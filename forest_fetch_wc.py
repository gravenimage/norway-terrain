"""
Forest tree placement from ESA WorldCover 10m (2021 v200).

Pipeline:
  1. Download four 3x3 deg tiles covering Rogaland from public S3.
  2. Build a virtual mosaic and reproject-on-the-fly to EPSG:25833.
  3. Stride-sample tree pixels (class 10) at TARGET_SPACING_M, with strong jitter.
  4. For each candidate, look up DEM elevation; drop sea/alpine; density roll-off.
  5. Pick species by elevation; jitter height; emit TRE1 binary.

Output: forest.bin (same TRE1 format as forest_fetch.py).
"""
from __future__ import annotations

import os
import struct
import sys
import math
import random
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.merge import merge as rio_merge
from rasterio.vrt import WarpedVRT

ROOT = Path(__file__).resolve().parent
DEM = ROOT / "rogaland_10m.tif"
META = ROOT / "tiles" / "meta.json"
OUT = ROOT / "forest.bin"
CACHE = ROOT / "worldcover_cache"
CACHE.mkdir(exist_ok=True)

# ESA WorldCover tile naming: 3-degree tiles, lat/lon at SW corner
# Tiles needed for Rogaland bbox 58-60.5 N x 4-7.5 E:
#   N57E003 covers 57-60 N, 3-6 E
#   N57E006 covers 57-60 N, 6-9 E
#   N60E003 covers 60-63 N, 3-6 E
#   N60E006 covers 60-63 N, 6-9 E
TILE_NAMES = ["N57E003", "N57E006", "N60E003", "N60E006"]
URL_TPL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_{name}_Map.tif"
)

CLS_TREES = 10        # primary forest
CLS_SHRUB = 20        # shrubland - small chance of trees / dwarf birch
CLS_WETLAND = 90      # bogs - very few trees

TARGET_SPACING_M = 45.0    # stride in EPSG:25833 metres
JITTER = 0.75              # jitter as fraction of half-spacing
TREE_LINE_Z = 720.0
DENSITY_ROLLOFF_Z = 480.0
SEA_Z = 0.5

SHRUB_KEEP = 0.18          # treat shrubland as ~18% of forest density
WETLAND_KEEP = 0.05

random.seed(31415)


def download(name: str) -> Path:
    p = CACHE / f"{name}.tif"
    if p.exists() and p.stat().st_size > 1_000_000:
        return p
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


def species_for_z(z: float, is_shrub: bool, rng: random.Random) -> int:
    if is_shrub:
        # Dwarf birch / juniper - render as low birch/mixed
        return 2 if rng.random() < 0.7 else 3
    if z < 150:
        r = rng.random()
        return 0 if r < 0.50 else (1 if r < 0.78 else (2 if r < 0.92 else 3))
    if z < 350:
        r = rng.random()
        return 0 if r < 0.55 else (1 if r < 0.85 else (2 if r < 0.95 else 3))
    if z < 550:
        r = rng.random()
        return 0 if r < 0.40 else (1 if r < 0.78 else 2)
    # 550-720 sub-alpine: birch dominates
    r = rng.random()
    return 1 if r < 0.18 else 2


def height_for(species: int, z: float, is_shrub: bool, rng: random.Random) -> float:
    alt_factor = max(0.40, 1.0 - max(0.0, (z - 350.0) / 400.0) * 0.55)
    if is_shrub:
        return max(1.5, rng.gauss(3.5, 1.0)) * alt_factor
    if species == 0:
        h = rng.gauss(18.0, 6.0)
    elif species == 1:
        h = rng.gauss(15.0, 5.0)
    elif species == 2:
        h = rng.gauss(9.0, 3.5)
    else:
        h = rng.gauss(12.0, 4.5)
    return max(3.0, h) * alt_factor


def main() -> None:
    print("downloading WorldCover tiles ...", flush=True)
    tile_paths = [download(n) for n in TILE_NAMES]

    print("loading DEM ...", flush=True)
    dem = rasterio.open(DEM)
    dem_arr = dem.read(1)
    dem_bnds = dem.bounds
    dem_crs = dem.crs

    import json
    meta = json.loads(META.read_text())
    cx_off = (dem_bnds.left + dem_bnds.right) * 0.5
    cy_off = (dem_bnds.bottom + dem_bnds.top) * 0.5
    print(f"  dem bounds: {dem_bnds}, centre: {cx_off:.0f}, {cy_off:.0f}", flush=True)

    print("merging WorldCover tiles ...", flush=True)
    srcs = [rasterio.open(p) for p in tile_paths]
    mosaic, mosaic_tf = rio_merge(srcs, indexes=[1])
    mosaic = mosaic[0]
    mosaic_crs = srcs[0].crs
    for s in srcs:
        s.close()
    print(f"  mosaic shape={mosaic.shape}, crs={mosaic_crs}", flush=True)

    print("reprojecting WorldCover into DEM grid (16 m for sampling) ...", flush=True)
    # Resample WorldCover into a clean EPSG:25833 grid at 16 m for fast sampling
    SAMPLE_RES = 16.0
    width = int(round((dem_bnds.right - dem_bnds.left) / SAMPLE_RES))
    height = int(round((dem_bnds.top - dem_bnds.bottom) / SAMPLE_RES))
    dst_tf = rasterio.transform.from_origin(dem_bnds.left, dem_bnds.top, SAMPLE_RES, SAMPLE_RES)
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
    print(f"  sampled grid: {wc.shape}", flush=True)
    print(
        f"  class counts: trees={int((wc == CLS_TREES).sum()):,} "
        f"shrub={int((wc == CLS_SHRUB).sum()):,} wetland={int((wc == CLS_WETLAND).sum()):,}",
        flush=True,
    )

    # Stride loop: every Nth row/col of the 16 m WC grid, plus jitter
    stride_px = max(1, int(round(TARGET_SPACING_M / SAMPLE_RES)))
    print(f"stride = {stride_px} px ({stride_px * SAMPLE_RES:.0f} m)", flush=True)

    dem_w = dem_arr.shape[1]
    dem_h = dem_arr.shape[0]
    inv_dem_x = 1.0 / 10.0  # 10 m DEM
    inv_dem_y = 1.0 / 10.0

    out = []
    sea_skip = 0
    alpine_skip = 0
    density_skip = 0
    out_skip = 0

    rng = random.Random(31415)
    j_amp = TARGET_SPACING_M * 0.5 * JITTER

    for jy in range(0, height, stride_px):
        for jx in range(0, width, stride_px):
            cls = int(wc[jy, jx])
            if cls == CLS_TREES:
                p_keep = 1.0
                is_shrub = False
            elif cls == CLS_SHRUB:
                p_keep = SHRUB_KEEP
                is_shrub = True
            elif cls == CLS_WETLAND:
                p_keep = WETLAND_KEEP
                is_shrub = True
            else:
                continue
            if rng.random() > p_keep:
                continue

            # Pixel centre in EPSG:25833
            x = dem_bnds.left + (jx + 0.5) * SAMPLE_RES
            y = dem_bnds.top - (jy + 0.5) * SAMPLE_RES
            x += rng.uniform(-j_amp, j_amp)
            y += rng.uniform(-j_amp, j_amp)

            # DEM lookup (10 m grid, top-left origin)
            ix = int((x - dem_bnds.left) * inv_dem_x)
            iy = int((dem_bnds.top - y) * inv_dem_y)
            if ix < 0 or ix >= dem_w or iy < 0 or iy >= dem_h:
                out_skip += 1
                continue
            z = float(dem_arr[iy, ix])
            if z <= SEA_Z:
                sea_skip += 1
                continue
            if z >= TREE_LINE_Z:
                alpine_skip += 1
                continue
            if z > DENSITY_ROLLOFF_Z:
                fade = 1.0 - (z - DENSITY_ROLLOFF_Z) / (TREE_LINE_Z - DENSITY_ROLLOFF_Z)
                if rng.random() > fade:
                    density_skip += 1
                    continue

            sp = species_for_z(z, is_shrub, rng)
            h = height_for(sp, z, is_shrub, rng)

            cx = x - cx_off
            cy = y - cy_off
            out.append(
                (
                    cx,
                    cy,
                    z,
                    h,
                    sp,
                    rng.randint(0, 255),
                    rng.randint(0, 255),
                )
            )

        if (jy // stride_px) % 50 == 0:
            print(
                f"  row {jy}/{height} -> kept {len(out):,} "
                f"(sea={sea_skip:,} alpine={alpine_skip:,} dens={density_skip:,})",
                flush=True,
            )

    n = len(out)
    print(
        f"\nFINAL: {n:,} trees "
        f"(sea={sea_skip:,} alpine={alpine_skip:,} density={density_skip:,} oob={out_skip:,})",
        flush=True,
    )

    with open(OUT, "wb") as f:
        f.write(b"TRE1")
        f.write(struct.pack("<I", n))
        for cx, cy, z, h, sp, sj, cj in out:
            f.write(struct.pack("<ffffBBBB", cx, cy, z, h, sp, sj, cj, 0))
    sz = OUT.stat().st_size
    print(f"wrote {OUT.name} ({sz / 1024 / 1024:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()
