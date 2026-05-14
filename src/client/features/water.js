import { assertMagic } from '../core/binary.js';

export const WATER_CONTRACT = Object.freeze({
  magic: 'WATR',
  units: 'metres',
  indexType: 'uint16',
});

export function parseWaterBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, WATER_CONTRACT.magic);
  const version = view.getUint32(4, true);
  const nCells = view.getUint32(8, true);
  let off = 12;
  let totalTris = 0;
  const cells = [];
  for (let i = 0; i < nCells; i += 1) {
    const kx = view.getInt32(off, true); off += 4;
    const ky = view.getInt32(off, true); off += 4;
    const cx = view.getFloat32(off, true); off += 4;
    const cy = view.getFloat32(off, true); off += 4;
    const czMin = view.getFloat32(off, true); off += 4;
    const czMax = view.getFloat32(off, true); off += 4;
    const radius = view.getFloat32(off, true); off += 4;
    const nV = view.getUint32(off, true); off += 4;
    const nT = view.getUint32(off, true); off += 4;
    const verts = new Float32Array(buffer, off, nV * 3).slice();
    off += nV * 12;
    const indices = new Uint16Array(buffer, off, nT * 3).slice();
    off += nT * 6;
    if ((nT * 3) & 1) off += 2;
    cells.push({ kx, ky, cx, cy, czMin, czMax, radius, nV, nT, verts, indices });
    totalTris += nT;
  }
  return { version, nCells, cells, totalTris };
}

export function createWaterSystem({ THREE, scene, waterUniforms, waterMaterial }) {
  const waterGroup = THREE.Group ? new THREE.Group() : { add() {} };
  const waterCells = [];
  if (scene && scene.add) scene.add(waterGroup);

  return {
    async load() {
      try {
        const ab = await (await fetch('water.bin')).arrayBuffer();
        const parsed = parseWaterBuffer(ab);
        for (const { kx, ky, cx, cy, czMin, czMax, radius, verts, indices } of parsed.cells) {
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
          geom.setIndex(new THREE.BufferAttribute(indices, 1));
          const mesh = new THREE.Mesh(geom, waterMaterial);
          mesh.frustumCulled = false;
          mesh.renderOrder = 0;
          waterGroup.add(mesh);
          waterCells.push({ mesh, cx, cy, czMin, czMax, radius, kx, ky });
        }
        document.getElementById('hud').insertAdjacentHTML('beforeend',
          `<br>water: ${parsed.nCells} cells, ${parsed.totalTris.toLocaleString()} tris`);
      } catch (e) {
        console.warn('water.bin not loaded:', e);
      }
    },
    setExaggeration(value) {
      waterUniforms.uExag.value = value;
    },
  };
}
