// Master + Schedules (legal package v3 FINAL) — the sentences that carry legal
// weight, asserted.
//
// Master §1: "Your signature below constitutes acceptance of this Agreement and
// every Service Schedule attached at signing. Services added later are engaged by
// your electronic acceptance of the applicable Schedule through the client portal,
// without re-execution of this Agreement."
//
// That is four claims, and each one is a way this can be wrong:
//   · one signature covers every attached schedule       → acceptance rows exist per schedule
//   · the Master is never re-executed                    → a second signed packet is impossible
//   · later services are accepted per-schedule           → via = 'portal_acceptance'
//   · a Schedule incorporates the Master                 → no acceptance before the signature
//
// Plus the two v3 side-rules: English controls until Brian approves a translation,
// and the §7216 consents are presented on v3's terms, not whenever convenient.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import {
  acceptScheduleInPortal, createPacket, pendingSchedules, previewPacket,
  recordMasterSignature, renderMasterForPacket, resolveSchedules,
} from '../src/modules/engagements/packet.ts';
import { consentsToPresent, recordConsentAnswer } from '../src/modules/compliance/consent-presentation.ts';
import { renderTemplate } from '../src/modules/templates/service.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let actor: AuthedStaff;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** Sign a contact in the way the portal does, returning its session token. */
async function portalSession(contactId: string, email: string): Promise<string> {
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { randomBytes, createHash } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return token;
}

/** A client with one active engagement on the given line. */
async function clientWith(line: string, name: string): Promise<string> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, $2::service_line, 'active')`,
    [c.id, line]
  );
  return c.id;
}

before(async () => {
  config = await createTestConfig('masterschedules');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-ms@example.test', 'ceo');
  actor = { id: brian.id, email: brian.email, permissions: ['*'] } as AuthedStaff;
});

after(async () => {
  await app.close();
});

// ── The seed itself: nothing final is a placeholder ────────────────────────────

test('the Master is final, carries the late-fee disclosure, and the old letters are retired', async () => {
  const master = await app.db.query<{ key: string; is_placeholder: boolean; has_late_fee_disclosure: boolean }>(
    `SELECT key, is_placeholder, has_late_fee_disclosure FROM templates WHERE kind = 'master' AND is_active`
  );
  assert.equal(master.rows.length, 1, 'exactly one active Master');
  assert.equal(master.rows[0]!.is_placeholder, false, 'the Master is final text');
  assert.equal(
    master.rows[0]!.has_late_fee_disclosure, true,
    'the late-fee disclosure now lives on the Master — the fee job reads this stamp'
  );

  // THE LAUNCH GATE. Schedule F's flag cleared 2026-08-10 on Brian's ruling that
  // its "FOR ATTORNEY REDLINE" header is a stale draft banner, so the set is empty
  // again — every piece of client-facing legal copy is final and sendable.
  const activePlaceholders = await app.db.query<{ key: string }>(
    `SELECT key FROM templates WHERE is_placeholder AND is_active ORDER BY key`
  );
  assert.deepEqual(
    activePlaceholders.rows.map((r) => r.key), [],
    'no ACTIVE template is still a placeholder — that is the launch gate'
  );

  /*
   * INVERTED 2026-09-06 (Brian's ruling): the five old letters are DELETED, not retired.
   *
   * This asserted the opposite — "retired WITH a reason, not deleted" — on the seed's stated
   * grounds that they were "the terms any historical engagement was signed under". That never
   * became true: no executed envelope ever referenced one, in any environment.
   *
   * What they did instead was cost a day. On 2026-09-06 a readiness sweep grepped template
   * bodies for "PLACEHOLDER", matched their warning banners — their body IS the banner — and
   * reported that no engagement letter could be sent to a client, as the headline blocker for
   * client #1. The assertion three lines above this one was passing that whole time, saying
   * plainly that every piece of client-facing legal copy is final and sendable. Migration 0079
   * removes the rows so the next reader cannot repeat the mistake.
   */
  const orphans = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM templates WHERE key LIKE 'engagement_letter_%'`
  );
  assert.equal(orphans.rows[0]!.n, 0, 'the five superseded letters are gone, not merely deactivated');

  const schedules = await app.db.query<{ schedule_code: string }>(
    `SELECT schedule_code FROM service_schedules ORDER BY schedule_code`
  );
  // F joined the set when the attest schedule landed (see schedule-f-attest.spec.ts).
  assert.deepEqual(schedules.rows.map((r) => r.schedule_code), ['A', 'B', 'C', 'D', 'E', 'F']);
});

// ── Assembly ──────────────────────────────────────────────────────────────────

test('the A/B split comes from the RETURN TYPE, not from the service line', async () => {
  const noReturns = await clientWith('tax', 'TaxNoReturns');
  const a = await resolveSchedules(app, noReturns);
  assert.deepEqual(a.codes, ['A'], 'tax with no return type on file defaults to the individual schedule');

  const biz = await clientWith('tax', 'TaxBusiness');
  const eng = await app.db.query<{ id: string }>(
    `SELECT id FROM engagements WHERE contact_id = $1`, [biz]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline)
     VALUES ($1, 2025, '1120s', 'intake_started', '2026-03-15')`,
    [eng.rows[0]!.id]
  );
  const b = await resolveSchedules(app, biz);
  assert.deepEqual(b.codes, ['B'], 'a business-only client gets B and is NOT made to sign A as well');

  // The owner's personal return arrives too — a second engagement, same client.
  const personal = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [biz]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline)
     VALUES ($1, 2025, '1040', 'intake_started', '2026-04-15')`,
    [personal.rows[0]!.id]
  );
  const both = await resolveSchedules(app, biz);
  assert.deepEqual(both.codes, ['A', 'B'], 'a 1040 alongside the 1120-S adds A');
});

test('service lines map to their schedules', async () => {
  const books = await clientWith('bookkeeping', 'BooksClient');
  assert.deepEqual((await resolveSchedules(app, books)).codes, ['C']);

  const advisory = await clientWith('advisory', 'AdvisoryClient');
  assert.deepEqual((await resolveSchedules(app, advisory)).codes, ['D']);

  const entity = await clientWith('entity', 'EntityClient');
  assert.deepEqual((await resolveSchedules(app, entity)).codes, ['E']);

  // Attest used to be refused here (`service_line_unscheduled`) because Schedules
  // A–E do not cover CPA review/audit work. Schedule F now covers it, so attest
  // MAPS — but under a harder rule that lives in schedule-f-attest.spec.ts: no
  // packet without a complete per-engagement Addendum.
  const attest = await clientWith('attest', 'AttestClient');
  assert.deepEqual((await resolveSchedules(app, attest)).codes, ['F']);
});

// ── Master §1, all four claims ────────────────────────────────────────────────

test('ONE signature accepts the Master and every attached schedule', async () => {
  const id = await clientWith('bookkeeping', 'OneSignature');
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'advisory', 'active')`,
    [id]
  );
  const packet = await createPacket(app, id, actor);
  assert.deepEqual(packet.scheduleCodes, ['C', 'D'], 'both services ride one envelope');

  const result = await recordMasterSignature(app, packet.packetId);
  assert.deepEqual(result.accepted.sort(), ['C', 'D']);

  const rows = await app.db.query<{ schedule_code: string; via: string; packet_id: string | null }>(
    `SELECT schedule_code, via::text AS via, packet_id FROM schedule_acceptances
     WHERE contact_id = $1 ORDER BY schedule_code`,
    [id]
  );
  assert.equal(rows.rows.length, 2, 'one acceptance row per schedule — per-service is answerable');
  for (const r of rows.rows) {
    assert.equal(r.via, 'master_signature');
    assert.equal(r.packet_id, packet.packetId, 'and it points at the packet that carried the signature');
  }

  // The old single flag stays in step so every pre-v3 gate keeps working.
  const contact = await app.db.query<{ engagement_letter_status: string }>(
    `SELECT engagement_letter_status FROM contacts WHERE id = $1`, [id]
  );
  assert.equal(contact.rows[0]!.engagement_letter_status, 'signed');
});

test('the Master is NEVER re-executed — a second signed packet is impossible', async () => {
  const id = await clientWith('bookkeeping', 'NoReExecution');
  const first = await createPacket(app, id, actor);
  await recordMasterSignature(app, first.packetId);

  // The service layer refuses...
  await assert.rejects(
    createPacket(app, id, actor),
    (err: { code?: string }) => err.code === 'master_already_signed',
    'a second packet is refused with the reason, not a generic error'
  );

  // ...and so does the database, even if some future code path forgets to ask.
  await assert.rejects(
    app.db.query(
      // signature_method is set so this INSERT gets PAST
      // engagement_packets_signed_has_method and actually reaches the unique index
      // under test. Both constraints are real; this one is not the subject here.
      `INSERT INTO engagement_packets
         (contact_id, master_template_key, master_version, schedule_codes, status, signed_at,
          signature_method)
       VALUES ($1, 'engagement_master', 1, ARRAY['C'], 'signed', now(), 'portal_esign')`,
      [id]
    ),
    /idx_one_signed_master_per_contact/,
    'the partial unique index is the real guarantee'
  );
});

test('a later-added service is accepted per-schedule in the portal, and recorded as such', async () => {
  const id = await clientWith('bookkeeping', 'AddsLater');
  const packet = await createPacket(app, id, actor);
  await recordMasterSignature(app, packet.packetId);

  // Payroll is added months later. It maps to Schedule C, already accepted —
  // so nothing new is asked of the client.
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'payroll', 'active')`,
    [id]
  );
  assert.deepEqual((await previewPacket(app, id)).newSchedules, [], 'C already covers payroll');

  // Advisory is genuinely new terms — Schedule D, pending acceptance.
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'advisory', 'active')`,
    [id]
  );
  const preview = await previewPacket(app, id);
  assert.deepEqual(preview.newSchedules, ['D'], 'the new service needs its schedule accepted');
  assert.equal(preview.alreadySigned, true, 'but NOT a new signature');

  const accepted = await acceptScheduleInPortal(app, id, 'D', { ip: '203.0.113.10' });
  assert.deepEqual(accepted, { accepted: true, alreadyAccepted: false });
  const row = await app.db.query<{ via: string; packet_id: string | null; template_version: number }>(
    `SELECT via::text AS via, packet_id, template_version FROM schedule_acceptances
     WHERE contact_id = $1 AND schedule_code = 'D'`,
    [id]
  );
  assert.equal(row.rows[0]!.via, 'portal_acceptance');
  assert.equal(row.rows[0]!.packet_id, null, 'no packet — this one came in without a signature');
  assert.ok(row.rows[0]!.template_version >= 1, 'the version they agreed to is recorded');

  // Idempotent: a double-tap in the portal is not a second acceptance.
  assert.deepEqual(await acceptScheduleInPortal(app, id, 'D'), { accepted: true, alreadyAccepted: true });
});

test('BEFORE signing, no schedule is offered as "added since then" (finding #8)', async () => {
  // The portal offered Schedule A as a service "we added since then", under copy
  // asserting the Master was already signed, with an accept button that
  // acceptScheduleInPortal then refused as master_not_signed. The acceptance rows
  // were fine — "pending" simply meant "not yet accepted" instead of "added after
  // signing", and before a signature nothing is accepted, so everything looked new.
  const id = await clientWith('tax', 'PendingBeforeSign');

  const before = await pendingSchedules(app, id);
  assert.equal(before.masterSigned, false);
  assert.deepEqual(
    before.pending.map((p) => p.schedule_code), [],
    'nothing is "added since then" when nothing has been signed yet'
  );

  // After signing, still nothing pending: A was attached AT signing and covered.
  const packet = await createPacket(app, id, actor);
  await recordMasterSignature(app, packet.packetId, { method: 'portal_esign' });
  const after = await pendingSchedules(app, id);
  assert.equal(after.masterSigned, true);
  assert.deepEqual(after.accepted, ['A']);
  assert.deepEqual(
    after.pending.map((p) => p.schedule_code), [],
    'a schedule covered by the signature is never offered again'
  );

  // A genuinely NEW service does appear — that is what pending is for.
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'advisory', 'active')`,
    [id]
  );
  const withNew = await pendingSchedules(app, id);
  assert.deepEqual(withNew.pending.map((p) => p.schedule_code), ['D']);
});

test('a Schedule cannot be accepted before the Master it incorporates', async () => {
  const id = await clientWith('bookkeeping', 'ScheduleFirst');
  await assert.rejects(
    acceptScheduleInPortal(app, id, 'C'),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'master_not_signed');
      assert.match(String(err.message), /incorporates the Master/i);
      return true;
    }
  );
  const rows = await app.db.query(`SELECT 1 FROM schedule_acceptances WHERE contact_id = $1`, [id]);
  assert.equal(rows.rows.length, 0, 'and nothing was written');
});

// ── English controls ─────────────────────────────────────────────────────────

test('unapproved Spanish is never sent — the client gets the controlling English text', async () => {
  const vars = { schedules_attached: 'A — Individual Income Tax Preparation' };
  const enOnly = await renderTemplate(app, 'engagement_master', 'en', vars);
  const asSpanish = await renderTemplate(app, 'engagement_master', 'es', vars);
  assert.equal(asSpanish.body, enOnly.body, 'no Spanish body yet → English, which is the text that governs');

  // A translation exists but is UNAPPROVED: still English. This is the case that
  // would otherwise slip through, because the body is no longer NULL.
  await app.db.query(
    `UPDATE templates SET body_es = 'TRADUCCIÓN SIN APROBAR — no debe enviarse.', subject_es = 'Sin aprobar'
     WHERE key = 'engagement_master'`
  );
  const unapproved = await renderTemplate(app, 'engagement_master', 'es', vars);
  assert.equal(unapproved.body, enOnly.body, 'a pending translation is not live copy');

  // Approved → the Spanish is used.
  await app.db.query(
    `UPDATE templates SET needs_es_review = false, es_approved_by_staff_id = $1, es_approved_at = now()
     WHERE key = 'engagement_master'`,
    [brian.id]
  );
  const approved = await renderTemplate(app, 'engagement_master', 'es', vars);
  assert.match(approved.body, /TRADUCCIÓN SIN APROBAR/, 'once Brian approves it, Spanish readers get Spanish');

  // Put it back — later tests in this file render the Master as the client sees it.
  await app.db.query(
    `UPDATE templates SET body_es = NULL, subject_es = NULL, needs_es_review = true,
            es_approved_by_staff_id = NULL, es_approved_at = NULL
     WHERE key = 'engagement_master'`
  );
});

test('the attached-schedule list in the Master comes from the packet, not from a caller', async () => {
  const id = await clientWith('bookkeeping', 'RendersMaster');
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'entity', 'active')`,
    [id]
  );
  const packet = await createPacket(app, id, actor);
  const rendered = await renderMasterForPacket(app, packet.packetId);
  assert.deepEqual(rendered.scheduleCodes, ['C', 'E']);
  // #20: the TITLE carries the code, so the line reads "Schedule C — …; Schedule E — …".
  // The point of this assertion is unchanged — the list comes from the packet, not a
  // caller — so it is the expected FORMAT that moved, not the guarantee.
  assert.match(rendered.body, /Service Schedules attached at signing: Schedule C — .*; Schedule E — /);
  assert.doesNotMatch(rendered.body, /signing: C — Schedule C/, "the code is not prefixed twice");
  assert.doesNotMatch(rendered.body, /\{\{/, 'no unfilled variable reaches a signer');
});

test('the Spanish queue lists what is waiting, refuses to approve nothing, and re-queues on edit', async () => {
  const queue = await app.inject({ method: 'GET', url: '/admin/templates/es-queue', headers: auth(brian) });
  assert.equal(queue.statusCode, 200);
  const waiting = queue.json().awaitingApproval as Array<{ key: string; translation_missing: boolean }>;
  assert.ok(waiting.length >= 6, 'the Master, five schedules and the consents are queued');
  assert.ok(waiting.some((t) => t.key === 'consent_7216_use'));

  // Approving a template with no translation is a no-op with an explanation.
  // The seeded consents now DO carry a (pending) translation, so clear one first —
  // this is testing the empty case, not the seeded state.
  await app.db.query(`UPDATE templates SET body_es = NULL WHERE key = 'consent_7216_use'`);
  const empty = await app.inject({
    method: 'POST', url: '/admin/templates/consent_7216_use/es-approve', headers: auth(brian),
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'no_translation');

  // Enter a translation, approve it, then edit it — the edit sends it back.
  await app.inject({
    method: 'PATCH', url: '/admin/templates/consent_7216_use', headers: auth(brian),
    payload: { bodyEs: 'Consentimiento traducido.' },
  });
  const approve = await app.inject({
    method: 'POST', url: '/admin/templates/consent_7216_use/es-approve', headers: auth(brian),
  });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().status, 'approved');

  const edit = await app.inject({
    method: 'PATCH', url: '/admin/templates/consent_7216_use', headers: auth(brian),
    payload: { bodyEs: 'Consentimiento traducido, revisado.' },
  });
  assert.equal(edit.json().esRequeuedForApproval, true, 'an approval belongs to the text that was read');
  const row = await app.db.query<{ needs_es_review: boolean; es_approved_at: string | null }>(
    `SELECT needs_es_review, es_approved_at FROM templates WHERE key = 'consent_7216_use'`
  );
  assert.equal(row.rows[0]!.needs_es_review, true);
  assert.equal(row.rows[0]!.es_approved_at, null, 'and the stale approval is cleared, not left standing');
});

// ── §7216 presentation split ─────────────────────────────────────────────────

test('no §7216 consent is presented before the Master is signed', async () => {
  const id = await clientWith('tax', 'ConsentTiming');
  const before = await consentsToPresent(app, id);
  assert.equal(before.masterSigned, false);
  assert.deepEqual(before.offers, [], 'asking alongside the document they must sign is the conditioning §7216 forbids');
  assert.equal(before.withheld.length, 2);

  await assert.rejects(
    recordConsentAnswer(app, id, '7216_use', true),
    (err: { code?: string }) => err.code === 'master_not_signed',
    'and the capture path refuses too, not just the presentation'
  );
});

test('USE goes to every client; DISCLOSE only to a Hilo bridge or a real referral moment', async () => {
  const plain = await clientWith('tax', 'PlainTax');
  await recordMasterSignature(app, (await createPacket(app, plain, actor)).packetId);

  const offers = await consentsToPresent(app, plain);
  assert.deepEqual(offers.offers.map((o) => o.kind), ['7216_use'], 'USE yes, DISCLOSE no');
  assert.match(offers.offers[0]!.headlineEn, /savings/i, 'and it is framed as a benefit, not a form');
  assert.match(offers.offers[0]!.bodyEn, /not a condition of any service/i, 'never conditioning service');
  const why = offers.withheld.find((w) => w.kind === '7216_disclose');
  assert.match(String(why?.reason), /No Hilo relationship/i, 'the reason is recorded, not implied');

  // A referral moment opens the DISCLOSE window for the same client.
  const atReferral = await consentsToPresent(app, plain, { atReferralMoment: true });
  assert.deepEqual(atReferral.offers.map((o) => o.kind).sort(), ['7216_disclose', '7216_use']);

  // A Hilo-bridge client is asked at onboarding without waiting for a referral.
  const hilo = await clientWith('tax', 'HiloBridge');
  await app.db.query(`UPDATE contacts SET br1_referred_by_hilo = true WHERE id = $1`, [hilo]);
  await recordMasterSignature(app, (await createPacket(app, hilo, actor)).packetId);
  const hiloOffers = await consentsToPresent(app, hilo);
  assert.deepEqual(hiloOffers.offers.map((o) => o.kind).sort(), ['7216_disclose', '7216_use']);
  assert.match(
    String(hiloOffers.offers.find((o) => o.kind === '7216_disclose')?.reason),
    /Hilo bridge/i
  );
});

test('a declined consent is recorded and never asked again — and does not revoke a signed one', async () => {
  const id = await clientWith('tax', 'Declines');
  await app.db.query(`UPDATE contacts SET br4_hilo_program_participant = true WHERE id = $1`, [id]);
  await recordMasterSignature(app, (await createPacket(app, id, actor)).packetId);

  assert.deepEqual((await recordConsentAnswer(app, id, '7216_use', true)), { status: 'signed' });
  assert.deepEqual((await recordConsentAnswer(app, id, '7216_disclose', false)), { status: 'declined' });

  const after = await consentsToPresent(app, id);
  assert.deepEqual(after.offers, [], 'both answered — stop asking');
  for (const w of after.withheld) assert.match(w.reason, /Already answered/i);

  // The rollup every existing gate reads must still say the USE consent is on file.
  const rollup = await app.db.query<{ consent_7216_status: string }>(
    `SELECT consent_7216_status FROM contacts WHERE id = $1`, [id]
  );
  assert.equal(
    rollup.rows[0]!.consent_7216_status, 'signed',
    'declining the Hilo disclosure must not revoke the consent they actually gave'
  );
});

test('the portal shows only the offers, and refuses an answer to a consent it never asked', async () => {
  const id = await clientWith('tax', 'PortalConsent');
  await recordMasterSignature(app, (await createPacket(app, id, actor)).packetId);
  const cookie = { cookie: `saos_portal_session=${await portalSession(id, 'portalconsent@example.test')}` };

  const shown = await app.inject({ method: 'GET', url: '/portal/consents', headers: cookie });
  assert.equal(shown.statusCode, 200);
  const body = shown.json() as { masterSigned: boolean; offers: Array<{ kind: string }>; withheld?: unknown };
  assert.equal(body.masterSigned, true);
  assert.deepEqual(body.offers.map((o) => o.kind), ['7216_use']);
  assert.equal(body.withheld, undefined, 'a client has no reason to read why they were not asked something');

  // This client has no Hilo relationship, so DISCLOSE was withheld. A crafted
  // request must not be able to record it anyway.
  const crafted = await app.inject({
    method: 'POST', url: '/portal/consents', headers: cookie,
    payload: { kind: '7216_disclose', granted: true },
  });
  assert.equal(crafted.statusCode, 409);
  assert.equal(crafted.json().error, 'consent_not_offered');
  const none = await app.db.query(
    `SELECT 1 FROM consents WHERE contact_id = $1 AND type = '7216_disclose'`, [id]
  );
  assert.equal(none.rows.length, 0, 'and nothing was written');

  // The offered one goes through and is recorded as a portal answer.
  const ok = await app.inject({
    method: 'POST', url: '/portal/consents', headers: cookie,
    payload: { kind: '7216_use', granted: true },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const row = await app.db.query<{ status: string; method: string; policy_version: string; signed_at: string | null }>(
    `SELECT status::text, method::text, policy_version, signed_at FROM consents
     WHERE contact_id = $1 AND type = '7216_use'`,
    [id]
  );
  assert.equal(row.rows[0]!.status, 'signed');
  assert.equal(row.rows[0]!.method, 'portal_checkbox');
  assert.match(row.rows[0]!.policy_version, /^v3-t\d+$/, 'the consent records which version they read');
  assert.ok(row.rows[0]!.signed_at);
});

test('the portal accepts a later schedule, and refuses a code it was not offered', async () => {
  const id = await clientWith('bookkeeping', 'PortalSchedule');
  await recordMasterSignature(app, (await createPacket(app, id, actor)).packetId);
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'advisory', 'active')`,
    [id]
  );
  const cookie = { cookie: `saos_portal_session=${await portalSession(id, 'portalschedule@example.test')}` };

  const pending = await app.inject({ method: 'GET', url: '/portal/schedules', headers: cookie });
  assert.equal(pending.statusCode, 200);
  const list = pending.json() as { masterSigned: boolean; pending: Array<{ schedule_code: string; body_en: string }> };
  assert.equal(list.masterSigned, true);
  assert.deepEqual(list.pending.map((p) => p.schedule_code), ['D']);
  assert.ok(list.pending[0]!.body_en.length > 200, 'the client is shown the actual terms, not a title');

  const accept = await app.inject({ method: 'POST', url: '/portal/schedules/D/accept', headers: cookie });
  assert.equal(accept.statusCode, 200, accept.body);
  assert.equal(accept.json().alreadyAccepted, false);

  const bad = await app.inject({ method: 'POST', url: '/portal/schedules/Z/accept', headers: cookie });
  assert.equal(bad.statusCode, 400, 'a code outside A–E is not a schedule');
});

test('a legal DOCUMENT can render in Spanish — a null subject is not "Spanish unavailable"', async () => {
  // Found 2026-08-13, the morning after Brian approved nine translations: renderTemplate
  // treated `subject_es === null` as "no Spanish", and every legal document has a null
  // subject because a contract has no email subject line. So the Master, six Schedules
  // and both consents would have rendered ENGLISH to Spanish clients forever while the
  // admin screen showed them approved. A fallback that cannot be switched off is a wall.
  const staffRow = await app.db.query<{ id: string }>(
    `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'ceo' LIMIT 1`
  );
  await app.db.query(
    `UPDATE templates
        SET body_es = 'CONTRATO DE PRUEBA — cuerpo en español.',
            needs_es_review = false, es_approved_at = now(), es_approved_by_staff_id = $1
      WHERE key = 'schedule_a_individual_tax'`,
    [staffRow.rows[0]!.id]
  );

  const subj = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM templates
      WHERE key = 'schedule_a_individual_tax' AND subject_en IS NULL AND subject_es IS NULL`
  );
  assert.equal(subj.rows[0]!.n, 1, 'the precondition: this document has no subject at all');

  const { renderTemplate } = await import('../src/modules/templates/service.ts');
  const es = await renderTemplate(app, 'schedule_a_individual_tax', 'es', {});
  assert.match(es.body, /CONTRATO DE PRUEBA/, 'approved Spanish renders for a subjectless document');

  // And an EMAIL template still requires its Spanish subject before Spanish is used —
  // sending a Spanish body under an English subject line is worse than either.
  await app.db.query(
    `UPDATE templates
        SET body_es = 'Cuerpo en español.', subject_es = NULL,
            needs_es_review = false, es_approved_at = now(), es_approved_by_staff_id = $1
      WHERE key = 'packet_ready_to_sign'`,
    [staffRow.rows[0]!.id]
  );
  const email = await renderTemplate(app, 'packet_ready_to_sign', 'es', {
    first_name: 'Sintética', schedules: 'A', sign_link: 'https://example.test/s',
  });
  assert.doesNotMatch(email.body, /Cuerpo en español/, 'an email with no Spanish subject stays English');
});

test('§7216: the client is shown the MANDATED text, bilingual, with English operative', async () => {
  // The consent screen used to show benefit framing only, while the consent row stamped
  // a template version whose text the client had never seen. Treas. Reg. §301.7216-3
  // requires the mandatory statements to be IN the consent.
  const { consentsToPresent } = await import('../src/modules/compliance/consent-presentation.ts');
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'ConsentText', email: 'consenttext@example.test', language: 'es',
  });
  await app.db.query(
    `INSERT INTO engagement_packets
       (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master',
             (SELECT version FROM templates WHERE key = 'engagement_master'),
             ARRAY['A'], 'signed', now(), 'portal_esign')`,
    [c.id]
  );

  const { offers } = await consentsToPresent(app, c.id);
  const use = offers.find((o) => o.kind === '7216_use');
  assert.ok(use, 'the USE consent is offered after signing');

  // The statements the regulation prescribes, in the text the client actually sees.
  assert.match(use!.legalEn, /Federal law requires this consent form be provided to you/);
  assert.match(use!.legalEn, /your consent will not be valid/, 'the invalid-if-conditioned statement');
  assert.match(use!.legalEn, /1-800-366-4484/, 'the TIGTA contact');
  assert.ok(use!.templateVersion >= 1, 'the version shown is the version stamped on the record');

  // Wet-signature ruled lines are gone: this is signed by tapping a button.
  assert.doesNotMatch(use!.legalEn, /_{6,}/, 'no ruled signature lines in an e-signed consent');
  if (use!.legalEs) assert.doesNotMatch(use!.legalEs, /_{6,}/);
});
