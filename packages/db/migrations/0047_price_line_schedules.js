/**
 * FINDING #17, discovered while building it — the price book and the service schedules
 * speak DIFFERENT vocabularies, and nothing translated between them.
 *
 *   price_service_line (price_book_items): individual_tax | business_tax |
 *     recurring_accounting | scope_ladder | setup_conversion | software_passthrough |
 *     filings_1099_w2 | entity_services | attest | specialized_cpa | coo | deposit
 *
 *   service_line (engagements, service_schedules.service_lines): tax | bookkeeping |
 *     payroll | sales_tax | advisory | coo | entity | attest | specialized_cpa |
 *     nonprofit_cfo
 *
 * Three values coincide (attest, specialized_cpa, coo) and the rest do not. So a join
 * from a quote's line items to service_schedules matched almost nothing — including the
 * most common case of all, an individual tax return, which never resolved to Schedule
 * A. Any "does this quote duplicate existing coverage?" check built on that join would
 * have quietly passed everything.
 *
 * This table is the missing translation, kept as DATA so Brian can correct a mapping
 * without a deploy — the same reasoning as service_schedules itself.
 *
 * A useful consequence: the price-book vocabulary is FINER than the engagement one. It
 * distinguishes individual_tax from business_tax, which is exactly the A/B split that
 * service_schedules cannot express (Schedule B's service_lines array is empty, because
 * A vs B comes from return type). So this mapping finally gives Schedule B a source.
 *
 * THREE VALUES ARE DELIBERATELY LEFT UNMAPPED pending Brian's ruling, rather than
 * guessed at: scope_ladder, setup_conversion, filings_1099_w2. An unmapped line is
 * reported as "schedule unknown" rather than "no schedule", so it shows up instead of
 * silently reading as no-overlap. software_passthrough and deposit are unmapped on
 * purpose and permanently — neither is a service under any schedule.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE schedule_for_price_line (
      service_line  price_service_line PRIMARY KEY,
      schedule_code text NOT NULL REFERENCES service_schedules(schedule_code),
      note          text,
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE schedule_for_price_line IS
      'Translates the price book vocabulary (price_service_line) to the engagement-schedule vocabulary. Data, not code: a mapping correction is an admin edit. A price_service_line ABSENT from this table means "no schedule known" — callers must treat that as unknown, never as "no schedule applies". software_passthrough and deposit are absent permanently: neither is a service governed by a schedule.';

  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE schedule_for_price_line;`);
};
