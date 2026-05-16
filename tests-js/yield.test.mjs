import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBudget, processWithBudget, yieldToBrowser } from '../src/client/core/yield.js';

test('yieldToBrowser resolves on the next macrotask', async () => {
  let flag = 'before';
  const p = yieldToBrowser().then(() => { flag = 'after'; });
  // synchronous code after the await initiator should still see 'before'
  assert.equal(flag, 'before');
  await p;
  assert.equal(flag, 'after');
});

test('makeBudget reports elapsed and exceeded', async () => {
  const b = makeBudget(20);
  assert.equal(b.exceeded(), false);
  // Burn ~25ms wall-clock
  const start = Date.now();
  while (Date.now() - start < 25) { /* spin */ }
  assert.equal(b.exceeded(), true);
  b.reset();
  assert.equal(b.exceeded(), false);
});

test('processWithBudget runs every item exactly once and finishes', async () => {
  const items = [1, 2, 3, 4, 5];
  const seen = [];
  await processWithBudget(items, (v, i) => { seen.push([i, v]); }, { budgetMs: 1000 });
  assert.deepEqual(seen, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
});

test('processWithBudget yields and reports progress when budget is exceeded', async () => {
  const items = [0, 1, 2, 3];
  const progress = [];
  await processWithBudget(
    items,
    () => {
      // Each item spins for ~6ms, so two items burn ~12ms and exceed a 5ms budget
      const start = Date.now();
      while (Date.now() - start < 6) { /* spin */ }
    },
    { budgetMs: 5, onProgress: (done, total) => progress.push([done, total]) },
  );
  // Final completion progress is always emitted
  assert.equal(progress[progress.length - 1][0], 4);
  assert.equal(progress[progress.length - 1][1], 4);
  // At least one intermediate yield happened (could be more depending on host)
  assert.ok(progress.length >= 2, `expected at least 2 progress callbacks, got ${progress.length}`);
});

test('processWithBudget handles empty input', async () => {
  let calls = 0;
  await processWithBudget([], () => { calls += 1; }, { onProgress: () => { calls += 1; } });
  // Empty input still emits the final (0,0) completion callback for consistency
  assert.equal(calls, 1);
});

test('processWithBudget never yields when all items finish within the budget', async () => {
  const items = [1, 2, 3];
  const progress = [];
  await processWithBudget(items, () => {}, {
    budgetMs: 1000,
    onProgress: (done, total) => progress.push([done, total]),
  });
  // Only the terminal completion callback should fire
  assert.deepEqual(progress, [[3, 3]]);
});
