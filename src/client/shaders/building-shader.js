/**
 * @file Shader string templates for instanced buildings with separate wall and roof colors plus distance fade.
 */

/**
 * Vertex shader for instanced buildings that sizes, rotates, and places wall and roof geometry in world space.
 * Expects aPart, iPos, iSize, iRot, iWallColor, iRoofColor, iRoofH attributes plus uExag and uExtraLift uniforms.
 */
export const vertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aPart;
attribute vec3 iPos;
attribute vec3 iSize;
attribute float iRot;
attribute vec3 iWallColor;
attribute vec3 iRoofColor;
attribute float iRoofH;
uniform float uExag;
uniform float uExtraLift;
varying vec3 vColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main(){
  vec3 p = position;
  p.x *= iSize.x;
  p.y *= iSize.y;
  if (aPart < 0.5) {
    p.z = p.z * iSize.z;
  } else {
    p.z = iSize.z + (p.z - 1.0) * iRoofH;
  }
  float c = cos(iRot), s = sin(iRot);
  vec2 r = vec2(c*p.x - s*p.y, s*p.x + c*p.y);
  p.x = r.x; p.y = r.y;
  p.x += iPos.x;
  p.y += iPos.y;
  p.z += iPos.z * uExag + uExtraLift;
  vec3 N = normal;
  vec2 nr = vec2(c*N.x - s*N.y, s*N.x + c*N.y);
  N = normalize(vec3(nr, N.z));
  vNormal = N;
  vColor  = (aPart < 0.5) ? iWallColor : iRoofColor;
  vWorld  = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}`;

/**
 * Fragment shader for buildings that applies sun lighting, vertical normal bias, fog, and distance alpha fade.
 * Expects uSun, uFogColor, uFogNear/uFogFar, and uFadeNear/uFadeFar uniforms from the building material.
 */
export const fragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFadeNear;
uniform float uFadeFar;
void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormal);
  float diff = clamp(dot(N, normalize(uSun)), 0.0, 1.0);
  float wrap = 0.30 + 0.85 * diff;
  float zBias = clamp(N.z * 0.15 + 0.85, 0.6, 1.0);
  vec3 col = vColor * wrap * zBias;
  float dist = length(vWorld - cameraPosition);
  float fogF = smoothstep(uFogNear, uFogFar, dist);
  col = mix(col, uFogColor, fogF);
  float alpha = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;
