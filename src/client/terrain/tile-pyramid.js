export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

export function tileUrl(z, x, y) {
  return `tiles/${z}/${x}/${y}.png`;
}

export function tileBounds(meta, z, x, y) {
  const size = meta.size / (2 ** z);
  const x0 = meta.x0 + x * size;
  const y0 = meta.y0 + y * size;
  return { x0, y0, x1: x0 + size, y1: y0 + size, size };
}
