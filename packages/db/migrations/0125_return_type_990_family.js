/* eslint-disable camelcase */
/**
 * THE FORM 990 FAMILY (Brian, 2026-09-26, R66). Ana-Maria's first SAOS returns are three Form 990s
 * due 2026-11-15, and the enum knew 990 and 990-EZ alone. 990-PF (a private foundation) and 990-T
 * (an exempt organization's unrelated business income) join it. Their deadlines derive from the
 * table in apps/api tax/deadlines.ts (the 15th day of the fifth month after the fiscal year end,
 * +6 months on extension, Form 8868 for all four) — never a literal date pair here or anywhere.
 *
 * Same shape as 0014 (ag990il): ADD VALUE IF NOT EXISTS, one statement per value; an enum value
 * cannot be dropped in place, so down is a no-op.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE return_type ADD VALUE IF NOT EXISTS '990pf';`);
  pgm.sql(`ALTER TYPE return_type ADD VALUE IF NOT EXISTS '990t';`);
};

exports.down = () => {
  // Enum values cannot be dropped in place; harmless to leave on rollback.
};
