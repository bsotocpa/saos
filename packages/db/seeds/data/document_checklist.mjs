/*
 * THE DOCUMENT CHECKLIST, AS SEEDED (Brian, 2026-09-27, R83).
 *
 * Per price-book item: the documents the client owes for it. Acceptance of a tax quote builds the
 * return's checklist from its lines; two lines asking for the same doc_key ask once (every base 1040
 * asks for the same ID, prior return, W-2s and 1099s). Brian's list, as ruled: base 1040: W-2s, 1099s,
 * prior-year return, ID; Schedule B/D: 1099-INT/DIV/B; Schedule E K-1: K-1s; Schedule C: income and
 * expense records; 1120-S: year-end financials, prior return, K-1 detail; "and so on" for the rest,
 * each row his to edit in Admin -> Document checklist.
 *
 * Insert-if-absent, like every other editable seed: a row Brian has edited is never overwritten, and
 * a row he has switched off stays off. An item with no row asks for nothing (surcharges, support
 * hours, additional states).
 */

const ID = { key: 'photo_id', en: 'Photo ID (driver’s license or passport) for each person on the return', es: 'Identificación con foto (licencia de conducir o pasaporte) de cada persona en la declaración' };
const PRIOR_1040 = { key: 'prior_year_return', en: 'Last year’s tax return (federal and state)', es: 'La declaración de impuestos del año pasado (federal y estatal)' };
const W2 = { key: 'w2', en: 'W-2 forms from every employer', es: 'Los formularios W-2 de cada empleador' };
const F1099 = { key: 'forms_1099', en: '1099 forms you received (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 and any others)', es: 'Los formularios 1099 que recibió (1099-NEC, 1099-MISC, 1099-G, 1099-R, SSA-1099 y cualquier otro)' };
const BASE_1040 = [ID, PRIOR_1040, W2, F1099];

const INCOME = { key: 'business_income_records', en: 'Business income records for the year (sales totals, 1099-NEC and 1099-K)', es: 'Registros de ingresos del negocio del año (totales de ventas, 1099-NEC y 1099-K)' };
const EXPENSES = { key: 'business_expense_records', en: 'Business expense records for the year (receipts, statements or a profit and loss)', es: 'Registros de gastos del negocio del año (recibos, estados de cuenta o un estado de pérdidas y ganancias)' };
const FINANCIALS = { key: 'year_end_financials', en: 'Year-end financial statements (profit and loss and balance sheet)', es: 'Estados financieros de cierre de año (pérdidas y ganancias y balance general)' };
const PRIOR_BIZ = { key: 'prior_year_business_return', en: 'Last year’s business tax return', es: 'La declaración de impuestos del negocio del año pasado' };
const AMENDED = { key: 'return_being_amended', en: 'The return being amended, and the documents that change it', es: 'La declaración que se va a enmendar y los documentos que la cambian' };
const NOTICE = { key: 'notice', en: 'The IRS or state notice (every page)', es: 'El aviso del IRS o del estado (todas las páginas)' };

/** [item_code, documents in the order the client sees them] */
export const CHECKLIST = [
  ['IND_BASE_SINGLE', BASE_1040],
  ['IND_BASE_MFJ', BASE_1040],
  ['IND_BASE_MFS', BASE_1040],
  ['IND_BASE_HOH', BASE_1040],
  ['IND_SCH_B_D', [{ key: 'forms_1099_int_div_b', en: '1099-INT, 1099-DIV and 1099-B statements from every bank and brokerage account', es: 'Los formularios 1099-INT, 1099-DIV y 1099-B de cada cuenta bancaria y de inversión' }]],
  ['IND_SCH_E_K1', [{ key: 'k1s', en: 'Schedule K-1 from each partnership, S corporation, estate or trust', es: 'El Anexo K-1 de cada sociedad, corporación S, patrimonio o fideicomiso' }]],
  ['IND_SCH_E_RENTAL', [{ key: 'rental_records', en: 'Rent received and expenses for each rental property (Form 1098, property tax, repairs, insurance)', es: 'Rentas recibidas y gastos de cada propiedad de alquiler (Formulario 1098, impuesto predial, reparaciones, seguro)' }]],
  ['IND_SCH_C', [INCOME, EXPENSES]],
  ['IND_SCH_A', [{ key: 'itemized_records', en: 'Form 1098 mortgage interest, property tax bills and charitable donation receipts', es: 'El Formulario 1098 de intereses hipotecarios, los recibos del impuesto predial y los recibos de donaciones' }]],
  ['IND_SCH_H', [{ key: 'household_payroll', en: 'Wages paid to each household employee this year', es: 'Los salarios pagados a cada empleado doméstico este año' }]],
  ['IND_F8863', [{ key: 'form_1098t', en: 'Form 1098-T from each school', es: 'El Formulario 1098-T de cada escuela' }]],
  ['IND_F2441', [{ key: 'dependent_care_providers', en: 'Each dependent care provider’s name, address, tax ID and the amount paid', es: 'El nombre, la dirección, el número de identificación fiscal y el monto pagado a cada proveedor de cuidado de dependientes' }]],
  ['IND_F4562', [{ key: 'asset_purchases', en: 'Purchase records for equipment, vehicles or property placed in service this year', es: 'Registros de compra de equipo, vehículos o propiedades puestos en servicio este año' }]],
  ['IND_F5695', [{ key: 'energy_improvements', en: 'Receipts for energy improvements to your home (solar, heat pump, insulation, windows)', es: 'Recibos de mejoras de energía en su hogar (solar, bomba de calor, aislamiento, ventanas)' }]],
  ['IND_F8949_121', [{ key: 'home_sale_closing', en: 'The closing statement for the home sale, and the purchase and improvement records', es: 'La declaración de cierre de la venta de la casa y los registros de compra y mejoras' }]],
  ['IND_F8936', [{ key: 'clean_vehicle_report', en: 'The purchase agreement and the dealer’s clean vehicle report', es: 'El contrato de compra y el informe de vehículo limpio del concesionario' }]],
  ['IND_AMENDMENT_1040X', [AMENDED]],
  ['IND_NOTICE_SUPPORT', [NOTICE]],
  ['BIZ_SCH_C', [INCOME, EXPENSES]],
  ['BIZ_1120S', [FINANCIALS, PRIOR_BIZ, { key: 'k1_detail', en: 'Shareholder detail for the K-1s (each owner, ownership percentage and distributions)', es: 'Detalle de accionistas para los K-1 (cada dueño, porcentaje de participación y distribuciones)' }]],
  ['BIZ_1065', [FINANCIALS, PRIOR_BIZ, { key: 'k1_detail', en: 'Partner detail for the K-1s (each partner, ownership percentage, contributions and distributions)', es: 'Detalle de socios para los K-1 (cada socio, porcentaje de participación, aportaciones y distribuciones)' }]],
  ['BIZ_1120', [FINANCIALS, PRIOR_BIZ]],
  ['BIZ_990', [FINANCIALS, PRIOR_BIZ, { key: 'officers_list', en: 'The list of officers, directors and key employees', es: 'La lista de funcionarios, directores y empleados clave' }]],
  ['BIZ_AMENDMENT', [AMENDED]],
  ['BIZ_NOTICE_SUPPORT', [NOTICE]],
];

export async function seedDocumentChecklist(client) {
  let inserted = 0;
  let rows = 0;
  for (const [itemCode, docs] of CHECKLIST) {
    for (const [i, d] of docs.entries()) {
      rows++;
      const res = await client.query(
        `INSERT INTO document_checklist_items (item_code, doc_key, label_en, label_es, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (item_code, doc_key) DO NOTHING`,
        [itemCode, d.key, d.en, d.es, (i + 1) * 10]
      );
      inserted += res.rowCount;
    }
  }
  return `${inserted} of ${rows} document checklist rows inserted (${CHECKLIST.length} items; existing rows untouched)`;
}
