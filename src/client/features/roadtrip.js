/**
 * @file Road-trip mode: rail-guided camera that drives along the pre-extracted E39 polyline
 * between Mekjarvik and Egersund at constant speed and configurable height. Loads `e39.bin`
 * (produced by `extract_e39.py`), exposes teleport/start/stop/setHeight/setSpeed/update API,
 * and overrides MapControls while active.
 *
 * Coordinate notes:
 *   - Scene is Z-up. Road points stored as (x_rel, y_rel, z_raw, cumDist) in metres where
 *     x_rel/y_rel are EPSG:25833 minus the world centre. z_raw is the *raw* DEM elevation;
 *     the terrain shader multiplies by uExag, so this system multiplies z by the current
 *     exaggeration to keep the camera flush with the visible road surface.
 *   - Drag-look adds yaw/pitch offsets relative to the road tangent; both decay smoothly on
 *     pointer release. Pitch is clamped to avoid flipping the camera.
 */

const MAGIC = 'E391';

/**
 * Decode the binary `e39.bin` produced by `extract_e39.py`.
 * Returns the route header plus a Float32Array view over [x, y, z, cumDist] per vertex.
 */
export function parseE39Buffer(ab) {
  const view = new DataView(ab);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new Error(`e39.bin: bad magic ${JSON.stringify(magic)}`);
  let off = 4;
  const nPts = view.getUint32(off, true); off += 4;
  const idxMekjarvik = view.getUint32(off, true); off += 4;
  const idxEgersund = view.getUint32(off, true); off += 4;
  const centerX = view.getFloat64(off, true); off += 8;
  const centerY = view.getFloat64(off, true); off += 8;
  const floats = new Float32Array(ab, off, nPts * 4);
  return { nPts, idxMekjarvik, idxEgersund, centerX, centerY, floats };
}

/**
 * Locate the route vertex index whose cumulative distance is just below `s` (metres). The route
 * is monotonic in cumDist by construction so a binary search is correct and cheap.
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

  // smoothed tangent via lookahead window
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
 * Construct the road-trip system. Owns route state and the active camera-override behaviour, but
 * borrows camera/controls/canvas references — it does not create or dispose them.
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
  let route = null; // { floats, nPts, idxMekjarvik, idxEgersund, totalLen }
  let mode = 'idle'; // 'idle' | 'driving'
  let progress = 0; // metres along route
  let direction = 1; // +1 = toward egersund (increasing s), -1 = toward mekjarvik
  let height = initialHeight;
  let speedKmh = initialSpeedKmh;
  let dragYaw = 0;
  let dragPitch = 0;
  let dragYawVel = 0;
  let dragPitchVel = 0;
  let dragging = false;
  let lastPx = 0, lastPy = 0;
  let controlsTargetRestore = null;
  // smoothedHeadingYaw lags the raw road tangent so the camera doesn't snap around roundabouts
  // and OSM vertex kinks. null means "uninitialised" — first applyCamera snaps to the target so
  // teleports don't sweep through the world.
  let smoothedHeadingYaw = null;
  const PITCH_MIN = -1.2; // ~-69° (look up steeply, but not flip)
  const PITCH_MAX = 0.6;  // ~+34° (look down at the road)
  const YAW_DECAY = 4.0;  // 1/s, exponential decay toward zero on release
  const PITCH_DECAY = 4.0;
  // Heading-smoothing time constant: at ~70km/h this gives roughly 250m of "settling distance"
  // before the camera is aimed at a new straight section, so roundabouts/turns are felt as a
  // gentle sweep rather than a jerk. Larger = lazier camera.
  const HEADING_TIME_CONSTANT = 4.0; // seconds
  const onStateChange = new Set();

  function notify() {
    for (const fn of onStateChange) fn(getState());
  }

  /**
   * Returns a snapshot of the driver state for UI binding. Cheap; copies primitives only.
   */
  function getState() {
    return {
      loaded: route !== null,
      mode,
      progress,
      totalLen: route ? route.totalLen : 0,
      height,
      speedKmh,
      direction,
      atMekjarvik: route ? Math.abs(progress - route.floats[route.idxMekjarvik * 4 + 3]) < 5 : false,
      atEgersund: route ? Math.abs(progress - route.floats[route.idxEgersund * 4 + 3]) < 5 : false,
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
    // pixels → radians; tuned so a full canvas drag ≈ ~90° rotation
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

  /**
   * Wrap an angle delta into (-π, π] so heading smoothing always rotates the short way around the
   * unit circle instead of, say, sweeping 359° counter-clockwise to reach a 1° turn.
   */
  function shortestAngleDelta(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /**
   * Compose the camera transform: position = (rx, ry, exag*rz + height); look along the
   * inertia-smoothed heading rotated by (yaw_drag, pitch_drag). `dt` is used to advance the
   * heading low-pass filter toward the raw road tangent; passing 0 leaves the heading untouched
   * (used by teleport/setHeight to refresh the view without artificially aging the filter).
   */
  function applyCamera(dt = 0) {
    if (!route) return;
    const s = sampleRoute(route.floats, route.nPts, progress);
    const exag = getExag();
    const baseZ = s.z * exag;
    camera.position.set(s.x, s.y, baseZ + height);

    // road tangent angle in world XY plane (raw, before smoothing)
    const tangentAngle = Math.atan2(s.fwdY, s.fwdX);
    const targetHeadingYaw = direction > 0 ? tangentAngle : tangentAngle + Math.PI;
    if (smoothedHeadingYaw === null) {
      smoothedHeadingYaw = targetHeadingYaw;
    } else if (dt > 0) {
      // exponential approach: alpha = 1 - exp(-dt/τ). With τ=4s and dt=1/60s, alpha≈0.0041,
      // so the heading takes several seconds to fully converge — that's the inertia.
      const alpha = 1 - Math.exp(-dt / HEADING_TIME_CONSTANT);
      smoothedHeadingYaw += shortestAngleDelta(smoothedHeadingYaw, targetHeadingYaw) * alpha;
    }
    const yaw = smoothedHeadingYaw + dragYaw;
    const pitch = dragPitch;
    // forward vector with pitch (Z-up): horizontal*cos(pitch) + Z*sin(pitch)
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const LOOK_AT = 200;
    const tx = s.x + cy * cp * LOOK_AT;
    const ty = s.y + sy * cp * LOOK_AT;
    const tz = baseZ + height + sp * LOOK_AT;
    camera.up.set(0, 0, 1);
    camera.lookAt(tx, ty, tz);

    // Keep controls.target in lock-step so re-enabling MapControls on stop() yields a sensible
    // orbit centre instead of an 80km swing back to a stale target.
    if (controls && controls.target) {
      controls.target.set(tx, ty, tz);
    }
  }

  function endpointDistance(endpoint) {
    if (!route) return 0;
    const idx = endpoint === 'mekjarvik' ? route.idxMekjarvik : route.idxEgersund;
    return route.floats[idx * 4 + 3];
  }

  return {
    /**
     * Fetches `e39.bin`, parses the route, and snaps the camera to Mekjarvik in idle mode so the
     * user can immediately teleport/drive without a manual setup step. Idempotent on failure:
     * leaves `route = null` and surfaces an error via `getState().loaded === false`.
     */
    async load() {
      try {
        const ab = await (await fetch('e39.bin')).arrayBuffer();
        const parsed = parseE39Buffer(ab);
        route = {
          floats: parsed.floats,
          nPts: parsed.nPts,
          idxMekjarvik: parsed.idxMekjarvik,
          idxEgersund: parsed.idxEgersund,
          totalLen: parsed.floats[(parsed.nPts - 1) * 4 + 3],
        };
        progress = endpointDistance('mekjarvik');
        notify();
      } catch (e) {
        console.warn('e39.bin not loaded:', e);
      }
    },

    /**
     * Snap the camera to one named endpoint without starting motion. Drops drag offsets so the
     * teleported view faces forward along the road tangent at that endpoint.
     */
    teleport(endpoint) {
      if (!route) return;
      progress = endpointDistance(endpoint);
      // pre-orient: when teleporting to mekjarvik, the natural drive is south (s increasing → +1);
      // when teleporting to egersund, the natural drive is north (s decreasing → -1).
      direction = endpoint === 'mekjarvik' ? 1 : -1;
      dragYaw = 0; dragPitch = 0; dragYawVel = 0; dragPitchVel = 0;
      // Reset the heading filter so the teleport snaps to face down the road instead of slewing
      // from whatever heading we had at the last position.
      smoothedHeadingYaw = null;
      // While idle we still want the camera to actually be over the road, not where MapControls
      // last left it, so apply now and disable orbit drift until user explicitly resumes idle.
      const wasMode = mode;
      mode = 'driving'; applyCamera(0); mode = wasMode;
      // Sync controls target to the road-aligned target so MapControls (if still enabled) orbits
      // around the teleport location instead of the old map centre.
      if (mode === 'idle' && controls) controls.update?.();
      notify();
    },

    /**
     * Begin driving toward the named endpoint. Captures the prior MapControls target so `stop()`
     * can restore it. Direction is chosen by comparing current progress to the endpoint's s.
     */
    startDrive(toEndpoint) {
      if (!route) return;
      const target = endpointDistance(toEndpoint);
      const newDirection = target > progress ? 1 : -1;
      // If we just reversed direction (e.g. user drove Mekjarvik→Egersund then hit Drive→Mekjarvik
      // mid-route), snap the heading so the camera doesn't lazily 180° around on its own.
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

    /**
     * Halt driving and hand the camera back to MapControls. The current look target stays in
     * `controls.target` (set every drive frame) so the user can continue panning/orbiting from
     * exactly where the drive stopped.
     */
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

    /**
     * Per-frame tick. While driving: advances `progress` by speed*dt, clamps at endpoints (then
     * idles automatically), decays drag offsets, and re-applies the camera transform.
     */
    update(dt) {
      if (mode !== 'driving' || !route) return;
      const ds = (speedKmh / 3.6) * dt * direction;
      progress += ds;
      if (progress <= 0) { progress = 0; mode = 'idle'; if (controls) { controls.enabled = true; controls.update?.(); } notify(); return; }
      if (progress >= route.totalLen) { progress = route.totalLen; mode = 'idle'; if (controls) { controls.enabled = true; controls.update?.(); } notify(); return; }
      if (!dragging) {
        // Exponential decay toward zero so the view eases back to forward when the user releases.
        const decay = Math.exp(-YAW_DECAY * dt);
        const pdecay = Math.exp(-PITCH_DECAY * dt);
        dragYaw *= decay;
        dragPitch *= pdecay;
      }
      applyCamera(dt);
    },

    /**
     * Attach DOM listeners for drag-look. Caller is expected to call this once; pointer events
     * are filtered to only act while driving so MapControls is unaffected during idle.
     */
    attachInput() {
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
    },

    /**
     * Subscribe to state-change events. Returns an unsubscribe function. Used by the UI panel
     * to keep button labels and the progress readout in sync with internal state.
     */
    onChange(fn) {
      onStateChange.add(fn);
      return () => onStateChange.delete(fn);
    },

    getState,
  };
}
