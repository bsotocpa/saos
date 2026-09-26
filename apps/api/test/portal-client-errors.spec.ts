/*
 * THE PORTAL'S ERROR REPORT DOOR (R49, Brian, 2026-09-26): POST /portal/client-errors.
 *
 * The portal's error boundary posts the route and the browser's message when a page throws. The
 * door opens one task per route (deduped while open), raises one Ops alert pointing at it, writes
 * an audit row, masks anything shaped like an address or a run of digits, refuses without a
 * session, and stops taking reports from one session after five in ten minutes. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { generateToken } from '../src/crypto.ts';
import { PORTAL_SESSION_COOKIE } from '../src/cookies.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;

async function makeClient(last: string, email: string): Promise<{ contactId: string; portalUserId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status) VALUES ('Synthetic', $1, $2, 'en', 'active') RETURNING id`,
    [last, email]
  );
  const contactId = contact.rows[0]!.id;
  const user = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [contactId, email]);
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return { contactId, portalUserId: user.rows[0]!.id, token };
}

interface Answer { statusCode: number; body: string; json: () => unknown }
const report = async (token: string | null, body: unknown): Promise<Answer> => {
  const cookies = token ? { [PORTAL_SESSION_COOKIE]: token } : {};
  return app.inject({ method: 'POST', url: '/portal/client-errors', payload: body as Record<string, unknown>, cookies });
};

async function tasksFor(route: string): Promise<Array<{ id: string; title: string; description: string; assigned_staff_id: string | null; contact_id: string | null; status: string }>> {
  const { rows } = await app.db.query(
    `SELECT id, title, description, assigned_staff_id, contact_id, status::text AS status FROM tasks WHERE source_type = 'portal_page_error' AND source_id = $1 ORDER BY created_at`,
    [route]
  );
  return rows;
}

before(async () => {
  config = await createTestConfig('r49_client_errors');
  app = buildServer(config);
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'ceo-r49@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-123456', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
});
after(async () => { await app.close(); });

test('no session, no report: 401', async () => {
  const res = await report(null, { route: '/documents', message: 'TypeError: x' });
  assert.equal(res.statusCode, 401, res.body);
});

test('a report without a message is refused with the field named, and nothing is opened', async () => {
  const c = await makeClient('Novalid', 'r49-novalid@example.test');
  const res = await report(c.token, { route: '/documents' });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.body, /message/);
  assert.equal((await tasksFor('/documents')).length, 0);
});

test('one report opens one task for the CEO, one alert pointing at it, and an audit row; a second on the same route opens nothing new', async () => {
  const c = await makeClient('Reporter', 'r49-reporter@example.test');
  const first = await report(c.token, { route: '/documents?token=abc123', message: "TypeError: Cannot read properties of undefined (reading '0')", digest: '1234567890' });
  assert.equal(first.statusCode, 202, first.body);
  const body = first.json() as { taskId: string; created: boolean };
  assert.equal(body.created, true);

  const tasks = await tasksFor('/documents');
  assert.equal(tasks.length, 1, 'one task, keyed on the route without its query string');
  assert.equal(tasks[0]!.id, body.taskId);
  assert.equal(tasks[0]!.assigned_staff_id, ceo.id, 'assigned to the CEO');
  assert.equal(tasks[0]!.contact_id, c.contactId, 'the client whose browser reported it');
  assert.match(tasks[0]!.title, /\/documents/);
  assert.match(tasks[0]!.description, /Cannot read properties of undefined \(reading '0'\)/);
  assert.doesNotMatch(tasks[0]!.description, /abc123/, 'the query string never reaches the task');
  assert.match(tasks[0]!.description, /Reference: <digits>/, 'a digest that is a run of digits is masked like any other');

  const alerts = await app.db.query<{ staff_id: string; related_object_id: string; severity: string }>(
    `SELECT staff_id, related_object_id, severity FROM notifications WHERE type = 'portal_page_error'`
  );
  assert.equal(alerts.rows.length, 1, 'one alert');
  assert.equal(alerts.rows[0]!.staff_id, ceo.id);
  assert.equal(alerts.rows[0]!.related_object_id, body.taskId, 'the alert points at the task');
  assert.equal(alerts.rows[0]!.severity, 'warning');

  const audits = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'portal.client_error' AND object_id = $1 AND actor_type = 'client'`, [body.taskId]
  );
  assert.equal(audits.rows[0]!.n, 1, 'one audit row, the client as actor');

  // The same route from another client while the task is open: the same task, no second alert.
  const other = await makeClient('Second', 'r49-second@example.test');
  const again = await report(other.token, { route: '/documents', message: 'TypeError: something else on the same page' });
  assert.equal(again.statusCode, 202, again.body);
  assert.equal((again.json() as { created: boolean }).created, false);
  assert.equal((await tasksFor('/documents')).length, 1, 'still one open task for the route');
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'portal_page_error'`)).rows[0]!.n, 1, 'still one alert');

  // A different route is a different defect.
  const elsewhere = await report(other.token, { route: '/returns', message: 'TypeError: elsewhere' });
  assert.equal(elsewhere.statusCode, 202, elsewhere.body);
  assert.equal((elsewhere.json() as { created: boolean }).created, true);
  assert.equal((await tasksFor('/returns')).length, 1);
});

test('an address or a long run of digits in the message is masked before it is written anywhere', async () => {
  const c = await makeClient('Masked', 'r49-masked@example.test');
  const res = await report(c.token, { route: '/profile', message: 'Error: could not save someone@example.test with 123456789 on file' });
  assert.equal(res.statusCode, 202, res.body);
  const [task] = await tasksFor('/profile');
  assert.ok(task);
  assert.doesNotMatch(task.description, /someone@example\.test/);
  assert.doesNotMatch(task.description, /123456789/);
  assert.match(task.description, /<address>/);
  assert.match(task.description, /<digits>/);
  const audit = await app.db.query<{ details: { message: string } }>(
    `SELECT details FROM audit_log WHERE action = 'portal.client_error' AND object_id = $1`, [task.id]
  );
  assert.doesNotMatch(audit.rows[0]!.details.message, /someone@|123456789/);
});

test('the sixth report from one session in ten minutes is refused with 429; the first five were recorded', async () => {
  const c = await makeClient('Flood', 'r49-flood@example.test');
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await report(c.token, { route: `/flood-${i}`, message: `Error: attempt ${i}` });
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
  const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE source_type = 'portal_page_error' AND source_id LIKE '/flood-%'`);
  assert.equal(rows[0]!.n, 5);
});
