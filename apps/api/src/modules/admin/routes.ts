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
import { calendarDay } from '../tax/deadlines.ts';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { registerOpsRoutes } from './ops.ts';

/** The price_service_line enum, as the database holds it. */
const PRICE_SERVICE_LINES = [
  'individual_tax', 'business_tax', 'recurring_accounting', 'scope_ladder', 'setup_conversion', 'software_passthrough',
  'filings_1099_w2', 'entity_services', 'attest', 'specialized_cpa', 'coo', 'deposit',
] as const;

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
    .default([]),
  /*
   * NEW LINES (R75, 2026-09-27): a version may add items the book has never held (BIZ_990PF, BIZ_990T).
   * Every column a line needs is said here; nothing is inferred. A code already in the book is refused
   * (change it through `changes` instead), and the R55 deposit check reads these rows too.
   */
  additions: z
    .array(
      z.object({
        itemCode: z.string().regex(/^[A-Z0-9_]+$/, 'Item codes are capitals, digits and underscores.'),
        serviceLine: z.enum(PRICE_SERVICE_LINES),
        nameEn: z.string().min(1),
        nameEs: z.string().min(1),
        descriptionEn: z.string().min(1).nullable().optional(),
        descriptionEs: z.string().min(1).nullable().optional(),
        pricingMode: z.enum(['flat', 'range', 'hourly', 'percent']),
        unit: z.string().min(1).default('flat'),
        amountCents: z.number().int().nonnegative().nullable().optional(),
        priceMinCents: z.number().int().nonnegative().nullable().optional(),
        priceMaxCents: z.number().int().nonnegative().nullable().optional(),
        depositCents: z.number().int().nonnegative().nullable().optional(),
        groupKey: z.string().min(1).nullable().optional(),
        sortOrder: z.number().int(),
        displayOnQuote: z.boolean().default(true),
      })
    )
    .default([]),
  /*
   * DISCOUNT RULES (R75): added to, or changed in, the new version only (matched by rule code). The
   * rate and the lines reached are the book's; the condition and the scope are the kinds the code
   * knows how to apply (migration 0128's CHECKs name them).
   */
  discountRules: z
    .array(
      z.object({
        ruleCode: z.string().regex(/^[A-Z0-9_]+$/),
        nameEn: z.string().min(1),
        nameEs: z.string().min(1),
        descriptionEn: z.string().min(1).nullable().optional(),
        descriptionEs: z.string().min(1).nullable().optional(),
        percentRate: z.number().positive().max(100),
        appliesToServiceLines: z.array(z.enum(PRICE_SERVICE_LINES)).min(1),
        condition: z.enum(['referred_by_hilo']),
        scope: z.enum(['first_engagement']),
        isActive: z.boolean().default(true),
      })
    )
    .default([]),
}).refine((b) => b.changes.length + b.additions.length + b.discountRules.length > 0, {
  message: 'A new version needs at least one change, new line or discount rule.',
});

type VersionChange = z.infer<typeof NewVersionBody>['changes'][number];
type VersionAddition = z.infer<typeof NewVersionBody>['additions'][number];

/**
 * The item codes whose deposit would exceed their flat price once `changes` are laid over the rows
 * of `sourceVersionId` — the rows the new version would hold (R55). Same predicate as the CHECK
 * price_book_items_deposit_not_over_price: only a flat-unit line with both a price and a deposit is
 * compared. A change to a code the source lacks is left to the publish route's own unknown_price_items.
 */
export async function depositOverPrice(
  db: { query: <R extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[] }> },
  sourceVersionId: string,
  changes: readonly VersionChange[],
  additions: readonly VersionAddition[] = []
): Promise<string[]> {
  const { rows } = await db.query<{ item_code: string; unit: string; amount_cents: number | null; deposit_cents: number | null }>(
    `SELECT item_code, unit::text AS unit, amount_cents, deposit_cents FROM price_book_items WHERE version_id = $1 ORDER BY item_code`,
    [sourceVersionId]
  );
  const byCode = new Map(changes.map((c) => [c.itemCode, c] as const));
  const over: string[] = [];
  for (const r of rows) {
    const c = byCode.get(r.item_code);
    const amount = c?.amountCents !== undefined ? c.amountCents : r.amount_cents;
    const deposit = c?.depositCents !== undefined ? c.depositCents : r.deposit_cents;
    if (deposit === null || r.unit !== 'flat' || amount === null || deposit <= amount) continue;
    over.push(r.item_code);
  }
  // R75: a new line is held to the same predicate as a copied one.
  for (const a of additions) {
    const deposit = a.depositCents ?? null;
    const amount = a.amountCents ?? null;
    if (deposit === null || a.unit !== 'flat' || amount === null || deposit <= amount) continue;
    over.push(a.itemCode);
  }
  return over;
}

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
    const discountRules = await app.db.query(
      `SELECT rule_code, name_en, name_es, description_en, percent_rate::float AS percent_rate,
              applies_to_service_lines::text[] AS applies_to_service_lines, condition, scope, is_active
         FROM price_book_discount_rules WHERE version_id = $1 ORDER BY sort_order, rule_code`,
      [v.id]
    );
    return { version: version.rows[0], items: items.rows, bundleRules: rules.rows, discountRules: discountRules.rows };
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
      if (calendarDay(b.effectiveFrom, 'effectiveFrom') <= calendarDay(cur.effective_from, 'effective_from')) {
        throw new AppError(400, 'effective_date_conflict', `New version must start after ${cur.effective_from}.`);
      }

      // A version is published whole and never edited afterwards (R55), so every row it will hold is
      // checked here, before anything is written: the source version's rows with this publish's
      // changes laid over them. The predicate is the one the constraint
      // price_book_items_deposit_not_over_price holds (flat unit rows only; a per-hour line may ask
      // more up front than one hour costs). The constraint was added NOT VALID over four version-4
      // rows and stays as the backstop; this refusal names the lines so the publisher can fix them in
      // the same sitting instead of reading a constraint name.
      const overPrice = await depositOverPrice(client, cur.id, b.changes, b.additions);
      if (overPrice.length > 0) {
        throw new AppError(409, 'deposit_over_price',
          `A deposit cannot exceed the price it is taken against. Fix ${overPrice.length === 1 ? 'this line' : 'these lines'} before publishing: ${overPrice.join(', ')}.`);
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
        // group_key (0116) joined the list 2026-09-27 (R75): the copy had been dropping every line's
        // catalog group, so the first version published after 0116 would have lost them all.
        `INSERT INTO price_book_items
           (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
            amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
            needs_confirmation, confirmation_note, is_active, sort_order, metadata,
            pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note,
            percent_rate, group_key)
         SELECT $1, item_code, service_line, name_en, name_es, description_en, description_es,
                amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
                needs_confirmation, confirmation_note, is_active, sort_order, metadata,
                pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note,
                percent_rate, group_key
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

      /*
       * THE PACKAGES (R75, 2026-09-27). bundles and bundle_components are version-scoped and every
       * reader (composeBundle, the catalog, the builder) reads the version in force, but the copy never
       * carried them: a publish would have left the new version with no packages. Copied whole, each
       * package with its components, the new rows under new ids.
       */
      const bundles = await client.query<{ id: string }>(`SELECT id FROM bundles WHERE version_id = $1 ORDER BY slug`, [cur.id]);
      for (const bundle of bundles.rows) {
        const copied = await client.query<{ id: string }>(
          `INSERT INTO bundles (version_id, slug, name_en, name_es, description_en, description_es,
                                discount_percent, discount_cents, override_cents, is_active, published_at, campaign_code)
           SELECT $1, slug, name_en, name_es, description_en, description_es,
                  discount_percent, discount_cents, override_cents, is_active, published_at, campaign_code
             FROM bundles WHERE id = $2
           RETURNING id`,
          [newId, bundle.id]
        );
        await client.query(
          `INSERT INTO bundle_components (bundle_id, item_code, quantity, is_optional, sort_order, note_en, note_es)
           SELECT $1, item_code, quantity, is_optional, sort_order, note_en, note_es
             FROM bundle_components WHERE bundle_id = $2`,
          [copied.rows[0]!.id, bundle.id]
        );
      }

      // R75: the discount rules are the book's too; a version copies them whole.
      await client.query(
        `INSERT INTO price_book_discount_rules
           (version_id, rule_code, name_en, name_es, description_en, description_es, percent_rate,
            applies_to_service_lines, condition, scope, is_active, sort_order)
         SELECT $1, rule_code, name_en, name_es, description_en, description_es, percent_rate,
                applies_to_service_lines, condition, scope, is_active, sort_order
         FROM price_book_discount_rules WHERE version_id = $2`,
        [newId, cur.id]
      );

      // R75: new lines, into the NEW version only. A code the book already holds is a change, not a line.
      for (const a of b.additions) {
        const exists = await client.query(`SELECT 1 FROM price_book_items WHERE version_id = $1 AND item_code = $2`, [newId, a.itemCode]);
        if (exists.rowCount) {
          throw new AppError(409, 'price_item_exists', `${a.itemCode} is already in the book; change it instead of adding it.`);
        }
        await client.query(
          `INSERT INTO price_book_items
             (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
              pricing_mode, unit, amount_cents, price_min_cents, price_max_cents, deposit_cents,
              group_key, sort_order, display_on_quote, is_active, needs_confirmation)
           VALUES ($1, $2, $3::price_service_line, $4, $5, $6, $7, $8::price_pricing_mode, $9::price_unit, $10, $11, $12, $13,
                   $14, $15, $16, true, false)`,
          [newId, a.itemCode, a.serviceLine, a.nameEn, a.nameEs, a.descriptionEn ?? null, a.descriptionEs ?? null,
           a.pricingMode, a.unit, a.amountCents ?? null, a.priceMinCents ?? null, a.priceMaxCents ?? null, a.depositCents ?? null,
           a.groupKey ?? null, a.sortOrder, a.displayOnQuote]
        );
      }

      // R75: discount rules, added or changed in the NEW version only.
      for (const r of b.discountRules) {
        await client.query(
          `INSERT INTO price_book_discount_rules
             (version_id, rule_code, name_en, name_es, description_en, description_es, percent_rate,
              applies_to_service_lines, condition, scope, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::price_service_line[], $9, $10, $11)
           ON CONFLICT (version_id, rule_code) DO UPDATE SET
             name_en = EXCLUDED.name_en, name_es = EXCLUDED.name_es,
             description_en = EXCLUDED.description_en, description_es = EXCLUDED.description_es,
             percent_rate = EXCLUDED.percent_rate, applies_to_service_lines = EXCLUDED.applies_to_service_lines,
             condition = EXCLUDED.condition, scope = EXCLUDED.scope, is_active = EXCLUDED.is_active`,
          [newId, r.ruleCode, r.nameEn, r.nameEs, r.descriptionEn ?? null, r.descriptionEs ?? null, r.percentRate,
           r.appliesToServiceLines, r.condition, r.scope, r.isActive]
        );
      }

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
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'price_book.version_created',
        objectType: 'price_book_version', objectId: newId,
        details: {
          version_number: cur.version_number + 1,
          effective_from: b.effectiveFrom,
          changes: b.changes.map((c) => c.itemCode),
          additions: b.additions.map((a) => a.itemCode),
          discount_rules: b.discountRules.map((r) => ({ code: r.ruleCode, percent_rate: r.percentRate, lines: r.appliesToServiceLines })),
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
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
      /*
       * held_count (decision 3, 2026-09-09): every send this automation HELD while it was off —
       * the audit rows the gate wrote instead of sending (details.automation = key). Arming
       * never replays them; the number stays on the row so a person can see what waited and
       * decide, by hand, whether any of it should still go.
       */
      `SELECT a.key, a.name, a.description, a.audience, a.enabled, a.updated_at,
              st.full_name AS updated_by,
              (SELECT count(*)::int FROM audit_log l
                WHERE l.action LIKE '%\\_suppressed' AND l.details->>'automation' = a.key) AS held_count
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: b.enabled ? 'automation.enabled' : 'automation.disabled',
      objectType: 'automation', objectId: key,
      details: { name: existing.rows[0].name, from: existing.rows[0].enabled, to: b.enabled },
    });
    return { status: 'ok' };
  });

  // ── Roles (for the staff admin UI) ────────────────────────────────────────
  app.get('/admin/roles', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT r.key, r.name, r.description, r.accepts_staff,
              COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       GROUP BY r.id ORDER BY r.key`
    );
    return { roles: rows };
  });
}
