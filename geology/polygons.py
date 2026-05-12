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
