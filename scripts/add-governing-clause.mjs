// Add the governing-language clause to the Master as a NEW template version.
//
// Brian, after attorney review (2026-08-13): EXACTLY this text and nothing more. The
// attorney's draft carried a third sentence requiring all communications in English;
// Brian deliberately omitted it because it contradicts bilingual operations, and the
// deletion is pending the attorney's written confirmation. That is recorded on the
// version so the omission is a documented decision rather than a gap someone later
// "fixes" by pasting the draft back in.
//
// The clause becomes section 11 and Entire Agreement moves to 12 — the schedules line
// and signature block stay at the end where a reader expects them.

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');

// EXACT text. Not reformatted, not re-wrapped, not "improved".
const CLAUSE_EN =
  'This Agreement is executed and concluded in the English language. If this Agreement ' +
  'is translated into any other language for convenience or any other purpose, the ' +
  'English language text shall govern, control, and prevail over any such translation ' +
  'in all respects, including the performance, interpretation, construction, and ' +
  'enforcement of this Agreement.';

// The Spanish Master is a convenience translation of a document whose English governs —
// so the clause must appear there too, saying that the English governs. A Spanish
// contract silently missing its governing-language clause is the one place the omission
// would actually matter.
const CLAUSE_ES =
  'Este Contrato se celebra y perfecciona en idioma inglés. Si este Contrato se traduce ' +
  'a cualquier otro idioma por conveniencia o para cualquier otro fin, el texto en ' +
  'idioma inglés regirá, controlará y prevalecerá sobre dicha traducción en todos los ' +
  'aspectos, incluidos el cumplimiento, la interpretación, la construcción y la ' +
  'ejecución de este Contrato.';

const VERSION_NOTE =
  'Governing-language clause added (attorney green light, Brian 2026-08-13). ' +
  "OMITTED DELIBERATELY: the attorney's draft carried a third sentence requiring all " +
  'communications to be conducted in English. Brian removed it — it contradicts Soto\'s ' +
  'bilingual operations, in which client copy ships in English AND Spanish. The deletion ' +
  'is PENDING THE ATTORNEY\'S WRITTEN CONFIRMATION; do not restore that sentence without it.';

const db = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://saos:saos_dev_password@localhost:5432/saos',
});
await db.connect();

const { rows } = await db.query(
  `SELECT key, version, body_en, body_es, needs_es_review, es_approved_at IS NOT NULL AS es_approved
     FROM templates WHERE key = 'engagement_master'`
);
const m = rows[0];
if (!m) {
  console.error('engagement_master not found');
  process.exit(1);
}
console.log(`engagement_master currently v${m.version}, ES approved: ${m.es_approved}`);

if (m.body_en.includes('executed and concluded in the English language')) {
  console.log('The clause is already present. Nothing to do.');
  await db.end();
  process.exit(0);
}

/** Insert as a new numbered section immediately before "Entire agreement", renumbering it. */
function withClause(body, clause, headingRe, entireHeading, newEntireHeading) {
  const idx = body.search(headingRe);
  if (idx === -1) return null;
  const before = body.slice(0, idx);
  const after = body.slice(idx).replace(entireHeading, newEntireHeading);
  return `${before}${clause}\n\n${after}`;
}

const enBody = withClause(
  m.body_en,
  `10. Governing language\n${CLAUSE_EN}`,
  /^10\. Entire agreement$/m,
  '10. Entire agreement',
  '11. Entire agreement'
);
const esBody = m.body_es
  ? withClause(
      m.body_es,
      `10. Idioma que rige\n${CLAUSE_ES}`,
      /^10\. Acuerdo íntegro$/m,
      '10. Acuerdo íntegro',
      '11. Acuerdo íntegro'
    )
  : null;

if (!enBody) {
  console.error('Could not locate "10. Entire agreement" in the English Master — refusing to guess.');
  process.exit(1);
}
if (m.body_es && !esBody) {
  console.error('Could not locate "10. Acuerdo íntegro" in the Spanish Master — refusing to guess.');
  process.exit(1);
}

console.log('\nEnglish clause to insert as section 11:\n');
console.log(CLAUSE_EN);
console.log('\nSpanish rendering:\n');
console.log(CLAUSE_ES);
console.log(`\nSections: clause becomes 10, Entire agreement renumbered 10 → 11 (no gap).`);
console.log(`\nVersion note:\n${VERSION_NOTE}`);

if (!EXECUTE) {
  console.log('\nDRY RUN — re-run with --execute.\n');
  await db.end();
  process.exit(0);
}

await db.query('BEGIN');
try {
  await db.query(
    `UPDATE templates
        SET body_en = $1,
            body_es = COALESCE($2, body_es),
            version = version + 1,
            version_note = $3,
            updated_at = now()
      WHERE key = 'engagement_master'`,
    [enBody, esBody, VERSION_NOTE]
  );
  await db.query('COMMIT');
} catch (err) {
  await db.query('ROLLBACK');
  console.error('\nFAILED — rolled back:', err.message);
  await db.end();
  process.exit(1);
}

const after = await db.query(
  `SELECT version, version_note,
          body_en LIKE '%executed and concluded in the English language%' AS en_has_clause,
          body_es LIKE '%regirá, controlará y prevalecerá%' AS es_has_clause,
          body_en LIKE '%11. Entire agreement%' AS en_renumbered,
          body_es LIKE '%11. Acuerdo íntegro%' AS es_renumbered,
          needs_es_review, es_approved_at IS NOT NULL AS es_approved
     FROM templates WHERE key = 'engagement_master'`
);
console.log('\nRESULT:', JSON.stringify(after.rows[0], null, 1));
await db.end();
