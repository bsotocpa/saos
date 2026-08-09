// Bundle builder seeds (v4.6). A bundle is PRICE-BOOK ITEMS + a discount rule
// + optional components — never an ad-hoc price. The two seeded bundles are
// the ones the spec names, and the resolution one exists partly to prove the
// mechanism generalises.
//
// Discounts are left NULL: "bundle discount: admin-set at publish" (v4.6).
// A bundle with no discount prices as the plain sum of its components, so
// publishing one before Brian sets a discount can never quietly undercharge.

export const bundles = [
  {
    slug: 's-corp-conversion',
    nameEn: 'S-Corp Conversion Package',
    nameEs: 'Paquete de conversión a S-Corp',
    descriptionEn:
      'Everything the conversion needs in one place: the 2553 election, the first 1120-S, one year of book cleanup, ' +
      'QBO and payroll set up together, and the owner-compensation analysis that makes the election worth having.',
    descriptionEs:
      'Todo lo que la conversión necesita en un solo lugar: la elección 2553, la primera declaración 1120-S, un año de ' +
      'limpieza de libros, la configuración de QBO y nómina, y el análisis de compensación al dueño que hace que la ' +
      'elección valga la pena.',
    campaignCode: 'scorp-2026',
    components: [
      { itemCode: 'SCORP_CONVERSION_2553', quantity: 1 },
      { itemCode: 'BIZ_1120S', quantity: 1 },
      { itemCode: 'ACCT_CATCHUP_HOURLY', quantity: 1, noteEn: 'One year of cleanup, billed hourly at the book rate.', noteEs: 'Un año de limpieza, por hora según la tarifa del libro.' },
      { itemCode: 'SETUP_QBO', quantity: 1 },
      { itemCode: 'SETUP_PAYROLL', quantity: 1 },
      { itemCode: 'SPEC_TAX_PLANNING', quantity: 1, noteEn: 'Owner-compensation analysis and election planning.', noteEs: 'Análisis de compensación al dueño y planificación de la elección.' },
      // Optional at quote time — the client chooses.
      { itemCode: 'ACCT_QUARTERLY', quantity: 1, isOptional: true, noteEn: 'Add ongoing quarterly bookkeeping.', noteEs: 'Agregar contabilidad trimestral continua.' },
    ],
  },
  {
    slug: 'tax-resolution',
    nameEn: 'Tax Resolution Package (multi-year)',
    nameEs: 'Paquete de resolución fiscal (varios años)',
    descriptionEn:
      'Multi-year catch-up filing. Years are priced per return from the book, the prior-year surcharge applies ' +
      'automatically to anything more than two years back, reconstruction is added per year whose books are ' +
      'incomplete, and the 8821 transcript step comes first.',
    descriptionEs:
      'Presentación de varios años atrasados. Cada año se cotiza por declaración según el libro de precios, el ' +
      'recargo por año anterior se aplica automáticamente a lo que tenga más de dos años, la reconstrucción se ' +
      'agrega por cada año con libros incompletos, y el paso de transcripciones (8821) va primero.',
    campaignCode: 'resolution-2026',
    components: [
      { itemCode: 'IND_BASE_SINGLE', quantity: 1, noteEn: 'Per-year base — the quote grid multiplies it by the years selected.', noteEs: 'Base por año — la cuadrícula de cotización lo multiplica por los años seleccionados.' },
      { itemCode: 'PRIOR_YEAR_SURCHARGE', quantity: 1, noteEn: 'Applied automatically per return more than two years back.', noteEs: 'Se aplica automáticamente por declaración de más de dos años atrás.' },
      { itemCode: 'RES_BOOKS_RECONSTRUCTION', quantity: 1, isOptional: true, noteEn: 'Added per year whose books are partial or missing.', noteEs: 'Se agrega por año con libros incompletos o inexistentes.' },
      { itemCode: 'RES_PENALTY_ABATEMENT', quantity: 1, isOptional: true, noteEn: 'Requires an active 2848 for the year.', noteEs: 'Requiere un 2848 vigente para el año.' },
      { itemCode: 'RES_INSTALLMENT_AGREEMENT', quantity: 1, isOptional: true, noteEn: 'Requires an active 2848 for the year.', noteEs: 'Requiere un 2848 vigente para el año.' },
    ],
  },
];

export async function seedBundles(client) {
  const version = await client.query(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const versionId = version.rows[0]?.id;
  if (!versionId) return 'no price book version — bundles skipped';

  let inserted = 0;
  let skippedComponents = 0;
  for (const b of bundles) {
    const res = await client.query(
      `INSERT INTO bundles (version_id, slug, name_en, name_es, description_en, description_es, campaign_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (version_id, slug) DO NOTHING
       RETURNING id`,
      [versionId, b.slug, b.nameEn, b.nameEs, b.descriptionEn, b.descriptionEs, b.campaignCode ?? null]
    );
    if (res.rowCount === 0) continue; // admin edits win over re-seeds
    inserted++;
    const bundleId = res.rows[0].id;
    for (const [i, c] of b.components.entries()) {
      // A component MUST reference a real price-book item — a bundle can never
      // invent a price, so an unknown code is skipped loudly rather than faked.
      const exists = await client.query(
        `SELECT 1 FROM price_book_items WHERE version_id = $1 AND item_code = $2`,
        [versionId, c.itemCode]
      );
      if (exists.rowCount === 0) {
        skippedComponents++;
        console.warn(`  ⚠ bundle ${b.slug}: unknown price-book item ${c.itemCode} — component skipped`);
        continue;
      }
      await client.query(
        `INSERT INTO bundle_components (bundle_id, item_code, quantity, is_optional, sort_order, note_en, note_es)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (bundle_id, item_code) DO NOTHING`,
        [bundleId, c.itemCode, c.quantity ?? 1, c.isOptional ?? false, i, c.noteEn ?? null, c.noteEs ?? null]
      );
    }
  }
  return `${inserted} of ${bundles.length} bundles seeded (discounts admin-set at publish)` +
    (skippedComponents > 0 ? `; ⚠ ${skippedComponents} component(s) referenced unknown items` : '');
}
