/**
 * @file Loads terrain height textures and bounds memory growth with an LRU tile cache.
 */

import { tileKey, tileUrl } from './tile-pyramid.js';

/**
 * Creates a height texture cache with a fixed maximum entry count to avoid unbounded GPU memory use.
 * Cache entries are keyed by tile pyramid coordinate and evicted by least-recent access when size exceeds maxEntries.
 */
export function createTileCache({ THREE, maxEntries = 400 }) {
  const tileCache = new Map();
  const MAX_CACHE = maxEntries;
  const loader = new THREE.TextureLoader();

  /**
   * Returns the cache record for a tile, starting an async texture load on first request.
   * Textures keep flipY disabled because the terrain shader owns the height texture Y-flip convention.
   */
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

  /**
   * Enforces the cache size limit by disposing the least-recently-used textures first.
   * Entries are sorted by lastUsed so the oldest excess records are removed until MAX_CACHE is restored.
   */
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
    /**
     * Exposes explicit LRU maintenance so callers can choose when eviction work occurs.
     */
    evict: evictCache,
    /**
     * Reports total cached records, including loading or missing placeholders, for cache budget checks.
     */
    get size() { return tileCache.size; },
  };
}
