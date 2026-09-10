/*
 * THE RENDERED-OUTPUT HARNESS (decision 3, 2026-09-10, Brian's ruling).
 *
 * The API suite proves what the server says; the static guards read the source; the browser
 * walk is a person. This is the layer between: the real API against a fresh test database,
 * the real Ops app, a real browser, one page per run, asserted on what a person would read —
 * at 390 × 844 (the iPhone) and 1280 × 800 (the desk).
 *
 * Root suite: it runs from `npm test` like every other workspace test; red blocks deploy.
 * Failures commit their screenshots under tasks/walks/<date>/; passing artifacts stay local
 * under .artifacts/ for 14 days (prune-artifacts.mjs) and the report links them.
 * Gate for page two: five consecutive green runs of page one.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/runs',
  use: {
    baseURL: 'http://localhost:3105',
    screenshot: 'off', // the spec takes its own, named by viewport, so a pass leaves a picture too
    trace: 'retain-on-failure',
  },
  projects: [
    // The iPhone preset (touch, mobile UA) in Chromium: one browser to install, the phone geometry to read.
    { name: 'phone', use: { ...devices['iPhone 14'], defaultBrowserType: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: 'desk', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
});
