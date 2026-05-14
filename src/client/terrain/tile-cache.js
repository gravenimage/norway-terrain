import { tileKey, tileUrl } from './tile-pyramid.js';

export function createTileCache({ THREE, maxEntries = 400 }) {
  const tileCache = new Map();
  const MAX_CACHE = maxEntries;
  const loader = new THREE.TextureLoader();

  function getTile(z, x, y) {
    const k = tileKey(z, x, y);
    let t = tileCache.get(k);
    if (t) { t.lastUsed = performance.now(); return t; }
    t = { tex: null, lastUsed: performance.now(), loading: true, missing: false };
    tileCache.set(k, t);
    loader.load(tileUrl(z, x, y), tex => {
      tex.flipY = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      t.tex = tex; t.loading = false;
    }, undefined, () => { t.loading = false; t.missing = true; });
    return t;
  }

  function evictCache() {
    if (tileCache.size <= MAX_CACHE) return;
    const arr = [...tileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = arr.slice(0, tileCache.size - MAX_CACHE);
    for (const [k, v] of drop) {
      if (v.tex) v.tex.dispose();
      tileCache.delete(k);
    }
  }

  return {
    tileCache,
    getTile,
    evict: evictCache,
    get size() { return tileCache.size; },
  };
}
