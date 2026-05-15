/**
 * @file CPU-side placement obstacles service.
 *
 * Holds shared spatial indices of roads and buildings so that procedural placement code (currently
 * forest trees) can reject candidates whose footprint would intersect a road or a building.
 *
 * The terrain shader paints roads on top of the ground, and water/canopy/tree fragment shaders
 * discard fragments inside the road footprint — but that only solves *rendering* overdraw. Tree
 * geometry placed on a road still gets clipped to a sliver, which looks like a chopped tree. The
 * proper fix is to never place those trees in the first place, which is what this service enables.
 *
 * Lifecycle:
 *   1. init.js creates one instance and passes it into the roads, buildings, and forest systems.
 *   2. roads.js calls setRoads(...) after parsing osm.bin (or markRoadsEmpty() on failure).
 *   3. buildings.js calls setBuildings(...) after parsing buildings.bin (or markBuildingsEmpty()).
 *   4. forest.js awaits roadsReady and buildingsReady before generating tree instances and calls
 *      isBlocked(x, y) per candidate, dropping those that hit roads or buildings.
 *
 * The hot-loop math now lives in core/obstacles-query.js so it can be shared with the forest
 * generation Web Worker. This file owns lifecycle (ready promises + setters) plus the flat-state
 * adapters; the math itself is identical on main thread and worker.
 */

import {
  couldBeBlocked as couldBeBlockedQuery,
  flattenBuildingCells,
  flattenRoadCells,
  isBlocked as isBlockedQuery,
} from '../core/obstacles-query.js';

/**
 * Construct a placement obstacles service. Roads and buildings each start unresolved and unblock
 * tree placement only when their data (or an empty placeholder) is registered. The service stores
 * flat-array obstacle state internally so the same memory layout can be queried directly on the
 * main thread and cloned cheaply for a worker.
 */
export function createPlacementObstacles() {
  let roadsState = null;
  let buildingsState = null;
  let buildingsBlankRecords = null;   // records reference kept so consumers can still read columns
  let resolveRoads;
  let resolveBuildings;
  const roadsReady = new Promise((r) => { resolveRoads = r; });
  const buildingsReady = new Promise((r) => { resolveBuildings = r; });

  /**
   * Register the parsed road network. Flattens the per-cell index arrays into a single Int32Array
   * with a Uint32Array of cell start offsets so queries become array indexing rather than nested
   * lookups, and so the whole state can be transferred to a worker.
   */
  function setRoads(input) {
    roadsState = flattenRoadCells(input);
    resolveRoads();
  }

  /**
   * Resolve roadsReady with no road data — used when osm.bin fails to load so that downstream tree
   * generation does not hang forever waiting for a network that will not arrive.
   */
  function markRoadsEmpty() {
    if (!roadsState) resolveRoads();
  }

  /**
   * Register parsed BLD1 records and build a fine spatial grid keyed at the given metre cell size
   * so isBlocked() only probes the small 3x3 neighbourhood of candidate buildings near the query.
   */
  function setBuildings({ records, n, gridMetres = 200 }) {
    if (!n) {
      buildingsState = null;
      buildingsBlankRecords = records;
      resolveBuildings();
      return;
    }
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const cx = records.cx[i];
      const cy = records.cy[i];
      const halfDiag = 0.5 * Math.hypot(records.length[i], records.width[i]);
      if (cx - halfDiag < xMin) xMin = cx - halfDiag;
      if (cy - halfDiag < yMin) yMin = cy - halfDiag;
      if (cx + halfDiag > xMax) xMax = cx + halfDiag;
      if (cy + halfDiag > yMax) yMax = cy + halfDiag;
    }
    const cellSize = gridMetres;
    const gridW = Math.max(1, Math.ceil((xMax - xMin) / cellSize));
    const gridH = Math.max(1, Math.ceil((yMax - yMin) / cellSize));
    const cells = new Array(gridW * gridH);
    for (let i = 0; i < cells.length; i += 1) cells[i] = [];
    for (let i = 0; i < n; i += 1) {
      const cx = records.cx[i];
      const cy = records.cy[i];
      const halfDiag = 0.5 * Math.hypot(records.length[i], records.width[i]);
      let gx0 = Math.floor((cx - halfDiag - xMin) / cellSize);
      let gx1 = Math.floor((cx + halfDiag - xMin) / cellSize);
      let gy0 = Math.floor((cy - halfDiag - yMin) / cellSize);
      let gy1 = Math.floor((cy + halfDiag - yMin) / cellSize);
      if (gx0 < 0) gx0 = 0; if (gy0 < 0) gy0 = 0;
      if (gx1 >= gridW) gx1 = gridW - 1; if (gy1 >= gridH) gy1 = gridH - 1;
      for (let gy = gy0; gy <= gy1; gy += 1) {
        for (let gx = gx0; gx <= gx1; gx += 1) {
          cells[gy * gridW + gx].push(i);
        }
      }
    }
    buildingsState = flattenBuildingCells({ records, n, cells, gridW, gridH, cellSize, xMin, yMin });
    resolveBuildings();
  }

  /** Resolve buildingsReady with no buildings — used when buildings.bin fails to load. */
  function markBuildingsEmpty() {
    if (!buildingsState) resolveBuildings();
  }

  /**
   * Bridge to the shared pure query module. Wraps the call so external callers continue to use
   * the same (x, y, roadMargin, buildingMargin) signature without seeing the state object.
   */
  function isBlocked(x, y, roadMargin = 1.5, buildingMargin = 1.5) {
    return isBlockedQuery({ roads: roadsState, buildings: buildingsState }, x, y, roadMargin, buildingMargin);
  }

  /**
   * Fast cheap pre-check: true when at least one road or building exists in the 3x3 grid
   * neighbourhood around (x, y). Used by forest generation to skip the per-instance isBlocked
   * math for seeds in obstacle-free wilderness.
   */
  function couldBeBlocked(x, y) {
    return couldBeBlockedQuery({ roads: roadsState, buildings: buildingsState }, x, y);
  }

  /**
   * Clone the obstacle state into a structured-cloneable + transferable snapshot for a Web
   * Worker. Every typed array is .slice()'d so the resulting buffers can be moved via the
   * transfer list without detaching the live main-thread copies.
   */
  function serializeForWorker() {
    const out = { roads: null, buildings: null };
    if (roadsState) {
      out.roads = {
        segAx: roadsState.segAx.slice(),
        segAy: roadsState.segAy.slice(),
        segBx: roadsState.segBx.slice(),
        segBy: roadsState.segBy.slice(),
        segCls: roadsState.segCls.slice(),
        cellSegIdx: roadsState.cellSegIdx.slice(),
        cellStarts: roadsState.cellStarts.slice(),
        gridW: roadsState.gridW,
        gridH: roadsState.gridH,
        cellSize: roadsState.cellSize,
        xMinC: roadsState.xMinC,
        yMinC: roadsState.yMinC,
      };
    }
    if (buildingsState) {
      out.buildings = {
        recCx: buildingsState.recCx.slice(),
        recCy: buildingsState.recCy.slice(),
        recAngle: buildingsState.recAngle.slice(),
        recLength: buildingsState.recLength.slice(),
        recWidth: buildingsState.recWidth.slice(),
        cellBldIdx: buildingsState.cellBldIdx.slice(),
        cellStarts: buildingsState.cellStarts.slice(),
        gridW: buildingsState.gridW,
        gridH: buildingsState.gridH,
        cellSize: buildingsState.cellSize,
        xMin: buildingsState.xMin,
        yMin: buildingsState.yMin,
      };
    }
    return out;
  }

  /**
   * Collects every transferable buffer from a snapshot for use as the postMessage transfer list.
   * Returns an empty array when the snapshot has no obstacle data (so transfer is a no-op).
   */
  function collectTransferables(snapshot) {
    const transfers = [];
    if (snapshot.roads) {
      transfers.push(
        snapshot.roads.segAx.buffer,
        snapshot.roads.segAy.buffer,
        snapshot.roads.segBx.buffer,
        snapshot.roads.segBy.buffer,
        snapshot.roads.segCls.buffer,
        snapshot.roads.cellSegIdx.buffer,
        snapshot.roads.cellStarts.buffer,
      );
    }
    if (snapshot.buildings) {
      transfers.push(
        snapshot.buildings.recCx.buffer,
        snapshot.buildings.recCy.buffer,
        snapshot.buildings.recAngle.buffer,
        snapshot.buildings.recLength.buffer,
        snapshot.buildings.recWidth.buffer,
        snapshot.buildings.cellBldIdx.buffer,
        snapshot.buildings.cellStarts.buffer,
      );
    }
    return transfers;
  }

  return {
    roadsReady,
    buildingsReady,
    setRoads,
    setBuildings,
    markRoadsEmpty,
    markBuildingsEmpty,
    isBlocked,
    couldBeBlocked,
    serializeForWorker,
    collectTransferables,
  };
}

/**
 * Inert placeholder that resolves both ready promises immediately and never reports any obstacle.
 * Useful for unit tests and for callers that have no road or building data available.
 */
export function createNullObstacles() {
  return {
    roadsReady: Promise.resolve(),
    buildingsReady: Promise.resolve(),
    setRoads() {},
    setBuildings() {},
    markRoadsEmpty() {},
    markBuildingsEmpty() {},
    isBlocked() { return false; },
    couldBeBlocked() { return false; },
    serializeForWorker() { return { roads: null, buildings: null }; },
    collectTransferables() { return []; },
  };
}
