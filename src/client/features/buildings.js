import { assertMagic } from '../core/binary.js';

export const BUILDING_CONTRACT = Object.freeze({
  magic: 'BLD1',
  units: 'metres',
  recordBytes: 32,
  cellSizeMetres: 8000,
});

const PAL = [
  [0.61,0.16,0.15], // 0 falu red
  [0.93,0.90,0.83], // 1 white
  [0.79,0.63,0.31], // 2 ochre
  [0.83,0.63,0.09], // 3 mustard
  [0.42,0.12,0.09], // 4 dark red
  [0.71,0.69,0.66], // 5 apt grey
  [0.81,0.77,0.68], // 6 apt beige
  [0.85,0.78,0.65], // 7 apt cream
  [0.61,0.59,0.56], // 8 commercial concrete
  [0.76,0.74,0.70], // 9 commercial light
  [0.48,0.47,0.44], //10 commercial grey
  [0.44,0.31,0.17], //11 cabin brown
];

function roofFor(typeIdx, colorIdx){
  if (typeIdx === 0 || typeIdx === 3) return [0.16,0.16,0.18]; // dark slate
  if (typeIdx === 1) return [0.32,0.30,0.28];
  return [0.45,0.45,0.43];
}

export function parseBuildingsBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, BUILDING_CONTRACT.magic);
  const n = view.getUint32(4, true);
  const records = {
    cx: new Float32Array(n),
    cy: new Float32Array(n),
    bz: new Float32Array(n),
    length: new Float32Array(n),
    width: new Float32Array(n),
    height: new Float32Array(n),
    angle: new Float32Array(n),
    type: new Uint8Array(n),
    roof: new Uint8Array(n),
    color: new Uint8Array(n),
  };
  const bins = new Map();
  const tmp = new DataView(buffer, 8);
  for (let i = 0; i < n; i += 1) {
    const o = i * BUILDING_CONTRACT.recordBytes;
    const cx = tmp.getFloat32(o + 0, true);
    const cy = tmp.getFloat32(o + 4, true);
    records.cx[i] = cx;
    records.cy[i] = cy;
    records.bz[i] = tmp.getFloat32(o + 8, true);
    records.length[i] = tmp.getFloat32(o + 12, true);
    records.width[i] = tmp.getFloat32(o + 16, true);
    records.height[i] = tmp.getFloat32(o + 20, true);
    records.angle[i] = tmp.getFloat32(o + 24, true);
    records.type[i] = tmp.getUint8(o + 28);
    records.roof[i] = tmp.getUint8(o + 29);
    records.color[i] = tmp.getUint8(o + 30);

    const gx = Math.floor(cx / BUILDING_CONTRACT.cellSizeMetres);
    const gy = Math.floor(cy / BUILDING_CONTRACT.cellSizeMetres);
    const k = gx * 100000 + gy;
    let arr = bins.get(k);
    if (!arr) { arr = []; bins.set(k, arr); }
    arr.push(i);
  }
  return { n, records, bins };
}

export function createBuildingSystem({ THREE, scene, buildingsGroup, buildingUniforms, buildingMaterial, elevationMax = 14835 }) {
  void scene;
  const buildingCells = [];
  const cellSphere = THREE.Sphere ? new THREE.Sphere() : null;
  const cellCenter = THREE.Vector3 ? new THREE.Vector3() : null;

  return {
    async load() {
      try {
        const [{ makeHouseGeometry }, ab] = await Promise.all([
          import('./geometry-builders.js'),
          (await fetch('buildings.bin')).arrayBuffer(),
        ]);
        const { n, records, bins } = parseBuildingsBuffer(ab);
        const houseGeom = makeHouseGeometry();
        let totalCells = 0;
        for (const [, idxArr] of bins){
          const m = idxArr.length;
          if (!m) continue;
          const iPos = new Float32Array(m * 3);
          const iSize = new Float32Array(m * 3);
          const iRot = new Float32Array(m);
          const iWallColor = new Float32Array(m * 3);
          const iRoofColor = new Float32Array(m * 3);
          const iRoofH = new Float32Array(m);
          let bxMin = Infinity, byMin = Infinity, bxMax = -Infinity, byMax = -Infinity;
          for (let k = 0; k < m; k++){
            const idx = idxArr[k];
            const cx = records.cx[idx];
            const cy = records.cy[idx];
            const bz = records.bz[idx];
            const L  = records.length[idx];
            const W  = records.width[idx];
            const H  = records.height[idx];
            const a  = records.angle[idx];
            const t  = records.type[idx];
            const rf = records.roof[idx];
            const ci = records.color[idx];
            iPos[k*3+0] = cx; iPos[k*3+1] = cy; iPos[k*3+2] = bz;
            iSize[k*3+0] = L; iSize[k*3+1] = W; iSize[k*3+2] = H;
            iRot[k] = a;
            const wc = PAL[ci] || PAL[1];
            iWallColor[k*3+0] = wc[0]; iWallColor[k*3+1] = wc[1]; iWallColor[k*3+2] = wc[2];
            const rc = roofFor(t, ci);
            iRoofColor[k*3+0] = rc[0]; iRoofColor[k*3+1] = rc[1]; iRoofColor[k*3+2] = rc[2];
            let rh = 0;
            if (rf === 1) rh = Math.min(0.55 * W, 4.5);
            else if (rf === 2) rh = Math.min(0.40 * W, 3.5);
            iRoofH[k] = rh;
            if (cx < bxMin) bxMin = cx; if (cy < byMin) byMin = cy;
            if (cx > bxMax) bxMax = cx; if (cy > byMax) byMax = cy;
          }
          const cellCx = (bxMin + bxMax) / 2, cellCy = (byMin + byMax) / 2;
          const radius = Math.hypot(bxMax - cellCx, byMax - cellCy) + 60;
          const ig = new THREE.InstancedBufferGeometry();
          ig.setAttribute('position', houseGeom.getAttribute('position'));
          ig.setAttribute('normal',   houseGeom.getAttribute('normal'));
          ig.setAttribute('aPart',    houseGeom.getAttribute('aPart'));
          ig.setAttribute('iPos',       new THREE.InstancedBufferAttribute(iPos, 3));
          ig.setAttribute('iSize',      new THREE.InstancedBufferAttribute(iSize, 3));
          ig.setAttribute('iRot',       new THREE.InstancedBufferAttribute(iRot, 1));
          ig.setAttribute('iWallColor', new THREE.InstancedBufferAttribute(iWallColor, 3));
          ig.setAttribute('iRoofColor', new THREE.InstancedBufferAttribute(iRoofColor, 3));
          ig.setAttribute('iRoofH',     new THREE.InstancedBufferAttribute(iRoofH, 1));
          ig.instanceCount = m;
          const mesh = new THREE.Mesh(ig, buildingMaterial);
          mesh.frustumCulled = false;
          buildingsGroup.add(mesh);
          buildingCells.push({ mesh, cx: cellCx, cy: cellCy, radius });
          totalCells++;
        }
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>buildings: ${n.toLocaleString()} in ${totalCells} cells`);
      } catch (e) {
        console.warn('buildings.bin not loaded:', e);
      }
    },
    cull({ camera, frustum, rangeMetres }) {
      if (!buildingsGroup.visible || !cellCenter || !cellSphere) return;
      const exag = buildingUniforms.uExag.value;
      for (const cell of buildingCells){
        cellCenter.set(cell.cx, cell.cy, elevationMax * exag * 0.5);
        cellSphere.center.copy(cellCenter);
        cellSphere.radius = cell.radius + elevationMax * exag * 0.5 + 30;
        const dist = camera.position.distanceTo(cellCenter);
        const visible = (dist - cell.radius) < rangeMetres && frustum.intersectsSphere(cellSphere);
        cell.mesh.visible = visible;
      }
    },
    setVisible(visible) {
      buildingsGroup.visible = visible;
    },
    setRange(rangeMetres) {
      buildingUniforms.uFadeFar.value = rangeMetres;
      buildingUniforms.uFadeNear.value = Math.max(rangeMetres - 4000, rangeMetres * 0.7);
    },
    setExaggeration(value) {
      buildingUniforms.uExag.value = value;
    },
  };
}
