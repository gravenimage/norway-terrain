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
 */

const ROAD_HALF_W = [6.5, 5.0, 4.0, 3.25, 2.75];

/**
 * Squared distance from point (px, py) to segment (ax, ay)-(bx, by). Square root is avoided in the
 * hot loop; callers pre-square their margin.
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
 * Construct a placement obstacles service. Roads and buildings each start unresolved and unblock
 * tree placement only when their data (or an empty placeholder) is registered. The service stores
 * raw segment arrays for roads and builds its own fine spatial grid for buildings (the BLD1 parser
 * bins at 8 km which is too coarse for per-tree probes).
 */
export function createPlacementObstacles() {
  let roads = null;
  let buildings = null;
  let resolveRoads;
  let resolveBuildings;
  const roadsReady = new Promise((r) => { resolveRoads = r; });
  const buildingsReady = new Promise((r) => { resolveBuildings = r; });

  /**
   * Register the parsed road network. `grid.cells[c]` is an array of segment indices, addressed by
   * `c = gy * gridW + gx` with `gx = floor((x - xMinC) / cellSize)`. Segment endpoints live in
   * parallel Float32Arrays and per-segment class lives in segCls. Mirrors the structure already
   * built inside overlays/roads.js so we can share work.
   */
  function setRoads({ cells, segAx, segAy, segBx, segBy, segCls, gridW, gridH, cellSize, xMinC, yMinC }) {
    roads = { cells, segAx, segAy, segBx, segBy, segCls, gridW, gridH, cellSize, xMinC, yMinC };
    resolveRoads();
  }

  /**
   * Resolve roadsReady with no road data — used when osm.bin fails to load so that downstream tree
   * generation does not hang forever waiting for a network that will not arrive.
   */
  function markRoadsEmpty() {
    if (!roads) resolveRoads();
  }

  /**
   * Register parsed BLD1 records and build a fine spatial grid keyed at the given metre cell size
   * so isBlocked() only probes the small 3x3 neighbourhood of candidate buildings near the query.
   */
  function setBuildings({ records, n, gridMetres = 200 }) {
    if (!n) {
      buildings = { gridW: 0, gridH: 0, cellSize: gridMetres, xMin: 0, yMin: 0, cells: [], records };
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
    buildings = { gridW, gridH, cellSize, xMin, yMin, cells, records };
    resolveBuildings();
  }

  /** Resolve buildingsReady with no buildings — used when buildings.bin fails to load. */
  function markBuildingsEmpty() {
    if (!buildings) resolveBuildings();
  }

  /**
   * True when (x, y) is within roadMargin of any road segment (using its class half-width) or
   * within buildingMargin of any building's oriented rectangular footprint. Margins are extra
   * clearance on top of the road half-width / building size — set to 0 for an exact-touch test.
   */
  function isBlocked(x, y, roadMargin = 1.5, buildingMargin = 1.5) {
    if (roads) {
      const { cells, segAx, segAy, segBx, segBy, segCls, gridW, gridH, cellSize, xMinC, yMinC } = roads;
      const gxCenter = Math.floor((x - xMinC) / cellSize);
      const gyCenter = Math.floor((y - yMinC) / cellSize);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = gxCenter + dx;
          const gy = gyCenter + dy;
          if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
          const list = cells[gy * gridW + gx];
          for (let k = 0; k < list.length; k += 1) {
            const idx = list[k];
            const halfW = ROAD_HALF_W[segCls[idx]] + roadMargin;
            const limit = halfW * halfW;
            if (distSqPointSeg(x, y, segAx[idx], segAy[idx], segBx[idx], segBy[idx]) <= limit) {
              return true;
            }
          }
        }
      }
    }
    if (buildings && buildings.cells.length) {
      const { cells, gridW, gridH, cellSize, xMin, yMin, records } = buildings;
      const gxCenter = Math.floor((x - xMin) / cellSize);
      const gyCenter = Math.floor((y - yMin) / cellSize);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = gxCenter + dx;
          const gy = gyCenter + dy;
          if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
          const list = cells[gy * gridW + gx];
          for (let k = 0; k < list.length; k += 1) {
            const idx = list[k];
            const cx = records.cx[idx];
            const cy = records.cy[idx];
            const ang = records.angle[idx];
            const ca = Math.cos(-ang);
            const sa = Math.sin(-ang);
            const lx = ca * (x - cx) - sa * (y - cy);
            const ly = sa * (x - cx) + ca * (y - cy);
            const halfL = records.length[idx] * 0.5 + buildingMargin;
            const halfWB = records.width[idx] * 0.5 + buildingMargin;
            if (Math.abs(lx) <= halfL && Math.abs(ly) <= halfWB) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Fast cheap pre-check: true when at least one road or building exists in the
   * 3x3 grid neighbourhood around (x, y). Used by forest generation to skip the
   * per-instance isBlocked() math entirely for the (vast majority of) seeds
   * sitting in roadless, building-free wilderness. The grid cells (roads: 100 m,
   * buildings: 200 m) comfortably exceed the K_TREES quad radius (~48 m), so a
   * negative answer at the seed location guarantees no instance can be blocked.
   */
  function couldBeBlocked(x, y) {
    if (roads) {
      const { cells, gridW, gridH, cellSize, xMinC, yMinC } = roads;
      const gxCenter = Math.floor((x - xMinC) / cellSize);
      const gyCenter = Math.floor((y - yMinC) / cellSize);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = gxCenter + dx;
          const gy = gyCenter + dy;
          if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
          if (cells[gy * gridW + gx].length > 0) return true;
        }
      }
    }
    if (buildings && buildings.cells.length) {
      const { cells, gridW, gridH, cellSize, xMin, yMin } = buildings;
      const gxCenter = Math.floor((x - xMin) / cellSize);
      const gyCenter = Math.floor((y - yMin) / cellSize);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = gxCenter + dx;
          const gy = gyCenter + dy;
          if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
          if (cells[gy * gridW + gx].length > 0) return true;
        }
      }
    }
    return false;
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
  };
}
