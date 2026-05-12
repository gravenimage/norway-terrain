"""NGU WFS client: tiled fetch with on-disk cache and feature deduplication."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Iterable, Iterator

import requests


def tile_grid(bbox: tuple[float, float, float, float], deg: float = 0.4) -> Iterator[tuple[float, float, float, float]]:
    """Yield (xmin, ymin, xmax, ymax) tiles covering bbox at <= deg per side."""
    xmin, ymin, xmax, ymax = bbox
    x = xmin
    while x < xmax:
        y = ymin
        while y < ymax:
            yield (x, y, min(x + deg, xmax), min(y + deg, ymax))
            y += deg
        x += deg


def cache_path(cache_dir: Path, layer: str, bbox: tuple[float, float, float, float]) -> Path:
    key = f"{layer}|{bbox[0]:.5f},{bbox[1]:.5f},{bbox[2]:.5f},{bbox[3]:.5f}"
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return cache_dir / f"{layer}_{h}.geojson"


def dedup_features(feats: Iterable[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for f in feats:
        fid = f.get("id")
        if fid is None:
            # Fallback: hash properties so anonymous duplicates still dedup
            fid = hashlib.sha1(json.dumps(f.get("properties") or {}, sort_keys=True).encode()).hexdigest()
        if fid in seen:
            continue
        seen.add(fid)
        out.append(f)
    return out


def fetch_tile(
    cache_dir: Path,
    layer: str,
    bbox: tuple[float, float, float, float],
    url: str,
    *,
    typename: str | None = None,
    srs: str = "EPSG:4326",
    timeout: float = 60.0,
    retries: int = 3,
    backoff: float = 2.0,
) -> dict:
    """Fetch one tile from a WFS service. Caches GeoJSON response on disk."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cp = cache_path(cache_dir, layer, bbox)
    if cp.exists() and cp.stat().st_size > 0:
        return json.loads(cp.read_text(encoding="utf-8"))

    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "outputFormat": "application/json",
        "srsName": srs,
        "bbox": f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]},{srs}",
    }
    if typename:
        params["typeNames"] = typename

    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            cp.write_text(json.dumps(data), encoding="utf-8")
            return data
        except Exception as e:  # noqa: BLE001 — log and retry
            last_err = e
            time.sleep(backoff ** attempt)
    raise RuntimeError(f"WFS fetch failed for {layer} {bbox}: {last_err}")
