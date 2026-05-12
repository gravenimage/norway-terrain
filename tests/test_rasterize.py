"""Tests for polygon rasterizer."""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from geology import polygons, rasterize, lookup


def _square_poly(x0, y0, x1, y1, rid):
    ring = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return polygons.PreparedPoly(rings=[ring], rock_id=rid)


def test_rasterize_two_squares():
    """Two non-overlapping squares produce distinct class ids in the grid."""
    polys = [
        _square_poly(0.0, 0.0, 100.0, 100.0, 0),   # id 0 -> raster 1
        _square_poly(100.0, 0.0, 200.0, 100.0, 1), # id 1 -> raster 2
    ]
    grid, bbox, (w, h) = rasterize.rasterize_polygons(
        polys, bbox=(0.0, 0.0, 200.0, 100.0), resolution=10.0
    )
    assert grid.dtype == np.uint16
    assert (w, h) == (20, 10)
    assert grid.shape == (10, 20)
    # row 0 is south (yMin), columns left-to-right (xMin->xMax)
    # left half should be id 1, right half should be id 2
    left = grid[:, :10]
    right = grid[:, 10:]
    assert (left == 1).sum() > 50, f"expected mostly 1 in left half, got {np.unique(left, return_counts=True)}"
    assert (right == 2).sum() > 50, f"expected mostly 2 in right half, got {np.unique(right, return_counts=True)}"


def test_rasterize_empty_area_is_zero():
    """Polygon doesn't cover the whole bbox -> uncovered cells stay 0 (nodata)."""
    polys = [_square_poly(0.0, 0.0, 50.0, 50.0, 0)]
    grid, _, _ = rasterize.rasterize_polygons(polys, bbox=(0.0, 0.0, 100.0, 100.0), resolution=10.0)
    # bottom-left corner is inside polygon (id 0 -> 1)
    assert grid[0, 0] == 1
    # top-right corner is outside -> 0
    assert grid[-1, -1] == 0


def test_write_raster_roundtrip(tmp_path: Path):
    """Header + uint16 grid round-trip correctly."""
    polys = [_square_poly(0.0, 0.0, 100.0, 100.0, 0)]
    grid, bbox, _ = rasterize.rasterize_polygons(polys, bbox=(0.0, 0.0, 100.0, 100.0), resolution=10.0)
    out = tmp_path / "test_raster.bin"
    rasterize.write_raster(out, magic=b"TST1", grid=grid, bbox=bbox)

    data = out.read_bytes()
    assert data[:4] == b"TST1"
    ver, w, h = struct.unpack_from("<III", data, 4)
    assert ver == 1
    assert (w, h) == (10, 10)
    xMin, yMin, xMax, yMax = struct.unpack_from("<ffff", data, 16)
    assert (xMin, yMin, xMax, yMax) == (0.0, 0.0, 100.0, 100.0)
    payload = np.frombuffer(data[32:], dtype="<u2").reshape(h, w)
    assert np.array_equal(payload, grid)


def test_palette_writes_1_based_keys(tmp_path: Path):
    """write_palette emits keys 1..N (matching the +1 raster offset)."""
    lk = lookup.Lookup(palette={"granite": "#abcdef"})
    lk.id_for("granite", "N250")   # gets id 0 internally
    lk.id_for("gneiss", "N250")    # gets id 1 internally
    out = tmp_path / "p.json"
    rasterize.write_palette(out, lk)
    import json
    j = json.loads(out.read_text(encoding="utf-8"))
    assert set(j.keys()) == {"1", "2"}
    assert j["1"]["name"] == "granite"
    assert j["1"]["color"] == "#abcdef"
    assert j["2"]["name"] == "gneiss"
