/*
 * #44 — PAUSING AN ENGAGEMENT, and what a pause costs whom.
 *
 * Brian's ruling: "who caused the pause owns the clock."
 *
 *   · A STAFF pause is our delay. The clock is held — on resume, `waiting_since` moves
 *     forward by the pause duration, and `price_lock_expires_on` extends by the same.
 *   · A DUNNING pause is the client's. Suppress-only: nothing chases them while their work
 *     is paused, but their clock keeps running and the price lock does not move.
 *
 * That asymmetry is the policy, in one sentence: our delays are free to the client, theirs
 * are not.
 *
 * A PAUSE IS NOT AN ENDING, which is why `on_hold` is not terminal and why the client stays
 * `active` through it. `deriveLifecycle` counts an `on_hold` engagement as open for exactly
 * that reason — a client whose work we paused this week has not stopped being a client.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { refreshContactStatus } from '../crm/lifecycle.ts';

export interface PauseActor {
  type: 'staff' | 'system';
  id?: string | null;
  label: string;
}

interface EngagementPauseRow {
  id: string;
  contact_id: string;
  status: string;
  work_paused_at: Date | null;
  work_pause_source: string | null;
  price_lock_expires_on: string | null;
}

async function loadForPause(app: FastifyInstance, engagementId: string): Promise<EngagementPauseRow> {
  const { rows } = await app.db.query<EngagementPauseRow>(
    `SELECT id, contact_id, status::text AS status, work_paused_at, work_pause_source,
            price_lock_expires_on::text AS price_lock_expires_on
       FROM engagements WHERE id = $1`,
    [engagementId]
  );
  const eng = rows[0];
  if (!eng) throw new AppError(404, 'not_found', 'Engagement not found.');
  return eng;
}

/**
 * Put an engagement on hold. Deliberate, permission-gated, reason required.
 *
 * A reason is required here where it is optional on `completed`, for the same argument that
 * makes it required on `withdrawn`: work that is progressing explains itself, and work that
 * STOPPED is the thing someone will have to explain later — most likely to the client
 * asking why nothing has happened.
 */
export async function pauseEngagement(
  app: FastifyInstance,
  engagementId: string,
  input: { reason: string },
  actor: PauseActor
): Promise<{ engagementId: string; contactId: string; pausedAt: string }> {
  const eng = await loadForPause(app, engagementId);

  if (eng.status === 'completed' || eng.status === 'withdrawn') {
    throw new AppError(
      409,
      'already_closed',
      `This engagement is '${eng.status}'. A closed engagement has nothing left to pause.`
    );
  }
  if (eng.work_paused_at) {
    throw new AppError(
      409,
      'already_paused',
      eng.work_pause_source === 'dunning'
        ? 'Work on this engagement is already paused for non-payment. Resolve the overdue invoice rather than holding it a second time.'
        : 'This engagement is already on hold.'
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new AppError(
      400,
      'reason_required',
      'Holding an engagement needs a reason — work that stopped is what the client will ask about.'
    );
  }

  await app.db.query(
    `UPDATE engagements
        SET status = 'on_hold',
            work_paused_at = now(),
            work_pause_reason = $2,
            work_pause_source = 'staff',
            work_paused_by_staff_id = $3
      WHERE id = $1`,
    [engagementId, reason, actor.type === 'staff' ? (actor.id ?? null) : null]
  );

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label,
    action: 'engagement.paused',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: eng.contact_id,
    details: { reason, source: 'staff', previous_status: eng.status },
  });

  /*
   * The client does NOT move. `deriveLifecycle` counts `on_hold` as an open engagement, so
   * this is a no-op that self-heals a stale mirror — called for the same reason #42 made
   * `refreshContactStatus` idempotent rather than conditional.
   */
  await refreshContactStatus(app, eng.contact_id, 'engagement_paused');

  return { engagementId, contactId: eng.contact_id, pausedAt: new Date().toISOString() };
}

/**
 * Lift a staff hold, and give back the time.
 *
 * Refuses a DUNNING pause outright. That pause lifts when the invoice is paid
 * (`resumeAfterPayment`), and letting a staff member click through it here would turn the
 * billing hold into a suggestion — the one consequence in the dunning ladder that has
 * teeth.
 */
export async function resumeEngagement(
  app: FastifyInstance,
  engagementId: string,
  actor: PauseActor
): Promise<{ engagementId: string; contactId: string; pausedDays: number; tasksAdjusted: number }> {
  const eng = await loadForPause(app, engagementId);

  if (!eng.work_paused_at) {
    throw new AppError(409, 'not_paused', 'This engagement is not on hold.');
  }
  if (eng.work_pause_source === 'dunning') {
    throw new AppError(
      409,
      'dunning_pause',
      'Work on this engagement is paused for non-payment, not by a staff hold. It resumes when the overdue invoice is paid.'
    );
  }

  const pausedMs = Date.now() - eng.work_paused_at.getTime();
  const pausedDays = Math.max(0, Math.floor(pausedMs / 86_400_000));

  /*
   * THE CLOCK IS HELD, in the only two places a clock actually runs.
   *
   * `waiting_since` first: the D3/D7/D14/D30 ladder measures from it, so pushing it forward
   * by the pause duration is what makes "the days spent on hold do not count against the
   * client" true rather than stated. Only tasks still waiting are touched — a task the
   * client answered during the pause has no clock left to adjust.
   *
   * The ladder ALSO skips paused engagements outright while the pause is on, because a
   * refund after the fact does not un-send the reminder that went out on day 3.
   */
  const adjusted = await app.db.query(
    `UPDATE tasks
        SET waiting_since = waiting_since + ($2 || ' days')::interval,
            updated_at = now()
      WHERE engagement_id = $1 AND waiting_since IS NOT NULL`,
    [engagementId, String(pausedDays)]
  );

  /*
   * And the price lock, per the ruling: a staff pause extends it by the pause duration.
   * A client cannot lose a price they were promised because we were the ones who stopped.
   * Guarded on NULL — an engagement with no lock has nothing to extend, and
   * `date + integer` on NULL would quietly stay NULL anyway; being explicit says so.
   */
  await app.db.query(
    `UPDATE engagements
        SET status = 'active',
            work_paused_at = NULL,
            work_pause_reason = NULL,
            work_pause_source = NULL,
            work_paused_by_staff_id = NULL,
            price_lock_expires_on = CASE
              WHEN price_lock_expires_on IS NULL THEN NULL
              ELSE price_lock_expires_on + $2::int
            END
      WHERE id = $1`,
    [engagementId, pausedDays]
  );

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label,
    action: 'engagement.resumed',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: eng.contact_id,
    details: {
      paused_days: pausedDays,
      tasks_adjusted: adjusted.rowCount ?? 0,
      price_lock_extended: eng.price_lock_expires_on !== null,
    },
  });

  await refreshContactStatus(app, eng.contact_id, 'engagement_resumed');

  return {
    engagementId,
    contactId: eng.contact_id,
    pausedDays,
    tasksAdjusted: adjusted.rowCount ?? 0,
  };
}
