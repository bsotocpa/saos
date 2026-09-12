/*
 * THE §7216 WALL, PHASE 2 (2026-09-12, Brian's ruling 4 and his rulings on Jaqueline's six).
 *
 * Four things stay behind the wall for Laura (va_entity) and Jaqueline (ed_coo): tax-category
 * documents, the SSN last-4, interview content, and CPA sessions with Soto clients. Each is
 * enforced in the query or the download, never in a screen. Each test here is in Brian's
 * sabotage form: the reader HOLDS the read grant, and the thing is still absent. Positive
 * controls prove the wall is category-shaped: Laura sees entity filings, Jaqueline sees the
 * bank statement and her own sessions, Ana and Brian see everything.
 *
 * Her six: meetings.upload, the Hilo dashboard (dashboards.hilo), event close-out (events.manage),
 * meetings.read scoped, referrals.suggest (phase 1). Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createQuote } from '../src/modules/pricing/quotes.ts';
import { createSop } from '../src/modules/sops/service.ts';

let app: FastifyInstance;
let config: Config;
type Tok = TestStaff & { token: string };
let brian: Tok; let ana: Tok; let laura: Tok; let jackson: Tok;
let walled = ''; let hiloOnly = ''; let dual = '';
const docs: Record<string, string> = {};
const meetings: Record<string, string> = {};
let quoteId = ''; let taxEngagementId = '';

const PDF = Buffer.from('%PDF-1.4 synthetic wall test document — no real client data\n%%EOF');
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const SSN4 = '7391';
const INTERVIEW = 'WALL-INTERVIEW-ANSWER-MARKER';
const COMPLEXITY = 'WALL-COMPLEXITY-MARKER';
const CPA_TRANSCRIPT = 'WALL-CPA-TRANSCRIPT-MARKER';
const CPA_SUMMARY = 'WALL-CPA-SUMMARY-MARKER';

async function staffWithToken(email: string, role: string): Promise<Tok> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
const actorOf = (t: Tok, role: string, perms: string[]): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: role, permissions: perms, sessionId: 'wall-spec' });

async function contactRow(last: string, opts: { hilo: string; soto: string; ssn4?: string }): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, hilo_status, soto_status, ssn_last4)
     VALUES ('Synthetic', $1, $2, $3::hilo_status, $4::soto_status, $5) RETURNING id`,
    [last, `${last.toLowerCase()}-wall@example.test`, opts.hilo, opts.soto, opts.ssn4 ?? null]
  );
  return rows[0]!.id;
}
async function upload(contactId: string, category: string, filename: string): Promise<string> {
  const { payload, headers } = multipartBody({ contactId, category }, { field: 'file', filename, contentType: 'application/pdf', data: PDF });
  const res = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(brian), ...headers }, payload });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}
async function session(contactId: string, staffId: string, title: string, transcript: string, summary: string): Promise<string> {
  const m = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, staff_id, type, source, status, title, started_at)
     VALUES ($1, $2, 'in_person', 'manual', 'ready', $3, now() - interval '1 hour') RETURNING id`,
    [contactId, staffId, title]
  );
  const id = m.rows[0]!.id;
  await app.db.query(`INSERT INTO transcripts (meeting_id, engine, content) VALUES ($1, 'test', $2)`, [id, transcript]);
  await app.db.query(
    `INSERT INTO meeting_summaries (meeting_id, summary, client_recap_status, recap_body_en, recap_body_es)
     VALUES ($1, $2, 'drafted', $3, $3)`,
    [id, summary, `Recap: ${summary}`]
  );
  return id;
}
const grants = async (key: string) => (await app.db.query<{ permission: string }>(
  `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = $1 ORDER BY 1`, [key])).rows.map((r) => r.permission);

before(async () => {
  config = await createTestConfig('wall');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await staffWithToken('brian-wall@example.test', 'ceo');
  ana = await staffWithToken('ana-wall@example.test', 'tax_preparer');
  laura = await staffWithToken('laura-wall@example.test', 'va_entity');
  jackson = await staffWithToken('jackson-wall@example.test', 'ed_coo');

  walled = await contactRow('Walled', { hilo: 'none', soto: 'active', ssn4: SSN4 });
  hiloOnly = await contactRow('Hiloonly', { hilo: 'active', soto: 'none' });
  dual = await contactRow('Dual', { hilo: 'active', soto: 'active' });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${walled}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Walled LLC', ein: '12-3456789', entityType: 'llc' } });
  assert.equal(biz.statusCode, 201, biz.body);

  docs.tax = await upload(walled, 'tax_documents', 'WALL-W2-2025.pdf');
  docs.notice = await upload(walled, 'irs_notices', 'WALL-CP2000.pdf');
  docs.bank = await upload(walled, 'business_records', 'WALL-BANK-STATEMENT.pdf');
  docs.entity = await upload(walled, 'entity_filings', 'WALL-ARTICLES-OF-ORGANIZATION.pdf');
  docs.signed = await upload(walled, 'signed_authorizations', 'WALL-SIGNED-8879.pdf');

  meetings.cpa = await session(walled, brian.id, 'CPA session with a Soto client', CPA_TRANSCRIPT, CPA_SUMMARY);
  meetings.own = await session(walled, jackson.id, 'Jaqueline coaching the same client', 'WALL-OWN-TRANSCRIPT', 'WALL-OWN-SUMMARY');
  meetings.hilo = await session(hiloOnly, brian.id, 'Brian at a Hilo workshop', 'WALL-HILO-TRANSCRIPT', 'WALL-HILO-SUMMARY');
  meetings.dualCpa = await session(dual, brian.id, 'CPA session with a dual client', 'WALL-DUAL-TRANSCRIPT', 'WALL-DUAL-SUMMARY');

  const item = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents > 0 AND pbi.display_on_quote ORDER BY pbi.item_code LIMIT 1`);
  const q = await createQuote(app, { contactId: walled, lines: [{ itemCode: item.rows[0]!.item_code }], interviewAnswers: { dependents: 2, note: INTERVIEW } }, actorOf(brian, 'ceo', ['*']));
  quoteId = q.id;
  const te = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { contactId: walled, taxYear: 2025, returnType: '1040' } });
  assert.equal(te.statusCode, 201, te.body);
  taxEngagementId = (te.json() as { id: string }).id;
  await app.db.query(`UPDATE tax_engagements SET complexity_inputs = $2::jsonb WHERE id = $1`, [taxEngagementId, JSON.stringify({ states: 1, note: COMPLEXITY })]);
});
after(async () => { await app.close(); });

test('the grants: her six on ed_coo, the entity scope on va_entity, the preparer inside the wall', async () => {
  assert.deepEqual(await grants('ed_coo'), [
    'contacts.read', 'dashboards.hilo', 'documents.read', 'documents.read.relationship', 'engagements.read',
    'events.manage', 'events.read', 'meetings.read', 'meetings.upload', 'referrals.suggest', 'tasks.manage', 'tasks.read',
  ]);
  const va = await grants('va_entity');
  assert.ok(va.includes('documents.read') && va.includes('documents.read.entity') && !va.includes('documents.read.all'));
  const prep = await grants('tax_preparer');
  for (const p of ['documents.read.all', 'meetings.read.all', 'pii.read', 'interviews.read']) assert.ok(prep.includes(p), `tax_preparer holds ${p}`);
  assert.ok((await grants('bookkeeper')).includes('documents.read.all'), 'Marian reaches what she reached before');
  assert.ok((await grants('comms_billing')).includes('pii.read'), 'Rene verifies callers by SSN: inside the firm');
  assert.ok(!(await grants('intern')).includes('events.read'), 'an intern does not see event rosters');
});

test('documents, Laura: holds documents.read; sees entity filings and nothing else, in the list, the overview, and the download', async () => {
  const list = await app.inject({ method: 'GET', url: `/documents?contactId=${walled}`, headers: auth(laura) });
  assert.equal(list.statusCode, 200, list.body);
  const cats = (list.json() as { documents: { category: string; original_filename: string }[] }).documents.map((d) => d.category);
  assert.deepEqual(cats, ['entity_filings']);
  assert.ok(!list.body.includes('WALL-W2-2025'), 'no tax document name');
  const asked = await app.inject({ method: 'GET', url: `/documents?contactId=${walled}&category=tax_documents`, headers: auth(laura) });
  assert.equal((asked.json() as { documents: unknown[] }).documents.length, 0, 'asking for the walled category by name yields nothing');
  const overview = await app.inject({ method: 'GET', url: `/documents/overview?contactId=${walled}`, headers: auth(laura) });
  const ov = overview.json() as { documents: { category: string }[]; counts: Record<string, number> };
  assert.deepEqual(ov.documents.map((d) => d.category), ['entity_filings']);
  assert.equal(Object.values(ov.counts).reduce((a, b) => a + b, 0), 1, 'the counts are of what she may see');
  for (const k of ['tax', 'notice', 'bank', 'signed']) {
    const dl = await app.inject({ method: 'GET', url: `/documents/${docs[k]}/download`, headers: auth(laura) });
    assert.equal(dl.statusCode, 404, `${k}: the same 404 as nonexistent`);
  }
  const ok = await app.inject({ method: 'GET', url: `/documents/${docs.entity}/download`, headers: auth(laura) });
  assert.equal(ok.statusCode, 200, 'the entity filing downloads');
  const audited = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'document.downloaded' AND object_id = $1 AND actor_id = $2`, [docs.entity, laura.id]);
  assert.equal(audited.rows.length, 1, 'and is audited');
  const refused = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'document.downloaded' AND object_id = $1 AND actor_id = $2`, [docs.tax, laura.id]);
  assert.equal(refused.rows.length, 0, 'a refused download is not a download');
});

test('documents, Jaqueline: holds documents.read; the four return-adjacent categories and recordings are absent, the rest present', async () => {
  const list = await app.inject({ method: 'GET', url: `/documents?contactId=${walled}`, headers: auth(jackson) });
  const cats = (list.json() as { documents: { category: string }[] }).documents.map((d) => d.category).sort();
  assert.deepEqual(cats, ['business_records', 'entity_filings']);
  for (const k of ['tax', 'notice', 'signed']) {
    const dl = await app.inject({ method: 'GET', url: `/documents/${docs[k]}/download`, headers: auth(jackson) });
    assert.equal(dl.statusCode, 404, `${k}: 404`);
  }
  assert.equal((await app.inject({ method: 'GET', url: `/documents/${docs.bank}/download`, headers: auth(jackson) })).statusCode, 200);
});

test('uploads follow reads: Laura files entity papers and nothing else; Rene reads the SSN last-4', async () => {
  const { payload, headers } = multipartBody({ contactId: walled, category: 'tax_documents' }, { field: 'file', filename: 'WALL-LAURA-TAX-UPLOAD.pdf', contentType: 'application/pdf', data: PDF });
  const refused = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(laura), ...headers }, payload });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().error, 'category_not_allowed');
  assert.equal((await app.db.query(`SELECT 1 FROM documents WHERE filename = 'WALL-LAURA-TAX-UPLOAD.pdf'`)).rows.length, 0, 'nothing was stored');
  const ok = multipartBody({ contactId: walled, category: 'entity_filings' }, { field: 'file', filename: 'WALL-LAURA-ANNUAL-REPORT.pdf', contentType: 'application/pdf', data: PDF });
  const accepted = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(laura), ...ok.headers }, payload: ok.payload });
  assert.equal(accepted.statusCode, 201, accepted.body);
  docs.lauraEntity = (accepted.json() as { id: string }).id;
  const rene = await staffWithToken('rene-wall@example.test', 'comms_billing');
  const res = await app.inject({ method: 'GET', url: `/contacts/${walled}`, headers: auth(rene) });
  assert.equal((res.json() as { contact: { ssn_last4: string } }).contact.ssn_last4, SSN4, 'Rene holds pii.read');
});

test('documents, inside the wall: Brian and Ana see every category', async () => {
  for (const who of [brian, ana]) {
    const list = await app.inject({ method: 'GET', url: `/documents?contactId=${walled}`, headers: auth(who) });
    assert.equal((list.json() as { documents: unknown[] }).documents.length, 6, who.email);
    assert.equal((await app.inject({ method: 'GET', url: `/documents/${docs.tax}/download`, headers: auth(who) })).statusCode, 200);
  }
});

test('pii.read is real: the SSN last-4 leaves the client record only for its holders; the status and the EIN stay', async () => {
  for (const who of [laura, jackson]) {
    const res = await app.inject({ method: 'GET', url: `/contacts/${walled}`, headers: auth(who) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { contact: Record<string, unknown>; businesses: { ein: string }[] };
    assert.ok(!('ssn_last4' in body.contact), `${who.email}: no ssn_last4 key at all`);
    assert.ok(!res.body.includes(SSN4), 'the digits are nowhere in the response');
    assert.equal(body.contact.pii_withheld, true);
    assert.ok('ssn_status' in body.contact, 'whether one is on file is workflow, and stays');
    assert.equal(body.businesses[0]!.ein, '12-3456789', 'the EIN stays visible: Laura files with it');
  }
  for (const who of [ana, brian]) {
    const res = await app.inject({ method: 'GET', url: `/contacts/${walled}`, headers: auth(who) });
    assert.equal((res.json() as { contact: { ssn_last4: string } }).contact.ssn_last4, SSN4, who.email);
  }
});

test('interview content is behind interviews.read: the quote answers and the complexity inputs', async () => {
  for (const who of [laura, jackson]) {
    const q = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(who) });
    const te = await app.inject({ method: 'GET', url: `/tax-engagements/${taxEngagementId}`, headers: auth(who) });
    // Laura does not hold engagements.read, so hers is a 403; Jaqueline's is a 200 without the content.
    assert.ok(!q.body.includes(INTERVIEW), `${who.email}: no interview answer in the quote (${q.statusCode})`);
    assert.ok(!te.body.includes(COMPLEXITY), `${who.email}: no complexity input in the engagement (${te.statusCode})`);
  }
  const jq = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(jackson) });
  assert.equal(jq.statusCode, 200);
  assert.ok(!('interview_answers' in (jq.json() as { quote: Record<string, unknown> }).quote), 'the key itself is gone, not nulled');
  const jte = await app.inject({ method: 'GET', url: `/tax-engagements/${taxEngagementId}`, headers: auth(jackson) });
  assert.equal(jte.statusCode, 200);
  assert.ok(!('complexity_inputs' in (jte.json() as { taxEngagement: Record<string, unknown> }).taxEngagement));
  const aq = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(ana) });
  assert.ok(aq.body.includes(INTERVIEW), 'the preparer reads the interview');
  const ate = await app.inject({ method: 'GET', url: `/tax-engagements/${taxEngagementId}`, headers: auth(ana) });
  assert.ok(ate.body.includes(COMPLEXITY));
});

test('sessions, Jaqueline: holds meetings.read; a CPA session with a Soto client is absent everywhere, her own and Hilo sessions are present', async () => {
  assert.ok((await grants('ed_coo')).includes('meetings.read'), 'the grant is held; the sabotage is that the transcript is still absent');
  const list = await app.inject({ method: 'GET', url: `/contacts/${walled}/meetings`, headers: auth(jackson) });
  assert.equal(list.statusCode, 200, list.body);
  const ids = (list.json() as { meetings: { id: string }[] }).meetings.map((m) => m.id);
  assert.deepEqual(ids, [meetings.own], 'only her own session with this client');
  assert.ok(!list.body.includes(CPA_SUMMARY), 'the CPA summary is not in the list');

  const cpa = await app.inject({ method: 'GET', url: `/meetings/${meetings.cpa}/transcript`, headers: auth(jackson) });
  assert.equal(cpa.statusCode, 404, 'the CPA transcript reads as nonexistent');
  assert.ok(!cpa.body.includes(CPA_TRANSCRIPT));
  assert.equal((await app.inject({ method: 'GET', url: `/meetings/${meetings.cpa}`, headers: auth(jackson) })).statusCode, 404, 'and so does its detail');
  assert.equal((await app.inject({ method: 'GET', url: `/meetings/${meetings.dualCpa}/transcript`, headers: auth(jackson) })).statusCode, 404, 'a CPA session with a client who is ALSO in Hilo stays behind the wall');
  const noAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'transcript.read' AND object_id = $1 AND actor_id = $2`, [meetings.cpa, jackson.id]);
  assert.equal(noAudit.rows.length, 0, 'a refused read is not a read');

  const own = await app.inject({ method: 'GET', url: `/meetings/${meetings.own}/transcript`, headers: auth(jackson) });
  assert.equal(own.statusCode, 200, 'her own session reads');
  const hilo = await app.inject({ method: 'GET', url: `/meetings/${meetings.hilo}/transcript`, headers: auth(jackson) });
  assert.equal(hilo.statusCode, 200, 'a Hilo session recorded by someone else reads');
  const hiloList = await app.inject({ method: 'GET', url: `/contacts/${hiloOnly}/meetings`, headers: auth(jackson) });
  assert.equal((hiloList.json() as { meetings: unknown[] }).meetings.length, 1);

  const queue = await app.inject({ method: 'GET', url: '/recaps', headers: auth(jackson) });
  assert.equal(queue.statusCode, 200, queue.body);
  const qIds = (queue.json() as { recaps?: { meeting_id: string }[]; queue?: { meeting_id: string }[] });
  const rows = (qIds.recaps ?? qIds.queue ?? []) as { meeting_id: string }[];
  assert.ok(rows.some((r) => r.meeting_id === meetings.own), 'her recap is queued for her');
  assert.ok(!rows.some((r) => r.meeting_id === meetings.cpa || r.meeting_id === meetings.dualCpa), 'the CPA recaps are not');
  assert.ok(!queue.body.includes(CPA_SUMMARY));
  const draft = await app.inject({ method: 'POST', url: `/meetings/${meetings.cpa}/recap/draft`, headers: auth(jackson) });
  assert.equal(draft.statusCode, 404, 'drafting a CPA recap reads as no summary');

  const anaList = await app.inject({ method: 'GET', url: `/contacts/${walled}/meetings`, headers: auth(ana) });
  assert.equal((anaList.json() as { meetings: unknown[] }).meetings.length, 2, 'the preparer, inside the wall, sees both');
  assert.equal((await app.inject({ method: 'GET', url: `/meetings/${meetings.cpa}/transcript`, headers: auth(ana) })).statusCode, 200);
  const lauraList = await app.inject({ method: 'GET', url: `/contacts/${walled}/meetings`, headers: auth(laura) });
  assert.equal(lauraList.statusCode, 403, 'Laura holds no session grant at all');
});

test('her dashboard: dashboards.hilo opens it for Jaqueline, and its recent summaries are Hilo sessions only', async () => {
  const res = await app.inject({ method: 'GET', url: '/dashboards/hilo', headers: auth(jackson) });
  assert.equal(res.statusCode, 200, res.body);
  const summaries = (res.json() as { recentSummaries: { summary: string }[] }).recentSummaries.map((s) => s.summary);
  assert.ok(summaries.includes('WALL-HILO-SUMMARY'), 'the Hilo workshop is there');
  assert.ok(summaries.includes('WALL-OWN-SUMMARY'), 'her own session with a Soto client is there: she recorded it');
  assert.ok(!summaries.includes(CPA_SUMMARY) && !summaries.includes('WALL-DUAL-SUMMARY'), 'no CPA session, dual client or not');
  assert.equal((await app.inject({ method: 'GET', url: '/dashboards/hilo', headers: auth(laura) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(jackson) })).statusCode, 403, 'the firm\'s executive view is not hers');
});

test('her events: events.manage lets Jaqueline create, publish and complete a Hilo event', async () => {
  const body = {
    slug: 'wall-workshop', titleEn: 'Synthetic workshop', titleEs: 'Taller sintético',
    descriptionEn: 'A synthetic workshop for the wall spec.', descriptionEs: 'Un taller sintético para la prueba.',
    startsAt: new Date(Date.now() - 3_600_000).toISOString(), capacity: 10, program: 'hilo',
  };
  const created = await app.inject({ method: 'POST', url: '/events', headers: auth(jackson), payload: body });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await app.inject({ method: 'POST', url: '/events/wall-workshop/publish', headers: auth(jackson) })).statusCode, 200);
  const done = await app.inject({ method: 'POST', url: '/events/wall-workshop/complete', headers: auth(jackson) });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await app.inject({ method: 'POST', url: '/events', headers: auth(laura), payload: { ...body, slug: 'wall-workshop-2' } })).statusCode, 403);
});

test('a transcript-seeded SOP draft is the author\'s until published', async () => {
  const sop = await createSop(app, { slug: 'wall-draft-sop', title: 'Synthetic draft SOP', bodyMd: `Steps. ${CPA_TRANSCRIPT}`, seededFromMeetingId: meetings.cpa }, actorOf(brian, 'ceo', ['*']));
  assert.equal(sop.status, 'draft');
  const asJackson = await app.inject({ method: 'GET', url: '/sops/wall-draft-sop', headers: auth(jackson) });
  assert.equal(asJackson.statusCode, 404, 'a draft reads as nonexistent to a non-author');
  assert.ok(!asJackson.body.includes(CPA_TRANSCRIPT));
  assert.equal((await app.inject({ method: 'GET', url: '/sops/wall-draft-sop', headers: auth(brian) })).statusCode, 200);
});
