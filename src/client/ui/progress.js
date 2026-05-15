/**
 * @file Tiny progress tracker for async loaders. Renders a fixed-position panel
 * of active tasks (id → label + phase + N/M) so users see what the page is
 * doing during boot. Multiple tasks can run concurrently; finished entries
 * linger briefly so the final state is readable, then auto-remove.
 *
 * The tracker is decoupled from any single loader. Each loader gets the tracker
 * by injection and calls start/update/finish on its own id. Tests run without a
 * DOM by passing `documentRef: null`, which makes all DOM work a no-op while
 * the bookkeeping (active task map, callbacks) still works.
 */

const REMOVE_DELAY_MS = 800;

/**
 * Creates a progress tracker. When `documentRef` is null (e.g. node tests),
 * DOM rendering is skipped; the bookkeeping API still works so callers can be
 * exercised without jsdom. `onChange` fires after every state mutation and is
 * convenient for tests asserting state transitions.
 */
export function createProgressTracker({ documentRef = (typeof document !== 'undefined' ? document : null), onChange } = {}) {
  const tasks = new Map();
  let container = null;

  /**
   * Lazily attaches the container the first time a task is started. Kept inside
   * the factory so multiple trackers can coexist (e.g. tests) without colliding.
   */
  function ensureContainer() {
    if (!documentRef || container) return;
    container = documentRef.createElement('div');
    container.id = 'viewer-progress';
    container.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99998;font:12px/1.35 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,0.62);padding:6px 10px;border-radius:6px;max-width:340px;pointer-events:none;backdrop-filter:blur(2px);';
    documentRef.body.appendChild(container);
  }

  /**
   * Renders the active task list into the container. Cheap to call repeatedly;
   * uses textContent (no innerHTML) so user-supplied labels can't inject markup.
   */
  function render() {
    if (!container) return;
    if (tasks.size === 0) {
      container.style.display = 'none';
      container.textContent = '';
      return;
    }
    container.style.display = 'block';
    container.textContent = '';
    for (const { label, phase, current, total, done, errored } of tasks.values()) {
      const row = documentRef.createElement('div');
      let suffix = '';
      if (errored) {
        suffix = ' — failed';
      } else if (done) {
        suffix = ' — done';
      } else if (phase) {
        suffix = `: ${phase}`;
        if (total > 0) suffix += ` (${current}/${total})`;
      } else if (total > 0) {
        suffix = ` (${current}/${total})`;
      }
      row.textContent = `${label}${suffix}`;
      container.appendChild(row);
    }
  }

  /**
   * Notifies the optional onChange callback with a snapshot of the active map.
   */
  function notify() {
    if (!onChange) return;
    const snapshot = [];
    for (const [id, t] of tasks) snapshot.push({ id, ...t });
    onChange(snapshot);
  }

  /**
   * Removes a task after a short delay so the final state stays visible. Safe
   * if the same id is restarted before the timer fires (the timer is cleared).
   */
  function scheduleRemoval(id, delayMs = REMOVE_DELAY_MS) {
    const task = tasks.get(id);
    if (!task) return;
    if (task.removeTimer) clearTimeout(task.removeTimer);
    task.removeTimer = setTimeout(() => {
      tasks.delete(id);
      render();
      notify();
    }, delayMs);
  }

  return {
    /**
     * Begins or restarts a task. If the id is already active its state is
     * reset (label/phase overwritten, counters cleared) rather than ignored,
     * so a re-fetch surfaces a fresh status line.
     */
    start(id, label) {
      ensureContainer();
      const existing = tasks.get(id);
      if (existing && existing.removeTimer) clearTimeout(existing.removeTimer);
      tasks.set(id, { label, phase: '', current: 0, total: 0, done: false, errored: false, removeTimer: 0 });
      render();
      notify();
    },
    /**
     * Records new phase/progress for an in-flight task. Any of phase/current/
     * total may be omitted; only provided fields are updated.
     */
    update(id, { phase, current, total } = {}) {
      const task = tasks.get(id);
      if (!task) return;
      if (phase !== undefined) task.phase = phase;
      if (current !== undefined) task.current = current;
      if (total !== undefined) task.total = total;
      render();
      notify();
    },
    /**
     * Marks a task complete and schedules its removal from the UI. The state
     * lingers briefly so the user can read it before it disappears.
     */
    finish(id) {
      const task = tasks.get(id);
      if (!task) return;
      task.done = true;
      task.phase = '';
      render();
      notify();
      scheduleRemoval(id);
    },
    /**
     * Marks a task as failed; the message replaces the phase label so the
     * user sees why. Errored tasks also auto-remove after the standard delay.
     */
    error(id, message) {
      const task = tasks.get(id);
      if (!task) return;
      task.errored = true;
      task.phase = message ? String(message) : 'failed';
      render();
      notify();
      scheduleRemoval(id);
    },
    /**
     * Returns a plain snapshot of current tasks for tests/debugging without
     * exposing the internal map.
     */
    snapshot() {
      const out = [];
      for (const [id, t] of tasks) out.push({ id, label: t.label, phase: t.phase, current: t.current, total: t.total, done: t.done, errored: t.errored });
      return out;
    },
  };
}
