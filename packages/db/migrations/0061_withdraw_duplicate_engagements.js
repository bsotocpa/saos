/*
 * WITHDRAW DUPLICATE ENGAGEMENTS (Brian, 2026-08-16, finding #41).
 *
 * The portal showed two rows reading "Impuestos — En marcha" that a client could not tell
 * apart. They were not a display bug: the two engagements are identical in every stored
 * dimension — same service line, same status, no business, same tax year, created minutes
 * apart — because they ARE the same acceptance recorded twice. Brian's ruling: keep the
 * first, withdraw the rest, and mark them the way the one already-withdrawn row is marked.
 *
 * EXPRESSED AS A RULE, NOT A LIST OF IDS, so a fresh environment carrying the same import
 * gets the same correction, and so the definition of "duplicate" is legible.
 *
 * The rule is deliberately narrow: same contact, same service line, AND the same tax year
 * (both NULL counts as the same). A client with a 2024 return and a 2025 return has two
 * legitimate tax engagements, and collapsing those would be a far worse bug than the one
 * being fixed. Only rows that are genuinely indistinguishable are touched.
 *
 * Withdrawing the engagement also withdraws its tax engagement, or the return would dangle
 * in the preparer queue attached to work that no longer exists.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TEMP TABLE dupes AS
    SELECT id FROM (
      SELECT e.id,
             row_number() OVER (
               PARTITION BY e.contact_id, e.service_line, COALESCE(te.tax_year, -1)
               ORDER BY e.created_at
             ) AS seq
        FROM engagements e
        LEFT JOIN tax_engagements te ON te.engagement_id = e.id
       WHERE e.status = 'active'
    ) ranked
    WHERE seq > 1;

    UPDATE tax_engagements
       SET stage = 'withdrawn'
     WHERE engagement_id IN (SELECT id FROM dupes)
       AND stage <> 'withdrawn';

    UPDATE engagements
       SET status = 'withdrawn',
           title  = 'Withdrawn — duplicate accept',
           ended_on = COALESCE(ended_on, CURRENT_DATE)
     WHERE id IN (SELECT id FROM dupes);
  `);
};

exports.down = () => {
  /*
   * Not reversible, deliberately. "Restore the duplicates" is not a state anyone wants,
   * and the rows are still there — withdrawn, titled, and dated — for anyone who needs to
   * see what happened.
   */
};
