/**
 * @file Shader strings for the tile-edge outline overlay that traces the perimeter of each rendered terrain tile.
 *
 * The vertex shader samples the same height texture as the terrain material, so the outline follows the displaced
 * surface exactly. The fragment shader emits a single bright colour without lighting or fog so the lines stay
 * legible at any distance.
 */

/**
 * Vertex shader for tile-edge outlines. Expects the same uHeight / uOriginXY / uTileSize / uExag /
 * uUVScale / uUVOffset uniforms as the terrain material and is intended to share that uniform object
 * by reference so the outline always tracks the tile mesh.
 */
export const vertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform sampler2D uHeight;
uniform vec2 uOriginXY;
uniform float uTileSize;
uniform float uExag;
uniform vec2 uUVScale;
uniform vec2 uUVOffset;
float decode(vec3 c){ return -10000.0 + (c.r*255.0*65536.0 + c.g*255.0*256.0 + c.b*255.0)*0.1; }
void main(){
  vec2 sUv = uUVOffset + uv * uUVScale;
  vec2 tuv = vec2(sUv.x, 1.0 - sUv.y);
  float h = max(decode(texture2D(uHeight, tuv).rgb), 0.0) * uExag;
  vec2 wxy = uOriginXY + uv * uTileSize;
  // Tiny upward bias keeps the outline above the terrain surface even without polygon offset.
  gl_Position = projectionMatrix * viewMatrix * vec4(wxy, h + 0.5, 1.0);
  #include <logdepthbuf_vertex>
}
`;

/**
 * Fragment shader for tile-edge outlines. Emits a bright yellow colour with no lighting, overlays or fog
 * so the wireframe stays visible against any terrain shading.
 */
export const fragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(1.0, 0.85, 0.10, 1.0);
}
`;
