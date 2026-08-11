// THE GUIDED TAX INTERVIEW — derive a quote's line items from answers.
//
// The bug this exists for: quotes priced the base correctly and understated
// everything else, because additional schedules only made it onto a quote if a
// staffer remembered to add them. Three rentals silently became one Schedule E, or
// none at all.
//
// Two of Brian's rulings are load-bearing here:
//
//  1. COUNTS, NOT YES/NO. `IND_SCH_E_RENTAL` is priced per_property and
//     `IND_SCH_E_K1` per_k1. A boolean cannot price them, and treating "do you have
//     rentals?" as one unit is exactly how the understatement happened.
//
//  2. DERIVED SCHEDULES QUOTE EXACT; THE RANGE STAYS ON THE BASE. Once a client has
//     told us they have three rentals, the schedule price is a known number — a
//     range around it reads as vagueness. Complexity genuinely varies in the base
//     return, so that is the only part the band widens.
//
// The questions and their price-book mapping live in `tax_interview_questions`, so
// adding a schedule to the interview is an admin edit and the money still comes from
// the versioned price book.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';

export type AnswerValue = string | number | boolean;
export type InterviewAnswers = Record<string, AnswerValue>;

interface QuestionRow {
  key: string;
  answer_type: 'choice' | 'count' | 'bool';
  prompt_en: string;
  prompt_es: string;
  help_en: string | null;
  help_es: string | null;
  item_code: string | null;
  choice_items: Record<string, string> | null;
  is_base: boolean;
  sort_order: number;
}

export interface InterviewQuestion {
  key: string;
  answerType: 'choice' | 'count' | 'bool';
  prompt: string;
  help: string | null;
  isBase: boolean;
  /** For choice questions: the option values a caller may send. */
  options?: string[] | undefined;
}

export interface DerivedLine {
  itemCode: string;
  name: string;
  quantity: number;
  unit: string | null;
  unitCents: number;
  lineCents: number;
  isBase: boolean;
  /** The question and answer that produced this line — shown to staff and client. */
  because: string;
  needsConfirmation: boolean;
  /**
   * TRUE when the price book gives this item a range rather than a flat amount.
   * Such a line CANNOT be quoted exactly, so it is priced at its minimum and its
   * spread is added to the quote's range. Otherwise a range-priced item would sit
   * in an "exact" line at the bottom of its range and understate — the same bug
   * this whole feature exists to fix.
   */
  isRangePriced: boolean;
  maxUnitCents: number;
}

export interface DerivedQuote {
  lines: DerivedLine[];
  baseCents: number;
  derivedCents: number;
  subtotalCents: number;
  /** Range narrowed to the base only. Equal to subtotal when the base is flat-priced. */
  rangeMinCents: number;
  rangeMaxCents: number;
  bandPercent: number;
  /** Items the interview did not price because the price book has no amount for them. */
  unpriced: string[];
  warnings: string[];
}

export async function interviewQuestions(
  app: FastifyInstance,
  language: 'en' | 'es' = 'en'
): Promise<InterviewQuestion[]> {
  const { rows } = await app.db.query<QuestionRow>(
    `SELECT key, answer_type::text AS answer_type, prompt_en, prompt_es, help_en, help_es,
            item_code, choice_items, is_base, sort_order
     FROM tax_interview_questions WHERE is_active ORDER BY sort_order, key`
  );
  return rows.map((q) => ({
    key: q.key,
    answerType: q.answer_type,
    prompt: language === 'es' ? q.prompt_es : q.prompt_en,
    help: (language === 'es' ? q.help_es : q.help_en) ?? null,
    isBase: q.is_base,
    ...(q.choice_items ? { options: Object.keys(q.choice_items) } : {}),
  }));
}

/** The estimate band, from settings — never a literal. */
async function bandPercent(app: FastifyInstance): Promise<number> {
  const { getSetting } = await import('../tax/extension.ts');
  return Number(await getSetting(app, 'pricing.estimate_band_percent', 20));
}

export async function deriveTaxQuote(
  app: FastifyInstance,
  answers: InterviewAnswers,
  language: 'en' | 'es' = 'en'
): Promise<DerivedQuote> {
  const { rows: questions } = await app.db.query<QuestionRow>(
    `SELECT key, answer_type::text AS answer_type, prompt_en, prompt_es, help_en, help_es,
            item_code, choice_items, is_base, sort_order
     FROM tax_interview_questions WHERE is_active ORDER BY sort_order, key`
  );
  if (questions.length === 0) {
    throw new AppError(500, 'interview_not_seeded', 'The tax interview has no questions configured.');
  }

  const unknownKeys = Object.keys(answers).filter((k) => !questions.some((q) => q.key === k));
  if (unknownKeys.length > 0) {
    throw new AppError(400, 'unknown_interview_keys', `Not interview questions: ${unknownKeys.join(', ')}.`);
  }

  const base = questions.find((q) => q.is_base);
  if (!base) throw new AppError(500, 'interview_no_base', 'No base question configured.');
  const baseAnswer = answers[base.key];
  if (baseAnswer === undefined || baseAnswer === '') {
    throw new AppError(
      400,
      'base_answer_required',
      `"${language === 'es' ? base.prompt_es : base.prompt_en}" must be answered — it sets the base price.`
    );
  }

  // Work out which items each answer calls for, with quantities.
  const wanted: Array<{ code: string; qty: number; because: string; isBase: boolean }> = [];
  const warnings: string[] = [];

  for (const q of questions) {
    const value = answers[q.key];
    const prompt = language === 'es' ? q.prompt_es : q.prompt_en;
    if (value === undefined || value === null || value === '') continue;

    if (q.answer_type === 'choice') {
      const code = q.choice_items?.[String(value)];
      if (!code) {
        throw new AppError(400, 'invalid_choice', `"${String(value)}" is not an option for ${q.key}.`);
      }
      wanted.push({ code, qty: 1, because: `${prompt} → ${String(value)}`, isBase: q.is_base });
      continue;
    }

    if (q.answer_type === 'count') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        throw new AppError(400, 'invalid_count', `${q.key} must be a whole number, got "${String(value)}".`);
      }
      if (n === 0) continue;
      if (n > 50) {
        throw new AppError(
          400, 'implausible_count',
          `${q.key} = ${n} looks like a typo. If it is real, add the lines by hand so someone has seen the number.`
        );
      }
      // THE FIX: quantity carries through, so three rentals price as three.
      wanted.push({ code: q.item_code!, qty: n, because: `${prompt} → ${n}`, isBase: false });
      continue;
    }

    // bool
    if (value === true || value === 'true') {
      wanted.push({ code: q.item_code!, qty: 1, because: `${prompt} → yes`, isBase: false });
    }
  }

  // Price everything from the version in force.
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  if (!version.rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');

  const codes = wanted.map((w) => w.code);
  const { rows: priced } = await app.db.query<{
    item_code: string; name_en: string; name_es: string; amount_cents: number | null;
    price_min_cents: number | null; price_max_cents: number | null; unit: string | null;
    needs_confirmation: boolean;
  }>(
    `SELECT item_code, name_en, name_es, amount_cents, price_min_cents, price_max_cents,
            unit, needs_confirmation
     FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [version.rows[0].id, codes]
  );
  const byCode = new Map(priced.map((p) => [p.item_code, p]));

  const lines: DerivedLine[] = [];
  const unpriced: string[] = [];
  for (const w of wanted) {
    const item = byCode.get(w.code);
    if (!item) {
      unpriced.push(w.code);
      warnings.push(`${w.code} is not in the price book in force — it was left off the quote.`);
      continue;
    }
    const unitCents = item.amount_cents ?? item.price_min_cents;
    if (unitCents === null) {
      unpriced.push(w.code);
      warnings.push(
        `${item.name_en} has no amount in the price book at all, so it was left off — add it by hand.`
      );
      continue;
    }
    if (item.needs_confirmation) {
      warnings.push(`${item.name_en} is still flagged ⚠ awaiting your price confirmation.`);
    }
    // A range-priced item has no exact number to quote. Pricing it at the minimum
    // and calling the line exact is precisely the understatement being fixed, so it
    // is flagged and its spread widens the quote's range instead.
    const isRangePriced = item.amount_cents === null && item.price_max_cents !== null;
    const maxUnitCents = item.amount_cents ?? item.price_max_cents ?? unitCents;
    if (isRangePriced) {
      warnings.push(
        `${item.name_en} is quoted as a range in the price book (${(unitCents / 100).toFixed(0)}–${(maxUnitCents / 100).toFixed(0)}). ` +
          'It is included at the low end and widens the quote range — set a firm figure before sending if you can.'
      );
    }
    lines.push({
      itemCode: w.code,
      name: language === 'es' ? item.name_es : item.name_en,
      quantity: w.qty,
      unit: item.unit,
      unitCents,
      lineCents: unitCents * w.qty,
      isBase: w.isBase,
      because: w.because,
      needsConfirmation: item.needs_confirmation,
      isRangePriced,
      maxUnitCents,
    });
  }

  const baseCents = lines.filter((l) => l.isBase).reduce((s, l) => s + l.lineCents, 0);
  const derivedCents = lines.filter((l) => !l.isBase).reduce((s, l) => s + l.lineCents, 0);
  const subtotalCents = baseCents + derivedCents;

  // THE RANGE, narrowed. Only the base widens; derived schedules are exact because
  // the client already told us the counts. If the base item carries a real
  // min/max in the price book, that is used; otherwise the band applies to it.
  const band = await bandPercent(app);
  const baseItem = lines.find((l) => l.isBase);
  const baseRow = baseItem ? byCode.get(baseItem.itemCode) : undefined;
  const baseMax =
    baseRow && baseRow.price_max_cents !== null
      ? baseRow.price_max_cents * (baseItem?.quantity ?? 1)
      : Math.round(baseCents * (1 + band / 100));

  // Range-priced derived lines contribute their spread too, so the range brackets
  // reality rather than pretending a range-priced item is exactly its low end.
  const rangeSpread = lines
    .filter((l) => !l.isBase && l.isRangePriced)
    .reduce((s, l) => s + (l.maxUnitCents - l.unitCents) * l.quantity, 0);

  return {
    lines,
    baseCents,
    derivedCents,
    subtotalCents,
    rangeMinCents: subtotalCents,
    rangeMaxCents: derivedCents + baseMax + rangeSpread,
    bandPercent: band,
    unpriced,
    warnings,
  };
}
