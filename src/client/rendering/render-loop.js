/**
 * @file Coordinates the viewer frame loop without taking ownership of shared scene, camera, renderer, or system references.
 */

import { updateFps, updateHud } from '../ui/hud.js';

/**
 * Reports whether the URL carries ?debug=1 so the loop can emit per-subsystem timing into the HUD. Returns false during tests where window.location.search is absent.
 */
function debugFlagEnabled() {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

/**
 * Starts the perpetual render loop that advances controls, visibility, cache maintenance, and presentation in a stable order.
 * The loop only orchestrates shared controls, camera, renderer, scene, terrain, systems, cache, and compass references; their lifetimes remain owned by the caller.
 */
export function startRenderLoop({ controls, camera, culler, terrain, systems, getBldRange, tileCache, renderer, scene, compass }) {
  let last = performance.now(), frames = 0;
  let lastFrameTime = performance.now();

  const debug = debugFlagEnabled();
  const perfTotals = debug
    ? { controls: 0, roadtrip: 0, labels: 0, terrain: 0, buildings: 0, forest: 0, render: 0, compass: 0 }
    : null;
  let perfSamples = 0;
  let perfHud = null;
  if (debug) {
    perfHud = document.createElement('div');
    perfHud.id = '__viewer-perf-hud';
    perfHud.style.cssText = 'position:fixed;right:8px;top:8px;background:rgba(0,0,0,0.7);color:#cfe;font:11px/1.3 monospace;padding:6px 8px;border:1px solid #555;border-radius:4px;z-index:9999;white-space:pre;pointer-events:none;';
    document.body.appendChild(perfHud);
  }

  /**
   * Times a phase only when debug instrumentation is active. The function call cost is paid even when disabled, so the wrapper is only used in hot phases.
   */
  function timed(name, fn) {
    if (!debug) { fn(); return; }
    const t0 = performance.now();
    fn();
    perfTotals[name] += performance.now() - t0;
  }

  /**
   * Executes one animation frame in the required pipeline order: controls, recycle, camera matrix, frustum, terrain, buildings/forest cull, cache evict, render, compass, then HUD.
   * Keeping this sequence explicit prevents culling or overlays from using stale camera state.
   */
  function loop() {
    requestAnimationFrame(loop);
    const tNow = performance.now();
    const dt = Math.min(0.1, (tNow - lastFrameTime) / 1000); // clamp to 100ms to avoid huge jumps after tab-switches
    lastFrameTime = tNow;
    timed('controls', () => controls.update());
    if (systems.roadtrip) timed('roadtrip', () => systems.roadtrip.update(dt));
    if (systems.labels) timed('labels', () => systems.labels.update(camera));
    terrain.recycleAll();

    camera.updateMatrixWorld();
    culler.update(camera);

    timed('terrain', () => terrain.visitRoot());
    timed('buildings', () => systems.buildings.cull({ camera, frustum: culler.frustum, rangeMetres: getBldRange() }));
    timed('forest', () => systems.forest.cull({ camera, frustum: culler.frustum }));
    tileCache.evict();
    timed('render', () => renderer.render(scene, camera));
    timed('compass', () => compass.render());

    frames++;
    if (debug) perfSamples++;
    const now = performance.now();
    if (now - last > 500) {
      updateFps(frames * 1000 / (now - last));
      frames = 0; last = now;
      updateHud({ drawn: terrain.getDrawnCount(), cacheSize: tileCache.size });
      if (debug && perfHud && perfSamples > 0) {
        const lines = Object.entries(perfTotals)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k.padEnd(9)} ${(v / perfSamples).toFixed(2).padStart(6)}ms`);
        perfHud.textContent = `frame phases (avg ${perfSamples}f)\n` + lines.join('\n');
        for (const key of Object.keys(perfTotals)) perfTotals[key] = 0;
        perfSamples = 0;
      }
    }
  }

  loop();
}
