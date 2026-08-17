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

/**
 * Field QUESTION TEXT, in both languages — added when the public renderer was
 * built (M28). It lives here, as data, for the same reason every other
 * client-facing string does: Brian edits the wording in the definition without a
 * deploy. Keyed by field key and injected by withLabels() below, so adding a
 * field to a screen and forgetting its wording is visible rather than silent.
 *
 * Voice: these address a capable business owner, not someone being processed.
 * Questions are short, say why when the reason is not obvious, and never imply
 * that a blank answer is a failure.
 */
const LABELS = {
  language: ['Which language should we use with you?', '¿En qué idioma prefiere que le hablemos?'],
  first_name: ['First name', 'Nombre'],
  last_name: ['Last name', 'Apellido'],
  email: ['Email', 'Correo electrónico'],
  mobile_phone: ['Mobile number', 'Número de celular'],
  sms_ok: ['Can we text you?', '¿Podemos enviarle mensajes de texto?'],
  preferred_contact_method: ['Best way to reach you', 'Mejor forma de contactarlo(a)'],
  zip: ['ZIP code', 'Código postal'],

  // Soto — business
  owns_business: ['Do you own a business?', '¿Tiene un negocio?'],
  business_name: ['Business name', 'Nombre del negocio'],
  entity_type: ['How is it set up?', '¿Cómo está constituido?'],
  industry: ['What does the business do?', '¿A qué se dedica el negocio?'],
  years_in_business: ['How long have you been running it?', '¿Cuánto tiempo lleva operando?'],
  /*
   * #29 (Brian, 2026-08-16): the exact figure replaces the bucket — we do not ask twice.
   *
   * {{tax_year}} is resolved when the definition is SERVED, from currentTaxYear(), never
   * baked into the stored text. Brian's reason: "relative labels rot in January". A form
   * that says "last year" means 2025 in December and 2026 in January while the client's
   * situation has not changed at all, and a form with 2025 typed into it is simply wrong
   * the following season with nobody to notice.
   */
  gross_revenue: ['{{tax_year}} gross revenue', 'Ingresos brutos de {{tax_year}}'],
  employees_range: ['How many people work there, including you?', '¿Cuántas personas trabajan ahí, incluyéndolo(a) a usted?'],
  business_zip: ['Business ZIP code', 'Código postal del negocio'],
  other_businesses: [
    'Do you own or co-own any other businesses?',
    '¿Tiene o comparte otros negocios?',
  ],
  other_businesses_list: ['The other businesses', 'Los otros negocios'],

  // Soto — what you need
  services: ['What can we help with?', '¿Con qué le podemos ayudar?'],
  filed_last_year: ['Did you file last year?', '¿Presentó su declaración el año pasado?'],
  irs_letters: [
    'Have you received any letters from the IRS or the state?',
    '¿Ha recibido cartas del IRS o del estado?',
  ],
  notes: [
    'Anything else we should know before we talk?',
    '¿Algo más que debamos saber antes de hablar?',
  ],
  ssn_preference: [
    'How would you rather give us your SSN or ITIN?',
    '¿Cómo prefiere darnos su SSN o ITIN?',
  ],
  how_heard: ['How did you hear about us?', '¿Cómo supo de nosotros?'],
  referred_by: ['Who should we thank?', '¿A quién le agradecemos?'],
  /*
   * #28 (Brian, 2026-08-16): every "Other" gets a free-text companion — except
   * demo_race, which stays a closed list.
   *
   * "Other" with nowhere to write was a dead end in both directions: the client could not
   * say what they actually do, and `industry` drives NAICS AND the Form 5 module routing,
   * so picking it also silently dropped them out of industry-specific onboarding.
   *
   * demo_race is the exception because that screen is funder-reporting demographics,
   * aggregated only and deliberately never copied to the contact record. A free-text box
   * there invites someone to type a sentence about themselves into a field the system is
   * built never to read — and it would put free-text PII inside the grant export path.
   */
  industry_other: ['What does it do?', '¿A qué se dedica?'],
  how_heard_other: ['How did you find us?', '¿Cómo nos encontró?'],
  business_kind_other: ['What kind of business is it?', '¿Qué tipo de negocio es?'],

  // Hilo
  stage: ['Where are you with the business right now?', '¿En qué etapa está su negocio ahora?'],
  business_kind: ['What kind of business is it?', '¿Qué tipo de negocio es?'],
  help_domains: ['What do you want help with?', '¿En qué quiere ayuda?'],
  whats_going_on: ['Tell us what is going on', 'Cuéntenos qué está pasando'],
  demo_woman: ['Woman-owned?', '¿Propiedad de una mujer?'],
  demo_race: ['Race or ethnicity', 'Raza o etnia'],
  demo_veteran: ['Veteran-owned?', '¿Propiedad de un veterano?'],
  demo_disability: ['Owner with a disability?', '¿Dueño(a) con discapacidad?'],

  // Consents
  communication_consent: [
    'Soto Accounting may contact me about my request',
    'Soto Accounting puede contactarme sobre mi solicitud',
  ],
  esign_consent: [
    'I agree to sign documents electronically (ESIGN Act)',
    'Acepto firmar documentos electrónicamente (Ley ESIGN)',
  ],
};

/** Demographic questions are for funder reporting and are never required. */
const OPTIONAL_NOTE_EN = 'Optional — this is for our funder reporting and never affects what you get.';
const OPTIONAL_NOTE_ES = 'Opcional — es para nuestros reportes a financiadores y nunca afecta lo que recibe.';

/**
 * Inject question text into every field, and flag any field whose wording is
 * missing rather than shipping a raw key to a client.
 */
function withLabels(definition) {
  const missing = [];
  const screens = definition.screens.map((screen) => ({
    ...screen,
    fields: screen.fields.map((f) => {
      const label = LABELS[f.key];
      if (!label) missing.push(f.key);
      const extra = {};
      if (f.key.startsWith('demo_')) {
        extra.helpEn = f.helpEn ?? OPTIONAL_NOTE_EN;
        extra.helpEs = f.helpEs ?? OPTIONAL_NOTE_ES;
      }
      return {
        ...f,
        labelEn: label?.[0] ?? f.key,
        labelEs: label?.[1] ?? f.key,
        ...extra,
      };
    }),
  }));
  if (missing.length > 0) {
    // Loud, not silent: a field with no wording would render as a database key.
    console.warn(`  ⚠ form fields missing question text: ${missing.join(', ')}`);
  }
  return { ...definition, screens };
}

// TCPA / A2P 10DLC consent disclosure — shown WITH the sms_ok question. This
// exact language is what the privacy page and the A2P campaign registration
// reference; renderers must display it at the point of consent.
const SMS_DISCLOSURE_EN =
  'By selecting Yes, you agree to receive text messages from Soto Accounting LLC about your ' +
  'engagement — appointment reminders, document requests, and account updates — at the mobile ' +
  'number provided. Message frequency varies. Message & data rates may apply. Reply STOP to ' +
  'opt out, HELP for help. Consent is not a condition of service. See our Privacy Policy at ' +
  'sotoaccounting.com/privacy.';
const SMS_DISCLOSURE_ES =
  'Al seleccionar Sí, usted acepta recibir mensajes de texto de Soto Accounting LLC sobre su ' +
  'servicio — recordatorios de citas, solicitudes de documentos y actualizaciones de su cuenta — ' +
  'al número móvil proporcionado. La frecuencia de mensajes varía. Pueden aplicar tarifas de ' +
  'mensajes y datos. Responda STOP para cancelar o HELP para recibir ayuda. El consentimiento no ' +
  'es condición del servicio. Consulte nuestra Política de Privacidad en sotoaccounting.com/privacy.';

export const SOTO_INTAKE_DEFINITION = {
  slug: 'soto_intake',
  version: 5, // #38: Spanish that dropped what the English says
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
        // TCPA consent flag — the disclosure MUST render with the question.
        { key: 'sms_ok', type: 'yesno', required: true, helpEn: SMS_DISCLOSURE_EN, helpEs: SMS_DISCLOSURE_ES },
        {
          key: 'preferred_contact_method', type: 'select', required: true,
          options: [opt('text', 'Text', 'Texto'), opt('email', 'Email', 'Correo electrónico'), opt('phone', 'Phone', 'Teléfono'), opt('portal', 'Portal', 'Portal')],
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
            opt('professional_services', 'Professional Services — consulting, legal, design, marketing', 'Servicios profesionales — consultoría, legal, diseño, marketing', { naics: '541611' }),
            opt('real_estate_property', 'Real Estate & Property Management', 'Bienes raíces y administración', { naics: '531210' }),
            opt('transportation_logistics', 'Transportation & Logistics', 'Transporte y logística', { naics: '484110' }),
            opt('fitness_wellness', 'Fitness & Wellness', 'Fitness y bienestar', { naics: '713940' }),
            opt('arts_events', 'Arts, Events & Entertainment', 'Arte, eventos y entretenimiento', { naics: '711510' }),
            opt('cleaning_home', 'Cleaning & Home Services', 'Limpieza y servicios del hogar', { naics: '561720' }),
            opt('nonprofit', 'Nonprofit', 'Sin fines de lucro', { naics: '813319' }),
            opt('other', 'Other', 'Otro'),
          ],
        },
        /*
         * #28: required only when they actually chose "Other". Picking the option that
         * means "my answer is not on your list" and then leaving the box empty tells us
         * nothing, which is the dead end this exists to close — and it can only ever be
         * asked of someone who reached for it deliberately.
         */
        {
          key: 'industry_other', type: 'text',
          required: { field: 'industry', equals: 'other' },
          showWhen: { field: 'industry', equals: 'other' },
        },
        {
          key: 'years_in_business', type: 'select', required: { field: 'owns_business', equals: 'yes' },
          showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          options: [opt('<1', '<1', '<1'), opt('1-3', '1–3', '1–3'), opt('3-5', '3–5', '3–5'), opt('5+', '5+', '5+')],
        },
        // OPTIONAL by ruling: "a client who doesn't know the number shouldn't be blocked
        // from finishing setup; we'll get truth from their books." It also means an
        // in-flight submission started on v2 still validates against v3, since nothing
        // newly required appeared on a screen the client already passed.
        {
          key: 'gross_revenue', type: 'number', required: false,
          showWhen: { field: 'owns_business', in: ['yes', 'starting'] },
          helpEn: 'Roughly is fine — leave it blank if you are not sure.',
          helpEs: 'Un aproximado está bien — déjelo en blanco si no está seguro(a).',
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
            opt('entity', 'Entity formation or conversion (LLC, PLLC, S-Corp election)', 'Formación o conversión de entidad (LLC, PLLC, elección S-Corp)'),
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
        {
          key: 'how_heard_other', type: 'text',
          required: { field: 'how_heard', equals: 'other' },
          showWhen: { field: 'how_heard', equals: 'other' },
        },
        { key: 'communication_consent', type: 'checkbox', required: true },
        { key: 'esign_consent', type: 'checkbox', required: true },
      ],
    },
  ],
};

export const HILO_INTAKE_DEFINITION = {
  slug: 'hilo_intake',
  version: 3, // #28: free-text companion for business_kind 'Other'
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
        { key: 'sms_ok', type: 'yesno', required: true, helpEn: SMS_DISCLOSURE_EN, helpEs: SMS_DISCLOSURE_ES },
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
        // #28. Note what is NOT here: demo_race on screen 3 keeps its closed list, so no
        // free-text about a person ever enters the funder-reporting path.
        {
          key: 'business_kind_other', type: 'text',
          required: { field: 'business_kind', equals: 'other' },
          showWhen: { field: 'business_kind', equals: 'other' },
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

/*
 * An answer option, WITH the bilingual labels the renderer needs.
 *
 * These modules shipped as structure only — options were bare value strings like
 * 'qbo' and 'fba' — because nothing rendered them, exactly the state the intake
 * definitions were in before M28. A client cannot be shown "qb_desktop", and half
 * the firm's clients read Spanish, so the questionnaire could not be built until
 * every option carried both labels.
 *
 * VALUES ARE FROZEN. The flag rules match on them (module_h H3 === 'fba' raises
 * multistate nexus; C4/G4/I6 drive worker-classification), so a value is a
 * behaviour identifier and only the labels are new.
 */
const mopt = (value, labelEn, labelEs) => ({ value, labelEn, labelEs });

/*
 * #37 — a companion for every module "Other", and the questionnaire renderer honours
 * `showWhen` so it only appears when they reach for it.
 *
 * Same rule as #28 on the intake: an option meaning "my answer is not on your list", with
 * nowhere to write the answer, is a dead end in both directions. In the modules it is
 * worse than cosmetic — A1/A2 name the software we have to work with, F4 feeds multistate
 * nexus, and C3 feeds the fiscal year end that every extended deadline derives from.
 *
 * `showWhen` speaks the modules' own vocabulary (`question`, not `field`) because that is
 * what the flag rules already use — `{ question: 'C4', numberGte: 3 }`.
 */
const otherText = (parentId, type, labelEn, labelEs) => ({
  id: `${parentId}_other`,
  labelEn, labelEs,
  type: 'text',
  showWhen: type === 'multiselect'
    ? { question: parentId, includesAny: ['other'] }
    : { question: parentId, equals: 'other' },
});

/*
 * C3 is the exception, and deliberately NOT free text.
 *
 * "Another month" is the answer to a question whose output drives deadline computation —
 * CLAUDE.md: extended deadlines derive from return type + fiscal year end. Free text
 * ("end of June", "6/30", "June-ish") cannot drive a calculation, and a month is a closed
 * set of twelve. Asking for the month itself is both easier for the client and usable by
 * the system, where a text box would only look like an answer.
 */
const MONTHS = [
  ['january', 'January', 'enero'], ['february', 'February', 'febrero'], ['march', 'March', 'marzo'],
  ['april', 'April', 'abril'], ['may', 'May', 'mayo'], ['june', 'June', 'junio'],
  ['july', 'July', 'julio'], ['august', 'August', 'agosto'], ['september', 'September', 'septiembre'],
  ['october', 'October', 'octubre'], ['november', 'November', 'noviembre'], ['december', 'December', 'diciembre'],
];

const YES_NO_UNSURE = [
  mopt('yes', 'Yes', 'Sí'),
  mopt('no', 'No', 'No'),
  mopt('not_sure', 'Not sure', 'No estoy seguro(a)'),
];

export const ONBOARDING_MODULES = [
  {
    key: 'module_a', nameEn: 'Tech stack', nameEs: 'Herramientas',
    trigger: { services_any: ['bookkeeping', 'payroll', 'sales_tax', 'cfo_advisory'] },
    sort: 10,
    questions: [
      q('A1', 'Bookkeeping software', 'Software contable', 'select', [
        mopt('qbo', 'QuickBooks Online', 'QuickBooks Online'),
        mopt('qb_desktop', 'QuickBooks Desktop', 'QuickBooks Desktop'),
        mopt('xero', 'Xero', 'Xero'),
        mopt('wave', 'Wave', 'Wave'),
        mopt('spreadsheets', 'Spreadsheets', 'Hojas de cálculo'),
        mopt('none', 'Nothing yet', 'Nada todavía'),
        mopt('other', 'Something else', 'Otro'),
      ]),
      otherText('A1', 'select', 'Which one?', '¿Cuál?'),
      q('A2', 'Payroll system', 'Sistema de nómina', 'select', [
        mopt('gusto', 'Gusto', 'Gusto'),
        mopt('qb_payroll', 'QuickBooks Payroll', 'QuickBooks Payroll'),
        mopt('adp', 'ADP', 'ADP'),
        mopt('paychex', 'Paychex', 'Paychex'),
        mopt('manual', 'We run it by hand', 'La hacemos a mano'),
        mopt('no_employees', 'No employees', 'Sin empleados'),
        mopt('other', 'Something else', 'Otro'),
      ]),
      otherText('A2', 'select', 'Which one?', '¿Cuál?'),
      q('A3', 'POS system(s)', 'Sistema(s) de punto de venta', 'multiselect', [
        mopt('square', 'Square', 'Square'),
        mopt('toast', 'Toast', 'Toast'),
        mopt('clover', 'Clover', 'Clover'),
        mopt('shopify_pos', 'Shopify POS', 'Shopify POS'),
        mopt('lightspeed', 'Lightspeed', 'Lightspeed'),
        mopt('none', 'No POS', 'Sin punto de venta'),
        mopt('other', 'Something else', 'Otro'),
      ]),
      otherText('A3', 'multiselect', 'Which one?', '¿Cuál?'),
      q('A4', 'Payment processors', 'Procesadores de pago', 'multiselect', [
        mopt('stripe', 'Stripe', 'Stripe'),
        mopt('square', 'Square', 'Square'),
        mopt('paypal', 'PayPal', 'PayPal'),
        mopt('venmo', 'Venmo', 'Venmo'),
        mopt('zelle', 'Zelle', 'Zelle'),
        mopt('cash_only', 'Cash only', 'Solo efectivo'),
        mopt('other', 'Something else', 'Otro'),
      ]),
      otherText('A4', 'multiselect', 'Which one?', '¿Cuál?'),
      q('A5', 'Online sales channels', 'Canales de venta en línea', 'multiselect', [
        mopt('own_site', 'Our own website', 'Nuestro propio sitio web'),
        mopt('etsy', 'Etsy', 'Etsy'),
        mopt('amazon', 'Amazon', 'Amazon'),
        mopt('none', 'We do not sell online', 'No vendemos en línea'),
        mopt('other', 'Something else', 'Otro'),
      ]),
      otherText('A5', 'multiselect', 'Where else do you sell?', '¿Dónde más vende?'),
      q('A6', 'Business bank accounts (count + banks)', 'Cuentas bancarias del negocio (cuántas y en qué bancos)', 'text'),
      q('A7', 'Business credit cards (count + issuers)', 'Tarjetas de crédito del negocio (cuántas y de qué banco)', 'text'),
      q('A8', 'Ever pay business expenses from personal accounts (or vice versa)?', '¿Paga gastos del negocio desde cuentas personales (o al revés)?', 'select', [
        mopt('often', 'Often', 'Con frecuencia'),
        mopt('sometimes', 'Sometimes', 'A veces'),
        mopt('never', 'Never', 'Nunca'),
      ]),
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
      q('B1', 'Third-party delivery apps', 'Apps de entrega', 'multiselect', [
        mopt('doordash', 'DoorDash', 'DoorDash'),
        mopt('ubereats', 'Uber Eats', 'Uber Eats'),
        mopt('grubhub', 'Grubhub', 'Grubhub'),
        mopt('chownow', 'ChowNow', 'ChowNow'),
        mopt('direct', 'We deliver ourselves', 'Entregamos nosotros mismos'),
        mopt('none', 'We do not deliver', 'No hacemos entregas'),
        mopt('other', 'Something else', 'Otra'),
      ]),
      otherText('B1', 'multiselect', 'Which app?', '¿Cuál app?'),
      q('B2', 'Roughly what % of sales are cash?', '¿Qué porcentaje de las ventas es en efectivo?', 'select', [
        mopt('<10', 'Under 10%', 'Menos del 10 %'),
        mopt('10-25', '10–25%', '10–25 %'),
        mopt('25-50', '25–50%', '25–50 %'),
        mopt('50+', 'Over 50%', 'Más del 50 %'),
      ]),
      q('B3', 'How are tips handled?', '¿Cómo se manejan las propinas?', 'select', [
        mopt('pos_payroll', 'Through the POS and payroll', 'Por el punto de venta y la nómina'),
        mopt('cash', 'Cash, kept by staff', 'En efectivo, se las queda el personal'),
        mopt('both', 'Both', 'Ambas'),
        mopt('none', 'We do not take tips', 'No aceptamos propinas'),
      ]),
      q('B4', 'Sell at markets, pop-ups, or events?', '¿Vende en mercados, pop-ups o eventos?', 'yesno'),
    ],
    flags: [],
  },
  {
    key: 'module_c', nameEn: 'Bookkeeping scoping', nameEs: 'Alcance contable',
    trigger: { services_any: ['bookkeeping'] },
    sort: 30,
    questions: [
      q('C1', 'When were your books last reconciled?', '¿Cuándo se conciliaron sus libros por última vez?', 'select', [
        mopt('last_month', 'Within the last month', 'En el último mes'),
        mopt('2-6mo', 'Two to six months ago', 'Hace dos a seis meses'),
        mopt('6-12mo', 'Six to twelve months ago', 'Hace seis a doce meses'),
        mopt('over_year', 'More than a year ago', 'Hace más de un año'),
        mopt('never', 'Never', 'Nunca'),
      ]),
      q('C2', 'Accounting method', 'Método contable', 'select', [
        mopt('cash', 'Cash basis', 'Base de efectivo'),
        mopt('accrual', 'Accrual basis', 'Base devengada'),
        mopt('not_sure', 'Not sure', 'No estoy seguro(a)'),
      ]),
      q('C3', 'Fiscal year end', 'Cierre del año fiscal', 'select', [
        mopt('december', 'December 31', '31 de diciembre'),
        mopt('other', 'Another month', 'Otro mes'),
      ]),
      {
        id: 'C3_other',
        labelEn: 'Which month does your fiscal year end?',
        labelEs: '¿En qué mes termina su año fiscal?',
        type: 'select',
        options: MONTHS.map(([v, en, es]) => mopt(v, en, es)),
        showWhen: { question: 'C3', equals: 'other' },
      },
      q('C4', 'Do you pay 1099 contractors? (rough count)', '¿Paga contratistas 1099? (aproximadamente cuántos)', 'text'),
      q('C5', 'Rough monthly transaction volume', 'Volumen mensual aproximado de transacciones', 'select', [
        mopt('<50', 'Under 50', 'Menos de 50'),
        mopt('50-200', '50–200', '50–200'),
        mopt('200-500', '200–500', '200–500'),
        mopt('500+', 'Over 500', 'Más de 500'),
      ]),
    ],
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'C4', numberGte: 3 }, routeToRole: 'ceo' }],
  },
  {
    key: 'module_d', nameEn: 'Sales tax', nameEs: 'Impuesto sobre ventas',
    trigger: { services_any: ['sales_tax'] },
    sort: 40,
    questions: [
      q('D1', 'States/jurisdictions where you sell', 'Estados o jurisdicciones donde vende', 'text'),
      q('D2', 'Currently registered to collect?', '¿Está registrado para cobrarlo?', 'select', YES_NO_UNSURE),
      q('D3', 'Current filing frequency', 'Frecuencia de presentación actual', 'select', [
        mopt('monthly', 'Monthly', 'Mensual'),
        mopt('quarterly', 'Quarterly', 'Trimestral'),
        mopt('annual', 'Annually', 'Anual'),
        mopt('not_sure', 'Not sure', 'No estoy seguro(a)'),
      ]),
      q('D4', 'Any past-due sales tax filings?', '¿Tiene presentaciones vencidas?', 'select', YES_NO_UNSURE),
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
      q('E3', 'Pay frequency', 'Frecuencia de pago', 'select', [
        mopt('weekly', 'Weekly', 'Semanal'),
        mopt('biweekly', 'Every two weeks', 'Cada dos semanas'),
        mopt('semimonthly', 'Twice a month', 'Dos veces al mes'),
        mopt('monthly', 'Monthly', 'Mensual'),
      ]),
      q('E4', 'States where employees work', 'Estados donde trabajan sus empleados', 'text'),
      q('E5', 'Current provider — switching or keeping?', 'Proveedor actual — ¿lo cambia o lo mantiene?', 'text'),
    ],
    flags: [],
  },
  {
    key: 'module_f', nameEn: 'Tax onboarding', nameEs: 'Datos para impuestos',
    trigger: { services_any: ['tax_personal', 'tax_business'] },
    sort: 60,
    questions: [
      q('F1', 'Who prepared last year’s return?', '¿Quién preparó su declaración del año pasado?', 'select', [
        mopt('self', 'I did', 'Yo mismo(a)'),
        mopt('other_preparer', 'Another preparer', 'Otro preparador'),
        mopt('soto', 'Soto Accounting', 'Soto Accounting'),
        mopt('didnt_file', 'I did not file', 'No presenté'),
      ]),
      q('F2', 'Filing status', 'Estado civil tributario', 'select', [
        mopt('single', 'Single', 'Soltero(a)'),
        mopt('mfj', 'Married filing jointly', 'Casado(a) declarando en conjunto'),
        mopt('mfs', 'Married filing separately', 'Casado(a) declarando por separado'),
        mopt('hoh', 'Head of household', 'Jefe(a) de familia'),
      ]),
      q('F3', 'Dependents (count)', 'Dependientes (cuántos)', 'number'),
      q('F4', 'States you lived/earned in during the tax year', 'Estados donde vivió o generó ingresos durante el año', 'multiselect', [
        mopt('il', 'Illinois', 'Illinois'),
        mopt('in', 'Indiana', 'Indiana'),
        mopt('wi', 'Wisconsin', 'Wisconsin'),
        mopt('other', 'Another state', 'Otro estado'),
      ]),
      otherText('F4', 'multiselect', 'Which other states?', '¿Qué otros estados?'),
      q('F5', 'Estimated payments this year?', '¿Hizo pagos estimados este año?', 'select', YES_NO_UNSURE),
      q('F6', 'Major life/business changes this year?', '¿Cambios importantes este año, personales o del negocio?', 'multiselect', [
        mopt('property_bought_sold', 'Bought or sold property', 'Compré o vendí una propiedad'),
        mopt('new_business', 'Started a business', 'Empecé un negocio'),
        mopt('closed_business', 'Closed a business', 'Cerré un negocio'),
        mopt('marriage_divorce', 'Marriage or divorce', 'Matrimonio o divorcio'),
        mopt('new_dependent', 'A new dependent', 'Un nuevo dependiente'),
        mopt('crypto', 'Bought or sold crypto', 'Compré o vendí criptomonedas'),
        mopt('other', 'Something else', 'Otro'),
        mopt('none', 'None of these', 'Ninguno de estos'),
      ]),
      otherText('F6', 'multiselect', 'What changed?', '¿Qué cambió?'),
    ],
    flags: [],
  },
  {
    key: 'module_g', nameEn: 'Trades & contractors', nameEs: 'Oficios y contratistas',
    trigger: { industry: 'construction_trades', any_service_module: true },
    sort: 70,
    questions: [
      q('G1', 'Trade', 'Oficio', 'select', [
        mopt('general', 'General contracting', 'Contratista general'),
        mopt('electrical', 'Electrical', 'Electricidad'),
        mopt('plumbing', 'Plumbing', 'Plomería'),
        mopt('hvac', 'HVAC', 'Climatización (HVAC)'),
        mopt('landscaping', 'Landscaping', 'Jardinería'),
        mopt('painting', 'Painting', 'Pintura'),
        mopt('remodeling', 'Remodeling', 'Remodelación'),
        mopt('other', 'Another trade', 'Otro oficio'),
      ]),
      otherText('G1', 'select', 'Which trade?', '¿Qué oficio?'),
      q('G2', 'Track costs by job/project?', '¿Controla los costos por trabajo o proyecto?', 'select', [
        mopt('software', 'Yes, in software', 'Sí, con software'),
        mopt('paper', 'Yes, on paper', 'Sí, en papel'),
        mopt('no', 'Not currently', 'Por ahora no'),
      ]),
      q('G3', 'How do you bill?', '¿Cómo factura?', 'multiselect', [
        mopt('fixed_bid', 'Fixed bid', 'Precio fijo'),
        mopt('time_materials', 'Time and materials', 'Tiempo y materiales'),
        mopt('progress', 'Progress billing', 'Facturación por avance'),
        mopt('deposits', 'Deposit up front', 'Depósito por adelantado'),
      ]),
      q('G4', 'Subcontractors (1099)? (count)', '¿Subcontratistas 1099? (cuántos)', 'text'),
      q('G5', 'Vehicles/equipment owned? (count)', '¿Vehículos o equipo propios? (cuántos)', 'text'),
      q('G6', 'Licensed/bonded jurisdictions', 'Jurisdicciones donde tiene licencia o fianza', 'text'),
    ],
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'G4', numberGte: 3 }, routeToRole: 'ceo' }],
  },
  {
    key: 'module_h', nameEn: 'E-commerce', nameEs: 'Comercio electrónico',
    trigger: { industry: 'retail_ecommerce' },
    sort: 80,
    questions: [
      q('H1', 'Selling platforms', 'Plataformas de venta', 'multiselect', [
        mopt('shopify', 'Shopify', 'Shopify'),
        mopt('amazon', 'Amazon', 'Amazon'),
        mopt('etsy', 'Etsy', 'Etsy'),
        mopt('ebay', 'eBay', 'eBay'),
        mopt('tiktok', 'TikTok Shop', 'TikTok Shop'),
        mopt('walmart', 'Walmart Marketplace', 'Walmart Marketplace'),
        mopt('own_site', 'Our own website', 'Nuestro propio sitio web'),
        mopt('other', 'Somewhere else', 'Otra'),
      ]),
      otherText('H1', 'multiselect', 'Where else do you sell?', '¿Dónde más vende?'),
      q('H2', 'Hold physical inventory?', '¿Maneja inventario físico?', 'yesno'),
      q('H3', 'Fulfillment', 'Envíos', 'select', [
        mopt('self', 'We ship it ourselves', 'Enviamos nosotros mismos'),
        mopt('3pl', 'A third-party warehouse', 'Un almacén externo (3PL)'),
        mopt('fba', 'Fulfilled by Amazon (FBA)', 'Logística de Amazon (FBA)'),
        mopt('mix', 'A mix', 'Una combinación'),
      ]),
      q('H4', 'States with inventory or significant sales', 'Estados con inventario o ventas significativas', 'text'),
      q('H5', 'Returns/refunds volume', 'Volumen de devoluciones y reembolsos', 'select', [
        mopt('low', 'Low', 'Bajo'),
        mopt('moderate', 'Moderate', 'Moderado'),
        mopt('high', 'High', 'Alto'),
      ]),
    ],
    flags: [{ flagKey: 'multistate_nexus', when: { question: 'H3', equals: 'fba' }, routeToRole: 'comms_billing' }],
  },
  {
    key: 'module_i', nameEn: 'Healthcare & private practice', nameEs: 'Salud y práctica privada',
    trigger: { industry: 'healthcare_therapy' },
    sort: 90,
    questions: [
      q('I1', 'License type', 'Tipo de licencia', 'select', [
        mopt('lcpc', 'LCPC — licensed clinical professional counselor', 'LCPC — consejero(a) clínico(a) profesional licenciado(a)'),
        mopt('lcsw', 'LCSW — licensed clinical social worker', 'LCSW — trabajador(a) social clínico(a) licenciado(a)'),
        mopt('lmft', 'LMFT — marriage and family therapist', 'LMFT — terapeuta matrimonial y familiar'),
        mopt('psychologist', 'Psychologist', 'Psicólogo(a)'),
        mopt('psychiatrist_md', 'Psychiatrist (MD)', 'Psiquiatra (MD)'),
        mopt('chiropractor', 'Chiropractor', 'Quiropráctico(a)'),
        mopt('pt_ot', 'Physical or occupational therapist', 'Fisioterapeuta o terapeuta ocupacional'),
        mopt('other_licensed', 'Another licensed profession', 'Otra profesión con licencia'),
        mopt('not_licensed', 'Not a licensed profession', 'No es una profesión con licencia'),
      ]),
      q('I2', 'Current entity structure', 'Estructura actual de la entidad', 'select', [
        mopt('sole_prop', 'Sole proprietor', 'Propietario(a) único(a)'),
        mopt('llc', 'LLC', 'LLC'),
        mopt('pllc', 'PLLC', 'PLLC'),
        mopt('s_corp', 'S-Corp', 'Corporación S'),
        mopt('not_formed', 'Not formed yet', 'Aún no está constituida'),
        mopt('not_sure', 'Not sure', 'No estoy seguro(a)'),
      ]),
      q('I3', 'Payment mix', 'Mezcla de pagos', 'select', [
        mopt('mostly_insurance', 'Mostly insurance', 'Mayormente seguros'),
        mopt('mostly_private', 'Mostly private pay', 'Mayormente pago privado'),
        mopt('even_mix', 'About even', 'Más o menos parejo'),
      ]),
      q('I4', 'Practice management / EHR', 'Sistema de gestión de la práctica / EHR', 'select', [
        mopt('simplepractice', 'SimplePractice', 'SimplePractice'),
        mopt('therapynotes', 'TherapyNotes', 'TherapyNotes'),
        mopt('jane', 'Jane', 'Jane'),
        mopt('headway', 'Headway', 'Headway'),
        mopt('alma', 'Alma', 'Alma'),
        mopt('grow', 'Grow Therapy', 'Grow Therapy'),
        mopt('other', 'Something else', 'Otro'),
        mopt('none', 'None', 'Ninguno'),
      ]),
      otherText('I4', 'select', 'Which system?', '¿Qué sistema?'),
      q('I5', 'Telehealth clients in other states?', '¿Atiende clientes de telesalud en otros estados?', 'yesno'),
      q('I6', 'Solo or group practice?', '¿Práctica individual o grupal?', 'select', [
        mopt('solo', 'Solo practice', 'Práctica individual'),
        mopt('group_w2', 'Group, W-2 clinicians', 'Grupal, con clínicos W-2'),
        mopt('group_1099', 'Group, 1099 clinicians', 'Grupal, con clínicos 1099'),
        mopt('mix', 'A mix', 'Una combinación'),
      ]),
    ],
    // ⚑ The PLLC auto-flag rule (I1 licensed + I2 llc/sole_prop + IL) is
    // enforced in the processor — it creates the pllc_conversions record.
    flags: [{ flagKey: 'worker_classification_risk', when: { question: 'I6', equals: 'group_1099' }, routeToRole: 'ceo' }],
  },
];

// Starter resource-library entries (admin replaces/extends via M20; content
// publishing pipeline is Phase 5). Insert-if-missing by title.
const STARTER_RESOURCES = [
  {
    titleEn: 'How your client portal works', titleEs: 'Cómo funciona su portal de cliente',
    descEn: 'Uploading documents, signing, paying invoices, and getting answers — all in one place.',
    descEs: 'Subir documentos, firmar, pagar facturas y obtener respuestas — todo en un solo lugar.',
    type: 'guide',
  },
  {
    titleEn: 'Schedule C: what we need from you', titleEs: 'Anexo C: qué necesitamos de usted',
    descEn: 'The records that make your self-employment return smooth — income, expenses, mileage, home office.',
    descEs: 'Los registros que agilizan su declaración — ingresos, gastos, millaje, oficina en casa.',
    type: 'guide',
  },
  {
    titleEn: 'IRS notices: don’t panic, do this', titleEs: 'Avisos del IRS: no entre en pánico, haga esto',
    descEn: 'Most notices are routine. Upload it to your portal and we take it from there.',
    descEs: 'La mayoría de los avisos son de rutina. Súbalo a su portal y nosotros nos encargamos.',
    type: 'guide',
  },
];

export async function seedForms(client) {
  let inserted = 0;
  for (const def of [SOTO_INTAKE_DEFINITION, HILO_INTAKE_DEFINITION]) {
    /*
     * VERSIONS, and why this is a new one rather than an edit.
     *
     * v1 shipped structure only, with no field labels, because nothing rendered it.
     * v2 (M28) added the bilingual question text the public renderer needs.
     * v3 (#29, 2026-08-16) replaces `revenue_range` with `gross_revenue` — a question
     *    left the form and another arrived, which is a different form, not a correction
     *    to this one. Submissions stamp the version they were filled under, so v2 stays
     *    exactly as it was for everyone who already answered it.
     *
     * loadDefinition() takes the highest ACTIVE version, so a new row supersedes the old
     * without touching it, and any admin edit to a published version survives re-seeding
     * — the same insert-only promise every seed here makes.
     */
    const labelled = withLabels(def);
    const res = await client.query(
      `INSERT INTO form_definitions (key, version, title_en, title_es, definition)
       VALUES ($1, $5, $2, $3, $4::jsonb)
       ON CONFLICT (key, version) DO NOTHING`,
      [def.slug, def.slug === 'soto_intake' ? 'New Client Intake' : 'Hilo Entrepreneur Intake',
       def.slug === 'soto_intake' ? 'Registro de nuevo cliente' : 'Registro de emprendedor Hilo',
       JSON.stringify(labelled), def.version]
    );
    inserted += res.rowCount;
  }
  let modules = 0;
  let labelled = 0;
  let added = 0;
  let optionsAdded = 0;
  for (const m of ONBOARDING_MODULES) {
    const res = await client.query(
      `INSERT INTO onboarding_modules (key, name_en, name_es, trigger, questions, flags, sort_order)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (key) DO NOTHING`,
      [m.key, m.nameEn, m.nameEs, JSON.stringify(m.trigger), JSON.stringify(m.questions), JSON.stringify(m.flags), m.sort]
    );
    modules += res.rowCount;

    /*
     * ONE-TIME OPTION LABELLING (2026-08-15), and it can only ever run once per row.
     *
     * These modules shipped with bare option values — 'qbo', 'fba' — because nothing
     * rendered them, the same state the intake definitions were in before M28. The
     * questionnaire cannot be shown to a client until every option carries EN and ES
     * labels, so existing rows need upgrading, not just fresh databases.
     *
     * The guard is the point. It rewrites a row ONLY while that row still has a bare
     * string option, which means:
     *   · a row Brian has since edited in Admin is already labelled, so it is skipped
     *   · a second deploy finds nothing bare and reports 0
     * That keeps the seed's insert-only promise where it matters — it never overwrites
     * content someone chose — while still repairing rows that were never finished.
     *
     * Values are unchanged, so the flag rules that match on them still match.
     */
    if (res.rowCount === 0) {
      const cur = await client.query(`SELECT questions FROM onboarding_modules WHERE key = $1`, [m.key]);
      const stored = cur.rows[0]?.questions ?? [];
      const hasBareOption = stored.some((sq) => (sq.options ?? []).some((o) => typeof o === 'string'));
      if (hasBareOption) {
        await client.query(`UPDATE onboarding_modules SET questions = $2::jsonb WHERE key = $1`, [
          m.key,
          JSON.stringify(m.questions),
        ]);
        labelled += 1;
      } else {
        /*
         * ADDITIVE UPGRADE (#37): questions present in code and absent from the row get
         * appended, matched on id. Nothing is rewritten and nothing is removed, so a
         * module Brian has reworded in Admin keeps his wording and still gains the
         * companion. This is how the "Other" free-text boxes reach the modules that were
         * seeded before they existed.
         *
         * Position matters — a companion belongs beside its parent, not at the end — so
         * each new question is inserted after the question it depends on when it has a
         * showWhen, and appended otherwise.
         */
        /*
         * MISSING OPTIONS TOO, not just missing questions (#46).
         *
         * The first version of this upgrade was question-granular: it added questions by
         * id and never touched an existing one. So when #37 added an "other" OPTION to
         * F6 and a companion question beside it, the companion arrived and the option did
         * not — a conditional question whose trigger could never occur. The deploy
         * reported "12 module question(s) added", which was true and hid it completely.
         *
         * Still additive: options are matched by value and inserted at the position they
         * occupy in the source, so a label Brian reworded in Admin is untouched and the
         * new option lands where it belongs rather than after "None of these".
         */
        for (const [qi, storedQ] of stored.entries()) {
          const source = m.questions.find((q) => q.id === storedQ.id);
          if (!source?.options || !storedQ.options) continue;
          const haveValues = new Set(storedQ.options.map((o) => o.value));
          const missingOpts = source.options.filter((o) => !haveValues.has(o.value));
          if (missingOpts.length === 0) continue;
          const merged = [...storedQ.options];
          for (const o of missingOpts) {
            const at = source.options.findIndex((x) => x.value === o.value);
            merged.splice(Math.min(at, merged.length), 0, o);
          }
          stored[qi] = { ...storedQ, options: merged };
          optionsAdded += missingOpts.length;
        }

        const have = new Set(stored.map((q) => q.id));
        const missing = m.questions.filter((q) => !have.has(q.id));
        if (optionsAdded > 0 && missing.length === 0) {
          await client.query(`UPDATE onboarding_modules SET questions = $2::jsonb WHERE key = $1`, [
            m.key,
            JSON.stringify(stored),
          ]);
        }
        if (missing.length > 0) {
          const next = [...stored];
          for (const q of missing) {
            const parentId = q.showWhen?.question;
            const at = parentId ? next.findIndex((x) => x.id === parentId) : -1;
            if (at >= 0) next.splice(at + 1, 0, q);
            else next.push(q);
          }
          await client.query(`UPDATE onboarding_modules SET questions = $2::jsonb WHERE key = $1`, [
            m.key,
            JSON.stringify(next),
          ]);
          added += missing.length;
        }
      }
    }
  }
  let resources = 0;
  for (const [i, r] of STARTER_RESOURCES.entries()) {
    const res = await client.query(
      `INSERT INTO resource_library (title_en, title_es, description_en, description_es, audience, resource_type, is_published, sort_order)
       SELECT $1, $2, $3, $4, 'soto', $5, true, $6
       WHERE NOT EXISTS (SELECT 1 FROM resource_library WHERE title_en = $1)`,
      [r.titleEn, r.titleEs, r.descEn, r.descEs, r.type, i * 10]
    );
    resources += res.rowCount;
  }
  /*
   * VERIFY THE DEPLOYED DATA, not just what we meant to deploy (#46).
   *
   * The build-time check (scripts/check-form-conditionals.mjs) reads the SOURCE and would
   * not have caught #46: the source was right and the database was stale. A conditional
   * question whose trigger value is missing from its parent renders as nothing, forever,
   * without erroring — so the only place that can catch the gap between what we wrote and
   * what is live is here, after seeding, against the rows themselves.
   *
   * It THROWS rather than warns. A silent form is exactly the failure mode that got past
   * a code review, a test suite, a deploy and a human walkthrough; a warning in a log
   * nobody reads would have got past this too.
   */
  const live = await client.query(`SELECT key, questions FROM onboarding_modules WHERE is_active`);
  const broken = [];
  for (const row of live.rows) {
    const byId = new Map(row.questions.map((q) => [q.id, q]));
    for (const q of row.questions) {
      const c = q.showWhen;
      if (!c) continue;
      const parent = byId.get(c.question);
      if (!parent) { broken.push(`${row.key}/${q.id}: no question "${c.question}"`); continue; }
      if (!parent.options) continue;
      const available = new Set(parent.options.map((o) => (typeof o === 'string' ? o : o.value)));
      const wanted = c.includesAny ?? (c.equals !== undefined ? [c.equals] : []);
      for (const v of wanted) {
        if (!available.has(v)) {
          broken.push(`${row.key}/${q.id}: waits for ${c.question} = "${v}", which it does not offer`);
        }
      }
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `Conditional questions in the DATABASE can never fire — they render as nothing, silently:\n  ` +
      broken.join('\n  ')
    );
  }

  return (
    `${inserted} of 2 form definitions, ${modules} of ${ONBOARDING_MODULES.length} onboarding modules, ` +
    `${resources} starter resources inserted` +
    (labelled > 0 ? `; ${labelled} module(s) upgraded to bilingual option labels` : '') +
    (added > 0 ? `; ${added} module question(s) added` : '') +
    (optionsAdded > 0 ? `; ${optionsAdded} option(s) added` : '') +
    `; ${live.rows.length} module conditionals verified`
  );
}
