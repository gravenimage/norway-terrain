import { test, expect } from '@playwright/test';
import { startViewerServer } from './helpers/viewer-server.mjs';
import { applyPreset, openViewer, unexpectedConsoleMessages, VIEWER_PRESETS } from './helpers/viewer-page.mjs';

const PRESET_NAMES = Object.keys(VIEWER_PRESETS);

for (const name of PRESET_NAMES) {
  test(`viewer visual baseline: ${name}`, async () => {
    test.setTimeout(120_000);
    const server = await startViewerServer({ port: 8800 + PRESET_NAMES.indexOf(name) });
    const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);

    try {
      await applyPreset(page, VIEWER_PRESETS[name]);
      // Wait for the streaming LOD renderer to reach a quiescent state:
      // tile cache size + drawn-tile count must remain unchanged for several
      // consecutive 200ms samples. This avoids capturing a mid-stream frame.
      await page.waitForFunction(() => {
        const w = /** @type {any} */ (window);
        const ccount = document.getElementById('ccount')?.textContent || '';
        const tcount = document.getElementById('tcount')?.textContent || '';
        const key = `${ccount}|${tcount}`;
        w.__stableSamples = w.__stableSamples || [];
        w.__stableSamples.push(key);
        if (w.__stableSamples.length > 8) w.__stableSamples.shift();
        return w.__stableSamples.length >= 8 && w.__stableSamples.every((k) => k === key);
      }, null, { timeout: 60_000, polling: 250 });
      // Hide the live-updating HUD so the screenshot is determined only by the
      // WebGL canvas + static UI chrome.
      await page.evaluate(() => {
        const hud = document.getElementById('hud');
        if (hud) hud.style.visibility = 'hidden';
      });
      const buf = await page.screenshot({ animations: 'disabled', fullPage: false });
      expect(buf).toMatchSnapshot(`viewer-${name}.png`, { maxDiffPixelRatio: 0.05 });
      expect(unexpectedConsoleMessages(consoleMessages)).toEqual([]);
    } finally {
      await browser.close();
      await server.stop();
    }
  });
}


