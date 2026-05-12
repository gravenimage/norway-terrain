#!/usr/bin/env python3
"""Build forest canopy carpet + tree records from ESA WorldCover.

Outputs two binaries:
  - canopy.bin: regular 32 m grid quads clipped to WorldCover class==10,
    draped onto the DEM with per-vertex canopy height. Binned per 4 km cell.
  - forest.bin: per-tree records (TRE1) placed inside the canopy mask.

Run with:
  uv run --with numpy --with rasterio python forest_polys.py
"""

from __future__ import annotations
import struct
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge as rio_merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

ROOT = Path(__file__).parent
DEM_PATH = ROOT / "rogaland_10m.tif"
CACHE = ROOT / "worldcover_cache"
OUT_CANOPY = ROOT / "canopy.bin"
OUT_FOREST = ROOT / "forest.bin"

TILE_NAMES = ["N57E003", "N57E006", "N60E003", "N60E006"]
URL_TPL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_{name}_Map.tif"
)
CLS_TREES = 10

CANOPY_RES_M   = 48.0   # quad size for canopy carpet
TREE_SPACING_M = 30.0   # avg tree spacing inside canopy
JITTER         = 0.55   # tree position jitter (fraction of stride)
SEA_Z          = 0.5
TREE_LINE_Z    = 720.0
DENSITY_ROLLOFF_Z = 480.0
CELL_SIZE_M    = 4000.0  # spatial bin (matches viewer's tree cells)


def download(name: str) -> Path:
    p = CACHE / f"{name}.tif"
    if p.exists() and p.stat().st_size > 1_000_000:
        return p
    CACHE.mkdir(exist_ok=True)
    url = URL_TPL.format(name=name)
    print(f"  downloading {name} ...", flush=True)
    tmp = p.with_suffix(".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(p)
    return p


def canopy_height_for(z: float) -> float:
    """Local canopy thickness in metres, by elevation."""
    if z < 50.0:  return 15.0
    if z < 200.0: return 12.5
    if z < 400.0: return 9.0
    if z < 600.0: return 6.0
    return 3.5


def main() -> None:
    print("downloading WorldCover tiles ...", flush=True)
    tile_paths = [download(n) for n in TILE_NAMES]

    print("loading DEM ...", flush=True)
    dem_src = rasterio.open(DEM_PATH)
    dem = dem_src.read(1).astype(np.float32)
    dem_h, dem_w = dem.shape
    dem_bnds = dem_src.bounds
    dem_crs = dem_src.crs
    dem_tf = dem_src.transform
    minx, miny = dem_bnds.left, dem_bnds.bottom
    maxx, maxy = dem_bnds.right, dem_bnds.top
    dem_src.close()
    print(f"  dem: {dem_w}x{dem_h}  bbox=[{minx:.0f},{miny:.0f},{maxx:.0f},{maxy:.0f}]")

    # Centre offset (matches viewer convention)
    cx_off = (minx + maxx) * 0.5
    cy_off = (miny + maxy) * 0.5

    print("merging WorldCover tiles ...", flush=True)
    srcs = [rasterio.open(p) for p in tile_paths]
    mosaic, mosaic_tf = rio_merge(srcs, indexes=[1])
    mosaic = mosaic[0]
    mosaic_crs = srcs[0].crs
    for s in srcs:
        s.close()

    print(f"reprojecting to EPSG:25833 at {CANOPY_RES_M:.0f} m ...", flush=True)
    width  = int(round((maxx - minx) / CANOPY_RES_M))
    height = int(round((maxy - miny) / CANOPY_RES_M))
    dst_tf = from_origin(minx, maxy, CANOPY_RES_M, CANOPY_RES_M)
    wc = np.zeros((height, width), dtype=np.uint8)
    reproject(
        source=mosaic,
        destination=wc,
        src_transform=mosaic_tf,
        src_crs=mosaic_crs,
        dst_transform=dst_tf,
        dst_crs=dem_crs,
        resampling=Resampling.mode,
        num_threads=4,
    )
    print(f"  grid: {wc.shape}")

    # ----- DEM bilinear sampler -----
    a, _b, c = dem_tf.a, dem_tf.b, dem_tf.c   # b=0 expected
    d, e, fT = dem_tf.d, dem_tf.e, dem_tf.f   # d=0 expected

    def sample_dem(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        cols = (xs - c) / a
        rows = (ys - fT) / e
        c0 = np.floor(cols).astype(np.int32)
        r0 = np.floor(rows).astype(np.int32)
        c1 = c0 + 1
        r1 = r0 + 1
        c0 = np.clip(c0, 0, dem_w - 1); c1 = np.clip(c1, 0, dem_w - 1)
        r0 = np.clip(r0, 0, dem_h - 1); r1 = np.clip(r1, 0, dem_h - 1)
        fx = (cols - c0).astype(np.float32)
        fy = (rows - r0).astype(np.float32)
        v00 = dem[r0, c0]; v10 = dem[r0, c1]
        v01 = dem[r1, c0]; v11 = dem[r1, c1]
        return ((1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10
                + (1 - fx) * fy * v01 + fx * fy * v11)

    # ----- Canopy mask + corner DEM -----
    print("building canopy mask ...", flush=True)
    nx_c = width + 1
    ny_c = height + 1
    xs_corner = (minx + np.arange(nx_c) * CANOPY_RES_M).astype(np.float32)
    ys_corner = (maxy - np.arange(ny_c) * CANOPY_RES_M).astype(np.float32)
    XS, YS = np.meshgrid(xs_corner, ys_corner)
    Z_corner = sample_dem(XS, YS).astype(np.float32)

    mask = (wc == CLS_TREES)

    # Quad-corner extrema (each quad has 4 corners)
    Z_quad_min = np.minimum.reduce([
        Z_corner[:-1, :-1], Z_corner[:-1, 1:],
        Z_corner[1:, :-1],  Z_corner[1:, 1:],
    ])
    Z_quad_max = np.maximum.reduce([
        Z_corner[:-1, :-1], Z_corner[:-1, 1:],
        Z_corner[1:, :-1],  Z_corner[1:, 1:],
    ])
    mask &= (Z_quad_min > SEA_Z) & (Z_quad_max < TREE_LINE_Z)

    # Density rolloff near treeline
    quad_mid_z = (Z_quad_min + Z_quad_max) * 0.5
    rng = np.random.default_rng(31415)
    keep = np.ones_like(quad_mid_z)
    high = quad_mid_z > DENSITY_ROLLOFF_Z
    keep[high] = np.clip(
        1.0 - (quad_mid_z[high] - DENSITY_ROLLOFF_Z) / (TREE_LINE_Z - DENSITY_ROLLOFF_Z),
        0.0, 1.0,
    )
    mask &= rng.random(mask.shape) < keep
    n_quads = int(mask.sum())
    print(f"  forest quads: {n_quads:,} of {mask.size:,} ({100*mask.mean():.1f}%)")
    if n_quads == 0:
        raise SystemExit("no forest detected")

    # ----- Per-vertex canopy height lookup -----
    H_corner = np.empty_like(Z_corner)
    bands = [(50, 15.0), (200, 12.5), (400, 9.0), (600, 6.0), (1e9, 3.5)]
    flat_z = Z_corner.ravel()
    flat_h = np.empty_like(flat_z)
    prev_lo = -1e9
    for hi, hv in bands:
        sel = (flat_z >= prev_lo) & (flat_z < hi)
        flat_h[sel] = hv
        prev_lo = hi
    H_corner = flat_h.reshape(Z_corner.shape)
    # Subtle per-vertex height variation
    H_corner += (rng.random(H_corner.shape).astype(np.float32) - 0.5) * 1.5
    H_corner = np.clip(H_corner, 2.0, 18.0).astype(np.float32)

    # ----- Bin quads into 4 km cells -----
    print("binning canopy quads into 4 km cells ...", flush=True)
    qi, qj = np.where(mask)
    qxc = (minx + (qj + 0.5) * CANOPY_RES_M).astype(np.float64)
    qyc = (maxy - (qi + 0.5) * CANOPY_RES_M).astype(np.float64)
    kx_arr = np.floor(qxc / CELL_SIZE_M).astype(np.int32)
    ky_arr = np.floor(qyc / CELL_SIZE_M).astype(np.int32)
    cell_keys = kx_arr.astype(np.int64) * 1_000_000 + ky_arr.astype(np.int64)
    order = np.argsort(cell_keys, kind="stable")
    sorted_keys = cell_keys[order]
    splits = np.concatenate([[0],
                             np.where(np.diff(sorted_keys) != 0)[0] + 1,
                             [len(sorted_keys)]])
    n_cells = len(splits) - 1
    print(f"  {n_cells} canopy cells")

    # ----- Build canopy.bin -----
    # Per-cell layout (v2):
    #   header:  i32 kx, i32 ky
    #            f32 cx, cy, czMin, czMax, radius
    #            u32 nVerts, nTris
    #   vertex stream: nVerts * (f32 x, f32 y, f32 baseZ)   # canopy height derived in shader
    #   index stream:  nTris * 3 * u16   (each cell has < 65k verts at 48 m grid)
    print("writing canopy.bin ...", flush=True)
    f_out = open(OUT_CANOPY, "wb")
    f_out.write(b"CANO")
    f_out.write(struct.pack("<II", 2, n_cells))

    for b in range(n_cells):
        beg, end = splits[b], splits[b + 1]
        sel = order[beg:end]
        kx = int(kx_arr[sel[0]])
        ky = int(ky_arr[sel[0]])
        ci = qi[sel]
        cj = qj[sel]
        n_q = len(sel)

        c_tl = ci.astype(np.int64) * nx_c + cj.astype(np.int64)
        c_tr = c_tl + 1
        c_bl = c_tl + nx_c
        c_br = c_bl + 1
        all_c = np.concatenate([c_tl, c_tr, c_bl, c_br])
        unique_c, inv = np.unique(all_c, return_inverse=True)
        n_v = len(unique_c)
        if n_v >= 65535:
            raise SystemExit(f"cell {kx},{ky} has {n_v} verts >= 65535; lower CELL_SIZE_M or raise CANOPY_RES_M")

        v_tl = inv[:n_q]
        v_tr = inv[n_q:2 * n_q]
        v_bl = inv[2 * n_q:3 * n_q]
        v_br = inv[3 * n_q:]

        v_rows = (unique_c // nx_c).astype(np.int32)
        v_cols = (unique_c % nx_c).astype(np.int32)
        vx = (minx + v_cols * CANOPY_RES_M - cx_off).astype(np.float32)
        vy = (maxy - v_rows * CANOPY_RES_M - cy_off).astype(np.float32)
        vz = Z_corner[v_rows, v_cols].astype(np.float32)

        idx = np.empty((n_q, 6), dtype=np.uint16)
        idx[:, 0] = v_tl; idx[:, 1] = v_bl; idx[:, 2] = v_tr
        idx[:, 3] = v_tr; idx[:, 4] = v_bl; idx[:, 5] = v_br
        idx_flat = idx.reshape(-1)
        n_t = n_q * 2

        cx_local = float(vx.mean())
        cy_local = float(vy.mean())
        cz_min = float(vz.min())
        cz_max = float(vz.max() + 18.0)   # rough upper bound for cull sphere
        radius = float(np.hypot(vx.max() - cx_local, vy.max() - cy_local) + CANOPY_RES_M)

        f_out.write(struct.pack("<iifffffII",
                                kx, ky,
                                cx_local, cy_local,
                                cz_min, cz_max, radius,
                                n_v, n_t))
        verts = np.empty((n_v, 3), dtype=np.float32)
        verts[:, 0] = vx
        verts[:, 1] = vy
        verts[:, 2] = vz
        f_out.write(verts.tobytes())
        f_out.write(idx_flat.tobytes())
        # Pad to 4-byte alignment if odd index count
        if (idx_flat.size & 1) == 1:
            f_out.write(b"\0\0")

    f_out.close()
    print(f"  canopy.bin: {OUT_CANOPY.stat().st_size/1024/1024:.1f} MB")

    # ----- Trees: jittered subsample of forest quads -----
    # Canopy quads are at 32 m; we want ~45 m effective tree spacing for a manageable
    # forest.bin while keeping it dense enough to look like real forest up close.
    TREE_KEEP = 1.00   # one seed per forest quad; viewer scatters K trees per seed across the quad
    tree_sel = rng.random(n_quads) < TREE_KEEP
    tqi = qi[tree_sel]
    tqj = qj[tree_sel]
    n_trees = int(tree_sel.sum())
    print(f"placing {n_trees:,} trees ...", flush=True)
    # Seeds sit at exact quad centres; JS loader scatters K trees per seed across the quad,
    # giving a uniform distribution with no clustering or gaps.
    tx = (minx + (tqj + 0.5) * CANOPY_RES_M).astype(np.float32)
    ty = (maxy - (tqi + 0.5) * CANOPY_RES_M).astype(np.float32)
    tz = sample_dem(tx, ty).astype(np.float32)

    # --- Per-quad corner-height deltas (so JS scatter can interpolate per-tree z) ---
    # Without this, every sub-tree inside a quad inherits the centre's z,
    # which creates horizontal "shelves" of trees on steep slopes.
    half = CANOPY_RES_M * 0.5
    # corners: 00 = (-x, -y), 10 = (+x, -y), 01 = (-x, +y), 11 = (+x, +y)
    z00 = sample_dem(tx - half, ty - half)
    z10 = sample_dem(tx + half, ty - half)
    z01 = sample_dem(tx - half, ty + half)
    z11 = sample_dem(tx + half, ty + half)
    # encode as int8 deltas with 0.5 m precision (range +/-63.5 m from quad centre)
    def _enc(z):
        return np.clip(np.round((z - tz) * 2.0), -127, 127).astype(np.int8)
    d00, d10, d01, d11 = _enc(z00), _enc(z10), _enc(z01), _enc(z11)

    species = np.where(tz < 200, 0,
              np.where(tz < 400, 1,
              np.where(tz < 550, 2, 3))).astype(np.uint8)
    base_h_lut = np.array([18.0, 13.0, 8.5, 4.5], dtype=np.float32)
    h = base_h_lut[species] * (0.80 + rng.random(n_trees).astype(np.float32) * 0.40)
    sj = (rng.random(n_trees) * 256).astype(np.uint8)
    cj = (rng.random(n_trees) * 256).astype(np.uint8)

    # TRE2 record: 24 bytes (was 20). Adds 4 corner-height deltas (int8) at the end.
    rec_dt = np.dtype([
        ("cx", "<f4"), ("cy", "<f4"),
        ("cz", "<f4"), ("h",  "<f4"),
        ("sp", "u1"), ("sj", "u1"), ("cj", "u1"), ("pad", "u1"),
        ("d00", "i1"), ("d10", "i1"), ("d01", "i1"), ("d11", "i1"),
    ])
    recs = np.zeros(n_trees, dtype=rec_dt)
    recs["cx"] = (tx - cx_off).astype(np.float32)
    recs["cy"] = (ty - cy_off).astype(np.float32)
    recs["cz"] = tz
    recs["h"]  = h
    recs["sp"] = species
    recs["sj"] = sj
    recs["cj"] = cj
    recs["d00"] = d00; recs["d10"] = d10
    recs["d01"] = d01; recs["d11"] = d11

    with open(OUT_FOREST, "wb") as f:
        f.write(b"TRE2")
        f.write(struct.pack("<I", n_trees))
        f.write(recs.tobytes())
    print(f"  forest.bin: {OUT_FOREST.stat().st_size/1024/1024:.1f} MB ({n_trees:,} trees)")
    print("done.")


if __name__ == "__main__":
    main()
