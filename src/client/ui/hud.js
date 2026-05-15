/**
 * @file Owns lightweight HUD updates for render-loop diagnostics. The functions tolerate missing DOM nodes so tests and partial pages can reuse them safely.
 */

import { HUD_IDS } from './dom-ids.js';

/**
 * Publishes current terrain draw and cache counts to the HUD without owning the render-loop state that produces them.
 */
export function updateHud({ drawn, cacheSize }) {
  const tileCount = document.getElementById(HUD_IDS.tileCount);
  const cacheCount = document.getElementById(HUD_IDS.cacheCount);
  if (tileCount) tileCount.textContent = String(drawn);
  if (cacheCount) cacheCount.textContent = String(cacheSize);
}

/**
 * Shows an integer frames-per-second value while keeping FPS measurement responsibility in the render loop.
 */
export function updateFps(fps) {
  const fpsEl = document.getElementById(HUD_IDS.fps);
  if (fpsEl) fpsEl.textContent = String(Math.round(fps));
}
