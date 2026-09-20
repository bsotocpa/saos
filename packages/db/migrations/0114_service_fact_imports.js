/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, rulings R21 and R23):
 *
 *   service_fact_imports                                  the idempotency ledger for 04b
 *     PRIMARY KEY (source, trello_source_id, fact_type)   — R21's key, exactly
 *   tax_engagement_jurisdictions.declared_by_import_default   R23's marker
 *
 * ── WHY A LEDGER AND NOT TWO COLUMNS ON EVERY FACT TABLE ────────────────────
 *
 * R21: "the idempotency key is (source, trello_source_id, fact_type) (a unique index; migration
 * 0114 if the 0109/0105-0110 shapes need a fact table or column for trello_source_id and
 * fact_type)". They do, and the shape that fits is a ledger rather than a pair of columns
 * everywhere, for three reasons that are all about the fact that ONE SOURCE ROW IS NOT ONE FACT ROW:
 *
 *   · An 04b `access` row carries {"facts": ["firm_holds_login", "mfa_code_goes_to_client"]} and
 *     becomes TWO business_access_facts rows. A unique index on (source, trello_source_id,
 *     fact_type) placed on that table would refuse the second one — the key would be enforcing
 *     "one fact per source row", which is not what the bundle contains.
 *   · A `bookkeeping` row writes businesses.books_current_through and its as-of date: a column on
 *     an existing row, not a row of its own. There is nowhere on `businesses` to put a per-fact
 *     provenance key without inventing one column pair per fact type, and a business can legitimately
 *     receive facts from several 04b rows.
 *   · An `annual_report_anniversary` row writes entity_compliance, a third table again.
 *
 * So the FACTS keep living in their typed homes (0105-0110), where a reader looks for them, and
 * WHETHER A SOURCE ROW HAS BEEN APPLIED becomes its own record. That is the thing idempotency is
 * actually about: not "does this value exist" — a value can be legitimately equal by coincidence —
 * but "have we already done what this row says". A second run finds the ledger row and does nothing.
 *
 * THE NAME KEY IS NEVER THE KEY (R21). `match_key` is in the ledger for reading only, and is not
 * part of the primary key: two Trello cards can carry the same hand-typed business name, and a name
 * can be re-typed between bundles. trello_source_id is the card (or the checklist-item id for an
 * anniversary, or `<card>:access` for an access row) and it is stable across bundles, which is the
 * whole reason Brian moved the key onto it.
 *
 * ── R23's MARKER ────────────────────────────────────────────────────────────
 *
 * A return imported as "filed, awaiting ack" declares its jurisdictions from the R2 DEFAULT — what
 * the address implies — because the Trello card never said where the return went. That is a
 * defensible thing to write and an indefensible thing to leave indistinguishable from a preparer's
 * own declaration: the preparer knows, the default guesses. The boolean says which, so the confirm
 * task has something to clear and a report can count the unconfirmed ones. It defaults false, so
 * every row anything else writes keeps meaning "somebody said so".
 *
 * ── AND ONE INDEX 0111 GOT WRONG, WHICH 0111 PREDICTED ──────────────────────
 *
 *   uq_tasks_trello_card  (source, trello_card_id)
 *     becomes
 *   uq_tasks_trello_card_type  (source, trello_card_id, source_type)
 *
 * 0111's header said it plainly: "(source, trello_card_id) says: ONE ROW PER CARD PER TABLE… a
 * future import that wants to create THREE engagements from one file-04 business card cannot use
 * this key as-is: that import needs its own discriminator, and it will have to say so rather than
 * discover it." R23 is that future, one day later and from the other direction — not one card into
 * three engagements, but one card into two TASKS.
 *
 * Nine cards appear in BOTH file 01 and file 02 of the 2026-09-20 bundle. A card reading "accepted,
 * client not yet notified" earns a comms_billing task to tell the client (R23) from file 01 and an
 * A/R worklist task from file 02 — two different pieces of work, for two different people, from one
 * card. The old index refused the second one with a constraint violation mid-import.
 *
 * SO THE DISCRIMINATOR IS THE TASK TYPE, which is the true invariant and not a workaround: a card
 * may produce at most ONE TASK OF EACH KIND. That is exactly what createTask's own
 * (source_type, source_id) dedupe already enforces in the application, so the index now agrees with
 * the door instead of being stricter than it. Rerun protection is unchanged — a second import of the
 * same card still creates nothing, because nothing about it has a new type.
 *
 * The four other tables keep (source, trello_card_id): a card really does become at most one contact,
 * one business, one engagement and one return, and loosening those would lose the guarantee.
 *
 * CREATES ONE TABLE, ADDS ONE COLUMN, REPLACES ONE INDEX. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // lessons.md: DDL and any row work through pgm.db.query, in order.
  await pgm.db.query(`
    CREATE TABLE service_fact_imports (
      source           import_source NOT NULL,
      trello_source_id text          NOT NULL,
      fact_type        text          NOT NULL,
      business_id      uuid          REFERENCES businesses(id) ON DELETE CASCADE,
      match_key        text,
      as_of            date          NOT NULL,
      applied_at       timestamptz   NOT NULL DEFAULT now(),
      applied_by       text          NOT NULL,
      /* How many rows this source row actually wrote. 0 is a real answer: the row was read, the
       * fact was already true, and nothing changed — which is what the second pass must record so
       * "applied" and "changed something" stay different questions. */
      rows_written     integer       NOT NULL DEFAULT 0,
      PRIMARY KEY (source, trello_source_id, fact_type)
    )
  `);
  await pgm.db.query(`
    ALTER TABLE service_fact_imports
      ADD CONSTRAINT service_fact_imports_ids_not_blank
        CHECK (length(btrim(trello_source_id)) > 0 AND length(btrim(fact_type)) > 0)
  `);
  await pgm.db.query(`CREATE INDEX idx_service_fact_imports_business ON service_fact_imports (business_id)`);
  await pgm.db.query(`CREATE INDEX idx_service_fact_imports_type ON service_fact_imports (fact_type)`);
  await pgm.db.query(`
    COMMENT ON TABLE service_fact_imports IS
      'The idempotency ledger for imported service facts (Brian, 2026-09-20, R21). One row per source row applied, keyed (source, trello_source_id, fact_type). The FACTS live in their typed homes — businesses.books_current_through, business_access_facts, entity_compliance, engagements — and this records whether a source row has already been applied. match_key is for reading only and is deliberately NOT part of the key: a hand-typed name is not an identity.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN service_fact_imports.rows_written IS
      'How many rows this source row wrote when it was applied. 0 means the fact was already true — read, applied, nothing changed.'
  `);

  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD COLUMN declared_by_import_default boolean NOT NULL DEFAULT false
  `);
  /*
   * The old index is dropped before the new one is created, in that order, so a moment never exists
   * where both constrain the table — a second task for a card would fail against the old one even
   * while the new one permitted it.
   */
  await pgm.db.query(`DROP INDEX IF EXISTS uq_tasks_trello_card`);
  await pgm.db.query(`
    CREATE UNIQUE INDEX uq_tasks_trello_card_type
      ON tasks (source, trello_card_id, source_type) WHERE trello_card_id IS NOT NULL
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tasks.trello_card_id IS
      'The Trello card this task was imported from. NULL for everything made in SAOS. Unique per (source, trello_card_id, source_type): one card may produce at most one task of each KIND — an A/R worklist item and a notify-the-client item can both come off the same card, and do for 9 cards in the 2026-09-20 bundle.'
  `);

  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.declared_by_import_default IS
      'True when this jurisdiction was declared by the IMPORT from the address default rather than by a preparer who knew (Brian, 2026-09-20, R23). An imported "filed, awaiting ack" return carries a preparer task to confirm the list; until it is confirmed these rows are a default, not a declaration.'
  `);
};

exports.down = async (pgm) => {
  /*
   * BOTH names are dropped before the old one is recreated. A down that only dropped the new name
   * would fail on a database where this migration had been applied in an earlier form — which is
   * exactly what happened while it was being written, and is the ordinary state of an uncommitted
   * migration being iterated on.
   */
  await pgm.db.query(`DROP INDEX IF EXISTS uq_tasks_trello_card_type`);
  await pgm.db.query(`DROP INDEX IF EXISTS uq_tasks_trello_card`);
  await pgm.db.query(`
    CREATE UNIQUE INDEX uq_tasks_trello_card
      ON tasks (source, trello_card_id) WHERE trello_card_id IS NOT NULL
  `);
  await pgm.db.query(`ALTER TABLE tax_engagement_jurisdictions DROP COLUMN IF EXISTS declared_by_import_default`);
  await pgm.db.query(`DROP TABLE IF EXISTS service_fact_imports`);
};
