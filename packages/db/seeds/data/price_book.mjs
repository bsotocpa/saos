// Price book v1 — faithful transcription of MP v4.2 "PRICING SEED DATA".
// Source: 2025_new_process_buildoutpricing_v2.xlsx ("pricing packages" =
// canonical calculator), 2025 Business/Personal Service Sheet, 2026 session
// transcripts. Where sources conflict the spec's primary value is seeded and
// needsConfirmation carries the conflict for Brian to resolve BEFORE LAUNCH
// (launch gate, M23). All amounts in integer cents.
//
// This file and its sibling migration are the ONLY places prices may appear
// as literals (scripts/check-no-hardcoded-prices.mjs enforces).

/*
 * pricing_mode is DERIVED from the shape rather than annotated on 84 items by hand.
 * Hand-annotating would let a line say 'flat' while carrying a range — which is the
 * exact drift the CHECK constraint exists to prevent, reintroduced one file earlier.
 *
 * 'hourly' is never produced here. Brian's ruling 2026-08-14: the three per_hour lines
 * migrate as flat-with-a-per-hour-unit (behaviour preserved exactly) and go to his
 * confirmation queue. If he confirms them as hourly, the mode gets built then.
 */
const modeFor = (amountCents, minCents, maxCents) =>
  amountCents === null && minCents !== null && maxCents !== null ? 'range' : 'flat';

const item = (code, serviceLine, nameEn, nameEs, amountCents, opts = {}) => ({
  code,
  serviceLine,
  nameEn,
  nameEs,
  amountCents,
  unit: opts.unit ?? 'flat',
  minCents: opts.minCents ?? null,
  maxCents: opts.maxCents ?? null,
  isActive: opts.isActive ?? true,
  pricingMode: modeFor(amountCents, opts.minCents ?? null, opts.maxCents ?? null),
  structureNeedsConfirmation: opts.structureNeedsConfirmation ?? false,
  structureConfirmationNote: opts.structureConfirmationNote ?? null,
  // What this line asks for up front. NULL on almost every line — a deposit is a
  // work-start commitment, not a property of every service.
  depositCents: opts.depositCents ?? null,
  passThrough: opts.passThrough ?? false,
  displayOnQuote: opts.displayOnQuote ?? true,
  needsConfirmation: opts.needsConfirmation ?? false,
  confirmationNote: opts.confirmationNote ?? null,
  descEn: opts.descEn ?? null,
  descEs: opts.descEs ?? null,
  metadata: opts.metadata ?? {},
});

/**
 * Shared shape for derivation-only components (Brian's pricing ruling,
 * 2026-08-09). displayOnQuote:false is not decoration — the quote builder and
 * the invoice builder both REFUSE an item flagged this way, so a component
 * cannot reach a client-facing surface even if a staffer picks it by item code.
 */
const COMPONENT = {
  displayOnQuote: false,
  descEn:
    'Derivation component for the engagement configurator. Never quoted or invoiced on its own — ' +
    'clients see one bundled plan price.',
  descEs:
    'Componente de derivación para el configurador de compromisos. Nunca se cotiza ni se factura por ' +
    'separado — el cliente ve un solo precio de plan.',
};

export const PRICE_BOOK_V1 = {
  versionNumber: 1,
  effectiveFrom: '2026-07-05',
  note: 'v1 — seeded from MP v4.2 Pricing Seed Data (2025 pricing workbook + service sheet + 2026 transcripts). ⚠ conflicts carried as needs_confirmation.',
};

/*
 * DEPOSITS (v4, Brian 2026-08-14). A deposit used to be its own sellable price-book item
 * — DEPOSIT_1040 $250, DEPOSIT_BUSINESS_TAX $300 — picked one-per-quote. It is now an
 * attribute of the line that starts the work, and a quote's deposit is the SUM of its
 * lines' deposits.
 *
 * Placed on the lines that START AN ENGAGEMENT and nowhere else: the four individual
 * base returns and the entity returns. Add-ons (extra states, extra K-1s, notices) do
 * not each demand their own work-start commitment.
 *
 * Deliberately NOT on BIZ_SCH_C: a Schedule C is a schedule on someone's 1040, not a
 * separate entity return, so its deposit is the 1040's. Giving it one would ask a sole
 * proprietor for $250 + $300 where today they are asked for one deposit.
 *
 * EVERY line carrying a deposit is flagged. Brian's instruction was "flag any line where
 * deposit-vs-price is ambiguous rather than guessing" — these amounts preserve today's
 * behaviour for the common single-return quote, but WHICH lines carry a deposit is a
 * pricing decision, so all of them land in his confirmation queue with the 13.
 */
const DEPOSIT_1040_CENTS = 25000;
const DEPOSIT_BIZ_CENTS = 30000;
const DEPOSIT_NOTE_IND =
  '⚠ v4 deposit split: carried from the retired DEPOSIT_1040 item. Confirm this line should ask for a deposit, and the amount.';
const DEPOSIT_NOTE_BIZ =
  '⚠ v4 deposit split: carried from the retired DEPOSIT_BUSINESS_TAX item. Confirm this line should ask for a deposit, and the amount. A quote with two entity returns now asks for two deposits.';
/*
 * These use structureNeedsConfirmation, NOT needsConfirmation. The two mean different
 * things and gate different things: needs_confirmation says the PRICE is unsettled,
 * which makes any quote containing the line provisional. The $200 on an MFJ return is
 * not in doubt — what awaits Brian is whether that line should ask for a deposit. Using
 * the price flag for it marked every 1040 quote as unconfirmed, which the golden pricing
 * test caught immediately and correctly.
 */
const indDeposit = {
  depositCents: DEPOSIT_1040_CENTS,
  structureNeedsConfirmation: true,
  structureConfirmationNote: DEPOSIT_NOTE_IND,
};
const bizDeposit = {
  depositCents: DEPOSIT_BIZ_CENTS,
  structureNeedsConfirmation: true,
  structureConfirmationNote: DEPOSIT_NOTE_BIZ,
};

/*
 * The three lines already priced per hour. Brian's brief said "we don't bill hourly
 * today"; the book said otherwise, and he corrected himself on 2026-08-14 — these
 * rate-card lines are real.
 *
 * They migrate as pricing_mode 'flat' with unit 'per_hour', which is exactly how they
 * behave today ($75 or $150, per hour). Flagged so he rules on them in the same sitting:
 * if he confirms them as genuinely hourly, pricing_mode 'hourly' gets built then, against
 * these three lines. Until that ruling, nothing constructs the hourly mode.
 */
const hourlyConfirm = {
  structureNeedsConfirmation: true,
  structureConfirmationNote:
    '⚠ v4 mode: priced per hour. Confirm this is a rate card (a flat amount, quoted per hour) rather than tracked time-and-materials. Confirming it as true hourly is what triggers building pricing_mode = hourly.',
};

export const items = [
  // ── Individual tax — itemized calculator (one federal + one state included) ──
  item('IND_BASE_SINGLE', 'individual_tax', 'Individual return — Single', 'Declaración individual — Soltero(a)', 15000, {
    ...indDeposit,
    descEn: 'Base price; one federal + one state included.',
    descEs: 'Precio base; incluye una declaración federal y un estado.',
  }),
  item('IND_BASE_MFJ', 'individual_tax', 'Individual return — Married filing jointly', 'Declaración individual — Casados en conjunto', 20000, {
    ...indDeposit,
    descEn: 'Base price; one federal + one state included.',
    descEs: 'Precio base; incluye una declaración federal y un estado.',
  }),
  item('IND_BASE_MFS', 'individual_tax', 'Individual return — Married filing separately', 'Declaración individual — Casados por separado', 20000, indDeposit),
  item('IND_BASE_HOH', 'individual_tax', 'Individual return — Head of household', 'Declaración individual — Cabeza de familia', 20000, indDeposit),
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
  item('IND_SPECIALIZED_HOURLY', 'individual_tax', 'Specialized services (hourly)', 'Servicios especializados (por hora)', 15000, { unit: 'per_hour', ...hourlyConfirm }),

  // ── Business tax returns (one federal + one state included) ──────────────────
  item('BIZ_SCH_C', 'business_tax', 'Schedule C (sole prop or SMLLC)', 'Anexo C (propietario único o SMLLC)', 18000, {
    descEn: 'Same service as IND_SCH_C — listed in both spec sections; the calculator (M12) applies it once.',
    descEs: 'Mismo servicio que IND_SCH_C; la calculadora lo aplica una sola vez.',
  }),
  item('BIZ_1065', 'business_tax', 'Form 1065 — partnership', 'Formulario 1065 — sociedad', 60000, bizDeposit),
  item('BIZ_1120S', 'business_tax', 'Form 1120-S — S corporation', 'Formulario 1120-S — corporación S', 70000, bizDeposit),
  item('BIZ_1120', 'business_tax', 'Form 1120 — C corporation', 'Formulario 1120 — corporación C', 80000, bizDeposit),
  item('BIZ_990', 'business_tax', 'Form 990 / 990-EZ — exempt organization', 'Formulario 990 / 990-EZ — organización exenta', 80000, bizDeposit),
  item('BIZ_1120C', 'business_tax', 'Form 1120-C — housing co-op', 'Formulario 1120-C — cooperativa de vivienda', 80000, bizDeposit),
  item('BIZ_1120F', 'business_tax', 'Form 1120-F — foreign corporation', 'Formulario 1120-F — corporación extranjera', 80000, bizDeposit),
  item('BIZ_1120H', 'business_tax', 'Form 1120-H — homeowners association', 'Formulario 1120-H — asociación de propietarios', 80000, bizDeposit),
  item('BIZ_1120POL', 'business_tax', 'Form 1120-POL — political organization', 'Formulario 1120-POL — organización política', 80000, bizDeposit),
  item('BIZ_ADDL_STATE', 'business_tax', 'Additional state return (business)', 'Estado adicional (negocios)', 35000, { unit: 'per_state' }),
  item('BIZ_AMENDMENT', 'business_tax', 'Amended business return', 'Declaración enmendada (negocios)', 60000),
  item('BIZ_NOTICE_SUPPORT', 'business_tax', 'Notice support (business)', 'Apoyo con avisos (negocios)', 30000),

  // ── Recurring accounting (Full Management) ───────────────────────────────────
  //
  // BRIAN'S PRICING RULING, 2026-08-09. Two layers, deliberately:
  //
  //  1. BUNDLED PLANS (these four) are the CLIENT-FACING prices — one figure,
  //     matched cadences, quotable. "Monthly bookkeeping with monthly CPA
  //     session, $250/mo" is exactly how a client sees it.
  //  2. COMPONENTS (below) exist ONLY so the two-dial configurator can derive a
  //     price for cadence combinations that have no package — monthly books with
  //     quarterly sessions, say. They are displayOnQuote:false and the code
  //     REFUSES them on any quote or invoice line: presenting a broken-out
  //     session fee to a client is a defect, per the ruling.
  //
  // The two layers must agree to the cent — bundled = prep + (1 × session) at
  // matched cadence — and a test asserts it, so drift is a build failure rather
  // than a discrepancy a client notices.
  item('ACCT_WEEKLY', 'recurring_accounting', 'Accounting — weekly (full management, weekly CPA session)', 'Contabilidad semanal — gestión completa, sesión CPA semanal', 30000, { unit: 'per_week' }),
  item('ACCT_MONTHLY', 'recurring_accounting', 'Accounting — monthly (full management, monthly CPA session)', 'Contabilidad mensual — gestión completa, sesión CPA mensual', 25000, { unit: 'per_month' }),
  item('ACCT_QUARTERLY', 'recurring_accounting', 'Accounting — quarterly (full management, quarterly CPA session)', 'Contabilidad trimestral — gestión completa, sesión CPA trimestral', 60000, { unit: 'per_quarter' }),
  item('ACCT_SEMI_ANNUAL', 'recurring_accounting', 'Accounting — semi-annual (full management, semi-annual CPA session)', 'Contabilidad semestral — gestión completa, sesión CPA semestral', 100000, {
    unit: 'per_6_months',
    // CONFIRMED by Brian 2026-08-09: $1,000 all-in is the ruling; the
    // sheet/workbook conflict ($900 / $800) is resolved.
  }),
  item('ACCT_CATCHUP_HOURLY', 'recurring_accounting', 'Catch-up / cleanup (hourly)', 'Puesta al día / limpieza (por hora)', 7500, { unit: 'per_hour', ...hourlyConfirm }),

  // ── Derivation components — NEVER client-facing ──────────────────────────────
  // Prep component = bookkeeper labour for one close period.
  // Session component = one CPA session with Brian.
  item('ACCT_PREP_WEEKLY', 'recurring_accounting', 'Prep component — weekly close', 'Componente de preparación — cierre semanal', 20000, { unit: 'per_week', ...COMPONENT }),
  item('ACCT_PREP_MONTHLY', 'recurring_accounting', 'Prep component — monthly close', 'Componente de preparación — cierre mensual', 15000, { unit: 'per_month', ...COMPONENT }),
  item('ACCT_PREP_QUARTERLY', 'recurring_accounting', 'Prep component — quarterly close', 'Componente de preparación — cierre trimestral', 50000, { unit: 'per_quarter', ...COMPONENT }),
  item('ACCT_PREP_SEMI_ANNUAL', 'recurring_accounting', 'Prep component — semi-annual close', 'Componente de preparación — cierre semestral', 90000, { unit: 'per_6_months', ...COMPONENT }),
  item('CPA_SESSION', 'recurring_accounting', 'Session component — one CPA session', 'Componente de sesión — una sesión CPA', 10000, { unit: 'per_session', ...COMPONENT }),

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

  /*
   * ── Deposits — RETIRED 2026-08-14, never deleted ───────────────────────────
   *
   * These modelled a deposit as a service you could sell. They were briefly left active
   * and flagged, because retiring them broke Lane 1 — the New Client Discovery booking
   * flow invoiced them directly, with no quote and no lines to sum, and switching that
   * off was Brian's call rather than a side effect of a schema change.
   *
   * He made it: "retire the direct-deposit invoice path entirely ... deposits exist ONLY
   * on accepted quotes. Discovery and all bookings are free." Nothing invoices these now.
   * A deposit is deposit_cents on the service line that starts the work.
   *
   * INACTIVE, not deleted: two accepted quotes are price-locked against DEPOSIT_1040, so
   * dropping the row would rewrite what those clients were actually quoted. The legacy
   * branch of resolveDeposit deliberately does not filter on is_active for that reason.
   * Same rule as the superseded engagement letters.
   */
  item('DEPOSIT_1040', 'deposit', 'Discovery deposit — 1040 (retired)', 'Depósito inicial — declaración 1040 (retirado)', 25000, {
    isActive: false,
    descEn: 'RETIRED 2026-08-14. Bookings are free; a deposit exists only on an accepted quote, as deposit_cents on the service line that starts the work. Kept because accepted quotes are price-locked against this item.',
    descEs: 'RETIRADO el 2026-08-14. Las reservas no tienen costo; el depósito existe solo en una cotización aceptada.',
  }),
  item('DEPOSIT_BUSINESS_TAX', 'deposit', 'Discovery deposit — business tax (retired)', 'Depósito inicial — impuestos de negocio (retirado)', 30000, {
    isActive: false,
    descEn: 'RETIRED 2026-08-14 — see DEPOSIT_1040. Its amount now lives on the entity-return lines as deposit_cents.',
    descEs: 'RETIRADO el 2026-08-14 — ver DEPOSIT_1040.',
  }),

  // ── Tax resolution lane (v4.6) ──────────────────────────────────────────────
  // The prior-year surcharge is a PRICE-BOOK ITEM so the +$100 never appears
  // as a literal in code. It applies automatically to any return more than two
  // years back, bundled or not (CLAUDE.md).
  item('PRIOR_YEAR_SURCHARGE', 'individual_tax', 'Prior-year surcharge (returns 3+ years back)', 'Recargo por año anterior (declaraciones de 3+ años)', 10000, {
    unit: 'per_form',
    descEn: 'Applied automatically per return more than two tax years back — older years mean paper filing, transcript work, and reconstructed records.',
    descEs: 'Se aplica automáticamente por declaración de más de dos años atrás — los años antiguos requieren presentación en papel, transcripciones y reconstrucción de registros.',
  }),
  item('RES_PENALTY_ABATEMENT', 'specialized_cpa', 'Penalty abatement (first-time or reasonable cause)', 'Reducción de multas (primera vez o causa razonable)', 50000, {
    needsConfirmation: true,
    confirmationNote: '⚠ v4.6 seeds penalty abatement at the Specialized $500 rate — Brian confirms before launch.',
    descEn: 'Requires an active Form 2848 covering the year in question.',
    descEs: 'Requiere un Formulario 2848 vigente que cubra el año en cuestión.',
  }),
  item('RES_INSTALLMENT_AGREEMENT', 'specialized_cpa', 'Installment agreement setup', 'Configuración de plan de pagos', 50000, {
    needsConfirmation: true,
    confirmationNote: '⚠ v4.6 seeds installment-agreement setup at the Specialized $500 rate — Brian confirms before launch.',
    descEn: 'Requires an active Form 2848 covering the year in question.',
    descEs: 'Requiere un Formulario 2848 vigente que cubra el año en cuestión.',
  }),
  item('RES_BOOKS_RECONSTRUCTION', 'recurring_accounting', 'Books reconstruction (per year, hourly)', 'Reconstrucción de libros (por año, por hora)', 7500, {
    unit: 'per_hour',
    ...hourlyConfirm,
    descEn: 'Paired automatically with any resolution year whose books are partial or missing.',
    descEs: 'Se combina automáticamente con cualquier año de resolución cuyos libros estén incompletos o no existan.',
  }),

  // ── Late fee (v4.3 flow 4) ──────────────────────────────────────────────────
  // The RATE lives here, never in code (CLAUDE.md). Percent-per-month sits in
  // metadata because it is a rate, not a dollar amount; edit it through the
  // normal versioned price-book flow. amount_cents stays null — a fee amount is
  // always computed from the overdue balance.
  // amount_cents = 0 because a late fee has NO fixed price — the amount is
  // always computed from metadata.monthly_rate_percent × the overdue balance.
  // (The table requires a price or a range; 0 is the honest "not a fixed fee",
  // and display_on_quote = false keeps it off every quote.)
  item('LATE_FEE_MONTHLY', 'specialized_cpa', 'Late fee — monthly rate on past-due balances', 'Cargo por mora — tasa mensual sobre saldos vencidos', 0, {
    unit: 'per_month',
    displayOnQuote: false,
    metadata: { monthly_rate_percent: 1.5, grace_days: 30 },
    descEn: '1.5%/month (18% APR) on balances 30+ days past due. Applies ONLY to clients whose signed engagement letter carries the late-fee disclosure.',
    descEs: '1.5% mensual (18% anual) sobre saldos con 30+ días de atraso. Solo aplica a clientes cuya carta de compromiso firmada incluye la cláusula de cargo por mora.',
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
         needs_confirmation, confirmation_note, sort_order, metadata,
         pricing_mode, deposit_cents, is_active,
         structure_needs_confirmation, structure_confirmation_note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::price_pricing_mode,$19,$20,$21,$22)
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
         -- A CONFIRMATION IS A HUMAN DECISION AND THE SEED NEVER REVERSES IT.
         -- Plain assignment here meant every deploy re-flagged any price Brian
         -- had confirmed in Admin → Pricing: the ⚠ badge came back on a price he
         -- had already ruled on, with nothing to say it had happened.
         -- AND keeps both directions honest — the seed can still flag a NEW item,
         -- and can still resolve one (true AND false = false), but a row that is
         -- already confirmed (false) stays confirmed forever.
         needs_confirmation = price_book_items.needs_confirmation AND EXCLUDED.needs_confirmation,
         confirmation_note = CASE
           WHEN price_book_items.needs_confirmation AND EXCLUDED.needs_confirmation
             THEN EXCLUDED.confirmation_note
           ELSE NULL
         END,
         sort_order = EXCLUDED.sort_order,
         metadata = EXCLUDED.metadata,
         -- Both are plain assignments, unlike needs_confirmation. The seed owns v1, and
         -- the ONLY in-place mutation the admin API performs is confirming a flag —
         -- setting a price or a deposit creates a NEW version, which the seed never
         -- touches. So re-seeding cannot overwrite a decision Brian made.
         pricing_mode = EXCLUDED.pricing_mode,
         deposit_cents = EXCLUDED.deposit_cents,
         is_active = EXCLUDED.is_active,
         -- Same rule as needs_confirmation: a HUMAN decision is never reversed by a
         -- redeploy. AND keeps both directions honest — the seed can raise a new
         -- structure question, and can resolve one, but a line Brian already ruled
         -- on stays ruled on.
         structure_needs_confirmation =
           price_book_items.structure_needs_confirmation AND EXCLUDED.structure_needs_confirmation,
         structure_confirmation_note = CASE
           WHEN price_book_items.structure_needs_confirmation AND EXCLUDED.structure_needs_confirmation
             THEN EXCLUDED.structure_confirmation_note
           ELSE NULL
         END`,
      [
        versionId, it.code, it.serviceLine, it.nameEn, it.nameEs,
        it.descEn, it.descEs, it.amountCents, it.minCents,
        it.maxCents, it.unit, it.passThrough, it.displayOnQuote,
        it.needsConfirmation, it.confirmationNote, sort, JSON.stringify(it.metadata),
        it.pricingMode, it.depositCents, it.isActive,
        it.structureNeedsConfirmation, it.structureConfirmationNote,
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
