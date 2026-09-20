/* eslint-disable camelcase */
/**
 * JURISDICTIONS ARE DECLARED ON THE RETURN (2026-09-19 evening, Brian's ruling 2).
 *
 * Completion used to read one state off the client's or the entity's address and call that "the
 * state this return files in". A return with two state filings could never complete, a return for
 * a client living in a no-income-tax state waited forever on a filing that does not exist, and a
 * second state's acknowledgment was recorded as somebody else's business. None of that is a
 * property of an address: it is a decision the preparer makes when the return goes out the door.
 *
 * So the return carries the list. One row per jurisdiction — 'federal' plus zero or more
 * two-letter state codes — written when the return is marked filed, each row carrying its own
 * acceptance. A return completes when every row it declares has accepted.
 *
 * A TABLE, NOT A text[] COLUMN. Both can hold the list; only the table can hold the list AND each
 * jurisdiction's own acknowledgment (accepted date, submission id) without a second parallel array
 * to keep in step. The primary key is the invariant that a jurisdiction appears once per return.
 * A REJECTION stays where it already lives — reject_code and perfection_deadline on the return —
 * because the perfection clock is one clock on one return, whichever jurisdiction rejected it; no
 * per-jurisdiction rejection columns are added until something needs them.
 *
 * WHAT IS KEPT FOR COMPATIBILITY: tax_engagements.federal_accepted_on and
 * state_accepted_on / state_accepted_code stay, and the acknowledgment ingest keeps writing them —
 * the FIRST state to accept fills the state pair. Every existing reader (the returns list, the Ops
 * client page, the harness's read of state_accepted_code, the specs) is unchanged by this
 * migration. The table is the authority for completion; those columns are the summary.
 *
 * TOUCHES ROWS. Every return already at or past 'filed' is given its declared list, derived the
 * same way the code derives its defaults (federal, plus the entity's state on a business return
 * else the contact's, and no state at all for the nine states with no income tax), with each
 * jurisdiction's acceptance copied from the columns above so nothing that is complete today
 * becomes incomplete. Pre-filed returns get nothing: they declare at filing. Every row written is
 * printed below by return id, year and return type — no client names, no PII.
 */
exports.shorthands = undefined;

/** The nine states that levy no income tax: the default declared list for them is federal alone. */
const NO_INCOME_TAX_STATES = ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY'];
const FILED_OR_LATER = `('filed', 'rejected', 'completed')`;

exports.up = async (pgm) => {
  // pgm.sql() is queued until this function returns; the row work below runs NOW, through this
  // same connection. So the DDL is issued with pgm.db.query() in order, or the backfill finds no
  // table (lessons.md: "the migration does DDL and any row work through pgm.db.query in order").
  await pgm.db.query(`
    CREATE TABLE tax_engagement_jurisdictions (
      tax_engagement_id uuid NOT NULL REFERENCES tax_engagements(id) ON DELETE CASCADE,
      jurisdiction      text NOT NULL CHECK (jurisdiction = 'federal' OR jurisdiction ~ '^[A-Z]{2}$'),
      accepted_on       date,
      submission_id     text,
      declared_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tax_engagement_id, jurisdiction)
    )
  `);
  await pgm.db.query(`
    COMMENT ON TABLE tax_engagement_jurisdictions IS
      'The jurisdictions a return declares at filing: federal plus zero or more states. A return completes when every row here is accepted. tax_engagements.federal_accepted_on / state_accepted_on are kept in step as the summary (the first state fills the pair).'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.jurisdiction IS
      $$'federal' or a two-letter upper-case state code. The preparer edits the list in the Mark filed modal; the default comes from the entity's state, else the contact's, and is federal alone for a no-income-tax state.$$
  `);
  await pgm.db.query(`
    CREATE INDEX idx_tax_engagement_jurisdictions_awaiting
      ON tax_engagement_jurisdictions (tax_engagement_id) WHERE accepted_on IS NULL
  `);

  const { rows } = await pgm.db.query(
    `SELECT te.id, te.tax_year, te.return_type::text AS return_type, te.stage::text AS stage,
            te.federal_accepted_on::text AS federal_accepted_on,
            te.state_accepted_on::text  AS state_accepted_on,
            te.state_accepted_code,
            upper(trim(COALESCE(CASE WHEN e.business_id IS NOT NULL THEN b.state ELSE c.state END, ''))) AS derived_state
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE te.stage::text IN ${FILED_OR_LATER}
      ORDER BY te.tax_year, te.id`
  );

  const declared = [];
  for (const r of rows) {
    // The state the return files in, as the code derives it: the one already acknowledged when
    // there is one (it can only be the derived state today), else the derived state, and none for
    // a no-income-tax state.
    const acked = (r.state_accepted_code ?? '').trim().toUpperCase();
    const state = acked || r.derived_state || '';
    const states = state && !NO_INCOME_TAX_STATES.includes(state) ? [state] : [];
    declared.push({
      tax_engagement_id: r.id,
      jurisdiction: 'federal',
      accepted_on: r.federal_accepted_on,
      submission_id: null,
    });
    for (const s of states) {
      declared.push({
        tax_engagement_id: r.id,
        jurisdiction: s,
        // Only the state that actually acknowledged carries a date.
        accepted_on: acked === s ? r.state_accepted_on : null,
        submission_id: null,
      });
    }
  }

  console.log(`0104: declaring jurisdictions on ${rows.length} return(s) already at or past 'filed' (${declared.length} row(s)):`);
  for (const r of rows) {
    const mine = declared.filter((d) => d.tax_engagement_id === r.id);
    const shown = mine.map((d) => `${d.jurisdiction}${d.accepted_on ? ` accepted ${d.accepted_on}` : ' awaiting'}`).join(', ');
    console.log(`0104:   ${r.id}  ·  ${r.tax_year} ${r.return_type.toUpperCase()}  ·  ${r.stage}  ·  ${shown}`);
  }
  if (declared.length === 0) return;

  await pgm.db.query(
    `INSERT INTO tax_engagement_jurisdictions (tax_engagement_id, jurisdiction, accepted_on, submission_id)
     SELECT x.tax_engagement_id, x.jurisdiction, x.accepted_on, x.submission_id
       FROM jsonb_to_recordset($1::jsonb)
         AS x(tax_engagement_id uuid, jurisdiction text, accepted_on date, submission_id text)
     ON CONFLICT (tax_engagement_id, jurisdiction) DO NOTHING`,
    [JSON.stringify(declared)]
  );
  await pgm.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
     SELECT 'system', 'migration 0104 (ruled by Brian, 2026-09-19)', 'tax_engagement.jurisdictions_declared', 'tax_engagement', x.id,
            jsonb_build_object(
              'reason', 'jurisdictions are declared on the return; the filed returns were given the list the code derived from the entity or contact state',
              'jurisdictions', x.jurisdictions)
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, jurisdictions jsonb)`,
    [
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          jurisdictions: declared.filter((d) => d.tax_engagement_id === r.id).map((d) => d.jurisdiction),
        }))
      ),
    ]
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS tax_engagement_jurisdictions;`);
};
