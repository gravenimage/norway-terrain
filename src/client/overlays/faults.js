import { readMagic } from '../core/binary.js';

export const FAULT_CONTRACT = Object.freeze({
  magic: 'FLT1',
  units: 'metres',
  classes: 'type byte followed by line segment vertices',
});

export function parseFaultsBuffer(buffer) {
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (magic !== FAULT_CONTRACT.magic) throw new Error('bad faults magic ' + magic);
  let off = 4;
  const nGroups = view.getUint32(off, true); off += 4;
  let totalSegs = 0;
  const groups = [];
  for (let g = 0; g < nGroups; g += 1) {
    const typeIdx = view.getUint8(off); off += 4;
    const nVerts = view.getUint32(off, true); off += 4;
    const verts = new Float32Array(buffer, off, nVerts * 3);
    off += nVerts * 12;
    groups.push({ typeIdx, nVerts, verts });
    totalSegs += nVerts / 2;
  }
  return { magic, nGroups, groups, totalSegs };
}
