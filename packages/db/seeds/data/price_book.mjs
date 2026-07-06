// Price book v1 — faithful transcription of MP v4.2 "PRICING SEED DATA".
// Source: 2025_new_process_buildoutpricing_v2.xlsx ("pricing packages" =
// canonical calculator), 2025 Business/Personal Service Sheet, 2026 session
// transcripts. Where sources conflict the spec's primary value is seeded and
// needsConfirmation carries the conflict for Brian to resolve BEFORE LAUNCH
// (launch gate, M23). All amounts in integer cents.
//
// This file and its sibling migration are the ONLY places prices may appear
// as literals (scripts/check-no-hardcoded-prices.mjs enforces).

const item = (code, serviceLine, nameEn, nameEs, amountCents, opts = {}) => ({
  code,
  serviceLine,
  nameEn,
  nameEs,
  amountCents,
  unit: opts.unit ?? 'flat',
  minCents: opts.minCents ?? null,
  maxCents: opts.maxCents ?? null,
  passThrough: opts.passThrough ?? false,
  displayOnQuote: opts.displayOnQuote ?? true,
  needsConfirmation: opts.needsConfirmation ?? false,
  confirmationNote: opts.confirmationNote ?? null,
  descEn: opts.descEn ?? null,
  descEs: opts.descEs ?? null,
});

export const PRICE_BOOK_V1 = {
  versionNumber: 1,
  effectiveFrom: '2026-07-05',
  note: 'v1 — seeded from MP v4.2 Pricing Seed Data (2025 pricing workbook + service sheet + 2026 transcripts). ⚠ conflicts carried as needs_confirmation.',
};

export const items = [
  // ── Individual tax — itemized calculator (one federal + one state included) ──
  item('IND_BASE_SINGLE', 'individual_tax', 'Individual return — Single', 'Declaración individual — Soltero(a)', 15000, {
    descEn: 'Base price; one federal + one state included.',
    descEs: 'Precio base; incluye una declaración federal y un estado.',
  }),
  item('IND_BASE_MFJ', 'individual_tax', 'Individual return — Married filing jointly', 'Declaración individual — Casados en conjunto', 20000, {
    descEn: 'Base price; one federal + one state included.',
    descEs: 'Precio base; incluye una declaración federal y un estado.',
  }),
  item('IND_BASE_MFS', 'individual_tax', 'Individual return — Married filing separately', 'Declaración individual — Casados por separado', 20000),
  item('IND_BASE_HOH', 'individual_tax', 'Individual return — Head of household', 'Declaración individual — Cabeza de familia', 20000),
  item('IND_ADDL_STATE', 'individual_tax', 'Additional state return', 'Estado adicional', 15000, { unit: 'per_state' }),

  // Individual add-ons
  item('IND_SCH_C', 'individual_tax', 'Schedule C (self-employment)', 'Anexo C (negocio propio)', 18000, { unit: 'per_form' }),
  item('IND_SCH_A', 'individual_tax', 'Schedule A (itemized deductions)', 'Anexo A (deducciones detalladas)', 10000),
  item('IND_SCH_B_D', 'individual_tax', 'Schedule B/D (interest, dividends, capital gains)', 'Anexos B/D (intereses, dividendos, ganancias)', 12000),
  item('IND_SCH_E_RENTAL', 'individual_tax', 'Schedule E — rental property', 'Anexo E — propiedad de alquiler', 18000, { unit: 'per_property' }),
  item('IND_SCH_E_K1', 'individual_tax', 'Schedule E — K-1', 'Anexo E — K-1', 12000, { unit: 'per_k1' }),
  item('IND_SCH_H', 'individual_tax', 'Schedule H (household employment)', 'Anexo H (empleados domésticos)', 12000),
  item('IND_SCH_EIC', 'individual_tax', 'Schedule EIC (earned income credit)', 'Anexo EIC (crédito por ingreso del trabajo)', 15000),
  item('IND_F8863', 'individual_tax', 'Form 8863 — education credits', 'Formulario 8863 — créditos educativos', 10000),
  item('IND_F8995', 'individual_tax', 'Form 8995 — QBI deduction', 'Formulario 8995 — deducción QBI', 7500),
  item('IND_F4562', 'individual_tax', 'Form 4562 — depreciation', 'Formulario 4562 — depreciación', 12000),
  item('IND_F2441', 'individual_tax', 'Form 2441 — dependent care', 'Formulario 2441 — cuidado de dependientes', 5000),
  item('IND_F8812', 'individual_tax', 'Form 8812 — child tax credit', 'Formulario 8812 — crédito por hijos', 5000),
  item('IND_W7_ITIN', 'individual_tax', 'Form W-7 — ITIN application', 'Formulario W-7 — solicitud de ITIN', 35000),
  item('IND_W7_ITIN_ADDL', 'individual_tax', 'Form W-7 — each additional ITIN', 'Formulario W-7 — ITIN adicional', 25000, { unit: 'per_additional' }),
  item('IND_F5695', 'individual_tax', 'Form 5695 — residential energy credits', 'Formulario 5695 — créditos de energía', 5000),
  item('IND_NOL', 'individual_tax', 'NOL carryover', 'Arrastre de pérdida operativa neta (NOL)', 15000),
  item('IND_F8949_121', 'individual_tax', 'Form 8949 — §121 home sale', 'Formulario 8949 — venta de vivienda (§121)', 15000),
  item('IND_F8936', 'individual_tax', 'Form 8936 — clean vehicle credit', 'Formulario 8936 — vehículo limpio', 15000),

  // Individual — other services
  item('IND_AMENDMENT_1040X', 'individual_tax', 'Amended return (1040-X)', 'Declaración enmendada (1040-X)', 30000),
  item('IND_NOTICE_SUPPORT', 'individual_tax', 'Notice / penalty / installment support', 'Apoyo con avisos, multas o planes de pago', 15000),
  item('IND_AUDIT_DEFENSE', 'individual_tax', 'Audit defense', 'Defensa en auditoría', 15000),
  item('IND_CPA_LETTER', 'individual_tax', 'CPA letters / wealth statements / tax planning', 'Cartas CPA / estados patrimoniales / planificación fiscal', null, {
    minCents: 25000,
    maxCents: 50000,
    needsConfirmation: true,
    confirmationNote: '⚠ Sheets conflict: $250–500 range. Overlaps Specialized CPA tax-planning item — Brian confirms canonical pricing before launch.',
  }),
  item('IND_SPECIALIZED_HOURLY', 'individual_tax', 'Specialized services (hourly)', 'Servicios especializados (por hora)', 15000, { unit: 'per_hour' }),

  // ── Business tax returns (one federal + one state included) ──────────────────
  item('BIZ_SCH_C', 'business_tax', 'Schedule C (sole prop or SMLLC)', 'Anexo C (propietario único o SMLLC)', 18000, {
    descEn: 'Same service as IND_SCH_C — listed in both spec sections; the calculator (M12) applies it once.',
    descEs: 'Mismo servicio que IND_SCH_C; la calculadora lo aplica una sola vez.',
  }),
  item('BIZ_1065', 'business_tax', 'Form 1065 — partnership', 'Formulario 1065 — sociedad', 60000),
  item('BIZ_1120S', 'business_tax', 'Form 1120-S — S corporation', 'Formulario 1120-S — corporación S', 70000),
  item('BIZ_1120', 'business_tax', 'Form 1120 — C corporation', 'Formulario 1120 — corporación C', 80000),
  item('BIZ_990', 'business_tax', 'Form 990 / 990-EZ — exempt organization', 'Formulario 990 / 990-EZ — organización exenta', 80000),
  item('BIZ_1120C', 'business_tax', 'Form 1120-C — housing co-op', 'Formulario 1120-C — cooperativa de vivienda', 80000),
  item('BIZ_1120F', 'business_tax', 'Form 1120-F — foreign corporation', 'Formulario 1120-F — corporación extranjera', 80000),
  item('BIZ_1120H', 'business_tax', 'Form 1120-H — homeowners association', 'Formulario 1120-H — asociación de propietarios', 80000),
  item('BIZ_1120POL', 'business_tax', 'Form 1120-POL — political organization', 'Formulario 1120-POL — organización política', 80000),
  item('BIZ_ADDL_STATE', 'business_tax', 'Additional state return (business)', 'Estado adicional (negocios)', 35000, { unit: 'per_state' }),
  item('BIZ_AMENDMENT', 'business_tax', 'Amended business return', 'Declaración enmendada (negocios)', 60000),
  item('BIZ_NOTICE_SUPPORT', 'business_tax', 'Notice support (business)', 'Apoyo con avisos (negocios)', 30000),

  // ── Recurring accounting (Full Management) ───────────────────────────────────
  item('ACCT_MONTHLY', 'recurring_accounting', 'Accounting — monthly (full management)', 'Contabilidad mensual — gestión completa', 25000, { unit: 'per_month' }),
  item('ACCT_QUARTERLY', 'recurring_accounting', 'Accounting — quarterly (full management)', 'Contabilidad trimestral — gestión completa', 60000, { unit: 'per_quarter' }),
  item('ACCT_SEMI_ANNUAL', 'recurring_accounting', 'Accounting — semi-annual (full management)', 'Contabilidad semestral — gestión completa', 100000, {
    unit: 'per_6_months',
    needsConfirmation: true,
    confirmationNote: '⚠ Service sheet $900, workbook $800, most recent verbal $1,000 — seeded at $1,000 (most recent verbal wins per spec); Brian confirms.',
  }),
  item('ACCT_CATCHUP_HOURLY', 'recurring_accounting', 'Catch-up / cleanup (hourly)', 'Puesta al día / limpieza (por hora)', 7500, { unit: 'per_hour' }),

  // ── Scope ladder (per service line: Accounting, Payroll, Sales Tax) ──────────
  item('SCOPE_REG_SETUP', 'scope_ladder', 'Registration & Setup', 'Registro y configuración', 25000),
  item('SCOPE_REVIEW_AUDIT', 'scope_ladder', 'Review / Audit rung', 'Revisión / auditoría interna', 15000),
  item('SCOPE_ADMIN_TRAINING', 'scope_ladder', 'Admin & Training Support', 'Soporte administrativo y capacitación', 15000, {
    descEn: 'The deliberate Hilo bridge product — DIY-minded entrepreneurs buy training.',
    descEs: 'El producto puente con Hilo — para emprendedores que prefieren hacerlo ellos mismos.',
  }),
  item('SCOPE_FULLMGMT_PAYROLL', 'scope_ladder', 'Payroll — full management & compliance (W-2/940/941/944/UI)', 'Nómina — gestión completa (W-2/940/941/944/UI)', 50000, {
    unit: 'per_month',
    needsConfirmation: true,
    confirmationNote: 'Spec gives $500 without a billing unit; seeded as monthly (recurring service). Brian confirms unit.',
  }),
  item('SCOPE_FULLMGMT_SALES_TAX', 'scope_ladder', 'Sales tax — full management & compliance', 'Impuesto sobre ventas — gestión completa', 10000, {
    unit: 'per_month',
    needsConfirmation: true,
    confirmationNote: '⚠ $100 in workbook vs ST-1 $50/filing on service sheet; free with monthly package (bundle rule FREE_ST1_WITH_MONTHLY). Unit assumed monthly. Brian confirms.',
  }),
  item('SALES_TAX_ST1_FILING', 'scope_ladder', 'ST-1 sales tax filing', 'Presentación ST-1 de impuesto sobre ventas', 5000, {
    unit: 'per_filing',
    needsConfirmation: true,
    confirmationNote: '⚠ Service-sheet per-filing price ($50) — same conflict as SCOPE_FULLMGMT_SALES_TAX; free with monthly package via bundle rule.',
  }),

  // ── Setups & conversions ─────────────────────────────────────────────────────
  item('SETUP_QBO', 'setup_conversion', 'QuickBooks Online setup', 'Configuración de QuickBooks Online', 25000),
  item('SETUP_PAYROLL', 'setup_conversion', 'Payroll setup', 'Configuración de nómina', 25000, {
    descEn: 'Bundled with QBO setup = one combined fee (bundle rule BUNDLE_QBO_PAYROLL_SETUP).',
    descEs: 'En paquete con la configuración de QBO = una sola tarifa combinada.',
  }),
  item('SCORP_CONVERSION_2553', 'setup_conversion', 'S corp conversion (Form 2553)', 'Conversión a corporación S (Formulario 2553)', 25000, {
    descEn: 'Owner-comp default: 1/3 of net profits (app_settings.owner_comp_default_fraction).',
    descEs: 'Compensación del dueño por defecto: 1/3 de las utilidades netas.',
  }),

  // ── Software pass-through (shown on quotes; NOT Soto revenue) ────────────────
  item('PASS_QBO', 'software_passthrough', 'QuickBooks Online subscription (software cost)', 'Suscripción QuickBooks Online (costo del software)', 4000, {
    unit: 'per_month',
    passThrough: true,
    descEn: 'From ~$40/mo, billed by Intuit. ~$90–100/mo typical combined with QBO Payroll.',
    descEs: 'Desde ~$40/mes, facturado por Intuit. Combinado con nómina suele ser ~$90–100/mes.',
  }),
  item('PASS_QBO_PAYROLL', 'software_passthrough', 'QBO Payroll subscription (software cost)', 'QBO Payroll (costo del software)', 5000, {
    unit: 'per_month',
    passThrough: true,
    descEn: 'From ~$50/mo, billed by Intuit.',
    descEs: 'Desde ~$50/mes, facturado por Intuit.',
  }),

  // ── 1099 / W-2 filings ───────────────────────────────────────────────────────
  item('FILING_1099_W2_BASE', 'filings_1099_w2', '1099/W-2 filing — base', 'Presentación 1099/W-2 — base', 5000),
  item('FILING_1099_W2_PER_FORM', 'filings_1099_w2', '1099/W-2 filing — per form', 'Presentación 1099/W-2 — por formulario', 1000, { unit: 'per_form' }),

  // ── Entity services ──────────────────────────────────────────────────────────
  item('ENTITY_FORMATION_EIN', 'entity_services', 'Entity formation with EIN', 'Formación de entidad con EIN', 50000, {
    needsConfirmation: true,
    confirmationNote: '⚠ $500 current vs $250 on older sheet — Brian confirms.',
  }),
  item('ENTITY_501C3_1023', 'entity_services', '501(c)(3) application (Form 1023)', 'Solicitud 501(c)(3) (Formulario 1023)', 50000),
  item('ENTITY_ANNUAL_REPORT', 'entity_services', 'Annual report filing', 'Informe anual', 13000, {
    needsConfirmation: true,
    confirmationNote: '⚠ $130 current vs $60 on older sheet — Brian confirms.',
  }),
  item('ENTITY_AMENDMENT', 'entity_services', 'Entity amendment', 'Enmienda de entidad', 12000),
  item('ENTITY_DBA', 'entity_services', 'DBA registration', 'Registro de DBA', 12000),
  item('ENTITY_BOI', 'entity_services', 'BOI report', 'Informe BOI', 12000),

  // ── Attest (independence check enforced before engagement creation) ─────────
  item('ATTEST_REVIEW', 'attest', 'CPA financial statement review', 'Revisión de estados financieros (CPA)', 250000),
  item('ATTEST_AUDIT', 'attest', 'CPA financial statement audit', 'Auditoría de estados financieros (CPA)', 500000),
  item('ATTEST_WC_INS_AUDIT', 'attest', 'Workers comp / payroll insurance audit', 'Auditoría de seguro de compensación laboral / nómina', 25000),

  // ── Specialized CPA (⚠ $500 each vs $150/hr on service sheet) ────────────────
  ...[
    ['SPEC_CPA_CONFIRMATION_LETTERS', 'CPA letters of confirmation', 'Cartas de confirmación CPA'],
    ['SPEC_LOAN_DUE_DILIGENCE', 'Loan / funding due diligence', 'Diligencia debida para préstamos y financiamiento'],
    ['SPEC_TAX_PLANNING', 'Tax planning & analysis', 'Planificación y análisis fiscal'],
    ['SPEC_FORECASTING_BUDGETING', 'Forecasting / budgeting', 'Pronósticos y presupuestos'],
  ].map(([code, en, es]) =>
    item(code, 'specialized_cpa', en, es, 50000, {
      needsConfirmation: true,
      confirmationNote: '⚠ $500 each vs $150/hr per service sheet — Brian confirms canonical.',
      ...(code === 'SPEC_FORECASTING_BUDGETING'
        ? {
            descEn: 'Free with monthly accounting package (bundle rule FREE_FORECAST_WITH_MONTHLY).',
            descEs: 'Gratis con el paquete mensual de contabilidad.',
          }
        : {}),
    })
  ),

  // ── COO services ─────────────────────────────────────────────────────────────
  item('COO_UNIT', 'coo', 'COO services (ops / people / branding catalog)', 'Servicios COO (operaciones, personal, marca)', 15000, {
    unit: 'per_unit',
    descEn: 'Engagement styles: advisory retainer · fixed-scope project · fractional ops retainer.',
    descEs: 'Modalidades: asesoría recurrente · proyecto de alcance fijo · operaciones fraccionales.',
  }),

  // ── Deposits (true-up model: deposit reconciles against the final quote) ────
  item('DEPOSIT_1040', 'deposit', 'Discovery deposit — 1040', 'Depósito inicial — declaración 1040', 25000, {
    descEn: 'Collected at New Client Discovery booking (Lane 1); auto-credits or bills the difference at completion.',
    descEs: 'Se cobra al reservar la consulta inicial; al finalizar se acredita o se factura la diferencia.',
  }),
  item('DEPOSIT_BUSINESS_TAX', 'deposit', 'Discovery deposit — business tax', 'Depósito inicial — impuestos de negocio', 30000, {
    needsConfirmation: true,
    confirmationNote: '⚠ Observed $300 discovery deposit — confirm one standard discovery deposit vs a per-service deposit schedule.',
  }),
];

export const bundleRules = [
  {
    ruleCode: 'BUNDLE_QBO_PAYROLL_SETUP',
    ruleType: 'bundle_price',
    descriptionEn: 'QBO setup and payroll setup purchased together bill as one combined setup fee.',
    descriptionEs: 'La configuración de QBO y la de nómina contratadas juntas se cobran como una sola tarifa.',
    componentItemCodes: ['SETUP_QBO', 'SETUP_PAYROLL'],
    bundlePriceCents: 25000,
    conditionItemCode: null,
  },
  {
    ruleCode: 'FREE_ST1_WITH_MONTHLY',
    ruleType: 'free_with',
    descriptionEn: 'ST-1 sales tax filings are free with the monthly accounting package.',
    descriptionEs: 'Las presentaciones ST-1 son gratuitas con el paquete mensual de contabilidad.',
    componentItemCodes: ['SALES_TAX_ST1_FILING'],
    bundlePriceCents: null,
    conditionItemCode: 'ACCT_MONTHLY',
  },
  {
    ruleCode: 'FREE_FORECAST_WITH_MONTHLY',
    ruleType: 'free_with',
    descriptionEn: 'Forecasting and profit-margin analysis are free with the monthly accounting package.',
    descriptionEs: 'Los pronósticos y el análisis de márgenes son gratuitos con el paquete mensual de contabilidad.',
    componentItemCodes: ['SPEC_FORECASTING_BUDGETING'],
    bundlePriceCents: null,
    conditionItemCode: 'ACCT_MONTHLY',
  },
];

export async function seedPriceBook(client) {
  // Version 1: insert once; never mutated by re-seeds (admin edits create v2+).
  const { rows: vrows } = await client.query(
    `INSERT INTO price_book_versions (version_number, effective_from, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (version_number) DO UPDATE SET note = price_book_versions.note
     RETURNING id`,
    [PRICE_BOOK_V1.versionNumber, PRICE_BOOK_V1.effectiveFrom, PRICE_BOOK_V1.note]
  );
  const versionId = vrows[0].id;

  // Items upsert with DO UPDATE: v1 is defined as "the spec's seed values", so
  // re-running the seed re-aligns v1 with this file (typo fixes propagate).
  let sort = 0;
  for (const it of items) {
    sort += 10;
    await client.query(
      `INSERT INTO price_book_items (
         version_id, item_code, service_line, name_en, name_es,
         description_en, description_es, amount_cents, price_min_cents,
         price_max_cents, unit, is_pass_through, display_on_quote,
         needs_confirmation, confirmation_note, sort_order
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (version_id, item_code) DO UPDATE SET
         service_line = EXCLUDED.service_line,
         name_en = EXCLUDED.name_en,
         name_es = EXCLUDED.name_es,
         description_en = EXCLUDED.description_en,
         description_es = EXCLUDED.description_es,
         amount_cents = EXCLUDED.amount_cents,
         price_min_cents = EXCLUDED.price_min_cents,
         price_max_cents = EXCLUDED.price_max_cents,
         unit = EXCLUDED.unit,
         is_pass_through = EXCLUDED.is_pass_through,
         display_on_quote = EXCLUDED.display_on_quote,
         needs_confirmation = EXCLUDED.needs_confirmation,
         confirmation_note = EXCLUDED.confirmation_note,
         sort_order = EXCLUDED.sort_order`,
      [
        versionId, it.code, it.serviceLine, it.nameEn, it.nameEs,
        it.descEn, it.descEs, it.amountCents, it.minCents,
        it.maxCents, it.unit, it.passThrough, it.displayOnQuote,
        it.needsConfirmation, it.confirmationNote, sort,
      ]
    );
  }

  for (const r of bundleRules) {
    await client.query(
      `INSERT INTO bundle_rules (
         version_id, rule_code, rule_type, description_en, description_es,
         component_item_codes, bundle_price_cents, condition_item_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (version_id, rule_code) DO UPDATE SET
         rule_type = EXCLUDED.rule_type,
         description_en = EXCLUDED.description_en,
         description_es = EXCLUDED.description_es,
         component_item_codes = EXCLUDED.component_item_codes,
         bundle_price_cents = EXCLUDED.bundle_price_cents,
         condition_item_code = EXCLUDED.condition_item_code`,
      [
        versionId, r.ruleCode, r.ruleType, r.descriptionEn, r.descriptionEs,
        r.componentItemCodes, r.bundlePriceCents, r.conditionItemCode,
      ]
    );
  }

  const flagged = items.filter((i) => i.needsConfirmation).length;
  return `price book v1: ${items.length} items (${flagged} flagged needs_confirmation), ${bundleRules.length} bundle rules`;
}
