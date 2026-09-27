/* eslint-disable camelcase */
/**
 * 0127 — 8879-F, THE FIDUCIARY AUTHORIZATION (Brian, 2026-09-27, R72).
 *
 * R66 named four Form 8879 variants (8879, 8879-CORP, 8879-PE, 8879-TE). A 1041 (an estate or trust)
 * is signed on the 8879-F; R72 adds it and makes it the 1041's default. The documents CHECK constraint
 * that 0124 wrote with the four is rebuilt with the five.
 *
 * No backfill: production holds no 1041 return and no signed authorization on one (read 2026-09-27),
 * and a 1041's 8879 already on file anywhere else keeps what it was recorded as; the correction door
 * moves it if the paper says otherwise.
 */
exports.shorthands = undefined;

const F8879_VARIANTS = ['8879', '8879-CORP', '8879-PE', '8879-TE', '8879-F'];
const R66_VARIANTS = ['8879', '8879-CORP', '8879-PE', '8879-TE'];

const constraint = (values) =>
  `ALTER TABLE documents
     DROP CONSTRAINT IF EXISTS documents_f8879_variant_values,
     ADD CONSTRAINT documents_f8879_variant_values CHECK (f8879_variant IS NULL OR f8879_variant IN (${values.map((v) => `'${v}'`).join(', ')}))`;

exports.up = async (pgm) => {
  await pgm.db.query(constraint(F8879_VARIANTS));
  await pgm.db.query(`
    COMMENT ON COLUMN documents.f8879_variant IS
      'R66, R72: which Form 8879 this signed authorization is (8879, 8879-CORP, 8879-PE, 8879-TE, 8879-F), defaulted from the return type at upload; corrected through the filing-correction door.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(constraint(R66_VARIANTS));
};
