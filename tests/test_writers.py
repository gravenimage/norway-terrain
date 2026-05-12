"""Round-trip tests for BRK1/QUA1 binary writer."""
from __future__ import annotations
from io import BytesIO
import struct

import numpy as np

from geology import writers, polygons


def _make_cell(rock_id: int):
    ring = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    p = polygons.PreparedPoly(rings=[ring], rock_id=rock_id)
    p.centroid = (5.0, 5.0)
    p.bounds = (0.0, 0.0, 10.0, 10.0)
    verts2d, tris = polygons.triangulate(p.rings)
    # add z=0 column
    verts3d = np.hstack([verts2d, np.zeros((len(verts2d), 1))]).astype(np.float32)
    return p, verts3d, tris


def test_write_polygon_binary_roundtrip(tmp_path):
    p1, v1, t1 = _make_cell(7)
    p2, v2, t2 = _make_cell(9)
    cells = {
        (0, 0): [(p1, v1, t1)],
        (1, 0): [(p2, v2, t2)],
    }
    out = tmp_path / "x.bin"
    writers.write_polygons(out, magic=b"BRK1", cells=cells, cell_size=4000.0)
    # parse back manually
    data = out.read_bytes()
    assert data[:4] == b"BRK1"
    ver, n_cells = struct.unpack_from("<II", data, 4)
    assert ver == 1 and n_cells == 2
    # not asserting full structure here — main check is "no exception, magic+counts match"


def test_write_lines_binary(tmp_path):
    groups = {
        0: np.array([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]], dtype=np.float32),
        2: np.array([[2.0, 2.0, 0.0], [3.0, 3.0, 0.0]], dtype=np.float32),
    }
    out = tmp_path / "f.bin"
    writers.write_lines(out, magic=b"FLT1", groups=groups)
    data = out.read_bytes()
    assert data[:4] == b"FLT1"
    n = struct.unpack_from("<I", data, 4)[0]
    assert n == 2
