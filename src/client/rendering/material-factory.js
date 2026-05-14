/**
 * @file Creates shader materials while preserving each renderer option required by the corresponding visual layer.
 */

import * as THREE from 'three';
import { vertexShader as terrainVertexShader, fragmentShader as terrainFragmentShader } from '../shaders/terrain-shader.js';
import { vertexShader as buildingVertexShader, fragmentShader as buildingFragmentShader } from '../shaders/building-shader.js';
import {
  treeVertexShader,
  treeFragmentShader,
  billboardVertexShader,
  billboardFragmentShader,
} from '../shaders/tree-shader.js';
import { vertexShader as canopyVertexShader, fragmentShader as canopyFragmentShader } from '../shaders/canopy-shader.js';
import { vertexShader as waterVertexShader, fragmentShader as waterFragmentShader } from '../shaders/water-shader.js';
import {
  areaVertexShader,
  areaFragmentShader,
  propVertexShader,
  propFragmentShader,
} from '../shaders/amenity-shader.js';

/**
 * Creates the terrain material with derivative support and polygon offset so terrain shading, contours, and overlays remain stable.
 * The factory preserves the required extensions and polygonOffset settings while binding caller-owned uniforms.
 */
export function createTerrainMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    uniforms,
    vertexShader: terrainVertexShader,
    fragmentShader: terrainFragmentShader,
    extensions: { derivatives: true },
  });
}

/**
 * Creates the instanced building material used for wall and roof shading with fog fade.
 * The transparent and depthWrite options are kept together so faded buildings still participate correctly in depth ordering.
 */
export function createBuildingMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: buildingVertexShader,
    fragmentShader: buildingFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

/**
 * Creates the amenity area material for semi-transparent ground overlays above terrain.
 * The transparent, depthWrite, and polygonOffset values are preserved to prevent z-fighting while retaining correct depth composition.
 */
export function createAmenityAreaMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: areaVertexShader,
    fragmentShader: areaFragmentShader,
    transparent: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

/**
 * Creates the amenity prop material for instanced vertical markers and objects.
 * The transparent and depthWrite settings are intentional so distance fades do not break scene depth cues.
 */
export function createAmenityPropMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: propVertexShader,
    fragmentShader: propFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

/**
 * Creates the close-range tree mesh material for trunk and canopy geometry.
 * It preserves transparent and depthWrite behavior because the shader fades trees by distance while still writing depth for solid silhouettes.
 */
export function createTreeMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: treeVertexShader,
    fragmentShader: treeFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

/**
 * Creates the distant tree billboard material so impostors can face the camera from both sides.
 * The transparent, depthWrite, and DoubleSide options are preserved for alpha-masked conical silhouettes.
 */
export function createTreeBillboardMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: billboardVertexShader,
    fragmentShader: billboardFragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
}

/**
 * Creates the forest canopy material for polygonal canopy surfaces with procedural variation.
 * The transparent, depthWrite, DoubleSide, and derivatives extension options are required for fade, two-sided coverage, and normal reconstruction.
 */
export function createCanopyMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: canopyVertexShader,
    fragmentShader: canopyFragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    extensions: { derivatives: true },
  });
}

/**
 * Creates the water material with front-side rendering, derivative normals, and terrain-safe polygon offset.
 * Preserving side, extensions, and polygonOffset settings keeps the water plane visually stable under terrain overlays.
 */
export function createWaterMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: waterVertexShader,
    fragmentShader: waterFragmentShader,
    side: THREE.FrontSide,
    extensions: { derivatives: true },
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}
