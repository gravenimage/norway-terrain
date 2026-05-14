import { assertMagic } from '../core/binary.js';

export const BUILDING_CONTRACT = Object.freeze({
  magic: 'BLD1',
  units: 'metres',
  recordBytes: 32,
  cellSizeMetres: 8000,
});

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
