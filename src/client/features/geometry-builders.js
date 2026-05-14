/** @file THREE.BufferGeometry builders consumed by buildings, forest, and amenities. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Build the unit house THREE.BufferGeometry consumed by the building system.
 * Produces position, normal, and aPart attributes where aPart distinguishes
 * walls from roof faces; building instances add iPos/iSize/iRot/color attrs.
 */
export function makeHouseGeometry(){
  const verts = [];   // [x,y,z, nx,ny,nz, part]
  /**
   * Append one house triangle with a shared normal and wall/roof part marker.
   */
  function tri(a, b, c, n, part){
    verts.push(...a, ...n, part, ...b, ...n, part, ...c, ...n, part);
  }
  /**
   * Append two triangles forming one house quad with the same part marker.
   */
  function quad(a, b, c, d, n, part){ tri(a,b,c,n,part); tri(a,c,d,n,part); }

  // wall corners (z=0 / z=1)
  const c000=[-.5,-.5,0], c100=[.5,-.5,0], c110=[.5,.5,0], c010=[-.5,.5,0];
  const c001=[-.5,-.5,1], c101=[.5,-.5,1], c111=[.5,.5,1], c011=[-.5,.5,1];
  // walls (no bottom / no top: top is replaced by roof)
  quad(c000,c100,c101,c001, [0,-1,0], 0); // south
  quad(c100,c110,c111,c101, [1,0,0],  0); // east
  quad(c110,c010,c011,c111, [0,1,0],  0); // north
  quad(c010,c000,c001,c011, [-1,0,0], 0); // west
  // roof: ridge along X axis, peak at z=2 (in unit space; scaled by iRoofH in shader)
  const rw=[-.5,0,2], re=[.5,0,2];
  // south slope (faces -y, +z)
  const ny = Math.SQRT1_2; // for visualisation; shader recomputes anyway
  quad(c001, c101, re, rw, [0,-ny,ny], 1);
  // north slope
  quad(c111, c011, rw, re, [0, ny, ny], 1);
  // west gable triangle
  tri(c001, rw, c011, [-1,0,0], 1);
  // east gable triangle
  tri(c101, c111, re, [1,0,0], 1);

  const stride = 7; // floats per vertex
  const f = new Float32Array(verts);
  const n = f.length / stride;
  const positions = new Float32Array(n * 3);
  const normals   = new Float32Array(n * 3);
  const parts     = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const o = i * stride;
    positions[i*3+0] = f[o+0]; positions[i*3+1] = f[o+1]; positions[i*3+2] = f[o+2];
    normals[i*3+0] = f[o+3]; normals[i*3+1] = f[o+4]; normals[i*3+2] = f[o+5];
    parts[i] = f[o+6];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  g.setAttribute('aPart',    new THREE.BufferAttribute(parts, 1));
  return g;
}

/**
 * Build a colored box BufferGeometry primitive used by amenity prop builders.
 */
function _propBox(w, l, h, ox, oy, oz, color){
  const g = new THREE.BoxGeometry(w, l, h);
  g.translate(ox, oy, oz + h * 0.5);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
/**
 * Build a colored Z-up cylinder BufferGeometry primitive for amenity props.
 */
function _propCyl(r, h, ox, oy, oz, color, radial=8){
  const g = new THREE.CylinderGeometry(r, r, h, radial);
  g.rotateX(Math.PI / 2); // Y-up → Z-up
  g.translate(ox, oy, oz + h * 0.5);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
/**
 * Build a colored sphere BufferGeometry primitive for amenity props.
 */
function _propSphere(r, ox, oy, oz, color){
  const g = new THREE.SphereGeometry(r, 8, 6);
  g.translate(ox, oy, oz);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ c[i*3]=color[0]; c[i*3+1]=color[1]; c[i*3+2]=color[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

const _WOOD = [0.55, 0.35, 0.20];
const _DARK = [0.28, 0.18, 0.10];
const _METAL = [0.55, 0.55, 0.58];
const _STONE = [0.58, 0.56, 0.52];
const _SAND = [0.86, 0.76, 0.50];
const _RED = [0.78, 0.22, 0.20];
const _YEL = [0.92, 0.78, 0.20];
const _BLU = [0.25, 0.42, 0.78];
const _WHT = [0.92, 0.92, 0.92];

/**
 * Build the bench THREE.BufferGeometry consumed by amenity prop instancing;
 * returns merged colored box primitives with position, normal, and color attrs.
 */
export function buildBenchGeom(){
  return mergeGeometries([
    _propBox(1.8, 0.35, 0.06, 0, 0, 0.42, _WOOD),
    _propBox(1.8, 0.06, 0.40, 0, -0.14, 0.48, _WOOD),
    _propBox(0.08, 0.35, 0.42, -0.85, 0, 0, _DARK),
    _propBox(0.08, 0.35, 0.42,  0.85, 0, 0, _DARK),
  ], false);
}

/**
 * Build the picnic-table THREE.BufferGeometry consumed by amenity prop
 * instancing; returns merged colored box primitives with per-vertex colors.
 */
export function buildPicnicTableGeom(){
  return mergeGeometries([
    _propBox(2.0, 0.9, 0.06, 0, 0, 0.74, _WOOD),
    _propBox(2.0, 0.30, 0.05, 0, -0.7, 0.42, _WOOD),
    _propBox(2.0, 0.30, 0.05, 0,  0.7, 0.42, _WOOD),
    _propBox(0.08, 1.8, 0.74, -0.9, 0, 0, _DARK),
    _propBox(0.08, 1.8, 0.74,  0.9, 0, 0, _DARK),
  ], false);
}

/**
 * Build the lighthouse THREE.BufferGeometry consumed by amenity prop instancing;
 * returns merged colored cylinders/sphere with per-vertex color attributes.
 */
export function buildLighthouseGeom(){
  return mergeGeometries([
    _propCyl(1.4, 4.5, 0, 0, 0, _WHT, 14),
    _propCyl(1.55, 0.4, 0, 0, 4.5, _RED, 14),
    _propCyl(1.1, 1.4, 0, 0, 4.9, _WHT, 12),
    _propCyl(1.25, 0.4, 0, 0, 6.3, _RED, 12),
    _propSphere(0.7, 0, 0, 6.8, _RED),
  ], false);
}

export const amenityGeometryBuilders = Object.freeze({
  buildBenchGeom,
  buildPicnicTableGeom,
  buildLighthouseGeom,
});

/**
 * Build the detailed tree THREE.BufferGeometry consumed by the forest system.
 * Produces position, normal, and aPart attributes where aPart identifies lower
 * canopy, upper canopy, and trunk regions for the tree shader.
 */
export function makeTreeGeometry(){
  const verts = []; // [x,y,z, nx,ny,nz, part]   part: 0 lower 1 upper 2 trunk
  /**
   * Append one tree triangle with a shared normal and canopy/trunk part marker.
   */
  function tri(a, b, c, n, part){
    verts.push(a[0],a[1],a[2], n[0],n[1],n[2], part,
               b[0],b[1],b[2], n[0],n[1],n[2], part,
               c[0],c[1],c[2], n[0],n[1],n[2], part);
  }
  /**
   * Append two triangles forming one tree quad with the same part marker.
   */
  function quad(a, b, c, d, n, part){ tri(a,b,c,n,part); tri(a,c,d,n,part); }
  /**
   * Compute a normalized face normal for tree canopy and trunk triangles.
   */
  function nrm(a, b, c){
    const ax = b[0]-a[0], ay = b[1]-a[1], az = b[2]-a[2];
    const bx = c[0]-a[0], by = c[1]-a[1], bz = c[2]-a[2];
    let nx = ay*bz - az*by;
    let ny = az*bx - ax*bz;
    let nz = ax*by - ay*bx;
    const L = Math.hypot(nx, ny, nz) || 1;
    return [nx/L, ny/L, nz/L];
  }

  const SIDES = 6;
  /**
   * Generate a six-sided horizontal ring used to shape the conifer canopy.
   */
  function ring(z, r){
    const out = [];
    for (let i = 0; i < SIDES; i++){
      const a = i / SIDES * Math.PI * 2;
      out.push([Math.cos(a) * r, Math.sin(a) * r, z]);
    }
    return out;
  }

  // Lower cone: ring at z=0.05 (radius 1.0), peak at z=0.55 (radius 0.55)
  const lowerBase = ring(0.05, 1.0);
  const lowerPeak = ring(0.55, 0.55);
  // Upper cone: ring at z=0.50 (radius 0.65), peak at z=1.0
  const upperBase = ring(0.50, 0.65);
  const upperPeakP = [0, 0, 1.0];

  for (let i = 0; i < SIDES; i++){
    const j = (i + 1) % SIDES;
    // lower skirt: trapezoidal side
    {
      const a = lowerBase[i], b = lowerBase[j];
      const c = lowerPeak[j], d = lowerPeak[i];
      quad(a, b, c, d, nrm(a, b, c), 0);
    }
    // upper cone side (peak-to-ring)
    {
      const a = upperBase[i], b = upperBase[j], p = upperPeakP;
      tri(a, b, p, nrm(a, b, p), 1);
    }
  }
  // small trunk box (square cross-section, radius 0.07, height 0.05 below lowest ring)
  const tr = 0.07, t0 = -0.10, t1 = 0.06;
  const t000=[-tr,-tr,t0], t100=[tr,-tr,t0], t110=[tr,tr,t0], t010=[-tr,tr,t0];
  const t001=[-tr,-tr,t1], t101=[tr,-tr,t1], t111=[tr,tr,t1], t011=[-tr,tr,t1];
  quad(t000,t100,t101,t001, [0,-1,0], 2);
  quad(t100,t110,t111,t101, [1,0,0],  2);
  quad(t110,t010,t011,t111, [0,1,0],  2);
  quad(t010,t000,t001,t011, [-1,0,0], 2);

  const stride = 7;
  const f = new Float32Array(verts);
  const n = f.length / stride;
  const positions = new Float32Array(n * 3);
  const normals   = new Float32Array(n * 3);
  const parts     = new Float32Array(n);
  for (let i = 0; i < n; i++){
    const o = i * stride;
    positions[i*3+0] = f[o+0]; positions[i*3+1] = f[o+1]; positions[i*3+2] = f[o+2];
    normals[i*3+0]   = f[o+3]; normals[i*3+1]   = f[o+4]; normals[i*3+2]   = f[o+5];
    parts[i] = f[o+6];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
  g.setAttribute('aPart',    new THREE.BufferAttribute(parts, 1));
  return g;
}

/**
 * Build the tree billboard THREE.BufferGeometry for forest impostors.
 * Produces aQuad corner coordinates plus a dummy position attribute and uint16
 * index buffer; forest shader expands instances in camera-facing space.
 */
export function makeTreeBillboardGeometry(){
  // 4 verts: bottom-left, bottom-right, top-right, top-left
  // aQuad.x in [-1, 1], aQuad.y in [0, 1] (0 = base, 1 = top)
  const aQuad = new Float32Array([
    -1, 0,
     1, 0,
     1, 1,
    -1, 1,
  ]);
  const pos = new Float32Array([0,0,0, 0,0,0, 0,0,0, 0,0,0]); // unused, expanded in vs
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aQuad',    new THREE.BufferAttribute(aQuad, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
