/*
 * THE RETURNS CARD AS A STEPPER (Brian, 2026-09-26, R50) — the pure parts, proven.
 *
 * The sixteen steps in the order ruled; a done step carries its day and its person; the current step
 * is the first one not done and is the only one with a control; a later step says what unlocks it;
 * steps after the current one that are already done stay done. The R53 step sits between delivered
 * and 8879 on file and is satisfied by the signed scan when nothing was recorded. The four fixes:
 * the amount is labelled, the "extended" badge leaves at filing, the paper sentence needs a paper
 * jurisdiction, and the jurisdiction line reads as the record did.
 *
 * The wiring — the client page rendering the stepper when GET /auth/me says the switch is on and the
 * row otherwise, the stepper reusing the row's actions rather than its own modals — is checked in
 * the source, because the front-end has no render harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STEP_KEYS, STEP_LABEL, STEP_UNLOCKS, amountLabel, buildSteps, currentStep, effectiveStage, feeDetail, hasPaperJurisdiction,
  showExtendedBadge, type StepperInput,
} from '../lib/return-stepper.ts';
import { stageActionLabel } from '../lib/return-controls.ts';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

function input(over: Partial<StepperInput> & { te?: Partial<StepperInput['te']> } = {}): StepperInput {
  const base: StepperInput = {
    te: {
      stage: 'intake_started', engagement_letter_signed_at: null, estimate_locked_at: null,
      estimated_fee_min_cents: null, estimated_fee_max_cents: null, final_fee_cents: null,
      filed_date: null, f8879_signed_on: null, payment_status: 'unbilled',
    },
    stageHistory: [], activity: [], f8879_sent: null, signed_authorization_on_file: false,
    assigned_preparer: null, preparer_of_record: null, jurisdictions: [], final_fee_invoice: null, legal_next_stages: ['scheduled'],
  };
  return { ...base, ...over, te: { ...base.te, ...(over.te ?? {}) } };
}
const states = (i: StepperInput) => Object.fromEntries(buildSteps(i).map((s) => [s.key, s.state]));

test('sixteen steps, in the order Brian ruled, each with a label and an unlock sentence', () => {
  assert.deepEqual([...STEP_KEYS], [
    'letter', 'preparer', 'estimate', 'scheduled', 'documents_requested', 'in_preparation', 'internal_review',
    'delivered', 'f8879_sent', 'f8879_on_file', 'final_fee', 'ready_to_file', 'filed', 'jurisdictions', 'paid', 'completed',
  ]);
  for (const k of STEP_KEYS) {
    assert.ok(STEP_LABEL[k].length > 0, `${k} has a label`);
    assert.ok(STEP_UNLOCKS[k].length > 0, `${k} says what unlocks it`);
  }
  assert.equal(STEP_KEYS.indexOf('f8879_sent'), STEP_KEYS.indexOf('delivered') + 1, 'R53 sits right after delivered');
  assert.equal(STEP_KEYS.indexOf('f8879_on_file'), STEP_KEYS.indexOf('f8879_sent') + 1, 'and right before 8879 on file');
});

test('a fresh return: the letter is current, everything else later with its unlock sentence', () => {
  const steps = buildSteps(input());
  assert.equal(steps[0]!.state, 'current');
  assert.equal(currentStep(steps)!.key, 'letter');
  for (const s of steps.slice(1)) {
    assert.equal(s.state, 'later', `${s.key} is later`);
    assert.equal(s.unlocks, STEP_UNLOCKS[s.key]);
  }
  assert.equal(steps.filter((s) => s.state === 'current').length, 1, 'exactly one current step');
});

test('mid-preparation: the done steps carry the day and the person; the stage step is current with its transition', () => {
  const i = input({
    te: { stage: 'in_preparation', engagement_letter_signed_at: '2026-09-20T15:00:00.000Z', estimate_locked_at: '2026-09-21T15:00:00.000Z', estimated_fee_min_cents: 60000, estimated_fee_max_cents: 80000 },
    assigned_preparer: { id: 'p1', name: 'Synthetic Ana' },
    stageHistory: [
      { stage: 'scheduled', entered_at: '2026-09-22T15:00:00.000Z', changed_by_name: 'Synthetic CEO', note: null },
      { stage: 'documents_requested', entered_at: '2026-09-23T15:00:00.000Z', changed_by_name: 'Synthetic CEO', note: null },
      { stage: 'in_preparation', entered_at: '2026-09-24T15:00:00.000Z', changed_by_name: 'Synthetic Ana', note: null },
    ],
    activity: [
      { action: 'tax_engagement.preparer_assigned', actor_label: 'Synthetic CEO', at: '2026-09-20T16:00:00.000Z', details: {} },
      { action: 'tax_engagement.estimate_locked', actor_label: 'Synthetic CEO', at: '2026-09-21T15:00:00.000Z', details: {} },
    ],
    legal_next_stages: ['internal_review'],
  });
  const steps = buildSteps(i);
  const by = Object.fromEntries(steps.map((s) => [s.key, s.done?.by ?? null]));
  assert.deepEqual(states(i), {
    letter: 'done', preparer: 'done', estimate: 'done', scheduled: 'done', documents_requested: 'done', in_preparation: 'done',
    internal_review: 'current', delivered: 'later', f8879_sent: 'later', f8879_on_file: 'later', final_fee: 'later',
    ready_to_file: 'later', filed: 'later', jurisdictions: 'later', paid: 'later', completed: 'later',
  });
  assert.equal(by.letter, 'the client (portal signature)', 'no upload row: the portal signature stamped it');
  assert.equal(by.preparer, 'Synthetic CEO');
  assert.equal(by.estimate, 'Synthetic CEO');
  assert.equal(by.in_preparation, 'Synthetic Ana');
  assert.equal(steps.find((s) => s.key === 'preparer')!.done!.detail, 'Preparer: Synthetic Ana', 'the row still reads "Preparer: <name>"');
  assert.equal(steps.find((s) => s.key === 'letter')!.done!.at, '2026-09-20T15:00:00.000Z', 'an instant leaves raw for dayOf');
  const current = currentStep(steps)!;
  assert.equal(current.key, 'internal_review');
  assert.equal(current.transitionTo, 'internal_review', 'the one control is the legal move into the step');
  assert.equal(stageActionLabel(current.transitionTo!), 'Internal review', 'the button word comes from the shared map');
});

test('delivered: the R53 step is current; a signed 8879 with nothing recorded satisfies it on the way past', () => {
  const delivered = input({
    te: { stage: 'client_review', engagement_letter_signed_at: '2026-09-20T15:00:00.000Z', estimate_locked_at: '2026-09-21T15:00:00.000Z' },
    assigned_preparer: { id: 'p1', name: 'Synthetic Ana' },
    stageHistory: [{ stage: 'client_review', entered_at: '2026-09-25T15:00:00.000Z', changed_by_name: null, note: 'auto: return delivered to portal' }],
    legal_next_stages: ['ready_to_file'],
  });
  assert.equal(currentStep(buildSteps(delivered))!.key, 'f8879_sent');
  assert.equal(buildSteps(delivered).find((s) => s.key === 'delivered')!.done!.by, 'automation', 'the delivery moved the stage with no staff id');

  const sent = input({ ...delivered, f8879_sent: { method: 'adobe_sign', sent_on: '2026-09-25', recorded_by_name: 'Synthetic Ana', declared_by_import: false } });
  const sentSteps = buildSteps(sent);
  assert.equal(sentSteps.find((s) => s.key === 'f8879_sent')!.state, 'done');
  assert.deepEqual(sentSteps.find((s) => s.key === 'f8879_sent')!.done, { day: '2026-09-25', by: 'Synthetic Ana', detail: 'Adobe Sign' });
  assert.equal(currentStep(sentSteps)!.key, 'f8879_on_file', 'the upload form is next');

  const imported = input({ ...delivered, f8879_sent: { method: null, sent_on: '2026-09-19', recorded_by_name: null, declared_by_import: true } });
  assert.deepEqual(buildSteps(imported).find((s) => s.key === 'f8879_sent')!.done, { day: '2026-09-19', by: 'the Trello import (declared from the card)', detail: 'method not recorded' });

  const onFile = input({ ...delivered, te: { ...delivered.te, f8879_signed_on: '2026-09-25' }, signed_authorization_on_file: true, preparer_of_record: 'Synthetic Ana',
    activity: [{ action: 'signature.recorded_wet', actor_label: 'Synthetic CEO', at: '2026-09-25T20:00:00.000Z', details: { type: 'f8879' } }] });
  const onFileSteps = buildSteps(onFile);
  assert.equal(onFileSteps.find((s) => s.key === 'f8879_sent')!.state, 'done', 'signed across the desk with nothing recorded: not a block');
  assert.equal(onFileSteps.find((s) => s.key === 'f8879_sent')!.done!.detail, 'not recorded separately; the signed 8879 is on file');
  assert.deepEqual(onFileSteps.find((s) => s.key === 'f8879_on_file')!.done, { day: '2026-09-25', by: 'Synthetic CEO', detail: 'PTIN holder Synthetic Ana' });
  assert.equal(currentStep(onFileSteps)!.key, 'final_fee', 'the fee comes before ready to file, as ruled');
});

test('filed awaiting acks: filed is done with its day and the preparer of record; the jurisdiction step is current and says what it waits on', () => {
  const i = input({
    te: { stage: 'filed', engagement_letter_signed_at: 'x', estimate_locked_at: 'x', final_fee_cents: 70000, filed_date: '2026-09-26', f8879_signed_on: '2026-09-24' },
    assigned_preparer: { id: 'p1', name: 'Synthetic Ana' }, preparer_of_record: 'Synthetic Ana', signed_authorization_on_file: true,
    stageHistory: [{ stage: 'filed', entered_at: '2026-09-26T15:00:00.000Z', changed_by_name: 'Synthetic Ana', note: null }],
    activity: [{ action: 'tax_engagement.final_fee_set', actor_label: 'Synthetic Ana', at: '2026-09-26T14:00:00.000Z', details: {} }],
    jurisdictions: [
      { jurisdiction: 'federal', filingMethod: 'efile', acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
      { jurisdiction: 'IL', filingMethod: 'paper', acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
    ],
    final_fee_invoice: { status: 'sent', paid_at: null, total_cents: 70000 },
    legal_next_stages: ['completed', 'rejected'],
  });
  const steps = buildSteps(i);
  const filed = steps.find((s) => s.key === 'filed')!;
  assert.equal(filed.state, 'done');
  assert.deepEqual(filed.done, { day: '2026-09-26', by: 'Synthetic Ana', detail: 'preparer of record: Synthetic Ana' });
  assert.equal(steps.find((s) => s.key === 'final_fee')!.done!.by, 'Synthetic Ana');
  assert.equal(feeDetail(money(70000)), 'current $700.00', 'the fee line keeps the words the walk reads');
  const cur = currentStep(steps)!;
  assert.equal(cur.key, 'jurisdictions');
  assert.match(cur.waiting!, /paper jurisdiction completes when its mailing is recorded/);
  assert.equal(steps.find((s) => s.key === 'paid')!.state, 'later');
  assert.equal(steps.find((s) => s.key === 'completed')!.state, 'later');
});

test('a completed return still unpaid: paid is current, completed stays done — a step after the current one keeps its state', () => {
  const i = input({
    te: { stage: 'completed', engagement_letter_signed_at: 'x', estimate_locked_at: 'x', final_fee_cents: 70000, filed_date: '2026-09-26', f8879_signed_on: '2026-09-24' },
    assigned_preparer: { id: 'p1', name: 'Synthetic Ana' }, preparer_of_record: 'Synthetic Ana', signed_authorization_on_file: true,
    stageHistory: [
      { stage: 'filed', entered_at: '2026-09-26T15:00:00.000Z', changed_by_name: 'Synthetic Ana', note: null },
      { stage: 'completed', entered_at: '2026-09-27T15:00:00.000Z', changed_by_name: null, note: 'auto: every declared jurisdiction has accepted' },
    ],
    jurisdictions: [
      { jurisdiction: 'federal', filingMethod: 'efile', acceptedOn: '2026-09-27', mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null },
      { jurisdiction: 'IL', filingMethod: 'paper', acceptedOn: null, mailedOn: '2026-09-26', mailingMethod: 'certified', trackingNumber: '9400X', receiptDocumentId: null },
    ],
    final_fee_invoice: { status: 'sent', paid_at: null, total_cents: 70000 },
    legal_next_stages: [],
  });
  const steps = buildSteps(i);
  assert.equal(steps.find((s) => s.key === 'jurisdictions')!.state, 'done');
  assert.equal(steps.find((s) => s.key === 'jurisdictions')!.done!.day, '2026-09-27', 'the latest answer is the day');
  assert.equal(currentStep(steps)!.key, 'paid');
  assert.match(currentStep(steps)!.waiting!, /invoice is sent/);
  assert.equal(steps.find((s) => s.key === 'completed')!.state, 'done');
  assert.equal(steps.find((s) => s.key === 'completed')!.done!.by, 'automation');

  const paid = input({ ...i, final_fee_invoice: { status: 'paid', paid_at: '2026-09-28T15:00:00.000Z', total_cents: 70000 } });
  assert.equal(currentStep(buildSteps(paid)), null, 'every step done: nothing is current');
  assert.deepEqual(buildSteps(paid).find((s) => s.key === 'paid')!.done, { at: '2026-09-28T15:00:00.000Z', by: 'the client' });
});

test('rejected: filed is undone, ready to file is current with the re-file words; on hold reads the held stage', () => {
  const rejected = input({
    te: { stage: 'rejected', engagement_letter_signed_at: 'x', estimate_locked_at: 'x', final_fee_cents: 70000, filed_date: '2026-09-26', f8879_signed_on: '2026-09-24' },
    assigned_preparer: { id: 'p1', name: 'A' }, signed_authorization_on_file: true, legal_next_stages: ['ready_to_file'],
  });
  const steps = buildSteps(rejected);
  assert.equal(steps.find((s) => s.key === 'filed')!.state, 'later');
  const cur = currentStep(steps)!;
  assert.equal(cur.key, 'ready_to_file');
  assert.equal(cur.transitionTo, 'ready_to_file');
  assert.match(cur.waiting!, /E-file rejected/);

  const held = { stage: 'on_hold' };
  assert.equal(effectiveStage(held, [{ stage: 'in_preparation', entered_at: 'x', changed_by_name: null, note: null }, { stage: 'on_hold', entered_at: 'y', changed_by_name: null, note: null }]), 'in_preparation');
  assert.equal(effectiveStage(held, []), 'intake_started');
  assert.equal(effectiveStage({ stage: 'filed' }, []), 'filed');
});

test('a stage reached without its lock: the estimate is current and the stage steps already reached stay done', () => {
  const i = input({
    te: { stage: 'scheduled', engagement_letter_signed_at: 'x' },
    assigned_preparer: { id: 'p1', name: 'A' },
    stageHistory: [{ stage: 'scheduled', entered_at: '2026-09-22T15:00:00.000Z', changed_by_name: 'Synthetic CEO', note: null }],
    legal_next_stages: ['documents_requested'],
  });
  const s = states(i);
  assert.equal(s.estimate, 'current');
  assert.equal(s.scheduled, 'done');
  assert.equal(s.documents_requested, 'later');
});

test('an imported stage names the import and the attestation', () => {
  const i = input({
    te: { stage: 'client_review' },
    stageHistory: [{ stage: 'client_review', entered_at: '2026-09-20T15:00:00.000Z', changed_by_name: null, note: 'Steps before this stage were completed outside SAOS, per Trello card abc, as of 2026-09-19.' }],
    activity: [{ action: 'tax_engagement.imported_at_stage', actor_label: 'trello import (synthetic)', at: '2026-09-20T15:00:00.000Z', details: {} }],
  });
  const d = buildSteps(i).find((s) => s.key === 'delivered')!;
  assert.equal(d.state, 'done');
  assert.equal(d.done!.by, 'trello import (synthetic)');
  assert.equal(d.done!.detail, 'imported at this stage under the R16 attestation');
});

test('the four fixes: the labelled amount, the badge that leaves at filing, the paper sentence', () => {
  assert.equal(amountLabel({ final_fee_cents: 70000, estimated_fee_max_cents: 80000 }, money), 'Final fee $700.00');
  assert.equal(amountLabel({ final_fee_cents: null, estimated_fee_max_cents: 80000 }, money), 'Estimate up to $800.00');
  assert.equal(amountLabel({ final_fee_cents: null, estimated_fee_max_cents: null }, money), 'No fee yet');

  assert.equal(showExtendedBadge({ extension_filed: true, filed_date: null, stage: 'in_preparation' }), true);
  assert.equal(showExtendedBadge({ extension_filed: true, filed_date: '2026-09-26', stage: 'filed' }), false, 'filed: the badge leaves');
  assert.equal(showExtendedBadge({ extension_filed: true, filed_date: null, stage: 'completed' }), false);
  assert.equal(showExtendedBadge({ extension_filed: false, filed_date: null, stage: 'scheduled' }), false);

  const efile = { jurisdiction: 'federal', filingMethod: 'efile' as const, acceptedOn: null, mailedOn: null, mailingMethod: null, trackingNumber: null, receiptDocumentId: null };
  const paper = { ...efile, jurisdiction: 'IL', filingMethod: 'paper' as const, mailedOn: '2026-09-26', mailingMethod: 'certified' as const, trackingNumber: '9400X' };
  assert.equal(hasPaperJurisdiction([efile]), false, 'federal e-file alone: no paper sentence');
  assert.equal(hasPaperJurisdiction([efile, paper]), true);
});

test('the wiring: the page decides from the switch, the stepper reuses the row’s actions, no formatter grows in the lib', () => {
  const page = readFileSync(new URL('../app/clients/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /returnStepper === 'on' \?[\s\S]*<ReturnStepper/, 'the stepper renders when the session says on');
  assert.match(page, /returnStepper === 'off' \?[\s\S]*<ReturnControls/, 'the row renders when it says off');
  assert.match(page, /m\.switches\?\.returnStepper === 'on' \? 'on' : 'off'/, 'anything but on is off');
  assert.match(page, /showExtendedBadge\(t\)/, 'fix 4 on the row header');
  assert.match(page, /amountLabel\(t, formatMoney\)/, 'fix 3 on the row header');

  const stepper = readFileSync(new URL('../components/return-stepper.tsx', import.meta.url), 'utf8');
  assert.match(stepper, /useReturnActions\(\{ taxEngagementId, contactId, stage, detail, after \}\)/, 'one set of actions');
  assert.doesNotMatch(stepper, /await ask\(/, 'the stepper opens no modal of its own');
  assert.match(stepper, /data-testid="current-step-control"/, 'the current step carries the control');
  assert.match(stepper, /data-testid="return-details"/, 'the details area');
  assert.match(stepper, /hasPaperJurisdiction\(rows\) \? <p className="muted small">\{CONTROL_SENTENCES\.mailing\}/, 'fix 2');

  const lib = readFileSync(new URL('../lib/return-stepper.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(lib, /Intl\.DateTimeFormat|toLocale/, 'no date formatter in the lib');
  assert.doesNotMatch(lib, /^import \{/m, 'no runtime import in the lib (node --test loads it bare)');
  assert.match(stepper, /jurisdiction-line-\$\{j\.jurisdiction\}/, 'the record line keeps its test id');
  assert.match(stepper, /data-testid="jurisdiction-status"/, 'and the mailing block its own');

  const controls = readFileSync(new URL('../components/return-controls.tsx', import.meta.url), 'utf8');
  assert.match(controls, /export function useReturnActions/, 'the actions are the shared hook');
  assert.match(controls, /data-testid="record-8879-sent"/, 'R53 is on the row too');
  assert.match(controls, /\/tax-engagements\/\$\{taxEngagementId\}\/8879-sent/, 'through its own door');
  assert.match(controls, /data-testid="upload-8879-form"[\s\S]*data-testid="upload-signed-8879"/, 'the 8879 upload is one grouped form with its button beneath');
});
