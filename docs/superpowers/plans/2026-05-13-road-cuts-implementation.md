# Road Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a road-cut pipeline and viewer runtime that renders close roads as flat cross-section corridor regrid meshes with terrain holes and a far fallback.

**Architecture:** Add a generated `roadcuts.bin` asset containing road polylines, smoothed elevations, bank widths, flags, and spatial bins. Extend `viewer.html` to load that asset, build near-camera corridor meshes, discard base terrain inside close road footprints, and use the existing road shader overlay as the far visual fallback. Keep changes dependency-free beyond the existing Python stack.

**Tech Stack:** Python 3.10+ via `uv`, `numpy`, `rasterio`, `pyproj`, browser JavaScript in single-file `viewer.html`, Three.js 0.160.0, pytest.

---

## File structure

- Create `roadcuts.py`: reusable road-cut calculations, binary writer/reader, OSM graph helpers.
- Create `roadcuts_build.py`: CLI script that reads `osm_raw.json` and `rogaland_10m.tif`, then writes `roadcuts.bin`.
- Create `tests/test_roadcuts.py`: unit tests for smoothing, bank width calculation, binary round-trip, bridge/tunnel flags, and spatial bins.
- Modify `viewer.html`: load `roadcuts.bin`, build corridor geometry, add terrain discard uniforms/functions, render corridor meshes, and expose debug state.
- Modify `README.md`: mention `roadcuts.bin` and the regeneration command.
- Create/update `roadcuts.bin`: generated binary committed if size is reasonable.

## Binary layout: `RDC1`

All values are little-endian.

Header:

```text
magic[4] = "RDC1"
uint32 version = 1
uint32 nRoads
uint32 nBins
float32 cellSize
float64 centerX
float64 centerY
```

Per road:

```text
uint32 roadId
uint8 classIdx
uint8 flags       bit0=bridge, bit1=tunnel
uint16 reserved
float32 halfWidth
uint32 nStations
float32 station[nStations] packed as:
  x, y, zOrig, zRoad, dist, leftBank, rightBank
```

Spatial bins:

```text
int32 ix
int32 iy
uint32 nRefs
uint32 roadIndex[nRefs]
```

---

### Task 1: Add road-cut calculation library and tests

**Files:**
- Create: `roadcuts.py`
- Create: `tests/test_roadcuts.py`

- [ ] **Step 1: Write failing tests for smoothing, bank widths, and binary round-trip**

Add this initial `tests/test_roadcuts.py`:

```python
from __future__ import annotations

import struct

import numpy as np

from roadcuts import (
    CLASS_ORDER,
    RoadCut,
    Station,
    compute_bank_widths,
    encode_roadcuts,
    smooth_elevations,
    spatial_bins,
)


def test_smooth_elevations_limits_grade_and_deviation():
    dist = np.array([0.0, 25.0, 50.0, 75.0, 100.0], dtype=np.float32)
    z = np.array([100.0, 100.5, 118.0, 101.0, 101.5], dtype=np.float32)

    out = smooth_elevations(dist, z, max_grade=0.08, max_deviation=4.0, iterations=8)

    assert out.shape == z.shape
    assert np.max(np.abs(out - z)) <= 4.0001
    assert np.max(np.abs(np.diff(out) / np.diff(dist))) <= 0.0801
    assert out[2] < 118.0


def test_compute_bank_widths_scale_with_height_difference():
    road_z = np.array([10.0, 10.0], dtype=np.float32)
    left_z = np.array([12.0, 25.0], dtype=np.float32)
    right_z = np.array([9.0, -5.0], dtype=np.float32)

    left, right = compute_bank_widths(
        road_z,
        left_z,
        right_z,
        min_bank=8.0,
        max_bank=40.0,
        cut_ratio=1.5,
        fill_ratio=2.0,
    )

    assert left[0] == 8.0
    assert left[1] > left[0]
    assert right[0] == 8.0
    assert right[1] == 38.0


def test_encode_roadcuts_roundtrip_header_and_payload():
    road = RoadCut(
        road_id=42,
        class_idx=CLASS_ORDER.index("primary"),
        flags=0b01,
        half_width=4.0,
        stations=[
            Station(0.0, 0.0, 10.0, 10.5, 0.0, 8.0, 9.0),
            Station(25.0, 0.0, 11.0, 10.8, 25.0, 8.5, 9.5),
        ],
    )

    data = encode_roadcuts([road], center_x=1.25, center_y=2.5, cell_size=100.0)

    assert data[:4] == b"RDC1"
    version, n_roads, n_bins = struct.unpack_from("<III", data, 4)
    assert version == 1
    assert n_roads == 1
    assert n_bins == 1
    road_id = struct.unpack_from("<I", data, 32)[0]
    assert road_id == 42
    class_idx, flags = struct.unpack_from("<BB", data, 36)
    assert class_idx == CLASS_ORDER.index("primary")
    assert flags == 0b01


def test_spatial_bins_reference_roads_by_expanded_bounds():
    road = RoadCut(
        road_id=7,
        class_idx=0,
        flags=0,
        half_width=6.5,
        stations=[
            Station(10.0, 10.0, 0.0, 0.0, 0.0, 8.0, 8.0),
            Station(160.0, 10.0, 0.0, 0.0, 150.0, 8.0, 8.0),
        ],
    )

    bins = spatial_bins([road], cell_size=100.0)

    assert (0, 0) in bins
    assert (1, 0) in bins
    assert bins[(0, 0)] == [0]
    assert bins[(1, 0)] == [0]
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
uv run --with pytest --with numpy pytest tests\test_roadcuts.py -q
```

Expected: import failure for `roadcuts`.

- [ ] **Step 3: Implement `roadcuts.py`**

Create `roadcuts.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
import math
import struct
from typing import Iterable

import numpy as np

CLASS_ORDER = ["motorway", "trunk", "primary", "secondary", "tertiary"]
ROAD_HALF_W = [6.5, 5.0, 4.0, 3.25, 2.75]
FLAG_BRIDGE = 1 << 0
FLAG_TUNNEL = 1 << 1


@dataclass(frozen=True)
class Station:
    x: float
    y: float
    z_orig: float
    z_road: float
    dist: float
    left_bank: float
    right_bank: float


@dataclass(frozen=True)
class RoadCut:
    road_id: int
    class_idx: int
    flags: int
    half_width: float
    stations: list[Station]


def smooth_elevations(
    dist: np.ndarray,
    z: np.ndarray,
    *,
    max_grade: float = 0.10,
    max_deviation: float = 6.0,
    iterations: int = 12,
) -> np.ndarray:
    """Smooth DEM road samples while bounding grade and deviation from terrain."""
    d = np.asarray(dist, dtype=np.float32)
    src = np.asarray(z, dtype=np.float32)
    if len(src) <= 2:
        return src.copy()

    out = src.copy()
    for _ in range(iterations):
        prev = out.copy()
        out[1:-1] = prev[:-2] * 0.25 + prev[1:-1] * 0.5 + prev[2:] * 0.25
        out = np.clip(out, src - max_deviation, src + max_deviation)
        for i in range(1, len(out)):
            step = max(float(d[i] - d[i - 1]), 1e-3)
            lim = max_grade * step
            out[i] = min(out[i], out[i - 1] + lim)
            out[i] = max(out[i], out[i - 1] - lim)
        for i in range(len(out) - 2, -1, -1):
            step = max(float(d[i + 1] - d[i]), 1e-3)
            lim = max_grade * step
            out[i] = min(out[i], out[i + 1] + lim)
            out[i] = max(out[i], out[i + 1] - lim)
        out = np.clip(out, src - max_deviation, src + max_deviation)
    return out.astype(np.float32)


def compute_bank_widths(
    road_z: np.ndarray,
    left_terrain_z: np.ndarray,
    right_terrain_z: np.ndarray,
    *,
    min_bank: float = 8.0,
    max_bank: float = 48.0,
    cut_ratio: float = 1.5,
    fill_ratio: float = 2.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Return per-side bank widths from road-to-terrain height differences."""
    rz = np.asarray(road_z, dtype=np.float32)
    lz = np.asarray(left_terrain_z, dtype=np.float32)
    rz_side = np.asarray(right_terrain_z, dtype=np.float32)

    def one_side(side_z: np.ndarray) -> np.ndarray:
        dz = side_z - rz
        ratio = np.where(dz >= 0.0, cut_ratio, fill_ratio)
        widths = np.maximum(min_bank, np.abs(dz) * ratio + min_bank)
        return np.minimum(max_bank, widths).astype(np.float32)

    return one_side(lz), one_side(rz_side)


def _road_bounds(road: RoadCut) -> tuple[float, float, float, float]:
    xs = [s.x for s in road.stations]
    ys = [s.y for s in road.stations]
    pad = road.half_width + max(max(s.left_bank, s.right_bank) for s in road.stations)
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def spatial_bins(roads: list[RoadCut], *, cell_size: float = 2000.0) -> dict[tuple[int, int], list[int]]:
    bins: dict[tuple[int, int], list[int]] = {}
    for road_index, road in enumerate(roads):
        xmin, ymin, xmax, ymax = _road_bounds(road)
        ix0 = math.floor(xmin / cell_size)
        ix1 = math.floor(xmax / cell_size)
        iy0 = math.floor(ymin / cell_size)
        iy1 = math.floor(ymax / cell_size)
        for iy in range(iy0, iy1 + 1):
            for ix in range(ix0, ix1 + 1):
                bins.setdefault((ix, iy), []).append(road_index)
    return bins


def encode_roadcuts(
    roads: list[RoadCut],
    *,
    center_x: float,
    center_y: float,
    cell_size: float = 2000.0,
) -> bytes:
    bins = spatial_bins(roads, cell_size=cell_size)
    parts: list[bytes] = [
        b"RDC1",
        struct.pack("<III", 1, len(roads), len(bins)),
        struct.pack("<fdd", float(cell_size), float(center_x), float(center_y)),
    ]
    for road in roads:
        parts.append(
            struct.pack(
                "<IBBHfI",
                int(road.road_id) & 0xFFFFFFFF,
                int(road.class_idx) & 0xFF,
                int(road.flags) & 0xFF,
                0,
                float(road.half_width),
                len(road.stations),
            )
        )
        arr = np.array(
            [
                (s.x, s.y, s.z_orig, s.z_road, s.dist, s.left_bank, s.right_bank)
                for s in road.stations
            ],
            dtype=np.float32,
        )
        parts.append(arr.tobytes(order="C"))
    for (ix, iy), refs in sorted(bins.items()):
        parts.append(struct.pack("<iiI", ix, iy, len(refs)))
        parts.append(np.asarray(refs, dtype=np.uint32).tobytes(order="C"))
    return b"".join(parts)
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
uv run --with pytest --with numpy pytest tests\test_roadcuts.py -q
```

Expected: `4 passed`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add roadcuts.py tests\test_roadcuts.py
git commit -m "Add road-cut binary helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add `roadcuts_build.py` generator

**Files:**
- Create: `roadcuts_build.py`
- Modify: `tests/test_roadcuts.py`

- [ ] **Step 1: Add a generator unit test for one synthetic OSM way**

Append to `tests/test_roadcuts.py`:

```python
from roadcuts_build import build_roadcuts_from_elements


def test_build_roadcuts_from_elements_densifies_and_flags_bridge():
    elements = [
        {
            "type": "way",
            "id": 99,
            "tags": {"highway": "secondary", "bridge": "yes"},
            "geometry": [
                {"lat": 0.0, "lon": 0.0},
                {"lat": 0.0, "lon": 0.001},
            ],
        }
    ]

    def project(lat: float, lon: float) -> tuple[float, float]:
        return lon * 100_000.0, lat * 100_000.0

    def sample_z(x: float, y: float) -> float:
        return 10.0 + x * 0.001

    roads = build_roadcuts_from_elements(
        elements,
        project=project,
        sample_z=sample_z,
        center_x=0.0,
        center_y=0.0,
        densify_m=25.0,
    )

    assert len(roads) == 1
    road = roads[0]
    assert road.road_id == 99
    assert road.class_idx == CLASS_ORDER.index("secondary")
    assert road.flags & 0b01
    assert len(road.stations) > 2
    assert road.stations[-1].dist > 90.0
```

- [ ] **Step 2: Run the generator test to verify it fails**

Run:

```powershell
uv run --with pytest --with numpy pytest tests\test_roadcuts.py::test_build_roadcuts_from_elements_densifies_and_flags_bridge -q
```

Expected: import failure for `roadcuts_build`.

- [ ] **Step 3: Implement `roadcuts_build.py`**

Create `roadcuts_build.py`:

```python
#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Callable

import numpy as np
import rasterio
from pyproj import Transformer

from roadcuts import (
    CLASS_ORDER,
    FLAG_BRIDGE,
    FLAG_TUNNEL,
    ROAD_HALF_W,
    RoadCut,
    Station,
    compute_bank_widths,
    encode_roadcuts,
    smooth_elevations,
)

ROOT = Path(__file__).parent
RAW_OSM = ROOT / "osm_raw.json"
DEM_PATH = ROOT / "rogaland_10m.tif"
OUT = ROOT / "roadcuts.bin"
DENSIFY_M = 25.0
BANK_SAMPLE_EXTRA_M = 10.0
BIN_CELL_M = 2000.0


def _truthy_tag(value: object) -> bool:
    return str(value).lower() in {"yes", "true", "1", "viaduct"}


def _densify(points: list[tuple[float, float]], densify_m: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for i, p in enumerate(points):
        if i:
            x0, y0 = points[i - 1]
            x1, y1 = p
            d = math.hypot(x1 - x0, y1 - y0)
            n = int(d / densify_m)
            for k in range(1, n + 1):
                t = k / (n + 1)
                out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        out.append(p)
    return out


def _distances(points: list[tuple[float, float]]) -> np.ndarray:
    d = np.zeros(len(points), dtype=np.float32)
    for i in range(1, len(points)):
        x0, y0 = points[i - 1]
        x1, y1 = points[i]
        d[i] = d[i - 1] + math.hypot(x1 - x0, y1 - y0)
    return d


def _side_samples(
    points: list[tuple[float, float]],
    half_width: float,
    sample_z: Callable[[float, float], float],
) -> tuple[np.ndarray, np.ndarray]:
    left: list[float] = []
    right: list[float] = []
    offset = half_width + BANK_SAMPLE_EXTRA_M
    for i, (x, y) in enumerate(points):
        if i == 0:
            x2, y2 = points[min(1, len(points) - 1)]
            tx, ty = x2 - x, y2 - y
        elif i == len(points) - 1:
            x0, y0 = points[i - 1]
            tx, ty = x - x0, y - y0
        else:
            x0, y0 = points[i - 1]
            x2, y2 = points[i + 1]
            tx, ty = x2 - x0, y2 - y0
        length = max(math.hypot(tx, ty), 1e-6)
        nx, ny = -ty / length, tx / length
        left.append(sample_z(x + nx * offset, y + ny * offset))
        right.append(sample_z(x - nx * offset, y - ny * offset))
    return np.asarray(left, dtype=np.float32), np.asarray(right, dtype=np.float32)


def build_roadcuts_from_elements(
    elements: list[dict],
    *,
    project: Callable[[float, float], tuple[float, float]],
    sample_z: Callable[[float, float], float],
    center_x: float,
    center_y: float,
    densify_m: float = DENSIFY_M,
) -> list[RoadCut]:
    roads: list[RoadCut] = []
    for el in elements:
        tags = el.get("tags") or {}
        highway = tags.get("highway")
        geom = el.get("geometry") or []
        if el.get("type") != "way" or highway not in CLASS_ORDER or len(geom) < 2:
            continue
        projected = [project(float(g["lat"]), float(g["lon"])) for g in geom]
        dense = _densify(projected, densify_m)
        if len(dense) < 2:
            continue

        cls = CLASS_ORDER.index(highway)
        half_width = ROAD_HALF_W[cls]
        dist = _distances(dense)
        z_orig = np.asarray([sample_z(x, y) for x, y in dense], dtype=np.float32)
        z_road = smooth_elevations(dist, z_orig)
        left_z, right_z = _side_samples(dense, half_width, sample_z)
        left_bank, right_bank = compute_bank_widths(z_road, left_z, right_z)

        flags = 0
        if _truthy_tag(tags.get("bridge")):
            flags |= FLAG_BRIDGE
        if _truthy_tag(tags.get("tunnel")):
            flags |= FLAG_TUNNEL

        stations = [
            Station(
                x=x - center_x,
                y=y - center_y,
                z_orig=float(z_orig[i]),
                z_road=float(z_road[i]),
                dist=float(dist[i]),
                left_bank=float(left_bank[i]),
                right_bank=float(right_bank[i]),
            )
            for i, (x, y) in enumerate(dense)
        ]
        roads.append(
            RoadCut(
                road_id=int(el.get("id", len(roads))),
                class_idx=cls,
                flags=flags,
                half_width=half_width,
                stations=stations,
            )
        )
    return roads


def main() -> None:
    data = json.loads(RAW_OSM.read_text(encoding="utf-8"))
    tr = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)
    with rasterio.open(DEM_PATH) as ds:
        band = ds.read(1)
        inv = ~ds.transform
        nodata = ds.nodata
        bounds = ds.bounds
        center_x = (bounds.left + bounds.right) * 0.5
        center_y = (bounds.bottom + bounds.top) * 0.5
        h, w = band.shape

        def project(lat: float, lon: float) -> tuple[float, float]:
            return tr.transform(lon, lat)

        def sample_z(x: float, y: float) -> float:
            col, row = inv * (x, y)
            c = int(np.clip(math.floor(col), 0, w - 1))
            r = int(np.clip(math.floor(row), 0, h - 1))
            v = float(band[r, c])
            if nodata is not None and v == nodata:
                return 0.0
            return max(v, 0.0)

        roads = build_roadcuts_from_elements(
            data.get("elements", []),
            project=project,
            sample_z=sample_z,
            center_x=center_x,
            center_y=center_y,
        )
        OUT.write_bytes(
            encode_roadcuts(roads, center_x=center_x, center_y=center_y, cell_size=BIN_CELL_M)
        )
        n_stations = sum(len(r.stations) for r in roads)
        print(f"wrote {OUT} with {len(roads)} roads and {n_stations} stations")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run generator tests**

Run:

```powershell
uv run --with pytest --with numpy --with pyproj --with rasterio pytest tests\test_roadcuts.py -q
```

Expected: all road-cut tests pass.

- [ ] **Step 5: Generate `roadcuts.bin`**

Run:

```powershell
uv run --with numpy --with rasterio --with pyproj python roadcuts_build.py
```

Expected: prints `wrote ... roadcuts.bin` with a non-zero road and station count.

- [ ] **Step 6: Commit**

Run:

```powershell
git add roadcuts_build.py tests\test_roadcuts.py roadcuts.bin
git commit -m "Generate road-cut corridor data" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Load `roadcuts.bin` in `viewer.html`

**Files:**
- Modify: `viewer.html`

- [ ] **Step 1: Add parser and debug state**

After the existing `buildRoadOverlay(segsByClass)` function in `viewer.html`, add:

```javascript
const ROAD_FLAG_BRIDGE = 1;
const ROAD_FLAG_TUNNEL = 2;
const ROADCUT_CELL = 2000.0;
const roadCutState = {
  ready: false,
  roads: [],
  bins: new Map(),
  active: [],
  meshes: new Map(),
  frame: 0,
};

function _roadCutBinKey(ix, iy){ return `${ix},${iy}`; }

function parseRoadcuts(ab){
  const dv = new DataView(ab);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RDC1') throw new Error('bad roadcuts magic ' + magic);
  let off = 4;
  const version = dv.getUint32(off, true); off += 4;
  if (version !== 1) throw new Error('unsupported roadcuts version ' + version);
  const nRoads = dv.getUint32(off, true); off += 4;
  const nBins = dv.getUint32(off, true); off += 4;
  const cellSize = dv.getFloat32(off, true); off += 4;
  const centerX = dv.getFloat64(off, true); off += 8;
  const centerY = dv.getFloat64(off, true); off += 8;
  const roads = [];
  for (let i = 0; i < nRoads; i++) {
    const roadId = dv.getUint32(off, true); off += 4;
    const classIdx = dv.getUint8(off); off += 1;
    const flags = dv.getUint8(off); off += 1;
    off += 2;
    const halfWidth = dv.getFloat32(off, true); off += 4;
    const n = dv.getUint32(off, true); off += 4;
    const stations = new Float32Array(ab, off, n * 7).slice();
    off += n * 7 * 4;
    roads.push({ roadId, classIdx, flags, halfWidth, stations, n });
  }
  const bins = new Map();
  for (let i = 0; i < nBins; i++) {
    const ix = dv.getInt32(off, true); off += 4;
    const iy = dv.getInt32(off, true); off += 4;
    const n = dv.getUint32(off, true); off += 4;
    const refs = [];
    for (let k = 0; k < n; k++, off += 4) refs.push(dv.getUint32(off, true));
    bins.set(_roadCutBinKey(ix, iy), refs);
  }
  return { cellSize, centerX, centerY, roads, bins };
}

(async () => {
  try {
    const ab = await (await fetch('roadcuts.bin')).arrayBuffer();
    const parsed = parseRoadcuts(ab);
    roadCutState.ready = true;
    roadCutState.roads = parsed.roads;
    roadCutState.bins = parsed.bins;
    roadCutState.cellSize = parsed.cellSize;
    window.__roadCuts = roadCutState;
    document.getElementById('hud').insertAdjacentHTML('beforeend',
      `<br>road cuts: ${parsed.roads.length.toLocaleString()} roads`);
  } catch (e) {
    console.warn('roadcuts.bin not loaded:', e);
  }
})();
```

- [ ] **Step 2: Smoke-check parser in browser**

Run:

```powershell
uv run serve.py
```

Expected: viewer loads without page errors and HUD shows `road cuts: N roads`.

- [ ] **Step 3: Commit**

Run:

```powershell
git add viewer.html
git commit -m "Load road-cut data in viewer" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Render near-camera corridor meshes

**Files:**
- Modify: `viewer.html`

- [ ] **Step 1: Add corridor material and geometry builder**

Add after the road-cut parser:

```javascript
const roadCutGroup = new THREE.Group();
scene.add(roadCutGroup);

const roadCutMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
  metalness: 0.0,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -2,
});

const ROAD_CUT_ACTIVE_M = 4500.0;
const ROAD_CUT_MAX_MESHES = 160;

function _stationAt(road, i, col){
  return road.stations[i * 7 + col];
}

function _roadCutRoadBounds(road){
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < road.n; i++) {
    const x = _stationAt(road, i, 0);
    const y = _stationAt(road, i, 1);
    const pad = road.halfWidth + Math.max(_stationAt(road, i, 5), _stationAt(road, i, 6));
    xmin = Math.min(xmin, x - pad);
    ymin = Math.min(ymin, y - pad);
    xmax = Math.max(xmax, x + pad);
    ymax = Math.max(ymax, y + pad);
  }
  return { xmin, ymin, xmax, ymax };
}

function buildRoadCutGeometry(road){
  const cols = [-1, -0.55, -0.18, 0, 0.18, 0.55, 1];
  const nCols = cols.length;
  const positions = new Float32Array(road.n * nCols * 3);
  const colors = new Float32Array(road.n * nCols * 3);
  const indices = [];
  const asphalt = new THREE.Color(0x2f2f33);
  const bank = new THREE.Color(0x526348);
  for (let i = 0; i < road.n; i++) {
    const x = _stationAt(road, i, 0);
    const y = _stationAt(road, i, 1);
    const zOrig = _stationAt(road, i, 2);
    const zRoad = _stationAt(road, i, 3);
    const leftBank = _stationAt(road, i, 5);
    const rightBank = _stationAt(road, i, 6);
    let tx = 1, ty = 0;
    if (i === 0 && road.n > 1) {
      tx = _stationAt(road, 1, 0) - x;
      ty = _stationAt(road, 1, 1) - y;
    } else if (i > 0) {
      tx = x - _stationAt(road, i - 1, 0);
      ty = y - _stationAt(road, i - 1, 1);
    }
    const len = Math.max(Math.hypot(tx, ty), 1e-6);
    const nx = -ty / len;
    const ny = tx / len;
    for (let c = 0; c < nCols; c++) {
      const v = cols[c];
      const isLeft = v < 0;
      const sideBank = isLeft ? leftBank : rightBank;
      const absV = Math.abs(v);
      const roadFrac = Math.min(absV / 0.18, 1.0);
      const bankFrac = absV <= 0.18 ? 0.0 : (absV - 0.18) / 0.82;
      const offset = Math.sign(v) * (road.halfWidth * Math.min(roadFrac, 1.0) + sideBank * bankFrac);
      const z = absV <= 0.18 ? zRoad : THREE.MathUtils.lerp(zRoad, zOrig, bankFrac);
      const p = (i * nCols + c) * 3;
      positions[p + 0] = x + nx * offset;
      positions[p + 1] = y + ny * offset;
      positions[p + 2] = z * EXAG + 0.18;
      const col = absV <= 0.18 ? asphalt : bank;
      colors[p + 0] = col.r;
      colors[p + 1] = col.g;
      colors[p + 2] = col.b;
    }
  }
  for (let i = 0; i < road.n - 1; i++) {
    for (let c = 0; c < nCols - 1; c++) {
      const a = i * nCols + c;
      const b = a + 1;
      const d = (i + 1) * nCols + c;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}
```

- [ ] **Step 2: Add active-road updater**

Add before `loop()`:

```javascript
function updateRoadCutMeshes(){
  if (!roadCutState.ready || roadUniforms.uRoadShow.value < 0.5) {
    roadCutGroup.visible = false;
    return;
  }
  roadCutGroup.visible = true;
  roadCutState.frame++;
  const cs = roadCutState.cellSize || ROADCUT_CELL;
  const ix0 = Math.floor((camera.position.x - ROAD_CUT_ACTIVE_M) / cs);
  const ix1 = Math.floor((camera.position.x + ROAD_CUT_ACTIVE_M) / cs);
  const iy0 = Math.floor((camera.position.y - ROAD_CUT_ACTIVE_M) / cs);
  const iy1 = Math.floor((camera.position.y + ROAD_CUT_ACTIVE_M) / cs);
  const wanted = new Set();
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const refs = roadCutState.bins.get(_roadCutBinKey(ix, iy));
      if (!refs) continue;
      for (const roadIndex of refs) {
        if (wanted.size >= ROAD_CUT_MAX_MESHES) break;
        const road = roadCutState.roads[roadIndex];
        if (!road || (road.flags & (ROAD_FLAG_BRIDGE | ROAD_FLAG_TUNNEL))) continue;
        const b = road._bounds || (road._bounds = _roadCutRoadBounds(road));
        const dx = Math.max(b.xmin - camera.position.x, 0, camera.position.x - b.xmax);
        const dy = Math.max(b.ymin - camera.position.y, 0, camera.position.y - b.ymax);
        if (Math.hypot(dx, dy) <= ROAD_CUT_ACTIVE_M) wanted.add(roadIndex);
      }
    }
  }
  for (const roadIndex of wanted) {
    let rec = roadCutState.meshes.get(roadIndex);
    if (!rec) {
      const mesh = new THREE.Mesh(buildRoadCutGeometry(roadCutState.roads[roadIndex]), roadCutMaterial);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      roadCutGroup.add(mesh);
      rec = { mesh, frame: roadCutState.frame };
      roadCutState.meshes.set(roadIndex, rec);
    }
    rec.frame = roadCutState.frame;
    rec.mesh.visible = true;
  }
  for (const [roadIndex, rec] of roadCutState.meshes) {
    if (!wanted.has(roadIndex)) rec.mesh.visible = false;
  }
}
```

Call it in `loop()` after `visit(0,0,0);`:

```javascript
  visit(0,0,0);
  updateRoadCutMeshes();
  cullBuildings();
```

- [ ] **Step 3: Smoke-check corridor meshes**

Run:

```powershell
uv run serve.py
```

Expected: viewer loads, `window.__roadCuts.meshes.size` grows when camera is near roads, and no page errors appear.

- [ ] **Step 4: Commit**

Run:

```powershell
git add viewer.html
git commit -m "Render dynamic road-cut corridor meshes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Add terrain discard for close road cuts

**Files:**
- Modify: `viewer.html`

- [ ] **Step 1: Add shared discard uniforms**

Extend `roadUniforms`:

```javascript
  uRoadCutShow:   { value: 0.0 },
  uRoadCutNear:   { value: 4500.0 },
  uRoadCutBankPad:{ value: 48.0 },
```

Add these uniforms to `makeMaterial()`:

```javascript
      uRoadCutShow:    roadUniforms.uRoadCutShow,
      uRoadCutNear:    roadUniforms.uRoadCutNear,
      uRoadCutBankPad: roadUniforms.uRoadCutBankPad,
```

Declare them in the terrain fragment shader near the road uniforms:

```glsl
uniform float uRoadCutShow;
uniform float uRoadCutNear;
uniform float uRoadCutBankPad;
```

- [ ] **Step 2: Reuse the road-grid lookup to discard near active road footprints**

Inside the existing road shader block, after `halfW` is computed and before asphalt color is mixed, add:

```glsl
      float camDistXY = length(vWorld.xy - cameraPosition.xy);
      if (uRoadCutShow > 0.5 && camDistXY < uRoadCutNear && minDist <= halfW + uRoadCutBankPad) {
        discard;
      }
```

Set `roadUniforms.uRoadCutShow.value` in `updateRoadCutMeshes()`:

```javascript
  roadUniforms.uRoadCutShow.value = roadCutState.meshes.size > 0 ? 1.0 : 0.0;
```

When roads are hidden, set:

```javascript
    roadUniforms.uRoadCutShow.value = 0.0;
```

- [ ] **Step 3: Update roads checkbox handler**

Replace the current road checkbox handler with:

```javascript
document.getElementById('showRoads').onchange = e => {
  const show = e.target.checked ? 1.0 : 0.0;
  roadUniforms.uRoadShow.value = show;
  roadUniforms.uRoadCutShow.value = show;
  roadCutGroup.visible = show > 0.5;
};
```

- [ ] **Step 4: Smoke-check terrain holes are filled**

Run:

```powershell
uv run serve.py
```

Expected: at close range, asphalt/bank corridor meshes cover road footprints without base terrain z-fighting.

- [ ] **Step 5: Commit**

Run:

```powershell
git add viewer.html
git commit -m "Punch terrain holes for road cuts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Mask water, canopy, and runtime tree placement

**Files:**
- Modify: `viewer.html`

- [ ] **Step 1: Share road-grid uniforms with canopy and water materials**

Add the road grid uniforms to `canopyUniforms` and `waterUniforms` by reference:

```javascript
  uRoadGrid:      roadUniforms.uRoadGrid,
  uRoadRefs:      roadUniforms.uRoadRefs,
  uRoadCls:       roadUniforms.uRoadCls,
  uRoadOrigin:    roadUniforms.uRoadOrigin,
  uRoadCell:      roadUniforms.uRoadCell,
  uRoadGridDims:  roadUniforms.uRoadGridDims,
  uRoadRefsDims:  roadUniforms.uRoadRefsDims,
  uRoadShow:      roadUniforms.uRoadShow,
  uRoadReady:     roadUniforms.uRoadReady,
```

- [ ] **Step 2: Add GLSL road-mask helper to canopy and water fragments**

Add the same uniforms and helper functions used by the terrain road shader:

```glsl
uniform sampler2D uRoadGrid;
uniform sampler2D uRoadRefs;
uniform sampler2D uRoadCls;
uniform vec2  uRoadOrigin;
uniform float uRoadCell;
uniform vec2  uRoadGridDims;
uniform vec2  uRoadRefsDims;
uniform float uRoadShow;
uniform float uRoadReady;

vec2 roadRefUV(float i){
  float w = uRoadRefsDims.x;
  float row = floor(i / w);
  float colF = i - row * w;
  return vec2((colF + 0.5) / w, (row + 0.5) / uRoadRefsDims.y);
}
float roadDistSeg(vec2 p, vec2 a, vec2 b){
  vec2 d = b - a;
  float L2 = max(dot(d, d), 1e-6);
  float t = clamp(dot(p - a, d) / L2, 0.0, 1.0);
  return length(p - (a + d * t));
}
float roadMask(vec2 p){
  if (uRoadShow < 0.5 || uRoadReady < 0.5) return 0.0;
  vec2 cf = (p - uRoadOrigin) / uRoadCell;
  vec2 cellF = floor(cf);
  float minDist = 1e9;
  float minClsF = -1.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = cellF + vec2(float(dx), float(dy));
      if (c.x < 0.0 || c.y < 0.0 || c.x >= uRoadGridDims.x || c.y >= uRoadGridDims.y) continue;
      vec2 cellUV = vec2((c.x + 0.5) / uRoadGridDims.x, (c.y + 0.5) / uRoadGridDims.y);
      vec2 hdr = texture2D(uRoadGrid, cellUV).rg;
      for (int k = 0; k < 128; k++) {
        if (float(k) >= hdr.g) break;
        float ri = hdr.r + float(k);
        vec4 s = texture2D(uRoadRefs, roadRefUV(ri));
        float d = roadDistSeg(p, s.xy, s.zw);
        if (d < minDist) {
          minDist = d;
          minClsF = floor(texture2D(uRoadCls, roadRefUV(ri)).r * 255.0 + 0.5);
        }
      }
    }
  }
  if (minClsF < 0.0) return 0.0;
  int minCls = int(minClsF);
  float halfW = (minCls == 0) ? 6.5 :
                (minCls == 1) ? 5.0 :
                (minCls == 2) ? 4.0 :
                (minCls == 3) ? 3.25 : 2.75;
  return minDist <= halfW + 2.0 ? 1.0 : 0.0;
}
```

At the top of each fragment `main()`, after log-depth setup, add:

```glsl
if (roadMask(vWorld.xy) > 0.5) discard;
```

- [ ] **Step 3: Runtime-filter tree instances as a stopgap**

Before writing each tree instance in the forest loop, skip points inside the existing JS road grid after it is ready:

```javascript
if (window.__roadGrid && pointNearRoad(cx, cy, 2.0)) continue;
```

Add a JS helper near `buildRoadOverlay`:

```javascript
function pointNearRoad(x, y, extra){
  if (!window.__roadGrid) return false;
  const g = window.__roadGrid;
  const cfX = Math.floor((x - g.xMinC) / g.cell);
  const cfY = Math.floor((y - g.yMinC) / g.cell);
  let best = Infinity;
  let clsBest = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = cfX + dx, cy = cfY + dy;
      if (cx < 0 || cy < 0 || cx >= g.gridW || cy >= g.gridH) continue;
      const h = (cy * g.gridW + cx) * 2;
      const off = g.gridData[h], cnt = g.gridData[h + 1];
      for (let k = 0; k < cnt; k++) {
        const ri = off + k;
        const p = ri * 4;
        const ax = g.refsData[p], ay = g.refsData[p + 1], bx = g.refsData[p + 2], by = g.refsData[p + 3];
        const vx = bx - ax, vy = by - ay;
        const len2 = Math.max(vx * vx + vy * vy, 1e-6);
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
        const d = Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
        if (d < best) {
          best = d;
          clsBest = g.clsData[ri] || 4;
        }
      }
    }
  }
  return clsBest >= 0 && best <= ROAD_HALF_W[clsBest] + extra;
}
```

Also expose `refsData` and `clsData` in `window.__roadGrid`.

- [ ] **Step 4: Smoke-check masking**

Run:

```powershell
uv run serve.py
```

Expected: water/canopy no longer paint over roads; newly built runtime tree instances skip road footprints when the road grid loads first.

- [ ] **Step 5: Commit**

Run:

```powershell
git add viewer.html
git commit -m "Mask overlays from road footprints" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Update docs and run validation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README file list and regeneration commands**

Add `roadcuts.bin` to the file table:

```markdown
| `roadcuts.bin` | Road-cut corridor data (RDC1 binary) for close road regrid meshes. |
```

Add `roadcuts_build.py` to regeneration scripts:

```markdown
- `roadcuts_build.py` — builds `roadcuts.bin` from cached OSM roads and the 10 m DEM.
```

- [ ] **Step 2: Run Python tests**

Run:

```powershell
uv run --with pytest --with numpy --with rasterio --with pyproj pytest -q
```

Expected: all tests pass.

- [ ] **Step 3: Run a browser screenshot smoke test**

Start the server on the screenshot harness port:

```powershell
uv run python -m http.server 8765
```

In another shell, run:

```powershell
uv run --with playwright --with pillow python tests\roads_screenshot.py roadcuts
```

Expected: `tests\_artifacts\roads_roadcuts.png` and console log are written without page errors.

- [ ] **Step 4: Inspect git status**

Run:

```powershell
git --no-pager status --short
```

Expected: only intended files are modified, plus ignored test artifacts.

- [ ] **Step 5: Commit**

Run:

```powershell
git add README.md
git commit -m "Document road-cut assets" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-review checklist

- Spec coverage:
  - `roadcuts.bin` offline asset: Tasks 1-2.
  - Dynamic corridor meshes: Task 4.
  - Terrain discard/hole punching: Task 5.
  - Far fallback: Task 5 keeps existing road shader overlay outside close range.
  - Overlay conflicts: Task 6.
  - Tree stopgap: Task 6.
  - Documentation and validation: Task 7.
- Known first-pass limitations:
  - Junction caps are represented by continuous overlapping corridor coverage, not a full polygon clipping system.
  - Bridges and tunnels are tagged and skipped from cutting, not rendered as separate decks.
  - Offline forest subtraction is documented as the durable future fix; Task 6 adds only runtime filtering for newly generated viewer instances.
- Placeholder scan: no TBD/TODO/FIXME placeholders.
- Type consistency: `RoadCut`, `Station`, `RDC1`, and road flag names are consistent across tasks.
