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
    key: 'extension_notice',
    name: 'Extension filed notice (extension of time to FILE, not to pay)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'tax_year', 'extended_deadline'],
    subjectEn: 'We’re filing an extension for your {{tax_year}} return',
    subjectEs: 'Presentaremos una extensión para su declaración {{tax_year}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'We’re filing an extension for your {{tax_year}} tax return. This is a smart, routine move — ' +
      'it gives us until {{extended_deadline}} to file an accurate return.\n\n' +
      'One important thing: an extension extends the time to FILE, not the time to PAY. ' +
      'If an estimated payment applies to you, we’ll send the amount and instructions separately.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Presentaremos una extensión para su declaración de impuestos {{tax_year}}. Es un paso ' +
      'inteligente y de rutina — nos da hasta el {{extended_deadline}} para presentar una declaración precisa.\n\n' +
      'Algo importante: la extensión extiende el plazo para PRESENTAR, no para PAGAR. ' +
      'Si le corresponde un pago estimado, le enviaremos el monto y las instrucciones por separado.\n\n' +
      '— Soto Accounting',
  },
  {
    key: 'extension_payment_reminder',
    name: 'Extension payment estimate + instructions',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'tax_year', 'amount', 'original_deadline'],
    subjectEn: 'Your estimated payment for tax year {{tax_year}}',
    subjectEs: 'Su pago estimado para el año fiscal {{tax_year}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'With your {{tax_year}} extension, we recommend an estimated payment of {{amount}}, ' +
      'submitted by {{original_deadline}} — the extension moves the filing date, not the payment date.\n\n' +
      'Paying now avoids interest and penalties later. Reply here or call the office if you’d like ' +
      'to walk through it.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Con su extensión {{tax_year}}, recomendamos un pago estimado de {{amount}}, ' +
      'enviado antes del {{original_deadline}} — la extensión mueve la fecha de presentación, no la de pago.\n\n' +
      'Pagar ahora evita intereses y multas después. Responda aquí o llame a la oficina si desea repasarlo.\n\n' +
      '— Soto Accounting',
  },
  {
    key: 'extension_chase_june',
    name: 'Summer document chase #1 (June — beat the fall rush)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'extended_deadline', 'portal_link'],
    subjectEn: 'Beat the fall rush — send your tax documents when ready',
    subjectEs: 'Adelántese al otoño — envíe sus documentos cuando pueda',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your extended deadline is {{extended_deadline}} — plenty of time, and that’s exactly why now ' +
      'is the easiest moment to knock this out. Upload your documents to your portal whenever you’re ready:\n\n' +
      '{{portal_link}}\n\nEarly filers get the calmest turnaround of the year.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su plazo extendido es el {{extended_deadline}} — hay tiempo de sobra, y justo por eso este es ' +
      'el momento más fácil para resolverlo. Suba sus documentos a su portal cuando esté listo(a):\n\n' +
      '{{portal_link}}\n\nQuienes presentan temprano reciben la atención más ágil del año.\n\n— Soto Accounting',
  },
  {
    key: 'extension_chase_july',
    name: 'Summer document chase #2 (July — firmer)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'extended_deadline', 'portal_link'],
    subjectEn: 'Your {{extended_deadline}} deadline — let’s get your documents in',
    subjectEs: 'Su plazo del {{extended_deadline}} — enviemos sus documentos',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'A quick nudge: we still need your tax documents to prepare your extended return ' +
      '(deadline {{extended_deadline}}). Uploading them this month keeps everything comfortable:\n\n' +
      '{{portal_link}}\n\nIf anything is hard to track down, tell us — we can usually help.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Un recordatorio rápido: aún necesitamos sus documentos para preparar su declaración extendida ' +
      '(plazo {{extended_deadline}}). Subirlos este mes mantiene todo sin prisas:\n\n' +
      '{{portal_link}}\n\nSi algo le cuesta conseguir, díganos — normalmente podemos ayudar.\n\n— Soto Accounting',
  },
  {
    key: 'extension_chase_august',
    name: 'Summer document chase #3 (August — urgent)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'extended_deadline', 'portal_link'],
    subjectEn: 'Action needed: documents required for your {{extended_deadline}} deadline',
    subjectEs: 'Acción necesaria: documentos para su plazo del {{extended_deadline}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your extended deadline of {{extended_deadline}} is now close, and we don’t yet have your ' +
      'documents. To file on time — and avoid a compressed, error-prone October — we need them within ' +
      'the next two weeks:\n\n{{portal_link}}\n\n' +
      'If something is blocking you, reply today and we’ll solve it together.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su plazo extendido del {{extended_deadline}} ya está cerca y aún no tenemos sus documentos. ' +
      'Para presentar a tiempo — y evitar un octubre comprimido y propenso a errores — los necesitamos ' +
      'dentro de las próximas dos semanas:\n\n{{portal_link}}\n\n' +
      'Si algo se lo impide, responda hoy y lo resolvemos juntos.\n\n— Soto Accounting',
  },
  {
    key: 'doc_request',
    name: 'Document request (initial, itemized)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'request_title', 'items_list', 'portal_link'],
    subjectEn: 'Documents needed: {{request_title}}',
    subjectEs: 'Documentos necesarios: {{request_title}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'To move your work forward we need the following:\n\n{{items_list}}\n\n' +
      'Upload them to your secure portal (photos from your phone work great):\n\n{{portal_link}}\n\n' +
      'For your security, please use the portal — not email or text — for documents.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Para avanzar con su trabajo necesitamos lo siguiente:\n\n{{items_list}}\n\n' +
      'Súbalos a su portal seguro (las fotos desde su teléfono funcionan perfecto):\n\n{{portal_link}}\n\n' +
      'Por su seguridad, use el portal — no correo ni mensajes de texto — para documentos.\n\n— Soto Accounting',
  },
  {
    key: 'doc_request_reminder',
    name: 'Document request reminder (recurring)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'request_title', 'portal_link'],
    subjectEn: 'Reminder: we still need your documents ({{request_title}})',
    subjectEs: 'Recordatorio: aún necesitamos sus documentos ({{request_title}})',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'A friendly reminder — we’re still waiting on documents for: {{request_title}}.\n\n' +
      'Your secure portal is the fastest way to get them to us:\n\n{{portal_link}}\n\n' +
      'Stuck on something? Reply here and we’ll figure it out together.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Un recordatorio amistoso — seguimos esperando documentos para: {{request_title}}.\n\n' +
      'Su portal seguro es la vía más rápida para enviárnoslos:\n\n{{portal_link}}\n\n' +
      '¿Algo se le complica? Responda aquí y lo resolvemos juntos.\n\n— Soto Accounting',
  },
  {
    key: 'return_delivered',
    name: 'Tax return delivered to portal',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'tax_year', 'portal_link'],
    subjectEn: 'Your {{tax_year}} tax return is ready to review',
    subjectEs: 'Su declaración de impuestos {{tax_year}} está lista para revisar',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your {{tax_year}} tax return is ready and waiting in your portal under “My Returns”:\n\n{{portal_link}}\n\n' +
      'Review it at your convenience — it’s available for download any time. ' +
      'We’ll follow up on the e-file authorization next.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su declaración de impuestos {{tax_year}} está lista en su portal, en “Mis Declaraciones”:\n\n{{portal_link}}\n\n' +
      'Revísela con calma — puede descargarla en cualquier momento. ' +
      'Luego le enviaremos la autorización de presentación electrónica.\n\n— Soto Accounting',
  },
  {
    key: 'invoice_sent',
    name: 'Invoice sent (portal Pay Now)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'invoice_number', 'amount', 'portal_link'],
    subjectEn: 'Invoice {{invoice_number}} — {{amount}}',
    subjectEs: 'Factura {{invoice_number}} — {{amount}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your invoice {{invoice_number}} for {{amount}} is ready in your portal. ' +
      'You can review the details and pay securely with one click:\n\n{{portal_link}}\n\n' +
      'Questions about anything on it? Reply here — happy to walk through it.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su factura {{invoice_number}} por {{amount}} está lista en su portal. ' +
      'Puede revisar los detalles y pagar de forma segura con un clic:\n\n{{portal_link}}\n\n' +
      '¿Preguntas sobre algún cargo? Responda aquí — con gusto lo repasamos.\n\n— Soto Accounting',
  },
  {
    key: 'payment_received',
    name: 'Payment received (receipt)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'invoice_number', 'amount'],
    subjectEn: 'Payment received — thank you ({{invoice_number}})',
    subjectEs: 'Pago recibido — gracias ({{invoice_number}})',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'We received your payment of {{amount}} for invoice {{invoice_number}} — thank you. ' +
      'Your receipt and invoice history are always available in your portal.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Recibimos su pago de {{amount}} por la factura {{invoice_number}} — gracias. ' +
      'Su recibo y el historial de facturas están siempre disponibles en su portal.\n\n— Soto Accounting',
  },
  {
    key: 'invoice_reminder',
    name: 'Invoice unpaid reminder (automation 17)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'invoice_number', 'amount', 'portal_link'],
    subjectEn: 'Friendly reminder: invoice {{invoice_number}} ({{amount}})',
    subjectEs: 'Recordatorio: factura {{invoice_number}} ({{amount}})',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'A quick reminder that invoice {{invoice_number}} for {{amount}} is still open. ' +
      'Paying takes about a minute in your portal:\n\n{{portal_link}}\n\n' +
      'If the timing is tight or something looks off, reply here and we’ll sort it out.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Un recordatorio rápido: la factura {{invoice_number}} por {{amount}} sigue pendiente. ' +
      'Pagar toma un minuto en su portal:\n\n{{portal_link}}\n\n' +
      'Si el momento no es oportuno o algo no cuadra, responda aquí y lo resolvemos.\n\n— Soto Accounting',
  },
  {
    key: 'annual_report_reminder',
    name: 'Annual report reminder (client, T-30)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'business_name', 'due_date', 'state'],
    subjectEn: '{{business_name}}: annual report due {{due_date}}',
    subjectEs: '{{business_name}}: informe anual vence el {{due_date}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'A heads-up from your compliance calendar: the {{state}} annual report for {{business_name}} ' +
      'is due {{due_date}}. We handle the filing — no action needed unless anything about the ' +
      'business has changed (address, ownership, registered agent).\n\n' +
      'If something has changed, reply here and we’ll update it before filing.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Un aviso de su calendario de cumplimiento: el informe anual de {{business_name}} en {{state}} ' +
      'vence el {{due_date}}. Nosotros nos encargamos de la presentación — no necesita hacer nada, ' +
      'salvo que algo del negocio haya cambiado (dirección, propietarios, agente registrado).\n\n' +
      'Si algo cambió, responda aquí y lo actualizamos antes de presentar.\n\n— Soto Accounting',
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
