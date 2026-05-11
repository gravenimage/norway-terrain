#!/usr/bin/env python3
"""Build inland water-body mesh from ESA WorldCover class 80.

Output:
  water.bin: 48 m grid quads clipped to WorldCover class==80 with DEM > MIN_Z
  (excludes ocean). Binned per 4 km cell, same layout as canopy.bin (magic "WATR").

Run with:
  uv run --with numpy --with rasterio python water_polys.py
"""
from __future__ import annotations
import struct
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge as rio_merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

ROOT = Path(__file__).parent
DEM_PATH = ROOT / "rogaland_10m.tif"
CACHE = ROOT / "worldcover_cache"
OUT_WATER = ROOT / "water.bin"

TILE_NAMES = ["N57E003", "N57E006", "N60E003", "N60E006"]
CLS_WATER = 80

WATER_RES_M = 48.0
MIN_Z       = 2.0      # exclude ocean / tidal flats
CELL_SIZE_M = 4000.0


def main() -> None:
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
    print(f"  dem: {dem_w}x{dem_h}")

    cx_off = (minx + maxx) * 0.5
    cy_off = (miny + maxy) * 0.5

    print("merging WorldCover tiles ...", flush=True)
    srcs = [rasterio.open(CACHE / f"{n}.tif") for n in TILE_NAMES]
    mosaic, mosaic_tf = rio_merge(srcs, indexes=[1])
    mosaic = mosaic[0]
    mosaic_crs = srcs[0].crs
    for s in srcs:
        s.close()

    print(f"reprojecting to EPSG:25833 at {WATER_RES_M:.0f} m ...", flush=True)
    width = int(round((maxx - minx) / WATER_RES_M))
    height = int(round((maxy - miny) / WATER_RES_M))
    dst_tf = from_origin(minx, maxy, WATER_RES_M, WATER_RES_M)
    wc = np.zeros((height, width), dtype=np.uint8)
    reproject(
        source=mosaic, destination=wc,
        src_transform=mosaic_tf, src_crs=mosaic_crs,
        dst_transform=dst_tf, dst_crs=dem_crs,
        resampling=Resampling.mode, num_threads=4,
    )
    print(f"  grid: {wc.shape}")

    a, _b, c = dem_tf.a, dem_tf.b, dem_tf.c
    d, e, fT = dem_tf.d, dem_tf.e, dem_tf.f

    def sample_dem(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        cols = (xs - c) / a
        rows = (ys - fT) / e
        c0 = np.clip(np.floor(cols).astype(np.int32), 0, dem_w - 1)
        r0 = np.clip(np.floor(rows).astype(np.int32), 0, dem_h - 1)
        c1 = np.clip(c0 + 1, 0, dem_w - 1)
        r1 = np.clip(r0 + 1, 0, dem_h - 1)
        fx = (cols - c0).astype(np.float32)
        fy = (rows - r0).astype(np.float32)
        v00 = dem[r0, c0]; v10 = dem[r0, c1]
        v01 = dem[r1, c0]; v11 = dem[r1, c1]
        return ((1 - fx) * (1 - fy) * v00 + fx * (1 - fy) * v10
                + (1 - fx) * fy * v01 + fx * fy * v11)

    print("building water mask ...", flush=True)
    nx_c = width + 1
    ny_c = height + 1
    xs_corner = (minx + np.arange(nx_c) * WATER_RES_M).astype(np.float32)
    ys_corner = (maxy - np.arange(ny_c) * WATER_RES_M).astype(np.float32)
    XS, YS = np.meshgrid(xs_corner, ys_corner)
    Z_corner = sample_dem(XS, YS).astype(np.float32)

    mask = (wc == CLS_WATER)
    Z_quad_min = np.minimum.reduce([
        Z_corner[:-1, :-1], Z_corner[:-1, 1:],
        Z_corner[1:, :-1],  Z_corner[1:, 1:],
    ])
    mask &= Z_quad_min > MIN_Z
    n_quads = int(mask.sum())
    print(f"  water quads: {n_quads:,} ({100*mask.mean():.2f}%)")
    if n_quads == 0:
        raise SystemExit("no inland water detected")

    print("binning water quads into 4 km cells ...", flush=True)
    qi, qj = np.where(mask)
    qxc = (minx + (qj + 0.5) * WATER_RES_M).astype(np.float64)
    qyc = (maxy - (qi + 0.5) * WATER_RES_M).astype(np.float64)
    kx_arr = np.floor(qxc / CELL_SIZE_M).astype(np.int32)
    ky_arr = np.floor(qyc / CELL_SIZE_M).astype(np.int32)
    cell_keys = kx_arr.astype(np.int64) * 1_000_000 + ky_arr.astype(np.int64)
    order = np.argsort(cell_keys, kind="stable")
    sorted_keys = cell_keys[order]
    splits = np.concatenate([[0],
                             np.where(np.diff(sorted_keys) != 0)[0] + 1,
                             [len(sorted_keys)]])
    n_cells = len(splits) - 1
    print(f"  {n_cells} water cells")

    print("writing water.bin ...", flush=True)
    f_out = open(OUT_WATER, "wb")
    f_out.write(b"WATR")
    f_out.write(struct.pack("<II", 1, n_cells))

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
            raise SystemExit(f"cell {kx},{ky} has {n_v} verts >= 65535")

        v_tl = inv[:n_q]; v_tr = inv[n_q:2*n_q]
        v_bl = inv[2*n_q:3*n_q]; v_br = inv[3*n_q:]

        v_rows = (unique_c // nx_c).astype(np.int32)
        v_cols = (unique_c % nx_c).astype(np.int32)
        vx = (minx + v_cols * WATER_RES_M - cx_off).astype(np.float32)
        vy = (maxy - v_rows * WATER_RES_M - cy_off).astype(np.float32)
        # Water level: use min of quad corner DEM values for a flatter surface,
        # nudged up slightly to prevent z-fight with shoreline terrain.
        vz = Z_corner[v_rows, v_cols].astype(np.float32) + 0.4

        idx = np.empty((n_q, 6), dtype=np.uint16)
        idx[:, 0] = v_tl; idx[:, 1] = v_bl; idx[:, 2] = v_tr
        idx[:, 3] = v_tr; idx[:, 4] = v_bl; idx[:, 5] = v_br
        idx_flat = idx.reshape(-1)
        n_t = n_q * 2

        cx_local = float(vx.mean())
        cy_local = float(vy.mean())
        cz_min = float(vz.min())
        cz_max = float(vz.max())
        radius = float(np.hypot(vx.max() - cx_local, vy.max() - cy_local) + WATER_RES_M)

        f_out.write(struct.pack("<iifffffII",
                                kx, ky,
                                cx_local, cy_local,
                                cz_min, cz_max, radius,
                                n_v, n_t))
        verts = np.empty((n_v, 3), dtype=np.float32)
        verts[:, 0] = vx; verts[:, 1] = vy; verts[:, 2] = vz
        f_out.write(verts.tobytes())
        f_out.write(idx_flat.tobytes())
        if (idx_flat.size & 1) == 1:
            f_out.write(b"\0\0")

    f_out.close()
    print(f"  water.bin: {OUT_WATER.stat().st_size/1024/1024:.1f} MB")
    print("done.")


if __name__ == "__main__":
    main()
