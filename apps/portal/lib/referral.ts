/*
 * THE HILO REFERRAL DISCOUNT ON THE PROPOSAL (R75, 2026-09-27), the pure part.
 *
 * The server writes the discount on the quote over the included lines it reaches (GET
 * /public/quote/:token → referralDiscount.cents, already netted out of total_cents) and says per
 * line whether the rule reaches it (referral_reached). At acceptance it recomputes over the lines the
 * client actually chose: the rate on the sum of every chosen, non-pass-through line it reaches,
 * rounded once. This mirrors that for the add-ons the client ticks, so the proposal reads the figure
 * acceptance will charge. With nothing ticked it is the server's figure, untouched.
 */

export interface ReferralLine {
  item_code: string;
  line_cents: number | null;
  is_optional: boolean;
  is_pass_through: boolean;
  referral_reached?: boolean;
}

export interface ReferralOnQuote {
  labelEn: string;
  labelEs: string;
  /** Percent off, as the book holds it (50 = half). */
  rate: number;
  /** The discount the server wrote on the quote, over its included lines. */
  cents: number;
}

const reached = (l: ReferralLine): boolean => l.referral_reached === true && !l.is_pass_through && l.line_cents !== null;

/** The referral discount the proposal shows with these add-ons ticked. */
export function referralCentsWithTicks(
  lines: readonly ReferralLine[],
  referral: ReferralOnQuote | null,
  ticked: Readonly<Record<string, boolean>>
): number {
  if (!referral) return 0;
  const sum = (ls: readonly ReferralLine[]) => ls.reduce((s, l) => s + (l.line_cents ?? 0), 0);
  const included = sum(lines.filter((l) => !l.is_optional && reached(l)));
  const added = sum(lines.filter((l) => l.is_optional && ticked[l.item_code] === true && reached(l)));
  if (added === 0) return referral.cents;
  const rateOf = (cents: number) => Math.round((cents * referral.rate) / 100);
  return referral.cents + rateOf(included + added) - rateOf(included);
}

/** The row's words in the client's language: the book's label and the rate, "Hilo referral discount (50%)". */
export function referralRowText(referral: Pick<ReferralOnQuote, 'labelEn' | 'labelEs' | 'rate'>, lang: 'en' | 'es'): string {
  return `${lang === 'es' ? referral.labelEs : referral.labelEn} (${referral.rate}%)`;
}
