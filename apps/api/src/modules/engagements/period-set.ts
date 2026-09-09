/*
 * Setting a legacy engagement's period (decision 1, 2026-09-09).
 *
 * Migration 0083 added period_key and refused to guess it for existing rows. Brian ruled the
 * four active legacy rows are tax year 2025. This is the one door for that: a person, a
 * reason, an audit row, and the partial unique index as the judge — if another active
 * engagement already holds that (contact, line, period), the UPDATE is refused and the
 * refusal is the answer (withdraw or supersede the other one first).
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

export async function setEngagementPeriod(
  app: FastifyInstance,
  engagementId: string,
  input: { periodKey: string; reason: string },
  actor: { type: 'staff' | 'system'; id?: string | null; label: string }
): Promise<{ engagementId: string; periodKey: string; previous: string | null }> {
  const { rows } = await app.db.query<{ id: string; contact_id: string; status: string; period_key: string | null; service_line: string }>(
    `SELECT id, contact_id, status::text AS status, period_key, service_line::text AS service_line FROM engagements WHERE id = $1`,
    [engagementId]
  );
  const eng = rows[0];
  if (!eng) throw new AppError(404, 'not_found', 'Engagement not found.');
  try {
    await app.db.query(`UPDATE engagements SET period_key = $2 WHERE id = $1`, [engagementId, input.periodKey]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new AppError(
        409,
        'engagement_exists',
        `Another active ${eng.service_line} engagement already holds period ${input.periodKey} for this client. Withdraw or supersede it first.`
      );
    }
    throw err;
  }
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label,
    action: 'engagement.period_set',
    objectType: 'engagement',
    objectId: engagementId,
    contactId: eng.contact_id,
    details: { previous: eng.period_key, period_key: input.periodKey, reason: input.reason },
  });
  return { engagementId, periodKey: input.periodKey, previous: eng.period_key };
}
