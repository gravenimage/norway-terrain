"""Tests for NGU WFS client (no network — uses monkeypatch)."""
from __future__ import annotations
import json
from pathlib import Path

import pytest

from geology import wfs


def test_tile_grid_covers_bbox():
    bbox = (0.0, 0.0, 1.0, 1.0)  # 1 deg x 1 deg
    tiles = list(wfs.tile_grid(bbox, deg=0.4))
    # ceil(1/0.4) = 3 in each axis -> 9 tiles
    assert len(tiles) == 9
    # union of tiles must cover the bbox
    assert min(t[0] for t in tiles) <= 0.0
    assert max(t[2] for t in tiles) >= 1.0


def test_dedup_by_feature_id():
    feats = [
        {"id": "a", "properties": {"x": 1}},
        {"id": "b", "properties": {"x": 2}},
        {"id": "a", "properties": {"x": 1}},  # dup
    ]
    out = wfs.dedup_features(feats)
    ids = sorted(f["id"] for f in out)
    assert ids == ["a", "b"]


def test_cache_path_is_deterministic(tmp_path):
    p1 = wfs.cache_path(tmp_path, "Berggrunn", (1.0, 2.0, 3.0, 4.0))
    p2 = wfs.cache_path(tmp_path, "Berggrunn", (1.0, 2.0, 3.0, 4.0))
    assert p1 == p2
    assert p1.parent == tmp_path
    assert p1.suffix == ".geojson"


def test_fetch_tile_uses_cache(tmp_path, monkeypatch):
    # Pre-populate cache with a fake response
    body = {"type": "FeatureCollection", "features": [{"id": "x"}]}
    cp = wfs.cache_path(tmp_path, "Berggrunn", (0.0, 0.0, 1.0, 1.0))
    cp.write_text(json.dumps(body), encoding="utf-8")

    def boom(*a, **k):
        raise AssertionError("network must not be called when cache exists")
    monkeypatch.setattr(wfs.requests, "get", boom)

    out = wfs.fetch_tile(tmp_path, "Berggrunn", (0.0, 0.0, 1.0, 1.0), "https://nope")
    assert out["features"][0]["id"] == "x"
