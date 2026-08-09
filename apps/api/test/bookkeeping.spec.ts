// M26 flow 5 "Prove it": the books close cycle. Ordered checklist, statements
// AUTO-POSTING to the portal on close (no review gate), and the calendar
// cross-check both ways — an existing upcoming session means statements
// ATTACH and NO scheduling task is created; only a client with no session on
// the calendar gets one (CLAUDE.md: never create a session-scheduling task
// without checking first). Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let marian: TestStaff & { token: string };
let brian: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) { sentMail.push(msg); return { id: `captured-${sentMail.length}` }; },
};
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function makeClient(last: string, email: string): Promise<{ contactId: string; portalToken: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', $1, $2, 'active') RETURNING id`,
    [last, email]
  );
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contact.rows[0]!.id, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return { contactId: contact.rows[0]!.id, portalToken: token };
}

async function newCycle(contactId: string, periodStart: string, periodEnd: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/close-cycles', headers: auth(marian),
    payload: { contactId, cadence: 'monthly', periodStart, periodEnd },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function closeWithStatements(cycleId: string, asOf: string) {
  const body = multipartBody(
    { asOf },
    {
      field: 'file', filename: 'statements.pdf', contentType: 'application/pdf',
      data: Buffer.from('%PDF-1.4 synthetic statements'),
    }
  );
  return app.inject({
    method: 'POST', url: `/close-cycles/${cycleId}/close`,
    headers: { ...auth(marian), ...body.headers },
    payload: body.payload,
  });
}

before(async () => {
  config = await createTestConfig('books');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  marian = await staffWithToken('marian-books@example.test', 'bookkeeper');
  brian = await staffWithToken('brian-books@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('close checklist is ordered: no skipping ahead, no closing early', async () => {
  const ada = await makeClient('Booksada', 'books-ada@example.test');
  const cycle = await newCycle(ada.contactId, '2026-07-01', '2026-07-31');

  // The close itself is a task on Marian's list (every work item is a task).
  const task = await app.db.query<{ assigned_staff_id: string }>(
    `SELECT assigned_staff_id FROM tasks WHERE source_type = 'close_cycle' AND source_id = $1`,
    [cycle]
  );
  assert.equal(task.rows.length, 1);
  assert.equal(task.rows[0]!.assigned_staff_id, marian.id);

  // Reconciled before categorized → refused.
  const outOfOrder = await app.inject({
    method: 'POST', url: `/close-cycles/${cycle}/steps/reconciled`, headers: auth(marian),
  });
  assert.equal(outOfOrder.statusCode, 409, outOfOrder.body);
  assert.equal(outOfOrder.json().error, 'step_out_of_order');

  // Closing before the checklist is done → refused.
  const early = await closeWithStatements(cycle, '2026-08-05');
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'checklist_incomplete');

  for (const step of ['categorized', 'reconciled', 'statements_ready']) {
    const res = await app.inject({
      method: 'POST', url: `/close-cycles/${cycle}/steps/${step}`, headers: auth(marian),
    });
    assert.equal(res.statusCode, 200, res.body);
  }
});

test('close with an EXISTING upcoming session: statements post to the portal and ATTACH — no scheduling task', async () => {
  const bo = await makeClient('Booksbo', 'books-bo@example.test');
  const cycle = await newCycle(bo.contactId, '2026-08-01', '2026-08-31');
  for (const step of ['categorized', 'reconciled', 'statements_ready']) {
    await app.inject({ method: 'POST', url: `/close-cycles/${cycle}/steps/${step}`, headers: auth(marian) });
  }

  // A recurring session already on the calendar (the common case).
  const session = await app.inject({
    method: 'POST', url: '/client-sessions', headers: auth(marian),
    payload: {
      contactId: bo.contactId, startsAt: '2026-09-20T15:00:00Z',
      eventType: 'monthly-books-review', externalRef: 'cal-books-bo-1', isRecurring: true,
    },
  });
  assert.equal(session.statusCode, 201, session.body);

  const closed = await closeWithStatements(cycle, '2026-09-05');
  assert.equal(closed.statusCode, 201, closed.body);
  assert.equal(closed.json().attachedSessionId, session.json().id, 'statements attached to the existing session');
  assert.equal(closed.json().schedulingTaskCreated, false, 'NO task — never double-book');

  const noTask = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'close_session_scheduling' AND source_id = $1`,
    [cycle]
  );
  assert.equal(noTask.rows[0]!.n, 0);

  // Statements AUTO-POSTED to the portal — visible to the client immediately,
  // no owner review gate.
  const docs = await app.inject({
    method: 'GET', url: '/portal/documents', headers: { authorization: `Bearer ${bo.portalToken}` },
  });
  assert.equal(docs.statusCode, 200, docs.body);
  const statement = docs.json().documents.find((d: { category: string }) => d.category === 'financial_statements');
  assert.ok(statement, 'client can see the statements the moment the books close');
  assert.equal(statement.id, closed.json().documentId);

  const notice = sentMail.find((m) => m.to === 'books-bo@example.test');
  assert.ok(notice, 'client told the statements are ready');
  assert.match(notice!.subject, /statements are ready/i);

  // The close work item closed itself.
  const closeTask = await app.db.query<{ status: string }>(
    `SELECT status FROM tasks WHERE source_type = 'close_cycle' AND source_id = $1`,
    [cycle]
  );
  assert.equal(closeTask.rows[0]!.status, 'completed');

  // Re-closing is refused.
  const again = await closeWithStatements(cycle, '2026-09-06');
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_closed');
});

test('close with NO session on the calendar: a scheduling task IS created (first review / cleanup client)', async () => {
  const cy = await makeClient('Bookscy', 'books-cy@example.test');
  const cycle = await newCycle(cy.contactId, '2026-08-01', '2026-08-31');
  for (const step of ['categorized', 'reconciled', 'statements_ready']) {
    await app.inject({ method: 'POST', url: `/close-cycles/${cycle}/steps/${step}`, headers: auth(marian) });
  }

  const closed = await closeWithStatements(cycle, '2026-09-05');
  assert.equal(closed.statusCode, 201, closed.body);
  assert.equal(closed.json().attachedSessionId, null);
  assert.equal(closed.json().schedulingTaskCreated, true);
  const task = await app.db.query<{ assigned_staff_id: string; priority: number }>(
    `SELECT assigned_staff_id, priority FROM tasks WHERE source_type = 'close_session_scheduling' AND source_id = $1`,
    [cycle]
  );
  assert.equal(task.rows.length, 1, 'a task only when the calendar is genuinely empty');
  assert.equal(task.rows[0]!.assigned_staff_id, marian.id);

  // A session in the PAST does not count as an upcoming session.
  const dee = await makeClient('Booksdee', 'books-dee@example.test');
  const cycle2 = await newCycle(dee.contactId, '2026-08-01', '2026-08-31');
  for (const step of ['categorized', 'reconciled', 'statements_ready']) {
    await app.inject({ method: 'POST', url: `/close-cycles/${cycle2}/steps/${step}`, headers: auth(marian) });
  }
  await app.inject({
    method: 'POST', url: '/client-sessions', headers: auth(marian),
    payload: { contactId: dee.contactId, startsAt: '2026-07-10T15:00:00Z', externalRef: 'cal-books-dee-past' },
  });
  const closed2 = await closeWithStatements(cycle2, '2026-09-05');
  assert.equal(closed2.json().attachedSessionId, null, 'a past session is not an upcoming session');
  assert.equal(closed2.json().schedulingTaskCreated, true);
});

test('workbench lists open cycles with checklist state and the next session; closed ones drop off', async () => {
  const eli = await makeClient('Bookseli', 'books-eli@example.test');
  const cycle = await newCycle(eli.contactId, '2026-09-01', '2026-09-30');
  await app.inject({ method: 'POST', url: `/close-cycles/${cycle}/steps/categorized`, headers: auth(marian) });
  await app.inject({
    method: 'POST', url: '/client-sessions', headers: auth(marian),
    payload: { contactId: eli.contactId, startsAt: '2099-01-15T15:00:00Z', externalRef: 'cal-books-eli-1', isRecurring: true },
  });

  const board = await app.inject({ method: 'GET', url: '/close-cycles?mine=true', headers: auth(marian) });
  assert.equal(board.statusCode, 200, board.body);
  const row = board.json().cycles.find((c: { id: string }) => c.id === cycle);
  assert.ok(row, 'open cycle on the workbench');
  assert.ok(row.categorized_at, 'checklist state visible');
  assert.equal(row.reconciled_at, null);
  assert.ok(row.next_session_at, 'the workbench shows whether a session is already booked');

  // Leadership sees the whole board; a cycle drops off once closed.
  const all = await app.inject({ method: 'GET', url: '/close-cycles', headers: auth(brian) });
  assert.ok(all.json().cycles.some((c: { id: string }) => c.id === cycle));
  for (const step of ['reconciled', 'statements_ready']) {
    await app.inject({ method: 'POST', url: `/close-cycles/${cycle}/steps/${step}`, headers: auth(marian) });
  }
  await closeWithStatements(cycle, '2026-10-05');
  const after = await app.inject({ method: 'GET', url: '/close-cycles', headers: auth(brian) });
  assert.equal(after.json().cycles.some((c: { id: string }) => c.id === cycle), false, 'closed cycles leave the board');
});
