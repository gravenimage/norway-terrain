/**
 * @file Test for features/forest-generate.js. Builds a tiny synthetic forest
 * buffer with 2 seeds in distinct 4000m cells, exercises generateForestBins
 * with empty obstacle state, and verifies bin/instance counts plus that the
 * attribute Float32Arrays carry plausible per-instance values (positions
 * inside the QUAD_M envelope, sizes > 0, canopy colour channels in palette
 * range). Locks the K_TREES math against unintended drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateForestBins } from '../src/client/features/forest-generate.js';

function makeSyntheticTRE2({ seeds }) {
  const recordBytes = 24;
  const buf = new ArrayBuffer(8 + seeds.length * recordBytes);
  const view = new DataView(buf);
  // magic 'TRE2'
  view.setUint8(0, 0x54); view.setUint8(1, 0x52); view.setUint8(2, 0x45); view.setUint8(3, 0x32);
  view.setUint32(4, seeds.length, true);
  for (let i = 0; i < seeds.length; i += 1) {
    const o = 8 + i * recordBytes;
    const s = seeds[i];
    view.setFloat32(o + 0, s.cx, true);
    view.setFloat32(o + 4, s.cy, true);
    view.setFloat32(o + 8, s.bz, true);
    view.setFloat32(o + 12, s.height, true);
    view.setUint8(o + 16, s.species);
    view.setUint8(o + 17, s.sizeJitter);
    view.setUint8(o + 18, s.colorJitter);
    view.setInt8(o + 20, 0);
    view.setInt8(o + 21, 0);
    view.setInt8(o + 22, 0);
    view.setInt8(o + 23, 0);
  }
  return buf;
}

test('generateForestBins produces K_TREES instances per seed in unobstructed cells', () => {
  const buf = makeSyntheticTRE2({
    seeds: [
      { cx: 100, cy: 100, bz: 50, height: 12, species: 0, sizeJitter: 128, colorJitter: 64 },
      { cx: 9000, cy: 9000, bz: 80, height: 10, species: 1, sizeJitter: 200, colorJitter: 32 },
    ],
  });
  const bins = [];
  let lastProgress = { current: 0, total: 0 };
  const summary = generateForestBins({
    forestBuffer: buf,
    obstacleState: { roads: null, buildings: null },
    onBin: (b) => bins.push(b),
    onProgress: (current, total) => { lastProgress = { current, total }; },
  });
  // Two seeds at (100,100) and (9000,9000) land in different 4000 m bins.
  assert.equal(bins.length, 2);
  assert.equal(summary.cells, 2);
  assert.equal(summary.seeds, 2);
  assert.equal(summary.K_TREES, 16);
  // 2 seeds × 16 trees, none culled (empty obstacles).
  assert.equal(summary.instances, 32);
  assert.equal(summary.culled, 0);
  assert.equal(lastProgress.current, lastProgress.total);
  // Each bin's first instance must have a finite position and positive size.
  for (const bin of bins) {
    assert.equal(bin.instanceCount, 16);
    assert.ok(Number.isFinite(bin.iPos[0]));
    assert.ok(bin.iSize[0] > 0); // radius
    assert.ok(bin.iSize[1] > 0); // height
    // canopy colours: A channel within palette envelope [0.04, 0.5].
    assert.ok(bin.iCanopyA[0] >= 0.04 && bin.iCanopyA[0] <= 0.5);
  }
});

test('generateForestBins yields 0 instances and 0 bins for an empty TRE2 buffer', () => {
  const buf = makeSyntheticTRE2({ seeds: [] });
  const bins = [];
  const summary = generateForestBins({
    forestBuffer: buf,
    obstacleState: { roads: null, buildings: null },
    onBin: (b) => bins.push(b),
  });
  assert.equal(bins.length, 0);
  assert.equal(summary.seeds, 0);
  assert.equal(summary.instances, 0);
  assert.equal(summary.culled, 0);
});
