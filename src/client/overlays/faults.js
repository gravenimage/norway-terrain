import { readMagic } from '../core/binary.js';

export const FAULT_CONTRACT = Object.freeze({
  magic: 'FLT1',
  units: 'metres',
  classes: 'type byte followed by line segment vertices',
});

const DEFAULT_FAULT_EXAGGERATION = 1.4;

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

export function createFaultSystem({ THREE, scene, faultsGroup, getExaggeration = () => DEFAULT_FAULT_EXAGGERATION }) {
  void scene;
  const faultMat = THREE.LineBasicMaterial
    ? new THREE.LineBasicMaterial({ color: 0xe040c0, transparent: true, opacity: 0.95, depthWrite: false })
    : null;

  return {
    async load() {
      let buf;
      try {
        const r = await fetch('faults.bin');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        buf = await r.arrayBuffer();
      } catch (e) {
        console.warn('faults.bin not loaded:', e.message);
        return;
      }
      let parsed;
      try {
        parsed = parseFaultsBuffer(buf);
      } catch (e) {
        console.warn('bad faults magic', e.message.replace('bad faults magic ', ''));
        return;
      }
      const exag = getExaggeration();
      for (const { nVerts, verts } of parsed.groups) {
        const positions = new Float32Array(verts.length);
        for (let i = 0; i < nVerts; i += 1) {
          positions[i * 3] = verts[i * 3];
          positions[i * 3 + 1] = verts[i * 3 + 1];
          positions[i * 3 + 2] = verts[i * 3 + 2] * exag + 1.0 * exag;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const seg = new THREE.LineSegments(geo, faultMat);
        seg.frustumCulled = false;
        seg.renderOrder = 12;
        faultsGroup.add(seg);
      }
      console.log(`faults: ${parsed.totalSegs} segments`);
    },
    setVisible(visible) {
      faultsGroup.visible = visible;
    },
  };
}
