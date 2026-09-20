/*
 * TRELLO IMPORT, PHASE 1 — MATCHING AND MAPPING, REPORT ONLY (Brian, 2026-09-19, items 11–13).
 *
 * Reads the staging bundle (imports/trello_import, gitignored; the raw Trello JSON never enters
 * the repo) and answers three questions against a COPY of production:
 *
 *   item 11  which Trello rows are already SAOS records, which are ambiguous, which are missing
 *   item 12  which SAOS stage each plain-English Trello stage maps to, and which have none
 *   item 13  which SAOS column each file-04 recurring-service fact lands in, and which are gaps
 *
 * NOTHING IS WRITTEN — not to the copy, not to production. This script only SELECTs. The write
 * side is scripts/trello-import.ts (item 15), and it is Phase 2 rehearsal on the copy only.
 *
 * THE COPY GUARD. The database name must end in `_copy`. A match run that pointed at `saos`
 * would be harmless today (it reads) but the guard is the same one trello-import.ts needs, and
 * a guard that lives in only one of two scripts is a guard someone forgets to add to the third.
 *
 * WHAT LEAVES THIS SCRIPT. Two kinds of output, deliberately separated:
 *   · out/*.csv  — the match results, which necessarily carry the Trello name key and the SAOS
 *                  id. Written under imports/trello_import/out (gitignored), never committed.
 *   · logs/*.log — counts, column names and stage names ONLY. These feed the report files
 *                  through scripts/report-table.mjs, so a client name here would end up in the
 *                  repo. Nothing in a log is a name.
 *
 * NORMALIZATION IS BORROWED, NOT INVENTED (item 11):
 *   · businesses — the bundle's own key() from imports/trello_import/scripts/extract.py, mirrored
 *     in trelloKey(): cut the noise, upper-case, & → AND, drop punctuation, drop the legal
 *     suffix tokens and the form-number tokens, collapse the spaces. SAOS business names go
 *     through the SAME function, which is what makes the comparison meaningful.
 *   · contacts — `norm` from apps/api/src/modules/crm/duplicates.ts (lower-case, collapse
 *     whitespace, trim), reproduced verbatim in contactNorm(). Note that the duplicate scan's
 *     normalizer does NOT strip punctuation or suffixes: it compares people's names, where a
 *     suffix stripper would merge a Jr. into his father. Both normalizers are here on purpose.
 *
 * Both normalizers, the similarity function and the copy guard live in scripts/trello-normalize.ts,
 * because scripts/trello-import.ts needs the same three and this file cannot be imported (it works
 * at the top level).
 *
 * SIMILARITY, for the candidate lists: character TRIGRAM JACCARD on the normalized string
 * (|A∩B| / |A∪B| over the set of 3-grams). Cheap, needs no extension on the copy, and ranks
 * a typo above a coincidence of one shared word — which token overlap does not.
 *
 *   DATABASE_URL=postgresql://…/saos_trello_copy \
 *     node --experimental-strip-types scripts/trello-match.ts [--dir /opt/saos/imports/trello_import]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { parseCsvObjects } from '../src/migration/csv.ts';
import { assertCopyDatabase, contactNorm, similarity, splitHousehold, trelloKey } from './trello-normalize.ts';

// ── the run ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
const DIR = resolve(dirArg >= 0 ? argv[dirArg + 1]! : '/opt/saos/imports/trello_import');
const OUT = resolve(DIR, 'out');
const LOGS = resolve(DIR, 'logs');
const DATE = '2026-09-19';

const url = process.env.DATABASE_URL ?? '';
const dbName = assertCopyDatabase(url);
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const pool = new pg.Pool({ connectionString: url, max: 4 });
const load = (f: string): Array<Record<string, string>> => parseCsvObjects(readFileSync(resolve(DIR, f), 'utf8'));

const files = {
  '01_tax_wip.csv': load('01_tax_wip.csv'),
  '02_tax_ar_worklist.csv': load('02_tax_ar_worklist.csv'),
  '03_tax_completed_roster.csv': load('03_tax_completed_roster.csv'),
  '04_business_services.csv': load('04_business_services.csv'),
};
const review = load('05_name_match_review.csv');

console.log(`trello-match: database '${dbName}', bundle ${DIR}`);
for (const [f, rows] of Object.entries(files)) console.log(`  ${f}: ${rows.length} row(s)`);

// ── SAOS side ───────────────────────────────────────────────────────────────

interface BizRow { id: string; name: string; key: string }
interface ConRow { id: string; first: string; last: string; full: string; lastKey: string; addr: string; households: string[] }

const biz = await pool.query<{ id: string; name: string }>(
  `SELECT id, name FROM businesses WHERE NOT is_archived AND NOT is_test ORDER BY created_at`
);
const businesses: BizRow[] = biz.rows.map((r) => ({ id: r.id, name: r.name, key: trelloKey(r.name) }));
const bizByKey = new Map<string, BizRow[]>();
for (const b of businesses) {
  if (!bizByKey.has(b.key)) bizByKey.set(b.key, []);
  bizByKey.get(b.key)!.push(b);
}

const con = await pool.query<{
  id: string; first_name: string; last_name: string; address_line1: string | null; zip: string | null; households: string[] | null;
}>(
  `SELECT c.id, c.first_name, c.last_name, c.address_line1, c.zip,
          ARRAY(SELECT bm.business_id::text FROM business_members bm WHERE bm.contact_id = c.id) AS households
     FROM contacts c
    WHERE NOT c.is_archived AND c.contact_status <> 'archived' AND NOT c.is_test
    ORDER BY c.created_at`
);
const contacts: ConRow[] = con.rows.map((r) => ({
  id: r.id,
  first: r.first_name,
  last: r.last_name,
  full: contactNorm(`${r.first_name} ${r.last_name}`),
  lastKey: contactNorm(r.last_name),
  addr: contactNorm(`${r.address_line1 ?? ''}|${r.zip ?? ''}`),
  households: r.households ?? [],
}));
const conByFull = new Map<string, ConRow[]>();
for (const c of contacts) {
  if (!conByFull.has(c.full)) conByFull.set(c.full, []);
  conByFull.get(c.full)!.push(c);
}
const conByLast = new Map<string, ConRow[]>();
for (const c of contacts) {
  if (!conByLast.has(c.lastKey)) conByLast.set(c.lastKey, []);
  conByLast.get(c.lastKey)!.push(c);
}
console.log(`  SAOS: ${businesses.length} live business(es), ${contacts.length} live contact(s)`);

/** File 05 clusters: a Trello key → the OTHER spellings in its cluster. Widens candidates only. */
const clusterOf = new Map<string, string>();
const membersOf = new Map<string, string[]>();
for (const r of review) {
  const k = (r.match_key ?? '').trim();
  const c = (r.cluster ?? '').trim();
  if (!k || !c) continue;
  clusterOf.set(k, c);
  if (!membersOf.has(c)) membersOf.set(c, []);
  membersOf.get(c)!.push(k);
}
function variantKeys(key: string): string[] {
  const c = clusterOf.get(key);
  if (!c) return [];
  return (membersOf.get(c) ?? []).filter((k) => k !== key);
}

// ── matching ────────────────────────────────────────────────────────────────

type Verdict = 'matched' | 'ambiguous' | 'not_in_saos';
interface Result {
  file: string; trelloCardId: string; trelloKey: string; saosType: string; saosId: string;
  score: string; candidates: string; reason: string; verdict: Verdict;
}

const CAND_MIN = 0.45;
const CAND_MAX = 5;

/**
 * Candidates for ONE needle. Deliberately not merged with the file-05 variants: a 1.00 that came
 * from a spelling variant is not a 1.00 for the row in hand, and a score column that hides which
 * string earned it is how a hint becomes an auto-accept by accident.
 *
 * CAVEAT, stated because the number is in a report: trigram JACCARD is over the SET of 3-grams,
 * so a name that repeats a phrase can score 1.00 against the phrase alone. It never promotes a
 * row to matched — auto-accept is exact string equality on the normalized key, never a score —
 * but a 1.00 in the candidates column means "identical 3-gram set", not "identical name".
 */
function rank(needle: string, pool_: Array<{ id: string; cmp: string }>): Array<[string, number]> {
  const seen = new Map<string, number>();
  for (const p of pool_) {
    const s = similarity(needle, p.cmp);
    if (s >= CAND_MIN) seen.set(p.id, Math.max(seen.get(p.id) ?? 0, s));
  }
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, CAND_MAX);
}
/** The same, over every file-05 sibling spelling of this key. Widens; never accepts. */
function rankVariants(variants: string[], pool_: Array<{ id: string; cmp: string }>): Array<[string, number]> {
  const seen = new Map<string, number>();
  for (const v of variants) for (const [id, s] of rank(v, pool_)) seen.set(id, Math.max(seen.get(id) ?? 0, s));
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, CAND_MAX);
}
const render = (r: Array<[string, number]>): string => r.map(([id, s]) => `${id}:${s.toFixed(2)}`).join(' ');
const topScore = (r: Array<[string, number]>): string => (r[0] ? r[0][1].toFixed(2) : '');
function combine(own: Array<[string, number]>, via05: Array<[string, number]>): string {
  return [own.length && `own ${render(own)}`, via05.length && `via05 ${render(via05)}`].filter(Boolean).join(' | ');
}

const bizPool = businesses.map((b) => ({ id: b.id, cmp: b.key }));
const conPool = contacts.map((c) => ({ id: c.id, cmp: c.full }));

/** File 04: match_key → businesses. Auto-accept only a unique exact normalized match. */
function matchBusiness(row: Record<string, string>): Result {
  const key = (row.match_key ?? '').trim();
  const exact = bizByKey.get(key) ?? [];
  const base = { file: '04_business_services.csv', trelloCardId: (row.bk_card_id ?? '').trim(), trelloKey: key };
  if (exact.length === 1) {
    return { ...base, saosType: 'business', saosId: exact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match', verdict: 'matched' };
  }
  const variants = variantKeys(key);
  const own = rank(key, bizPool);
  const via05 = rankVariants(variants, bizPool);
  if (exact.length > 1) {
    return {
      ...base, saosType: 'business', saosId: '', score: '1.00',
      candidates: exact.map((b) => `${b.id}:1.00`).join(' '),
      reason: `${exact.length} SAOS businesses share this normalized name`, verdict: 'ambiguous',
    };
  }
  if (own.length || via05.length) {
    return {
      ...base, saosType: 'business', saosId: '', score: topScore(own), candidates: combine(own, via05),
      reason: own.length
        ? (via05.length ? 'near matches on this key, plus file-05 spelling variants (never auto-accepted)' : 'near matches only, no exact normalized match')
        : 'no near match on this key; a file-05 spelling variant does match, which is a hint for a person, not an accept',
      verdict: 'ambiguous',
    };
  }
  return { ...base, saosType: 'business', saosId: '', score: '', candidates: '', reason: 'no SAOS business at or near this normalized name', verdict: 'not_in_saos' };
}

/**
 * Files 01–03: name_clean → contacts, with the household rule.
 *
 * A household row ("A & B Lastname") resolves ONLY when both first names land on exactly one
 * contact each, those contacts share the surname, and they share an address or a business
 * household. Anything less is ambiguous: "unique exact normalized match" is the auto-accept bar
 * and a two-person string does not clear it on its own.
 *
 * A row from the BUSINESS board whose name is an entity, not a person, is matched against
 * businesses as a fallback — otherwise 90 business returns would be counted as missing people.
 */
function matchContact(file: string, row: Record<string, string>): Result {
  const nameClean = (row.name_clean ?? '').trim();
  const key = (row.match_key ?? '').trim();
  const needle = contactNorm(nameClean);
  const base = { file, trelloCardId: (row.trello_card_id ?? '').trim(), trelloKey: key };
  const exact = conByFull.get(needle) ?? [];
  if (exact.length === 1) {
    return { ...base, saosType: 'contact', saosId: exact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match', verdict: 'matched' };
  }
  if (exact.length > 1) {
    return {
      ...base, saosType: 'contact', saosId: '', score: '1.00',
      candidates: exact.map((c) => `${c.id}:1.00`).join(' '),
      reason: `${exact.length} live SAOS contacts share this name (the duplicate scan's own territory)`, verdict: 'ambiguous',
    };
  }

  const hh = splitHousehold(nameClean);
  if (hh) {
    const lastKey = contactNorm(hh.last);
    const halves = hh.firsts.map((f) => (conByFull.get(contactNorm(`${f} ${hh.last}`)) ?? []));
    const resolvedBoth = halves.every((h) => h.length === 1);
    if (resolvedBoth) {
      const [a, b] = [halves[0]![0]!, halves[1]![0]!];
      const sameAddress = a.addr === b.addr && a.addr !== '|';
      const sameHousehold = a.households.some((h) => b.households.includes(h));
      if (sameAddress || sameHousehold) {
        return {
          ...base, saosType: 'contact_household', saosId: a.id, score: '1.00',
          candidates: `${a.id}:1.00 ${b.id}:1.00`,
          reason: `household: both first names resolve uniquely and the two contacts share ${sameAddress ? 'an address' : 'a business household'}`,
          verdict: 'matched',
        };
      }
      return {
        ...base, saosType: 'contact_household', saosId: '', score: '1.00',
        candidates: `${a.id}:1.00 ${b.id}:1.00`,
        reason: 'household: both names resolve but the contacts share neither address nor household',
        verdict: 'ambiguous',
      };
    }
    /*
     * How many of the two halves landed on exactly one contact? The number is the finding: a
     * household where one spouse is in SAOS and the other is not is a different piece of work
     * from one where neither is, and "ambiguous" alone hides which.
     */
    const resolvedHalves = halves.filter((h) => h.length === 1).length;
    const surnamePool = (conByLast.get(lastKey) ?? []).map((c) => ({ id: c.id, cmp: c.full }));
    const pool2 = surnamePool.length ? surnamePool : conPool;
    const own = rank(needle, pool2);
    const halfHits = rankVariants(hh.firsts.map((f) => contactNorm(`${f} ${hh.last}`)), pool2);
    if (own.length || halfHits.length) {
      return {
        ...base, saosType: 'contact_household', saosId: '', score: topScore(own), candidates: combine(own, halfHits),
        reason: `household: ${resolvedHalves} of 2 first name(s) resolve to exactly one contact; ${(conByLast.get(lastKey) ?? []).length} live contact(s) share the surname`,
        verdict: 'ambiguous',
      };
    }
    return { ...base, saosType: 'contact_household', saosId: '', score: '', candidates: '', reason: `household: neither name is in SAOS (${(conByLast.get(lastKey) ?? []).length} live contact(s) share the surname)`, verdict: 'not_in_saos' };
  }

  // Entity fallback: a business-board row whose name is the entity.
  const bizExact = bizByKey.get(key) ?? [];
  if (bizExact.length === 1) {
    return { ...base, saosType: 'business', saosId: bizExact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match against a SAOS business (entity return)', verdict: 'matched' };
  }
  const variants = variantKeys(key);
  const conRanked = rank(needle, conPool);
  const bizRanked = rank(key, bizPool);
  const bizVia05 = rankVariants(variants, bizPool);
  if (conRanked.length || bizRanked.length || bizVia05.length) {
    return {
      ...base, saosType: conRanked.length ? 'contact' : 'business', saosId: '',
      score: topScore(conRanked.length ? conRanked : bizRanked),
      candidates: [
        conRanked.length && `contact own ${render(conRanked)}`,
        bizRanked.length && `business own ${render(bizRanked)}`,
        bizVia05.length && `business via05 ${render(bizVia05)}`,
      ].filter(Boolean).join(' | '),
      reason: (conRanked.length || bizRanked.length)
        ? 'near matches only, no exact normalized match'
        : 'no near match on this key; a file-05 spelling variant does match a business, which is a hint for a person, not an accept',
      verdict: 'ambiguous',
    };
  }
  return { ...base, saosType: '', saosId: '', score: '', candidates: '', reason: 'no SAOS contact or business at or near this name', verdict: 'not_in_saos' };
}

const results: Result[] = [];
for (const f of ['01_tax_wip.csv', '02_tax_ar_worklist.csv', '03_tax_completed_roster.csv'] as const) {
  for (const row of files[f]) results.push(matchContact(f, row));
}
for (const row of files['04_business_services.csv']) results.push(matchBusiness(row));

// ── findings ────────────────────────────────────────────────────────────────

/** Bookkeeping status words that mean the cadence is history, not a live service. */
const DEAD_BK = ['lost', 'inactive', 'dissolved', 'self-prepared'];
function activeBookkeeping(row: Record<string, string>): boolean {
  if (!(row.bk_cadence_label ?? '').trim()) return false;
  const status = (row.bk_status ?? '').toLowerCase();
  return !DEAD_BK.some((d) => status.includes(d));
}
const activeBkKeys = new Set(files['04_business_services.csv'].filter(activeBookkeeping).map((r) => (r.match_key ?? '').trim()));

// ── out/*.csv ───────────────────────────────────────────────────────────────

const HEAD = 'source_file,trello_card_id,trello_key,saos_type,saos_id,score,candidates,reason';
const csvLine = (r: Result): string =>
  [r.file, r.trelloCardId, r.trelloKey, r.saosType, r.saosId, r.score, r.candidates, r.reason]
    .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
    .join(',');
for (const v of ['matched', 'ambiguous', 'not_in_saos'] as const) {
  const rows = results.filter((r) => r.verdict === v);
  const path = resolve(OUT, `trello_match_${v}.csv`);
  writeFileSync(path, [HEAD, ...rows.map(csvLine)].join('\n') + '\n');
  console.log(`  out/trello_match_${v}.csv: ${rows.length} row(s)`);
}

// ── logs/match-counts.log (item 11's table) ─────────────────────────────────

const countLines = ['source file | total | matched | ambiguous | not in SAOS | findings'];
for (const f of Object.keys(files)) {
  const rows = results.filter((r) => r.file === f);
  const matched = rows.filter((r) => r.verdict === 'matched').length;
  const ambiguous = rows.filter((r) => r.verdict === 'ambiguous').length;
  const missing = rows.filter((r) => r.verdict === 'not_in_saos');
  const findings =
    f === '04_business_services.csv'
      ? missing.filter((r) => activeBkKeys.has(r.trelloKey)).length
      : missing.length;
  countLines.push(`${f} | ${rows.length} | ${matched} | ${ambiguous} | ${missing.length} | ${findings}`);
}
const all = results.length;
countLines.push(
  `ALL FOUR FILES | ${all} | ${results.filter((r) => r.verdict === 'matched').length} | ` +
    `${results.filter((r) => r.verdict === 'ambiguous').length} | ${results.filter((r) => r.verdict === 'not_in_saos').length} | ` +
    `${countLines.slice(1).reduce((n, l) => n + Number(l.split(' | ')[5]), 0)}`
);
writeFileSync(resolve(LOGS, 'match-counts.log'), countLines.join('\n') + '\n');
console.log('\n' + countLines.join('\n'));

// Breakdown that belongs in the report's note, not in the table.
const entityFallback = results.filter((r) => r.file !== '04_business_services.csv' && r.verdict === 'matched' && r.saosType === 'business').length;
const households = results.filter((r) => r.saosType === 'contact_household').length;
const householdMatched = results.filter((r) => r.saosType === 'contact_household' && r.verdict === 'matched').length;
const widened = results.filter((r) => r.candidates.includes('via05')).length;
const onlyVia05 = results.filter((r) => r.reason.includes('hint for a person')).length;
console.log(
  `\nnote: ${entityFallback} row(s) in files 01–03 matched a SAOS business rather than a contact (entity returns); ` +
    `${households} household row(s), ${householdMatched} of them matched; ` +
    `${widened} ambiguous row(s) carry a file-05 variant candidate, ${onlyVia05} of them ONLY because of the variant.`
);

// ── logs/stage-map.log (item 12's table) ────────────────────────────────────

/**
 * Every plain-English Trello stage, and where it lands in SAOS.
 *
 * TAX_STAGES (apps/api/src/modules/tax/pipeline.ts) and engagement_status are the only real
 * targets. A value with no equivalent is marked GAP and is NOT forced into the nearest enum
 * member — Brian's instruction, and the reason the Trello lists cannot simply be renamed.
 */
const STAGE_MAP: Array<[string, string, string]> = [
  ['ready to prepare', 'in_preparation', 'maps; entering in_preparation needs estimate_locked_at (gate 2), so an import lands these behind a lock that Trello never held'],
  ['awaiting client response', 'pending_client_response', 'maps exactly; waiting_on = client'],
  ['awaiting documents', 'documents_requested', 'maps exactly'],
  ['awaiting documents (exempt org)', 'documents_requested', 'maps exactly; the exempt-org part is return_type 990/990ez, not a stage'],
  ['awaiting signature', 'ready_to_file', 'maps; the 8879 gate sits on entering filed, so "awaiting signature" IS ready_to_file'],
  ['prepared, not yet sent for signature', 'internal_review', 'maps'],
  ['extended, awaiting documents', 'documents_requested', 'maps; Extended is tax_engagements.extension_filed, a parallel flag, never a stage'],
  ['e-file rejected', 'rejected', 'maps exactly; a reject also carries a perfection_deadline SAOS computes, which Trello has no field for'],
  ['prior-year return in progress', 'in_preparation', 'maps; the filing lane is derived from the year (filingLane), never carried over from Trello'],
  ['accepted, client not yet notified', 'completed', 'maps; acceptance is recorded per jurisdiction by the ATX acknowledgment ingest, and "not yet notified" is the efile_acknowledgment automation, not a stage'],
  ['accepted, balance open', 'completed', 'maps; "balance open" is an invoice status (invoices.status), not a stage'],
  ['paper filed', 'filed', 'PARTIAL: filed exists, and so do filing_lane/paper_mailed_on/certified_tracking, but no acceptance can ever be RECORDED for a paper return (ack rows come only from the ATX report upload), so completion is a bare hand move with nothing accepted — see the R2 answer in the report'],
  ['amendment in progress', 'GAP', 'no amendment stage and no 1040X in the return_type enum; amendments exist only as the price-book item IND_AMENDMENT_1040X'],
  ['blocked on business return/financials', 'GAP', 'no blocked stage; the dependency is a task_dependencies row ("blocked by"), so this is a task shape, not a stage'],
  ['awaiting year-end financials (bookkeeping dependency)', 'GAP', 'same shape: documents_requested is close but the wait is on a close_cycles period, which is a task dependency, not a return stage'],
  ['awaiting CPA review of financials', 'GAP', 'internal_review is the REVIEW OF THE RETURN; this is Brian reviewing the books (close_cycles.statements_ready_at). Not the same thing, not forced'],
];
const stageCount = (f: '01_tax_wip.csv' | '02_tax_ar_worklist.csv', v: string): number =>
  files[f].filter((r) => (r.proposed_stage_plain ?? '').trim() === v).length;
const seen = new Set<string>();
for (const f of ['01_tax_wip.csv', '02_tax_ar_worklist.csv'] as const) {
  for (const r of files[f]) seen.add((r.proposed_stage_plain ?? '').trim());
}
const stageLines = ['proposed_stage_plain | file 01 | file 02 | total | SAOS stage | mapping'];
for (const [value, target, why] of STAGE_MAP) {
  if (!seen.has(value)) continue;
  const a = stageCount('01_tax_wip.csv', value);
  const b = stageCount('02_tax_ar_worklist.csv', value);
  stageLines.push(`${value} | ${a} | ${b} | ${a + b} | ${target} | ${why}`);
}
const unlisted = [...seen].filter((v) => v && !STAGE_MAP.some(([x]) => x === v));
for (const v of unlisted) {
  const a = stageCount('01_tax_wip.csv', v);
  const b = stageCount('02_tax_ar_worklist.csv', v);
  stageLines.push(`${v} | ${a} | ${b} | ${a + b} | UNREVIEWED | this value is in the bundle and not in the map above — a person decides it, not this script`);
}
writeFileSync(resolve(LOGS, 'stage-map.log'), stageLines.join('\n') + '\n');
console.log(`\nstage map: ${stageLines.length - 1} distinct proposed_stage_plain value(s), ${stageLines.filter((l) => l.includes('| GAP |')).length} gap(s), ${unlisted.length} unreviewed`);

// ── logs/field-map.log (item 13's table) ────────────────────────────────────

/**
 * File 04's recurring-service facts against the copy's own catalog.
 *
 * The verdict column is not an opinion: each candidate column is looked up in the copy's
 * information_schema, so "schema gap" means the column is not there, checked rather than
 * remembered. The proposed migration is named and NOT built (Brian's instruction).
 */
const FIELD_MAP: Array<{ field: string; col: string; note: string; migration: string }> = [
  { field: 'bk_cadence_label (bookkeeping cadence)', col: 'engagements.prep_cadence', note: 'prep_cadence enum is weekly|monthly|quarterly|semi_annual; the bundle also carries "annual" (35 rows), which the enum does not hold', migration: '0104_prep_cadence_annual: ALTER TYPE prep_cadence ADD VALUE \'annual\'' },
  { field: 'books_current_through', col: 'close_cycles.period_end', note: 'the LAST closed cycle\'s period_end is the fact, but there is no column saying "books are current through" on the business or the engagement; deriving it needs the cycles to exist first, and the import creates none', migration: '0105_books_current_through: businesses.books_current_through date, businesses.books_current_through_as_of date' },
  { field: 'bk_as_of (the 2026-07-01 as-of date)', col: 'businesses.books_current_through_as_of', note: 'no as-of column anywhere; the bundle is explicit that the fact is stale, and a stale fact with no as-of date reads as current', migration: '0105_books_current_through (same migration, second column)' },
  { field: 'sales_tax_frequency', col: 'engagements.service_line', note: 'sales_tax is a SERVICE LINE, so the engagement exists; the FREQUENCY has no column (prep_cadence belongs to the bookkeeping dials)', migration: '0106_sales_tax_frequency: engagements.filing_frequency text CHECK (monthly|quarterly|annual)' },
  { field: 'payroll (flag)', col: 'engagements.service_line', note: 'an active payroll engagement IS the flag; no boolean needed', migration: '—' },
  { field: 'payroll_provider', col: 'engagements.notes', note: 'no provider column; "QBO Payroll" would land in free text, which no report can group by', migration: '0107_payroll_provider: engagements.payroll_provider text' },
  { field: 'annual_report_state', col: 'entity_compliance.state', note: 'exact home', migration: '—' },
  { field: 'ar_anniversary_kind / ar_anniversary_mmdd', col: 'entity_compliance.annual_report_due_date', note: 'SAOS stores the DUE DATE, derived per state; the anniversary (admission or incorporation date, MM/DD) is the input that derives it and has no column — businesses.formation_date is the incorporation date only, and 57 of 61 rows are admission dates', migration: '0108_annual_report_anniversary: entity_compliance.anniversary_mmdd text, entity_compliance.anniversary_kind text CHECK (admission|incorporation)' },
  { field: 'access_facts (firm_holds_login, mfa_code_goes_to_*, sales_source_*)', col: '—', note: 'no column and no table; these are operational facts about who holds what, and CLAUDE.md keeps credentials out of SAOS entirely, so the honest home is a fact row, never a secret', migration: '0109_business_access_facts: business_access_facts (business_id uuid, fact text, recorded_at timestamptz, PRIMARY KEY (business_id, fact))' },
  { field: 'qbo_paid_by_2022', col: '—', note: 'who pays the QBO subscription; price_book_items.is_pass_through is the closest existing idea and it is a price-book fact, not a per-client one. The bundle calls this a 2022 roster hint', migration: '0110_qbo_subscription_payer: businesses.qbo_paid_by text CHECK (client|soto), businesses.qbo_paid_by_as_of date' },
];
const fieldLines = ['trello field (file 04) | rows with a value | SAOS table.column | verdict | proposed migration (not built)'];
for (const fm of FIELD_MAP) {
  const key = fm.field.match(/^([a-z0-9_]+)/)?.[1] ?? '';
  const filled = key ? files['04_business_services.csv'].filter((r) => (r[key] ?? '').trim()).length : 0;
  let verdict = 'schema gap';
  if (fm.col !== '—') {
    const [table, column] = fm.col.split('.');
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    verdict = Number(rows[0]!.n) > 0 ? `exists on the copy: ${fm.col}` : `schema gap: ${fm.col} is not there`;
  }
  fieldLines.push(`${fm.field} | ${filled} | ${fm.col} | ${verdict} — ${fm.note} | ${fm.migration}`);
}
writeFileSync(resolve(LOGS, 'field-map.log'), fieldLines.join('\n') + '\n');
console.log(`field map: ${fieldLines.length - 1} field(s) checked against the copy's information_schema`);

await pool.end();
console.log(`\ntrello-match: done (${DATE}). Nothing was written to any database.`);
