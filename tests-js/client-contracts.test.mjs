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
