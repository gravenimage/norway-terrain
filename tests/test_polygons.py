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
