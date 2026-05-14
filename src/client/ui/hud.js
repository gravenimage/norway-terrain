export function updateHud({ drawn, cacheSize }) {
  const tileCount = document.getElementById('tcount');
  const cacheCount = document.getElementById('ccount');
  if (tileCount) tileCount.textContent = String(drawn);
  if (cacheCount) cacheCount.textContent = String(cacheSize);
}

export function updateFps(fps) {
  const fpsEl = document.getElementById('fps');
  if (fpsEl) fpsEl.textContent = String(Math.round(fps));
}
