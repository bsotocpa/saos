/*
 * CLOSING AN ENGAGEMENT (#44).
 *
 * `engagement_status` has had `completed` and `withdrawn` since the schema was written and
 * NOTHING ever set either one. So an engagement went active and stayed active forever —
 * which is why #42's `active → dormant` transition had to ride on the health sweep, and
 * why a finished return sat inside a permanently open engagement.
 *
 * §4 first, per Brian's build order, because it is the half that is already wrong rather
 * than merely missing: `recordEfileAcceptance` moves a return to `completed` and nothing
 * hears it. The first client whose return the IRS accepts would have had a finished return
 * inside an active engagement, showing as an active client — the same untruth as #42's
 * "lead", one level down.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { refreshContactStatus } from '../crm/lifecycle.ts';

export type CloseOutcome = 'completed' | 'withdrawn';

/**
 * Tax stages that mean "this return needs nothing further".
 *
 * `rejected` is deliberately NOT here — a rejected return re-queues with a perfection
 * clock and is very much still open work. `on_hold` is not here either: a pause is not an
 * ending, which is the same rule the engagement states follow.
 */
const TERMINAL_TAX_STAGES = ['completed', 'withdrawn'] as const;

/**
 * Close an engagement. Refuses if it is already terminal, so a second click cannot
 * silently overwrite the outcome or the date someone recorded.
 *
 * A reason is REQUIRED on `withdrawn` and optional on `completed`: work that was delivered
 * explains itself, work that ended without delivering does not, and the missing "why" is
 * exactly what someone needs a year later. The database enforces this too — the service
 * refusing is a better error message, not the guarantee.
 */
export async function closeEngagement(
  app: FastifyInstance,
  engagementId: string,
  input: { outcome: CloseOutcome; reason?: string | null; endedOn?: string | null },
  actor: { type: 'staff' | 'system'; id?: string | null; label: string }
): Promise<{ engagementId: string; contactId: string; outcome: CloseOutcome }> {
  const { rows } = await app.db.query<{ id: string; contact_id: string; status: string; service_line: string }>(
    `SELECT id, contact_id, status::text AS status, service_line::text AS service_line
       FROM engagements WHERE id = $1`,
    [engagementId]
  );
  const eng = rows[0];
  if (!eng) throw new AppError(404, 'not_found', 'Engagement not found.');
  if (eng.status === 'completed' || eng.status === 'withdrawn') {
    throw new AppError(
      409,
      'already_closed',
      `This engagement was already closed as '${eng.status}'. Re-opening is a new engagement, because the work someone agreed to is the work that was quoted.`
    );
  }
  if (input.outcome === 'withdrawn' && !input.reason?.trim()) {
    throw new AppError(
      400,
      'reason_required',
      'Withdrawing needs a reason — work that ended without being delivered is the case someone will have to explain later.'
    );
  }

  await app.db.query(
    `UPDATE engagements
        SET status = $2::engagement_status,
            ended_on = COALESCE($3::date, CURRENT_DATE),
            close_reason = $4
      WHERE id = $1`,
    [engagementId, input.outcome, input.endedOn ?? null, input.reason?.trim() ?? null]
  );

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label,
    action: 'engagement.closed',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: eng.contact_id,
    details: { outcome: input.outcome, reason: input.reason ?? null, service_line: eng.service_line },
  });

  /*
   * This is where `active → dormant` actually comes from now. The health sweep still runs
   * the same recompute, but it was a stand-in for an event that did not exist — an event
   * that fires the moment the last engagement closes is the honest version.
   */
  await refreshContactStatus(app, eng.contact_id, 'engagement_closed');

  return { engagementId, contactId: eng.contact_id, outcome: input.outcome };
}

/**
 * #44 §4 — a return reaching its terminal stage may finish the engagement that holds it.
 *
 * Only when EVERY return under that engagement is terminal. A client with a 2024 and a
 * 2025 return on one engagement is not finished when the first is accepted, and closing on
 * the first acceptance would be worse than never closing: it would report work as done
 * while a return is still open.
 *
 * Silent when there is nothing to do. This runs inside the acceptance path, and an
 * engagement with returns still open is the ordinary case rather than a problem.
 */
export async function closeEngagementIfAllReturnsDone(
  app: FastifyInstance,
  taxEngagementId: string,
  actor: { type: 'staff' | 'system'; id?: string | null; label: string }
): Promise<{ closed: boolean; engagementId: string | null }> {
  const { rows } = await app.db.query<{ engagement_id: string; open_returns: number; status: string }>(
    `SELECT te.engagement_id,
            (SELECT count(*)::int FROM tax_engagements sib
              WHERE sib.engagement_id = te.engagement_id
                AND sib.stage <> ALL($2::tax_stage[])) AS open_returns,
            e.status::text AS status
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
      WHERE te.id = $1`,
    [taxEngagementId, [...TERMINAL_TAX_STAGES]]
  );
  const row = rows[0];
  if (!row) return { closed: false, engagementId: null };
  if (row.open_returns > 0) return { closed: false, engagementId: row.engagement_id };
  // Already closed by hand, or withdrawn — leave whatever a person decided alone.
  if (row.status === 'completed' || row.status === 'withdrawn') {
    return { closed: false, engagementId: row.engagement_id };
  }

  await closeEngagement(
    app,
    row.engagement_id,
    {
      outcome: 'completed',
      reason: 'Every return on this engagement is filed and accepted.',
      endedOn: todayChicago(),
    },
    actor
  );
  return { closed: true, engagementId: row.engagement_id };
}
