import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoadTripSystem, parseE39Buffer } from '../src/client/features/roadtrip.js';

/**
 * Build a minimal e39.bin-compatible ArrayBuffer with the given points (each [x,y,z]).
 * Cumulative distance is filled in by Euclidean addition in XY.
 */
function makeE39Buffer(pts, idxMek = 0, idxEgs = null) {
  const n = pts.length;
  const idxE = idxEgs === null ? n - 1 : idxEgs;
  const buf = new ArrayBuffer(4 + 4 + 4 + 4 + 8 + 8 + n * 16);
  const view = new DataView(buf);
  view.setUint8(0, 'E'.charCodeAt(0));
  view.setUint8(1, '3'.charCodeAt(0));
  view.setUint8(2, '9'.charCodeAt(0));
  view.setUint8(3, '1'.charCodeAt(0));
  let off = 4;
  view.setUint32(off, n, true); off += 4;
  view.setUint32(off, idxMek, true); off += 4;
  view.setUint32(off, idxE, true); off += 4;
  view.setFloat64(off, 25000, true); off += 8;
  view.setFloat64(off, 6570000, true); off += 8;
  let cum = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      cum += Math.hypot(dx, dy);
    }
    view.setFloat32(off + 0, pts[i][0], true);
    view.setFloat32(off + 4, pts[i][1], true);
    view.setFloat32(off + 8, pts[i][2], true);
    view.setFloat32(off + 12, cum, true);
    off += 16;
  }
  return buf;
}

test('parseE39Buffer reads header and packed floats', () => {
  const buf = makeE39Buffer([[0, 0, 100], [100, 0, 110], [200, 0, 120]], 0, 2);
  const r = parseE39Buffer(buf);
  assert.equal(r.nPts, 3);
  assert.equal(r.idxMekjarvik, 0);
  assert.equal(r.idxEgersund, 2);
  assert.equal(r.centerX, 25000);
  assert.equal(r.centerY, 6570000);
  assert.equal(r.floats.length, 12);
  assert.equal(r.floats[0 * 4 + 0], 0);
  assert.equal(r.floats[2 * 4 + 0], 200);
  // cumulative distance at the last vertex equals total straight-line length
  assert.ok(Math.abs(r.floats[2 * 4 + 3] - 200) < 1e-3);
});

test('parseE39Buffer rejects wrong magic', () => {
  const buf = new ArrayBuffer(20);
  const v = new DataView(buf);
  v.setUint8(0, 'X'.charCodeAt(0));
  assert.throws(() => parseE39Buffer(buf), /bad magic/);
});

/**
 * Minimal stub camera/controls/canvas so the system can be exercised in node without three.js.
 */
function makeStubs() {
  const camera = {
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    up: { x: 0, y: 0, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    lookAt(x, y, z) { this.lookTarget = { x, y, z }; },
  };
  const controls = {
    enabled: true,
    target: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, clone() { return { ...this }; } },
    update() { this.updated = (this.updated || 0) + 1; },
  };
  const canvas = {
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  return { camera, controls, canvas };
}

test('createRoadTripSystem exposes API and tracks state', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ THREE: null, camera, controls, canvas, getExag: () => 1.0 });
  assert.equal(typeof sys.load, 'function');
  assert.equal(typeof sys.teleport, 'function');
  assert.equal(typeof sys.startDrive, 'function');
  assert.equal(typeof sys.stop, 'function');
  assert.equal(typeof sys.update, 'function');
  assert.equal(typeof sys.setHeight, 'function');
  assert.equal(typeof sys.setSpeed, 'function');
  assert.equal(sys.getState().loaded, false);
  assert.equal(sys.getState().mode, 'idle');
});

test('roadtrip teleport snaps camera onto route at endpoint', () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 2.0, initialHeight: 50 });
  // Inject a route by mimicking what load() does (parse a synthetic buffer).
  const buf = makeE39Buffer([[0, 0, 100], [1000, 0, 110], [2000, 0, 120]], 0, 2);
  const parsed = parseE39Buffer(buf);
  // Use the internal load() route to avoid bypassing parsing; stub fetch.
  globalThis.fetch = async () => ({ arrayBuffer: async () => buf });
  return sys.load().then(() => {
    sys.teleport('mekjarvik');
    // raw z=100, exag=2 → road z=200, plus height 50 → 250
    assert.equal(camera.position.x, 0);
    assert.equal(camera.position.y, 0);
    assert.ok(Math.abs(camera.position.z - 250) < 1e-3);
    sys.teleport('egersund');
    // raw z=120, exag=2 → road z=240, plus 50 → 290
    assert.ok(Math.abs(camera.position.z - 290) < 1e-3);
    assert.equal(camera.position.x, 2000);
  });
});

test('roadtrip update advances progress by speed*dt and stops at endpoint', () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeE39Buffer([[0, 0, 0], [1000, 0, 0], [2000, 0, 0]], 0, 2);
  globalThis.fetch = async () => ({ arrayBuffer: async () => buf });
  return sys.load().then(() => {
    sys.teleport('mekjarvik');
    sys.setSpeed(36); // 36 km/h = 10 m/s
    sys.startDrive('egersund');
    sys.update(1.0);
    // After 1s at 10m/s, progress should be 10 m
    assert.ok(Math.abs(sys.getState().progress - 10) < 0.01);
    assert.equal(sys.getState().mode, 'driving');
    // Big jump should clamp and idle
    sys.update(10000);
    assert.equal(sys.getState().mode, 'idle');
    assert.ok(sys.getState().progress >= 2000 - 1e-3);
    assert.equal(controls.enabled, true);
  });
});

test('roadtrip stop re-enables controls and syncs target', () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeE39Buffer([[0, 0, 0], [100, 0, 0]], 0, 1);
  globalThis.fetch = async () => ({ arrayBuffer: async () => buf });
  return sys.load().then(() => {
    sys.teleport('mekjarvik');
    sys.startDrive('egersund');
    assert.equal(controls.enabled, false);
    sys.stop();
    assert.equal(controls.enabled, true);
    assert.equal(sys.getState().mode, 'idle');
  });
});
