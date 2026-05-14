/**
 * @file Owns conversion between source-world coordinates and the viewer's centered scene space. The transform preserves the metadata root as the invariant shared by terrain, overlays, and identify lookups.
 */

/**
 * Builds the coordinate adapter for one terrain dataset from metadata aliases. The returned object exposes immutable root values plus conversion methods that keep all rendered systems centred on the same origin.
 */
export function createWorldTransform(meta) {
  const rootX = meta.rootX ?? meta.x0;
  const rootY = meta.rootY ?? meta.y0;
  const rootSize = meta.rootSize ?? meta.size;
  const centerX = rootX + rootSize / 2;
  const centerY = rootY + rootSize / 2;

  return {
    rootX,
    rootY,
    rootSize,
    centerX,
    centerY,
    /**
     * Converts an absolute X coordinate into scene-centred space without changing scale.
     */
    toCenteredX(worldX) {
      return worldX - centerX;
    },
    /**
     * Converts an absolute Y coordinate into scene-centred space without changing scale or flipping axes.
     */
    toCenteredY(worldY) {
      return worldY - centerY;
    },
    /**
     * Restores a scene-centred X coordinate to the dataset's absolute world space.
     */
    toWorldX(centeredX) {
      return centeredX + centerX;
    },
    /**
     * Restores a scene-centred Y coordinate to the dataset's absolute world space, preserving the viewer's Y orientation.
     */
    toWorldY(centeredY) {
      return centeredY + centerY;
    },
  };
}
