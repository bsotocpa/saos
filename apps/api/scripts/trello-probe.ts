/*
 * THE IMPORT-MODE SABOTAGE PROBE, AS A MODULE (Brian, 2026-09-26, R68).
 *
 * "The importer's sabotage probe runs only on a database whose name ends in _copy; on any other
 * database it refuses before writing."
 *
 * The probe used to be a function inside scripts/trello-import.ts, which runs it once the import is
 * done, unconditionally. The 2026-09-26 day-two report (docs/proposals/2026-09-26-imported-
 * engagement-suppression.md) found that on the production import it would be the sole source of
 * every invoice, filed return and staff alert the import adds: a synthetic is_test contact walked to
 * 'filed' through the real pipeline, with a fee from the price book, so the filed-return factory
 * enqueues an invoice email for the import context to refuse. That measurement belongs on a copy
 * that is about to be dropped and nowhere else.
 *
 * So the probe lives here, importable by the spec, and asks the CONNECTION which database it is on
 * (current_database()) before its first write — not the URL the script was handed, and not the
 * script's own copy guard, which a cutover run will relax. A name that does not end in _copy is a
 * refusal: one line in the run log, nothing written, and the importer's sabotage table says the
 * measurement was not taken. `isCopyDatabaseName` is the predicate; the sabotage manifest removes it.
 *
 * Synthetic by construction: every stamp below lands on a contact this function creates, flagged
 * is_test with a note naming the rehearsal (R16), never on a matched client.
 */
import type { FastifyInstance } from 'fastify';
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { transitionStage, type TaxStage } from '../src/modules/tax/pipeline.ts';
import { recordSigned8879 } from '../src/modules/tax/signed-8879.ts';

/** The one predicate: a copy is a database whose name ends in _copy. */
export function isCopyDatabaseName(name: string): boolean {
  return name.endsWith('_copy');
}

export interface ProbeDeps {
  /** The CEO on the copy: the preparer and PTIN holder the probe's stamps name. */
  ceoId: string;
  /** The labelled session createEngagement wants. */
  actorStaff: AuthedStaff;
  /** The shape transitionStage and recordSigned8879 want. */
  actorLabel: { staffId: string; label: string };
  importLabel: string;
  sourceTag: string;
  appliedBy: string;
}

export interface ProbeOptions {
  /**
   * SPEC ONLY. The database name to judge instead of asking the connection. The importer never
   * passes it; the spec does, to run the body on a spec database and prove the guard sits before
   * the first write.
   */
  databaseNameForSpec?: string;
  log?: (line: string) => void;
}

export type ProbeResult =
  | { refused: true; databaseName: string; reason: string }
  | { refused: false; databaseName: string; delta: number; refusalDelta: number; reached: string };

async function currentDatabase(app: FastifyInstance): Promise<string> {
  const { rows } = await app.db.query<{ name: string }>(`SELECT current_database() AS name`);
  return rows[0]!.name;
}

/**
 * The fee the probe carries, READ FROM THE PRICE BOOK. CLAUDE.md: a price literal in application
 * code is a build failure, and a rehearsal script is application code. The probe needs a fee because
 * invoiceForFiledEngagement only enqueues 'invoice.send' when final_fee_cents is set.
 */
async function probeFeeCents(app: FastifyInstance): Promise<{ cents: number; itemCode: string }> {
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT pbi.item_code, pbi.amount_cents
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
        AND pbi.item_code = 'IND_BASE_SINGLE'
      LIMIT 1`
  );
  if (!rows[0]) throw new Error('refusing: no IND_BASE_SINGLE in the book in force — the probe fee has to come from the price book, never from a literal here.');
  return { cents: rows[0].amount_cents, itemCode: rows[0].item_code };
}

async function counts(app: FastifyInstance): Promise<{ outbox: number; refusals: number }> {
  const one = async (sql: string): Promise<number> => Number((await app.db.query<{ n: string }>(sql)).rows[0]!.n);
  return {
    outbox: await one(`SELECT count(*) AS n FROM outbox`),
    refusals: await one(`SELECT count(*) AS n FROM audit_log WHERE action = 'outbox.refused_in_import'`),
  };
}

/**
 * One probe: a synthetic client, a return carrying a fee, walked to 'filed' through the real
 * pipeline with the real gates satisfied. Returns the outbox delta — or the refusal, before any write.
 */
export async function runImportModeProbe(
  app: FastifyInstance,
  tag: string,
  deps: ProbeDeps,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const databaseName = opts.databaseNameForSpec ?? (await currentDatabase(app));
  if (!isCopyDatabaseName(databaseName)) {
    const reason = `the connection is on '${databaseName}', which does not end in _copy`;
    log(`  probe ${tag} REFUSED before writing: ${reason}. The probe files a synthetic return and raises a real invoice and alert; that runs on a copy about to be dropped and nowhere else.`);
    return { refused: true, databaseName, reason };
  }

  const fee = await probeFeeCents(app);
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, is_test, test_note, source)
     VALUES ($1, $2, $3, 'en', true, $4, 'trello') RETURNING id`,
    [
      'Rehearsal', `Probe ${tag}`, `rehearsal.probe.${tag}@example.invalid`,
      `Import-mode probe, ${deps.importLabel}. Synthetic: the gates below are stamped on THIS record and never on a matched client (R16). The copy is dropped at the end.`,
    ]
  );
  const contactId = contact.rows[0]!.id;
  const parent = await createEngagement(app, deps.actorStaff, {
    contactId, serviceLine: 'tax', title: `2025 1040 (import-mode probe ${tag})`, status: 'active',
    periodKey: '2025',
    origin: { via: 'staff', reason: `import-mode probe ${tag} (${deps.sourceTag})` },
  }, { ip: null, userAgent: `script: ${deps.appliedBy}` });
  const te = await app.db.query<{ id: string }>(
    /*
     * preparer_id IS SET HERE and nowhere else in the import. The pipeline's fourth gate (no return
     * enters in_preparation unassigned) has to be passed to reach 'filed', where the enqueue lives. An
     * imported return does NOT get one: who prepared a Trello return is not a thing the bundle knows.
     */
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, final_fee_cents,
                                  preparer_id, engagement_letter_signed_at, estimate_locked_at,
                                  estimated_fee_min_cents, estimated_fee_max_cents)
     VALUES ($1, 2025, '1040', 'individual', $2, $3, now(), now(), $2, $2) RETURNING id`,
    [parent.id, fee.cents, deps.ceoId]
  );
  const teId = te.rows[0]!.id;
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, tax_year, category, filename, minio_bucket, minio_key, uploaded_by_type, uploaded_by_id, scan_status)
     VALUES ($1, $2, 2025, 'signed_authorizations', $3, 'rehearsal', $4, 'staff', $5, 'clean') RETURNING id`,
    [contactId, teId, `8879-probe-${tag}.pdf`, `rehearsal/probe-${tag}`, deps.ceoId]
  );
  await recordSigned8879(app, deps.actorLabel, {
    taxEngagementId: teId, documentId: doc.rows[0]!.id, signedOn: '2026-04-01', preparerPtinHolderId: deps.ceoId,
  });

  const walk: TaxStage[] = ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'filed'];
  const s0 = await counts(app);
  let reached = 'intake_started';
  for (const to of walk) {
    try {
      await transitionStage(app, deps.actorLabel, teId, to, { note: `import-mode probe ${tag} (${deps.sourceTag})`, preparerPtinHolderId: deps.ceoId });
      reached = to;
    } catch (err) {
      log(`  probe ${tag} blocked entering ${to}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      break;
    }
  }
  const s1 = await counts(app);
  log(`  probe ${tag}: database '${databaseName}', fee ${fee.itemCode} (${fee.cents} cents from the book), reached ${reached}, outbox ${s0.outbox} -> ${s1.outbox}, refusals ${s0.refusals} -> ${s1.refusals}`);
  return { refused: false, databaseName, delta: s1.outbox - s0.outbox, refusalDelta: s1.refusals - s0.refusals, reached };
}
