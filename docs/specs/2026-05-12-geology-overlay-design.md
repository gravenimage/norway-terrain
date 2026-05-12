# Geology Overlay — Design

Date: 2026-05-12

## Goal

Add an interactive geological overlay to the existing Rogaland 3D terrain
viewer: bedrock geology, Quaternary surface deposits, and structural
faults — all toggleable, blendable against the natural terrain palette,
and clickable to identify the rock or deposit at any point.

## Data sources

All from NGU (Norges geologiske undersøkelse), public WFS services,
EPSG:25833 native, clipped to the Rogaland DEM bbox
(`-50000, 6,440,000 → 100,000, 6,700,000`).

| Layer | NGU service | Detail |
| --- | --- | --- |
| Bedrock (rock type) | "Berggrunn" — best available scale (preferring N50 1:50,000 where coverage exists, falling back to 1:250k for sheets without N50). | Polygons, attribute `hovedbergart` (main rock type) + `bergartnavn` (rock name). |
| Quaternary deposits | "Løsmasser" N50 (1:50,000, full Rogaland coverage). | Polygons, attribute `jorddekke` / deposit code. |
| Faults / structural lines | "Strukturer" linework from the Berggrunn dataset. | Lines, attribute `strukturtype` (fault, thrust, shear, etc.). |

### Why 1:50,000

Camera distances in this viewer go down to ~200 m, where 1:250k boundaries
look noticeably blocky. 1:50k preserves the real polygon shape down to
zoom levels users will actually use. The trade-off is data size — see
"Data size & chunking" below.

### Coverage caveat

N50 bedrock coverage is published per map sheet. Where N50 is missing,
the fetch script falls back to NGU's lower-detail scale automatically
(NGU exposes a multi-scale service for this). The legend in the viewer
shows "(N50)" or "(N250)" next to each rock name so the user knows the
detail level of what they clicked on.

## Offline pipeline

A single new script: `geology_fetch.py`.

1. **Tiled WFS fetch.** Subdivide the bbox into ~0.2° tiles (same pattern
   as `buildings_fetch.py`) to stay under NGU's per-request feature cap.
2. **Parse GeoJSON** with Shapely; reproject any non-EPSG:25833 features.
3. **Deduplicate** features split across tile boundaries by feature ID.
4. **Triangulate polygons** with `mapbox-earcut` (handles holes).
5. **Bin per 4 km cell** (same scheme as `canopy.bin` / `water.bin`) for
   GPU-side frustum culling.
6. **Emit binaries** (formats below).
7. **Emit sidecar JSONs** with the rock-type / deposit-type lookup tables
   (id → name + hex colour from NGU's published symbology).

The script is invoked the same way as the others:
```
uv run --with requests --with shapely --with mapbox-earcut python geology_fetch.py
```

The output binaries are committed to git (with `data_parts/` chunking if
any single file exceeds 100 MB — `reconstitute.py` already handles this
generically via its `TARGETS` list).

## Binary file formats

### `bedrock.bin` (magic `BRK1`)

Per-cell triangulated polygons. Each polygon record carries a `rockId`
into `bedrock.json`.

```
char  magic[4] = "BRK1"
u32   ver = 1
u32   nCells
for each cell:
  i32   kx, ky                     // cell index
  f32   cx, cy                     // cell centre (centred world coords)
  f32   czMin, czMax               // for sphere bounds
  f32   radius
  u32   nPolys
  for each poly:
    u16   rockId                   // -> bedrock.json
    u16   pad
    u32   nVerts
    u32   nTris
    f32   verts[nVerts][3]         // (x, y, z) DEM-draped
    u32   indices[nTris][3]        // u32 because per-cell can exceed 65535 verts
```

(Use `u32` indices rather than `u16` to avoid splitting big polygons; the
extra 2 bytes per index is cheap.)

### `quaternary.bin` (magic `QUA1`)

Identical layout to `bedrock.bin`, magic `QUA1`, IDs into `quaternary.json`.

### `faults.bin` (magic `FLT1`)

Same layout as `osm.bin` — grouped by fault type rather than road class.

```
char  magic[4] = "FLT1"
u32   nGroups
for each group:
  u8   typeIdx                    // 0 fault, 1 thrust, 2 shear, 3 other
  u8   pad[3]
  u32  nVerts                     // even (LineSegments pair vertices)
  f32  vert[nVerts][3]            // x, y, z (DEM-draped)
```

### Sidecar JSONs

```jsonc
// bedrock.json
{
  "0": { "name": "Granitt",          "color": "#ff6f6f", "scale": "N50" },
  "1": { "name": "Gneis",            "color": "#f0a8c8", "scale": "N50" },
  "2": { "name": "Glimmerskifer",    "color": "#b8d878", "scale": "N250" },
  ...
}
// quaternary.json — same shape, deposit names + standard NGU colours
```

Colours are taken from NGU's published SLD/symbology so the map matches
official NGU visualisations.

## Renderer additions (`viewer.html`)

### New uniforms

- `uGeoBlend` — 0..1 blend amount (HUD slider).
- `uBedrockOpacity = uGeoBlend × bedrockVisible`.
- `uQuatOpacity    = uGeoBlend × quatVisible`.

### New layers

1. **Bedrock layer** — `THREE.Group` of meshes, one mesh per cell.
   Vertex shader: identity (positions are world-space, Z lifted by
   `+0.5 m × EXAG` to sit on top of terrain). Fragment shader: per-vertex
   `vColor` (colour baked from `rockId` lookup at load time), `gl_FragColor =
   vec4(col, uBedrockOpacity)` modulated by simple Lambert and fog.

2. **Quaternary layer** — same as bedrock, separate group, separate
   uniform.

3. **Faults layer** — `THREE.LineSegments`, lifted by `drapeOffset × EXAG`
   (same as roads), single colour `#e040c0` (saturated magenta — readable
   over both natural and geological colours). Optional per-type stroke
   variation (dashed for thrust faults).

### Render order

```
sea → water → terrain → bedrock → quaternary → canopy → trees → buildings → roads → boundaries → faults
```

Bedrock + quaternary use `transparent: true`, `depthWrite: false`, `polygonOffset`
to avoid z-fight with the terrain underneath.

### Blending semantics

The natural terrain palette is rendered as today. Bedrock + quaternary
sit on top with alpha = `uGeoBlend`. So:
- slider at 0 → pure natural palette
- slider at 1 → fully geological (terrain still visible because hill-shading
  is applied to the geology colours too)
- slider at intermediate → see-through tint

Faults are independent: they're either visible (sharp solid line) or
hidden, controlled by their own checkbox.

### HUD additions

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Bedrock checkbox | — | off | Toggle bedrock layer. |
| Quaternary checkbox | — | off | Toggle quaternary layer. |
| Faults checkbox | — | off | Toggle fault lines. |
| Geology blend | 0–100% step 5% | 60% | Alpha of bedrock + quaternary fills. |

All four collapse into a small "Geology" subpanel in the existing controls
panel — a `<details>` block, closed by default so first-time users aren't
overwhelmed.

### Click-to-identify

1. On `pointerdown` (no drag), raycast from camera through cursor.
2. Intersect against the loaded terrain meshes — already cheap because
   the renderer maintains the terrain quad-tree.
3. Get world (x, y) of the hit.
4. Query the polygon spatial index (see below) at (x, y) for both
   bedrock and quaternary.
5. Display a small floating panel anchored at the cursor:
   ```
   Bedrock:   Anorthosite   (N50)
   Quaternary: Bare bedrock  (N50)
   ```
   Plus a small swatch matching the layer colour. Panel auto-hides
   on next click outside it or after 8 s.

### Spatial index

A flatbush-style packed Hilbert R-tree built at viewer load time over
all polygon AABBs (one entry per polygon, both bedrock and quaternary).
Roughly:
- Build cost: O(n log n) once, milliseconds for tens of thousands of polys.
- Query cost: O(log n) bounding-box prune + O(k) point-in-polygon refine.

Implementation: a small dependency-free flatbush-equivalent inlined in
viewer.html (~100 lines), or pull `flatbush` from a CDN. Decision left
to implementation phase; both are cheap.

## LOD strategy

- Per-cell frustum culling (sphere bounds), like canopy/water.
- No far-fade for geology by default — at long distances polygons collapse
  visually anyway; we just rely on fog.
- Beyond a configurable `geologyRange` (default = `canopyRange`, i.e.
  ~30 km), cells are dropped to keep big-zoom-out fast.

## Data size & chunking

Estimated sizes for Rogaland 1:50k:

- `bedrock.bin`: ~30–80 MB triangulated. **May exceed 100 MB**; if it
  does, append it to `reconstitute.py`'s `TARGETS` list and chunk into
  `data_parts/`. The viewer-side logic doesn't change.
- `quaternary.bin`: probably 20–60 MB.
- `faults.bin`: ~1 MB.
- `bedrock.json` / `quaternary.json`: each a few KB.

Downloading the raw data from NGU is the slow step (~tens of minutes
for tiled WFS over Rogaland). That happens once, offline; users only
ever load the binaries.

## Failure modes & graceful degradation

- **Binaries missing**: viewer logs a warning, hides the geology
  controls. Existing layers continue to work.
- **Fetch script can't reach NGU**: falls back to retry with backoff;
  if a tile fully fails after retries, it's skipped and a warning is
  logged. The script is resumable (caches per-tile responses).
- **Click on a polygon hole / void**: the panel shows "(no data)" for
  that layer.

## Out of scope (for this iteration)

- Cross-sections / "slice through the terrain" view.
- Mineral resource overlays (NGU has these but they're a separate dataset).
- Time-period filtering (e.g. "show only Precambrian rocks").
- Mobile / touch support for the click-identify panel (the rest of the
  viewer is desktop-only by convention).

## Testing approach

- `geology_fetch.py`: round-trip a small known WFS query, assert the
  written binary parses back to the same polygon list (Shapely equality
  on a sample subset).
- Viewer: smoke test that toggling each checkbox re-renders without
  console errors; click-identify returns a known rock name at a hand-
  picked test coordinate (e.g. the Stavanger anorthosite outcrop).

## Reimplementation note

When `SPEC.md` is next updated, add a new "Section 9: Geology overlay"
mirroring the format of sections 5–7 (features, aesthetics, binary
formats), so the spec stays the single source of truth for any future
re-implementation.
