/**
 * @file Pure obstacle-query primitives shared by the main-thread placement
 * service and the forest generation worker. Operates on a flat snapshot of
 * roads + buildings so the state can be cheaply transferred to a Worker via
 * structured clone + transferable typed-array buffers — no nested JS arrays
 * to walk, no methods to recreate.
 *
 * State shape (either roads or buildings may be null):
 *   roads: {
 *     segAx, segAy, segBx, segBy: Float32Array
 *     segCls: Uint8Array
 *     cellSegIdx: Int32Array  // concatenation of all per-cell segment indices
 *     cellStarts: Uint32Array // length gridW*gridH + 1; cellStarts[i+1] - cellStarts[i] = #segs in cell i
 *     gridW, gridH: number
 *     cellSize, xMinC, yMinC: number
 *   }
 *   buildings: {
 *     recCx, recCy, recAngle, recLength, recWidth: Float32Array
 *     cellBldIdx: Int32Array
 *     cellStarts: Uint32Array
 *     gridW, gridH: number
 *     cellSize, xMin, yMin: number
 *   }
 */

const ROAD_HALF_W = [6.5, 5.0, 4.0, 3.25, 2.75];

/**
 * Squared distance from point (px, py) to segment (ax, ay)-(bx, by). The hot
 * obstacle-query math lives here exclusively after the worker refactor; the
 * main-thread placement-obstacles service delegates to this module.
 */
function distSqPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = Math.max(dx * dx + dy * dy, 1e-6);
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const rx = px - (ax + dx * t);
  const ry = py - (ay + dy * t);
  return rx * rx + ry * ry;
}

/**
 * True when (x, y) is within roadMargin of any road segment (using its class
 * half-width) or within buildingMargin of any building's oriented rectangular
 * footprint. Matches the semantics of the legacy service.isBlocked exactly.
 */
export function isBlocked(state, x, y, roadMargin = 1.5, buildingMargin = 1.5) {
  const { roads, buildings } = state;
  if (roads) {
    const { segAx, segAy, segBx, segBy, segCls, cellSegIdx, cellStarts, gridW, gridH, cellSize, xMinC, yMinC } = roads;
    const gxCenter = Math.floor((x - xMinC) / cellSize);
    const gyCenter = Math.floor((y - yMinC) / cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const gx = gxCenter + dx;
        const gy = gyCenter + dy;
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
        const cellIdx = gy * gridW + gx;
        const start = cellStarts[cellIdx];
        const end = cellStarts[cellIdx + 1];
        for (let k = start; k < end; k += 1) {
          const idx = cellSegIdx[k];
          const halfW = ROAD_HALF_W[segCls[idx]] + roadMargin;
          const limit = halfW * halfW;
          if (distSqPointSeg(x, y, segAx[idx], segAy[idx], segBx[idx], segBy[idx]) <= limit) {
            return true;
          }
        }
      }
    }
  }
  if (buildings) {
    const { recCx, recCy, recAngle, recLength, recWidth, cellBldIdx, cellStarts, gridW, gridH, cellSize, xMin, yMin } = buildings;
    const gxCenter = Math.floor((x - xMin) / cellSize);
    const gyCenter = Math.floor((y - yMin) / cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const gx = gxCenter + dx;
        const gy = gyCenter + dy;
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
        const cellIdx = gy * gridW + gx;
        const start = cellStarts[cellIdx];
        const end = cellStarts[cellIdx + 1];
        for (let k = start; k < end; k += 1) {
          const idx = cellBldIdx[k];
          const cx = recCx[idx];
          const cy = recCy[idx];
          const ang = recAngle[idx];
          const ca = Math.cos(-ang);
          const sa = Math.sin(-ang);
          const lx = ca * (x - cx) - sa * (y - cy);
          const ly = sa * (x - cx) + ca * (y - cy);
          const halfL = recLength[idx] * 0.5 + buildingMargin;
          const halfWB = recWidth[idx] * 0.5 + buildingMargin;
          if (Math.abs(lx) <= halfL && Math.abs(ly) <= halfWB) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Cheap pre-check: true if any road or building exists in the 3x3 grid
 * neighbourhood around (x, y). Skips per-segment math entirely so it is the
 * appropriate first cull for forest seeds in wilderness.
 */
export function couldBeBlocked(state, x, y) {
  const { roads, buildings } = state;
  if (roads) {
    const { cellStarts, gridW, gridH, cellSize, xMinC, yMinC } = roads;
    const gxCenter = Math.floor((x - xMinC) / cellSize);
    const gyCenter = Math.floor((y - yMinC) / cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const gx = gxCenter + dx;
        const gy = gyCenter + dy;
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
        const cellIdx = gy * gridW + gx;
        if (cellStarts[cellIdx + 1] > cellStarts[cellIdx]) return true;
      }
    }
  }
  if (buildings) {
    const { cellStarts, gridW, gridH, cellSize, xMin, yMin } = buildings;
    const gxCenter = Math.floor((x - xMin) / cellSize);
    const gyCenter = Math.floor((y - yMin) / cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const gx = gxCenter + dx;
        const gy = gyCenter + dy;
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
        const cellIdx = gy * gridW + gx;
        if (cellStarts[cellIdx + 1] > cellStarts[cellIdx]) return true;
      }
    }
  }
  return false;
}

/**
 * Builds the flat road state from per-cell arrays-of-indices and per-segment
 * parallel typed arrays. Mirrors the legacy roads.setRoads() input shape.
 */
export function flattenRoadCells({ cells, segAx, segAy, segBx, segBy, segCls, gridW, gridH, cellSize, xMinC, yMinC }) {
  const nCells = gridW * gridH;
  const cellStarts = new Uint32Array(nCells + 1);
  let total = 0;
  for (let i = 0; i < nCells; i += 1) {
    cellStarts[i] = total;
    total += cells[i].length;
  }
  cellStarts[nCells] = total;
  const cellSegIdx = new Int32Array(total);
  let write = 0;
  for (let i = 0; i < nCells; i += 1) {
    const list = cells[i];
    for (let k = 0; k < list.length; k += 1) {
      cellSegIdx[write++] = list[k];
    }
  }
  return { segAx, segAy, segBx, segBy, segCls, cellSegIdx, cellStarts, gridW, gridH, cellSize, xMinC, yMinC };
}

/**
 * Builds the flat building state. Accepts the in-memory cells-of-arrays
 * representation produced by the legacy service and condenses it into the
 * worker-friendly parallel-arrays form.
 */
export function flattenBuildingCells({ records, n, cells, gridW, gridH, cellSize, xMin, yMin }) {
  const nCells = gridW * gridH;
  const cellStarts = new Uint32Array(nCells + 1);
  let total = 0;
  for (let i = 0; i < nCells; i += 1) {
    cellStarts[i] = total;
    total += cells[i].length;
  }
  cellStarts[nCells] = total;
  const cellBldIdx = new Int32Array(total);
  let write = 0;
  for (let i = 0; i < nCells; i += 1) {
    const list = cells[i];
    for (let k = 0; k < list.length; k += 1) {
      cellBldIdx[write++] = list[k];
    }
  }
  // Project the record columns we need into compact parallel arrays — the
  // legacy `records` keeps every BLD1 column including ones unused for
  // placement queries, so we slim it down to keep the transfer small.
  const recCx = new Float32Array(n);
  const recCy = new Float32Array(n);
  const recAngle = new Float32Array(n);
  const recLength = new Float32Array(n);
  const recWidth = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    recCx[i] = records.cx[i];
    recCy[i] = records.cy[i];
    recAngle[i] = records.angle[i];
    recLength[i] = records.length[i];
    recWidth[i] = records.width[i];
  }
  return { recCx, recCy, recAngle, recLength, recWidth, cellBldIdx, cellStarts, gridW, gridH, cellSize, xMin, yMin };
}
