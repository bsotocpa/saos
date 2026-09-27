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
  login_same_address: ['Use the email address you first signed up with.', 'Use el correo electrónico con el que se registró por primera vez.'],
  verify_intro: ['Press the button to finish signing in.', 'Pulse el botón para terminar de entrar.'],
  verify_press: ['Sign in', 'Entrar'],
  verify_working: ['Signing you in…', 'Iniciando sesión…'],
  verify_failed: ['This link is invalid, used, or expired. Request a fresh one below.', 'Este enlace es inválido, usado o vencido. Pida uno nuevo abajo.'],
  // The sign-in email move, confirmed at the new address by a press (R45, 2026-09-26). Functional copy only.
  confirm_email_title: ['Confirm your new sign-in email', 'Confirme su nuevo correo de acceso'],
  confirm_email_intro: ['Your email on file changed. Press the button to sign in with this address from now on.', 'Su correo registrado cambió. Pulse el botón para entrar con esta dirección de ahora en adelante.'],
  confirm_email_press: ['Use this email to sign in', 'Usar este correo para entrar'],
  confirm_email_working: ['Updating your sign-in…', 'Actualizando su acceso…'],
  confirm_email_done: ['Done. From now on, sign in with this email address.', 'Listo. De ahora en adelante, entre con este correo electrónico.'],
  confirm_email_failed: ['This link is invalid, used, or expired. Write to us and we will send a new one.', 'Este enlace es inválido, usado o vencido. Escríbanos y le enviamos uno nuevo.'],

  // Dashboard
  home_title: ['Welcome back', 'Bienvenido(a) de nuevo'],
  checklist_title: ['Let’s get you set up', 'Pongamos todo en marcha'],
  // Reordered 2026-08-13: deposit second, booking removed, 'prior-year return'
  // renamed because clients send far more than last year's return.
  checklist_sign: ['Sign your documents', 'Firme sus documentos'],
  checklist_deposit: ['Pay your deposit', 'Pague su depósito'],
  checklist_confirm: ['Confirm your information', 'Confirme su información'],
  checklist_upload: ['Upload your documents', 'Suba sus documentos'],
  checklist_track: ['Track your services', 'Siga el avance de sus servicios'],
  checklist_track_note: [
    'Work usually starts within two business days. You can watch each service move along below.',
    'El trabajo suele comenzar dentro de dos días hábiles. Puede seguir el avance de cada servicio abajo.',
  ],
  checklist_deposit_waiting: ['Waiting on payment', 'Pendiente de pago'],
  checklist_go: ['Go', 'Ir'],
  /*
   * Steps 3 and 6 of the canonical journey (#34, 2026-08-16).
   *
   * The consent step names what it is — permission, which the client can refuse. It
   * does NOT say "give us permission", because §7216 is a rule against making service
   * depend on consent, and a checklist that reads like an instruction to consent is the
   * same pressure in a different place. Answering it either way completes the step.
   */
  checklist_consent: ['Answer the privacy permissions', 'Responda los permisos de privacidad'],
  checklist_consent_waiting: ['Waiting on your answer', 'Pendiente de su respuesta'],
  checklist_questionnaire_waiting: ['Waiting on your answers', 'Pendiente de sus respuestas'],
  checklist_book: ['Book your kickoff call', 'Reserve su llamada de inicio'],
  checklist_book_waiting: ['Waiting on your booking', 'Pendiente de su reserva'],
  checklist_optional: ['optional', 'opcional'],
  /*
   * Step 4 of the canonical journey (#30/#31 split, 2026-08-15). The onboarding-voice
   * questionnaire, assembled from the client's own services and industry.
   *
   * The copy says WHY it is being asked — these questions scope the work, they are not
   * a form for its own sake — and it never treats the reader as someone being rescued.
   */
  checklist_questionnaire: ['Answer a few questions about your business', 'Responda unas preguntas sobre su negocio'],
  quest_title: ['A few questions about how you work', 'Unas preguntas sobre cómo trabaja'],
  quest_resumed: [
    'Welcome back — we picked up where you left off.',
    'Bienvenido(a) de nuevo — continuamos donde lo dejó.',
  ],
  quest_saved_note: [
    'Your answers save as you go, so you can close this and come back. Skip anything you are unsure about — we can fill it in together.',
    'Sus respuestas se guardan solas, así que puede cerrar y volver después. Salte lo que no tenga claro — lo completamos juntos.',
  ],
  quest_done_title: ['Thank you — that is everything we needed', 'Gracias — eso es todo lo que necesitábamos'],
  quest_done_body: [
    'Your answers are with your team. They shape how we set up your books, your filings and your calendar, so nothing here gets asked twice.',
    'Sus respuestas ya están con su equipo. Con ellas configuramos sus libros, sus presentaciones y su calendario, para no volver a preguntarle lo mismo.',
  ],
  /*
   * #27 — the questionnaire opens with what we already hold, prefilled and correctable.
   * This is what replaced the separate "Confirm your information" step: the copy says we
   * already have these, so the client is checking rather than filling a form again.
   */
  quest_details_title: ['Your details', 'Sus datos'],
  quest_details_intro: [
    'These are what we have on file. Change anything that is out of date.',
    'Esto es lo que tenemos registrado. Corrija lo que ya no esté al día.',
  ],
  quest_first_name: ['First name', 'Nombre'],
  quest_last_name: ['Last name', 'Apellido'],
  quest_phone: ['Mobile number', 'Número de celular'],
  quest_address: ['Street address', 'Dirección'],
  quest_city: ['City', 'Ciudad'],
  quest_state: ['State', 'Estado'],
  quest_zip: ['ZIP code', 'Código postal'],
  quest_language: ['Language we should use with you', 'Idioma que debemos usar con usted'],
  quest_preferred: ['Best way to reach you', 'Mejor forma de contactarlo(a)'],
  quest_pref_text: ['Text', 'Texto'],
  quest_pref_email: ['Email', 'Correo electrónico'],
  quest_pref_phone: ['Phone', 'Teléfono'],
  quest_pref_portal: ['Portal', 'Portal'],
  // R45 (2026-09-26): this prints the CONTACT email of record, which every message we send goes to.
  // It is not necessarily the sign-in address, so the label must not call it that.
  quest_email_fixed: [
    'Your email on file — write to us to change it:',
    'Su correo registrado — escríbanos para cambiarlo:',
  ],
  /*
   * #45 — a completed questionnaire is not a one-way door.
   *
   * The copy treats a correction as ordinary rather than exceptional: people mistype
   * revenue and forget a state, and a client who has to write to us about that is a
   * client the portal failed. It never implies they got it wrong the first time.
   */
  action_review_answers: ['Review your answers', 'Revisar sus respuestas'],
  action_answer_questions: ['Answer your questions', 'Responder sus preguntas'],
  quest_review_title: ['Your answers', 'Sus respuestas'],
  quest_review_intro: [
    'Here is what you told us. Change anything that has moved on — it takes effect straight away.',
    'Esto es lo que nos dijo. Cambie lo que ya no aplique — surte efecto de inmediato.',
  ],
  quest_review_note: [
    'Changes save when you reach the end. Nothing here needs to be re-done.',
    'Los cambios se guardan al llegar al final. No hay que volver a hacer nada.',
  ],
  quest_save_changes: ['Save changes', 'Guardar cambios'],
  quest_saved: ['Saved — your team sees the update.', 'Guardado — su equipo ve la actualización.'],
  quest_can_revisit: [
    'You can come back and change any of this whenever something moves on.',
    'Puede volver y cambiar cualquiera de esto cuando algo cambie.',
  ],
  quest_none_title: ['Nothing to answer right now', 'Nada que responder por ahora'],
  quest_none_body: [
    'These questions are built from the services you have with us. When a new service starts, the questions that go with it will appear here.',
    'Estas preguntas se arman según los servicios que tiene con nosotros. Cuando comience un servicio nuevo, aquí aparecerán las preguntas que le corresponden.',
  ],
  back_home: ['Back to your portal', 'Volver a su portal'],
  // Estimated payment due — its own container (Brian, 2026-08-13): the amount, where
  // to pay it, and a way to ask whether it is still the right number.
  estdue_title: ['Estimated payment due', 'Pago estimado'],
  estdue_intro: [
    'This is what we projected for this quarter. Pay it directly to the agencies — we never take estimated payments on your behalf.',
    'Esto es lo que proyectamos para este trimestre. Páguelo directamente a las agencias — nunca hacemos pagos estimados en su nombre.',
  ],
  estdue_pay_irs: ['Pay the IRS', 'Pagar al IRS'],
  estdue_pay_state: ['Pay Illinois', 'Pagar a Illinois'],
  estdue_review: ['Something changed? Book a session', '¿Algo cambió? Reserve una sesión'],
  estdue_review_note: [
    'A new job, a baby, a house, a big invoice — any of those can change this number. Better to adjust it now than in April.',
    'Un nuevo trabajo, un bebé, una casa, una factura grande — cualquiera de esos puede cambiar esta cifra. Mejor ajustarla ahora que en abril.',
  ],
  qa_schedule: ['Schedule a call or meeting', 'Agende una llamada o reunión'],
  doc_withdraw: ['Remove', 'Quitar'],
  doc_withdraw_confirm: [
    'Remove this file? It stops counting toward anything we asked you for, and we will not work from it. Your record still shows it was sent, so nothing goes missing.',
    '¿Quitar este archivo? Dejará de contar para lo que le pedimos y no trabajaremos con él. Su expediente seguirá mostrando que lo envió, así que nada se pierde.',
  ],
  checklist_done: ['Done', 'Listo'],
  checklist_mark_done: ['Mark done', 'Marcar listo'],
  status_title: ['Your returns', 'Sus declaraciones'],
  status_deadline: ['Deadline', 'Fecha límite'],
  status_extended: ['Extended', 'Con extensión'],
  /*
   * #35 — home becomes projects + progress + scheduling.
   *
   * "Your returns" was the old heading and it was tax-only, in a section that was itself
   * tax-only. A bookkeeping client has work with us too, and it belongs on their home.
   *
   * The service-line names are the CLIENT's words for what they buy, not the internal
   * enum: "Bookkeeping", not "bookkeeping"; "Reviews and audits", not "attest".
   */
  projects_title: ['Your work with us', 'Su trabajo con nosotros'],
  svcline_tax: ['Taxes', 'Impuestos'],
  svcline_bookkeeping: ['Bookkeeping', 'Contabilidad'],
  svcline_payroll: ['Payroll', 'Nómina'],
  svcline_sales_tax: ['Sales tax', 'Impuesto sobre ventas'],
  svcline_advisory: ['Advisory', 'Asesoría'],
  svcline_coo: ['Operations support', 'Apoyo operativo'],
  svcline_entity: ['Entity setup and changes', 'Constitución y cambios de entidad'],
  svcline_attest: ['Reviews and audits', 'Revisiones y auditorías'],
  svcline_specialized_cpa: ['Specialized CPA work', 'Trabajo especializado de CPA'],
  svcline_nonprofit_cfo: ['Nonprofit CFO', 'CFO para organizaciones sin fines de lucro'],
  /*
   * Status for ONGOING services. No progress bar and no stage: bookkeeping does not
   * finish, so the honest thing to show is whether it is running.
   */
  estatus_active: ['Running', 'En marcha'],
  estatus_on_hold: ['Paused', 'En pausa'],
  estatus_completed: ['Finished', 'Terminado'],
  estatus_draft: ['Being set up', 'En preparación'],
  estatus_withdrawn: ['Closed', 'Cerrado'],
  // Scheduling — real bookings, because the system only shows what it actually has.
  sched_title: ['Meetings', 'Reuniones'],
  sched_none: [
    'Nothing on the calendar with us right now.',
    'No hay nada en el calendario con nosotros por ahora.',
  ],
  sched_book: ['Book a meeting', 'Reservar una reunión'],
  sched_time_tbd: ['Time to be confirmed', 'Hora por confirmar'],
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
  docs_choose: ['Choose files (photos work great)', 'Elija archivos (las fotos funcionan perfecto)'],
  docs_category: ['Category', 'Categoría'],
  // R47 (2026-09-26): the category starts unselected; a file chosen before one is picked is refused here, not sent.
  docs_category_placeholder: ['Choose a category', 'Elija una categoría'],
  docs_category_required: ['Choose a category first, then pick your files.', 'Elija una categoría primero y luego sus archivos.'],
  docs_empty: ['Nothing uploaded yet. Files you send us appear here.', 'Aún no hay archivos. Los que nos envíe aparecerán aquí.'],
  docs_file_uploaded: ['uploaded', 'subido'],
  cat_tax_documents: ['Tax documents', 'Documentos de impuestos'],
  cat_business_records: ['Business records', 'Registros del negocio'],
  cat_id_verification: ['ID verification', 'Verificación de identidad'],
  cat_irs_notices: ['IRS notice', 'Aviso del IRS'],
  cat_other: ['Other', 'Otro'],
  cat_entity_filings: ['Entity filings', 'Documentos de la entidad'],
  /*
   * THE STAFF-FILED CATEGORIES (R49, 2026-09-26). The five above are what a CLIENT may pick; the
   * list below is what the firm files on a client's behalf, and every one of them reaches the
   * Documents page through GET /portal/documents. The page used to look each row's category up
   * here with no entry for these, and translate() threw on the first staff-filed row — the
   * client-side exception on Brian's own account (a signed engagement letter and a delivered
   * return). Every value of the database enum document_category now has a label, and the page
   * goes through docCategoryLabel() (lib/documents.ts), which never throws on a value it has not
   * met.
   */
  cat_signed_authorizations: ['Signed authorizations', 'Autorizaciones firmadas'],
  cat_return_deliverable: ['Completed return', 'Declaración terminada'],
  cat_recording: ['Session recording', 'Grabación de sesión'],
  cat_financial_statements: ['Financial statements', 'Estados financieros'],
  cat_mailing_receipts: ['Mailing receipts', 'Comprobantes de envío'],
  docs_uploaded: ['Uploaded — thank you!', '¡Subido — gracias!'],
  docs_for_request: ['This fulfills:', 'Esto corresponde a:'],
  doc_status_uploaded: ['Received', 'Recibido'],
  doc_status_under_review: ['Under review', 'En revisión'],
  doc_status_accepted: ['Accepted', 'Aceptado'],
  doc_status_needs_replacement: ['Needs replacement', 'Necesita reemplazo'],
  doc_status_archived: ['Archived', 'Archivado'],
  download: ['Download', 'Descargar'],

  // Returns
  returns_title: ['My Returns', 'Mis declaraciones'],
  returns_intro: ['Your filed returns, available any time.', 'Sus declaraciones presentadas, disponibles en todo momento.'],
  returns_empty: ['Your returns will appear here once they’re ready.', 'Sus declaraciones aparecerán aquí cuando estén listas.'],
  /*
   * WHAT HAPPENS NEXT (R48, Brian, 2026-09-26): one sentence per state of the return the delivered
   * copy belongs to, read from the return record and the R53 "8879 sent" fields. Plain words, no
   * legal language; the keys mirror GET /portal/returns next_step.
   */
  returns_next_title: ['What happens next', 'Qué sigue'],
  returns_next_f8879_pending: ['Your return is ready to review. We will send Form 8879 for your signature next.', 'Su declaración está lista para revisar. A continuación le enviaremos el Formulario 8879 para su firma.'],
  returns_next_f8879_adobe_sign: ['Look for an email from Adobe Sign with your Form 8879. Your return is filed once you sign.', 'Busque un correo de Adobe Sign con su Formulario 8879. Su declaración se presenta en cuanto firme.'],
  returns_next_f8879_in_office: ['Sign Form 8879 at your visit; your return is filed once you sign.', 'Firme el Formulario 8879 en su visita; su declaración se presenta en cuanto firme.'],
  returns_next_f8879_mailed: ['Form 8879 is in the mail to you; sign and return it and we file.', 'El Formulario 8879 va en camino por correo; fírmelo, devuélvalo y presentamos su declaración.'],
  returns_next_f8879_sent: ['Form 8879 is on its way to you for signature; your return is filed once you sign.', 'El Formulario 8879 va en camino para su firma; su declaración se presenta en cuanto firme.'],
  returns_next_f8879_on_file: ['We have your signed Form 8879 and are filing your return.', 'Tenemos su Formulario 8879 firmado y estamos presentando su declaración.'],
  returns_next_filed: ['Filed. We will let you know when it is accepted.', 'Presentada. Le avisaremos cuando sea aceptada.'],
  returns_next_accepted: ['Accepted.', 'Aceptada.'],
  // The completed line reads per declared jurisdiction (R48, Brian's words): {{where}} is the IRS or the
  // state's name in the reader's language (lib/states.ts), {{date}} the calendar day through formatDate.
  returns_next_accepted_by: ['Accepted by {{where}} on {{date}}.', 'Aceptada por {{where}} el {{date}}.'],
  returns_next_mailed_to: ['Mailed to {{where}} on {{date}}.', 'Enviada por correo a {{where}} el {{date}}.'],
  jurisdiction_irs: ['the IRS', 'el IRS'],

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
  // R46 (2026-09-26): a signed envelope reads the day it was signed, never "Being prepared".
  env_status_signed_on: ['Signed on {date}', 'Firmado el {date}'],

  // Invoices
  inv_title: ['Invoices & Payments', 'Facturas y pagos'],
  inv_pay: ['Pay now', 'Pagar ahora'],
  inv_paid: ['Paid', 'Pagada'],
  inv_open: ['Open', 'Pendiente'],
  inv_overdue: ['Past due', 'Vencida'],
  inv_empty: ['No invoices yet.', 'Aún no hay facturas.'],
  inv_paying: ['Opening checkout…', 'Abriendo el pago…'],
  // Marks the invoice the email linked to, so a client who followed the link can see
  // they are looking at the right one.
  inv_from_email: ['from your email', 'de su correo'],

  // Security (finding #13). Sessions last 30 days and slide with use, so the shared or
  // borrowed device needs its own answer rather than shorter sessions for everyone.
  sec_title: ['Security', 'Seguridad'],
  sec_help: [
    'You stay signed in on this device for 30 days. If you signed in on a shared or borrowed device — a work computer, a family tablet — you can end every session everywhere at once. You will need a new sign-in link afterwards.',
    'Su sesión permanece activa en este dispositivo durante 30 días. Si inició sesión en un dispositivo compartido o prestado — una computadora del trabajo, una tableta familiar — puede cerrar todas las sesiones a la vez. Después necesitará un nuevo enlace de acceso.',
  ],
  sec_sign_out_all: ['Sign out everywhere', 'Cerrar sesión en todos los dispositivos'],
  sec_signing_out: ['Signing out…', 'Cerrando sesión…'],
  sec_done: [
    'Signed out on every device. Enter your email on the sign-in page for a fresh link.',
    'Sesión cerrada en todos los dispositivos. Ingrese su correo en la página de acceso para recibir un enlace nuevo.',
  ],
  // The return from Stripe. Three honest states — never a blank screen (finding #23).
  inv_confirming: ['Confirming your payment…', 'Confirmando su pago…'],
  inv_paid_notice: ['Payment received. Thank you.', 'Pago recibido. Gracias.'],
  inv_paid_pending: [
    'We do not have confirmation from the payment processor yet. If you completed the payment it will appear here shortly — nothing further is needed from you.',
    'Todavía no tenemos la confirmación del procesador de pagos. Si completó el pago, aparecerá aquí en unos minutos; no necesita hacer nada más.',
  ],

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
  method_email: ['Email', 'Correo electrónico'],
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
  // 2026-09-09: money that went back is shown as such — a refunded invoice never reads Paid.
  inv_refunded: ['Refunded', 'Reembolsada'],
  inv_partially_refunded: ['Partly refunded', 'Parcialmente reembolsada'],
  inv_disputed: ['Under review', 'En revisi\u00f3n'],
  inv_void: ['Cancelled', 'Anulada'],

  // The pay page (2026-09-09): one invoice, no login. The reader is paying, not being sold to.
  pay_title: ['Pay your invoice', 'Pague su factura'],
  pay_invoice: ['Invoice', 'Factura'],
  pay_due: ['Due', 'Vence'],
  pay_button: ['Pay now', 'Pagar ahora'],
  pay_secure: [
    'You will pay on a secure Stripe page. We never see your card.',
    'Pagar\u00e1 en una p\u00e1gina segura de Stripe. Nunca vemos su tarjeta.',
  ],
  pay_confirming: ['Confirming your payment\u2026', 'Confirmando su pago\u2026'],
  pay_paid_title: ['Payment received \u2014 thank you', 'Pago recibido \u2014 gracias'],
  pay_paid_body: [
    'Your receipt is on its way by email. Nothing further is needed from you.',
    'Su recibo va en camino por correo. No se necesita nada m\u00e1s de usted.',
  ],
  pay_pending: [
    'We do not have confirmation from the payment processor yet. If you completed the payment it will show here shortly.',
    'A\u00fan no tenemos confirmaci\u00f3n del procesador de pagos. Si complet\u00f3 el pago, aparecer\u00e1 aqu\u00ed en breve.',
  ],
  pay_unavailable_title: ['This invoice is no longer payable', 'Esta factura ya no se puede pagar'],
  pay_unavailable_body: [
    'The link may have expired, or the invoice may have been paid or cancelled. If you believe you still owe something, reply to our email and we will send a current link.',
    'El enlace puede haber vencido, o la factura puede haber sido pagada o anulada. Si cree que a\u00fan debe algo, responda a nuestro correo y le enviamos un enlace vigente.',
  ],
  quote_title: ['Your proposal', 'Su propuesta'],
  quote_intro: [
    'Here is exactly what we would do and what it costs. Nothing is charged until you accept.',
    'Esto es exactamente lo que haríamos y cuánto cuesta. No se cobra nada hasta que usted acepte.',
  ],
  quote_included: ['Included', 'Incluido'],
  quote_tax_year: ['Tax year', 'Año fiscal'],
  quote_tax_year_interview: ['from your answers', 'según sus respuestas'],
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
  // The deposit, on the proposal itself — not discovered after accepting. "Applied" is
  // literal: billing/deposit-credit.ts credits a paid deposit against the invoice that follows.
  quote_deposit: ['Deposit to start the work', 'Depósito para iniciar el trabajo'],
  quote_deposit_note: [
    'Invoiced by email when you accept, and applied to your final invoice. Nothing is charged before you accept.',
    'Se factura por correo cuando usted acepta y se aplica a su factura final. No se cobra nada antes de que acepte.',
  ],
  quote_deposit_waived: ['Waived — no deposit is asked for', 'Exonerado — no se pide depósito'],
  quote_deposit_reduced_from: ['reduced from', 'reducido de'],
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
  // "Within a few minutes" is backed by OUTBOX_SWEEP_MS (60s) in the API — the number that
  // makes this sentence true. It used to say "on its way" over a fifteen-minute tick.
  quote_accepted_deposit: [
    'Your deposit invoice arrives by email within a few minutes. The work is already queued.',
    'Su factura de depósito le llega por correo en unos minutos. El trabajo ya está en cola.',
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
  // This string promised "close this and come back" for months while the page threw
  // the resume token away on every reload. As of 2026-08-15 it is true.
  intake_saved_note: [
    'Your answers save as you go, so you can close this and come back.',
    'Sus respuestas se guardan solas, así que puede cerrar y volver después.',
  ],
  intake_resumed: [
    'Welcome back — we picked up where you left off.',
    'Bienvenido(a) de nuevo — continuamos donde lo dejó.',
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

  // The dedicated §7216 consent screen (Rev. Proc. 2013-14: content solely about
  // the consent). Duration is stated because the rule requires it.
  consent_duration_label: ['How long this lasts:', 'Cuánto dura:'],
  consent_duration_body: [
    'One year from the date you agree, unless you withdraw it sooner. You can withdraw it at any time by telling us — in the portal, by email, or by phone.',
    'Un año desde la fecha en que acepte, a menos que lo retire antes. Puede retirarlo en cualquier momento avisándonos — en el portal, por correo o por teléfono.',
  ],
  consent_none_title: ['Nothing to decide', 'Nada por decidir'],
  consent_done_body: [
    'There is nothing waiting for you here. Thank you.',
    'No hay nada pendiente aquí. Gracias.',
  ],
  consent_continue: ['Back to my checklist', 'Volver a mi lista'],

  // Onward path from the signature (finding #10) — the signature must not dead-end.
  packet_signed_next_checklist: ['Back to my checklist', 'Volver a mi lista'],
  packet_signed_next_consent: ['Continue', 'Continuar'],

  // Checklist step 4 when scheduling is not open yet (finding #9): say so rather
  // than routing the client to the wrong page.
  checklist_step4_unavailable: [
    'Scheduling is not open yet — we will reach out to set this up.',
    'Las citas aún no están abiertas — nos comunicaremos para coordinarla.',
  ],
  // Shown between the Spanish and English renderings of a §7216 consent. Brian's
  // ruling after attorney review: bilingual, with English operative. The Spanish is for
  // comprehension; the English is the consent.
  english_governs: [
    'The English version governs. The Spanish is provided for your convenience.',
    'La versión en inglés es la que rige. El texto en español se proporciona para su comodidad.',
  ],

  // Attachments in Messages (finding #11). The copy says where the file GOES —
  // a client sending a W-2 in chat should know it lands in their documents.
  msg_attach_label: ['Attach a file (optional)', 'Adjuntar un archivo (opcional)'],
  msg_attach_category: ['What kind of document is it?', '¿Qué tipo de documento es?'],
  msg_attach_where: [
    'It will be saved securely to your Documents and we will see it here in the conversation. Photos from your phone are fine.',
    'Se guardará de forma segura en sus Documentos y lo veremos aquí en la conversación. Las fotos desde su teléfono funcionan bien.',
  ],
  msg_send_with_file: ['Send file', 'Enviar archivo'],
  msg_sending: ['Sending…', 'Enviando…'],
  msg_open_attachment: ['Open attachment', 'Abrir archivo adjunto'],

  loading: ['Loading…', 'Cargando…'],
  error_generic: ['Something went wrong. Please try again.', 'Algo salió mal. Intente de nuevo.'],

  // The page-level error boundary (R49): one plain sentence and a reload control. Nothing about
  // what failed is shown to the client; the failure itself is posted to the firm.
  error_page_sentence: ['This page could not be shown. Reloading usually fixes it, and we have been told.', 'Esta página no se pudo mostrar. Recargar suele resolverlo, y ya se nos avisó.'],
  error_page_reload: ['Reload', 'Recargar'],
} satisfies Record<string, [string, string]>;

export type DictKey = keyof typeof dict;

export function translate(lang: Lang, key: DictKey): string {
  const entry = dict[key];
  return lang === 'es' ? entry[1] : entry[0];
}

/**
 * Whether a string built at runtime (`cat_${row.category}`) names an entry. translate() takes a
 * DictKey the compiler has checked; a key assembled from a database value is not one until this
 * says so (R49: the Documents page asserted the type and the page died on the first row).
 */
export function hasDictKey(key: string): key is DictKey {
  return Object.prototype.hasOwnProperty.call(dict, key);
}

/*
 * THE DOCUMENT ROW'S LABELS (R49, Brian, 2026-09-26).
 *
 * GET /portal/documents returns every non-withdrawn, non-archived row of the client's, whoever
 * filed it: the client's own uploads AND what the firm files for them (a signed engagement
 * letter, a delivered return, a mailing receipt). The Documents page used to label a row with
 * `t(\`cat_${row.category}\`)`, asserting to the compiler that the assembled string was a
 * dictionary key. For the staff-filed categories it was not, and translate() threw on the first
 * such row: the client-side exception on Brian's own account, whose two documents were exactly
 * a signed authorization and a delivered return.
 *
 * These helpers are the only way a row's category or status reaches the screen. A known value
 * gets its translated label; a value the dictionary has not met (a category added by a later
 * migration before the portal learns its name) gets the value itself with its underscores turned
 * into spaces, and the page renders. They never throw. They live here, beside the dictionary,
 * so the node test can import one file (the portal's lib files carry no extension in their
 * imports, which Next resolves and node does not).
 */

/** 'signed_authorizations' -> 'Signed authorizations': readable, and honest about being untranslated. */
export function humanise(value: string): string {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export function docCategoryLabel(lang: Lang, category: string | null | undefined): string {
  const value = typeof category === 'string' ? category : '';
  const key = `cat_${value}`;
  return hasDictKey(key) ? translate(lang, key) : humanise(value);
}

export function docStatusLabel(lang: Lang, status: string | null | undefined): string {
  const value = typeof status === 'string' ? status : '';
  const key = `doc_status_${value}`;
  return hasDictKey(key) ? translate(lang, key) : humanise(value);
}

/** The row's status tone: the two statuses a client acts on or is reassured by, nothing else. */
export function docStatusTone(status: string | null | undefined): 'danger' | 'ok' | '' {
  return status === 'needs_replacement' ? 'danger' : status === 'accepted' ? 'ok' : '';
}

/*
 * ONE ROW PER DOCUMENT (Brian, 2026-09-26, R46).
 *
 * GET /portal/signature-envelopes returns every envelope of the client's, and two envelopes of one
 * type used to print as two identical rows ("Engagement letter", "Engagement letter") with nothing to
 * tell them apart. The API now names what each envelope belongs to (the business, or the return's
 * type and year); these fold envelopes of one type on one engagement into one row — the most
 * advanced status wins, because a signed copy beside a draft copy IS signed — and label the row with
 * its document and what it belongs to. Here beside the dictionary for the same reason as the
 * document labels above: one file for the node test to import.
 */
export interface Envelope {
  id: string;
  type: string;
  status: string;
  sent_at?: string | null;
  completed_at?: string | null;
  engagement_id?: string | null;
  service_line?: string | null;
  tax_year?: number | null;
  return_type?: string | null;
  business_name?: string | null;
}

/** Higher is further along: a signed copy outranks a sent one, which outranks a draft. */
const ENVELOPE_RANK: Record<string, number> = { draft: 0, kba_required: 1, kba_pending: 1, sent: 2, viewed: 3, completed: 4 };
const envelopeRank = (s: string): number => ENVELOPE_RANK[s] ?? 0;

/** One row per (type, engagement): the furthest-along envelope stands for the document. */
export function envelopeRows(envelopes: Envelope[]): Envelope[] {
  const byDocument = new Map<string, Envelope>();
  for (const e of envelopes) {
    const key = `${e.type}:${e.engagement_id ?? ''}`;
    const have = byDocument.get(key);
    if (!have || envelopeRank(e.status) > envelopeRank(have.status)) byDocument.set(key, e);
  }
  return [...byDocument.values()];
}

/** What the envelope belongs to, in the client's words: the business, or the return by type and year. */
export function envelopeContext(e: Envelope): string | null {
  if (e.business_name) return e.business_name;
  if (e.return_type && e.tax_year) return `${e.return_type.toUpperCase()} ${e.tax_year}`;
  if (e.tax_year) return String(e.tax_year);
  return null;
}

/**
 * "Engagement letter — Harness S Corp, LLC". A type the dictionary has not met (w9, grant_agreement,
 * other) reads as its words: hasDictKey first, never an asserted key — the R49 lesson.
 */
export function envelopeLabel(t: (key: DictKey) => string, e: Envelope): string {
  const key = `env_${e.type}`;
  const name = hasDictKey(key) ? t(key) : e.type.replace(/_/g, ' ');
  const context = envelopeContext(e);
  return context ? `${name} — ${context}` : name;
}
