import { readMagic } from '../core/binary.js';

export const AMENITIES_CONTRACT = Object.freeze({
  magic: 'AMN1',
  units: 'metres',
  areaHeaderBytes: 8,
  pointRecordBytes: 16,
});

const AMENITY_AREA_COLORS = [
  [0.32, 0.55, 0.24], // 0 PITCH_GRASS
  [0.55, 0.35, 0.22], // 1 PITCH_HARD
  [0.78, 0.36, 0.22], // 2 TRACK
  [0.86, 0.74, 0.34], // 3 PLAYGROUND
  [0.30, 0.52, 0.24], // 4 PARK
  [0.32, 0.50, 0.22], // 5 GARDEN
  [0.30, 0.62, 0.85], // 6 POOL
  [0.74, 0.66, 0.40], // 7 SCHOOL_YARD
  [0.36, 0.46, 0.30], // 8 CEMETERY
  [0.52, 0.66, 0.28], // 9 GOLF
  [0.58, 0.58, 0.58], //10 STADIUM
];

const _WOOD = [0.55, 0.35, 0.20];
const _DARK = [0.28, 0.18, 0.10];
const _METAL = [0.55, 0.55, 0.58];
const _STONE = [0.58, 0.56, 0.52];
const _SAND = [0.86, 0.76, 0.50];
const _RED = [0.78, 0.22, 0.20];
const _YEL = [0.92, 0.78, 0.20];
const _BLU = [0.25, 0.42, 0.78];

export function parseAmenitiesBuffer(buffer) {
  if (buffer.byteLength < 8) throw new Error('amenities.bin too small');
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (magic !== AMENITIES_CONTRACT.magic) throw new Error('amenities.bin bad magic ' + magic);

  const nAreas = view.getUint32(4, true);
  let off = 8;
  const areas = [];
  for (let i = 0; i < nAreas; i += 1) {
    const tid = view.getUint16(off, true); off += 2;
    const nv = view.getUint16(off, true); off += 2;
    const baseZ = view.getFloat32(off, true); off += 4;
    const positions = new Float32Array(nv * 3);
    const ring2d = new Array(nv);
    for (let v = 0; v < nv; v += 1) {
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      off += 12;
      positions[v * 3 + 0] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      ring2d[v] = [x, y];
    }
    areas.push({ tid, nv, baseZ, positions, ring2d });
  }

  const nPoints = view.getUint32(off, true); off += 4;
  const points = [];
  for (let i = 0; i < nPoints; i += 1) {
    const tid = view.getUint16(off, true);
    const x = view.getFloat32(off + 4, true);
    const y = view.getFloat32(off + 8, true);
    const z = view.getFloat32(off + 12, true);
    off += AMENITIES_CONTRACT.pointRecordBytes;
    points.push({ tid, x, y, z });
  }
  return { nAreas, areas, nPoints, points };
}

function createPropBuilders(THREE, mergeGeometries, baseBuilders) {
  function _propBox(w, l, h, ox, oy, oz, color){
    const g = new THREE.BoxGeometry(w, l, h);
    g.translate(ox, oy, oz + h * 0.5);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  }
  function _propCyl(r, h, ox, oy, oz, color, radial=8){
    const g = new THREE.CylinderGeometry(r, r, h, radial);
    g.rotateX(Math.PI / 2);
    g.translate(ox, oy, oz + h * 0.5);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  }
  function _propSphere(r, ox, oy, oz, color){
    const g = new THREE.SphereGeometry(r, 8, 6);
    g.translate(ox, oy, oz);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  }
  function buildShelterGeom(){
    return mergeGeometries([
      _propCyl(0.07, 2.2, -1.4, -0.9, 0, _DARK),
      _propCyl(0.07, 2.2,  1.4, -0.9, 0, _DARK),
      _propCyl(0.07, 2.2, -1.4,  0.9, 0, _DARK),
      _propCyl(0.07, 2.2,  1.4,  0.9, 0, _DARK),
      _propBox(3.2, 2.2, 0.12, 0, 0, 2.2, [0.45, 0.28, 0.18]),
      _propBox(2.6, 0.30, 0.04, 0, -0.7, 0.42, _WOOD),
    ], false);
  }
  function buildArtworkGeom(){
    return mergeGeometries([
      _propBox(0.6, 0.6, 0.3, 0, 0, 0, _STONE),
      _propCyl(0.18, 2.0, 0, 0, 0.3, _METAL, 12),
      _propSphere(0.32, 0, 0, 2.5, _METAL),
    ], false);
  }
  function buildMemorialGeom(){
    return mergeGeometries([
      _propBox(1.0, 0.4, 0.15, 0, 0, 0, _STONE),
      _propBox(0.8, 0.18, 1.2, 0, 0, 0.15, _STONE),
    ], false);
  }
  function buildSwingGeom(){
    return mergeGeometries([
      _propCyl(0.06, 2.5, -1.2, 0, 0, _METAL),
      _propCyl(0.06, 2.5,  1.2, 0, 0, _METAL),
      _propBox(2.6, 0.10, 0.10, 0, 0, 2.45, _METAL),
      _propBox(0.40, 0.18, 0.05, -0.6, 0, 0.5, _RED),
      _propBox(0.40, 0.18, 0.05,  0.6, 0, 0.5, _BLU),
      _propBox(0.02, 0.02, 1.9, -0.6, -0.07, 0.5, _DARK),
      _propBox(0.02, 0.02, 1.9, -0.6,  0.07, 0.5, _DARK),
      _propBox(0.02, 0.02, 1.9,  0.6, -0.07, 0.5, _DARK),
      _propBox(0.02, 0.02, 1.9,  0.6,  0.07, 0.5, _DARK),
    ], false);
  }
  function buildSlideGeom(){
    return mergeGeometries([
      _propBox(1.2, 1.2, 1.6, 0, 0.6, 0, _WOOD),
      _propBox(0.9, 2.4, 0.10, 0, -0.6, 0.4, _RED),
      _propCyl(0.04, 1.6, -0.5, 1.0, 0, _DARK, 6),
      _propCyl(0.04, 1.6,  0.5, 1.0, 0, _DARK, 6),
    ], false);
  }
  function buildRoundaboutGeom(){
    return mergeGeometries([
      _propCyl(1.4, 0.18, 0, 0, 0, _RED, 16),
      _propCyl(0.08, 0.6, 0, 0, 0.18, _METAL, 8),
    ], false);
  }
  function buildClimbingFrameGeom(){
    const parts = [];
    for (const [x,y] of [[-1,-1],[1,-1],[-1,1],[1,1]]) parts.push(_propCyl(0.05, 2.0, x, y, 0, _METAL, 6));
    parts.push(_propBox(2.0, 0.05, 0.05, 0, -1, 2.0, _METAL));
    parts.push(_propBox(2.0, 0.05, 0.05, 0,  1, 2.0, _METAL));
    parts.push(_propBox(0.05, 2.0, 0.05, -1, 0, 2.0, _METAL));
    parts.push(_propBox(0.05, 2.0, 0.05,  1, 0, 2.0, _METAL));
    parts.push(_propBox(2.0, 0.04, 0.04, 0, 0, 1.0, _METAL));
    parts.push(_propBox(0.04, 2.0, 0.04, 0, 0, 1.0, _METAL));
    return mergeGeometries(parts, false);
  }
  function buildSandpitGeom(){
    return mergeGeometries([
      _propBox(3.0, 3.0, 0.12, 0, 0, 0, _SAND),
      _propBox(3.0, 0.10, 0.18, 0, -1.5, 0, _WOOD),
      _propBox(3.0, 0.10, 0.18, 0,  1.5, 0, _WOOD),
      _propBox(0.10, 3.0, 0.18, -1.5, 0, 0, _WOOD),
      _propBox(0.10, 3.0, 0.18,  1.5, 0, 0, _WOOD),
    ], false);
  }
  function buildSeesawGeom(){
    return mergeGeometries([
      _propCyl(0.10, 0.6, 0, 0, 0, _DARK, 8),
      _propBox(2.4, 0.20, 0.08, 0, 0, 0.60, _WOOD),
      _propBox(0.20, 0.20, 0.10, -1.0, 0, 0.68, _RED),
      _propBox(0.20, 0.20, 0.10,  1.0, 0, 0.68, _BLU),
    ], false);
  }
  function buildSpringyGeom(){
    return mergeGeometries([
      _propCyl(0.06, 0.4, 0, 0, 0, _METAL, 6),
      _propBox(0.6, 0.25, 0.50, 0, 0, 0.4, _YEL),
      _propSphere(0.10, 0, -0.20, 0.85, _RED),
    ], false);
  }
  function buildPgOtherGeom(){
    return mergeGeometries([
      _propBox(0.4, 0.4, 0.4, 0, 0, 0, _YEL),
      _propCyl(0.05, 0.8, 0, 0, 0.4, _METAL, 6),
    ], false);
  }

  return [
    baseBuilders.buildBenchGeom,
    baseBuilders.buildPicnicTableGeom,
    buildShelterGeom,
    buildArtworkGeom,
    buildMemorialGeom,
    baseBuilders.buildLighthouseGeom,
    buildSwingGeom,
    buildSlideGeom,
    buildRoundaboutGeom,
    buildClimbingFrameGeom,
    buildSandpitGeom,
    buildSeesawGeom,
    buildSpringyGeom,
    buildPgOtherGeom,
  ];
}

function _amHash(x, y){
  let h = (Math.floor(x * 31.7) ^ Math.floor(y * 19.3)) >>> 0;
  h = ((h * 0x27d4eb2d) ^ (h >>> 15)) >>> 0;
  return (h & 0xffff) / 65535;
}

export function createAmenitiesSystem({ THREE, scene, amenitiesGroup, amenityAreaUniforms, amenityPropUniforms }) {
  void scene;
  const propsGroup = THREE.Group ? new THREE.Group() : { add() {} };
  if (amenitiesGroup && amenitiesGroup.add) amenitiesGroup.add(propsGroup);

  return {
    async load() {
      let ab;
      try { ab = await (await fetch('amenities.bin')).arrayBuffer(); }
      catch (e) { console.warn('amenities.bin not loaded:', e); return; }
      let parsed;
      try { parsed = parseAmenitiesBuffer(ab); }
      catch (e) { console.warn(e.message); return; }

      const [materials, geometryBuilders, bufferUtils] = await Promise.all([
        import('../rendering/material-factory.js'),
        import('./geometry-builders.js'),
        import('three/addons/utils/BufferGeometryUtils.js'),
      ]);
      const amenityAreaMaterial = materials.createAmenityAreaMaterial(amenityAreaUniforms);
      const amenityPropMaterial = materials.createAmenityPropMaterial(amenityPropUniforms);

      const { nAreas, areas, points } = parsed;
      const areasByType = new Map();
      for (const area of areas){
        const { tid, positions, ring2d } = area;
        const shape = ring2d.map(([x, y]) => new THREE.Vector2(x, y));
        let tris;
        try {
          tris = THREE.ShapeUtils.triangulateShape(shape, []);
        } catch (e) { continue; }
        if (!tris || !tris.length) continue;
        let arr = areasByType.get(tid);
        if (!arr) { arr = []; areasByType.set(tid, arr); }
        arr.push({ positions, tris });
      }

      const RENDER_ORDER = [4, 8, 5, 7, 9, 10, 3, 6, 0, 1, 2];
      for (let r = 0; r < RENDER_ORDER.length; r++){
        const tid = RENDER_ORDER[r];
        const list = areasByType.get(tid);
        if (!list || !list.length) continue;
        let totalV = 0, totalI = 0;
        for (const it of list){ totalV += it.positions.length / 3; totalI += it.tris.length * 3; }
        const positions = new Float32Array(totalV * 3);
        const colors    = new Float32Array(totalV * 3);
        const indices   = (totalV > 65535) ? new Uint32Array(totalI) : new Uint16Array(totalI);
        const col = AMENITY_AREA_COLORS[tid] || [0.5, 0.5, 0.5];
        let vOff = 0, iOff = 0;
        for (const it of list){
          const baseV = vOff;
          const pn = it.positions.length / 3;
          positions.set(it.positions, vOff * 3);
          for (let v = 0; v < pn; v++){
            colors[(vOff+v)*3+0] = col[0];
            colors[(vOff+v)*3+1] = col[1];
            colors[(vOff+v)*3+2] = col[2];
          }
          vOff += pn;
          for (const t of it.tris){
            indices[iOff++] = baseV + t[0];
            indices[iOff++] = baseV + t[1];
            indices[iOff++] = baseV + t[2];
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
        g.setIndex(new THREE.BufferAttribute(indices, 1));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, amenityAreaMaterial);
        mesh.renderOrder = r;
        mesh.frustumCulled = false;
        amenitiesGroup.add(mesh);
      }

      const PROP_BUILDERS = createPropBuilders(THREE, bufferUtils.mergeGeometries, geometryBuilders);
      const buckets = new Array(PROP_BUILDERS.length);
      for (let i = 0; i < PROP_BUILDERS.length; i++) buckets[i] = [];
      for (const { tid, x, y, z } of points){
        if (tid >= 0 && tid < buckets.length) buckets[tid].push(x, y, z);
      }
      let totalProps = 0;
      for (let tid = 0; tid < PROP_BUILDERS.length; tid++){
        const arr = buckets[tid];
        const m = arr.length / 3;
        if (!m) continue;
        const geom = PROP_BUILDERS[tid]();
        const ig = new THREE.InstancedBufferGeometry();
        ig.setAttribute('position', geom.getAttribute('position'));
        ig.setAttribute('normal',   geom.getAttribute('normal'));
        ig.setAttribute('color',    geom.getAttribute('color'));
        if (geom.index) ig.setIndex(geom.index);
        const iPos = new Float32Array(m * 3);
        const iRot = new Float32Array(m);
        const iScale = new Float32Array(m);
        for (let k = 0; k < m; k++){
          const x = arr[k*3+0], y = arr[k*3+1], z = arr[k*3+2];
          iPos[k*3+0] = x; iPos[k*3+1] = y; iPos[k*3+2] = z;
          const hx = _amHash(x, y);
          const hy = _amHash(y, x + 7.3);
          iRot[k] = hx * Math.PI * 2;
          iScale[k] = 0.85 + hy * 0.30;
        }
        ig.setAttribute('iPos',   new THREE.InstancedBufferAttribute(iPos, 3));
        ig.setAttribute('iRot',   new THREE.InstancedBufferAttribute(iRot, 1));
        ig.setAttribute('iScale', new THREE.InstancedBufferAttribute(iScale, 1));
        ig.instanceCount = m;
        const mesh = new THREE.Mesh(ig, amenityPropMaterial);
        mesh.frustumCulled = false;
        propsGroup.add(mesh);
        totalProps += m;
      }
      document.getElementById('hud').insertAdjacentHTML('beforeend',
        `<br>amenities: ${nAreas.toLocaleString()} areas · ${totalProps.toLocaleString()} props`);
    },
    setVisible(visible) {
      amenitiesGroup.visible = visible;
    },
    setExaggeration(value) {
      amenityAreaUniforms.uExag.value = value;
      amenityPropUniforms.uExag.value = value;
    },
  };
}
