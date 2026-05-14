/**
 * @file Bottom-right "Road Trip" control panel. Builds its own DOM, binds inputs to the
 * supplied roadTripSystem, and subscribes to system state changes so button labels and the
 * status text stay accurate without polling.
 *
 * Multi-trip support: a `<select>` at the top of the panel is populated from
 * `roadTripSystem.getTrips()` (the `trips.json` manifest). Switching trips calls
 * `setTrip(id)`, which auto-stops driving and persists the choice via localStorage on the
 * system side. Endpoint button labels follow the active trip's `fromLabel` / `toLabel`.
 */

export function attachRoadTripPanel({ roadTripSystem }) {
  const panel = document.createElement('div');
  panel.id = 'roadtrip-panel';
  panel.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:50',
    'background:rgba(8,12,18,0.78)', 'color:#cfe3ff',
    'font:12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'padding:10px 12px', 'border:1px solid rgba(120,180,255,0.25)', 'border-radius:8px',
    'min-width:240px', 'backdrop-filter:blur(6px)',
  ].join(';');
  panel.innerHTML = `
    <details class="panel-body" data-panel-key="roadtrip" open>
      <summary style="letter-spacing:.04em">ROAD TRIP</summary>
      <label style="display:block;margin:6px 0 4px">
        <select data-rt="trip" style="width:100%;padding:3px 4px;background:#0c1626;color:#cfe3ff;border:1px solid rgba(120,180,255,0.3);border-radius:4px;font:inherit"></select>
      </label>
      <div style="display:flex;gap:4px;margin-bottom:8px;margin-top:4px;align-items:stretch">
        <button data-rt="tp-from" style="flex:1;white-space:nowrap">From</button>
        <button data-rt="drive" style="flex:1;background:#1a4070;color:#fff;white-space:nowrap">Drive →</button>
        <button data-rt="stop" title="Stop" style="width:30px;padding:0;font-size:14px">⏸</button>
        <button data-rt="tp-to" style="flex:1;white-space:nowrap">To</button>
      </div>
      <label style="display:block;margin:4px 0">
        <span data-rt="height-label">Height: 75 m</span>
        <input data-rt="height" type="range" min="3" max="300" step="1" value="75" style="width:100%">
      </label>
      <label style="display:block;margin:4px 0">
        <span data-rt="speed-label">Speed: 70 km/h</span>
        <input data-rt="speed" type="range" min="10" max="250" step="5" value="70" style="width:100%">
      </label>
      <div data-rt="status" style="margin-top:6px;font-size:11px;color:#8fb4d8;min-height:1.2em">idle</div>
    </details>
  `;
  document.body.appendChild(panel);
  if (typeof window !== 'undefined' && typeof window.__wirePanels === 'function') {
    window.__wirePanels();
  }

  const q = (sel) => panel.querySelector(`[data-rt="${sel}"]`);
  const tripSelect = q('trip');
  const btnTpFrom = q('tp-from');
  const btnTpTo = q('tp-to');
  const btnDrive = q('drive');
  const btnStop = q('stop');
  const heightInput = q('height');
  const heightLabel = q('height-label');
  const speedInput = q('speed');
  const speedLabel = q('speed-label');
  const statusEl = q('status');

  btnTpFrom.addEventListener('click', () => roadTripSystem.teleport('from'));
  btnTpTo.addEventListener('click', () => roadTripSystem.teleport('to'));
  btnDrive.addEventListener('click', () => {
    const st = roadTripSystem.getState();
    // The Drive button always sends the camera in the current `direction` (set by the last
    // teleport or the last in-progress drive), so the arrow on the button matches actual
    // motion regardless of how the user navigated to this state.
    const target = st.direction > 0 ? 'to' : 'from';
    roadTripSystem.startDrive(target);
  });
  btnStop.addEventListener('click', () => roadTripSystem.stop());
  heightInput.addEventListener('input', () => {
    const h = parseFloat(heightInput.value);
    heightLabel.textContent = `Height: ${h.toFixed(0)} m`;
    roadTripSystem.setHeight(h);
  });
  speedInput.addEventListener('input', () => {
    const v = parseFloat(speedInput.value);
    speedLabel.textContent = `Speed: ${v.toFixed(0)} km/h`;
    roadTripSystem.setSpeed(v);
  });
  tripSelect.addEventListener('change', () => {
    // setTrip() is async (fetches a new .bin), but render() will be called from the system's
    // own state-change notification once the swap completes; we just kick it off here.
    roadTripSystem.setTrip(tripSelect.value);
  });

  // `populatedTripIds` lets us avoid rebuilding the <option> list every state-change tick;
  // the manifest is fetched once and never changes during the page's lifetime.
  let populatedTripIds = '';

  function populateTrips(state) {
    const trips = roadTripSystem.getTrips();
    if (!trips.length) return;
    const sig = trips.map((t) => t.id).join('|');
    if (sig === populatedTripIds) return;
    populatedTripIds = sig;
    // Clear and rebuild. Browsers preserve `value` only if an option with that value exists,
    // so we assign `tripSelect.value` after appending all options to ensure the correct row
    // is selected.
    tripSelect.innerHTML = '';
    for (const trip of trips) {
      const opt = document.createElement('option');
      opt.value = trip.id;
      const km = typeof trip.lengthKm === 'number' ? ` (${trip.lengthKm.toFixed(0)} km)` : '';
      opt.textContent = `${trip.title}${km}`;
      tripSelect.appendChild(opt);
    }
    if (state.currentTripId) tripSelect.value = state.currentTripId;
  }

  function render(state) {
    populateTrips(state);
    // Endpoint button labels come from the manifest, so they update automatically when the
    // user picks a different trip from the dropdown.
    btnTpFrom.textContent = state.fromLabel || 'From';
    btnTpTo.textContent = state.toLabel || 'To';
    btnDrive.textContent = state.direction > 0 ? 'Drive →' : '← Drive';
    if (state.currentTripId && tripSelect.value !== state.currentTripId) {
      tripSelect.value = state.currentTripId;
    }
    if (!state.loaded) {
      statusEl.textContent = 'loading…';
      btnDrive.disabled = btnStop.disabled = btnTpFrom.disabled = btnTpTo.disabled = true;
      return;
    }
    btnTpFrom.disabled = btnTpTo.disabled = false;
    const km = (state.progress / 1000);
    const tot = (state.totalLen / 1000);
    if (state.mode === 'driving') {
      btnDrive.disabled = true;
      btnStop.disabled = false;
      const dirLabel = state.direction > 0 ? `→ ${state.toLabel}` : `→ ${state.fromLabel}`;
      statusEl.textContent = `driving ${dirLabel} · ${km.toFixed(2)} / ${tot.toFixed(1)} km`;
    } else {
      btnDrive.disabled = false;
      btnStop.disabled = true;
      let where = '';
      if (state.atFrom) where = ` at ${state.fromLabel}`;
      else if (state.atTo) where = ` at ${state.toLabel}`;
      else where = ` at ${km.toFixed(2)} km`;
      statusEl.textContent = `idle${where}`;
    }
  }

  const unsubscribe = roadTripSystem.onChange(render);
  render(roadTripSystem.getState());

  return {
    destroy() {
      unsubscribe();
      panel.remove();
    },
  };
}
