import { readMagic } from '../core/binary.js';

export const AMENITIES_CONTRACT = Object.freeze({
  magic: 'AMN1',
  units: 'metres',
  areaHeaderBytes: 8,
  pointRecordBytes: 16,
});

export function parseAmenitiesBuffer(buffer) {
  if (buffer.byteLength < 8) throw new Error('amenities.bin too small');
  const view = new DataView(buffer);
  const magic = readMagic(view, 0, 4);
  if (magic !== AMENITIES_CONTRACT.magic) throw new Error('amenities.bin bad magic ' + magic);

  const nAreas = view.getUint32(4, true);
  let off = 8;
  const areas = [];
  for (let i = 0; i < nAreas; i += 1) {
    const tid = view.getUint16(off, true); off += 2;
    const nv = view.getUint16(off, true); off += 2;
    const baseZ = view.getFloat32(off, true); off += 4;
    const positions = new Float32Array(nv * 3);
    const ring2d = new Array(nv);
    for (let v = 0; v < nv; v += 1) {
      const x = view.getFloat32(off, true);
      const y = view.getFloat32(off + 4, true);
      const z = view.getFloat32(off + 8, true);
      off += 12;
      positions[v * 3 + 0] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      ring2d[v] = [x, y];
    }
    areas.push({ tid, nv, baseZ, positions, ring2d });
  }

  const nPoints = view.getUint32(off, true); off += 4;
  const points = [];
  for (let i = 0; i < nPoints; i += 1) {
    const tid = view.getUint16(off, true);
    const x = view.getFloat32(off + 4, true);
    const y = view.getFloat32(off + 8, true);
    const z = view.getFloat32(off + 12, true);
    off += AMENITIES_CONTRACT.pointRecordBytes;
    points.push({ tid, x, y, z });
  }
  return { nAreas, areas, nPoints, points };
}
