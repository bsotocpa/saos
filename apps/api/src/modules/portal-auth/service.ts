// Magic-link authentication for clients (MP Portal Auth): magic link on
// intake, optional password later, MFA optional for clients. Links are
// single-use and expire; only token hashes touch the database. Delivery
// failure triggers the Rene bounce-fallback task (see webhooks module).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { generateToken, hashToken } from '../../crypto.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { AppError } from '../../types.ts';

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Create (or fetch) the portal account for a contact. Staff-initiated (intake automations call this too). */
export async function ensurePortalUser(
  app: FastifyInstance,
  contactId: string
): Promise<{ id: string; email: string; created: boolean }> {
  const existing = await app.db.query<{ id: string; email: string }>(
    `SELECT id, email FROM portal_users WHERE contact_id = $1`,
    [contactId]
  );
  if (existing.rows[0]) return { ...existing.rows[0], created: false };

  const contact = await app.db.query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [
    contactId,
  ]);
  if (!contact.rows[0]) throw new AppError(404, 'contact_not_found', 'Contact not found.');
  if (!contact.rows[0].email) {
    throw new AppError(400, 'contact_has_no_email', 'Contact has no email address — cannot create portal access.');
  }

  const { rows } = await app.db.query<{ id: string; email: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id, email`,
    [contactId, contact.rows[0].email]
  );
  // Form 4: every new portal account gets the 4-step first-login checklist
  // ('migrated' variant is set by the M22 import instead).
  await app.db.query(
    `INSERT INTO portal_onboarding (contact_id, variant) VALUES ($1, 'new') ON CONFLICT (contact_id) DO NOTHING`,
    [contactId]
  );
  return { ...rows[0]!, created: true };
}

/**
 * Issue a fresh magic link and email it (contact's language). Throttled: at
 * most 3 outstanding links per user per 10 minutes — extra requests succeed
 * silently without sending (no oracle for attackers, no mail spam).
 */
export async function issueMagicLink(app: FastifyInstance, portalUserId: string): Promise<void> {
  const { rows } = await app.db.query<{
    id: string;
    email: string;
    contact_id: string;
    first_name: string;
    language: 'en' | 'es';
    recent: number;
  }>(
    `SELECT u.id, u.email, u.contact_id, c.first_name, c.language,
            (SELECT count(*)::int FROM magic_link_tokens t
             WHERE t.portal_user_id = u.id AND t.created_at > now() - interval '10 minutes') AS recent
     FROM portal_users u JOIN contacts c ON c.id = u.contact_id
     WHERE u.id = $1 AND u.is_active`,
    [portalUserId]
  );
  const user = rows[0];
  if (!user) throw new AppError(404, 'portal_user_not_found', 'Portal user not found.');
  if (user.recent >= 3) {
    app.log.warn({ portalUserId }, 'magic-link throttled');
    return;
  }

  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO magic_link_tokens (portal_user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'login', now() + make_interval(mins => $3))`,
    [user.id, hash, app.config.MAGIC_LINK_TTL_MINUTES]
  );

  await sendTemplatedEmail(app, {
    to: user.email,
    templateKey: 'portal_magic_link',
    language: user.language,
    contactId: user.contact_id,
    vars: {
      first_name: user.first_name,
      link: `${app.config.PORTAL_BASE_URL}/auth/verify?token=${token}`,
      ttl_minutes: String(app.config.MAGIC_LINK_TTL_MINUTES),
    },
  });

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'magic_link.issued',
    objectType: 'portal_user',
    objectId: user.id,
    contactId: user.contact_id,
  });
}

/** Redeem a magic link: single use, unexpired → portal session. */
export async function verifyMagicLink(
  app: FastifyInstance,
  token: string,
  meta: RequestMeta
): Promise<{ sessionToken: string; firstLogin: boolean }> {
  // Atomic redemption — two racing requests can't both consume the link.
  const { rows } = await app.db.query<{ id: string; portal_user_id: string }>(
    `UPDATE magic_link_tokens
     SET used_at = now(), used_ip = $2
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, portal_user_id`,
    [hashToken(token), meta.ip ?? null]
  );
  const redeemed = rows[0];
  if (!redeemed) throw new AppError(401, 'invalid_magic_link', 'This sign-in link is invalid, used, or expired.');

  const user = await app.db.query<{ contact_id: string; email: string; last_login_at: Date | null }>(
    `SELECT contact_id, email, last_login_at FROM portal_users WHERE id = $1 AND is_active`,
    [redeemed.portal_user_id]
  );
  const u = user.rows[0];
  if (!u) throw new AppError(401, 'invalid_magic_link', 'This sign-in link is invalid, used, or expired.');
  const firstLogin = u.last_login_at === null;
  await app.db.query(`UPDATE portal_users SET last_login_at = now() WHERE id = $1`, [redeemed.portal_user_id]);

  const { token: sessionToken, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [redeemed.portal_user_id, hash, meta.ip ?? null, meta.userAgent ?? null, app.config.PORTAL_SESSION_DAYS]
  );

  await writeAudit(app.db, {
    actorType: 'client',
    actorId: redeemed.portal_user_id,
    actorLabel: u.email,
    action: 'portal.login',
    contactId: u.contact_id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { sessionToken, firstLogin };
}

/**
 * Bounce fallback (MP Portal Auth): delivery failure → verification task for
 * Rene (comms_billing role) so a human confirms contact info and re-sends.
 */
export async function handleMailBounce(app: FastifyInstance, recipient: string): Promise<{ matched: boolean }> {
  const { rows } = await app.db.query<{ portal_user_id: string; contact_id: string; first_name: string; last_name: string }>(
    `SELECT u.id AS portal_user_id, c.id AS contact_id, c.first_name, c.last_name
     FROM portal_users u JOIN contacts c ON c.id = u.contact_id
     WHERE u.email = $1`,
    [recipient]
  );
  const match = rows[0];
  if (!match) return { matched: false };

  const rene = await app.db.query<{ id: string }>(
    `SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id
     WHERE r.key = 'comms_billing' AND st.is_active
     ORDER BY st.created_at LIMIT 1`
  );
  const assignee = rene.rows[0]?.id ?? null;

  const task = await app.db.query<{ id: string }>(
    `INSERT INTO tasks (title, description, assigned_staff_id, contact_id, priority, source, source_type, source_id)
     VALUES ($1, $2, $3, $4, 1, 'automation', 'magic_link_bounce', $5)
     RETURNING id`,
    [
      `Magic link bounced — verify contact info for ${match.first_name} ${match.last_name}`,
      'Portal email bounced. Verify the email address (or phone the client), correct the contact record, and re-send portal access. Clients can also call the office number for an access reset.',
      assignee,
      match.contact_id,
      match.portal_user_id,
    ]
  );

  if (assignee) {
    await app.db.query(
      `INSERT INTO notifications (staff_id, type, severity, title, contact_id, related_object_type, related_object_id)
       VALUES ($1, 'magic_link_bounce', 'warning', $2, $3, 'task', $4)`,
      [assignee, `Magic link bounced: ${match.first_name} ${match.last_name}`, match.contact_id, task.rows[0]!.id]
    );
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'magic_link.bounced',
    objectType: 'portal_user',
    objectId: match.portal_user_id,
    contactId: match.contact_id,
    details: { task_id: task.rows[0]!.id, assigned: assignee !== null },
  });
  return { matched: true };
}
