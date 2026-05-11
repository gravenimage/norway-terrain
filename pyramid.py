"""Build a Mapbox-style terrain-RGB tile pyramid from rogaland_10m.tif.

Layout: tiles/{z}/{x}/{y}.png (PNG y-down within tile, slippy-style yx index).
- Tile size: 256x256
- Levels: 0..MAX_Z
- Negative elevations clamped to 0 (no bathymetry)
- meta.json describes the pyramid in EPSG:25833 world units

Encoding: h = -10000 + (R*65536 + G*256 + B) * 0.1
"""
from __future__ import annotations
import json
import pathlib
import time
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from PIL import Image

SRC = "rogaland_10m.tif"
OUT = pathlib.Path("tiles")
TILE = 256
MAX_Z = 6  # 0..6 = 7 levels


def encode_terrain_rgb(elev: np.ndarray) -> np.ndarray:
    v = (elev + 10000.0) * 10.0
    v = np.clip(v, 0, 0xFFFFFF).astype(np.uint32)
    r = ((v >> 16) & 0xFF).astype(np.uint8)
    g = ((v >> 8) & 0xFF).astype(np.uint8)
    b = (v & 0xFF).astype(np.uint8)
    return np.dstack([r, g, b])


def main() -> None:
    OUT.mkdir(exist_ok=True)
    with rasterio.open(SRC) as ds:
        s_xmin, s_ymin, s_xmax, s_ymax = ds.bounds
        nodata = ds.nodata if ds.nodata is not None else -9999

        cx = (s_xmin + s_xmax) / 2
        cy = (s_ymin + s_ymax) / 2
        side = max(s_xmax - s_xmin, s_ymax - s_ymin)
        root_x = cx - side / 2
        root_y = cy - side / 2

        meta = {
            "crs": "EPSG:25833",
            "rootX": root_x,
            "rootY": root_y,
            "rootSize": side,
            "tileSize": TILE,
            "maxZ": MAX_Z,
            "encoding": "mapbox-rgb",
            "src": {"xMin": s_xmin, "yMin": s_ymin, "xMax": s_xmax, "yMax": s_ymax},
            "elevMax": 0.0,
        }

        z_max_seen = 0.0
        total = 0
        t0 = time.time()
        for z in range(MAX_Z + 1):
            n = 1 << z
            sz = side / n
            zdir = OUT / str(z)
            zdir.mkdir(exist_ok=True)
            count = 0
            for x in range(n):
                tx_min = root_x + x * sz
                tx_max = tx_min + sz
                if tx_max <= s_xmin or tx_min >= s_xmax:
                    continue
                xdir = zdir / str(x)
                for y in range(n):
                    ty_max_world = root_y + side - y * sz
                    ty_min_world = ty_max_world - sz
                    if ty_max_world <= s_ymin or ty_min_world >= s_ymax:
                        continue
                    out_path = xdir / f"{y}.png"
                    if out_path.exists() and out_path.stat().st_size > 100:
                        count += 1
                        continue

                    dst = np.zeros((TILE, TILE), dtype=np.float32)
                    dst_transform = from_bounds(tx_min, ty_min_world, tx_max, ty_max_world, TILE, TILE)
                    reproject(
                        source=rasterio.band(ds, 1),
                        destination=dst,
                        src_transform=ds.transform, src_crs=ds.crs,
                        dst_transform=dst_transform, dst_crs=ds.crs,
                        resampling=Resampling.bilinear,
                        src_nodata=nodata, dst_nodata=0,
                    )
                    np.maximum(dst, 0.0, out=dst)
                    if dst.max() > z_max_seen:
                        z_max_seen = float(dst.max())
                    rgb = encode_terrain_rgb(dst)
                    xdir.mkdir(exist_ok=True)
                    Image.fromarray(rgb).save(out_path, optimize=False, compress_level=3)
                    count += 1
            total += count
            print(f"z={z}: {count} tiles ({total} cumulative, {time.time()-t0:.1f}s)", flush=True)

        meta["elevMax"] = z_max_seen
        (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
        print(f"Done. {total} tiles, max elevation {z_max_seen:.1f} m.")


if __name__ == "__main__":
    main()
