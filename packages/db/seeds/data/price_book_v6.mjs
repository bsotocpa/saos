/*
 * PRICE BOOK v6 — THE CHANGE SET (Brian, 2026-09-27, R75).
 *
 * Not a seed: nothing inserts this at deploy. It is the one statement of what v6 changes, read by
 * the three things that publish it through the version door (POST /admin/price-book/versions):
 *   apps/api/scripts/publish-price-book-v6.ts   production, once, as the CEO's labelled session
 *   apps/api/scripts/e2e-boot.ts                the harness, effective the harness's today
 *   apps/api/test/price-book-v6.spec.ts         the API proof
 * Prices live here because packages/db holds the book (CLAUDE.md: no price literal in application code).
 *
 * R75, verbatim in substance:
 *   - BIZ_990PF and BIZ_990T at $1,200 flat each, same deposit rule as BIZ_990 (the publisher reads
 *     BIZ_990's deposit from the version it copies: `depositFrom`);
 *   - the Hilo referral discount: 50% off tax-return and entity-services lines on the referred client's
 *     first engagement only; not recurring accounting, software pass-through, attest or COO; deposit on
 *     the discounted total; only when the contact's referral source is Hilo on the record; its own line
 *     on the quote and the invoice; counted on the money line as a discount; removable by the CEO on a
 *     quote with a reason, never widenable;
 *   - effective 2026-10-01 (v5 closes 2026-09-30: effective_to is the exclusive handover day).
 */
export const PRICE_BOOK_V6 = {
  effectiveFrom: '2026-10-01',
  note: 'v6 (Brian, 2026-09-27, R75): BIZ_990PF and BIZ_990T at $1,200 flat with the BIZ_990 deposit; the Hilo referral discount (50% off tax-return and entity-services lines on a Hilo-referred client\'s first engagement).',
  additions: [
    {
      itemCode: 'BIZ_990PF',
      serviceLine: 'business_tax',
      nameEn: 'Form 990-PF — private foundation',
      nameEs: 'Formulario 990-PF — fundación privada',
      pricingMode: 'flat',
      unit: 'flat',
      amountCents: 120000,
      depositFrom: 'BIZ_990',
      groupKey: 'business_returns',
      placeAfter: 'BIZ_990',
    },
    {
      itemCode: 'BIZ_990T',
      serviceLine: 'business_tax',
      nameEn: 'Form 990-T — unrelated business income',
      nameEs: 'Formulario 990-T — ingresos comerciales no relacionados',
      pricingMode: 'flat',
      unit: 'flat',
      amountCents: 120000,
      depositFrom: 'BIZ_990',
      groupKey: 'business_returns',
      placeAfter: 'BIZ_990PF',
    },
  ],
  discountRules: [
    {
      ruleCode: 'HILO_REFERRAL',
      nameEn: 'Hilo referral discount',
      nameEs: 'Descuento por referencia de Hilo',
      descriptionEn:
        'Half off tax-return and entity-services work on the first engagement of a client Hilo referred. Not recurring accounting, software, attest or COO work.',
      descriptionEs:
        'La mitad de descuento en declaraciones de impuestos y servicios de entidades en el primer compromiso de un cliente referido por Hilo. No aplica a contabilidad recurrente, software, atestiguamiento ni COO.',
      percentRate: 50,
      appliesToServiceLines: ['individual_tax', 'business_tax', 'entity_services'],
      condition: 'referred_by_hilo',
      scope: 'first_engagement',
    },
  ],
};
