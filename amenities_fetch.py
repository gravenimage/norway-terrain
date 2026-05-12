"""Fetch OSM civic-amenity features across the Rogaland DEM bbox.

Categorises features into two groups:
  - "areas": polygon features like football pitches, parks, playground areas,
    cemeteries, school yards, etc. Stored as densified polygon outlines, draped
    onto the DEM via base-Z at the centroid.
  - "points": node features like benches, picnic tables, shelters, lighthouses,
    playground equipment. Stored as oriented point markers with a type id.

Output: amenities.bin
  magic[4]   = "AMN1"
  uint32     nAreas
  for each area (variable):
    uint16   type
    uint16   nVerts
    float32  baseZ
    nVerts * (float32 x, float32 y, float32 z)   (per-vertex world coords,
                                                  centred; per-vertex z lets
                                                  large polygons drape onto
                                                  sloped terrain.)
  uint32     nPoints
  for each point (16 bytes):
    uint16   type
    uint16   pad
    float32  x, y, z                  (centred world coords)

Run with:
  uv run --no-project --with numpy --with rasterio --with shapely \
      --with requests --with pyproj python amenities_fetch.py
"""
from __future__ import annotations
import io
import json
import math
import pathlib
import struct
import time

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from shapely.geometry import Polygon

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (rogaland amenities)",
    "Accept": "application/json",
}

S, W, N, E = 58.0, 4.0, 60.5, 7.5
TILE_DEG = 0.4
CACHE = pathlib.Path("amenities_cache")
CACHE.mkdir(exist_ok=True)

# ---- Area type ids (must match viewer.html) ----
A_PITCH_GRASS = 0   # leisure=pitch with grass/sport=soccer/football/rugby
A_PITCH_HARD  = 1   # leisure=pitch with hard surface (tennis, basketball, ...)
A_TRACK       = 2   # leisure=track
A_PLAYGROUND  = 3   # leisure=playground area
A_PARK        = 4   # leisure=park
A_GARDEN      = 5   # leisure=garden
A_POOL        = 6   # leisure=swimming_pool
A_SCHOOL_YARD = 7   # amenity=school / kindergarten yard
A_CEMETERY    = 8   # landuse=cemetery
A_GOLF        = 9   # leisure=golf_course
A_STADIUM     = 10  # leisure=stadium / sports_centre

# ---- Point type ids (must match viewer.html) ----
P_BENCH        = 0
P_PICNIC_TABLE = 1
P_SHELTER      = 2
P_ARTWORK      = 3
P_MEMORIAL     = 4
P_LIGHTHOUSE   = 5
P_PG_SWING        = 6
P_PG_SLIDE        = 7
P_PG_ROUNDABOUT   = 8
P_PG_CLIMBINGFRAME = 9
P_PG_SANDPIT      = 10
P_PG_SEESAW       = 11
P_PG_SPRINGY      = 12
P_PG_OTHER        = 13

HARD_PITCH_SPORTS = {
    "tennis", "basketball", "volleyball", "padel", "handball",
    "futsal", "table_tennis", "skateboard", "skating",
    "ice_hockey", "roller_skating", "5pin", "pelota",
}


def query_tile(s, w, n, e):
    fname = CACHE / f"t_{s:.2f}_{w:.2f}_{n:.2f}_{e:.2f}.json"
    if fname.exists() and fname.stat().st_size > 80:
        return json.loads(fname.read_text(encoding="utf-8"))
    q = (
        f"[out:json][timeout:240];"
        f"("
        f"way['leisure'~'^(pitch|track|stadium|sports_centre|swimming_pool|playground|park|garden|golf_course)$']({s},{w},{n},{e});"
        f"way['amenity'~'^(school|kindergarten)$']({s},{w},{n},{e});"
        f"way['landuse'='cemetery']({s},{w},{n},{e});"
        f"node['playground']({s},{w},{n},{e});"
        f"node['amenity'~'^(bench|picnic_table|shelter)$']({s},{w},{n},{e});"
        f"node['tourism'='artwork']({s},{w},{n},{e});"
        f"node['historic'='memorial']({s},{w},{n},{e});"
        f"node['man_made'='lighthouse']({s},{w},{n},{e});"
        f");"
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


def classify_area(tags):
    leisure = (tags.get("leisure") or "").lower()
    amenity = (tags.get("amenity") or "").lower()
    landuse = (tags.get("landuse") or "").lower()
    sport = (tags.get("sport") or "").lower().split(";")[0].strip()
    surface = (tags.get("surface") or "").lower()

    if leisure == "pitch":
        if sport in HARD_PITCH_SPORTS or surface in (
            "asphalt", "concrete", "paving_stones", "clay",
            "artificial_turf", "tartan", "rubber",
        ):
            return A_PITCH_HARD
        return A_PITCH_GRASS
    if leisure == "track":
        return A_TRACK
    if leisure == "playground":
        return A_PLAYGROUND
    if leisure == "park":
        return A_PARK
    if leisure == "garden":
        return A_GARDEN
    if leisure == "swimming_pool":
        return A_POOL
    if leisure == "golf_course":
        return A_GOLF
    if leisure in ("stadium", "sports_centre"):
        return A_STADIUM
    if amenity in ("school", "kindergarten"):
        return A_SCHOOL_YARD
    if landuse == "cemetery":
        return A_CEMETERY
    return None


def classify_point(tags):
    pg = (tags.get("playground") or "").lower()
    if pg:
        if "swing" in pg:        return P_PG_SWING
        if "slide" in pg:        return P_PG_SLIDE
        if "roundabout" in pg or "carousel" in pg: return P_PG_ROUNDABOUT
        if "climbing" in pg or "structure" in pg or "rope" in pg: return P_PG_CLIMBINGFRAME
        if "sandpit" in pg or "sandbox" in pg: return P_PG_SANDPIT
        if "seesaw" in pg or "see_saw" in pg: return P_PG_SEESAW
        if "springy" in pg or "spring" in pg: return P_PG_SPRINGY
        return P_PG_OTHER
    amenity = (tags.get("amenity") or "").lower()
    if amenity == "bench":          return P_BENCH
    if amenity == "picnic_table":   return P_PICNIC_TABLE
    if amenity == "shelter":        return P_SHELTER
    if (tags.get("tourism") or "").lower() == "artwork":     return P_ARTWORK
    if (tags.get("historic") or "").lower() == "memorial":   return P_MEMORIAL
    if (tags.get("man_made") or "").lower() == "lighthouse": return P_LIGHTHOUSE
    return None


# Per-area maximum kept vertex counts and densification spacing.
# Polygons are first simplified (Douglas-Peucker), then *densified* so that
# subsequent draping onto the DEM still has reasonable sub-vertex elevation
# fidelity. Cap protects against pathological huge OSM polygons.
SIMPLIFY_TOL_M = 1.5
DENSIFY_STEP_M = {
    A_PITCH_GRASS: 6.0,   A_PITCH_HARD: 5.0,    A_TRACK: 4.0,
    A_PLAYGROUND: 5.0,    A_PARK: 12.0,          A_GARDEN: 6.0,
    A_POOL: 3.0,          A_SCHOOL_YARD: 10.0,   A_CEMETERY: 12.0,
    A_GOLF: 20.0,         A_STADIUM: 8.0,
}
MAX_VERTS_PER_AREA = 256


def densify_ring(coords_xy, step_m):
    """Add intermediate points so no edge is longer than step_m. Drop closing dup."""
    if len(coords_xy) < 3:
        return coords_xy
    if coords_xy[0] == coords_xy[-1]:
        coords_xy = coords_xy[:-1]
    out = []
    n = len(coords_xy)
    for i in range(n):
        x0, y0 = coords_xy[i]
        x1, y1 = coords_xy[(i + 1) % n]
        out.append((x0, y0))
        dx, dy = x1 - x0, y1 - y0
        d = math.hypot(dx, dy)
        if d > step_m:
            k = int(math.ceil(d / step_m))
            for j in range(1, k):
                t = j / k
                out.append((x0 + t * dx, y0 + t * dy))
    return out


def main():
    print(f"tiling {S}-{N} N x {W}-{E} E in {TILE_DEG} deg steps", flush=True)
    n_lat = int(math.ceil((N - S) / TILE_DEG))
    n_lon = int(math.ceil((E - W) / TILE_DEG))
    tiles = []
    for i in range(n_lat):
        for j in range(n_lon):
            tiles.append((S + i * TILE_DEG, W + j * TILE_DEG,
                          min(N, S + (i + 1) * TILE_DEG),
                          min(E, W + (j + 1) * TILE_DEG)))
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

    seen_ways = set()
    seen_nodes = set()
    areas = []   # (type_id, baseZ, [(x,y), ...]) in centred coords
    points = []  # (type_id, x, y, z) in centred coords
    skipped_small = skipped_oob = skipped_unclassified = 0

    for k, (s, w, n, e) in enumerate(tiles):
        print(f"[{k+1}/{len(tiles)}] {s:.2f},{w:.2f}..{n:.2f},{e:.2f}", flush=True)
        try:
            data = query_tile(s, w, n, e)
        except Exception as exc:
            print(f"   skipped tile: {exc}", flush=True)
            continue
        for el in data.get("elements", []):
            etype = el.get("type")
            tags = el.get("tags") or {}
            if etype == "way":
                wid = el.get("id")
                if wid in seen_ways:
                    continue
                seen_ways.add(wid)
                tid = classify_area(tags)
                if tid is None:
                    skipped_unclassified += 1
                    continue
                geom = el.get("geometry") or []
                if len(geom) < 4:
                    continue
                xy = [tr.transform(g["lon"], g["lat"]) for g in geom]
                try:
                    poly = Polygon(xy)
                    if not poly.is_valid:
                        poly = poly.buffer(0)
                    if poly.is_empty or poly.geom_type != "Polygon":
                        continue
                    area_m2 = poly.area
                except Exception:
                    continue
                # very small things ignored (artefacts, tiny school yard misclassifs)
                if area_m2 < 20.0:
                    skipped_small += 1
                    continue
                cx, cy = poly.centroid.x, poly.centroid.y
                if not (bnds.left <= cx <= bnds.right and bnds.bottom <= cy <= bnds.top):
                    skipped_oob += 1
                    continue
                # simplify, densify, cap verts
                simp = poly.simplify(SIMPLIFY_TOL_M, preserve_topology=True)
                if simp.is_empty or simp.geom_type != "Polygon":
                    simp = poly
                ring = list(simp.exterior.coords)
                step = DENSIFY_STEP_M.get(tid, 8.0)
                dens = densify_ring(ring, step)
                if len(dens) > MAX_VERTS_PER_AREA:
                    # decimate uniformly
                    keep_every = max(1, math.ceil(len(dens) / MAX_VERTS_PER_AREA))
                    dens = dens[::keep_every]
                if len(dens) < 3:
                    continue
                base_z = sample_z(cx, cy)
                # per-vertex z (drape on terrain so big polygons follow slopes)
                centred = [(x - CX, y - CY, sample_z(x, y)) for (x, y) in dens]
                areas.append((tid, base_z, centred))
            elif etype == "node":
                nid = el.get("id")
                if nid in seen_nodes:
                    continue
                seen_nodes.add(nid)
                tid = classify_point(tags)
                if tid is None:
                    skipped_unclassified += 1
                    continue
                lat = el.get("lat"); lon = el.get("lon")
                if lat is None or lon is None:
                    continue
                x, y = tr.transform(lon, lat)
                if not (bnds.left <= x <= bnds.right and bnds.bottom <= y <= bnds.top):
                    skipped_oob += 1
                    continue
                z = sample_z(x, y)
                points.append((tid, x - CX, y - CY, z))
        print(f"   running: areas={len(areas):,} points={len(points):,}", flush=True)

    print(f"\ntotal: {len(areas):,} areas, {len(points):,} points "
          f"(small={skipped_small}, oob={skipped_oob}, unclassified={skipped_unclassified})")

    # ----- binary emit -----
    out = io.BytesIO()
    out.write(b"AMN1")
    out.write(struct.pack("<I", len(areas)))
    for tid, base_z, ring in areas:
        out.write(struct.pack("<HHf", tid, len(ring), base_z))
        flat = np.array(ring, dtype="<f4").reshape(-1)  # x,y,z triples
        out.write(flat.tobytes())
    out.write(struct.pack("<I", len(points)))
    parr = np.empty(len(points), dtype=[
        ("t", "<u2"), ("p", "<u2"), ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
    ])
    for i, (tid, x, y, z) in enumerate(points):
        parr[i] = (tid, 0, x, y, z)
    out.write(parr.tobytes())
    pathlib.Path("amenities.bin").write_bytes(out.getvalue())
    print(f"wrote amenities.bin ({pathlib.Path('amenities.bin').stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
