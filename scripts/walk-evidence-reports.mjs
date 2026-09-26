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
  G: 'The portal Documents page (R49): G1 reads the three kinds of row on a fixture client (a signed engagement letter and a delivered return filed through POST /documents at boot, the client upload made by the spec through the page control); G2 forces a render failure through the harness-only /harness/documents-crash switch and reads the sentence, the Reload control, the portal_page_error task and the Ops alert through the CEO API.',
  F: 'Filed on and the filing corrected: F1 to F4 are the CEO taps at 390 and 1280 on a synthetic 1120S each viewport opens through the API doors and files from the row; the role proof is the bookkeeper, who has no Correct the filing control and is refused 403.',
  H: 'The business in every Ops search and the stage row that opens (R51, R52, R54): H1 to H3 type the S corp fixture\'s legal name into Deliver Return, New quote and the clients list and read "Business — owner" (ops-business-search.spec.ts); H4 opens a return by hand on a fresh synthetic client through the API doors and taps its stage row on the executive view; H5 is the duplicate-EIN warning, the refusal beside the EIN, Create anyway and Save anyway with a reason (ops-add-business.spec.ts).',
  S: 'The Returns card as a stepper (R50, behind OPS_RETURN_STEPPER, off in production): S1 and S2 read the stepper on the harness return with the switch flipped on through the harness-only /harness/return-stepper door, S3 the row with it off, at 390 and 1280; the role proof is ed_coo, who reads the steps and gets no control and no details area. The nine approval screenshots come from return-stepper-shots.spec.ts, not from these rows.',
  P: 'R45 to R48 (2026-09-26): P1 the contact-email change on the client page offering to move the sign-in, the confirmation link read from the harness mailer and pressed on the portal (ops-portal-email-move.spec.ts); P2 the portal home and sign page after the client signs the packet on the signing fixture (a withdrawn 1040 with its letter, two letters on the live 1120-S; portal-signing-home.spec.ts); P3 the Documents upload control on a fresh client (portal-upload-control.spec.ts); P4 Deliver a return with the return_delivered notice off and on through the admin toggle (ops-deliver-return.spec.ts); P5 My Returns on a return walked through the API doors from delivery to filed (portal-returns-next.spec.ts).',
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
