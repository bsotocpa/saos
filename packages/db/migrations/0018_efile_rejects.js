/**
 * M26 flow 1 (v4.3 "no dead-end engagement states"): Filed is NOT terminal
 * until e-file ACCEPTANCE. Rejects re-queue with an IRS perfection-period
 * clock (10 days business / 5 days individual, derived from return type in
 * code — never hardcoded at call sites) and an owned fix-and-refile task.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE tax_stage ADD VALUE IF NOT EXISTS 'rejected';`);
  pgm.sql(`
    ALTER TABLE tax_engagements
      ADD COLUMN efile_accepted_at   timestamptz,
      ADD COLUMN rejected_at         timestamptz,
      ADD COLUMN reject_code         text,
      ADD COLUMN reject_reason       text,
      ADD COLUMN perfection_deadline date;
    -- flow 1 companion: notice-response billing links its price-book invoice.
    ALTER TABLE irs_notices ADD COLUMN invoice_id uuid REFERENCES invoices(id);
    COMMENT ON COLUMN tax_engagements.perfection_deadline IS
      'IRS perfection period after an e-file reject: re-file by this date to keep the original filing date. Cleared on successful re-file.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements
      DROP COLUMN efile_accepted_at, DROP COLUMN rejected_at, DROP COLUMN reject_code,
      DROP COLUMN reject_reason, DROP COLUMN perfection_deadline;
    ALTER TABLE irs_notices DROP COLUMN invoice_id;
  `);
  // 'rejected' stays in the enum (values cannot be dropped in place).
};
