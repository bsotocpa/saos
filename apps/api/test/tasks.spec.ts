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
import {
  addTaskDependency, advanceDate, backlogCountFor, closeTasksForSource, createTask, myTasks, runLadderJob,
  runTaskReminderSweep, setTaskStatus,
} from '../src/modules/tasks/service.ts';
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
  assert.ok(brianRow.not_started >= 2);
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
  assert.equal(ticket.rows[0].status, 'not_started');
  assert.ok(ticket.rows[0].due_date, 'ticket carries the response deadline');

  const resolve = await app.inject({
    method: 'PATCH', url: `/irs-notices/${noticeId}`, headers: auth(brian),
    payload: { status: 'resolved', resolutionNotes: 'handled' },
  });
  assert.equal(resolve.statusCode, 200, resolve.body);
  const closed = await app.db.query(`SELECT status FROM tasks WHERE source_type = 'irs_notice' AND source_id = $1`, [noticeId]);
  assert.equal(closed.rows[0].status, 'completed', 'resolving the notice closes its ticket');
});

test('migration representative: enrichment gaps live as ONE task that follows the data', async () => {
  const gapId = (await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, soto_status) VALUES ('Synthetic', 'Gappy', 'lead') RETURNING id`
  )).rows[0]!.id;

  await refreshEnrichmentGaps(app, gapId);
  const open = await app.db.query<{ id: string; description: string }>(
    `SELECT id, description FROM tasks WHERE contact_id = $1 AND source_type = 'enrichment' AND status = 'not_started'`,
    [gapId]
  );
  assert.equal(open.rows.length, 1, 'gap task created');
  assert.match(open.rows[0]!.description, /email/);

  // Fill the gaps → the task closes itself (no human bookkeeping).
  await app.db.query(`UPDATE contacts SET email = 'gappy@example.test', phone = '+13125550188' WHERE id = $1`, [gapId]);
  await refreshEnrichmentGaps(app, gapId);
  const closed = await app.db.query(`SELECT status FROM tasks WHERE id = $1`, [open.rows[0]!.id]);
  assert.equal(closed.rows[0].status, 'completed');
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
  assert.equal(doneCard.rows[0].status, 'completed', 'cards on done-ish lists arrive completed');
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
    method: 'PATCH', url: `/tasks/${own.id}/status`, headers: auth(intern), payload: { status: 'completed' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const refused = await app.inject({
    method: 'PATCH', url: `/tasks/${foreign.id}/status`, headers: auth(intern), payload: { status: 'completed' },
  });
  assert.equal(refused.statusCode, 403);
});

// ── v4.5 additions: waiting/ladder, recurrence, reminders, search, views ─────

test('waiting_for_input stamps waiting_since; leaving clears it and resets the rung', async () => {
  const wanda = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Waiting', email: 'waiting@example.test' });
  const t = await createTask(app, { title: 'Need the K-1', contactId: wanda.id, source: 'manual' });

  await setTaskStatus(app, t.id, 'waiting_for_input', brian);
  const armed = await app.db.query(`SELECT waiting_since, ladder_rung FROM tasks WHERE id = $1`, [t.id]);
  assert.ok(armed.rows[0].waiting_since, 'entering waiting arms the ladder clock');

  await app.db.query(`UPDATE tasks SET ladder_rung = 2 WHERE id = $1`, [t.id]); // pretend D7 fired
  await setTaskStatus(app, t.id, 'in_progress', brian);
  const disarmed = await app.db.query(`SELECT waiting_since, ladder_rung FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(disarmed.rows[0].waiting_since, null, 'client responded — clock disarmed');
  assert.equal(disarmed.rows[0].ladder_rung, 0, 'rung resets for the next waiting episode');
});

test('escalation ladder: D3 fires rung 1; a task discovered late fires ONLY the highest rung', async () => {
  const larry = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Ladder', email: 'ladder@example.test' });
  const t = await createTask(app, { title: 'Sign the 8879', contactId: larry.id, source: 'manual', status: 'waiting_for_input' });

  // 4 days waiting on 2030-06-15 → D3 rung.
  await app.db.query(`UPDATE tasks SET waiting_since = timestamp '2030-06-11 12:00' WHERE id = $1`, [t.id]);
  const run1 = await runLadderJob(app, '2030-06-15');
  assert.equal(run1.skipped, false);
  assert.deepEqual(run1.rungs, [1, 0, 0, 0]);
  const afterD3 = await app.db.query(`SELECT ladder_rung FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(afterD3.rows[0].ladder_rung, 1);

  // Same date reruns are a no-op (date guard).
  const rerun = await runLadderJob(app, '2030-06-15');
  assert.equal(rerun.skipped, true);

  // Next day the task is 15 days old → jumps straight to D14 (call task for
  // Rene), skipping D7 — only the highest newly-reached rung fires.
  await app.db.query(`UPDATE tasks SET waiting_since = timestamp '2030-06-01 12:00' WHERE id = $1`, [t.id]);
  const run2 = await runLadderJob(app, '2030-06-16');
  assert.deepEqual(run2.rungs, [0, 0, 1, 0]);
  const call = await app.db.query(
    `SELECT assigned_staff_id FROM tasks WHERE source_type = 'ladder_call' AND source_id = $1`,
    [t.id]
  );
  assert.equal(call.rows.length, 1, 'D14 = a call task, owned');
  assert.equal(call.rows[0].assigned_staff_id, rene.id);

  // D30 → STALLED flag task lands on the owner rollup.
  await app.db.query(`UPDATE tasks SET waiting_since = timestamp '2030-05-10 12:00' WHERE id = $1`, [t.id]);
  const run3 = await runLadderJob(app, '2030-06-17');
  assert.deepEqual(run3.rungs, [0, 0, 0, 1]);
  const rollup = await app.inject({ method: 'GET', url: '/tasks/rollup', headers: auth(brian) });
  assert.ok(rollup.json().stalled >= 1, 'stalled count surfaces on the rollup');
});

test('recurrence: completing a repeating task spawns the next occurrence', async () => {
  assert.equal(advanceDate('2026-01-31', 'monthly', 1), '2026-02-28', 'month-end clamps');
  assert.equal(advanceDate('2026-03-31', 'quarterly', 1), '2026-06-30');
  assert.equal(advanceDate('2026-04-15', 'annually', 1), '2027-04-15');

  const t = await createTask(app, {
    title: 'File ST-1', dueDate: '2026-01-31', recurFreq: 'monthly', source: 'manual', tags: ['sales-tax'],
  });
  await setTaskStatus(app, t.id, 'completed', brian);
  const next = await app.db.query<{ id: string; due_date: string; status: string; tags: string[] }>(
    `SELECT id, due_date::text AS due_date, status, tags FROM tasks WHERE parent_task_id = $1`,
    [t.id]
  );
  assert.equal(next.rows.length, 1, 'next occurrence spawned');
  assert.equal(next.rows[0]!.due_date, '2026-02-28');
  assert.equal(next.rows[0]!.status, 'not_started');
  assert.deepEqual(next.rows[0]!.tags, ['sales-tax']);

  // Completing the completed task again must not double-spawn.
  await setTaskStatus(app, t.id, 'completed', brian);
  const still = await app.db.query(`SELECT count(*)::int AS n FROM tasks WHERE parent_task_id = $1`, [t.id]);
  assert.equal(still.rows[0].n, 1);
});

test('reminder sweep: due reminders notify the assignee exactly once', async () => {
  const t = await createTask(app, {
    title: 'Prep for the noon call', assignedStaffId: brian.id, source: 'manual',
    remindAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const sweep1 = await runTaskReminderSweep(app);
  assert.ok(sweep1.reminded >= 1);
  const note = await app.db.query(
    `SELECT 1 FROM notifications WHERE staff_id = $1 AND type = 'task_reminder' AND related_object_id = $2`,
    [brian.id, t.id]
  );
  assert.equal(note.rows.length, 1);
  const sweep2 = await runTaskReminderSweep(app);
  const again = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'task_reminder' AND related_object_id = $1`,
    [t.id]
  );
  assert.equal(again.rows[0].n, 1, `reminder never repeats (sweep2=${sweep2.reminded})`);
});

test('search: the filter rail combines q, tag, priority, and dual lookups', async () => {
  const searchClient = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Searchee', email: 'searchee@example.test' });
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name) VALUES ('Synthetic Search LLC') RETURNING id`
  );
  await createTask(app, {
    title: 'Quarterly books close', contactId: searchClient.id, businessId: biz.rows[0]!.id,
    priority: 2, tags: ['books', 'q3'], source: 'manual',
  });

  const byTag = await app.inject({ method: 'GET', url: '/tasks/search?tag=q3', headers: auth(brian) });
  assert.equal(byTag.statusCode, 200, byTag.body);
  assert.equal(byTag.json().tasks.length, 1);

  const combined = await app.inject({
    method: 'GET',
    url: `/tasks/search?q=books&priority=2&businessId=${biz.rows[0]!.id}&contactId=${searchClient.id}`,
    headers: auth(brian),
  });
  assert.equal(combined.json().tasks.length, 1);
  assert.equal(combined.json().tasks[0].business_name, 'Synthetic Search LLC');

  const miss = await app.inject({ method: 'GET', url: '/tasks/search?q=books&priority=0', headers: auth(brian) });
  assert.equal(miss.json().tasks.some((x: { title: string }) => x.title === 'Quarterly books close'), false);
});

test('saved views: private stays private, shared is visible, only the owner deletes', async () => {
  const created = await app.inject({
    method: 'POST', url: '/task-views', headers: auth(brian),
    payload: { name: 'My urgent list', viewType: 'list', filters: { priority: [2] }, sort: { field: 'due_date', dir: 'asc' } },
  });
  assert.equal(created.statusCode, 201, created.body);
  const privateId = created.json().id as string;

  const sharedRes = await app.inject({
    method: 'POST', url: '/task-views', headers: auth(brian),
    payload: { name: 'Team waiting board', shared: true, viewType: 'kanban', groupBy: 'status' },
  });
  const sharedId = sharedRes.json().id as string;

  const reneSees = await app.inject({ method: 'GET', url: '/task-views', headers: auth(rene) });
  const names = reneSees.json().views.map((v: { name: string }) => v.name);
  assert.ok(names.includes('Team waiting board'));
  assert.ok(!names.includes('My urgent list'), 'private views stay private');

  const reneDelete = await app.inject({ method: 'DELETE', url: `/task-views/${sharedId}`, headers: auth(rene) });
  assert.equal(reneDelete.statusCode, 404, 'only the owner deletes a view');
  const brianDelete = await app.inject({ method: 'DELETE', url: `/task-views/${privateId}`, headers: auth(brian) });
  assert.equal(brianDelete.statusCode, 200);
});

test('bulk operations: mass status + owner + tags across a selection', async () => {
  const a = await createTask(app, { title: 'Bulk A', source: 'manual' });
  const b = await createTask(app, { title: 'Bulk B', source: 'manual', tags: ['old'] });
  const res = await app.inject({
    method: 'POST', url: '/tasks/bulk', headers: auth(brian),
    payload: { ids: [a.id, b.id], set: { assignedStaffId: rene.id, addTags: ['sweep'], removeTags: ['old'] } },
  });
  assert.equal(res.statusCode, 200, res.body);
  const rows = await app.db.query<{ assigned_staff_id: string; tags: string[] }>(
    `SELECT assigned_staff_id, tags FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY title`,
    [[a.id, b.id]]
  );
  assert.equal(rows.rows[0]!.assigned_staff_id, rene.id);
  assert.deepEqual(rows.rows[1]!.tags, ['sweep'], 'old removed, sweep added');

  const complete = await app.inject({
    method: 'POST', url: '/tasks/bulk', headers: auth(brian),
    payload: { ids: [a.id, b.id], set: { status: 'completed' } },
  });
  assert.equal(complete.json().updated, 2);
  const done = await app.db.query(`SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::uuid[]) AND status = 'completed'`, [[a.id, b.id]]);
  assert.equal(done.rows[0].n, 2);
});

test('duplicate + follow-up + inline PATCH (client-visible arms the ladder clock)', async () => {
  const dup = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Dup', email: 'dup@example.test' });
  const orig = await createTask(app, { title: 'Original work', contactId: dup.id, tags: ['x'], priority: 1, source: 'manual' });

  const d = await app.inject({ method: 'POST', url: `/tasks/${orig.id}/duplicate`, headers: auth(brian), payload: {} });
  assert.equal(d.statusCode, 201, d.body);
  const copy = await app.db.query(`SELECT title, parent_task_id, status FROM tasks WHERE id = $1`, [d.json().id]);
  assert.equal(copy.rows[0].title, 'Original work');
  assert.equal(copy.rows[0].parent_task_id, orig.id);
  assert.equal(copy.rows[0].status, 'not_started');

  const f = await app.inject({ method: 'POST', url: `/tasks/${orig.id}/follow-up`, headers: auth(brian), payload: { dueDate: '2026-08-01' } });
  assert.equal(f.statusCode, 201, f.body);
  const fu = await app.db.query(`SELECT title, due_date::text AS due FROM tasks WHERE id = $1`, [f.json().id]);
  assert.equal(fu.rows[0].title, 'Follow up: Original work');
  assert.equal(fu.rows[0].due, '2026-08-01');

  const patch = await app.inject({
    method: 'PATCH', url: `/tasks/${orig.id}`, headers: auth(brian),
    payload: { dueDate: '2026-09-15', clientVisible: true, tags: ['x', 'y'] },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  const patched = await app.db.query(`SELECT due_date::text AS due, client_visible, waiting_since, tags FROM tasks WHERE id = $1`, [orig.id]);
  assert.equal(patched.rows[0].due, '2026-09-15');
  assert.ok(patched.rows[0].waiting_since, 'becoming client-visible arms the ladder clock');
  assert.deepEqual(patched.rows[0].tags, ['x', 'y']);
});

// ── v4.6: task dependencies ("blocked by") ───────────────────────────────────

test('dependencies: blocked tasks cannot complete; completing the blocker cascades unblock notification', async () => {
  const books = await createTask(app, { title: 'Reconstruct 2021 books', assignedStaffId: rene.id, source: 'manual' });
  const ret = await createTask(app, { title: 'Prepare 2021 return', assignedStaffId: brian.id, source: 'manual' });
  await addTaskDependency(app, ret.id, books.id, brian);

  // Blocked task shows up as blocked in search…
  const search = await app.inject({ method: 'GET', url: '/tasks/search?q=Prepare%202021', headers: auth(brian) });
  assert.equal(search.json().tasks[0].open_blockers, 1);

  // …and refuses to complete, via service AND route.
  await assert.rejects(() => setTaskStatus(app, ret.id, 'completed', brian), (e: { code?: string }) => e.code === 'task_blocked');
  const viaRoute = await app.inject({
    method: 'PATCH', url: `/tasks/${ret.id}/status`, headers: auth(brian), payload: { status: 'completed' },
  });
  assert.equal(viaRoute.statusCode, 409, viaRoute.body);

  // Non-terminal moves stay allowed while blocked.
  await setTaskStatus(app, ret.id, 'in_progress', brian);

  // Blocker completes → assignee of the unblocked task is notified once.
  await setTaskStatus(app, books.id, 'completed', brian);
  const note = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE staff_id = $1 AND type = 'task_unblocked' AND related_object_id = $2`,
    [brian.id, ret.id]
  );
  assert.equal(note.rows[0].n, 1, 'unblock notification cascaded to the assignee');

  // Now it completes fine.
  await setTaskStatus(app, ret.id, 'completed', brian);
});

test('dependencies: no self-blocks, no cycles, no terminal blockers; multi-blocker waits for the LAST one', async () => {
  const a = await createTask(app, { title: 'Dep A', assignedStaffId: brian.id, source: 'manual' });
  const b = await createTask(app, { title: 'Dep B', source: 'manual' });
  const c = await createTask(app, { title: 'Dep C', assignedStaffId: brian.id, source: 'manual' });

  await assert.rejects(() => addTaskDependency(app, a.id, a.id, brian), (e: { code?: string }) => e.code === 'self_dependency');

  // a blocked by b, b blocked by c → adding c blocked by a closes a loop.
  await addTaskDependency(app, a.id, b.id, brian);
  await addTaskDependency(app, b.id, c.id, brian);
  await assert.rejects(() => addTaskDependency(app, c.id, a.id, brian), (e: { code?: string }) => e.code === 'dependency_cycle');

  // Terminal blockers are meaningless — refused.
  const done = await createTask(app, { title: 'Dep done', source: 'manual' });
  await setTaskStatus(app, done.id, 'completed', brian);
  await assert.rejects(() => addTaskDependency(app, a.id, done.id, brian), (e: { code?: string }) => e.code === 'blocker_terminal');

  // Two blockers: completing only one does NOT unblock (no notification yet).
  const two = await createTask(app, { title: 'Dep two-blockers', assignedStaffId: brian.id, source: 'manual' });
  const b1 = await createTask(app, { title: 'Dep blocker 1', source: 'manual' });
  const b2 = await createTask(app, { title: 'Dep blocker 2', source: 'manual' });
  await addTaskDependency(app, two.id, b1.id, brian);
  await addTaskDependency(app, two.id, b2.id, brian);
  await setTaskStatus(app, b1.id, 'completed', brian);
  const early = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'task_unblocked' AND related_object_id = $1`, [two.id]
  );
  assert.equal(early.rows[0].n, 0, 'still one open blocker — not unblocked');
  await assert.rejects(() => setTaskStatus(app, two.id, 'completed', brian), (e: { code?: string }) => e.code === 'task_blocked');
  // CANCELLING the last blocker also unblocks (abandoned work stops blocking).
  await setTaskStatus(app, b2.id, 'cancelled', brian);
  const after2 = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'task_unblocked' AND related_object_id = $1`, [two.id]
  );
  assert.equal(after2.rows[0].n, 1);
  await setTaskStatus(app, two.id, 'completed', brian);

  // Bulk mass-complete SKIPS blocked tasks and reports the count.
  const free = await createTask(app, { title: 'Dep free', source: 'manual' });
  const res = await app.inject({
    method: 'POST', url: '/tasks/bulk', headers: auth(brian),
    payload: { ids: [b.id, free.id], set: { status: 'completed' } }, // b is blocked by c
  });
  assert.equal(res.json().blocked, 1);
  assert.equal(res.json().updated, 1);
});

/*
 * MIGRATION BACKLOG (Brian, 2026-08-14). The July import raised 611 `enrichment` tasks —
 * "this contact is missing a phone number" — against 9 from everything the business
 * actually does. My Tasks was 98.5% backlog, which is the same as having no task list:
 * the nine a client was waiting on were unfindable.
 *
 * His ruling was about the SHAPE, not the cleanup: "don't bulk-close — separate filtered
 * view, excluded from My Tasks by default. That's migration backlog to triage
 * deliberately later, not noise to delete." So these prove both halves — out of the way,
 * and still there.
 */
test('backlog: enrichment is excluded from My Tasks, and the count says how much', async () => {
  // Deltas, not absolutes: other tests in this file create enrichment rows too, so a
  // fixed count would pass or fail on execution order rather than on the behaviour.
  const beforeCount = (await myTasks(app, brian.id, false)).length;
  const beforeBacklog = await backlogCountFor(app, brian.id);
  const beforeAll = (await myTasks(app, brian.id, false, { includeBacklog: true })).length;

  await createTask(app, {
    title: 'Missing phone number', sourceType: 'enrichment', sourceId: `enr-${brian.id}-1`,
    source: 'system', assignedStaffId: brian.id,
  });
  await createTask(app, {
    title: 'Missing EIN', sourceType: 'enrichment', sourceId: `enr-${brian.id}-2`,
    source: 'system', assignedStaffId: brian.id,
  });
  await createTask(app, {
    title: 'Call the client back', sourceType: 'unit_test_real', sourceId: `real-${brian.id}`,
    source: 'system', assignedStaffId: brian.id,
  });

  const after = await myTasks(app, brian.id, false);
  assert.equal(after.length, beforeCount + 1, 'only the real task joined the list');
  assert.ok(
    after.every((t: { source_type: string | null }) => t.source_type !== 'enrichment'),
    'no enrichment row is in My Tasks'
  );

  // NOT deleted, NOT closed — just out of the way, and counted.
  assert.equal(await backlogCountFor(app, brian.id), beforeBacklog + 2, 'the backlog reports its own size');

  const withBacklog = await myTasks(app, brian.id, false, { includeBacklog: true });
  assert.equal(withBacklog.length, beforeAll + 3, 'and opting in shows them again');
});

test('backlog: the route ships the hidden count with the list, and the filtered view finds them', async () => {
  const mine = await app.inject({
    method: 'GET', url: '/tasks/mine', headers: { authorization: `Bearer ${brian.token}` },
  });
  assert.equal(mine.statusCode, 200, mine.body);
  assert.ok(mine.json().backlogHidden >= 2, 'the list says what it is holding back');
  assert.ok(
    (mine.json().tasks as Array<{ source_type: string | null }>).every((t) => t.source_type !== 'enrichment'),
    'while keeping them out of the list itself'
  );

  // The separate filtered view — one query away, which is the whole point of not deleting.
  const view = await app.inject({
    method: 'GET', url: '/tasks/search?sourceType=enrichment&limit=2000',
    headers: { authorization: `Bearer ${brian.token}` },
  });
  assert.equal(view.statusCode, 200, view.body);
  const rows = view.json().tasks as Array<{ source_type: string; status: string }>;
  assert.ok(rows.length >= 2, 'the backlog is still there to triage');
  assert.ok(rows.every((t) => t.source_type === 'enrichment'), 'and the view is exactly that source');
  assert.ok(rows.every((t) => t.status !== 'cancelled'), 'nothing was bulk-closed to achieve this');

  // The exclusion is a REAL filter on search, not a hidden rule.
  const excluded = await app.inject({
    method: 'GET', url: '/tasks/search?excludeSourceType=enrichment&limit=2000',
    headers: { authorization: `Bearer ${brian.token}` },
  });
  assert.ok(
    (excluded.json().tasks as Array<{ source_type: string | null }>).every((t) => t.source_type !== 'enrichment'),
    'excludeSourceType removes exactly that source'
  );
});
