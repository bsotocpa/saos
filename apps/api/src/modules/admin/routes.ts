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
import { registerOpsRoutes } from './ops.ts';

const NewVersionBody = z.object({
  effectiveFrom: z.iso.date(),
  note: z.string().min(3),
  changes: z
    .array(
      z.object({
        itemCode: z.string().min(1),
        amountCents: z.number().int().nonnegative().nullable().optional(),
        priceMinCents: z.number().int().nonnegative().nullable().optional(),
        priceMaxCents: z.number().int().nonnegative().nullable().optional(),
        isActive: z.boolean().optional(),
        // v4. Switching a line between flat and range means CLEARING the columns the
        // other mode uses, which is why the price fields are nullable above — the
        // mode CHECK refuses a row that carries both an amount and a range.
        pricingMode: z.enum(['flat', 'range', 'hourly', 'percent']).optional(),
        // A rate, for percent-mode lines (the late fee). Editable like any other price,
        // because CLAUDE.md puts the rate in the price book and nowhere else.
        percentRate: z.number().positive().max(100).nullable().optional(),
        // null = this line stops asking for a deposit.
        depositCents: z.number().int().nonnegative().nullable().optional(),
        // Rate-carrying items (e.g. the late-fee percent) keep their value in
        // metadata — editable through this same versioned, audited flow.
        metadata: z.record(z.string(), z.unknown()).optional(),
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
    // v4.3 flow 4: set this ONLY when the body actually carries the late-fee
    // disclosure — it is the gate the fee job reads (CLAUDE.md).
    hasLateFeeDisclosure: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update.' });

const SettingBody = z.object({ value: z.unknown() });

export function registerAdminRoutes(app: FastifyInstance): void {
  /**
   * Container health, reported by the HOST cron (scripts/container-health.sh).
   *
   * Authenticated with WEBHOOK_SECRET, the same way the Docuseal webhook is: the
   * caller is a script on the box, not a person with a session. The API deliberately
   * has no Docker socket — mounting it would hand root-equivalent host control to
   * the most internet-exposed process we run.
   */
  app.post('/webhooks/container-health', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (typeof secret !== 'string' || secret !== app.config.WEBHOOK_SECRET) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const b = z
      .object({
        containers: z
          .array(
            z.object({
              name: z.string().min(1),
              health: z.string(),
              state: z.string(),
              failingStreak: z.number().int().min(0).default(0),
              unhealthyMinutes: z.number().min(0).optional(),
              exitCode: z.number().int().optional(),
            })
          )
          .max(100),
      })
      .parse(request.body);
    const { recordContainerHealth } = await import('./container-health.ts');
    return recordContainerHealth(app, b.containers);
  });

  const pricing = { preHandler: [app.authenticate, requirePermission('pricing.edit')] };
  const admin = { preHandler: [app.authenticate, requirePermission('admin.settings')] };

  registerOpsRoutes(app); // WISP security summary (M21)

  // ── Price book ────────────────────────────────────────────────────────────
  /*
   * The admin surface reads the LATEST version, not the one in force today.
   *
   * They differ whenever a version has been staged to start on a future date, which is
   * the normal case: at most one version may exist per day, so a book corrected on a day
   * that already has a version starts tomorrow. The confirm endpoint below has always
   * written to the LATEST version, so reading the in-force one here meant that during
   * that window the page showed one version's flags while a tap cleared another's —
   * confirm, reload, and the ⚠ is still there. It looks like a broken button and it
   * silently answers a question about a different book.
   *
   * Latest is also the right thing to edit: you stage the next version, you do not amend
   * the one clients are being quoted from. `pending` tells the page to say so.
   */
  app.get('/admin/price-book', pricing, async () => {
    const version = await app.db.query(
      `SELECT id, version_number, effective_from, effective_to, note,
              (effective_from > CURRENT_DATE) AS pending
       FROM price_book_versions
       ORDER BY version_number DESC LIMIT 1`
    );
    if (!version.rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version exists.');
    const v = version.rows[0] as { id: string };
    const items = await app.db.query(
      `SELECT item_code, service_line, name_en, amount_cents, price_min_cents, price_max_cents,
              unit, is_pass_through, needs_confirmation, confirmation_note, is_active,
              pricing_mode::text AS pricing_mode, deposit_cents, percent_rate,
              structure_needs_confirmation, structure_confirmation_note
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
        // Every column is listed explicitly, so anything added to price_book_items and
        // NOT added here is silently reset to its default in the new version — a price
        // book that quietly loses a field one version after it was set.
        `INSERT INTO price_book_items
           (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
            amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
            needs_confirmation, confirmation_note, is_active, sort_order, metadata,
            pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note,
            percent_rate)
         SELECT $1, item_code, service_line, name_en, name_es, description_en, description_es,
                amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
                needs_confirmation, confirmation_note, is_active, sort_order, metadata,
                pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note,
                percent_rate
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
        if (change.pricingMode !== undefined) { params.push(change.pricingMode); sets.push(`pricing_mode = $${params.length}::price_pricing_mode`); }
        if (change.depositCents !== undefined) { params.push(change.depositCents); sets.push(`deposit_cents = $${params.length}`); }
        if (change.percentRate !== undefined) { params.push(change.percentRate); sets.push(`percent_rate = $${params.length}`); }
        if (change.metadata !== undefined) { params.push(JSON.stringify(change.metadata)); sets.push(`metadata = $${params.length}::jsonb`); }
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

  /**
   * Confirming a ⚠ item: metadata only — what was seeded stands, no new version.
   *
   * `kind` says WHICH question is being answered. They are separate columns because
   * they mean different things: a price question makes every quote containing the line
   * provisional; a v4 structure question (should this line carry a deposit, is it really
   * hourly) does not. One tap answers one question, and confirming the price does not
   * quietly also confirm the deposit.
   */
  app.post<{ Params: { code: string } }>('/admin/price-book/items/:code/confirm', pricing, async (request) => {
    const code = z.string().min(1).parse(request.params.code);
    const { kind } = z
      .object({ kind: z.enum(['price', 'structure']).default('price') })
      .parse(request.query ?? {});
    const actor = request.staff!;
    const [flag, note] =
      kind === 'structure'
        ? ['structure_needs_confirmation', 'structure_confirmation_note']
        : ['needs_confirmation', 'confirmation_note'];
    const res = await app.db.query(
      `UPDATE price_book_items SET ${flag} = false, ${note} = NULL
       WHERE item_code = $1 AND ${flag}
         AND version_id = (SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1)`,
      [code]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'No unconfirmed item with that code in the current version.');
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: kind === 'structure' ? 'price_book.item_structure_confirmed' : 'price_book.item_confirmed',
      objectType: 'price_book_item', objectId: code,
      details: { kind },
    });
    return { status: 'ok' };
  });

  // ── Templates (copy changes NEVER require a deploy) ──────────────────────
  app.get('/admin/templates', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT key, name, channel, subject_en, subject_es, body_en, body_es,
              is_placeholder, variables, version, updated_at,
              kind::text AS kind, schedule_code, is_active, retired_reason,
              needs_es_review, es_approved_at
       FROM templates ORDER BY is_active DESC, is_placeholder DESC, key`
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
    if (b.hasLateFeeDisclosure !== undefined) {
      params.push(b.hasLateFeeDisclosure);
      sets.push(`has_late_fee_disclosure = $${params.length}`);
    }
    // ENGLISH CONTROLS (legal package v3). Editing the Spanish copy sends it back
    // to the approval queue and drops the prior approval — an approval belongs to
    // the text that was read, not to the row.
    const esEdited = b.bodyEs !== undefined || b.subjectEs !== undefined;
    if (esEdited) {
      sets.push(`needs_es_review = true`, `es_approved_at = NULL`, `es_approved_by_staff_id = NULL`);
    }
    await app.db.query(`UPDATE templates SET ${sets.join(', ')} WHERE key = $1`, params);

    // The launch-gate moment: placeholder → live means final legal text landed.
    const cleared = existing.rows[0].is_placeholder && b.isPlaceholder === false;
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: cleared ? 'template.placeholder_cleared' : 'template.updated',
      objectType: 'template', objectId: key,
      details: { fields: Object.keys(b), es_requeued: esEdited },
    });
    return { status: 'ok', placeholderCleared: cleared, esRequeuedForApproval: esEdited };
  });

  // ── Settings (SLA windows, thresholds, automation knobs) ─────────────────
  /*
   * FINDING #14(3): system health on the ops dashboard.
   *
   * Authenticated staff, no admin.settings permission required — a wedged virus
   * scanner is operational information that everyone working the queue needs, not a
   * configuration secret. Putting it behind the admin gate is how it stays invisible.
   *
   * Includes the document-scan backlog, because "the scanner is down" and "47 client
   * uploads are waiting to be filed" are the same incident seen from two ends, and the
   * second one is what makes it urgent.
   */
  app.get('/admin/system-health', { preHandler: [app.authenticate] }, async () => {
    const deps = await app.db.query(
      `SELECT name, reachable, since, last_checked_at, detail,
              EXTRACT(EPOCH FROM (now() - since))::bigint AS seconds_in_state
         FROM dependency_health ORDER BY reachable, name`
    );
    const scans = await app.db.query(
      `SELECT scan_status::text AS status, count(*)::int AS n,
              min(created_at) AS oldest
         FROM documents
        WHERE archived_at IS NULL
        GROUP BY scan_status`
    );
    return { dependencies: deps.rows, documentScans: scans.rows };
  });

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

  // ── Client-acting automation kill switches (Brian's directive) ─────────────
  // Every automation that touches a client ships DISABLED; Brian arms them
  // here as real clients reach the portal. Each flip is audited.
  app.get('/admin/automations', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT a.key, a.name, a.description, a.audience, a.enabled, a.updated_at,
              st.full_name AS updated_by
       FROM automations a
       LEFT JOIN staff st ON st.id = a.updated_by_staff_id
       ORDER BY a.enabled DESC, a.key`
    );
    return { automations: rows };
  });

  app.patch<{ Params: { key: string } }>('/admin/automations/:key', admin, async (request) => {
    const key = z.string().min(1).parse(request.params.key);
    const b = z.object({ enabled: z.boolean() }).parse(request.body);
    const actor = request.staff!;
    const existing = await app.db.query<{ enabled: boolean; name: string }>(
      `SELECT enabled, name FROM automations WHERE key = $1`,
      [key]
    );
    if (!existing.rows[0]) throw new AppError(404, 'not_found', 'Unknown automation.');
    await app.db.query(
      `UPDATE automations SET enabled = $2, updated_by_staff_id = $3 WHERE key = $1`,
      [key, b.enabled, actor.id]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: b.enabled ? 'automation.enabled' : 'automation.disabled',
      objectType: 'automation', objectId: key,
      details: { name: existing.rows[0].name, from: existing.rows[0].enabled, to: b.enabled },
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
