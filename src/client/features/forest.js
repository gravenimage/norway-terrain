import { readMagic } from '../core/binary.js';
import { parseCanopyBuffer } from './canopy.js';

export const FOREST_CONTRACT = Object.freeze({
  magic: Object.freeze(['TRE1', 'TRE2']),
  units: 'metres',
  tre1RecordBytes: 20,
  tre2RecordBytes: 24,
  cellSizeMetres: 4000,
  cornerDeltaUnitMetres: 0.5,
});

const TREE_PAL = [
  [0.12, 0.22, 0.12], // 0 spruce
  [0.13, 0.22, 0.12], // 1 pine
  [0.13, 0.23, 0.12], // 2 upper pine/birch
  [0.12, 0.21, 0.11], // 3 stunted pine
];
const TREE_PAL_DARK = [
  [0.07, 0.15, 0.08],
  [0.08, 0.15, 0.08],
  [0.08, 0.16, 0.09],
  [0.07, 0.14, 0.07],
];
const TREE_ASPECT = [0.30, 0.36, 0.55, 0.40];

export function parseForestBuffer(buffer) {
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (!FOREST_CONTRACT.magic.includes(magic)) throw new Error('bad magic ' + magic);
  const hasCornerDeltas = magic === 'TRE2';
  const n = view.getUint32(4, true);
  const recordBytes = hasCornerDeltas ? FOREST_CONTRACT.tre2RecordBytes : FOREST_CONTRACT.tre1RecordBytes;
  const records = {
    cx: new Float32Array(n),
    cy: new Float32Array(n),
    bz: new Float32Array(n),
    height: new Float32Array(n),
    species: new Uint8Array(n),
    sizeJitter: new Uint8Array(n),
    colorJitter: new Uint8Array(n),
    d00: new Float32Array(n),
    d10: new Float32Array(n),
    d01: new Float32Array(n),
    d11: new Float32Array(n),
  };
  const bins = new Map();
  const tmp = new DataView(buffer, 8);
  for (let i = 0; i < n; i += 1) {
    const o = i * recordBytes;
    const cx = tmp.getFloat32(o + 0, true);
    const cy = tmp.getFloat32(o + 4, true);
    records.cx[i] = cx;
    records.cy[i] = cy;
    records.bz[i] = tmp.getFloat32(o + 8, true);
    records.height[i] = tmp.getFloat32(o + 12, true);
    records.species[i] = tmp.getUint8(o + 16);
    records.sizeJitter[i] = tmp.getUint8(o + 17);
    records.colorJitter[i] = tmp.getUint8(o + 18);
    if (hasCornerDeltas) {
      records.d00[i] = tmp.getInt8(o + 20) * FOREST_CONTRACT.cornerDeltaUnitMetres;
      records.d10[i] = tmp.getInt8(o + 21) * FOREST_CONTRACT.cornerDeltaUnitMetres;
      records.d01[i] = tmp.getInt8(o + 22) * FOREST_CONTRACT.cornerDeltaUnitMetres;
      records.d11[i] = tmp.getInt8(o + 23) * FOREST_CONTRACT.cornerDeltaUnitMetres;
    }
    const gx = Math.floor(cx / FOREST_CONTRACT.cellSizeMetres);
    const gy = Math.floor(cy / FOREST_CONTRACT.cellSizeMetres);
    const k = gx * 100000 + gy;
    let arr = bins.get(k);
    if (!arr) { arr = []; bins.set(k, arr); }
    arr.push(i);
  }
  return { magic, hasCornerDeltas, n, recordBytes, records, bins };
}

export function createForestSystem({ THREE, scene, treesGroup, canopyGroup, treeUniforms, canopyUniforms, elevationMax = 14835 }) {
  void scene;
  const treeCells = [];
  const canopyCells = [];
  const cellSphere = THREE.Sphere ? new THREE.Sphere() : null;
  const cellCenter = THREE.Vector3 ? new THREE.Vector3() : null;
  let visibleWanted = true;
  let geologyVisible = false;
  let canopyLodLo = canopyUniforms.uFadeNear.value;
  let canopyLodHi = canopyUniforms.uFadeFar.value;
  let canopyRange = canopyUniforms.uRangeFar.value;

  function applyVisibility() {
    const visible = visibleWanted && !geologyVisible;
    treesGroup.visible = visible;
    canopyGroup.visible = visible;
  }

  return {
    async loadTrees() {
      try {
        const [{ makeTreeGeometry }, materials, ab] = await Promise.all([
          import('./geometry-builders.js'),
          import('../rendering/material-factory.js'),
          (await fetch('forest.bin')).arrayBuffer(),
        ]);
        const { n, records, bins } = parseForestBuffer(ab);
        const treeGeom = makeTreeGeometry();
        const treeMaterial = materials.createTreeMaterial(treeUniforms);
        const K_TREES = 16;
        const QUAD_M = 48.0;
        const BASE_SINK = 1.2;
        const jh = (a, b) => {
          let x = (a * 374761393 ^ b * 668265263) | 0;
          x = (x ^ (x >>> 13)) * 1274126177 | 0;
          x = x ^ (x >>> 16);
          return ((x >>> 0) / 0xffffffff) * 2.0 - 1.0;
        };
        let totalCells = 0;
        let totalInstances = 0;
        for (const [, idxArr] of bins){
          const m = idxArr.length;
          if (!m) continue;
          const M = m * K_TREES;
          const iPos       = new Float32Array(M * 3);
          const iSize      = new Float32Array(M * 2);
          const iRot       = new Float32Array(M);
          const iCanopyA   = new Float32Array(M * 3);
          const iCanopyB   = new Float32Array(M * 3);
          let bxMin = Infinity, byMin = Infinity, bxMax = -Infinity, byMax = -Infinity;
          let maxH = 0;
          let wi = 0;
          for (let k = 0; k < m; k++){
            const seedIdx = idxArr[k];
            const cx0 = records.cx[seedIdx];
            const cy0 = records.cy[seedIdx];
            const bz0 = records.bz[seedIdx];
            const h0  = records.height[seedIdx];
            const sp  = records.species[seedIdx];
            const sj  = records.sizeJitter[seedIdx];
            const cj  = records.colorJitter[seedIdx];
            const d00 = records.d00[seedIdx];
            const d10 = records.d10[seedIdx];
            const d01 = records.d01[seedIdx];
            const d11 = records.d11[seedIdx];
            const aspect = TREE_ASPECT[sp] || 0.4;
            const A = TREE_PAL[sp] || TREE_PAL[0];
            const B = TREE_PAL_DARK[sp] || TREE_PAL_DARK[0];
            for (let s = 0; s < K_TREES; s++){
              const sub = K_TREES;
              const nx = Math.ceil(Math.sqrt(sub));
              const sx = s % nx, sy = (s / nx) | 0;
              const baseU = (sx + 0.5) / nx - 0.5;
              const baseV = (sy + 0.5) / nx - 0.5;
              const ru = jh(seedIdx, s * 2 + 1) * (0.5 / nx) * 0.95;
              const rv = jh(seedIdx, s * 2 + 2) * (0.5 / nx) * 0.95;
              let u = baseU + ru;
              let v = baseV + rv;
              const theta = jh(seedIdx, 9991) * Math.PI;
              const ct = Math.cos(theta), st = Math.sin(theta);
              const u2 =  ct * u - st * v;
              const v2 =  st * u + ct * v;
              const offU = jh(seedIdx, 9992) * 0.45;
              const offV = jh(seedIdx, 9993) * 0.45;
              const cx = cx0 + (u2 + offU) * QUAD_M;
              const cy = cy0 + (v2 + offV) * QUAD_M;
              const fu = Math.max(0, Math.min(1, (u2 + offU) + 0.5));
              const fv = Math.max(0, Math.min(1, (v2 + offV) + 0.5));
              const dz = (d00 * (1 - fu) * (1 - fv))
                       + (d10 *      fu  * (1 - fv))
                       + (d01 * (1 - fu) *      fv )
                       + (d11 *      fu  *      fv );
              const rh1 = jh(seedIdx, 100 + s);
              const rh3 = jh(seedIdx, 300 + s);
              const sjF = sj / 255.0 + rh1 * 0.20;
              const rJit = 0.80 + Math.max(0, Math.min(1, sjF)) * 0.35;
              const hJit = 0.85 + Math.max(0, Math.min(1, sjF)) * 0.25;
              const radius = Math.max(0.6, h0 * aspect * rJit);
              const height = Math.max(2.0, h0 * hJit);
              iPos[wi*3+0] = cx;
              iPos[wi*3+1] = cy;
              iPos[wi*3+2] = bz0 + dz - BASE_SINK;
              iSize[wi*2+0] = radius;
              iSize[wi*2+1] = height;
              iRot[wi] = (cj / 255.0 + rh3 * 0.5) * Math.PI * 2.0;
              const jLum = jh(seedIdx, 401 + s) * 0.05;
              const jR   = jh(seedIdx, 411 + s) * 0.025;
              const jG   = jh(seedIdx, 421 + s) * 0.035;
              const jB   = jh(seedIdx, 431 + s) * 0.025;
              iCanopyA[wi*3+0] = Math.max(0.04, Math.min(0.5, A[0] + jLum + jR));
              iCanopyA[wi*3+1] = Math.max(0.04, Math.min(0.5, A[1] + jLum + jG));
              iCanopyA[wi*3+2] = Math.max(0.04, Math.min(0.5, A[2] + jLum + jB));
              iCanopyB[wi*3+0] = Math.max(0.03, Math.min(0.4, B[0] + jLum + jR));
              iCanopyB[wi*3+1] = Math.max(0.03, Math.min(0.4, B[1] + jLum + jG));
              iCanopyB[wi*3+2] = Math.max(0.03, Math.min(0.4, B[2] + jLum + jB));
              if (cx < bxMin) bxMin = cx; if (cy < byMin) byMin = cy;
              if (cx > bxMax) bxMax = cx; if (cy > byMax) byMax = cy;
              if (height > maxH) maxH = height;
              wi++;
            }
          }
          const cellCx = (bxMin + bxMax) / 2, cellCy = (byMin + byMax) / 2;
          const radius = Math.hypot(bxMax - cellCx, byMax - cellCy) + 30;

          const aPos      = new THREE.InstancedBufferAttribute(iPos, 3);
          const aSize     = new THREE.InstancedBufferAttribute(iSize, 2);
          const aRot      = new THREE.InstancedBufferAttribute(iRot, 1);
          const aCanopyA  = new THREE.InstancedBufferAttribute(iCanopyA, 3);
          const aCanopyB  = new THREE.InstancedBufferAttribute(iCanopyB, 3);

          const ig = new THREE.InstancedBufferGeometry();
          ig.setAttribute('position', treeGeom.getAttribute('position'));
          ig.setAttribute('normal',   treeGeom.getAttribute('normal'));
          ig.setAttribute('aPart',    treeGeom.getAttribute('aPart'));
          ig.setAttribute('iPos',     aPos);
          ig.setAttribute('iSize',    aSize);
          ig.setAttribute('iRot',     aRot);
          ig.setAttribute('iCanopyA', aCanopyA);
          ig.setAttribute('iCanopyB', aCanopyB);
          ig.instanceCount = M;
          const mesh = new THREE.Mesh(ig, treeMaterial);
          mesh.frustumCulled = false;
          mesh.renderOrder = 1;
          treesGroup.add(mesh);
          totalInstances += M;
          treeCells.push({ mesh, cx: cellCx, cy: cellCy, radius, maxH, count: m });
          totalCells++;
        }
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>trees: ${totalInstances.toLocaleString()} (×${K_TREES} from ${n.toLocaleString()} seeds) in ${totalCells} cells, < ${(canopyLodHi/1000).toFixed(1)} km`);
      } catch (e) {
        console.warn('forest.bin not loaded:', e);
      }
    },
    async loadCanopy() {
      try {
        const [materials, ab] = await Promise.all([
          import('../rendering/material-factory.js'),
          (await fetch('canopy.bin')).arrayBuffer(),
        ]);
        const canopyMaterial = materials.createCanopyMaterial(canopyUniforms);
        const parsed = parseCanopyBuffer(ab);
        for (const { kx, ky, cx, cy, czMin, czMax, radius, verts, indices } of parsed.cells){
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
          geom.setIndex(new THREE.BufferAttribute(indices, 1));
          const mesh = new THREE.Mesh(geom, canopyMaterial);
          mesh.frustumCulled = false;
          mesh.renderOrder = 1;
          canopyGroup.add(mesh);
          canopyCells.push({ mesh, cx, cy, czMin, czMax, radius, kx, ky });
        }
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>canopy: ${parsed.nCells} cells, ${parsed.totalTris.toLocaleString()} tris`);
      } catch (e) {
        console.warn('canopy.bin not loaded:', e);
      }
    },
    cull({ camera, frustum }) {
      if (!cellCenter || !cellSphere) return;
      const exag = treeUniforms.uExag.value;
      if (!treesGroup.visible){
        for (const c of treeCells){ c.mesh.visible = false; }
      } else {
        for (const c of treeCells){
          cellCenter.set(c.cx, c.cy, elevationMax*exag*0.5);
          cellSphere.center.copy(cellCenter);
          cellSphere.radius = c.radius + elevationMax*exag*0.5 + c.maxH;
          const dist = camera.position.distanceTo(cellCenter);
          const near = dist - c.radius;
          const inFrustumNow = frustum.intersectsSphere(cellSphere);
          c.mesh.visible = inFrustumNow && near < canopyLodHi;
        }
      }
      if (!canopyGroup.visible){
        for (const c of canopyCells){ c.mesh.visible = false; }
        return;
      }
      for (const c of canopyCells){
        const cz = (c.czMin + c.czMax) * 0.5 * exag + 4.0;
        cellCenter.set(c.cx, c.cy, cz);
        cellSphere.center.copy(cellCenter);
        cellSphere.radius = c.radius + (c.czMax - c.czMin) * exag * 0.5 + 18.0;
        const dist = camera.position.distanceTo(cellCenter);
        const near = dist - c.radius;
        const far  = dist + c.radius;
        const inFrustumNow = frustum.intersectsSphere(cellSphere);
        c.mesh.visible = inFrustumNow && far > canopyLodLo && near < canopyRange;
      }
    },
    setVisible(visible) {
      visibleWanted = visible;
      applyVisibility();
    },
    setRange(rangeMetres) {
      canopyRange = rangeMetres;
      canopyUniforms.uRangeFar.value  = canopyRange;
      canopyUniforms.uRangeNear.value = Math.max(canopyRange - 2000, canopyRange * 0.85);
    },
    setLodSwitch(loMetres, hiMetres) {
      canopyLodLo = loMetres;
      canopyLodHi = hiMetres;
      treeUniforms.uFadeNear.value   = canopyLodLo;
      treeUniforms.uFadeFar.value    = canopyLodHi;
      canopyUniforms.uFadeNear.value = canopyLodLo;
      canopyUniforms.uFadeFar.value  = canopyLodHi;
    },
    setExaggeration(value) {
      treeUniforms.uExag.value = value;
      canopyUniforms.uExag.value = value;
    },
    updateForGeology({ bedrockVisible, quaternaryVisible }) {
      geologyVisible = Boolean(bedrockVisible) || Boolean(quaternaryVisible);
      applyVisibility();
    },
  };
}
