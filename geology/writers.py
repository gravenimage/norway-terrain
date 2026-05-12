"""Binary writers for geology layers (BRK1 / QUA1 / FLT1)."""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np


def write_polygons(
    out: Path,
    *,
    magic: bytes,
    cells: Mapping[tuple[int, int], Sequence[tuple]],   # cell -> list[(PreparedPoly, verts (N,3) f32, tris (M,3) u32)]
    cell_size: float,
) -> None:
    """Write a polygon binary in the BRK1/QUA1 layout (see SPEC §9)."""
    assert len(magic) == 4
    cell_keys = sorted(cells.keys())
    with out.open("wb") as f:
        f.write(magic)
        f.write(struct.pack("<II", 1, len(cell_keys)))   # version, nCells
        for (kx, ky) in cell_keys:
            entries = cells[(kx, ky)]
            cx = (kx + 0.5) * cell_size
            cy = (ky + 0.5) * cell_size

            # Aggregate cell bounds from polygons
            zs = []
            xmins, ymins, xmaxs, ymaxs = [], [], [], []
            for (p, verts, _tris) in entries:
                xmins.append(verts[:, 0].min()); xmaxs.append(verts[:, 0].max())
                ymins.append(verts[:, 1].min()); ymaxs.append(verts[:, 1].max())
                zs.append(verts[:, 2])
            allz = np.concatenate(zs) if zs else np.array([0.0], dtype=np.float32)
            zmin, zmax = float(allz.min()), float(allz.max())
            xmin = min(xmins); ymin = min(ymins); xmax = max(xmaxs); ymax = max(ymaxs)
            radius = float(np.hypot(max(xmax - cx, cx - xmin), max(ymax - cy, cy - ymin)))

            f.write(struct.pack("<ii", kx, ky))
            f.write(struct.pack("<ff", cx, cy))
            f.write(struct.pack("<ff", zmin, zmax))
            f.write(struct.pack("<f",  radius))
            f.write(struct.pack("<I",  len(entries)))
            for (p, verts, tris) in entries:
                rock_id = int(getattr(p, "rock_id", 0))
                f.write(struct.pack("<HH", rock_id & 0xFFFF, 0))
                f.write(struct.pack("<I", len(verts)))
                f.write(struct.pack("<I", len(tris)))
                f.write(verts.astype(np.float32, copy=False).tobytes())
                f.write(tris.astype(np.uint32, copy=False).tobytes())


def write_lines(out: Path, *, magic: bytes, groups: Mapping[int, np.ndarray]) -> None:
    """Write a line binary in the OSM2/FLT1 layout (one group per type idx)."""
    assert len(magic) == 4
    keys = sorted(groups.keys())
    with out.open("wb") as f:
        f.write(magic)
        f.write(struct.pack("<I", len(keys)))
        for k in keys:
            verts = groups[k].astype(np.float32, copy=False)
            assert verts.ndim == 2 and verts.shape[1] == 3 and len(verts) % 2 == 0, \
                "lines must be paired vertices (n even, shape (n,3))"
            f.write(struct.pack("<B3x", k & 0xFF))         # 1 byte type, 3 bytes pad
            f.write(struct.pack("<I", len(verts)))
            f.write(verts.tobytes())
