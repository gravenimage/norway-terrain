"""Rasterize polygon layers (bedrock / quaternary) onto a regular grid.

Each grid cell stores a 16-bit class id (0 = nodata, 1..N = palette index).
The output is a small header + uint16 raster that the viewer samples in the
terrain fragment shader as a colour overlay, so geology can never "poke
through" the underlying DEM — the colour is just applied to whichever DEM
fragment it falls on.

Header layout (little-endian):
    [0:4]   magic, 4 bytes (e.g. b"BRR1" or b"QRR1")
    [4:8]   version, uint32 = 1
    [8:12]  width, uint32
    [12:16] height, uint32
    [16:32] bbox xMin, yMin, xMax, yMax as float32 (centred world coords)
    [32:..] width * height uint16 class ids, row-major, row 0 = south (yMin)
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Iterable

import numpy as np
from rasterio.features import rasterize as rio_rasterize
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, mapping
from shapely.ops import transform as shp_transform

from . import lookup, polygons


def rasterize_polygons(
    prepared: Iterable[polygons.PreparedPoly],
    bbox: tuple[float, float, float, float],
    resolution: float,
) -> tuple[np.ndarray, tuple[float, float, float, float], tuple[int, int]]:
    """Rasterize prepared polygons over `bbox` at `resolution` metres per pixel.

    Returns (grid uint16 [H,W] row 0 = south, bbox snapped to whole pixels, (W,H)).
    """
    xMin, yMin, xMax, yMax = bbox
    if resolution <= 0:
        raise ValueError("resolution must be positive")
    width = int(np.ceil((xMax - xMin) / resolution))
    height = int(np.ceil((yMax - yMin) / resolution))
    if width <= 0 or height <= 0:
        raise ValueError(f"empty bbox: {bbox}")
    # Snap bbox to whole pixels so the transform is exact.
    xMaxSnap = xMin + width * resolution
    yMaxSnap = yMin + height * resolution
    # rasterio uses image convention: row 0 = north. We feed it that way then
    # flip vertically at the end so row 0 = south for shader UV mapping.
    transform = from_bounds(xMin, yMin, xMaxSnap, yMaxSnap, width, height)

    shapes: list[tuple[dict, int]] = []
    for p in prepared:
        # Rock ids are 0-indexed by lookup.Lookup; shift by +1 so 0 stays
        # reserved for "no data" in the raster.
        idx = int(p.rock_id) + 1
        if idx <= 0 or idx > 0xFFFF:
            continue
        outer = p.rings[0]
        holes = p.rings[1:] if len(p.rings) > 1 else None
        try:
            poly = Polygon(outer, holes=holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
        except Exception:
            continue
        shapes.append((mapping(poly), idx))

    if not shapes:
        grid_north = np.zeros((height, width), dtype=np.uint16)
    else:
        grid_north = rio_rasterize(
            shapes,
            out_shape=(height, width),
            transform=transform,
            fill=0,
            dtype=np.uint16,
            all_touched=False,
        )
    # Flip so row 0 = south
    grid = np.flipud(grid_north).copy()
    snapped_bbox = (xMin, yMin, xMaxSnap, yMaxSnap)
    return grid, snapped_bbox, (width, height)


def write_raster(
    path: Path,
    magic: bytes,
    grid: np.ndarray,
    bbox: tuple[float, float, float, float],
) -> None:
    """Write the binary raster (header + uint16 grid) to `path`."""
    if len(magic) != 4:
        raise ValueError("magic must be exactly 4 bytes")
    if grid.dtype != np.uint16:
        raise ValueError("grid must be uint16")
    height, width = grid.shape
    xMin, yMin, xMax, yMax = bbox
    header = magic + struct.pack(
        "<I I I ffff",
        1,  # version
        int(width),
        int(height),
        float(xMin),
        float(yMin),
        float(xMax),
        float(yMax),
    )
    with path.open("wb") as f:
        f.write(header)
        f.write(np.ascontiguousarray(grid, dtype="<u2").tobytes())


def write_palette(path: Path, lk: lookup.Lookup) -> None:
    """Write palette JSON for raster output. Keys are 1-based to match the
    +1 offset applied during rasterization (raster 0 = nodata)."""
    import json
    out = {str(i + 1): e for i, e in enumerate(lk._entries)}
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
