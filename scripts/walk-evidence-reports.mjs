#!/usr/bin/env node
/*
 * THE WALK-EVIDENCE TABLES ARE WRITTEN BY THE FULL HARNESS RUN (2026-09-20, batch 4).
 *
 * Until today each path's table was written by hand-running scripts/walk-evidence.mjs after a spec
 * run, so a table could describe a partial run (one spec file, one path) and a later full run could
 * leave it stale. The root `npm test` now ends the e2e workspace with this script: every path's
 * table is regenerated from the run record the full harness just wrote, with the run's own counts in
 * the query line, so the tables in tasks/reports describe the receipted run and nothing else.
 *
 *   node scripts/walk-evidence-reports.mjs            (after `playwright test` in apps/e2e)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const runFile = resolve(root, 'apps', 'e2e', '.artifacts', 'last-run.json');
if (!existsSync(runFile)) { console.error('walk-evidence-reports: no apps/e2e/.artifacts/last-run.json; run the harness first'); process.exit(1); }
const run = JSON.parse(readFileSync(runFile, 'utf8'));
// Playwright's JSON reporter: stats.expected is the passed count, stats.unexpected the failed.
const passed = Number(run.stats?.expected ?? 0);
const failed = Number(run.stats?.unexpected ?? 0) + Number(run.stats?.flaky ?? 0);
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // the local calendar day, the way the other report files are dated
const scratch = resolve(process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? root, 'saos-e2e', 'walk-logs');
mkdirSync(scratch, { recursive: true });

const NOTES = {
  A: 'Rows come from walk-step annotations the specs push while they run, on the migrated-client fixture (a portal account on one address, the contact record on another; the proposal and sign-in links followed from the emailed hrefs); A3b is the Ops packet step and A3c the consent screen (R27); how=api is the Stripe event beside a passing Pay tap.',
  B: 'The 1040 on extension with IL filed on paper, on the migrated-client fixture; B1 is the fixture person, whose Add a client tap is cleared in ops-add-client.spec.ts; how=api rows are the two Stripe events.',
  D: 'Void, the test-client flag, the refund door on (D3) and off (D3b, R32); how=api rows are the Stripe events.',
  E: 'The migrated client (R37): a proposal link rendering with a stale signed-in marker, the sign-in link spent by a press, the portal email aligned from the client page.',
  Q: 'The Quotes card (R39): Q1 to Q4 are the CEO taps at 390 and 1280; the role proof is ed_coo, who reads the card and holds no quotes.manage.',
};
for (const which of Object.keys(NOTES)) {
  const log = resolve(scratch, `walk-${which.toLowerCase()}.log`);
  const rows = execFileSync('node', [resolve(here, 'walk-evidence.mjs'), which], { cwd: root, encoding: 'utf8' });
  writeFileSync(log, rows);
  execFileSync('node', [resolve(here, 'report-table.mjs'), '--name', `walk-evidence-path-${which.toLowerCase()}`, '--date', date, '--from-log', log,
    '--sql', `node scripts/walk-evidence.mjs ${which}  (reads apps/e2e/.artifacts/last-run.json from the full harness run of ${date}: ${passed} passed, ${failed} failed)`,
    '--note', NOTES[which]], { cwd: root, stdio: 'inherit' });
}
// The edit-door inventory (R38) reads the same run record for its tapped columns.
const doorsLog = resolve(scratch, 'edit-doors.log');
writeFileSync(doorsLog, execFileSync('node', [resolve(here, 'edit-doors.mjs')], { cwd: root, encoding: 'utf8' }));
execFileSync('node', [resolve(here, 'report-table.mjs'), '--name', 'edit-doors', '--date', date, '--from-log', doorsLog,
  '--sql', `node scripts/edit-doors.mjs  (the API route registrations under apps/api/src/modules joined with scripts/edit-doors.json; tapped columns from apps/e2e/.artifacts/last-run.json, the full harness run of ${date}: ${passed} passed, ${failed} failed)`,
  '--note', 'Every entity with a create control has an edit control tapped at both viewports, or an explicit "immutable because" entry (R38); the guard scripts/check-edit-doors.mjs fails the root chain when a create route has no update route with a UI caller and the entity is not marked immutable.'], { cwd: root, stdio: 'inherit' });
