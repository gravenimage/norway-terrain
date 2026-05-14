/**
 * @file Maintains the camera frustum used by render systems to skip off-screen content.
 */

/**
 * Creates a reusable frustum and projection matrix pair to avoid per-frame allocations during culling.
 * Callers keep the returned frustum reference stable while update refreshes it from the latest camera matrices.
 */
export function createFrustumCuller(THREE) {
  const frustum = new THREE.Frustum();
  const _projMat = new THREE.Matrix4();

  /**
   * Recomputes the culling frustum from the camera projection and inverse world matrix after camera updates.
   * This must run after camera.updateMatrixWorld so downstream terrain, building, and forest cullers see current planes.
   */
  function update(camera) {
    _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(_projMat);
  }

  return { frustum, update };
}
