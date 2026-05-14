import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('geometry builder module exports expected factories', async () => {
  // Node cannot resolve the browser import-map specifier 'three', so verify the module contract textually.
  const source = await readFile(new URL('../src/client/features/geometry-builders.js', import.meta.url), 'utf8');

  assert.match(source, /export function makeHouseGeometry\s*\(/);
  assert.match(source, /export function makeTreeGeometry\s*\(/);
  assert.match(source, /export function makeTreeBillboardGeometry\s*\(/);
  assert.match(source, /export const amenityGeometryBuilders\s*=\s*Object\.freeze\s*\(/);
});

test('shader modules expose non-empty GLSL source', async () => {
  const terrain = await import('../src/client/shaders/terrain-shader.js');

  assert.equal(typeof terrain.vertexShader, 'string');
  assert.equal(typeof terrain.fragmentShader, 'string');
  assert.ok(terrain.vertexShader.length > 100);
  assert.ok(terrain.fragmentShader.length > 1000);
  assert.ok(terrain.fragmentShader.includes('uHeight'));
  assert.ok(terrain.fragmentShader.includes('uExag'));
});

test('binary parser modules expose explicit contracts', async () => {
  const buildings = await import('../src/client/features/buildings.js');
  const forest = await import('../src/client/features/forest.js');
  const canopy = await import('../src/client/features/canopy.js');
  const water = await import('../src/client/features/water.js');
  const amenities = await import('../src/client/features/amenities.js');
  const roads = await import('../src/client/overlays/roads.js');
  const geology = await import('../src/client/overlays/geology.js');
  const faults = await import('../src/client/overlays/faults.js');

  // Magic strings mirror the binary headers checked inline by viewer.html before parser extraction.
  assert.equal(buildings.BUILDING_CONTRACT.magic, 'BLD1');
  assert.equal(forest.FOREST_CONTRACT.magic[0], 'TRE1');
  assert.equal(forest.FOREST_CONTRACT.magic[1], 'TRE2');
  assert.equal(canopy.CANOPY_CONTRACT.magic, 'CANO');
  assert.equal(water.WATER_CONTRACT.magic, 'WATR');
  assert.equal(amenities.AMENITIES_CONTRACT.magic, 'AMN1');
  assert.equal(roads.ROAD_CONTRACT.magic, 'OSM2');
  assert.equal(geology.GEOLOGY_RASTER_CONTRACT.bedrockMagic, 'BRR1');
  assert.equal(geology.GEOLOGY_RASTER_CONTRACT.quaternaryMagic, 'QRR1');
  assert.equal(faults.FAULT_CONTRACT.magic, 'FLT1');

  // Function names document the pure parser API consumed by viewer.html.
  assert.equal(typeof buildings.parseBuildingsBuffer, 'function');
  assert.equal(typeof buildings.createBuildingSystem, 'function');
  assert.equal(typeof forest.parseForestBuffer, 'function');
  assert.equal(typeof forest.createForestSystem, 'function');
  assert.equal(typeof canopy.parseCanopyBuffer, 'function');
  assert.equal(typeof water.parseWaterBuffer, 'function');
  assert.equal(typeof water.createWaterSystem, 'function');
  assert.equal(typeof amenities.parseAmenitiesBuffer, 'function');
  assert.equal(typeof amenities.createAmenitiesSystem, 'function');
  assert.equal(typeof roads.parseRoadsBuffer, 'function');
  assert.equal(typeof roads.createRoadSystem, 'function');
  assert.equal(typeof geology.parseGeologyRasterBuffer, 'function');
  assert.equal(typeof geology.createGeologySystem, 'function');
  assert.equal(typeof faults.parseFaultsBuffer, 'function');
  assert.equal(typeof faults.createFaultSystem, 'function');
});

test('road system exposes stateful overlay API and mutates shared uniforms and groups', async () => {
  const { createRoadSystem } = await import('../src/client/overlays/roads.js');
  const roadUniforms = { uRoadShow: { value: 1.0 } };
  const overlayUniforms = { uExag: { value: 1.4 }, uOffset: { value: 12.0 } };
  const townsGroup = { visible: true };
  const roadsGroup = { visible: true };

  const system = createRoadSystem({
    THREE: {},
    scene: {},
    roadUniforms,
    overlayUniforms,
    roadsGroup,
    townsGroup,
  });

  assert.deepEqual(Object.keys(system).sort(), [
    'load',
    'setDrapeOffset',
    'setExaggeration',
    'setRoadsVisible',
    'setTownsVisible',
  ]);
  system.setRoadsVisible(false);
  system.setTownsVisible(false);
  system.setExaggeration(2.0);
  system.setDrapeOffset(8.5);

  assert.equal(roadUniforms.uRoadShow.value, 0.0);
  assert.equal(roadsGroup.visible, false);
  assert.equal(townsGroup.visible, false);
  assert.equal(overlayUniforms.uExag.value, 2.0);
  assert.equal(overlayUniforms.uOffset.value, 8.5);
});

test('fault system exposes stateful overlay API and mutates group visibility', async () => {
  const { createFaultSystem } = await import('../src/client/overlays/faults.js');
  const faultsGroup = { visible: false };
  const system = createFaultSystem({ THREE: {}, scene: {}, faultsGroup });

  assert.deepEqual(Object.keys(system).sort(), ['load', 'setVisible']);
  system.setVisible(true);
  assert.equal(faultsGroup.visible, true);
  system.setVisible(false);
  assert.equal(faultsGroup.visible, false);
});

test('water system exposes stateful overlay API and mutates shared uniforms', async () => {
  const { createWaterSystem } = await import('../src/client/features/water.js');
  const waterUniforms = { uExag: { value: 1.4 } };
  const system = createWaterSystem({ THREE: {}, scene: {}, waterUniforms, waterMaterial: {} });

  assert.deepEqual(Object.keys(system).sort(), ['load', 'setExaggeration']);
  system.setExaggeration(2.25);
  assert.equal(waterUniforms.uExag.value, 2.25);
});

test('building system exposes stateful API and mutates shared uniforms and group visibility', async () => {
  const { createBuildingSystem } = await import('../src/client/features/buildings.js');
  const buildingsGroup = { visible: true, add() {} };
  const buildingUniforms = { uExag: { value: 1.4 }, uFadeFar: { value: 22000 }, uFadeNear: { value: 18000 } };
  const system = createBuildingSystem({ THREE: {}, scene: {}, buildingsGroup, buildingUniforms, buildingMaterial: {} });

  assert.deepEqual(Object.keys(system).sort(), ['cull', 'load', 'setExaggeration', 'setRange', 'setVisible']);
  system.setVisible(false);
  system.setExaggeration(2.1);
  system.setRange(10000);

  assert.equal(buildingsGroup.visible, false);
  assert.equal(buildingUniforms.uExag.value, 2.1);
  assert.equal(buildingUniforms.uFadeFar.value, 10000);
  assert.equal(buildingUniforms.uFadeNear.value, 7000);
});

test('amenities system exposes stateful API and mutates shared uniforms and group visibility', async () => {
  const { createAmenitiesSystem } = await import('../src/client/features/amenities.js');
  const amenitiesGroup = { visible: true, add() {} };
  const amenityAreaUniforms = { uExag: { value: 1.4 } };
  const amenityPropUniforms = { uExag: { value: 1.4 } };
  const system = createAmenitiesSystem({ THREE: {}, scene: {}, amenitiesGroup, amenityAreaUniforms, amenityPropUniforms });

  assert.deepEqual(Object.keys(system).sort(), ['load', 'setExaggeration', 'setVisible']);
  system.setVisible(false);
  system.setExaggeration(1.75);

  assert.equal(amenitiesGroup.visible, false);
  assert.equal(amenityAreaUniforms.uExag.value, 1.75);
  assert.equal(amenityPropUniforms.uExag.value, 1.75);
});

test('forest system exposes stateful API and coordinates tree and canopy visibility', async () => {
  const { createForestSystem } = await import('../src/client/features/forest.js');
  const treesGroup = { visible: true, add() {} };
  const canopyGroup = { visible: true, add() {} };
  const treeUniforms = { uExag: { value: 1.4 }, uFadeNear: { value: 1200 }, uFadeFar: { value: 1800 } };
  const canopyUniforms = {
    uExag: { value: 1.4 },
    uFadeNear: { value: 1200 },
    uFadeFar: { value: 1800 },
    uRangeNear: { value: 28000 },
    uRangeFar: { value: 30000 },
  };
  const system = createForestSystem({ THREE: {}, scene: {}, treesGroup, canopyGroup, treeUniforms, canopyUniforms });

  assert.deepEqual(Object.keys(system).sort(), [
    'cull',
    'loadCanopy',
    'loadTrees',
    'setExaggeration',
    'setLodSwitch',
    'setRange',
    'setVisible',
    'updateForGeology',
  ]);
  system.setVisible(false);
  assert.equal(treesGroup.visible, false);
  assert.equal(canopyGroup.visible, false);

  system.setVisible(true);
  system.updateForGeology({ bedrockVisible: true, quaternaryVisible: false });
  assert.equal(treesGroup.visible, false);
  assert.equal(canopyGroup.visible, false);

  system.updateForGeology({ bedrockVisible: false, quaternaryVisible: false });
  system.setExaggeration(2.5);
  system.setRange(15000);
  system.setLodSwitch(900, 1500);

  assert.equal(treesGroup.visible, true);
  assert.equal(canopyGroup.visible, true);
  assert.equal(treeUniforms.uExag.value, 2.5);
  assert.equal(canopyUniforms.uExag.value, 2.5);
  assert.equal(canopyUniforms.uRangeFar.value, 15000);
  assert.equal(canopyUniforms.uRangeNear.value, 13000);
  assert.equal(treeUniforms.uFadeNear.value, 900);
  assert.equal(treeUniforms.uFadeFar.value, 1500);
  assert.equal(canopyUniforms.uFadeNear.value, 900);
  assert.equal(canopyUniforms.uFadeFar.value, 1500);
});

test('geology system exposes stateful overlay API and mutates shared uniforms', async () => {
  const { createGeologySystem } = await import('../src/client/overlays/geology.js');
  const geoUniforms = {
    uBedShow: { value: 0.0 },
    uQuatShow: { value: 0.0 },
    uGeoOpacity: { value: 0.6 },
  };

  const system = createGeologySystem({ THREE: {}, geoUniforms, faultsGroup: { visible: false } });

  assert.deepEqual(Object.keys(system).sort(), [
    'loadBedrock',
    'loadQuaternary',
    'sampleAt',
    'setBedrockVisible',
    'setOpacity',
    'setQuaternaryVisible',
  ]);
  system.setBedrockVisible(true);
  system.setQuaternaryVisible(true);
  system.setOpacity(0.35);

  assert.equal(geoUniforms.uBedShow.value, 1.0);
  assert.equal(geoUniforms.uQuatShow.value, 1.0);
  assert.equal(geoUniforms.uGeoOpacity.value, 0.35);
  assert.deepEqual(system.sampleAt(0, 0), {});

  system.setBedrockVisible(false);
  system.setQuaternaryVisible(false);
  assert.equal(system.sampleAt(0, 0), null);
});

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

test('camera persistence preserves the existing p/t localStorage shape', async () => {
  const { restoreCamera, saveCamera } = await import('../src/client/rendering/camera-persistence.js');
  const writes = new Map();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) { return writes.get(key) ?? null; },
    setItem(key, value) { writes.set(key, value); },
  };

  try {
    const camera = { position: vectorStub([1, 2, 3]), updateMatrixWorldCalled: false, updateMatrixWorld() { this.updateMatrixWorldCalled = true; } };
    const controls = { target: vectorStub([4, 5, 6]), updateCalled: false, update() { this.updateCalled = true; } };

    saveCamera({ camera, controls, storageKey: 'viewer-camera' });
    assert.deepEqual(JSON.parse(writes.get('viewer-camera')), { p: [1, 2, 3], t: [4, 5, 6] });

    writes.set('viewer-camera', JSON.stringify({ p: [7, 8, 9], t: [10, 11, 12] }));
    assert.equal(restoreCamera({ camera, controls, storageKey: 'viewer-camera' }), true);
    assert.deepEqual(camera.position.values, [7, 8, 9]);
    assert.deepEqual(controls.target.values, [10, 11, 12]);
    assert.equal(camera.updateMatrixWorldCalled, true);
    assert.equal(controls.updateCalled, true);

    writes.set('viewer-camera', JSON.stringify({ position: [1, 2, 3], target: [4, 5, 6] }));
    assert.equal(restoreCamera({ camera, controls, storageKey: 'viewer-camera' }), false);
  } finally {
    globalThis.localStorage = previousLocalStorage;
  }
});

test('viewer scene factory preserves camera, renderer, controls, fog, and groups setup', async () => {
  const { createViewerScene } = await import('../src/client/rendering/scene.js');
  const previousWindow = globalThis.window;
  const previousInnerWidth = globalThis.innerWidth;
  const previousInnerHeight = globalThis.innerHeight;
  globalThis.window = { devicePixelRatio: 3, innerWidth: 800, innerHeight: 600 };
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;

  try {
    const THREE = createThreeStub();
    class MapControls {
      constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.target = new THREE.Vector3();
      }
      update() { this.updated = true; }
      addEventListener() {}
    }

    const canvas = { tagName: 'CANVAS' };
    const viewerScene = createViewerScene({ THREE, MapControls, canvas, meta: { size: 1000 } });

    assert.equal(viewerScene.camera.fov, 55);
    assert.equal(viewerScene.camera.near, 50);
    assert.equal(viewerScene.camera.far, 4000);
    assert.deepEqual(viewerScene.camera.position.values, [0, -120000, 90000]);
    assert.equal(viewerScene.renderer.pixelRatio, 2);
    assert.deepEqual(viewerScene.renderer.size, [800, 600]);
    assert.equal(viewerScene.renderer.outputColorSpace, 'srgb');
    assert.equal(viewerScene.scene.background.hex, 0x0c1322);
    assert.deepEqual([viewerScene.scene.fog.near, viewerScene.scene.fog.far], [500, 1600]);
    assert.equal(viewerScene.controls.enableDamping, true);
    assert.equal(viewerScene.controls.dampingFactor, 0.08);
    assert.deepEqual(Object.keys(viewerScene.groups).sort(), [
      'amenitiesGroup',
      'buildingsGroup',
      'canopyGroup',
      'faultsGroup',
      'roadsGroup',
      'townsGroup',
      'treesGroup',
      'water',
    ]);
    assert.equal(viewerScene.groups.faultsGroup.visible, false);

    globalThis.window.innerWidth = 1024;
    globalThis.window.innerHeight = 768;
    globalThis.innerWidth = 1024;
    globalThis.innerHeight = 768;
    viewerScene.resize();
    assert.equal(viewerScene.camera.aspect, 1024 / 768);
    assert.deepEqual(viewerScene.renderer.size, [1024, 768]);
    assert.equal(viewerScene.camera.projectionUpdated, true);
  } finally {
    globalThis.window = previousWindow;
    globalThis.innerWidth = previousInnerWidth;
    globalThis.innerHeight = previousInnerHeight;
  }
});

test('compass factory preserves viewport rendering and camera orientation sync', async () => {
  const { createCompass } = await import('../src/client/rendering/compass.js');
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1024, innerHeight: 768 };
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      return { width: 0, height: 0, getContext: () => ({ clearRect() {}, fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', textBaseline: '', strokeText() {}, fillText() {} }) };
    },
  };

  try {
    const calls = [];
    const THREE = createThreeStub();
    const renderer = {
      autoClear: true,
      setScissorTest(value) { calls.push(['setScissorTest', value]); },
      setViewport(...args) { calls.push(['setViewport', ...args]); },
      setScissor(...args) { calls.push(['setScissor', ...args]); },
      clearDepth() { calls.push(['clearDepth']); },
      render(scene, camera) { calls.push(['render', scene.type, camera.fov]); },
    };
    const camera = { quaternion: { marker: 'main' } };

    const compass = createCompass({ THREE, renderer, camera });
    compass.render();

    assert.equal(renderer.autoClear, true);
    assert.deepEqual(calls, [
      ['setScissorTest', true],
      ['setViewport', 16, 16, 140, 140],
      ['setScissor', 16, 16, 140, 140],
      ['clearDepth'],
      ['render', 'Scene', 35],
      ['setScissorTest', false],
      ['setViewport', 0, 0, globalThis.window.innerWidth, globalThis.window.innerHeight],
    ]);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('tile cache module exports createTileCache with LRU eviction and getTile', async () => {
  const source = await readFile(new URL('../src/client/terrain/tile-cache.js', import.meta.url), 'utf8');
  assert.match(source, /export function createTileCache/);
  assert.match(source, /getTile/);
  assert.match(source, /evict/);
  assert.match(source, /MAX_CACHE|maxEntries/);
  assert.match(source, /lastUsed/);
  assert.match(source, /\.sort\(/);
  assert.match(source, /tileUrl/);
  assert.match(source, /TextureLoader/);
});

test('terrain mesh pool module exports createTerrainMeshPool with acquire/recycleAll/setGeometry', async () => {
  const source = await readFile(new URL('../src/client/terrain/terrain-mesh-pool.js', import.meta.url), 'utf8');
  assert.match(source, /export function createTerrainMeshPool/);
  assert.match(source, /acquire/);
  assert.match(source, /recycleAll/);
  assert.match(source, /setGeometry/);
  assert.match(source, /usedCount/);
  assert.match(source, /scene\.add/);
  assert.match(source, /scene\.remove/);
  assert.match(source, /frustumCulled\s*=\s*false/);
});

test('frustum culler module exports createFrustumCuller preserving matrix update expression', async () => {
  const source = await readFile(new URL('../src/client/rendering/frustum-culler.js', import.meta.url), 'utf8');
  assert.match(source, /export function createFrustumCuller/);
  assert.match(source, /frustum\.setFromProjectionMatrix/);
  assert.match(source, /_projMat\.multiplyMatrices\s*\(/);
  assert.match(source, /camera\.projectionMatrix/);
  assert.match(source, /camera\.matrixWorldInverse/);
});

test('terrain LOD renderer module exports createTerrainLodRenderer preserving visit recursion', async () => {
  const source = await readFile(new URL('../src/client/terrain/terrain-lod.js', import.meta.url), 'utf8');
  assert.match(source, /export function createTerrainLodRenderer/);
  assert.match(source, /visitRoot/);
  assert.match(source, /rebuildPlane/);
  assert.match(source, /getDrawnCount/);
  // Recursion order verbatim
  assert.match(source, /visit\(z\+1,\s*x\*2,\s*y\*2\)/);
  assert.match(source, /visit\(z\+1,\s*x\*2\+1,\s*y\*2\)/);
  assert.match(source, /visit\(z\+1,\s*x\*2,\s*y\*2\+1\)/);
  assert.match(source, /visit\(z\+1,\s*x\*2\+1,\s*y\*2\+1\)/);
  // Ancestor fallback
  assert.match(source, /tz--;\s*tx\s*>>=\s*1;\s*ty\s*>>=\s*1/);
  // Geometry rebuild disposes old
  assert.match(source, /old\.dispose\(\)/);
  assert.match(source, /meshPool\.setGeometry/);
});

test('render loop module exports startRenderLoop preserving per-frame ordering', async () => {
  const source = await readFile(new URL('../src/client/rendering/render-loop.js', import.meta.url), 'utf8');
  assert.match(source, /export function startRenderLoop/);
  assert.match(source, /controls\.update/);
  assert.match(source, /camera\.updateMatrixWorld/);
  assert.match(source, /renderer\.render/);
  assert.match(source, /compass\.render/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /updateFps/);
  assert.match(source, /updateHud/);
  // Eviction happens before render
  const evictIdx = source.indexOf('evict');
  const renderIdx = source.indexOf('renderer.render');
  assert.ok(evictIdx < renderIdx, 'cache evict should appear before renderer.render');
  // Recycle meshes before visiting
  const recycleIdx = source.indexOf('recycleAll');
  const visitIdx = source.indexOf('visitRoot');
  assert.ok(recycleIdx < visitIdx, 'recycleAll should appear before visitRoot');
});

function vectorStub(initial = [0, 0, 0]) {
  return {
    values: [...initial],
    set(x, y, z) { this.values = [x, y, z]; return this; },
    fromArray(values) { this.values = [...values]; return this; },
    toArray() { return [...this.values]; },
  };
}

function createThreeStub() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.values = [x, y, z]; }
    set(x, y, z) { this.values = [x, y, z]; return this; }
    clone() { return new Vector3(...this.values); }
    normalize() { return this; }
    copy(other) { this.values = [...other.values]; return this; }
    multiplyScalar(scalar) { this.values = this.values.map((value) => value * scalar); return this; }
    applyQuaternion() { return this; }
  }
  class Color { constructor(hex) { this.hex = hex; } }
  class Fog { constructor(hex, near, far) { this.hex = hex; this.near = near; this.far = far; } }
  class Scene { constructor() { this.children = []; this.type = 'Scene'; } add(child) { this.children.push(child); } }
  class PerspectiveCamera {
    constructor(fov, aspect, near, far) { this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; this.up = new Vector3(); this.position = new Vector3(); this.quaternion = { copy(other) { this.source = other; } }; }
    updateProjectionMatrix() { this.projectionUpdated = true; }
    updateMatrixWorld() { this.matrixWorldUpdated = true; }
  }
  class WebGLRenderer {
    constructor(options) { this.options = options; this.domElement = options.canvas || {}; this.autoClear = true; }
    setPixelRatio(value) { this.pixelRatio = value; }
    setSize(width, height) { this.size = [width, height]; }
  }
  class Group { constructor() { this.children = []; this.visible = true; } add(child) { this.children.push(child); } }
  class Mesh { constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector3(); } }
  class PlaneGeometry { constructor(width, height) { this.width = width; this.height = height; } }
  class MeshBasicMaterial { constructor(options) { this.options = options; } }
  class AmbientLight { constructor(color, intensity) { this.color = color; this.intensity = intensity; } }
  class DirectionalLight { constructor(color, intensity) { this.color = color; this.intensity = intensity; this.position = new Vector3(); } }
  class Shape { moveTo() {} lineTo() {} }
  class ExtrudeGeometry { constructor(shape, options) { this.shape = shape; this.options = options; } }
  class DataTexture { constructor(...args) { this.args = args; } }
  class MeshToonMaterial { constructor(options) { this.options = options; } }
  class EdgesGeometry { constructor(geometry, threshold) { this.geometry = geometry; this.threshold = threshold; } }
  class LineBasicMaterial { constructor(options) { this.options = options; } }
  class LineSegments { constructor(geometry, material) { this.geometry = geometry; this.material = material; } }
  class CanvasTexture { constructor(canvas) { this.canvas = canvas; } }
  class SpriteMaterial { constructor(options) { this.options = options; } }
  class Sprite { constructor(material) { this.material = material; this.scale = new Vector3(); this.position = new Vector3(); } }
  return {
    Vector3,
    Color,
    Fog,
    Scene,
    PerspectiveCamera,
    WebGLRenderer,
    Group,
    Mesh,
    PlaneGeometry,
    MeshBasicMaterial,
    AmbientLight,
    DirectionalLight,
    Shape,
    ExtrudeGeometry,
    DataTexture,
    MeshToonMaterial,
    EdgesGeometry,
    LineBasicMaterial,
    LineSegments,
    CanvasTexture,
    SpriteMaterial,
    Sprite,
    SRGBColorSpace: 'srgb',
    RGBAFormat: 'rgba',
    NearestFilter: 'nearest',
  };
}
