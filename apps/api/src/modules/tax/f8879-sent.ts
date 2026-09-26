/*
 * THE 8879 SENT FOR SIGNATURE (Brian, 2026-09-26, R53).
 *
 * "Remote clients sign Form 8879 through Adobe Sign, outside SAOS. Add 'Record 8879 sent' on the
 * return: method (Adobe Sign, in office, mailed) and date sent. No Adobe integration, no send from
 * SAOS."
 *
 * So this module RECORDS a fact about something that happened elsewhere, and does nothing else: it
 * sends nothing, it calls no vendor, and it does not touch the 8879 gate (the signed scan on file,
 * signed-8879.ts) in either direction. What it gives the rest of the system is a state between
 * "delivered to the client" and "the signed 8879 is on file":
 *
 *   the R50 stepper shows it as its own step, between those two;
 *   the preparer queue reads a return in this state as "awaiting signature (<method>, sent <day>)";
 *   the portal's "what happens next" block (R48) will read the method to tell the client where to
 *   look — the Adobe Sign email, the visit, the mail.
 *
 * WHEN IT MAY BE RECORDED. Once the return is at delivered (client_review) or later, because a form
 * is sent for signature after the client has the return, and only while no signed 8879 is on file,
 * because after that there is nothing to await. Both refused by name.
 *
 * THE DAY. A calendar day, said by the person, never after today in Chicago — the same rule every
 * other recorded day on the return holds to (filed on, mailed on, signed on).
 *
 * A LATER RECORD REPLACES THE EARLIER ONE. The columns hold the current state; the audit row carries
 * what it replaced, so the history is in the log and the return says one thing. Brian ruled a
 * history table unnecessary here.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { calendarDay, todayChicago } from './deadlines.ts';
import type { TaxStage } from './pipeline.ts';

export const F8879_SENT_METHODS = ['adobe_sign', 'in_office', 'mailed'] as const;
export type F8879SentMethod = (typeof F8879_SENT_METHODS)[number];

/**
 * The stages at or past "delivered to the client". Listed rather than derived from the pipeline's
 * private ORDER so this module owns its own rule: a return that has been delivered, is ready to
 * file, or has been filed and bounced can be awaiting a signature; one still being prepared cannot.
 * `completed` is here because an imported return can reach it with no 8879 on file — the on-file
 * check below is what refuses the ordinary completed return.
 */
const AT_OR_PAST_DELIVERED: ReadonlySet<string> = new Set<TaxStage>(['client_review', 'ready_to_file', 'filed', 'rejected', 'completed']);

export interface F8879SentRecord {
  method: F8879SentMethod | null;
  sentOn: string;
  recordedAt: Date;
  recordedBy: string | null;
  declaredByImport: boolean;
}

interface Row {
  id: string;
  stage: TaxStage;
  contact_id: string;
  f8879_document_id: string | null;
  f8879_sent_method: F8879SentMethod | null;
  f8879_sent_on: string | null;
  f8879_sent_declared_by_import: boolean;
}

async function loadRow(app: FastifyInstance, taxEngagementId: string): Promise<Row> {
  const { rows } = await app.db.query<Row>(
    `SELECT te.id, te.stage, e.contact_id, te.f8879_document_id,
            te.f8879_sent_method, te.f8879_sent_on::text AS f8879_sent_on, te.f8879_sent_declared_by_import
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE te.id = $1`,
    [taxEngagementId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  return row;
}

/** The two refusals both doors share: not before delivery, not after the signed 8879 is on file. */
function assertAwaitable(row: Row): void {
  if (!AT_OR_PAST_DELIVERED.has(row.stage)) {
    throw new AppError(
      409,
      'f8879_sent_before_delivery',
      `The return is at '${row.stage}'; the 8879 is sent for signature once the return has been delivered to the client.`
    );
  }
  if (row.f8879_document_id) {
    throw new AppError(
      409,
      'f8879_already_on_file',
      'A signed 8879 is already on file for this return; there is nothing left to send for signature.'
    );
  }
}

/**
 * Record that the 8879 went to the client, by a person, with the method and the day. Replaces an
 * earlier record; the audit row names what it replaced.
 */
export async function record8879Sent(
  app: FastifyInstance,
  actor: { staffId: string; label: string; ip?: string | null; userAgent?: string | null },
  taxEngagementId: string,
  input: { method: F8879SentMethod; sentOn: string }
): Promise<F8879SentRecord> {
  if (!F8879_SENT_METHODS.includes(input.method)) {
    throw new AppError(400, 'f8879_sent_method_unknown', `'${input.method}' is not a way the 8879 reaches a client (Adobe Sign, in office, mailed).`);
  }
  const day = calendarDay(input.sentOn, 'sentOn');
  const today = calendarDay(todayChicago(), 'today');
  if (day > today) {
    throw new AppError(409, 'f8879_sent_in_future', `The sent date ${day} is after today; the 8879 is recorded as sent after it goes out, not before.`);
  }
  const row = await loadRow(app, taxEngagementId);
  assertAwaitable(row);

  const replaced = row.f8879_sent_on
    ? { method: row.f8879_sent_method, sent_on: row.f8879_sent_on, declared_by_import: row.f8879_sent_declared_by_import }
    : null;
  const { rows } = await app.db.query<{ f8879_sent_recorded_at: Date }>(
    `UPDATE tax_engagements
        SET f8879_sent_method = $2::f8879_sent_method,
            f8879_sent_on = $3::date,
            f8879_sent_recorded_by = $4,
            f8879_sent_recorded_at = now(),
            f8879_sent_declared_by_import = false
      WHERE id = $1
      RETURNING f8879_sent_recorded_at`,
    [taxEngagementId, input.method, day, actor.staffId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.staffId, actorLabel: actor.label,
    action: 'tax_engagement.f8879_sent_recorded', objectType: 'tax_engagement', objectId: taxEngagementId,
    contactId: row.contact_id, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
    details: { method: input.method, sent_on: day, replaced },
  });
  return { method: input.method, sentOn: day, recordedAt: rows[0]!.f8879_sent_recorded_at, recordedBy: actor.staffId, declaredByImport: false };
}

/**
 * THE IMPORT'S DECLARATION (R53 with R16). A Trello card that said "awaiting signature" says the
 * 8879 went to the client and nothing about how; the import records the day the bundle was true
 * with NO method and the declared_by_import flag, under the one attestation the stage set already
 * wrote. The same door's refusals apply: the return must be at delivered or later and hold no 8879.
 * Never a method invented — "in office" would be a claim about how a client was reached that nobody
 * made.
 */
export async function declareImported8879Sent(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  input: { taxEngagementId: string; trelloCardId: string; asOf: string }
): Promise<F8879SentRecord> {
  if (!input.trelloCardId.trim() || !input.asOf.trim()) {
    throw new AppError(400, 'attestation_incomplete', 'An import-declared 8879 sent record needs the card it came from and the date the bundle was true.');
  }
  const day = calendarDay(input.asOf, 'asOf');
  const row = await loadRow(app, input.taxEngagementId);
  assertAwaitable(row);
  if (row.f8879_sent_on) {
    throw new AppError(409, 'f8879_sent_already_recorded', 'This return already records the 8879 as sent; the import declares it once, on a fresh return.');
  }
  const { rows } = await app.db.query<{ f8879_sent_recorded_at: Date }>(
    `UPDATE tax_engagements
        SET f8879_sent_method = NULL,
            f8879_sent_on = $2::date,
            f8879_sent_recorded_by = $3,
            f8879_sent_recorded_at = now(),
            f8879_sent_declared_by_import = true
      WHERE id = $1
      RETURNING f8879_sent_recorded_at`,
    [input.taxEngagementId, day, actor.staffId]
  );
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system', actorId: actor.staffId, actorLabel: actor.label,
    action: 'tax_engagement.f8879_sent_declared_by_import', objectType: 'tax_engagement', objectId: input.taxEngagementId,
    contactId: row.contact_id,
    details: {
      sent_on: day, method: null, declared_by: 'import',
      note: 'The Trello card said awaiting signature and nothing about how the 8879 reached the client; the method is left unsaid rather than invented.',
      trello_card_id: input.trelloCardId, as_of: input.asOf,
    },
  });
  return { method: null, sentOn: day, recordedAt: rows[0]!.f8879_sent_recorded_at, recordedBy: actor.staffId, declaredByImport: true };
}

/** What GET /tax-engagements/:id and the queue print: the record as a person reads it, or null. */
export function f8879SentView(te: {
  f8879_sent_method: F8879SentMethod | null; f8879_sent_on: string | null;
  f8879_sent_recorded_at: Date | string | null; f8879_sent_recorded_by: string | null; f8879_sent_declared_by_import: boolean;
}, recordedByName: string | null = null): {
  method: F8879SentMethod | null; sent_on: string; recorded_at: Date | string | null; recorded_by: string | null; recorded_by_name: string | null; declared_by_import: boolean;
} | null {
  if (!te.f8879_sent_on) return null;
  return {
    method: te.f8879_sent_method,
    sent_on: te.f8879_sent_on,
    recorded_at: te.f8879_sent_recorded_at,
    recorded_by: te.f8879_sent_recorded_by,
    recorded_by_name: recordedByName,
    declared_by_import: te.f8879_sent_declared_by_import,
  };
}

/** "Adobe Sign", "in office", "mailed" — one place for the words, shared by the queue and the audit reader. */
export const F8879_SENT_METHOD_LABEL: Record<F8879SentMethod, string> = {
  adobe_sign: 'Adobe Sign',
  in_office: 'in office',
  mailed: 'mailed',
};
