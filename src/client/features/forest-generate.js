/**
 * @file Pure tree-instance generator. The hot K_TREES expansion loop that used
 * to live inside features/forest.js is extracted here so it can run inside a
 * Web Worker (with no THREE / DOM dependency) and so the same code path is
 * exercised by both the worker and a node-test bench.
 *
 * The generator drives outputs via callbacks rather than constructing meshes
 * itself: per-bin it allocates fresh Float32Arrays (iPos, iSize, iRot,
 * iCanopyA, iCanopyB) and hands them off via `onBin`. The caller (worker)
 * postMessages those buffers with transfer; tests inspect them directly.
 */

import { parseForestBuffer } from './forest-parse.js';
import { couldBeBlocked, isBlocked } from '../core/obstacles-query.js';

const TREE_PAL = [
  [0.12, 0.22, 0.12],
  [0.13, 0.22, 0.12],
  [0.13, 0.23, 0.12],
  [0.12, 0.21, 0.11],
];
const TREE_PAL_DARK = [
  [0.07, 0.15, 0.08],
  [0.08, 0.15, 0.08],
  [0.08, 0.16, 0.09],
  [0.07, 0.14, 0.07],
];
const TREE_ASPECT = [0.30, 0.36, 0.55, 0.40];

/**
 * Deterministic per-seed jitter hash. Mirrors the inline implementation that
 * used to live in features/forest.js; kept bit-identical to preserve placement.
 */
function jh(a, b) {
  let x = (a * 374761393 ^ b * 668265263) | 0;
  x = (x ^ (x >>> 13)) * 1274126177 | 0;
  x = x ^ (x >>> 16);
  return ((x >>> 0) / 0xffffffff) * 2.0 - 1.0;
}

/**
 * Walk the forest binary, expand each TRE1/TRE2 seed into K_TREES instances,
 * cull against obstacles, and stream fully-formed per-bin attribute buffers
 * to `onBin`. Returns the aggregate summary the caller logs.
 *
 * Inputs:
 *   forestBuffer: ArrayBuffer of forest.bin (will be parsed once here)
 *   obstacleState: { roads, buildings } in the flat shape expected by
 *     core/obstacles-query.js; either side may be null
 *   onBin({ cellCx, cellCy, radius, maxH, instanceCount, iPos, iSize, iRot,
 *           iCanopyA, iCanopyB }): receives the per-bin attribute arrays
 *   onProgress(currentBin, totalBins): called periodically; safe to be a noop
 *   K_TREES, QUAD_M, BASE_SINK: layout constants matching the legacy code
 */
export function generateForestBins({
  forestBuffer,
  obstacleState,
  onBin,
  onProgress = () => {},
  K_TREES = 16,
  QUAD_M = 48.0,
  BASE_SINK = 1.2,
} = {}) {
  const { n, records, bins } = parseForestBuffer(forestBuffer);
  const binEntries = Array.from(bins.values());
  const totalBins = binEntries.length;
  let totalCells = 0;
  let totalInstances = 0;
  let totalCulled = 0;
  let isBlockedCalls = 0;
  let seedsSkippedByPrecheck = 0;
  for (let binI = 0; binI < totalBins; binI += 1) {
    const idxArr = binEntries[binI];
    const m = idxArr.length;
    if (!m) continue;
    const M = m * K_TREES;
    const iPos     = new Float32Array(M * 3);
    const iSize    = new Float32Array(M * 2);
    const iRot     = new Float32Array(M);
    const iCanopyA = new Float32Array(M * 3);
    const iCanopyB = new Float32Array(M * 3);
    let bxMin = Infinity, byMin = Infinity, bxMax = -Infinity, byMax = -Infinity;
    let maxH = 0;
    let wi = 0;
    for (let k = 0; k < m; k++) {
      const seedIdx = idxArr[k];
      const cx0 = records.cx[seedIdx];
      const cy0 = records.cy[seedIdx];
      const bz0 = records.bz[seedIdx];
      const h0  = records.height[seedIdx];
      const sp  = records.species[seedIdx];
      const sj  = records.sizeJitter[seedIdx];
      const cj  = records.colorJitter[seedIdx];
      const d00 = records.d00[seedIdx];
      const d10 = records.d10[seedIdx];
      const d01 = records.d01[seedIdx];
      const d11 = records.d11[seedIdx];
      const aspect = TREE_ASPECT[sp] || 0.4;
      const A = TREE_PAL[sp] || TREE_PAL[0];
      const B = TREE_PAL_DARK[sp] || TREE_PAL_DARK[0];
      const seedCouldBlock = couldBeBlocked(obstacleState, cx0, cy0);
      isBlockedCalls += 1;
      if (!seedCouldBlock) seedsSkippedByPrecheck += 1;
      for (let s = 0; s < K_TREES; s++) {
        const sub = K_TREES;
        const nx = Math.ceil(Math.sqrt(sub));
        const sx = s % nx, sy = (s / nx) | 0;
        const baseU = (sx + 0.5) / nx - 0.5;
        const baseV = (sy + 0.5) / nx - 0.5;
        const ru = jh(seedIdx, s * 2 + 1) * (0.5 / nx) * 0.95;
        const rv = jh(seedIdx, s * 2 + 2) * (0.5 / nx) * 0.95;
        const u = baseU + ru;
        const v = baseV + rv;
        const theta = jh(seedIdx, 9991) * Math.PI;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const u2 =  ct * u - st * v;
        const v2 =  st * u + ct * v;
        const offU = jh(seedIdx, 9992) * 0.45;
        const offV = jh(seedIdx, 9993) * 0.45;
        const cx = cx0 + (u2 + offU) * QUAD_M;
        const cy = cy0 + (v2 + offV) * QUAD_M;
        if (seedCouldBlock) {
          isBlockedCalls += 1;
          if (isBlocked(obstacleState, cx, cy)) { totalCulled++; continue; }
        }
        const fu = Math.max(0, Math.min(1, (u2 + offU) + 0.5));
        const fv = Math.max(0, Math.min(1, (v2 + offV) + 0.5));
        const dz = (d00 * (1 - fu) * (1 - fv))
                 + (d10 *      fu  * (1 - fv))
                 + (d01 * (1 - fu) *      fv )
                 + (d11 *      fu  *      fv );
        const rh1 = jh(seedIdx, 100 + s);
        const rh3 = jh(seedIdx, 300 + s);
        const sjF = sj / 255.0 + rh1 * 0.20;
        const rJit = 0.80 + Math.max(0, Math.min(1, sjF)) * 0.35;
        const hJit = 0.85 + Math.max(0, Math.min(1, sjF)) * 0.25;
        const radius = Math.max(0.6, h0 * aspect * rJit);
        const height = Math.max(2.0, h0 * hJit);
        iPos[wi*3+0] = cx;
        iPos[wi*3+1] = cy;
        iPos[wi*3+2] = bz0 + dz - BASE_SINK;
        iSize[wi*2+0] = radius;
        iSize[wi*2+1] = height;
        iRot[wi] = (cj / 255.0 + rh3 * 0.5) * Math.PI * 2.0;
        const jLum = jh(seedIdx, 401 + s) * 0.05;
        const jR   = jh(seedIdx, 411 + s) * 0.025;
        const jG   = jh(seedIdx, 421 + s) * 0.035;
        const jB   = jh(seedIdx, 431 + s) * 0.025;
        iCanopyA[wi*3+0] = Math.max(0.04, Math.min(0.5, A[0] + jLum + jR));
        iCanopyA[wi*3+1] = Math.max(0.04, Math.min(0.5, A[1] + jLum + jG));
        iCanopyA[wi*3+2] = Math.max(0.04, Math.min(0.5, A[2] + jLum + jB));
        iCanopyB[wi*3+0] = Math.max(0.03, Math.min(0.4, B[0] + jLum + jR));
        iCanopyB[wi*3+1] = Math.max(0.03, Math.min(0.4, B[1] + jLum + jG));
        iCanopyB[wi*3+2] = Math.max(0.03, Math.min(0.4, B[2] + jLum + jB));
        if (cx < bxMin) bxMin = cx; if (cy < byMin) byMin = cy;
        if (cx > bxMax) bxMax = cx; if (cy > byMax) byMax = cy;
        if (height > maxH) maxH = height;
        wi++;
      }
    }
    if (wi === 0) {
      onProgress(binI + 1, totalBins);
      continue;
    }
    const cellCx = (bxMin + bxMax) / 2;
    const cellCy = (byMin + byMax) / 2;
    const radius = Math.hypot(bxMax - cellCx, byMax - cellCy) + 30;
    // Pass full-size buffers (slot M = m * K_TREES) along with the instance count
    // so the caller's mesh.instanceCount can be set without re-slicing — the
    // unused tail is harmless because instancing draws exactly instanceCount items.
    onBin({ cellCx, cellCy, radius, maxH, instanceCount: wi, seedCount: m, iPos, iSize, iRot, iCanopyA, iCanopyB });
    totalInstances += wi;
    totalCells += 1;
    onProgress(binI + 1, totalBins);
  }
  return {
    seeds: n,
    instances: totalInstances,
    culled: totalCulled,
    cells: totalCells,
    isBlockedCalls,
    seedsSkippedByPrecheck,
    K_TREES,
  };
}
