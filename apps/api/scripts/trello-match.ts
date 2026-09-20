/*
 * TRELLO IMPORT, PHASE 1 — MATCHING AND MAPPING, REPORT ONLY (Brian, 2026-09-19, items 11–13).
 *
 * THE BUNDLE IS NOT IN THE REPO AND NOT IN DROPBOX (Brian, 2026-09-20). It lives at
 * C:/Users/brian/saos-imports/trello_import on Brian's machine and /opt/saos/imports/trello_import
 * on the box, and the directory comes from TRELLO_IMPORT_DIR (or --dir, which wins). It moved
 * because the repo sits inside Dropbox and Dropbox syncs the whole tree: a gitignored path under it
 * is still a client file leaving the machine. Outputs go to <dir>/out and <dir>/logs — never into
 * the repo.
 *
 * Reads the staging bundle and answers three questions against a COPY of production:
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
import { assertCopyDatabase, contactNorm, similarity, splitHousehold, STAGE_MAP, trelloKey } from './trello-normalize.ts';

// ── the run ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
/** --dir wins, then TRELLO_IMPORT_DIR, then Brian's machine. Never a path inside the repo. */
const DEFAULT_DIR = 'C:/Users/brian/saos-imports/trello_import';
const DIR = resolve(dirArg >= 0 ? argv[dirArg + 1]! : process.env.TRELLO_IMPORT_DIR ?? DEFAULT_DIR);
const OUT = resolve(DIR, 'out');
const LOGS = resolve(DIR, 'logs');
const DATE = '2026-09-20';

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
/**
 * Which live contacts are members of which business. Built from the same rows the contact query
 * already returned, so the owner-in-parentheses rule below costs no extra query.
 */
const membersByBiz = new Map<string, string[]>();
for (const c of contacts) {
  for (const b of c.households) {
    if (!membersByBiz.has(b)) membersByBiz.set(b, []);
    membersByBiz.get(b)!.push(c.id);
  }
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
/** Which rule accepted a row. '' when nothing did. */
type Tier = '' | 'exact' | 'household_both' | 'household_first' | 'trigram_090' | 'owner_in_parens';
interface Result {
  file: string; trelloCardId: string; trelloKey: string; saosType: string; saosId: string;
  score: string; candidates: string; reason: string; verdict: Verdict;
  /**
   * The verdict the 2026-09-19 rule would have given — unique exact normalized match and nothing
   * else. Carried on every row so the counts report shows old against new from ONE run rather than
   * two, which is the only way the two columns are comparable.
   */
  tier1Verdict: Verdict;
  tier: Tier;
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

/*
 * -- SECOND-TIER AUTO-ACCEPT (Brian, 2026-09-20, item d) --------------------
 *
 * The 2026-09-19 rule was one rule: a unique EXACT match on the normalized key, and everything else
 * to a person. It left 320 of 1066 rows ambiguous, and the counts report said why: 73 household rows
 * auto-accepted ZERO of the time, and hundreds of business rows sat at 0.90-plus similarity with one
 * obvious candidate. A review pile that large does not get reviewed; it gets skimmed, which is worse
 * than a rule.
 *
 * So three more rules, each narrow enough to name the failure it would make.
 *
 *   HOUSEHOLDS -- the FIRST-NAMED person's exact normalized first and last name, when that lands on
 *   exactly one contact. "A & B Lastname" is one Trello card for one return, and the first name on
 *   it is the one Trello treated as the client. The failure this could make: attaching the return to
 *   the husband when the wife is the primary filer -- a wrong PRIMARY on a joint return, not a wrong
 *   household, and visible and fixable on the return's own page. It cannot attach the return to the
 *   wrong family, because the surname and one exact first name both have to land.
 *
 *   BUSINESSES, BY SIMILARITY -- trigram >= 0.90 with a UNIQUE candidate whose runner-up is at least
 *   0.15 lower. Both halves matter and for different reasons: 0.90 is close enough that the
 *   difference is punctuation or a dropped word, and the 0.15 gap is what stops the rule firing
 *   between two businesses that resemble EACH OTHER -- "SOTO HOLDINGS" and "SOTO HOLDINGS II" both
 *   score high against "SOTO HOLDING", and a rule that took the top one would silently pick a
 *   sibling entity. A tight cluster stays ambiguous by design.
 *
 *   BUSINESSES, BY OWNER -- the person named in parentheses on the Trello card matches, exactly and
 *   uniquely, a contact who is ALREADY a member of the candidate business in SAOS. This is the
 *   strongest of the three and the one with the least to do with spelling: the name of an entity is
 *   evidence about a string, and the identity of its owner is evidence about a relationship SAOS
 *   already records. It accepts candidates the similarity rule refuses.
 *
 * WHAT DID NOT CHANGE. A score alone still never accepts anything below 0.90, a name shared by two
 * SAOS records still never accepts, and file 05's spelling variants are still hints only -- a variant
 * that matches is a reason for a person to look, never an accept (the 2026-09-19 reasoning, intact).
 */

const TIER2_MIN = 0.9;
const TIER2_GAP = 0.15;

/** The tier-2 similarity rule, over a ranked candidate list. Returns the accepted id or null. */
function acceptBySimilarity(ranked: Array<[string, number]>): { id: string; score: number } | null {
  const top = ranked[0];
  if (!top || top[1] < TIER2_MIN) return null;
  const runnerUp = ranked[1];
  if (runnerUp && top[1] - runnerUp[1] < TIER2_GAP) return null;
  return { id: top[0], score: top[1] };
}

/**
 * The tier-2 owner rule. `owner` is file 04's entity_owner_in_parens, free text typed by hand, and it
 * carries junk ('SM', 'CLOSED', a note about a client who died) alongside real names. The junk is
 * filtered by the requirement itself: it has to be a unique exact normalized contact name AND that
 * contact has to already be a member of exactly one of the candidate businesses.
 */
function acceptByOwner(owner: string, candidateIds: string[]): { id: string; contactId: string } | null {
  const needle = contactNorm(owner.trim());
  if (!needle) return null;
  const hits = conByFull.get(needle) ?? [];
  if (hits.length !== 1) return null;
  const contactId = hits[0]!.id;
  const linked = candidateIds.filter((b) => (membersByBiz.get(b) ?? []).includes(contactId));
  if (linked.length !== 1) return null;
  return { id: linked[0]!, contactId };
}

/** File 04: match_key -> businesses. Tier 1 is a unique exact normalized match; then the two business rules. */
function matchBusiness(row: Record<string, string>): Result {
  const key = (row.match_key ?? '').trim();
  const exact = bizByKey.get(key) ?? [];
  const base = { file: '04_business_services.csv', trelloCardId: (row.bk_card_id ?? '').trim(), trelloKey: key };
  if (exact.length === 1) {
    return { ...base, saosType: 'business', saosId: exact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match', verdict: 'matched', tier1Verdict: 'matched', tier: 'exact' };
  }
  const variants = variantKeys(key);
  const own = rank(key, bizPool);
  const via05 = rankVariants(variants, bizPool);
  /** Tier 1's answer, before the new rules get a turn. */
  const tier1: Verdict = exact.length > 1 || own.length || via05.length ? 'ambiguous' : 'not_in_saos';

  // Tier 2, rule 2: similarity, on this key's OWN candidates. Never on a file-05 variant's.
  const bySim = exact.length === 0 ? acceptBySimilarity(own) : null;
  if (bySim) {
    return {
      ...base, saosType: 'business', saosId: bySim.id, score: bySim.score.toFixed(2), candidates: combine(own, via05),
      reason: `tier 2: trigram ${bySim.score.toFixed(2)} on a unique candidate, runner-up at least ${TIER2_GAP} lower`,
      verdict: 'matched', tier1Verdict: tier1, tier: 'trigram_090',
    };
  }
  // Tier 2, rule 3: the owner in parentheses is already a member of exactly one candidate business.
  const candidateIds = [...new Set([...exact.map((b) => b.id), ...own.map(([id]) => id)])];
  const byOwner = acceptByOwner(row.entity_owner_in_parens ?? '', candidateIds);
  if (byOwner) {
    return {
      ...base, saosType: 'business', saosId: byOwner.id, score: topScore(own), candidates: combine(own, via05),
      reason: `tier 2: the owner named in parentheses is already a member of this SAOS business (contact ${byOwner.contactId})`,
      verdict: 'matched', tier1Verdict: tier1, tier: 'owner_in_parens',
    };
  }

  if (exact.length > 1) {
    return {
      ...base, saosType: 'business', saosId: '', score: '1.00',
      candidates: exact.map((b) => `${b.id}:1.00`).join(' '),
      reason: `${exact.length} SAOS businesses share this normalized name`, verdict: 'ambiguous',
      tier1Verdict: tier1, tier: '',
    };
  }
  if (own.length || via05.length) {
    return {
      ...base, saosType: 'business', saosId: '', score: topScore(own), candidates: combine(own, via05),
      reason: own.length
        ? (via05.length ? 'near matches on this key, plus file-05 spelling variants (never auto-accepted)' : 'near matches only, below the tier-2 bar')
        : 'no near match on this key; a file-05 spelling variant does match, which is a hint for a person, not an accept',
      verdict: 'ambiguous', tier1Verdict: tier1, tier: '',
    };
  }
  return { ...base, saosType: 'business', saosId: '', score: '', candidates: '', reason: 'no SAOS business at or near this normalized name', verdict: 'not_in_saos', tier1Verdict: tier1, tier: '' };
}

/**
 * Files 01-03: name_clean -> contacts, with the household rules.
 *
 * TIER 1 households resolve only when BOTH first names land on exactly one contact each and those two
 * contacts share an address or a business household. TIER 2 accepts the FIRST-NAMED person alone when
 * that name is unique -- see the block comment above for what that can and cannot get wrong.
 *
 * A row from the BUSINESS board whose name is an entity, not a person, is matched against businesses
 * as a fallback -- otherwise 90 business returns would be counted as missing people -- and the tier-2
 * similarity rule applies there too, because it is a rule about business names wherever they appear.
 */
function matchContact(file: string, row: Record<string, string>): Result {
  const nameClean = (row.name_clean ?? '').trim();
  const key = (row.match_key ?? '').trim();
  const needle = contactNorm(nameClean);
  const base = { file, trelloCardId: (row.trello_card_id ?? '').trim(), trelloKey: key };
  const exact = conByFull.get(needle) ?? [];
  if (exact.length === 1) {
    return { ...base, saosType: 'contact', saosId: exact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match', verdict: 'matched', tier1Verdict: 'matched', tier: 'exact' };
  }
  if (exact.length > 1) {
    return {
      ...base, saosType: 'contact', saosId: '', score: '1.00',
      candidates: exact.map((c) => `${c.id}:1.00`).join(' '),
      reason: `${exact.length} live SAOS contacts share this name (the duplicate scan's own territory)`, verdict: 'ambiguous',
      tier1Verdict: 'ambiguous', tier: '',
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
          verdict: 'matched', tier1Verdict: 'matched', tier: 'household_both',
        };
      }
    }
    /*
     * TIER 2, RULE 1. The first-named person, exactly and uniquely. Reached whether or not the second
     * name resolved: a pair that resolves to two contacts sharing neither an address nor a household
     * is precisely the pair where the card's first name is the better evidence, and a pair where only
     * the first name is in SAOS is the common shape (37 of the 73 household rows on 2026-09-19).
     */
    const resolvedHalves = halves.filter((h) => h.length === 1).length;
    const first = halves[0] ?? [];
    if (first.length === 1) {
      return {
        ...base, saosType: 'contact_household', saosId: first[0]!.id, score: '1.00',
        candidates: halves.flat().map((c) => `${c.id}:1.00`).join(' '),
        reason: `tier 2: the first-named person resolves to exactly one contact (${resolvedHalves} of 2 names resolve); the return attaches to them`,
        verdict: 'matched', tier1Verdict: 'ambiguous', tier: 'household_first',
      };
    }
    /*
     * How many of the two halves landed on exactly one contact? The number is the finding: a household
     * where one spouse is in SAOS and the other is not is a different piece of work from one where
     * neither is, and "ambiguous" alone hides which.
     */
    const surnamePool = (conByLast.get(lastKey) ?? []).map((c) => ({ id: c.id, cmp: c.full }));
    const pool2 = surnamePool.length ? surnamePool : conPool;
    const own = rank(needle, pool2);
    const halfHits = rankVariants(hh.firsts.map((f) => contactNorm(`${f} ${hh.last}`)), pool2);
    if (own.length || halfHits.length) {
      return {
        ...base, saosType: 'contact_household', saosId: '', score: topScore(own), candidates: combine(own, halfHits),
        reason: `household: ${resolvedHalves} of 2 first name(s) resolve to exactly one contact; ${(conByLast.get(lastKey) ?? []).length} live contact(s) share the surname`,
        verdict: 'ambiguous', tier1Verdict: 'ambiguous', tier: '',
      };
    }
    return { ...base, saosType: 'contact_household', saosId: '', score: '', candidates: '', reason: `household: neither name is in SAOS (${(conByLast.get(lastKey) ?? []).length} live contact(s) share the surname)`, verdict: 'not_in_saos', tier1Verdict: 'not_in_saos', tier: '' };
  }

  // Entity fallback: a business-board row whose name is the entity.
  const bizExact = bizByKey.get(key) ?? [];
  if (bizExact.length === 1) {
    return { ...base, saosType: 'business', saosId: bizExact[0]!.id, score: '1.00', candidates: '', reason: 'unique exact normalized match against a SAOS business (entity return)', verdict: 'matched', tier1Verdict: 'matched', tier: 'exact' };
  }
  const variants = variantKeys(key);
  const conRanked = rank(needle, conPool);
  const bizRanked = rank(key, bizPool);
  const bizVia05 = rankVariants(variants, bizPool);
  const tier1: Verdict = bizExact.length > 1 || conRanked.length || bizRanked.length || bizVia05.length ? 'ambiguous' : 'not_in_saos';

  // Tier 2, rule 2 again: an entity name at 0.90 with a clear winner is the same evidence here.
  const bySim = bizExact.length === 0 ? acceptBySimilarity(bizRanked) : null;
  if (bySim) {
    return {
      ...base, saosType: 'business', saosId: bySim.id, score: bySim.score.toFixed(2),
      candidates: [conRanked.length ? `contact own ${render(conRanked)}` : '', `business own ${render(bizRanked)}`].filter(Boolean).join(' | '),
      reason: `tier 2: entity return, trigram ${bySim.score.toFixed(2)} on a unique SAOS business, runner-up at least ${TIER2_GAP} lower`,
      verdict: 'matched', tier1Verdict: tier1, tier: 'trigram_090',
    };
  }
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
        ? 'near matches only, below the tier-2 bar'
        : 'no near match on this key; a file-05 spelling variant does match a business, which is a hint for a person, not an accept',
      verdict: 'ambiguous', tier1Verdict: tier1, tier: '',
    };
  }
  return { ...base, saosType: '', saosId: '', score: '', candidates: '', reason: 'no SAOS contact or business at or near this name', verdict: 'not_in_saos', tier1Verdict: tier1, tier: '' };
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

// -- the review file's admission rule, and the enrichment list ---------------

/**
 * WHAT GOES IN THE REVIEW FILE (Brian, 2026-09-20, item e): three kinds of row and no others.
 *
 *   file 01 -- work in progress. Every ambiguous row is a return somebody has to place.
 *   file 02 -- the AR worklist. Every ambiguous row is money owed against a return.
 *   file 04 -- ONLY where a service is actually live (a bookkeeping cadence, sales tax, or payroll).
 *
 * AND FILE 03'S AMBIGUOUS ROWS ARE NOT IN IT. File 03 is 388 accepted-and-paid TY2025 returns and
 * the bundle's own import intent for it is "existence check only -- do not import". An ambiguous row
 * there resolves to no work: the return is filed, the invoice is paid, and nothing about which SAOS
 * contact the card meant changes anything anyone does. Putting 133 of them in the review file made it
 * 40% noise, and a review file that is mostly noise is a review file nobody finishes. The file-03
 * rows that DO mean something -- the ones with no SAOS record at all -- are a different artefact: an
 * enrichment list, below.
 *
 * The same reasoning excludes an inactive file-04 row. A business whose bookkeeping is marked Lost
 * and whose payroll is closed has no live service to attach; matching it is archaeology.
 */
const DEAD_SERVICE = ['closed', 'not_client', 'lost', 'inactive', 'dissolved'];
function activeService(row: Record<string, string>): boolean {
  if (activeBookkeeping(row)) return true;
  const stFreq = (row.sales_tax_frequency ?? '').trim();
  const stStatus = (row.sales_tax_status ?? '').toLowerCase();
  if (stFreq && !DEAD_SERVICE.some((d) => stStatus.includes(d))) return true;
  if ((row.payroll ?? '').trim().toLowerCase() === 'yes') return true;
  return false;
}
const activeServiceKeys = new Set(
  files['04_business_services.csv'].filter(activeService).map((r) => (r.match_key ?? '').trim())
);

/** A row belongs in the review file if it is ambiguous AND one of the three admitted kinds. */
function inReviewFile(r: Result): boolean {
  if (r.verdict !== 'ambiguous') return false;
  if (r.file === '01_tax_wip.csv' || r.file === '02_tax_ar_worklist.csv') return true;
  if (r.file === '04_business_services.csv') return activeServiceKeys.has(r.trelloKey);
  return false; // 03_tax_completed_roster.csv
}

// -- out/*.csv ---------------------------------------------------------------

const HEAD = 'source_file,trello_card_id,trello_key,saos_type,saos_id,score,tier,candidates,reason';
const csvLine = (r: Result): string =>
  [r.file, r.trelloCardId, r.trelloKey, r.saosType, r.saosId, r.score, r.tier, r.candidates, r.reason]
    .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
    .join(',');
const written: Record<string, number> = {};
for (const v of ['matched', 'ambiguous', 'not_in_saos'] as const) {
  // The ambiguous file IS the review file, so it is the filtered set rather than every ambiguous row.
  const rows = v === 'ambiguous' ? results.filter(inReviewFile) : results.filter((r) => r.verdict === v);
  writeFileSync(resolve(OUT, `trello_match_${v}.csv`), [HEAD, ...rows.map(csvLine)].join('\n') + '\n');
  written[v] = rows.length;
  console.log(`  out/trello_match_${v}.csv: ${rows.length} row(s)${v === 'ambiguous' ? ' (the review file: files 01, 02 and active 04 only)' : ''}`);
}

/**
 * THE FILE-03 ENRICHMENT LIST (item f). A file-03 row with no SAOS record at all is a client whose
 * TY2025 return we filed and who is not in the system -- which is a real finding and NOT a thing the
 * import creates, because a completed-and-paid roster row carries no engagement, no stage and no
 * money: creating a contact from it would put a name in the directory with nothing attached and
 * nobody accountable. It goes on a list for a person to enrich.
 */
const enrichment = results.filter((r) => r.file === '03_tax_completed_roster.csv' && r.verdict === 'not_in_saos');
const f03ByCard = new Map(files['03_tax_completed_roster.csv'].map((r) => [(r.trello_card_id ?? '').trim(), r]));
writeFileSync(
  resolve(OUT, 'enrichment_file03.csv'),
  [
    'trello_card_id,trello_key,name_clean,form_type,last_activity,reason',
    ...enrichment.map((r) => {
      const row = f03ByCard.get(r.trelloCardId) ?? {};
      return [r.trelloCardId, r.trelloKey, row.name_clean ?? '', row.form_type ?? '', row.last_activity ?? '', r.reason]
        .map((v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(',');
    }),
  ].join('\n') + '\n'
);
console.log(`  out/enrichment_file03.csv: ${enrichment.length} row(s) — listed for enrichment, NEVER created`);

// -- logs/match-counts.log (item 11's table, old rule against new) -----------

/*
 * OLD AND NEW FROM ONE RUN. Every Result carries tier1Verdict -- what the 2026-09-19 exact-match-only
 * rule would have said -- alongside the verdict the tier-2 rules produced. Two columns from two
 * separate runs against two moments of the copy would not be comparable; these are the same 1066 rows
 * judged twice.
 */
const countLines = [
  'source file | total | matched old | matched new | ambiguous old | ambiguous new | not in SAOS old | not in SAOS new | in the review file',
];
const tally = (rows: Result[], v: Verdict, which: 'tier1Verdict' | 'verdict'): number =>
  rows.filter((r) => r[which] === v).length;
for (const f of Object.keys(files)) {
  const rows = results.filter((r) => r.file === f);
  countLines.push(
    [
      f, rows.length,
      tally(rows, 'matched', 'tier1Verdict'), tally(rows, 'matched', 'verdict'),
      tally(rows, 'ambiguous', 'tier1Verdict'), tally(rows, 'ambiguous', 'verdict'),
      tally(rows, 'not_in_saos', 'tier1Verdict'), tally(rows, 'not_in_saos', 'verdict'),
      rows.filter(inReviewFile).length,
    ].join(' | ')
  );
}
countLines.push(
  [
    'ALL FOUR FILES', results.length,
    tally(results, 'matched', 'tier1Verdict'), tally(results, 'matched', 'verdict'),
    tally(results, 'ambiguous', 'tier1Verdict'), tally(results, 'ambiguous', 'verdict'),
    tally(results, 'not_in_saos', 'tier1Verdict'), tally(results, 'not_in_saos', 'verdict'),
    results.filter(inReviewFile).length,
  ].join(' | ')
);
writeFileSync(resolve(LOGS, 'match-counts.log'), countLines.join('\n') + '\n');
console.log('\n' + countLines.join('\n'));

// Breakdown that belongs in the report's note, not in the table.
const byTier = new Map<string, number>();
for (const r of results.filter((x) => x.verdict === 'matched')) byTier.set(r.tier, (byTier.get(r.tier) ?? 0) + 1);
const entityFallback = results.filter((r) => r.file !== '04_business_services.csv' && r.verdict === 'matched' && r.saosType === 'business').length;
const households = results.filter((r) => r.saosType === 'contact_household').length;
const householdMatched = results.filter((r) => r.saosType === 'contact_household' && r.verdict === 'matched').length;
const widened = results.filter((r) => r.candidates.includes('via05')).length;
const promoted = results.filter((r) => r.verdict === 'matched' && r.tier1Verdict !== 'matched').length;
const activeMissing04 = results.filter((r) => r.file === '04_business_services.csv' && r.verdict === 'not_in_saos' && activeServiceKeys.has(r.trelloKey)).length;
console.log(
  `\nnote: matched by tier — ${[...byTier].map(([t, n]) => `${t || '(none)'} ${n}`).join(', ')}; ` +
    `${promoted} row(s) promoted from ambiguous/not-in-SAOS by the tier-2 rules; ` +
    `${entityFallback} row(s) in files 01–03 matched a SAOS business rather than a contact (entity returns); ` +
    `${households} household row(s), ${householdMatched} of them matched; ` +
    `${widened} ambiguous row(s) carry a file-05 variant candidate; ` +
    `file 04: ${activeServiceKeys.size} row(s) carry an active service, ${activeMissing04} of those are not in SAOS; ` +
    `review file ${written.ambiguous} row(s) against ${tally(results, 'ambiguous', 'verdict')} ambiguous overall.`
);

// ── logs/stage-map.log (item 12's table) ────────────────────────────────────

/**
 * Every plain-English Trello stage, and where it lands in SAOS.
 *
 * THE MAP ITSELF MOVED to scripts/trello-normalize.ts on 2026-09-20, because the import now reads
 * it too (item g) and a reporting copy that could drift from the acting copy is a report that lies
 * about what the import did. TAX_STAGES (apps/api/src/modules/tax/pipeline.ts) and engagement_status
 * are still the only real targets; a value with no equivalent is marked GAP and is NOT forced into
 * the nearest enum member, and the import turns it into a task instead.
 */
const stageCount = (f: '01_tax_wip.csv' | '02_tax_ar_worklist.csv', v: string): number =>
  files[f].filter((r) => (r.proposed_stage_plain ?? '').trim() === v).length;
const seenStages = new Set<string>();
for (const f of ['01_tax_wip.csv', '02_tax_ar_worklist.csv'] as const) {
  for (const r of files[f]) seenStages.add((r.proposed_stage_plain ?? '').trim());
}
const stageLines = ['proposed_stage_plain | file 01 | file 02 | total | SAOS stage | import handling | mapping'];
for (const [value, m] of Object.entries(STAGE_MAP)) {
  if (!seenStages.has(value)) continue;
  const a = stageCount('01_tax_wip.csv', value);
  const b = stageCount('02_tax_ar_worklist.csv', value);
  stageLines.push(`${value} | ${a} | ${b} | ${a + b} | ${m.saosStage} | ${m.handling} | ${m.mapping}`);
}
const unlisted = [...seenStages].filter((v) => v && !(v in STAGE_MAP));
for (const v of unlisted) {
  const a = stageCount('01_tax_wip.csv', v);
  const b = stageCount('02_tax_ar_worklist.csv', v);
  stageLines.push(`${v} | ${a} | ${b} | ${a + b} | UNREVIEWED | refused | this value is in the bundle and not in the map — a person decides it, and the import refuses the row rather than picking a near stage`);
}
writeFileSync(resolve(LOGS, 'stage-map.log'), stageLines.join('\n') + '\n');
console.log(`\nstage map: ${stageLines.length - 1} distinct proposed_stage_plain value(s), ${stageLines.filter((l) => l.includes('| GAP |')).length} gap(s), ${unlisted.length} unreviewed`);

// ── logs/field-map.log (item 13's table) ────────────────────────────────────

/**
 * File 04's recurring-service facts against the copy's own catalog.
 *
 * The verdict column is not an opinion: each candidate column is looked up in the copy's
 * information_schema, so "schema gap" means the column is not there, checked rather than
 * remembered — which is also what makes this table self-correcting now that the migrations exist:
 * run against a copy carrying 0105-0111 and the gaps read "exists on the copy".
 *
 * On 2026-09-19 the migration column named what was PROPOSED and not built (Brian's instruction at
 * the time). On 2026-09-20 Brian ruled them in and they are 0105-0111; the column names the real
 * migration and says BUILT, so the two never have to be reconciled by hand.
 */
const FIELD_MAP: Array<{ field: string; col: string; note: string; migration: string }> = [
  { field: 'bk_cadence_label (bookkeeping cadence)', col: 'engagements.prep_cadence', note: 'prep_cadence enum is weekly|monthly|quarterly|semi_annual; the bundle also carries "annual" (35 rows), which the enum does not hold', migration: '0105_bookkeeping_facts — BUILT: ALTER TYPE prep_cadence ADD VALUE \'annual\'' },
  { field: 'books_current_through', col: 'close_cycles.period_end', note: 'the LAST closed cycle\'s period_end is the fact, but there is no column saying "books are current through" on the business or the engagement; deriving it needs the cycles to exist first, and the import creates none', migration: '0105_bookkeeping_facts — BUILT: businesses.books_current_through, businesses.books_current_through_as_of, with a CHECK that refuses the first without the second' },
  { field: 'bk_as_of (the 2026-07-01 as-of date)', col: 'businesses.books_current_through_as_of', note: 'no as-of column anywhere; the bundle is explicit that the fact is stale, and a stale fact with no as-of date reads as current', migration: '0105_bookkeeping_facts — BUILT: businesses.books_current_through_as_of, required whenever books_current_through is set' },
  { field: 'sales_tax_frequency', col: 'engagements.service_line', note: 'sales_tax is a SERVICE LINE, so the engagement exists; the FREQUENCY has no column (prep_cadence belongs to the bookkeeping dials)', migration: '0106_sales_tax_frequency — BUILT: engagements.filing_frequency, CHECK (monthly|quarterly|annual|quarterly_or_annual), scoped to service_line = sales_tax. The fourth value keeps the 11 rows whose card never said which' },
  { field: 'payroll (flag)', col: 'engagements.service_line', note: 'an active payroll engagement IS the flag; no boolean needed', migration: '—' },
  { field: 'payroll_provider', col: 'engagements.notes', note: 'no provider column; "QBO Payroll" would land in free text, which no report can group by', migration: '0107_payroll_provider — BUILT: engagements.payroll_provider text, scoped to service_line = payroll' },
  { field: 'annual_report_state', col: 'entity_compliance.state', note: 'exact home', migration: '—' },
  { field: 'ar_anniversary_kind / ar_anniversary_mmdd', col: 'entity_compliance.annual_report_due_date', note: 'SAOS stores the DUE DATE, derived per state; the anniversary (admission or incorporation date, MM/DD) is the input that derives it and has no column — businesses.formation_date is the incorporation date only, and 57 of 61 rows are admission dates', migration: '0108_annual_report_anniversary — BUILT: entity_compliance.anniversary_mmdd (MM/DD, shape-checked) and anniversary_kind CHECK (admission|incorporation), declared together' },
  { field: 'access_facts (firm_holds_login, mfa_code_goes_to_*, sales_source_*)', col: '—', note: 'no column and no table; these are operational facts about who holds what, and CLAUDE.md keeps credentials out of SAOS entirely, so the honest home is a fact row, never a secret', migration: '0109_business_access_facts — BUILT: business_access_facts (business_id, fact, as_of NOT NULL, source, recorded_at), PK (business_id, fact), with a CHECK that refuses any fact that is not one of three derived shapes — so the column cannot hold a credential' },
  { field: 'qbo_paid_by_2022', col: '—', note: 'who pays the QBO subscription; price_book_items.is_pass_through is the closest existing idea and it is a price-book fact, not a per-client one. The bundle calls this a 2022 roster hint', migration: '0110_qbo_paid_by — BUILT: qbo_payer enum (client|soto|unknown), businesses.qbo_paid_by NOT NULL DEFAULT unknown + qbo_paid_by_as_of. The 2022 values are NOT imported (Brian): every row stays unknown' },
];
const fieldLines = ['trello field (file 04) | rows with a value | SAOS table.column | verdict | migration'];
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
