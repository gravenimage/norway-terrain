# Browser Client — Architectural Review

_Reviewed: `src/client/` (entry `viewer.html` → `src/client/init.js`), ~40 ES modules._

This review was conducted by four parallel reviewers, each focused on a distinct
angle:

1. **Module structure** — directory taxonomy, import graph, `init.js` extraction,
   `create*System` interface consistency.
2. **State & lifecycle** — `app-state` adoption, shared-by-reference uniforms,
   render-loop protocol, async loader races, globals, teardown.
3. **Feature & shader duplication** — repeated GLSL, binary-loader patterns,
   geometry primitives, LOD/culling abstractions.
4. **Maintainability scaffolding** — HTML↔JS coupling, JSDoc accuracy, test
   coverage, naming, error handling, contributor onramp.

The goal is to make the codebase **easy to modify and maintain** going forward.
Findings below are deduped and prioritised by leverage on future change cost.

---

## Overall verdict

The codebase is **fundamentally sound**: clean ESM, no import cycles, pure
parsers separated from systems, factory-based composition, decent JSDoc, a small
but real test suite, and an obstacles-service pattern that cleanly coordinates
async loads.

It is at an **inflection point**. Forty modules with consistent-enough
conventions that small refactors now pay dividends, but with enough subtle drift
that another five features added in the same style will start to hurt.

Three meta-issues dominate, each surfaced by multiple reviewers from different
angles:

1. **The `appState` store is dead code at runtime.** Critical mutable state
   (`EXAG`, `SSE_PX`, `BLD_RANGE`, `CANOPY_RANGE`, fade ranges…) lives as `let`
   closures in `init.js`. `ui/controls.js` reaches past `appState` and mutates
   uniform `.value` fields directly across seven uniform bundles per slider
   change. Two mental models, neither owning the truth.

2. **Shared-by-reference uniforms are an undocumented contract.** Road-mask,
   geology, contour and fog uniforms are aliased into half a dozen materials at
   construction time. The contract — "mutate this object's `.value` and
   everyone updates instantly" — is implicit. One developer copying a uniform by
   value instead of by reference silently breaks rendering. No abstraction names
   this pattern.

3. **No system protocol.** The nine `create*System` factories present nine
   different surfaces: `load` vs `loadTrees`+`loadCanopy` vs
   `loadBedrock`+`loadQuaternary`; `cull({camera, frustum, rangeMetres})` vs
   `cull({camera, frustum})` vs `update(camera)` vs nothing;
   `setExaggeration` vs `setExag`; `setVisible(b)` vs
   `setRoadsVisible`+`setTownsVisible`. `rendering/render-loop.js` hard-codes
   which system gets which call. New features can't be added blindly.

---

## Consensus high-leverage findings

### A. State management collapse
_(state review #1, module review #8, maintainability review #4)_

- `core/app-state.js` is a clean observable, but only `EXAG` flows through it
  (and even then via the `stateAccessors` bridge, not as the source of truth).
- `ui/controls.js` fans out each slider into seven uniform mutations plus N
  system method calls in 18 lines of repetitive code.
- Magic tuning numbers (`uExtraLift: 0.5/1.2/0.4`,
  `uFadeNear/Far: 18000/22000/1200/1800/3500/5000`, `maxEntries: 400`,
  `cellSizeMetres: 8000/4000/500`) sit hard-coded in `init.js` and feature
  modules rather than in `core/constants.js`.

**Fix.** Make `appState` the source of truth for every tunable. Replace
`stateAccessors` and direct uniform writes in `controls.js` with
`appState.set('exag', v)`, and let a single subscriber in `init.js` own the
fan-out (either inline or as a small `uniform-coordinator` factory). Move every
magic number that a UI control or tuner could touch into `core/constants.js`.

### B. Shared uniform bundles need a name
_(state #2, module #4)_

- Nine road-mask uniforms are manually re-aliased into `treeUniforms`,
  `canopyUniforms`, `waterUniforms` (`init.js` lines ~200–262).
- Ten geology and five contour uniforms are aliased into the per-tile terrain
  material via the `makeMaterial()` closure.
- Dummy 1×1 `DataTexture` placeholders sit in `init.js` waiting to be replaced
  by `overlays/roads.js` after `osm.bin` parses.

**Fix.** Extract `rendering/uniform-bundles.js` with
`createSharedRoadUniforms(THREE)`, `createSharedGeologyUniforms(THREE)`,
`createSharedContourUniforms(THREE)`. Document at the top: _shared by reference;
do not reconstruct._ Feed bundles into `material-factory.js` so the aliasing
happens inside the factory, not at every call site.

### C. System protocol
_(state #4, module #3, feature-dup #4)_

All three reviewers independently want a `FeatureSystem` shape:

```text
load()            : Promise<void>
update(ctx)       : void                  // ctx = { dt, camera, time }
cull(ctx)         : void                  // ctx = { camera, frustum, rangeMetres }
setVisible(v)     : void
setExaggeration(v): void
setRange(m)       : void
dispose()         : void
```

Each method is optional; a base provides no-op defaults.

- Forest: expose a unified `load()` that calls trees+canopy internally.
- Geology: unified `load()` for bedrock+quaternary.
- Labels: rename `update(camera)` to `cull({camera, frustum})` for consistency.
- Roads: collapse `setRoadsVisible` + `setTownsVisible` into
  `setVisible({roads, towns})`.

`rendering/render-loop.js` then becomes:

```js
for (const s of systems) { s.update?.(updateCtx); s.cull?.(cullCtx); }
```

This is the single highest-leverage refactor: it pays for itself the next time
you add a feature.

### D. Geometry primitives copy-pasted
_(feature-dup #6, module #7)_

- `features/amenities.js:92–125` redefines `_propBox`, `_propCyl`, `_propSphere`
  byte-for-byte identical to `features/geometry-builders.js:64–98`.
- `geometry-builders.js` is also a grab-bag: `makeHouseGeometry` (used only by
  buildings), `makeTreeGeometry` (used only by forest) and 12 amenity props.

**Fix.** Export the colored-primitive helpers as `buildColoredBox/Cylinder/Sphere`
and have amenities import them. Optionally split `geometry-builders.js` into
`building-geometry.js` / `tree-geometry.js` / `amenity-geometry.js` for clearer
ownership.

---

## Other findings, by angle

### Module structure

- **Directory taxonomy is leaky.** `overlays/` mixes GPU-texture overlays
  (roads' road-mask, geology rasters) with line-segment renderers (faults,
  kommune boundaries that live inside `roads.js`). `features/water.js` and
  `features/forest.js` import road-mask uniforms — they're as "overlay-ish" as
  anything in `overlays/`.
  Rename to `scene-layers/` + `terrain-shaders/`, or split `roads.js` into a
  GPU-overlay module and a kommune-boundaries scene layer.
- **`init.js` (579 lines) is mostly fine** as orchestration narrative, but the
  inline identify-panel DOM construction (lines ~403–447) should move to
  `ui/identify-panel.js` to match `attachRoadTripPanel`'s pattern.
- **`placement/obstacles.js` is mis-bucketed.** It's a cross-cutting service
  used by exactly one consumer (forest); rename `placement/` → `services/` and
  the file to `spatial-index.js`.
- **`shaders/road-mask-glsl.js` is a layering hint, not a violation.** It
  defines the GPU contract between `overlays/roads.js` (texture producer) and
  tree/canopy/water shaders (consumers). A short `@file` comment naming the
  contract is enough.
- **No circular dependencies** anywhere in the import graph — keep it that way.

### State & lifecycle

- **Three accidental globals:** `window.__viewer` (debug — fine but flag with
  `if (DEV)`), `window.__roadGrid` (dead-weight debug leak in `roads.js:264`,
  delete it), `window.__wirePanels` (already optional, OK).
- **No dispose/teardown.** Acceptable for a single-page viewer, but
  `initializeViewer` should at minimum document the page-lifetime contract in
  JSDoc. Tests can't tear down cleanly today.
- **Async loader races are currently safe but fragile.** Forest awaits
  `obstacles.roadsReady` + `obstacles.buildingsReady`. If either fails without
  calling `markEmpty()`, forest hangs forever. Add a 10s timeout + warning in
  `forest.js`.
- **localStorage is scattered** across `camera-persistence.js`, `roadtrip.js`
  and the inline panel-state script in `viewer.html`. A tiny `core/storage.js`
  would centralise it and enable a "reset viewer state" debug action.
- **Camera-save timer leaks on `beforeunload`** — `clearTimeout(_camSaveTimer)`
  before the synchronous save is a one-line fix.

### Feature & shader duplication

- **Fog / fade / sun-wrap GLSL is inlined verbatim in five fragment shaders**
  (`tree`, `canopy`, `building`, `amenity` area+prop, `water`), with **drifting
  constants**: wrap-lighting coefficient is `0.35 + 0.80 * diff` for trees,
  `0.30 + 0.85 * diff` for buildings, `0.55 + 0.55 * diff` for amenity areas.
  Extract `shaders/shared-chunks.js` with `fogBlendGLSL`, `distanceFadeGLSL`,
  `sunWrapLightingGLSL` and compose via template strings. **Single biggest LOC
  savings in the review.**
- **Road-mask discard is duplicated** across tree/canopy/water shaders and
  **silently absent** from buildings and amenities — intent undocumented. A
  `withRoadMask(fragmentShader, {enabled, margin})` wrapper makes the opt-out
  explicit.
- **Binary parser boilerplate** (magic check + manual `off += N` offset
  tracking) repeats across eight parsers. A
  `class BinaryLoader { readUint32 / readFloat32 / readUint16 / readUint8 }`
  with magic auto-validated would shrink each parser ~20%.
- **LOD fade math** has two unrelated formulas: buildings use
  `max(range − 4000, range × 0.7)`, canopy uses
  `max(range − 2000, range × 0.85)`. No documented reason. Extract
  `computeFadeRange(range, {fadeWindowMetres, fadeMinRatio})`.
- **Per-cell frustum culling** is duplicated in `buildings.js` and `forest.js`
  (trees+canopy). Extract a `CellCuller` class taking an LOD predicate.
- **Overlay vertex shader** is inlined in `roads.js` for kommune boundaries;
  `faults.js` does CPU-side Z exaggeration instead of using the same shader.
  Extract `overlay-shaders.js` + `createOverlayLineMaterial()`.
- **No central binary format registry.** Each parser exports its own
  `*_CONTRACT`. A `core/binary-registry.js` cataloguing `{AMN1, BLD1, TRE1/TRE2,
  WATR, CANO, OSM2, BRR1, QRR1, FLT1, E391}` with schema docs would be
  invaluable for tooling and onboarding.

### Maintainability scaffolding

- **`tiles/meta.json` fetch has zero error handling** (`init.js:53`). 404 →
  uncaught rejection → blank white viewer. Add a user-facing error overlay.
  **Highest-impact one-day fix in the entire review.**
- **HTML↔JS DOM ID contract is 100% implicit.** 30+ IDs in `viewer.html`,
  hard-coded strings in `ui/controls.js` and `ui/hud.js`, three different
  conventions (plain `id`, `data-panel-key`, `data-rt`). A `ui/dom-ids.js`
  registry plus a `validateDomIds()` boot check would catch typos at startup
  instead of in production.
- **Critical untested modules:** `terrain/terrain-lod.js` (the core renderer),
  `terrain/tile-cache.js` (LRU eviction), `core/app-state.js`,
  `rendering/camera-persistence.js`, `ui/controls.js`. The tests that exist
  (`client-contracts`, `roadtrip`, `labels`, smoke, visual) are good — they
  just don't protect the highest-risk modules.
- **No `playwright.config.ts`** despite having Playwright tests; CI behaviour is
  whatever defaults Playwright ships.
- **No contributor onramp.** `package.json` scripts aren't documented in
  `README.md`; `docs/client-architecture.md` and
  `docs/client-regression-checklist.md` exist but aren't linked from the README.
  A short "## Testing" + "## Contributing" section is a one-hour fix.
- **Factory naming has three prefixes** (`create*` / `attach*` / `make*`) with a
  real but undocumented semantics. Document them in
  `docs/client-architecture.md`.
- **Performance instrumentation is FPS-only.** A `?debug=1` URL flag enabling
  per-subsystem timing would make perf regressions diagnosable.

---

## Recommended sequencing

### Wave 1 — Bleeding stopped _(small, near-zero risk)_

1. Wrap `initializeViewer` bootstrap in try/catch with an error overlay.
2. Extract `shaders/shared-chunks.js` for fog / fade / sun-wrap; refactor the
   five fragment shaders to compose from chunks.
3. Export colored-primitive helpers from `geometry-builders.js`; delete the
   duplicates in `amenities.js`.
4. Delete `window.__roadGrid`; clear the camera-save timer on `beforeunload`;
   document `window.__viewer` as a dev-only debug API.
5. Add "## Testing" + "## Contributing" sections to `README.md`.

### Wave 2 — Contracts named _(medium, low risk)_

6. Extract `rendering/uniform-bundles.js`; have `material-factory.js` accept
   bundles.
7. Define and document the `FeatureSystem` protocol; rename `setExag` →
   `setExaggeration`, `loadTrees`+`loadCanopy` → `load`, `update(camera)` →
   `cull({camera,frustum})`. Make `render-loop.js` iterate a `systems[]` array
   generically.
8. Make `appState` the source of truth: every slider sets state; one `init.js`
   subscriber owns the uniform/system fan-out. Move all tunable magic numbers
   into `core/constants.js`.
9. Add `ui/dom-ids.js` + boot-time `validateDomIds()`.

### Wave 3 — Polish _(mostly mechanical)_

10. Add unit tests for `terrain-lod.js`, `tile-cache.js`, `app-state.js`,
    `camera-persistence.js`, `controls.js`.
11. Decide directory taxonomy: at minimum rename `placement/` → `services/`.
    Optionally rename `features/` + `overlays/` to `scene-layers/` +
    `terrain-shaders/` and split `roads.js`.
12. Extract `BinaryLoader` + `core/binary-registry.js`; refactor parsers
    one-by-one with byte-for-byte output comparison.
13. Extract `computeFadeRange`, `CellCuller`, `overlay-shaders.js`.
14. Add `playwright.config.ts`.
15. Add `?debug=1` perf instrumentation.

### Deliberately not recommended

- A feature-plugin framework — 10 features is not enough to justify framework
  weight.
- Collapsing per-system uniforms into a mega-object.
- Generalising the obstacles service into an event bus.
- Moving to a multi-instance viewer model.

Each of these would add framework weight without clear payoff at the current
scale.
