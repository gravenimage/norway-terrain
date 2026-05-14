/**
 * @file Road-trip mode: rail-guided camera that drives along a pre-extracted polyline at
 * constant speed and configurable height. Supports multiple routes via `trips.json`
 * (built by `extract_route.py`); each route is its own `<id>.bin` with the same layout.
 *
 * Public entry points:
 *   parseRouteBuffer(ab)  - pure parser, returns header + Float32 view (testable in node)
 *   createRoadTripSystem  - factory that owns route state and camera-override behaviour
 *
 * Coordinate notes:
 *   - Scene is Z-up. Route points are stored as (x_rel, y_rel, z_raw, cumDist) in metres,
 *     where x_rel/y_rel are EPSG:25833 minus the world centre. z_raw is the *raw* DEM
 *     elevation; the terrain shader multiplies by uExag, so this system multiplies z by the
 *     current exaggeration to keep the camera flush with the visible road surface.
 *   - Drag-look adds yaw/pitch offsets relative to the road tangent; both decay smoothly on
 *     pointer release. Pitch is clamped to avoid flipping the camera.
 *   - Endpoints are positional: "from" = idxFrom (vertex 0 by convention) and "to" = idxTo
 *     (last vertex). Display labels are looked up in the manifest, not the binary, so a route
 *     can be relabelled without rebuilding the .bin.
 */

const MAGIC = 'E391';
const TRIPS_MANIFEST_URL = 'trips.json';
const TRIP_STORAGE_KEY = 'roadtrip-trip';

/**
 * Decode a route binary produced by `extract_route.py`. Same layout as the historical
 * `e39.bin`; the two endpoint indices are exposed as `idxFrom` / `idxTo`. Kept exported
 * (and pure) so it can be unit-tested without spinning up the whole system.
 */
export function parseRouteBuffer(ab) {
  const view = new DataView(ab);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error(`route bin: bad magic ${JSON.stringify(magic)}`);
  let off = 4;
  const nPts = view.getUint32(off, true); off += 4;
  const idxFrom = view.getUint32(off, true); off += 4;
  const idxTo = view.getUint32(off, true); off += 4;
  const centerX = view.getFloat64(off, true); off += 8;
  const centerY = view.getFloat64(off, true); off += 8;
  const floats = new Float32Array(ab, off, nPts * 4);
  return { nPts, idxFrom, idxTo, centerX, centerY, floats };
}

// Back-compat re-export so callers that imported the old name keep working. Both names
// point at the exact same parser; the binary format is unchanged.
export const parseE39Buffer = parseRouteBuffer;

/**
 * Locate the route vertex index whose cumulative distance is just below `s` (metres). The
 * route is monotonic in cumDist by construction so a binary search is correct and cheap.
 */
function findSegment(floats, nPts, s) {
  let lo = 0, hi = nPts - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    const sMid = floats[mid * 4 + 3];
    if (sMid <= s) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Interpolate a sample {x, y, z, fwdX, fwdY} along the route at distance `s` metres. Forward
 * tangent is computed from a short lookahead window (±LOOKAHEAD metres clamped to the route
 * ends) and normalized; this smooths over OSM vertex jaggies so the camera doesn't yaw-snap.
 */
function sampleRoute(floats, nPts, s) {
  const totalLen = floats[(nPts - 1) * 4 + 3];
  if (s <= 0) s = 0;
  else if (s >= totalLen) s = totalLen;
  const i = findSegment(floats, nPts, s);
  const j = Math.min(i + 1, nPts - 1);
  const s0 = floats[i * 4 + 3];
  const s1 = floats[j * 4 + 3];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const x = floats[i * 4 + 0] * (1 - t) + floats[j * 4 + 0] * t;
  const y = floats[i * 4 + 1] * (1 - t) + floats[j * 4 + 1] * t;
  const z = floats[i * 4 + 2] * (1 - t) + floats[j * 4 + 2] * t;

  const LOOKAHEAD = 60; // metres
  const sBack = Math.max(0, s - LOOKAHEAD);
  const sFwd = Math.min(totalLen, s + LOOKAHEAD);
  const ib = findSegment(floats, nPts, sBack);
  const ifw = Math.min(findSegment(floats, nPts, sFwd) + 1, nPts - 1);
  const ax = floats[ib * 4 + 0], ay = floats[ib * 4 + 1];
  const bx = floats[ifw * 4 + 0], by = floats[ifw * 4 + 1];
  let fx = bx - ax, fy = by - ay;
  const flen = Math.hypot(fx, fy) || 1;
  fx /= flen; fy /= flen;
  return { x, y, z, fwdX: fx, fwdY: fy, totalLen };
}

/**
 * Construct the road-trip system. Owns route state and the active camera-override behaviour,
 * but borrows camera/controls/canvas references — it does not create or dispose them.
 *
 * Multi-trip lifecycle:
 *   1. load()         - fetches trips.json, then loads the persisted-or-first trip's .bin.
 *   2. setTrip(id)    - swaps to a different trip from the same manifest. Auto-stops driving.
 *   3. getTrips()     - returns the manifest entries (id, title, file, fromLabel, toLabel,
 *                       lengthKm) so the UI can build a dropdown.
 *
 * Endpoint references throughout the API are positional ("from" / "to"), not name-based —
 * the manifest carries the human-readable labels so the system itself stays route-agnostic.
 */
export function createRoadTripSystem({
  THREE,
  camera,
  controls,
  canvas,
  getExag = () => 1.0,
  initialHeight = 75,
  initialSpeedKmh = 70,
} = {}) {
  let trips = null;            // array of manifest entries, or null until load() resolves
  let currentTripId = null;    // id of the active trip, or null while unloaded
  let route = null;            // { floats, nPts, idxFrom, idxTo, totalLen } for currentTripId
  let mode = 'idle';
  let progress = 0;
  let direction = 1;           // +1 = toward "to" (s increasing), -1 = toward "from"
  let height = initialHeight;
  let speedKmh = initialSpeedKmh;
  let dragYaw = 0;
  let dragPitch = 0;
  let dragYawVel = 0;
  let dragPitchVel = 0;
  let dragging = false;
  let lastPx = 0, lastPy = 0;
  let controlsTargetRestore = null;
  let smoothedHeadingYaw = null;
  const PITCH_MIN = -1.2;
  const PITCH_MAX = 0.6;
  const YAW_DECAY = 4.0;
  const PITCH_DECAY = 4.0;
  const HEADING_TIME_CONSTANT = 4.0;
  const onStateChange = new Set();

  function notify() {
    const st = getState();
    for (const fn of onStateChange) fn(st);
  }

  /** Look up the currently-selected trip's manifest entry, or null if none is loaded. */
  function getCurrentTrip() {
    if (!trips || !currentTripId) return null;
    return trips.find((t) => t.id === currentTripId) || null;
  }

  /** Public state snapshot. Always safe to call; returns sensible defaults pre-load. */
  function getState() {
    const trip = getCurrentTrip();
    return {
      loaded: route !== null,
      mode,
      progress,
      totalLen: route ? route.totalLen : 0,
      height,
      speedKmh,
      direction,
      currentTripId,
      fromLabel: trip ? trip.fromLabel : '',
      toLabel: trip ? trip.toLabel : '',
      // Convenience booleans so the panel doesn't replicate the float comparison logic.
      atFrom: route ? Math.abs(progress - route.floats[route.idxFrom * 4 + 3]) < 5 : false,
      atTo:   route ? Math.abs(progress - route.floats[route.idxTo   * 4 + 3]) < 5 : false,
    };
  }

  function onPointerDown(ev) {
    if (mode !== 'driving') return;
    if (ev.button !== 0) return;
    dragging = true;
    lastPx = ev.clientX;
    lastPy = ev.clientY;
    canvas.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - lastPx;
    const dy = ev.clientY - lastPy;
    lastPx = ev.clientX;
    lastPy = ev.clientY;
    const SENS = 0.005;
    dragYaw -= dx * SENS;
    dragPitch -= dy * SENS;
    if (dragPitch < PITCH_MIN) dragPitch = PITCH_MIN;
    if (dragPitch > PITCH_MAX) dragPitch = PITCH_MAX;
  }

  function onPointerUp(ev) {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(ev.pointerId);
  }

  function shortestAngleDelta(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function applyCamera(dt = 0) {
    if (!route) return;
    const s = sampleRoute(route.floats, route.nPts, progress);
    const exag = getExag();
    const baseZ = s.z * exag;
    camera.position.set(s.x, s.y, baseZ + height);

    const tangentAngle = Math.atan2(s.fwdY, s.fwdX);
    const targetHeadingYaw = direction > 0 ? tangentAngle : tangentAngle + Math.PI;
    if (smoothedHeadingYaw === null) {
      smoothedHeadingYaw = targetHeadingYaw;
    } else if (dt > 0) {
      const alpha = 1 - Math.exp(-dt / HEADING_TIME_CONSTANT);
      smoothedHeadingYaw += shortestAngleDelta(smoothedHeadingYaw, targetHeadingYaw) * alpha;
    }
    const yaw = smoothedHeadingYaw + dragYaw;
    const pitch = dragPitch;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const LOOK_AT = 200;
    const tx = s.x + cy * cp * LOOK_AT;
    const ty = s.y + sy * cp * LOOK_AT;
    const tz = baseZ + height + sp * LOOK_AT;
    camera.up.set(0, 0, 1);
    camera.lookAt(tx, ty, tz);

    if (controls && controls.target) {
      controls.target.set(tx, ty, tz);
    }
  }

  /** Returns the cumulative-distance value of the given endpoint on the active route. */
  function endpointDistance(which) {
    if (!route) return 0;
    const idx = which === 'from' ? route.idxFrom : route.idxTo;
    return route.floats[idx * 4 + 3];
  }

  /**
   * Parse a .bin ArrayBuffer into the internal `route` shape and snap progress to the FROM
   * endpoint. Shared between initial load() and runtime setTrip(); kept private so the API
   * surface stays narrow.
   */
  function adoptRouteFromBuffer(ab) {
    const parsed = parseRouteBuffer(ab);
    route = {
      floats: parsed.floats,
      nPts: parsed.nPts,
      idxFrom: parsed.idxFrom,
      idxTo: parsed.idxTo,
      totalLen: parsed.floats[(parsed.nPts - 1) * 4 + 3],
    };
    progress = endpointDistance('from');
    direction = 1;
    smoothedHeadingYaw = null;
    dragYaw = 0; dragPitch = 0; dragYawVel = 0; dragPitchVel = 0;
  }

  /** Best-effort localStorage read; tolerates SSR/private-mode environments. */
  function readPersistedTripId() {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(TRIP_STORAGE_KEY);
    } catch { return null; }
  }
  function writePersistedTripId(id) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(TRIP_STORAGE_KEY, id);
    } catch { /* ignore quota / disabled storage */ }
  }

  return {
    /**
     * Fetch `trips.json` then the active trip's binary. The "active trip" is the one
     * persisted in localStorage, falling back to the first manifest entry if that id is
     * unknown (or no preference recorded). Idempotent on failure: leaves `route = null`.
     */
    async load() {
      try {
        const manifest = await (await fetch(TRIPS_MANIFEST_URL)).json();
        if (!Array.isArray(manifest) || manifest.length === 0) {
          throw new Error('trips.json is empty or malformed');
        }
        trips = manifest;
        const persisted = readPersistedTripId();
        const initial = trips.find((t) => t.id === persisted) || trips[0];
        currentTripId = initial.id;
        const ab = await (await fetch(initial.file)).arrayBuffer();
        adoptRouteFromBuffer(ab);
        notify();
      } catch (e) {
        console.warn('road-trip load failed:', e);
        notify();
      }
    },

    /**
     * Switch to a different trip from the loaded manifest. Stops driving first so the user
     * can't accidentally keep driving along a now-irrelevant polyline, snaps the camera to
     * the new trip's FROM endpoint, persists the choice. No-op if `tripId` is unknown or
     * already active.
     */
    async setTrip(tripId) {
      if (!trips) return;
      const trip = trips.find((t) => t.id === tripId);
      if (!trip || trip.id === currentTripId) return;
      if (mode === 'driving') {
        mode = 'idle';
        if (controls) { controls.enabled = true; controls.update?.(); }
      }
      try {
        const ab = await (await fetch(trip.file)).arrayBuffer();
        currentTripId = trip.id;
        adoptRouteFromBuffer(ab);
        writePersistedTripId(trip.id);
        applyCamera(0);
        notify();
      } catch (e) {
        console.warn(`road-trip setTrip(${tripId}) failed:`, e);
      }
    },

    /** Manifest accessor for the panel's dropdown. */
    getTrips() { return trips ? trips.slice() : []; },

    /** Current trip's manifest entry, or null if nothing loaded. */
    getCurrentTrip,

    /**
     * Snap to one positional endpoint without starting motion. `which` is 'from' or 'to'.
     * Drops drag offsets so the teleported view faces forward along the road tangent.
     */
    teleport(which) {
      if (!route) return;
      progress = endpointDistance(which);
      // Natural drive direction: from FROM is +1 (toward TO); from TO is -1 (toward FROM).
      direction = which === 'from' ? 1 : -1;
      dragYaw = 0; dragPitch = 0; dragYawVel = 0; dragPitchVel = 0;
      smoothedHeadingYaw = null;
      const wasMode = mode;
      mode = 'driving'; applyCamera(0); mode = wasMode;
      if (mode === 'idle' && controls) controls.update?.();
      notify();
    },

    /**
     * Begin driving toward the named positional endpoint ('from' | 'to'). Captures the prior
     * MapControls target so `stop()` can restore it. Direction is recomputed from the current
     * progress so this works mid-route as well as immediately after a teleport.
     */
    startDrive(toWhich) {
      if (!route) return;
      const target = endpointDistance(toWhich);
      const newDirection = target > progress ? 1 : -1;
      if (newDirection !== direction) smoothedHeadingYaw = null;
      direction = newDirection;
      if (controls) {
        controlsTargetRestore = controls.target ? controls.target.clone() : null;
        controls.enabled = false;
      }
      mode = 'driving';
      dragYaw = 0; dragPitch = 0; dragYawVel = 0; dragPitchVel = 0;
      notify();
    },

    stop() {
      if (mode !== 'driving') return;
      mode = 'idle';
      if (controls) {
        controls.enabled = true;
        controls.update?.();
      }
      controlsTargetRestore = null;
      notify();
    },

    setHeight(h) { height = Math.max(2, h); if (mode === 'driving') applyCamera(0); notify(); },
    setSpeed(kmh) { speedKmh = Math.max(1, kmh); notify(); },

    update(dt) {
      if (mode !== 'driving' || !route) return;
      const ds = (speedKmh / 3.6) * dt * direction;
      progress += ds;
      if (progress <= 0) { progress = 0; mode = 'idle'; if (controls) { controls.enabled = true; controls.update?.(); } notify(); return; }
      if (progress >= route.totalLen) { progress = route.totalLen; mode = 'idle'; if (controls) { controls.enabled = true; controls.update?.(); } notify(); return; }
      if (!dragging) {
        const decay = Math.exp(-YAW_DECAY * dt);
        const pdecay = Math.exp(-PITCH_DECAY * dt);
        dragYaw *= decay;
        dragPitch *= pdecay;
      }
      applyCamera(dt);
    },

    attachInput() {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
    },

    onChange(fn) {
      onStateChange.add(fn);
      return () => onStateChange.delete(fn);
    },

    getState,
  };
}
