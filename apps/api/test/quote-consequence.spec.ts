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

/**
 * A quotable item that actually CARRIES a deposit — derived from the book, never named.
 *
 * #48's post-commit tests are about the deposit invoice, and the tax items have
 * `deposit_cents` NULL, so a quote built from `taxItemCode()` produces no invoice at all.
 * My first version of those tests guarded on `if (!depositInvoiceId) return`, which meant
 * they passed by asserting nothing — the same "check that cannot fail" this codebase keeps
 * turning up. This makes the fixture carry what the test is about.
 */
async function depositItemCode(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  assert.ok(rows[0], 'the book in force has a quotable item that carries a deposit');
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

/*
 * #47 — WHAT AN ENGAGEMENT COVERS, and why it is a snapshot.
 *
 * #41's two identical `tax`/`active` rows were indistinguishable because nothing recorded
 * what either one covered. The split from quote into engagements happens in code and left
 * no trace. These tests hold the line on both halves: scope IS captured, and it does NOT
 * move afterwards.
 */
test('#47: acceptance snapshots each engagement scope, split along the same lines', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Scoped', email: 'scoped@example.test',
  });
  const other = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line::text = 'entity_services' AND pbi.is_active
        AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`
  );
  const taxCode = await taxItemCode();
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: taxCode }, { itemCode: other.rows[0]!.item_code }] },
    staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});
  assert.equal(accepted.engagements.length, 2);

  const { scopeForEngagement, scopeName } = await import('../src/modules/engagements/scope.ts');
  for (const e of accepted.engagements) {
    const items = await scopeForEngagement(app, e.id);
    assert.ok(items.length >= 1, `${e.serviceLine} engagement knows what it covers`);
    assert.ok(scopeName(items, 'en'), 'and can name itself in English');
    assert.ok(scopeName(items, 'es'), 'and in Spanish');
  }

  // The SPLIT is the point: the tax item belongs to the tax engagement and nowhere else.
  const taxEng = accepted.engagements.find((e) => e.serviceLine === 'tax')!;
  const entityEng = accepted.engagements.find((e) => e.serviceLine === 'entity')!;
  const taxScope = await scopeForEngagement(app, taxEng.id);
  const entityScope = await scopeForEngagement(app, entityEng.id);
  assert.ok(taxScope.some((i) => i.itemCode === taxCode), 'the tax line landed on the tax engagement');
  assert.ok(
    !entityScope.some((i) => i.itemCode === taxCode),
    'and NOT on the other one — the split is recorded, not just performed'
  );

  // The version is pinned beside the text, so the engagement can answer "under which book".
  const pinned = await app.db.query<{ n: number; versions: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT price_book_version_id)::int AS versions
       FROM engagement_scope_items WHERE engagement_id = ANY($1)`,
    [accepted.engagements.map((e) => e.id)]
  );
  assert.ok(pinned.rows[0]!.n >= 2, 'both engagements have scope rows');
  assert.equal(pinned.rows[0]!.versions, 1, 'all pinned to the same price-book version as the quote');
});

test('#47: editing the quote line afterwards does NOT rewrite what was agreed', async () => {
  /*
   * THE REASON THIS IS A SNAPSHOT (Brian's requirement, and he was right that my design
   * missed it). The obvious table was (engagement_id, quote_line_item_id) — a foreign key
   * to a live row. Editing that line later would silently change what the engagement
   * claims to cover and nothing would look wrong: an agreement whose terms move after it
   * was agreed, which is the exact bug the price-lock fields exist to prevent.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Frozen', email: 'frozen-scope@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});

  const { scopeForEngagement } = await import('../src/modules/engagements/scope.ts');
  const before = await scopeForEngagement(app, accepted.engagementId);
  assert.ok(before[0], 'scope was captured');

  // Someone edits the quote line after the fact — text AND price.
  await app.db.query(
    `UPDATE quote_line_items
        SET description_en = 'REWRITTEN AFTER ACCEPTANCE',
            description_es = 'REESCRITO', line_cents = 999999, unit_cents = 999999
      WHERE quote_id = $1`,
    [quote.id]
  );

  const after = await scopeForEngagement(app, accepted.engagementId);
  assert.equal(after[0]!.descriptionEn, before[0]!.descriptionEn, 'the agreement still reads what it read');
  assert.notEqual(after[0]!.descriptionEn, 'REWRITTEN AFTER ACCEPTANCE');
  assert.equal(after[0]!.lineCents, before[0]!.lineCents, 'and at the price that was agreed');
});

test('#47: the snapshot refuses to be updated at all', async () => {
  /*
   * "Written once, never updated" is the whole point, and a comment saying so is exactly
   * the kind of guarantee that survives until the first person in a hurry. The database
   * refuses; this proves the refusal rather than trusting the convention.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Immutable', email: 'immutable-scope@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});

  await assert.rejects(
    () => app.db.query(
      `UPDATE engagement_scope_items SET description_en = 'tampered' WHERE engagement_id = $1`,
      [accepted.engagementId]
    ),
    /snapshot of what was agreed and cannot be updated/,
    'the database refuses, not just the convention'
  );

  const scoped = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagement_scope_items WHERE engagement_id = $1`,
    [accepted.engagementId]
  );
  assert.ok(scoped.rows[0]!.n > 0, 'the row exists to refuse the update');

  /*
   * IMMUTABLE IS NOT UNDELETABLE. The trigger refuses UPDATE only, so ON DELETE CASCADE
   * from engagements still works — otherwise the snapshot would pin engagements in place
   * forever. Proven on a standalone engagement: an ACCEPTED one cannot be deleted at all,
   * because `quotes.converted_engagement_id` points at it, which is its own good rule.
   */
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const loose = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'bookkeeping', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO engagement_scope_items
       (engagement_id, price_book_version_id, item_code, description_en, quantity)
     VALUES ($1, $2, 'SYNTHETIC_ITEM', 'Synthetic line', 1)`,
    [loose.rows[0]!.id, version.rows[0]!.id]
  );
  await app.db.query(`DELETE FROM engagements WHERE id = $1`, [loose.rows[0]!.id]);
  const gone = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagement_scope_items WHERE engagement_id = $1`,
    [loose.rows[0]!.id]
  );
  assert.equal(gone.rows[0]!.n, 0, 'ON DELETE CASCADE still works — immutable is not undeletable');
});

test('#47: an engagement with no scope names itself null rather than guessing', async () => {
  /*
   * NO BACKFILL, confirmed by Brian. The 5 existing production quotes were split in code
   * and the split was never recorded, so which engagement covered which line is genuinely
   * unknowable. A composed-looking name over a guess is the 426-client backfill again:
   * a confident wrong answer derived from incomplete evidence.
   */
  const { scopeName, scopeSummary } = await import('../src/modules/engagements/scope.ts');
  assert.equal(scopeName([], 'en'), null, 'no scope → no name, and the caller falls back');
  assert.equal(scopeName([], 'es'), null);
  assert.deepEqual(scopeSummary([]), { count: 0, totalCents: 0 });
});

/*
 * #48 — ACCEPTANCE CLAIMS THE QUOTE BEFORE DOING ANY WORK.
 *
 * The guard sat at step 1 and the write that made it true sat at step 12, with every
 * engagement, every scope row and the deposit invoice in between. Two acceptances
 * overlapping in that window both passed the guard and both built a full set — the
 * mechanism behind #41, where Brian's client carried two indistinguishable tax engagements
 * plus a third already marked "duplicate accept".
 */
test('#48: two simultaneous acceptances produce ONE set of engagements, not two', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Doubletap', email: 'doubletap@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const token = sent.url.split('/').pop()!;

  // The double-tap, as it actually arrives: two requests in flight at once.
  const results = await Promise.allSettled([
    acceptQuote(app, token, {}),
    acceptQuote(app, token, {}),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one acceptance goes through');
  assert.equal(lost.length, 1, 'and exactly one is turned away');
  assert.match(
    (lost[0] as PromiseRejectedResult).reason.message,
    /already accepted/i,
    'the loser is told the truth — it WAS accepted, just not by them'
  );

  const eng = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagements WHERE contact_id = $1`, [c.id]
  );
  assert.equal(eng.rows[0]!.n, 1, 'ONE engagement — this is the #41 duplicate, prevented');

  const inv = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices WHERE contact_id = $1`, [c.id]
  );
  assert.ok(inv.rows[0]!.n <= 1, 'and at most one deposit invoice — never two charges');
});

test('#48: the claim is what stops it — the quote leaves "sent" before any work happens', async () => {
  /*
   * The ordering IS the fix, so it is asserted directly rather than inferred from the
   * outcome: by the time an engagement exists, the quote must already be spoken for.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Claimed', email: 'claimed@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await taxItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  await acceptQuote(app, sent.url.split('/').pop()!, {});

  const q = await app.db.query<{ status: string; accepted_at: Date; created_at: Date }>(
    `SELECT q.status::text AS status, q.accepted_at,
            (SELECT min(e.created_at) FROM engagements e WHERE e.contact_id = $2) AS created_at
       FROM quotes q WHERE q.id = $1`,
    [quote.id, c.id]
  );
  assert.equal(q.rows[0]!.status, 'accepted');
  assert.ok(
    q.rows[0]!.accepted_at.getTime() <= q.rows[0]!.created_at.getTime(),
    'the quote was claimed no later than the first engagement was created'
  );
});

/*
 * INVERTED FOR THE OUTBOX (#48). These two asserted the INLINE post-commit behaviour part one
 * shipped: the send happening at the end of `acceptQuote`, and a try/catch there raising a P1
 * task when it failed.
 *
 * Both premises are now wrong, and the reason is worth keeping rather than deleting. Part one
 * was right about WHERE the send belongs and wrong about durability: an effect that only exists
 * in code after the commit is lost if the process dies between the two, and the client is never
 * told about an acceptance that definitely happened. The intent is a row now, written inside the
 * transaction, drained afterwards.
 *
 * What replaced them lives in outbox.spec.ts, which tests the stronger claims: nothing is sent
 * during acceptance, the intent commits and rolls back WITH the acceptance, the drain performs
 * it, and five failed attempts end at a person. The two assertions below are what survives here
 * — the part that is still this file's business.
 */
test('#48: acceptance itself sends nothing, and queues the delivery instead', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Postcommit', email: 'postcommit@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});
  assert.ok(accepted.depositInvoiceId, 'the fixture carries a deposit — otherwise this proves nothing');

  const inv = await app.db.query<{ status: string; sent_at: Date | null }>(
    `SELECT status::text AS status, sent_at FROM invoices WHERE id = $1`,
    [accepted.depositInvoiceId]
  );
  assert.equal(inv.rows[0]!.status, 'draft', 'the invoice does not claim to have been sent');
  assert.equal(inv.rows[0]!.sent_at, null, 'and carries no sent_at, because nothing was sent yet');

  const queued = await app.db.query<{ effect: string; status: string }>(
    `SELECT effect, status::text AS status FROM outbox WHERE object_id = $1`,
    [accepted.depositInvoiceId]
  );
  assert.equal(queued.rows[0]!.effect, 'invoice.send');
  assert.equal(queued.rows[0]!.status, 'pending', 'the delivery is an intent that committed with the acceptance');
});

/*
 * ── #48 PART TWO: ACCEPTANCE AS ONE TRANSACTION ────────────────────────────
 *
 * Part one stopped two acceptances from both proceeding. It did nothing for the other half:
 * eighteen writes in sequence, any of which could fail and leave the client with SOME of an
 * acceptance — engagements but no invoice, an invoice but no onboarding task, a charge and
 * nobody at Soto knowing to start.
 *
 * THE FAILURE IS INJECTED WITH A REAL DATABASE TRIGGER, at the LAST write in the sequence.
 * That matters: a failure at step 3 would prove almost nothing, because there is barely
 * anything to roll back. Failing at the onboarding task — after the engagements, the scope
 * snapshot and the deposit invoice — is the case where the old code left the most wreckage.
 */

/** Block the onboarding-task insert for ONE synthetic client, by name. */
async function blockOnboardingTaskFor(lastName: string): Promise<void> {
  await app.db.query(`
    CREATE OR REPLACE FUNCTION synthetic_block_onboarding() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.title LIKE 'Start onboarding:%${lastName}%' THEN
        RAISE EXCEPTION 'synthetic failure at the last write in acceptance';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_synthetic_block_onboarding ON tasks;
    CREATE TRIGGER trg_synthetic_block_onboarding
      BEFORE INSERT ON tasks
      FOR EACH ROW EXECUTE FUNCTION synthetic_block_onboarding();
  `);
}

async function unblockOnboardingTask(): Promise<void> {
  await app.db.query(`
    DROP TRIGGER IF EXISTS trg_synthetic_block_onboarding ON tasks;
    DROP FUNCTION IF EXISTS synthetic_block_onboarding();
  `);
}

test('#48b: a failure at the LAST write leaves absolutely nothing behind', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Rollback', email: 'rollback-48@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const token = sent.url.split('/').pop()!;

  await blockOnboardingTaskFor('Rollback');
  try {
    await assert.rejects(
      () => acceptQuote(app, token, {}),
      /synthetic failure at the last write/,
      'the acceptance fails, as designed'
    );

    /*
     * The old code would have left every one of these behind. Each row here is a way a
     * client could have ended up half-onboarded and nobody noticing.
     */
    const left = await app.db.query<{
      engagements: number; scope: number; invoices: number; quote_status: string;
      accepted_at: Date | null; lead_stage: string | null; contact_status: string;
    }>(
      `SELECT (SELECT count(*)::int FROM engagements WHERE contact_id = $1)                    AS engagements,
              (SELECT count(*)::int FROM engagement_scope_items s
                 JOIN engagements e ON e.id = s.engagement_id WHERE e.contact_id = $1)         AS scope,
              (SELECT count(*)::int FROM invoices WHERE contact_id = $1)                       AS invoices,
              (SELECT status::text FROM quotes WHERE id = $2)                                  AS quote_status,
              (SELECT accepted_at FROM quotes WHERE id = $2)                                   AS accepted_at,
              (SELECT lead_stage::text FROM contacts WHERE id = $1)                            AS lead_stage,
              (SELECT contact_status::text FROM contacts WHERE id = $1)                         AS contact_status`,
      [c.id, quote.id]
    );
    const r = left.rows[0]!;
    assert.equal(r.engagements, 0, 'no engagement');
    assert.equal(r.scope, 0, 'no scope snapshot');
    assert.equal(r.invoices, 0, 'no invoice — the client was not charged for a failed acceptance');
    assert.notEqual(r.lead_stage, 'deposit_paid', 'the pipeline did not advance');
    assert.notEqual(r.contact_status, 'onboarding', 'and neither did the lifecycle');

    /*
     * THE QUOTE IS OPEN AGAIN. The claim from part one is inside the transaction, so the
     * rollback un-claims it — a failed acceptance does not burn the quote.
     */
    assert.equal(r.quote_status, 'sent', 'the quote went back to open');
    assert.equal(r.accepted_at, null, 'and carries no acceptance timestamp');
  } finally {
    await unblockOnboardingTask();
  }
});

test('#48b: the rolled-back acceptance is LOUD — the client tried to buy and someone is told', async () => {
  /*
   * Everything the transaction wrote is gone, including any audit row it managed to write.
   * That is correct — there was no acceptance. But the ATTEMPT must not evaporate with it,
   * so the record is written outside the transaction. Brian's rule from part one, applied at
   * the transaction boundary.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Loudrollback', email: 'loudrollback-48@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));

  await blockOnboardingTaskFor('Loudrollback');
  try {
    await assert.rejects(() => acceptQuote(app, sent.url.split('/').pop()!, {}));
  } finally {
    await unblockOnboardingTask();
  }

  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'quote.acceptance_failed' AND object_id = $1`,
    [quote.id]
  );
  assert.equal(audit.rows[0]!.n, 1, 'the failed attempt is on the record, outside the transaction');

  const task = await app.db.query<{ n: number; title: string; priority: number }>(
    `SELECT count(*)::int AS n, max(title) AS title, min(priority) AS priority
       FROM tasks WHERE contact_id = $1 AND source_type = 'acceptance_failed'`,
    [c.id]
  );
  assert.equal(task.rows[0]!.n, 1, 'and a person is told');
  assert.equal(task.rows[0]!.priority, 1, 'at P1 — a hot lead with a broken checkout');
  assert.match(task.rows[0]!.title, /ACCEPTANCE FAILED/);
});

test('#48b: after a failed acceptance the client can simply try again', async () => {
  /*
   * The point of un-claiming. The retry cannot collide with the wreckage of the failed
   * attempt because there is none — so it produces exactly one of everything.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Retryable', email: 'retryable-48@example.test',
  });
  const quote = await createQuote(
    app, { contactId: c.id, lines: [{ itemCode: await depositItemCode() }] }, staffActor(await ceoId())
  );
  const sent = await sendQuote(app, quote.id, staffActor(await ceoId()));
  const token = sent.url.split('/').pop()!;

  await blockOnboardingTaskFor('Retryable');
  try {
    await assert.rejects(() => acceptQuote(app, token, {}));
  } finally {
    await unblockOnboardingTask();
  }

  // Same token, same client, nothing changed except the cause being fixed.
  const accepted = await acceptQuote(app, token, {});
  assert.ok(accepted.engagementId, 'the retry goes through on the original link');

  const counts = await app.db.query<{ engagements: number; invoices: number; onboarding: number }>(
    `SELECT (SELECT count(*)::int FROM engagements WHERE contact_id = $1) AS engagements,
            (SELECT count(*)::int FROM invoices WHERE contact_id = $1)    AS invoices,
            (SELECT count(*)::int FROM tasks
               WHERE contact_id = $1 AND source_type = 'quote_accepted')  AS onboarding`,
    [c.id]
  );
  assert.equal(counts.rows[0]!.engagements, 1, 'exactly one engagement, not one per attempt');
  assert.equal(counts.rows[0]!.invoices, 1, 'exactly one invoice');
  assert.equal(counts.rows[0]!.onboarding, 1, 'exactly one onboarding task');
});

test('#48b: withTransaction is re-entrant — a nested call joins rather than nesting', async () => {
  /*
   * This is what makes it safe to wrap a service call some other caller has already wrapped.
   * Asserted directly because the alternative — a second BEGIN on the same client — fails
   * quietly with a Postgres warning rather than an error, so nothing else would catch it.
   */
  const { withTransaction, inTransaction } = await import('../src/db.ts');

  assert.equal(inTransaction(), false, 'no transaction outside');
  let innerSawTransaction = false;
  await withTransaction(app.db, async () => {
    assert.equal(inTransaction(), true, 'inside, the ambient client is visible');
    await withTransaction(app.db, async () => {
      innerSawTransaction = inTransaction();
      // A write here is governed by the OUTER transaction — the whole point.
      await app.db.query(`SELECT 1`);
    });
  });
  assert.equal(innerSawTransaction, true, 'the nested call joined the outer transaction');
  assert.equal(inTransaction(), false, 'and the context is gone afterwards');
});

test('#48b: a rollback inside withTransaction discards every write, including nested ones', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Discarded', email: 'discarded-48@example.test',
  });
  const { withTransaction } = await import('../src/db.ts');

  await assert.rejects(
    () =>
      withTransaction(app.db, async () => {
        await app.db.query(`UPDATE contacts SET last_name = 'Committed' WHERE id = $1`, [c.id]);
        // A nested call joins, so its write is discarded with the outer one.
        await withTransaction(app.db, async () => {
          await app.db.query(`UPDATE contacts SET first_name = 'Nested' WHERE id = $1`, [c.id]);
        });
        throw new Error('synthetic');
      }),
    /synthetic/
  );

  const after = await app.db.query<{ first_name: string; last_name: string }>(
    `SELECT first_name, last_name FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(after.rows[0]!.last_name, 'Discarded', 'the outer write is gone');
  assert.equal(after.rows[0]!.first_name, 'Synthetic', 'and so is the nested one');
});

test('#48b: an ordinary query outside a transaction still uses the pool', async () => {
  /*
   * The wrapper is on the path of all ~792 call sites, so the boring case has to be boring.
   * The rest of the suite is the real regression test for this; the assertion here is that
   * the wrapper is transparent when no transaction is in progress.
   */
  const { inTransaction } = await import('../src/db.ts');
  assert.equal(inTransaction(), false);
  const r = await app.db.query<{ n: number }>(`SELECT 1::int AS n`);
  assert.equal(r.rows[0]!.n, 1);
});
