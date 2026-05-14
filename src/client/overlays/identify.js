/** @file Wires terrain identify clicks to geology sampling and panel display. */
import * as THREE from 'three';

/** Return terrain meshes that expose height uniforms and can be raycast for identify. */
function terrainObjects(scene) {
  return scene.children.filter((object) => object.isMesh && object.material?.uniforms?.uHeight);
}

/**
 * Attach pointer handlers that identify geology under a simple left click.
 * Uses shared `canvas`, `camera`, and `scene` refs for raycasting, delegates map
 * sampling to `geologySystem`, and calls `showPanel` with screen coordinates and
 * sampled geology info. A click is left-button only, within 4 px of pointer-down,
 * and no longer than 500 ms.
 */
export function attachIdentifyHandlers({ canvas, camera, scene, geologySystem, showPanel }) {
  let downX = 0;
  let downY = 0;
  let downT = 0;

  /** Record the start point/time for candidate left-click identify gestures. */
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
  };

  /** Validate click thresholds, raycast terrain, sample geology, and show details. */
  const onPointerUp = (e) => {
    if (e.button !== 0) return;
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
    if (performance.now() - downT > 500) return;

    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(terrainObjects(scene), false);
    if (!hits.length) return;
    const wx = hits[0].point.x;
    const wy = hits[0].point.y;
    const info = geologySystem.sampleAt(wx, wy);
    if (info === null) return;
    showPanel(e.clientX, e.clientY, info);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  /** Detach the pointer handlers installed by attachIdentifyHandlers. */
  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
  };
}
