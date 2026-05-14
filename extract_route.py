"""Generic road-trip route extractor. Takes one or more route configs, queries Overpass
for the highway ways matching each route's `ref`, stitches them into a connected polyline
between two named endpoints, samples DEM heights, and writes a `<id>.bin` file in the same
format used by the viewer's road-trip system. Also writes/updates `trips.json` which lists
every configured route along with display labels and route length.

Run with:
  uv run --no-project --with numpy --with rasterio --with pyproj --with requests \\
      python extract_route.py [route_id|all]

Binary layout (little-endian) for every route — same as the original e39.bin:
  magic[4]    = "E391"
  uint32 nPts
  uint32 idxFrom       (index of the "from" endpoint in the densified point array)
  uint32 idxTo         (index of the "to" endpoint)
  float64 centerX, centerY    (matches osm.bin scene centre)
  Float32Array[nPts, 4]       (x - cx, y - cy, z_raw, cumulativeDistMeters)

Endpoint labels and the relationship between "from"/"to" and the on-screen names are kept
out of the binary and recorded in `trips.json` instead, so the client picks up labels and
display titles from there without re-running the extractor.
"""
from __future__ import annotations
import json
import math
import pathlib
import struct
import sys
import time
from collections import defaultdict, deque

import numpy as np
import rasterio
import requests
from pyproj import Transformer

DENSIFY_M = 25.0

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (road-trip extractor)",
    "Accept": "application/json",
}

# Each route is a self-contained config. The Overpass query is assembled from `filters`,
# which is a list of partial way-tag filters; for E39 we need both `ref` and `int_ref`
# because some segments only tag one or the other. `bbox` is (S, W, N, E) in WGS84.
ROUTES: dict[str, dict] = {
    "e39": {
        "title": "E39 · Mekjarvik – Egersund",
        "bbox": (58.30, 5.30, 59.15, 6.30),
        "filters": [
            '["ref"~"(^|[;, ])E\\\\s*39([;, ]|$)"]',
            '["int_ref"~"(^|[;, ])E\\\\s*39([;, ]|$)"]',
        ],
        "from": {"id": "mekjarvik", "label": "Mekjarvik", "lat": 59.0185, "lon": 5.6390},
        "to":   {"id": "egersund",  "label": "Egersund",  "lat": 58.4513, "lon": 6.0009},
    },
    "byrkjedal": {
        "title": "Fv450 · Ålgård – Byrkjedalstunet",
        # Tighter bbox keeps the Overpass response small and avoids pulling in unrelated
        # roads with the same ref outside Rogaland. Hunnedalsvegen (Fv450) tops out at
        # ~58.86N / 6.45E within this corridor, more than enough to reach Byrkjedalstunet.
        "bbox": (58.60, 5.70, 58.90, 6.45),
        # The Ålgård → Byrkjedal road is signed "Fv450" (Hunnedalsvegen). In OSM, ways
        # along this corridor are tagged `ref="450"` (no Fv prefix). The whole-token
        # regex prevents accidental matches against 4500/4501/etc.
        "filters": [
            '["ref"~"(^|[;, ])450([;, ]|$)"]',
        ],
        "from": {"id": "algard",          "label": "Ålgård",          "lat": 58.7691, "lon": 5.8482},
        "to":   {"id": "byrkjedalstunet", "label": "Byrkjedalstunet", "lat": 58.7798, "lon": 6.3155},
    },
}


def overpass_query_for(route: dict) -> str:
    """Assemble the Overpass QL query for `route`, ORing every filter as a separate way
    selector inside the same union so each contributing tag scheme is picked up."""
    s, w, n, e = route["bbox"]
    bbox = f"{s},{w},{n},{e}"
    parts = [f'  way["highway"]{flt}({bbox});' for flt in route["filters"]]
    return f"""
[out:json][timeout:240];
(
{chr(10).join(parts)}
);
out geom;
"""


def fetch(route_id: str, route: dict) -> dict:
    """Fetch (or load from disk cache) the Overpass response for `route`."""
    cache = pathlib.Path(f"{route_id}_raw.json")
    if cache.exists() and cache.stat().st_size > 1000:
        print(f"using cached {cache}")
        return json.loads(cache.read_text(encoding="utf-8"))
    query = overpass_query_for(route)
    print(f"querying Overpass for {route_id}...", flush=True)
    last_err: Exception | None = None
    for url in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"  -> {url} (attempt {attempt+1})", flush=True)
                r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=300)
                r.raise_for_status()
                cache.write_text(r.text, encoding="utf-8")
                return r.json()
            except Exception as e:  # noqa: BLE001
                last_err = e
                wait = 10 * (attempt + 1)
                print(f"     failed: {e}; sleeping {wait}s", flush=True)
                time.sleep(wait)
    raise SystemExit(f"Overpass failed for {route_id}: {last_err}")


def build_route_bin(route_id: str, route: dict) -> dict:
    """Extract, stitch, densify, and write `<route_id>.bin`. Returns the manifest entry
    (title, file, labels, lengthKm) so callers can assemble `trips.json`.
    """
    data = fetch(route_id, route)
    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)

    ds = rasterio.open("rogaland_10m.tif")
    band = ds.read(1)
    inv = ~ds.transform
    nodata = ds.nodata
    H, W = band.shape
    b = ds.bounds
    CX, CY = (b.left + b.right) / 2.0, (b.bottom + b.top) / 2.0

    def sample_z(x: float, y: float) -> float:
        col, row = inv * (x, y)
        c, r = int(col), int(row)
        if 0 <= c < W and 0 <= r < H:
            v = band[r, c]
            if v == nodata:
                return 0.0
            return float(max(v, 0.0))
        return 0.0

    # ----- collect ways as projected polylines -----
    ways: list[list[tuple[float, float]]] = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        ways.append([tr.transform(g["lon"], g["lat"]) for g in geom])
    print(f"[{route_id}] ways: {len(ways)}")
    if not ways:
        raise SystemExit(f"[{route_id}] no ways returned from Overpass")

    # ----- undirected graph with 1m-quantised vertex matching so shared endpoints connect -----
    Q = 1.0

    def key(x: float, y: float) -> tuple[int, int]:
        return (int(round(x / Q)), int(round(y / Q)))

    node_id_of: dict[tuple[int, int], int] = {}
    node_xy: list[tuple[float, float]] = []

    def get_node(x: float, y: float) -> int:
        k = key(x, y)
        nid = node_id_of.get(k)
        if nid is None:
            nid = len(node_xy)
            node_id_of[k] = nid
            node_xy.append((x, y))
        return nid

    adj: dict[int, list[int]] = defaultdict(list)
    for w in ways:
        ids = [get_node(x, y) for (x, y) in w]
        for j in range(len(ids) - 1):
            a, b = ids[j], ids[j + 1]
            if a == b:
                continue
            adj[a].append(b)
            adj[b].append(a)

    print(f"[{route_id}] nodes: {len(node_xy)}, half-edges: {sum(len(v) for v in adj.values())}")

    # ----- locate anchor nodes nearest each WGS endpoint -----
    def nearest_node(target_lat: float, target_lon: float) -> int:
        tx, ty = tr.transform(target_lon, target_lat)
        best_id = -1
        best_d2 = math.inf
        for nid, (x, y) in enumerate(node_xy):
            d2 = (x - tx) ** 2 + (y - ty) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_id = nid
        return best_id

    from_id = nearest_node(route["from"]["lat"], route["from"]["lon"])
    to_id   = nearest_node(route["to"]["lat"],   route["to"]["lon"])
    fx, fy = node_xy[from_id]
    tx, ty = node_xy[to_id]
    print(f"[{route_id}] FROM '{route['from']['label']}' anchor node {from_id} @ ({fx:.0f},{fy:.0f})")
    print(f"[{route_id}] TO   '{route['to']['label']}' anchor node {to_id} @ ({tx:.0f},{ty:.0f})")

    # ----- BFS shortest path in the graph (edge count). OSM segments are short so this
    # approximates the geodesic well and avoids gnarly detours.
    def bfs_path(src: int, dst: int) -> list[int] | None:
        prev: dict[int, int] = {src: -1}
        q = deque([src])
        while q:
            u = q.popleft()
            if u == dst:
                break
            for v in adj[u]:
                if v not in prev:
                    prev[v] = u
                    q.append(v)
        if dst not in prev:
            return None
        out = []
        cur = dst
        while cur != -1:
            out.append(cur)
            cur = prev[cur]
        out.reverse()
        return out

    path = bfs_path(from_id, to_id)
    if path is None:
        # Same fallback as the old extract_e39: ferry gap or disconnected components.
        # Pick the component containing `to_id` and use its farthest reachable node as the
        # surrogate "from" endpoint so we still emit a usable route.
        print(f"[{route_id}] WARNING: endpoints not connected; falling back to largest"
              " component containing the TO endpoint.")
        prev = {to_id: -1}
        q = deque([to_id])
        order = []
        while q:
            u = q.popleft()
            order.append(u)
            for v in adj[u]:
                if v not in prev:
                    prev[v] = u
                    q.append(v)
        far_id = order[-1]
        path = []
        cur = far_id
        while cur != -1:
            path.append(cur)
            cur = prev[cur]
        from_id = far_id

    print(f"[{route_id}] path nodes: {len(path)}")

    # ----- materialise + densify -----
    raw_xy = [node_xy[nid] for nid in path]
    dense: list[tuple[float, float]] = []
    for i, (x, y) in enumerate(raw_xy):
        if i == 0:
            dense.append((x, y))
            continue
        x0, y0 = raw_xy[i - 1]
        d = math.hypot(x - x0, y - y0)
        if d > DENSIFY_M:
            n = int(d / DENSIFY_M)
            for k in range(1, n + 1):
                t = k / (n + 1)
                dense.append((x0 + (x - x0) * t, y0 + (y - y0) * t))
        dense.append((x, y))

    cum = 0.0
    pts: list[tuple[float, float, float, float]] = []
    for i, (x, y) in enumerate(dense):
        if i > 0:
            x0, y0 = dense[i - 1]
            cum += math.hypot(x - x0, y - y0)
        z = sample_z(x, y)
        pts.append((x - CX, y - CY, z, cum))

    idx_from = 0
    idx_to = len(pts) - 1
    length_km = cum / 1000.0
    print(f"[{route_id}] densified to {len(pts)} points, {length_km:.1f} km")

    # ----- pack binary -----
    parts: list[bytes] = [
        b"E391",
        struct.pack("<III", len(pts), idx_from, idx_to),
        struct.pack("<dd", CX, CY),
    ]
    arr = np.asarray(pts, dtype=np.float32)
    parts.append(arr.tobytes(order="C"))

    bin_path = pathlib.Path(f"{route_id}.bin")
    bin_path.write_bytes(b"".join(parts))
    print(f"[{route_id}] wrote {bin_path} ({bin_path.stat().st_size/1024:.1f} KB)")

    return {
        "id": route_id,
        "title": route["title"],
        "file": bin_path.name,
        "fromLabel": route["from"]["label"],
        "toLabel": route["to"]["label"],
        "lengthKm": round(length_km, 1),
    }


def write_manifest(entries: list[dict]) -> None:
    """Write `trips.json` listing every route currently extractable. Order follows the
    `ROUTES` dict so the client gets a stable presentation order."""
    out = pathlib.Path("trips.json")
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def main() -> None:
    requested = sys.argv[1] if len(sys.argv) > 1 else "all"
    if requested == "all":
        targets = list(ROUTES.keys())
    elif requested in ROUTES:
        targets = [requested]
    else:
        raise SystemExit(f"unknown route '{requested}'; known: {list(ROUTES.keys())}")

    # Build each target. For routes not in `targets` but already extracted (their .bin
    # exists), still include them in trips.json so the client doesn't lose a route just
    # because we re-ran the extractor for a single one.
    entries: list[dict] = []
    for rid, route in ROUTES.items():
        if rid in targets:
            entries.append(build_route_bin(rid, route))
        else:
            bin_path = pathlib.Path(f"{rid}.bin")
            if not bin_path.exists():
                print(f"skip {rid}: {bin_path} not present and not requested")
                continue
            # Recover length from the existing binary so trips.json stays consistent.
            with bin_path.open("rb") as f:
                data = f.read()
            n_pts = struct.unpack("<I", data[4:8])[0]
            arr = np.frombuffer(data, dtype=np.float32, offset=4 + 12 + 16, count=n_pts * 4).reshape(-1, 4)
            length_km = float(arr[-1, 3]) / 1000.0
            entries.append({
                "id": rid,
                "title": route["title"],
                "file": bin_path.name,
                "fromLabel": route["from"]["label"],
                "toLabel": route["to"]["label"],
                "lengthKm": round(length_km, 1),
            })
    write_manifest(entries)


if __name__ == "__main__":
    main()
