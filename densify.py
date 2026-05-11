"""Tile-download Rogaland DTM at 10 m from Kartverket NHM_DTM_TOPOBATHY_25833 and mosaic."""
from __future__ import annotations
import concurrent.futures as cf
import pathlib
import time
import requests
import rasterio
from rasterio.merge import merge
from rasterio.transform import from_origin

SERVICE = (
    "https://hoydedata.no/arcgis/rest/services/"
    "NHM_DTM_TOPOBATHY_25833/ImageServer/exportImage"
)

# Rogaland (with margin) in EPSG:25833
XMIN, YMIN, XMAX, YMAX = -50_000, 6_440_000, 100_000, 6_700_000
PIXEL = 10  # metres
TILE_PX = 2048  # ArcGIS limit is 4096; some requests 502 at 4096, 2048 is reliable
TILE_M = TILE_PX * PIXEL  # 20_480 m per tile side

OUT_DIR = pathlib.Path("tiles_10m")
OUT_DIR.mkdir(exist_ok=True)
MOSAIC = pathlib.Path("rogaland_10m.tif")


def tile_grid():
    xs, x = [], XMIN
    while x < XMAX:
        xs.append((x, min(x + TILE_M, XMAX)))
        x += TILE_M
    ys, y = [], YMIN
    while y < YMAX:
        ys.append((y, min(y + TILE_M, YMAX)))
        y += TILE_M
    return xs, ys


def fetch(args):
    i, j, x0, x1, y0, y1 = args
    out = OUT_DIR / f"tile_{i:02d}_{j:02d}.tif"
    if out.exists() and out.stat().st_size > 1000:
        return f"skip {out.name}"
    w = round((x1 - x0) / PIXEL)
    h = round((y1 - y0) / PIXEL)
    url = (
        f"{SERVICE}?bbox={x0},{y0},{x1},{y1}&bboxSR=25833"
        f"&size={w},{h}&imageSR=25833&format=tiff&pixelType=F32"
        f"&interpolation=RSP_BilinearInterpolation&noData=-9999&f=image"
    )
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=600)
            r.raise_for_status()
            if not r.content.startswith(b"II*\x00") and not r.content.startswith(b"MM\x00*"):
                raise RuntimeError(f"not a TIFF (got {r.content[:60]!r})")
            out.write_bytes(r.content)
            return f"ok   {out.name} {len(r.content)/1e6:.1f} MB (try {attempt+1})"
        except Exception as e:
            if attempt == 5:
                return f"FAIL {out.name}: {e}"
            wait = min(60, 4 * (2 ** attempt))
            print(f"  retry {out.name} in {wait}s ({type(e).__name__})", flush=True)
            time.sleep(wait)
    return f"FAIL {out.name}"


def main():
    xs, ys = tile_grid()
    jobs = [
        (i, j, x0, x1, y0, y1)
        for j, (y0, y1) in enumerate(ys)
        for i, (x0, x1) in enumerate(xs)
    ]
    print(f"Grid: {len(xs)} cols x {len(ys)} rows = {len(jobs)} tiles")
    t0 = time.time()
    for job in jobs:
        print(fetch(job), flush=True)
    print(f"Tile fetch took {time.time()-t0:.1f}s")

    print("Mosaicking...")
    t0 = time.time()
    srcs = [rasterio.open(p) for p in sorted(OUT_DIR.glob("tile_*.tif"))]
    arr, transform = merge(srcs, nodata=-9999)
    profile = srcs[0].profile
    profile.update(
        height=arr.shape[1], width=arr.shape[2], transform=transform,
        compress="deflate", predictor=3, tiled=True, blockxsize=512, blockysize=512,
        nodata=-9999,
    )
    with rasterio.open(MOSAIC, "w", **profile) as dst:
        dst.write(arr)
    for s in srcs:
        s.close()
    print(f"Mosaic written: {MOSAIC} ({MOSAIC.stat().st_size/1e6:.1f} MB) in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
