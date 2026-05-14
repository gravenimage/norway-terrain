/**
 * @file Coordinates the viewer frame loop without taking ownership of shared scene, camera, renderer, or system references.
 */

import { updateFps, updateHud } from '../ui/hud.js';

/**
 * Starts the perpetual render loop that advances controls, visibility, cache maintenance, and presentation in a stable order.
 * The loop only orchestrates shared controls, camera, renderer, scene, terrain, systems, cache, and compass references; their lifetimes remain owned by the caller.
 */
export function startRenderLoop({ controls, camera, culler, terrain, systems, getBldRange, tileCache, renderer, scene, compass }) {
  let last = performance.now(), frames = 0;
  let lastFrameTime = performance.now();

  /**
   * Executes one animation frame in the required pipeline order: controls, recycle, camera matrix, frustum, terrain, buildings/forest cull, cache evict, render, compass, then HUD.
   * Keeping this sequence explicit prevents culling or overlays from using stale camera state.
   */
  function loop() {
    requestAnimationFrame(loop);
    const tNow = performance.now();
    const dt = Math.min(0.1, (tNow - lastFrameTime) / 1000); // clamp to 100ms to avoid huge jumps after tab-switches
    lastFrameTime = tNow;
    controls.update();
    if (systems.roadtrip) systems.roadtrip.update(dt);
    if (systems.labels) systems.labels.update(camera);
    terrain.recycleAll();

    camera.updateMatrixWorld();
    culler.update(camera);

    terrain.visitRoot();
    systems.buildings.cull({ camera, frustum: culler.frustum, rangeMetres: getBldRange() });
    systems.forest.cull({ camera, frustum: culler.frustum });
    tileCache.evict();
    renderer.render(scene, camera);
    compass.render();

    frames++;
    const now = performance.now();
    if (now - last > 500) {
      updateFps(frames * 1000 / (now - last));
      frames = 0; last = now;
      updateHud({ drawn: terrain.getDrawnCount(), cacheSize: tileCache.size });
    }
  }

  loop();
}
