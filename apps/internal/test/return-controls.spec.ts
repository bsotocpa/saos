/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2) — the Ops half.
 *
 * The decision that shows or hides the controls is a pure function of the session's permissions
 * (lib/return-controls.ts), proven here for real: a bookkeeper's grants hide them, the preparer's
 * and the CEO's show them. The wiring — that the Returns card renders the component and that the
 * component decides from GET /auth/me and renders nothing otherwise — is checked in the source,
 * because the front-end has no render harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canManageReturns, controlsApply, dollarsToCents, outsideRange, stageActionLabel } from '../lib/return-controls.ts';

// The grants as seeded (packages/db/seeds/data/roles.mjs), synthetic sessions.
const BOOKKEEPER = ['contacts.read', 'bookkeeping.assigned.manage', 'documents.read', 'documents.read.all', 'documents.write', 'tasks.read', 'tasks.manage', 'time.log'];
const VA_ENTITY = ['contacts.read', 'entity.manage', 'documents.read', 'documents.read.entity', 'documents.write', 'tasks.read', 'tasks.manage', 'time.log'];
const PREPARER = ['contacts.read', 'engagements.read', 'engagements.tax.manage', 'irs_notices.manage', 'documents.read'];
const CEO = ['*', 'deposits.override'];

const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');
const component = readFileSync(new URL('../components/return-controls.tsx', import.meta.url), 'utf8');

test('role proof: a bookkeeper (and the VA) cannot see the controls; the preparer and the CEO can', () => {
  assert.equal(canManageReturns(BOOKKEEPER), false);
  assert.equal(canManageReturns(VA_ENTITY), false);
  assert.equal(canManageReturns(PREPARER), true);
  assert.equal(canManageReturns(CEO), true);
  assert.equal(canManageReturns(null), false, 'no session, no controls');
});

test('the component decides from GET /auth/me and renders nothing without the permission', () => {
  assert.match(component, /api<\{ permissions: string\[\] \}>\('\/auth\/me'\)/, 'reads the session');
  assert.match(component, /setCanManage\(canManageReturns\(m\.permissions\)\)/, 'the pure decision');
  assert.match(component, /if \(!canManage \|\| !applies\) return null;/, 'nothing, not disabled buttons');
});

test('the Returns card renders the controls inside its rows, and nowhere else on the page', () => {
  const section = page.slice(page.indexOf('<h2>Returns</h2>'), page.indexOf('</section>', page.indexOf('<h2>Returns</h2>')));
  assert.match(section, /<ReturnControls taxEngagementId=\{t\.id\} contactId=\{params\.id\} stage=\{t\.stage\} onChanged=\{load\} \/>/);
  assert.equal(page.match(/<ReturnControls /g)?.length, 1);
});

test('the buttons say where the return goes; filed is "Mark filed"', () => {
  assert.equal(stageActionLabel('ready_to_file'), 'Ready to file');
  assert.equal(stageActionLabel('filed'), 'Mark filed');
  assert.equal(stageActionLabel('in_preparation'), 'Start preparation');
  assert.equal(stageActionLabel('something_new'), 'something new', 'an unknown stage never crashes the card');
  for (const name of ['Lock estimate', 'Set final fee', 'Upload the signed 8879']) {
    assert.ok(component.includes(`>${name}<`) || component.includes(`'${name}'`), `a button named "${name}"`);
  }
  assert.match(component, /data-testid="upload-signed-8879"/);
});

test('the controls apply before filing and on the re-file path, not after', () => {
  for (const s of ['intake_started', 'in_preparation', 'ready_to_file', 'rejected']) assert.equal(controlsApply(s), true, s);
  for (const s of ['filed', 'completed', 'withdrawn', 'on_hold']) assert.equal(controlsApply(s), false, s);
});

test('each control carries one plain sentence, and the 8879 modal is told before the tap', () => {
  assert.match(component, /Locks the estimate so preparation can start; the client's range no longer moves\./);
  assert.match(component, /Records the fee the client will be invoiced; outside the quoted range it needs a reason\./);
  assert.match(component, /Moves the return to the next stage; filed issues the final-fee invoice through the same door every invoice uses\./);
  assert.match(component, /This scan is what authorizes the return; the date and the PTIN holder are recorded from it\./);
  assert.match(component, /No signed authorization on file/);
  // The PTIN holder defaults to the assigned preparer; the labels the harness reads are exact.
  assert.match(component, /te\.preparer_ptin_holder_id \?\? detail\.assigned_preparer\?\.id/);
  assert.match(component, /\n\s*Signed on\n/);
  assert.match(component, /\n\s*PTIN holder\n/);
});

test('dollars typed by a person become cents; the range check reads both ends', () => {
  assert.equal(dollarsToCents('700'), 70000);
  assert.equal(dollarsToCents('$1,234.50'), 123450);
  assert.equal(dollarsToCents(' 0.10 '), 10);
  assert.equal(dollarsToCents('seven hundred'), null);
  assert.equal(dollarsToCents('1.234'), null);
  const range = { min_cents: 60000, max_cents: 80000, price_book_version: 1 };
  assert.equal(outsideRange(70000, range), false);
  assert.equal(outsideRange(60000, range), false);
  assert.equal(outsideRange(59999, range), true);
  assert.equal(outsideRange(80001, range), true);
  assert.equal(outsideRange(1, null), false, 'no range, nothing to be outside of');
});
