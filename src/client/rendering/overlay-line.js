/**
 * @file Owns the road / boundary overlay line shader and the small factory that turns shared overlay uniforms + a colour into a ready-to-use ShaderMaterial. Kept separate from overlays/roads.js so future overlays (faults, isohypses) can reuse the same shader without re-importing the roads module.
 */

export const overlayVertGLSL = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uExag;
uniform float uOffset;
void main(){
  vec3 p = position;
  p.z = max(p.z, 0.0) * uExag + uOffset;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const overlayFragGLSL = /* glsl */`
precision highp float;
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, 1.0);
}
`;

/**
 * Builds a ShaderMaterial suitable for THREE.LineSegments overlay geometry. The supplied overlayUniforms (uExag, uOffset) are merged with a uColor uniform so callers can pick different colours for kommune boundaries, faults, or other overlay layers while keeping the displacement shader identical.
 */
export function createOverlayLineMaterial({ THREE, overlayUniforms, color }) {
  return new THREE.ShaderMaterial({
    uniforms: { ...overlayUniforms, uColor: { value: new THREE.Color(color) } },
    vertexShader: overlayVertGLSL,
    fragmentShader: overlayFragGLSL,
    transparent: false,
    depthTest: true,
    depthWrite: false,
  });
}
