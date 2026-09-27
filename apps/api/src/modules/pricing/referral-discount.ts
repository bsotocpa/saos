/*
 * THE HILO REFERRAL DISCOUNT (Brian, 2026-09-12 ruling 5; 2026-09-27, R75).
 *
 * A rule of the price book (price_book_discount_rules, migration 0129), never a number in code: the
 * version in force says the rate and the price lines it reaches. This module knows only the two kinds
 * of rule the book can hold today, and applies them:
 *
 *   condition referred_by_hilo   the contact's Hilo referral attribution on the record
 *                                (contacts.br1_referred_by_hilo, written only by a verified Hilo
 *                                transition link; nobody types it)
 *   scope first_engagement       the client's first engagement that carries a line the rule reaches
 *                                (R78, 2026-09-27): an earlier engagement consumes it only when it is
 *                                on an engagement line the rule's price lines produce (tax, entity) and
 *                                is not withdrawn. Bookkeeping-only work does not consume it; withdrawn
 *                                work never does (priorEligibleEngagement)
 *
 * How it reads, end to end:
 *   quote       its own line ("Hilo referral discount −$x"); total = subtotal − package − referral;
 *               the deposit is computed on the discounted lines; recomputed at acceptance over the
 *               lines the client actually chose; the CEO may remove it with a reason, nothing widens it
 *   engagement  the accepted quote's rule is snapshotted on each engagement it reaches
 *   invoice     each invoice on such an engagement carries the discount as its own line
 *               (billing/service.ts createInvoice), recorded in invoice_discount_lines and audited as
 *               invoice.referral_discount, which the money line counts as a discount
 */
import type { FastifyInstance } from 'fastify';
import { engagementLineFor } from './engagement-lines.ts';

export interface ReferralRule {
  ruleCode: string;
  labelEn: string;
  labelEs: string;
  /** Percent off, as the book holds it (50 = half). */
  rate: number;
  /** The price lines (price_service_line) the rule reaches. */
  serviceLines: string[];
}

export type ReferralVerdict =
  | { applies: true; rule: ReferralRule }
  | { applies: false; why: 'no_rule_in_book' | 'not_referred_by_hilo' | 'not_first_engagement' };

/** Whether a quote for this contact, written under this version, takes the referral discount — and why not. */
export async function referralRuleFor(app: FastifyInstance, contactId: string, versionId: string): Promise<ReferralVerdict> {
  const rule = await app.db.query<{ rule_code: string; name_en: string; name_es: string; percent_rate: string; lines: string[] }>(
    `SELECT rule_code, name_en, name_es, percent_rate::text AS percent_rate, applies_to_service_lines::text[] AS lines
       FROM price_book_discount_rules
      WHERE version_id = $1 AND is_active AND condition = 'referred_by_hilo' AND scope = 'first_engagement'
      ORDER BY sort_order, rule_code LIMIT 1`,
    [versionId]
  );
  const r = rule.rows[0];
  if (!r) return { applies: false, why: 'no_rule_in_book' };
  const contact = await app.db.query<{ referred: boolean | null }>(
    `SELECT br1_referred_by_hilo AS referred FROM contacts WHERE id = $1`,
    [contactId]
  );
  if (contact.rows[0]?.referred !== true) return { applies: false, why: 'not_referred_by_hilo' };
  if (await priorEligibleEngagement(app, contactId, r.lines)) return { applies: false, why: 'not_first_engagement' };
  return {
    applies: true,
    rule: { ruleCode: r.rule_code, labelEn: r.name_en, labelEs: r.name_es, rate: Number(r.percent_rate), serviceLines: r.lines },
  };
}

/** The engagement lines the rule's price lines produce: individual_tax and business_tax make 'tax', entity_services 'entity'. */
export function engagementLinesReached(serviceLines: readonly string[]): string[] {
  return [...new Set(serviceLines.map((pl) => engagementLineFor(pl, '')).filter((l): l is NonNullable<typeof l> => l !== null))];
}

/**
 * R78: HAS THE FIRST ENGAGEMENT ALREADY HAPPENED? True when the client holds an engagement, not
 * withdrawn, on a line the rule reaches. A bookkeeping-only engagement does not consume the discount;
 * a withdrawn engagement never does. Read at quote time and again at acceptance, the same way.
 */
export async function priorEligibleEngagement(app: FastifyInstance, contactId: string, serviceLines: readonly string[]): Promise<boolean> {
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM engagements
      WHERE contact_id = $1 AND status <> 'withdrawn' AND service_line::text = ANY($2::text[])`,
    [contactId, engagementLinesReached(serviceLines)]
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** The discount on these lines under this rule: the rate on the lines it reaches, rounded to the cent. */
export function referralDiscountCents(
  lines: ReadonlyArray<{ cents: number; serviceLine: string | null }>,
  rule: { rate: number; serviceLines: readonly string[] }
): number {
  const reached = lines.reduce((sum, l) => sum + (l.serviceLine !== null && rule.serviceLines.includes(l.serviceLine) ? l.cents : 0), 0);
  return Math.round((reached * rule.rate) / 100);
}
