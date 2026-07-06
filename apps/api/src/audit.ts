// Audit log writer — the WISP compliance trail. Every document/PII access and
// every permission change flows through here (MP Compliance Layer). The table
// is append-only at the database level (see migration 0001).
//
// Failures PROPAGATE: if the audit row cannot be written, the audited action
// must not silently succeed (fail-closed).

import type { Db } from './db.ts';

export type AuditActorType = 'staff' | 'client' | 'system';

export interface AuditEntry {
  actorType: AuditActorType;
  actorId?: string | null | undefined;
  /** Denormalized name/email snapshot — audit rows must stand alone forever. */
  actorLabel?: string | null | undefined;
  /** Dotted verb, e.g. 'auth.login_failed', 'permission.change', 'document.download'. */
  action: string;
  objectType?: string | null | undefined;
  objectId?: string | null | undefined;
  contactId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  /** Identifiers and metadata ONLY — never PII values or document contents. */
  details?: Record<string, unknown> | undefined;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (actor_type, actor_id, actor_label, action, object_type, object_id, contact_id, ip, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      entry.actorType,
      entry.actorId ?? null,
      entry.actorLabel ?? null,
      entry.action,
      entry.objectType ?? null,
      entry.objectId ?? null,
      entry.contactId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.details ?? {}),
    ]
  );
}
