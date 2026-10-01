/*
 * THE RENDERED-OUTPUT HARNESS (decision 3, 2026-09-10, Brian's ruling).
 *
 * The API suite proves what the server says; the static guards read the source; the browser
 * walk is a person. This is the layer between: the real API against a fresh test database,
 * the real Ops app, a real browser, one page per run, asserted on what a person would read —
 * at 375, 768 and 1440 in Chromium and WebKit (R106, 2026-09-30; until then 390 and 1280).
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
  reporter: [['list'], ['json', { outputFile: process.env.E2E_RUN_FILE ?? '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/runs',
  use: {
    baseURL: 'http://localhost:3105',
    screenshot: 'off', // the spec takes its own, named by viewport, so a pass leaves a picture too
    trace: 'retain-on-failure',
  },
  projects: [
    /*
     * THE SIX PROJECTS (Brian, 2026-09-30, R106): 375, 768 and 1440 in Chromium and WebKit, his
     * definition of done. Every walk and the layout audit run in all six. The narrow WebKit is the
     * iPhone (touch, mobile user agent, the engine of Brian's phone); the others are the browsers at
     * width. scripts run-harness.mjs runs each project against its own fresh harness database, so a
     * walk that consumes its fixture state finds it whole in every project; a walk reads the fixture
     * set for its width (viewport.ts: under 768 the narrow set, otherwise the wide one).
     */
    { name: 'chromium-375', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } } },
    { name: 'chromium-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'chromium-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit-375', use: { ...devices['iPhone 14'], viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 } },
    { name: 'webkit-768', use: { ...devices['Desktop Safari'], viewport: { width: 768, height: 1024 } } },
    { name: 'webkit-1440', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
});
