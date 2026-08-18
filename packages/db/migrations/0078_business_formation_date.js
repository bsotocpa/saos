/*
 * FORMATION DATE ON THE BUSINESS, WITH ITS PROVENANCE — and the duplicate column retired.
 *
 * Brian's ruling (2026-08-17): "Add formation_date to businesses, populated from ILSOS at
 * enrollment time, stored with a source stamp."
 *
 * WHY THE SOURCE STAMP IS NOT DECORATION. This date derives a STATUTORY deadline: in Illinois
 * the formation date IS the annual-report due date. A date somebody half-remembered on a call and
 * a date read off the state's own register produce identical-looking rows and identical-looking
 * deadlines — the same indistinguishability that `RESEARCHED_ANNUAL_REPORT_STATES` and
 * `due_date_override_reason` exist to break. So the column cannot be stored alone: the CHECK
 * makes date, source and timestamp all-or-nothing, exactly like
 * `entity_compliance_override_is_complete` in 0072. A date with no provenance cannot be written.
 *
 * The sources are ordered by how much weight they can carry:
 *   · `sos_register`   — read from the Secretary of State's own record. Authoritative.
 *   · `sos_document`   — off a filed document we hold (articles, a stamped annual report).
 *   · `staff_verified` — a person checked something and typed it. Provenance is the person.
 *   · `client_stated`  — the client told us. WEAKEST, and the one most likely to be a year out;
 *                        people remember when they started trading, not when the state stamped it.
 *
 * `client_stated` is deliberately allowed rather than banned. Refusing it would not make better
 * data appear — it would leave the column NULL and the entity untracked, which is worse than a
 * tracked entity whose date is labelled as unverified.
 *
 * ── AND THE DUPLICATE GOES ──
 *
 * `entity_compliance.formation_date` already held this fact. Two columns for one fact is the
 * defect I documented hours ago in the enrichment queue — two spellings of one gap, drifting
 * apart with nothing reporting it. The business is the right owner: a company has one formation
 * date whether or not anybody enrolled it in tracking, and it survives the compliance row being
 * deleted and recreated.
 *
 * Dropped outright rather than mirrored, because production holds ZERO compliance rows and zero
 * formation dates. The soto_status pattern says mirror only when a reader cannot move
 * immediately; every reader here is in this repo and moves in the same commit. This is the
 * cheapest this will ever be.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses
      ADD COLUMN formation_date date,
      ADD COLUMN formation_date_source text,
      ADD COLUMN formation_date_recorded_at timestamptz
  `);

  pgm.sql(`
    COMMENT ON COLUMN businesses.formation_date IS
      'Date the state formed/registered this entity. In anniversary-based states (IL) this IS the annual-report deadline, so it is never stored without its provenance.';
    COMMENT ON COLUMN businesses.formation_date_source IS
      'Where the date came from, weakest to strongest: client_stated < staff_verified < sos_document < sos_register. Read it before trusting a derived deadline.';
  `);

  // All three together or none — a date with no provenance is the thing this prevents.
  pgm.sql(`
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_formation_date_is_sourced CHECK (
        (formation_date IS NULL AND formation_date_source IS NULL AND formation_date_recorded_at IS NULL)
        OR
        (formation_date IS NOT NULL AND formation_date_source IS NOT NULL AND formation_date_recorded_at IS NOT NULL)
      ),
      ADD CONSTRAINT businesses_formation_date_source_known CHECK (
        formation_date_source IS NULL
        OR formation_date_source IN ('sos_register', 'sos_document', 'staff_verified', 'client_stated')
      )
  `);

  /*
   * Carry anything that exists before dropping — production has none, but a developer database
   * might, and a migration that silently discards data it did not check for is how the next one
   * gets written carelessly. `staff_verified` is the honest label: somebody typed it into the
   * enrolment form, and nothing recorded where they got it.
   */
  pgm.sql(`
    UPDATE businesses b
       SET formation_date = ec.formation_date,
           formation_date_source = 'staff_verified',
           formation_date_recorded_at = COALESCE(ec.created_at, now())
      FROM entity_compliance ec
     WHERE ec.business_id = b.id
       AND ec.formation_date IS NOT NULL
       AND b.formation_date IS NULL
  `);

  pgm.sql(`
    DO $report$
    DECLARE carried int;
    BEGIN
      SELECT count(*) INTO carried FROM businesses WHERE formation_date IS NOT NULL;
      RAISE WARNING '0078: formation dates carried onto businesses = %', carried;
    END
    $report$;
  `);

  pgm.sql(`ALTER TABLE entity_compliance DROP COLUMN formation_date`);
};

exports.down = (pgm) => {
  /*
   * Reversible, unlike the SOP migrations: this is structure, and a rollback that left the new
   * columns behind would leave the code reading a column its schema no longer guarantees. The
   * dates come back onto the compliance rows so a downgrade does not lose them.
   */
  pgm.sql(`ALTER TABLE entity_compliance ADD COLUMN formation_date date`);
  pgm.sql(`
    UPDATE entity_compliance ec
       SET formation_date = b.formation_date
      FROM businesses b
     WHERE b.id = ec.business_id AND b.formation_date IS NOT NULL
  `);
  pgm.sql(`
    ALTER TABLE businesses
      DROP CONSTRAINT IF EXISTS businesses_formation_date_is_sourced,
      DROP CONSTRAINT IF EXISTS businesses_formation_date_source_known,
      DROP COLUMN formation_date,
      DROP COLUMN formation_date_source,
      DROP COLUMN formation_date_recorded_at
  `);
};
