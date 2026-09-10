// Engagement creation + the ATTEST INDEPENDENCE CHECK (CLAUDE.md hard rule,
// MP v4.2 Service Delivery Model): the system blocks creating a CPA
// review/audit engagement for any client with active Soto bookkeeping/
// payroll/management services, absent Brian's documented override.
// Cristian's attest work stays walled from firm-prepared books.

import type { FastifyInstance } from 'fastify';
import { isOneActivePerPeriodViolation } from './period.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import type { AuthedStaff } from '../../types.ts';

// Service lines that impair independence for attest work. Deliberately broad
// (management functions included) — blocking more is safe because the
// documented-override path exists; narrowing is Brian's call.
const INDEPENDENCE_CONFLICT_LINES = ['bookkeeping', 'payroll', 'sales_tax', 'coo', 'nonprofit_cfo'] as const;

export interface CreateEngagementInput {
  contactId: string;
  /**
   * The period this engagement covers (engagements/period.ts): the tax year, 'ongoing', or
   * null for per-matter lines and legacy rows. Non-null puts it under the one-active-per-line-
   * period unique index (migration 0083).
   */
  periodKey?: string | null | undefined;
  businessId?: string | undefined;
  serviceLine:
    | 'tax'
    | 'bookkeeping'
    | 'payroll'
    | 'sales_tax'
    | 'advisory'
    | 'coo'
    | 'entity'
    | 'attest'
    | 'specialized_cpa'
    | 'nonprofit_cfo';
  title?: string | undefined;
  leadStaffId?: string | undefined;
  status?: 'draft' | 'active' | undefined;
  /** Attest only: Brian's documented independence override. */
  independenceOverrideNote?: string | undefined;
}

async function currentPriceBookVersionId(app: FastifyInstance): Promise<string | null> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

export async function createEngagement(
  app: FastifyInstance,
  actor: AuthedStaff,
  input: CreateEngagementInput,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ id: string; independenceOverridden: boolean }> {
  let independenceOverridden = false;

  if (input.serviceLine === 'attest') {
    /*
     * `on_hold` COUNTS, and this is the reason the pause work had to touch this file.
     *
     * Independence is about the RELATIONSHIP, not about whether we happen to be working
     * this week. Reading only `active` would mean pausing a bookkeeping engagement makes
     * the conflict disappear — a compliance gate anyone could walk around by holding the
     * engagement for a day, which is the opposite of what a gate is for.
     */
    const conflicts = await app.db.query<{ id: string; service_line: string; title: string | null }>(
      `SELECT id, service_line, title FROM engagements
       WHERE contact_id = $1 AND status IN ('active', 'on_hold')
         AND service_line = ANY($2::service_line[])`,
      [input.contactId, [...INDEPENDENCE_CONFLICT_LINES]]
    );

    if (conflicts.rows.length > 0) {
      if (!input.independenceOverrideNote) {
        throw new AppError(
          409,
          'independence_conflict',
          `Independence conflict: this client has active ${conflicts.rows
            .map((c) => c.service_line)
            .join(', ')} service(s) at Soto. An attest engagement requires Brian's documented override — or refer the attest work out.`
        );
      }
      // The override is Brian's alone (MP: "Brian's explicit documented override").
      if (actor.roleKey !== 'ceo') {
        throw new AppError(
          403,
          'independence_override_requires_ceo',
          'Only Brian (CEO) may override the attest independence check.'
        );
      }
      independenceOverridden = true;
    }
  }

  const versionId = await currentPriceBookVersionId(app);
  let rows: Array<{ id: string }>;
  try {
    rows = (await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, business_id, service_line, status, title, lead_staff_id,
                              price_book_version_id,
                              independence_override_by_id, independence_override_note, independence_override_at,
                              period_key)
     VALUES ($1, $2, $3::service_line, $4::engagement_status, $5, $6, $7,
             $8, $9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
             $10)
     RETURNING id`,
    [
      input.contactId,
      input.businessId ?? null,
      input.serviceLine,
      input.status ?? 'draft',
      input.title ?? null,
      input.leadStaffId ?? null,
      versionId,
      independenceOverridden ? actor.id : null,
      independenceOverridden ? input.independenceOverrideNote : null,
      input.periodKey ?? null,
    ]
    )).rows;
  } catch (err) {
    // THE RULE, said in words (2026-09-09): one active engagement per line and period.
    if (isOneActivePerPeriodViolation(err)) {
      throw new AppError(
        409,
        'engagement_exists',
        `This client already has an active ${input.serviceLine} engagement for this period (${input.periodKey}). ` +
          'A second agreement for the same work is a change order that replaces the first, not a new engagement.'
      );
    }
    throw err;
  }
  const id = rows[0]!.id;

  await writeAudit(app.db, {
    actorType: 'staff',
    actorId: actor.id,
    actorLabel: actor.fullName,
    action: 'engagement.created',
    objectType: 'engagement',
    objectId: id,
    contactId: input.contactId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { service_line: input.serviceLine },
  });
  if (independenceOverridden) {
    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: actor.id,
      actorLabel: actor.fullName,
      action: 'engagement.independence_override',
      objectType: 'engagement',
      objectId: id,
      contactId: input.contactId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { note: input.independenceOverrideNote },
    });
  }

  return { id, independenceOverridden };
}
