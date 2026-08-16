// Magic-link authentication for clients (MP Portal Auth): magic link on
// intake, optional password later, MFA optional for clients. Links are
// single-use and expire; only token hashes touch the database. Delivery
// failure triggers the Rene bounce-fallback task (see webhooks module).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { generateToken, hashToken } from '../../crypto.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';

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
 * Issue a fresh magic link and email it (contact's language). Throttled: at most 3
 * outstanding links per user per 10 minutes — extra requests succeed silently without
 * sending (no oracle for attackers, no mail spam).
 *
 * And it chooses which message carries the link.
 *
 * FINDING #21: an invite and a re-login link are different emails. A first-time client
 * used to receive "Here is your secure link to sign in to your Soto Accounting portal"
 * for a portal nobody had told them about — no context, fifteen-minute expiry, and
 * indistinguishable from phishing. `purpose: 'invite'` sends the welcome instead; every
 * later request sends the bare link, which is the right message once you know what the
 * portal is.
 *
 * #21 ONLY EVER SHIPPED FOR THE STAFF-GRANT PATH (2026-08-15). The intake processor —
 * the path every self-serve client actually walks — called this with no purpose at all,
 * so the people the finding was written about kept getting the phishing-shaped link.
 * The default stays 'login' because a bare link is the safe thing to send to someone who
 * already knows the portal; callers that CREATE an account are the ones who must say so.
 *
 * BRAND is a parameter, not an inference. A Hilo entrepreneur receiving "your Soto
 * Accounting portal is ready" is a brand violation, and `contacts.hilo_status` cannot
 * stand in for brand — Soto clients carry it too (referrals, program participants). The
 * caller knows which front door someone came through; nothing else reliably does.
 */
type Brand = 'soto' | 'hilo';

const LINK_TEMPLATES: Record<Brand, { invite: string; login: string }> = {
  soto: { invite: 'portal_invite', login: 'portal_magic_link' },
  hilo: { invite: 'portal_invite_hilo', login: 'portal_magic_link_hilo' },
};

export async function issueMagicLink(
  app: FastifyInstance,
  portalUserId: string,
  opts: { purpose?: 'invite' | 'login'; brand?: Brand } = {}
): Promise<void> {
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

  const isInvite = opts.purpose === 'invite';
  const templates = LINK_TEMPLATES[opts.brand ?? 'soto'];
  await sendTemplatedEmail(app, {
    to: user.email,
    templateKey: isInvite ? templates.invite : templates.login,
    language: user.language,
    contactId: user.contact_id,
    vars: {
      first_name: user.first_name,
      link: `${app.config.PORTAL_BASE_URL}/auth/verify?token=${token}`,
      ttl_minutes: String(app.config.MAGIC_LINK_TTL_MINUTES),
      // The invite tells them where to get a fresh link when this one expires, because
      // it will expire and "ask for another" has to be an instruction, not a dead end.
      portal_url: app.config.PORTAL_BASE_URL,
    },
  });

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'magic_link.issued',
    objectType: 'portal_user',
    objectId: user.id,
    contactId: user.contact_id,
    // The brand is on the audit line because "which email did this client actually
    // get" is the question #21 was reopened to answer.
    details: { purpose: isInvite ? 'invite' : 'login', brand: opts.brand ?? 'soto' },
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

/**
 * A sign-in attempt for an address with no portal access (finding #21).
 *
 * The public endpoint's answer is deliberately vague and stays that way — it must not
 * confirm who is a client. This is the internal half: when the address belongs to a
 * contact we already know, somebody we have a relationship with is locked out and
 * nobody was told. Rene gets a task naming the client and the fix (grant portal access).
 *
 * Scoped to known contacts on purpose. An unrecognised address produces a log line and
 * nothing else: creating a task per unknown address would let anyone fill the queue by
 * typing strangers' emails, and there would be nothing to act on anyway.
 */
export async function recordUnknownSignInAttempt(
  app: FastifyInstance,
  email: string
): Promise<{ known: boolean }> {
  const { rows } = await app.db.query<{
    id: string; first_name: string; last_name: string; has_user: boolean;
  }>(
    `SELECT c.id, c.first_name, c.last_name,
            EXISTS (SELECT 1 FROM portal_users u WHERE u.contact_id = c.id) AS has_user
       FROM contacts c
      WHERE c.email = $1 AND NOT c.is_archived
      LIMIT 1`,
    [email]
  );
  const contact = rows[0];
  if (!contact) {
    // No PII in logs: the fact, not the address.
    app.log.info({ event: 'portal_signin_unknown_address' }, 'sign-in requested for an address we do not recognise');
    return { known: false };
  }

  const rene = await firstActiveByRole(app.db, 'comms_billing');
  const why = contact.has_user
    ? 'Their portal account is on a DIFFERENT email address than the one they tried.'
    : 'They have no portal account yet.';
  const created = await createTask(app, {
    title: `${contact.first_name} ${contact.last_name} tried to sign in and could not`,
    description:
      `${why} They asked for a sign-in link and received nothing, and the portal cannot tell them why ` +
      `without confirming to strangers who our clients are.\n\n` +
      `Grant portal access (or point them at the address that has it) from their client record.`,
    ...(rene ? { assignedStaffId: rene } : {}),
    contactId: contact.id,
    priority: 2,
    source: 'automation',
    sourceType: 'portal_access_blocked',
    // Deduped per contact while the task is open — a client retrying five times is one
    // problem, not five.
    sourceId: contact.id,
  });

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'portal.signin_blocked',
    objectType: 'contact',
    objectId: contact.id,
    contactId: contact.id,
    details: { has_portal_user: contact.has_user, task_created: created.created },
  });
  return { known: true };
}
