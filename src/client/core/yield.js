/**
 * @file Cooperative scheduling helpers used by long-running loaders to keep the
 * main thread responsive. Forest/canopy generation can iterate tens of millions
 * of instances; without yielding, the page freezes for many seconds during boot.
 *
 * Design notes:
 *  - `yieldToBrowser()` prefers `scheduler.yield()` where supported (Chrome 129+)
 *    and falls back to `setTimeout(0)`. Both unblock input/paint; the scheduler
 *    primitive is preferable because it explicitly returns to the event loop
 *    without timer clamping.
 *  - `processWithBudget()` runs `perItem(item, i)` synchronously while wall-clock
 *    elapsed remains under `budgetMs`. When exceeded it yields, reports progress,
 *    and resumes. A `yieldEvery` knob lets callers ask the helper to nudge
 *    sub-item: pass a numeric `seedsThisItem` (or omit) to do simple per-item
 *    chunking, or use `shouldYield()` directly inside very large items.
 */

const NOW = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

/**
 * Cooperatively yields to the browser event loop. Prefers `scheduler.yield()`
 * (Chrome 129+) for explicit cooperative scheduling, otherwise `setTimeout(0)`.
 * Both flush input/paint before resuming.
 */
export function yieldToBrowser() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a budget-checking helper closure. The returned function reads the
 * wall clock and returns true once `budgetMs` has elapsed since the last reset.
 * Call `reset()` after yielding to start a new budget window.
 */
export function makeBudget(budgetMs = 8) {
  let start = NOW();
  return {
    /**
     * Returns true when the current budget window has been exhausted.
     */
    exceeded() { return NOW() - start >= budgetMs; },
    /**
     * Starts a fresh budget window; call this immediately after yielding.
     */
    reset() { start = NOW(); },
    /**
     * Returns milliseconds elapsed in the current budget window.
     */
    elapsed() { return NOW() - start; },
  };
}

/**
 * Iterates `items`, invoking `perItem(item, index)` synchronously and yielding
 * to the browser when the per-slice wall clock exceeds `budgetMs`. Progress is
 * reported on each yield boundary and once at the end. Items are never split,
 * so callers with very large individual items should use `makeBudget()` inside
 * `perItem` themselves to yield mid-item.
 */
export async function processWithBudget(items, perItem, options = {}) {
  const budgetMs = options.budgetMs ?? 8;
  const onProgress = options.onProgress;
  const n = items.length;
  const budget = makeBudget(budgetMs);
  for (let i = 0; i < n; i += 1) {
    await perItem(items[i], i);
    if (budget.exceeded() && i + 1 < n) {
      if (onProgress) onProgress(i + 1, n);
      await yieldToBrowser();
      budget.reset();
    }
  }
  if (onProgress) onProgress(n, n);
}
