// Admin core (MP Admin Interface — Brian-configurable, no code):
//   price book  — edits create a NEW effective-dated version; existing
//                 engagements keep the version pinned at signing (v4.2
//                 billing architecture). Confirming a ⚠ seed item is
//                 metadata, not a price change (no new version).
//   templates   — ALL client copy is DB-driven; edits bump the version;
//                 clearing is_placeholder is THE launch-gate action (final
//                 legal text arrived) and is audited by name.
//   settings    — SLA windows / alert thresholds / automation knobs.
//   staff/roles — M4's endpoints already exist; roles listing added here.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

const NewVersionBody = z.object({
  effectiveFrom: z.iso.date(),
  note: z.string().min(3),
  changes: z
    .array(
      z.object({
        itemCode: z.string().min(1),
        amountCents: z.number().int().nonnegative().optional(),
        priceMinCents: z.number().int().nonnegative().optional(),
        priceMaxCents: z.number().int().nonnegative().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .min(1),
});

const TemplateBody = z
  .object({
    subjectEn: z.string().nullable().optional(),
    subjectEs: z.string().nullable().optional(),
    bodyEn: z.string().min(1).optional(),
    bodyEs: z.string().nullable().optional(),
    isPlaceholder: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

const SettingBody = z.object({ value: z.unknown() });

export function registerAdminRoutes(app: FastifyInstance): void {
  const pricing = { preHandler: [app.authenticate, requirePermission('pricing.edit')] };
  const admin = { preHandler: [app.authenticate, requirePermission('admin.settings')] };

  // ── Price book ────────────────────────────────────────────────────────────
  app.get('/admin/price-book', pricing, async () => {
    const version = await app.db.query(
      `SELECT id, version_number, effective_from, effective_to, note
       FROM price_book_versions
       WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
       ORDER BY version_number DESC LIMIT 1`
    );
    if (!version.rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');
    const v = version.rows[0] as { id: string };
    const items = await app.db.query(
      `SELECT item_code, service_line, name_en, amount_cents, price_min_cents, price_max_cents,
              unit, is_pass_through, needs_confirmation, confirmation_note, is_active
       FROM price_book_items WHERE version_id = $1 ORDER BY sort_order`,
      [v.id]
    );
    const rules = await app.db.query(
      `SELECT rule_code, rule_type, description_en, component_item_codes, bundle_price_cents, condition_item_code
       FROM bundle_rules WHERE version_id = $1`,
      [v.id]
    );
    return { version: version.rows[0], items: items.rows, bundleRules: rules.rows };
  });

  /**
   * New version = full copy of the current one with the listed changes
   * applied. The old version closes at the new effective date. Engagements
   * keep the version pinned at signing — a launch-day increase is a data
   * change that never repricing existing work.
   */
  app.post('/admin/price-book/versions', pricing, async (request, reply) => {
    const b = NewVersionBody.parse(request.body);
    const actor = request.staff!;

    const client = await app.db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ id: string; version_number: number; effective_from: string }>(
        `SELECT id, version_number, effective_from::text AS effective_from
         FROM price_book_versions ORDER BY version_number DESC LIMIT 1 FOR UPDATE`
      );
      const cur = current.rows[0];
      if (!cur) throw new AppError(500, 'price_book_missing', 'No price book to version from.');
      if (b.effectiveFrom <= cur.effective_from) {
        throw new AppError(400, 'effective_date_conflict', `New version must start after ${cur.effective_from}.`);
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO price_book_versions (version_number, effective_from, note, created_by_staff_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [cur.version_number + 1, b.effectiveFrom, b.note, actor.id]
      );
      const newId = created.rows[0]!.id;

      // Full copy: items + bundle rules.
      await client.query(
        `INSERT INTO price_book_items
           (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
            amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
            needs_confirmation, confirmation_note, is_active, sort_order, metadata)
         SELECT $1, item_code, service_line, name_en, name_es, description_en, description_es,
                amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
                needs_confirmation, confirmation_note, is_active, sort_order, metadata
         FROM price_book_items WHERE version_id = $2`,
        [newId, cur.id]
      );
      await client.query(
        `INSERT INTO bundle_rules
           (version_id, rule_code, rule_type, description_en, description_es, component_item_codes,
            bundle_price_cents, condition_item_code, is_active)
         SELECT $1, rule_code, rule_type, description_en, description_es, component_item_codes,
                bundle_price_cents, condition_item_code, is_active
         FROM bundle_rules WHERE version_id = $2`,
        [newId, cur.id]
      );

      // Apply the changes to the NEW version only.
      for (const change of b.changes) {
        const sets: string[] = [];
        const params: unknown[] = [newId, change.itemCode];
        if (change.amountCents !== undefined) { params.push(change.amountCents); sets.push(`amount_cents = $${params.length}`); }
        if (change.priceMinCents !== undefined) { params.push(change.priceMinCents); sets.push(`price_min_cents = $${params.length}`); }
        if (change.priceMaxCents !== undefined) { params.push(change.priceMaxCents); sets.push(`price_max_cents = $${params.length}`); }
        if (change.isActive !== undefined) { params.push(change.isActive); sets.push(`is_active = $${params.length}`); }
        if (sets.length === 0) continue;
        // An admin-set price is a deliberate decision — confirmation clears.
        sets.push(`needs_confirmation = false`, `confirmation_note = NULL`);
        const res = await client.query(
          `UPDATE price_book_items SET ${sets.join(', ')} WHERE version_id = $1 AND item_code = $2`,
          params
        );
        if (res.rowCount === 0) throw new AppError(400, 'unknown_price_items', `Unknown item: ${change.itemCode}.`);
      }

      // Close the outgoing version at the handover date.
      await client.query(`UPDATE price_book_versions SET effective_to = $2 WHERE id = $1`, [cur.id, b.effectiveFrom]);
      await client.query('COMMIT');

      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
        action: 'price_book.version_created',
        objectType: 'price_book_version', objectId: newId,
        details: {
          version_number: cur.version_number + 1,
          effective_from: b.effectiveFrom,
          changes: b.changes.map((c) => c.itemCode),
        },
      });
      return reply.code(201).send({ id: newId, versionNumber: cur.version_number + 1 });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // Confirming a ⚠ seed item: metadata only — the price stands as seeded.
  app.post<{ Params: { code: string } }>('/admin/price-book/items/:code/confirm', pricing, async (request) => {
    const code = z.string().min(1).parse(request.params.code);
    const actor = request.staff!;
    const res = await app.db.query(
      `UPDATE price_book_items SET needs_confirmation = false, confirmation_note = NULL
       WHERE item_code = $1 AND needs_confirmation
         AND version_id = (SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1)`,
      [code]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'No unconfirmed item with that code in the current version.');
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'price_book.item_confirmed', objectType: 'price_book_item', objectId: code,
    });
    return { status: 'ok' };
  });

  // ── Templates (copy changes NEVER require a deploy) ──────────────────────
  app.get('/admin/templates', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT key, name, channel, subject_en, subject_es, body_en, body_es,
              is_placeholder, variables, version, updated_at
       FROM templates ORDER BY is_placeholder DESC, key`
    );
    return { templates: rows };
  });

  app.patch<{ Params: { key: string } }>('/admin/templates/:key', admin, async (request) => {
    const key = z.string().min(1).parse(request.params.key);
    const b = TemplateBody.parse(request.body);
    const actor = request.staff!;

    const existing = await app.db.query<{ is_placeholder: boolean }>(
      `SELECT is_placeholder FROM templates WHERE key = $1`,
      [key]
    );
    if (!existing.rows[0]) throw new AppError(404, 'not_found', 'Template not found.');

    const sets: string[] = [`version = version + 1`, `updated_by_staff_id = $2`];
    const params: unknown[] = [key, actor.id];
    const map: Record<string, unknown> = {
      subject_en: b.subjectEn, subject_es: b.subjectEs, body_en: b.bodyEn, body_es: b.bodyEs,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (b.isPlaceholder !== undefined) { params.push(b.isPlaceholder); sets.push(`is_placeholder = $${params.length}`); }
    await app.db.query(`UPDATE templates SET ${sets.join(', ')} WHERE key = $1`, params);

    // The launch-gate moment: placeholder → live means final legal text landed.
    const cleared = existing.rows[0].is_placeholder && b.isPlaceholder === false;
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: cleared ? 'template.placeholder_cleared' : 'template.updated',
      objectType: 'template', objectId: key,
      details: { fields: Object.keys(b) },
    });
    return { status: 'ok', placeholderCleared: cleared };
  });

  // ── Settings (SLA windows, thresholds, automation knobs) ─────────────────
  app.get('/admin/settings', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT key, value, description, updated_at FROM app_settings ORDER BY key`
    );
    return { settings: rows };
  });

  app.patch<{ Params: { key: string } }>('/admin/settings/:key', admin, async (request) => {
    const key = z.string().min(1).parse(request.params.key);
    const b = SettingBody.parse(request.body);
    const actor = request.staff!;
    const existing = await app.db.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    if (!existing.rows[0]) throw new AppError(404, 'not_found', 'Unknown setting.');
    await app.db.query(
      `UPDATE app_settings SET value = $2::jsonb, updated_by_staff_id = $3, updated_at = now() WHERE key = $1`,
      [key, JSON.stringify(b.value), actor.id]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'setting.updated', objectType: 'app_setting', objectId: key,
      details: { from: existing.rows[0].value, to: b.value },
    });
    return { status: 'ok' };
  });

  // ── Roles (for the staff admin UI) ────────────────────────────────────────
  app.get('/admin/roles', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT r.key, r.name, r.description,
              COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       GROUP BY r.id ORDER BY r.key`
    );
    return { roles: rows };
  });
}
