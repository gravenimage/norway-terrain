/**
 * @file Owns the bidirectional DOM <-> appState binding for viewer controls. Handlers translate DOM input events into appState mutations, and a single appState subscription updates display labels. Side effects on rendering systems and uniforms live in init.js so this file has no dependency on Three.js or feature systems.
 */

import {
  CHECKBOX_IDS,
  DISPLAY_IDS,
  OTHER_IDS,
  SLIDER_IDS,
} from './dom-ids.js';

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

  bindSlider(SLIDER_IDS.exag, 'exag');
  bindSlider(SLIDER_IDS.sse, 'ssePx');
  bindSlider(SLIDER_IDS.drape, 'drape');
  bindSlider(SLIDER_IDS.bldRange, 'buildingRange', (km) => km * 1000);
  bindSlider(SLIDER_IDS.canopyRange, 'canopyRange', (km) => km * 1000);
  bindSlider(SLIDER_IDS.canopyLod, 'canopyLodMidKm');
  bindSlider(SLIDER_IDS.geoBlend, 'geoOpacity');
  bindSlider(SLIDER_IDS.contourOpacity, 'contourOpacity');

  bindCheckbox(CHECKBOX_IDS.showRoads, 'showRoads');
  bindCheckbox(CHECKBOX_IDS.showTowns, 'showTowns');
  bindCheckbox(CHECKBOX_IDS.showBuildings, 'showBuildings');
  bindCheckbox(CHECKBOX_IDS.showTrees, 'showTrees');
  bindCheckbox(CHECKBOX_IDS.showLabels, 'showLabels');
  bindCheckbox(CHECKBOX_IDS.showTileEdges, 'showTileEdges');
  bindCheckbox(CHECKBOX_IDS.showBedrock, 'showBedrock');
  bindCheckbox(CHECKBOX_IDS.showQuaternary, 'showQuaternary');
  bindCheckbox(CHECKBOX_IDS.showFaults, 'showFaults');
  bindCheckbox(CHECKBOX_IDS.showContours, 'showContours');

  const segEl = document.getElementById(SLIDER_IDS.seg);
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

  const intervalEl = document.getElementById(OTHER_IDS.contourInterval);
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
    exag: [DISPLAY_IDS.exag, (v) => v.toFixed(2)],
    ssePx: [DISPLAY_IDS.sse, (v) => v.toFixed(1)],
    segments: [DISPLAY_IDS.seg, (v) => String(v)],
    drape: [DISPLAY_IDS.drape, (v) => String(v)],
    buildingRange: [DISPLAY_IDS.bldRange, (v) => String(Math.round(v / 1000))],
    canopyRange: [DISPLAY_IDS.canopyRange, (v) => String(Math.round(v / 1000))],
    canopyLodMidKm: [DISPLAY_IDS.canopyLod, (v) => String(v)],
    geoOpacity: [DISPLAY_IDS.geoBlend, (v) => v.toFixed(2)],
    contourOpacity: [DISPLAY_IDS.contourOpacity, (v) => v.toFixed(2)],
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
