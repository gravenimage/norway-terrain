/**
 * @file Owns the bidirectional DOM <-> appState binding for viewer controls. Handlers translate DOM input events into appState mutations, and a single appState subscription updates display labels. Side effects on rendering systems and uniforms live in init.js so this file has no dependency on Three.js or feature systems.
 */

/**
 * Attaches sliders, checkboxes, and dropdowns to appState. Every input maps to a named appState entry; init.js owns the fan-out from those entries to systems and uniforms. The optional rebuildPlane callback is the one piece of geometry-side work tied to the segment slider, kept here because it must run before the display label reflects the new segment count.
 */
export function attachControls({ appState, rebuildPlane, getSegments }) {
  /**
   * Wires a slider input to an appState key, optionally transforming the raw
   * numeric value before storing it.
   */
  function bindSlider(elementId, stateKey, transform = (n) => n) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.oninput = () => {
      appState.set(stateKey, transform(Number(el.value)));
    };
  }

  /**
   * Wires a checkbox input to an appState key, storing the boolean directly.
   */
  function bindCheckbox(elementId, stateKey) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.onchange = (event) => {
      appState.set(stateKey, event.target.checked);
    };
  }

  bindSlider('exag', 'exag');
  bindSlider('sse', 'ssePx');
  bindSlider('drape', 'drape');
  bindSlider('bldRange', 'buildingRange', (km) => km * 1000);
  bindSlider('canopyRange', 'canopyRange', (km) => km * 1000);
  bindSlider('canopyLod', 'canopyLodMidKm');
  bindSlider('r-geo-blend', 'geoOpacity');
  bindSlider('r-contour-opacity', 'contourOpacity');

  bindCheckbox('showRoads', 'showRoads');
  bindCheckbox('showTowns', 'showTowns');
  bindCheckbox('showBld', 'showBuildings');
  bindCheckbox('showTrees', 'showTrees');
  bindCheckbox('showLabels', 'showLabels');
  bindCheckbox('showTileEdges', 'showTileEdges');
  bindCheckbox('cb-bedrock', 'showBedrock');
  bindCheckbox('cb-quat', 'showQuaternary');
  bindCheckbox('cb-faults', 'showFaults');
  bindCheckbox('cb-contours', 'showContours');

  const segEl = document.getElementById('seg');
  /**
   * Segment density is the one slider whose displayed value comes from the
   * renderer (post-rebuild) rather than the raw input, so it is handled
   * separately from bindSlider.
   */
  if (segEl) {
    segEl.oninput = () => {
      const value = Number(segEl.value);
      rebuildPlane(value);
      const actual = getSegments?.() ?? value;
      appState.set('segments', actual);
    };
  }

  const intervalEl = document.getElementById('contour-interval');
  if (intervalEl) {
    intervalEl.onchange = (event) => {
      appState.set('contourInterval', parseFloat(event.target.value));
    };
  }

  /**
   * Display-label updates are the inverse direction of the binding: every
   * appState change can refresh the matching <span> so the UI stays
   * consistent regardless of which subsystem mutated state.
   */
  const labelMap = {
    exag: ['exagv', (v) => v.toFixed(2)],
    ssePx: ['ssev', (v) => v.toFixed(1)],
    segments: ['segv', (v) => String(v)],
    drape: ['drapev', (v) => String(v)],
    buildingRange: ['bldRangev', (v) => String(Math.round(v / 1000))],
    canopyRange: ['canopyRangev', (v) => String(Math.round(v / 1000))],
    canopyLodMidKm: ['canopyLodv', (v) => String(v)],
    geoOpacity: ['r-geo-blend-val', (v) => v.toFixed(2)],
    contourOpacity: ['r-contour-opacity-val', (v) => v.toFixed(2)],
  };

  /**
   * Initialise display labels from the current appState snapshot so the
   * panel reads correctly on first paint, before any user interaction.
   */
  const initial = appState.snapshot();
  for (const [key, [elementId, format]] of Object.entries(labelMap)) {
    if (initial[key] === undefined) continue;
    const el = document.getElementById(elementId);
    if (el) el.textContent = format(initial[key]);
  }

  appState.subscribe(({ name, value }) => {
    const entry = labelMap[name];
    if (!entry) return;
    const el = document.getElementById(entry[0]);
    if (el) el.textContent = entry[1](value);
  });
}
