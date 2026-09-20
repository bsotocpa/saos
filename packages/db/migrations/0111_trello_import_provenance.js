/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): the provenance of a Trello-imported row,
 * and the RERUN GUARD that makes importing twice a no-op.
 *
 *   record_source += 'trello'                  (contacts.source, businesses.source, the tags)
 *   import_source += 'trello'                  (engagements.source, tax_engagements.source)
 *   contacts.unverified_import_source          record_source  — the mirror of 0103's business tag
 *   engagements.source                         import_source  — the table had none
 *   tax_engagements.source                     import_source  — the table had none
 *   <table>.trello_card_id                     text, on contacts, businesses, engagements,
 *                                              tax_engagements and tasks
 *   UNIQUE (source, trello_card_id) WHERE trello_card_id IS NOT NULL, on each of the five
 *
 * ── WHY THE CARD ID IS ON THE ROW AND NOT IN AN IMPORT LEDGER ──
 *
 * Ruling: "no production import now; Phase 2 runs at each role's cutover from a fresh bundle."
 * Five cutovers means five imports, each from a bundle rebuilt that day, each overlapping the last.
 * The rerun guard therefore cannot be "remember what the last run did" — the last run was a
 * different bundle, and a ledger the script consults is a guard that fails the moment somebody runs
 * the script from a different machine. Putting the card id ON THE ROW and letting the DATABASE
 * refuse the second one moves the guard to the only place that sees every attempt.
 *
 * The index is PARTIAL because almost every row in these tables has no card id and never will;
 * a full unique index would collapse all of them onto a single NULL-bearing key per source.
 *
 * ── WHAT THE KEY MEANS, STATED SO THE NEXT TRACK IS NOT SURPRISED ──
 *
 * (source, trello_card_id) says: ONE ROW PER CARD PER TABLE. That is exactly right for what the
 * 2026-09-20 import creates — a tax card becomes one engagement and one tax_engagement, a business
 * card becomes one business, a person's card becomes one contact. It also means a future import
 * that wants to create THREE engagements from one file-04 business card (bookkeeping, sales tax,
 * payroll all live on the same card) cannot use this key as-is: that import needs its own
 * discriminator, and it will have to say so rather than discover it. Named here because a
 * constraint whose limits are undocumented gets worked around instead of extended.
 *
 * AND IT HAPPENED THE NEXT DAY, from the other direction: R23 gives one card two TASKS (an A/R
 * worklist item and a notify-the-client item), so migration 0114 replaces the tasks index with
 * (source, trello_card_id, source_type). The other four tables keep the key below. Read 0114's
 * header before assuming this one describes the tasks table.
 *
 * ── WHY contacts GETS unverified_import_source ──
 *
 * Migration 0103 tags an unverified imported BUSINESS by setting businesses.unverified_import_source
 * to where the row came from; the client page and every business picker read it. Brian's instruction
 * for this import is that created people are tagged the same way, and contacts had no such column —
 * contacts.source alone says where a row came from, not that nobody has verified it. A person typed
 * into a Trello card by hand, with no email, no SSN and no engagement, is exactly the record that
 * must announce itself as unverified wherever staff look at it.
 *
 * ── source ON engagements AND tax_engagements ──
 *
 * Neither table had any notion of where its row came from, because until now every engagement was
 * made by a person in the app. import_source (not record_source) because these are batch-import
 * artefacts, the same family as import_batches.source, and NULL is the honest default: it means
 * "made in SAOS", which is true of every existing row.
 *
 * ADDS TWO ENUM VALUES, FIVE COLUMNS AND FIVE INDEXES. Touches no rows.
 */
exports.shorthands = undefined;

/** Every column that will still be typed record_source when the down migration rebuilds the type. */
const RECORD_SOURCE_COLUMNS = [
  ['contacts', 'source', `'native'`],
  ['businesses', 'source', `'native'`],
  ['businesses', 'unverified_import_source', null],
  ['grants_received', 'source', `'native'`],
  // Added by 0109, which is still applied when 0111 comes down.
  ['business_access_facts', 'source', `'native'`],
];

exports.up = async (pgm) => {
  // lessons.md: every statement through pgm.db.query, in order — pgm.sql() would queue the DDL
  // until after this function returned, and the indexes below need the columns to exist now.
  await pgm.db.query(`ALTER TYPE record_source ADD VALUE IF NOT EXISTS 'trello'`);
  await pgm.db.query(`ALTER TYPE import_source ADD VALUE IF NOT EXISTS 'trello'`);

  await pgm.db.query(`ALTER TABLE contacts ADD COLUMN unverified_import_source record_source`);
  await pgm.db.query(`
    COMMENT ON COLUMN contacts.unverified_import_source IS
      'Set when the contact was created by a batch import and nobody has verified them since: a name typed into a source system by hand, with no email, no SSN and no engagement. The value is where the row came from. NULL = not tagged. The mirror of businesses.unverified_import_source (migration 0103).'
  `);

  await pgm.db.query(`ALTER TABLE engagements      ADD COLUMN source import_source`);
  await pgm.db.query(`ALTER TABLE tax_engagements  ADD COLUMN source import_source`);
  await pgm.db.query(`
    COMMENT ON COLUMN engagements.source IS
      'The batch import that created this engagement. NULL = made in SAOS by a person, which is every row before 2026-09-20.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagements.source IS
      'The batch import that created this return. NULL = made in SAOS by a person.'
  `);

  for (const table of ['contacts', 'businesses', 'engagements', 'tax_engagements', 'tasks']) {
    await pgm.db.query(`ALTER TABLE ${table} ADD COLUMN trello_card_id text`);
    await pgm.db.query(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_trello_card_id_not_blank
          CHECK (trello_card_id IS NULL OR length(btrim(trello_card_id)) > 0)
    `);
    /*
     * THE RERUN GUARD. A second import of the same card is refused by the database rather than by
     * the script remembering, which is the only version of the guard that survives a rerun from a
     * different machine, a different bundle, or a different person's hand.
     */
    await pgm.db.query(`
      CREATE UNIQUE INDEX uq_${table}_trello_card
        ON ${table} (source, trello_card_id) WHERE trello_card_id IS NOT NULL
    `);
    await pgm.db.query(`
      COMMENT ON COLUMN ${table}.trello_card_id IS
        'The Trello card this row was imported from. NULL for everything made in SAOS. Unique per (source, trello_card_id): importing the same card twice creates nothing.'
    `);
  }
};

exports.down = async (pgm) => {
  for (const table of ['contacts', 'businesses', 'engagements', 'tax_engagements', 'tasks']) {
    await pgm.db.query(`DROP INDEX IF EXISTS uq_${table}_trello_card`);
    await pgm.db.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_trello_card_id_not_blank`);
    await pgm.db.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS trello_card_id`);
  }
  await pgm.db.query(`ALTER TABLE contacts         DROP COLUMN IF EXISTS unverified_import_source`);
  await pgm.db.query(`ALTER TABLE engagements      DROP COLUMN IF EXISTS source`);
  await pgm.db.query(`ALTER TABLE tax_engagements  DROP COLUMN IF EXISTS source`);

  /*
   * Postgres cannot drop an enum value, so both types are rebuilt. REFUSED rather than destructive:
   * 0010's down DELETEs the rows that used the value it is removing, which is defensible for a
   * grants sheet and indefensible for imported clients. If a row says it came from Trello, that is
   * a fact about a client record, and a down migration does not get to delete a client to shrink a
   * type. It stops and names the count.
   */
  const inUse = await pgm.db.query(`
    SELECT (SELECT count(*) FROM contacts   WHERE source = 'trello')::int AS contacts,
           (SELECT count(*) FROM businesses WHERE source = 'trello'
                                               OR unverified_import_source = 'trello')::int AS businesses,
           (SELECT count(*) FROM grants_received WHERE source = 'trello')::int AS grants,
           (SELECT count(*) FROM business_access_facts WHERE source = 'trello')::int AS access_facts,
           (SELECT count(*) FROM import_batches WHERE source = 'trello')::int AS batches
  `);
  const u = inUse.rows[0];
  const total = u.contacts + u.businesses + u.grants + u.access_facts + u.batches;
  if (total > 0) {
    throw new Error(
      `0111 down: ${total} row(s) still say their source is 'trello' ` +
        `(contacts ${u.contacts}, businesses ${u.businesses}, grants ${u.grants}, ` +
        `access facts ${u.access_facts}, import batches ${u.batches}). Postgres cannot drop an enum ` +
        `value while it is in use, and this migration will not delete client records to shrink a ` +
        `type. Re-source or remove those rows first.`
    );
  }

  await pgm.db.query(`ALTER TYPE record_source RENAME TO record_source_old`);
  await pgm.db.query(`CREATE TYPE record_source AS ENUM ('native', 'dubsado', 'zoho', 'grant_tracker')`);
  for (const [table, column, dflt] of RECORD_SOURCE_COLUMNS) {
    if (dflt) await pgm.db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
    await pgm.db.query(
      `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE record_source USING ${column}::text::record_source`
    );
    if (dflt) await pgm.db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${dflt}`);
  }
  await pgm.db.query(`DROP TYPE record_source_old`);

  await pgm.db.query(`ALTER TYPE import_source RENAME TO import_source_old`);
  await pgm.db.query(`CREATE TYPE import_source AS ENUM ('dubsado', 'zoho', 'grant_tracker')`);
  await pgm.db.query(
    `ALTER TABLE import_batches ALTER COLUMN source TYPE import_source USING source::text::import_source`
  );
  await pgm.db.query(`DROP TYPE import_source_old`);
};
