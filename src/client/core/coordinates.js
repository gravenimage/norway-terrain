export function createWorldTransform(meta) {
  const rootX = meta.x0;
  const rootY = meta.y0;
  const rootSize = meta.size;
  const centerX = rootX + rootSize / 2;
  const centerY = rootY + rootSize / 2;

  return {
    rootX,
    rootY,
    rootSize,
    centerX,
    centerY,
    toCenteredX(worldX) {
      return worldX - centerX;
    },
    toCenteredY(worldY) {
      return worldY - centerY;
    },
    toWorldX(centeredX) {
      return centeredX + centerX;
    },
    toWorldY(centeredY) {
      return centeredY + centerY;
    },
  };
}
