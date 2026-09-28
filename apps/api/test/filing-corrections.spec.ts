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
import { createTestConfig, makeContact, makeStaff, multipartBody, signed8879OnFile, type TestStaff } from './helpers.ts';
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

/*
 * ═══ R69 (Brian, 2026-09-26/27): THE SIGNED 8879, CORRECTED ═════════════════════════════════════
 * The day lives on tax_engagements.f8879_signed_at (read everywhere as ::date); the scan is the
 * document row f8879_document_id points at. Both move through the same door as the filed date.
 */
const PDF = Buffer.from('%PDF-1.4 synthetic test document - no real client data\n%%EOF');
/** A scan into Signed Authorizations against the return with NO signed date: filed, not yet the 8879 on file. */
async function uploadScan(te: { id: string; contactId: string }, filename: string, who: { token: string } = ana): Promise<string> {
  const body = multipartBody(
    { contactId: te.contactId, category: 'signed_authorizations', taxEngagementId: te.id },
    { field: 'file', filename, contentType: 'application/pdf', data: PDF }
  );
  const res = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(who), ...body.headers }, payload: body.payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}
async function authorization(id: string) {
  const { rows } = await app.db.query<{ f8879_signed_on: string | null; f8879_document_id: string | null; envelope_on: string | null; envelope_doc: string | null }>(
    `SELECT te.f8879_signed_at::date::text AS f8879_signed_on, te.f8879_document_id,
            (SELECT se.completed_at::date::text FROM signature_envelopes se WHERE se.tax_engagement_id = te.id AND se.type = 'f8879' ORDER BY se.created_at DESC LIMIT 1) AS envelope_on,
            (SELECT se.signed_document_id FROM signature_envelopes se WHERE se.tax_engagement_id = te.id AND se.type = 'f8879' ORDER BY se.created_at DESC LIMIT 1) AS envelope_doc
       FROM tax_engagements te WHERE te.id = $1`,
    [id]
  );
  return rows[0]!;
}

test('R69 the 8879 signed date correction: refused after today, after the filed date, before the year end and when unchanged; lands on the return and the envelope; the filed-date rule then reads the corrected day, inclusive', async () => {
  const te = await filedReturn('Signedfix');
  // Filed three days ago first, so "after today" and "after the filed date" are two different refusals.
  const filedDay = addDays(today, -3);
  assert.equal((await correct(te.id, { filedOn: filedDay })).statusCode, 201);

  const future = await correct(te.id, { f8879SignedOn: addDays(today, 1) });
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'signed_date_in_future');
  const afterFiled = await correct(te.id, { f8879SignedOn: addDays(today, -1) });
  assert.equal(afterFiled.statusCode, 409, afterFiled.body);
  assert.equal(afterFiled.json().error, 'signed_after_filing');
  assert.match(afterFiled.json().message, new RegExp(`after the filed date ${filedDay}`), 'names the filed day');
  const early = await correct(te.id, { f8879SignedOn: '2025-12-30' });
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'signed_before_year_end');
  const same = await correct(te.id, { f8879SignedOn: SIGNED_ON });
  assert.equal(same.statusCode, 409, same.body);
  assert.equal(same.json().error, 'nothing_to_correct');
  assert.equal((await corrections(te.id)).length, 1, 'four refusals appended nothing');
  assert.equal((await authorization(te.id)).f8879_signed_on, SIGNED_ON, 'and moved nothing');

  // The paper is dated twelve days ago; the upload recorded ten.
  const paperDay = addDays(today, -12);
  const ok = await correct(te.id, { f8879SignedOn: paperDay });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().fields, ['f8879_signed_on']);
  const a = await authorization(te.id);
  assert.equal(a.f8879_signed_on, paperDay, 'the return reads the corrected day where the gate and the filed-date rule read it');
  assert.equal(a.envelope_on, paperDay, 'the envelope row reads it too');
  const rows = await corrections(te.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1]!.fields, ['f8879_signed_on']);
  assert.equal(rows[1]!.before['f8879_signed_on'], SIGNED_ON);
  assert.equal(rows[1]!.after['f8879_signed_on'], paperDay);
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.filing_corrected' AND object_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [te.id]);
  assert.deepEqual(audit.rows[0]!.details['fields'], ['f8879_signed_on']);
  assert.deepEqual(audit.rows[0]!.details['after'], { f8879_signed_on: paperDay }, 'dates only, nothing about the client');
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as { taxEngagement: { f8879_signed_on: string } };
  assert.equal(detail.taxEngagement.f8879_signed_on, paperDay, 'GET reads the corrected day');

  // THE FILED-DATE RULE READS THE CORRECTED VALUE — and "not before" is inclusive.
  const before = await correct(te.id, { filedOn: addDays(paperDay, -1) });
  assert.equal(before.statusCode, 409, before.body);
  assert.equal(before.json().error, 'filed_before_authorization');
  assert.match(before.json().message, new RegExp(`dated ${paperDay}`), 'the refusal names the CORRECTED signed day');
  const onTheDay = await correct(te.id, { filedOn: paperDay });
  assert.equal(onTheDay.statusCode, 201, onTheDay.body);
  assert.equal((await state(te.id)).filed_date, paperDay, 'filed on the signed day is allowed');
  // Both in one correction, to the same earlier day: authorized and filed the same day, both moving together.
  const together = await correct(te.id, { f8879SignedOn: addDays(today, -14), filedOn: addDays(today, -14) });
  assert.equal(together.statusCode, 201, together.body);
  assert.deepEqual(together.json().fields, ['f8879_signed_on', 'filed_date']);
  // And a signed day after the filed day, sent together, is refused against the filed day AS IT WILL STAND.
  const crossed = await correct(te.id, { f8879SignedOn: addDays(today, -13), filedOn: addDays(today, -15) });
  assert.equal(crossed.statusCode, 409, crossed.body);
  assert.equal(crossed.json().error, 'filed_before_authorization');
});

test('R69 the scan replaced: the previous row is kept and marked superseded, listed, still downloadable and audited; the return and the envelope point at the new scan; a scan from another client or one already replaced is refused', async () => {
  const te = await filedReturn('Scanfix');
  const first = (await authorization(te.id)).f8879_document_id!;
  // The replacement goes in through the documents door with no signed date: a document, not yet the 8879.
  const second = await uploadScan(te, 'synthetic-8879-replacement-one.pdf');
  assert.equal((await authorization(te.id)).f8879_document_id, first, 'an upload alone moves nothing');

  const ok = await correct(te.id, { f8879DocumentId: second });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().fields, ['f8879_document']);
  assert.equal(ok.json().before.f8879_document, first);
  assert.equal(ok.json().after.f8879_document, second);
  const a = await authorization(te.id);
  assert.equal(a.f8879_document_id, second, 'the return points at the new scan');
  assert.equal(a.envelope_doc, second, 'so does the envelope');
  const docs = await app.db.query<{ id: string; superseded_by: string | null; superseded_at: Date | null; archived_at: Date | null; f8879_variant: string | null }>(
    `SELECT id, superseded_by, superseded_at, archived_at, f8879_variant FROM documents WHERE id = ANY($1::uuid[])`, [[first, second]]);
  const oldRow = docs.rows.find((d) => d.id === first)!;
  const newRow = docs.rows.find((d) => d.id === second)!;
  assert.equal(oldRow.superseded_by, second, 'the old row is marked, never deleted');
  assert.ok(oldRow.superseded_at, 'and says when');
  assert.equal(oldRow.archived_at, null, 'not archived: it stays on the record');
  assert.equal(newRow.f8879_variant, '8879-CORP', 'the new scan carries the form the old one had (a 1120S: 8879-CORP)');
  const superseded = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'document.superseded' AND object_id = $1`, [first]);
  assert.equal(superseded.rows.length, 1, 'the supersession is audited on the document');
  assert.equal(superseded.rows[0]!.details['superseded_by'], second);

  // Listed with its mark; still downloadable (the second scan, once replaced by a third, has real bytes behind it).
  const third = await uploadScan(te, 'synthetic-8879-replacement-two.pdf');
  assert.equal((await correct(te.id, { f8879DocumentId: third })).statusCode, 201);
  const listed = (await app.inject({ method: 'GET', url: `/documents?contactId=${te.contactId}`, headers: auth(brian) })).json() as {
    documents: Array<{ id: string; superseded_by: string | null; superseded_at: string | null }>;
  };
  assert.equal(listed.documents.find((d) => d.id === second)!.superseded_by, third, 'the list says the row was replaced');
  assert.equal(listed.documents.find((d) => d.id === third)!.superseded_at, null);
  const download = await app.inject({ method: 'GET', url: `/documents/${second}/download`, headers: auth(brian) });
  assert.equal(download.statusCode, 200, 'a superseded scan still downloads');
  const downloaded = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'document.downloaded' AND object_id = $1`, [second]);
  assert.equal(downloaded.rows.length, 1, 'and the download is audited like any other');

  // Refused: the replaced scan again, another client's scan, the current scan (nothing to correct).
  const again = await correct(te.id, { f8879DocumentId: second });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'document_superseded');
  const other = await filedReturn('Scanother');
  const theirs = await uploadScan(other, 'synthetic-8879-someone-else.pdf');
  const wrongClient = await correct(te.id, { f8879DocumentId: theirs });
  assert.equal(wrongClient.statusCode, 409, wrongClient.body);
  assert.equal(wrongClient.json().error, 'wrong_client');
  const current = await correct(te.id, { f8879DocumentId: third });
  assert.equal(current.statusCode, 409, current.body);
  assert.equal(current.json().error, 'nothing_to_correct');
  assert.equal((await authorization(te.id)).f8879_document_id, third, 'three refusals moved nothing');
  assert.equal((await corrections(te.id)).length, 2);
});

/*
 * ═══ R86 (Brian, 2026-09-27): THE FILING, CORRECTED ON A COMPLETED RETURN ═══════════════════════
 * Brian's 1120S was completed before his corrections could run. Offered at completed too: the signed
 * day, the scan, the filed day and the PTIN holder correct; the return stays completed; a satisfied
 * jurisdiction still cannot be removed, and a completed return takes no new one (that is a reopen).
 */
test('R86: a completed return takes the signed-day, scan, filed-day and PTIN-holder corrections and stays completed; a satisfied jurisdiction cannot be removed and none can be added', async () => {
  const te = await filedReturn('Completedfix');
  const fed = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/efile-result`, headers: auth(ana), payload: { result: 'accepted' } });
  assert.ok(fed.statusCode < 300, fed.body);
  const il = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/efile-result`, headers: auth(ana), payload: { result: 'accepted', jurisdiction: 'state', stateCode: 'IL' } });
  assert.ok(il.statusCode < 300, il.body);
  assert.equal((await state(te.id)).stage, 'completed', 'the fixture is completed');

  const paperDay = addDays(today, -12);
  const signed = await correct(te.id, { f8879SignedOn: paperDay });
  assert.equal(signed.statusCode, 201, signed.body);
  const filedFix = await correct(te.id, { filedOn: paperDay });
  assert.equal(filedFix.statusCode, 201, filedFix.body);
  const scan = await uploadScan(te, 'synthetic-8879-real-scan.pdf');
  const scanFix = await correct(te.id, { f8879DocumentId: scan });
  assert.equal(scanFix.statusCode, 201, scanFix.body);
  const ptin = await correct(te.id, { preparerPtinHolderId: brian.id });
  assert.equal(ptin.statusCode, 201, ptin.body);
  const after = await state(te.id);
  assert.equal(after.stage, 'completed', 'correcting the record is not reopening the return');
  assert.equal(after.filed_date, paperDay);
  assert.equal(after.preparer_ptin_holder_id, brian.id);
  assert.equal((await authorization(te.id)).f8879_document_id, scan);

  const removeIl = await correct(te.id, { jurisdictions: ['federal'] });
  assert.equal(removeIl.statusCode, 409, removeIl.body);
  assert.equal(removeIl.json().error, 'jurisdiction_satisfied');
  const addWi = await correct(te.id, { jurisdictions: ['federal', 'IL', 'WI'] });
  assert.equal(addWi.statusCode, 409, addWi.body);
  assert.equal(addWi.json().error, 'completed_takes_no_jurisdiction');
  assert.equal((await corrections(te.id)).length, 4, 'four corrections appended, the refusals none');
});
