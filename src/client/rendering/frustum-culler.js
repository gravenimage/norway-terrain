export function createFrustumCuller(THREE) {
  const frustum = new THREE.Frustum();
  const _projMat = new THREE.Matrix4();

  function update(camera) {
    _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(_projMat);
  }

  return { frustum, update };
}
