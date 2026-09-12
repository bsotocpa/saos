// Staff administration (RBAC-gated). Role changes are permission changes —
// they land in the audit log as 'permission.change' (WISP requirement).

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';

const CreateStaffBody = z.object({
  email: z.email(),
  /** The person's legal name. Client-facing and contractual. */
  legalName: z.string().min(1),
  /** What the team calls them. Defaults to the legal name. */
  displayName: z.string().min(1).optional(),
  roleKey: z.string().min(1),
  phone: z.string().optional(),
});

const UpdateStaffBody = z
  .object({
    roleKey: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    /** Ruling 9 (2026-09-12): names are editable after creation, because a legal name is a fact to get right, not a guess to live with. */
    legalName: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    /**
     * The sign-in address is editable too (2026-09-12). Sessions are keyed by staff id, not by
     * address, so a change never orphans a live login: the open session keeps working and the
     * next sign-in uses the new address. The change is audited with both values.
     */
    email: z.email().optional(),
  })
  .refine((b) => b.roleKey !== undefined || b.isActive !== undefined || b.legalName !== undefined || b.displayName !== undefined || b.email !== undefined, {
    message: 'Provide roleKey, isActive, legalName, displayName and/or email.',
  });

/**
 * A temporary password is shown exactly once, to the person who minted it, in the response to the
 * call that minted it. It is never stored in clear, never logged, never emailed, and never
 * returned by any other route. 20 characters of base64url from 15 random bytes.
 */
function mintTempPassword(): string {
  return randomBytes(15).toString('base64url');
}

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

async function roleIdByKey(app: FastifyInstance, key: string): Promise<{ id: string; key: string }> {
  const { rows } = await app.db.query<{ id: string; key: string; accepts_staff: boolean }>(`SELECT id, key, accepts_staff FROM roles WHERE key = $1`, [key]);
  if (!rows[0]) throw new AppError(400, 'unknown_role', `Role '${key}' does not exist.`);
  // "Nobody is provisioned into client_success or advisory_manager" (Brian, 2026-09-12): a rule, so a refusal.
  if (!rows[0].accepts_staff) throw new AppError(409, 'role_not_provisionable', `Nobody is provisioned into '${key}'; it exists so its permission level does.`);
  return { id: rows[0].id, key: rows[0].key };
}

export function registerStaffRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [app.authenticate, requirePermission('staff.manage')] };

  // Name directory for assignee pickers (v4.5 task UI) — any signed-in staff.
  // Names only; the full roster (emails, MFA state) stays behind staff.manage.
  app.get('/staff/directory', { preHandler: [app.authenticate] }, async () => {
    const { rows } = await app.db.query(
      `SELECT st.id, st.full_name, r.key AS role FROM staff st JOIN roles r ON r.id = st.role_id
       WHERE st.is_active ORDER BY st.full_name`
    );
    return { staff: rows };
  });

  app.get('/staff', guarded, async () => {
    const { rows } = await app.db.query(
      `SELECT st.id, st.full_name, st.legal_name, st.display_name, st.email, st.is_active, st.totp_enabled, st.last_login_at,
              st.must_change_password, r.key AS role
       FROM staff st JOIN roles r ON r.id = st.role_id
       ORDER BY st.full_name`
    );
    return { staff: rows };
  });

  app.post('/staff', guarded, async (request, reply) => {
    const body = CreateStaffBody.parse(request.body);
    const actor = request.staff!;
    const role = await roleIdByKey(app, body.roleKey);

    // Temporary password: returned exactly once, to the admin who created the
    // account, for out-of-band handover. Never emailed. MFA enrollment is
    // forced on first login before any real session exists.
    const tempPassword = mintTempPassword();
    const { rows } = await app.db.query<{ id: string }>(
      // Ruling 1 (2026-09-12): the temporary password dies at 72 hours or first use; ruling 9: legal and display names.
      `INSERT INTO staff (legal_name, display_name, email, phone, role_id, password_hash, temp_password_expires_at, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '72 hours', true) RETURNING id`,
      [body.legalName, body.displayName ?? body.legalName, body.email, body.phone ?? null, role.id, await argon2.hash(tempPassword)]
    );
    const staffId = rows[0]!.id;

    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: actor.id,
      actorLabel: actor.fullName,
      action: 'staff.created',
      objectType: 'staff',
      objectId: staffId,
      ...meta(request),
      details: { role: role.key },
    });
    return reply.code(201).send({ id: staffId, tempPassword });
  });

  app.patch<{ Params: { id: string } }>('/staff/:id', guarded, async (request) => {
    const body = UpdateStaffBody.parse(request.body);
    const actor = request.staff!;
    const targetId = z.uuid().parse(request.params.id);

    const { rows } = await app.db.query<{ id: string; email: string; is_active: boolean; role_key: string }>(
      `SELECT st.id, st.email, st.is_active, r.key AS role_key
       FROM staff st JOIN roles r ON r.id = st.role_id WHERE st.id = $1`,
      [targetId]
    );
    const target = rows[0];
    if (!target) throw new AppError(404, 'not_found', 'Staff member not found.');

    if (body.roleKey !== undefined && body.roleKey !== target.role_key) {
      const role = await roleIdByKey(app, body.roleKey);
      await app.db.query(`UPDATE staff SET role_id = $2 WHERE id = $1`, [targetId, role.id]);
      // WISP: permission changes are audit events.
      await writeAudit(app.db, {
        actorType: 'staff',
        actorId: actor.id,
        actorLabel: actor.fullName,
        action: 'permission.change',
        objectType: 'staff',
        objectId: targetId,
        ...meta(request),
        details: { from_role: target.role_key, to_role: role.key },
      });
    }

    if (body.legalName !== undefined || body.displayName !== undefined) {
      const before = await app.db.query<{ legal_name: string; display_name: string }>(`SELECT legal_name, display_name FROM staff WHERE id = $1`, [targetId]);
      await app.db.query(
        `UPDATE staff SET legal_name = COALESCE($2, legal_name), display_name = COALESCE($3, display_name) WHERE id = $1`,
        [targetId, body.legalName ?? null, body.displayName ?? null]
      );
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'staff.renamed', objectType: 'staff', objectId: targetId,
        ...meta(request),
        details: { from: before.rows[0], to: { legal_name: body.legalName ?? before.rows[0]?.legal_name, display_name: body.displayName ?? before.rows[0]?.display_name } },
      });
    }
    if (body.email !== undefined && body.email.toLowerCase() !== target.email.toLowerCase()) {
      // citext UNIQUE on staff.email: a collision surfaces as the server's 409, not a 500.
      await app.db.query(`UPDATE staff SET email = $2 WHERE id = $1`, [targetId, body.email]);
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'staff.email_changed', objectType: 'staff', objectId: targetId,
        ...meta(request),
        details: { from: target.email, to: body.email },
      });
    }
    if (body.isActive !== undefined && body.isActive !== target.is_active) {
      await app.db.query(`UPDATE staff SET is_active = $2 WHERE id = $1`, [targetId, body.isActive]);
      if (!body.isActive) {
        // Deactivation kills every live session immediately.
        await app.db.query(
          `UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`,
          [targetId]
        );
      }
      await writeAudit(app.db, {
        actorType: 'staff',
        actorId: actor.id,
        actorLabel: actor.fullName,
        action: body.isActive ? 'staff.reactivated' : 'staff.deactivated',
        objectType: 'staff',
        objectId: targetId,
        ...meta(request),
      });
    }

    return { status: 'ok' };
  });

  /**
   * REGENERATE (Brian, 2026-09-12): a separate, audited action. Mints a fresh temporary password
   * under the same rules as creation (72 hours or first use, session owes a password), revokes
   * every live session the old credential opened, and returns the new password once, to the
   * admin who asked. The previous password is dead the moment this returns. MFA enrollment is
   * untouched: losing a password is not losing the phone.
   */
  app.post<{ Params: { id: string } }>('/staff/:id/password/regenerate', guarded, async (request) => {
    const actor = request.staff!;
    const targetId = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{ id: string; is_active: boolean; display_name: string }>(
      `SELECT id, is_active, display_name FROM staff WHERE id = $1`, [targetId]
    );
    const target = rows[0];
    if (!target) throw new AppError(404, 'not_found', 'Staff member not found.');
    if (!target.is_active) throw new AppError(409, 'staff_inactive', 'Reactivate the account before issuing it a password.');

    const tempPassword = mintTempPassword();
    await app.db.query(
      `UPDATE staff SET password_hash = $2, temp_password_expires_at = now() + interval '72 hours', must_change_password = true
        WHERE id = $1`,
      [targetId, await argon2.hash(tempPassword)]
    );
    const revoked = await app.db.query(
      `UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`, [targetId]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'staff.password_regenerated', objectType: 'staff', objectId: targetId,
      ...meta(request),
      details: { sessions_revoked: revoked.rowCount ?? 0, expires_in_hours: 72 },
    });
    return { id: targetId, tempPassword };
  });
}
