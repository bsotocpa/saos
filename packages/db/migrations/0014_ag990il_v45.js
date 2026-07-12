/**
 * v4.5 (corrected master prompt, resolved July 11): AG990-IL — the Illinois
 * Attorney General charity annual report — joins the authoritative deadline
 * table. return_type gains the value so engagements can carry the filing.
 * The due-date rule (last day of the 6th month after FYE; 60-day AG
 * extensions, up to two; INDEPENDENT of the federal 990's extension clock)
 * lives in apps/api tax/deadlines.ts THE_TABLE — never a hardcoded date.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE return_type ADD VALUE IF NOT EXISTS 'ag990il';`);
};

exports.down = () => {
  // Enum values cannot be dropped in place; harmless to leave on rollback.
};
