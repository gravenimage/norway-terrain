"""Fetch OSM building footprints across the Rogaland DEM bbox in sub-tiles, reduce
each polygon to a minimum-area oriented bounding box + height + type, sample the
ground elevation from rogaland_10m.tif, and emit a compact binary for the viewer.

Output: buildings.bin
  magic[4] = "BLD1"
  uint32 n
  for each building (40 bytes):
    float32 cx, cy, baseZ
    float32 length, width, height
    float32 angle              (radians, ridge axis)
    uint8 type                 (0 house, 1 apartments, 2 commercial, 3 cabin/hut, 4 other)
    uint8 roof                 (0 flat, 1 gabled, 2 hipped)
    uint8 colorIdx             (palette index)
    uint8 pad
"""
from __future__ import annotations
import io
import json
import math
import pathlib
import struct
import time
import requests
import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import Polygon

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (rogaland buildings)",
    "Accept": "application/json",
}

# WGS84 bbox covering DEM
S, W, N, E = 58.0, 4.0, 60.5, 7.5
TILE_DEG = 0.4  # ~25 km lat, ~22 km lon at this latitude
CACHE = pathlib.Path("buildings_cache")
CACHE.mkdir(exist_ok=True)

TYPE_MAP = {
    "house": 0, "detached": 0, "semidetached_house": 0, "semi-detached": 0,
    "terrace": 0, "bungalow": 0, "static_caravan": 0, "residential": 0,
    "apartments": 1, "dormitory": 1,
    "commercial": 2, "retail": 2, "industrial": 2, "office": 2, "warehouse": 2, "supermarket": 2,
    "cabin": 3, "hut": 3, "shed": 3, "garage": 3, "boathouse": 3,
}
DEFAULT_HEIGHTS = {0: 5.5, 1: 14.0, 2: 7.0, 3: 3.5, 4: 5.0}
LEVEL_HEIGHT = 3.0


def query_tile(s, w, n, e):
    fname = CACHE / f"t_{s:.2f}_{w:.2f}_{n:.2f}_{e:.2f}.json"
    if fname.exists() and fname.stat().st_size > 50:
        return json.loads(fname.read_text(encoding="utf-8"))
    q = f"[out:json][timeout:240];(way['building']({s},{w},{n},{e}););out geom;"
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


def _height_from_tags(tags, type_idx):
    h = tags.get("height")
    if h:
        try:
            return max(2.0, float(str(h).split()[0].replace(",", ".")))
        except Exception:
            pass
    lv = tags.get("building:levels") or tags.get("levels")
    if lv:
        try:
            return max(2.0, float(str(lv).split(";")[0]) * LEVEL_HEIGHT + 1.0)
        except Exception:
            pass
    return DEFAULT_HEIGHTS[type_idx]


def _roof_from_tags(tags, type_idx):
    rs = (tags.get("roof:shape") or "").lower()
    if rs in ("flat",):
        return 0
    if rs in ("gabled", "gable"):
        return 1
    if rs in ("hipped", "hip", "half-hipped", "half_hipped", "pyramidal"):
        return 2
    # defaults: residential & cabin gabled, apartments slight gabled, commercial flat
    if type_idx in (0, 3):
        return 1
    if type_idx == 1:
        return 1
    return 0


def obb(poly: Polygon):
    mrr = poly.minimum_rotated_rectangle
    if mrr.is_empty or mrr.geom_type != "Polygon":
        return None
    coords = list(mrr.exterior.coords)[:4]
    if len(coords) < 4:
        return None
    edges = []
    for i in range(4):
        x0, y0 = coords[i]
        x1, y1 = coords[(i + 1) % 4]
        edges.append((math.hypot(x1 - x0, y1 - y0), math.atan2(y1 - y0, x1 - x0)))
    # the two longest are parallel; first index is one of them
    lengths = sorted(set(round(e[0], 4) for e in edges), reverse=True)
    if len(lengths) < 2:
        return None
    L = lengths[0]
    Wd = lengths[-1]
    angle = next(a for (l, a) in edges if abs(l - L) < 1e-3)
    cx = sum(c[0] for c in coords) / 4.0
    cy = sum(c[1] for c in coords) / 4.0
    return cx, cy, L, Wd, angle


def main():
    print(f"tiling {S}-{N} N x {W}-{E} E in {TILE_DEG}° steps", flush=True)
    n_lat = int(math.ceil((N - S) / TILE_DEG))
    n_lon = int(math.ceil((E - W) / TILE_DEG))
    tiles = []
    for i in range(n_lat):
        for j in range(n_lon):
            tiles.append((S + i * TILE_DEG, W + j * TILE_DEG,
                          min(N, S + (i + 1) * TILE_DEG), min(E, W + (j + 1) * TILE_DEG)))
    print(f"  {len(tiles)} sub-bboxes", flush=True)

    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    ds = rasterio.open("rogaland_10m.tif")
    band = ds.read(1)
    inv = ~ds.transform
    nodata = ds.nodata
    H, Wd = band.shape
    bnds = ds.bounds
    CX = (bnds.left + bnds.right) / 2.0
    CY = (bnds.bottom + bnds.top) / 2.0

    def sample_z(x, y):
        col, row = inv * (x, y)
        c, r = int(col), int(row)
        if 0 <= c < Wd and 0 <= r < H:
            v = band[r, c]
            if v == nodata:
                return 0.0
            return float(max(v, 0.0))
        return 0.0

    seen_ids = set()
    rows = []
    skipped_small = skipped_oob = 0

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
            tags = el.get("tags") or {}
            btype = tags.get("building", "yes")
            type_idx = TYPE_MAP.get(btype, 4)
            # project polygon to UTM33
            xy = [tr.transform(g["lon"], g["lat"]) for g in geom]
            try:
                poly = Polygon(xy)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                area = poly.area
            except Exception:
                continue
            if area < 8.0:  # ignore tiny artefacts < 8 m²
                skipped_small += 1
                continue
            ob = obb(poly)
            if ob is None:
                skipped_small += 1
                continue
            cx, cy, L, Wb, ang = ob
            if not (bnds.left <= cx <= bnds.right and bnds.bottom <= cy <= bnds.top):
                skipped_oob += 1
                continue
            base_z = sample_z(cx, cy)
            h = _height_from_tags(tags, type_idx)
            roof_idx = _roof_from_tags(tags, type_idx)
            # deterministic colour palette index from id, biased by type
            if type_idx == 0:
                palette = [0, 1, 2, 3, 4]   # falu red, white, ochre, mustard, dark red
            elif type_idx == 1:
                palette = [5, 6, 7]         # apartment greys/beige
            elif type_idx == 2:
                palette = [8, 9, 10]        # commercial concrete tones
            elif type_idx == 3:
                palette = [0, 4, 11]        # cabin: red, dark red, brown
            else:
                palette = [1, 6, 9]
            color_idx = palette[hash(wid) % len(palette)]
            rows.append((cx - CX, cy - CY, base_z, L, Wb, h, ang, type_idx, roof_idx, color_idx))
        print(f"   running total: {len(rows)} buildings", flush=True)

    print(f"total: {len(rows)} buildings (skipped small={skipped_small}, out-of-bbox={skipped_oob})")

    # binary emit
    out = io.BytesIO()
    out.write(b"BLD1")
    out.write(struct.pack("<I", len(rows)))
    arr = np.empty(len(rows), dtype=[
        ("cx", "<f4"), ("cy", "<f4"), ("bz", "<f4"),
        ("L", "<f4"), ("W", "<f4"), ("H", "<f4"),
        ("a", "<f4"), ("t", "u1"), ("r", "u1"), ("c", "u1"), ("p", "u1"),
    ])
    for i, row in enumerate(rows):
        arr[i] = (row[0], row[1], row[2], row[3], row[4], row[5], row[6],
                  row[7], row[8], row[9], 0)
    out.write(arr.tobytes())
    pathlib.Path("buildings.bin").write_bytes(out.getvalue())
    print(f"wrote buildings.bin ({pathlib.Path('buildings.bin').stat().st_size/1024/1024:.1f} MB)")


if __name__ == "__main__":
    main()
