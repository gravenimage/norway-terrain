/**
 * @file Owns reusable terrain mesh instances so LOD traversal can redraw tiles without allocating meshes every frame.
 *
 * Each pool entry pairs a tile mesh with an optional LineSegments outline that shares the same per-tile uniforms.
 * The outline is parented to the mesh, so transform updates in drawTile() propagate to both at once and the
 * outline goes back into the pool together with its mesh on recycleAll().
 */

/**
 * Creates the mesh lifecycle boundary for terrain rendering, separating mesh allocation from per-frame LOD decisions.
 * The intended frame order is scene.remove during recycle, return-to-pool, reacquire for visible tiles, then scene.add.
 *
 * If makeEdgeMaterial and edgeGeometry are supplied, every pool entry also owns a LineSegments outline whose
 * material shares uniforms with the mesh material. setEdgesVisible(visible) toggles the outlines without
 * altering the rest of the pool lifecycle.
 */
export function createTerrainMeshPool({
  THREE,
  scene,
  makeMaterial,
  initialGeometry,
  makeEdgeMaterial = null,
  edgeGeometry = null,
}) {
  let plane = initialGeometry;
  let perimeter = edgeGeometry;
  let edgesVisible = false;
  const meshPool = [];
  const meshUsed = [];

  /**
   * Attaches a tile-edge outline to a freshly created mesh, sharing its uniforms by reference so per-tile
   * updates in drawTile() propagate to the outline without extra work. The outline is parented to the mesh
   * so it inherits position and scale automatically and is recycled alongside its parent.
   */
  function attachEdge(mesh) {
    if (!makeEdgeMaterial || !perimeter) return null;
    const line = new THREE.LineSegments(perimeter, makeEdgeMaterial(mesh.material.uniforms));
    line.frustumCulled = false;
    line.visible = edgesVisible;
    mesh.add(line);
    return line;
  }

  /**
   * Reuses an idle mesh or grows the pool when visibility exceeds previous demand.
   * Every acquired mesh is marked used and added to the scene so recycleAll can later remove and return it.
   * Pooled meshes with stale geometry are rebound to the current plane and perimeter so geometry rebuilds
   * survive without forcing pool turnover.
   */
  function acquire() {
    let m = meshPool.pop();
    if (!m) {
      m = new THREE.Mesh(plane, makeMaterial());
      m.frustumCulled = false;
      m.userData.edgeLine = attachEdge(m);
    } else {
      m.geometry = plane;
      if (m.userData.edgeLine && perimeter) {
        m.userData.edgeLine.geometry = perimeter;
        m.userData.edgeLine.visible = edgesVisible;
      }
    }
    meshUsed.push(m);
    scene.add(m);
    return m;
  }

  /**
   * Ends a frame by removing all drawn meshes from the scene and making them available for the next traversal.
   * This preserves the recycle lifecycle: scene.remove, return-to-pool, reacquire, scene.add.
   * Outlines stay parented to the mesh so they are removed and re-added in lockstep.
   */
  function recycleAll() {
    for (const m of meshUsed) { scene.remove(m); meshPool.push(m); }
    meshUsed.length = 0;
  }

  /**
   * Updates the geometries future acquisitions should use after tessellation changes.
   * Existing pooled meshes are rebound on acquire so the pool can survive plane rebuilds.
   * The perimeter argument is optional; passing it keeps tile-edge outlines aligned with the new segment count.
   */
  function setGeometry(geom, edgeGeom) {
    plane = geom;
    if (edgeGeom) perimeter = edgeGeom;
  }

  /**
   * Toggles tile-edge outline visibility across every pool entry, including idle ones.
   * The state is also remembered so meshes acquired or grown later default to the same visibility.
   */
  function setEdgesVisible(visible) {
    edgesVisible = Boolean(visible);
    for (const m of meshUsed) {
      if (m.userData.edgeLine) m.userData.edgeLine.visible = edgesVisible;
    }
    for (const m of meshPool) {
      if (m.userData.edgeLine) m.userData.edgeLine.visible = edgesVisible;
    }
  }

  return {
    acquire,
    recycleAll,
    setGeometry,
    setEdgesVisible,
    /**
     * Reports meshes currently checked out for the active frame, not total pool capacity.
     */
    get usedCount() { return meshUsed.length; },
  };
}
