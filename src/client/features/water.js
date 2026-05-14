/** @file WATR water parser and stateful water scene system. */
import { assertMagic } from '../core/binary.js';

export const WATER_CONTRACT = Object.freeze({
  magic: 'WATR',
  units: 'metres',
  indexType: 'uint16',
});

/**
 * Parse the WATR water mesh binary without depending on THREE.
 * Layout is magic WATR, uint32 version, uint32 cell count, then per cell:
 * int32 kx/ky, float32 center/min/max/radius, uint32 vertex/triangle counts,
 * tightly packed float32 xyz vertices and uint16 triangle indices with optional
 * uint16 padding. Returns a plain object with version, nCells, totalTris, and
 * cells whose verts/indices are sliced typed arrays.
 */
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

/**
 * Create the stateful water renderer. THREE, scene, waterUniforms, and
 * waterMaterial are shared references; this factory owns the waterGroup added
 * to the scene plus the parsed water cell registry. Uniforms are mutated in
 * place, and callers normally invoke load() fire-and-forget.
 */
export function createWaterSystem({ THREE, scene, waterUniforms, waterMaterial }) {
  const waterGroup = THREE.Group ? new THREE.Group() : { add() {} };
  const waterCells = [];
  if (scene && scene.add) scene.add(waterGroup);

  return {
    /**
     * Fire-and-forget load() for water.bin: fetches WATR cells, creates one
     * THREE.BufferGeometry mesh per cell, adds meshes to the owned group, and
     * appends a HUD summary without returning scene objects.
     */
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
    /**
     * Mutate the shared water uniform in place so all water meshes follow the
     * current terrain exaggeration.
     */
    setExaggeration(value) {
      waterUniforms.uExag.value = value;
    },
  };
}
