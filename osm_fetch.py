"""Fetch OSM roads + Norwegian municipality (kommune) boundaries for the Rogaland
bbox via Overpass, reproject to EPSG:25833, sample heights from the 10 m DEM,
densify long segments so they hug topography, and emit osm.json for the viewer.
"""
from __future__ import annotations
import json
import math
import sys
import time
import pathlib
import requests
import rasterio
import numpy as np
from pyproj import Transformer

# bbox in WGS84 (S,W,N,E) covering Rogaland comfortably
BBOX_WGS = (58.0, 4.0, 60.5, 7.5)
ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary"}
DENSIFY_ROAD_M = 25.0
DENSIFY_BORDER_M = 100.0
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (rogaland topography demo)",
    "Accept": "application/json",
}

QUERY = f"""
[out:json][timeout:240];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  relation["boundary"="administrative"]["admin_level"="7"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
);
out geom;
"""


def fetch():
    cache = pathlib.Path("osm_raw.json")
    if cache.exists() and cache.stat().st_size > 1000:
        print(f"using cached {cache}")
        return json.loads(cache.read_text(encoding="utf-8"))
    print("querying Overpass...", flush=True)
    last_err = None
    for url in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"  -> {url} (attempt {attempt+1})", flush=True)
                r = requests.post(url, data={"data": QUERY}, headers=HEADERS, timeout=300)
                r.raise_for_status()
                cache.write_text(r.text, encoding="utf-8")
                return r.json()
            except Exception as e:
                last_err = e
                wait = 10 * (attempt + 1)
                print(f"     failed: {e}; sleeping {wait}s", flush=True)
                time.sleep(wait)
    raise SystemExit(f"Overpass failed: {last_err}")


def main():
    data = fetch()
    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)

    ds = rasterio.open("rogaland_10m.tif")
    band = ds.read(1)
    inv = ~ds.transform
    nodata = ds.nodata
    H, W = band.shape
    b = ds.bounds
    CX, CY = (b.left + b.right) / 2, (b.bottom + b.top) / 2

    def sample_z(x, y):
        col, row = inv * (x, y)
        c, r = int(col), int(row)
        if 0 <= c < W and 0 <= r < H:
            v = band[r, c]
            if v == nodata:
                return 0.0
            return float(max(v, 0.0))
        return 0.0

    def project_pts(latlon_pts, densify_m):
        xy = [tr.transform(lon, lat) for lat, lon in latlon_pts]
        out = []
        for i, (x, y) in enumerate(xy):
            if i > 0:
                x0, y0 = xy[i - 1]
                d = math.hypot(x - x0, y - y0)
                if d > densify_m:
                    n = int(d / densify_m)
                    for k in range(1, n + 1):
                        t = k / (n + 1)
                        xi = x0 + (x - x0) * t
                        yi = y0 + (y - y0) * t
                        out.append([xi - CX, yi - CY, sample_z(xi, yi)])
            out.append([x - CX, y - CY, sample_z(x, y)])
        # filter to source bbox to drop content outside the DEM (kommuner spilling out)
        return out

    def in_dem(p):
        x, y = p[0] + CX, p[1] + CY
        return b.left <= x <= b.right and b.bottom <= y <= b.top

    roads = []
    towns = []
    n_ways = n_rels = 0
    for el in data.get("elements", []):
        t = el.get("type")
        tags = el.get("tags") or {}
        geom = el.get("geometry")
        if t == "way" and geom and tags.get("highway") in ROAD_CLASSES:
            n_ways += 1
            pts = [(g["lat"], g["lon"]) for g in geom]
            proj = project_pts(pts, DENSIFY_ROAD_M)
            # only keep ways with at least one vertex inside DEM
            if any(in_dem(p) for p in proj):
                roads.append({"cls": tags["highway"], "pts": proj})
        elif t == "relation" and tags.get("admin_level") == "7" and tags.get("boundary") == "administrative":
            n_rels += 1
            name = tags.get("name", "")
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("role") == "outer" and "geometry" in m:
                    pts = [(g["lat"], g["lon"]) for g in m["geometry"]]
                    proj = project_pts(pts, DENSIFY_BORDER_M)
                    if any(in_dem(p) for p in proj):
                        towns.append({"name": name, "pts": proj})

    print(f"ways considered: {n_ways}; relations: {n_rels}")
    print(f"emitted: {len(roads)} roads, {len(towns)} boundary segments")

    # group roads by class index
    cls_order = ["motorway", "trunk", "primary", "secondary", "tertiary"]
    by_cls = {c: [] for c in cls_order}
    for r in roads:
        if r["cls"] in by_cls:
            by_cls[r["cls"]].append(r["pts"])

    # ---- binary OSM2 layout (little-endian) ----
    # magic[4] = "OSM2"
    # uint32 nGroups
    # float64 centerX, centerY
    # for each group:
    #   uint8 classIdx (0..4 road class, 5 = town boundary), uint8[3] pad
    #   uint32 vertexCount  (vertices already in LineSegments pair order)
    #   float32 x, y, z  * vertexCount
    import struct
    parts = []
    parts.append(b"OSM2")
    n_groups = sum(1 for c in cls_order if by_cls[c]) + (1 if towns else 0)
    parts.append(struct.pack("<I", n_groups))
    parts.append(struct.pack("<dd", CX, CY))

    def encode_group(cls_idx, polys):
        verts = []
        for pl in polys:
            for i in range(1, len(pl)):
                verts.append(pl[i - 1])
                verts.append(pl[i])
        if not verts:
            return None
        arr = np.asarray(verts, dtype=np.float32)
        hdr = struct.pack("<BBBBI", cls_idx, 0, 0, 0, arr.shape[0])
        return hdr + arr.tobytes(order="C")

    for idx, c in enumerate(cls_order):
        g = encode_group(idx, by_cls[c])
        if g:
            parts.append(g)
    if towns:
        g = encode_group(5, [t["pts"] for t in towns])
        if g:
            parts.append(g)

    bin_path = pathlib.Path("osm.bin")
    bin_path.write_bytes(b"".join(parts))
    print(f"wrote {bin_path} ({bin_path.stat().st_size/1024/1024:.1f} MB)")


if __name__ == "__main__":
    main()
