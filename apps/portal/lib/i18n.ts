// Bilingual dictionary (MP: all Soto client-facing copy ships EN AND ES;
// the reader is a capable professional — never someone being rescued).

export type Lang = 'en' | 'es';

const dict = {
  // Shell
  nav_home: ['Home', 'Inicio'],
  nav_documents: ['Documents', 'Documentos'],
  nav_returns: ['My Returns', 'Mis declaraciones'],
  nav_sign: ['Sign', 'Firmar'],
  nav_invoices: ['Invoices', 'Facturas'],
  nav_messages: ['Messages', 'Mensajes'],
  nav_estimate: ['Estimate', 'Estimado'],
  nav_resources: ['Resources', 'Recursos'],
  nav_profile: ['My Info', 'Mis datos'],
  sign_out: ['Sign out', 'Cerrar sesión'],

  // Login / verify
  login_title: ['Sign in to your portal', 'Entre a su portal'],
  login_intro: ['Enter your email and we’ll send you a secure one-time link.', 'Escriba su correo y le enviamos un enlace seguro de un solo uso.'],
  login_email: ['Email', 'Correo electrónico'],
  login_send: ['Send my sign-in link', 'Enviar mi enlace'],
  login_sent: ['If that address has portal access, a sign-in link is on its way. Check your inbox.', 'Si esa dirección tiene acceso, su enlace va en camino. Revise su correo.'],
  verify_working: ['Signing you in…', 'Iniciando sesión…'],
  verify_failed: ['This link is invalid, used, or expired. Request a fresh one below.', 'Este enlace es inválido, usado o vencido. Pida uno nuevo abajo.'],

  // Dashboard
  home_title: ['Welcome back', 'Bienvenido(a) de nuevo'],
  checklist_title: ['Let’s get you set up', 'Pongamos todo en marcha'],
  checklist_step1: ['Confirm your info', 'Confirme sus datos'],
  checklist_step2: ['Sign your documents', 'Firme sus documentos'],
  checklist_step3: ['Upload your prior-year return', 'Suba su declaración anterior'],
  checklist_step4: ['Book your consultation', 'Reserve su consulta'],
  checklist_go: ['Go', 'Ir'],
  checklist_done: ['Done', 'Listo'],
  checklist_mark_done: ['Mark done', 'Marcar listo'],
  status_title: ['Your returns', 'Sus declaraciones'],
  status_deadline: ['Deadline', 'Fecha límite'],
  status_extended: ['Extended', 'Con extensión'],
  requests_title: ['Documents we need', 'Documentos que necesitamos'],
  unsigned_title: ['Waiting for your signature', 'Esperando su firma'],
  invoices_open_title: ['Open invoices', 'Facturas pendientes'],
  quick_actions: ['Quick actions', 'Acciones rápidas'],
  action_upload: ['Upload a document', 'Subir un documento'],
  action_message: ['Send us a message', 'Envíenos un mensaje'],
  action_request: ['Request a service', 'Solicitar un servicio'],
  action_estimate: ['Get an estimate', 'Pedir un estimado'],
  all_caught_up: ['You’re all caught up — nothing waiting on you.', 'Está al día — nada pendiente de su parte.'],

  // Stages, plain English (MP: engagement status in plain English)
  stage_intake_started: ['Getting started', 'Comenzando'],
  stage_scheduled: ['Consultation scheduled', 'Consulta agendada'],
  stage_documents_requested: ['Documents requested', 'Documentos solicitados'],
  stage_pending_client_response: ['Waiting on your documents', 'Esperando sus documentos'],
  stage_in_preparation: ['We’re preparing your return', 'Preparando su declaración'],
  stage_internal_review: ['In review by our team', 'En revisión por nuestro equipo'],
  stage_client_review: ['Ready for your review', 'Lista para su revisión'],
  stage_ready_to_file: ['Ready to file', 'Lista para presentar'],
  stage_filed: ['Filed', 'Presentada'],
  // v4.3 flow 1: honest, calm, no-action-needed — a reject is a transmission
  // hiccup we own, not a client problem.
  stage_rejected: ['Fixing a transmission issue — we’re re-filing for you', 'Corrigiendo un problema de transmisión — volveremos a presentarla por usted'],
  stage_completed: ['Completed', 'Completada'],
  stage_on_hold: ['On hold', 'En pausa'],

  // Documents
  docs_title: ['Document Center', 'Centro de documentos'],
  docs_policy: ['For your security, documents move through this portal only — never by text or email attachment.', 'Por su seguridad, los documentos van solo por este portal — nunca por texto ni adjuntos de correo.'],
  docs_upload: ['Upload', 'Subir'],
  docs_choose: ['Choose a file (photos work great)', 'Elija un archivo (las fotos funcionan perfecto)'],
  docs_category: ['Category', 'Categoría'],
  cat_tax_documents: ['Tax documents', 'Documentos de impuestos'],
  cat_business_records: ['Business records', 'Registros del negocio'],
  cat_id_verification: ['ID verification', 'Verificación de identidad'],
  cat_irs_notices: ['IRS notice', 'Aviso del IRS'],
  cat_other: ['Other', 'Otro'],
  docs_uploaded: ['Uploaded — thank you!', '¡Subido — gracias!'],
  docs_for_request: ['This fulfills:', 'Esto corresponde a:'],
  doc_status_uploaded: ['Received', 'Recibido'],
  doc_status_under_review: ['Under review', 'En revisión'],
  doc_status_accepted: ['Accepted', 'Aceptado'],
  doc_status_needs_replacement: ['Needs replacement', 'Necesita reemplazo'],
  download: ['Download', 'Descargar'],

  // Returns
  returns_title: ['My Returns', 'Mis declaraciones'],
  returns_intro: ['Your filed returns, available any time.', 'Sus declaraciones presentadas, disponibles en todo momento.'],
  returns_empty: ['Your returns will appear here once they’re ready.', 'Sus declaraciones aparecerán aquí cuando estén listas.'],

  // Sign
  sign_title: ['Sign Documents', 'Firmar documentos'],
  sign_intro: ['Documents that need your signature appear here. Signing takes about a minute.', 'Los documentos que requieren su firma aparecen aquí. Firmar toma un minuto.'],
  sign_empty: ['Nothing waiting for your signature.', 'Nada pendiente de firma.'],
  env_engagement_letter: ['Engagement letter', 'Carta de compromiso'],
  env_consent_7216: ['Tax information consent (§7216)', 'Consentimiento de información fiscal (§7216)'],
  env_f8879: ['E-file authorization (Form 8879)', 'Autorización de presentación electrónica (8879)'],
  env_status_draft: ['Being prepared', 'En preparación'],
  env_status_sent: ['Ready to sign — check your email', 'Lista para firmar — revise su correo'],
  env_status_completed: ['Signed', 'Firmado'],
  env_status_kba: ['Identity verification pending', 'Verificación de identidad pendiente'],

  // Invoices
  inv_title: ['Invoices & Payments', 'Facturas y pagos'],
  inv_pay: ['Pay now', 'Pagar ahora'],
  inv_paid: ['Paid', 'Pagada'],
  inv_open: ['Open', 'Pendiente'],
  inv_overdue: ['Past due', 'Vencida'],
  inv_empty: ['No invoices yet.', 'Aún no hay facturas.'],

  // Messages
  msg_title: ['Messages', 'Mensajes'],
  msg_intro: ['One conversation, whatever the channel. We reply within one business day.', 'Una sola conversación, sin importar el canal. Respondemos en un día hábil.'],
  msg_placeholder: ['Write your message…', 'Escriba su mensaje…'],
  msg_send: ['Send', 'Enviar'],
  msg_new_subject: ['Subject (optional)', 'Asunto (opcional)'],

  // Request a service
  req_title: ['Request a Service', 'Solicitar un servicio'],
  req_intro: ['Tell us what you need — we’ll respond within 24 hours.', 'Díganos qué necesita — respondemos dentro de 24 horas.'],
  req_service: ['Service', 'Servicio'],
  svc_tax: ['Tax', 'Impuestos'],
  svc_bookkeeping: ['Bookkeeping', 'Contabilidad'],
  svc_advisory: ['Advisory / CFO', 'Asesoría / CFO'],
  svc_entity: ['Entity formation or changes', 'Formación o cambios de entidad'],
  svc_irs_notice_help: ['IRS notice help', 'Ayuda con aviso del IRS'],
  svc_other: ['Other', 'Otro'],
  req_notes: ['Anything we should know?', '¿Algo que debamos saber?'],
  req_send: ['Send request', 'Enviar solicitud'],
  req_sent: ['Request received. We’ll be in touch within 24 hours.', 'Solicitud recibida. Le contactamos dentro de 24 horas.'],

  // Estimate
  est_title: ['Get an Estimate', 'Pedir un estimado'],
  est_intro: ['A few quick questions — you’ll get a realistic price range for your return.', 'Unas preguntas rápidas — recibirá un rango de precio realista para su declaración.'],
  est_filing_status: ['Filing status', 'Estado civil tributario'],
  fs_single: ['Single', 'Soltero(a)'],
  fs_mfj: ['Married filing jointly', 'Casados en conjunto'],
  fs_mfs: ['Married filing separately', 'Casados por separado'],
  fs_hoh: ['Head of household', 'Cabeza de familia'],
  est_schc: ['Self-employment businesses (Schedule C)', 'Negocios propios (Anexo C)'],
  est_rentals: ['Rental properties', 'Propiedades de alquiler'],
  est_k1s: ['K-1s you receive', 'K-1 que recibe'],
  est_states: ['States you file in', 'Estados donde declara'],
  est_bizreturn: ['Business return', 'Declaración de negocio'],
  biz_none: ['None', 'Ninguna'],
  est_calc: ['Show my range', 'Ver mi rango'],
  est_range_title: ['Your estimated range', 'Su rango estimado'],
  est_range_note: ['Final pricing is confirmed after we see your documents — no surprises without talking to you first.', 'El precio final se confirma al ver sus documentos — sin sorpresas y siempre hablando con usted primero.'],
  est_book: ['Book a consultation', 'Reservar una consulta'],

  // Resources
  res_title: ['Resource Library', 'Biblioteca de recursos'],

  // Profile
  prof_title: ['My Info', 'Mis datos'],
  prof_intro: ['Confirm or update your details — this keeps everything moving smoothly.', 'Confirme o actualice sus datos — así todo avanza sin fricción.'],
  prof_first: ['First name', 'Nombre'],
  prof_last: ['Last name', 'Apellido'],
  prof_phone: ['Mobile phone', 'Teléfono móvil'],
  prof_method: ['Preferred contact method', 'Método de contacto preferido'],
  method_text: ['Text', 'Texto'],
  method_email: ['Email', 'Correo'],
  method_phone: ['Phone', 'Teléfono'],
  method_portal: ['Portal', 'Portal'],
  prof_address: ['Address', 'Dirección'],
  prof_city: ['City', 'Ciudad'],
  prof_state: ['State', 'Estado'],
  prof_zip: ['ZIP', 'Código postal'],
  prof_save: ['Save', 'Guardar'],
  prof_saved: ['Saved.', 'Guardado.'],
  prof_language: ['Language / Idioma', 'Idioma / Language'],

  // Notification settings (v4.3: estimate toggle, default ON)
  notif_title: ['Notification settings', 'Configuración de notificaciones'],
  notif_estimate_label: [
    'Quarterly estimated-tax due dates and reminders',
    'Fechas y recordatorios de impuestos estimados trimestrales',
  ],
  notif_estimate_help: [
    'Shows upcoming federal estimated-payment due dates on your dashboard and emails a reminder a week before each one. Turn off if estimated payments don’t apply to you.',
    'Muestra las próximas fechas de pagos estimados federales en su panel y envía un recordatorio por correo una semana antes de cada una. Desactívelo si los pagos estimados no le aplican.',
  ],
  dash_estimate_due: ['Estimated payment due', 'Pago estimado vence'],

  // Client to-dos (v4.4)
  todos_title: ['Your to-dos', 'Sus pendientes'],
  todos_empty: ['Nothing waiting on you right now.', 'No hay nada pendiente de su parte por ahora.'],
  todos_done: ['Done', 'Listo'],
  todos_kind_upload: ['Upload', 'Subir'],
  todos_kind_signature: ['Signature', 'Firma'],
  todos_due: ['due', 'vence'],

  // Transition (Form 3 — Hilo → Soto)
  trans_title: ['You’re almost there', 'Ya casi está'],
  trans_intro: ['Hilo already shared the basics — confirm, choose what you need, and you’re in.', 'Hilo ya compartió lo básico — confirme, elija lo que necesita, y listo.'],
  trans_your_info: ['Your info (from Hilo)', 'Sus datos (de Hilo)'],
  trans_services: ['What can Soto help with?', '¿Con qué puede ayudar Soto?'],
  trans_disclosure_title: ['One thing you should know', 'Algo que debe saber'],
  trans_disclosure_ack: ['I understand, and I choose to continue', 'Entiendo, y elijo continuar'],
  trans_comm_consent: ['Soto Accounting may contact me about my request', 'Soto Accounting puede contactarme sobre mi solicitud'],
  trans_esign_consent: ['I agree to sign documents electronically (ESIGN Act)', 'Acepto firmar documentos electrónicamente (Ley ESIGN)'],
  trans_submit: ['Complete my transition', 'Completar mi transición'],
  trans_done_title: ['Welcome to Soto Accounting', 'Bienvenido(a) a Soto Accounting'],
  trans_done_body: ['Your portal sign-in link is on its way by email. Brian’s team already has your details.', 'Su enlace de acceso al portal va en camino por correo. El equipo de Brian ya tiene sus datos.'],
  trans_invalid: ['This link is invalid, expired, or already used.', 'Este enlace es inválido, venció o ya fue usado.'],

  // Quote (M27). The reader is deciding on a proposal, not being sold to.
  quote_title: ['Your proposal', 'Su propuesta'],
  quote_intro: [
    'Here is exactly what we would do and what it costs. Nothing is charged until you accept.',
    'Esto es exactamente lo que haríamos y cuánto cuesta. No se cobra nada hasta que usted acepte.',
  ],
  quote_included: ['Included', 'Incluido'],
  quote_optional: ['Optional — your choice', 'Opcional — usted decide'],
  quote_optional_hint: [
    'Tick anything you want added. Leave it unticked and it is not part of the price.',
    'Marque lo que desee agregar. Si no lo marca, no forma parte del precio.',
  ],
  quote_passthrough: ['Billed by the software provider, not by us', 'Lo cobra el proveedor del software, no nosotros'],
  quote_subtotal: ['Subtotal', 'Subtotal'],
  quote_discount: ['Package discount', 'Descuento del paquete'],
  quote_total: ['Total', 'Total'],
  quote_estimate_note: [
    'One-time work is quoted as a range. The final invoice lands inside it, or we talk before it does not.',
    'El trabajo puntual se cotiza como un rango. La factura final queda dentro del rango, o hablamos antes.',
  ],
  quote_expires: ['This proposal is good through', 'Esta propuesta es válida hasta'],
  quote_accept: ['Accept and start the work', 'Aceptar y comenzar el trabajo'],
  quote_decline: ['This is not right for me', 'Esto no me conviene'],
  quote_decline_prompt: [
    'Tell us what did not fit. It genuinely helps — and if it is the scope or the timing, we can requote.',
    'Cuéntenos qué no le convino. De verdad nos ayuda — y si es el alcance o el momento, podemos recotizar.',
  ],
  quote_decline_send: ['Send', 'Enviar'],
  quote_accepted_title: ['You’re all set', 'Todo listo'],
  quote_accepted_body: [
    'The work is open on our side. Watch your email for your portal sign-in link and the engagement letter.',
    'El trabajo ya está abierto de nuestro lado. Revise su correo para el enlace de acceso al portal y la carta de compromiso.',
  ],
  quote_accepted_deposit: [
    'Your deposit invoice is on its way by email. The work is already queued.',
    'Su factura de depósito va en camino por correo. El trabajo ya está en cola.',
  ],
  quote_declined_title: ['Thank you for telling us', 'Gracias por decírnoslo'],
  quote_declined_body: [
    'Nothing is owed and nothing is scheduled. If anything changes, reply to our email and we will pick it up from here.',
    'No hay nada que pagar ni nada programado. Si algo cambia, responda a nuestro correo y seguimos desde aquí.',
  ],
  quote_expired_title: ['This proposal has expired', 'Esta propuesta ya venció'],
  quote_expired_body: [
    'Prices move, so proposals do not sit open forever. Reply to our email and we will send you a current one.',
    'Los precios cambian, así que las propuestas no quedan abiertas para siempre. Responda a nuestro correo y le enviamos una vigente.',
  ],
  quote_invalid: ['This link is invalid or has already been used.', 'Este enlace es inválido o ya fue usado.'],

  // Unsubscribe (M27). Says plainly what stopped and what did not — a client who
  // believes they switched off "your return is ready" is worse off, not better.
  unsub_done_title: ['You’re unsubscribed', 'Suscripción cancelada'],
  unsub_done_body: [
    'You won’t receive firm announcements from Soto Accounting any more. No need to do anything else.',
    'Ya no recibirá anuncios de la firma de Soto Accounting. No necesita hacer nada más.',
  ],
  unsub_still_get: [
    'You will still get messages about your own work — returns, invoices, document requests, and sign-in links. Those aren’t announcements.',
    'Seguirá recibiendo mensajes sobre su propio trabajo — declaraciones, facturas, solicitudes de documentos y enlaces de acceso. Esos no son anuncios.',
  ],
  unsub_undo: [
    'Changed your mind? Reply to any email from us and we’ll turn announcements back on.',
    '¿Cambió de opinión? Responda a cualquiera de nuestros correos y volvemos a activarlos.',
  ],
  unsub_invalid_title: ['This link didn’t work', 'Este enlace no funcionó'],
  unsub_invalid_body: [
    'The link may be incomplete. Reply to any email from us and we’ll take you off the announcement list by hand.',
    'El enlace puede estar incompleto. Responda a cualquiera de nuestros correos y lo quitamos de la lista de anuncios manualmente.',
  ],

  // SMS opt-in, offered in the welcome flow (M27). The disclosure is the
  // TCPA-required content: who is texting, what about, that consent is not a
  // condition of service, that rates may apply, and how to stop. Versioned as
  // sms-portal-optin-v1 in the consents row.
  sms_optin_title: ['Text messages (optional)', 'Mensajes de texto (opcional)'],
  sms_optin_body: [
    'We can text you short nudges — a document we’re waiting on, a deadline coming up, your return is ready. Never documents, and never anything sensitive.',
    'Podemos enviarle avisos breves por texto — un documento que esperamos, una fecha límite próxima, su declaración está lista. Nunca documentos, y nunca información delicada.',
  ],
  sms_optin_disclosure: [
    'By turning this on, you agree that Soto Accounting LLC may send you account and service text messages at the number below. Message frequency varies. Message and data rates may apply. Consent is NOT a condition of any service — everything still reaches you by email and in this portal. Reply STOP any time to stop, or switch this off here.',
    'Al activarlo, usted acepta que Soto Accounting LLC le envíe mensajes de texto sobre su cuenta y servicios al número de abajo. La frecuencia varía. Pueden aplicar tarifas de mensajes y datos. El consentimiento NO es condición para ningún servicio — todo le llega igual por correo y en este portal. Responda STOP en cualquier momento para detenerlos, o desactívelo aquí.',
  ],
  sms_optin_phone: ['Mobile number for texts', 'Número de celular para textos'],
  sms_optin_agree: ['Yes, text me about my account', 'Sí, envíenme textos sobre mi cuenta'],
  sms_optin_on: ['Texts are on', 'Los textos están activados'],
  sms_optin_turn_off: ['Turn texts off', 'Desactivar los textos'],
  sms_optin_skip: ['No thanks', 'No, gracias'],
  sms_optin_off_note: [
    'Texts are off. Everything still reaches you by email and here in the portal.',
    'Los textos están desactivados. Todo le llega igual por correo y aquí en el portal.',
  ],
  sms_optin_phone_required: [
    'Add a mobile number first so we know where to text.',
    'Agregue primero un número de celular para saber a dónde enviar.',
  ],

  // Hilo workshops (M27). A full workshop offers the waitlist, never a dead end.
  event_register: ['Register', 'Inscribirse'],
  event_join_waitlist: ['Join the waitlist', 'Unirse a la lista de espera'],
  event_seats_left: ['Seats left', 'Lugares disponibles'],
  event_full: [
    'This workshop is full — join the waitlist and we’ll tell you if a seat opens.',
    'Este taller está lleno — únase a la lista de espera y le avisamos si se abre un lugar.',
  ],
  event_virtual: ['online', 'en línea'],
  event_cancelled: ['This workshop has been cancelled.', 'Este taller fue cancelado.'],
  event_first_name: ['First name', 'Nombre'],
  event_last_name: ['Last name', 'Apellido'],
  event_email: ['Email', 'Correo electrónico'],
  event_phone: ['Phone (optional)', 'Teléfono (opcional)'],
  event_sms_optin: [
    'Text me a reminder the day before. Message and data rates may apply; reply STOP any time. Not required to attend.',
    'Envíenme un recordatorio por texto el día anterior. Pueden aplicar tarifas de mensajes y datos; responda STOP en cualquier momento. No es obligatorio para asistir.',
  ],
  event_confirmed_title: ['You’re registered', 'Está inscrito(a)'],
  event_confirmed_body: [
    'We emailed your confirmation. If you can’t make it, reply to that email and we’ll free your seat for someone else.',
    'Le enviamos la confirmación por correo. Si no puede asistir, responda a ese correo y liberamos su lugar para otra persona.',
  ],
  event_waitlisted_title: ['You’re on the waitlist', 'Está en la lista de espera'],
  event_waitlisted_body: [
    'The workshop is full, but we’ll email you if a seat opens. Your position:',
    'El taller está lleno, pero le avisamos por correo si se abre un lugar. Su lugar en la lista:',
  ],
  event_not_found_title: ['We couldn’t find that workshop', 'No encontramos ese taller'],
  event_not_found_body: [
    'The link may be old, or the workshop may not be open for registration yet.',
    'El enlace puede estar vencido, o el taller todavía no está abierto para inscripciones.',
  ],

  // IRS notices, client-facing (M28). A letter from the IRS is frightening; this
  // copy is calm and specific, and never implies the client must act alone.
  nav_notices: ['IRS Letters', 'Cartas del IRS'],
  notices_title: ['IRS letters', 'Cartas del IRS'],
  notices_none: [
    'No IRS letters on your account.',
    'No hay cartas del IRS en su cuenta.',
  ],
  notices_none_hint: [
    'If one arrives, upload it here or text us a photo and we’ll take it from there — you don’t need to know what it means first.',
    'Si le llega una, súbala aquí o mándenos una foto por mensaje y nosotros seguimos — no necesita entenderla primero.',
  ],
  notice_state_working: ['We’re on it.', 'Ya lo estamos atendiendo.'],
  notice_state_sent: [
    'Our response has been sent to the IRS. Waiting on them now.',
    'Nuestra respuesta ya se envió al IRS. Ahora esperamos su contestación.',
  ],
  notice_state_resolved: ['Resolved — nothing further needed.', 'Resuelto — no se necesita nada más.'],
  notice_response_due: ['Response due', 'Respuesta debe enviarse antes del'],
  notice_received: ['We received it', 'Lo recibimos el'],
  notices_upload_hint: [
    'If more pages arrive for the same letter, upload them under Documents. Never email or text the pages — the portal keeps them encrypted.',
    'Si llegan más páginas de la misma carta, súbalas en Documentos. No las envíe por correo ni por mensaje — el portal las guarda cifradas.',
  ],

  // Public intake / questionnaire chrome (M28). The QUESTIONS live in the form
  // definition so Brian edits them without a deploy; these are the buttons and
  // scaffolding around them.
  intake_progress: ['Step', 'Paso'],
  intake_next: ['Continue', 'Continuar'],
  intake_back: ['Back', 'Atrás'],
  intake_submit: ['Send it', 'Enviar'],
  intake_choose: ['Choose one…', 'Elija una…'],
  intake_yes: ['Yes', 'Sí'],
  intake_no: ['No', 'No'],
  intake_required: ['We need this one.', 'Necesitamos esta respuesta.'],
  intake_fix_below: [
    'Almost — a couple of answers need a look.',
    'Ya casi — un par de respuestas necesitan revisión.',
  ],
  intake_add_another: ['Add another', 'Agregar otro'],
  intake_remove: ['Remove', 'Quitar'],
  intake_saved_note: [
    'Your answers save as you go, so you can close this and come back.',
    'Sus respuestas se guardan solas, así que puede cerrar y volver después.',
  ],
  intake_done_title: ['Got it — thank you', 'Listo — gracias'],
  intake_done_body: [
    'We have what we need to prepare for our conversation. Nothing else is needed from you right now.',
    'Ya tenemos lo necesario para preparar nuestra conversación. No necesitamos nada más de usted por ahora.',
  ],
  intake_done_next: [
    'Watch your email — we will confirm next steps there, in the language you chose.',
    'Revise su correo — le confirmamos los siguientes pasos ahí, en el idioma que eligió.',
  ],
  intake_unavailable_title: ['This form isn’t available', 'Este formulario no está disponible'],
  intake_unavailable_body: [
    'The link may be old. Reply to any email from us and we will send you a current one.',
    'El enlace puede estar vencido. Responda a cualquiera de nuestros correos y le enviamos uno vigente.',
  ],

  // The engagement packet, signed here in the portal (E-SIGN / UETA).
  packet_title: ['Your engagement agreement', 'Su acuerdo de compromiso'],
  packet_intro: [
    'This is the agreement for the services you asked for. Read it, then sign at the bottom. It takes a minute.',
    'Este es el acuerdo para los servicios que solicitó. Léalo y fírmelo al final. Toma un minuto.',
  ],
  packet_includes: ['What this covers', 'Qué cubre'],
  packet_signed_title: ['Signed — thank you', 'Firmado — gracias'],
  packet_signed_body: [
    'We have your signed agreement. A copy is in your Documents, and nothing else is needed here.',
    'Tenemos su acuerdo firmado. Hay una copia en Documentos y no necesita hacer nada más aquí.',
  ],
  packet_name_label: ['Type your full name to sign', 'Escriba su nombre completo para firmar'],
  packet_sign_button: ['Sign the agreement', 'Firmar el acuerdo'],
  packet_signing: ['Signing…', 'Firmando…'],
  packet_changed: [
    'The agreement changed while you had it open, so nothing was signed. Reload the page and read the current version — we will not bind you to text you did not see.',
    'El acuerdo cambió mientras lo tenía abierto, así que no se firmó nada. Recargue la página y lea la versión actual — no lo vincularemos a un texto que no vio.',
  ],
  packet_reload: ['Reload and read again', 'Recargar y leer de nuevo'],
  packet_name_required: ['Please type your full name.', 'Por favor escriba su nombre completo.'],
  packet_affirm_required: [
    'Please confirm both statements before signing.',
    'Por favor confirme ambas declaraciones antes de firmar.',
  ],

  // Service Schedules (legal package v3). A client signs the Master once; a
  // service added later needs only its own schedule accepted here.
  schedules_title: ['One more thing to agree to', 'Un punto más por aceptar'],
  schedules_intro: [
    'You have already signed your Master Engagement Agreement, so there is nothing to re-sign. A service we added since then has its own terms — read them and accept below.',
    'Ya firmó su Acuerdo Maestro de Compromiso, así que no hay nada que volver a firmar. Un servicio que agregamos después tiene sus propios términos — léalos y acéptelos abajo.',
  ],
  schedules_accept: ['I have read this and I agree', 'Lo he leído y estoy de acuerdo'],
  schedules_accepted: ['Accepted', 'Aceptado'],
  schedules_accepted_on: ['Accepted', 'Aceptado'],

  // §7216 consents — optional, never a condition of service.
  consents_title: ['Two optional permissions', 'Dos permisos opcionales'],
  consent_optional: [
    'Optional. Saying no changes nothing about your service.',
    'Opcional. Decir no no cambia nada de su servicio.',
  ],
  consent_yes: ['Yes, you have my permission', 'Sí, tiene mi permiso'],
  consent_no: ['No, thank you', 'No, gracias'],
  consent_recorded_yes: ['Permission given. You can withdraw it any time.', 'Permiso otorgado. Puede retirarlo cuando quiera.'],
  consent_recorded_no: ['Noted — we will not ask again.', 'Anotado — no volveremos a preguntar.'],
  consent_en_only: [
    '',
    'Este texto legal se muestra en inglés porque la versión en inglés es la que rige. La traducción está en revisión y se la enviaremos cuando esté aprobada.',
  ],

  loading: ['Loading…', 'Cargando…'],
  error_generic: ['Something went wrong. Please try again.', 'Algo salió mal. Intente de nuevo.'],
} satisfies Record<string, [string, string]>;

export type DictKey = keyof typeof dict;

export function translate(lang: Lang, key: DictKey): string {
  const entry = dict[key];
  return lang === 'es' ? entry[1] : entry[0];
}
