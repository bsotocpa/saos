/*
 * ONE VOCABULARY FOR ONE GAP, and a queue that reflects TODAY rather than July.
 *
 * Two defects found while building the entity-type classification pass Brian ruled as the first
 * task of annual-report enrolment (2026-08-17). Both are the same species: something reported a
 * number that was true once.
 *
 * 1. TWO NAMES FOR ONE GAP. The July import wrote business-level gaps prefixed —
 *    `business:entity_type` — and `computeEnrichmentGaps()` wrote them bare — `entity_type`.
 *    Same column, same meaning. Production carried 304 prefixed against 1 bare, the bare ones
 *    appearing only where a contact happened to have been edited since. Nothing crashed; a
 *    filter on either name would simply have missed part of the book, and the first such filter
 *    was the classification pass itself. The code now emits the prefixed form (it carries
 *    information the bare form does not — the gap is about a BUSINESS, not the person); this
 *    converts the strays.
 *
 * 2. THE QUEUE WAS A JULY SNAPSHOT. `enrichment_queue` rows were written once by the import and
 *    only ever recomputed for a contact somebody edited. So the queue's idea of who is missing an
 *    entity type had been drifting away from the businesses table for a month, in both
 *    directions: gaps closed by later edits still listed, and businesses added since never
 *    listed at all. This recomputes every open row's business-level gaps from the live tables.
 *
 * Deliberately SQL rather than a script calling refreshEnrichmentGaps(): this must run for every
 * environment on deploy, and the recompute is a set operation. The task-side refresh still
 * happens through the service on the next edit — this fixes the machine-readable queue that the
 * classification pass reads.
 *
 * `down` restores neither: putting two spellings back into one column would be reintroducing the
 * defect, and re-freezing July's counts would be worse than either.
 */

exports.up = (pgm) => {
  // ── 1. One vocabulary ──
  pgm.sql(`
    UPDATE enrichment_queue
       SET missing_fields = (
             SELECT array_agg(DISTINCT CASE
                      WHEN f IN ('ein', 'entity_type', 'industry') THEN 'business:' || f
                      ELSE f END)
               FROM unnest(missing_fields) AS f
           )
     WHERE resolved_at IS NULL
       AND missing_fields && ARRAY['ein', 'entity_type', 'industry']
  `);

  /*
   * ── 2. Recompute business-level gaps from the live tables ──
   *
   * Contact-level gaps (email, phone) are preserved as they stand: they are recomputed the same
   * way by the service and nothing here has better information about them. Only the three
   * business-derived fields are rebuilt, because those are the ones the July snapshot froze.
   */
  pgm.sql(`
    WITH live AS (
      SELECT q.id,
             ARRAY(
               SELECT f FROM unnest(q.missing_fields) AS f
                WHERE f NOT LIKE 'business:%'
             )
             ||
             ARRAY(
               SELECT DISTINCT g FROM (
                 SELECT 'business:ein' AS g
                   FROM business_members m JOIN businesses b ON b.id = m.business_id
                  WHERE m.contact_id = q.contact_id AND b.ein IS NULL
                 UNION ALL
                 SELECT 'business:entity_type'
                   FROM business_members m JOIN businesses b ON b.id = m.business_id
                  WHERE m.contact_id = q.contact_id AND b.entity_type IS NULL
                 UNION ALL
                 SELECT 'business:industry'
                   FROM business_members m JOIN businesses b ON b.id = m.business_id
                  WHERE m.contact_id = q.contact_id AND b.industry IS NULL
               ) s
                ORDER BY g
             ) AS fields
        FROM enrichment_queue q
       WHERE q.resolved_at IS NULL
    )
    UPDATE enrichment_queue q
       SET missing_fields = live.fields
      FROM live
     WHERE q.id = live.id AND q.missing_fields <> live.fields
  `);

  // A row whose gaps all closed is resolved, not left sitting at zero fields.
  pgm.sql(`
    UPDATE enrichment_queue
       SET resolved_at = now()
     WHERE resolved_at IS NULL AND cardinality(missing_fields) = 0
  `);

  pgm.sql(`
    DO $report$
    DECLARE bare int; typed int; unclassified int; resolved int;
    BEGIN
      SELECT count(*) INTO bare FROM enrichment_queue
       WHERE resolved_at IS NULL AND missing_fields && ARRAY['ein','entity_type','industry'];
      SELECT count(*) INTO typed FROM enrichment_queue
       WHERE resolved_at IS NULL AND 'business:entity_type' = ANY(missing_fields);
      SELECT count(*) INTO unclassified FROM businesses WHERE entity_type IS NULL;
      SELECT count(*) INTO resolved FROM enrichment_queue WHERE resolved_at IS NOT NULL;
      RAISE WARNING '0077: bare business gaps remaining = % (want 0)', bare;
      RAISE WARNING '0077: queue rows flagging business:entity_type = %, businesses with no type = %', typed, unclassified;
      RAISE WARNING '0077: resolved enrichment rows = %', resolved;
    END
    $report$;
  `);
};

exports.down = () => {
  /* Empty on purpose — see the header. */
};
