/*
 * IMPORT MODE, AND THE IMPORTED STAGE (Brian, 2026-09-20, ruling R16).
 *
 * Two rulings, one spec, because they are two halves of the same promise: importing history must
 * not tell a client anything, and must not invent anything.
 *
 *   (b) Under `runInImportContext`, every client-facing outbox effect is REFUSED — the row is not
 *       written — and each refusal is audited. Outside it, the same enqueue flows. The context is
 *       ambient (AsyncLocalStorage), so what is really being tested is that it applies to an
 *       enqueue several frames down a call chain, and that it does not leak out of its own tree.
 *
 *   (c) `setImportedStage` moves a return's POSITION and writes no EVIDENCE. The gate columns stay
 *       null, one audit row carries the attestation, and the gates from that stage forward still
 *       hold: an imported return at `ready_to_file` is refused `filed` without a signed 8879.
 *
 * Synthetic data only.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { enqueueEffect, isImportContext, runInImportContext } from '../src/outbox.ts';
import { setImportedStage, attestation } from '../src/modules/tax/import.ts';
import { transitionStage } from '../src/modules/tax/pipeline.ts';

let app: FastifyInstance;
let config: Config;
let ceoId = '';

const IMPORT_LABEL = 'trello import rehearsal 2026-09-20 (synthetic)';
const BUNDLE_DATE = '2026-09-19';

before(async () => {
  config = await createTestConfig('import_mode');
  app = buildServer(config, {});
  await app.ready();
  const staff = await makeStaff(app.db, config, {
    email: 'ceo-import@example.test',
    name: 'Synthetic CEO',
    role: 'ceo',
    password: 'ceo-password-1234567',
  });
  ceoId = staff.id;
});

after(async () => {
  await app.close();
});

let seq = 0;

/** A contact with an invoice we can name as the object of an effect. Nothing here is sent. */
async function invoiceFor(): Promise<{ contactId: string; invoiceId: string }> {
  seq++;
  const c = await makeContact(app.db, {
    firstName: 'Import',
    lastName: `Subject${seq}`,
    email: `import.subject${seq}@example.test`,
  });
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, due_date)
     VALUES ($1, $2, 'draft', 1000, 1000, 0, CURRENT_DATE + 30) RETURNING id`,
    [`SYN-IMPORT-${String(seq).padStart(4, '0')}`, c.id]
  );
  return { contactId: c.id, invoiceId: rows[0]!.id };
}

async function outboxCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox`);
  return rows[0]!.n;
}

async function refusals(effect?: string): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(
    effect
      ? `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'outbox.refused_in_import' AND details->>'effect' = $1`
      : `SELECT count(*)::int AS n FROM audit_log WHERE action = 'outbox.refused_in_import'`,
    effect ? [effect] : []
  );
  return rows[0]!.n;
}

// ── (b) THE CONTEXT ────────────────────────────────────────────────────────

test('outside an import context there is no import context', () => {
  assert.equal(isImportContext(), null);
});

test('R16: an enqueue OUTSIDE the import context flows, and is the control for everything below', async () => {
  const { contactId, invoiceId } = await invoiceFor();
  const before = await outboxCount();
  const row = await enqueueEffect(app, {
    effect: 'invoice.send',
    payload: { invoiceId },
    contactId,
    objectType: 'invoice',
    objectId: invoiceId,
  });
  assert.ok(row?.id, 'the effect was enqueued');
  assert.equal(await outboxCount(), before + 1, 'exactly one row was written');
});

test('R16: an enqueue UNDER the import context is refused — no row — and audited by name', async () => {
  const { contactId, invoiceId } = await invoiceFor();
  const beforeRows = await outboxCount();
  const beforeRefusals = await refusals('invoice.send');

  const result = await runInImportContext(IMPORT_LABEL, async () => {
    assert.equal(isImportContext(), IMPORT_LABEL, 'the label is visible inside the tree');
    return enqueueEffect(app, {
      effect: 'invoice.send',
      payload: { invoiceId },
      contactId,
      objectType: 'invoice',
      objectId: invoiceId,
    });
  });

  assert.equal(result, null, 'the enqueue reports nothing queued');
  assert.equal(await outboxCount(), beforeRows, 'NO outbox row was written — the message does not exist');
  assert.equal(
    await refusals('invoice.send'),
    beforeRefusals + 1,
    'the refusal is one audit row, so a silent import is distinguishable from a failed one'
  );

  const { rows } = await app.db.query<{ actor_label: string; effect: string; imp: string; object_id: string }>(
    `SELECT actor_label, details->>'effect' AS effect, details->>'import' AS imp, object_id
       FROM audit_log WHERE action = 'outbox.refused_in_import' ORDER BY occurred_at DESC, id DESC LIMIT 1`
  );
  const audit = rows[0]!;
  assert.equal(audit.effect, 'invoice.send', 'the audit row names the effect that was refused');
  assert.equal(audit.imp, IMPORT_LABEL, 'and which import refused it');
  assert.equal(audit.actor_label, IMPORT_LABEL, 'the actor is the import, not a person');
  assert.equal(audit.object_id, invoiceId, 'and what it was about');
});

test('R16: the refusal reaches an enqueue several frames down, which is why it is ambient', async () => {
  /*
   * The real call shape: nothing on this path was told an import is running. `filed` →
   * invoiceForFiledEngagement → enqueueEffect is four frames in the live code; four frames of
   * anonymous helpers here make the same point without a fixture return.
   */
  const { contactId, invoiceId } = await invoiceFor();
  const deep = async () =>
    enqueueEffect(app, { effect: 'invoice.send', payload: { invoiceId }, contactId, objectType: 'invoice', objectId: invoiceId });
  const three = async () => deep();
  const two = async () => three();
  const one = async () => two();

  const before = await outboxCount();
  const got = await runInImportContext(IMPORT_LABEL, one);
  assert.equal(got, null);
  assert.equal(await outboxCount(), before, 'the enqueue four frames down was refused too');
});

test('R16: the context does not leak — after it returns, the same enqueue flows', async () => {
  const { contactId, invoiceId } = await invoiceFor();
  await runInImportContext(IMPORT_LABEL, async () => {
    await enqueueEffect(app, { effect: 'invoice.send', payload: { invoiceId }, contactId, objectType: 'invoice', objectId: invoiceId });
  });
  assert.equal(isImportContext(), null, 'the store is gone with the tree');

  const before = await outboxCount();
  const row = await enqueueEffect(app, {
    effect: 'invoice.send', payload: { invoiceId }, contactId, objectType: 'invoice', objectId: invoiceId,
  });
  assert.ok(row?.id, 'the same enqueue outside the context is performed');
  assert.equal(await outboxCount(), before + 1);
});

test('R16: an import context must be labelled — an unnamed refusal is unreadable', async () => {
  await assert.rejects(
    () => runInImportContext('   ', async () => 1),
    /import_label_required|labelled/i
  );
});

test('R16: EVERY registered effect is refused, not a list somebody maintained', async () => {
  /*
   * The point of refusing the whole set rather than a subset: a new client-facing effect added
   * tomorrow is covered without anybody remembering the import. Each effect is enqueued under the
   * context with a payload that never has to be valid — nothing performs it.
   */
  const { OUTBOX_EFFECTS } = await import('../src/outbox.ts');
  const before = await outboxCount();
  const beforeRefusals = await refusals();
  await runInImportContext(IMPORT_LABEL, async () => {
    for (const effect of OUTBOX_EFFECTS) {
      const got = await enqueueEffect(app, { effect, payload: { synthetic: true }, objectType: 'synthetic', objectId: null });
      assert.equal(got, null, `${effect} was refused`);
    }
  });
  assert.equal(await outboxCount(), before, 'no row for any effect');
  assert.equal(await refusals(), beforeRefusals + OUTBOX_EFFECTS.length, 'one audit row each');
});

// ── (c) THE IMPORTED STAGE ─────────────────────────────────────────────────

/** A return the import just created: intake_started, no letter, no estimate, no 8879, no PTIN holder. */
async function freshImportedReturn(): Promise<{ teId: string; contactId: string }> {
  seq++;
  const c = await makeContact(app.db, {
    firstName: 'Imported',
    lastName: `Return${seq}`,
    email: `imported.return${seq}@example.test`,
  });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'tax', '2025 1040', 'active') RETURNING id`,
    [c.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type)
     VALUES ($1, 2025, '1040', 'individual') RETURNING id`,
    [eng.rows[0]!.id]
  );
  return { teId: te.rows[0]!.id, contactId: c.id };
}

const importActor = { staffId: null as string | null, label: IMPORT_LABEL };

test('R16: a card past a gate imports at its mapped stage, with ONE audited attestation', async () => {
  const { teId } = await freshImportedReturn();
  const CARD = 'trello-card-abc123';

  const got = await setImportedStage(app, importActor, {
    taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: CARD, asOf: BUNDLE_DATE,
  });
  assert.equal(got.stage, 'ready_to_file');
  assert.equal(
    got.attestation,
    `Steps before this stage were completed outside SAOS, per Trello card ${CARD}, as of ${BUNDLE_DATE}.`,
    'the attestation says what happened, where, and when — and claims nothing about correctness'
  );
  assert.equal(got.attestation, attestation(CARD, BUNDLE_DATE));

  const { rows } = await app.db.query<{ n: number; line: string }>(
    `SELECT count(*)::int AS n, min(details->>'attestation') AS line
       FROM audit_log WHERE action = 'tax_engagement.imported_at_stage' AND object_id = $1`,
    [teId]
  );
  assert.equal(rows[0]!.n, 1, 'ONE audit row per return, not one per skipped stage');
  assert.equal(rows[0]!.line, got.attestation);
});

test('R16: NO letter, estimate, 8879 or PTIN stamp is written — the position moved, the evidence did not', async () => {
  const { teId } = await freshImportedReturn();
  await setImportedStage(app, importActor, {
    taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: 'trello-card-def456', asOf: BUNDLE_DATE,
  });
  const { rows } = await app.db.query<{
    stage: string; letter: string | null; estimate: string | null; signed: string | null;
    doc: string | null; ptin: string | null; filed: string | null;
  }>(
    `SELECT stage::text AS stage, engagement_letter_signed_at AS letter, estimate_locked_at AS estimate,
            f8879_signed_at AS signed, f8879_document_id AS doc, preparer_ptin_holder_id AS ptin,
            filed_date AS filed
       FROM tax_engagements WHERE id = $1`,
    [teId]
  );
  const r = rows[0]!;
  assert.equal(r.stage, 'ready_to_file', 'the stage is where the work is');
  assert.equal(r.letter, null, 'no engagement letter was signed, and the record says so');
  assert.equal(r.estimate, null, 'no estimate was locked');
  assert.equal(r.signed, null, 'no 8879 signature date');
  assert.equal(r.doc, null, 'no 8879 document');
  assert.equal(r.ptin, null, 'nobody put their PTIN on it');
  assert.equal(r.filed, null, 'it was not filed');
});

test('R16: gates from the imported stage FORWARD apply normally — ready_to_file is refused filed with no 8879', async () => {
  const { teId } = await freshImportedReturn();
  await setImportedStage(app, importActor, {
    taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: 'trello-card-ghi789', asOf: BUNDLE_DATE,
  });
  /*
   * THE PROOF THAT NOTHING WAS WEAKENED, in the order the gates actually fire.
   *
   * FIRST REFUSAL: the engagement letter. Gate 1 in transitionStage guards every target past
   * 'scheduled', so a return the import placed at ready_to_file without a letter is refused for the
   * letter before the 8879 is even looked at. That is worth asserting in its own right — it is the
   * direct consequence of the import having declined to fabricate gate 1, and it is what a preparer
   * will hit on a real imported return.
   */
  const move = () =>
    transitionStage(app, { staffId: ceoId, label: 'Synthetic CEO' }, teId, 'filed', { preparerPtinHolderId: ceoId });
  await assert.rejects(move, (err: unknown) => {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, 'engagement_letter_required', `first gate, got ${e.code}: ${e.message}`);
    return true;
  });

  /*
   * SECOND REFUSAL: the 8879. With a letter and an estimate on file — written HERE, in a synthetic
   * test, which is exactly where such a stamp belongs — the return is refused 'filed' for the one
   * gate that cannot be satisfied by anything but an uploaded scan. This is the assertion the ruling
   * asks for, and reaching it took stamping two facts the import refused to stamp.
   */
  await app.db.query(
    `UPDATE tax_engagements
        SET engagement_letter_signed_at = now(), estimate_locked_at = now(),
            estimated_fee_min_cents = 0, estimated_fee_max_cents = 0
      WHERE id = $1`,
    [teId]
  );
  await assert.rejects(move, (err: unknown) => {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, 'f8879_required', `then the 8879, got ${e.code}: ${e.message}`);
    return true;
  });

  const { rows } = await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [teId]);
  assert.equal(rows[0]!.stage, 'ready_to_file', 'and through both refusals it did not move');
});

test('R16: the import stage-set refuses a return that already has a history in SAOS', async () => {
  const { teId } = await freshImportedReturn();
  await app.db.query(`UPDATE tax_engagements SET engagement_letter_signed_at = now() WHERE id = $1`, [teId]);
  await assert.rejects(
    () => setImportedStage(app, importActor, {
      taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: 'trello-card-jkl012', asOf: BUNDLE_DATE,
    }),
    /not_a_fresh_import|already records/i,
    'this is not a back door for repositioning a live return past a gate it failed'
  );
});

test('R16: an attestation that cites no card and no date is refused', async () => {
  const { teId } = await freshImportedReturn();
  await assert.rejects(
    () => setImportedStage(app, importActor, { taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: '', asOf: BUNDLE_DATE }),
    /attestation_incomplete|attests to nothing/i
  );
  await assert.rejects(
    () => setImportedStage(app, importActor, { taxEngagementId: teId, stage: 'ready_to_file', trelloCardId: 'c1', asOf: '' }),
    /attestation_incomplete|attests to nothing/i
  );
});

test('R16: a stage-gap note travels with the attestation (blocked on business return/financials)', async () => {
  const { teId } = await freshImportedReturn();
  const NOTE = 'Trello: blocked on business return/financials — no blocked stage exists in SAOS.';
  await setImportedStage(app, importActor, {
    taxEngagementId: teId, stage: 'documents_requested', trelloCardId: 'trello-card-mno345', asOf: BUNDLE_DATE, note: NOTE,
  });
  const { rows } = await app.db.query<{ note: string; gap: string }>(
    `SELECT h.note, a.details->>'stage_gap_note' AS gap
       FROM engagement_stage_history h
       JOIN audit_log a ON a.object_id = h.tax_engagement_id::text AND a.action = 'tax_engagement.imported_at_stage'
      WHERE h.tax_engagement_id = $1 AND h.stage = 'documents_requested'`,
    [teId]
  );
  assert.ok(rows[0]!.note.includes(NOTE), 'the stage history carries the note a person reads on the card');
  assert.equal(rows[0]!.gap, NOTE, 'and the audit row records it as a stage gap, not as a stage');
});
