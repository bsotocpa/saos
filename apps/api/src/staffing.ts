// Role → staff resolution for automation routing (Ana-Maria = tax_preparer,
// Laura = va_entity, Rene = comms_billing, Brian = ceo, Jackson = ed_coo).
// Routing is ALWAYS by role, never by name — people change, roles persist.

import type { Db } from './db.ts';

/** Oldest active staff member holding the role (deterministic default assignee). */
export async function firstActiveByRole(db: Db, roleKey: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id
     WHERE r.key = $1 AND st.is_active ORDER BY st.created_at LIMIT 1`,
    [roleKey]
  );
  return rows[0]?.id ?? null;
}

/** All active staff across the given roles (escalation fan-out). */
export async function allActiveByRoles(db: Db, roleKeys: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id
     WHERE r.key = ANY($1) AND st.is_active`,
    [roleKeys]
  );
  return rows.map((r) => r.id);
}

/** Insert a notification unless an identical one already exists for the object (idempotent alerts). */
export async function notifyOnce(
  db: Db,
  opts: {
    staffId: string;
    type: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    contactId?: string | null;
    relatedObjectType?: string | null;
    relatedObjectId?: string | null;
    body?: string | null;
  }
): Promise<boolean> {
  const existing = await db.query(
    `SELECT 1 FROM notifications
     WHERE staff_id = $1 AND type = $2
       AND related_object_type IS NOT DISTINCT FROM $3
       AND related_object_id IS NOT DISTINCT FROM $4
     LIMIT 1`,
    [opts.staffId, opts.type, opts.relatedObjectType ?? null, opts.relatedObjectId ?? null]
  );
  if (existing.rows.length > 0) return false;
  await db.query(
    `INSERT INTO notifications (staff_id, type, severity, title, body, contact_id, related_object_type, related_object_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.staffId, opts.type, opts.severity, opts.title, opts.body ?? null,
      opts.contactId ?? null, opts.relatedObjectType ?? null, opts.relatedObjectId ?? null,
    ]
  );
  return true;
}
