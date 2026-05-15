# Client Architecture

The browser client starts in `viewer.html`, imports `src/client/init.js`, and initializes browser-native ES modules under `src/client/`.

## Module ownership

- `core/`: constants, binary helpers, coordinate transforms, and UI-controlled app state.
- `terrain/`: tile pyramid math, height texture contracts, tile cache, mesh pool, and LOD traversal.
- `rendering/`: scene setup, camera persistence, frustum updates, material factories, render loop, and compass.
- `shaders/`: shader source strings moved from the original viewer without formula changes.
- `overlays/`: roads, geology, contours, faults, and click-to-identify.
- `features/`: buildings, forest/canopy, water, amenities, road-trip camera, place-name labels, and geometry builders.
- `ui/`: DOM controls and HUD updates.

## Preserved contracts

- Height texture sampling keeps the original Y-flip behavior.
- Geology raster sampling keeps the original no-flip behavior.
- Shared uniforms are passed by reference.
- Terrain meshes are recycled each frame before quadtree traversal.
- Render-loop order remains controls, recycle, frustum, terrain, feature culling, cache eviction, render, compass.
- UI controls preserve the original labels, ranges, and side effects.

## FeatureSystem protocol

The `create*System` factories converge on a shared shape so the render loop
and UI controls can iterate systems generically. Each method is optional —
systems implement only what applies.

| Method | Purpose |
| --- | --- |
| `load()` | Fire-and-forget async loader. Returns `Promise<void>`. Composite systems (forest, geology) wrap their sub-loaders here so callers see one entry point. |
| `update(ctx)` | Per-frame update. `ctx = { dt, camera, time }`. Used by labels (re-evaluate visibility) and roadtrip (advance camera). |
| `cull(ctx)` | Per-frame visibility refresh. `ctx = { camera, frustum, rangeMetres? }`. Distinct from `update` so the render loop can pass the live frustum once. |
| `setVisible(arg)` | Toggle the whole system. `arg` is normally a boolean; `roads` accepts `{ roads, towns }` to flip both sub-groups in one call. |
| `setExaggeration(value)` | Mirror the global exaggeration into the system's owned uniforms / meshes. |
| `setRange(metres)` | Optional. Set the system's far visibility / fade range. |
| `dispose()` | Optional. Release GPU resources. Currently unused — the viewer is a single-page app. |

### Current adoption

- `forest`, `geology` expose composite `load()` plus the legacy
  `loadTrees`/`loadCanopy` and `loadBedrock`/`loadQuaternary` for tests and
  partial loading.
- `roads` exposes `setVisible({ roads, towns })` plus the legacy
  `setRoadsVisible`/`setTownsVisible`.
- `labels` exposes `setExaggeration` (alias of `setExag`) and `cull(ctx)`
  (alias of `update(camera)`) for protocol parity.
- Everything else (`buildings`, `water`, `amenities`, `faults`, `roadtrip`,
  `compass`, `terrainLod`) already followed the protocol.

When adding a new feature system, prefer the protocol method names from the
table above and document any deliberate deviations at the top of the module.

## Factory naming

The codebase uses three factory prefixes with distinct semantics:

- `create*` — Owns its own state. Returns an object exposing the
  FeatureSystem methods. Most modules use this (`createBuildingSystem`,
  `createForestSystem`, …).
- `attach*` — Wires shared references to DOM or already-created systems.
  Does not own state. Returns `void` or a small unbind handle. Examples:
  `attachControls`, `attachRoadTripPanel`, `attachIdentifyHandlers`.
- `make*` — Constructs a one-shot artifact (typically geometry).
  Returns the artifact, not a system. Examples: `makeHouseGeometry`,
  `makeTreeGeometry`, `makeTileEdgeGeometry`.
