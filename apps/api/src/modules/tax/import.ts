/*
 * IMPORTING A RETURN THAT IS ALREADY PAST A GATE (Brian, 2026-09-20, ruling R16).
 *
 * ── THE PROBLEM THIS SOLVES ──
 *
 * A Trello card says "awaiting signature". In SAOS that is `ready_to_file`, four gated transitions
 * past `intake_started`: the engagement letter (gate 1), the locked estimate (gate 2), and the
 * stages in between. None of those facts exists in SAOS for this client, because the work happened
 * in Trello and a filing cabinet. So `transitionStage` refuses, correctly, and there are exactly
 * two ways past it:
 *
 *   1. STAMP THE GATES. Write an engagement_letter_signed_at, an estimate_locked_at, an
 *      f8879_signed_at, a PTIN holder. The return then walks the pipeline like any other.
 *   2. SET THE STAGE, ATTEST TO WHY.
 *
 * Option 1 is what the 2026-09-19 rehearsal did, on a copy, to measure the outbox — and every one
 * of those stamps is a lie about a compliance record. An engagement_letter_signed_at timestamp
 * means a client signed a letter on that day. An f8879_signed_at with a document id means a scan of
 * a wet-signed authorization is on file. Writing either one because a Trello list was named
 * "awaiting signature" fabricates the evidence that the gate exists to require, on a real client's
 * real return, in an append-only audit trail. R16 forbids it: "no fabricated letter, estimate, 8879
 * or PTIN stamp on real records; a card past a gate imports at its stage with one audited
 * attestation."
 *
 * ── SO THE STAGE MOVES AND THE FACTS DO NOT ──
 *
 * `setImportedStage` writes ONE column — `stage` — plus a stage-history row and ONE audit row
 * carrying the attestation. It never touches engagement_letter_signed_at, estimate_locked_at,
 * f8879_signed_at, f8879_document_id, preparer_ptin_holder_id or filed_date. After the import the
 * return is honest in both directions: it sits where the work actually is, and every gate fact
 * still reads "we do not have this", because we do not.
 *
 * THE DISTINCTION THAT MAKES THIS LEGITIMATE. A stage is a POSITION in our workflow. The gate facts
 * are EVIDENCE. Moving a position with an attestation that says where the evidence lives is
 * bookkeeping; writing the evidence is forgery. CLAUDE.md's rule that nothing but the uploaded scan
 * may stamp the 8879 is untouched here, and deliberately: this module writes no authorization at all.
 *
 * ── AND GATES FROM HERE FORWARD APPLY NORMALLY ──
 *
 * This is not a back door into `filed`. The import sets the stage ONCE, on a freshly created return
 * (asserted below — a return that already carries gate facts is refused, so this can never be used
 * to reposition a live return past a gate it failed). Every move AFTERWARDS goes through
 * `transitionStage`, gates and all. An imported return sitting at `ready_to_file` is refused `filed`
 * until a wet-signed 8879 is scanned and uploaded, exactly like one that started at intake — and
 * that refusal is the proof this module did not weaken anything. It is asserted in
 * test/import-mode.spec.ts and on the rehearsal copy.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { TAX_STAGES, type TaxStage } from './pipeline.ts';

/** The columns this module must never write, and the reason each one is evidence rather than position. */
const GATE_FACTS = [
  ['engagement_letter_signed_at', 'a client signed an engagement letter on a day'],
  ['estimate_locked_at', 'a fee range was locked and quoted'],
  ['f8879_signed_at', 'a wet-signed e-file authorization exists'],
  ['f8879_document_id', 'a scan of that authorization is on file'],
  ['preparer_ptin_holder_id', 'a named PTIN holder took responsibility for the filing'],
  ['filed_date', 'the return went out the door on a day'],
] as const;

export interface ImportedStageInput {
  taxEngagementId: string;
  /** The stage the Trello card's list maps to (item 12's stage map). */
  stage: TaxStage;
  /** The card the attestation cites, so a person can go and read the source. */
  trelloCardId: string;
  /** The bundle's own as-of date — NOT today. The facts are as stale as the export. */
  asOf: string;
  /** A stage-gap note, where the map has one ("blocked on business return/financials"). */
  note?: string | undefined;
}

/**
 * The sentence written into the audit row, verbatim.
 *
 * It says three things and no more: that the earlier steps happened, that they happened somewhere
 * else, and where to look. It does not say the steps were DONE CORRECTLY, because nobody in SAOS
 * checked — and a wording that implied otherwise would be the same fabrication in prose.
 */
export function attestation(trelloCardId: string, asOf: string): string {
  return `Steps before this stage were completed outside SAOS, per Trello card ${trelloCardId}, as of ${asOf}.`;
}

/**
 * Put an imported return at its mapped stage, with one audited attestation.
 *
 * Refuses a return that already carries any gate fact: this is for a return created moments ago by
 * the import and nothing else. That check is what keeps the function from being a way to move a
 * live return past a gate it genuinely failed.
 */
export async function setImportedStage(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  input: ImportedStageInput
): Promise<{ stage: TaxStage; attestation: string }> {
  if (!TAX_STAGES.includes(input.stage)) {
    throw new AppError(400, 'unknown_stage', `'${input.stage}' is not a tax stage.`);
  }
  if (!input.trelloCardId.trim() || !input.asOf.trim()) {
    throw new AppError(
      400,
      'attestation_incomplete',
      'An imported stage needs the card it came from and the date the bundle was true. An attestation that cites nothing attests to nothing.'
    );
  }

  const { rows } = await app.db.query<
    Record<string, unknown> & { id: string; stage: TaxStage; contact_id: string }
  >(
    `SELECT te.id, te.stage, te.engagement_letter_signed_at, te.estimate_locked_at,
            te.f8879_signed_at, te.f8879_document_id, te.preparer_ptin_holder_id, te.filed_date,
            e.contact_id
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE te.id = $1`,
    [input.taxEngagementId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');

  /*
   * A FRESH RETURN ONLY. If any evidence column is already filled, this return has a history in
   * SAOS and its stage is the pipeline's business, not the importer's.
   */
  const held = GATE_FACTS.filter(([column]) => row[column] !== null && row[column] !== undefined);
  if (held.length > 0) {
    throw new AppError(
      409,
      'not_a_fresh_import',
      `Refusing: this return already records ${held.map(([, what]) => what).join(', ')}. ` +
        `The import stage-set is for a return created by the import and nothing else; moving a ` +
        `return that has a history in SAOS goes through the gated transition.`
    );
  }
  if (row.stage !== 'intake_started') {
    throw new AppError(
      409,
      'not_a_fresh_import',
      `Refusing: this return is already at '${row.stage}'. The import sets a stage once, on a return that has not moved.`
    );
  }

  const line = attestation(input.trelloCardId, input.asOf);

  /*
   * ONE COLUMN. Spelled out rather than built from a set, so a future edit that adds a second column
   * here has to be written by hand and read by a reviewer.
   */
  await app.db.query(`UPDATE tax_engagements SET stage = $2::tax_stage WHERE id = $1`, [
    input.taxEngagementId,
    input.stage,
  ]);
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, $2::tax_stage, $3, 'staff', $4)`,
    [input.taxEngagementId, input.stage, actor.staffId, input.note ? `${line} ${input.note}` : line]
  );
  /*
   * ONE AUDIT ROW PER RETURN (R16). Not one per skipped stage: the attestation is a single statement
   * about a single record, and five rows saying it would read as five separate claims.
   */
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.imported_at_stage',
    objectType: 'tax_engagement',
    objectId: input.taxEngagementId,
    contactId: row.contact_id,
    details: {
      attestation: line,
      stage: input.stage,
      trello_card_id: input.trelloCardId,
      as_of: input.asOf,
      ...(input.note ? { stage_gap_note: input.note } : {}),
      gates_not_stamped: GATE_FACTS.map(([column]) => column),
    },
  });

  return { stage: input.stage, attestation: line };
}
