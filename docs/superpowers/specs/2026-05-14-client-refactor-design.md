# Client Refactor Design

## Problem

The client is implemented as a single `viewer.html` file containing HTML, CSS, and roughly 2,760 lines of embedded module JavaScript. The file mixes scene setup, shader definitions, tile loading, terrain mesh LOD, binary asset parsing, overlays, feature rendering, UI handlers, culling, cache eviction, and the render loop.

This makes the next planned terrain mesh rewrite risky because important data contracts are implicit in control flow and shared mutable globals. The refactor must first separate concerns and document assumptions without changing behavior.

## Goals

- Preserve runtime behavior exactly while moving code into focused modules.
- Make inputs, outputs, data formats, coordinate assumptions, and side effects explicit.
- Keep every extraction small enough to review and revert independently.
- Highlight existing coupling instead of hiding it behind premature abstractions.
- Establish browser-level regression checks before moving client code.
- Leave the codebase ready for later terrain mesh generation and display changes.

## Non-goals

- No change to terrain mesh generation, LOD heuristics, shader formulas, colors, overlays, UI behavior, or data formats.
- No conversion to a framework.
- No build pipeline requirement unless browser regression tooling needs one.
- No cleanup of server-side Python or data generation scripts except where tests need a stable local server.

## Current client responsibilities

`viewer.html` currently owns these concerns:

- Scene, renderer, fog, camera, controls, compass, and camera persistence.
- Global configuration such as exaggeration, screen-space error, terrain segment count, range controls, and LOD thresholds.
- Binary loading/parsing for roads, buildings, amenities, forest, canopy, water, geology rasters, and faults.
- Geometry builders for houses, trees, billboards, canopy, water, amenities, and props.
- Shader strings and material factories for terrain, overlays, buildings, trees, canopy, water, and amenities.
- Shared uniform objects used by multiple material instances.
- Terrain tile loading, tile cache, mesh pool, frustum tests, quadtree LOD traversal, and cache eviction.
- UI event handlers that directly mutate globals, uniforms, visibility flags, geometry, and localStorage.
- Click-to-identify logic for geology raster sampling and panel display.

The most important finding is not just file size; it is that hidden contracts are currently enforced by top-level ordering and shared object identity.

## Target architecture

The refactor should introduce browser-native ES modules under `src/client/` while keeping `viewer.html` as the browser entry point.

```text
src/client/
  core/
    constants.js
    coordinates.js
    binary.js
    shared-uniforms.js
    app-state.js
  terrain/
    tile-pyramid.js
    tile-cache.js
    terrain-mesh-pool.js
    terrain-lod.js
    height-contract.js
  rendering/
    scene.js
    camera-persistence.js
    frustum-culler.js
    material-factory.js
    render-loop.js
    compass.js
  shaders/
    terrain-shader.js
    building-shader.js
    tree-shader.js
    canopy-shader.js
    water-shader.js
    amenity-shader.js
  overlays/
    roads.js
    geology.js
    contours.js
    faults.js
    identify.js
  features/
    buildings.js
    forest.js
    canopy.js
    water.js
    amenities.js
    geometry-builders.js
  ui/
    controls.js
    hud.js
  init.js
viewer.html
```

The first implementation may use fewer files if that makes individual commits safer. The desired direction is clear module ownership, not maximum file count.

## Architectural rules

1. Move code before changing code. Initial extractions should preserve function bodies, shader source, formulas, constants, and call order.
2. Preserve shared uniform references. Shared terrain, road, geology, contour, tree, canopy, water, and building uniforms must be passed by reference, not cloned.
3. Preserve render-loop order: controls update, mesh recycle, camera matrix/frustum update, terrain visit, feature culling, cache eviction, main render, compass render.
4. Preserve fixed render order values and depth behavior for water, terrain, amenity areas, roads, faults, buildings, trees, and canopy.
5. Preserve async degradation behavior. Missing optional assets may warn and leave the scene usable, but refactoring must not turn tolerated failures into hard crashes.
6. Preserve global debug affordances such as `window.__viewer` unless intentionally replaced in a later approved change.
7. Prefer explicit system APIs over direct cross-module mutation, but introduce those APIs only after browser regression checks exist.

## Data and rendering contracts to document

The refactor must make these assumptions visible in code and tests:

- Coordinates use EPSG:25833-like world coordinates centered by root metadata. Elevation exaggeration applies only to Z.
- Terrain height textures use the existing height decode formula and the existing Y-flip sampling convention.
- Geology rasters use their existing no-flip sampling convention and world-space bounding boxes.
- The tile pyramid uses the existing root bounds, power-of-two subdivision, z/x/y URL structure, and screen-space error logic.
- Terrain mesh geometry uses the existing plane tessellation and UV layout.
- The terrain mesh pool is recycled every frame before quadtree traversal.
- Roads use the existing spatial grid texture layout and class encoding.
- Buildings use the existing binary record interpretation, hardcoded palette, roof-height formulas, 8 km cells, and culling behavior.
- Forest uses the existing TRE1/TRE2 interpretation, densification, species mapping, tree/canopy fade thresholds, and geology interaction.
- Water keeps its current all-cells rendering behavior unless a later behavior change is approved.
- Contours remain shader-procedural and coupled to terrain height sampling.
- Faults remain line geometry with existing baked Z handling.

## Refactor approach

Use a harness-first, seam-by-seam strategy:

1. Add verification harnesses before moving client code.
2. Extract low-risk pure code first.
3. Extract data contracts and parsers next.
4. Extract feature systems one at a time.
5. Centralize UI/state after systems expose APIs.
6. Extract terrain LOD/render orchestration last.
7. Reduce `viewer.html` to imports and bootstrap only after modules are proven.

This sequence keeps the highest-risk coupling in place until there is enough regression coverage to detect subtle visual or state changes.

## Step-by-step implementation plan

### Step 1: Baseline and browser regression harness

- Keep `viewer.html` unchanged.
- Add a local browser smoke harness that can serve the project, open the viewer, wait for the scene to become usable, and fail on unexpected console errors.
- Add stable camera/view presets for representative scenes: terrain-only, roads, buildings, forest/canopy, geology, water, and dense mixed view.
- Capture baseline screenshots or pixel snapshots for those presets.
- Record baseline client metrics that are practical to automate: load completion, visible layer flags, tile count, basic FPS sample, and absence of unexpected console errors.
- Keep existing Python tests passing.

### Step 2: Extract pure constants, helpers, and geometry builders

- Move constants that do not depend on runtime initialization into `core/constants.js`.
- Move coordinate and tile-bound helpers into `core/coordinates.js` and `terrain/tile-pyramid.js`.
- Move binary reading helpers into `core/binary.js`.
- Move house, amenity prop, tree, billboard, and other pure geometry builders into `features/geometry-builders.js`.
- Keep call sites and returned geometry identical.
- Run the browser harness after each extraction group.

### Step 3: Extract shader and material source without changing formulas

- Move shader strings into `src/client/shaders/`.
- Move material factory functions into `rendering/material-factory.js`.
- Keep shader text and uniform names unchanged initially.
- Add a check that all expected uniforms are present for terrain materials.
- Keep shared uniform objects created at the same logical point in initialization.

### Step 4: Extract data contracts and parsers

- Create parser modules for roads, buildings, amenities, forest/canopy, water, geology rasters, and faults.
- Each parser should document the binary magic, record layout, units, coordinate assumptions, and nodata behavior it expects.
- Parser modules should return plain data structures and avoid touching THREE.js scene objects.
- Add parser-level tests where fixtures are small enough to keep in the repo or can be generated from existing test fixtures.

### Step 5: Extract overlays and feature systems one at a time

Extract each system with a narrow public API and no behavior change:

- Geology and identify: raster loading, palette texture creation, bbox updates, opacity/toggle uniforms, click-to-identify sampling.
- Roads and towns: OSM parsing, road grid texture generation, road-ready flag, town boundary visibility.
- Water and faults: geometry creation and existing visibility/render order.
- Buildings: binary load, instanced geometry, culling cells, material uniform updates, range controls.
- Forest and canopy: tree/canopy loading, LOD fade state, geology visibility interaction, culling.
- Amenities: area triangulation, props, render ordering, visibility relationship with buildings.

Each system should own its scene nodes and expose explicit methods for load, setVisibility, setExaggeration or equivalent state changes, and per-frame culling where applicable.

### Step 6: Centralize UI and state propagation

- Move DOM lookups and event listener wiring into `ui/controls.js`.
- Introduce an `app-state.js` boundary only for settings that are currently changed by UI controls.
- Keep direct system calls acceptable where they reduce risk, but ensure all UI mutations have one visible code path.
- Preserve localStorage camera persistence behavior and keys.
- Keep `window.__viewer` exposing enough internals for debugging and tests.

### Step 7: Extract terrain mesh, tile cache, and render loop

- Move tile loading and LRU eviction into `terrain/tile-cache.js`.
- Move mesh pool lifecycle into `terrain/terrain-mesh-pool.js`.
- Move quadtree traversal, screen-space error calculation, tile drawing, and frustum checks into `terrain/terrain-lod.js`.
- Move frame orchestration into `rendering/render-loop.js`.
- Keep the original frame order and all counters/HUD updates identical.
- Do this late because it touches the highest-risk behavior: visual terrain output, cache lifetime, popping, and frame performance.

### Step 8: Thin `viewer.html`

- Replace embedded JavaScript with an import of `src/client/init.js`.
- Keep DOM structure and CSS unchanged unless an approved follow-up changes them.
- Keep external library loading behavior unchanged.
- Keep the same viewer URL and data asset paths.

## Verification gates

Every extraction commit should satisfy:

- Existing Python tests pass with `uv`.
- Browser smoke harness loads the viewer with no unexpected console errors.
- Baseline view snapshots stay within the accepted pixel threshold.
- All relevant UI controls still update the same visible behavior.
- Layer toggles still affect the same objects.
- Camera persistence still restores the same view.
- Click-to-identify still returns the same geology information for baseline points.
- Tile count, cache behavior, FPS sample, and memory trend do not show obvious regressions.

For high-risk steps such as terrain LOD, render-loop extraction, shared uniforms, and shader movement, require additional manual review of screenshots and browser console state.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Shared uniform references accidentally cloned | High | Keep a shared uniform registry and add tests/assertions for object identity where practical. |
| Async load ordering changes visual readiness | Medium | Preserve fire-and-forget behavior initially; add load status reporting without blocking render. |
| Shader text changes during extraction | High | Move shader strings verbatim first; format or decompose only in later approved changes. |
| Terrain LOD or tile bounds changes cause seams/popping | High | Extract terrain traversal late and compare baseline views plus tile counters. |
| UI state propagation misses a system | High | Centralize UI wiring after systems expose explicit setters; test every control. |
| Feature culling diverges | Medium | Keep per-system culling policies documented and preserve existing order. |
| Browser harness becomes flaky | Medium | Use fixed camera presets, local static serving, deterministic waits, and limited pixel thresholds. |

## Definition of done

The refactor is complete when:

- `viewer.html` is a small bootstrap file with the same DOM/CSS and data paths.
- Major client responsibilities are separated into focused modules.
- Each module documents its inputs, outputs, side effects, and coupling.
- Existing tests and browser regression checks pass.
- Baseline visual output and UI behavior are preserved.
- The code clearly identifies where future terrain mesh generation and display changes should happen.
