/**
 * @file Shared GLSL fragments for sampling the road overlay grid from feature shaders.
 *
 * Roads are drawn inside the terrain fragment shader; features that render in front of terrain (water,
 * canopy, trees) need access to the same grid/refs/cls textures so they can discard fragments that fall
 * on a road footprint and therefore stop occluding the painted road.
 *
 * Usage in a fragment shader:
 *   // before main():
 *   ${roadMaskUniformsGLSL}
 *   ${roadMaskFunctionGLSL}
 *   // inside main(), after vWorld is available:
 *   if (roadFootprintHalfWidth(vWorld.xy, 0.5) >= 0.0) discard;
 *
 * The margin parameter widens the discarded band slightly beyond the painted road half-width so that
 * antialiased edges of the road in the terrain shader still read cleanly without overlay artefacts.
 */

/**
 * Uniform declarations expected by the road mask helper. Bind these by reference from the same
 * roadUniforms object the terrain material uses so a single road update propagates to every consumer.
 */
export const roadMaskUniformsGLSL = String.raw`
uniform sampler2D uRoadGrid;
uniform sampler2D uRoadRefs;
uniform sampler2D uRoadCls;
uniform vec2  uRoadOrigin;
uniform float uRoadCell;
uniform vec2  uRoadGridDims;
uniform vec2  uRoadRefsDims;
uniform float uRoadShow;
uniform float uRoadReady;
`;

/**
 * GLSL helper exposing roadFootprintHalfWidth(p, margin). Returns the class half-width if p falls
 * within (halfW + margin) of the nearest road segment, or -1.0 otherwise. The class half-widths
 * mirror the values used inside the terrain fragment shader so the masks line up pixel-for-pixel.
 */
export const roadMaskFunctionGLSL = String.raw`
vec2 _roadMaskRefUV(float i) {
  float w = uRoadRefsDims.x;
  float h = uRoadRefsDims.y;
  float row = floor(i / w);
  float colF = i - row * w;
  return vec2((colF + 0.5) / w, (row + 0.5) / h);
}
float _roadMaskDistSeg(vec2 p, vec2 a, vec2 b) {
  vec2 d = b - a;
  float L2 = max(dot(d, d), 1e-6);
  float t = clamp(dot(p - a, d) / L2, 0.0, 1.0);
  return length(p - (a + d * t));
}
float roadFootprintHalfWidth(vec2 p, float margin) {
  if (uRoadShow < 0.5 || uRoadReady < 0.5) return -1.0;
  vec2 cf = (p - uRoadOrigin) / uRoadCell;
  vec2 cellF = floor(cf);
  float minDist = 1e9;
  float minClsF = -1.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = cellF + vec2(float(dx), float(dy));
      if (c.x < 0.0 || c.y < 0.0 || c.x >= uRoadGridDims.x || c.y >= uRoadGridDims.y) continue;
      vec2 cellUV = vec2((c.x + 0.5) / uRoadGridDims.x, (c.y + 0.5) / uRoadGridDims.y);
      vec2 hdr = texture2D(uRoadGrid, cellUV).rg;
      float off = hdr.r;
      float cnt = hdr.g;
      for (int k = 0; k < 128; k++) {
        if (float(k) >= cnt) break;
        float ri = off + float(k);
        vec2 ruv = _roadMaskRefUV(ri);
        vec4 s = texture2D(uRoadRefs, ruv);
        float d = _roadMaskDistSeg(p, s.xy, s.zw);
        if (d < minDist) {
          minDist = d;
          minClsF = floor(texture2D(uRoadCls, ruv).r * 255.0 + 0.5);
        }
      }
    }
  }
  if (minClsF < 0.0) return -1.0;
  int cls = int(minClsF);
  float halfW = (cls == 0) ? 6.5 :
                (cls == 1) ? 5.0 :
                (cls == 2) ? 4.0 :
                (cls == 3) ? 3.25 : 2.75;
  return (minDist <= halfW + margin) ? halfW : -1.0;
}
`;
