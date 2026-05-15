/**
 * @file Pins Playwright defaults for the viewer visual-regression suite. The config keeps Playwright local-dev quiet (1 worker, no retries) while letting CI use moderate retries; baseline screenshots live next to the test file under a snapshots directory Playwright manages.
 */

import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests-js',
  testMatch: /viewer-visual\.test\.mjs$/,
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
