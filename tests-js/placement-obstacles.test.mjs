import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacementObstacles, createNullObstacles } from '../src/client/services/placement-obstacles.js';

/**
 * Builds a minimal road grid with a single segment classified as the widest
 * road class (index 0, half-width 6.5 m). The grid is 1 cell × 1 cell at the
 * origin so the obstacle lookup logic for the 3x3 neighbourhood is exercised
 * without needing real OSM data.
 */
function makeSingleRoadGrid() {
  const segAx = new Float32Array([0]);
  const segAy = new Float32Array([0]);
  const segBx = new Float32Array([100]);
  const segBy = new Float32Array([0]);
  const segCls = new Uint8Array([0]);
  return {
    cells: [[0]],
    segAx, segAy, segBx, segBy, segCls,
    gridW: 1, gridH: 1, cellSize: 100, xMinC: 0, yMinC: 0,
  };
}

test('couldBeBlocked returns false when neither roads nor buildings are loaded', () => {
  const obs = createPlacementObstacles();
  obs.markRoadsEmpty();
  obs.markBuildingsEmpty();
  assert.equal(obs.couldBeBlocked(123, 456), false);
});

test('couldBeBlocked returns true near a road segment cell, false far away', () => {
  const obs = createPlacementObstacles();
  obs.setRoads(makeSingleRoadGrid());
  obs.markBuildingsEmpty();
  // Inside the cell — 3x3 neighbourhood includes the cell with the segment
  assert.equal(obs.couldBeBlocked(50, 50), true);
  // Far outside the grid — outside the 3x3 neighbourhood, all cells out of range
  assert.equal(obs.couldBeBlocked(10000, 10000), false);
});

test('couldBeBlocked agrees with isBlocked semantics for clear areas (no false negatives)', () => {
  const obs = createPlacementObstacles();
  obs.setRoads(makeSingleRoadGrid());
  obs.markBuildingsEmpty();
  // Any point isBlocked() flags must also satisfy couldBeBlocked() — otherwise
  // a seed near a road would skip the per-instance check and miss real hits.
  // Sample a few points inside the road's segment span:
  for (const [x, y] of [[10, 0], [50, 0], [90, 0]]) {
    if (obs.isBlocked(x, y)) {
      assert.equal(obs.couldBeBlocked(x, y), true, `couldBeBlocked must be true wherever isBlocked is, at (${x},${y})`);
    }
  }
});

test('createNullObstacles exposes couldBeBlocked returning false', () => {
  const obs = createNullObstacles();
  assert.equal(obs.couldBeBlocked(0, 0), false);
  assert.equal(obs.couldBeBlocked(1e6, -1e6), false);
});
