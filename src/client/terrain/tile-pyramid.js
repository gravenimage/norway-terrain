/**
 * @file Provides tile pyramid addressing helpers that keep cache keys, URLs, and world bounds consistent.
 */

/**
 * Produces the canonical identity for a terrain tile so independent systems share one cache namespace.
 * Keeping z/x/y formatting stable prevents duplicate loads for the same pyramid node.
 */
export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/**
 * Maps a pyramid coordinate to the static tile asset path expected by the terrain loader.
 * The URL mirrors tileKey ordering so cache entries and network requests remain easy to correlate.
 */
export function tileUrl(z, x, y) {
  return `tiles/${z}/${x}/${y}.png`;
}

/**
 * Converts a pyramid coordinate into source-space bounds for culling, LOD, and mesh placement.
 * Metadata with rootSize/rootY uses top-origin tile rows, while legacy metadata preserves bottom-origin Y math.
 */
export function tileBounds(meta, z, x, y) {
  const rootX = meta.rootX ?? meta.x0;
  const rootY = meta.rootY ?? meta.y0;
  const rootSize = meta.rootSize ?? meta.size;
  const size = rootSize / (2 ** z);
  const x0 = rootX + x * size;
  if (meta.rootSize !== undefined || meta.rootY !== undefined) {
    const y1 = rootY + rootSize - y * size;
    return { x0, y0: y1 - size, x1: x0 + size, y1, size };
  }
  const y0 = rootY + y * size;
  return { x0, y0, x1: x0 + size, y1: y0 + size, size };
}
