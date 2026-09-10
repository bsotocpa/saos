// Leads pipeline (M27, v4.4):
//   call_booked → quoted → deposit_paid → onboarding → client   (or lost)
//
// Two rules keep the funnel honest:
//
//  1. AN EXISTING CLIENT IS NEVER DEMOTED INTO THE FUNNEL. Brian quotes extra
//     work to current clients constantly. If that quote set lead_stage back to
//     'quoted' — or worse, to 'lost' when it expired — the conversion numbers
//     would count real clients as open leads and lost deals. Once a contact
//     reaches 'client', quote-driven stage changes are recorded in history and
//     skipped on the contact.
//  2. EVERY STAGE CHANGE APPENDS TO lead_stage_history. Time-in-stage and
//     conversion rates derive from that table, so the funnel is measured, never
//     estimated — same discipline as the deadline table.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import type { AuthedStaff } from '../../types.ts';

export type LeadStage = 'call_booked' | 'quoted' | 'deposit_paid' | 'onboarding' | 'client' | 'lost';

/** Forward order of the funnel. 'lost' sits outside it — it is an exit, not a rung. */
export const STAGE_ORDER: readonly LeadStage[] = [
  'call_booked',
  'quoted',
  'deposit_paid',
  'onboarding',
  'client',
] as const;

export function stageRank(stage: LeadStage): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? -1 : i;
}

/**
 * Move a contact's pipeline stage. Returns whether the contact row actually
 * moved — history is appended either way, so a skipped move is still visible.
 */
export async function setLeadStage(
  app: FastifyInstance,
  contactId: string,
  stage: LeadStage,
  actor: AuthedStaff | null,
  note: string | null = null
): Promise<{ moved: boolean; from: LeadStage | null; reason?: string }> {
  const { rows } = await app.db.query<{ lead_stage: LeadStage | null }>(
    `SELECT lead_stage FROM contacts WHERE id = $1`,
    [contactId]
  );
  if (rows.length === 0) return { moved: false, from: null, reason: 'contact_not_found' };
  const from = rows[0]!.lead_stage;

  // Rule 1: an existing client stays a client.
  const isDemotionFromClient = from === 'client' && stage !== 'client';
  // Backwards inside the funnel (e.g. a re-quote after deposit) is also noise.
  const isBackwards =
    from !== null &&
    from !== 'lost' &&
    stageRank(stage) !== -1 &&
    stageRank(from) > stageRank(stage);

  const skip = isDemotionFromClient || isBackwards;

  await app.db.query(
    `INSERT INTO lead_stage_history (contact_id, stage, note, changed_by_staff_id)
     VALUES ($1, $2, $3, $4)`,
    [
      contactId,
      stage,
      skip ? `${note ?? stage} (recorded only — contact stays '${from}')` : note,
      actor?.id ?? null,
    ]
  );

  if (skip) {
    return {
      moved: false,
      from,
      reason: isDemotionFromClient ? 'already_client' : 'backwards',
    };
  }

  await app.db.query(
    `UPDATE contacts
     SET lead_stage = $2,
         lead_stage_at = now(),
         lost_reason = CASE WHEN $2::lead_stage = 'lost' THEN lost_reason ELSE NULL END
     WHERE id = $1`,
    [contactId, stage]
  );
  await writeAudit(app.db, {
    actorType: actor ? 'staff' : 'system',
    actorId: actor?.id ?? null,
    actorLabel: actor?.fullName ?? 'pipeline',
    action: 'lead.stage_changed',
    objectType: 'contact',
    objectId: contactId,
    contactId,
    details: { from, to: stage, note },
  });
  return { moved: true, from };
}

export interface PipelineMetrics {
  byStage: Array<{ stage: LeadStage; count: number }>;
  quotesSent: number;
  quotesAccepted: number;
  quotesDeclined: number;
  quotesExpired: number;
  quotesOpen: number;
  /** Accepted ÷ decided (accepted + declined + expired). Null until a quote is decided. */
  winRatePercent: number | null;
  acceptedValueCents: number;
  openValueCents: number;
  medianDaysToDecision: number | null;
  lostReasons: Array<{ reason: string; count: number }>;
}

/**
 * Conversion metrics for the pipeline board. Win rate is measured against
 * DECIDED quotes only — counting still-open quotes as losses would make every
 * fresh quote look like a failure.
 */
export async function pipelineMetrics(app: FastifyInstance): Promise<PipelineMetrics> {
  // NOT is_archived matters as much as NOT is_test: archiving a lead is how Brian
  // says "this will never convert", and a lead that will never convert must leave
  // the conversion numbers. Reports and the Executive dashboard already filtered
  // it; this query did not.
  const stages = await app.db.query<{ stage: LeadStage; count: number }>(
    `SELECT lead_stage AS stage, count(*)::int AS count
     FROM contacts WHERE lead_stage IS NOT NULL AND NOT is_test AND NOT is_archived
     GROUP BY lead_stage`
  );
  const byStage = STAGE_ORDER.concat('lost').map((stage) => ({
    stage,
    count: stages.rows.find((r) => r.stage === stage)?.count ?? 0,
  }));

  const q = await app.db.query<{
    sent: number; accepted: number; declined: number; expired: number; open: number;
    accepted_value: number; open_value: number; median_days: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE sent_at IS NOT NULL)::int                     AS sent,
       count(*) FILTER (WHERE status = 'accepted')::int                     AS accepted,
       count(*) FILTER (WHERE status = 'declined')::int                     AS declined,
       count(*) FILTER (WHERE status = 'expired')::int                      AS expired,
       count(*) FILTER (WHERE status = 'sent')::int                         AS open,
       COALESCE(sum(total_cents) FILTER (WHERE status = 'accepted'), 0)::int AS accepted_value,
       COALESCE(sum(total_cents) FILTER (WHERE status = 'sent'), 0)::int     AS open_value,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (COALESCE(accepted_at, declined_at) - sent_at)) / 86400.0
       ) FILTER (WHERE sent_at IS NOT NULL AND COALESCE(accepted_at, declined_at) IS NOT NULL)
                                                                            AS median_days
     -- These are MEASUREMENT numbers, so they exclude test and archived clients
     -- exactly as the stage counts above do. They used to read FROM quotes with no
     -- join at all, which is how one rehearsal quote showed as an open quote with
     -- its value in the pipeline header while the stage columns beside it correctly
     -- showed zero — the same screen disagreeing with itself, and a rehearsal
     -- win or loss moving the real win rate.
     FROM quotes q JOIN contacts c ON c.id = q.contact_id
     -- 'void' = withdrawn by us (duplicate/error). Never a proposal, so it is
     -- neither sent, open, won nor lost — excluded outright rather than
     -- misfiled as a client decline.
     WHERE NOT c.is_test AND NOT c.is_archived AND q.status <> 'void'`
  );
  const r = q.rows[0]!;
  const decided = r.accepted + r.declined + r.expired;

  const lost = await app.db.query<{ reason: string; count: number }>(
    `SELECT COALESCE(q.decline_reason, 'no response') AS reason, count(*)::int AS count
     FROM quotes q JOIN contacts c ON c.id = q.contact_id
     WHERE q.status IN ('declined', 'expired') AND NOT c.is_test AND NOT c.is_archived
     GROUP BY 1 ORDER BY 2 DESC, 1`
  );

  return {
    byStage,
    quotesSent: r.sent,
    quotesAccepted: r.accepted,
    quotesDeclined: r.declined,
    quotesExpired: r.expired,
    quotesOpen: r.open,
    winRatePercent: decided === 0 ? null : Math.round((r.accepted / decided) * 1000) / 10,
    acceptedValueCents: r.accepted_value,
    openValueCents: r.open_value,
    medianDaysToDecision:
      r.median_days === null ? null : Math.round(Number(r.median_days) * 10) / 10,
    lostReasons: lost.rows,
  };
}

/** The pipeline board: leads grouped by stage with their newest quote. */
export async function pipelineBoard(app: FastifyInstance) {
  const { rows } = await app.db.query(
    // The BOARD is operations, not measurement: "excluded from measurement,
    // visible in operations". A test client must be workable here — a rehearsal you
    // cannot see is not a rehearsal — so it is INCLUDED and flagged, while every
    // number in pipelineMetrics excludes it. Archived leads stay hidden: archiving
    // means "stop working this".
    `SELECT c.id, c.first_name, c.last_name, c.email, c.lead_stage::text AS lead_stage,
            c.lead_stage_at, c.lost_reason, c.language, c.is_test,
            q.id AS quote_id, q.status::text AS quote_status, q.total_cents,
            q.range_min_cents, q.range_max_cents, q.sent_at, q.expires_at
     FROM contacts c
     LEFT JOIN LATERAL (
       SELECT id, status, total_cents, range_min_cents, range_max_cents, sent_at, expires_at
       FROM quotes WHERE contact_id = c.id ORDER BY created_at DESC LIMIT 1
     ) q ON true
     WHERE c.lead_stage IS NOT NULL AND c.lead_stage <> 'client'
       AND NOT c.is_archived
     ORDER BY c.lead_stage, c.lead_stage_at DESC NULLS LAST`
  );
  return rows;
}
