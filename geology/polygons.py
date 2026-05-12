"""Polygon binning per cell + earcut triangulation."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import mapbox_earcut as earcut


Ring = list[tuple[float, float]]


@dataclass
class PreparedPoly:
    rings: list[Ring]            # rings[0] = outer, rings[1:] = holes
    rock_id: int
    # filled by bin_polygons:
    centroid: tuple[float, float] | None = None
    bounds: tuple[float, float, float, float] | None = None  # xmin,ymin,xmax,ymax


def cell_index(x: float, y: float, cell_size: float) -> tuple[int, int]:
    import math
    return (math.floor(x / cell_size), math.floor(y / cell_size))


def _bounds(rings: list[Ring]) -> tuple[float, float, float, float]:
    pts = rings[0]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def _centroid(rings: list[Ring]) -> tuple[float, float]:
    b = _bounds(rings)
    return ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5)


def triangulate(rings: list[Ring]) -> tuple[np.ndarray, np.ndarray]:
    """Earcut triangulation. Returns (verts (N,2) float64, tris (M,3) uint32).

    rings[0] is the outer ring (CCW recommended); rings[1:] are holes (CW).
    """
    flat: list[float] = []
    ring_end_indices: list[int] = []
    for r in rings:
        for x, y in r:
            flat.append(float(x))
            flat.append(float(y))
        ring_end_indices.append(len(flat) // 2)
    verts = np.asarray(flat, dtype=np.float64).reshape(-1, 2)
    ring_end_arr = np.asarray(ring_end_indices, dtype=np.uint32)
    tri = earcut.triangulate_float64(verts, ring_end_arr).reshape(-1, 3).astype(np.uint32)
    return verts, tri


def subdivide_triangles(
    verts: np.ndarray,
    tris: np.ndarray,
    max_edge: float,
    max_iters: int = 8,
) -> tuple[np.ndarray, np.ndarray]:
    """Recursively 1-to-4 split any triangle with an edge longer than max_edge.

    Returns refined (verts (N,2) float64, tris (M,3) uint32). Shares midpoint
    vertices between neighbouring triangles so the mesh stays watertight.
    """
    vlist: list[tuple[float, float]] = [(float(v[0]), float(v[1])) for v in verts]
    tlist: list[tuple[int, int, int]] = [(int(t[0]), int(t[1]), int(t[2])) for t in tris]
    mid_cache: dict[tuple[int, int], int] = {}

    def get_mid(i: int, j: int) -> int:
        key = (i, j) if i < j else (j, i)
        cached = mid_cache.get(key)
        if cached is not None:
            return cached
        vi = vlist[i]
        vj = vlist[j]
        new_idx = len(vlist)
        vlist.append(((vi[0] + vj[0]) * 0.5, (vi[1] + vj[1]) * 0.5))
        mid_cache[key] = new_idx
        return new_idx

    me2 = max_edge * max_edge
    for _ in range(max_iters):
        new_tlist: list[tuple[int, int, int]] = []
        changed = False
        for (a, b, c) in tlist:
            va = vlist[a]; vb = vlist[b]; vc = vlist[c]
            dxab = va[0] - vb[0]; dyab = va[1] - vb[1]
            dxbc = vb[0] - vc[0]; dybc = vb[1] - vc[1]
            dxca = vc[0] - va[0]; dyca = vc[1] - va[1]
            d2ab = dxab * dxab + dyab * dyab
            d2bc = dxbc * dxbc + dybc * dybc
            d2ca = dxca * dxca + dyca * dyca
            if max(d2ab, d2bc, d2ca) > me2:
                d = get_mid(a, b)
                e = get_mid(b, c)
                f = get_mid(c, a)
                new_tlist.append((a, d, f))
                new_tlist.append((d, b, e))
                new_tlist.append((f, e, c))
                new_tlist.append((d, e, f))
                changed = True
            else:
                new_tlist.append((a, b, c))
        tlist = new_tlist
        if not changed:
            break

    return (
        np.asarray(vlist, dtype=np.float64),
        np.asarray(tlist, dtype=np.uint32),
    )


def bin_polygons(polys: Iterable[PreparedPoly], cell_size: float) -> dict[tuple[int, int], list[PreparedPoly]]:
    """Assign each polygon to one cell by its centroid."""
    cells: dict[tuple[int, int], list[PreparedPoly]] = {}
    for p in polys:
        if p.centroid is None:
            p.centroid = _centroid(p.rings)
        if p.bounds is None:
            p.bounds = _bounds(p.rings)
        kx, ky = cell_index(p.centroid[0], p.centroid[1], cell_size)
        cells.setdefault((kx, ky), []).append(p)
    return cells
