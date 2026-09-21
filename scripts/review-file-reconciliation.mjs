#!/usr/bin/env node
/*
 * THE REVIEW FILE AGAINST THE MATCH TABLE (Brian, 2026-09-20, ruling R34).
 *
 * review.csv has 150 names; the match-counts table says 89 "in the review file". Both numbers are
 * right and they count different things: the table's column counts CARD ROWS whose verdict is
 * ambiguous in an admitted file (files 01, 02, and file 04 with a live service — the rows of
 * out/trello_match_ambiguous.csv), and review.csv is ONE ROW PER TRELLO NAME across those same
 * files, plus every not-in-SAOS name from them, because "create or skip" is a decision too.
 *
 * This script reads the matcher's own output files under the bundle's out/ directory, sorts every
 * row into a class, checks that the classes sum from the 89 to the 150, and writes the counts as a
 * " | " log for scripts/report-table.mjs. COUNTS ONLY: no name, id or score leaves this script.
 *
 *   TRELLO_IMPORT_DIR=<bundle> node scripts/review-file-reconciliation.mjs
 *   node scripts/report-table.mjs --name review-file-reconciliation --from-log <bundle>/logs/review-reconciliation.log --sql "..."
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.env.TRELLO_IMPORT_DIR ?? 'C:/Users/brian/saos-imports/trello_import_v2/trello_import');
const OUT = resolve(DIR, 'out');
const LOGS = resolve(DIR, 'logs');
const DECISIONS = resolve(process.env.TRELLO_DECISIONS_FILE ?? 'C:/Users/brian/saos-imports/decisions.json');
if (DIR.replace(/\\/g, '/').toLowerCase().includes('/dropbox/')) throw new Error('refusing: the bundle path is under a sync root');

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1 || (r[0] ?? '').trim()).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
const load = (f) => parseCsv(readFileSync(resolve(OUT, f), 'utf8'));
const review = load('review.csv');
const ambiguous = load('trello_match_ambiguous.csv');
const matched = load('trello_match_matched.csv');
const notInSaos = load('trello_match_not_in_saos.csv');
const enrichment = existsSync(resolve(OUT, 'enrichment_file03.csv')) ? load('enrichment_file03.csv') : [];
const decisions = existsSync(DECISIONS) ? JSON.parse(readFileSync(DECISIONS, 'utf8')) : {};

const byFile = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.source_file, (m.get(r.source_file) ?? 0) + 1);
  return [...m].sort().map(([f, n]) => `${f.slice(0, 2)}: ${n}`).join(', ');
};
const keysOf = (rows) => new Set(rows.map((r) => r.trello_key));

// ── the 89: ambiguous card rows in the admitted files (the ambiguous file IS the review set) ──
const reviewSetRows = ambiguous.length;
const reviewSetNames = keysOf(ambiguous);

// ── review.csv, by verdict ──
const reviewNames = new Set(review.map((r) => r.match_key));
const reviewAmbiguous = review.filter((r) => r.verdict === 'ambiguous');
const reviewNotInSaos = review.filter((r) => r.verdict === 'not_in_saos');

// ── not-in-SAOS card rows, by file: 01/02 always admitted; 03 never (enrichment); 04 only with a
//    live service, which is the case exactly when its name reached review.csv ──
const nisFile03 = notInSaos.filter((r) => r.source_file === '03_tax_completed_roster.csv');
const nisFile03NameAlsoAdmitted = nisFile03.filter((r) => reviewNames.has(r.trello_key));
const nisFile04 = notInSaos.filter((r) => r.source_file === '04_business_services.csv');
const nisFile04Dead = nisFile04.filter((r) => !reviewNames.has(r.trello_key));
const nisAdmitted = notInSaos.filter((r) => (r.source_file.startsWith('01') || r.source_file.startsWith('02')) || (r.source_file.startsWith('04') && reviewNames.has(r.trello_key)));
const nisOther = notInSaos.filter((r) => (r.source_file.startsWith('01') || r.source_file.startsWith('02')) && !reviewNames.has(r.trello_key));
const nisAdmittedNames = keysOf(nisAdmitted);

// ── a name ambiguous on one card and not-in-SAOS on another: one review row, verdict ambiguous ──
const bothWays = [...nisAdmittedNames].filter((k) => reviewSetNames.has(k));
// ── a name on several admitted ambiguous cards: collapsed to one review row ──
const ambiguousDuplicateRows = reviewSetRows - reviewSetNames.size;
const nisDuplicateRows = nisAdmitted.length - nisAdmittedNames.size;

// ── ambiguous card rows NOT in the review set: file 03, and file-04 rows with no live service ──
// (the matcher writes only the admitted ambiguous rows to its ambiguous file; the table's
//  "ambiguous new" column counted every ambiguous row, so the rest is read off the table itself)
const decided = review.filter((r) => (r.pick ?? '').trim()).length;
const decidedInMatched = matched.filter((r) => r.tier === 'decision').length;
const skipPicks = matched.filter((r) => r.saos_type === 'skip').length;
const createPicks = notInSaos.filter((r) => r.saos_type === 'create').length;
const threeCandidates = review.filter((r) => (r.candidate3_id ?? '').trim()).length;
const noCandidates = review.filter((r) => !(r.candidate1_id ?? '').trim()).length;
const filesCombo = (() => {
  const m = new Map();
  for (const r of review) m.set(r.source_files, (m.get(r.source_files) ?? 0) + 1);
  return [...m].sort().map(([f, n]) => `${f || '(none)'}: ${n}`).join(', ');
})();

// ── THE SUMS, asserted ──
const expected150 = reviewSetNames.size + nisAdmittedNames.size - bothWays.length;
const problems = [];
if (expected150 !== review.length) problems.push(`ambiguous names ${reviewSetNames.size} + not-in-SAOS names ${nisAdmittedNames.size} - both ways ${bothWays.length} = ${expected150}, but review.csv has ${review.length}`);
if (reviewAmbiguous.length !== reviewSetNames.size) problems.push(`review.csv ambiguous rows ${reviewAmbiguous.length} != distinct ambiguous names ${reviewSetNames.size}`);
if (reviewNotInSaos.length !== nisAdmittedNames.size - bothWays.length) problems.push(`review.csv not-in-SAOS rows ${reviewNotInSaos.length} != not-in-SAOS-only names ${nisAdmittedNames.size - bothWays.length}`);
if (nisOther.length !== 0) problems.push(`${nisOther.length} not-in-SAOS row(s) from files 01/02 are missing from review.csv`);
if (nisFile03.length !== enrichment.length) problems.push(`file-03 not-in-SAOS rows ${nisFile03.length} != enrichment list ${enrichment.length}`);

const lines = [
  'row class | card rows | distinct names | in the 89 (match table: in the review file) | in the 150 (review.csv) | how it is counted',
  `ambiguous card rows in the admitted files (01, 02, live 04) — out/trello_match_ambiguous.csv | ${reviewSetRows} | ${reviewSetNames.size} | ${reviewSetRows} | ${reviewSetNames.size} | the 89 is CARD ROWS (${byFile(ambiguous)}); review.csv has one row per NAME`,
  `  of which: the same name on more than one admitted ambiguous card, collapsed | ${ambiguousDuplicateRows} | - | ${ambiguousDuplicateRows} | 0 | ${reviewSetRows} rows - ${reviewSetNames.size} names = ${ambiguousDuplicateRows} rows that add nothing to the 150`,
  `not-in-SAOS card rows in the admitted files, whose name is in review.csv | ${nisAdmitted.length} | ${nisAdmittedNames.size} | 0 | ${nisAdmittedNames.size - bothWays.length} | never in the 89 (not ambiguous); in the 150 because "create or skip" is a decision the importer obeys (${byFile(nisAdmitted)})`,
  `  of which: the same name on more than one not-in-SAOS card, collapsed | ${nisDuplicateRows} | - | 0 | 0 | ${nisAdmitted.length} rows - ${nisAdmittedNames.size} names`,
  `  of which: a name ambiguous on one card and not-in-SAOS on another | - | ${bothWays.length} | 0 | 0 | one review row, verdict ambiguous (there is something to choose between); already counted in the ambiguous names above`,
  `not-in-SAOS card rows from file 03 — out/enrichment_file03.csv | ${nisFile03.length} | ${keysOf(nisFile03).size} | 0 | 0 | file 03 is never imported; these go to the enrichment list and are never created; ${nisFile03NameAlsoAdmitted.length} of them carry a name that also reached review.csv through another file's row, and are counted there under that row, not here`,
  `not-in-SAOS card rows from file 04 with no live service | ${nisFile04Dead.length} | ${keysOf(nisFile04Dead).size} | 0 | 0 | not admitted: nothing live to attach (the same rule that keeps them out of the 89)`,
  `not-in-SAOS card rows from files 01/02 missing from review.csv (must be 0) | ${nisOther.length} | ${keysOf(nisOther).size} | 0 | 0 | every 01/02 not-in-SAOS row is admitted`,
  `review.csv rows by verdict | - | ${review.length} | - | ${review.length} | ambiguous ${reviewAmbiguous.length}, not_in_saos ${reviewNotInSaos.length}`,
  `review.csv rows by the files the name appears in | - | ${review.length} | - | ${review.length} | ${filesCombo}`,
  `review.csv rows carrying a saved pick (decisions file) | - | ${decided} | - | ${decided} | a pick already applied is still a row, with the pick shown; ${decidedInMatched} matched card row(s) at tier decision and ${skipPicks} skip row(s) sit in the matched file, ${createPicks} create row(s) in the not-in-SAOS file`,
  `review.csv rows with three candidates / with none | - | ${threeCandidates} / ${noCandidates} | - | - | none: the ${reviewNotInSaos.length} not-in-SAOS names, where the decision is create or skip, plus ${noCandidates - reviewNotInSaos.length} ambiguous name(s) with no live candidate to show (a saved pick naming an id that is no longer live comes back ambiguous on purpose)`,
  `THE SUM | ${reviewSetRows + nisAdmitted.length} | ${expected150} | ${reviewSetRows} | ${review.length} | ${reviewSetNames.size} ambiguous names + ${nisAdmittedNames.size} not-in-SAOS names - ${bothWays.length} counted both ways = ${expected150}; the 89 is ${reviewSetRows} ambiguous card rows = ${reviewSetNames.size} names + ${ambiguousDuplicateRows} repeats`,
  `CHECK | - | - | - | - | ${problems.length === 0 ? 'the classes sum from the 89 to the 150' : 'DOES NOT SUM: ' + problems.join('; ')}`,
];
mkdirSync(LOGS, { recursive: true });
writeFileSync(resolve(LOGS, 'review-reconciliation.log'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (problems.length) { console.error('\nreconciliation FAILED: ' + problems.join('; ')); process.exit(1); }
