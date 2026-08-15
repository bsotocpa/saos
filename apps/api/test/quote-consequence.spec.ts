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

/*
 * GATE 1 IS LIFTED (#19 fixed, 2026-08-15).
 *
 * The gate existed because acceptQuote hardcoded serviceLine 'tax', so accepting a
 * bookkeeping quote produced a Schedule A — an individual-tax agreement for work that is
 * not individual tax. Acceptance now derives the line from the price book, so this test
 * is the old one inverted: the same quote that was refused must now send AND accept into
 * a bookkeeping engagement.
 */
test('#19: a bookkeeping quote sends, and accepts into a BOOKKEEPING engagement', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'BookkeepingOk',
    email: 'bookkeeping-ok@example.test',
  });

  const bk = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line::text = 'recurring_accounting' AND pbi.is_active
        AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND pbi.item_code NOT IN ('SCOPE_FULLMGMT_PAYROLL', 'SCOPE_FULLMGMT_SALES_TAX', 'SALES_TAX_ST1_FILING')
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  assert.ok(bk.rows[0], 'the price book has a bookkeeping item');

  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: bk.rows[0]!.item_code }] },
    staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  assert.ok(sent.url, 'no longer refused at send');

  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});
  const eng = await app.db.query<{ service_line: string; title: string }>(
    `SELECT service_line::text AS service_line, title FROM engagements WHERE id = ANY($1)`,
    [accepted.engagements.map((e) => e.id)]
  );
  assert.equal(eng.rows.length, 1, 'one service line on this quote → one engagement');
  assert.equal(eng.rows[0]!.service_line, 'bookkeeping', 'NOT tax — the whole point of #19');
  assert.notEqual(eng.rows[0]!.title, 'Accepted quote', 'and it is not the old generic title');
  assert.match(eng.rows[0]!.title, /^Bookkeeping — /, 'the title names the line and the work');
});

test('#19: a quote spanning two service lines creates two DISTINCT engagements', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'TwoLines',
    email: 'two-lines@example.test',
  });

  /*
   * The second line is derived from the BOOK, not hardcoded.
   *
   * SCOPE_FULLMGMT_PAYROLL was the obvious pick and it is classified differently in v1
   * (scope_ladder) than in v5 (recurring_accounting): GATE 2's reclassification landed in
   * a new version and deliberately left v1 alone, so a fresh database and production
   * genuinely disagree about what that item is. A test naming it passes or fails
   * depending on which version happens to be in force — which is a property of the
   * fixture, not of the code under test.
   */
  const other = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line::text = 'entity_services' AND pbi.is_active
        AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  assert.ok(other.rows[0], 'the book in force has a quotable entity item');

  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: await taxItemCode() }, { itemCode: other.rows[0]!.item_code }] },
    staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});

  const eng = await app.db.query<{ service_line: string; title: string }>(
    `SELECT service_line::text AS service_line, title FROM engagements
       WHERE contact_id = $1 ORDER BY service_line`,
    [c.id]
  );
  assert.equal(eng.rows.length, 2, 'one engagement per distinct service line');
  const linesFound = eng.rows.map((r) => r.service_line);
  assert.deepEqual(linesFound, ['entity', 'tax'], 'two different agreements, derived from the book');

  // Brian's RC2 finding: "2 active engagements (tax, tax)" with nothing to tell them
  // apart. Both the line AND the title must now distinguish them.
  assert.equal(new Set(linesFound).size, 2, 'service lines are distinct');
  assert.equal(new Set(eng.rows.map((r) => r.title)).size, 2, 'and so are the titles');
  assert.equal(accepted.engagements.length, 2, 'the caller is told about both');
});

test('#19 successor gate: a line mapping to no engagement is refused at SEND', async () => {
  // GATE 1's replacement. A priced line that maps to no engagement service line would be
  // silently dropped when the engagements are built — the client would agree to work that
  // produces no agreement and no schedule.
  const { engagementLineFor } = await import('../src/modules/pricing/engagement-lines.ts');

  // The mapping itself is the unit under test; every ACTIVE, quotable price line must
  // resolve, or sending a quote containing it now throws.
  const priceLines = await app.db.query<{ service_line: string; item_code: string }>(
    `SELECT DISTINCT pbi.service_line::text AS service_line, pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.display_on_quote
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)`
  );
  const unmapped = priceLines.rows.filter(
    (r) => !['deposit', 'software_passthrough', 'scope_ladder'].includes(r.service_line)
      && engagementLineFor(r.service_line, r.item_code) === null
  );
  assert.deepEqual(unmapped, [], 'every quotable line in the live book maps to an engagement line');

  // And the mapping is per-ITEM where the price line is ambiguous.
  assert.equal(engagementLineFor('recurring_accounting', 'SCOPE_FULLMGMT_PAYROLL'), 'payroll');
  assert.equal(engagementLineFor('recurring_accounting', 'SCOPE_FULLMGMT_SALES_TAX'), 'sales_tax');
  assert.equal(engagementLineFor('recurring_accounting', 'SALES_TAX_ST1_FILING'), 'sales_tax');
  assert.equal(engagementLineFor('recurring_accounting', 'ACCT_MONTHLY'), 'bookkeeping');
  assert.equal(engagementLineFor('deposit', 'ANYTHING'), null, 'a deposit is not work');
});

test('schedule resolution PINS the price-book version — a reclassification is not retroactive', async () => {
  // This broke the moment a second version existed. schedulesImpliedByQuote joined
  // price_book_items on item_code alone, so one quote resolved to the UNION of the
  // item's old and new classifications: after GATE 2 moved SCORP_CONVERSION_2553 from
  // setup_conversion to entity_services, a quote for it implied both C and E.
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'PinnedVersion',
    email: 'pinnedversion@example.test',
  });
  const itemCode = await taxItemCode();

  // A quote against the version in force today.
  const before = await createQuote(app, { contactId: c.id, lines: [{ itemCode }] }, staffActor(await ceoId()));
  assert.deepEqual(await schedulesImpliedByQuote(app, before.id), ['A']);

  // Now reclassify that very item in a NEW version, the way GATE 2 did.
  const v1 = await app.db.query<{ id: string; version_number: number }>(
    `SELECT id, version_number FROM price_book_versions
      WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
      ORDER BY version_number DESC LIMIT 1`
  );
  const v2 = await app.db.query<{ id: string }>(
    `INSERT INTO price_book_versions (version_number, effective_from, note)
     VALUES ($1, CURRENT_DATE, 'test: reclassification must not reach backwards') RETURNING id`,
    [v1.rows[0]!.version_number + 1]
  );
  await app.db.query(
    `INSERT INTO price_book_items
       (version_id, item_code, service_line, name_en, name_es, amount_cents, unit,
        is_pass_through, display_on_quote, is_active, sort_order)
     SELECT $1, item_code, 'entity_services'::price_service_line, name_en, name_es, amount_cents,
            unit, is_pass_through, display_on_quote, is_active, sort_order
       FROM price_book_items WHERE version_id = $2 AND item_code = $3`,
    [v2.rows[0]!.id, v1.rows[0]!.id, itemCode]
  );

  // The OLD quote still means what the book said when it was written.
  assert.deepEqual(
    await schedulesImpliedByQuote(app, before.id),
    ['A'],
    'a reclassification must not reach backwards into a quote already given to a client'
  );

  // Clean up so later tests see one version in force.
  await app.db.query(`DELETE FROM price_book_items WHERE version_id = $1`, [v2.rows[0]!.id]);
  await app.db.query(`DELETE FROM price_book_versions WHERE id = $1`, [v2.rows[0]!.id]);
});
