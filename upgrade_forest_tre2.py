#!/usr/bin/env python3
"""Upgrade forest.bin from TRE1 to TRE2 by sampling DEM at 4 corners of each quad
and appending int8 (0.5 m units) corner-z deltas relative to the seed centre.
This lets the viewer bilinear-interpolate per-tree z so trees follow the
local slope inside each 48 m quad - no more horizontal tree shelves on steep
terrain.

Run with:
  uv run --with numpy --with rasterio python upgrade_forest_tre2.py
"""
from __future__ import annotations
import struct
from pathlib import Path
import numpy as np
import rasterio

ROOT = Path(__file__).parent
DEM_PATH = ROOT / "rogaland_10m.tif"
FOREST = ROOT / "forest.bin"
CANOPY_RES_M = 48.0  # must match forest_polys.py

def main():
    raw = FOREST.read_bytes()
    magic = raw[:4]
    if magic == b"TRE2":
        print("forest.bin is already TRE2; nothing to do.")
        return
    if magic != b"TRE1":
        raise SystemExit(f"bad magic: {magic!r}")
    n = struct.unpack("<I", raw[4:8])[0]
    print(f"upgrading TRE1 -> TRE2 ({n:,} seeds)")

    rec_dt = np.dtype([
        ("cx", "<f4"), ("cy", "<f4"),
        ("cz", "<f4"), ("h",  "<f4"),
        ("sp", "u1"), ("sj", "u1"), ("cj", "u1"), ("pad", "u1"),
    ])
    recs = np.frombuffer(raw, dtype=rec_dt, count=n, offset=8)
    cx = recs["cx"].astype(np.float64)
    cy = recs["cy"].astype(np.float64)
    cz = recs["cz"].astype(np.float64)

    # forest.bin coords are centred on the DEM bbox. Recover absolute world coords
    # by adding the DEM centre offset (cx_off, cy_off used inside forest_polys.py).
    src = rasterio.open(DEM_PATH)
    print(f"  dem: {src.width}x{src.height}")
    left, bottom, right, top = src.bounds
    cx_off = (left + right) * 0.5
    cy_off = (bottom + top) * 0.5
    print(f"  centre offset: ({cx_off:.1f}, {cy_off:.1f})")
    abs_x = cx + cx_off
    abs_y = cy + cy_off

    dem = src.read(1).astype(np.float32)
    tr = src.transform
    a, _, c, _, e, fT = tr.a, tr.b, tr.c, tr.d, tr.e, tr.f
    dem_h, dem_w = dem.shape

    def sample(xs, ys):
        cols = (xs - c) / a
        rows = (ys - fT) / e
        c0 = np.floor(cols).astype(np.int32)
        r0 = np.floor(rows).astype(np.int32)
        c1 = c0 + 1
        r1 = r0 + 1
        fc = (cols - c0).astype(np.float32)
        fr = (rows - r0).astype(np.float32)
        c0 = np.clip(c0, 0, dem_w - 1); c1 = np.clip(c1, 0, dem_w - 1)
        r0 = np.clip(r0, 0, dem_h - 1); r1 = np.clip(r1, 0, dem_h - 1)
        v00 = dem[r0, c0]; v10 = dem[r0, c1]
        v01 = dem[r1, c0]; v11 = dem[r1, c1]
        return (v00 * (1 - fc) * (1 - fr) + v10 * fc * (1 - fr)
              + v01 * (1 - fc) * fr       + v11 * fc * fr).astype(np.float32)

    half = CANOPY_RES_M * 0.5
    print("sampling DEM at 4 corners per quad ...")
    z00 = sample(abs_x - half, abs_y - half)
    z10 = sample(abs_x + half, abs_y - half)
    z01 = sample(abs_x - half, abs_y + half)
    z11 = sample(abs_x + half, abs_y + half)

    def _enc(z):
        return np.clip(np.round((z.astype(np.float64) - cz) * 2.0), -127, 127).astype(np.int8)
    d00, d10, d01, d11 = _enc(z00), _enc(z10), _enc(z01), _enc(z11)

    # describe statistics
    abs_max = np.maximum.reduce([np.abs(d00), np.abs(d10), np.abs(d01), np.abs(d11)])
    print(f"  delta stats: max |dz|={abs_max.max()*0.5:.1f}m   mean |dz|={abs_max.mean()*0.5:.2f}m")

    new_dt = np.dtype([
        ("cx", "<f4"), ("cy", "<f4"),
        ("cz", "<f4"), ("h",  "<f4"),
        ("sp", "u1"), ("sj", "u1"), ("cj", "u1"), ("pad", "u1"),
        ("d00", "i1"), ("d10", "i1"), ("d01", "i1"), ("d11", "i1"),
    ])
    new_recs = np.zeros(n, dtype=new_dt)
    for field in ("cx", "cy", "cz", "h", "sp", "sj", "cj"):
        new_recs[field] = recs[field]
    new_recs["d00"] = d00; new_recs["d10"] = d10
    new_recs["d01"] = d01; new_recs["d11"] = d11

    with open(FOREST, "wb") as f:
        f.write(b"TRE2")
        f.write(struct.pack("<I", n))
        f.write(new_recs.tobytes())
    sz = FOREST.stat().st_size / 1024 / 1024
    print(f"wrote forest.bin ({sz:.1f} MB, TRE2)")

if __name__ == "__main__":
    main()
