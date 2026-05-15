/**
 * @file Tests for computeFadeRange — the inner-edge formula used by every distance fade band. The asserts pin the floor-fraction behaviour at small far ranges and the constant-band behaviour at large ranges so future tweaks must update both expectations.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('computeFadeRange returns far - band when band is below the floor fraction', async () => {
  const { computeFadeRange } = await import('../src/client/core/lod-fade.js');
  const near = computeFadeRange(22000, { bandMetres: 4000, floorFraction: 0.7 });
  assert.equal(near, 18000);
});

test('computeFadeRange clamps to far * floorFraction when far is small', async () => {
  const { computeFadeRange } = await import('../src/client/core/lod-fade.js');
  const near = computeFadeRange(5000, { bandMetres: 4000, floorFraction: 0.7 });
  assert.equal(near, 3500);
});

test('computeFadeRange honours a higher floor fraction for canopy ranges', async () => {
  const { computeFadeRange } = await import('../src/client/core/lod-fade.js');
  const near = computeFadeRange(30000, { bandMetres: 2000, floorFraction: 0.85 });
  assert.equal(near, 28000);
});
