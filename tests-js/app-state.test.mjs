/**
 * @file Behavioural tests for createAppState: subscriber bookkeeping and unsubscribe semantics beyond the single get/set covered in client-contracts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('app state seeds from initial values and exposes them through get/snapshot', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const state = createAppState({ exag: 1.4, ssePx: 3 });
  assert.equal(state.get('exag'), 1.4);
  assert.equal(state.get('ssePx'), 3);
  assert.deepEqual(state.snapshot(), { exag: 1.4, ssePx: 3 });
});

test('app state subscribers stop receiving updates after their unsubscribe is called', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const state = createAppState({ exag: 1.4 });
  const changes = [];
  const unsubscribe = state.subscribe((change) => changes.push(change));
  state.set('exag', 2.0);
  unsubscribe();
  state.set('exag', 2.5);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].value, 2.0);
});

test('app state fan-out delivers every change to every active subscriber', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const state = createAppState({ exag: 1.4 });
  const a = [];
  const b = [];
  state.subscribe((c) => a.push(c.value));
  state.subscribe((c) => b.push(c.value));
  state.set('exag', 2.0);
  state.set('exag', 2.5);
  assert.deepEqual(a, [2.0, 2.5]);
  assert.deepEqual(b, [2.0, 2.5]);
});

test('app state ignores set calls that do not change the stored value', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const state = createAppState({ exag: 1.4 });
  let count = 0;
  state.subscribe(() => { count += 1; });
  state.set('exag', 1.4);
  state.set('exag', 1.4);
  assert.equal(count, 0);
});

test('app state snapshot is a defensive copy that cannot mutate the store', async () => {
  const { createAppState } = await import('../src/client/core/app-state.js');
  const state = createAppState({ exag: 1.4 });
  const snap = state.snapshot();
  snap.exag = 99;
  assert.equal(state.get('exag'), 1.4);
});
