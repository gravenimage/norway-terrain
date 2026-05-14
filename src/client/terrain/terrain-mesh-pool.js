export function createTerrainMeshPool({ THREE, scene, makeMaterial, initialGeometry }) {
  let plane = initialGeometry;
  const meshPool = [];
  const meshUsed = [];

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

  function recycleAll() {
    for (const m of meshUsed) { scene.remove(m); meshPool.push(m); }
    meshUsed.length = 0;
  }

  function setGeometry(geom) {
    plane = geom;
  }

  return {
    acquire,
    recycleAll,
    setGeometry,
    get usedCount() { return meshUsed.length; },
  };
}
