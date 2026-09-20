/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2) — the Ops half.
 *
 * Plus the 2026-09-19 EVENING rulings: the scope-creep category select that appears in the Set final
 * fee modal above a locked estimate and is never preselected (ruling 1), and the jurisdiction list
 * the Mark filed modal declares (ruling 2).
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
import {
  aboveLockedEstimate, addState, canManageReturns, controlsApply, dollarsToCents, jurisdictionsSentence,
  normaliseJurisdictions, outsideRange, removeState, stageActionLabel, startingJurisdictions,
  SCOPE_CREEP_CATEGORIES, SCOPE_CREEP_LABEL,
} from '../lib/return-controls.ts';

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

// ── 2026-09-19 evening, ruling 1: the category, in the same modal, never defaulted ──

test('above a locked estimate is a narrower thing than outside the quoted range', () => {
  const locked = { estimated_fee_max_cents: 80000 };
  assert.equal(aboveLockedEstimate(80001, locked), true);
  assert.equal(aboveLockedEstimate(80000, locked), false, 'at the top is not above it');
  assert.equal(aboveLockedEstimate(10, locked), false, 'below the range is outside it, but not above a lock');
  assert.equal(aboveLockedEstimate(999999, { estimated_fee_max_cents: null }), false, 'no lock, no category question');
});

test('the category select carries the enum, in words, with an empty first option and nothing preselected', () => {
  assert.deepEqual([...SCOPE_CREEP_CATEGORIES], [
    'additional_states', 'additional_sch_c', 'additional_sch_e', 'foreign',
    'late_docs', 'prior_year_cleanup', 'irs_notice', 'other',
  ]);
  for (const c of SCOPE_CREEP_CATEGORIES) assert.ok(SCOPE_CREEP_LABEL[c]?.length, `${c} has words`);
  assert.match(SCOPE_CREEP_LABEL.other, /reason/, "'other' says where the detail goes");
  // In the component: the select lives in the final-fee modal, opens empty, and its draft starts ''.
  assert.match(component, /data-testid="scope-creep-category"/);
  assert.match(component, /\n\s*Scope-creep category\n/, 'labelled so a harness can find it, and not matching /Reason/');
  assert.match(component, /const overLock = cents !== null && aboveLockedEstimate\(cents, te\);/);
  assert.match(component, /category: ''/, 'the draft starts with no category');
  assert.match(component, /<option value="">Choose\u2026<\/option>\n\s*\{SCOPE_CREEP_CATEGORIES\.map/, 'an empty first option, never a preselected one');
  assert.doesNotMatch(component, /scopeCreepReason: 'other'/, "nothing in Ops files an overrun under 'other' on the person's behalf");
  assert.match(component, /\.\.\.\(draft\.category \? \{ scopeCreepReason: draft\.category \} : \{\}\)/, 'only what was chosen is sent');
});

// ── 2026-09-19 evening, ruling 2: the jurisdictions are declared on the return ──

test('the jurisdiction list starts from what the return declares, else what the address suggests', () => {
  assert.deepEqual(startingJurisdictions({ declared_jurisdictions: ['federal', 'IL'], default_jurisdictions: ['federal'] }), ['federal', 'IL']);
  assert.deepEqual(startingJurisdictions({ declared_jurisdictions: [], default_jurisdictions: ['federal', 'IL'] }), ['federal', 'IL']);
  assert.deepEqual(startingJurisdictions({ declared_jurisdictions: [], default_jurisdictions: ['federal'] }), ['federal'], 'a no-income-tax state suggests federal alone');
  assert.deepEqual(startingJurisdictions({}), ['federal'], 'federal is never absent');
  assert.deepEqual(normaliseJurisdictions(['WI', 'federal', 'il']), ['federal', 'IL', 'WI'], 'federal first, then the states in order, upper-cased');
});

test('a state is added by its two-letter code, refused otherwise, and federal never leaves', () => {
  assert.deepEqual(addState(['federal'], 'il'), { list: ['federal', 'IL'], error: '' });
  assert.deepEqual(addState(['federal'], ' wi '), { list: ['federal', 'WI'], error: '' });
  assert.deepEqual(addState(['federal', 'IL'], 'IL').error, 'IL is already on the list.');
  assert.match(addState(['federal'], 'Illinois').error, /two-letter code/);
  assert.match(addState(['federal'], '').error, /two-letter code/);
  assert.deepEqual(addState(['federal'], 'Illinois').list, ['federal'], 'a refused code changes nothing');
  assert.deepEqual(removeState(['federal', 'IL', 'WI'], 'il'), ['federal', 'WI']);
  assert.deepEqual(removeState(['federal', 'IL'], 'federal'), ['federal', 'IL'], 'federal is not removable');
  assert.match(jurisdictionsSentence(['federal']), /^Federal only/);
  assert.match(jurisdictionsSentence(['federal', 'IL', 'WI']), /Federal and IL, WI/);
});

test('the Mark filed modal keeps the PTIN holder and adds the jurisdiction list; the transition sends it', () => {
  // The harness taps these by name: they stay exactly as they are (apps/e2e ops-scorp-dry-run).
  assert.match(component, /\n\s*PTIN holder \(the paid preparer of record\)\n/);
  assert.match(component, /label: 'Mark filed', tone: 'primary'/);
  // And the new control, with its own labels and test id.
  assert.match(component, /data-testid="filed-jurisdictions"/);
  assert.match(component, /<legend className="small">Jurisdictions filed<\/legend>/);
  assert.match(component, /\n\s*Add a state \(two-letter code\)\n/);
  assert.ok(component.includes('>Add state<'), 'a button named "Add state"');
  assert.ok(component.includes('Remove {j}'), 'each state can be taken off');
  assert.match(component, /jurisdictions: startingJurisdictions\(detail\)/, 'the modal starts from the return');
  assert.match(component, /jurisdictions: normaliseJurisdictions\(draft\.jurisdictions\)/, 'and the filing sends the list');
  assert.match(component, /The return completes when every jurisdiction declared here has accepted; federal is always one of them\./);
});
