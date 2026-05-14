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

export function createBuildingMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: buildingVertexShader,
    fragmentShader: buildingFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

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

export function createAmenityPropMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: propVertexShader,
    fragmentShader: propFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

export function createTreeMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: treeVertexShader,
    fragmentShader: treeFragmentShader,
    transparent: true,
    depthWrite: true,
  });
}

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
