/*
 * EACH ROLE'S HOME IS THE PAGE ITS PERMISSIONS CAN OPEN (R64, 2026-09-26).
 *
 * GET /auth/me carries `home`: the Ops route a session lands on after sign-in and is sent to from
 * the root. It is decided here, on the API, from the permissions the session holds — never guessed
 * by the browser from a failed request. The rule, in order:
 *
 *   1. dashboards.executive      → /            the Executive view (the CEO, and '*')
 *   2. engagements.tax.manage    → /queue       My Queue (the tax preparer)
 *   3. billing.manage            → /clients     Ops has no invoices page; the Invoices card is on
 *                                               the client page, so the billing role lands there
 *   4. otherwise the first page of the Ops navigation the session can open, in the navigation's
 *      order (apps/internal/lib/nav.ts declares each item's permissions; the same pairs are listed
 *      here so the API can compute the home without the browser's table)
 *   5. a role that opens no permissioned page → /account. SOPs, Alerts and Account open for every
 *      staff session and do not count as "a page the role holds": a session whose only pages are
 *      those has nowhere to work, and Account is where it can at least manage itself.
 *
 * `holds` is the caller's permission predicate (plugins/auth.ts `holds`, wildcard-aware), so this
 * module owns no copy of the wildcard rule or the explicit-only set. The unit test in
 * apps/internal/test/nav.spec.ts proves that every seeded role's home is a page the shell shows it.
 */

export const HOME_RULES: ReadonlyArray<readonly [permission: string, href: string]> = [
  ['dashboards.executive', '/'],
  ['engagements.tax.manage', '/queue'],
  ['billing.manage', '/clients'],
  // The navigation, in its order (apps/internal/lib/nav.ts); items open to every session are not here.
  ['contacts.read', '/clients'],
  ['documents.read', '/documents'],
  ['tasks.read', '/tasks'],
  ['engagements.read', '/queue'],
  ['efile.manage', '/efile-acks'],
  ['inbox.manage', '/inbox'],
  ['engagements.create', '/configurator'],
  ['events.read', '/events'],
  ['dashboards.hilo', '/hilo'],
  ['documents.write', '/upload-return'],
  ['meetings.upload', '/recorder'],
  ['admin.settings', '/admin/automations'],
  ['pricing.edit', '/admin/pricing'],
  ['staff.manage', '/admin/staff'],
];

export const HOME_FALLBACK = '/account';

/** The route a session lands on, from what it holds. */
export function homeFor(holds: (permission: string) => boolean): string {
  for (const [permission, href] of HOME_RULES) if (holds(permission)) return href;
  return HOME_FALLBACK;
}
