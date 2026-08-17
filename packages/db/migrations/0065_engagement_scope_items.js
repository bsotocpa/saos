/*
 * #47 — WHAT AN ENGAGEMENT COVERS (Brian's ruling 2026-08-16).
 *
 * #41 was not a display bug. Two engagements on one client were `tax`/`active` with no
 * business, no tax year, no start date, created the same day — indistinguishable BECAUSE
 * THEY WERE THE SAME THING TWICE, and nothing recorded what either one covered.
 * `engagements.title` was the only carrier, it is free text, and it read "Accepted quote".
 *
 * A SNAPSHOT, NOT A JOIN — Brian's requirement, and he was right that the design missed it.
 * The obvious table is (engagement_id, quote_line_item_id), a foreign key to a live row.
 * Editing that quote line afterwards would silently rewrite what the engagement claims to
 * cover, and nothing would look wrong. That is the same shape as the price-book bug the
 * price-lock fields exist to prevent: an agreement whose terms move after it was agreed.
 *
 * So the row carries the CONTENT as it read at acceptance, and the price-book version is
 * pinned beside it — an engagement answers "what did we agree, at what prices, under which
 * version" from its own rows, touching nothing that can still change.
 *
 * NO BACKFILL, confirmed. The 5 existing quotes were split into engagements in code and the
 * split was never recorded, so which engagement covered which line is genuinely unknowable.
 * Guessing and storing the guess would make an unreliable record look authoritative — the
 * exact error of my 426-client backfill. An engagement with no scope rows renders as it does
 * today.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE engagement_scope_items (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      engagement_id         uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,

      -- PROVENANCE ONLY. Deliberately no FK: a constraint would either block a legitimate
      -- quote edit or cascade a delete into the engagement's own record of what was agreed.
      -- Never joined to for display or totals — the columns below are the answer.
      source_quote_id       uuid,
      source_quote_line_id  uuid,

      -- THE SNAPSHOT: what was agreed, as it read at acceptance.
      price_book_version_id uuid NOT NULL REFERENCES price_book_versions(id),
      item_code             text NOT NULL,
      description_en        text NOT NULL,
      description_es        text,
      quantity              numeric(8,2) NOT NULL DEFAULT 1,
      unit_cents            integer,
      line_cents            integer,
      is_pass_through       boolean NOT NULL DEFAULT false,
      sort_order            integer NOT NULL DEFAULT 0,
      captured_at           timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_engagement_scope ON engagement_scope_items (engagement_id, sort_order);

    COMMENT ON TABLE engagement_scope_items IS
      '#47: what an engagement covers, snapshotted at acceptance. Written once, never updated — a later quote edit must not rewrite an agreement that was already made.';
    COMMENT ON COLUMN engagement_scope_items.source_quote_line_id IS
      'Provenance for tracing only. No FK on purpose: this must survive the quote line being edited or deleted. Never read for display or totals.';
    COMMENT ON COLUMN engagement_scope_items.description_en IS
      'The line text as it read when the client accepted. Both languages are frozen because a client who flips the portal to Spanish must not get Spanish chrome around English service names.';
  `);

  /*
   * WRITTEN ONCE, ENFORCED RATHER THAN PROMISED.
   *
   * "Never updated" is the whole point of the snapshot, and a comment saying so is exactly
   * the kind of guarantee that survives until the first person in a hurry. The trigger
   * refuses any UPDATE; correcting a wrong scope means withdrawing the engagement and
   * making a new one, which is the same rule closing already follows — the work someone
   * agreed to is the work that was quoted.
   *
   * DELETE stays allowed: ON DELETE CASCADE from engagements has to work.
   */
  pgm.sql(`
    CREATE FUNCTION engagement_scope_is_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'engagement_scope_items is a snapshot of what was agreed and cannot be updated (engagement %). To change scope, withdraw the engagement and create a new one.', OLD.engagement_id
        USING ERRCODE = 'restrict_violation';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_engagement_scope_immutable
      BEFORE UPDATE ON engagement_scope_items
      FOR EACH ROW EXECUTE FUNCTION engagement_scope_is_immutable();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_engagement_scope_immutable ON engagement_scope_items;
    DROP FUNCTION IF EXISTS engagement_scope_is_immutable();
    DROP TABLE IF EXISTS engagement_scope_items;
  `);
};
