// FINDING #17 — acceptance must always produce visible consequence.
//
// Brian accepted a quote and nothing happened. The engagement row was created; the
// task and the alert were both inside `if (rene)`, and `comms_billing` is a role
// nobody holds. So the test that matters is not "does acceptance work" — it did — but
// "does acceptance still produce something a human can SEE when the intended owner
// does not exist". That is the first test below, and it fails against the old code.
//
// The second half is his send-time gate: a quote whose schedules the client has
// already accepted must refuse to send until the sender says whether this is extra
// work or a duplicate, and the answer must be recorded rather than clicked through.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import { createQuote, sendQuote, acceptQuote, quoteByToken } from '../src/modules/pricing/quotes.ts';
import { schedulesImpliedByQuote, coveredSchedules } from '../src/modules/pricing/quote-coverage.ts';
import { AppError } from '../src/types.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** The system actor shape sendQuote expects. */
function staffActor(id: string) {
  return {
    id,
    email: 'system@saos',
    fullName: 'SAOS',
    roleKey: 'ceo' as const,
    permissions: ['*'],
    sessionId: 'test',
  };
}

let cachedCeo = '';
/** The one staff account, created on demand — a fresh test DB seeds roles, not people. */
async function ceoId(): Promise<string> {
  if (cachedCeo) return cachedCeo;
  const staff = await makeStaff(app.db, config, {
    email: 'ceo-consequence@example.test',
    name: 'Synthetic CEO',
    role: 'ceo',
    password: 'ceo-password-123456',
  });
  cachedCeo = staff.id;
  return cachedCeo;
}

/** An individual-tax line, so the quote implies Schedule A. */
async function taxItemCode(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line::text = 'individual_tax' AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  assert.ok(rows[0], 'the seeded price book has an active quotable tax item');
  return rows[0]!.item_code;
}

before(async () => {
  config = await createTestConfig('quoteconseq');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('THE BUG: acceptance produces a visible task even when NOBODY holds the routing role', async () => {
  // Production has exactly one staff account (ceo). comms_billing — the role the
  // acceptance task routes to — has nobody. Prove that first, or the test proves
  // nothing.
  const routing = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff st JOIN roles r ON r.id = st.role_id
      WHERE r.key = 'comms_billing' AND st.is_active`
  );
  assert.equal(routing.rows[0]!.n, 0, 'no comms_billing staff — the condition that made this silent');

  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Consequence',
    email: 'consequence@example.test',
  });
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] },
    staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const token = sent.url.split('/').pop()!;

  const result = await acceptQuote(app, token, {});
  assert.ok(result.engagementId, 'an engagement was created (this part always worked)');

  // The part that did not work: something Brian can SEE.
  const tasks = await app.db.query<{ id: string; title: string; assigned_staff_id: string | null }>(
    `SELECT id, title, assigned_staff_id FROM tasks
      WHERE source_type = 'quote_accepted' AND source_id = $1`,
    [quote.id]
  );
  assert.equal(tasks.rowCount, 1, 'acceptance produced exactly one onboarding task');
  assert.match(tasks.rows[0]!.title, /Synthetic Consequence/, 'and it names the client');

  // It fell back to the CEO rather than being dropped or left ownerless.
  assert.equal(
    tasks.rows[0]!.assigned_staff_id,
    await ceoId(),
    'unrouted work lands on Brian rather than vanishing'
  );
});

test('the acceptance task names the schedule the quote covers', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'ScheduleNamed',
    email: 'schednamed@example.test',
  });
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] },
    staffActor(await ceoId())
  );

  const implied = await schedulesImpliedByQuote(app, quote.id);
  assert.ok(implied.includes('A'), `a tax line implies Schedule A (got ${JSON.stringify(implied)})`);

  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  await acceptQuote(app, sent.url.split('/').pop()!, {});

  const task = await app.db.query<{ description: string }>(
    `SELECT description FROM tasks WHERE source_type = 'quote_accepted' AND source_id = $1`,
    [quote.id]
  );
  assert.match(
    task.rows[0]!.description,
    /Schedule A/,
    'the task says which schedule, so it is actionable without opening the quote'
  );
});

test('SEND is blocked when the client already accepted that schedule', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'AlreadyCovered',
    email: 'alreadycovered@example.test',
  });

  // Simulate the state Brian was in: Schedule A already accepted.
  await app.db.query(
    `INSERT INTO schedule_acceptances (contact_id, schedule_code, via, template_version)
     VALUES ($1, 'A', 'portal_acceptance', 3)`,
    [c.id]
  );
  assert.deepEqual(await coveredSchedules(app, c.id), ['A']);

  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] },
    staffActor(await ceoId())
  );

  // No intent → refuse, and the message must NAME the schedule and ask his question.
  const actor = staffActor(await ceoId());
  await assert.rejects(
    () => sendQuote(app, quote.id, actor),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'schedule_already_covered');
      assert.match(err.message, /already has an active Schedule A/);
      assert.match(err.message, /Adding work, or duplicating\?/);
      return true;
    },
    'silent acceptance into the void is never valid — so it never gets sent'
  );

  // The quote must still be a draft: a refused send changes nothing.
  const after = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM quotes WHERE id = $1`,
    [quote.id]
  );
  assert.equal(after.rows[0]!.status, 'draft', 'a blocked send left the quote untouched');
});

test('declaring the intent lets it through, and the answer is RECORDED', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'AddedScope',
    email: 'addedscope@example.test',
  });
  await app.db.query(
    `INSERT INTO schedule_acceptances (contact_id, schedule_code, via, template_version)
     VALUES ($1, 'A', 'portal_acceptance', 3)`,
    [c.id]
  );
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] },
    staffActor(await ceoId())
  );

  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()), {
    duplicateIntent: 'additional_work',
  });
  assert.ok(sent.url, 'it sent');

  const row = await app.db.query<{ intent: string; schedules: string[]; status: string }>(
    `SELECT duplicate_intent::text AS intent, duplicate_intent_schedules AS schedules,
            status::text AS status
       FROM quotes WHERE id = $1`,
    [quote.id]
  );
  assert.equal(row.rows[0]!.status, 'sent');
  assert.equal(row.rows[0]!.intent, 'additional_work', 'the reason survives the click');
  assert.deepEqual(
    row.rows[0]!.schedules,
    ['A'],
    'and which schedules overlapped is snapshotted, so the record still reads later'
  );

  // Accepting it still produces consequence — the gate is at send, not at accept.
  await acceptQuote(app, sent.url.split('/').pop()!, {});
  const tasks = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'quote_accepted' AND source_id = $1`,
    [quote.id]
  );
  assert.equal(tasks.rows[0]!.n, 1, 'a deliberate duplicate still generates work');
});

test('a quote with no overlap sends with no intent and records none', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'NoOverlap',
    email: 'nooverlap@example.test',
  });
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] },
    staffActor(await ceoId())
  );
  await sendQuote(app, quote.id, staffActor(await ceoId()));

  const row = await app.db.query<{ intent: string | null; schedules: string[] | null }>(
    `SELECT duplicate_intent::text AS intent, duplicate_intent_schedules AS schedules
       FROM quotes WHERE id = $1`,
    [quote.id]
  );
  assert.equal(row.rows[0]!.intent, null, 'NULL means "no overlap", not "unanswered"');
  assert.equal(row.rows[0]!.schedules, null);
});
