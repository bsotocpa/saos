/*
 * DISPLAY NAMES CARRY THE FORM NUMBER (Brian, 2026-09-27, R81). Presentation metadata on
 * price_book_items (0133), like group_key: set on every version's rows by item_code, never a new
 * version; the book's own name_en/name_es stay as priced. Written where a row has none, so a fresh
 * book (tests, the harness) gets them on seeding and a name set later is never overwritten.
 */
export const DISPLAY_NAMES = [
  ['IND_BASE_SINGLE', 'Form 1040 — Single', 'Formulario 1040 — Soltero(a)'],
  ['IND_BASE_MFJ', 'Form 1040 — Married filing jointly', 'Formulario 1040 — Casados en conjunto'],
  ['IND_BASE_MFS', 'Form 1040 — Married filing separately', 'Formulario 1040 — Casados por separado'],
  ['IND_BASE_HOH', 'Form 1040 — Head of household', 'Formulario 1040 — Cabeza de familia'],
  ['IND_ADDL_STATE', 'Additional state return (1040)', 'Estado adicional (1040)'],
  ['IND_SCH_A', 'Schedule A (1040) — itemized deductions', 'Anexo A (1040) — deducciones detalladas'],
  ['IND_SCH_B_D', 'Schedule B/D (1040) — interest, dividends, capital gains', 'Anexos B/D (1040) — intereses, dividendos, ganancias'],
  ['IND_SCH_C', 'Schedule C (1040) — self-employment', 'Anexo C (1040) — negocio propio'],
  ['IND_SCH_E_RENTAL', 'Schedule E (1040) — rental property', 'Anexo E (1040) — propiedad de alquiler'],
  ['IND_SCH_E_K1', 'Schedule E (1040) — K-1', 'Anexo E (1040) — K-1'],
  ['IND_SCH_H', 'Schedule H (1040) — household employment', 'Anexo H (1040) — empleo doméstico'],
  ['IND_SCH_EIC', 'Schedule EIC (1040) — earned income credit', 'Anexo EIC (1040) — crédito por ingreso del trabajo'],
  ['BIZ_SCH_C', 'Schedule C (1040) — sole prop or single-member LLC', 'Anexo C (1040) — negocio propio o LLC de un solo miembro'],
];

export async function seedPriceBookDisplayNames(client) {
  let rows = 0;
  for (const [code, en, es] of DISPLAY_NAMES) {
    const r = await client.query(
      `UPDATE price_book_items SET display_name_en = $2, display_name_es = $3
        WHERE item_code = $1 AND display_name_en IS NULL AND display_name_es IS NULL`,
      [code, en, es]
    );
    rows += r.rowCount;
  }
  return `display names: ${DISPLAY_NAMES.length} item code(s), ${rows} row(s) set across every version (rows already named left untouched)`;
}
