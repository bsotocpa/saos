// Spanish bodies for the v3 legal package — PENDING BRIAN'S APPROVAL.
//
// These are written into templates.body_es while needs_es_review stays TRUE, so the
// render path keeps falling back to English until he approves each one in
// Admin → Templates. Approving is a per-template act with a confirm that says "this
// confirms you have READ the translation and it says what the English says" — that is
// deliberate and there is no bulk-approve shortcut, by design.
//
// TRANSLATION DECISIONS, stated so they can be argued with:
//
//   Master Engagement Agreement → Contrato Marco de Servicios Profesionales
//   Service Schedule            → Anexo de Servicios  ("Anexo", not "Cédula"/"Programa",
//                                 which read as tax-form or scheduling language)
//   engagement configuration    → configuración de su contrato
//   fee schedule                → tarifario vigente
//   late charge                 → recargo por mora
//   attest services             → servicios de atestiguamiento (AICPA usage)
//   limited / reasonable assurance → seguridad limitada / seguridad razonable
//   material misstatement       → incorrección material (IAASB/AICPA Spanish usage)
//   representation letter       → carta de representación
//   workpapers                  → papeles de trabajo
//
// Register names, statutes, agency names, form numbers, the TIGTA contact details and
// the firm's own address are LEFT IN ENGLISH on purpose: they are identifiers, and
// translating "Form 1023" or "Treasury Inspector General for Tax Administration" would
// make them harder to act on, not easier.
//
// Placeholders ({{like_this}}) are preserved byte for byte — a translated placeholder
// silently renders as literal text in a signed document.

const ES = {
  // ── §7216 consents ─────────────────────────────────────────────────────────
  // NOTE FOR BRIAN, repeated in the review file: these two contain language the IRS
  // PRESCRIBES. Translating mandated wording is a legal decision, not a linguistic one.
  consent_7216_disclose: {
    body: `CONSENTIMIENTO PARA LA DIVULGACIÓN DE INFORMACIÓN DE LA DECLARACIÓN DE IMPUESTOS (IRC §7216)

Este consentimiento se presenta por separado de sus documentos de contratación, es completamente opcional y no es condición para ningún servicio.

La ley federal exige que se le proporcione este formulario de consentimiento. Salvo autorización de la ley, no podemos divulgar la información de su declaración de impuestos a terceros para fines distintos de la preparación y presentación de su declaración sin su consentimiento. Si usted consiente la divulgación de la información de su declaración de impuestos, es posible que la ley federal no proteja dicha información contra usos o distribuciones posteriores.

No está obligado a completar este formulario para contratar nuestros servicios de preparación de declaraciones de impuestos. Si obtenemos su firma en este formulario condicionando nuestros servicios de preparación a su consentimiento, su consentimiento no será válido. Si usted acepta la divulgación de la información de su declaración de impuestos, su consentimiento es válido durante el plazo que usted especifique. Si no especifica la duración de su consentimiento, este será válido por un año a partir de la fecha de la firma.

Preparador que realiza la divulgación: Soto Accounting LLC, 4252 N. Cicero Ave., Chicago, IL 60641.

Destinatario: Hilo NFP (anteriormente DishRoulette Kitchen NFP), 917 W. 18th St., Chicago, IL 60606.

Información que se divulgará: su nombre, datos de contacto, nombre y tipo de su negocio o entidad, y una descripción general de sus necesidades contables, fiscales o de desarrollo empresarial.

Propósito: coordinar programas de desarrollo empresarial, educación, subvenciones y servicios de referencia ofrecidos por Hilo NFP para los que usted pueda ser elegible o que haya solicitado.

Duración del consentimiento: Este consentimiento es válido por un (1) año a partir de la fecha de la firma que aparece abajo, salvo que aquí se especifique un plazo distinto: ______________. Usted puede revocar este consentimiento en cualquier momento mediante aviso por escrito a Soto Accounting LLC.

Si considera que la información de su declaración de impuestos ha sido divulgada o utilizada indebidamente, de manera no autorizada por la ley o sin su permiso, puede comunicarse con el Treasury Inspector General for Tax Administration (TIGTA) por teléfono al 1-800-366-4484, o por correo electrónico a complaints@tigta.treas.gov.

Firma del cliente: ____________________________________    Fecha: ______________
Nombre en letra de molde / Entidad y cargo: ____________________________________
SOTO ACCOUNTING LLC — Por: ____________________________________`,
  },

  consent_7216_use: {
    body: `CONSENTIMIENTO PARA EL USO DE INFORMACIÓN DE LA DECLARACIÓN DE IMPUESTOS (IRC §7216)

Este consentimiento se presenta por separado de sus documentos de contratación, es completamente opcional y no es condición para ningún servicio.

La ley federal exige que se le proporcione este formulario de consentimiento. Salvo autorización de la ley, no podemos utilizar la información de su declaración de impuestos para fines distintos de la preparación y presentación de su declaración sin su consentimiento.

No está obligado a completar este formulario para contratar nuestros servicios de preparación de declaraciones de impuestos. Si obtenemos su firma en este formulario condicionando nuestros servicios de preparación a su consentimiento, su consentimiento no será válido. Si usted acepta el uso de la información de su declaración de impuestos, su consentimiento es válido durante el plazo que usted especifique. Si no especifica la duración de su consentimiento, este será válido por un año a partir de la fecha de la firma.

Preparador de declaraciones que utiliza la información: Soto Accounting LLC.

Información que se utilizará: la información contenida en sus declaraciones de impuestos y en los registros que las respaldan, incluidos el tipo de entidad, la composición de ingresos y gastos, la actividad de nómina y de contratistas, y el historial de presentaciones.

Propósito: evaluar e informarle sobre servicios de contabilidad, planificación fiscal, estructura de entidad (incluido el análisis de la elección de S-corporation), teneduría de libros, nómina, asesoría y educación ofrecidos por Soto Accounting LLC o por Hilo NFP que puedan beneficiarle a usted o a su negocio.

Duración del consentimiento: Este consentimiento es válido por un (1) año a partir de la fecha de la firma que aparece abajo, salvo que aquí se especifique un plazo distinto: ______________. Usted puede revocar este consentimiento en cualquier momento mediante aviso por escrito a Soto Accounting LLC.

Si considera que la información de su declaración de impuestos ha sido divulgada o utilizada indebidamente, de manera no autorizada por la ley o sin su permiso, puede comunicarse con el Treasury Inspector General for Tax Administration (TIGTA) por teléfono al 1-800-366-4484, o por correo electrónico a complaints@tigta.treas.gov.

Firma del cliente: ____________________________________    Fecha: ______________
Nombre en letra de molde / Entidad y cargo: ____________________________________
SOTO ACCOUNTING LLC — Por: ____________________________________`,
  },

  // ── Master ─────────────────────────────────────────────────────────────────
  engagement_master: {
    body: `CONTRATO MARCO DE SERVICIOS PROFESIONALES
Soto Accounting LLC, 4252 N. Cicero Ave., Chicago, IL 60641 · (312) 715-8599 · sotoaccounting.com

Este Contrato Marco de Servicios Profesionales ("Contrato") se celebra entre Soto Accounting LLC ("nosotros", "la Firma") y el cliente identificado abajo ("usted", "el Cliente"), y rige todos los servicios profesionales que le prestamos. Los servicios específicos que usted ha contratado se describen en los Anexos de Servicios adjuntos a este Contrato o incorporados posteriormente conforme a él. Cada Anexo incorpora este Contrato; si un Anexo entra en conflicto con este Contrato, prevalece el Anexo respecto de ese servicio.

1. Estructura de la contratación
Su firma abajo constituye la aceptación de este Contrato y de cada Anexo de Servicios adjunto al momento de firmar. Los servicios que se agreguen posteriormente se contratan mediante su aceptación electrónica del Anexo correspondiente a través del portal de clientes, sin necesidad de volver a firmar este Contrato.

2. Honorarios, cotizaciones, depósitos y conciliación
Los honorarios de cada servicio se establecen en su cotización de honorarios y en la configuración de su contrato, con base en nuestro tarifario vigente. Cuando se cobra un depósito al aceptar una cotización, todo el trabajo completado se concilia contra su depósito al facturar: los pagos en exceso se acreditan a su cuenta y cualquier saldo restante se factura. La Firma puede, a su discreción, reducir o exonerar un depósito; dicha facilidad no modifica los honorarios de los servicios prestados. Los depósitos de contrataciones que no se lleven a cabo se mantienen como crédito en su cuenta y se atienden caso por caso; los depósitos no se pierden automáticamente. Los planes recurrentes se facturan automáticamente por adelantado según la periodicidad de su plan; los cambios de plan surten efecto en el siguiente ciclo de facturación. Las suscripciones de software adquiridas para usted se facturan como costos trasladados.

3. Recargos por mora; suspensión
Las facturas vencen al momento de su presentación. Todo saldo que permanezca impago por más de treinta (30) días desde la fecha de la factura acumula un recargo por mora del uno y medio por ciento (1.5%) mensual (18% anual), aplicado al saldo pendiente después de todos los depósitos y créditos. Podemos suspender el trabajo mientras una factura permanezca vencida por más de treinta (30) días; le avisaremos antes de que cualquier suspensión surta efecto.

4. Portal de clientes; registros y firmas electrónicas
Nuestra relación se administra a través del portal seguro de clientes de Soto Accounting. Usted acepta intercambiar documentos por medio del portal y no por correo electrónico ni por archivos adjuntos de mensajes de texto; los documentos recibidos fuera del portal pueden ser transferidos a su expediente en el portal. Usted consiente recibir registros, avisos, facturas y divulgaciones de forma electrónica, así como el uso de firmas electrónicas (E-SIGN Act / UETA). Para las autorizaciones de presentación electrónica ante el IRS (Formulario 8879) firmadas de forma remota, usted acepta completar la verificación de identidad (autenticación basada en conocimiento) conforme lo exige la Publicación 1345 del IRS; la firma en persona sigue disponible si la solicita.

5. Comunicaciones
Con el consentimiento que usted otorgue durante su incorporación, podemos comunicarnos con usted por correo electrónico, mensaje del portal y SMS respecto de su cuenta, sus citas y sus documentos. La frecuencia de los mensajes varía; pueden aplicar tarifas de mensajes y datos; responda STOP para cancelar los SMS en cualquier momento. Términos de SMS y política de privacidad: sotoaccounting.com/sms-terms y sotoaccounting.com/privacy.

6. Confidencialidad; §7216
Cada parte protegerá la información confidencial de la otra con no menos que cuidado razonable, la usará solo en lo necesario para cumplir con este Contrato y limitará el acceso al personal que la necesite. Nuestro uso y divulgación de la información de su declaración de impuestos está además restringido por el IRC §7216; no usaremos ni divulgaremos la información de su declaración salvo autorización de la ley o su consentimiento por escrito otorgado por separado.

7. Registros
Los registros originales que usted proporcione le serán devueltos o se mantendrán en su expediente del portal. Nuestros papeles de trabajo siguen siendo de nuestra propiedad. Conservamos los registros de la contratación durante siete (7) años, después de lo cual pueden ser destruidos.

8. Terminación
Cualquiera de las partes puede terminar este Contrato o cualquier Anexo mediante aviso por escrito. Usted sigue siendo responsable de los honorarios y costos incurridos hasta la terminación, conciliados contra depósitos y créditos.

9. Limitación de responsabilidad; indemnización; ley aplicable; resolución de controversias
(a) Limitación de responsabilidad. En la máxima medida permitida por la ley, la responsabilidad total y acumulada de la Firma y de sus socios, directivos, empleados y agentes (las "Partes de la Firma") frente al Cliente o frente a cualquier tercero por cualquier reclamación, daño, pérdida, costo o gasto (incluidos honorarios razonables de abogados) que surja de o se relacione con este Contrato o con los servicios — con independencia de la teoría de responsabilidad, ya sea contractual, extracontractual (incluida la negligencia), por mala praxis profesional o de otro tipo — se limita a los honorarios profesionales efectivamente pagados por el Cliente por los servicios específicos que dieron lugar a la reclamación. En ningún caso las Partes de la Firma serán responsables por daños consecuentes, incidentales, indirectos, punitivos, ejemplares o especiales, ni por lucro cesante, pérdida de datos, pérdida de prestigio comercial o interrupción del negocio, aun habiendo sido advertidas de su posibilidad. Estas limitaciones son un elemento esencial que induce a la Firma a prestar los servicios y subsisten a la terminación, expiración o conclusión de la contratación.
(b) Indemnización. El Cliente indemnizará, defenderá y mantendrá indemnes a las Partes de la Firma frente a reclamaciones de terceros, responsabilidades, pérdidas, daños, costos y gastos (incluidos honorarios razonables de abogados) que surjan de (i) el incumplimiento del Cliente en proporcionar información, documentación o declaraciones exactas, completas y oportunas; (ii) tergiversación, fraude u omisión intencional por parte del Cliente, su administración o sus agentes; o (iii) la distribución o publicación no autorizada por parte del Cliente de los informes, entregables o productos de trabajo de la Firma — salvo en la medida en que una sentencia firme e inapelable de un tribunal o panel arbitral determine que la reclamación resultó directamente de negligencia grave, dolo o mala fe de la Firma.
(c) Ley aplicable; jurisdicción. Este Contrato y toda reclamación o controversia que surja de o se relacione con la contratación (contractual o extracontractual) se rigen por las leyes del Estado de Illinois, sin atender a sus normas sobre conflicto de leyes. Sujeto al párrafo (d), cualquier procedimiento judicial permitido se presentará exclusivamente ante los tribunales estatales o federales ubicados en Chicago, Condado de Cook, Illinois, y cada parte se somete irrevocablemente a su jurisdicción personal exclusiva.
(d) Resolución de controversias. Las partes intentarán primero, de buena fe, resolver cualquier controversia mediante negociación entre representantes con facultades para transigir; si no se resuelve dentro de los treinta (30) días siguientes al aviso por escrito, mediante mediación no vinculante administrada por la American Arbitration Association ("AAA") conforme a sus Commercial Mediation Procedures en Chicago, Illinois, compartiendo por partes iguales los honorarios del mediador; y si aún no se resuelve sesenta (60) días después de iniciada la mediación, mediante arbitraje final y vinculante administrado por la AAA conforme a sus Commercial Arbitration Rules en Chicago, Illinois, ante un único árbitro neutral que sea juez jubilado o abogado con al menos quince (15) años de experiencia en derecho contable o en controversias de responsabilidad profesional. El árbitro no tiene facultad para otorgar daños excluidos por el párrafo (a). El laudo puede ser homologado ante cualquier tribunal competente.
(e) RENUNCIA A JUICIO POR JURADO Y A ACCIONES COLECTIVAS. CADA PARTE RENUNCIA IRREVOCABLEMENTE, EN LA MÁXIMA MEDIDA PERMITIDA POR LA LEY, A CUALQUIER DERECHO A JUICIO POR JURADO RESPECTO DE CUALQUIER CONTROVERSIA, Y EL CLIENTE ACEPTA QUE TODAS LAS RECLAMACIONES DEBEN PRESENTARSE A TÍTULO INDIVIDUAL Y NO COMO DEMANDANTE O MIEMBRO DE UNA CLASE EN CUALQUIER PROCEDIMIENTO PRETENDIDAMENTE COLECTIVO, REPRESENTATIVO O DE GRUPO.

10. Idioma que rige
Este Contrato se celebra y perfecciona en idioma inglés. Si este Contrato se traduce a cualquier otro idioma por conveniencia o para cualquier otro fin, el texto en idioma inglés regirá, controlará y prevalecerá sobre dicha traducción en todos los aspectos, incluidos el cumplimiento, la interpretación, la construcción y la ejecución de este Contrato.

11. Acuerdo íntegro
Este Contrato, junto con sus Anexos, su cotización de honorarios y la configuración de su contrato, constituye el acuerdo íntegro respecto de los servicios descritos y reemplaza las cartas de contratación anteriores para dichos servicios.

Anexos de Servicios adjuntos al momento de firmar: {{schedules_attached}}

Firma del cliente: ____________________________________    Fecha: ______________
Nombre en letra de molde / Entidad y cargo: ____________________________________
SOTO ACCOUNTING LLC — Por: ____________________________________`,
  },

  // ── Operational email ──────────────────────────────────────────────────────
  packet_ready_to_sign: {
    subject: 'Su contrato de servicios está listo para firmar',
    body: `Hola {{first_name}}:

Su contrato de servicios está listo. Cubre {{schedules}}.

Puede leerlo y firmarlo en su portal — toma alrededor de un minuto:

{{sign_link}}

Firmarlo una sola vez cubre el contrato y todos los anexos de servicios incluidos arriba. Si más adelante agregamos un servicio, usted acepta únicamente ese anexo en el portal — nunca se le pedirá volver a firmar este documento.

Si algo no le parece correcto, respóndanos y díganos. Preferimos corregir los términos antes que usted firme algo sobre lo que tiene dudas.

— Soto Accounting`,
  },

  // ── Schedules ──────────────────────────────────────────────────────────────
  schedule_a_individual_tax: {
    body: `ANEXO A — PREPARACIÓN DE DECLARACIONES DE IMPUESTOS SOBRE LA RENTA DE PERSONAS FÍSICAS

Prepararemos sus declaraciones de impuestos sobre la renta, federales y estatales, para el o los años fiscales identificados en la configuración de su contrato, con base en la información que usted proporcione. Nuestro trabajo no incluye procedimientos para descubrir irregularidades o inexactitudes en la información que usted proporcione. Los años adicionales (incluidos años anteriores no presentados), los estados adicionales, las declaraciones enmendadas y las respuestas a avisos de las autoridades fiscales son servicios separados que se cotizan conforme a nuestro tarifario vigente.

Usted proporcionará toda la información relacionada con ingresos y deducciones y responderá oportunamente a nuestras solicitudes para que las declaraciones puedan completarse en sus fechas límite.

Usted mantendrá los registros apropiados: documentos fiscales oficiales, recibos y comprobantes que respalden las deducciones, e información de compra y venta de activos.

Usted revisará sus declaraciones antes de su presentación; la presentación oportuna es su responsabilidad. Cuando queden documentos pendientes cerca de una fecha límite, podemos recomendar y, con aviso a usted, preparar una prórroga preventiva.

Si sus declaraciones son seleccionadas para revisión o auditoría, podemos asistirle o representarle a solicitud suya; dicha asistencia se factura conforme a nuestro tarifario vigente y no está incluida en los honorarios de preparación.`,
  },

  schedule_b_business_tax: {
    body: `ANEXO B — PREPARACIÓN DE DECLARACIONES DE IMPUESTOS SOBRE LA RENTA DE EMPRESAS

Prepararemos las declaraciones de impuestos sobre la renta de la entidad, federales y estatales, y los anexos que las acompañan (incluidos los Anexos K-1 de los socios o accionistas, según corresponda) para el o los años indicados en la configuración de su contrato, con base en la balanza de comprobación, los estados financieros y la información que usted proporcione. Podemos proponer asientos de ajuste necesarios para efectos fiscales; su registro sigue siendo responsabilidad suya, salvo que también se contraten servicios de teneduría de libros (Anexo C). Los años adicionales, los estados adicionales, las declaraciones enmendadas, las elecciones (incluido el Formulario 2553) y las respuestas a avisos se cotizan por separado.

La administración es responsable de la exactitud e integridad de los registros financieros. Nuestra preparación no constituye una auditoría, revisión ni compilación, y no puede utilizarse como base para detectar errores, fraude u otros actos ilegales.

Usted revisará las declaraciones antes de su presentación y antes de firmar la autorización de presentación electrónica. Cuando queden documentos pendientes cerca de una fecha límite, podemos recomendar y, con aviso, preparar una prórroga preventiva.

Cuando la entidad mantenga una elección de S-corporation, mantener una compensación razonable para el propietario es responsabilidad suya; el análisis de compensación está disponible bajo el Anexo D.

Las entidades relacionadas contratadas en conjunto pueden optar por una sola factura consolidada desglosada por entidad, o por facturas separadas por entidad, modificable hacia el futuro en cualquier momento.`,
  },

  schedule_c_bookkeeping: {
    body: `ANEXO C — TENEDURÍA DE LIBROS Y CONTABILIDAD RECURRENTE

Según la periodicidad de preparación indicada en la configuración de su contrato (semanal / mensual / trimestral / semestral), realizaremos lo siguiente: conciliar cuentas bancarias y de tarjetas y registrar asientos correctivos con aviso a usted; revisar y conciliar las cuentas del libro mayor; registrar los asientos de diario necesarios; preparar y publicar los estados financieros en su portal al cierre de cada periodo; y, si así se selecciona, preparar declaraciones de impuestos sobre ventas, revisar y conciliar los registros de nómina, y configurar sistemas de contabilidad y nómina con una capacitación básica.

Según la periodicidad de sesiones indicada en la configuración de su contrato, nos reuniremos con usted para revisar los estados financieros y conversar sobre estrategia fiscal y asuntos del negocio; los resúmenes de sesión con las decisiones y las tareas acordadas se entregan a través de su portal. Los clientes con una elección de S-corporation activa mantienen un mínimo de dos sesiones con el CPA al año.

Esta contratación se limita a los periodos y servicios configurados; el trabajo de puesta al día o de limpieza se cotiza por separado a nuestra tarifa por hora.

Esto no es administración del negocio; no revisamos el pago de facturas ni de cuentas, aunque le señalaremos las partidas inusuales.

Esto no es una auditoría ni una revisión conforme a las normas de auditoría generalmente aceptadas y no se expresa ninguna opinión; le pedimos no referirse a nuestro trabajo como una auditoría o una revisión.

Nos basamos en la exactitud e integridad de los registros que usted proporcione y nuestro trabajo no puede utilizarse como base para revelar errores, fraude u otros actos ilegales, aunque le informaremos de las partidas materiales que lleguen a nuestro conocimiento. No tenemos la responsabilidad de identificar deficiencias en sus controles internos.`,
  },

  schedule_d_advisory: {
    body: `ANEXO D — SERVICIOS DE ASESORÍA / CFO

Según se configure, los servicios de asesoría pueden incluir: revisión e interpretación de estados financieros; planificación y proyecciones fiscales; análisis de estructura de entidad (incluidos el análisis de la elección de S-corporation y el cálculo de la compensación del propietario); presupuestos, pronósticos y análisis de márgenes; preparación para préstamos y financiamiento y apoyo en procesos de debida diligencia; cartas de confirmación del CPA; y asesoría empresarial impartida en sesiones programadas con resúmenes en el portal.

Los servicios de asesoría son de carácter consultivo; las decisiones, su implementación y sus resultados siguen siendo exclusivamente suyos.

Las proyecciones y los pronósticos son estimaciones basadas en supuestos y en la información que usted proporcione; los resultados reales variarán y no se expresa ninguna seguridad sobre información financiera prospectiva.

Los servicios de asesoría no constituyen una auditoría, revisión ni compilación, y no son asesoría legal ni de inversiones; las contrataciones con profesionales referidos se celebran directamente entre usted y el proveedor.`,
  },

  schedule_e_entity: {
    body: `ANEXO E — CONSTITUCIÓN DE ENTIDADES Y CUMPLIMIENTO

Según se configure, prepararemos y presentaremos: los trámites de constitución de entidades en Illinois junto con la solicitud del EIN; la solicitud de exención 501(c)(3) (Formulario 1023); las presentaciones de informes anuales; los artículos de enmienda; el registro de nombre comercial (DBA); y/o el reporte de información sobre beneficiarios finales (BOI). Las copias de todas las presentaciones se entregan a través de su portal, y las fechas límite de renovación aplicables se controlan con recordatorios mientras usted siga siendo cliente activo.

No somos un despacho de abogados y no brindamos asesoría legal; los documentos de constitución utilizan formatos estándar basados en la información que usted proporcione. La elección de la entidad y los términos de gobierno corporativo pueden tener consecuencias legales; recomendamos consultar a un abogado y podemos referirle a un asesor calificado.

Los tiempos de trámite gubernamental están fuera de nuestro control; las tarifas gubernamentales de presentación son responsabilidad suya y se facturan como costos trasladados.

Usted es responsable de la exactitud de la información proporcionada para las presentaciones, incluida la información sobre beneficiarios finales, y de mantener la vigencia legal de su entidad.`,
  },

  schedule_f_attest: {
    body: `ANEXO F — SERVICIOS DE ATESTIGUAMIENTO (REVISIÓN Y AUDITORÍA DEL CPA)

Según se configure en su contratación, realizaremos uno de los siguientes trabajos de atestiguamiento respecto de los estados financieros de la entidad identificada en el Addendum de Contratación correspondiente: (i) una revisión de estados financieros realizada conforme a los Statements on Standards for Accounting and Review Services (SSARS) emitidos por el AICPA; o (ii) una auditoría de estados financieros realizada conforme a las normas de auditoría generalmente aceptadas en los Estados Unidos de América (GAAS); o (iii) una auditoría de compensación de trabajadores o de seguro de nómina, según se especifique. Cada trabajo de atestiguamiento se documenta mediante un Addendum de Contratación que indica la entidad, los estados financieros y el o los periodos cubiertos, el marco de información financiera aplicable y los honorarios.

Independencia

Solo podemos aceptar un trabajo de atestiguamiento cuando somos independientes de la entidad conforme al significado de las normas profesionales aplicables. Cuando la Firma presta servicios de teneduría de libros, nómina, administración u otros servicios distintos del atestiguamiento a la entidad, la independencia puede verse comprometida y podríamos vernos obligados a declinar el trabajo de atestiguamiento o a referirlo a otra firma; se lo notificaremos de inmediato si así ocurre.

Respecto de cualquier servicio permitido distinto del atestiguamiento que se preste junto con un trabajo de atestiguamiento, usted acepta asumir todas las responsabilidades de la administración; supervisar dichos servicios designando a una persona con la aptitud, el conocimiento o la experiencia adecuados; evaluar la suficiencia y los resultados de los servicios; y aceptar la responsabilidad por ellos.

Responsabilidades de la administración

La administración es responsable de la preparación y presentación razonable de los estados financieros conforme al marco aplicable; del diseño, la implementación y el mantenimiento del control interno relevante para su preparación; de la prevención y detección del fraude; y del cumplimiento de las leyes y reglamentos aplicables.

La administración nos dará acceso a toda la información relevante para el trabajo, a la información adicional que solicitemos y acceso irrestricto a las personas dentro de la entidad, y entregará una carta de representación firmada al concluir el trabajo. Nuestro informe está condicionado a la recepción de dicha carta.

Naturaleza y limitaciones del trabajo

Una revisión consiste principalmente en procedimientos analíticos e indagaciones y proporciona seguridad limitada; su alcance es sustancialmente menor que el de una auditoría, y no expresaremos una opinión de auditoría.

Una auditoría se realizará conforme a las normas de auditoría generalmente aceptadas en los Estados Unidos de América (US GAAS), que exigen que planifiquemos y ejecutemos la auditoría para obtener seguridad razonable — no absoluta — sobre si los estados financieros están libres de incorrección material. Una auditoría implica aplicar procedimientos para obtener evidencia sobre los importes y las revelaciones de los estados financieros; los procedimientos seleccionados dependen de nuestro juicio, incluida la valoración de los riesgos de incorrección material, ya sea por fraude o por error. Una auditoría también incluye evaluar lo apropiado de las políticas contables utilizadas y la razonabilidad de las estimaciones significativas realizadas por la administración, así como la presentación general de los estados financieros. Debido a las limitaciones inherentes de una auditoría, junto con las limitaciones inherentes del control interno, existe un riesgo inevitable de que algunas incorrecciones materiales no sean detectadas, aun cuando la auditoría se planifique y ejecute adecuadamente conforme a las US GAAS.

Al realizar nuestras valoraciones de riesgo, consideramos el control interno relevante para la preparación y presentación razonable de los estados financieros por parte de la entidad con el fin de diseñar procedimientos apropiados, pero no con el propósito de expresar una opinión sobre la eficacia del control interno.

Le comunicaremos, según lo exigen las normas profesionales, los asuntos significativos que surjan del trabajo, incluidas las deficiencias significativas o debilidades materiales en el control interno que lleguen a nuestro conocimiento.

Informes y distribución

Al concluir, emitiremos el informe escrito que exigen las normas aplicables, dirigido según corresponda (en el caso de auditorías, al consejo de administración o su equivalente). No podemos asegurar que se expresará una opinión o conclusión sin salvedades; las circunstancias pueden obligarnos a modificar nuestro informe, a agregar párrafos de énfasis o de otros asuntos, o a renunciar al trabajo, y comentaremos con usted cualquiera de dichas circunstancias. Usted sigue siendo responsable de los honorarios incurridos hasta esa fecha.

Nuestro informe y los estados financieros que lo acompañan son para el uso descrito en el informe. Usted no puede reproducir, extractar ni distribuir nuestro informe salvo en su totalidad, y cualquier uso en documentos de oferta o presentaciones regulatorias requiere nuestro consentimiento previo por escrito.

Honorarios

Los honorarios de atestiguamiento son los del Addendum de Contratación correspondiente, cotizados conforme a nuestro tarifario vigente (honorario fijo u por hora con un rango estimado, según se indique en el Addendum), más los gastos directos desembolsados y los impuestos aplicables. El depósito o anticipo indicado en el Addendum se debe pagar al momento de la aceptación y se concilia contra la facturación final conforme al Contrato Marco de Servicios Profesionales. Los recargos por mora y la suspensión del trabajo por falta de pago se rigen por el Contrato Marco; si suspendemos o renunciamos por falta de pago, no somos responsables por daños derivados del cese de la prestación de servicios. Las disposiciones del Contrato Marco sobre limitación de responsabilidad y resolución de controversias aplican a los trabajos de atestiguamiento, salvo en la medida en que lo limiten la ley aplicable o las normas profesionales.

ADDENDUM DE CONTRATACIÓN (por cada trabajo de atestiguamiento)

Entidad: {{entity_name}}
Tipo de trabajo: {{engagement_type}}
Estados financieros y periodo(s) cubiertos: {{statements_and_periods}}
Marco de información financiera: {{reporting_framework}}
Honorarios: {{fee_summary}}
Depósito/anticipo a pagar al aceptar: {{deposit_summary}}
Fecha estimada del informe: {{expected_report_date}}`,
  },
};

export async function seedLegalV3Es(db) {
  let written = 0;
  const missing = [];
  const placeholderMismatch = [];

  for (const [key, { body, subject }] of Object.entries(ES)) {
    const { rows } = await db.query(
      `SELECT body_en, subject_en, body_es, needs_es_review, es_approved_at FROM templates WHERE key = $1`,
      [key]
    );
    if (rows.length === 0) {
      missing.push(key);
      continue;
    }
    /*
     * NEVER overwrite a translation that already exists.
     *
     * This used to skip only APPROVED copy, which left a hole exactly wide enough to
     * fall through: the governing-language clause was added to body_es directly, the
     * approval was then re-queued (clearing es_approved_at), and the next deploy saw an
     * unapproved row and overwrote it with the pre-clause text from this file. Brian
     * then approved a Spanish Master silently missing the clause he had just ordered.
     *
     * This file seeds INITIAL translations. Once a body exists — approved or not — it is
     * the live text and this seed is not the authority on it.
     */
    if (rows[0].es_approved_at || (rows[0].body_es && rows[0].body_es.trim().length > 0)) continue;

    // A placeholder that does not survive translation renders as literal text in a
    // signed document. Compare the sets rather than trusting the prose.
    const found = (s) => new Set((String(s || '').match(/\{\{[a-z_]+\}\}/g) || []));
    const en = found(rows[0].body_en);
    const es = found(body);
    if ([...en].some((v) => !es.has(v)) || [...es].some((v) => !en.has(v))) {
      placeholderMismatch.push(`${key} (en:${[...en].join(',') || 'none'} es:${[...es].join(',') || 'none'})`);
      continue;
    }

    await db.query(
      `UPDATE templates
          SET body_es = $2,
              subject_es = COALESCE($3, subject_es),
              needs_es_review = true
        WHERE key = $1`,
      [key, body, subject ?? null]
    );
    written += 1;
  }

  let report = `${written} Spanish body(ies) written, ALL still awaiting Brian's approval`;
  if (missing.length > 0) report += `; template not found: ${missing.join(', ')}`;
  if (placeholderMismatch.length > 0) {
    report += `; ⚠ SKIPPED on placeholder mismatch: ${placeholderMismatch.join('; ')}`;
  }
  return report;
}
