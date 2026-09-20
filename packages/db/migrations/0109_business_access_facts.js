/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): WHO CAN GET INTO A CLIENT'S SYSTEMS —
 * as derived categories, and NEVER as a credential.
 *
 *   business_access_facts (business_id, fact, as_of, recorded_at, source)
 *
 * WHY THIS TABLE EXISTS AT ALL. The bundle's access_facts column answers questions that come up
 * every week and that nothing in SAOS can answer today: which clients does the firm hold a login
 * for, whose phone does the MFA code land on, which POS the sales figures come out of. The raw
 * Trello source of those answers is the one part of the export that could never be imported —
 * Rene's board carries plaintext logins in card descriptions, which is exactly why the bundle
 * extracted CATEGORIES and left the descriptions behind.
 *
 * SO THE SHAPE IS THE CONTROL. CLAUDE.md keeps credentials out of SAOS entirely (they live in
 * Vaultwarden), and a free-text "access notes" column would be a credential store within a month —
 * somebody would paste a password into it in good faith. The CHECK below refuses any fact that is
 * not one of three derived shapes, so the column physically cannot hold an email address, an
 * account number, a URL or a password: no '@', no spaces, no uppercase, no punctuation.
 *
 *   firm_holds_login              the firm has a login for this client's system
 *   client_sends_statements       the client sends statements rather than the firm pulling them
 *   firm_has_bank_access          read access to the bank feed (the bundle's bk_bank_access)
 *   mfa_code_goes_to_<who>        whose phone the second factor reaches — a first name, lowercase
 *   sales_source_<platform>       where the sales figures come from (square, toast, clover…)
 *
 * A TABLE AND NOT jsonb. Both can hold a set of tags; only the table gives each fact its own
 * as-of date and a primary key that makes the fact appear once. The bundle's own column repeats
 * tokens ("firm_holds_login mfa_code_goes_to_brian mfa_code_goes_to_brian"), which a jsonb array
 * would carry forward as duplicates and a PRIMARY KEY collapses for free.
 *
 * AS-OF, AGAIN. The bundle's access facts were last touched 2026-07-01 and are stale; a fact about
 * who holds a login must say when it was true, or an offboarded bookkeeper keeps access on paper
 * forever. NOT NULL here, because unlike a bookkeeping date there is no version of this fact worth
 * recording without its date.
 *
 * CREATES ONE TABLE. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE business_access_facts (
      business_id uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      fact        text          NOT NULL,
      as_of       date          NOT NULL,
      source      record_source NOT NULL DEFAULT 'native',
      recorded_at timestamptz   NOT NULL DEFAULT now(),
      PRIMARY KEY (business_id, fact)
    )
  `);
  /*
   * THE SHAPE IS THE GUARD. Lowercase letters, digits and underscores only, in one of the three
   * families. '@', ':', '/', '.', a space or an upper-case letter all fail, which is every shape a
   * credential, an email address, a URL or an account number takes.
   */
  await pgm.db.query(`
    ALTER TABLE business_access_facts
      ADD CONSTRAINT business_access_facts_is_a_derived_category
        CHECK (fact ~ '^(firm_holds_login|client_sends_statements|firm_has_bank_access|mfa_code_goes_to_[a-z][a-z_]*|sales_source_[a-z][a-z0-9_]*)$')
  `);
  await pgm.db.query(`CREATE INDEX idx_business_access_facts_fact ON business_access_facts (fact)`);
  await pgm.db.query(`
    COMMENT ON TABLE business_access_facts IS
      'Derived, non-secret facts about who can reach a client''s systems: firm_holds_login, client_sends_statements, firm_has_bank_access, mfa_code_goes_to_<who>, sales_source_<platform>. NEVER a credential — the CHECK on fact refuses any string that could be one. Credentials live in Vaultwarden (CLAUDE.md).'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN business_access_facts.as_of IS
      'The day this was true. Required: a stale "the firm holds the login" is how access outlives the person who had it.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS business_access_facts`);
};
