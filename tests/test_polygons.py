"""Tests for polygon binning + triangulation."""
from __future__ import annotations
import numpy as np

from geology import polygons


def test_cell_index_for_point():
    # cell size 4000 m, origin (0,0)
    assert polygons.cell_index(0.0, 0.0, 4000.0) == (0, 0)
    assert polygons.cell_index(3999.0, 1.0, 4000.0) == (0, 0)
    assert polygons.cell_index(4000.0, 0.0, 4000.0) == (1, 0)
    assert polygons.cell_index(-1.0, -1.0, 4000.0) == (-1, -1)


def test_triangulate_square_no_holes():
    # CCW unit square in metres
    ring = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    verts, tris = polygons.triangulate([ring])
    assert verts.shape == (4, 2)
    assert tris.shape == (2, 3)
    # all indices must be valid
    assert tris.max() < len(verts)


def test_triangulate_with_hole():
    outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    hole  = [(3.0, 3.0), (7.0, 3.0), (7.0, 7.0), (3.0, 7.0)]
    verts, tris = polygons.triangulate([outer, hole])
    assert len(verts) == 8
    # 8 triangles in a square-with-square-hole
    assert len(tris) == 8


def test_bin_polygon_by_centroid():
    """Polygons get assigned to one cell, by centroid; cell aabb extends to actual bounds."""
    # square centered at (1500, 1500), so cell (0,0) at 4 km cells
    ring = [(1000.0, 1000.0), (2000.0, 1000.0), (2000.0, 2000.0), (1000.0, 2000.0)]
    poly = polygons.PreparedPoly(rings=[ring], rock_id=42)
    cells = polygons.bin_polygons([poly], cell_size=4000.0)
    assert list(cells.keys()) == [(0, 0)]
    assert len(cells[(0, 0)]) == 1
    assert cells[(0, 0)][0].rock_id == 42


def test_subdivide_reduces_max_edge():
    ring = [(0.0, 0.0), (1000.0, 0.0), (1000.0, 1000.0), (0.0, 1000.0)]
    verts, tris = polygons.triangulate([ring])
    # original triangles have edges up to ~1414 m (diagonal)
    v2, t2 = polygons.subdivide_triangles(verts, tris, max_edge=100.0)
    # check every edge in refined mesh is below threshold
    import numpy as np
    for (a, b, c) in t2:
        for i, j in [(a, b), (b, c), (c, a)]:
            d = np.hypot(v2[i, 0] - v2[j, 0], v2[i, 1] - v2[j, 1])
            assert d <= 100.0 + 1e-6
    # triangle count must have grown
    assert len(t2) > len(tris) * 4
    # midpoints must be shared (no duplicate vertices at same XY)
    seen = {tuple(np.round(v, 6)) for v in v2}
    assert len(seen) == len(v2)
