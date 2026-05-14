export const HEIGHT_TEXTURE_CONTRACT = Object.freeze({
  encoding: 'mapbox-rgb',
  units: 'metres',
  shaderSampleY: 'flipped',
  decodedRangeMetres: [-10000, 14835],
  uniforms: ['uHeight', 'uElevMax', 'uExag', 'uTile', 'uSeg'],
});
