export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

export function tileUrl(z, x, y) {
  return `tiles/${z}/${x}/${y}.png`;
}

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
