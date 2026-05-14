"""Fetch named towns, peaks/hills, and lakes from OSM across the Rogaland DEM bbox
and emit `features.json` for the client label system.

Output JSON layout:
  {
    "centerX": float,        # EPSG:25833, matches osm.bin / e39.bin
    "centerY": float,
    "features": [
      {
        "name": str,
        "kind": "town" | "village" | "peak" | "hill" | "lake",
        "rank": int,         # 0=biggest (city), 1=town, 2=village, 3=hamlet, etc.
        "x": float,          # EPSG:25833 minus centerX
        "y": float,          # EPSG:25833 minus centerY
        "z": float           # raw DEM elevation; client multiplies by uExag
      },
      ...
    ]
  }

Run with:
  uv run --no-project --with numpy --with rasterio --with pyproj --with requests \\
      python extract_named_features.py
"""
from __future__ import annotations
import json
import pathlib
import time

import numpy as np
import rasterio
import requests
from pyproj import Transformer

BBOX_WGS = (58.0, 4.0, 60.5, 7.5)  # matches the Rogaland DEM coverage

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (named features)",
    "Accept": "application/json",
}

# place rank: smaller = more important. Used by the client only as a tiebreaker if it ever
# needs to thin labels at high density; for now every feature is shown.
PLACE_RANK = {
    "city": 0,
    "town": 1,
    "village": 2,
    "hamlet": 3,
    "suburb": 4,
}

QUERY = f"""
[out:json][timeout:180];
(
  node["place"~"^(city|town|village|hamlet)$"]["name"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  node["natural"="peak"]["name"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  node["natural"="hill"]["name"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  way["natural"="water"]["name"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  relation["natural"="water"]["name"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
);
out center;
"""


def fetch() -> dict:
    """Return parsed Overpass JSON, caching it locally to avoid re-querying on reruns."""
    cache = pathlib.Path("features_raw.json")
    if cache.exists():
        print(f"using cached {cache}")
        return json.loads(cache.read_text(encoding="utf-8"))
    last_err: Exception | None = None
    for ep in OVERPASS_ENDPOINTS:
        try:
            print(f"fetching from {ep} ...")
            r = requests.post(ep, data={"data": QUERY}, headers=HEADERS, timeout=200)
            r.raise_for_status()
            data = r.json()
            cache.write_text(json.dumps(data), encoding="utf-8")
            return data
        except Exception as e:
            print(f"  failed: {e}")
            last_err = e
            time.sleep(2)
    raise SystemExit(f"all Overpass endpoints failed: {last_err}")


def main() -> None:
    data = fetch()
    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)

    ds = rasterio.open("rogaland_10m.tif")
    band = ds.read(1)
    inv = ~ds.transform
    nodata = ds.nodata
    H, W = band.shape
    b = ds.bounds
    CX, CY = (b.left + b.right) / 2.0, (b.bottom + b.top) / 2.0

    def sample_z(x: float, y: float) -> float | None:
        """Return DEM elevation in metres, or None if (x, y) is outside DEM coverage."""
        col, row = inv * (x, y)
        c, r = int(col), int(row)
        if 0 <= c < W and 0 <= r < H:
            v = band[r, c]
            if v == nodata:
                return None
            return float(max(v, 0.0))
        return None

    seen: set[tuple[str, int, int]] = set()  # de-dup by (name, x_round, y_round)
    out_features: list[dict] = []
    n_place = n_peak = n_hill = n_lake = 0

    for el in data.get("elements", []):
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue
        kind: str
        rank: int
        if "place" in tags:
            place = tags["place"]
            if place not in PLACE_RANK:
                continue
            kind = "town" if place in ("city", "town") else "village"
            rank = PLACE_RANK[place]
        elif tags.get("natural") == "peak":
            kind, rank = "peak", 10
        elif tags.get("natural") == "hill":
            kind, rank = "hill", 11
        elif tags.get("natural") == "water":
            kind, rank = "lake", 20
        else:
            continue

        # Resolve the feature's representative lat/lon. Nodes give lat/lon; ways/relations
        # come back with `center` from `out center;`.
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            lat, lon = c.get("lat"), c.get("lon")
        if lat is None or lon is None:
            continue

        x, y = tr.transform(lon, lat)
        key = (name, round(x), round(y))
        if key in seen:
            continue
        seen.add(key)

        z = sample_z(x, y)
        if z is None:
            continue  # outside DEM coverage — would float at z=0 and look wrong
        # For peaks: prefer OSM ele tag when present; the DEM at the exact peak point is often
        # a few metres off because OSM peak nodes don't sit on a DEM pixel centre.
        if kind == "peak":
            ele = tags.get("ele")
            try:
                if ele is not None:
                    z = max(float(ele), z)
            except ValueError:
                pass

        out_features.append({
            "name": name,
            "kind": kind,
            "rank": rank,
            "x": round(x - CX, 1),
            "y": round(y - CY, 1),
            "z": round(z, 1),
        })
        if kind in ("town", "village"):
            n_place += 1
        elif kind == "peak":
            n_peak += 1
        elif kind == "hill":
            n_hill += 1
        elif kind == "lake":
            n_lake += 1

    print(f"features: {len(out_features)} total "
          f"(places={n_place}, peaks={n_peak}, hills={n_hill}, lakes={n_lake})")

    payload = {
        "centerX": CX,
        "centerY": CY,
        "features": out_features,
    }
    out = pathlib.Path("features.json")
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
