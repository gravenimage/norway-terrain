/**
 * @file Owns the registry of every DOM element id consumed by the viewer client. Centralising the strings lets controls.js, hud.js, and init.js validation refer to the same names, and lets validateDomIds() warn loudly when viewer.html drifts away from the JavaScript expectations.
 */

/**
 * Slider inputs that bind to numeric appState entries.
 */
export const SLIDER_IDS = Object.freeze({
  exag: 'exag',
  sse: 'sse',
  seg: 'seg',
  drape: 'drape',
  bldRange: 'bldRange',
  canopyRange: 'canopyRange',
  canopyLod: 'canopyLod',
  geoBlend: 'r-geo-blend',
  contourOpacity: 'r-contour-opacity',
});

/**
 * Display spans that mirror the matching slider's current value.
 */
export const DISPLAY_IDS = Object.freeze({
  exag: 'exagv',
  sse: 'ssev',
  seg: 'segv',
  drape: 'drapev',
  bldRange: 'bldRangev',
  canopyRange: 'canopyRangev',
  canopyLod: 'canopyLodv',
  geoBlend: 'r-geo-blend-val',
  contourOpacity: 'r-contour-opacity-val',
});

/**
 * Boolean toggles that bind to visibility / overlay flags in appState.
 */
export const CHECKBOX_IDS = Object.freeze({
  showRoads: 'showRoads',
  showTowns: 'showTowns',
  showBuildings: 'showBld',
  showTrees: 'showTrees',
  showLabels: 'showLabels',
  showTileEdges: 'showTileEdges',
  showBedrock: 'cb-bedrock',
  showQuaternary: 'cb-quat',
  showFaults: 'cb-faults',
  showContours: 'cb-contours',
});

/**
 * Miscellaneous controls that do not fit slider/checkbox/display.
 */
export const OTHER_IDS = Object.freeze({
  contourInterval: 'contour-interval',
});

/**
 * HUD and persistent structural elements present in viewer.html.
 */
export const HUD_IDS = Object.freeze({
  hud: 'hud',
  tileCount: 'tcount',
  cacheCount: 'ccount',
  fps: 'fps',
});

/**
 * Confirms that every id this module declares is present in the live DOM. Logs a console.warn listing any missing ids so a developer can spot viewer.html drift early instead of debugging silent failures in individual handlers. Returns the array of missing ids so callers can react if they choose.
 */
export function validateDomIds() {
  const allIds = [
    ...Object.values(SLIDER_IDS),
    ...Object.values(DISPLAY_IDS),
    ...Object.values(CHECKBOX_IDS),
    ...Object.values(OTHER_IDS),
    ...Object.values(HUD_IDS),
  ];
  const missing = allIds.filter((id) => !document.getElementById(id));
  if (missing.length > 0) {
    console.warn('[viewer] DOM id registry mismatch — missing:', missing);
  }
  return missing;
}
