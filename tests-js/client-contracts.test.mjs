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
  assert.equal(typeof forest.parseForestBuffer, 'function');
  assert.equal(typeof canopy.parseCanopyBuffer, 'function');
  assert.equal(typeof water.parseWaterBuffer, 'function');
  assert.equal(typeof water.createWaterSystem, 'function');
  assert.equal(typeof amenities.parseAmenitiesBuffer, 'function');
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
