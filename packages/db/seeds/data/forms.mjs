// Forms as data (OF Build Notes: "All selects admin-editable — Brian adds
// industries/services without code"). Form definitions + the Form 5 service-
// onboarding modules (OF Modules A–I). Seeds insert-if-missing: admin edits
// are never clobbered.
//
// Field schema (consumed by the validator in apps/api forms service):
//   { key, type: text|email|phone|zip|select|multiselect|yesno|checkbox|
//     longtext|repeat|number, required: true|{field,equals}|{field,includesAny},
//     showWhen?: {field, equals|in|includesAny}, options?: [{value, labelEn,
//     labelEs, naics?, fires?}] }

const opt = (value, labelEn, labelEs, extra = {}) => ({ value, labelEn, labelEs, ...extra });

export const SOTO_INTAKE_DEFINITION = {
  slug: 'soto_intake',
  maxMinutes: 3,
  screens: [
    {
      id: 1,
      titleEn: 'Language + Contact', titleEs: 'Idioma y contacto',
      fields: [
        { key: 'language', type: 'select', required: true, options: [opt('en', 'English', 'English'), opt('es', 'Español', 'Español')] },
        { key: 'first_name', type: 'text', required: true },
        { key: 'last_name', type: 'text', required: true },
        { key: 'email', type: 'email', required: true },
        { key: 'mobile_phone', type: 'phone', required: true },
        { key: 'sms_ok', type: 'yesno', required: true }, // TCPA consent flag
        {
          key: 'preferred_contact_method', type: 'select', required: true,
          options: [opt('text', 'Text', 'Texto'), opt('email', 'Email', 'Correo'), opt('phone', 'Phone', 'Teléfono'), opt('portal', 'Portal', 'Portal')],
        },
      ],
    },
    {
      id: 2,
      titleEn: 'About Your Business', titleEs: 'Sobre su negocio',
      fields: [
        {
          key: 'owns_business', type: 'select', required: true,
          options: [opt('yes', 'Yes', 'Sí'), opt('no', 'No', 'No'), opt('starting', 'Starting one', 'Estoy empezando uno')],
        },
        { key: 'business_name', type: 'text', required: { field: 'owns_business', equals: 'yes' }, showWhen: { field: 'owns_business', in: ['yes', 'starting'] } },
        {
          key: 'entity_type', type: 'select', required: { field: 'owns_business', equals: 'yes' },
          showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [
            opt('sole_prop', 'Sole Prop', 'Propietario único'), opt('llc', 'LLC', 'LLC'), opt('s_corp', 'S-Corp', 'Corporación S'),
            opt('c_corp', 'C-Corp', 'Corporación C'), opt('partnership', 'Partnership', 'Sociedad'),
            opt('nonprofit', 'Nonprofit', 'Sin fines de lucro'), opt('not_sure', 'Not sure', 'No estoy seguro(a)'),
          ],
        },
        {
          key: 'industry', type: 'select', required: { field: 'owns_business', equals: 'yes' },
          showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [
            opt('food_beverage', 'Food & Beverage — restaurant, catering, food truck, vendor', 'Comida y bebida — restaurante, catering, food truck', { naics: '722511', fires: 'module_b' }),
            opt('healthcare_therapy', 'Healthcare, Therapy & Counseling', 'Salud, terapia y consejería', { naics: '621330', fires: 'module_i' }),
            opt('construction_trades', 'Construction & Trades', 'Construcción y oficios', { naics: '236118', fires: 'module_g' }),
            opt('retail_ecommerce', 'Retail & E-commerce', 'Comercio y ventas en línea', { naics: '455219', fires: 'module_h' }),
            opt('beauty_personal_care', 'Beauty & Personal Care — salon, barber, spa', 'Belleza y cuidado personal', { naics: '812112' }),
            opt('professional_services', 'Professional Services — consulting, legal, design, marketing', 'Servicios profesionales', { naics: '541611' }),
            opt('real_estate_property', 'Real Estate & Property Management', 'Bienes raíces y administración', { naics: '531210' }),
            opt('transportation_logistics', 'Transportation & Logistics', 'Transporte y logística', { naics: '484110' }),
            opt('fitness_wellness', 'Fitness & Wellness', 'Fitness y bienestar', { naics: '713940' }),
            opt('arts_events', 'Arts, Events & Entertainment', 'Arte, eventos y entretenimiento', { naics: '711510' }),
            opt('cleaning_home', 'Cleaning & Home Services', 'Limpieza y servicios del hogar', { naics: '561720' }),
            opt('nonprofit', 'Nonprofit', 'Sin fines de lucro', { naics: '813319' }),
            opt('other', 'Other', 'Otro'),
          ],
        },
        {
          key: 'years_in_business', type: 'select', required: { field: 'owns_business', equals: 'yes' },
          showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [opt('<1', '<1', '<1'), opt('1-3', '1–3', '1–3'), opt('3-5', '3–5', '3–5'), opt('5+', '5+', '5+')],
        },
        {
          key: 'revenue_range', type: 'select', required: false, showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [opt('<50k', '<$50K', '<$50K'), opt('50-150k', '$50–150K', '$50–150K'), opt('150-500k', '$150–500K', '$150–500K'), opt('500k-1m', '$500K–1M', '$500K–1M'), opt('1m+', '$1M+', '$1M+'), opt('na', 'Prefer not to say', 'Prefiero no decir')],
        },
        {
          key: 'employees_range', type: 'select', required: false, showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [opt('just_me', 'Just me', 'Solo yo'), opt('1-5', '1–5', '1–5'), opt('6-20', '6–20', '6–20'), opt('20+', '20+', '20+')],
        },
        { key: 'business_zip', type: 'zip', required: { field: 'owns_business', equals: 'yes' }, showWhen: { field: 'owns_business', in: ['yes', 'starting'] } },
        // v4.2 addendum #2 — entity groups.
        { key: 'other_businesses', type: 'yesno', required: false, showWhen: { field: 'owns_business', in: ['yes', 'starting'] } },
        { key: 'other_businesses_list', type: 'repeat', required: false, showWhen: { field: 'other_businesses', equals: 'yes' }, itemFields: ['name', 'role'] },
      ],
    },
    {
      id: 3,
      titleEn: 'What You Need', titleEs: 'Qué necesita',
      fields: [
        {
          key: 'services', type: 'multiselect', required: true,
          options: [
            opt('tax_personal', 'Tax prep – personal', 'Impuestos – personales'),
            opt('tax_business', 'Tax prep – business', 'Impuestos – de negocio'),
            opt('bookkeeping', 'Bookkeeping', 'Contabilidad'),
            opt('payroll', 'Payroll', 'Nómina'),
            opt('sales_tax', 'Sales tax', 'Impuesto sobre ventas'),
            opt('irs_notice', 'IRS notice or letter', 'Aviso o carta del IRS'),
            opt('entity', 'Entity formation or conversion (LLC, PLLC, S-Corp election)', 'Formación o conversión de entidad'),
            opt('cfo_advisory', 'CFO–advisory', 'CFO–asesoría'),
            opt('not_sure', 'Not sure yet', 'Aún no sé'),
          ],
        },
        {
          key: 'filed_last_year', type: 'select', required: { field: 'services', includesAny: ['tax_personal', 'tax_business'] },
          showWhen: { field: 'services', includesAny: ['tax_personal', 'tax_business'] },
          options: [opt('yes', 'Yes', 'Sí'), opt('no', 'No', 'No'), opt('extension', 'Filed an extension', 'Presenté una extensión')],
        },
        { key: 'irs_letters', type: 'yesno', required: true },
        { key: 'notes', type: 'longtext', required: false },
        // v4.2 addendum #4 — SSN escape hatch (never over email/SMS).
        {
          key: 'ssn_preference', type: 'select', required: false,
          showWhen: { field: 'services', includesAny: ['tax_personal'] },
          options: [opt('portal', 'Enter securely in the portal', 'Ingresar en el portal seguro'), opt('phone', 'I’ll provide it by phone', 'Lo doy por teléfono'), opt('on_file', 'Already on file', 'Ya lo tienen')],
        },
      ],
    },
    {
      id: 4,
      titleEn: 'How You Found Us + Consents', titleEs: 'Cómo nos encontró y consentimientos',
      fields: [
        {
          key: 'how_heard', type: 'select', required: true,
          options: [
            opt('referral', 'Referral from a person', 'Referencia de una persona'),
            opt('hilo', 'Hilo NFP', 'Hilo NFP'),
            opt('google', 'Google', 'Google'),
            opt('social', 'Social media', 'Redes sociales'),
            opt('cpa', 'Another CPA', 'Otro CPA'),
            opt('other', 'Other', 'Otro'),
          ],
        },
        { key: 'referred_by', type: 'text', required: false, showWhen: { field: 'how_heard', equals: 'referral' } },
        { key: 'communication_consent', type: 'checkbox', required: true },
        { key: 'esign_consent', type: 'checkbox', required: true },
      ],
    },
  ],
};

export const HILO_INTAKE_DEFINITION = {
  slug: 'hilo_intake',
  maxMinutes: 1.5,
  screens: [
    {
      id: 1,
      titleEn: 'Language + You', titleEs: 'Idioma y usted',
      fields: [
        { key: 'language', type: 'select', required: true, options: [opt('en', 'English', 'English'), opt('es', 'Español', 'Español')] },
        { key: 'first_name', type: 'text', required: true },
        { key: 'last_name', type: 'text', required: true },
        { key: 'email', type: 'email', required: true },
        { key: 'mobile_phone', type: 'phone', required: true },
        { key: 'sms_ok', type: 'yesno', required: true },
        { key: 'zip', type: 'zip', required: true }, // funder metric
      ],
    },
    {
      id: 2,
      titleEn: 'Your Business (or the one you’re dreaming about)', titleEs: 'Su negocio (o el que sueña con tener)',
      fields: [
        {
          key: 'stage', type: 'select', required: true,
          options: [
            opt('idea', 'Just an idea', 'Solo una idea'),
            opt('starting', 'Getting started (<1 yr)', 'Empezando (<1 año)'),
            opt('running', 'Up and running (1–3 yrs)', 'En marcha (1–3 años)'),
            opt('growing', 'Growing (3+ yrs)', 'Creciendo (3+ años)'),
          ],
        },
        { key: 'business_name', type: 'text', required: false },
        {
          key: 'business_kind', type: 'select', required: true,
          options: [opt('food', 'Food & beverage', 'Comida y bebida'), opt('retail', 'Retail', 'Comercio'), opt('services', 'Services', 'Servicios'), opt('other', 'Other', 'Otro')],
        },
        {
          key: 'help_domains', type: 'multiselect', required: true,
          options: [
            opt('money', 'Money stuff — taxes, bookkeeping, pricing', 'Dinero — impuestos, contabilidad, precios'),
            opt('legal', 'Legal stuff — licenses, permits, structure', 'Legal — licencias, permisos, estructura'),
            opt('operations', 'Running the business — operations, hiring, systems', 'Operar el negocio — operaciones, contratación'),
            opt('marketing', 'Getting the word out — branding, marketing', 'Darse a conocer — marca, marketing'),
            opt('not_sure', 'I’m not sure — help me figure it out', 'No sé — ayúdenme a decidir'),
          ],
        },
        { key: 'whats_going_on', type: 'longtext', required: false },
      ],
    },
    {
      id: 3,
      titleEn: 'Optional — these help us report our community impact', titleEs: 'Opcional — nos ayudan a reportar nuestro impacto',
      // Aggregated for funder reporting ONLY — never copied to the contact
      // record, never shown on day-to-day views (enforced in the processor).
      fields: [
        { key: 'demo_woman', type: 'select', required: false, options: [opt('yes', 'Yes', 'Sí'), opt('no', 'No', 'No'), opt('na', 'Prefer not to say', 'Prefiero no decir')] },
        { key: 'demo_race', type: 'multiselect', required: false, options: [opt('black', 'Black or African American', 'Negra o afroamericana'), opt('latino', 'Hispanic or Latino', 'Hispana o latina'), opt('white', 'White', 'Blanca'), opt('asian', 'Asian', 'Asiática'), opt('native', 'Native American', 'Indígena americana'), opt('pacific', 'Pacific Islander', 'Isleña del Pacífico'), opt('other', 'Other', 'Otra'), opt('na', 'Prefer not to say', 'Prefiero no decir')] },
        { key: 'demo_veteran', type: 'select', required: false, options: [opt('yes', 'Yes', 'Sí'), opt('no', 'No', 'No'), opt('na', 'Prefer not to say', 'Prefiero no decir')] },
        { key: 'demo_disability', type: 'select', required: false, options: [opt('yes', 'Yes', 'Sí'), opt('no', 'No', 'No'), opt('na', 'Prefer not to say', 'Prefiero no decir')] },
      ],
    },
    {
      id: 4,
      titleEn: 'Book It', titleEs: 'Reserve su sesión',
      fields: [{ key: 'communication_consent', type: 'checkbox', required: true }],
    },
  ],
};

// ── Form 5 service-onboarding modules (OF Modules A–I) ───────────────────────
// Stored as DATA so the Phase-2 no-code Module Builder edits rows, not code.
// Triggers evaluated by the assembly logic; B fires on industry ALONE (v4.1
// fix), G needs industry + any service module, I feeds the PLLC auto-flag.

const q = (id, labelEn, labelEs, type, options = null, extra = {}) => ({
  id, labelEn, labelEs, type, ...(options ? { options } : {}), ...extra,
});

export const ONBOARDING_MODULES = [
  {
    key: 'module_a', nameEn: 'Tech stack', nameEs: 'Herramientas',
    trigger: { services_any: ['bookkeeping', 'payroll', 'sales_tax', 'cfo_advisory'] },
    sort: 10,
    questions: [
      q('A1', 'Bookkeeping software', 'Software contable', 'select', ['qbo', 'qb_desktop', 'xero', 'wave', 'spreadsheets', 'none', 'other']),
      q('A2', 'Payroll system', 'Sistema de nómina', 'select', ['gusto', 'qb_payroll', 'adp', 'paychex', 'manual', 'no_employees', 'other']),
      q('A3', 'POS system(s)', 'Sistema(s) de punto de venta', 'multiselect', ['square', 'toast', 'clover', 'shopify_pos', 'lightspeed', 'none', 'other']),
      q('A4', 'Payment processors', 'Procesadores de pago', 'multiselect', ['stripe', 'square', 'paypal', 'venmo', 'zelle', 'cash_only', 'other']),
      q('A5', 'Online sales channels', 'Canales de venta en línea', 'multiselect', ['own_site', 'etsy', 'amazon', 'none', 'other']),
      q('A6', 'Business bank accounts (count + banks)', 'Cuentas bancarias del negocio', 'text'),
      q('A7', 'Business credit cards (count + issuers)', 'Tarjetas de crédito del negocio', 'text'),
      q('A8', 'Ever pay business expenses from personal accounts (or vice versa)?', '¿Paga gastos del negocio desde cuentas personales (o al revés)?', 'select', ['often', 'sometimes', 'never']),
    ],
    flags: [],
  },
  {
    key: 'module_b', nameEn: 'Food & Beverage', nameEs: 'Comida y bebida',
    // v4.1 FIX: fires on industry ALONE so tax-only restaurant clients still
    // get delivery-app / cash % / tips scoping.
    trigger: { industry: 'food_beverage' },
    sort: 20,
    questions: [
      q('B1', 'Third-party delivery apps', 'Apps de entrega', 'multiselect', ['doordash', 'ubereats', 'grubhub', 'chownow', 'direct', 'none', 'other']),
      q('B2', 'Roughly what % of sales are cash?', '¿Qué % de ventas es en efectivo?', 'select', ['<10', '10-25', '25-50', '50+']),
      q('B3', 'How are tips handled?', '¿Cómo se manejan las propinas?', 'select', ['pos_payroll', 'cash', 'both', 'none']),
      q('B4', 'Sell at markets, pop-ups, or events?', '¿Vende en mercados, pop-ups o eventos?', 'yesno'),
    ],
    flags: [],
  },
  {
    key: 'module_c', nameEn: 'Bookkeeping scoping', nameEs: 'Alcance contable',
    trigger: { services_any: ['bookkeeping'] },
    sort: 30,
    questions: [
      q('C1', 'When were your books last reconciled?', '¿Cuándo se conciliaron sus libros por última vez?', 'select', ['last_month', '2-6mo', '6-12mo', 'over_year', 'never']),
      q('C2', 'Accounting method', 'Método contable', 'select', ['cash', 'accrual', 'not_sure']),
      q('C3', 'Fiscal year end', 'Cierre del año fiscal', 'select', ['december', 'other']),
      q('C4', 'Do you pay 1099 contractors? (rough count)', '¿Paga contratistas 1099? (cuántos)', 'text'),
      q('C5', 'Rough monthly transaction volume', 'Volumen mensual de transacciones', 'select', ['<50', '50-200', '200-500', '500+']),
    ],
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'C4', numberGte: 3 }, routeToRole: 'ceo' }],
  },
  {
    key: 'module_d', nameEn: 'Sales tax', nameEs: 'Impuesto sobre ventas',
    trigger: { services_any: ['sales_tax'] },
    sort: 40,
    questions: [
      q('D1', 'States/jurisdictions where you sell', 'Estados donde vende', 'text'),
      q('D2', 'Currently registered to collect?', '¿Registrado para cobrar?', 'select', ['yes', 'no', 'not_sure']),
      q('D3', 'Current filing frequency', 'Frecuencia de presentación', 'select', ['monthly', 'quarterly', 'annual', 'not_sure']),
      q('D4', 'Any past-due sales tax filings?', '¿Presentaciones vencidas?', 'select', ['yes', 'no', 'not_sure']),
    ],
    flags: [],
  },
  {
    key: 'module_e', nameEn: 'Payroll', nameEs: 'Nómina',
    trigger: { services_any: ['payroll'] },
    sort: 50,
    questions: [
      q('E1', 'W-2 employees (count)', 'Empleados W-2 (cuántos)', 'number'),
      q('E2', '1099 contractors (count)', 'Contratistas 1099 (cuántos)', 'number'),
      q('E3', 'Pay frequency', 'Frecuencia de pago', 'select', ['weekly', 'biweekly', 'semimonthly', 'monthly']),
      q('E4', 'States where employees work', 'Estados donde trabajan', 'text'),
      q('E5', 'Current provider — switching or keeping?', 'Proveedor actual — ¿cambia o se queda?', 'text'),
    ],
    flags: [],
  },
  {
    key: 'module_f', nameEn: 'Tax onboarding', nameEs: 'Datos para impuestos',
    trigger: { services_any: ['tax_personal', 'tax_business'] },
    sort: 60,
    questions: [
      q('F1', 'Who prepared last year’s return?', '¿Quién preparó su declaración pasada?', 'select', ['self', 'other_preparer', 'soto', 'didnt_file']),
      q('F2', 'Filing status', 'Estado civil tributario', 'select', ['single', 'mfj', 'mfs', 'hoh']),
      q('F3', 'Dependents (count)', 'Dependientes (cuántos)', 'number'),
      q('F4', 'States you lived/earned in during the tax year', 'Estados donde vivió/ganó en el año', 'multiselect', ['il', 'in', 'wi', 'other']),
      q('F5', 'Estimated payments this year?', '¿Pagos estimados este año?', 'select', ['yes', 'no', 'not_sure']),
      q('F6', 'Major life/business changes this year?', '¿Cambios importantes este año?', 'multiselect', ['property_bought_sold', 'new_business', 'closed_business', 'marriage_divorce', 'new_dependent', 'crypto', 'none']),
    ],
    flags: [],
  },
  {
    key: 'module_g', nameEn: 'Trades & contractors', nameEs: 'Oficios y contratistas',
    trigger: { industry: 'construction_trades', any_service_module: true },
    sort: 70,
    questions: [
      q('G1', 'Trade', 'Oficio', 'select', ['general', 'electrical', 'plumbing', 'hvac', 'landscaping', 'painting', 'remodeling', 'other']),
      q('G2', 'Track costs by job/project?', '¿Controla costos por proyecto?', 'select', ['software', 'paper', 'no']),
      q('G3', 'How do you bill?', '¿Cómo factura?', 'multiselect', ['fixed_bid', 'time_materials', 'progress', 'deposits']),
      q('G4', 'Subcontractors (1099)? (count)', '¿Subcontratistas 1099? (cuántos)', 'text'),
      q('G5', 'Vehicles/equipment owned? (count)', '¿Vehículos/equipo propios? (cuántos)', 'text'),
      q('G6', 'Licensed/bonded jurisdictions', 'Jurisdicciones con licencia/fianza', 'text'),
    ],
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'G4', numberGte: 3 }, routeToRole: 'ceo' }],
  },
  {
    key: 'module_h', nameEn: 'E-commerce', nameEs: 'Comercio electrónico',
    trigger: { industry: 'retail_ecommerce' },
    sort: 80,
    questions: [
      q('H1', 'Selling platforms', 'Plataformas de venta', 'multiselect', ['shopify', 'amazon', 'etsy', 'ebay', 'tiktok', 'walmart', 'own_site', 'other']),
      q('H2', 'Hold physical inventory?', '¿Maneja inventario físico?', 'yesno'),
      q('H3', 'Fulfillment', 'Envíos', 'select', ['self', '3pl', 'fba', 'mix']),
      q('H4', 'States with inventory or significant sales', 'Estados con inventario o ventas significativas', 'text'),
      q('H5', 'Returns/refunds volume', 'Volumen de devoluciones', 'select', ['low', 'moderate', 'high']),
    ],
    flags: [{ flagKey: 'multistate_nexus', when: { question: 'H3', equals: 'fba' }, routeToRole: 'comms_billing' }],
  },
  {
    key: 'module_i', nameEn: 'Healthcare & private practice', nameEs: 'Salud y práctica privada',
    trigger: { industry: 'healthcare_therapy' },
    sort: 90,
    questions: [
      q('I1', 'License type', 'Tipo de licencia', 'select', ['lcpc', 'lcsw', 'lmft', 'psychologist', 'psychiatrist_md', 'chiropractor', 'pt_ot', 'other_licensed', 'not_licensed']),
      q('I2', 'Current entity structure', 'Estructura actual', 'select', ['sole_prop', 'llc', 'pllc', 's_corp', 'not_formed', 'not_sure']),
      q('I3', 'Payment mix', 'Mezcla de pagos', 'select', ['mostly_insurance', 'mostly_private', 'even_mix']),
      q('I4', 'Practice management / EHR', 'Sistema de gestión / EHR', 'select', ['simplepractice', 'therapynotes', 'jane', 'headway', 'alma', 'grow', 'other', 'none']),
      q('I5', 'Telehealth clients in other states?', '¿Clientes de telesalud en otros estados?', 'yesno'),
      q('I6', 'Solo or group practice?', '¿Práctica individual o grupal?', 'select', ['solo', 'group_w2', 'group_1099', 'mix']),
    ],
    // ⚑ The PLLC auto-flag rule (I1 licensed + I2 llc/sole_prop + IL) is
    // enforced in the processor — it creates the pllc_conversions record.
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'I6', equals: 'group_1099' }, routeToRole: 'ceo' }],
  },
];

export async function seedForms(client) {
  let inserted = 0;
  for (const def of [SOTO_INTAKE_DEFINITION, HILO_INTAKE_DEFINITION]) {
    const res = await client.query(
      `INSERT INTO form_definitions (key, version, title_en, title_es, definition)
       VALUES ($1, 1, $2, $3, $4::jsonb)
       ON CONFLICT (key, version) DO NOTHING`,
      [def.slug, def.slug === 'soto_intake' ? 'New Client Intake' : 'Hilo Entrepreneur Intake',
       def.slug === 'soto_intake' ? 'Registro de nuevo cliente' : 'Registro de emprendedor Hilo',
       JSON.stringify(def)]
    );
    inserted += res.rowCount;
  }
  let modules = 0;
  for (const m of ONBOARDING_MODULES) {
    const res = await client.query(
      `INSERT INTO onboarding_modules (key, name_en, name_es, trigger, questions, flags, sort_order)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (key) DO NOTHING`,
      [m.key, m.nameEn, m.nameEs, JSON.stringify(m.trigger), JSON.stringify(m.questions), JSON.stringify(m.flags), m.sort]
    );
    modules += res.rowCount;
  }
  return `${inserted} of 2 form definitions, ${modules} of ${ONBOARDING_MODULES.length} onboarding modules inserted`;
}
