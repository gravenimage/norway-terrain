/**
 * @file Owns reusable terrain mesh instances so LOD traversal can redraw tiles without allocating meshes every frame.
 */

/**
 * Creates the mesh lifecycle boundary for terrain rendering, separating mesh allocation from per-frame LOD decisions.
 * The intended frame order is scene.remove during recycle, return-to-pool, reacquire for visible tiles, then scene.add.
 */
export function createTerrainMeshPool({ THREE, scene, makeMaterial, initialGeometry }) {
  let plane = initialGeometry;
  const meshPool = [];
  const meshUsed = [];

  /**
   * Reuses an idle mesh or grows the pool when visibility exceeds previous demand.
   * Every acquired mesh is marked used and added to the scene so recycleAll can later remove and return it.
   */
  function acquire() {
    let m = meshPool.pop();
    if (!m) {
      m = new THREE.Mesh(plane, makeMaterial());
      m.frustumCulled = false;
    } else {
      m.geometry = plane;
    }
    meshUsed.push(m);
    scene.add(m);
    return m;
  }

  /**
   * Ends a frame by removing all drawn meshes from the scene and making them available for the next traversal.
   * This preserves the recycle lifecycle: scene.remove, return-to-pool, reacquire, scene.add.
   */
  function recycleAll() {
    for (const m of meshUsed) { scene.remove(m); meshPool.push(m); }
    meshUsed.length = 0;
  }

  /**
   * Updates the geometry future acquisitions should use after tessellation changes.
   * Existing pooled meshes are rebound on acquire so the pool can survive plane rebuilds.
   */
  function setGeometry(geom) {
    plane = geom;
  }

  return {
    acquire,
    recycleAll,
    setGeometry,
    /**
     * Reports meshes currently checked out for the active frame, not total pool capacity.
     */
    get usedCount() { return meshUsed.length; },
  };
}
