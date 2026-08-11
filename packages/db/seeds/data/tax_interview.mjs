// The guided tax interview: the questions, and which price-book item each answer
// adds. Every item_code here must exist in the price book — the seeder verifies it
// rather than trusting, because a typo would silently drop a schedule from a quote
// and the symptom would be an understated price, which is the bug this fixes.
//
// Prompts are written to be readable by a CLIENT, not just staff: the same interview
// becomes lead self-quoting later, and rewriting them then would mean re-testing the
// derivation. Client copy ships EN + ES (CLAUDE.md).

export const questions = [
  {
    key: 'filing_status',
    answerType: 'choice',
    isBase: true,
    promptEn: 'How will you file?',
    promptEs: '¿Cómo va a declarar?',
    helpEn: 'This sets the base price. One federal return and one state are included.',
    helpEs: 'Esto establece el precio base. Incluye una declaración federal y un estado.',
    choiceItems: {
      single: 'IND_BASE_SINGLE',
      mfj: 'IND_BASE_MFJ',
      mfs: 'IND_BASE_MFS',
      hoh: 'IND_BASE_HOH',
    },
    sortOrder: 10,
  },
  {
    key: 'self_employment_count',
    answerType: 'count',
    itemCode: 'IND_SCH_C',
    promptEn: 'How many businesses or self-employed activities do you have?',
    promptEs: '¿Cuántos negocios o actividades por cuenta propia tiene?',
    helpEn: 'Each one is its own Schedule C — freelancing, 1099 work, a shop, driving.',
    helpEs: 'Cada una lleva su propio Anexo C — trabajo independiente, 1099, una tienda, conducir.',
    sortOrder: 20,
  },
  {
    key: 'rental_count',
    answerType: 'count',
    itemCode: 'IND_SCH_E_RENTAL',
    promptEn: 'How many rental properties do you own?',
    promptEs: '¿Cuántas propiedades de alquiler tiene?',
    helpEn: 'Priced per property, so three rentals cost three times one.',
    helpEs: 'Se cobra por propiedad, así que tres alquileres cuestan el triple que uno.',
    sortOrder: 30,
  },
  {
    key: 'k1_count',
    answerType: 'count',
    itemCode: 'IND_SCH_E_K1',
    promptEn: 'How many K-1s will you receive?',
    promptEs: '¿Cuántos formularios K-1 recibirá?',
    helpEn: 'From a partnership, S corporation, or trust. Priced per K-1.',
    helpEs: 'De una sociedad, corporación S o fideicomiso. Se cobra por cada K-1.',
    sortOrder: 40,
  },
  {
    key: 'extra_states',
    answerType: 'count',
    itemCode: 'IND_ADDL_STATE',
    promptEn: 'Besides your home state, how many other states do you need to file in?',
    promptEs: 'Además de su estado, ¿en cuántos otros estados necesita declarar?',
    helpEn: 'Your first state is already in the base price. Count only the extras.',
    helpEs: 'Su primer estado ya está en el precio base. Cuente solo los adicionales.',
    sortOrder: 50,
  },
  {
    key: 'investments',
    answerType: 'bool',
    itemCode: 'IND_SCH_B_D',
    promptEn: 'Did you have interest, dividends, or sell any investments?',
    promptEs: '¿Tuvo intereses, dividendos o vendió inversiones?',
    helpEn: 'Includes brokerage accounts and crypto sales (Schedules B and D).',
    helpEs: 'Incluye cuentas de corretaje y ventas de criptomonedas (Anexos B y D).',
    sortOrder: 60,
  },
  {
    key: 'itemize',
    answerType: 'bool',
    itemCode: 'IND_SCH_A',
    promptEn: 'Do you plan to itemize deductions?',
    promptEs: '¿Piensa detallar sus deducciones?',
    helpEn: 'Mortgage interest, large medical bills, significant charitable giving.',
    helpEs: 'Intereses hipotecarios, gastos médicos altos, donaciones importantes.',
    sortOrder: 70,
  },
  {
    key: 'household_employee',
    answerType: 'bool',
    itemCode: 'IND_SCH_H',
    promptEn: 'Did you pay a household employee, such as a nanny or caregiver?',
    promptEs: '¿Le pagó a un empleado doméstico, como una niñera o cuidador?',
    sortOrder: 80,
  },
  {
    key: 'earned_income_credit',
    answerType: 'bool',
    itemCode: 'IND_SCH_EIC',
    promptEn: 'Do you expect to claim the Earned Income Credit?',
    promptEs: '¿Espera reclamar el Crédito por Ingreso del Trabajo?',
    helpEn: 'Usually applies with qualifying children and income under the IRS limit.',
    helpEs: 'Generalmente aplica con hijos calificados e ingresos bajo el límite del IRS.',
    sortOrder: 90,
  },
];

export async function seedTaxInterview(client) {
  // Every referenced item must exist in the price book in force. A typo here would
  // drop a schedule from derived quotes and show up only as an understated price.
  const referenced = new Set();
  for (const q of questions) {
    if (q.itemCode) referenced.add(q.itemCode);
    for (const code of Object.values(q.choiceItems ?? {})) referenced.add(code);
  }
  const { rows: found } = await client.query(
    `SELECT DISTINCT item_code FROM price_book_items WHERE item_code = ANY($1)`,
    [[...referenced]]
  );
  const missing = [...referenced].filter((c) => !found.some((f) => f.item_code === c));
  if (missing.length > 0) {
    throw new Error(
      `tax interview references price-book items that do not exist: ${missing.join(', ')}`
    );
  }

  let inserted = 0;
  for (const q of questions) {
    const res = await client.query(
      `INSERT INTO tax_interview_questions
         (key, answer_type, prompt_en, prompt_es, help_en, help_es, item_code, choice_items,
          is_base, sort_order)
       VALUES ($1, $2::interview_answer_type, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (key) DO UPDATE SET
         answer_type = EXCLUDED.answer_type,
         prompt_en = EXCLUDED.prompt_en, prompt_es = EXCLUDED.prompt_es,
         help_en = EXCLUDED.help_en, help_es = EXCLUDED.help_es,
         item_code = EXCLUDED.item_code, choice_items = EXCLUDED.choice_items,
         is_base = EXCLUDED.is_base, sort_order = EXCLUDED.sort_order`,
      [
        q.key, q.answerType, q.promptEn, q.promptEs, q.helpEn ?? null, q.helpEs ?? null,
        q.itemCode ?? null, q.choiceItems ? JSON.stringify(q.choiceItems) : null,
        q.isBase ?? false, q.sortOrder,
      ]
    );
    inserted += res.rowCount;
  }
  return `tax interview: ${questions.length} questions (${referenced.size} price-book items verified)`;
}
