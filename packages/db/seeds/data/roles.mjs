// Roles + starter permission grants — MP "Team & Access" table.
// The 8 current roles plus the named future roles, so permission levels exist
// from day one. Permission keys are coarse verbs the RBAC middleware (M4)
// checks; '*' = full access. Attest scoping (Cristian: assigned engagements
// only) and intern PII exclusion are enforced by the ABSENCE of grants plus
// row-level checks in the app.

export const roles = [
  {
    key: 'ceo',
    name: 'CEO / CPA',
    description: 'Brian. Full access; approval gate for pricing/scope commitments.',
    // 'deposits.override' is listed EXPLICITLY even though this role holds '*':
    // it is an explicit-only permission (see EXPLICIT_ONLY_PERMISSIONS in
    // plugins/auth.ts), so the wildcard does not reach it. That is deliberate —
    // Brian asked for deposit waivers to be his alone, and Jackson also holds
    // '*'. Without the explicit-only carve-out there would be no way to say
    // "Brian only" at all.
    permissions: ['*', 'deposits.override'], // '*' includes referrals.approve (Jackson too)
  },
  {
    key: 'ed_coo',
    name: 'ED Hilo / Fractional COO',
    description: 'Jackson. Equal to Brian; independent on all Hilo-side decisions.',
    permissions: ['*'],
  },
  {
    key: 'tax_preparer',
    name: 'Tax Preparer / IRS Notice Handler',
    description: 'Ana-Maria (+ future preparers). Assigned engagements + all IRS notices. No pricing changes.',
    permissions: [
      'contacts.read',
      'engagements.read',
      'engagements.tax.manage',
      'irs_notices.manage',
      'documents.read',
      'documents.write',
      'pii.read',
      'tasks.read',
      'tasks.manage',
      'meetings.read',
      'meetings.upload',
      'time.log',
    ],
  },
  {
    key: 'va_entity',
    name: 'Remote VA / Entity & Annual Reports',
    description: 'Laura. Entity module, admin tickets. Fully remote.',
    permissions: [
      'contacts.read',
      'entity.manage',
      'documents.read',
      'documents.write',
      'tasks.read',
      'tasks.manage',
      'time.log',
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor (contract)',
    description: 'Cristian Borcan. Attest engagements only; access scoped per engagement; walled from firm-prepared books.',
    permissions: ['attest.assigned.manage', 'documents.assigned.read', 'time.log'],
  },
  {
    key: 'comms_billing',
    name: 'Phone/Text Handler / Sales Tax / Payroll / Billing',
    description: 'Rene. Unified comms inbox, Stripe billing queue, sales tax + payroll workflows, magic-link bounce follow-ups.',
    permissions: [
      'contacts.read',
      'contacts.write',
      'inbox.manage',
      'billing.manage',
      'sales_tax.manage',
      'payroll.manage',
      'magic_links.manage',
      'tasks.read',
      'tasks.manage',
      'time.log',
    ],
  },
  {
    key: 'bookkeeper',
    name: 'Bookkeeper',
    description: 'Marian. Bookkeeping engagements only; works in each client’s QBO as accountant user.',
    permissions: [
      'contacts.read',
      'bookkeeping.assigned.manage',
      'documents.read',
      'documents.write',
      'tasks.read',
      'tasks.manage',
      'time.log',
    ],
  },
  {
    key: 'intern',
    name: 'Intern',
    description: 'Juan. Read-only on assigned records, task execution, NO PII or financial access.',
    permissions: ['assigned.read', 'tasks.read', 'tasks.execute', 'time.log'],
  },
  // Future roles (MP: "permission levels built now")
  {
    key: 'client_success',
    name: 'Client Success (future)',
    description: 'Future hire. Client communication + portal support.',
    permissions: ['contacts.read', 'inbox.manage', 'tasks.read', 'tasks.manage', 'time.log'],
  },
  {
    key: 'advisory_manager',
    name: 'Advisory Manager (future)',
    description: 'Future hire. Advisory/COO engagement delivery.',
    permissions: ['contacts.read', 'engagements.read', 'advisory.manage', 'tasks.read', 'tasks.manage', 'time.log'],
  },
];

export async function seedRoles(client) {
  let grants = 0;
  for (const role of roles) {
    const { rows } = await client.query(
      `INSERT INTO roles (key, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [role.key, role.name, role.description]
    );
    const roleId = rows[0].id;
    for (const permission of role.permissions) {
      const res = await client.query(
        `INSERT INTO role_permissions (role_id, permission)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, permission]
      );
      grants += res.rowCount;
    }
  }
  return `${roles.length} roles, ${grants} new permission grants`;
}
