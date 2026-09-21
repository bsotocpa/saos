/*
 * SAVE THESE LINES AS A PACKAGE (Brian, 2026-09-20). A package is a bundle: price-book items plus
 * a discount rule (CLAUDE.md), never an ad-hoc amount. So the builder's lines are saved by item
 * code and quantity only — the amounts a person may have typed on them stay on that quote — and a
 * custom line, which has no code, is refused. The discount is left unset, the way the seeded
 * bundles are: admin-set at publish, so a new package can never quietly undercharge.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';
import { AppError, type AuthedStaff } from '../../types.ts';

export interface PackageLineInput {
  itemCode: string;
  quantity?: number | undefined;
  isOptional?: boolean | undefined;
}

/** "S corp first year" → "s-corp-first-year"; a second package of the same name gets a numeric suffix. */
function slugOf(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : 'package';
}

export async function savePackage(
  app: FastifyInstance,
  input: { name: string; lines: PackageLineInput[] },
  actor: AuthedStaff
): Promise<{ slug: string; name: string; components: number }> {
  const custom = input.lines.filter((l) => l.itemCode.startsWith('CUSTOM_')).map((l) => l.itemCode);
  if (custom.length > 0) {
    throw Object.assign(
      new AppError(400, 'custom_line_in_package', 'A package composes from the price book only; remove the custom line first.'),
      { issues: [{ path: 'lines', message: 'A package composes from the price book only; remove the custom line first.' }] }
    );
  }
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  const versionId = version.rows[0]?.id;
  if (!versionId) throw new AppError(500, 'price_book_missing', 'No price book version in force.');

  const codes = [...new Set(input.lines.map((l) => l.itemCode))];
  const known = await app.db.query<{ item_code: string; display_on_quote: boolean }>(
    `SELECT item_code, display_on_quote FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [versionId, codes]
  );
  const byCode = new Map(known.rows.map((r) => [r.item_code, r]));
  const missing = codes.filter((c) => !byCode.has(c));
  if (missing.length > 0) throw new AppError(400, 'unknown_price_items', `Not in the price book in force: ${missing.join(', ')}.`);
  const components = codes.filter((c) => byCode.get(c)!.display_on_quote === false);
  if (components.length > 0) throw new AppError(400, 'not_quotable', `These are derivation components, not sellable lines: ${components.join(', ')}.`);

  return withTransaction(app.db, async () => {
    const base = slugOf(input.name);
    const taken = await app.db.query<{ slug: string }>(
      `SELECT slug FROM bundles WHERE version_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%')`,
      [versionId, base]
    );
    const have = new Set(taken.rows.map((r) => r.slug));
    let slug = base;
    for (let n = 2; have.has(slug); n += 1) slug = `${base}-${n}`;

    const created = await app.db.query<{ id: string }>(
      `INSERT INTO bundles (version_id, slug, name_en, name_es, description_en)
       VALUES ($1, $2, $3, $3, $4) RETURNING id`,
      [versionId, slug, input.name, `Saved from the quote builder by ${actor.fullName}.`]
    );
    const bundleId = created.rows[0]!.id;
    // One component per code: a line listed twice is one component at the first line's terms.
    const seen = new Set<string>();
    let sort = 0;
    for (const l of input.lines) {
      if (seen.has(l.itemCode)) continue;
      seen.add(l.itemCode);
      await app.db.query(
        `INSERT INTO bundle_components (bundle_id, item_code, quantity, is_optional, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [bundleId, l.itemCode, l.quantity ?? 1, l.isOptional ?? false, sort]
      );
      sort += 1;
    }
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'bundle.created', objectType: 'bundle', objectId: bundleId,
      details: { slug, name: input.name, item_codes: [...seen], source: 'quote_builder' },
    });
    return { slug, name: input.name, components: seen.size };
  });
}
