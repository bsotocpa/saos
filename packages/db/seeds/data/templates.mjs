// Placeholder document templates — MP §7216 / E-Signature Module.
//
// APPROVED BUILD APPROACH (MP v4.1 changelog #6): ship clearly-marked
// placeholder text for the §7216 consents and all engagement letter templates.
// Brian supplies final legal language via the admin template editor before
// client-facing launch. While is_placeholder = true, the send path BLOCKS
// these from reaching any production client (gate enforced in code, M11).
//
// Seed never overwrites an existing template — admin edits win over re-seeds.
// Spanish copy is a translation pass Brian/Jackson approve (OF Build Notes).

const PLACEHOLDER_BANNER_EN =
  '⚠ PLACEHOLDER TEMPLATE — NOT FOR CLIENT USE.\n' +
  'This document contains placeholder text only. Final legal language must be ' +
  'supplied by Brian Soto, CPA before this template can be sent to any client. ' +
  'The system blocks sending while this template is flagged PLACEHOLDER.\n\n';

const PLACEHOLDER_BANNER_ES =
  '⚠ PLANTILLA PROVISIONAL — NO USAR CON CLIENTES.\n' +
  'Este documento contiene únicamente texto provisional. Brian Soto, CPA debe ' +
  'proporcionar el texto legal definitivo antes de que esta plantilla pueda ' +
  'enviarse a cualquier cliente. El sistema bloquea el envío mientras la ' +
  'plantilla esté marcada como PROVISIONAL.\n\n';

const letter = (serviceEn, serviceEs) => ({
  bodyEn:
    PLACEHOLDER_BANNER_EN +
    `ENGAGEMENT LETTER — ${serviceEn} (placeholder)\n` +
    'Parties: Soto Accounting LLC and {{client_name}}.\n' +
    'Scope of services: {{service_scope}}.\n' +
    'Fees: {{fee_summary}} (from the engagement’s locked price book version; deposit/true-up terms per the current pricing sheet).\n' +
    'Signatures collected via Docuseal; executed copy filed to the client record.',
  bodyEs:
    PLACEHOLDER_BANNER_ES +
    `CARTA DE COMPROMISO — ${serviceEs} (provisional)\n` +
    'Partes: Soto Accounting LLC y {{client_name}}.\n' +
    'Alcance de los servicios: {{service_scope}}.\n' +
    'Honorarios: {{fee_summary}} (según la versión del libro de precios fijada en el compromiso; términos de depósito y ajuste según la hoja de precios vigente).\n' +
    'Firmas mediante Docuseal; la copia firmada se archiva en el expediente del cliente.',
});

export const templates = [
  ...[
    ['engagement_letter_tax', 'Engagement Letter — Tax', 'TAX PREPARATION', 'PREPARACIÓN DE IMPUESTOS'],
    ['engagement_letter_bookkeeping', 'Engagement Letter — Bookkeeping', 'BOOKKEEPING', 'CONTABILIDAD'],
    ['engagement_letter_advisory', 'Engagement Letter — Advisory/CFO', 'ADVISORY / CFO', 'ASESORÍA / CFO'],
    ['engagement_letter_coo', 'Engagement Letter — COO Services', 'COO SERVICES', 'SERVICIOS COO'],
    ['engagement_letter_entity', 'Engagement Letter — Entity Services', 'ENTITY SERVICES', 'SERVICIOS DE ENTIDAD'],
  ].map(([key, name, en, es]) => ({
    key,
    name,
    channel: 'document',
    isPlaceholder: true,
    variables: ['client_name', 'service_scope', 'fee_summary'],
    ...letter(en, es),
  })),
  {
    key: 'consent_7216_use',
    name: '§7216 Consent to USE Tax Return Information',
    channel: 'document',
    isPlaceholder: true,
    variables: ['client_name', 'tax_year'],
    bodyEn:
      PLACEHOLDER_BANNER_EN +
      'IRC §7216 CONSENT TO USE OF TAX RETURN INFORMATION (placeholder)\n' +
      'IRS-mandated consent language (Rev. Proc. 2013-14 format) to be supplied by Brian. ' +
      'Until signed, the referral engine, upsell flagging, and any cross-entity use of ' +
      '{{client_name}}’s tax return information remain BLOCKED by the system.',
    bodyEs:
      PLACEHOLDER_BANNER_ES +
      'CONSENTIMIENTO §7216 PARA EL USO DE INFORMACIÓN DE LA DECLARACIÓN (provisional)\n' +
      'El texto de consentimiento exigido por el IRS será proporcionado por Brian. ' +
      'Hasta que se firme, el sistema mantiene BLOQUEADO todo uso de la información ' +
      'fiscal de {{client_name}} entre entidades, incluidas referencias y ofertas.',
  },
  {
    key: 'portal_magic_link',
    name: 'Portal magic-link sign-in email',
    channel: 'email',
    isPlaceholder: false, // functional copy, not legal language — live from day one, admin-editable
    variables: ['first_name', 'link', 'ttl_minutes'],
    subjectEn: 'Your secure sign-in link — Soto Accounting',
    subjectEs: 'Su enlace seguro de acceso — Soto Accounting',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Here is your secure link to sign in to your Soto Accounting portal:\n\n' +
      '{{link}}\n\n' +
      'The link works once and expires in {{ttl_minutes}} minutes. If you did not request it, ' +
      'you can ignore this email — your account is safe.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Aquí está su enlace seguro para entrar a su portal de Soto Accounting:\n\n' +
      '{{link}}\n\n' +
      'El enlace funciona una sola vez y vence en {{ttl_minutes}} minutos. Si usted no lo solicitó, ' +
      'puede ignorar este correo — su cuenta está segura.\n\n' +
      '— Soto Accounting',
  },
  {
    key: 'consent_7216_disclose',
    name: '§7216 Consent to DISCLOSE Tax Return Information',
    channel: 'document',
    isPlaceholder: true,
    variables: ['client_name', 'tax_year'],
    bodyEn:
      PLACEHOLDER_BANNER_EN +
      'IRC §7216 CONSENT TO DISCLOSURE OF TAX RETURN INFORMATION (placeholder)\n' +
      'IRS-mandated disclosure-consent language to be supplied by Brian.',
    bodyEs:
      PLACEHOLDER_BANNER_ES +
      'CONSENTIMIENTO §7216 PARA LA DIVULGACIÓN DE INFORMACIÓN DE LA DECLARACIÓN (provisional)\n' +
      'El texto de consentimiento exigido por el IRS será proporcionado por Brian.',
  },
];

export async function seedTemplates(client) {
  let inserted = 0;
  for (const t of templates) {
    const res = await client.query(
      `INSERT INTO templates (key, name, channel, subject_en, subject_es, body_en, body_es, is_placeholder, variables)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        t.key,
        t.name,
        t.channel,
        t.subjectEn ?? null,
        t.subjectEs ?? null,
        t.bodyEn,
        t.bodyEs,
        t.isPlaceholder,
        JSON.stringify(t.variables),
      ]
    );
    inserted += res.rowCount;
  }
  return `${inserted} of ${templates.length} templates inserted (existing keys left untouched)`;
}
