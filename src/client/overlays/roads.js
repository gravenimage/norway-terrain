import { assertMagic, concatFloat32 } from '../core/binary.js';

export const ROAD_CONTRACT = Object.freeze({
  magic: 'OSM2',
  units: 'metres',
  classes: '0..4 roads, 5 kommune boundaries',
});

export function parseRoadsBuffer(buffer) {
  const view = new DataView(buffer);
  assertMagic(view, ROAD_CONTRACT.magic);
  let off = 4;
  const nGroups = view.getUint32(off, true); off += 4;
  const centerX = view.getFloat64(off, true); off += 8;
  const centerY = view.getFloat64(off, true); off += 8;
  let totalSegs = 0;
  let townSegs = 0;
  const segsByClass = [[], [], [], [], []];
  const townGroups = [];

  for (let g = 0; g < nGroups; g += 1) {
    const cls = view.getUint8(off); off += 4;
    const n = view.getUint32(off, true); off += 4;
    const verts = new Float32Array(buffer, off, n * 3);
    off += n * 3 * 4;
    if (cls === 5) {
      townGroups.push({ cls, n, verts });
      townSegs += n / 2;
    } else if (cls >= 0 && cls <= 4) {
      const m = (n / 2) | 0;
      const out = new Float32Array(m * 4);
      for (let k = 0; k < m; k += 1) {
        out[k * 4 + 0] = verts[k * 6 + 0];
        out[k * 4 + 1] = verts[k * 6 + 1];
        out[k * 4 + 2] = verts[k * 6 + 3];
        out[k * 4 + 3] = verts[k * 6 + 4];
      }
      segsByClass[cls] = segsByClass[cls].length
        ? concatFloat32([segsByClass[cls], out])
        : out;
      totalSegs += m;
    }
  }

  return { nGroups, centerX, centerY, segsByClass, townGroups, totalSegs, townSegs };
}
