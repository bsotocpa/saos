// Translates the price-book vocabulary to the engagement-schedule vocabulary.
//
// FINDING #17. The two enums never matched:
//
//   price_service_line (price_book_items): individual_tax | business_tax |
//     recurring_accounting | scope_ladder | setup_conversion | software_passthrough |
//     filings_1099_w2 | entity_services | attest | specialized_cpa | coo | deposit
//
//   service_line (engagements, service_schedules): tax | bookkeeping | payroll |
//     sales_tax | advisory | coo | entity | attest | specialized_cpa | nonprofit_cfo
//
// Three values coincide and the rest do not, so joining a quote's line items straight
// to service_schedules resolved almost nothing — including an individual tax return,
// which never produced Schedule A. Any duplicate-coverage check built on that join
// would have passed everything silently.
//
// This lives in the SEED rather than the migration because it references
// service_schedules rows, which are themselves seeded: a migration that inserts these
// fails the foreign key on a fresh database, which is exactly how it was caught.
//
// A useful property: the price-book vocabulary is FINER than the engagement one. It
// separates individual_tax from business_tax, which is the A/B split service_schedules
// cannot express (Schedule B maps to no service_line at all, because A vs B comes from
// return type). So this mapping is what finally gives Schedule B a source.
//
// THREE VALUES ARE DELIBERATELY ABSENT pending Brian's ruling, not guessed:
// scope_ladder, setup_conversion, filings_1099_w2. Absent means "schedule unknown" and
// is reported as such — never as "no schedule applies".
// software_passthrough and deposit are absent permanently: neither is a service.

const MAPPINGS = [
  ['individual_tax', 'A', 'Individual returns — the 1040-series schedule.'],
  [
    'business_tax',
    'B',
    'Business returns. The price book is what distinguishes A from B; service_schedules cannot, which is why Schedule B maps to no service_line.',
  ],
  ['recurring_accounting', 'C', 'Bookkeeping, payroll and sales tax all sit under Schedule C.'],
  ['entity_services', 'E', 'Formations, annual reports, registered agent.'],
  ['attest', 'F', 'CPA review / audit / insurance-WC audit — the attest schedule.'],
  ['specialized_cpa', 'D', 'Specialized CPA advisory work.'],
  ['coo', 'D', 'Outsourced COO/CFO advisory work.'],
  // Brian's ruling, 2026-08-13.
  ['setup_conversion', 'C', 'Books setup and conversion is recurring-accounting work — Schedule C.'],
  ['filings_1099_w2', 'C', '1099/W-2 filings are payroll-adjacent — Schedule C.'],
];

/**
 * PERMANENTLY unmapped, by ruling — not awaiting anything.
 *
 * scope_ladder: Brian ruled no schedule (2026-08-13). Scope-ladder items are add-on
 *   tiers that ride on whatever engagement they are attached to; they do not bring a
 *   schedule of their own. A quote of ONLY scope-ladder lines therefore implies no
 *   schedule, which is correct and also means it cannot stand as an engagement by
 *   itself.
 * software_passthrough, deposit: not services under any schedule.
 */
const NEVER_MAPPED = ['scope_ladder', 'software_passthrough', 'deposit'];

export async function seedSchedulePriceLines(db) {
  // Verify every target schedule exists before inserting, so a missing schedule is a
  // clear message rather than a foreign-key error.
  const { rows: schedules } = await db.query(
    `SELECT schedule_code FROM service_schedules`
  );
  const known = new Set(schedules.map((r) => r.schedule_code));
  const missing = MAPPINGS.filter(([, code]) => !known.has(code)).map(([, code]) => code);
  if (missing.length > 0) {
    return `SKIPPED — service_schedules missing ${[...new Set(missing)].join(', ')} (seed legal_v3 first)`;
  }

  let inserted = 0;
  for (const [serviceLine, scheduleCode, note] of MAPPINGS) {
    // Brian's corrections win over a re-seed: only fill in what is absent.
    const res = await db.query(
      `INSERT INTO schedule_for_price_line (service_line, schedule_code, note)
       VALUES ($1::price_service_line, $2, $3)
       ON CONFLICT (service_line) DO NOTHING`,
      [serviceLine, scheduleCode, note]
    );
    inserted += res.rowCount;
  }

  // Anything neither mapped nor deliberately never-mapped is a genuine gap, and it
  // stays visible in the deploy output rather than being quietly forgotten.
  const { rows: unmapped } = await db.query(
    `SELECT unnest(enum_range(NULL::price_service_line))::text AS service_line
     EXCEPT SELECT service_line::text FROM schedule_for_price_line
     EXCEPT SELECT unnest($1::text[])`,
    [NEVER_MAPPED]
  );
  const pending = unmapped.map((r) => r.service_line).sort();
  return (
    `${inserted} of ${MAPPINGS.length} price-line → schedule mappings inserted` +
    (pending.length > 0
      ? `; AWAITING A RULING: ${pending.join(', ')}`
      : `; no schedule by ruling: ${NEVER_MAPPED.join(', ')}`)
  );
}
