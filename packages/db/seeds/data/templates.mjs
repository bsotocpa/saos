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
    'Late payment: balances unpaid 30 days past the invoice date accrue a late fee of ' +
    '{{late_fee_rate}} per month (18% APR), itemized on the invoice. Deposits and credits ' +
    'apply to the balance first. (v4.3 required disclosure block — final wording from Brian.)\n' +
    'Signatures collected via Docuseal; executed copy filed to the client record.',
  bodyEs:
    PLACEHOLDER_BANNER_ES +
    `CARTA DE COMPROMISO — ${serviceEs} (provisional)\n` +
    'Partes: Soto Accounting LLC y {{client_name}}.\n' +
    'Alcance de los servicios: {{service_scope}}.\n' +
    'Honorarios: {{fee_summary}} (según la versión del libro de precios fijada en el compromiso; términos de depósito y ajuste según la hoja de precios vigente).\n' +
    'Pago atrasado: los saldos con 30 días de atraso acumulan un cargo por mora de ' +
    '{{late_fee_rate}} mensual (18% anual), detallado en la factura. Los depósitos y créditos ' +
    'se aplican primero al saldo. (Bloque de divulgación requerido v4.3 — redacción final de Brian.)\n' +
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
    variables: ['client_name', 'service_scope', 'fee_summary', 'late_fee_rate'],
    hasLateFeeDisclosure: true, // v4.3 flow 4: THE late-fee gate reads this
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
    /*
     * FINDING #21 — the first thing a new client ever hears from us.
     *
     * Before this, a brand-new client's opening email was portal_magic_link: "Here is
     * your secure link to sign in to your Soto Accounting portal" — for a portal they
     * had never been told existed, expiring in fifteen minutes, with no explanation of
     * what it was or why they had it. That reads like phishing, and a careful person is
     * right not to click it.
     *
     * An invite and a re-login link are different messages. This one says what the
     * portal is, what is waiting there, and what to do when the link expires — because
     * it will, and "request a new one" has to be an instruction rather than a dead end.
     */
    key: 'portal_invite',
    name: 'Portal invitation (first-time access)',
    channel: 'email',
    isPlaceholder: false, // functional copy, not legal language — admin-editable, no deploy
    variables: ['first_name', 'link', 'ttl_minutes', 'portal_url'],
    subjectEn: 'Your Soto Accounting client portal is ready',
    subjectEs: 'Su portal de cliente de Soto Accounting está listo',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'We have set up your secure client portal at Soto Accounting. It is where your ' +
      'documents, invoices, engagement letters and messages live — everything in one ' +
      'place, and nothing sensitive travelling by email or text.\n\n' +
      'Open it here:\n\n' +
      '{{link}}\n\n' +
      'In the portal you can:\n' +
      '  · upload documents securely (photos from your phone are fine)\n' +
      '  · sign your engagement letter and authorizations\n' +
      '  · see and pay invoices\n' +
      '  · message us, and track where your work stands\n\n' +
      'That link signs you in once and expires in {{ttl_minutes}} minutes. If it expires ' +
      'before you use it, go to {{portal_url}} and enter this same email address — we ' +
      'will send you a fresh one. There is no password to create or remember.\n\n' +
      'If anything looks wrong, reply to this email and a person will answer.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Hemos creado su portal seguro de cliente en Soto Accounting. Allí viven sus ' +
      'documentos, facturas, cartas de compromiso y mensajes — todo en un solo lugar, ' +
      'sin que nada confidencial viaje por correo o mensaje de texto.\n\n' +
      'Ábralo aquí:\n\n' +
      '{{link}}\n\n' +
      'En el portal usted puede:\n' +
      '  · subir documentos de forma segura (las fotos desde su teléfono funcionan bien)\n' +
      '  · firmar su carta de compromiso y autorizaciones\n' +
      '  · ver y pagar facturas\n' +
      '  · escribirnos y seguir el estado de su trabajo\n\n' +
      'Ese enlace le da acceso una sola vez y vence en {{ttl_minutes}} minutos. Si vence ' +
      'antes de usarlo, visite {{portal_url}} e ingrese este mismo correo electrónico — ' +
      'le enviaremos uno nuevo. No hay contraseña que crear ni recordar.\n\n' +
      'Si algo no se ve bien, responda a este correo y una persona le contestará.\n\n' +
      '— Soto Accounting',
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
    key: 'ladder_portal_reminder',
    name: 'Escalation ladder — D3 portal reminder (waiting on client)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'item', 'portal_link'],
    subjectEn: 'Quick reminder — we’re waiting on one thing from you',
    subjectEs: 'Recordatorio rápido — esperamos una cosa de usted',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your work is queued and ready — we’re just waiting on one item from you:\n\n' +
      '{{item}}\n\n' +
      'Two minutes in your portal takes care of it:\n{{portal_link}}\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su trabajo está en cola y listo — solo esperamos una cosa de su parte:\n\n' +
      '{{item}}\n\n' +
      'Dos minutos en su portal lo resuelven:\n{{portal_link}}\n\n' +
      '— Soto Accounting',
  },
  {
    key: 'ladder_sms_nudge',
    name: 'Escalation ladder — D7 SMS nudge (waiting on client)',
    channel: 'sms',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: null,
    subjectEs: null,
    bodyEn:
      'Hi {{first_name}}, it’s Soto Accounting. We’re still waiting on one item from you — ' +
      'your portal has the details: {{portal_link}} Reply STOP to opt out.',
    bodyEs:
      'Hola {{first_name}}, le escribe Soto Accounting. Aún esperamos una cosa de su parte — ' +
      'su portal tiene los detalles: {{portal_link}} Responda STOP para cancelar.',
  },
  {
    key: 'statements_posted',
    name: 'Monthly/period statements posted to the portal (books close, v4.3 flow 5)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'period', 'portal_link'],
    subjectEn: 'Your {{period}} statements are ready',
    subjectEs: 'Sus estados financieros de {{period}} están listos',
    bodyEn:
      'Hi {{first_name}},\n\nYour books for {{period}} are closed and your statements are in your portal:\n' +
      '{{portal_link}}\n\nHave a look before our next conversation — the numbers are yours, and questions are ' +
      'always welcome.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}},\n\nSus libros de {{period}} están cerrados y sus estados financieros están en su portal:\n' +
      '{{portal_link}}\n\nRevíselos antes de nuestra próxima conversación — los números son suyos, y sus preguntas ' +
      'siempre son bienvenidas.\n\n— Soto Accounting',
  },
  {
    key: 'protective_extension_notice',
    name: 'Protective extension filed (auto-extension batch, v4.3 flow 3)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'tax_year', 'portal_link'],
    subjectEn: 'We’re filing an extension for your {{tax_year}} return',
    subjectEs: 'Presentaremos una extensión para su declaración {{tax_year}}',
    bodyEn:
      'Hi {{first_name}},\n\nWe’re filing an extension for your {{tax_year}} return. This is normal and it ' +
      'protects you — it gives us the time to file accurately instead of rushing, and it does not increase ' +
      'your chance of an audit.\n\nOne thing to know: an extension moves the FILING deadline, not the payment ' +
      'deadline. If you expect to owe, we’ll tell you what to pay and when.\n\nNothing is required from you ' +
      'right now. When you have your documents ready, your portal is here:\n{{portal_link}}\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}},\n\nPresentaremos una extensión para su declaración {{tax_year}}. Esto es normal y ' +
      'lo protege — nos da el tiempo para presentarla correctamente en lugar de apurarnos, y no aumenta su ' +
      'probabilidad de una auditoría.\n\nAlgo importante: una extensión mueve la fecha de PRESENTACIÓN, no la ' +
      'de pago. Si esperamos que deba impuestos, le diremos cuánto pagar y cuándo.\n\nNo necesitamos nada de ' +
      'usted en este momento. Cuando tenga sus documentos listos, su portal está aquí:\n{{portal_link}}\n\n— Soto Accounting',
  },
  {
    key: 'attachment_received_sms',
    name: 'Inbound attachment ack (MMS) — accept + portal nudge',
    channel: 'sms',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: null,
    subjectEs: null,
    bodyEn:
      'Hi {{first_name}}, we received your file — thank you. Our team will review and file it. ' +
      'For your security, the fastest way to send documents is your secure portal: {{portal_link}}',
    bodyEs:
      'Hola {{first_name}}, recibimos su archivo — gracias. Nuestro equipo lo revisará y lo archivará. ' +
      'Por su seguridad, la forma más rápida de enviar documentos es su portal seguro: {{portal_link}}',
  },
  {
    /*
     * PORTAL-UPLOAD ack — its own template, deliberately NOT the inbound one.
     *
     * Brian's ruling (2026-08-13): receipt confirmation + what happens next, and no
     * "visit the portal" copy, because they are already in it. The inbound template
     * exists to redirect people away from email attachments; sending that to someone
     * who just used the portal correctly would tell them to do the thing they did.
     *
     * Says what happens next rather than only "received", because "we got it" answers
     * the question the client did not ask. The one they did ask is "so am I done?".
     */
    key: 'portal_upload_received_email',
    name: 'Portal upload ack (email) — receipt + what happens next',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'document_summary'],
    subjectEn: 'We have your documents',
    subjectEs: 'Recibimos sus documentos',
    bodyEn:
      'Hi {{first_name}},\n\nWe have {{document_summary}} — it is filed to your record and ' +
      'nothing further is needed from you on it.\n\nWhat happens next: we review what you sent, ' +
      'and if anything is missing or unclear we will ask you for that specific item rather than ' +
      'starting over. If you were working from a document request, anything still outstanding is ' +
      'listed in your portal.\n\nYou do not need to email or text us a copy — what you uploaded ' +
      'is the copy we work from.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}},\n\nRecibimos {{document_summary}} — está archivado en su expediente y ' +
      'no necesitamos nada más de su parte al respecto.\n\nQué sigue: revisamos lo que envió, y si ' +
      'algo falta o no está claro le pediremos ese documento específico en lugar de empezar de ' +
      'nuevo. Si estaba respondiendo a una solicitud de documentos, lo que aún falta aparece en su ' +
      'portal.\n\nNo necesita enviarnos una copia por correo ni por mensaje — lo que subió es la ' +
      'copia con la que trabajamos.\n\n— Soto Accounting',
  },
  {
    key: 'attachment_received_email',
    name: 'Inbound attachment ack (email) — accept + portal nudge',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: 'We received your file',
    subjectEs: 'Recibimos su archivo',
    bodyEn:
      'Hi {{first_name}},\n\nThanks for sending your document — we have it, and our team will review ' +
      'and file it for you.\n\nFor your security (and the fastest turnaround), documents are best ' +
      'uploaded through your secure portal:\n{{portal_link}}\n\nThe portal encrypts your files and ' +
      'routes them straight to the right place — email attachments take an extra manual step on our ' +
      'side.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}},\n\nGracias por enviar su documento — lo recibimos y nuestro equipo lo ' +
      'revisará y archivará por usted.\n\nPor su seguridad (y para el trámite más rápido), lo mejor es ' +
      'subir los documentos por su portal seguro:\n{{portal_link}}\n\nEl portal cifra sus archivos y ' +
      'los dirige directamente al lugar correcto — los adjuntos por correo requieren un paso manual ' +
      'adicional de nuestra parte.\n\n— Soto Accounting',
  },
  {
    key: 'estimated_payment_reminder',
    name: 'Quarterly estimated-payment reminder (T-7, toggle-gated)',
    channel: 'email',
    isPlaceholder: false, // operational reminder copy — live, admin-editable
    variables: ['first_name', 'quarter', 'due_date'],
    subjectEn: 'Estimated tax payment due {{due_date}}',
    subjectEs: 'Pago de impuestos estimado vence el {{due_date}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'A quick reminder: the {{quarter}} federal estimated tax payment is due {{due_date}}.\n\n' +
      'If your estimates are already handled — or estimated payments don’t apply to you — ' +
      'you can ignore this note, or turn these reminders off any time in your portal’s ' +
      'notification settings. Questions about your amount? Message us through the portal.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Un recordatorio rápido: el pago de impuestos estimados federales del {{quarter}} vence el {{due_date}}.\n\n' +
      'Si sus pagos estimados ya están al día — o no le aplican — puede ignorar este mensaje, ' +
      'o desactivar estos recordatorios en la configuración de notificaciones de su portal. ' +
      '¿Preguntas sobre su monto? Escríbanos por el portal.\n\n' +
      '— Soto Accounting',
  },
  {
    key: 'twilio_voice_greeting',
    name: 'Voice greeting (spoken to callers on the texting number)',
    channel: 'sms',
    isPlaceholder: false, // operational copy — Brian tunes wording in admin, no deploy
    variables: [],
    subjectEn: null,
    subjectEs: null,
    bodyEn:
      'Thank you for calling Soto Accounting. This line is best for text messages — ' +
      'send us a text and our team will respond within one business day. ' +
      'You can also message us any time through your secure client portal.',
    bodyEs:
      'Gracias por llamar a Soto Accounting. Esta línea funciona mejor para mensajes de texto — ' +
      'envíenos un mensaje y nuestro equipo le responderá dentro de un día hábil. ' +
      'También puede escribirnos en cualquier momento desde su portal seguro de cliente.',
  },
  {
    key: 'portal_migration_welcome',
    name: 'Migrated-client portal welcome ("we upgraded our portal")',
    channel: 'email',
    isPlaceholder: false, // operational copy, admin-editable; SENDING is a launch-gate action (M22 stages, M23 sends)
    variables: ['first_name', 'link'],
    subjectEn: 'Your new Soto Accounting client portal is ready',
    subjectEs: 'Su nuevo portal de cliente de Soto Accounting está listo',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'We’ve upgraded to a new client portal — one secure place for your documents, ' +
      'returns, signatures, invoices, and messages with our team.\n\n' +
      'Your records came with us. Sign in here to take a look and confirm your details:\n\n' +
      '{{link}}\n\n' +
      'The link works once and signs you in directly — no password needed. From your phone, ' +
      'you can photograph and upload documents in seconds.\n\n' +
      'Going forward, the portal is how we exchange documents — faster for you, and more secure ' +
      'than email attachments.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Hemos actualizado a un nuevo portal de clientes — un solo lugar seguro para sus documentos, ' +
      'declaraciones, firmas, facturas y mensajes con nuestro equipo.\n\n' +
      'Sus registros ya están ahí. Entre aquí para revisarlos y confirmar sus datos:\n\n' +
      '{{link}}\n\n' +
      'El enlace funciona una sola vez y lo conecta directamente — sin contraseña. Desde su teléfono, ' +
      'puede fotografiar y subir documentos en segundos.\n\n' +
      'De ahora en adelante, el portal es la vía para intercambiar documentos — más rápido para usted ' +
      'y más seguro que los archivos adjuntos por correo.\n\n' +
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
  /*
   * Replaces `discovery_deposit`, which asked for money at booking and carried a Stripe
   * checkout link. Brian retired that path on 2026-08-14: deposits exist only on
   * accepted quotes. `discovery_deposit` is retired by the seed rather than edited,
   * because a template whose key says "deposit" and whose body says "nothing to pay"
   * is a trap for whoever opens Admin → Templates next.
   *
   * The copy treats the reader as a capable professional, per the standing rule: it
   * states what happens next and what it will cost them now (nothing), without
   * congratulating them or over-explaining.
   */
  {
    key: 'booking_confirmation',
    name: 'Booking confirmation — discovery call (no charge)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name'],
    subjectEn: 'Your consultation is booked',
    subjectEs: 'Su consulta está reservada',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your discovery consultation is on the calendar. You will get the calendar invite ' +
      'separately, with the meeting link.\n\n' +
      'There is nothing to pay for this call. After we meet, you will get a written quote for ' +
      'the work we discussed; the deposit comes with that quote, and it applies in full toward ' +
      'your invoice.\n\n' +
      'If anything comes up before then, just reply to this email.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su consulta inicial está en el calendario. Recibirá la invitación con el enlace de la ' +
      'reunión por separado.\n\n' +
      'Esta llamada no tiene ningún costo. Después de reunirnos, recibirá una cotización por ' +
      'escrito del trabajo que conversemos; el depósito viene con esa cotización y se aplica por ' +
      'completo a su factura.\n\n' +
      'Si surge algo antes, responda a este correo.\n\n— Soto Accounting',
  },
  {
    key: 'referral_disclosure',
    name: 'Referral-integrity disclosure block (Form 3 — REQUIRED screen)',
    channel: 'portal',
    isPlaceholder: false,
    variables: [],
    bodyEn:
      'Soto Accounting is one option — you’re free to work with any provider you choose. ' +
      'You should know: Hilo’s Executive Director also holds a role at Soto Accounting. ' +
      'Hilo receives no payment for this referral, and your relationship with Hilo does not ' +
      'depend on who you choose.',
    bodyEs:
      'Soto Accounting es una opción — usted es libre de trabajar con cualquier proveedor que elija. ' +
      'Debe saber: la Directora Ejecutiva de Hilo también tiene un cargo en Soto Accounting. ' +
      'Hilo no recibe ningún pago por esta referencia, y su relación con Hilo no depende de a quién elija.',
  },
  {
    key: 'referral_intro_hilo_to_soto',
    name: 'Warm handoff — Hilo → Soto (with transition link)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'transition_link'],
    subjectEn: 'A warm introduction to Soto Accounting',
    subjectEs: 'Una cálida presentación a Soto Accounting',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Based on where your business is headed, we’d like to introduce you to Soto Accounting — ' +
      'the CPA team we trust. Everything Hilo already knows is pre-filled, so this takes under a minute:\n\n' +
      '{{transition_link}}\n\n' +
      'You’ll see a short disclosure first — choosing them (or anyone else) is entirely up to you.\n\n— The Hilo team',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Por el rumbo que lleva su negocio, queremos presentarle a Soto Accounting — ' +
      'el equipo de CPA en el que confiamos. Todo lo que Hilo ya sabe está pre-llenado; esto toma menos de un minuto:\n\n' +
      '{{transition_link}}\n\n' +
      'Primero verá una breve divulgación — elegirlos (o a cualquier otro) es totalmente su decisión.\n\n— El equipo de Hilo',
  },
  {
    key: 'referral_intro_soto_to_hilo',
    name: 'Warm intro — Soto → Hilo',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name'],
    subjectEn: 'An introduction to Hilo — on us',
    subjectEs: 'Una presentación a Hilo — por nuestra cuenta',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'We work alongside Hilo, a nonprofit that gives entrepreneurs like you free 1-on-1 advisory ' +
      'sessions and workshops — operations, licensing, marketing, the works. It’s a resource we ' +
      'genuinely recommend, and it costs you nothing.\n\n' +
      'They’ll reach out shortly, or visit teamhilo.org whenever you like.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Trabajamos junto a Hilo, una organización sin fines de lucro que ofrece a emprendedores como ' +
      'usted sesiones de asesoría 1 a 1 y talleres gratuitos — operaciones, licencias, marketing y más. ' +
      'Es un recurso que recomendamos de verdad, y no le cuesta nada.\n\n' +
      'Le contactarán pronto, o visite teamhilo.org cuando guste.\n\n— Soto Accounting',
  },
  {
    key: 'welcome_soto',
    name: 'Welcome — Soto Accounting (intake)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: 'Welcome to Soto Accounting, {{first_name}}',
    subjectEs: 'Bienvenido(a) a Soto Accounting, {{first_name}}',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Welcome — we’re glad you’re here. Your secure client portal is being set up now; ' +
      'a sign-in link is on its way in a separate email.\n\n' +
      // The old copy promised a "4-step checklist … upload last year's return, and book
      // your consultation". The portal redesign made it five steps, replaced the
      // prior-year-return step with documents generally, and REMOVED booking entirely —
      // a client only reaches this point after the discovery meeting, so asking them to
      // book one asks for something they have already done. Describing a checklist that
      // no longer exists is the first instruction a new client gets from us.
      'Once you’re in, a short checklist gets everything moving: sign your documents, ' +
      'pay your deposit, confirm your information, and upload what we need.\n\n' +
      'You run your business. We’ve got the numbers.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Bienvenido(a) — nos alegra tenerle aquí. Su portal seguro de cliente se está configurando; ' +
      'un enlace de acceso llega en un correo aparte.\n\n' +
      'Al entrar, una lista breve pone todo en marcha: firme sus documentos, pague su depósito, ' +
      'confirme sus datos y suba lo que necesitamos.\n\n' +
      'Usted dirige su negocio. Nosotros nos encargamos de los números.\n\n— Soto Accounting',
  },
  {
    key: 'welcome_hilo',
    name: 'Welcome — Hilo NFP (intake)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: 'You’re in, {{first_name}} — welcome to Hilo',
    subjectEs: 'Ya está dentro, {{first_name}} — bienvenido(a) a Hilo',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Welcome to Hilo! You’re building something — and you don’t have to figure it all out alone. ' +
      'Your portal sign-in link is on its way in a separate email.\n\n' +
      'Book a session whenever you’re ready; bring whatever’s on your mind. This is your space.\n\n— The Hilo team',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      '¡Bienvenido(a) a Hilo! Usted está construyendo algo — y no tiene que resolverlo todo solo(a). ' +
      'Su enlace de acceso al portal llega en un correo aparte.\n\n' +
      'Reserve una sesión cuando quiera; traiga lo que tenga en mente. Este es su espacio.\n\n— El equipo de Hilo',
  },
  {
    key: 'sos_fix_steps',
    name: 'IL SOS not in good standing — fix steps',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'business_name'],
    subjectEn: '{{business_name}}: an Illinois filing needs attention',
    subjectEs: '{{business_name}}: una presentación de Illinois requiere atención',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Our compliance check shows {{business_name}} is currently not in good standing with the ' +
      'Illinois Secretary of State — usually a missed annual report, and very fixable.\n\n' +
      'We’re already on it: our team will confirm exactly what’s owed and handle the reinstatement ' +
      'filing with you. No action needed yet — we’ll reach out with the specifics.\n\n— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Nuestra verificación muestra que {{business_name}} no está al corriente con el Secretario de ' +
      'Estado de Illinois — normalmente es un informe anual pendiente, y tiene solución.\n\n' +
      'Ya estamos en ello: confirmaremos exactamente qué se debe y gestionaremos la reinstalación ' +
      'con usted. No necesita hacer nada aún — le contactaremos con los detalles.\n\n— Soto Accounting',
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
  {
    // M27 quote builder. Copy addresses a capable professional deciding on a
    // proposal — not someone being sold to, and not someone being rescued.
    key: 'quote_ready',
    name: 'Quote ready for review (M27 quote builder)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'amount', 'quote_link'],
    subjectEn: 'Your proposal from Soto Accounting',
    subjectEs: 'Su propuesta de Soto Accounting',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your proposal is ready to review: {{amount}}.\n\n' +
      'It lists exactly what is included, and anything optional is marked so you can decide ' +
      'what you want. Accepting it starts the work — nothing is charged until you do.\n\n' +
      '{{quote_link}}\n\n' +
      'If something in it does not fit, reply and tell us what to change. We would rather ' +
      'adjust the scope than have you agree to work you did not want.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Su propuesta está lista para revisar: {{amount}}.\n\n' +
      'Detalla exactamente qué incluye, y lo opcional está marcado para que usted decida qué ' +
      'desea. Al aceptarla comienza el trabajo — no se cobra nada hasta entonces.\n\n' +
      '{{quote_link}}\n\n' +
      'Si algo no le corresponde, responda y díganos qué cambiar. Preferimos ajustar el ' +
      'alcance antes que usted acepte un trabajo que no quería.\n\n' +
      '— Soto Accounting',
  },
  {
    // M27 review asks. Asks once, plainly, and makes "no" costless — a review
    // request that pressures is worse than none.
    key: 'review_request',
    name: 'Google review request (milestone-triggered)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'review_link'],
    subjectEn: 'One small favor, if you have two minutes',
    subjectEs: 'Un pequeño favor, si tiene dos minutos',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'That work is done and filed. Thank you for trusting us with it.\n\n' +
      'If the experience was a good one, a short Google review helps other business owners find ' +
      'a CPA who actually returns their calls:\n\n' +
      '{{review_link}}\n\n' +
      'And if something fell short, reply to this email instead — we would rather hear it directly ' +
      'and fix it.\n\n' +
      '— Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'Ese trabajo ya está terminado y presentado. Gracias por confiarnos su caso.\n\n' +
      'Si la experiencia fue buena, una breve reseña en Google ayuda a otros dueños de negocio a ' +
      'encontrar un CPA que de verdad contesta:\n\n' +
      '{{review_link}}\n\n' +
      'Y si algo no estuvo a la altura, mejor responda a este correo — preferimos escucharlo ' +
      'directamente y corregirlo.\n\n' +
      '— Soto Accounting',
  },
  {
    // Session recap notification (v4.2 #6). The recap ITSELF lives on the portal
    // thread — this email is a short pointer, so replies land in the thread where
    // the conversation belongs rather than in a mailbox nobody is watching.
    // ⚠ BRIAN: this is the copy you sign off on. Edit in Admin → Templates.
    key: 'session_recap',
    name: 'Session recap posted (v4.2 #6 — awaiting Brian’s copy sign-off)',
    channel: 'email',
    isPlaceholder: false,
    variables: ['first_name', 'portal_link'],
    subjectEn: 'Your session recap is in your portal',
    subjectEs: 'El resumen de su sesión está en su portal',
    bodyEn:
      'Hi {{first_name}},\n\n' +
      'Your recap from our session is posted — what we covered, what we need from you, ' +
      'what we are doing next, and when we meet again:\n\n' +
      '{{portal_link}}\n\n' +
      'Reply on that thread if I got anything wrong or left something out. It is easier to ' +
      'fix now than at filing time.\n\n' +
      '— Brian Soto, CPA · Soto Accounting',
    bodyEs:
      'Hola {{first_name}}:\n\n' +
      'El resumen de nuestra sesión ya está publicado — lo que cubrimos, lo que necesitamos ' +
      'de usted, lo que haremos nosotros, y cuándo nos volvemos a ver:\n\n' +
      '{{portal_link}}\n\n' +
      'Responda en ese hilo si algo quedó mal o si faltó algo. Es más fácil corregirlo ahora ' +
      'que al momento de declarar.\n\n' +
      '— Brian Soto, CPA · Soto Accounting',
  },
];

/*
 * Templates superseded by a decision, not by an edit. Retired rather than deleted, the
 * same rule the legal-package seed uses: the row records copy that really went to real
 * clients, and dropping it to tidy Admin → Templates would erase that.
 */
const RETIRED = [
  {
    key: 'discovery_deposit',
    reason:
      'Retired 2026-08-14 (Brian): the booking-time deposit charge is gone — deposits exist only on accepted quotes. Superseded by booking_confirmation, which says there is nothing to pay for the call.',
  },
];

export async function seedTemplates(client) {
  let inserted = 0;
  for (const t of templates) {
    const res = await client.query(
      `INSERT INTO templates (key, name, channel, subject_en, subject_es, body_en, body_es, is_placeholder, variables, has_late_fee_disclosure)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
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
        t.hasLateFeeDisclosure ?? false,
      ]
    );
    inserted += res.rowCount;
  }

  // Idempotent: `AND is_active` means a second run reports 0 rather than re-stamping
  // retired_at, so the retirement date stays the date it actually happened.
  let retired = 0;
  for (const r of RETIRED) {
    const res = await client.query(
      `UPDATE templates
          SET is_active = false, retired_at = now(), retired_reason = $2
        WHERE key = $1 AND is_active`,
      [r.key, r.reason]
    );
    retired += res.rowCount;
  }

  return (
    `${inserted} of ${templates.length} templates inserted (existing keys left untouched)` +
    (retired > 0 ? `, ${retired} retired` : '')
  );
}
