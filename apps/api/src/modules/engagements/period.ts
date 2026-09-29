/*
 * THE PERIOD OF AN ENGAGEMENT (2026-09-09, Brian's ruling).
 *
 * At most one active (or on-hold) engagement per (contact, service line, period). #48 guards
 * one QUOTE from being accepted twice; nothing guarded one SERVICE LINE from being agreed
 * twice through two different quotes — Rehearsal Client 2 carried three active tax
 * engagements by the end of a rehearsal. The database now holds the rule as a partial
 * unique index on (contact_id, service_line, period_key); this module decides what the
 * period IS for each line.
 *
 *   tax            → the tax year, as text ('2025'). From the quote when it says; otherwise
 *                    the filing-season default (see defaultTaxYear).
 *   recurring      → 'ongoing': one active at a time (bookkeeping, payroll, sales tax, the
 *                    advisory / COO / nonprofit-CFO retainers).
 *   per-matter     → null: entity filings, attest, specialized CPA work can legitimately run
 *                    side by side (two formations, two reviews). NOT enforced, on purpose,
 *                    and flagged for Brian rather than guessed.
 *
 * Legacy engagements created before this ruling carry period_key NULL and are outside the
 * index — they are REPORTED (legacyEngagementsWithoutPeriod), never guessed.
 */

import type { FastifyInstance } from 'fastify';

export const RECURRING_LINES: ReadonlySet<string> = new Set([
  'bookkeeping', 'payroll', 'sales_tax', 'advisory', 'coo', 'nonprofit_cfo',
]);
export const PER_MATTER_LINES: ReadonlySet<string> = new Set(['entity', 'attest', 'specialized_cpa']);

/**
 * The tax year a return quoted TODAY is for, when the quote does not say: the prior calendar
 * year. Returns prepared in 2026 are 2025 returns. DECISION-PENDING for Brian: after the
 * October extended deadline the next season's work may start to be quoted; a quote can
 * always name its year explicitly (interview answer `tax_year`).
 */
export function defaultTaxYear(todayIso: string): number {
  return Number(todayIso.slice(0, 4)) - 1;
}

export function periodKeyFor(
  serviceLine: string,
  opts: { taxYear?: number | null | undefined; todayIso: string }
): string | null {
  if (serviceLine === 'tax') return String(opts.taxYear ?? defaultTaxYear(opts.todayIso));
  if (RECURRING_LINES.has(serviceLine)) return 'ongoing';
  return null;
}

/** Postgres unique-violation on the one-active-per-line-period index. */
export function isOneActivePerPeriodViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === '23505' && e.constraint === 'engagements_one_active_per_line_period';
}

/**
 * Active engagements on this contact + line + period + ENTITY — the ones a new quote must replace.
 *
 * The entity is part of the key exactly as migration 0098 put it in the index: the owner's own
 * work (no business) collides with itself, and each business's work with that business's. The
 * send gate read (contact, line, period) alone after 0098, so an S corporation owner's 1040 quote
 * was refused as a "change order" of the corporation's 1120-S, whose engagement the change order
 * would then have withdrawn (R73 preflight, 2026-09-27).
 */
export async function activeEngagementsFor(
  app: FastifyInstance,
  contactId: string,
  serviceLine: string,
  periodKey: string,
  businessId: string | null
): Promise<Array<{ id: string; title: string | null; status: string; periodKey: string }>> {
  const { rows } = await app.db.query<{ id: string; title: string | null; status: string; period_key: string }>(
    `SELECT id, title, status::text AS status, period_key
       FROM engagements
      WHERE contact_id = $1 AND service_line = $2::service_line AND period_key = $3
        AND business_id IS NOT DISTINCT FROM $4::uuid
        AND status IN ('active', 'on_hold')
      ORDER BY created_at`,
    [contactId, serviceLine, periodKey, businessId]
  );
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, periodKey: r.period_key }));
}

/**
 * R89 (2026-09-29): the active tax engagements that already cover any of these years for this client
 * and entity. A multi-year engagement's period is its newest year, and it holds its older years only
 * as returns, so the one-active-per-period index sees the first and not the rest: this reads both,
 * the period and every return not withdrawn. `years` is what each one holds.
 */
export async function activeTaxEngagementsForYears(
  app: FastifyInstance,
  contactId: string,
  businessId: string | null,
  years: readonly number[]
): Promise<Array<{ id: string; title: string | null; periodKey: string | null; years: number[] }>> {
  if (years.length === 0) return [];
  const { rows } = await app.db.query<{ id: string; title: string | null; period_key: string | null; years: number[] | null }>(
    `SELECT e.id, e.title, e.period_key,
            array_agg(DISTINCT te.tax_year ORDER BY te.tax_year DESC) FILTER (WHERE te.stage <> 'withdrawn') AS years
       FROM engagements e
       LEFT JOIN tax_engagements te ON te.engagement_id = e.id
      WHERE e.contact_id = $1 AND e.service_line = 'tax' AND e.business_id IS NOT DISTINCT FROM $2::uuid
        AND e.status IN ('active', 'on_hold')
      GROUP BY e.id
     HAVING e.period_key = ANY($3::text[]) OR bool_or(te.stage <> 'withdrawn' AND te.tax_year = ANY($4::int[]))
      ORDER BY min(e.created_at)`,
    [contactId, businessId, years.map(String), [...years]]
  );
  return rows.map((r) => ({ id: r.id, title: r.title, periodKey: r.period_key, years: r.years ?? [] }));
}

/**
 * The legacy population the index does not cover: active/on-hold engagements with no
 * period. Reported by contact (name abbreviated: this goes into a report) — never guessed.
 */
export async function legacyEngagementsWithoutPeriod(
  app: FastifyInstance
): Promise<{ total: number; byContact: Array<{ contact: string; isTest: boolean; lines: string[]; count: number }> }> {
  const { rows } = await app.db.query<{ contact: string; is_test: boolean; lines: string[]; count: number }>(
    `SELECT c.first_name || ' ' || left(c.last_name, 1) || '.' AS contact, c.is_test,
            array_agg(DISTINCT e.service_line::text) AS lines, count(*)::int AS count
       FROM engagements e JOIN contacts c ON c.id = e.contact_id
      WHERE e.status IN ('active', 'on_hold') AND e.period_key IS NULL
      GROUP BY c.id, c.first_name, c.last_name, c.is_test
      ORDER BY count DESC, contact`
  );
  return {
    total: rows.reduce((n, r) => n + r.count, 0),
    byContact: rows.map((r) => ({ contact: r.contact, isTest: r.is_test, lines: r.lines, count: r.count })),
  };
}
