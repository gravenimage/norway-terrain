# Rogaland 3D Terrain — Reimplementation Spec

A complete description of every user-facing feature, every aesthetic decision,
and every external data source used in this project, so the same look and feel
can be recreated in a different tech stack.

The current implementation is browser-side WebGL (Three.js r160 with custom
shaders) reading data files generated offline by Python scripts. Only the
*spec* matters for reimplementation; the file paths and tooling are reference
context.

---

## 1. Geographic scope and projection

- **Region**: Rogaland, south-western Norway.
- **WGS-84 bbox** (used to fetch external data): `S=58.0, W=4.0, N=60.5, E=7.5`.
- **Working CRS**: `EPSG:25833` (UTM Zone 33N), metres.
- **DEM bbox** (UTM33): `xMin=-50000, yMin=6,440,000, xMax=100,000, yMax=6,700,000`
  (150 km × 260 km).
- **Scene origin**: world XY is centred on the DEM bbox centre
  `((xMin+xMax)/2, (yMin+yMax)/2)`. Z is up. All datasets are translated to this
  centred frame before being uploaded to the GPU.
- **Up axis**: Z-up (the renderer is configured Z-up, *not* the engine default
  Y-up). Trees, buildings, snow shading and lighting all assume Z-up.

---

## 2. Source data

Every layer is derived from one of these public sources. All processing is
offline; the renderer only ever loads the derived binary files.

### 2.1 Digital terrain model (DTM)

- **Source**: Kartverket "NHM_DTM_TOPOBATHY_25833" (Norwegian National
  Height Model with bathymetry), via the public ArcGIS ImageServer:
  `https://hoydedata.no/arcgis/rest/services/NHM_DTM_TOPOBATHY_25833/ImageServer/exportImage`
- **Native resolution**: 1 m. Sampled at **10 m** for this project (sufficient
  for the camera distances we use, and ~700 MB GeoTIFF for the full Rogaland
  bbox).
- **Fetch strategy**: tiled `exportImage` requests in 2048 px tiles
  (= 20.48 km on a side at 10 m), float32 GeoTIFF, then mosaicked.
- **Derived file**: `rogaland_10m.tif` (float32, EPSG:25833).
- **Negative elevations** (sea / fjord bathymetry) are clamped to 0 in the
  renderer; the sea is drawn separately as a flat plane.
- **Maximum elevation** in this DEM: ~1721 m.

### 2.2 Roads

- **Source**: OpenStreetMap, fetched via Overpass API (3 endpoints with
  retry/fallback).
- **Filter**: only major road classes, hierarchically ordered:
  `motorway, trunk, primary, secondary, tertiary`.
- **Densification**: long polyline segments are subdivided every **25 m** along
  the great-circle, so that when each vertex is draped onto the DEM the road
  hugs the topography.
- **Per-vertex height**: bilinear sample of the DEM.

### 2.3 Municipality (kommune) boundaries

- **Source**: OpenStreetMap, same Overpass query.
- **Filter**: `relation[boundary=administrative][admin_level=7]` (kommune
  level in Norway). Outer ways extracted, in WGS-84.
- **Densification**: **100 m** along boundary segments, then DEM-draped.

### 2.4 Buildings

- **Source**: OpenStreetMap building footprints, Overpass API, fetched in
  0.4° × 0.4° sub-tiles to avoid timeout on the giant Rogaland bbox.
- **Per-building extracted attributes**:
  - polygon → `Shapely` `minimum_rotated_rectangle` → centre `(cx,cy)`,
    length `L`, width `W`, ridge angle `θ`
  - building **type** (5 classes):
    - `0` house (incl. detached, semidetached, terrace, bungalow, residential)
    - `1` apartments / dormitory
    - `2` commercial / retail / industrial / office / warehouse / supermarket
    - `3` cabin / hut / shed / garage / boathouse
    - `4` other (fallback)
  - **height**: from `height` tag; else `building:levels × 3.0 m + 1.0 m`;
    else default by type (5.5, 14.0, 7.0, 3.5, 5.0 m).
  - **roof shape** (3 classes): `0 flat, 1 gabled, 2 hipped`. From
    `roof:shape` tag, otherwise default by type (residential & cabin
    gabled, apartments gabled, commercial flat).
  - **ground elevation**: DEM-sampled at `(cx,cy)`.
- **Filter**: footprints with area `< 8 m²` are dropped.
- **Wall colour**: deterministic palette index per building, chosen from a
  type-specific subset of the palette (see §6.4).

### 2.5 Forest cover (canopy mask)

- **Source**: ESA WorldCover v200 2021 (10 m global land cover), four 3°
  tiles (`N57E003`, `N57E006`, `N60E003`, `N60E006`). Public S3:
  `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/`
- **Trees** = class `10`. Optional sparse contributions from class `20`
  (shrubland, ~18% density, treated as dwarf birch/scrub) and class `90`
  (wetland, ~5%, occasional bog pine).
- **Tree-line cutoff**: no trees above ~720 m DEM elevation. Density rolls
  off smoothly between 480 m and 720 m.
- **Sea cutoff**: no trees below 0.5 m DEM elevation.
- The forest mask is consumed by two offline products (canopy + per-tree
  records) — see §3.

### 2.6 Inland water bodies (lakes, rivers)

- **Source**: ESA WorldCover class `80` (permanent water).
- **Ocean exclusion**: only kept where DEM > 2 m, so coastal sea is
  filtered out.
- **Resolution**: rasterised at **48 m** for mesh generation.

---

## 3. Offline processing pipeline

All Python; the runtime never does heavy CPU work. The viewer only reads
the derived binaries.

### 3.1 DEM acquisition (`densify.py`)

1. Generate 2048 px tile grid covering the Rogaland bbox.
2. Parallel fetch from ImageServer with retry on 502.
3. Mosaic into a single float32 GeoTIFF `rogaland_10m.tif`.

### 3.2 Terrain-RGB pyramid (`pyramid.py`)

The viewer uses a **Mapbox-style RGB elevation pyramid** sliced as
slippy-style PNG tiles, with a quad-tree LOD on the GPU side.

- **Tile size**: 256 × 256 px.
- **Levels**: 0 (root) … 6 inclusive.
- **Square root frame** centred on the DEM bbox centre, side length
  `max(width, height)` = 260 km.
- **Encoding**: `h = -10000 + (R*65536 + G*256 + B) × 0.1` metres
  (Mapbox terrain-RGB); allows ~−10 km to ~+1.6 Mm with 0.1 m precision.
  Negative elevations clamped to 0 before encoding.
- **Layout**: `tiles/{z}/{x}/{y}.png` (slippy y-down).
- **Sidecar**: `tiles/meta.json` describes
  `{crs, rootX, rootY, rootSize, tileSize, maxZ, encoding, src{xMin,..}, elevMax}`.

### 3.3 OSM roads + boundaries (`osm_fetch.py` → `osm.bin`)

Output is a single binary, magic `OSM2`, packing five road classes plus the
kommune boundary as classes `0..4` and `5` respectively. Each group has
densified line-segment vertices already DEM-draped, in centred world
coordinates. The viewer uploads these as Three.js `LineSegments` with a
custom shader that lifts each Z by `uExag` and a configurable offset.

### 3.4 Buildings (`buildings_fetch.py` → `buildings.bin`)

Magic `BLD1` + `uint32 n` + `n × 32-byte` records:

```
struct Building {
  float32 cx, cy, baseZ;     // centre (centred world XY) + DEM z
  float32 length, width, height;  // metres (along ridge / across / wall)
  float32 angle;             // ridge yaw, radians
  uint8   type;              // 0..4
  uint8   roof;              // 0 flat, 1 gabled, 2 hipped
  uint8   colorIdx;          // index into wall palette
  uint8   pad;
};
```

### 3.5 Canopy carpet + tree records (`forest_polys.py` → `canopy.bin`, `forest.bin`)

The same WorldCover mask drives **two** outputs:

**Canopy carpet** (`canopy.bin`, magic `CANO`, distant LOD): the WorldCover
forest mask is reprojected to EPSG:25833 at **48 m** and emitted as triangle
quads, each corner Z set to the DEM elevation at that point. Quads are
**binned per 4 km cell** (so the GPU can frustum-cull whole cells). The
fragment shader paints these as a noisy textured carpet (see §6.5). Index
type is `uint16`; the cell size is chosen so vertex count per cell stays
under 65535.

**Per-tree records** (`forest.bin`, magic `TRE1`, close-up LOD): inside the
canopy mask, **seed positions** are stride-sampled at 30 m × 30 m (one per
48 m forest quad) and emitted as 20-byte records:

```
struct TreeSeed {
  float32 cx, cy, cz;    // base position in centred world coords
  float32 h;             // base height in metres
  uint8 sp;              // species index (0..3)
  uint8 sj;              // size jitter (0..255 → 0..1)
  uint8 cj;              // colour/yaw jitter (0..255)
  uint8 pad;
};
```

The viewer expands each seed into **K = 16** stratified sub-trees (4×4 sub-grid
per 48 m quad with deterministic in-cell jitter), so the on-screen close-up
density is ~12 m spacing — hash function defined in viewer `jh(seed, salt)`.

**Species assignment by elevation**:
- 0 (`<200 m`): coastal Norway spruce
- 1 (`200–400 m`): Scots pine
- 2 (`400–550 m`): scrub pine + mountain birch mix
- 3 (`>550 m`): wind-stunted pine

**Canopy thickness LUT** (used both by the carpet and as base tree height):

| Elevation z (m) | h (m) |
| ---: | ---: |
| < 50  | 15.0 |
| < 200 | 12.5 |
| < 400 | 9.0  |
| < 600 | 6.0  |
| ≥ 600 | 3.5  |

### 3.6 Water bodies (`water_polys.py` → `water.bin`)

WorldCover class 80, intersected with DEM > 2 m, rasterised at 48 m,
emitted as triangle quads binned per 4 km cell. Magic `WATR`. Same
per-cell layout as canopy.bin but with a different fragment shader.

---

## 4. Coordinate / Z conventions

- **Z-up everywhere.** The terrain pyramid, water mesh, canopy carpet,
  trees, buildings, and roads all live in centred world XYZ where Z is
  the DEM elevation in metres.
- **Vertical exaggeration `EXAG`** (default 1.4, slider 0.5..3.0) is a
  **uniform**, applied in every shader as the last step before world
  position. **Trees, buildings and roads do not pre-multiply Z** — they
  lift their base Z by `EXAG` so they always sit on top of the
  exaggerated terrain. This is a critical invariant.
- The terrain shader exposes the **real** elevation (non-exaggerated) in
  the fragment shader as `zReal = havg / uExag` so the elevation-based
  colour ramp and snow line stay anchored to real heights even when
  exaggeration changes.

---

## 5. User-facing features

The viewer is a single full-window WebGL canvas with two HUD overlays.

### 5.1 Camera & controls

- **Map controls** (orbit + pan). Z-up. Damped, factor 0.08.
- **Mouse**: left-drag rotate, right-drag pan, wheel zoom.
- **Camera**: perspective, FOV 55°, near 50 m, far ~1 Mm.
- **Initial pose**: above and south of the scene, looking north over
  Rogaland. Polar-angle clamped just under horizon
  (`maxPolarAngle = π × 0.49`).
- **Zoom range**: minDistance 200 m, maxDistance ~520 km.

### 5.2 HUD (top-left)

- Title `Rogaland · DTM 10 m terrain-RGB pyramid`.
- Live counters: tiles drawn, cache size, FPS.
- After loaders complete, additional rows are appended:
  `roads: N segs · kommune: M segs`,
  `buildings: N in M cells`,
  `canopy: N cells, M tris`,
  `trees: N instances`,
  `water: N cells, M tris`.

### 5.3 Controls panel (top-right)

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| **Exaggeration** slider | 0.50–3.00 step 0.05 | 1.40 | Vertical scale for terrain. Live-updates terrain, overlays, buildings, trees, canopy and water uniforms together. |
| **SSE px** slider | 1–16 step 0.5 | 3 | Screen-space error in pixels per quad triangle, drives terrain LOD subdivision. |
| **Seg** slider | 16–128 step 16 | 64 | Tessellation per terrain tile (each tile is a SEG×SEG plane). |
| **Roads** checkbox | — | on | Toggle road overlay. |
| **Kommune boundaries** checkbox | — | on | Toggle municipal boundary overlay. |
| **Buildings** checkbox | — | on | Toggle stylised building instances. |
| **Forest / trees** checkbox | — | on | Toggles **both** close-up trees and the distant canopy carpet. |
| **Drape offset (m)** | 0–60 step 1 | 12 | Additional vertical lift of OSM lines above terrain (avoids z-fight). |
| **Building visibility (km)** | 3–60 step 1 | 22 | Far fade distance for buildings. Near fade is `max(far - 4 km, far × 0.7)`. |
| **Canopy range (km)** | 3–50 step 1 | 30 | Outer radius of distant canopy carpet visibility. |
| **Canopy LOD switch (km)** | 0.3–6 step 0.1 | 1.5 | Distance at which close-up trees fade out and the canopy carpet fades in. The transition band is ±300 m around this value. |

### 5.4 Layer hierarchy (rendered, back to front)

1. **Sea plane** — flat, low Z, dark navy, `MeshBasicMaterial` (single quad
   covering 1.5 × root size).
2. **Inland water bodies** — depth-shaded blue mesh, lifted +0.4 m above
   terrain to avoid z-fight with shores.
3. **Terrain pyramid** — quad-tree of textured terrain-RGB tiles with
   colour ramp + slope rock + snow.
4. **Distant canopy carpet** — fades in past the LOD switch.
5. **Close-up trees** — instanced low-poly cones, fade out past the LOD
   switch.
6. **Buildings** — instanced stylised houses, fade out past the building
   visibility distance.
7. **OSM roads + kommune boundaries** — lifted line segments, render
   order 10 / 11.

### 5.5 LOD strategy (terrain)

- Terrain is a quad-tree from level 0 (whole bbox) to level 6.
- **Subdivision criterion**: `screenPx / SEG > SSE_PX` ⇒ recurse. So per-quad
  pixel coverage stays under `SSE_PX` regardless of zoom.
- Each tile is rendered with a **shared** SEG×SEG plane mesh; per-tile
  uniforms are world origin, tile size, UV offset/scale (so a parent
  texture can serve a child if the child texture isn't yet loaded).
- **Texture cache**: LRU map of decoded terrain-RGB tiles, max 256.

### 5.6 LOD strategy (forest)

- **Two representations**: per-tree instanced geometry up close, textured
  canopy quads at distance.
- A configurable cross-fade band (default 1200 m → 1800 m) hides one as
  the other appears, so flying away from forest never shows a hard pop.
- **Outside the canopy range** (default 30 km) even the carpet fades to
  fog colour, so distant terrain shows just the underlying ramp.
- Per-cell frustum culling using sphere bounds for both layers.

### 5.7 LOD strategy (buildings)

- Instances bin into 8 km cells; each cell has a sphere bounding volume.
- Cells are dropped from rendering when `dist - radius > BLD_RANGE`, then
  individual instances additionally fade with distance via the fragment
  shader for a soft edge.

### 5.8 LOD strategy (water, roads)

- Roads/boundaries: drawn always (small geometry).
- Water: per-cell frustum cull only; no fade.

---

## 6. Aesthetics

This section captures every colour, every elevation band, and every lighting
constant that defines the look. All RGB triples are **linear** sRGB values
in `[0,1]` (the renderer outputs sRGB; values you see here are the
shader-side numbers).

### 6.1 Background, fog, sun

- **Scene background / fog colour**: `#0c1322` (very dark blue-grey,
  ≈ `(0.047, 0.075, 0.133)`).
- **Fog**: linear, `near = rootSize × 0.5`, `far = rootSize × 1.6`.
- **Sun direction (world)**: `normalize(-0.4, -0.6, 0.85)` — high, slightly
  N-NW. Used by every lit shader.
- **Body colour**: HUD/help panels on `rgba(0,0,0,0.55)`, text `#cdd`,
  highlight `#7cf`.

### 6.2 Sea (flat plane, far-water)

- `MeshBasicMaterial`, colour `#123048` (deep cool navy).
- Z position −0.5 m (below terrain shore).

### 6.3 Inland water bodies (lakes, rivers)

Custom shader; mesh lifted +0.4 m above shoreline:

- **Deep colour**: `(0.06, 0.20, 0.36)` — cold dark blue.
- **Shallow colour**: `(0.18, 0.42, 0.55)` — lighter teal.
- **Depth fade**: linear by *exaggerated* z, `vDepthFade = clamp(z/200, 0, 1)`,
  mixes deep → shallow with elevation. (Higher mountain lakes appear
  lighter, which reads correctly against the dark forested low country.)
- **Lighting**: per-pixel normal from `dFdx/dFdy` (procedural), `N·L`
  shading curve `0.55 + 0.45 × max(N·L, 0)` (no specular).

### 6.4 Buildings

Stylised low-poly Nordic houses. Each instance is a unit box (`x,y ∈ [-0.5,0.5]`,
walls `z ∈ [0,1]`) with one of three roof tops (flat / gabled / hipped),
scaled by per-instance L × W × H, then rotated by `iRot` and translated.

**Wall palette** (`PAL`, indices 0..11):

| # | RGB (linear) | Name |
| --- | --- | --- |
| 0 | (0.61, 0.16, 0.15) | Falu red |
| 1 | (0.93, 0.90, 0.83) | white |
| 2 | (0.79, 0.63, 0.31) | ochre |
| 3 | (0.83, 0.63, 0.09) | mustard |
| 4 | (0.42, 0.12, 0.09) | dark red |
| 5 | (0.71, 0.69, 0.66) | apartment grey |
| 6 | (0.81, 0.77, 0.68) | apartment beige |
| 7 | (0.85, 0.78, 0.65) | apartment cream |
| 8 | (0.61, 0.59, 0.56) | commercial concrete |
| 9 | (0.76, 0.74, 0.70) | commercial light |
| 10 | (0.48, 0.47, 0.44) | commercial grey |
| 11 | (0.44, 0.31, 0.17) | cabin brown |

**Per-type allowed wall colours**:

| Type | Allowed indices |
| --- | --- |
| 0 house | 0, 1, 2, 3, 4 |
| 1 apartments | 5, 6, 7 |
| 2 commercial | 8, 9, 10 |
| 3 cabin | 0, 4, 11 |
| 4 other | 1, 5, 8 |

A deterministic hash of OSM `id` chooses the wall colour within the allowed
subset.

**Roof colour by type+roof shape** (`roofFor`):

- type 0 (house) or 3 (cabin) → `(0.16, 0.16, 0.18)` dark slate
- type 1 (apartments) → `(0.32, 0.30, 0.28)` mid grey
- type 2 (commercial) or 4 (other) → `(0.45, 0.45, 0.43)` light grey

**Roof geometry**:
- flat (rf=0) → no peak.
- gabled (rf=1) → ridge along X, peak height `min(0.55 × W, 4.5) m`.
- hipped (rf=2) → peak height `min(0.40 × W, 3.5) m`.

**Building shading** (custom shader):
- `diff = max(N · L, 0)`, `wrap = 0.30 + 0.85 × diff` (soft wrap).
- `zBias = clamp(N.z × 0.15 + 0.85, 0.6, 1.0)` (top faces slightly brighter).
- Final colour `vColor × wrap × zBias`, distance fog mix, distance fade.

### 6.5 Forest — close-up trees

**Geometry** (low-poly conifer): two stacked hexagonal cones — a wider
lower skirt (radius 1.0 → 0.55, z 0.05 → 0.55) and a narrower upper spike
(radius 0.65 → 0, z 0.50 → 1.00) — plus a tiny 4-sided trunk box (radius
0.07, z −0.10 → 0.06). Three "parts": 0 lower, 1 upper, 2 trunk.

**Per-instance**: `iPos (cx,cy,cz)`, `iSize (radius, height)`, `iRot`,
`iCanopyA` (lower colour), `iCanopyB` (upper colour). Trunk colour fixed
at `(0.27, 0.18, 0.10)`.

**Aspect ratios** by species (base radius / height):

| Sp | Aspect |
| ---: | ---: |
| 0 spruce | 0.30 (narrow) |
| 1 pine | 0.36 |
| 2 mix | 0.55 (rounder) |
| 3 stunted | 0.40 |

**Tree palette** (`TREE_PAL` lower, `TREE_PAL_DARK` upper). Tight cool
dark pine tones — the four species are deliberately similar:

| Sp | Lower (A) | Upper (B) |
| --- | --- | --- |
| 0 | (0.12, 0.22, 0.12) | (0.07, 0.15, 0.08) |
| 1 | (0.13, 0.22, 0.12) | (0.08, 0.15, 0.08) |
| 2 | (0.13, 0.23, 0.12) | (0.08, 0.16, 0.09) |
| 3 | (0.12, 0.21, 0.11) | (0.07, 0.14, 0.07) |

**Per-tree colour jitter** (this matters — without it the forest looks
like a quilt):
- Each of the 16 sub-trees in a quad gets independent jitter from a
  hash `jh(seedIdx, salt + s)`:
  - overall luminance jitter ±0.05
  - per-channel micro-shifts: R ±0.025, G ±0.035, B ±0.025
- All values clamped after addition (`A` to `[0.04, 0.50]`,
  `B` to `[0.03, 0.40]`).

**Density**: K_TREES = 16 stratified sub-trees per 48 m forest quad
⇒ ~12 m on-screen tree spacing. Total ~66 M tree instances for Rogaland.

**Tree size jitter**:
- per-sub-tree: `radius ×= [0.80, 1.15]`, `height ×= [0.85, 1.10]`,
  blended with the per-seed `sj` byte for additional variation.

**Tree shading**: `diff = max(N·L, 0)`, `wrap = 0.35 + 0.80 × diff`,
distance fog mix, distance fade across the LOD band.

**Tree base sink**: trees are sunk slightly into the terrain
(`BASE_SINK ≈ 0.5 m`) so their trunk skirt appears flush.

### 6.6 Forest — distant canopy carpet

**Geometry**: 48 m DEM-draped quads from the WorldCover mask, bumped up
by the elevation-band canopy thickness (same LUT as §3.5).

**Fragment shader**:
- Per-pixel normal from `dFdx/dFdy`.
- Procedural fBm on world XY at two scales (0.013 and 0.045) blends
  three desaturated greens chosen to match the terrain palette:
  - `dark  = (0.06, 0.17, 0.08)` — emerald shadow
  - `mid   = (0.10, 0.24, 0.11)` — matches terrain 30–100 m band
  - `light = (0.17, 0.31, 0.15)` — mossy olive (no neon green)
- **Alpine desaturation**: above 350 m baseZ, blend up to 60% toward
  `base × 0.80 + (0.07, 0.07, 0.05) × 0.20`.
- `N·L` shading: `col = base × (0.40 + 0.65 × N·L)`.
- Two distance fades: in across `[uFadeNear, uFadeFar]` (the LOD
  cross-fade band) and out across `[uRangeNear, uRangeFar]` (the canopy
  visibility outer edge).

### 6.7 Terrain colour palette (the key aesthetic)

This was tuned by web-researching Rogaland landscape photography
(Lysefjord, Preikestolen, Kjerag, Jæren). **No tans or golds** — the
Norwegian uplands are heather/crowberry/peat, not dry grass.

**Elevation bands** (zReal = real-elevation, not exaggerated):

| Band | RGB | Description |
| --- | --- | --- |
| 0–30 m   | (0.07, 0.26, 0.10) | emerald coastal forest |
| 30–100 m | (0.10, 0.28, 0.11) | deep forest green |
| 100–200 m | (0.16, 0.28, 0.13) | mossy green, browner |
| 200–320 m | (0.18, 0.24, 0.13) | dark heath, olive-brown |
| 320–400 m | (0.20, 0.21, 0.15) | peat / heath, hint of purple |

(Above 400 m the snow blend dominates; see below.)

The bands are **stepped** (no smoothing between bands) — this gives a
recognisable "contour" feel that matches how Norwegian topographic
charts visualise elevation tiers.

**Bare granite on steep slopes** (Preikestolen / Kjerag look):
- `slope = 1 − N.z`
- Rock low (wet/mossy): `(0.48, 0.49, 0.50)` cool grey
- Rock high (pale exposed): `(0.66, 0.68, 0.70)` near-white granite
- Mix low→high by `smoothstep(150, 600, zReal)` — higher elevations are
  paler.
- Mix base→rock by `smoothstep(0.20, 0.50, slope)` — gentle slopes stay
  vegetated, steep faces become rock.
- The grey is deliberately **cool**, not warm — Rogaland granite reads
  cool blue-grey, not tan.

**Snow**:
- Snow colour: `(0.94, 0.96, 0.99)` (almost white, slight cool tint).
- Onset: `snowAlt = smoothstep(380, 470, zReal)` — feathered snow line
  centred at ~425 m. (User-specified, intentionally lower than the natural
  500–700 m for visual drama.)
- Slope mask: `snowSlope = 1 - smoothstep(0.28, 0.55, slope)` — snow
  sticks only on gentler ground.
- Final snow factor `snowAlt × snowSlope` blends into the rock+vegetation
  base.

**Sea cell short-circuit**: any terrain quad with `havg < 1.0 m` is
overwritten with `(0.10, 0.18, 0.28)` (deep navy, slightly warmer than
the inland water shader so coastal contrast reads clearly).

**Lighting curve** (terrain): `col = base × (0.40 + 0.70 × diff)` where
`diff = max(N·L, 0)`. This is intentionally flat — strong enough to read
slope but soft enough to keep shadow sides legible (deliberately
softer than the `0.30 + 0.85 × diff` curve used on buildings).

**Distance fog**: linear blend toward `uFogColor` over `[FOG_NEAR, FOG_FAR]`,
applied per-fragment to terrain, water, buildings, trees, and canopy.

### 6.8 Roads & boundaries

Solid, depth-tested but not depth-writing line colours:

| Class | Colour |
| --- | --- |
| 0 motorway | `#ff5050` |
| 1 trunk | `#ff8a3c` |
| 2 primary | `#ffc846` |
| 3 secondary | `#ffe89a` |
| 4 tertiary | `#cfd8dc` |
| 5 kommune boundary | `#7be0c8` |

Render order: roads `10`, boundaries `11` (boundaries on top).

---

## 7. Binary file formats (reference)

### 7.1 `osm.bin` (magic `OSM2`)

```
char  magic[4] = "OSM2"
u32   nGroups
f64   centerX, centerY        // (currently unused on read)
for each group:
  u8   classIdx               // 0..4 road class, 5 kommune
  u8   pad[3]
  u32  nVerts                 // even (LineSegments pair vertices)
  f32  vert[nVerts][3]        // x, y, z (centred world coords)
```

### 7.2 `buildings.bin` (magic `BLD1`)

```
char  magic[4] = "BLD1"
u32   n
record[n] { f32 cx,cy,baseZ; f32 L,W,H; f32 angle;
            u8 type; u8 roof; u8 colorIdx; u8 pad; }   // 32 bytes
```

### 7.3 `forest.bin` (magic `TRE1`)

```
char  magic[4] = "TRE1"
u32   n
record[n] { f32 cx,cy,cz; f32 h; u8 sp; u8 sj; u8 cj; u8 pad; }   // 20 bytes
```

### 7.4 `canopy.bin` (magic `CANO`)

```
char  magic[4] = "CANO"
u32   ver = 1
u32   nCells
for each cell:
  i32   kx, ky                      // cell index
  f32   cx, cy                      // cell centre (world)
  f32   czMin, czMax                // for sphere bounds
  f32   radius
  u32   nVerts
  u32   nTris
  f32   verts[nVerts][3]            // positions (cell-local? — see code)
  u16   indices[nTris][3]
  // pad to 4-byte boundary if (nTris*3) is odd
```

### 7.5 `water.bin` (magic `WATR`)

Identical to `canopy.bin` but with magic `WATR` and Z bumped by +0.4 m
to avoid shore z-fighting.

### 7.6 Terrain pyramid

- `tiles/{z}/{x}/{y}.png` 256×256 RGB (Mapbox terrain-RGB encoding).
- `tiles/meta.json` describes the pyramid (CRS, root extent, max level,
  encoding, source bbox, max elevation).

---

## 9. Geology overlay

### 9.1 Source data

- **Bedrock**: NGU "Berggrunn" WFS, multi-scale (preferring N50 1:50,000 where coverage exists, falling back to N250 1:250,000). Polygons with attributes including `bergartnavn` (rock name) and `malestokk` (scale).
- **Quaternary deposits**: NGU "Løsmasser" WFS N50 (1:50,000). Polygons with attribute `jordart` (deposit name).
- **Structural lines (faults)**: NGU "Berggrunn" WFS `strukturlinje`. Lines with attribute `strukturtype` (fault, thrust, shear, other).

All EPSG:25833. Tiled WFS fetch in 0.4° tiles (mirrors `buildings_fetch.py` pattern).

### 9.2 Offline pipeline (`geology_fetch.py`)

1. Tile-iterate the WGS-84 bbox, fetching each tile as GeoJSON, caching to `geology_cache/`.
2. Deduplicate features by `id` across overlapping tiles.
3. Reproject each feature to EPSG:25833 (Shapely + pyproj).
4. Triangulate polygons with `mapbox-earcut` (handles holes).
5. Sample DEM bilinearly at each vertex → per-vertex Z.
6. Bin polygons per 4 km cell (same scheme as canopy/water).
7. Emit binaries `bedrock.bin` (BRK1), `quaternary.bin` (QUA1), `faults.bin` (FLT1) and JSON sidecars `bedrock.json`, `quaternary.json`.

### 9.3 Binary formats

**`bedrock.bin` / `quaternary.bin`** (magic `BRK1` / `QUA1`):

```
char  magic[4]
u32   ver = 1
u32   nCells
for each cell:
  i32 kx, ky
  f32 cx, cy
  f32 czMin, czMax
  f32 radius
  u32 nPolys
  for each poly:
    u16 rockId; u16 pad
    u32 nVerts; u32 nTris
    f32 verts[nVerts][3]
    u32 indices[nTris][3]
```

**`faults.bin`** (magic `FLT1`): identical layout to `osm.bin` but typed by fault category (0 fault, 1 thrust, 2 shear, 3 other).

**Sidecar JSONs**: `{ "<rockId>": { "name": str, "color": "#rrggbb", "scale": "N50"|"N250" } }`.

### 9.4 Renderer

Three new layers added to `viewer.html`:

- `bedrockGroup` — ground-conforming polygon mesh per cell. Custom shader, Z lifted by `+0.5 m × EXAG`. Per-vertex colour baked from the JSON lookup. `transparent=true`, `depthWrite=false`, `polygonOffset` to avoid z-fight with terrain.
- `quatGroup` — same shader, `+0.7 m × EXAG` lift to sit above bedrock.
- `faultsGroup` — `LineSegments`, lifted `+1.0 m × EXAG`, single colour `#e040c0`.

### 9.5 HUD additions

A collapsible **Geology** subpanel (`<details>`, closed by default):

| Control | Range | Default | Effect |
| --- | --- | --- | --- |
| Bedrock checkbox | — | off | Toggle `bedrockGroup`. |
| Quaternary checkbox | — | off | Toggle `quatGroup`. |
| Faults checkbox | — | off | Toggle `faultsGroup`. |
| Geology blend | 0–100% step 5% | 60% | Sets `uOpacity` on both polygon materials. |

### 9.6 Click-to-identify

- On left-click without drag: raycast against terrain → world (x, y).
- AABB prefilter against polygon list, then ring-based point-in-polygon refine.
- Floating panel near cursor shows colour swatch + rock/deposit name + scale tag.
- Auto-hides after 8 s.
- Inactive when no geology layer is visible.

### 9.7 Aesthetics

Colour palettes are derived from NGU's published symbology (e.g. granite `#ff6f6f`, gneiss `#f0a8c8`, peat `#7a5a3a`, marine clay `#a8c8e0`). Unknown rock types fall back to a deterministic pastel from `sha1(name)`.

Hill-shading is intentionally minimal on the geology fills (`0.55 + 0.55 × N·L`) — strong shading would overwhelm the categorical colour read. Faults use saturated magenta to contrast against any underlying colour.

---

## 8. Reimplementation checklist

If you're building this in another stack (Bevy, Unity, Unreal, Godot,
your own engine):

1. Reproduce the Z-up convention and the centred-world coordinate frame.
2. Reproduce the **terrain quad-tree LOD with screen-space-error
   subdivision** (or a comparable adaptive scheme); 256 px tiles work well.
3. Reproduce the **stepped elevation palette** with **slope-based granite**
   and **snow above 400 m on gentle slopes** — these three rules are most
   of the visual identity.
4. Use the **pine-dominant cool dark-green tree palette** with
   **per-instance RGB micro-jitter** (not per-cluster) — this avoids the
   "quilt" look.
5. Implement the **two-stage forest LOD**: dense per-tree instances close
   in, a noise-textured canopy carpet far out, with a soft cross-fade.
6. Implement the **building palette by type subset** (Falu reds for
   houses, beige/grey for apartments, concrete tones for commercial,
   browns for cabins) with **gabled vs hipped vs flat roofs** chosen by
   OSM tags.
7. **Lift, don't pre-multiply**: trees, buildings, roads should *lift*
   their base Z by the exaggeration factor — they should not be modelled
   in pre-exaggerated coordinates. This keeps proportions correct as the
   user changes exaggeration live.
8. Treat the **fog colour as the universal "atmospheric tint"** — every
   shader fades to it at distance. Pick a single dark blue-grey
   (`#0c1322` here) and stick to it.
9. The **inland water shader** is two-colour by depth (deep-navy →
   teal) plus simple Lambert. Lifted +0.4 m above shore. Resist the urge
   to add specular — it disrupts the flat low-poly aesthetic.
10. Provide the same **user controls** (exaggeration, building/canopy
    visibility distances, layer toggles, road drape offset). They are how
    the user explores the scene at different scales.
