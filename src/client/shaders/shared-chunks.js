/**
 * @file Shared GLSL chunks for fog blend, distance fade, and wrapped sun lighting. Materials compose these strings into their fragment shaders so the constants live in one place and any drift between feature shaders is explicit at the call site rather than buried in copy-pasted GLSL.
 *
 * Wrap-lighting coefficients are parameterised because trees, buildings, and amenities historically drifted (0.35/0.80, 0.30/0.85, 0.55/0.55). Preserving each call site's existing coefficients keeps visual output identical; unifying them is a deliberate design choice for a future commit.
 */

/**
 * Uniform declarations for fog and distance fade shared by tree, canopy, building, and amenity fragment shaders. Includes uSun so the wrap-lighting helper sees its dependency from the same import.
 */
export const fogFadeUniformsGLSL = String.raw`
uniform vec3 uSun;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFadeNear;
uniform float uFadeFar;
`;

/**
 * Returns a GLSL statement that computes `float wrap = low + span * diff;` where `diff` is the caller's clamped N·L term. Coefficients are passed in to preserve per-shader drift verbatim.
 */
export function sunWrapLightingGLSL({ low, span }) {
  return `float wrap = ${low.toFixed(2)} + ${span.toFixed(2)} * diff;`;
}

/**
 * GLSL fragment that blends `col` toward `uFogColor` using `dist` from the camera. Caller must declare `vec3 col` and `float dist` before invoking.
 */
export const fogBlendGLSL = String.raw`
float fogF = smoothstep(uFogNear, uFogFar, dist);
col = mix(col, uFogColor, fogF);
`;

/**
 * GLSL fragment that produces `float alpha` from `dist`, fading from 1 at uFadeNear to 0 at uFadeFar. Caller must declare `float dist` before invoking.
 */
export const distanceFadeAlphaGLSL = String.raw`
float alpha = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
`;
