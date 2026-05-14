export function createAppState(initialState) {
  const state = { ...initialState };
  const listeners = new Set();

  return {
    get(name) {
      return state[name];
    },
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
    snapshot() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
