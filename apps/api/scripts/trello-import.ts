/*
 * TRELLO IMPORT — THE PHASE 2 REHEARSAL (Brian, 2026-09-20, ruling R16). COPY ONLY.
 *
 * ── WHAT CHANGED ON 2026-09-20, AND WHY THIS FILE WAS REWRITTEN ─────────────
 *
 * The 2026-09-19 version answered one question: does importing an already-accepted return enqueue a
 * message to that client? It answered it by STAMPING the compliance gates — an engagement letter, a
 * locked estimate, a signed-8879 document, a PTIN holder — so the walk could reach 'filed' and the
 * outbox could be counted there. Every one of those stamps was labelled "a fact Phase 2 must NOT
 * invent", and Brian then ruled on both halves of the problem:
 *
 *   R16  "import honesty: no fabricated letter, estimate, 8879 or PTIN stamp on real records; a card
 *        past a gate imports at its stage with one audited attestation."
 *        → the real import no longer walks the pipeline at all. It creates the return and calls
 *          setImportedStage (modules/tax/import.ts), which moves the POSITION and writes no
 *          EVIDENCE. Gates from that stage forward still hold, and this script proves it.
 *
 *   R16  every client-facing effect is refused under an import context, and audited.
 *        → the whole import runs inside runInImportContext(). The measurement is no longer "did a
 *          send happen" but "was every send REFUSED, and counted" — and the counter-test, with the
 *          mode off, is what makes the zero mean something.
 *
 * ── THE FOUR THINGS THIS SCRIPT DOES, IN ORDER ──────────────────────────────
 *
 *   A  THE IMPORT-MODE SABOTAGE. Two probe returns, each carrying a fee read from the price book,
 *      each walked to 'filed' through the real transitionStage — one under the import context, one
 *      with it off (--unsafe-no-import-mode, refused outside a _copy database). 'filed' runs
 *      invoiceForFiledEngagement, which enqueues 'invoice.send'. Under the mode: zero outbox rows.
 *      With it off: more than zero. Both counts go in the report.
 *
 *      THE PROBES ARE SYNTHETIC AND SAY SO. They are the one place in this script where the gates
 *      are stamped, and they are stamped on a contact this script created, flagged is_test, with a
 *      test_note naming the rehearsal — never on a matched client. That is the difference R16 turns
 *      on: "no fabricated ... stamp on REAL records". A probe fixture on a database about to be
 *      dropped is not a real record; a matched client's return is.
 *
 *   B  THE REAL IMPORT, inside runInImportContext. Files 01, 02 and 04, matched rows through the
 *      real doors and missing rows created as unverified imports. No gate is stamped anywhere in it.
 *
 *   C  THE RERUN. B again, unchanged. Every delta must be zero — proven by the database's own unique
 *      partial indexes on (source, trello_card_id) from migration 0111, not by the script
 *      remembering what it did.
 *
 *   D  THE 8879 PROOF. One imported return sitting at ready_to_file is asked to file. It is refused.
 *
 * ── THE DOORS IT USES, AND IT USES NO OTHERS ────────────────────────────────
 *   createEngagement    (modules/engagements/service.ts)  the parent engagement
 *   setImportedStage    (modules/tax/import.ts)           the stage, by attestation
 *   transitionStage     (modules/tax/pipeline.ts)         the probes only, gates and all
 *   recordSigned8879    (modules/tax/signed-8879.ts)      the probes only
 *   createTask          (modules/tasks/service.ts)        every task, never a raw INSERT
 *   runInImportContext  (src/outbox.ts)                   the refusal
 *
 * Contacts and businesses have no service door — the app creates them inside its route handlers —
 * so those two are INSERTs here, carrying source = 'trello' and the unverified-import tag that
 * migration 0103 gave businesses and 0111 gave contacts.
 *
 * ── WHERE IT RUNS AND WHAT IT REFUSES ───────────────────────────────────────
 *
 * `saos_trello_copy`, a pg_dump copy of production in the same Postgres container, DROPPED at the
 * end of the exercise. assertCopyDatabase() refuses any database whose name does not end in `_copy`.
 * Nothing drains the outbox: buildServer does not start the scheduler (that is index.ts), so a row
 * that is enqueued stays enqueued and is counted, and the copy is discarded rather than flushed.
 *
 *   TRELLO_IMPORT_DIR=/opt/saos/imports/trello_import \
 *   DATABASE_URL=postgresql://…/saos_trello_copy \
 *     node --experimental-strip-types scripts/trello-import.ts [--limit 25]
 *   … --unsafe-no-import-mode   ALSO run the second probe, with the context off, for the
 *                               counter-measurement. Refused outside a _copy database. The real
 *                               import (B) is inside the context either way — the flag buys one
 *                               extra synthetic probe, never an unprotected import.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { parseCsvObjects } from '../src/migration/csv.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { applyNewReturnDefaults, transitionStage, type TaxStage } from '../src/modules/tax/pipeline.ts';
import { isOneActivePerPeriodViolation } from '../src/modules/engagements/period.ts';
import { assertImportPreconditions, declareImportedJurisdictions, setImportedStage } from '../src/modules/tax/import.ts';
import { applyRecurringServiceFact, isLiveServiceFact, type RecurringFactType } from '../src/modules/engagements/import-facts.ts';
import { recordSigned8879 } from '../src/modules/tax/signed-8879.ts';
import { createTask } from '../src/modules/tasks/service.ts';
import { createSession } from '../src/modules/auth/service.ts';
import { runInImportContext } from '../src/outbox.ts';
import { alertRecipientForRole } from '../src/staffing.ts';
import { assertCopyDatabase, splitHousehold, stageFor } from './trello-normalize.ts';

// ── the run ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
const DEFAULT_DIR = 'C:/Users/brian/saos-imports/trello_import_v2/trello_import';
const DIR = resolve(arg('dir', process.env.TRELLO_IMPORT_DIR ?? DEFAULT_DIR));
const OUT = resolve(DIR, 'out');
const LOGS = resolve(DIR, 'logs');
const LIMIT = Number(arg('limit', '1000'));
const UNSAFE = argv.includes('--unsafe-no-import-mode');
/**
 * R22's PRECONDITION IS REAL, SO THE REHEARSAL HAS TO SATISFY IT RATHER THAN SKIP IT.
 *
 * Production holds one staff account today and `tax_preparer` is unfilled, so the refusal fires on
 * any copy of production — which is the precondition working, and is proven by running without this
 * flag. But a rehearsal that stops there produces no counts, so this creates the account the cutover
 * will create, on the COPY, with a name that says what it is.
 *
 * IT IS A FLAG AND NOT AUTOMATIC on purpose: the refusal must be the default behaviour, or the
 * precondition becomes something the import quietly works around.
 */
const MAKE_PREPARER = argv.includes('--rehearsal-preparer');

/** The bundle's own as-of date: what the attestation cites, never today. */
const BUNDLE_DATE = '2026-09-19';
const DATE = '2026-09-20';
const IMPORT_LABEL = `trello import rehearsal ${DATE} (bundle ${BUNDLE_DATE})`;
const SOURCE_TAG = `trello_${BUNDLE_DATE}`;

const config = loadConfig();
const dbName = assertCopyDatabase(config.DATABASE_URL);
/**
 * The flag gets its own refusal, naming itself. assertCopyDatabase above already stops production,
 * so this is belt and braces — but the message a person reads when they get this wrong should name
 * the flag they typed, not the database they forgot about.
 */
if (UNSAFE && !dbName.endsWith('_copy')) {
  throw new Error(
    `refusing --unsafe-no-import-mode against '${dbName}'. That flag exists to measure what the ` +
      `import mode prevents, by letting a client-facing effect be enqueued for real. It runs on a ` +
      `copy that is about to be dropped and nowhere else.`
  );
}
mkdirSync(LOGS, { recursive: true });

const app = buildServer(config, {});
await app.ready();

interface Snapshot {
  outbox: number; pending: number; audit: number; tasks: number;
  contacts: number; businesses: number; engagements: number; returns: number;
  refusals: number; attestations: number; byEffect: string;
}
async function snapshot(): Promise<Snapshot> {
  const one = async (sql: string): Promise<number> =>
    Number((await app.db.query<{ n: string }>(sql)).rows[0]!.n);
  const e = await app.db.query<{ effect: string; n: string }>(
    `SELECT effect, count(*)::text AS n FROM outbox GROUP BY effect ORDER BY effect`
  );
  return {
    outbox: await one(`SELECT count(*) AS n FROM outbox`),
    pending: await one(`SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'failed')`),
    audit: await one(`SELECT count(*) AS n FROM audit_log`),
    tasks: await one(`SELECT count(*) AS n FROM tasks`),
    contacts: await one(`SELECT count(*) AS n FROM contacts WHERE source = 'trello'`),
    businesses: await one(`SELECT count(*) AS n FROM businesses WHERE source = 'trello'`),
    engagements: await one(`SELECT count(*) AS n FROM engagements WHERE source = 'trello'`),
    returns: await one(`SELECT count(*) AS n FROM tax_engagements WHERE source = 'trello'`),
    refusals: await one(`SELECT count(*) AS n FROM audit_log WHERE action = 'outbox.refused_in_import'`),
    attestations: await one(`SELECT count(*) AS n FROM audit_log WHERE action = 'tax_engagement.imported_at_stage'`),
    byEffect: e.rows.map((r) => `${r.effect}=${r.n}`).join(' ') || '(none)',
  };
}

// ── the labelled session: every audit row names the script ──────────────────

const ceoRow = await app.db.query<{ id: string; email: string; display_name: string; role_key: string }>(
  `SELECT st.id, st.email, st.display_name, r.key AS role_key
     FROM staff st JOIN roles r ON r.id = st.role_id
    WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1`
);
if (!ceoRow.rows[0]) throw new Error('refusing: no active CEO on the copy');
const ceo = ceoRow.rows[0];
const APPLIED_BY = `${IMPORT_LABEL}, applied by script`;
await createSession(app.db, config, ceo.id, { appliedBy: APPLIED_BY });
const sessionId = (
  await app.db.query<{ id: string }>(
    `SELECT id FROM staff_sessions WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 1`, [ceo.id]
  )
).rows[0]!.id;
const perms = await app.db.query<{ permission: string }>(
  `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN staff st ON st.role_id = r.id WHERE st.id = $1`,
  [ceo.id]
);
const actorStaff = {
  id: ceo.id, email: ceo.email, fullName: `${ceo.display_name} (${APPLIED_BY})`,
  roleKey: ceo.role_key, permissions: perms.rows.map((r) => r.permission), sessionId,
};
/** The shape transitionStage, setImportedStage and recordSigned8879 want. Same label, same audit trail. */
const actorLabel = { staffId: ceo.id, label: actorStaff.fullName };

console.log(`trello-import: database '${dbName}', bundle ${DIR}, limit ${LIMIT}`);
console.log(`  labelled session ${sessionId.slice(0, 8)} — every audit row reads "${APPLIED_BY}"`);
console.log(`  import mode: ${UNSAFE ? 'OFF (--unsafe-no-import-mode)' : 'ON'}`);

// ── the bundle, and the matching this import obeys ──────────────────────────

const load = (f: string): Array<Record<string, string>> => parseCsvObjects(readFileSync(resolve(DIR, f), 'utf8'));
const f01 = load('01_tax_wip.csv');
const f02 = load('02_tax_ar_worklist.csv');
const f04 = load('04_business_services.csv');
/*
 * R21: 04b IS THE IMPORT SOURCE FOR SERVICE FACTS, and file 04 is matching only.
 *
 * The difference is the KEY. File 04 is one row per business NAME — a summary the extract built by
 * collapsing cards together — so its only identity is `match_key`, a hand-typed name, and 355 of its
 * 464 rows carried no card id at all: last night's rehearsal had to refuse 50 rows with a live
 * service because there was nothing to key a rerun on. 04b is one row per FACT, each carrying the
 * Trello id it came from, so every fact has a stable identity across bundles and the name is demoted
 * to what it always was: a way to find the business, never a way to identify the fact.
 */
const f04b = load('04b_service_facts.csv');

/*
 * THE IMPORT DOES NOT RE-DECIDE THE MATCHING. It reads trello-match.ts's own output files, so the
 * counts report and the import cannot disagree about which card is which client — the 2026-09-19
 * version resolved names again inside itself, with tier 1 only, and would now silently import a
 * different set from the one the report describes.
 */
for (const f of ['trello_match_matched.csv', 'trello_match_not_in_saos.csv']) {
  if (!existsSync(resolve(OUT, f))) {
    throw new Error(`refusing: ${f} is not in ${OUT}. Run scripts/trello-match.ts first — the import obeys its verdicts, it does not re-derive them.`);
  }
}
interface MatchRow { source_file: string; trello_card_id: string; trello_key: string; saos_type: string; saos_id: string; tier: string }
const matchedRows = parseCsvObjects(readFileSync(resolve(OUT, 'trello_match_matched.csv'), 'utf8')) as unknown as MatchRow[];
const missingRows = parseCsvObjects(readFileSync(resolve(OUT, 'trello_match_not_in_saos.csv'), 'utf8')) as unknown as MatchRow[];
const matchedByCard = new Map(matchedRows.filter((r) => r.trello_card_id).map((r) => [r.trello_card_id, r]));
const missingByCard = new Map(missingRows.filter((r) => r.trello_card_id).map((r) => [r.trello_card_id, r]));
/*
 * R21: THE BUSINESS FOR A NAME KEY. A key that matched a SAOS business anywhere — file 04's own rows
 * or an entity return on files 01-03 — is that business. Built from the match output rather than
 * re-derived, so the import and the counts report cannot disagree about who a name is.
 *
 * R24: `skip` is a DECISION, and it is in the matched file with no id: Brian said this Trello name is
 * not a client of ours, so nothing is created for it. Different from not-in-SAOS, where the import
 * creates — which is why the pick has three answers and not two.
 */
const matchedBizByKey = new Map<string, string>();
/**
 * R33: a name key that matched a CONTACT and no business (a sole proprietor whose sales tax or
 * payroll card carries their own name). A recurring engagement needs a contact to bill, and for
 * these the contact is the match itself, with no entity beside it.
 */
const matchedContactByKey = new Map<string, string>();
const skipKeys = new Set<string>();
for (const r of matchedRows) {
  if (r.saos_type === 'skip') { skipKeys.add(r.trello_key); continue; }
  if (r.saos_type === 'business' && r.saos_id && !matchedBizByKey.has(r.trello_key)) {
    matchedBizByKey.set(r.trello_key, r.saos_id);
  }
  if (r.saos_type === 'contact' && r.saos_id && !matchedContactByKey.has(r.trello_key)) {
    matchedContactByKey.set(r.trello_key, r.saos_id);
  }
}
const createKeys = new Set(missingRows.filter((r) => r.saos_type === 'create').map((r) => r.trello_key));

const enrichmentCount = existsSync(resolve(OUT, 'enrichment_file03.csv'))
  ? parseCsvObjects(readFileSync(resolve(OUT, 'enrichment_file03.csv'), 'utf8')).length
  : 0;
console.log(`  match verdicts read: ${matchedByCard.size} matched card(s), ${missingByCard.size} not in SAOS, ${enrichmentCount} on the file-03 enrichment list`);
console.log(`  R24 picks in the match output: ${skipKeys.size} SKIP, ${createKeys.size} CREATE; ${matchedBizByKey.size} name key(s) resolve to a SAOS business`);

/*
 * -- R21's THREE SMALL TABLES ------------------------------------------------
 *
 * HAS_A_HOME: the fact types SAOS can store today. Everything else is DEFERRED rather than dropped,
 * and the report names the counts, so "no column for this yet" is a visible number and not a silence.
 *
 * R33 ADDED sales_tax AND payroll TO IT, and the reason they were missing is worth keeping in view.
 * Migrations 0106 and 0107 put filing_frequency and payroll_provider on ENGAGEMENTS, scoped by a
 * CHECK to the sales_tax and payroll lines — but this set listed only the types whose home is a
 * table the import already wrote to, and no sales-tax or payroll engagement existed for the column
 * to sit on. The shelf was built; the box was not. modules/engagements/import-facts.ts now finds or
 * creates the engagement through the ordinary door and writes the column, keyed on the same ledger.
 *
 * ACTIVE_FACT: the fact types that justify CREATING a business that is not in SAOS. An anniversary
 * or an access note is a fact ABOUT a business we do not have; a live bookkeeping, sales-tax or
 * payroll service is a reason to have it — and for sales_tax and payroll "live" is read off the row
 * (isLiveServiceFact): a closed service is not a reason to create anything.
 */
const HAS_A_HOME = new Set(['bookkeeping', 'access', 'annual_report_entity', 'annual_report_anniversary', 'sales_tax', 'payroll']);
const ACTIVE_FACT = new Set(['bookkeeping', 'sales_tax', 'payroll']);
const RECURRING_FACT = new Set<string>(['sales_tax', 'payroll']);
const ANNIVERSARY_KIND_IN_04B: Record<string, string> = { 'admission date': 'admission', 'incorporation date': 'incorporation' };

/** How many 04b source rows the ledger says have been applied. The rerun proof reads this. */
async function ledgerCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM service_fact_imports`);
  return Number(rows[0]!.n);
}

/** Has this 04b row already been applied? The ledger answers; nothing re-derives it. */
async function factApplied(sourceId: string, factType: string): Promise<boolean> {
  const { rows } = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM service_fact_imports
      WHERE source = 'trello' AND trello_source_id = $1 AND fact_type = $2`,
    [sourceId, factType]
  );
  return Number(rows[0]!.n) > 0;
}

/** One access fact. The CHECK in 0109 refuses anything that is not a derived category. */
async function writeAccessFact(businessId: string, fact: string, asOf: string): Promise<number> {
  const r = await app.db.query(
    `INSERT INTO business_access_facts (business_id, fact, as_of, source)
     VALUES ($1, $2, $3, 'trello') ON CONFLICT DO NOTHING`,
    [businessId, fact, asOf]
  );
  return r.rowCount ?? 0;
}

/** File 04's live-service test, the same one the review file uses (item e). */
const DEAD_SERVICE = ['closed', 'not_client', 'lost', 'inactive', 'dissolved'];
function activeService(row: Record<string, string>): boolean {
  const cadence = (row.bk_cadence_label ?? '').trim();
  const bkStatus = (row.bk_status ?? '').toLowerCase();
  if (cadence && !DEAD_SERVICE.some((d) => bkStatus.includes(d))) return true;
  const stFreq = (row.sales_tax_frequency ?? '').trim();
  const stStatus = (row.sales_tax_status ?? '').toLowerCase();
  if (stFreq && !DEAD_SERVICE.some((d) => stStatus.includes(d))) return true;
  return (row.payroll ?? '').trim().toLowerCase() === 'yes';
}

/*
 * WHAT R21 FIXED, IN ONE NUMBER. Last night's rehearsal had to refuse 50 file-04 rows that carried a
 * live service, because 355 of 464 rows had no bk_card_id and (source, trello_card_id) is the rerun
 * guard: no key, no way to tell a second run from the first. 04b keys every fact on its own Trello
 * id, so the refusal is gone — the count below is what it used to be and what it is now.
 */
const f04NoCard = f04.filter((r) => !(r.bk_card_id ?? '').trim()).length;
const f04NoCardWithService = f04.filter((r) => !(r.bk_card_id ?? '').trim() && activeService(r)).length;
console.log(
  `  file 04 (matching only now): ${f04NoCard} of ${f04.length} row(s) carry no card id, ` +
    `${f04NoCardWithService} of those carry a live service — all ${f04NoCardWithService} were refused on 2026-09-19 and none are now: ` +
    `04b gives every one of its ${f04b.length} fact rows its own trello_source_id`
);

const RETURN_TYPES: Record<string, string> = {
  '1040': '1040', '1120-S': '1120s', '1120-C': '1120c', '1120': '1120', '1065': '1065',
  '990': '990', '990-N': '990ez', 'Schedule C': '1040',
};

/** A business return hangs off its primary member: an engagement needs a contact to bill and write to. */
const primaryMember = new Map<string, string>();
{
  const { rows } = await app.db.query<{ business_id: string; contact_id: string }>(
    `SELECT DISTINCT ON (business_id) business_id, contact_id FROM business_members ORDER BY business_id, is_primary DESC`
  );
  for (const r of rows) primaryMember.set(r.business_id, r.contact_id);
}

/** Where a matched card's return hangs. null when the match is a business with no member to bill. */
function targetOf(cardId: string): { contactId: string; businessId?: string } | null {
  const m = matchedByCard.get(cardId);
  if (!m || !m.saos_id) return null;
  if (m.saos_type === 'business') {
    const primary = primaryMember.get(m.saos_id);
    return primary ? { contactId: primary, businessId: m.saos_id } : null;
  }
  return { contactId: m.saos_id };
}

// ── the counts, before anything ─────────────────────────────────────────────

/*
 * R22: THE CUTOVER PRECONDITION, CHECKED BEFORE ANYTHING IS WRITTEN. The refusal is printed rather
 * than swallowed: an import that lands 44 returns in nobody's queue is silent, and the point of a
 * precondition is that it is loud at the start instead.
 */
if (MAKE_PREPARER) {
  const have = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.is_active AND r.key = 'tax_preparer'`
  );
  if (Number(have.rows[0]!.n) === 0) {
    const made = await app.db.query<{ id: string }>(
      `INSERT INTO staff (legal_name, display_name, email, role_id, is_active)
       SELECT $1, $2, $3, r.id, true FROM roles r WHERE r.key = 'tax_preparer' RETURNING id`,
      [
        `Rehearsal Preparer (${IMPORT_LABEL})`,
        'Rehearsal Preparer',
        `rehearsal.preparer.${DATE}@example.invalid`,
      ]
    );
    console.log(
      `  --rehearsal-preparer: created a synthetic ACTIVE tax_preparer ${made.rows[0]!.id.slice(0, 8)} on the copy, ` +
        `because R22 refuses the import without one. The refusal itself is proven by running without this flag.`
    );
  }
}
const pre = await assertImportPreconditions(app);
console.log(
  `  R22 precondition: ${pre.activePreparers} active tax_preparer(s)` +
    (pre.defaultPreparerId
      ? ` — imported returns take ${pre.defaultPreparerId.slice(0, 8)} as their default preparer (R11)`
      : ` — SEVERAL are active, so no default applies and imported returns land unassigned. Not a refusal: the firm chooses, not the import.`)
);

const before = await snapshot();
const armed = await app.db.query<{ key: string }>(`SELECT key FROM automations WHERE enabled ORDER BY key`);
console.log(`  BEFORE  outbox=${before.outbox} (pending ${before.pending}) audit=${before.audit} tasks=${before.tasks}  effects: ${before.byEffect}`);
console.log(`  armed automations on the copy (${armed.rows.length}): ${armed.rows.map((r) => r.key).join(', ')}`);

// ── A: THE IMPORT-MODE SABOTAGE PROBE ──────────────────────────────────────

/**
 * The fee the probe carries, READ FROM THE PRICE BOOK.
 *
 * CLAUDE.md: "A price appearing as a literal in application code is a build failure." A rehearsal
 * script is application code. The probe needs a fee because invoiceForFiledEngagement only enqueues
 * 'invoice.send' when final_fee_cents is set — a return with no fee raises a task for the preparer
 * instead, which is an internal effect and would measure nothing.
 */
async function probeFeeCents(): Promise<{ cents: number; itemCode: string }> {
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT pbi.item_code, pbi.amount_cents
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
        AND pbi.item_code = 'IND_BASE_SINGLE'
      LIMIT 1`
  );
  if (!rows[0]) throw new Error('refusing: no IND_BASE_SINGLE in the book in force — the probe fee has to come from the price book, never from a literal here.');
  return { cents: rows[0].amount_cents, itemCode: rows[0].item_code };
}

/**
 * One probe: a synthetic client, a return carrying a fee, walked to 'filed' through the real
 * pipeline with the real gates satisfied. Returns the outbox delta.
 *
 * EVERY STAMP IN HERE IS ON A RECORD THIS FUNCTION CREATED, flagged is_test with a test_note. That
 * is what makes it legitimate under R16 and it is the only place in this script that stamps anything.
 */
async function probe(tag: string): Promise<{ delta: number; refusalDelta: number; reached: string }> {
  const fee = await probeFeeCents();
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, is_test, test_note, source)
     VALUES ($1, $2, $3, 'en', true, $4, 'trello') RETURNING id`,
    [
      'Rehearsal', `Probe ${tag}`, `rehearsal.probe.${tag}@example.invalid`,
      `Import-mode probe, ${IMPORT_LABEL}. Synthetic: the gates below are stamped on THIS record and never on a matched client (R16). The copy is dropped at the end.`,
    ]
  );
  const contactId = contact.rows[0]!.id;
  const parent = await createEngagement(app, actorStaff, {
    contactId, serviceLine: 'tax', title: `2025 1040 (import-mode probe ${tag})`, status: 'active',
    periodKey: '2025',
    origin: { via: 'staff', reason: `import-mode probe ${tag} (${SOURCE_TAG})` },
  }, { ip: null, userAgent: `script: ${APPLIED_BY}` });
  const te = await app.db.query<{ id: string }>(
    /*
     * preparer_id IS SET HERE and nowhere else in this script. The pipeline gained a fourth gate
     * (no return enters in_preparation unassigned), and the probe has to pass it to reach 'filed'
     * where the enqueue lives. An imported return does NOT get one: who prepared a Trello return is
     * not a thing the bundle knows, and naming the CEO would be the same fabrication as a signature.
     * See the report — imported returns at in_preparation or later sit in nobody's queue, which is a
     * finding for Brian, not something this script decides.
     */
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, final_fee_cents,
                                  preparer_id, engagement_letter_signed_at, estimate_locked_at,
                                  estimated_fee_min_cents, estimated_fee_max_cents)
     VALUES ($1, 2025, '1040', 'individual', $2, $3, now(), now(), $2, $2) RETURNING id`,
    [parent.id, fee.cents, ceo.id]
  );
  const teId = te.rows[0]!.id;
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, tax_year, category, filename, minio_bucket, minio_key, uploaded_by_type, uploaded_by_id, scan_status)
     VALUES ($1, $2, 2025, 'signed_authorizations', $3, 'rehearsal', $4, 'staff', $5, 'clean') RETURNING id`,
    [contactId, teId, `8879-probe-${tag}.pdf`, `rehearsal/probe-${tag}`, ceo.id]
  );
  await recordSigned8879(app, actorLabel, {
    taxEngagementId: teId, documentId: doc.rows[0]!.id, signedOn: '2026-04-01', preparerPtinHolderId: ceo.id,
  });

  const walk: TaxStage[] = ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'filed'];
  const s0 = await snapshot();
  let reached = 'intake_started';
  for (const to of walk) {
    try {
      await transitionStage(app, actorLabel, teId, to, { note: `import-mode probe ${tag} (${SOURCE_TAG})`, preparerPtinHolderId: ceo.id });
      reached = to;
    } catch (err) {
      console.log(`  probe ${tag} blocked entering ${to}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      break;
    }
  }
  const s1 = await snapshot();
  console.log(`  probe ${tag}: fee ${fee.itemCode} (${fee.cents} cents from the book), reached ${reached}, outbox ${s0.outbox} -> ${s1.outbox}, refusals ${s0.refusals} -> ${s1.refusals}`);
  return { delta: s1.outbox - s0.outbox, refusalDelta: s1.refusals - s0.refusals, reached };
}

console.log(`\nA — THE IMPORT-MODE SABOTAGE. One probe under the mode, one with it off.`);
const probeOn = await runInImportContext(IMPORT_LABEL, () => probe('mode-on'));
const probeOff = UNSAFE ? await probe('mode-off') : null;
if (!UNSAFE) {
  console.log(`  probe mode-off SKIPPED: rerun with --unsafe-no-import-mode to take the counter-measurement.`);
}

// ── B: THE REAL IMPORT ─────────────────────────────────────────────────────

/**
 * A PASS'S OWN COUNTS, NOT A RUNNING TOTAL.
 *
 * The first version of this accumulated across both passes, which made the rerun add its zeros to
 * numbers that were already reported — and a table whose "created" column is first-pass-plus-rerun
 * cannot show that the rerun created nothing. Each pass gets a fresh tally; the rerun's tally being
 * all zeros is itself the proof, alongside the snapshot deltas.
 */
interface FileTally { recordsCreated: number; returnsCreated: number; attested: number; tasks: number; skipped: number; refused: number; facts: number;
  /** R22: returns that took the sole active tax preparer, and letters inherited from the contact. */
  preparerDefaulted: number; letterInherited: number;
  /** R23, by shape. */
  declaredByDefault: number; notifyTasks: number; completedSilently: number;
  /** R31: of the filed-awaiting-ack cards, those whose year put the declaration in the paper lane. */
  declaredPaper: number;
  /** R21: 04b rows read but not applied because SAOS has nowhere to put them yet. */
  deferred: number;
  /** R33: sales-tax and payroll engagements this pass created, rows that named a closed service, and live rows deferred for want of a contact to bill. */
  serviceEngagements: number; closedServices: number; noContact: number }
const emptyTally = (): FileTally => ({ recordsCreated: 0, returnsCreated: 0, attested: 0, tasks: 0, skipped: 0, refused: 0, facts: 0,
  preparerDefaulted: 0, letterInherited: 0, declaredByDefault: 0, notifyTasks: 0, completedSilently: 0, declaredPaper: 0, deferred: 0,
  serviceEngagements: 0, closedServices: 0, noContact: 0 });
type Tallies = Record<string, FileTally>;
const FILES = ['01_tax_wip.csv', '02_tax_ar_worklist.csv', '03_tax_completed_roster.csv', '04_business_services.csv', '04b_service_facts.csv'] as const;
/** One imported return at ready_to_file, kept for proof D. */
let readyToFileId: string | null = null;

/** Already imported? The database answers, through migration 0111's unique partial index. */
async function alreadyImported(table: 'contacts' | 'businesses' | 'engagements', cardId: string): Promise<boolean> {
  const { rows } = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE source = 'trello' AND trello_card_id = $1`, [cardId]
  );
  return Number(rows[0]!.n) > 0;
}

/**
 * A person's name, split for the contacts table.
 *
 * A HOUSEHOLD BECOMES ONE CONTACT, the first-named person, and the raw string is kept in the note.
 * Creating two contacts from "A & B Lastname" would invent a second person whose existence the card
 * only implies — no email, no date of birth, nothing but a first name — and R16 is precisely about
 * not inventing. The note is how the second name survives for whoever enriches the record.
 */
function splitName(nameClean: string): { first: string; last: string; note: string | null } | null {
  const hh = splitHousehold(nameClean);
  if (hh) {
    return {
      first: hh.firsts[0]!, last: hh.last,
      note: `The Trello card names a household: "${nameClean}". Only the first-named person was created; the second name is here and nowhere else.`,
    };
  }
  const parts = nameClean.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null; // one token is not a first and last name; a person decides it
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]!, note: null };
}

/** 'Dec 2025' -> the last day of December 2025. "Current through December" means through its end. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthEnd(raw: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return null;
  const year = Number(m[2]);
  const last = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
  return `${year}-${String(mi + 1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}


/** The import proper. Called twice — the second time must change nothing. */
async function runImport(pass: 'first' | 'rerun'): Promise<Tallies> {
  const tally: Tallies = Object.fromEntries(FILES.map((f) => [f, emptyTally()]));
  const preparer = await alertRecipientForRole(app.db, 'tax_preparer', 'trello_import_amendment');
  const comms = await alertRecipientForRole(app.db, 'comms_billing', 'trello_ar_worklist');
  const ceoOwner = await alertRecipientForRole(app.db, 'ceo', 'trello_import_books_review');

  // ── file 01: the work in progress ───────────────────────────────────────
  for (const row of f01.slice(0, LIMIT)) {
    const t = tally['01_tax_wip.csv']!;
    const cardId = (row.trello_card_id ?? '').trim();
    const plain = (row.proposed_stage_plain ?? '').trim();
    const mapping = stageFor(plain);
    if (!cardId || !mapping) { t.refused++; continue; }

    /*
     * ITEM g, THE TWO TASK SHAPES. An amendment has no stage and no 1040-X return type; the
     * awaiting-CPA-review card is Brian reviewing the BOOKS, which no return stage describes. Both
     * become tasks rather than returns placed at an approximate stage, because a return typed 1040
     * sitting at in_preparation would assert that the original return is being prepared again.
     */
    if (mapping.handling !== 'stage') {
      const target = targetOf(cardId);
      const common = {
        description:
          `Imported from the Trello tax board (${SOURCE_TAG}). Trello list: ${row.trello_list}.\n` +
          `${mapping.mapping}\n` +
          `No return was created for this card and no stage was set — SAOS has no shape for it yet.`,
        ...(target ? { contactId: target.contactId } : {}),
        priority: 2,
        source: 'import' as const,
        sourceId: cardId,
      };
      /*
       * TWO BRANCHES WITH THE TYPE WRITTEN OUT, not one call with a ternary in `sourceType`.
       * scripts/check-task-sop-hooks.mjs reads `sourceType: '...'` literals, and a ternary there is
       * invisible to it — which is exactly the shape that let eight task types ship with no SOP
       * decision. A guard that cannot see a task type is not guarding it, so the type is a literal
       * even though it costs a duplicated call.
       */
      const made = mapping.handling === 'preparer_task'
        ? await createTask(app, {
            ...common,
            title: `Trello: amendment in progress (card ${cardId})`,
            assignedStaffId: preparer,
            sourceType: 'trello_amendment',
          })
        : await createTask(app, {
            ...common,
            title: `Trello: awaiting CPA review of the books (card ${cardId})`,
            assignedStaffId: ceoOwner,
            sourceType: 'trello_books_review',
          });
      if (made.created) t.tasks++; else t.skipped++;
      await app.db.query(`UPDATE tasks SET trello_card_id = $2 WHERE id = $1 AND trello_card_id IS NULL`, [made.id, cardId]);
      continue;
    }

    const target = targetOf(cardId);
    if (!target) { t.skipped++; continue; }
    if (await alreadyImported('engagements', cardId)) { t.skipped++; continue; }

    const year = 2025;
    const returnType = RETURN_TYPES[(row.form_type ?? '').trim()] ?? (target.businessId ? '1120s' : '1040');
    let parent: { id: string };
    try {
      parent = await createEngagement(app, actorStaff, {
        contactId: target.contactId,
        ...(target.businessId ? { businessId: target.businessId } : {}),
        serviceLine: 'tax',
        title: `${year} ${returnType.toUpperCase()}`,
        status: 'active',
        periodKey: String(year),
        origin: { via: 'staff', reason: `Trello import (${SOURCE_TAG}), card ${cardId}` },
      }, { ip: null, userAgent: `script: ${APPLIED_BY}` });
    } catch (err) {
      /*
       * Migration 0083/0098's one-active-per-line-period-and-entity index: this client already has a
       * 2025 tax engagement. A legitimate refusal, and the second rerun guard behind 0111's.
       *
       * TWO SHAPES OF THE SAME REFUSAL, and both are named rather than caught wholesale.
       * createEngagement checks for the existing engagement itself and raises `engagement_exists`
       * (409); the raw unique index raises 23505 when two callers race. A catch-all here would turn
       * any genuine failure into a quiet "skipped" and the rehearsal would report a clean run over a
       * broken one, so anything else is rethrown.
       */
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (!isOneActivePerPeriodViolation(err) && code !== 'engagement_exists') throw err;
      t.skipped++;
      continue;
    }
    await app.db.query(`UPDATE engagements SET source = 'trello', trello_card_id = $2 WHERE id = $1`, [parent.id, cardId]);
    const te = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, source, trello_card_id)
       VALUES ($1, $2, $3::return_type, $4::tax_client_type, 'trello', $5) RETURNING id`,
      [parent.id, year, returnType, target.businessId ? 'business' : 'individual', cardId]
    );
    const teId = te.rows[0]!.id;
    t.returnsCreated++;

    /*
     * ITEM c. The stage, by attestation, through the dedicated service — never the gated transition,
     * and with no letter, estimate, 8879 or PTIN stamp anywhere near it.
     */
    const gapNote = mapping.saosStage.includes('+ note') ? `Trello list said: "${plain}". ${mapping.mapping}` : undefined;
    await setImportedStage(app, actorLabel, {
      taxEngagementId: teId,
      stage: mapping.stage as TaxStage,
      trelloCardId: cardId,
      asOf: BUNDLE_DATE,
      ...(gapNote ? { note: gapNote } : {}),
    });
    t.attested++;
    if (mapping.stage === 'ready_to_file' && !readyToFileId) readyToFileId = teId;

    /*
     * R22, AND THE ORDER MATTERS. applyNewReturnDefaults is called AFTER setImportedStage, not
     * before, because setImportedStage refuses a return that already carries a gate fact — and the
     * defaults may stamp one: a contact whose engagement_letter_status is 'signed' has the standing
     * letter inherited onto every return it covers. That inheritance is a REAL fact about the
     * client (they signed), which is why it is allowed at all and why R16 does not touch it; the
     * freshness check exists to stop a FABRICATED one, and running the defaults second keeps both
     * rules intact rather than weakening either.
     */
    const defaults = await applyNewReturnDefaults(app, teId, target.contactId);
    if (defaults.preparerId) t.preparerDefaulted++;
    if (defaults.engagementLetterInherited) t.letterInherited++;

    /*
     * R23: A RETURN AT OR PAST 'filed' MAKES CLAIMS, so each shape carries what replaces the claim
     * the import declined to invent.
     */
    if (mapping.postImport === 'declare_and_confirm') {
      /*
       * R31: the method is the YEAR'S LANE, derived inside declareImportedJurisdictions, and a
       * paper-lane year is declared paper rather than refused. No mailing is written for it — the
       * card said "filed", not when or how — so the confirm task also asks for the mailing record.
       */
      const declared = await declareImportedJurisdictions(app, actorLabel, { taxEngagementId: teId, trelloCardId: cardId, asOf: BUNDLE_DATE });
      const paper = declared.filingMethod === 'paper';
      const made = await createTask(app, {
        title: `Trello: confirm the jurisdictions on an imported return (card ${cardId})`,
        description:
          `Imported as filed and awaiting an acknowledgment (${SOURCE_TAG}). The card did not say where it was filed, ` +
          `so the declared list is the ADDRESS DEFAULT — ${declared.jurisdictions.join(', ')}, method ${paper ? 'paper (the tax year is in the paper lane)' : 'e-file'} — and every ` +
          `row is flagged declared_by_import_default. Confirm against ATX; a state on the list that was never filed ` +
          `will wait for an acknowledgment forever.` +
          (paper
            ? ` No mailing was recorded: the card named no date and no method, so record the mailing on each jurisdiction from the file when you confirm the list.`
            : ''),
        assignedStaffId: preparer,
        contactId: target.contactId,
        priority: 1,
        source: 'import',
        sourceType: 'trello_confirm_jurisdictions',
        sourceId: cardId,
      });
      if (made.created) t.tasks++;
      await app.db.query(`UPDATE tasks SET trello_card_id = $2 WHERE id = $1 AND trello_card_id IS NULL`, [made.id, cardId]);
      t.declaredByDefault++;
      if (paper) t.declaredPaper++;
    }
    if (mapping.postImport === 'notify_client') {
      const made = await createTask(app, {
        title: `Trello: tell the client their return was accepted (card ${cardId})`,
        description:
          `Imported as completed under the attestation (${SOURCE_TAG}). NO acceptance row was written and nothing was ` +
          `sent — the card is a note, not an acknowledgment, and an imported record never triggers a client message. ` +
          `Confirm the acceptance in ATX, then tell the client yourself.`,
        assignedStaffId: comms,
        contactId: target.contactId,
        priority: 2,
        source: 'import',
        sourceType: 'trello_notify_client',
        sourceId: cardId,
      });
      if (made.created) t.tasks++;
      await app.db.query(`UPDATE tasks SET trello_card_id = $2 WHERE id = $1 AND trello_card_id IS NULL`, [made.id, cardId]);
      t.notifyTasks++;
    }
    if (mapping.postImport === 'completed_silently') t.completedSilently++;
  }

  // ── file 02: a worklist, never an invoice ───────────────────────────────
  for (const row of f02.slice(0, LIMIT)) {
    const t = tally['02_tax_ar_worklist.csv']!;
    const cardId = (row.trello_card_id ?? '').trim();
    if (!cardId) { t.refused++; continue; }
    const pendingCeo = (row.invoice_state ?? '').trim() === 'created_pending_ceo_review';
    const target = targetOf(cardId);
    const created = await createTask(app, {
      title: `Trello AR worklist: ${pendingCeo ? 'invoice drafted, waiting on Brian' : 'accepted return with an open balance'} (card ${cardId})`,
      description:
        `Imported from the Trello AR worklist (${SOURCE_TAG}).\n` +
        `Trello list: ${row.trello_list}. Invoice state on the card: ${row.invoice_state}. ` +
        `This is a WORKLIST ITEM, not an invoice — no invoice is created by the import.`,
      assignedStaffId: pendingCeo ? ceoOwner : comms,
      ...(target ? { contactId: target.contactId } : {}),
      priority: 2,
      source: 'import',
      sourceType: 'trello_ar_worklist',
      sourceId: cardId,
    });
    if (created.created) t.tasks++; else t.skipped++;
    await app.db.query(`UPDATE tasks SET trello_card_id = $2 WHERE id = $1 AND trello_card_id IS NULL`, [created.id, cardId]);
  }

  // ── file 03: refused, in code ───────────────────────────────────────────
  tally['03_tax_completed_roster.csv']!.refused = enrichmentCount;

  /*
   * -- R21: 04b IS THE IMPORT SOURCE FOR SERVICE FACTS ---------------------
   *
   * ONE 04b ROW AT A TIME, keyed (source, trello_source_id, fact_type) against the ledger
   * `service_fact_imports` (migration 0114). The ledger is consulted FIRST, so a rerun does no work
   * rather than re-deriving whether the work is needed — which is the difference between idempotent
   * and accidentally-harmless.
   *
   * WHY THE LEDGER AND NOT "IS THE VALUE ALREADY THERE". Equal values do not mean already-applied: a
   * business whose books really are current through December would look applied before anything ran.
   * The question idempotency asks is "have we already done what this row says", and only a record of
   * having done it answers that.
   *
   * WHAT A DEFERRED ROW IS, and why it gets NO ledger row. Three fact types have nowhere to land:
   * svc_1099_ty2025, svc_2553 and bookkeeping_status_only have no column at all. Writing a ledger
   * row for those would mark them applied forever, so the day a status column arrives they would be
   * skipped in silence. They are counted as DEFERRED and left unapplied, which is the only version
   * of this that a later run can fix.
   *
   * sales_tax AND payroll USED TO BE ON THAT LIST, and R33 asked why, given that 0106 and 0107 hold
   * exactly those facts. The answer: their home is a column on a sales_tax or payroll ENGAGEMENT,
   * and this import created none, so the column existed and the row it belongs on did not. They now
   * go through modules/engagements/import-facts.ts, which finds or creates the engagement through
   * createEngagement and writes the column, on the same ledger key. One deferral remains for them
   * and is counted apart: a live service on a business with NO MEMBER has no contact to bill, and
   * engagements.contact_id is NOT NULL — that row waits, with no ledger row, until a person adds one.
   *
   * qbo_paid_by_2022_DO_NOT_IMPORT is different again: not deferred, REFUSED. Brian ruled the 2022
   * values out, so they are never applied and never will be, and the type name says so.
   */
  for (const row of f04b.slice(0, LIMIT)) {
    const t = tally['04b_service_facts.csv']!;
    const factType = (row.fact_type ?? '').trim();
    const sourceId = (row.trello_source_id ?? '').trim();
    const key = (row.match_key ?? '').trim();
    const asOf = (row.as_of ?? '').trim() || BUNDLE_DATE;
    if (!factType || !sourceId) { t.refused++; continue; }
    if (factType === 'qbo_paid_by_2022_DO_NOT_IMPORT') { t.refused++; continue; }
    if (!HAS_A_HOME.has(factType)) { t.deferred++; continue; }
    if (await factApplied(sourceId, factType)) { t.skipped++; continue; }

    let values: Record<string, unknown>;
    try {
      values = JSON.parse(row.values_json ?? '{}') as Record<string, unknown>;
    } catch { t.refused++; continue; }

    /*
     * WHICH BUSINESS. Through the MATCH output, by name key — file 04's job is now matching only, and
     * a name key that matched a SAOS business anywhere (file 04's own rows or an entity return on
     * files 01-03) is that business. The name is how the business is FOUND; the ledger key is how the
     * fact is IDENTIFIED, and R21 is the rule that those are not the same thing.
     */
    let businessId: string | null = matchedBizByKey.get(key) ?? null;
    const recurring = RECURRING_FACT.has(factType);
    /** R33: a sole proprietor's card matched a contact and no business; a RECURRING fact's engagement hangs on them. */
    const matchedContact = recurring && !businessId ? (matchedContactByKey.get(key) ?? null) : null;
    const live = !recurring || isLiveServiceFact(factType as RecurringFactType, values);
    if (!businessId && !matchedContact) {
      if (skipKeys.has(key)) { t.skipped++; continue; }         // R24: Brian said skip
      if (!ACTIVE_FACT.has(factType) || !live) { t.skipped++; continue; } // nothing live to attach
      /*
       * A business this import made on an earlier row (or an earlier run) is found by its own card
       * id and used, not skipped: the ledger, not the business row, is what says a FACT was applied.
       */
      const mine = await app.db.query<{ id: string }>(
        `SELECT id FROM businesses WHERE source = 'trello' AND trello_card_id = $1`, [sourceId]
      );
      if (mine.rows[0]) {
        businessId = mine.rows[0].id;
      } else {
        const name = (row.name_clean ?? '').trim() || key;
        if (!name) { t.refused++; continue; }
        const ins = await app.db.query<{ id: string }>(
          `INSERT INTO businesses (name, state, source, unverified_import_source, trello_card_id, notes)
           VALUES ($1, $2, 'trello', 'trello', $3, $4) RETURNING id`,
          [
            name,
            String(values.state ?? '').trim() || 'IL',
            sourceId,
            `Created by the Trello import (${SOURCE_TAG}) from 04b ${factType} row ${sourceId}. Unverified: Trello holds no EIN and no entity type, and the name was typed by hand.`,
          ]
        );
        businessId = ins.rows[0]!.id;
        t.recordsCreated++;
      }
      matchedBizByKey.set(key, businessId); // later facts for the same name land on the same business
    }

    /*
     * R33: sales_tax AND payroll LAND ON AN ENGAGEMENT, through modules/engagements/import-facts.ts.
     * The contact is the business's primary member, or the matched contact when the card carried a
     * person's name. No contact means no engagement can exist (contact_id is NOT NULL), so the row
     * is deferred WITHOUT a ledger row and counted apart: a member added later makes it importable.
     */
    if (recurring) {
      const contactId = businessId ? (primaryMember.get(businessId) ?? null) : matchedContact;
      if (!contactId) { t.deferred++; t.noContact++; continue; }
      const got = await applyRecurringServiceFact(app, actorStaff, {
        factType: factType as RecurringFactType,
        sourceId, matchKey: key, asOf, appliedBy: APPLIED_BY, sourceTag: SOURCE_TAG,
        contactId, businessId, values,
      });
      if (got.outcome === 'already_applied') { t.skipped++; continue; }
      if (got.outcome === 'closed') t.closedServices++;
      if (got.engagementCreated) t.serviceEngagements++;
      t.facts += got.rowsWritten;
      continue; // the module wrote the ledger row
    }
    if (!businessId) { t.refused++; continue; } // unreachable: every non-recurring path above resolved or created one

    let wrote = 0;
    if (factType === 'bookkeeping') {
      const through = monthEnd(String(values.books_current_through ?? ''));
      if (through) {
        const r = await app.db.query(
          `UPDATE businesses SET books_current_through = $2, books_current_through_as_of = $3
            WHERE id = $1 AND books_current_through IS DISTINCT FROM $2::date`,
          [businessId, through, asOf]
        );
        wrote += r.rowCount ?? 0;
      }
      // ONLY A TRUE IS A FACT. `false` here means the card carried no such label, not that the firm
      // lacks access, and a row asserting the negative would be a claim nobody made.
      if (values.firm_has_bank_access === true) {
        wrote += await writeAccessFact(businessId, 'firm_has_bank_access', asOf);
      }
    } else if (factType === 'access') {
      for (const fact of Array.isArray(values.facts) ? values.facts : []) {
        wrote += await writeAccessFact(businessId, String(fact), asOf);
      }
    } else if (factType === 'annual_report_entity') {
      const state = String(values.state ?? '').trim();
      if (state) {
        const r = await app.db.query(
          `INSERT INTO entity_compliance (business_id, state) VALUES ($1, $2)
           ON CONFLICT (business_id) DO NOTHING`,
          [businessId, state]
        );
        wrote += r.rowCount ?? 0;
      }
    } else if (factType === 'annual_report_anniversary') {
      const kind = ANNIVERSARY_KIND_IN_04B[String(values.anniversary_kind ?? '').trim().toLowerCase()];
      const mmdd = String(values.anniversary_mmdd ?? '').trim();
      /*
       * BOTH OR NEITHER. 0108's CHECK refuses a month and day without the kind, deliberately: the
       * state rule picks between an admission and an incorporation anniversary, and a date with the
       * wrong kind produces the wrong due date with full confidence. 61 of 118 rows carry no kind, so
       * they are deferred rather than guessed.
       */
      if (kind && /^(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])$/.test(mmdd)) {
        const r = await app.db.query(
          `INSERT INTO entity_compliance (business_id, state, anniversary_mmdd, anniversary_kind)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (business_id) DO UPDATE SET anniversary_mmdd = $3, anniversary_kind = $4
            WHERE entity_compliance.anniversary_mmdd IS NULL`,
          [businessId, String(values.state ?? '').trim() || 'IL', mmdd, kind]
        );
        wrote += r.rowCount ?? 0;
      } else {
        t.deferred++;
        continue; // no ledger row: a later bundle that supplies the kind must be able to apply it
      }
    }

    await app.db.query(
      `INSERT INTO service_fact_imports (source, trello_source_id, fact_type, business_id, match_key, as_of, applied_by, rows_written)
       VALUES ('trello', $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, trello_source_id, fact_type) DO NOTHING`,
      [sourceId, factType, businessId, key, asOf, APPLIED_BY, wrote]
    );
    t.facts += wrote;
  }

  // -- file 04 is MATCHING ONLY now (R21). Nothing here reads it for facts. --
  tally['04_business_services.csv']!.deferred = f04.length;

  // ── files 01 and 02: the people who are not in SAOS ─────────────────────
  for (const [file, rows] of [['01_tax_wip.csv', f01], ['02_tax_ar_worklist.csv', f02]] as const) {
    for (const row of rows.slice(0, LIMIT)) {
      const cardId = (row.trello_card_id ?? '').trim();
      if (!cardId || !missingByCard.has(cardId)) continue;
      const t = tally[file]!;
      const entity = (row.source_board ?? '').toUpperCase().includes('BUSINESS');
      const table = entity ? 'businesses' : 'contacts';
      if (await alreadyImported(table, cardId)) { t.skipped++; continue; }
      if (entity) {
        const name = (row.name_clean ?? '').trim();
        if (!name) { t.refused++; continue; }
        await app.db.query(
          `INSERT INTO businesses (name, source, unverified_import_source, trello_card_id, notes)
           VALUES ($1, 'trello', 'trello', $2, $3)`,
          [name, cardId, `Created by the Trello import (${SOURCE_TAG}) from business-board card ${cardId}. Unverified: no EIN, no entity type.`]
        );
      } else {
        const name = splitName((row.name_clean ?? '').trim());
        if (!name) { t.refused++; continue; }
        await app.db.query(
          `INSERT INTO contacts (first_name, last_name, source, unverified_import_source, trello_card_id, notes)
           VALUES ($1, $2, 'trello', 'trello', $3, $4)`,
          [
            name.first, name.last, cardId,
            `Created by the Trello import (${SOURCE_TAG}) from card ${cardId}. Unverified: Trello holds no email, no SSN and no engagement for this person.` +
              (name.note ? ` ${name.note}` : ''),
          ]
        );
      }
      t.recordsCreated++;
    }
  }
  const sum = (k: keyof FileTally): number => FILES.reduce((n, f) => n + tally[f]![k], 0);
  console.log(
    `  ${pass} pass: ${sum('recordsCreated')} record(s) created, ${sum('returnsCreated')} return(s), ` +
      `${sum('attested')} attested, ${sum('tasks')} task(s), ${sum('facts')} service fact row(s), ` +
      `${sum('skipped')} skipped, ${sum('refused')} refused`
  );
  return tally;
}

console.log(`\nB — THE REAL IMPORT, inside the import context. No gate is stamped anywhere in it.`);
const tally = await runInImportContext(IMPORT_LABEL, () => runImport('first'));
/** The first pass's own numbers. The rerun's are asserted zero beside them, never added in. */
const sumOf = (k: keyof FileTally): number => FILES.reduce((n, f) => n + tally[f]![k], 0);
const afterFirst = await snapshot();
console.log(`  AFTER   outbox=${afterFirst.outbox} (pending ${afterFirst.pending}) audit=${afterFirst.audit} tasks=${afterFirst.tasks}`);
console.log(`  created: ${afterFirst.contacts - before.contacts} contact(s), ${afterFirst.businesses - before.businesses} business(es), ` +
  `${afterFirst.engagements - before.engagements} engagement(s), ${afterFirst.returns - before.returns} return(s); ` +
  `${afterFirst.attestations - before.attestations} attestation(s)`);
console.log(`  refused client-facing sends, audited: ${afterFirst.refusals - before.refusals}`);
console.log(
  `  R22: ${sumOf('preparerDefaulted')} return(s) took the default preparer, ${sumOf('letterInherited')} inherited a standing letter. ` +
    `R23: ${sumOf('declaredByDefault')} filed-awaiting-ack (R31: ${sumOf('declaredPaper')} of them in the paper lane), ${sumOf('notifyTasks')} accepted-not-notified, ${sumOf('completedSilently')} paper-filed. ` +
    `R21: ${await ledgerCount()} ledger row(s), ${sumOf('deferred')} row(s) deferred for want of a home. ` +
    `R33: ${sumOf('serviceEngagements')} sales-tax/payroll engagement(s) created, ${sumOf('closedServices')} closed service row(s) applied with nothing created, ${sumOf('noContact')} live row(s) deferred for want of a contact.`
);

// ── C: THE RERUN ───────────────────────────────────────────────────────────

console.log(`\nC — THE RERUN. The same bundle, the same script. Every delta must be zero.`);
const ledgerBeforeRerun = await ledgerCount();
const rerunTally = await runInImportContext(IMPORT_LABEL, () => runImport('rerun'));
const ledgerRows = await ledgerCount();
const afterRerun = await snapshot();
const rerunSum = (k: keyof FileTally): number => FILES.reduce((n, f) => n + rerunTally[f]![k], 0);
const rerunDeltas = {
  contacts: afterRerun.contacts - afterFirst.contacts,
  businesses: afterRerun.businesses - afterFirst.businesses,
  engagements: afterRerun.engagements - afterFirst.engagements,
  returns: afterRerun.returns - afterFirst.returns,
  tasks: afterRerun.tasks - afterFirst.tasks,
  attestations: afterRerun.attestations - afterFirst.attestations,
  facts: rerunSum('facts'),
  ledger: ledgerRows - ledgerBeforeRerun,
  outbox: afterRerun.outbox - afterFirst.outbox,
};
console.log(`  rerun deltas: ${Object.entries(rerunDeltas).map(([k, v]) => `${k} ${v}`).join(', ')}`);

// ── D: THE 8879 PROOF ──────────────────────────────────────────────────────

console.log(`\nD — AN IMPORTED RETURN AT ready_to_file IS ASKED TO FILE.`);
let proof = 'no imported return reached ready_to_file in this run';
if (readyToFileId) {
  try {
    await transitionStage(app, actorLabel, readyToFileId, 'filed', { preparerPtinHolderId: ceo.id });
    proof = 'NOT REFUSED — that is a build failure';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    proof = `refused: ${e.code} — ${e.message?.slice(0, 120)}`;
  }
  const gates = await app.db.query<{ letter: string | null; est: string | null; signed: string | null; doc: string | null; ptin: string | null; stage: string }>(
    `SELECT engagement_letter_signed_at AS letter, estimate_locked_at AS est, f8879_signed_at AS signed,
            f8879_document_id AS doc, preparer_ptin_holder_id AS ptin, stage::text AS stage
       FROM tax_engagements WHERE id = $1`, [readyToFileId]
  );
  const g = gates.rows[0]!;
  console.log(`  ${proof}`);
  console.log(`  and the gate facts are still empty: letter=${g.letter ?? 'null'} estimate=${g.est ?? 'null'} 8879=${g.signed ?? 'null'} doc=${g.doc ?? 'null'} ptin=${g.ptin ?? 'null'}; stage=${g.stage}`);
} else {
  console.log(`  ${proof}`);
}

// ── the logs ───────────────────────────────────────────────────────────────

/*
 * TWO BREAKDOWNS READ FROM THE DATABASE RATHER THAN COUNTED IN THE SCRIPT.
 *
 * The per-file tally is what the import BELIEVES it did; these two are what the copy actually holds.
 * They are not the same claim, and a report that only carries the first one cannot notice a write
 * that silently did nothing.
 */
const tasksByType = (
  await app.db.query<{ source_type: string; n: string }>(
    `SELECT source_type, count(*)::text AS n FROM tasks
      WHERE trello_card_id IS NOT NULL GROUP BY source_type ORDER BY source_type`
  )
).rows;
const factsByType = (
  await app.db.query<{ fact_type: string; applied: string; wrote: string }>(
    `SELECT fact_type, count(*)::text AS applied, sum(rows_written)::text AS wrote
       FROM service_fact_imports GROUP BY fact_type ORDER BY fact_type`
  )
).rows;
/** R33: what the copy holds — the imported sales-tax and payroll engagements, and how many carry the fact. */
const recurringEngagements = (
  await app.db.query<{ service_line: string; n: string; with_value: string }>(
    `SELECT service_line::text AS service_line, count(*)::text AS n,
            count(*) FILTER (WHERE filing_frequency IS NOT NULL OR payroll_provider IS NOT NULL)::text AS with_value
       FROM engagements WHERE source = 'trello' AND service_line IN ('sales_tax', 'payroll')
      GROUP BY service_line ORDER BY service_line`
  )
).rows;
/** Which 04b fact types the import read and applied nothing for, so "no home yet" is a number. */
const deferredByType = (() => {
  const applied = new Set(factsByType.map((r) => r.fact_type));
  const counts = new Map<string, number>();
  for (const r of f04b) {
    const ft = (r.fact_type ?? '').trim();
    if (!ft || applied.has(ft) || ft === 'qbo_paid_by_2022_DO_NOT_IMPORT') continue;
    counts.set(ft, (counts.get(ft) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
})();

const row = (f: (typeof FILES)[number], rows: number, rerunNote: string): string => {
  const t = tally[f]!;
  return `${f} | ${rows} | ${t.recordsCreated} | ${t.returnsCreated} | ${t.attested} | ${t.tasks} | ${t.facts} | ${t.deferred} | ${t.refused} | ${t.skipped} | ${rerunNote}`;
};
const rehearsal = [
  'source file | rows | records created | returns created | attested at a stage | tasks | service fact rows written | deferred (no home in SAOS yet) | refused or never imported | skipped (already imported, or no unique match) | second pass',
  row('01_tax_wip.csv', f01.length, `engagements ${rerunDeltas.engagements}, returns ${rerunDeltas.returns}, attestations ${rerunDeltas.attestations}`),
  row('02_tax_ar_worklist.csv', f02.length, `tasks ${rerunDeltas.tasks}`),
  row('03_tax_completed_roster.csv', 388, `never imported: the script refuses it in code, and its ${enrichmentCount} missing row(s) go to out/enrichment_file03.csv and are not created`),
  row('04_business_services.csv', f04.length, `R21: matching only — every one of its ${f04.length} rows is deferred here by design, and no fact is read from it`),
  row('04b_service_facts.csv', f04b.length, `businesses ${rerunDeltas.businesses}, service facts ${rerunDeltas.facts}, ledger rows ${rerunDeltas.ledger}`),
  `ALL FILES | ${f01.length + f02.length + 388 + f04.length + f04b.length} | ${sumOf('recordsCreated')} | ${sumOf('returnsCreated')} | ${sumOf('attested')} | ${sumOf('tasks')} | ${sumOf('facts')} | ${sumOf('deferred')} | ${sumOf('refused')} | ${sumOf('skipped')} | every delta on the second pass: ${Object.entries(rerunDeltas).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  `R22 THE PREPARER DEFAULT | ${pre.activePreparers} active tax_preparer(s) | - | ${sumOf('preparerDefaulted')} return(s) took the sole active preparer | - | ${sumOf('letterInherited')} inherited a standing engagement letter | - | - | - | - | the import refuses outright when none is active; that refusal is in the sabotage manifest and in test/trello-import.spec.ts`,
  `R23 AT OR PAST FILED | ${sumOf('declaredByDefault') + sumOf('notifyTasks') + sumOf('completedSilently')} return(s) | - | - | - | - | - | - | - | - | filed-awaiting-ack ${sumOf('declaredByDefault')} (jurisdictions by address default, method by the year's lane, flagged, + a confirm task); accepted-not-notified ${sumOf('notifyTasks')} (completed, no acceptance row, + a notify task); paper-filed ${sumOf('completedSilently')} (completed, no acceptance and no mailing invented)`,
  `R31 FILED-AWAITING-ACK IN THE PAPER LANE | ${sumOf('declaredPaper')} return(s) | - | - | - | - | - | - | 0 refused for being old | - | of ${sumOf('declaredByDefault')} filed-awaiting-ack card(s), ${sumOf('declaredPaper')} carried a tax year older than current + 2 prior and were declared PAPER by the year's lane, flagged declared_by_import_default, with the confirm task and NO mailing written (mailed_on null); every imported return here is tax year 2025, so the paper shape is asserted in test/trello-import.spec.ts rather than exercised by this bundle`,
  `R33 SALES-TAX AND PAYROLL FACTS | ${f04b.filter((r) => RECURRING_FACT.has((r.fact_type ?? '').trim())).length} row(s) | ${sumOf('serviceEngagements')} engagement(s) created | - | - | - | ${factsByType.filter((r) => RECURRING_FACT.has(r.fact_type)).reduce((n, r) => n + Number(r.wrote), 0)} | ${sumOf('noContact')} deferred: live service on a business with no member to bill | - | - | ${factsByType.filter((r) => RECURRING_FACT.has(r.fact_type)).map((r) => `${r.fact_type}: ${r.applied} applied, ${r.wrote} row(s) written`).join('; ') || 'none applied'}; ${sumOf('closedServices')} row(s) named a closed service and created nothing (ledger row, 0 written); engagements on the copy: ${recurringEngagements.map((r) => `${r.service_line} ${r.n} (${r.with_value} carrying ${r.service_line === 'sales_tax' ? 'a filing_frequency' : 'a payroll_provider'})`).join(', ') || 'none'}`,
  `REFUSED CLIENT SENDS (audited, both passes) | - | - | - | - | - | - | - | ${afterRerun.refusals - before.refusals} | - | outbox rows the import itself added: ${afterRerun.outbox - before.outbox - probeOn.delta - (probeOff ? probeOff.delta : 0)}`,
  `THE 8879 GATE ON AN IMPORTED ready_to_file RETURN | - | - | - | - | - | - | - | - | - | ${proof}`,
  `TASKS BY TYPE (on the copy, from the tasks table) | ${tasksByType.reduce((n, r) => n + Number(r.n), 0)} | - | - | - | - | - | - | - | - | ${tasksByType.map((r) => `${r.source_type} ${r.n}`).join(', ')}`,
  `04b SERVICE FACTS BY TYPE (from the ledger) | ${factsByType.reduce((n, r) => n + Number(r.applied), 0)} source row(s) applied | - | - | - | - | ${factsByType.reduce((n, r) => n + Number(r.wrote), 0)} | - | - | - | ${factsByType.map((r) => `${r.fact_type}: ${r.applied} applied, ${r.wrote} row(s) written`).join('; ')}`,
  `04b DEFERRED BY TYPE (read, no home in SAOS yet) | ${deferredByType.reduce((n, r) => n + r[1], 0)} | - | - | - | - | - | ${deferredByType.reduce((n, r) => n + r[1], 0)} | - | - | ${deferredByType.map(([t, n]) => `${t} ${n}`).join(', ')}; plus qbo_paid_by_2022_DO_NOT_IMPORT ${f04b.filter((r) => (r.fact_type ?? '').trim() === 'qbo_paid_by_2022_DO_NOT_IMPORT').length} REFUSED outright (Brian ruled the 2022 values out)`,
];
writeFileSync(resolve(LOGS, 'import-rehearsal.log'), rehearsal.join('\n') + '\n');
console.log('\n' + rehearsal.join('\n'));

const sabotage = [
  'measurement | import mode | outbox rows added | refusals audited | stage reached | what it means',
  `one imported return carrying a fee, walked to filed | ON | ${probeOn.delta} | ${probeOn.refusalDelta} | ${probeOn.reached} | the client is told nothing, and the refusal is on the record`,
  probeOff
    ? `the same return, the same walk | OFF (--unsafe-no-import-mode) | ${probeOff.delta} | ${probeOff.refusalDelta} | ${probeOff.reached} | without the mode the invoice email is queued for real — which is what the zero above prevents`
    : `the same return, the same walk | OFF | not measured in this run | — | — | rerun with --unsafe-no-import-mode on the copy to take it`,
];
writeFileSync(resolve(LOGS, 'import-mode-sabotage.log'), sabotage.join('\n') + '\n');
console.log('\n' + sabotage.join('\n'));

await app.close();
console.log(`\ntrello-import: done (${DATE}). Database '${dbName}' — a copy, to be dropped.`);
process.exit(0);
