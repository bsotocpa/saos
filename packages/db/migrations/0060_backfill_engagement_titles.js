/*
 * BACKFILL PLACEHOLDER ENGAGEMENT TITLES (Brian, 2026-08-16 — queued during #33/#27).
 *
 * `engagements.title` is free text written by whichever path created the engagement, and
 * four active rows in production read "Accepted quote". #35 stopped showing that column
 * to clients — the portal composes a name from the service line and tax year instead —
 * but ops still reads it, so staff see placeholder text on real work.
 *
 * This applies the SAME composition the client sees, so the two surfaces agree:
 *   · a tax engagement with a return  → "2025 · 1040"
 *   · anything else                   → the service line, in the firm's own words
 *
 * SCOPE IS DELIBERATELY NARROW: 'Accepted quote' and NULL only. "2025 intake" is left
 * alone — it is not placeholder text, it says how the engagement came to exist, and
 * overwriting a title someone finds useful is not a cleanup. Anything a human typed is
 * likewise untouched, because this cannot tell a considered title from a careless one.
 */

const SERVICE_LINE_LABEL = {
  tax: 'Taxes',
  bookkeeping: 'Bookkeeping',
  payroll: 'Payroll',
  sales_tax: 'Sales tax',
  advisory: 'Advisory',
  coo: 'Operations support',
  entity: 'Entity setup and changes',
  attest: 'Reviews and audits',
  specialized_cpa: 'Specialized CPA work',
  nonprofit_cfo: 'Nonprofit CFO',
};

exports.up = (pgm) => {
  const cases = Object.entries(SERVICE_LINE_LABEL)
    .map(([line, label]) => `WHEN '${line}' THEN '${label.replace(/'/g, "''")}'`)
    .join('\n             ');

  pgm.sql(`
    UPDATE engagements e
       SET title = COALESCE(
             -- Tax work is named the way a client thinks of it: year and form.
             (SELECT te.tax_year || ' · ' || upper(te.return_type::text)
                FROM tax_engagements te
               WHERE te.engagement_id = e.id AND te.tax_year IS NOT NULL
               LIMIT 1),
             CASE e.service_line::text
             ${cases}
             ELSE e.service_line::text
             END
           )
     WHERE e.title IS NULL OR e.title = 'Accepted quote';
  `);
};

exports.down = () => {
  /*
   * Irreversible on purpose. The previous value was 'Accepted quote' or NULL — neither is
   * information, and restoring placeholder text over a real title would be the actual
   * data loss. Down migrations exist to undo STRUCTURE, not to reinstate noise.
   */
};
