import { updateFps, updateHud } from '../ui/hud.js';

export function startRenderLoop({ controls, camera, culler, terrain, systems, getBldRange, tileCache, renderer, scene, compass }) {
  let last = performance.now(), frames = 0;

  function loop() {
    requestAnimationFrame(loop);
    controls.update();
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
