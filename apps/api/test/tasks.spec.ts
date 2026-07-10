// M25 "Prove it": the unified task system — one entry point, dedupe,
// auto-close, the four staff views, client to-dos with aggregation, checklist
// templates, the Trello importer, and representative module migrations
// (notice ticket, referral approval, enrichment lifecycle). Synthetic only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTask, closeTasksForSource } from '../src/modules/tasks/service.ts';
import { refreshEnrichmentGaps } from '../src/modules/crm/service.ts';
import { importTrelloBoard } from '../src/migration/trello.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let rene: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function clientSession(contactId: string, email: string): Promise<string> {
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return token;
}

before(async () => {
  config = await createTestConfig('tasks');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-tasks@example.test', 'ceo');
  rene = await staffWithToken('rene-tasks@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('createTask dedupes per source; closeTasksForSource is the auto-close hook', async () => {
  const a = await createTask(app, { title: 'Work item', sourceType: 'unit_test', sourceId: 'x1', source: 'system' });
  const b = await createTask(app, { title: 'Work item again', sourceType: 'unit_test', sourceId: 'x1', source: 'system' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id, 'same open work item, never doubled');

  const closed = await closeTasksForSource(app, 'unit_test', 'x1', 'unit');
  assert.equal(closed, 1);
  const c = await createTask(app, { title: 'New cycle', sourceType: 'unit_test', sourceId: 'x1', source: 'system' });
  assert.equal(c.created, true, 'a closed work item can legitimately recur');
});

test('views: My Tasks, owner rollup (approvals), team workload', async () => {
  await createTask(app, { title: 'Mine A', assignedStaffId: brian.id, priority: 2, source: 'manual' });
  await createTask(app, {
    title: 'Approve referral: test', assignedStaffId: brian.id, priority: 1,
    source: 'automation', sourceType: 'referral_approval', sourceId: 'ref-x',
  });

  const mine = await app.inject({ method: 'GET', url: '/tasks/mine', headers: auth(brian) });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.ok(mine.json().tasks.some((t: { title: string }) => t.title === 'Mine A'));

  const rollup = await app.inject({ method: 'GET', url: '/tasks/rollup', headers: auth(brian) });
  assert.equal(rollup.statusCode, 200, rollup.body);
  assert.ok(rollup.json().approvals.some((t: { source_type: string }) => t.source_type === 'referral_approval'));
  assert.equal(typeof rollup.json().stalled, 'number');

  const wl = await app.inject({ method: 'GET', url: '/tasks/workload', headers: auth(rene) });
  assert.equal(wl.statusCode, 200, wl.body);
  const brianRow = wl.json().workload.find((w: { id: string }) => w.id === brian.id);
  assert.ok(brianRow.open >= 2);
});

test('checklist template instantiates per client with items', async () => {
  const tpl = await app.inject({
    method: 'POST', url: '/task-templates', headers: auth(brian),
    payload: { name: 'Onboarding checklist', items: ['Send welcome', 'Collect W-9', 'Book kickoff'], defaultPriority: 1 },
  });
  assert.equal(tpl.statusCode, 201, tpl.body);
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Tmpl', email: 'tmpl@example.test' });
  const inst = await app.inject({
    method: 'POST', url: `/task-templates/${tpl.json().id}/instantiate`, headers: auth(brian),
    payload: { contactId: client.id },
  });
  assert.equal(inst.statusCode, 201, inst.body);
  const items = await app.inject({ method: 'GET', url: `/tasks/${inst.json().taskId}/checklist`, headers: auth(brian) });
  assert.equal(items.json().items.length, 3);
});

test('client to-dos: aggregation (staff task + upload + signature) and client check-off', async () => {
  const carla = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Todos', email: 'todos@example.test' });
  const session = await clientSession(carla.id, 'todos@example.test');

  // Staff-added client-visible to-do ("mark Q2 estimate paid" style).
  const created = await app.inject({
    method: 'POST', url: '/tasks', headers: auth(rene),
    payload: { title: 'Confirm your Q2 estimate payment', contactId: carla.id, clientVisible: true },
  });
  assert.equal(created.statusCode, 201, created.body);
  // Internal task for the same client must NOT surface in the portal.
  await createTask(app, { title: 'Internal note about Todos', contactId: carla.id, source: 'manual' });
  // System items: an open document request item + a pending envelope.
  const req = await app.db.query<{ id: string }>(
    `INSERT INTO document_requests (contact_id, title_en, status) VALUES ($1, 'Docs', 'open') RETURNING id`,
    [carla.id]
  );
  await app.db.query(
    `INSERT INTO document_request_items (request_id, label_en, label_es) VALUES ($1, 'Upload your P&L', 'Suba su P&L')`,
    [req.rows[0]!.id]
  );
  // (engagement_letter: the f8879 DB CHECK rightly refuses 'sent' without a
  // signature_method — that gate has its own tests.)
  await app.db.query(
    `INSERT INTO signature_envelopes (contact_id, type, status) VALUES ($1, 'engagement_letter', 'sent')`,
    [carla.id]
  );

  const todos = await app.inject({
    method: 'GET', url: '/portal/todos', headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(todos.statusCode, 200, todos.body);
  const kinds = todos.json().todos.map((t: { kind: string }) => t.kind).sort();
  assert.deepEqual(kinds, ['signature', 'task', 'upload'], 'one of each source, internal task hidden');

  // Client checks off the staff-added item; system items are not check-off-able.
  const taskTodo = todos.json().todos.find((t: { kind: string }) => t.kind === 'task');
  const done = await app.inject({
    method: 'POST', url: `/portal/todos/${taskTodo.id}/complete`, headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(done.statusCode, 200, done.body);
  const after1 = await app.inject({ method: 'GET', url: '/portal/todos', headers: { authorization: `Bearer ${session}` } });
  assert.equal(after1.json().todos.filter((t: { kind: string }) => t.kind === 'task').length, 0);
});

test('migration representative: IRS notice creates an owned ticket that closes on resolve', async () => {
  await staffWithToken('ana-tasks@example.test', 'tax_preparer').catch(() => null); // handler role present
  const evan = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Notice', email: 'notice-task@example.test' });
  const notice = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(brian),
    payload: { contactId: evan.id, noticeType: 'CP2000', noticeDate: '2026-07-01' },
  });
  assert.equal(notice.statusCode, 201, notice.body);
  const noticeId = notice.json().id as string;

  const ticket = await app.db.query(
    `SELECT id, status, due_date::text AS due_date FROM tasks WHERE source_type = 'irs_notice' AND source_id = $1`,
    [noticeId]
  );
  assert.equal(ticket.rows.length, 1, 'notice = owned ticket-task (v4.3 flow 1)');
  assert.equal(ticket.rows[0].status, 'open');
  assert.ok(ticket.rows[0].due_date, 'ticket carries the response deadline');

  const resolve = await app.inject({
    method: 'PATCH', url: `/irs-notices/${noticeId}`, headers: auth(brian),
    payload: { status: 'resolved', resolutionNotes: 'handled' },
  });
  assert.equal(resolve.statusCode, 200, resolve.body);
  const closed = await app.db.query(`SELECT status FROM tasks WHERE source_type = 'irs_notice' AND source_id = $1`, [noticeId]);
  assert.equal(closed.rows[0].status, 'done', 'resolving the notice closes its ticket');
});

test('migration representative: enrichment gaps live as ONE task that follows the data', async () => {
  const gapId = (await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, soto_status) VALUES ('Synthetic', 'Gappy', 'lead') RETURNING id`
  )).rows[0]!.id;

  await refreshEnrichmentGaps(app.db, gapId);
  const open = await app.db.query<{ id: string; description: string }>(
    `SELECT id, description FROM tasks WHERE contact_id = $1 AND source_type = 'enrichment' AND status = 'open'`,
    [gapId]
  );
  assert.equal(open.rows.length, 1, 'gap task created');
  assert.match(open.rows[0]!.description, /email/);

  // Fill the gaps → the task closes itself (no human bookkeeping).
  await app.db.query(`UPDATE contacts SET email = 'gappy@example.test', phone = '+13125550188' WHERE id = $1`, [gapId]);
  await refreshEnrichmentGaps(app.db, gapId);
  const closed = await app.db.query(`SELECT status FROM tasks WHERE id = $1`, [open.rows[0]!.id]);
  assert.equal(closed.rows[0].status, 'done');
});

test('Trello importer: board → columns → tasks, idempotent rerun', async () => {
  const board = {
    name: 'Synthetic Firm Board',
    lists: [
      { id: 'l1', name: 'To do', closed: false, pos: 1 },
      { id: 'l2', name: 'Done', closed: false, pos: 2 },
      { id: 'l3', name: 'Archived list', closed: true, pos: 3 },
    ],
    cards: [
      { id: 'c1', name: 'Ship the thing', desc: 'details', due: '2026-08-01T12:00:00.000Z', idList: 'l1', closed: false, idMembers: ['m1'] },
      { id: 'c2', name: 'Already finished', idList: 'l2', closed: false },
      { id: 'c3', name: 'Archived card', idList: 'l1', closed: true },
      { id: 'c4', name: 'On archived list', idList: 'l3', closed: false },
    ],
    checklists: [{ idCard: 'c1', checkItems: [{ name: 'step 1', state: 'complete' as const }, { name: 'step 2', state: 'incomplete' as const }] }],
    members: [{ id: 'm1', fullName: 'Synthetic ceo' }], // matches brian's synthetic name
  };
  const r1 = await importTrelloBoard(app, board);
  assert.equal(r1.columns, 2, 'archived lists skipped');
  assert.equal(r1.tasksCreated, 2, 'archived cards + archived-list cards skipped');
  assert.equal(r1.assigneesMatched, 1);
  assert.equal(r1.checklistItems, 2);

  const doneCard = await app.db.query(
    `SELECT status, due_date FROM tasks WHERE source_type = 'trello' AND source_id = 'c2'`
  );
  assert.equal(doneCard.rows[0].status, 'done', 'cards on done-ish lists arrive completed');
  const dated = await app.db.query(`SELECT due_date::text AS d FROM tasks WHERE source_type = 'trello' AND source_id = 'c1'`);
  assert.equal(dated.rows[0].d, '2026-08-01');

  const r2 = await importTrelloBoard(app, board);
  assert.equal(r2.tasksCreated, 0);
  assert.equal(r2.tasksSkipped, 2, 'rerun is a no-op');
});

test('intern scope: tasks.execute changes status only on OWN tasks', async () => {
  const intern = await staffWithToken('intern-tasks@example.test', 'intern');
  const own = await createTask(app, { title: 'Intern job', assignedStaffId: intern.id, source: 'manual' });
  const foreign = await createTask(app, { title: 'Not intern job', assignedStaffId: brian.id, source: 'manual' });

  const ok = await app.inject({
    method: 'PATCH', url: `/tasks/${own.id}/status`, headers: auth(intern), payload: { status: 'done' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const refused = await app.inject({
    method: 'PATCH', url: `/tasks/${foreign.id}/status`, headers: auth(intern), payload: { status: 'done' },
  });
  assert.equal(refused.statusCode, 403);
});
