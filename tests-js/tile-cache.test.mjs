/**
 * @file Verifies the tile cache LRU policy and the per-entry texture dispose contract. The Three.js TextureLoader is stubbed so the tests run without a browser or GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Builds a Three.js stub that satisfies tile-cache.js: a TextureLoader whose load() resolves synchronously with a recordable texture, plus the filter and colour-space constants the cache writes onto each loaded texture.
 */
function makeThreeStub() {
  const created = [];
  /**
   * Records every dispose() call so tests can assert evicted textures are freed.
   */
  function makeTexture() {
    const tex = { disposed: false, dispose() { tex.disposed = true; } };
    created.push(tex);
    return tex;
  }
  return {
    LinearFilter: 'linear',
    ClampToEdgeWrapping: 'clamp',
    NoColorSpace: 'srgb-linear',
    TextureLoader: class {
      load(_url, onLoad) {
        const tex = makeTexture();
        onLoad(tex);
        return tex;
      }
    },
    _created: created,
  };
}

test('tile-cache evicts least-recently-used entries to enforce maxEntries', async () => {
  const { createTileCache } = await import('../src/client/terrain/tile-cache.js');
  const THREE = makeThreeStub();
  const cache = createTileCache({ THREE, maxEntries: 3 });

  cache.getTile(0, 0, 0);
  cache.getTile(0, 1, 0);
  cache.getTile(0, 0, 1);
  cache.getTile(0, 1, 1);
  assert.equal(cache.size, 4);

  cache.evict();
  assert.equal(cache.size, 3);
  assert.equal(THREE._created.filter((t) => t.disposed).length, 1);
});

test('tile-cache touches lastUsed on repeat access so hot entries survive eviction', async () => {
  const { createTileCache } = await import('../src/client/terrain/tile-cache.js');
  const THREE = makeThreeStub();
  const cache = createTileCache({ THREE, maxEntries: 2 });

  cache.getTile(0, 0, 0);
  await new Promise((r) => setTimeout(r, 2));
  cache.getTile(0, 1, 0);
  await new Promise((r) => setTimeout(r, 2));
  // Re-access the first entry so it becomes most recent.
  cache.getTile(0, 0, 0);
  await new Promise((r) => setTimeout(r, 2));
  cache.getTile(0, 1, 1);

  cache.evict();
  assert.equal(cache.size, 2);
  // The (0,1,0) entry should have been evicted, not (0,0,0).
  assert.equal(THREE._created[1].disposed, true);
  assert.equal(THREE._created[0].disposed, false);
});
