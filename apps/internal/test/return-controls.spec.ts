/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2) — the Ops half.
 *
 * Plus the 2026-09-19 EVENING rulings: the scope-creep category select that appears in the Set final
 * fee modal above a locked estimate and is never preselected (ruling 1), and the jurisdiction list
 * the Mark filed modal declares (ruling 2).
 *
 * And ruling 15 (2026-09-20): how each jurisdiction was filed, and what a paper one reads as — never
 * "Accepted", because no acknowledgment is coming for it.
 *
 * And the 2026-09-20 rulings' pure parts: who prepares the return and what the Assign preparer
 * select opens on (ruling 11), which form an extension goes in on and how the row's badge reads
 * (ruling 12), and the paper engagement-letter door's own labels — which must not collide with the
 * 8879 door's "Signed on", because the browser walk taps that one by name (ruling 10).
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
  aboveLockedEstimate, addState, canManageReturns, controlsApply, defaultExtensionForm, defaultPreparerId,
  dollarsToCents, extensionBadgeText, filingMethodsFor, jurisdictionLabel, jurisdictionStatusText,
  jurisdictionsSentence, mailingControlsApply, mailingsNeeded, normaliseJurisdictions, outsideRange,
  preparerLine, removeState, stageActionLabel, startingFilingMethods, startingJurisdictions,
  EXTENSION_FORMS, EXTENSION_FORM_LABEL, FILING_METHODS, FILING_METHOD_LABEL,
  MAILING_METHODS, MAILING_METHOD_LABEL, SCOPE_CREEP_CATEGORIES, SCOPE_CREEP_LABEL,
  type JurisdictionView,
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
  assert.match(component, /const starting = startingJurisdictions\(detail\);/, 'the modal starts from the return');
  assert.match(component, /jurisdictions: starting,/, 'and the draft carries that list');
  assert.match(component, /const jurisdictions = normaliseJurisdictions\(draft\.jurisdictions\);/, 'and the filing sends the list');
  assert.match(component, /The return completes when every jurisdiction declared here has accepted; federal is always one of them\./);
});

// ── 2026-09-20, rulings 10–12: the preparer, the extension, and the letter on paper ──

test('the row says who prepares the return, and says so plainly when nobody does', () => {
  assert.equal(preparerLine({ name: 'Synthetic Preparer' }), 'Preparer: Synthetic Preparer');
  assert.equal(preparerLine(null), 'No preparer');
  assert.equal(preparerLine(undefined), 'No preparer');
  assert.equal(preparerLine({ name: '' }), 'No preparer', 'a nameless row is not a preparer');
  // And the row renders it beside the control, as a warning badge when it is nobody.
  assert.match(component, /data-testid="assign-preparer"/);
  assert.ok(component.includes('>Assign preparer<'), 'a button named "Assign preparer"');
  assert.match(component, /preparerLine\(detail\.assigned_preparer\)/);
  assert.match(component, /detail\.assigned_preparer \? 'muted small' : 'badge warn'/, 'no preparer reads as a warning');
});

test('the Assign preparer select opens on whoever the return should already have, and never on a guess', () => {
  assert.equal(defaultPreparerId({ assigned_preparer: { id: 'a' }, sole_tax_preparer_id: 'b' }), 'a', 'whoever is assigned wins');
  assert.equal(defaultPreparerId({ assigned_preparer: null, sole_tax_preparer_id: 'b' }), 'b', 'the firm\'s only preparer');
  assert.equal(defaultPreparerId({ assigned_preparer: null, sole_tax_preparer_id: null }), '', 'two preparers, no guess');
  assert.equal(defaultPreparerId({}), '');
  // The modal offers the same staff list the PTIN holder select reads, and opens on "Choose…".
  assert.match(component, /title: 'Assign preparer'/);
  assert.match(component, /\n\s*Preparer\n/, 'labelled, and not matching the 8879 door\'s "PTIN holder"');
  assert.match(component, /options=\{detail\.staff_options\}/);
  assert.match(component, /body: <PreparerField draft=\{draft\} options=\{detail\.staff_options\} assigned=\{detail\.assigned_preparer\} \/>/);
  assert.match(component, /\/preparer`, \{ method: 'POST', body: \{ staffId: draft\.staffId \} \}/, 'the route the row posts to');
});

test('the extension form follows the return type: 4868 for an individual return, 7004 for an entity', () => {
  assert.equal(defaultExtensionForm('1040'), '4868');
  assert.equal(defaultExtensionForm('1040_expat'), '4868');
  assert.equal(defaultExtensionForm('1120S'), '7004', 'the case a row prints it in does not change the form');
  assert.equal(defaultExtensionForm('1065'), '7004');
  assert.equal(defaultExtensionForm('990'), '7004');
  assert.equal(defaultExtensionForm(null), '7004', 'an unknown return type never crashes the card');
  assert.deepEqual([...EXTENSION_FORMS], ['4868', '7004'], 'two real forms, and no third');
  for (const f of EXTENSION_FORMS) assert.match(EXTENSION_FORM_LABEL[f], new RegExp(f), `${f} is named in its label`);
});

test('the extension badge says which form went in and the deadline it bought, and never invents either', () => {
  assert.equal(extensionBadgeText('7004', 'Sep 15, 2026'), 'Extended · Form 7004 · deadline Sep 15, 2026');
  assert.equal(extensionBadgeText('4868', ''), 'Extended · Form 4868', 'no deadline on file, none printed');
  assert.equal(extensionBadgeText(null, 'Sep 15, 2026'), 'Extended · form not recorded · deadline Sep 15, 2026');
  // The badge takes an already-formatted day: this file grows no date formatter of its own.
  assert.match(component, /data-testid="record-extension"/);
  assert.ok(component.includes('>Record extension<'), 'a button named "Record extension"');
  assert.match(component, /extensionBadgeText\(te\.extension_form, te\.extended_deadline \? formatDate\(te\.extended_deadline\) : ''\)/);
  assert.match(component, /\n\s*Date filed\n/, 'the day it was filed');
  assert.match(component, /data-testid="extension-form"/);
  assert.match(component, /\/extension\/filed`, \{/, 'the existing route, extended');
  assert.doesNotMatch(component, /extendedDeadline:/, 'no deadline is ever typed or posted from the card');
});

test('the paper engagement-letter door is in the 8879 shape, with its own labels and test id', () => {
  assert.match(component, /data-testid="upload-engagement-letter"/);
  assert.ok(component.includes('>Upload the signed engagement letter<') || component.includes("'Upload the signed engagement letter'"),
    'a button named "Upload the signed engagement letter"');
  assert.match(component, /\n\s*Signed engagement letter \(scan\)\n/);
  // NOT "Signed on": that label belongs to the 8879 door and the browser walk taps it by name.
  assert.match(component, /\n\s*Date signed\n/);
  assert.equal((component.match(/\n\s*Signed on\n/g) ?? []).length, 1, 'exactly one control is labelled "Signed on"');
  assert.match(component, /fd\.append\('category', 'signed_authorizations'\)/);
  assert.match(component, /fd\.append\('engagementLetterSignedOn', signedOn\)/, 'its own field, so the route knows which paper arrived');
  // The refusal renders beside the date, and the control leaves once the letter is on the return.
  assert.match(component, /te\.engagement_letter_signed_at \? null : \(/);
  assert.match(component, /This scan is the signed engagement letter; the return is stamped with the date the client signed it\./);
});

test('each new control carries one plain sentence, and the labels the walk taps are untouched', () => {
  assert.match(component, /Names who prepares this return; preparation cannot start until somebody is on it\./);
  assert.match(component, /Records an extension that already went in; the extended deadline is derived from the return type, never typed\./);
  // The 2026-09-19 labels the harness reads stay exactly as they were.
  for (const name of ['Lock estimate', 'Set final fee', 'Upload the signed 8879', 'Add state']) {
    assert.ok(component.includes(`>${name}<`) || component.includes(`'${name}'`), `"${name}" is still here`);
  }
  assert.equal(stageActionLabel('in_preparation'), 'Start preparation', 'the walk taps this stage by name');
  assert.match(component, /data-testid="upload-signed-8879"/);
  assert.match(component, /label: 'Mark filed', tone: 'primary'/);
});

// ── 2026-09-20, ruling 15: paper filing, per jurisdiction ──────────────────────────────────────
//
// The row must never say "Accepted" for a paper filing: nobody accepted anything and no
// acknowledgment is coming. What satisfies a paper jurisdiction is the recorded MAILING, and the
// lane each one opens on is derived by the API (filingLane) and read from the detail — this file
// does not re-derive the year rule, the same way it grows no date formatter.

test('a paper jurisdiction reads "Mailed", an e-file one reads "Accepted", and neither ever borrows the other\'s word', () => {
  const paper: JurisdictionView = {
    jurisdiction: 'IL', filingMethod: 'paper', acceptedOn: null, mailedOn: '2026-09-18',
    mailingMethod: 'certified', trackingNumber: '9407', receiptDocumentId: null,
  };
  const efile: JurisdictionView = {
    jurisdiction: 'federal', filingMethod: 'efile', acceptedOn: '2026-09-19', mailedOn: null,
    mailingMethod: null, trackingNumber: null, receiptDocumentId: null,
  };
  assert.equal(jurisdictionStatusText(paper, 'Sep 18, 2026'), 'Mailed Sep 18, 2026');
  assert.equal(jurisdictionStatusText(efile, 'Sep 19, 2026'), 'Accepted Sep 19, 2026');
  assert.equal(jurisdictionStatusText({ ...paper, mailedOn: null, mailingMethod: null }, ''), 'Paper — no mailing recorded');
  assert.equal(jurisdictionStatusText({ ...efile, acceptedOn: null }, ''), 'Awaiting acceptance');
  // The one thing that must never happen: "Accepted" on a paper row, even with a date on it.
  assert.doesNotMatch(jurisdictionStatusText({ ...paper, acceptedOn: '2026-09-19' }, 'Sep 18, 2026'), /Accepted/);
  assert.equal(jurisdictionLabel('federal'), 'Federal');
  assert.equal(jurisdictionLabel('il'), 'IL');
});

test('the Record mailing control belongs to the declared paper jurisdictions with no mailing, after filing', () => {
  const rows: JurisdictionView[] = [
    { jurisdiction: 'federal', filingMethod: 'efile', acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
    { jurisdiction: 'IL', filingMethod: 'paper', acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
    { jurisdiction: 'WI', filingMethod: 'paper', acceptedOn: null, mailedOn: '2026-09-18', mailingMethod: 'first_class', trackingNumber: null, receiptDocumentId: null },
  ];
  assert.deepEqual(mailingsNeeded(rows).map((r) => r.jurisdiction), ['IL'], 'not the e-file one, not the one already mailed');
  assert.deepEqual(mailingsNeeded(null), [], 'a return that has declared nothing needs nothing');
  // A jurisdiction is declared AT filing, so the control starts where the others stop.
  for (const s of ['filed', 'rejected']) assert.equal(mailingControlsApply(s), true, s);
  for (const s of ['ready_to_file', 'in_preparation', 'completed', 'withdrawn']) assert.equal(mailingControlsApply(s), false, s);
  assert.equal(controlsApply('filed'), false, 'and the pre-filing controls still stop at filing');
});

test('each jurisdiction\'s method opens on what the return already says, else the lane the year implies', () => {
  const detail = {
    jurisdictions: [
      { jurisdiction: 'IL', filingMethod: 'paper' as const, acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
    ],
    default_filing_method: 'efile' as const,
  };
  assert.deepEqual(startingFilingMethods(detail, ['federal', 'IL']), { federal: 'efile', IL: 'paper' },
    'what the row says wins; the year fills the rest');
  assert.deepEqual(startingFilingMethods({ default_filing_method: 'paper' }, ['federal', 'IL']), { federal: 'paper', IL: 'paper' },
    'an old year opens on paper everywhere — it has no other lane');
  assert.deepEqual(startingFilingMethods({}, ['federal']), { federal: 'efile' }, 'never undefined, never a crash');
  // The map follows the list: a state removed takes its method with it, a state added takes the lane.
  assert.deepEqual(filingMethodsFor(['federal'], { federal: 'paper', IL: 'paper' }, 'efile'), { federal: 'paper' });
  assert.deepEqual(filingMethodsFor(['federal', 'WI'], { federal: 'efile' }, 'paper'), { federal: 'efile', WI: 'paper' });
  assert.deepEqual([...FILING_METHODS], ['efile', 'paper'], 'two lanes, and no third');
  for (const m of FILING_METHODS) assert.ok(FILING_METHOD_LABEL[m].length, `${m} has words`);
  assert.deepEqual([...MAILING_METHODS], ['certified', 'first_class', 'hand_delivered', 'mailed_by_client']);
  assert.match(MAILING_METHOD_LABEL.certified, /track/i, 'the tracked one says so, because it is the one that gets chased');
});

test('the Mark filed modal carries a filing method beside every jurisdiction, and the filing sends them', () => {
  assert.match(component, /data-testid=\{`filing-method-\$\{j\}`\}/, 'one select per jurisdiction row');
  assert.match(component, /aria-label=\{`Filing method — \$\{j === FEDERAL \? 'Federal' : j\}`\}/, 'named, so a harness can find each one');
  assert.match(component, /methods: startingFilingMethods\(detail, starting\)/, 'opening on the return, else the year');
  assert.match(component, /filingMethods: filingMethodsFor\(jurisdictions, draft\.methods, detail\.default_filing_method\)/, 'and the filing sends them');
  // The labels the 2026-09-19 walk taps are untouched by this.
  assert.match(component, /label: 'Mark filed', tone: 'primary'/);
  assert.match(component, /\n\s*PTIN holder \(the paid preparer of record\)\n/);
  assert.match(component, /data-testid="filed-jurisdictions"/);
});

test('the Record mailing modal: the day, the method, optional tracking, optional receipt — and the route refuses the rest', () => {
  assert.match(component, /data-testid=\{`record-mailing-\$\{j\.jurisdiction\}`\}/);
  assert.ok(component.includes('Record mailing — {jurisdictionLabel(j.jurisdiction)}'), 'a button naming which jurisdiction');
  assert.match(component, /label: 'Record mailing', tone: 'primary'/);
  assert.match(component, /\n\s*Mailed on\n/);
  assert.match(component, /data-testid="mailing-method"/);
  assert.match(component, /\n\s*Method\n/);
  assert.match(component, /\n\s*Tracking number\n/);
  assert.match(component, /\n\s*Mailing receipt \(scan\)\n/);
  // The receipt goes through /documents under its own category, then the mailing carries its id.
  assert.match(component, /fd\.append\('category', 'mailing_receipts'\)/);
  assert.match(component, /\/jurisdictions\/\$\{jurisdiction\}\/mailing`, \{/, 'the route the modal posts to');
  assert.match(component, /A paper jurisdiction has no acknowledgment to wait for: the recorded mailing is what completes it\./);
  // The status line uses the pure helper and the app's date formatter — never a raw date.
  assert.match(component, /jurisdictionStatusText\(j, j\.filingMethod === 'paper' \? \(j\.mailedOn \? formatDate\(j\.mailedOn\) : ''\)/);
  // Two windows, one gate: the pre-filing controls are hidden after filing, the mailing control is not.
  assert.match(component, /const preFiled = controlsApply\(stage\);/);
  assert.match(component, /const applies = preFiled \|\| mailingControlsApply\(stage\);/);
  assert.match(component, /if \(!canManage \|\| !applies\) return null;/, 'nothing, not disabled buttons');
});
