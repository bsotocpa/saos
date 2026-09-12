// #48 "same shape, other paths" — quote creation, e-file results, packet assembly.
//
// Acceptance was made atomic first because it takes money. These three are the rest of the
// same defect: multi-write sequences where a break part-way leaves the system holding a
// coherent-looking record of something that did not fully happen.
//
// EVERY TEST HERE INJECTS THE FAILURE AT THE LAST WRITE, with a real database trigger. A
// failure at the first write proves almost nothing — there is barely anything to roll back.
// The last write is where the old code left the most wreckage, so it is the only position
// that tests the claim.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff , signed8879OnFile } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote } from '../src/modules/pricing/quotes.ts';
import { recordEfileResult } from '../src/modules/tax/pipeline.ts';
import { recordMasterSignature } from '../src/modules/engagements/packet.ts';

let app: FastifyInstance;
let config: Config;
let ceo = '';

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

function staffActor(id: string) {
  return {
    id, email: 'system@saos', fullName: 'SAOS', roleKey: 'ceo' as const,
    permissions: ['*'], sessionId: 'test',
  };
}

async function ceoId(): Promise<string> {
  if (ceo) return ceo;
  const staff = await makeStaff(app.db, config, {
    email: 'ceo-txpaths@example.test', name: 'Synthetic CEO', role: 'ceo',
    password: 'ceo-password-1234567',
  });
  ceo = staff.id;
  return ceo;
}

/** Two quotable items, from the book — never named, so a reclassification cannot break this. */
async function twoItems(): Promise<string[]> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code
       FROM price_book_items pbi
       JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line::text = 'individual_tax' AND pbi.is_active AND pbi.display_on_quote
        AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 2`
  );
  assert.equal(rows.length, 2, 'the book in force has at least two quotable tax items');
  return rows.map((r) => r.item_code);
}

/**
 * Break the NEXT insert into `table` whose text matches `marker`.
 *
 * A trigger rather than a stub: it fails the real statement, from inside the database, at
 * exactly the point a disk error or a constraint would.
 */
async function breakInsert(table: string, column: string, marker: string): Promise<void> {
  await app.db.query(`
    CREATE OR REPLACE FUNCTION synthetic_break_insert() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.${column}::text LIKE '%${marker}%' THEN
        RAISE EXCEPTION 'synthetic failure at the last write';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_synthetic_break ON ${table};
    CREATE TRIGGER trg_synthetic_break BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION synthetic_break_insert();
  `);
}

async function unbreak(table: string): Promise<void> {
  await app.db.query(`
    DROP TRIGGER IF EXISTS trg_synthetic_break ON ${table};
    DROP FUNCTION IF EXISTS synthetic_break_insert();
  `);
}

before(async () => {
  config = await createTestConfig('txpaths');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

// ── QUOTE CREATION ─────────────────────────────────────────────────────────

test('#48: a quote that cannot be fully written is not written at all', async () => {
  /*
   * A quote is a header plus N lines, inserted one at a time, then the audit row. A break in
   * the loop used to leave a quote carrying SOME of its lines — and that is not a broken
   * record, it is a quote that UNDER-PRICES THE WORK, with a header total that still says
   * what the full set came to.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Partialquote', email: 'partialquote@example.test',
  });
  const items = await twoItems();

  // The audit row is the LAST write in createQuote — so the header and both lines are already
  // in before this fires.
  const quoteActor = staffActor(await ceoId());
  await breakInsert('audit_log', 'action', 'quote.created');
  try {
    await assert.rejects(
      () => createQuote(app, { contactId: c.id, lines: items.map((itemCode) => ({ itemCode })) }, quoteActor),
      /synthetic failure at the last write/
    );
  } finally {
    await unbreak('audit_log');
  }

  const left = await app.db.query<{ quotes: number; lines: number }>(
    `SELECT (SELECT count(*)::int FROM quotes WHERE contact_id = $1)              AS quotes,
            (SELECT count(*)::int FROM quote_line_items l
               JOIN quotes q ON q.id = l.quote_id WHERE q.contact_id = $1)        AS lines`,
    [c.id]
  );
  assert.equal(left.rows[0]!.quotes, 0, 'no quote header');
  assert.equal(left.rows[0]!.lines, 0, 'and no orphan lines');

  // And the ordinary path still works, with every line present.
  const ok = await createQuote(
    app, { contactId: c.id, lines: items.map((itemCode) => ({ itemCode })) }, staffActor(await ceoId())
  );
  const lines = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM quote_line_items WHERE quote_id = $1`, [ok.id]
  );
  assert.equal(lines.rows[0]!.n, 2, 'a committed quote carries all of its lines');
});

// ── E-FILE RESULTS ─────────────────────────────────────────────────────────

/** A return sitting at `filed`, with every gate satisfied so it can move. */
async function filedReturn(lastName: string): Promise<{ contactId: string; returnId: string; engagementId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName, email: `${lastName.toLowerCase()}@example.test`,
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements
       (engagement_id, tax_year, return_type, stage, engagement_letter_signed_at,
        estimate_locked_at)
     VALUES ($1, 2025, '1040', 'filed', now(), now()) RETURNING id`,
    [eng.rows[0]!.id]
  );
  await signed8879OnFile(app, te.rows[0]!.id, (await app.db.query<{ id: string }>(`SELECT id FROM staff WHERE is_active ORDER BY created_at LIMIT 1`)).rows[0]!.id);
  return { contactId: c.id, returnId: te.rows[0]!.id, engagementId: eng.rows[0]!.id };
}

const systemActor = { staffId: null, label: 'test' };

test('#48: a REJECTED return that cannot be fully recorded stays filed, with no half-set clock', async () => {
  /*
   * The reject branch stamps the reject code and the perfection deadline, moves the stage,
   * then creates the owned re-file task and alerts its owner. A break before the task used to
   * leave the return reading `rejected` with a live perfection clock and NOBODY OWNING IT —
   * no task, no alert, and nothing for the escalation ladder to hang from. What runs out in
   * that state is the original filing date.
   */
  const r = await filedReturn('Rejectpartial');

  // The task insert is the last write in the branch.
  await breakInsert('tasks', 'title', 'E-file REJECTED');
  try {
    await assert.rejects(
      () => recordEfileResult(app, systemActor, r.returnId, {
        result: 'rejected', rejectCode: 'IND-031-04', rejectReason: 'Synthetic prior-year AGI mismatch',
      }),
      /synthetic failure at the last write/
    );
  } finally {
    await unbreak('tasks');
  }

  const after = await app.db.query<{
    stage: string; rejected_at: Date | null; perfection_deadline: string | null; history: number;
  }>(
    `SELECT te.stage::text AS stage, te.rejected_at, te.perfection_deadline::text AS perfection_deadline,
            (SELECT count(*)::int FROM engagement_stage_history h
               WHERE h.tax_engagement_id = te.id AND h.stage = 'rejected') AS history
       FROM tax_engagements te WHERE te.id = $1`,
    [r.returnId]
  );
  assert.equal(after.rows[0]!.stage, 'filed', 'the return did not move');
  assert.equal(after.rows[0]!.rejected_at, null, 'no reject stamp');
  assert.equal(after.rows[0]!.perfection_deadline, null, 'and no perfection clock with nobody watching it');
  assert.equal(after.rows[0]!.history, 0, 'not even a stage-history row claiming it was rejected');

  // The retry records the whole thing.
  const done = await recordEfileResult(app, systemActor, r.returnId, {
    result: 'rejected', rejectCode: 'IND-031-04', rejectReason: 'Synthetic prior-year AGI mismatch',
  });
  assert.equal(done.stage, 'rejected');
  const task = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1`,
    [r.returnId]
  );
  assert.equal(task.rows[0]!.n, 1, 'and the re-file task exists, owned and clocked');
});

test('#48: an ACCEPTED return that cannot finish leaves the engagement open, not half-closed', async () => {
  /*
   * The accepted branch stamps acceptance, moves the stage to `completed`, then closes the
   * engagement and recomputes the client's lifecycle (#44 §4). A break midway would reinstate
   * the exact untruth #44 §4 removed — an accepted return inside a permanently open
   * engagement — this time from a failed write rather than a missing feature.
   */
  const r = await filedReturn('Acceptpartial');
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [r.contactId]
  );

  // The engagement-close audit row is the last write on the accepted path.
  await breakInsert('audit_log', 'action', 'engagement.closed');
  try {
    await assert.rejects(
      () => recordEfileResult(app, systemActor, r.returnId, { result: 'accepted' }),
      /synthetic failure at the last write/
    );
  } finally {
    await unbreak('audit_log');
  }

  const after = await app.db.query<{ stage: string; accepted_at: Date | null; eng_status: string; ended_on: string | null }>(
    `SELECT te.stage::text AS stage, te.efile_accepted_at AS accepted_at,
            e.status::text AS eng_status, e.ended_on::text AS ended_on
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE te.id = $1`,
    [r.returnId]
  );
  assert.equal(after.rows[0]!.stage, 'filed', 'the return is still filed, not completed');
  assert.equal(after.rows[0]!.accepted_at, null, 'and carries no acceptance stamp');
  assert.equal(after.rows[0]!.eng_status, 'active', 'the engagement was not closed');
  assert.equal(after.rows[0]!.ended_on, null, 'and has no end date');

  const done = await recordEfileResult(app, systemActor, r.returnId, { result: 'accepted' });
  assert.equal(done.stage, 'completed', 'the retry completes the whole chain');
});

// ── PACKET ASSEMBLY ────────────────────────────────────────────────────────

test('#48: a signed Master records ALL its schedules or none — the worst partial state', async () => {
  /*
   * The client signs ONE document covering N schedules, and the acceptances go in one at a
   * time. A break in that loop left a packet reading `signed` while recording acceptance of
   * only SOME of what the client signed for.
   *
   * That is not bookkeeping. `schedule_acceptances` is the evidence of what was agreed, the
   * coverage gate reads it to decide whether a quote may be sent, and the packet itself would
   * already say `signed` — so nothing downstream would have any reason to doubt it. The
   * document on file and the record of it would disagree, quietly, about the scope of a
   * signed agreement.
   */
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Halfsigned', email: 'halfsigned@example.test',
  });
  const packet = await app.db.query<{ id: string }>(
    `INSERT INTO engagement_packets
       (contact_id, master_template_key, master_version, schedule_codes)
     VALUES ($1, 'engagement_master', 1, ARRAY['A','C']) RETURNING id`,
    [c.id]
  );
  const packetId = packet.rows[0]!.id;

  // The audit row is the last write before the lifecycle recompute — by then the packet is
  // marked signed, BOTH acceptances are in, and the legacy flag is set.
  await breakInsert('audit_log', 'action', 'packet.signed');
  try {
    await assert.rejects(
      () => recordMasterSignature(app, packetId, { method: 'portal_esign' }),
      /synthetic failure at the last write/
    );
  } finally {
    await unbreak('audit_log');
  }

  const after = await app.db.query<{ status: string; signed_at: Date | null; accepted: number; letter: string | null }>(
    `SELECT p.status::text AS status, p.signed_at,
            (SELECT count(*)::int FROM schedule_acceptances s WHERE s.contact_id = $2) AS accepted,
            (SELECT engagement_letter_status::text FROM contacts WHERE id = $2)        AS letter
       FROM engagement_packets p WHERE p.id = $1`,
    [packetId, c.id]
  );
  assert.notEqual(after.rows[0]!.status, 'signed', 'the packet does not claim to be signed');
  assert.equal(after.rows[0]!.signed_at, null, 'and carries no signature timestamp');
  assert.equal(after.rows[0]!.accepted, 0, 'no schedule acceptance was recorded');
  assert.notEqual(after.rows[0]!.letter, 'signed', 'and the legacy flag did not move either');

  // Signing again records the complete set — both schedules, not one.
  const done = await recordMasterSignature(app, packetId, { method: 'portal_esign' });
  assert.deepEqual(done.accepted.sort(), ['A', 'C']);
  const codes = await app.db.query<{ schedule_code: string }>(
    `SELECT schedule_code FROM schedule_acceptances WHERE contact_id = $1 ORDER BY schedule_code`,
    [c.id]
  );
  assert.deepEqual(codes.rows.map((r) => r.schedule_code), ['A', 'C'], 'every schedule the client signed for');
});

test('#48: a packet is never created without the audit row that says who assembled it', async () => {
  /*
   * Two writes, but the two that must not disagree: a legal packet with no record of who
   * built it, or a record of a packet that does not exist. CLAUDE.md requires audit coverage
   * on anything touching client documents and grants no exception for "the audit write
   * failed".
   */
  const { createPacket } = await import('../src/modules/engagements/packet.ts');
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Unaudited', email: 'unaudited@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2)`,
    [c.id, version.rows[0]!.id]
  );

  const actor = staffActor(await ceoId());
  await breakInsert('audit_log', 'action', 'packet.created');
  try {
    await assert.rejects(
      () => createPacket(app, c.id, actor),
      /synthetic failure at the last write/
    );
  } finally {
    await unbreak('audit_log');
  }

  const packets = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagement_packets WHERE contact_id = $1`, [c.id]
  );
  assert.equal(packets.rows[0]!.n, 0, 'no unaudited packet was left behind');
});
