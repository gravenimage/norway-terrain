/**
 * @file Shader string templates for close tree meshes and distant billboards with fogged alpha fades.
 */

import { roadMaskUniformsGLSL, roadMaskFunctionGLSL } from './road-mask-glsl.js';
import { fogFadeUniformsGLSL, sunWrapLightingGLSL, fogBlendGLSL, distanceFadeAlphaGLSL } from './shared-chunks.js';

/**
 * Vertex shader for instanced tree meshes that scales canopy and trunk parts around terrain-anchored positions.
 * Expects aPart, iPos, iSize, iRot, iCanopyA, iCanopyB attributes plus uExag and uExtraLift uniforms.
 */
export const treeVertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aPart;
attribute vec3 iPos;
attribute vec2 iSize;        // x = base radius (m), y = height (m)
attribute float iRot;        // random yaw
attribute vec3 iCanopyA;     // lower / outer colour
attribute vec3 iCanopyB;     // upper colour
uniform float uExag;
uniform float uExtraLift;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
void main(){
  vec3 p = position;
  // canopy parts (0,1) scale by (radius, radius, height); trunk (2) scales tightly
  if (aPart < 1.5) {
    p.x *= iSize.x;
    p.y *= iSize.x;
    p.z *= iSize.y;
  } else {
    p.x *= iSize.x * 0.18;
    p.y *= iSize.x * 0.18;
    p.z *= iSize.y * 0.18;
  }
  float c = cos(iRot), s = sin(iRot);
  vec2 r = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
  p.x = r.x; p.y = r.y;
  p += iPos;
  // baseZ is already a real terrain elevation; lift it by exag (terrain is exaggerated, so trees should sit on top)
  p.z = (iPos.z) * uExag + (p.z - iPos.z) + uExtraLift;
  vec3 N = normal;
  vec2 nr = vec2(c*N.x - s*N.y, s*N.x + c*N.y);
  N = normalize(vec3(nr, N.z));
  vNormal = N;
  if (aPart < 0.5)      vColor = iCanopyA;       // lower skirt
  else if (aPart < 1.5) vColor = iCanopyB;       // upper spike
  else                  vColor = vec3(0.27, 0.18, 0.10); // trunk
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;

/**
 * Fragment shader for close tree meshes with wrapped sun lighting, fog, and distance fade.
 * Expects uSun, uFogColor, uFogNear/uFogFar, and uFadeNear/uFadeFar uniforms shared with feature materials.
 */
export const treeFragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
${fogFadeUniformsGLSL}
${roadMaskUniformsGLSL}
${roadMaskFunctionGLSL}
void main(){
  #include <logdepthbuf_fragment>
  if (roadFootprintHalfWidth(vWorld.xy, 0.5) >= 0.0) discard;
  vec3 N = normalize(vNormal);
  float diff = clamp(dot(N, normalize(uSun)), 0.0, 1.0);
  ${sunWrapLightingGLSL({ low: 0.35, span: 0.80 })}
  vec3 col = vColor * wrap;
  float dist = length(vWorld - cameraPosition);
  ${fogBlendGLSL}
  ${distanceFadeAlphaGLSL}
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;

/**
 * Vertex shader for distant tree billboards that rotate around Z to face the camera while staying upright.
 * Expects aQuad, iPos, iSize, iCanopyA, iCanopyB attributes plus uExag and uExtraLift uniforms.
 */
export const billboardVertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aQuad;
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec3 iCanopyA;
attribute vec3 iCanopyB;
uniform float uExag;
uniform float uExtraLift;
varying vec3 vColor;
varying vec3 vWorld;
varying vec2 vQuad;
void main(){
  // Tree base in world space (Z-up)
  vec3 base = vec3(iPos.x, iPos.y, iPos.z * uExag + uExtraLift);
  // Camera-facing horizontal right vector (rotation about Z only -> trees stay vertical)
  vec3 toCam = cameraPosition - base;
  toCam.z = 0.0;
  vec3 right = vec3(-1.0, 0.0, 0.0);
  float L = length(toCam);
  if (L > 1e-3) {
    vec3 fwd = toCam / L;
    right = normalize(vec3(-fwd.y, fwd.x, 0.0)); // perpendicular to fwd, in horizontal plane
  }
  // Width tapers from full at base to 0.30 at top -> conical silhouette
  float w = iSize.x * 1.30 * (1.0 - aQuad.y * 0.70);
  float h = iSize.y * 1.05;
  vec3 world = base + right * aQuad.x * w + vec3(0.0, 0.0, aQuad.y * h);
  vColor = mix(iCanopyA, iCanopyB, aQuad.y);
  vWorld = world;
  vQuad = aQuad;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
}`;

/**
 * Fragment shader for tree billboards that applies a soft conical alpha mask, top lighting, fog, and distance fade.
 * Expects uSun, uFogColor, uFogNear/uFogFar, and uFadeNear/uFadeFar uniforms for consistent impostor blending.
 */
export const billboardFragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying vec3 vWorld;
varying vec2 vQuad;
${fogFadeUniformsGLSL}
${roadMaskUniformsGLSL}
${roadMaskFunctionGLSL}
void main(){
  #include <logdepthbuf_fragment>
  if (roadFootprintHalfWidth(vWorld.xy, 0.5) >= 0.0) discard;
  // soft conical alpha mask: opaque in centre, fading at outer edge
  float u = abs(vQuad.x);
  float taper = 1.0 - vQuad.y * 0.80; // matches geometry taper
  float r = u / max(0.05, taper);
  float mask = 1.0 - smoothstep(0.78, 1.0, r);
  if (mask < 0.05) discard;
  // simple top-lit shading
  float light = 0.55 + 0.55 * vQuad.y;
  vec3 col = vColor * light;
  float dist = length(vWorld - cameraPosition);
  ${fogBlendGLSL}
  float alpha = mask * (1.0 - smoothstep(uFadeNear, uFadeFar, dist));
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(col, alpha);
}`;
