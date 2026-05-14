export function restoreCamera({ camera, controls, storageKey }) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.p) || !Array.isArray(s.t)) return false;
    if (s.p.length !== 3 || s.t.length !== 3) return false;
    if (!s.p.every(Number.isFinite) || !s.t.every(Number.isFinite)) return false;
    camera.position.fromArray(s.p);
    controls.target.fromArray(s.t);
    camera.updateMatrixWorld();
    controls.update();
    return true;
  } catch (e) { return false; }
}

export function saveCamera({ camera, controls, storageKey }) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      p: camera.position.toArray(),
      t: controls.target.toArray(),
    }));
    return true;
  } catch (e) { return false; }
}
