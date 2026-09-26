/*
 * FILED ON, AND THE FILING CORRECTED (Brian, 2026-09-26) — the API half.
 *
 *  · Mark filed takes "Filed on": today in Chicago when unsaid, refused after today and refused
 *    before the day on the signed 8879, in words the modal renders beside the field; the day lands
 *    on the return as a calendar day (filed_date) and on the stage-change audit row;
 *  · a re-file after a rejection keeps its first day: the same day passes, a different one is
 *    refused by name rather than dropped;
 *  · a correction to the filed date, the PTIN holder or the declared jurisdictions of a return at
 *    filed is APPENDED (one row: fields, before, after, reason, actor) and reflected on the return;
 *    GET reads the history back; the audit row names the fields;
 *  · the 0089 guard still refuses a bare change to the PTIN holder — the correction is the one door;
 *  · correcting the PTIN holder can also move the assigned preparer, through the assign door;
 *  · removing a jurisdiction that has accepted, or been mailed, is refused by name; a state added
 *    takes the lane the year implies;
 *  · nothing changed is refused; a return not at filed is refused; a chat artifact is not a reason;
 *    a bookkeeper gets 403.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';
import { filingLane } from '../src/modules/tax/resolution.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const today = todayChicago();
/** The day on every signed 8879 in this file: ten days ago, after the 2025 year end and before today. */
const SIGNED_ON = addDays(today, -10);
const REASON = 'The filing was recorded from the wrong screen; this is what the transmission record shows.';

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('filing_corrections');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-corrections@example.test', 'tax_preparer', 'Synthetic Preparer');
  brian = await staffWithToken('brian-corrections@example.test', 'ceo', 'Synthetic CEO');
  marian = await staffWithToken('marian-corrections@example.test', 'bookkeeper', 'Synthetic Bookkeeper');
});
after(async () => { await app.close(); });

/** A 2025 1120S at ready_to_file with the letter, the estimate lock and Ana assigned, and the signed 8879 on file. */
async function readyReturn(last: string): Promise<{ id: string; contactId: string }> {
  const contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-corrections@example.test` })).id;
  const version = await currentPriceBookVersion(app.db);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key, price_book_version_id)
     VALUES ($1, 'tax', '2025 1120S', 'active', '2025', $2) RETURNING id`,
    [contactId, version.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1120s', 'business', 'ready_to_file', $2, now(), now()) RETURNING id`,
    [eng.rows[0]!.id, ana.id]
  );
  await signed8879OnFile(app, te.rows[0]!.id, ana.id, SIGNED_ON);
  return { id: te.rows[0]!.id, contactId };
}
const file = (id: string, payload: Record<string, unknown> = {}, who: { token: string } = ana) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/transition`, headers: auth(who), payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: ['federal', 'IL'], ...payload } });
const correct = (id: string, payload: Record<string, unknown>, who: { token: string } = ana) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/filing-corrections`, headers: auth(who), payload: { reason: REASON, ...payload } });
async function filedReturn(last: string): Promise<{ id: string; contactId: string }> {
  const te = await readyReturn(last);
  const filed = await file(te.id);
  assert.equal(filed.statusCode, 200, filed.body);
  return te;
}
async function state(id: string) {
  const { rows } = await app.db.query<{ stage: string; filed_date: string | null; preparer_ptin_holder_id: string | null; preparer_id: string | null }>(
    `SELECT stage::text AS stage, filed_date::text AS filed_date, preparer_ptin_holder_id, preparer_id FROM tax_engagements WHERE id = $1`, [id]);
  return rows[0]!;
}
async function declared(id: string): Promise<Array<{ jurisdiction: string; filing_method: string | null }>> {
  const { rows } = await app.db.query<{ jurisdiction: string; filing_method: string | null }>(
    `SELECT jurisdiction, filing_method FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1 ORDER BY (jurisdiction <> 'federal'), jurisdiction`, [id]);
  return rows;
}
async function corrections(id: string) {
  const { rows } = await app.db.query<{ fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; reason: string; actor_label: string }>(
    `SELECT fields, before, after, reason, actor_label FROM tax_engagement_filing_corrections WHERE tax_engagement_id = $1 ORDER BY created_at`, [id]);
  return rows;
}

test('Mark filed: Filed on defaults to today in Chicago; after today is refused; before the signed 8879 is refused; nothing lands on a refusal', async () => {
  const te = await readyReturn('Filedon');

  const future = await file(te.id, { filedOn: addDays(today, 1) });
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'filed_date_in_future');
  assert.match(future.json().message, /is after today/);

  const early = await file(te.id, { filedOn: addDays(SIGNED_ON, -1) });
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'filed_before_authorization');
  assert.match(early.json().message, new RegExp(`before the signed 8879 dated ${SIGNED_ON}`), 'names the day on the 8879');

  const still = await state(te.id);
  assert.equal(still.stage, 'ready_to_file', 'two refusals left the return unfiled');
  assert.equal(still.filed_date, null);

  const filed = await file(te.id);
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(filed.json().filedOn, today, 'unsaid, the day is today in Chicago');
  const now = await state(te.id);
  assert.equal(now.stage, 'filed');
  assert.equal(now.filed_date, today, 'stored as the calendar day, not the server clock');
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.stage_changed' AND object_id = $1 AND details->>'to' = 'filed'`, [te.id]);
  assert.equal(audit.rows[0]!.details['filed_on'], today, 'the stage-change row carries the day');
});

test('Mark filed with an explicit day between the signed 8879 and today lands as that day; the day on the 8879 itself is allowed', async () => {
  const te = await readyReturn('Explicit');
  const filed = await file(te.id, { filedOn: SIGNED_ON });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(filed.json().filedOn, SIGNED_ON);
  assert.equal((await state(te.id)).filed_date, SIGNED_ON);
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    taxEngagement: { filed_date: string; f8879_signed_on: string }; filing_corrections: unknown[];
  };
  assert.equal(detail.taxEngagement.filed_date, SIGNED_ON, 'GET reads the calendar day');
  assert.equal(detail.taxEngagement.f8879_signed_on, SIGNED_ON, 'and the floor the modal prints');
  assert.deepEqual(detail.filing_corrections, [], 'no correction yet');
});

test('a re-file after a rejection keeps its first day: the same day passes, a different day is refused by name', async () => {
  const te = await readyReturn('Refile');
  const first = addDays(today, -3);
  assert.equal((await file(te.id, { filedOn: first })).statusCode, 200);
  const rejected = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/efile-result`, headers: auth(ana), payload: { result: 'rejected', rejectCode: 'R0000-902-01', rejectReason: 'synthetic reject' } });
  assert.equal(rejected.statusCode, 200, rejected.body);
  const back = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'ready_to_file' } });
  assert.equal(back.statusCode, 200, back.body);

  const other = await file(te.id, { filedOn: today });
  assert.equal(other.statusCode, 409, other.body);
  assert.equal(other.json().error, 'filed_date_kept');
  assert.match(other.json().message, new RegExp(`first filed on ${first}`));

  const same = await file(te.id, { filedOn: first });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal((await state(te.id)).filed_date, first, 'the first day stands');
  const unsaid = await state(te.id);
  assert.equal(unsaid.stage, 'filed');
});

test('the filed date correction: appended, reflected, audited, read back by GET; refused after today, before the 8879, and when nothing changed', async () => {
  const te = await filedReturn('Datefix');
  assert.equal((await state(te.id)).filed_date, today);
  const earlier = addDays(today, -4);

  const future = await correct(te.id, { filedOn: addDays(today, 2) });
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'filed_date_in_future');
  const early = await correct(te.id, { filedOn: addDays(SIGNED_ON, -1) });
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'filed_before_authorization');
  const same = await correct(te.id, { filedOn: today });
  assert.equal(same.statusCode, 409, same.body);
  assert.equal(same.json().error, 'nothing_to_correct');
  assert.equal((await corrections(te.id)).length, 0, 'three refusals appended nothing');

  const ok = await correct(te.id, { filedOn: earlier });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().fields, ['filed_date']);
  assert.equal((await state(te.id)).filed_date, earlier, 'the return now reads the corrected day');

  const rows = await corrections(te.id);
  assert.equal(rows.length, 1, 'one correction appended');
  assert.deepEqual(rows[0]!.fields, ['filed_date']);
  assert.equal(rows[0]!.before['filed_date'], today);
  assert.equal(rows[0]!.after['filed_date'], earlier);
  assert.equal(rows[0]!.reason, REASON);
  assert.equal(rows[0]!.actor_label, ana.fullName, 'the actor is a name');

  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.filing_corrected' AND object_id = $1`, [te.id]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(audit.rows[0]!.details['fields'], ['filed_date'], 'the audit row names the field');

  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    taxEngagement: { filed_date: string }; filing_corrections: Array<{ fields: string[]; reason: string; actor_label: string; created_at: string }>;
  };
  assert.equal(detail.taxEngagement.filed_date, earlier);
  assert.equal(detail.filing_corrections.length, 1);
  assert.deepEqual(detail.filing_corrections[0]!.fields, ['filed_date']);
  assert.equal(detail.filing_corrections[0]!.actor_label, ana.fullName);
  assert.ok(detail.filing_corrections[0]!.created_at, 'when it was corrected');

  // Append-only: the row cannot be edited or removed.
  await assert.rejects(app.db.query(`UPDATE tax_engagement_filing_corrections SET reason = 'x' WHERE tax_engagement_id = $1`, [te.id]), /append-only/);
  await assert.rejects(app.db.query(`DELETE FROM tax_engagement_filing_corrections WHERE tax_engagement_id = $1`, [te.id]), /append-only/);
});

test('the PTIN holder correction is the one door through the preparer-of-record guard, and offers to move the assigned preparer through the assign door', async () => {
  const te = await filedReturn('Holder');
  const was = await state(te.id);
  assert.equal(was.preparer_ptin_holder_id, ana.id);
  assert.equal(was.preparer_id, ana.id);

  // A bare change is still refused by the database.
  await assert.rejects(
    app.db.query(`UPDATE tax_engagements SET preparer_ptin_holder_id = $2 WHERE id = $1`, [te.id, brian.id]),
    /preparer_of_record_immutable/
  );
  // The bookkeeper cannot hold a PTIN on a return.
  const wrongRole = await correct(te.id, { preparerPtinHolderId: marian.id });
  assert.equal(wrongRole.statusCode, 409, wrongRole.body);
  assert.equal(wrongRole.json().error, 'preparer_wrong_role');
  // The offer without a corrected holder is refused: it is an offer about the holder.
  const offerAlone = await correct(te.id, { alsoAssignPreparer: true });
  assert.equal(offerAlone.statusCode, 409, offerAlone.body);
  assert.equal(offerAlone.json().error, 'preparer_offer_without_holder');

  // The holder alone: the assignee stays.
  const holderOnly = await correct(te.id, { preparerPtinHolderId: brian.id });
  assert.equal(holderOnly.statusCode, 201, holderOnly.body);
  assert.deepEqual(holderOnly.json().fields, ['preparer_ptin_holder_id']);
  assert.equal(holderOnly.json().preparer, null, 'no offer taken, no preparer moved');
  let now = await state(te.id);
  assert.equal(now.preparer_ptin_holder_id, brian.id);
  assert.equal(now.preparer_id, ana.id, 'the assignee did not move');

  // Back to Ana, WITH the offer: the preparer moves through assignPreparer, which writes its own audit row.
  const assignedBefore = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'tax_engagement.preparer_assigned' AND object_id = $1`, [te.id]);
  await app.db.query(`UPDATE tax_engagements SET preparer_id = $2 WHERE id = $1`, [te.id, brian.id]);
  const withOffer = await correct(te.id, { preparerPtinHolderId: ana.id, alsoAssignPreparer: true });
  assert.equal(withOffer.statusCode, 201, withOffer.body);
  assert.deepEqual(withOffer.json().preparer, { id: ana.id, name: ana.fullName });
  now = await state(te.id);
  assert.equal(now.preparer_ptin_holder_id, ana.id);
  assert.equal(now.preparer_id, ana.id, 'the assignee moved with the holder');
  const assignedAfter = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'tax_engagement.preparer_assigned' AND object_id = $1`, [te.id]);
  assert.equal(assignedAfter.rows.length, assignedBefore.rows.length + 1, 'the assign door wrote its row');

  const rows = await corrections(te.id);
  assert.equal(rows.length, 2, 'two corrections appended');
  assert.equal(rows[0]!.before['preparer_ptin_holder_id'], ana.id);
  assert.equal(rows[0]!.after['preparer_ptin_holder_id'], brian.id);
  assert.equal(rows[1]!.before['preparer_ptin_holder_id'], brian.id);
  assert.equal(rows[1]!.after['preparer_ptin_holder_id'], ana.id);
  const marker = await app.db.query<{ v: string }>(`SELECT COALESCE(current_setting('saos.filing_correction', true), '') AS v`);
  assert.equal(marker.rows[0]!.v, '', 'the guard\'s door closed with the transaction');
});

test('the jurisdictions correction: a state removed leaves, a state added takes the lane the year implies; an accepted or mailed jurisdiction cannot be removed', async () => {
  const te = await readyReturn('Where');
  const filed = await file(te.id, { jurisdictions: ['federal', 'IL', 'WI'], filingMethods: { WI: 'paper' } });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.deepEqual((await declared(te.id)).map((r) => r.jurisdiction), ['federal', 'IL', 'WI']);

  // Federal never leaves; the list rule is the filing's rule, in the same words.
  const noFederal = await correct(te.id, { jurisdictions: ['IL'] });
  assert.equal(noFederal.statusCode, 400, noFederal.body);
  assert.equal(noFederal.json().error, 'federal_jurisdiction_required');
  // The same list is not a correction.
  const same = await correct(te.id, { jurisdictions: ['WI', 'federal', 'IL'] });
  assert.equal(same.statusCode, 409, same.body);
  assert.equal(same.json().error, 'nothing_to_correct');

  // IL leaves, MN arrives on the year's lane.
  const moved = await correct(te.id, { jurisdictions: ['federal', 'WI', 'MN'] });
  assert.equal(moved.statusCode, 201, moved.body);
  assert.deepEqual(moved.json().fields, ['jurisdictions']);
  const after1 = await declared(te.id);
  assert.deepEqual(after1.map((r) => r.jurisdiction), ['federal', 'MN', 'WI']);
  assert.equal(after1.find((r) => r.jurisdiction === 'MN')!.filing_method, filingLane(2025), 'the added state takes the lane the year implies');
  assert.equal(after1.find((r) => r.jurisdiction === 'WI')!.filing_method, 'paper', 'a kept state keeps its method');
  const rows = await corrections(te.id);
  assert.deepEqual(rows[0]!.before['jurisdictions'], ['federal', 'IL', 'WI']);
  assert.deepEqual(rows[0]!.after['jurisdictions'], ['federal', 'MN', 'WI']);

  // WI is mailed; MN accepts. Neither can leave the filing now.
  const mailed = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/jurisdictions/WI/mailing`, headers: auth(ana), payload: { mailedOn: today, method: 'first_class' } });
  assert.equal(mailed.statusCode, 200, mailed.body);
  const accepted = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/efile-result`, headers: auth(ana), payload: { result: 'accepted', jurisdiction: 'state', stateCode: 'MN' } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await state(te.id)).stage, 'filed', 'federal is still awaited, so the return is still at filed');

  const dropMailed = await correct(te.id, { jurisdictions: ['federal', 'MN'] });
  assert.equal(dropMailed.statusCode, 409, dropMailed.body);
  assert.equal(dropMailed.json().error, 'jurisdiction_satisfied');
  assert.match(dropMailed.json().message, /WI was mailed this return on/);
  const dropAccepted = await correct(te.id, { jurisdictions: ['federal', 'WI'] });
  assert.equal(dropAccepted.statusCode, 409, dropAccepted.body);
  assert.equal(dropAccepted.json().error, 'jurisdiction_satisfied');
  assert.match(dropAccepted.json().message, /MN accepted this return on/);
  assert.deepEqual((await declared(te.id)).map((r) => r.jurisdiction), ['federal', 'MN', 'WI'], 'both refusals left the list alone');
  assert.equal((await corrections(te.id)).length, 1, 'and appended nothing');

  // Several fields in one correction: one row naming each.
  const both = await correct(te.id, { filedOn: addDays(today, -1), jurisdictions: ['federal', 'MN', 'WI', 'IA'] });
  assert.equal(both.statusCode, 201, both.body);
  assert.deepEqual(both.json().fields, ['filed_date', 'jurisdictions']);
});

test('role proof and the door\'s edges: a bookkeeper gets 403; a return not at filed gets 409; a chat artifact is not a reason; the CEO holds it by wildcard', async () => {
  const ready = await readyReturn('Edges');
  const notFiled = await correct(ready.id, { filedOn: SIGNED_ON });
  assert.equal(notFiled.statusCode, 409, notFiled.body);
  assert.equal(notFiled.json().error, 'not_filed');

  const te = await filedReturn('Roles');
  const bookkeeper = await correct(te.id, { filedOn: SIGNED_ON }, marian);
  assert.equal(bookkeeper.statusCode, 403, bookkeeper.body);
  const pointer = await correct(te.id, { filedOn: SIGNED_ON, reason: 'per ruling 44 as discussed' });
  assert.equal(pointer.statusCode, 400, pointer.body);
  const tooShort = await correct(te.id, { filedOn: SIGNED_ON, reason: 'typo' });
  assert.equal(tooShort.statusCode, 400, tooShort.body);
  assert.equal((await state(te.id)).filed_date, today, 'nothing moved');
  assert.equal((await corrections(te.id)).length, 0);

  const ceo = await correct(te.id, { filedOn: SIGNED_ON }, brian);
  assert.equal(ceo.statusCode, 201, ceo.body);
  assert.equal((await corrections(te.id))[0]!.actor_label, brian.fullName);
  assert.equal((await state(te.id)).filed_date, SIGNED_ON);
});
