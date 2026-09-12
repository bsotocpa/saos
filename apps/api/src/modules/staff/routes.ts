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
  })
  .refine((b) => b.roleKey !== undefined || b.isActive !== undefined, {
    message: 'Provide roleKey and/or isActive.',
  });

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

async function roleIdByKey(app: FastifyInstance, key: string): Promise<{ id: string; key: string }> {
  const { rows } = await app.db.query<{ id: string; key: string }>(`SELECT id, key FROM roles WHERE key = $1`, [key]);
  if (!rows[0]) throw new AppError(400, 'unknown_role', `Role '${key}' does not exist.`);
  return rows[0];
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
      `SELECT st.id, st.full_name, st.email, st.is_active, st.totp_enabled, st.last_login_at, r.key AS role
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
    const tempPassword = randomBytes(15).toString('base64url');
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
}
