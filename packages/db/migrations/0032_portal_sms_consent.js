/**
 * Portal SMS opt-in (Brian's addition, 2026-08-09) needs its own consent method.
 *
 * The enum had docuseal / wet_signature / intake_checkbox. The welcome-flow
 * opt-in is none of those: it happens after onboarding, in the portal, for a
 * client who may have been on the books for years. Recording it as
 * 'intake_checkbox' would put the wrong provenance on a TCPA record — and
 * provenance is most of what a consent record is FOR. If a carrier or a
 * complaint ever asks where consent came from, "portal_checkbox" plus the
 * policy_version answers it exactly.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE consent_method ADD VALUE IF NOT EXISTS 'portal_checkbox';`);
};

exports.down = () => {
  // Postgres cannot drop an enum value without rebuilding the type, and consents
  // rows may reference it. A no-op down is the honest choice here.
};
