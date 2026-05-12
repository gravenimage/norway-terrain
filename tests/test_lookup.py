"""Tests for rock-type ID assignment + JSON sidecar."""
from __future__ import annotations
import json

from geology import lookup


def test_assigns_stable_ids():
    lk = lookup.Lookup()
    assert lk.id_for("Granitt", "N50") == 0
    assert lk.id_for("Gneis", "N50") == 1
    assert lk.id_for("Granitt", "N50") == 0   # same name, same id


def test_distinct_scales_share_ids_for_same_name():
    """N50/N250 of same rock type are visually identical -> share id."""
    lk = lookup.Lookup()
    assert lk.id_for("Granitt", "N50") == lk.id_for("Granitt", "N250")


def test_color_default_for_unknown(tmp_path):
    lk = lookup.Lookup()
    rid = lk.id_for("UnobtainiumXYZ", "N50")
    sidecar = tmp_path / "x.json"
    lk.write(sidecar)
    data = json.loads(sidecar.read_text("utf-8"))
    assert str(rid) in data
    entry = data[str(rid)]
    assert entry["name"] == "UnobtainiumXYZ"
    assert entry["color"].startswith("#") and len(entry["color"]) == 7
    assert entry["scale"] == "N50"


def test_known_color_used_when_available(tmp_path):
    palette = {"granitt": "#ff6f6f"}
    lk = lookup.Lookup(palette=palette)
    rid = lk.id_for("Granitt", "N50")
    sidecar = tmp_path / "x.json"
    lk.write(sidecar)
    data = json.loads(sidecar.read_text("utf-8"))
    assert data[str(rid)]["color"] == "#ff6f6f"
