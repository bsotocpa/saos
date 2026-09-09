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

/** Active engagements on this contact + line + period — the ones a new quote must replace. */
export async function activeEngagementsFor(
  app: FastifyInstance,
  contactId: string,
  serviceLine: string,
  periodKey: string
): Promise<Array<{ id: string; title: string | null; status: string; periodKey: string }>> {
  const { rows } = await app.db.query<{ id: string; title: string | null; status: string; period_key: string }>(
    `SELECT id, title, status::text AS status, period_key
       FROM engagements
      WHERE contact_id = $1 AND service_line = $2::service_line AND period_key = $3
        AND status IN ('active', 'on_hold')
      ORDER BY created_at`,
    [contactId, serviceLine, periodKey]
  );
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, periodKey: r.period_key }));
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
