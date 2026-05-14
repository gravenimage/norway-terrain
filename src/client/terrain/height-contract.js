/**
 * @file Defines the terrain height texture contract shared by CPU tile loading and GPU shader sampling.
 * Height PNGs are uploaded with flipY disabled, so shaders intentionally sample with flipped Y to preserve tile addressing invariants.
 */
export const HEIGHT_TEXTURE_CONTRACT = Object.freeze({
  encoding: 'mapbox-rgb',
  units: 'metres',
  shaderSampleY: 'flipped',
  decodedRangeMetres: [-10000, 14835],
  uniforms: ['uHeight', 'uElevMax', 'uExag', 'uTile', 'uSeg'],
});
