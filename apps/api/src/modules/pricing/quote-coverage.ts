// FINDING #17 — what a quote covers, and what the client already has.
//
// Brian's ruling: "acceptance must always produce visible consequence — either
// engagement work/tasks for that schedule, or if the schedule is already covered,
// block at SEND time with 'this client already has an active Schedule A — adding work
// or duplicating?' Silent acceptance into the void is never valid."
//
// Two questions, deliberately answered in one place so they cannot drift apart:
//
//   schedulesImpliedByQuote()  — which service schedules would this quote bring in?
//   coveredSchedules()         — which does the client already have accepted?
//
// The block happens at SEND, not at accept. By the time a client taps Accept they have
// read a proposal and made a decision; refusing them at that moment punishes them for
// our bookkeeping. Refusing US at send time, while there is still a person looking at
// the screen who can answer "adding work or duplicating?", puts the decision where the
// knowledge is.

import type { FastifyInstance } from 'fastify';

/**
 * The schedule codes a quote's line items map to, through schedule_for_price_line.
 *
 * That table exists because the price book and the schedules speak different
 * vocabularies — `individual_tax` vs `tax` — and joining them directly matched almost
 * nothing, silently including the most common case of all. See migration 0047.
 */
export async function schedulesImpliedByQuote(
  app: FastifyInstance,
  quoteId: string
): Promise<string[]> {
  const { rows } = await app.db.query<{ schedule_code: string }>(
    `SELECT DISTINCT m.schedule_code
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       JOIN price_book_items pbi ON pbi.item_code = qli.item_code
       -- PIN THE VERSION. Joining on item_code alone matched the item in EVERY price
       -- book version, so the moment a second version existed a single quote resolved
       -- to the union of its old and new classifications (a GATE 2 reclassification
       -- made SCORP_CONVERSION_2553 imply both C and E). A quote means what the book
       -- said when it was written.
       AND pbi.version_id = q.price_book_version_id
       JOIN schedule_for_price_line m ON m.service_line = pbi.service_line
      WHERE qli.quote_id = $1 AND qli.chosen
      ORDER BY m.schedule_code`,
    [quoteId]
  );
  return rows.map((r) => r.schedule_code);
}

/**
 * Price-book service lines on this quote that have NO schedule mapping.
 *
 * Reported separately and deliberately: "I do not know which schedule this covers" is
 * a different answer from "this covers no schedule", and collapsing the two is how a
 * duplicate-coverage gate silently passes everything. software_passthrough and deposit
 * are expected here and are not service lines under any schedule; anything else in this
 * list is a mapping Brian has not ruled on yet.
 */
export async function unmappedServiceLines(
  app: FastifyInstance,
  quoteId: string
): Promise<string[]> {
  const { rows } = await app.db.query<{ service_line: string }>(
    `SELECT DISTINCT pbi.service_line::text AS service_line
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       JOIN price_book_items pbi ON pbi.item_code = qli.item_code
       -- PIN THE VERSION. Joining on item_code alone matched the item in EVERY price
       -- book version, so the moment a second version existed a single quote resolved
       -- to the union of its old and new classifications (a GATE 2 reclassification
       -- made SCORP_CONVERSION_2553 imply both C and E). A quote means what the book
       -- said when it was written.
       AND pbi.version_id = q.price_book_version_id
       LEFT JOIN schedule_for_price_line m ON m.service_line = pbi.service_line
      WHERE qli.quote_id = $1 AND qli.chosen AND m.service_line IS NULL
        AND pbi.service_line::text NOT IN ('software_passthrough', 'deposit')
      ORDER BY 1`,
    [quoteId]
  );
  return rows.map((r) => r.service_line);
}

/**
 * Schedule codes this contact has already accepted — whether by signing the Master
 * with the schedule attached, or by accepting it per-schedule in the portal later.
 *
 * schedule_acceptances is the single source of truth for that, which is why it exists:
 * "has this client agreed to Schedule A?" must not be answered by inferring from
 * engagements.
 */
export async function coveredSchedules(
  app: FastifyInstance,
  contactId: string
): Promise<string[]> {
  const { rows } = await app.db.query<{ schedule_code: string }>(
    `SELECT DISTINCT schedule_code FROM schedule_acceptances
      WHERE contact_id = $1 ORDER BY schedule_code`,
    [contactId]
  );
  const accepted = rows.map((r) => r.schedule_code);
  if (accepted.length === 0) return [];
  /*
   * R79 (Brian, 2026-09-27): "active" means a LIVE engagement sits under the schedule. A schedule the
   * client signed once, with no live engagement under it now (Brian's Schedule A after his two 1040
   * engagements were withdrawn), is not a trigger. The live schedules are the packet resolver's own
   * answer (engagements draft, active or on hold); if it cannot answer, every accepted schedule counts,
   * so the prompt errs toward asking.
   */
  let live: string[];
  try {
    const { resolveSchedules } = await import('../engagements/packet.ts');
    live = (await resolveSchedules(app, contactId)).codes;
  } catch {
    live = accepted;
  }
  return accepted.filter((code) => live.includes(code));
}

/**
 * R79: when the prompt fires, is this quote for a tax year no live tax engagement covers? Then it adds to
 * the agreement rather than replacing it, and the builder offers "Adds to the existing agreement" as the
 * default. Null when the quote names no tax year.
 */
export async function differentTaxYear(
  app: FastifyInstance,
  quoteId: string,
  contactId: string
): Promise<{ differs: boolean; quoteYear: string; liveYears: string[] } | null> {
  const { periodsForQuote, quoteReturnYears } = await import('../engagements/change-order.ts');
  const tax = (await periodsForQuote(app, quoteId)).find((p) => p.serviceLine === 'tax' && p.periodKey !== null);
  if (!tax) return null;
  // R89: a live year is an engagement's period or a return an engagement holds (a multi-year
  // engagement holds its older years only as returns); the quote differs when none of its years is live.
  const { rows } = await app.db.query<{ year: string }>(
    `SELECT e.period_key AS year FROM engagements e
      WHERE e.contact_id = $1 AND e.service_line = 'tax' AND e.status IN ('draft', 'active', 'on_hold') AND e.period_key IS NOT NULL
     UNION
     SELECT te.tax_year::text FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE e.contact_id = $1 AND e.service_line = 'tax' AND e.status IN ('draft', 'active', 'on_hold') AND te.stage <> 'withdrawn'
     ORDER BY 1`,
    [contactId]
  );
  const liveYears = rows.map((r) => r.year);
  const quoteYears = (await quoteReturnYears(app, quoteId)).map(String);
  return { differs: !quoteYears.some((y) => liveYears.includes(y)), quoteYear: quoteYears.join(', '), liveYears };
}

export interface CoverageOverlap {
  /** Schedules the quote would bring in that the client already accepted. */
  overlapping: string[];
  /** Human-readable schedule titles for the message. */
  titles: Record<string, string>;
}

/**
 * Does this quote duplicate coverage the client already has? Returns the overlap and
 * the schedule titles, so the caller can build a message that names the actual
 * schedule rather than saying "a schedule".
 */
export async function coverageOverlap(
  app: FastifyInstance,
  quoteId: string,
  contactId: string
): Promise<CoverageOverlap> {
  const [implied, covered] = await Promise.all([
    schedulesImpliedByQuote(app, quoteId),
    coveredSchedules(app, contactId),
  ]);
  const coveredSet = new Set(covered);
  const overlapping = implied.filter((code) => coveredSet.has(code));
  if (overlapping.length === 0) return { overlapping: [], titles: {} };

  const { rows } = await app.db.query<{ schedule_code: string; title: string }>(
    `SELECT schedule_code, title FROM service_schedules WHERE schedule_code = ANY($1)`,
    [overlapping]
  );
  return {
    overlapping,
    titles: Object.fromEntries(rows.map((r) => [r.schedule_code, r.title])),
  };
}

/**
 * GATE 1 (launch-readiness.md) — tax-only quoting until finding #19 is fixed.
 *
 * acceptQuote() hardcodes serviceLine: 'tax' when it creates the engagement, and the
 * engagement's service line is what drives schedule assembly. So a bookkeeping quote
 * produces a Schedule A — an individual-tax agreement for work that is not individual
 * tax. Verified by rendering the packet, which is the only thing that settles it.
 *
 * Brian's ruling: tax-only until #19 lands. Enforced here rather than only in the
 * document, because a gate that lives in a document is a gate that gets forgotten.
 *
 * REMOVE THIS FUNCTION AND ITS CALL when #19 is fixed — not before, and not by
 * loosening the list.
 */
/*
 * GATE 1 lived here: assertTaxOnlyUntil19 refused any quote whose lines were not
 * individual/business tax, because acceptQuote hardcoded a 'tax' engagement and would
 * have papered bookkeeping work with a Schedule A agreement.
 *
 * REMOVED 2026-08-15 — #19 is fixed. Acceptance now derives the service line from the
 * price book (engagement-lines.ts), so the reason the gate existed is gone. Its successor,
 * assertEveryLineCreatesWork, guards the failure that remains: a line mapping to no
 * engagement line at all.
 *
 * Deleted rather than left dormant. A gate that no longer gates is a comment pretending
 * to be a control, and the next person to read it cannot tell which.
 */

/** Intent a sender must declare to send a quote that duplicates existing coverage. */
export type DuplicateIntent = 'additional_work' | 'replaces_existing';

/**
 * The send-time gate. Throws with a message naming the schedule unless the sender has
 * said which of the two things they mean.
 *
 * Deliberately NOT a boolean "force" flag: "adding work" and "duplicating" have
 * different downstream meanings, and a yes/no override would record neither. The
 * answer is stored on the quote so the accepted engagement can later be read back
 * with the intent that justified it.
 */
export async function assertSendableOverCoverage(
  app: FastifyInstance,
  quoteId: string,
  contactId: string,
  intent: DuplicateIntent | undefined
): Promise<{ overlapping: string[]; intent: DuplicateIntent | null }> {
  const { overlapping, titles } = await coverageOverlap(app, quoteId, contactId);
  if (overlapping.length === 0) return { overlapping: [], intent: null };
  if (intent) return { overlapping, intent };

  const named = overlapping
    .map((code) => `Schedule ${code}${titles[code] ? ` (${titles[code]})` : ''}`)
    .join(' and ');
  const { AppError } = await import('../../types.ts');
  const year = await differentTaxYear(app, quoteId, contactId);
  throw Object.assign(
    new AppError(
      409,
      'schedule_already_covered',
      `This client already has an active ${named}. Adding work, or duplicating? ` +
        'Send again with intent "additional_work" to add scope under the existing ' +
        'agreement, or "replaces_existing" if this supersedes it. ' +
        'The answer is recorded on the quote.'
    ),
    // R79: a different tax year adds to the agreement; the builder opens on that answer.
    { issues: { suggestedIntent: year?.differs ? 'additional_work' : null, quoteYear: year?.quoteYear ?? null, liveYears: year?.liveYears ?? [] } }
  );
}
