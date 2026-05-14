/**
 * @file Owns the small observable state container used by UI controls. State is private to the factory, while subscribers share change records instead of direct mutable access.
 */

/**
 * Creates a viewer-scoped state store from initial control values. The returned object provides get/set/snapshot/subscribe methods; callers share the store reference, but only the factory owns the backing state and listener set.
 */
export function createAppState(initialState) {
  const state = { ...initialState };
  const listeners = new Set();

  return {
    /**
     * Reads a named value without exposing the mutable state object.
     */
    get(name) {
      return state[name];
    },
    /**
     * Updates one value and notifies listeners only when Object.is detects a real change.
     */
    set(name, value) {
      const previous = state[name];
      if (Object.is(previous, value)) {
        return;
      }
      state[name] = value;
      for (const listener of listeners) {
        listener({ name, previous, value });
      }
    },
    /**
     * Returns a shallow copy so consumers can inspect current state without mutating the store.
     */
    snapshot() {
      return { ...state };
    },
    /**
     * Registers a change listener and returns the unsubscribe function that owns its cleanup.
     */
    subscribe(listener) {
      listeners.add(listener);
      /**
       * Removes exactly the listener added by this subscription without affecting other observers.
       */
      return () => listeners.delete(listener);
    },
  };
}
