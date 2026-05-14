import { readMagic } from '../core/binary.js';

export const GEOLOGY_RASTER_CONTRACT = Object.freeze({
  bedrockMagic: 'BRR1',
  quaternaryMagic: 'QRR1',
  units: 'metres',
  headerBytes: 32,
  idType: 'uint16',
});

export function parseGeologyRasterBuffer(buffer, expectedMagic) {
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (magic !== expectedMagic) {
    throw new Error(`bad magic ${magic}, expected ${expectedMagic}`);
  }
  const version = view.getUint32(4, true);
  const w = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  const xMin = view.getFloat32(16, true);
  const yMin = view.getFloat32(20, true);
  const xMax = view.getFloat32(24, true);
  const yMax = view.getFloat32(28, true);
  const ids = new Uint16Array(buffer, GEOLOGY_RASTER_CONTRACT.headerBytes, w * h);
  const rgBytes = new Uint8Array(buffer, GEOLOGY_RASTER_CONTRACT.headerBytes, w * h * 2);
  return { magic, version, w, h, ids, rgBytes, bbox: { xMin, yMin, xMax, yMax } };
}
