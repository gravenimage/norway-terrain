/**
 * @file Bottom-right "Road Trip" control panel. Builds its own DOM (no HTML edits needed),
 * binds inputs to the supplied roadTripSystem, and subscribes to system state changes so the
 * Drive button label and status text stay accurate without polling.
 */

/**
 * Attach the road-trip panel. Returns a `destroy()` for tests; init.js doesn't currently call
 * it but the parity with other panels makes future teardown trivial.
 */
export function attachRoadTripPanel({ roadTripSystem }) {
  const panel = document.createElement('div');
  panel.id = 'roadtrip-panel';
  panel.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:50',
    'background:rgba(8,12,18,0.78)', 'color:#cfe3ff',
    'font:12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'padding:10px 12px', 'border:1px solid rgba(120,180,255,0.25)', 'border-radius:8px',
    'min-width:220px', 'backdrop-filter:blur(6px)',
  ].join(';');
  panel.innerHTML = `
    <div style="font-weight:600;color:#9ec7ff;margin-bottom:6px;letter-spacing:.04em">ROAD TRIP · E39</div>
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <button data-rt="tp-mek" style="flex:1">→ Mekjarvik</button>
      <button data-rt="tp-egs" style="flex:1">→ Egersund</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button data-rt="drive" style="flex:1;background:#1a4070;color:#fff">Drive</button>
      <button data-rt="stop" style="flex:1">Stop</button>
    </div>
    <label style="display:block;margin:4px 0">
      <span data-rt="height-label">Height: 30 m</span>
      <input data-rt="height" type="range" min="3" max="300" step="1" value="30" style="width:100%">
    </label>
    <label style="display:block;margin:4px 0">
      <span data-rt="speed-label">Speed: 70 km/h</span>
      <input data-rt="speed" type="range" min="10" max="250" step="5" value="70" style="width:100%">
    </label>
    <div data-rt="status" style="margin-top:6px;font-size:11px;color:#8fb4d8;min-height:1.2em">idle</div>
  `;
  document.body.appendChild(panel);

  const q = (sel) => panel.querySelector(`[data-rt="${sel}"]`);
  const btnTpMek = q('tp-mek');
  const btnTpEgs = q('tp-egs');
  const btnDrive = q('drive');
  const btnStop = q('stop');
  const heightInput = q('height');
  const heightLabel = q('height-label');
  const speedInput = q('speed');
  const speedLabel = q('speed-label');
  const statusEl = q('status');

  btnTpMek.addEventListener('click', () => roadTripSystem.teleport('mekjarvik'));
  btnTpEgs.addEventListener('click', () => roadTripSystem.teleport('egersund'));
  btnDrive.addEventListener('click', () => {
    const st = roadTripSystem.getState();
    // Default destination is whichever endpoint is further away in progress-space.
    const target = st.progress < st.totalLen / 2 ? 'egersund' : 'mekjarvik';
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

  /**
   * Reflect current system state into button labels and status text. Called both on every state
   * change event and once on attach to seed the UI for an unloaded route.
   */
  function render(state) {
    if (!state.loaded) {
      statusEl.textContent = 'loading e39.bin…';
      btnDrive.disabled = btnStop.disabled = btnTpMek.disabled = btnTpEgs.disabled = true;
      return;
    }
    btnTpMek.disabled = btnTpEgs.disabled = false;
    const km = (state.progress / 1000);
    const tot = (state.totalLen / 1000);
    if (state.mode === 'driving') {
      btnDrive.disabled = true;
      btnStop.disabled = false;
      const dirLabel = state.direction > 0 ? '→ Egersund' : '→ Mekjarvik';
      statusEl.textContent = `driving ${dirLabel} · ${km.toFixed(2)} / ${tot.toFixed(1)} km`;
    } else {
      btnDrive.disabled = false;
      btnStop.disabled = true;
      let where = '';
      if (state.atMekjarvik) where = ' at Mekjarvik';
      else if (state.atEgersund) where = ' at Egersund';
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
