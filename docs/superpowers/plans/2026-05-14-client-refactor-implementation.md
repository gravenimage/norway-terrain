# Client Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the monolithic browser client out of `viewer.html` into focused ES modules with zero functional changes and explicit data contracts.

**Architecture:** Add browser regression coverage first, then move code through low-risk seams before touching shared state, terrain LOD, or the render loop. Keep shader formulas, shared uniform object identity, render order, asset paths, UI behavior, and data formats unchanged until the modular structure is proven.

**Tech Stack:** Browser-native ES modules, THREE.js loaded by `viewer.html`, Node test runner, Playwright for browser smoke/visual checks, existing Python tests run through `uv`.

---

## Scope and sequencing

This is a master implementation plan for a large refactor. Execute it as a series of small commits. Do not combine tasks unless the task explicitly says to do so. If a task uncovers a behavior difference, stop, keep the failing regression evidence, and fix that behavior before proceeding.

The target spec is `docs/superpowers/specs/2026-05-14-client-refactor-design.md`.

## File map

### New verification files

- `package.json`: Node scripts and Playwright development dependency.
- `tests-js/helpers/viewer-server.mjs`: Starts `uv run serve.py --no-browser` and returns the actual local viewer URL.
- `tests-js/helpers/viewer-page.mjs`: Browser helpers for loading the viewer, waiting for readiness, applying camera presets, and collecting console errors.
- `tests-js/viewer-smoke.test.mjs`: Browser smoke and UI interaction checks.
- `tests-js/viewer-visual.test.mjs`: Playwright screenshot baseline comparison for stable camera presets.

### New client module tree

- `src/client/core/constants.js`: Constants moved from `viewer.html`; no runtime side effects.
- `src/client/core/coordinates.js`: Centered world-coordinate and bounds helpers.
- `src/client/core/binary.js`: Binary reader and typed-array helpers.
- `src/client/core/shared-uniforms.js`: Factories for shared uniform objects; must preserve object identity.
- `src/client/core/app-state.js`: UI-controlled state boundary introduced after systems expose APIs.
- `src/client/terrain/tile-pyramid.js`: Tile key, tile bounds, and subdivision math.
- `src/client/terrain/tile-cache.js`: Tile fetch, texture cache, and LRU eviction.
- `src/client/terrain/terrain-mesh-pool.js`: Per-frame terrain mesh recycling.
- `src/client/terrain/terrain-lod.js`: Screen-space error, frustum tests, quadtree traversal, and tile drawing.
- `src/client/terrain/height-contract.js`: Height texture decode contract documentation and shader uniform names.
- `src/client/rendering/scene.js`: Renderer, scene, camera, controls, fog, lights, and base groups.
- `src/client/rendering/camera-persistence.js`: localStorage camera restore/save behavior.
- `src/client/rendering/frustum-culler.js`: Frustum construction and layer culling helpers.
- `src/client/rendering/material-factory.js`: Material creation from shader modules and shared uniforms.
- `src/client/rendering/render-loop.js`: Per-frame orchestration.
- `src/client/rendering/compass.js`: Compass scene/camera/rendering logic.
- `src/client/shaders/*.js`: Shader source strings moved verbatim.
- `src/client/overlays/roads.js`: OSM roads and town boundary loading/rendering.
- `src/client/overlays/geology.js`: Bedrock/quaternary raster loading, palette textures, bbox, and uniforms.
- `src/client/overlays/contours.js`: Contour uniform state around existing terrain shader logic.
- `src/client/overlays/faults.js`: Fault line loading/rendering.
- `src/client/overlays/identify.js`: Click-to-identify raycast and geology sampling panel.
- `src/client/features/geometry-builders.js`: Pure geometry builders.
- `src/client/features/buildings.js`: Buildings load, cells, material hooks, visibility, and culling.
- `src/client/features/forest.js`: Tree load, canopy interaction, LOD thresholds, and culling.
- `src/client/features/canopy.js`: Canopy carpet load and visibility state if split from forest.
- `src/client/features/water.js`: Water geometry and material integration.
- `src/client/features/amenities.js`: Amenity area and prop loading/rendering.
- `src/client/ui/controls.js`: DOM controls and state/system method wiring.
- `src/client/ui/hud.js`: HUD updates and counters.
- `src/client/init.js`: Bootstrap once all modules exist.
- `viewer.html`: Final thin entry point with unchanged DOM/CSS and module import.

---

## Task 1: Add browser smoke-test tooling

**Files:**
- Create: `package.json`
- Create: `tests-js/helpers/viewer-server.mjs`
- Create: `tests-js/helpers/viewer-page.mjs`
- Create: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Create `package.json`**

Create `package.json` with this exact content:

```json
{
  "name": "norway-terrain-viewer-tests",
  "private": true,
  "type": "module",
  "scripts": {
    "test:viewer": "node --test tests-js/viewer-smoke.test.mjs",
    "test:viewer:visual": "node --test tests-js/viewer-visual.test.mjs",
    "test:python": "uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q",
    "test": "npm run test:viewer && npm run test:python"
  },
  "devDependencies": {
    "@playwright/test": "^1.53.0",
    "playwright": "^1.53.0"
  }
}
```

- [ ] **Step 2: Install Node dependencies**

Run:

```powershell
npm install
npx playwright install chromium
```

Expected:

- `package-lock.json` is created.
- Chromium browser binaries are installed for Playwright.
- No source files are modified.

- [ ] **Step 3: Create the server helper**

Create `tests-js/helpers/viewer-server.mjs` with this exact content:

```javascript
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 45000;

export async function startViewerServer({ port = 8765, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const child = spawn('uv', ['run', 'serve.py', '--no-browser', '--port', String(port)], {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const cleanup = () => {
    if (!child.killed) {
      child.kill();
    }
  };

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting for serve.py. stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/viewer:\s+(http:\/\/localhost:\d+\/viewer\.html)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`serve.py exited before ready with code ${code}. stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
  });

  const viewerUrl = await ready;

  return {
    viewerUrl,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      cleanup();
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    },
  };
}
```

- [ ] **Step 4: Create browser page helpers**

Create `tests-js/helpers/viewer-page.mjs` with this exact content:

```javascript
import { chromium } from 'playwright';

export const VIEWER_PRESETS = {
  overview: {
    position: [25000, 18000, 18000],
    target: [0, 0, 0],
  },
  terrainClose: {
    position: [8000, 5000, 3500],
    target: [0, 0, 600],
  },
  geology: {
    position: [14000, -9000, 9000],
    target: [0, 0, 500],
  },
  forest: {
    position: [-8000, 12000, 7000],
    target: [0, 0, 500],
  },
};

export async function openViewer(viewerUrl) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const consoleMessages = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });

  page.on('pageerror', (error) => {
    consoleMessages.push({ type: 'pageerror', text: error.message });
  });

  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);

  return { browser, page, consoleMessages };
}

export async function waitForViewerReady(page) {
  await page.waitForFunction(() => {
    const viewer = window.__viewer;
    const hud = document.getElementById('hud');
    return Boolean(viewer?.camera && viewer?.scene && viewer?.renderer && hud);
  }, undefined, { timeout: 30000 });

  await page.waitForFunction(() => Number(document.getElementById('tcount')?.textContent || '0') > 0, undefined, {
    timeout: 30000,
  });
}

export async function applyPreset(page, preset) {
  await page.evaluate(({ position, target }) => {
    const { camera, controls } = window.__viewer;
    camera.position.set(position[0], position[1], position[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }, preset);

  await page.waitForTimeout(250);
}

export function unexpectedConsoleMessages(consoleMessages) {
  return consoleMessages.filter((message) => message.type === 'error' || message.type === 'pageerror');
}
```

- [ ] **Step 5: Create the smoke test**

Create `tests-js/viewer-smoke.test.mjs` with this exact content:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { startViewerServer } from './helpers/viewer-server.mjs';
import { openViewer, unexpectedConsoleMessages, VIEWER_PRESETS, applyPreset } from './helpers/viewer-page.mjs';

test('viewer loads, renders terrain, and exposes expected UI controls', async (t) => {
  const server = await startViewerServer();
  t.after(() => server.stop());

  const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);
  t.after(() => browser.close());

  await applyPreset(page, VIEWER_PRESETS.overview);

  const state = await page.evaluate(() => ({
    title: document.title,
    tileCount: Number(document.getElementById('tcount')?.textContent || '0'),
    cacheCount: Number(document.getElementById('ccount')?.textContent || '0'),
    fpsText: document.getElementById('fps')?.textContent || '',
    controls: [
      'exag',
      'sse',
      'seg',
      'showRoads',
      'showTowns',
      'showBld',
      'showTrees',
      'drape',
      'bldRange',
      'canopyRange',
      'canopyLod',
      'cb-bedrock',
      'cb-quat',
      'cb-faults',
      'r-geo-blend',
      'cb-contours',
      'contour-interval',
      'r-contour-opacity',
    ].map((id) => ({ id, exists: Boolean(document.getElementById(id)) })),
  }));

  assert.ok(state.title.length > 0, 'viewer should have a document title');
  assert.ok(state.tileCount > 0, 'terrain tiles should be drawn');
  assert.ok(state.cacheCount > 0, 'terrain tile cache should be populated');
  assert.match(state.fpsText, /^\d+$/, 'fps HUD should contain a number');
  assert.deepEqual(
    state.controls.filter((control) => !control.exists),
    [],
    'all expected controls should exist',
  );
  assert.deepEqual(unexpectedConsoleMessages(consoleMessages), [], 'viewer should not emit unexpected console errors');
});

test('core UI controls mutate the same visible state used by the monolith', async (t) => {
  const server = await startViewerServer({ port: 8785 });
  t.after(() => server.stop());

  const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);
  t.after(() => browser.close());

  await page.locator('#exag').evaluate((input) => {
    input.value = '2.0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#showRoads').uncheck();
  await page.locator('#showBld').uncheck();
  await page.locator('#showTrees').uncheck();
  await page.locator('#cb-contours').check();

  const state = await page.evaluate(() => ({
    exagLabel: document.getElementById('exagv')?.textContent,
    roadsChecked: document.getElementById('showRoads')?.checked,
    buildingsChecked: document.getElementById('showBld')?.checked,
    treesChecked: document.getElementById('showTrees')?.checked,
    contoursChecked: document.getElementById('cb-contours')?.checked,
  }));

  assert.equal(state.exagLabel, '2.00');
  assert.equal(state.roadsChecked, false);
  assert.equal(state.buildingsChecked, false);
  assert.equal(state.treesChecked, false);
  assert.equal(state.contoursChecked, true);
  assert.deepEqual(unexpectedConsoleMessages(consoleMessages), [], 'UI interactions should not emit unexpected console errors');
});
```

- [ ] **Step 6: Run the smoke test and Python tests**

Run:

```powershell
npm run test:viewer
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

Expected:

- The viewer smoke tests pass.
- Python tests report passing.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add package.json package-lock.json tests-js\helpers\viewer-server.mjs tests-js\helpers\viewer-page.mjs tests-js\viewer-smoke.test.mjs
git commit -m "Add viewer browser smoke tests" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Add visual baseline regression checks

**Files:**
- Create: `tests-js/viewer-visual.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create the visual test**

Create `tests-js/viewer-visual.test.mjs` with this exact content:

```javascript
import { test, expect } from '@playwright/test';
import { startViewerServer } from './helpers/viewer-server.mjs';
import { applyPreset, openViewer, unexpectedConsoleMessages, VIEWER_PRESETS } from './helpers/viewer-page.mjs';

for (const [name, preset] of Object.entries(VIEWER_PRESETS)) {
  test(`viewer visual baseline: ${name}`, async () => {
    const server = await startViewerServer({ port: 8800 + Object.keys(VIEWER_PRESETS).indexOf(name) });
    const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);

    try {
      await applyPreset(page, preset);
      await expect(page).toHaveScreenshot(`viewer-${name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
      expect(unexpectedConsoleMessages(consoleMessages)).toEqual([]);
    } finally {
      await browser.close();
      await server.stop();
    }
  });
}
```

- [ ] **Step 2: Update `package.json` visual test script**

Edit `package.json` so the scripts block is:

```json
"scripts": {
  "test:viewer": "node --test tests-js/viewer-smoke.test.mjs",
  "test:viewer:visual": "playwright test tests-js/viewer-visual.test.mjs",
  "test:python": "uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q",
  "test": "npm run test:viewer && npm run test:python"
}
```

- [ ] **Step 3: Create the initial visual baselines**

Run:

```powershell
npm run test:viewer
npx playwright test tests-js/viewer-visual.test.mjs --update-snapshots
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

Expected:

- Smoke tests pass.
- Visual baseline images are created under `tests-js\viewer-visual.test.mjs-snapshots`.
- Python tests pass.

- [ ] **Step 4: Commit Task 2**

Run:

```powershell
git add package.json tests-js\viewer-visual.test.mjs tests-js\viewer-visual.test.mjs-snapshots
git commit -m "Add viewer visual regression baselines" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Add module directories and data-contract documentation modules

**Files:**
- Create: `src/client/core/constants.js`
- Create: `src/client/core/coordinates.js`
- Create: `src/client/core/binary.js`
- Create: `src/client/terrain/height-contract.js`
- Create: `src/client/terrain/tile-pyramid.js`
- Test: `tests-js/client-contracts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `src/client/core/constants.js`**

Create the file with constants moved from `viewer.html`. Start with this exact content:

```javascript
export const ELEV_MAX = 1800;
export const CAMERA_STORAGE_KEY = 'norwayterrain.cam.v1';
export const DEFAULT_EXAGGERATION = 1.4;
export const DEFAULT_SSE_PX = 3;
export const DEFAULT_SEGMENTS = 64;
export const DEFAULT_DRAPE_OFFSET_METRES = 12;
export const DEFAULT_BUILDING_RANGE_KM = 22;
export const DEFAULT_CANOPY_RANGE_KM = 30;
export const DEFAULT_CANOPY_LOD_KM = 1.5;
export const TREE_CANOPY_FADE_WIDTH_METRES = 300;
```

- [ ] **Step 2: Create `src/client/core/coordinates.js`**

Create the file with this exact content:

```javascript
export function createWorldTransform(meta) {
  const rootX = meta.x0;
  const rootY = meta.y0;
  const rootSize = meta.size;
  const centerX = rootX + rootSize / 2;
  const centerY = rootY + rootSize / 2;

  return {
    rootX,
    rootY,
    rootSize,
    centerX,
    centerY,
    toCenteredX(worldX) {
      return worldX - centerX;
    },
    toCenteredY(worldY) {
      return worldY - centerY;
    },
    toWorldX(centeredX) {
      return centeredX + centerX;
    },
    toWorldY(centeredY) {
      return centeredY + centerY;
    },
  };
}
```

- [ ] **Step 3: Create `src/client/core/binary.js`**

Create the file with this exact content:

```javascript
export function readMagic(view, offset, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

export function assertMagic(view, expected, offset = 0) {
  const actual = readMagic(view, offset, expected.length);
  if (actual !== expected) {
    throw new Error(`Expected binary magic ${expected}, got ${actual}`);
  }
}

export function concatFloat32(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
```

- [ ] **Step 4: Create `src/client/terrain/height-contract.js`**

Create the file with this exact content:

```javascript
export const HEIGHT_TEXTURE_CONTRACT = Object.freeze({
  encoding: 'mapbox-rgb',
  units: 'metres',
  shaderSampleY: 'flipped',
  decodedRangeMetres: [-10000, 14835],
  uniforms: ['uHeight', 'uElevMax', 'uExag', 'uTile', 'uSeg'],
});
```

- [ ] **Step 5: Create `src/client/terrain/tile-pyramid.js`**

Create the file with this exact content:

```javascript
export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

export function tileUrl(z, x, y) {
  return `tiles/${z}/${x}/${y}.png`;
}

export function tileBounds(meta, z, x, y) {
  const size = meta.size / (2 ** z);
  const x0 = meta.x0 + x * size;
  const y0 = meta.y0 + y * size;
  return { x0, y0, x1: x0 + size, y1: y0 + size, size };
}
```

- [ ] **Step 6: Create contract tests**

Create `tests-js/client-contracts.test.mjs` with this exact content:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { concatFloat32, readMagic } from '../src/client/core/binary.js';
import { createWorldTransform } from '../src/client/core/coordinates.js';
import { HEIGHT_TEXTURE_CONTRACT } from '../src/client/terrain/height-contract.js';
import { tileBounds, tileKey, tileUrl } from '../src/client/terrain/tile-pyramid.js';

test('coordinate transform centers and restores world coordinates', () => {
  const transform = createWorldTransform({ x0: 1000, y0: 2000, size: 400 });

  assert.equal(transform.centerX, 1200);
  assert.equal(transform.centerY, 2200);
  assert.equal(transform.toCenteredX(1210), 10);
  assert.equal(transform.toCenteredY(2180), -20);
  assert.equal(transform.toWorldX(10), 1210);
  assert.equal(transform.toWorldY(-20), 2180);
});

test('tile pyramid helpers preserve z/x/y URL and bounds contracts', () => {
  const meta = { x0: 0, y0: 100, size: 64 };

  assert.equal(tileKey(2, 1, 3), '2/1/3');
  assert.equal(tileUrl(2, 1, 3), 'tiles/2/1/3.png');
  assert.deepEqual(tileBounds(meta, 2, 1, 3), { x0: 16, y0: 148, x1: 32, y1: 164, size: 16 });
});

test('binary helpers expose explicit magic and concat behavior', () => {
  const bytes = new Uint8Array([79, 83, 77, 50]);
  const view = new DataView(bytes.buffer);

  assert.equal(readMagic(view, 0, 4), 'OSM2');
  assert.deepEqual(Array.from(concatFloat32([new Float32Array([1, 2]), new Float32Array([3])])), [1, 2, 3]);
});

test('height contract documents the current shader assumptions', () => {
  assert.equal(HEIGHT_TEXTURE_CONTRACT.encoding, 'mapbox-rgb');
  assert.equal(HEIGHT_TEXTURE_CONTRACT.shaderSampleY, 'flipped');
  assert.deepEqual(HEIGHT_TEXTURE_CONTRACT.decodedRangeMetres, [-10000, 14835]);
  assert.ok(HEIGHT_TEXTURE_CONTRACT.uniforms.includes('uHeight'));
});
```

- [ ] **Step 7: Update `package.json` test script**

Edit the scripts block so `test:client` is included:

```json
"scripts": {
  "test:client": "node --test tests-js/client-contracts.test.mjs",
  "test:viewer": "node --test tests-js/viewer-smoke.test.mjs",
  "test:viewer:visual": "playwright test tests-js/viewer-visual.test.mjs",
  "test:python": "uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q",
  "test": "npm run test:client && npm run test:viewer && npm run test:python"
}
```

- [ ] **Step 8: Run tests**

Run:

```powershell
npm run test:client
npm run test:viewer
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

Expected:

- Client contract tests pass.
- Viewer smoke tests pass.
- Python tests pass.

- [ ] **Step 9: Commit Task 3**

Run:

```powershell
git add package.json src\client tests-js\client-contracts.test.mjs
git commit -m "Add client contract modules" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Replace duplicated constants and helpers in `viewer.html`

**Files:**
- Modify: `viewer.html`
- Modify: `src/client/core/constants.js`
- Modify: `src/client/core/coordinates.js`
- Modify: `src/client/terrain/tile-pyramid.js`
- Test: `tests-js/client-contracts.test.mjs`

- [ ] **Step 1: Add imports to the existing module script**

At the top of `viewer.html` inside `<script type="module">`, keep existing external imports and add:

```javascript
import {
  CAMERA_STORAGE_KEY,
  DEFAULT_BUILDING_RANGE_KM,
  DEFAULT_CANOPY_LOD_KM,
  DEFAULT_CANOPY_RANGE_KM,
  DEFAULT_DRAPE_OFFSET_METRES,
  DEFAULT_EXAGGERATION,
  DEFAULT_SEGMENTS,
  DEFAULT_SSE_PX,
  ELEV_MAX,
  TREE_CANOPY_FADE_WIDTH_METRES,
} from './src/client/core/constants.js';
import { createWorldTransform } from './src/client/core/coordinates.js';
import { tileBounds, tileKey, tileUrl } from './src/client/terrain/tile-pyramid.js';
```

- [ ] **Step 2: Replace duplicate constant declarations**

Remove the duplicate inline declarations that correspond to imported constants. Keep the variable names used by the monolith by assigning from imports:

```javascript
const CAM_STORAGE_KEY = CAMERA_STORAGE_KEY;
let EXAG = DEFAULT_EXAGGERATION;
let SSE_PX = DEFAULT_SSE_PX;
let SEG = DEFAULT_SEGMENTS;
let BLD_RANGE = DEFAULT_BUILDING_RANGE_KM * 1000;
let CANOPY_RANGE = DEFAULT_CANOPY_RANGE_KM * 1000;
let CANOPY_LOD_LO = DEFAULT_CANOPY_LOD_KM * 1000 - TREE_CANOPY_FADE_WIDTH_METRES;
let CANOPY_LOD_HI = DEFAULT_CANOPY_LOD_KM * 1000 + TREE_CANOPY_FADE_WIDTH_METRES;
```

- [ ] **Step 3: Replace inline coordinate center calculations**

After `meta` is loaded, replace direct center calculations with:

```javascript
const world = createWorldTransform(meta);
const ROOT_X = world.rootX;
const ROOT_Y = world.rootY;
const ROOT_SIZE = world.rootSize;
const CENTER_X = world.centerX;
const CENTER_Y = world.centerY;
```

- [ ] **Step 4: Replace tile helper implementations**

Where `viewer.html` defines local `key`, URL, or tile-bounds helpers, replace the function bodies with calls to imported helpers while keeping original function names for compatibility:

```javascript
function key(z, x, y) {
  return tileKey(z, x, y);
}

function tilePath(z, x, y) {
  return tileUrl(z, x, y);
}

function getTileBounds(z, x, y) {
  return tileBounds(meta, z, x, y);
}
```

If the existing function names differ, preserve the existing names and only replace their internals.

- [ ] **Step 5: Run tests**

Run:

~~~powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
~~~

Expected:

- All tests pass.
- Visual diffs are within the accepted baseline threshold.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
git add viewer.html src\client\core src\client\terrain tests-js\client-contracts.test.mjs
git commit -m "Use client contract helpers in viewer" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Extract geometry builders without changing call sites

**Files:**
- Modify: `src/client/features/geometry-builders.js`
- Modify: `viewer.html`
- Test: `tests-js/client-contracts.test.mjs`

- [ ] **Step 1: Create `src/client/features/geometry-builders.js` from existing declarations**

In `viewer.html`, find each geometry builder with these searches:

```powershell
Select-String -Path viewer.html -Pattern "function makeHouseGeometry|function makeTreeGeometry|function makeTreeBillboardGeometry|function build.*Geom" -Context 0,2
```

Create `src/client/features/geometry-builders.js` by moving each matching function declaration into the new file. Keep the JavaScript statements inside each function unchanged. Convert only the function declaration to an exported function:

```javascript
export function makeHouseGeometry(THREE) {
  const shape = new THREE.Shape();
  /* Keep the remaining statements exactly as they were in viewer.html. */
}
```

For amenity builders, export a registry with the exact existing function names:

```javascript
export const amenityGeometryBuilders = Object.freeze({
  buildBenchGeom,
  buildPicnicTableGeom,
  buildLighthouseGeom,
  buildWindmillGeom,
  buildPlaygroundGeom,
});
```

Only include names that exist in `viewer.html`; do not invent missing builders.

- [ ] **Step 2: Import builders back into `viewer.html`**

Add the import:

```javascript
import {
  amenityGeometryBuilders,
  makeHouseGeometry,
  makeTreeBillboardGeometry,
  makeTreeGeometry,
} from './src/client/features/geometry-builders.js';
```

Remove the moved function declarations from `viewer.html`. Keep every call site unchanged unless a builder name is now accessed through `amenityGeometryBuilders`.

- [ ] **Step 3: Add a syntax/import contract test**

Append this test to `tests-js/client-contracts.test.mjs`:

```javascript
test('geometry builder module exports expected factories', async () => {
  const builders = await import('../src/client/features/geometry-builders.js');

  assert.equal(typeof builders.makeHouseGeometry, 'function');
  assert.equal(typeof builders.makeTreeGeometry, 'function');
  assert.equal(typeof builders.makeTreeBillboardGeometry, 'function');
  assert.equal(typeof builders.amenityGeometryBuilders, 'object');
});
```

- [ ] **Step 4: Run tests**

Run:

~~~powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
~~~

- [ ] **Step 5: Commit Task 5**

Run:

```powershell
git add viewer.html src\client\features\geometry-builders.js tests-js\client-contracts.test.mjs
git commit -m "Extract client geometry builders" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Extract shader strings and material factories verbatim

**Files:**
- Create: `src/client/shaders/terrain-shader.js`
- Create: `src/client/shaders/building-shader.js`
- Create: `src/client/shaders/tree-shader.js`
- Create: `src/client/shaders/canopy-shader.js`
- Create: `src/client/shaders/water-shader.js`
- Create: `src/client/shaders/amenity-shader.js`
- Create: `src/client/rendering/material-factory.js`
- Modify: `viewer.html`
- Test: `tests-js/client-contracts.test.mjs`

- [ ] **Step 1: Create shader module files**

For each shader currently embedded in `viewer.html`, move the exact template string into the matching module. Use this export shape and put the moved GLSL inside the template literal without formatting changes:

```javascript
export const vertexShader = String.raw`
precision highp float;
`;
export const fragmentShader = String.raw`
precision highp float;
`;
```

For files with multiple shader pairs, use explicit names:

```javascript
export const treeVertexShader = String.raw`
precision highp float;
`;
export const treeFragmentShader = String.raw`
precision highp float;
`;
export const billboardVertexShader = String.raw`
precision highp float;
`;
export const billboardFragmentShader = String.raw`
precision highp float;
`;
```

The `precision highp float;` examples above show only the export shape. The implementation must contain the complete shader text moved from `viewer.html` in the same commit, not a shortened shader.

- [ ] **Step 2: Create `src/client/rendering/material-factory.js`**

Move existing material factory functions from `viewer.html` into this file. Use this export shape for each factory:

```javascript
export function createTerrainMaterial(THREE, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
  });
}
```

Preserve all existing material options such as `transparent`, `depthWrite`, `side`, `fog`, `extensions`, `defines`, and `renderOrder` behavior.

- [ ] **Step 3: Import shader-backed material factories in `viewer.html`**

Add imports from `material-factory.js` for each moved factory. Remove only the old factory declarations and shader strings. Keep the existing uniforms and material creation call order.

- [ ] **Step 4: Add material contract test**

Append this test to `tests-js/client-contracts.test.mjs`:

```javascript
test('shader modules expose non-empty GLSL source', async () => {
  const terrain = await import('../src/client/shaders/terrain-shader.js');

  assert.equal(typeof terrain.vertexShader, 'string');
  assert.equal(typeof terrain.fragmentShader, 'string');
  assert.ok(terrain.vertexShader.length > 100);
  assert.ok(terrain.fragmentShader.length > 1000);
  assert.ok(terrain.fragmentShader.includes('uHeight'));
  assert.ok(terrain.fragmentShader.includes('uExag'));
});
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

- [ ] **Step 6: Commit Task 6**

Run:

```powershell
git add viewer.html src\client\shaders src\client\rendering\material-factory.js tests-js\client-contracts.test.mjs
git commit -m "Extract viewer shader sources" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Extract binary parsers as pure modules

**Files:**
- Create: `src/client/overlays/roads.js`
- Create: `src/client/overlays/geology.js`
- Create: `src/client/overlays/faults.js`
- Create: `src/client/features/buildings.js`
- Create: `src/client/features/forest.js`
- Create: `src/client/features/canopy.js`
- Create: `src/client/features/water.js`
- Create: `src/client/features/amenities.js`
- Modify: `viewer.html`
- Test: `tests-js/client-contracts.test.mjs`

- [ ] **Step 1: Establish parser exports**

Each module should export a pure parser for the binary format it owns. Use this shape:

```javascript
export const BUILDING_CONTRACT = Object.freeze({
  magic: 'BLD1',
  units: 'metres',
  cellSizeMetres: 8000,
});

export function parseBuildingsBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, BUILDING_CONTRACT.magic);
  return parseExistingBuildingRecords(view);
}
```

Replace `parseExistingBuildingRecords` with the exact parsing loop moved from `viewer.html`.

- [ ] **Step 2: Keep THREE.js scene creation in `viewer.html` during this task**

Only move parsing and plain-data conversion. Leave mesh creation, material creation, scene group mutation, and UI updates in `viewer.html`.

- [ ] **Step 3: Wire `viewer.html` to the parser modules**

For each existing async data load:

```javascript
const buf = await (await fetch('buildings.bin')).arrayBuffer();
const parsed = parseBuildingsBuffer(buf);
```

Then feed `parsed` into the existing mesh-creation code. Preserve warning/error behavior from the existing `try`/`catch` blocks.

- [ ] **Step 4: Add parser export tests**

Append this test to `tests-js/client-contracts.test.mjs`:

```javascript
test('binary parser modules expose explicit contracts', async () => {
  const buildings = await import('../src/client/features/buildings.js');
  const roads = await import('../src/client/overlays/roads.js');
  const geology = await import('../src/client/overlays/geology.js');

  assert.equal(buildings.BUILDING_CONTRACT.magic, 'BLD1');
  assert.equal(typeof buildings.parseBuildingsBuffer, 'function');
  assert.ok(typeof roads.parseRoadsBuffer === 'function' || typeof roads.buildRoadOverlay === 'function');
  assert.ok(typeof geology.parseGeologyRasterBuffer === 'function' || typeof geology.loadGeologyRaster === 'function');
});
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

- [ ] **Step 6: Commit Task 7**

Run:

```powershell
git add viewer.html src\client\overlays src\client\features tests-js\client-contracts.test.mjs
git commit -m "Extract client binary parsers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Extract geology and identify systems

**Files:**
- Modify: `src/client/overlays/geology.js`
- Create: `src/client/overlays/identify.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Move geology raster load and sampling logic**

Move these existing responsibilities from `viewer.html` into `src/client/overlays/geology.js`:

- Bedrock raster loading.
- Quaternary raster loading.
- Palette texture creation.
- Geo bbox updates.
- Uniform toggles and opacity updates.
- Raster sampling used by identify.

Export this API:

```javascript
export function createGeologySystem({ THREE, geoUniforms, faultsGroup }) {
  return {
    async loadBedrock() {},
    async loadQuaternary() {},
    setBedrockVisible(visible) {},
    setQuaternaryVisible(visible) {},
    setOpacity(opacity) {},
    sampleAt(worldX, worldY) {},
  };
}
```

Fill each method with the existing logic moved from `viewer.html`. Preserve all uniform names.

- [ ] **Step 2: Move click-to-identify**

Create `src/client/overlays/identify.js` with this API:

```javascript
export function attachIdentifyHandlers({ canvas, camera, scene, geologySystem, showPanel }) {
  // Move the existing pointerdown/pointerup and identify behavior here.
}
```

Use the existing raycast and panel display logic. Keep the same click threshold and panel timeout.

- [ ] **Step 3: Wire `viewer.html`**

Replace the inline geology and identify blocks with:

```javascript
const geologySystem = createGeologySystem({ THREE, geoUniforms, faultsGroup });
geologySystem.loadBedrock();
geologySystem.loadQuaternary();
attachIdentifyHandlers({
  canvas: renderer.domElement,
  camera,
  scene,
  geologySystem,
  showPanel: showIdPanel,
});
```

Preserve the existing checkbox and blend-slider UI behavior by calling geology system methods from the existing handlers.

- [ ] **Step 4: Extend smoke test for geology controls**

Add this assertion block to `tests-js/viewer-smoke.test.mjs`:

```javascript
await page.locator('#cb-bedrock').check();
await page.locator('#cb-quat').check();
await page.locator('#r-geo-blend').evaluate((input) => {
  input.value = '0.35';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

const geologyUi = await page.evaluate(() => ({
  bedrock: document.getElementById('cb-bedrock').checked,
  quat: document.getElementById('cb-quat').checked,
  blend: document.getElementById('r-geo-blend-val').textContent,
}));

assert.deepEqual(geologyUi, { bedrock: true, quat: true, blend: '0.35' });
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\overlays\geology.js src\client\overlays\identify.js tests-js\viewer-smoke.test.mjs
git commit -m "Extract geology overlay system" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: Extract roads, towns, faults, and water systems

**Files:**
- Modify: `src/client/overlays/roads.js`
- Modify: `src/client/overlays/faults.js`
- Modify: `src/client/features/water.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Extract roads and town boundaries**

Move OSM loading, road grid texture creation, road-ready uniform updates, and town boundary group population into `src/client/overlays/roads.js`.

Export:

```javascript
export function createRoadSystem({ THREE, scene, roadUniforms, overlayUniforms, roadsGroup, townsGroup }) {
  return {
    async load() {},
    setRoadsVisible(visible) {},
    setTownsVisible(visible) {},
    setExaggeration(value) {},
    setDrapeOffset(value) {},
  };
}
```

- [ ] **Step 2: Extract faults**

Move faults binary loading and line segment creation into `src/client/overlays/faults.js`.

Export:

```javascript
export function createFaultSystem({ THREE, scene, faultsGroup }) {
  return {
    async load() {},
    setVisible(visible) {},
  };
}
```

- [ ] **Step 3: Extract water**

Move water binary loading, water material usage, cell mesh creation, and water group ownership into `src/client/features/water.js`.

Export:

```javascript
export function createWaterSystem({ THREE, scene, waterUniforms, waterMaterial }) {
  return {
    async load() {},
    setExaggeration(value) {},
  };
}
```

- [ ] **Step 4: Wire `viewer.html` handlers**

Replace direct road/town/fault/water mutations in UI handlers with system calls:

```javascript
document.getElementById('showRoads').onchange = (event) => roadSystem.setRoadsVisible(event.target.checked);
document.getElementById('showTowns').onchange = (event) => roadSystem.setTownsVisible(event.target.checked);
document.getElementById('cb-faults').addEventListener('change', (event) => faultSystem.setVisible(event.target.checked));
```

Keep the existing load calls fire-and-forget.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\overlays\roads.js src\client\overlays\faults.js src\client\features\water.js tests-js\viewer-smoke.test.mjs
git commit -m "Extract roads faults and water systems" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: Extract buildings, amenities, forest, and canopy systems

**Files:**
- Modify: `src/client/features/buildings.js`
- Modify: `src/client/features/amenities.js`
- Modify: `src/client/features/forest.js`
- Modify: `src/client/features/canopy.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Extract buildings**

Move building load, instance geometry creation, cells, group visibility, and `cullBuildings()` into `src/client/features/buildings.js`.

Export:

```javascript
export function createBuildingSystem({ THREE, scene, buildingsGroup, buildingUniforms, buildingMaterial }) {
  return {
    async load() {},
    cull({ camera, frustum, rangeMetres }) {},
    setVisible(visible) {},
    setRange(rangeMetres) {},
    setExaggeration(value) {},
  };
}
```

- [ ] **Step 2: Extract amenities**

Move amenities load, area meshes, prop meshes, and visibility relationship with buildings into `src/client/features/amenities.js`.

Export:

```javascript
export function createAmenitiesSystem({ THREE, scene, amenitiesGroup, amenityAreaUniforms, amenityPropUniforms }) {
  return {
    async load() {},
    setVisible(visible) {},
    setExaggeration(value) {},
  };
}
```

- [ ] **Step 3: Extract forest and canopy**

Move tree loading, canopy loading, LOD thresholds, visibility, and `cullForest()` into `src/client/features/forest.js` and `src/client/features/canopy.js`.

Export from `forest.js`:

```javascript
export function createForestSystem({ THREE, scene, treesGroup, canopyGroup, treeUniforms, canopyUniforms }) {
  return {
    async loadTrees() {},
    async loadCanopy() {},
    cull({ camera, frustum }) {},
    setVisible(visible) {},
    setRange(rangeMetres) {},
    setLodSwitch(loMetres, hiMetres) {},
    setExaggeration(value) {},
    updateForGeology({ bedrockVisible, quaternaryVisible }) {},
  };
}
```

- [ ] **Step 4: Wire culling and UI**

Replace calls in the render loop:

```javascript
buildingSystem.cull({ camera, frustum, rangeMetres: BLD_RANGE });
forestSystem.cull({ camera, frustum });
```

Replace visibility handlers:

```javascript
document.getElementById('showBld').onchange = (event) => {
  buildingSystem.setVisible(event.target.checked);
  amenitiesSystem.setVisible(event.target.checked);
};

document.getElementById('showTrees').onchange = (event) => {
  forestSystem.setVisible(event.target.checked);
  forestSystem.updateForGeology({
    bedrockVisible: Boolean(geoUniforms.uBedShow.value),
    quaternaryVisible: Boolean(geoUniforms.uQuatShow.value),
  });
};
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\features tests-js\viewer-smoke.test.mjs
git commit -m "Extract feature rendering systems" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: Centralize UI controls and state propagation

**Files:**
- Create: `src/client/core/app-state.js`
- Create: `src/client/ui/controls.js`
- Create: `src/client/ui/hud.js`
- Modify: `viewer.html`
- Test: `tests-js/client-contracts.test.mjs`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Create `src/client/core/app-state.js`**

Create this exact state container:

```javascript
export function createAppState(initialState) {
  const state = { ...initialState };
  const listeners = new Set();

  return {
    get(name) {
      return state[name];
    },
    set(name, value) {
      const previous = state[name];
      if (Object.is(previous, value)) {
        return;
      }
      state[name] = value;
      for (const listener of listeners) {
        listener({ name, previous, value });
      }
    },
    snapshot() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
```

- [ ] **Step 2: Create `src/client/ui/hud.js`**

Create:

```javascript
export function updateHud({ drawn, cacheSize }) {
  const tileCount = document.getElementById('tcount');
  const cacheCount = document.getElementById('ccount');
  if (tileCount) tileCount.textContent = String(drawn);
  if (cacheCount) cacheCount.textContent = String(cacheSize);
}

export function updateFps(fps) {
  const fpsEl = document.getElementById('fps');
  if (fpsEl) fpsEl.textContent = String(Math.round(fps));
}
```

- [ ] **Step 3: Create `src/client/ui/controls.js`**

Move every `getElementById(...).oninput` and `addEventListener('change', ...)` handler from `viewer.html` into:

```javascript
export function attachControls({ appState, systems, uniforms, rebuildPlane }) {
  const exagEl = document.getElementById('exag');
  exagEl.oninput = () => {
    appState.set('exag', Number(exagEl.value));
  };

  appState.subscribe(({ name, value }) => {
    if (name === 'exag') {
      document.getElementById('exagv').textContent = value.toFixed(2);
      uniforms.overlayUniforms.uExag.value = value;
      uniforms.buildingUniforms.uExag.value = value;
      uniforms.treeUniforms.uExag.value = value;
      uniforms.canopyUniforms.uExag.value = value;
      uniforms.waterUniforms.uExag.value = value;
      uniforms.amenityAreaUniforms.uExag.value = value;
      uniforms.amenityPropUniforms.uExag.value = value;
      systems.roads.setExaggeration(value);
      systems.buildings.setExaggeration(value);
      systems.amenities.setExaggeration(value);
      systems.forest.setExaggeration(value);
      systems.water.setExaggeration(value);
    }
  });
}
```

Then add the rest of the existing handlers into the same function. Preserve labels, numeric conversions, and side effects.

- [ ] **Step 4: Wire `viewer.html` to `attachControls`**

Create app state with current defaults:

```javascript
const appState = createAppState({
  exag: EXAG,
  ssePx: SSE_PX,
  seg: SEG,
  buildingRange: BLD_RANGE,
  canopyRange: CANOPY_RANGE,
  canopyLodLo: CANOPY_LOD_LO,
  canopyLodHi: CANOPY_LOD_HI,
});

attachControls({
  appState,
  systems: { roads: roadSystem, buildings: buildingSystem, amenities: amenitiesSystem, forest: forestSystem, water: waterSystem, geology: geologySystem, faults: faultSystem },
  uniforms: { overlayUniforms, buildingUniforms, treeUniforms, canopyUniforms, waterUniforms, amenityAreaUniforms, amenityPropUniforms },
  rebuildPlane,
});
```

- [ ] **Step 5: Add app-state test**

Append to `tests-js/client-contracts.test.mjs`:

```javascript
test('app state notifies subscribers only when values change', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const appState = createAppState({ exag: 1.4 });
  const changes = [];

  appState.subscribe((change) => changes.push(change));
  appState.set('exag', 2);
  appState.set('exag', 2);

  assert.deepEqual(appState.snapshot(), { exag: 2 });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { name: 'exag', previous: 1.4, value: 2 });
});
```

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\core\app-state.js src\client\ui tests-js
git commit -m "Centralize viewer UI controls" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 12: Extract scene setup, camera persistence, and compass

**Files:**
- Create: `src/client/rendering/scene.js`
- Create: `src/client/rendering/camera-persistence.js`
- Create: `src/client/rendering/compass.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Extract camera persistence**

Create `camera-persistence.js`:

```javascript
export function restoreCamera({ camera, controls, storageKey }) {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return false;
  const saved = JSON.parse(raw);
  camera.position.set(saved.position[0], saved.position[1], saved.position[2]);
  controls.target.set(saved.target[0], saved.target[1], saved.target[2]);
  controls.update();
  return true;
}

export function saveCamera({ camera, controls, storageKey }) {
  localStorage.setItem(storageKey, JSON.stringify({
    position: camera.position.toArray(),
    target: controls.target.toArray(),
  }));
}
```

If the existing saved JSON field names differ, preserve the existing field names instead.

- [ ] **Step 2: Extract scene setup**

Move renderer, scene, camera, controls, fog, lights, base groups, and resize handling into `scene.js`.

Export:

```javascript
export function createViewerScene({ THREE, MapControls, canvas, meta }) {
  return {
    scene,
    camera,
    controls,
    renderer,
    groups,
    resize() {},
  };
}
```

Fill the function with the existing setup code from `viewer.html`.

- [ ] **Step 3: Extract compass**

Move compass scene/camera setup and `renderCompass()` into `compass.js`.

Export:

```javascript
export function createCompass({ THREE, renderer, camera }) {
  return {
    render() {},
  };
}
```

- [ ] **Step 4: Wire `viewer.html`**

Replace inline setup with:

```javascript
const viewerScene = createViewerScene({ THREE, MapControls, canvas: document.querySelector('canvas'), meta });
const { scene, camera, controls, renderer, groups } = viewerScene;
const compass = createCompass({ THREE, renderer, camera });
```

Keep `window.__viewer = { camera, controls, renderer, scene };`.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\rendering\scene.js src\client\rendering\camera-persistence.js src\client\rendering\compass.js tests-js
git commit -m "Extract viewer scene setup" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 13: Extract terrain tile cache, mesh pool, LOD traversal, and render loop

**Files:**
- Create: `src/client/terrain/tile-cache.js`
- Create: `src/client/terrain/terrain-mesh-pool.js`
- Create: `src/client/terrain/terrain-lod.js`
- Create: `src/client/rendering/frustum-culler.js`
- Create: `src/client/rendering/render-loop.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`

- [ ] **Step 1: Extract tile cache**

Move `getTile()` and `evictCache()` into `tile-cache.js`.

Export:

```javascript
export function createTileCache({ THREE, maxEntries }) {
  const tileCache = new Map();
  return {
    tileCache,
    async getTile(z, x, y) {},
    evict() {},
    size() {
      return tileCache.size;
    },
  };
}
```

Fill `getTile` and `evict` with the existing logic from `viewer.html`.

- [ ] **Step 2: Extract mesh pool**

Move `meshPool`, `meshUsed`, `acquireMesh()`, `recycleMeshes()`, and geometry update behavior into `terrain-mesh-pool.js`.

Export:

```javascript
export function createTerrainMeshPool({ THREE, scene, makeMaterial, initialGeometry }) {
  return {
    acquire() {},
    recycleAll() {},
    setGeometry(geometry) {},
    usedCount() {},
  };
}
```

Preserve the per-frame remove-from-scene and return-to-pool lifecycle.

- [ ] **Step 3: Extract frustum culler**

Create:

```javascript
export function createFrustumCuller(THREE) {
  const frustum = new THREE.Frustum();
  const matrix = new THREE.Matrix4();
  return {
    frustum,
    update(camera) {
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(matrix);
    },
  };
}
```

If the existing code uses a different matrix object or update expression, preserve the existing expression.

- [ ] **Step 4: Extract terrain LOD traversal**

Move `visit()`, `drawTile()`, projected-size calculation, tile bounds/frustum helpers, and `rebuildPlane()` into `terrain-lod.js`.

Export:

```javascript
export function createTerrainLodRenderer(dependencies) {
  return {
    visitRoot() {},
    rebuildPlane(seg) {},
    getDrawnCount() {},
  };
}
```

Dependencies should include `meta`, `camera`, `frustum`, `tileCache`, `meshPool`, shared uniforms, and current SSE/segment state. Keep the recursion order unchanged.

- [ ] **Step 5: Extract render loop**

Move `loop()` into `render-loop.js`.

Export:

```javascript
export function startRenderLoop({ controls, camera, culler, terrain, systems, tileCache, renderer, scene, compass, hud }) {
  function loop() {
    requestAnimationFrame(loop);
    controls.update();
    terrain.recycleMeshes();
    camera.updateMatrixWorld();
    culler.update(camera);
    terrain.visitRoot();
    systems.buildings.cull({ camera, frustum: culler.frustum });
    systems.forest.cull({ camera, frustum: culler.frustum });
    tileCache.evict();
    renderer.render(scene, camera);
    compass.render();
    hud.update();
  }
  loop();
}
```

Use the existing code's exact culling arguments and HUD update logic rather than the simplified parameter names above.

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git add viewer.html src\client\terrain src\client\rendering tests-js
git commit -m "Extract terrain render loop" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 14: Create `src/client/init.js` and thin `viewer.html`

**Files:**
- Create: `src/client/init.js`
- Modify: `viewer.html`
- Test: `tests-js/viewer-smoke.test.mjs`
- Test: `tests-js/viewer-visual.test.mjs`

- [ ] **Step 1: Create `src/client/init.js`**

Move the remaining top-level module JavaScript from `viewer.html` into:

```javascript
export async function initializeViewer({ THREE, MapControls }) {
  // Existing top-level initialization code moved from viewer.html.
}
```

The function must:

- Fetch `tiles/meta.json`.
- Create the scene and systems.
- Start async layer loads.
- Attach UI controls.
- Start the render loop.
- Set `window.__viewer` with the same exposed fields as before.

- [ ] **Step 2: Replace inline module code in `viewer.html`**

Leave HTML and CSS unchanged. Replace the large inline script body with:

```html
<script type="module">
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { MapControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/MapControls.js';
import { initializeViewer } from './src/client/init.js';

initializeViewer({ THREE, MapControls });
</script>
```

If the existing THREE.js version differs, keep the existing URL and version.

- [ ] **Step 3: Run full verification**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

Expected:

- All client contract tests pass.
- Viewer smoke tests pass.
- Visual baselines pass.
- Python tests pass.

- [ ] **Step 4: Check `viewer.html` size**

Run:

```powershell
(Get-Content viewer.html).Count
```

Expected:

- `viewer.html` is substantially smaller than 2,879 lines.
- The file still contains the existing DOM and CSS.

- [ ] **Step 5: Commit Task 14**

Run:

```powershell
git add viewer.html src\client\init.js
git commit -m "Thin viewer entry point" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 15: Final documentation and verification report

**Files:**
- Create: `docs/client-architecture.md`
- Create: `docs/client-regression-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Create architecture documentation**

Create `docs/client-architecture.md`:

```markdown
# Client Architecture

The browser client starts in `viewer.html`, imports `src/client/init.js`, and initializes browser-native ES modules under `src/client/`.

## Module ownership

- `core/`: constants, binary helpers, coordinate transforms, and UI-controlled app state.
- `terrain/`: tile pyramid math, height texture contracts, tile cache, mesh pool, and LOD traversal.
- `rendering/`: scene setup, camera persistence, frustum updates, material factories, render loop, and compass.
- `shaders/`: shader source strings moved from the original viewer without formula changes.
- `overlays/`: roads, geology, contours, faults, and click-to-identify.
- `features/`: buildings, forest/canopy, water, amenities, and geometry builders.
- `ui/`: DOM controls and HUD updates.

## Preserved contracts

- Height texture sampling keeps the original Y-flip behavior.
- Geology raster sampling keeps the original no-flip behavior.
- Shared uniforms are passed by reference.
- Terrain meshes are recycled each frame before quadtree traversal.
- Render-loop order remains controls, recycle, frustum, terrain, feature culling, cache eviction, render, compass.
- UI controls preserve the original labels, ranges, and side effects.
```

- [ ] **Step 2: Create regression checklist**

Create `docs/client-regression-checklist.md`:

```markdown
# Client Regression Checklist

Run before merging client refactors:

~~~powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
~~~

Manual browser checks:

- Page loads `viewer.html` with no unexpected console errors.
- Terrain renders and tile/cache counters increase.
- Exaggeration, SSE, segment, drape, building range, canopy range, and canopy LOD controls work.
- Roads, kommune boundaries, buildings, forest/trees, bedrock, quaternary, faults, and contours toggle correctly.
- Geology blend and contour opacity controls update labels and visuals.
- Camera position persists after refresh.
- Click-to-identify shows bedrock/quaternary information when rasters are loaded.
- Visual output matches the stored Playwright baselines within threshold.
```

- [ ] **Step 3: Update `README.md`**

Add a concise section:

```markdown
## Client development

The browser client is split into ES modules under `src/client/` and is bootstrapped by `viewer.html`.

Useful checks:

~~~powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
~~~

Use `docs/client-architecture.md` for module ownership and `docs/client-regression-checklist.md` before merging viewer changes.
```

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
git --no-pager status --short
```

Expected:

- All tests pass.
- Git status shows only intended documentation changes.

- [ ] **Step 5: Commit Task 15**

Run:

```powershell
git add README.md docs\client-architecture.md docs\client-regression-checklist.md
git commit -m "Document client module architecture" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final review gate

- [ ] Run:

```powershell
git --no-pager log --oneline main..HEAD
npm run test:client
npm run test:viewer
npm run test:viewer:visual
uv run --with pytest --with numpy --with rasterio --with pyproj --with requests --with shapely --with mapbox-earcut pytest -q
```

- [ ] Confirm `viewer.html` still serves the same URL and data asset paths.
- [ ] Confirm every commit is individually meaningful and revertible.
- [ ] Confirm there are no unrelated changes outside client/tests/docs/package files.
- [ ] Request code review before merging.
