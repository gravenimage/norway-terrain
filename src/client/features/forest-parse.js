/**
 * @file Pure TRE1/TRE2 forest binary parser. Extracted from features/forest.js
 * so a Web Worker can import it without the THREE-dependent system factory.
 */

import { readMagic } from '../core/binary.js';

export const FOREST_CONTRACT = Object.freeze({
  magic: Object.freeze(['TRE1', 'TRE2']),
  units: 'metres',
  tre1RecordBytes: 20,
  tre2RecordBytes: 24,
  cellSizeMetres: 4000,
  cornerDeltaUnitMetres: 0.5,
});

/**
 * Parse the TRE1/TRE2 forest seed binary without depending on THREE.
 * Layout is magic TRE1 or TRE2, uint32 record count, then 20-byte TRE1 records
 * or 24-byte TRE2 records with float32 cx/cy/bz/height, uint8 species/jitters,
 * and optional int8 corner deltas scaled by 0.5 m. Returns a plain object with
 * magic, recordBytes, typed-array columns, and 4000 m cell bins of seed indices.
 */
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
