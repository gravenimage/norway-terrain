"""Fetch OSM forest cover (landuse=forest, natural=wood) across the Rogaland DEM
bbox in sub-tiles, project polygons to UTM33, generate a jittered-grid (Poisson-ish)
point distribution inside each polygon at ~SPACING m, sample DEM z, drop above the
local tree-line (~700 m) and below sea level, and emit a compact binary for the viewer.

Output: forest.bin
  magic[4] = "TRE1"
  uint32 n
  for each tree (20 bytes):
    float32 cx, cy            (recentred to DEM centre, EPSG:25833)
    float32 baseZ             (terrain elevation, m)
    float32 height            (tree height, m)
    uint8 species             (0 spruce, 1 pine, 2 birch, 3 mixed/unknown)
    uint8 sizeJitter          (0..255 → secondary canopy/trunk variation)
    uint8 colorJitter         (0..255 → per-tree colour shift)
    uint8 pad
"""
from __future__ import annotations

import io
import json
import math
import pathlib
import random
import struct
import time
from typing import Iterable

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from shapely.geometry import Polygon, Point
from shapely.prepared import prep

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (rogaland forest)",
    "Accept": "application/json",
}

# WGS84 bbox covering the DEM (matches buildings_fetch / osm_fetch).
S, W, N, E = 58.0, 4.0, 60.5, 7.5
TILE_DEG = 0.4

CACHE = pathlib.Path("forest_cache")
CACHE.mkdir(exist_ok=True)

# --- tree placement parameters ---
SPACING = 32.0          # base point spacing inside polygons (m)
JITTER = 0.55           # 0..1 fraction of SPACING applied as random offset
TREE_LINE_Z = 720.0     # hard upper elevation for trees (m); above → dropped
DENSITY_ROLLOFF_Z = 480.0  # density tapers between this and TREE_LINE_Z
MIN_POLY_AREA = 200.0   # ignore polygons below 200 m² (artefacts)


def query_tile(s, w, n, e):
    fname = CACHE / f"f_{s:.2f}_{w:.2f}_{n:.2f}_{e:.2f}.json"
    if fname.exists() and fname.stat().st_size > 50:
        return json.loads(fname.read_text(encoding="utf-8"))
    q = (
        f"[out:json][timeout:240];"
        f"(way['landuse'='forest']({s},{w},{n},{e});"
        f" way['natural'='wood']({s},{w},{n},{e}););"
        f"out geom;"
    )
    last_err = None
    for url in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                r = requests.post(url, data={"data": q}, headers=HEADERS, timeout=300)
                r.raise_for_status()
                fname.write_text(r.text, encoding="utf-8")
                return r.json()
            except Exception as e:
                last_err = e
                wait = 5 * (attempt + 1)
                print(f"      {url} att {attempt+1}: {e}; sleep {wait}s", flush=True)
                time.sleep(wait)
    raise RuntimeError(f"all endpoints failed: {last_err}")


def species_for(z: float, rng: random.Random) -> int:
    """Pick species based on elevation with some randomness.
    0 spruce  (gran)        — dominant low-mid in Rogaland
    1 pine    (furu)        — dry slopes, coast, mid altitude
    2 birch   (bjørk)       — sub-alpine, wetter ground
    3 mixed/other
    """
    r = rng.random()
    if z < 150.0:
        if r < 0.5: return 0
        if r < 0.78: return 1
        if r < 0.92: return 2
        return 3
    if z < 350.0:
        if r < 0.55: return 0
        if r < 0.85: return 1
        if r < 0.95: return 2
        return 3
    if z < 550.0:
        if r < 0.40: return 0
        if r < 0.78: return 1
        return 2
    # 550..720
    if r < 0.18: return 1
    return 2  # mostly birch up here


def height_for(species: int, z: float, rng: random.Random) -> float:
    # Stunted at altitude.
    alt_factor = 1.0 - max(0.0, (z - 350.0) / 400.0) * 0.55  # 1.0 at 350m → 0.45 at 750m
    alt_factor = max(0.4, alt_factor)
    base, spread = {
        0: (18.0, 6.0),    # spruce
        1: (15.0, 5.0),    # pine
        2: (9.0, 3.5),     # birch
        3: (12.0, 4.5),    # mixed
    }[species]
    h = (base + (rng.random() - 0.5) * 2.0 * spread) * alt_factor
    return max(2.5, h)


def density_factor(z: float) -> float:
    """Probability multiplier 0..1 based on elevation (taper near tree-line)."""
    if z >= TREE_LINE_Z:
        return 0.0
    if z <= DENSITY_ROLLOFF_Z:
        return 1.0
    t = (z - DENSITY_ROLLOFF_Z) / (TREE_LINE_Z - DENSITY_ROLLOFF_Z)
    return max(0.0, 1.0 - t)


def sample_polygon(poly: Polygon, spacing: float, rng: random.Random) -> Iterable[tuple]:
    """Yield (x, y) inside the polygon on a jittered grid."""
    pp = prep(poly)
    minx, miny, maxx, maxy = poly.bounds
    nx = int(math.ceil((maxx - minx) / spacing))
    ny = int(math.ceil((maxy - miny) / spacing))
    if nx == 0 or ny == 0:
        return
    for i in range(nx):
        x0 = minx + i * spacing
        for j in range(ny):
            y0 = miny + j * spacing
            x = x0 + (0.5 + (rng.random() - 0.5) * JITTER * 2.0) * spacing
            y = y0 + (0.5 + (rng.random() - 0.5) * JITTER * 2.0) * spacing
            if minx <= x <= maxx and miny <= y <= maxy and pp.contains(Point(x, y)):
                yield x, y


def main():
    print(f"tiling {S}-{N} N x {W}-{E} E in {TILE_DEG}° steps", flush=True)
    n_lat = int(math.ceil((N - S) / TILE_DEG))
    n_lon = int(math.ceil((E - W) / TILE_DEG))
    tiles = []
    for i in range(n_lat):
        for j in range(n_lon):
            tiles.append((
                S + i * TILE_DEG, W + j * TILE_DEG,
                min(N, S + (i + 1) * TILE_DEG), min(E, W + (j + 1) * TILE_DEG),
            ))
    print(f"  {len(tiles)} sub-bboxes", flush=True)

    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    ds = rasterio.open("rogaland_10m.tif")
    band = ds.read(1)
    inv = ~ds.transform
    nodata = ds.nodata
    H_px, W_px = band.shape
    bnds = ds.bounds
    CX = (bnds.left + bnds.right) / 2.0
    CY = (bnds.bottom + bnds.top) / 2.0

    def sample_z(x, y):
        col, row = inv * (x, y)
        c, r = int(col), int(row)
        if 0 <= c < W_px and 0 <= r < H_px:
            v = band[r, c]
            if v == nodata:
                return None
            return float(v)
        return None

    rng = random.Random(20260510)
    seen_ids = set()
    rows = []
    skipped_small = 0
    skipped_above_treeline = 0
    skipped_below_sea = 0
    skipped_density = 0
    skipped_oob = 0
    poly_count = 0

    for k, (s, w, n, e) in enumerate(tiles):
        print(f"[{k+1}/{len(tiles)}] {s:.2f},{w:.2f}..{n:.2f},{e:.2f}", flush=True)
        try:
            data = query_tile(s, w, n, e)
        except Exception as exc:
            print(f"   skipped tile: {exc}", flush=True)
            continue
        for el in data.get("elements", []):
            if el.get("type") != "way":
                continue
            wid = el.get("id")
            if wid in seen_ids:
                continue
            seen_ids.add(wid)
            geom = el.get("geometry") or []
            if len(geom) < 4:
                continue
            xy = [tr.transform(g["lon"], g["lat"]) for g in geom]
            try:
                poly = Polygon(xy)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
                area = poly.area
            except Exception:
                continue
            if area < MIN_POLY_AREA:
                skipped_small += 1
                continue
            poly_count += 1
            for (x, y) in sample_polygon(poly, SPACING, rng):
                if not (bnds.left <= x <= bnds.right and bnds.bottom <= y <= bnds.top):
                    skipped_oob += 1
                    continue
                z = sample_z(x, y)
                if z is None:
                    skipped_oob += 1
                    continue
                if z <= 0.5:
                    skipped_below_sea += 1
                    continue
                if z >= TREE_LINE_Z:
                    skipped_above_treeline += 1
                    continue
                if rng.random() > density_factor(z):
                    skipped_density += 1
                    continue
                sp = species_for(z, rng)
                h = height_for(sp, z, rng)
                rows.append((
                    x - CX, y - CY, z, h,
                    sp,
                    rng.randint(0, 255),
                    rng.randint(0, 255),
                ))
        print(
            f"   running: trees={len(rows):,} polys={poly_count:,} "
            f"(skipped small={skipped_small}, oob={skipped_oob}, "
            f"sea={skipped_below_sea}, alpine={skipped_above_treeline}, density={skipped_density})",
            flush=True,
        )

    print(f"\nFINAL: {len(rows):,} trees from {poly_count:,} forest polygons")
    print(
        f"  skipped: small_poly={skipped_small}, oob={skipped_oob}, "
        f"sea={skipped_below_sea}, above_treeline={skipped_above_treeline}, density={skipped_density}",
    )

    out = io.BytesIO()
    out.write(b"TRE1")
    out.write(struct.pack("<I", len(rows)))
    arr = np.empty(len(rows), dtype=[
        ("cx", "<f4"), ("cy", "<f4"), ("bz", "<f4"), ("h", "<f4"),
        ("sp", "u1"), ("sj", "u1"), ("cj", "u1"), ("pad", "u1"),
    ])
    for i, row in enumerate(rows):
        arr[i] = (row[0], row[1], row[2], row[3], row[4], row[5], row[6], 0)
    out.write(arr.tobytes())
    pathlib.Path("forest.bin").write_bytes(out.getvalue())
    sz = pathlib.Path("forest.bin").stat().st_size / 1024 / 1024
    print(f"wrote forest.bin ({sz:.1f} MB)")


if __name__ == "__main__":
    main()
