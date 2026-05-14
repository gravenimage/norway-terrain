/** @file Pure CANO canopy binary parser for forest canopy mesh cells. */
import { assertMagic } from '../core/binary.js';

export const CANOPY_CONTRACT = Object.freeze({
  magic: 'CANO',
  units: 'metres',
  indexType: 'uint16',
});

/**
 * Parse the CANO canopy mesh binary without depending on THREE.
 * Layout is magic CANO, uint32 version, uint32 cell count, then per cell:
 * int32 kx/ky, float32 center/min/max/radius, uint32 vertex/triangle counts,
 * tightly packed float32 xyz vertices and uint16 triangle indices with optional
 * uint16 padding. Returns a plain object with version, nCells, totalTris, and
 * cells whose verts/indices are sliced typed arrays.
 */
export function parseCanopyBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, CANOPY_CONTRACT.magic);
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
