/**
 * @file Shader string templates for forest canopy polygons with procedural color variation and altitude desaturation.
 */

/**
 * Vertex shader for canopy surfaces that lifts canopy tops above exaggerated terrain according to elevation band.
 * Expects uExag and uExtraLift uniforms and passes base elevation, world position, and view distance to the fragment stage.
 */
export const vertexShader = String.raw`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uExag;
uniform float uExtraLift;
varying vec3 vWorld;
varying float vBaseZ;
varying float vDist;
void main(){
  float baseZ = position.z;
  // canopy thickness from elevation band (matches forest_polys.py)
  float h;
  if (baseZ < 50.0)       h = 15.0;
  else if (baseZ < 200.0) h = 12.5;
  else if (baseZ < 400.0) h = 9.0;
  else if (baseZ < 600.0) h = 6.0;
  else                    h = 3.5;
  vec3 world = vec3(position.x, position.y, baseZ * uExag + uExtraLift + h);
  vWorld = world;
  vBaseZ = baseZ;
  vec4 vp = viewMatrix * vec4(world, 1.0);
  vDist = -vp.z;
  gl_Position = projectionMatrix * vp;
  #include <logdepthbuf_vertex>
}`;

/**
 * Fragment shader for canopy surfaces with derivative normals, procedural forest noise, fog, and range fade.
 * Expects uSun, uFogColor, uFogNear/uFogFar, uFadeNear/uFadeFar, and uRangeNear/uRangeFar uniforms.
 */
export const fragmentShader = String.raw`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vWorld;
varying float vBaseZ;
varying float vDist;
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFogNear, uFogFar;
uniform float uFadeNear, uFadeFar;
uniform float uRangeNear, uRangeFar;

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  return 0.55*vnoise(p) + 0.28*vnoise(p*2.07) + 0.14*vnoise(p*4.17);
}

void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float n1 = fbm(vWorld.xy * 0.013);
  float n2 = fbm(vWorld.xy * 0.045 + 17.0);
  float n  = clamp(n1*0.7 + n2*0.3, 0.0, 1.0);
  // desaturated greens tuned to terrain bands (emerald -> deep forest -> mossy olive)
  vec3 dark  = vec3(0.06, 0.17, 0.08);
  vec3 mid   = vec3(0.10, 0.24, 0.11);
  vec3 light = vec3(0.17, 0.31, 0.15);
  vec3 base = mix(dark, mid,  smoothstep(0.20, 0.55, n));
  base      = mix(base, light, smoothstep(0.60, 0.85, n));
  // alpine desaturation: shift toward peat-heath grey-green at altitude
  float alt = clamp((vBaseZ - 350.0) / 350.0, 0.0, 1.0);
  base = mix(base, base*0.80 + vec3(0.07, 0.07, 0.05)*0.20, alt*0.60);
  float NdL = clamp(dot(N, uSun), 0.0, 1.0);
  vec3 col = base * (0.40 + 0.65 * NdL);
  float fogF = smoothstep(uFogNear, uFogFar, vDist);
  col = mix(col, uFogColor, fogF);
  float aIn  = smoothstep(uFadeNear, uFadeFar, vDist);
  float aOut = 1.0 - smoothstep(uRangeNear, uRangeFar, vDist);
  float alpha = aIn * aOut;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;
