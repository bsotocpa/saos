/*
 * THE ADDED-SCHEDULE NOTICE (2026-09-12, Brian's build ruling after the Schedule C proof run).
 *
 * A client with a signed Master gets a service added; its schedule waits in the portal. This
 * proves: the outbox row is queued by the engagement creation; the drain HOLDS it while the
 * schedule_added_notice automation is off, counted and audited, and nothing leaves; armed, the
 * email goes, in the client's language, with the deep link to Sign; a client whose Master is not
 * signed gets no notice (the packet owns that conversation). Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { drainOutbox } from '../src/outbox.ts';
import { readFileSync } from 'node:fs';
import { AUTOMATION_KEYS } from '../src/automations.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff;
let actor: AuthedStaff;
const sent: MailMessage[] = [];
const mailer: Mailer = { transport: 'console', async send(msg) { sent.push(msg); return { id: `m${sent.length}` }; } };

async function signedMaster(contactId: string): Promise<void> {
  // The Master signed with Schedule A, as a real signature records it (master-schedules.spec covers the path).
  const packet = await app.db.query<{ id: string }>(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY['A']::text[], 'signed', now(), 'portal_esign') RETURNING id`,
    [contactId]
  );
  await app.db.query(
    `INSERT INTO schedule_acceptances (contact_id, schedule_code, via, packet_id, template_version) VALUES ($1, 'A', 'master_signature', $2, 1)`,
    [contactId, packet.rows[0]!.id]
  );
}
const pendingRows = async (contactId: string) => (await app.db.query<{ status: string; payload: { scheduleCodes: string[] } }>(
  `SELECT status::text AS status, payload FROM outbox WHERE effect = 'schedule.added_notice' AND object_id = $1 ORDER BY created_at`, [contactId])).rows;

before(async () => {
  config = await createTestConfig('schednotice');
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await makeStaff(app.db, config, { email: 'brian-sched@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678' });
  actor = { id: brian.id, email: brian.email, fullName: brian.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 'spec' };
  // The test bootstrap arms every automation (helpers.ts); this suite is about the gate, so it starts OFF, as shipped.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'schedule_added_notice'`);
});
after(async () => { await app.close(); });

test('registered and OFF: the automation row ships disabled and the template is final, bilingual, and links to Sign', async () => {
  const auto = await app.db.query(`SELECT 1 FROM automations WHERE key = 'schedule_added_notice'`);
  assert.equal(auto.rows.length, 1, 'registered in the table');
  assert.ok(AUTOMATION_KEYS.includes('schedule_added_notice'), 'registered in code');
  const seed = readFileSync(new URL('../../../packages/db/seeds/data/automations.mjs', import.meta.url), 'utf8');
  assert.match(seed, /key: 'schedule_added_notice'/, 'the seed registers it (the seeder inserts enabled=false for every entry; automations.spec proves that)');
  const t = await app.db.query<{ is_placeholder: boolean; body_en: string; body_es: string; subject_en: string }>(
    `SELECT is_placeholder, body_en, body_es, subject_en FROM templates WHERE key = 'schedule_added'`);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0]!.is_placeholder, false);
  assert.equal(t.rows[0]!.subject_en, 'One more thing to agree to');
  assert.match(t.rows[0]!.body_en, /\{\{sign_link\}\}/);
  assert.match(t.rows[0]!.body_es, /\{\{sign_link\}\}/);
});

test('a service added after the Master: queued → held while off, counted and audited, nothing sent', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Added', email: 'added-sched@example.test' });
  await signedMaster(c.id);
  await createEngagement(app, actor, { contactId: c.id, serviceLine: 'bookkeeping', status: 'active', title: 'Books' }, {});

  const queued = await pendingRows(c.id);
  assert.equal(queued.length, 1, 'one outbox row');
  assert.equal(queued[0]!.status, 'pending');
  assert.deepEqual(queued[0]!.payload.scheduleCodes, ['C']);

  // A second added service before the drain does not make a second row: the email lists what is pending at send time.
  await createEngagement(app, actor, { contactId: c.id, serviceLine: 'advisory', status: 'active', title: 'Advisory' }, {});
  assert.equal((await pendingRows(c.id)).length, 1, 'still one pending row');

  const before = sent.length;
  const drained = await drainOutbox(app);
  assert.equal(drained.suppressed, 1, 'held by the gate, counted as a decision');
  assert.equal(drained.sent, 0);
  assert.equal(sent.length, before, 'nothing left the building');
  const audit = await app.db.query<{ details: { schedules: string[] } }>(
    `SELECT details FROM audit_log WHERE action = 'schedule.notice_suppressed' AND contact_id = $1`, [c.id]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(audit.rows[0]!.details.schedules.sort(), ['C', 'D'], 'the suppression names what would have gone out');
  assert.equal((await app.db.query(`SELECT 1 FROM outbox WHERE object_id = $1 AND status = 'pending'`, [c.id])).rows.length, 0, 'the held row is retired, not retried');
});

test('armed: the email leaves in the client\'s language with the deep link, and the send is audited', async () => {
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'schedule_added_notice'`);
  try {
    const c = await makeContact(app.db, { firstName: 'Sintética', lastName: 'Armada', email: 'armada-sched@example.test', language: 'es' });
    await signedMaster(c.id);
    await createEngagement(app, actor, { contactId: c.id, serviceLine: 'entity', status: 'active', title: 'Formation' }, {});
    const before = sent.length;
    const drained = await drainOutbox(app);
    assert.equal(drained.sent, 1, drained.toString());
    const msg = sent[before]!;
    assert.equal(msg.to, 'armada-sched@example.test');
    assert.equal(msg.subject, 'Un punto más por aceptar');
    assert.match(msg.text ?? '', /Schedule E — Entity Formation/);
    assert.match(msg.text ?? '', new RegExp(`${config.PORTAL_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sign`));
    assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'schedule.notice_sent' AND contact_id = $1`, [c.id])).rows.length, 1);
  } finally {
    await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'schedule_added_notice'`);
  }
});

test('no Master yet: a first engagement queues nothing; the packet owns that conversation', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Unsigned', email: 'unsigned-sched@example.test' });
  await createEngagement(app, actor, { contactId: c.id, serviceLine: 'bookkeeping', status: 'active', title: 'Books' }, {});
  assert.equal((await pendingRows(c.id)).length, 0);
});
