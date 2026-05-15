/**
 * @file Factories for shared-by-reference uniform bundles used across the terrain,
 * roads, geology, contour, water, and forest materials.
 *
 * CONTRACT — Uniforms returned here are intended to be shared by reference.
 * Mutating a `.value` on any returned uniform must propagate instantly to every
 * material that received the same uniform object at construction time. Do NOT
 * reconstruct these bundles per material; do NOT shallow-clone them. The
 * roads/geology/contour subsystems mutate `.value` in place after their async
 * loaders parse the source binaries, and live rendering depends on every
 * consumer having pointed at the same uniform instance.
 *
 * `aliasRoadUniforms(roadUniforms)` produces a fresh object whose properties
 * point at the same uniform instances as `roadUniforms`. It is the documented
 * way to give a non-terrain material (water, trees, canopy) the road-mask
 * shared state without duplicating the property list nine times.
 */

/**
 * Builds the shared road overlay uniform bundle including 1x1 dummy textures so materials can be constructed before osm.bin parses. The roads subsystem later swaps `.value` references on the same uniform objects to publish the real grid.
 */
export function createSharedRoadUniforms(THREE) {
  const dummyGrid = new THREE.DataTexture(new Float32Array([0, 0]), 1, 1, THREE.RGFormat, THREE.FloatType);
  dummyGrid.minFilter = THREE.NearestFilter;
  dummyGrid.magFilter = THREE.NearestFilter;
  dummyGrid.needsUpdate = true;
  const dummyRefs = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  dummyRefs.minFilter = THREE.NearestFilter;
  dummyRefs.magFilter = THREE.NearestFilter;
  dummyRefs.needsUpdate = true;
  const dummyCls = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  dummyCls.minFilter = THREE.NearestFilter;
  dummyCls.magFilter = THREE.NearestFilter;
  dummyCls.needsUpdate = true;
  return {
    uRoadGrid:      { value: dummyGrid },
    uRoadRefs:      { value: dummyRefs },
    uRoadCls:       { value: dummyCls },
    uRoadOrigin:    { value: new THREE.Vector2(0, 0) },
    uRoadCell:      { value: 500.0 },
    uRoadGridDims:  { value: new THREE.Vector2(1, 1) },
    uRoadRefsDims: { value: new THREE.Vector2(1, 1) },
    uRoadShow:      { value: 1.0 },
    uRoadReady:     { value: 0.0 },
  };
}

/**
 * Aliases road uniforms into a fresh object whose properties point at the same uniform instances. Materials that do not own the road overlay (trees, canopy, water) use this so their shaders observe live road updates without duplicating the property list at each call site.
 */
export function aliasRoadUniforms(roadUniforms) {
  return {
    uRoadGrid:      roadUniforms.uRoadGrid,
    uRoadRefs:      roadUniforms.uRoadRefs,
    uRoadCls:       roadUniforms.uRoadCls,
    uRoadOrigin:    roadUniforms.uRoadOrigin,
    uRoadCell:      roadUniforms.uRoadCell,
    uRoadGridDims:  roadUniforms.uRoadGridDims,
    uRoadRefsDims:  roadUniforms.uRoadRefsDims,
    uRoadShow:      roadUniforms.uRoadShow,
    uRoadReady:     roadUniforms.uRoadReady,
  };
}

/**
 * Builds the shared geology overlay uniform bundle including 1x1 dummy index/palette textures. Bedrock and quaternary loaders later swap `.value` on the same uniform objects to publish their parsed rasters and palettes.
 */
export function createSharedGeologyUniforms(THREE) {
  const dummyGeoTex = new THREE.DataTexture(new Uint8Array([0, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  dummyGeoTex.needsUpdate = true;
  const dummyPalTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  dummyPalTex.needsUpdate = true;
  return {
    uBedTex:      { value: dummyGeoTex },
    uBedPalette:  { value: dummyPalTex },
    uBedShow:     { value: 0.0 },
    uBedPalN:     { value: 1.0 },
    uQuatTex:     { value: dummyGeoTex },
    uQuatPalette: { value: dummyPalTex },
    uQuatShow:    { value: 0.0 },
    uQuatPalN:    { value: 1.0 },
    uGeoBBox:     { value: new THREE.Vector4(0, 0, 1, 1) },
    uGeoOpacity:  { value: 0.6 },
  };
}

/**
 * Builds the shared contour overlay uniform bundle. Sharing matches geology: every terrain material receives the same uniform objects so a UI toggle propagates without rebuilding materials.
 */
export function createSharedContourUniforms(THREE) {
  return {
    uContourShow:      { value: 0.0 },
    uContourInterval:  { value: 100.0 },
    uContourBoldEvery: { value: 5.0 },
    uContourColor:     { value: new THREE.Color(0x2a1a08) },
    uContourBoldColor: { value: new THREE.Color(0x140803) },
    uContourOpacity:   { value: 0.75 },
  };
}
