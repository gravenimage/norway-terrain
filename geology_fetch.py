"""Fetch NGU bedrock + Quaternary + faults for the Rogaland bbox and emit binaries.

Run with:
    uv run --no-project --with requests --with shapely --with mapbox-earcut --with numpy --with rasterio --with pyproj python geology_fetch.py
"""
from __future__ import annotations

import sqlite3
import struct
import sys
import zipfile
from pathlib import Path
from typing import Iterable

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Polygon, shape
from shapely.ops import transform as shp_transform

from geology import lookup, polygons, wfs, writers

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "geology_cache"
DEM = ROOT / "rogaland_10m.tif"
CELL_SIZE_M = 4000.0

# WGS84 bbox for Rogaland (matches existing scripts)
BBOX_WGS84 = (4.0, 58.0, 7.5, 60.5)
TILE_DEG = 0.4

# Original WFS endpoints from the plan. NGU currently advertises these layers through
# WMS/download services rather than a public WFS, so main() uses the live NGU Atom
# download API below and keeps the WFS helper for cache/debug compatibility.
SVC_BEDROCK = {
    "url": "https://geo.ngu.no/mapserver/BerggrunnWFS2",
    "type": "berggrunn:bergartflate",
}
SVC_QUAT = {
    "url": "https://geo.ngu.no/mapserver/LosmasserWFS",
    "type": "losmasser:LosmasseFlate",
}
SVC_FAULT = {
    "url": "https://geo.ngu.no/mapserver/BerggrunnWFS2",
    "type": "berggrunn:strukturlinje",
}

DOWNLOAD_BEDROCK_N250 = "https://nedlasting.ngu.no/api/fileproxy/7c39be66-77b6-4b74-b58d-53b6bee90067/3ca2d651-bd73-44ec-89af-997da08cf783"
DOWNLOAD_QUAT_REGIONAL = "https://nedlasting.ngu.no/api/fileproxy/e5847c27-0c30-44b6-9198-a797c177fa20/07623320-6968-4de0-9519-c13a9321963c"

# Curated NGU-style palettes (lowercased rock name -> hex). Extendable.
BEDROCK_PALETTE = {
    "granitt": "#ff6f6f",
    "granittisk gneis": "#ff8a8a",
    "gneis": "#f0a8c8",
    "anortositt": "#cab8e0",
    "kvartsitt": "#fff5b8",
    "fyllitt": "#b8d878",
    "glimmerskifer": "#a8c870",
    "amfibolitt": "#5fa085",
    "gabbro": "#3f6c80",
    "kalkstein": "#bfd8e8",
    "sandstein": "#d6c79a",
    "skifer": "#9eb09e",
}
QUATERNARY_PALETTE = {
    "bart fjell": "#cccccc",
    "morenemateriale, sammenhengende dekke": "#e0c8a0",
    "morenemateriale, usammenhengende eller tynt dekke": "#eed8b8",
    "torv og myr": "#7a5a3a",
    "marin avsetning": "#a8c8e0",
    "elveavsetning": "#cfe0a8",
    "breelvavsetning": "#e0d8a8",
}
FAULT_TYPE_INDEX = {
    "forkastning": 0,
    "skyveforkastning": 1,
    "skjaersone": 2,
    "skjærsone": 2,
    # everything else -> 3
}

PROJ_4326_TO_25833 = Transformer.from_crs(4326, 25833, always_xy=True).transform
FeatureRecord = tuple[object, dict]


def _drape_z(verts2d: np.ndarray, dem: np.ndarray, dem_tf, dem_w: int, dem_h: int) -> np.ndarray:
    """Sample DEM at each (x,y) in EPSG:25833 metres -> z (float32). Bilinear."""
    inv = ~dem_tf
    px, py = inv * (verts2d[:, 0], verts2d[:, 1])
    px = np.clip(px, 0, dem_w - 1)
    py = np.clip(py, 0, dem_h - 1)
    x0 = np.floor(px).astype(np.int32)
    x1 = np.clip(x0 + 1, 0, dem_w - 1)
    y0 = np.floor(py).astype(np.int32)
    y1 = np.clip(y0 + 1, 0, dem_h - 1)
    fx = px - x0
    fy = py - y0
    z00 = dem[y0, x0]
    z01 = dem[y0, x1]
    z10 = dem[y1, x0]
    z11 = dem[y1, x1]
    z = (z00 * (1 - fx) + z01 * fx) * (1 - fy) + (z10 * (1 - fx) + z11 * fx) * fy
    return np.maximum(z, 0.0).astype(np.float32)


def _pick_prop(props: dict, candidates: Iterable[str]) -> str | None:
    by_lower = {str(k).lower(): v for k, v in props.items()}
    for c in candidates:
        v = by_lower.get(c.lower())
        if v not in (None, ""):
            return str(v)
    return None


def _xy_ring(coords) -> list[tuple[float, float]]:
    return [(float(c[0]), float(c[1])) for c in coords]


def _polygon_parts(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type == "MultiPolygon":
        return list(geom.geoms)
    if geom.geom_type == "GeometryCollection":
        out: list[Polygon] = []
        for g in geom.geoms:
            out.extend(_polygon_parts(g))
        return out
    return []


def _line_parts(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type == "MultiLineString":
        return list(geom.geoms)
    if geom.geom_type == "GeometryCollection":
        out: list[LineString] = []
        for g in geom.geoms:
            out.extend(_line_parts(g))
        return out
    return []


def _features_to_prepared(
    feats: Iterable[dict],
    name_field_candidates: Iterable[str],
    scale_field: str,
    lk: lookup.Lookup,
) -> list[polygons.PreparedPoly]:
    out: list[polygons.PreparedPoly] = []
    for f in feats:
        geom = f.get("geometry")
        props = f.get("properties") or {}
        if not geom:
            continue
        name = _pick_prop(props, name_field_candidates)
        if not name:
            continue
        scale = str(props.get(scale_field, "N250"))
        try:
            sg = shape(geom)
            sg = shp_transform(PROJ_4326_TO_25833, sg)
        except Exception:
            continue
        for p in _polygon_parts(sg):
            rid = lk.id_for(name, scale)
            outer = _xy_ring(p.exterior.coords)
            holes = [_xy_ring(r.coords) for r in p.interiors]
            out.append(polygons.PreparedPoly(rings=[outer, *holes], rock_id=rid))
    return out


def _records_to_prepared(
    records: Iterable[FeatureRecord],
    name_field_candidates: Iterable[str],
    scale_field: str,
    lk: lookup.Lookup,
) -> list[polygons.PreparedPoly]:
    out: list[polygons.PreparedPoly] = []
    for geom, props in records:
        name = _pick_prop(props, name_field_candidates)
        if not name:
            continue
        scale = _pick_prop(props, [scale_field]) or "N250"
        rid = lk.id_for(name, str(scale))
        for p in _polygon_parts(geom):
            try:
                outer = _xy_ring(p.exterior.coords)
                holes = [_xy_ring(r.coords) for r in p.interiors]
            except Exception:
                continue
            out.append(polygons.PreparedPoly(rings=[outer, *holes], rock_id=rid))
    return out


def _download_archive(label: str, url: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{label}_ngu_download.zip"
    if out.exists() and out.stat().st_size > 0:
        print(f"[{label}] using cached archive {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
        return out
    print(f"[{label}] downloading NGU archive ...", flush=True)
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with out.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    print(f"[{label}] downloaded {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
    return out


def _extract_archive(label: str, archive: Path) -> Path:
    out = CACHE / f"{label}_extracted"
    marker = out / ".complete"
    if marker.exists():
        return out
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(out)
    marker.write_text("ok", encoding="utf-8")
    return out


def _dbf_records(dbf_path: Path) -> list[dict | None]:
    raw = dbf_path.read_bytes()
    nrec = struct.unpack_from("<I", raw, 4)[0]
    header_len = struct.unpack_from("<H", raw, 8)[0]
    rec_len = struct.unpack_from("<H", raw, 10)[0]
    encoding = "utf-8"
    cpg = dbf_path.with_suffix(".cpg")
    if cpg.exists():
        text = cpg.read_text(errors="ignore").strip()
        if text:
            encoding = "cp1252" if text.upper() in {"ANSI 1252", "1252"} else text

    fields: list[tuple[str, str, int, int]] = []
    pos = 32
    while pos < header_len and raw[pos] != 0x0D:
        name = raw[pos : pos + 11].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
        ftype = chr(raw[pos + 11])
        flen = raw[pos + 16]
        fdec = raw[pos + 17]
        fields.append((name, ftype, flen, fdec))
        pos += 32

    records: list[dict | None] = []
    pos = header_len
    for _ in range(nrec):
        rec = raw[pos : pos + rec_len]
        pos += rec_len
        if not rec or rec[0:1] == b"*":
            records.append(None)
            continue
        props: dict = {}
        off = 1
        for name, ftype, flen, fdec in fields:
            data = rec[off : off + flen]
            off += flen
            s = data.decode(encoding, errors="replace").strip()
            if not s:
                props[name] = None
            elif ftype in {"N", "F"}:
                try:
                    props[name] = int(s) if fdec == 0 and "." not in s else float(s)
                except ValueError:
                    props[name] = s
            else:
                props[name] = s
        records.append(props)
    return records


def _shp_geometries(shp_path: Path) -> list[object | None]:
    raw = shp_path.read_bytes()
    geoms: list[object | None] = []
    pos = 100
    while pos + 8 <= len(raw):
        _rec_no, content_words = struct.unpack_from(">2i", raw, pos)
        pos += 8
        end = pos + content_words * 2
        if end > len(raw) or pos + 4 > len(raw):
            break
        stype = struct.unpack_from("<i", raw, pos)[0]
        if stype == 0:
            geoms.append(None)
            pos = end
            continue
        if stype not in {3, 5, 13, 15, 23, 25}:
            geoms.append(None)
            pos = end
            continue
        num_parts, num_points = struct.unpack_from("<2i", raw, pos + 36)
        parts_off = pos + 44
        pts_off = parts_off + 4 * num_parts
        parts = list(struct.unpack_from(f"<{num_parts}i", raw, parts_off)) if num_parts else []
        pts = [struct.unpack_from("<2d", raw, pts_off + i * 16) for i in range(num_points)]
        pieces = []
        for i, start in enumerate(parts):
            stop = parts[i + 1] if i + 1 < len(parts) else num_points
            part = pts[start:stop]
            if len(part) < 2:
                continue
            if stype in {5, 15, 25}:
                if len(part) >= 4:
                    try:
                        poly = Polygon(part)
                        if not poly.is_valid:
                            poly = poly.buffer(0)
                        if not poly.is_empty:
                            pieces.append(poly)
                    except Exception:
                        pass
            else:
                try:
                    line = LineString(part)
                    if not line.is_empty:
                        pieces.append(line)
                except Exception:
                    pass
        if not pieces:
            geoms.append(None)
        elif stype in {5, 15, 25}:
            geoms.append(pieces[0] if len(pieces) == 1 else MultiPolygon([p for p in pieces if p.geom_type == "Polygon"]))
        else:
            geoms.append(pieces[0] if len(pieces) == 1 else MultiLineString(pieces))
        pos = end
    return geoms


def _read_shapefile_records(shp_path: Path) -> list[FeatureRecord]:
    props = _dbf_records(shp_path.with_suffix(".dbf"))
    geoms = _shp_geometries(shp_path)
    out: list[FeatureRecord] = []
    for geom, rec in zip(geoms, props):
        if geom is not None and rec is not None and not geom.is_empty:
            out.append((geom, rec))
    return out


def _gpkg_wkb_offset(blob: bytes) -> int:
    if len(blob) < 8 or blob[:2] != b"GP":
        return 0
    flags = blob[3]
    envelope_code = (flags >> 1) & 0b111
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    return 8 + envelope_sizes.get(envelope_code, 0)


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _read_gpkg_records(gpkg_path: Path, layer: str, columns: Iterable[str]) -> list[FeatureRecord]:
    with sqlite3.connect(gpkg_path) as con:
        geom_col = con.execute(
            "SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?", (layer,)
        ).fetchone()[0]
        table_cols = {row[1] for row in con.execute(f"PRAGMA table_info({_quote_ident(layer)})")}
        selected = [c for c in columns if c in table_cols]
        sql_cols = ", ".join([_quote_ident(c) for c in selected] + [_quote_ident(geom_col)])
        rows = con.execute(f"SELECT {sql_cols} FROM {_quote_ident(layer)}").fetchall()
    out: list[FeatureRecord] = []
    for row in rows:
        props = dict(zip(selected, row[: len(selected)]))
        blob = row[-1]
        if not blob:
            continue
        try:
            geom = wkb.loads(bytes(blob)[_gpkg_wkb_offset(blob) :])
        except Exception:
            continue
        if not geom.is_empty:
            out.append((geom, props))
    return out


def _fetch_layer(svc: dict, label: str) -> list[dict]:
    print(f"\n[{label}] tiled WFS fetch ...", flush=True)
    feats: list[dict] = []
    tiles = list(wfs.tile_grid(BBOX_WGS84, deg=TILE_DEG))
    for i, t in enumerate(tiles):
        print(f"  tile {i + 1}/{len(tiles)}: {t}", flush=True)
        data = wfs.fetch_tile(CACHE, label, t, svc["url"], typename=svc["type"])
        feats.extend(data.get("features") or [])
    print(f"[{label}] raw features: {len(feats)}")
    feats = wfs.dedup_features(feats)
    print(f"[{label}] after dedup: {len(feats)}")
    return feats


def _load_download_records() -> tuple[list[FeatureRecord], list[FeatureRecord], list[FeatureRecord]]:
    bedrock_root = _extract_archive("bedrock", _download_archive("bedrock", DOWNLOAD_BEDROCK_N250))
    quat_root = _extract_archive("quaternary", _download_archive("quaternary", DOWNLOAD_QUAT_REGIONAL))

    bedrock = _read_shapefile_records(next(bedrock_root.rglob("BergartFlate_N250.shp")))
    faults = _read_shapefile_records(next(bedrock_root.rglob("Linearstruktur_N250.shp")))
    quat = _read_gpkg_records(
        next(quat_root.rglob("*.gpkg")),
        "LøsmasseFlate",
        ["løsmassetypeNavn", "løsmassetype", "egnetMålestokk"],
    )
    print(f"[bedrock] raw features: {len(bedrock)}")
    print(f"[quaternary] raw features: {len(quat)}")
    print(f"[faults] raw features: {len(faults)}")
    return bedrock, quat, faults


def _build_polygon_layer(
    label: str,
    records: list[FeatureRecord] | list[dict],
    name_fields: list[str],
    palette: dict,
    out_bin: Path,
    out_json: Path,
    magic: bytes,
    dem,
    dem_tf,
    dem_w,
    dem_h,
    cx_off,
    cy_off,
) -> None:
    lk = lookup.Lookup(palette=palette)
    if records and isinstance(records[0], dict):
        prepared = _features_to_prepared(records, name_fields, scale_field="malestokk", lk=lk)  # type: ignore[arg-type]
    else:
        prepared = _records_to_prepared(records, name_fields, scale_field="egnetMålestokk", lk=lk)  # type: ignore[arg-type]
    print(f"[{label}] prepared polys: {len(prepared)}")
    cells = polygons.bin_polygons(prepared, cell_size=CELL_SIZE_M)

    out_cells: dict[tuple[int, int], list[tuple]] = {}
    for k, items in cells.items():
        bucket = []
        for p in items:
            try:
                v2d, tris = polygons.triangulate(p.rings)
            except Exception:
                continue
            zs = _drape_z(v2d.astype(np.float64), dem, dem_tf, dem_w, dem_h)
            v3d = np.empty((len(v2d), 3), dtype=np.float32)
            v3d[:, 0] = v2d[:, 0] - cx_off
            v3d[:, 1] = v2d[:, 1] - cy_off
            v3d[:, 2] = zs
            bucket.append((p, v3d, tris))
        if bucket:
            out_cells[k] = bucket

    writers.write_polygons(out_bin, magic=magic, cells=out_cells, cell_size=CELL_SIZE_M)
    lk.write(out_json)
    sz_mb = out_bin.stat().st_size / 1e6
    print(f"[{label}] wrote {out_bin.name} ({sz_mb:.1f} MB) + {out_json.name} ({len(lk._entries)} types)")


def _build_fault_layer(records: list[FeatureRecord] | list[dict], dem, dem_tf, dem_w, dem_h, cx_off, cy_off) -> None:
    print("\n[faults] preparing line groups ...", flush=True)
    groups_pts: dict[int, list[tuple[float, float, float]]] = {}
    if records and isinstance(records[0], dict):
        feature_iter = []
        for f in records:  # type: ignore[assignment]
            geom = f.get("geometry") or {}
            props = f.get("properties") or {}
            try:
                sg = shp_transform(PROJ_4326_TO_25833, shape(geom))
            except Exception:
                continue
            feature_iter.append((sg, props))
    else:
        feature_iter = records  # type: ignore[assignment]

    for geom, props in feature_iter:
        key = _pick_prop(props, ["objtype", "strukturtype", "type"]) or "other"
        idx = FAULT_TYPE_INDEX.get(str(key).lower(), 3)
        for line in _line_parts(geom):
            coords = _xy_ring(line.coords)
            if len(coords) < 2:
                continue
            v2d = np.asarray(coords, dtype=np.float64)
            zs = _drape_z(v2d, dem, dem_tf, dem_w, dem_h)
            v3d = np.column_stack([v2d[:, 0] - cx_off, v2d[:, 1] - cy_off, zs]).astype(np.float32)
            for i in range(len(v3d) - 1):
                groups_pts.setdefault(idx, []).append(tuple(v3d[i]))
                groups_pts.setdefault(idx, []).append(tuple(v3d[i + 1]))

    groups = {k: np.asarray(v, dtype=np.float32).reshape(-1, 3) for k, v in groups_pts.items()}
    writers.write_lines(ROOT / "faults.bin", magic=b"FLT1", groups=groups)
    total = sum(len(v) // 2 for v in groups.values())
    print(f"[faults] wrote faults.bin ({total} segments across {len(groups)} types)")


def main() -> None:
    if not DEM.exists():
        sys.exit(f"DEM not found at {DEM}. Run reconstitute.py first.")
    print(f"Loading DEM {DEM} ...", flush=True)
    with rasterio.open(DEM) as ds:
        dem = ds.read(1).astype(np.float32)
        dem_tf = ds.transform
        dem_w = ds.width
        dem_h = ds.height
        b = ds.bounds
    cx_off = (b.left + b.right) * 0.5
    cy_off = (b.bottom + b.top) * 0.5

    bedrock_records, quat_records, fault_records = _load_download_records()

    _build_polygon_layer(
        "bedrock",
        bedrock_records,
        name_fields=["tegnforkla", "hovedberg_", "hovedbergart", "bergartnavn", "name"],
        palette=BEDROCK_PALETTE,
        out_bin=ROOT / "bedrock.bin",
        out_json=ROOT / "bedrock.json",
        magic=b"BRK1",
        dem=dem,
        dem_tf=dem_tf,
        dem_w=dem_w,
        dem_h=dem_h,
        cx_off=cx_off,
        cy_off=cy_off,
    )
    _build_polygon_layer(
        "quaternary",
        quat_records,
        name_fields=["løsmassetypeNavn", "jordart", "navn", "name"],
        palette=QUATERNARY_PALETTE,
        out_bin=ROOT / "quaternary.bin",
        out_json=ROOT / "quaternary.json",
        magic=b"QUA1",
        dem=dem,
        dem_tf=dem_tf,
        dem_w=dem_w,
        dem_h=dem_h,
        cx_off=cx_off,
        cy_off=cy_off,
    )
    _build_fault_layer(fault_records, dem, dem_tf, dem_w, dem_h, cx_off, cy_off)

    print("\nDone.")


if __name__ == "__main__":
    main()
