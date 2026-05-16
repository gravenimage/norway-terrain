import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressTracker } from '../src/client/ui/progress.js';

test('start records a task and notifies subscribers', () => {
  const events = [];
  const tracker = createProgressTracker({ documentRef: null, onChange: (s) => events.push(s) });
  tracker.start('forest', 'Forest');
  const snap = tracker.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'forest');
  assert.equal(snap[0].label, 'Forest');
  assert.equal(snap[0].done, false);
  assert.equal(snap[0].errored, false);
  assert.equal(events.length, 1);
});

test('update records phase and counters', () => {
  const tracker = createProgressTracker({ documentRef: null });
  tracker.start('forest', 'Forest');
  tracker.update('forest', { phase: 'parsing' });
  tracker.update('forest', { current: 5, total: 100 });
  const t = tracker.snapshot()[0];
  assert.equal(t.phase, 'parsing');
  assert.equal(t.current, 5);
  assert.equal(t.total, 100);
});

test('update on unknown id is a no-op', () => {
  const tracker = createProgressTracker({ documentRef: null });
  // Must not throw and must not create a task implicitly
  tracker.update('ghost', { current: 1, total: 10 });
  assert.equal(tracker.snapshot().length, 0);
});

test('finish marks done and removes after the linger delay', async () => {
  const tracker = createProgressTracker({ documentRef: null });
  tracker.start('forest', 'Forest');
  tracker.finish('forest');
  // Linger window keeps the entry visible briefly
  assert.equal(tracker.snapshot()[0].done, true);
  // Wait for the auto-removal timer (REMOVE_DELAY_MS = 800ms)
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(tracker.snapshot().length, 0);
});

test('error marks errored with message', () => {
  const tracker = createProgressTracker({ documentRef: null });
  tracker.start('forest', 'Forest');
  tracker.error('forest', 'fetch failed');
  const t = tracker.snapshot()[0];
  assert.equal(t.errored, true);
  assert.equal(t.phase, 'fetch failed');
});

test('concurrent tasks each track independently', () => {
  const tracker = createProgressTracker({ documentRef: null });
  tracker.start('forest', 'Forest');
  tracker.start('canopy', 'Canopy');
  tracker.update('forest', { current: 3, total: 10 });
  tracker.update('canopy', { current: 7, total: 8 });
  const snap = tracker.snapshot();
  const forest = snap.find((t) => t.id === 'forest');
  const canopy = snap.find((t) => t.id === 'canopy');
  assert.equal(forest.current, 3);
  assert.equal(canopy.current, 7);
});

test('restarting an in-flight task resets its state', () => {
  const tracker = createProgressTracker({ documentRef: null });
  tracker.start('forest', 'Forest');
  tracker.update('forest', { current: 99, total: 100, phase: 'almost' });
  tracker.start('forest', 'Forest (retry)');
  const t = tracker.snapshot()[0];
  assert.equal(t.label, 'Forest (retry)');
  assert.equal(t.current, 0);
  assert.equal(t.total, 0);
  assert.equal(t.phase, '');
  assert.equal(t.done, false);
  assert.equal(t.errored, false);
});
