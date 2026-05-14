import { chromium } from 'playwright';

export const VIEWER_PRESETS = {
  overview: {
    position: [25000, 18000, 18000],
    target: [0, 0, 0],
  },
  terrainClose: {
    position: [8000, 5000, 3500],
    target: [0, 0, 600],
  },
  geology: {
    position: [14000, -9000, 9000],
    target: [0, 0, 500],
  },
  forest: {
    position: [-8000, 12000, 7000],
    target: [0, 0, 500],
  },
};

export async function openViewer(viewerUrl) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const consoleMessages = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });

  page.on('pageerror', (error) => {
    consoleMessages.push({ type: 'pageerror', text: error.message });
  });

  await page.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await page.evaluate(() => {
    const contourPanel = document.getElementById('contour-panel');
    if (contourPanel instanceof HTMLDetailsElement) {
      contourPanel.open = true;
    }
  });

  return { browser, page, consoleMessages };
}

export async function waitForViewerReady(page) {
  // Stage 1: viewer scaffolding is wired up (THREE renderer, scene, camera, HUD root).
  await page.waitForFunction(() => {
    const viewer = window.__viewer;
    const hud = document.getElementById('hud');
    return Boolean(viewer?.camera && viewer?.scene && viewer?.renderer && hud);
  }, undefined, { timeout: 30000 });

  // Stage 2: terrain data fetch + render loop have produced both a populated tile
  // cache and at least one HUD update (fps > 0). We deliberately do NOT require
  // tcount > 0 here because the monolith's default camera is far enough out that
  // no tiles are selected for drawing until a preset positions the camera over
  // the terrain.
  await page.waitForFunction(() => {
    const ccount = Number(document.getElementById('ccount')?.textContent || '0');
    const fps = Number(document.getElementById('fps')?.textContent || '0');
    return ccount > 0 && fps > 0;
  }, undefined, { timeout: 60000 });
}

export async function applyPreset(page, preset) {
  await page.evaluate(({ position, target }) => {
    const { camera, controls } = window.__viewer;
    camera.position.set(position[0], position[1], position[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }, preset);

  // After moving the camera over the terrain, wait for the LOD traversal to
  // actually select tiles for drawing so callers can rely on tcount > 0.
  await page.waitForFunction(
    () => Number(document.getElementById('tcount')?.textContent || '0') > 0,
    undefined,
    { timeout: 30000 },
  );
}

export function unexpectedConsoleMessages(consoleMessages) {
  return consoleMessages.filter((message) => message.type === 'error' || message.type === 'pageerror');
}
