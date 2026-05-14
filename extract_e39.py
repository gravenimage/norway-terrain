"""Extract the E39 road as a single connected polyline between Mekjarvik (north of Stavanger)
and Egersund, project to EPSG:25833, sample DEM heights, and write e39.bin for the viewer.

Output binary layout (little-endian):
  magic[4]      = "E391"
  uint32 nPts
  uint32 idxMekjarvik
  uint32 idxEgersund
  float64 centerX, centerY        (matches osm.bin, so client can subtract its scene center)
  Float32Array[nPts, 4]           (x - cx, y - cy, z, cumulativeDistMeters)

Endpoints are derived by finding the E39 vertex nearest the named WGS84 lat/lon locations.
If E39 ways don't form a single connected component containing both targets (e.g. ferry gap),
we keep the largest connected component that contains at least one target and pick the two
vertices in that component nearest to the requested lat/lons.
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

BBOX_WGS = (58.30, 5.30, 59.15, 6.30)  # covers Mekjarvik → Egersund corridor
DENSIFY_M = 25.0

# Named endpoints in WGS84 (lat, lon)
ENDPOINTS_WGS = {
    "mekjarvik": (59.0185, 5.6390),
    "egersund": (58.4513, 6.0009),
}

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HEADERS = {
    "User-Agent": "norwayterrain-experiment/1.0 (e39 road-trip)",
    "Accept": "application/json",
}

# Match any way tagged with ref=E39 or int_ref containing E39 (covers E 39, E39;Rv etc.)
QUERY = f"""
[out:json][timeout:240];
(
  way["highway"]["ref"~"(^|[;, ])E\\\\s*39([;, ]|$)"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
  way["highway"]["int_ref"~"(^|[;, ])E\\\\s*39([;, ]|$)"]({BBOX_WGS[0]},{BBOX_WGS[1]},{BBOX_WGS[2]},{BBOX_WGS[3]});
);
out geom;
"""


def fetch_e39():
    cache = pathlib.Path("e39_raw.json")
    if cache.exists() and cache.stat().st_size > 1000:
        print(f"using cached {cache}")
        return json.loads(cache.read_text(encoding="utf-8"))
    print("querying Overpass for E39...", flush=True)
    last_err = None
    for url in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"  -> {url} (attempt {attempt+1})", flush=True)
                r = requests.post(url, data={"data": QUERY}, headers=HEADERS, timeout=300)
                r.raise_for_status()
                cache.write_text(r.text, encoding="utf-8")
                return r.json()
            except Exception as e:  # noqa: BLE001
                last_err = e
                wait = 10 * (attempt + 1)
                print(f"     failed: {e}; sleeping {wait}s", flush=True)
                time.sleep(wait)
    raise SystemExit(f"Overpass failed: {last_err}")


def main():
    data = fetch_e39()
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

    # ----- collect E39 ways as projected polylines -----
    ways = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        # Project all way nodes to EPSG:25833
        xy = [tr.transform(g["lon"], g["lat"]) for g in geom]
        ways.append(xy)
    print(f"E39 ways: {len(ways)}")
    if not ways:
        raise SystemExit("no E39 ways returned from Overpass")

    # ----- build undirected graph keyed by quantized vertex positions -----
    # Quantize to 1 metre buckets so OSM ways that share endpoints (often spelled the same node id
    # in raw OSM, but here we've already discarded ids in favour of plain geometry) connect.
    Q = 1.0

    def key(x: float, y: float) -> tuple[int, int]:
        return (int(round(x / Q)), int(round(y / Q)))

    # node_id (integer) per quantized key; store its representative (x, y).
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

    # adjacency: node_id -> list of (neighbor_node_id, way_index, vertex_index_a, vertex_index_b)
    adj: dict[int, list[tuple[int, int, int, int]]] = defaultdict(list)
    # way_nodes[way_index] = [node_id per vertex]
    way_nodes: list[list[int]] = []
    for wi, w in enumerate(ways):
        ids = [get_node(x, y) for (x, y) in w]
        way_nodes.append(ids)
        for j in range(len(ids) - 1):
            a, b = ids[j], ids[j + 1]
            if a == b:
                continue
            adj[a].append((b, wi, j, j + 1))
            adj[b].append((a, wi, j + 1, j))

    print(f"nodes: {len(node_xy)}, edges (directed half): {sum(len(v) for v in adj.values())}")

    # ----- locate endpoint nodes (project requested WGS lat/lon and find nearest existing node) -----
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

    mek_id = nearest_node(*ENDPOINTS_WGS["mekjarvik"])
    egs_id = nearest_node(*ENDPOINTS_WGS["egersund"])
    mx, my = node_xy[mek_id]
    ex, ey = node_xy[egs_id]
    print(f"Mekjarvik anchor node {mek_id} @ ({mx:.0f}, {my:.0f})")
    print(f"Egersund  anchor node {egs_id} @ ({ex:.0f}, {ey:.0f})")

    # ----- find shortest path Mekjarvik -> Egersund in the graph (BFS by edge count;
    # edges are short ~OSM segment, so this approximates the geodesic on the network well enough,
    # and avoids picking weird hairy detours).
    # If they're not connected, log a warning and pick the largest connected component containing
    # Egersund (south stretch is the most useful demo).
    def bfs_path(src: int, dst: int) -> list[int] | None:
        prev: dict[int, int] = {src: -1}
        q = deque([src])
        while q:
            u = q.popleft()
            if u == dst:
                break
            for (v, _wi, _ja, _jb) in adj[u]:
                if v not in prev:
                    prev[v] = u
                    q.append(v)
        if dst not in prev:
            return None
        path = []
        cur = dst
        while cur != -1:
            path.append(cur)
            cur = prev[cur]
        path.reverse()
        return path

    path = bfs_path(mek_id, egs_id)
    if path is None:
        print("WARNING: Mekjarvik and Egersund not in same E39 connected component (ferry gap?).")
        # find component containing egersund
        seen: set[int] = set()
        q = deque([egs_id])
        seen.add(egs_id)
        while q:
            u = q.popleft()
            for (v, _wi, _ja, _jb) in adj[u]:
                if v not in seen:
                    seen.add(v)
                    q.append(v)
        # pick node in this component furthest (network-hops) from egs_id; treat that as
        # the northern endpoint so we still produce a usable route.
        prev = {egs_id: -1}
        q = deque([egs_id])
        order = []
        while q:
            u = q.popleft()
            order.append(u)
            for (v, _wi, _ja, _jb) in adj[u]:
                if v not in prev:
                    prev[v] = u
                    q.append(v)
        far_id = order[-1]
        print(f"  using component-only fallback: far node {far_id} <-> {egs_id}")
        # reconstruct from far_id to egs_id by following prev
        path = []
        cur = far_id
        while cur != -1:
            path.append(cur)
            cur = prev[cur]
        # path is far->egs; reverse so it reads start->end like Mekjarvik->Egersund
        # treat far_id as the new "mekjarvik" node for header purposes.
        mek_id = far_id

    print(f"path length (node hops): {len(path)}")

    # ----- materialise the path as a coordinate list, then densify -----
    raw_xy: list[tuple[float, float]] = [node_xy[nid] for nid in path]

    # densify segments >25m by linear interpolation
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

    # sample heights and build (x_rel, y_rel, z, cum_dist) records
    cum = 0.0
    pts: list[tuple[float, float, float, float]] = []
    for i, (x, y) in enumerate(dense):
        if i > 0:
            x0, y0 = dense[i - 1]
            cum += math.hypot(x - x0, y - y0)
        z = sample_z(x, y)
        pts.append((x - CX, y - CY, z, cum))

    # find the densified-vertex indices corresponding to mek_id and egs_id (the *first* and
    # *last* of `dense` are exactly node_xy[path[0]] and node_xy[path[-1]] because the densify
    # loop above always emits the original vertices).
    # Since path[0] == (possibly relabeled) mek_id and path[-1] == egs_id:
    idx_mek = 0
    idx_egs = len(pts) - 1

    # If we hit the ferry-gap fallback, the path was reconstructed from far_id back to egs_id;
    # in that branch `path` already starts at far_id (which we treat as mek_id) and ends at egs_id,
    # so the same indices hold.

    print(f"densified to {len(pts)} points, total length {cum/1000.0:.1f} km")
    print(f"endpoints: idx_mek={idx_mek} ({pts[idx_mek][0]+CX:.0f},{pts[idx_mek][1]+CY:.0f}) "
          f"idx_egs={idx_egs} ({pts[idx_egs][0]+CX:.0f},{pts[idx_egs][1]+CY:.0f})")

    # ----- pack binary -----
    parts: list[bytes] = []
    parts.append(b"E391")
    parts.append(struct.pack("<III", len(pts), idx_mek, idx_egs))
    parts.append(struct.pack("<dd", CX, CY))
    arr = np.asarray(pts, dtype=np.float32)
    parts.append(arr.tobytes(order="C"))

    out = pathlib.Path("e39.bin")
    out.write_bytes(b"".join(parts))
    print(f"wrote {out} ({out.stat().st_size/1024:.1f} KB)")


if __name__ == "__main__":
    main()
