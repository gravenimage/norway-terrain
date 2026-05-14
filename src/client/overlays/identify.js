import * as THREE from 'three';

function terrainObjects(scene) {
  return scene.children.filter((object) => object.isMesh && object.material?.uniforms?.uHeight);
}

export function attachIdentifyHandlers({ canvas, camera, scene, geologySystem, showPanel }) {
  let downX = 0;
  let downY = 0;
  let downT = 0;

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
  };

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

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
  };
}
