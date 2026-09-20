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
    description: 'Jaqueline Flores, display name Jackson. Executive Director of Hilo NFP; delivers paid COO/HR work under Soto Accounting. Named grants only (2026-09-12): the client book for RELATIONSHIP data, her recorder, her sessions and Hilo sessions, the Hilo dashboard, Hilo events. Behind the §7216 wall (phase 2, in code): no return contents, no SSN last-4, no interview answers, no tax documents, no IRS notices, no signed authorizations, no return deliverables, no CPA session with a Soto client.',
    permissions: [
      'contacts.read',
      'engagements.read',
      'tasks.read',
      'tasks.manage',
      'referrals.suggest',
      // Her six (2026-09-12): the recorder, her sessions (scoped), the Hilo dashboard, event close-out,
      // and the document categories on the relationship side of the wall.
      'meetings.upload',
      'meetings.read',
      'dashboards.hilo',
      'events.manage',
      'events.read', // 2026-09-12: check-in rosters are behind it; intern does not hold it
      'documents.read',
      'documents.read.relationship',
    ],
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
      // The ATX acknowledgment report is hers end to end (2026-09-19): upload, review row by row,
      // release. Named separately from engagements.tax.manage so the screen can be granted to a
      // preparer without granting every tax engagement action, and taken back the same way.
      'efile.manage',
      'documents.read',
      'documents.read.all', // every category: the preparer is inside the wall
      'documents.write',
      'pii.read', // checked in code since 2026-09-12: the SSN last-4 leaves only for this grant
      'interviews.read', // the return interview (quote answers, complexity inputs)
      'tasks.read',
      'tasks.manage',
      'meetings.read',
      'meetings.read.all', // every session, CPA sessions included
      'meetings.upload',
      'time.log',
    ],
  },
  {
    key: 'va_entity',
    name: 'Remote VA / Entity & Annual Reports',
    description: 'Laura. Entity module, admin tickets. Fully remote. Behind the §7216 wall (phase 2): entity filings only among documents, no SSN last-4, no interview content, no sessions. The EIN stays visible: she files with it.',
    permissions: [
      'contacts.read',
      // Adding a business is the entity module's own door (2026-09-19). She needs it to file, and it
      // is narrower than contacts.write, which would also open every identity field on the record.
      'businesses.write',
      'entity.manage',
      'documents.read',
      'documents.read.entity', // formation papers, SOS filings, EIN letters, annual reports
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
    description: 'Rene. Front desk, unified comms inbox, AR chasing, full billing (void, refund, deposit transfer — every money action lands on the CEO\'s daily digest), plus bookkeeping scope for sales tax and payroll, granted directly (2026-09-12).',
    permissions: [
      'contacts.read',
      'contacts.write',
      'pii.read', // 2026-09-12: Rene collects SSNs by phone and verifies callers; inside the firm
      'inbox.manage',
      'billing.manage',
      'bookkeeping.assigned.manage',
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
      'documents.read.all', // unchanged reach after the wall (2026-09-12); the category scope is for Laura and Jaqueline
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
    acceptsStaff: false, // 2026-09-12: nobody is provisioned into this role; the staff routes refuse it
    permissions: ['contacts.read', 'inbox.manage', 'tasks.read', 'tasks.manage', 'time.log'],
  },
  {
    key: 'advisory_manager',
    name: 'Advisory Manager (future)',
    description: 'Future hire. Advisory/COO engagement delivery.',
    acceptsStaff: false, // 2026-09-12: nobody is provisioned into this role; the staff routes refuse it
    permissions: ['contacts.read', 'engagements.read', 'advisory.manage', 'tasks.read', 'tasks.manage', 'time.log'],
  },
];

export async function seedRoles(client) {
  let grants = 0;
  let revoked = 0;
  for (const role of roles) {
    const { rows } = await client.query(
      `INSERT INTO roles (key, name, description, accepts_staff)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, accepts_staff = EXCLUDED.accepts_staff
       RETURNING id`,
      [role.key, role.name, role.description, role.acceptsStaff !== false]
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
    /*
     * THE SEED RECONCILES (2026-09-12). It used to only insert, so a permission removed from
     * this file stayed granted on every database that already had it — which is how ed_coo
     * would have kept '*' forever. A grant that is not in this file is not a grant.
     */
    const gone = await client.query(
      `DELETE FROM role_permissions WHERE role_id = $1 AND NOT (permission = ANY($2::text[])) RETURNING permission`,
      [roleId, role.permissions]
    );
    revoked += gone.rowCount;
  }
  return `${roles.length} roles, ${grants} new permission grants, ${revoked} revoked`;
}
