import assert from 'node:assert/strict';
import test from 'node:test';
import { startViewerServer } from './helpers/viewer-server.mjs';
import { openViewer, unexpectedConsoleMessages, VIEWER_PRESETS, applyPreset } from './helpers/viewer-page.mjs';

test('viewer loads, renders terrain, and exposes expected UI controls', async (t) => {
  const server = await startViewerServer();
  t.after(() => server.stop());

  const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);
  t.after(() => browser.close());

  await applyPreset(page, VIEWER_PRESETS.overview);

  const state = await page.evaluate(() => ({
    title: document.title,
    tileCount: Number(document.getElementById('tcount')?.textContent || '0'),
    cacheCount: Number(document.getElementById('ccount')?.textContent || '0'),
    fpsText: document.getElementById('fps')?.textContent || '',
    controls: [
      'exag',
      'sse',
      'seg',
      'showRoads',
      'showTowns',
      'showBld',
      'showTrees',
      'drape',
      'bldRange',
      'canopyRange',
      'canopyLod',
      'cb-bedrock',
      'cb-quat',
      'cb-faults',
      'r-geo-blend',
      'cb-contours',
      'contour-interval',
      'r-contour-opacity',
    ].map((id) => ({ id, exists: Boolean(document.getElementById(id)) })),
  }));

  assert.ok(state.title.length > 0, 'viewer should have a document title');
  assert.ok(state.tileCount > 0, 'terrain tiles should be drawn');
  assert.ok(state.cacheCount > 0, 'terrain tile cache should be populated');
  assert.match(state.fpsText, /^\d+$/, 'fps HUD should contain a number');
  assert.deepEqual(
    state.controls.filter((control) => !control.exists),
    [],
    'all expected controls should exist',
  );
  assert.deepEqual(unexpectedConsoleMessages(consoleMessages), [], 'viewer should not emit unexpected console errors');
});

test('core UI controls mutate the same visible state used by the monolith', async (t) => {
  const server = await startViewerServer({ port: 8785 });
  t.after(() => server.stop());

  const { browser, page, consoleMessages } = await openViewer(server.viewerUrl);
  t.after(() => browser.close());

  await page.locator('#exag').evaluate((input) => {
    input.value = '2.0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#showRoads').uncheck();
  await page.locator('#showBld').uncheck();
  await page.locator('#showTrees').uncheck();
  await page.locator('#cb-contours').check();
  await page.evaluate(() => {
    const geologyPanel = document.getElementById('geo-panel');
    if (geologyPanel instanceof HTMLDetailsElement) {
      geologyPanel.open = true;
    }
  });
  await page.locator('#cb-bedrock').check();
  await page.locator('#cb-quat').check();
  await page.locator('#r-geo-blend').evaluate((input) => {
    input.value = '0.35';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const state = await page.evaluate(() => ({
    exagLabel: document.getElementById('exagv')?.textContent,
    roadsChecked: document.getElementById('showRoads')?.checked,
    buildingsChecked: document.getElementById('showBld')?.checked,
    treesChecked: document.getElementById('showTrees')?.checked,
    contoursChecked: document.getElementById('cb-contours')?.checked,
    geologyUi: {
      bedrock: document.getElementById('cb-bedrock').checked,
      quat: document.getElementById('cb-quat').checked,
      blend: document.getElementById('r-geo-blend-val').textContent,
    },
  }));

  assert.equal(state.exagLabel, '2.00');
  assert.equal(state.roadsChecked, false);
  assert.equal(state.buildingsChecked, false);
  assert.equal(state.treesChecked, false);
  assert.equal(state.contoursChecked, true);
  assert.deepEqual(state.geologyUi, { bedrock: true, quat: true, blend: '0.35' });
  assert.deepEqual(unexpectedConsoleMessages(consoleMessages), [], 'UI interactions should not emit unexpected console errors');
});
