/*
 * THE TOP NAVIGATION SHOWS ONLY PAGES THE SESSION CAN OPEN (R64, 2026-09-26).
 *
 * One table: every Ops page, with the permission(s) that open it. `needs` is any-of, derived from
 * the page's own guard — the permission the API route the page calls first requires, or, for a
 * page whose whole purpose is one action, that action's route (`door` names it). An empty `needs`
 * is a page every staff session opens. The shell filters this table by the session's permissions
 * from GET /auth/me; nothing else decides what is in the navigation.
 *
 * The wildcard ('*', the CEO) opens every item here: no navigation permission is explicit-only
 * (plugins/auth.ts EXPLICIT_ONLY_PERMISSIONS holds narrow authority, none of which opens a page).
 * The unit test in ../test/nav.spec.ts reads that set from the plugin and holds the line.
 *
 * The API computes each role's home from the same pairs (apps/api/src/modules/auth/home.ts);
 * scripts/nav-items-by-role.mjs prints one row per seeded role from this table for the R42 record.
 *
 * Pure and erasable TypeScript on purpose: node's type stripping loads it in the unit test and in
 * the report script without a build.
 */

export interface NavItem {
  href: string;
  label: string;
  /** Any one of these opens the page; empty = every staff session. */
  needs: readonly string[];
  /** The guard the permission was read from. */
  door: string;
}

export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Executive', needs: ['dashboards.executive'], door: 'GET /dashboards/executive' },
  { href: '/clients', label: 'Clients', needs: ['contacts.read'], door: 'GET /contacts' },
  { href: '/documents', label: 'Documents', needs: ['documents.read'], door: 'GET /documents/overview' },
  { href: '/tasks', label: 'My Tasks', needs: ['tasks.read'], door: 'GET /tasks/layout, /task-views' },
  { href: '/queue', label: 'My Queue', needs: ['engagements.read'], door: 'GET /my-queue' },
  { href: '/efile-acks', label: 'E-file acks', needs: ['efile.manage'], door: 'GET /efile-acks' },
  { href: '/inbox', label: 'Inbox', needs: ['inbox.manage'], door: 'GET /inbound-attachments' },
  { href: '/pipeline', label: 'Pipeline', needs: ['engagements.read'], door: 'GET /pipeline' },
  { href: '/reports', label: 'Reports', needs: ['dashboards.executive'], door: 'GET /reports' },
  { href: '/configurator', label: 'Configurator', needs: ['engagements.create'], door: 'POST /engagements/:id/configure (the page exists to configure)' },
  { href: '/approvals', label: 'Approvals', needs: ['dashboards.executive'], door: 'POST /meetings/:id/recap/approve (the page exists to approve)' },
  { href: '/announcements', label: 'Announcements', needs: ['inbox.manage'], door: 'GET /broadcasts' },
  { href: '/sops', label: 'SOPs', needs: [], door: 'GET /sops/task-types (any staff)' },
  { href: '/events', label: 'Events', needs: ['events.read'], door: 'GET /events' },
  { href: '/hilo', label: 'Hilo Ops', needs: ['dashboards.hilo'], door: 'GET /dashboards/hilo' },
  { href: '/alerts', label: 'Alerts', needs: [], door: 'GET /notifications (any staff)' },
  { href: '/upload-return', label: 'Deliver Return', needs: ['documents.write'], door: 'POST /documents (return_deliverable)' },
  { href: '/recorder', label: 'Recorder', needs: ['meetings.upload'], door: 'POST /meetings/upload' },
  { href: '/admin/automations', label: 'Automations', needs: ['admin.settings'], door: 'GET /admin/automations' },
  { href: '/admin/pricing', label: 'Pricing', needs: ['pricing.edit'], door: 'GET /admin/price-book' },
  { href: '/admin/templates', label: 'Templates', needs: ['admin.settings'], door: 'GET /admin/templates' },
  { href: '/admin/document-checklist', label: 'Document checklist', needs: ['admin.settings'], door: 'GET /admin/document-checklist' },
  { href: '/admin/staff', label: 'Staff', needs: ['staff.manage'], door: 'GET /staff' },
  { href: '/admin/settings', label: 'Settings', needs: ['admin.settings'], door: 'GET /admin/settings' },
  { href: '/admin/wisp', label: 'WISP', needs: ['admin.settings'], door: 'GET /admin/wisp/security-summary' },
  { href: '/account', label: 'Account', needs: [], door: 'POST /auth/password (any staff)' },
];

/** The wildcard opens every navigation item (none is explicit-only); otherwise the named grant. */
export function sessionHolds(permissions: readonly string[], permission: string): boolean {
  return permissions.includes('*') || permissions.includes(permission);
}

/** The navigation this session sees, in the table's order. */
export function visibleNav(permissions: readonly string[]): NavItem[] {
  return NAV.filter((item) => item.needs.length === 0 || item.needs.some((p) => sessionHolds(permissions, p)));
}
