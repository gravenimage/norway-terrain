import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoadTripSystem, parseRouteBuffer, parseE39Buffer } from '../src/client/features/roadtrip.js';

/**
 * Build a minimal route-bin-compatible ArrayBuffer with the given points (each [x,y,z]).
 * Cumulative distance is filled in by Euclidean addition in XY. The two endpoint indices
 * default to first/last vertex (`idxFrom = 0`, `idxTo = n - 1`).
 */
function makeRouteBuffer(pts, idxFrom = 0, idxTo = null) {
  const n = pts.length;
  const idxT = idxTo === null ? n - 1 : idxTo;
  const buf = new ArrayBuffer(4 + 4 + 4 + 4 + 8 + 8 + n * 16);
  const view = new DataView(buf);
  view.setUint8(0, 'E'.charCodeAt(0));
  view.setUint8(1, '3'.charCodeAt(0));
  view.setUint8(2, '9'.charCodeAt(0));
  view.setUint8(3, '1'.charCodeAt(0));
  let off = 4;
  view.setUint32(off, n, true); off += 4;
  view.setUint32(off, idxFrom, true); off += 4;
  view.setUint32(off, idxT, true); off += 4;
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

test('parseRouteBuffer reads header and packed floats', () => {
  const buf = makeRouteBuffer([[0, 0, 100], [100, 0, 110], [200, 0, 120]], 0, 2);
  const r = parseRouteBuffer(buf);
  assert.equal(r.nPts, 3);
  assert.equal(r.idxFrom, 0);
  assert.equal(r.idxTo, 2);
  assert.equal(r.centerX, 25000);
  assert.equal(r.centerY, 6570000);
  assert.equal(r.floats.length, 12);
  assert.equal(r.floats[0 * 4 + 0], 0);
  assert.equal(r.floats[2 * 4 + 0], 200);
  // cumulative distance at the last vertex equals total straight-line length
  assert.ok(Math.abs(r.floats[2 * 4 + 3] - 200) < 1e-3);
});

test('parseE39Buffer is a back-compat alias of parseRouteBuffer', () => {
  assert.equal(parseE39Buffer, parseRouteBuffer);
});

test('parseRouteBuffer rejects wrong magic', () => {
  const buf = new ArrayBuffer(20);
  const v = new DataView(buf);
  v.setUint8(0, 'X'.charCodeAt(0));
  assert.throws(() => parseRouteBuffer(buf), /bad magic/);
});

/**
 * Minimal stubs so the system can be exercised in node without three.js / DOM.
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

/**
 * Stub `fetch` so the system can load `trips.json` and per-trip `.bin` files in node. Returns
 * a teardown function the test should call (we restore the original to avoid polluting later
 * tests). `bins` maps a URL (e.g. "e39.bin") to its ArrayBuffer.
 */
function stubFetch(manifest, bins) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'trips.json') {
      return { json: async () => manifest };
    }
    if (bins[url]) {
      return { arrayBuffer: async () => bins[url] };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

/** Most tests use a single-trip manifest with predictable endpoint labels. */
function singleTripManifest() {
  return [{
    id: 'e39',
    title: 'E39 · Mekjarvik – Egersund',
    file: 'e39.bin',
    fromLabel: 'Mekjarvik',
    toLabel: 'Egersund',
    lengthKm: 0,
  }];
}

test('createRoadTripSystem exposes API and tracks state', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ THREE: null, camera, controls, canvas, getExag: () => 1.0 });
  for (const m of ['load', 'setTrip', 'getTrips', 'getCurrentTrip', 'teleport',
                   'startDrive', 'stop', 'update', 'setHeight', 'setSpeed']) {
    assert.equal(typeof sys[m], 'function', `missing method ${m}`);
  }
  assert.equal(sys.getState().loaded, false);
  assert.equal(sys.getState().mode, 'idle');
  assert.equal(sys.getTrips().length, 0);
  assert.equal(sys.getCurrentTrip(), null);
});

test('load() reads trips.json then fetches the active trip bin', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeRouteBuffer([[0, 0, 100], [1000, 0, 110]], 0, 1);
  const restore = stubFetch(singleTripManifest(), { 'e39.bin': buf });
  try {
    await sys.load();
    const st = sys.getState();
    assert.equal(st.loaded, true);
    assert.equal(st.currentTripId, 'e39');
    assert.equal(st.fromLabel, 'Mekjarvik');
    assert.equal(st.toLabel, 'Egersund');
    assert.equal(sys.getTrips().length, 1);
    assert.equal(sys.getCurrentTrip().id, 'e39');
  } finally { restore(); }
});

test('teleport snaps camera onto the FROM and TO endpoints', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 2.0, initialHeight: 50 });
  const buf = makeRouteBuffer([[0, 0, 100], [1000, 0, 110], [2000, 0, 120]], 0, 2);
  const restore = stubFetch(singleTripManifest(), { 'e39.bin': buf });
  try {
    await sys.load();
    sys.teleport('from');
    // raw z=100, exag=2 → road z=200, plus height 50 → 250
    assert.equal(camera.position.x, 0);
    assert.equal(camera.position.y, 0);
    assert.ok(Math.abs(camera.position.z - 250) < 1e-3);
    sys.teleport('to');
    // raw z=120, exag=2 → road z=240, plus 50 → 290
    assert.ok(Math.abs(camera.position.z - 290) < 1e-3);
    assert.equal(camera.position.x, 2000);
  } finally { restore(); }
});

test('update advances progress by speed*dt and stops at endpoint', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeRouteBuffer([[0, 0, 0], [1000, 0, 0], [2000, 0, 0]], 0, 2);
  const restore = stubFetch(singleTripManifest(), { 'e39.bin': buf });
  try {
    await sys.load();
    sys.teleport('from');
    sys.setSpeed(36); // 36 km/h = 10 m/s
    sys.startDrive('to');
    sys.update(1.0);
    assert.ok(Math.abs(sys.getState().progress - 10) < 0.01);
    assert.equal(sys.getState().mode, 'driving');
    sys.update(10000);
    assert.equal(sys.getState().mode, 'idle');
    assert.ok(sys.getState().progress >= 2000 - 1e-3);
    assert.equal(controls.enabled, true);
  } finally { restore(); }
});

test('stop re-enables controls and returns to idle', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeRouteBuffer([[0, 0, 0], [100, 0, 0]], 0, 1);
  const restore = stubFetch(singleTripManifest(), { 'e39.bin': buf });
  try {
    await sys.load();
    sys.teleport('from');
    sys.startDrive('to');
    assert.equal(controls.enabled, false);
    sys.stop();
    assert.equal(controls.enabled, true);
    assert.equal(sys.getState().mode, 'idle');
  } finally { restore(); }
});

test('setTrip switches active trip, auto-stops driving, and re-seeds progress at FROM', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const e39 = makeRouteBuffer([[0, 0, 0], [1000, 0, 0]], 0, 1);
  const byrk = makeRouteBuffer([[500, 500, 200], [600, 500, 210], [700, 500, 220]], 0, 2);
  const manifest = [
    { id: 'e39', title: 'E39', file: 'e39.bin', fromLabel: 'Mekjarvik', toLabel: 'Egersund', lengthKm: 1 },
    { id: 'byrk', title: 'Byrkjedal', file: 'byrk.bin', fromLabel: 'Ålgård', toLabel: 'Byrkjedalstunet', lengthKm: 0.2 },
  ];
  const restore = stubFetch(manifest, { 'e39.bin': e39, 'byrk.bin': byrk });
  try {
    await sys.load();
    sys.teleport('from');
    sys.startDrive('to');
    assert.equal(sys.getState().mode, 'driving');
    assert.equal(sys.getState().currentTripId, 'e39');
    // Switch trips mid-drive: should auto-stop and load the new route.
    await sys.setTrip('byrk');
    const st = sys.getState();
    assert.equal(st.mode, 'idle', 'setTrip must auto-stop driving');
    assert.equal(st.currentTripId, 'byrk');
    assert.equal(st.fromLabel, 'Ålgård');
    assert.equal(st.toLabel, 'Byrkjedalstunet');
    // After swap, progress is seeded at the new route's FROM endpoint (vertex 0, cumDist 0).
    assert.ok(Math.abs(st.progress) < 1e-3, `expected progress=0 after trip swap, got ${st.progress}`);
    assert.equal(controls.enabled, true);
  } finally { restore(); }
});

test('setTrip is a no-op for unknown or already-active trips', async () => {
  const { camera, controls, canvas } = makeStubs();
  const sys = createRoadTripSystem({ camera, controls, canvas, getExag: () => 1.0 });
  const buf = makeRouteBuffer([[0, 0, 0], [100, 0, 0]], 0, 1);
  const restore = stubFetch(singleTripManifest(), { 'e39.bin': buf });
  try {
    await sys.load();
    const before = sys.getState().currentTripId;
    await sys.setTrip('nonexistent');
    assert.equal(sys.getState().currentTripId, before);
    await sys.setTrip('e39'); // same trip
    assert.equal(sys.getState().currentTripId, before);
  } finally { restore(); }
});
