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
import { transitionStage, type TaxStage } from '../src/modules/tax/pipeline.ts';
import { isOneActivePerPeriodViolation } from '../src/modules/engagements/period.ts';
import { setImportedStage } from '../src/modules/tax/import.ts';
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
const DEFAULT_DIR = 'C:/Users/brian/saos-imports/trello_import';
const DIR = resolve(arg('dir', process.env.TRELLO_IMPORT_DIR ?? DEFAULT_DIR));
const OUT = resolve(DIR, 'out');
const LOGS = resolve(DIR, 'logs');
const LIMIT = Number(arg('limit', '1000'));
const UNSAFE = argv.includes('--unsafe-no-import-mode');

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
const enrichmentCount = existsSync(resolve(OUT, 'enrichment_file03.csv'))
  ? parseCsvObjects(readFileSync(resolve(OUT, 'enrichment_file03.csv'), 'utf8')).length
  : 0;
console.log(`  match verdicts read: ${matchedByCard.size} matched card(s), ${missingByCard.size} not in SAOS, ${enrichmentCount} on the file-03 enrichment list`);

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
 * A FILE-04 ROW WITH NO CARD ID CANNOT BE IMPORTED, and this is a finding rather than a bug here.
 * (source, trello_card_id) is the rerun guard (migration 0111); a row with no card id has no key, so
 * a second run could not tell it apart from the first and would create the business twice. The
 * bundle's bk_card_id is only filled where a bookkeeping card exists — 109 of 464 rows — and the
 * count below is how many rows carrying a LIVE service the import therefore has to refuse. Either
 * the extract supplies a card id for them or Brian rules that the name key is the key; the script
 * does not invent one.
 */
const noCardWithService = f04.filter((r) => !(r.bk_card_id ?? '').trim() && activeService(r)).length;
console.log(`  file 04: ${f04.filter((r) => (r.bk_card_id ?? '').trim()).length} of ${f04.length} row(s) carry a card id; ${noCardWithService} row(s) with a LIVE service have none and are refused (no rerun key)`);

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
interface FileTally { recordsCreated: number; returnsCreated: number; attested: number; tasks: number; skipped: number; refused: number; facts: number }
const emptyTally = (): FileTally => ({ recordsCreated: 0, returnsCreated: 0, attested: 0, tasks: 0, skipped: 0, refused: 0, facts: 0 });
type Tallies = Record<string, FileTally>;
const FILES = ['01_tax_wip.csv', '02_tax_ar_worklist.csv', '03_tax_completed_roster.csv', '04_business_services.csv'] as const;
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

const ANNIVERSARY_KIND: Record<string, string> = { 'admission date': 'admission', 'incorporation date': 'incorporation' };

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

  // ── file 04: the businesses that are missing, and the service facts ─────
  for (const row of f04.slice(0, LIMIT)) {
    const t = tally['04_business_services.csv']!;
    const cardId = (row.bk_card_id ?? '').trim();
    if (!cardId) { t.refused++; continue; }
    const matched = matchedByCard.get(cardId);
    const missing = missingByCard.get(cardId);
    let businessId: string | null = matched?.saos_id ?? null;

    if (!businessId && missing) {
      /*
       * ITEM f: an ACTIVE file-04 row with no SAOS business is created as an unverified import. An
       * inactive one is not: a business whose bookkeeping is Lost and whose payroll is closed has no
       * live service to attach, and a record created for it would be a name in the directory with
       * nothing behind it.
       */
      if (!activeService(row)) { t.skipped++; continue; }
      if (await alreadyImported('businesses', cardId)) { t.skipped++; continue; }
      const name = (row.name_most_common ?? '').trim() || (row.match_key ?? '').trim();
      if (!name) { t.refused++; continue; }
      const ins = await app.db.query<{ id: string }>(
        `INSERT INTO businesses (name, state, source, unverified_import_source, trello_card_id, notes)
         VALUES ($1, $2, 'trello', 'trello', $3, $4) RETURNING id`,
        [
          name,
          (row.annual_report_state ?? '').trim() || 'IL',
          cardId,
          `Created by the Trello import (${SOURCE_TAG}) from card ${cardId}. Unverified: Trello holds no EIN and no entity type, and the name was typed by hand.`,
        ]
      );
      businessId = ins.rows[0]!.id;
      t.recordsCreated++;
    }
    if (!businessId) { t.skipped++; continue; }

    /*
     * THE SERVICE FACTS the 0105-0110 migrations exist for. Written on matched and created
     * businesses alike, because a column nothing ever writes is an unproven migration.
     *
     * TWO ARE DELIBERATELY NOT WRITTEN. engagements.filing_frequency and engagements.payroll_provider
     * live on an engagement, and this rehearsal creates no bookkeeping, sales-tax or payroll
     * engagements — those are a service-line import, not this one. businesses.qbo_paid_by stays
     * 'unknown' on Brian's explicit instruction: the bundle's values are from a 2022 pass.
     */
    const through = monthEnd(row.books_current_through ?? '');
    const asOf = (row.bk_as_of ?? '').trim();
    if (through && asOf) {
      const r = await app.db.query(
        `UPDATE businesses SET books_current_through = $2, books_current_through_as_of = $3
          WHERE id = $1 AND books_current_through IS DISTINCT FROM $2::date`,
        [businessId, through, asOf]
      );
      t.facts += r.rowCount ?? 0;
    }
    const facts = new Set((row.access_facts ?? '').split(/\s+/).filter(Boolean));
    if ((row.bk_bank_access ?? '').trim().toLowerCase() === 'yes') facts.add('firm_has_bank_access');
    for (const fact of facts) {
      const r = await app.db.query(
        `INSERT INTO business_access_facts (business_id, fact, as_of, source)
         VALUES ($1, $2, $3, 'trello') ON CONFLICT DO NOTHING`,
        [businessId, fact, asOf || BUNDLE_DATE]
      );
      t.facts += r.rowCount ?? 0;
    }
    const kind = ANNIVERSARY_KIND[(row.ar_anniversary_kind ?? '').trim().toLowerCase()];
    const mmdd = (row.ar_anniversary_mmdd ?? '').trim();
    if (kind && /^\d{2}\/\d{2}$/.test(mmdd)) {
      const r = await app.db.query(
        `INSERT INTO entity_compliance (business_id, state, anniversary_mmdd, anniversary_kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (business_id) DO UPDATE SET anniversary_mmdd = $3, anniversary_kind = $4
          WHERE entity_compliance.anniversary_mmdd IS NULL`,
        [businessId, (row.annual_report_state ?? '').trim() || 'IL', mmdd, kind]
      );
      t.facts += r.rowCount ?? 0;
    }
  }

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
const afterFirst = await snapshot();
console.log(`  AFTER   outbox=${afterFirst.outbox} (pending ${afterFirst.pending}) audit=${afterFirst.audit} tasks=${afterFirst.tasks}`);
console.log(`  created: ${afterFirst.contacts - before.contacts} contact(s), ${afterFirst.businesses - before.businesses} business(es), ` +
  `${afterFirst.engagements - before.engagements} engagement(s), ${afterFirst.returns - before.returns} return(s); ` +
  `${afterFirst.attestations - before.attestations} attestation(s)`);
console.log(`  refused client-facing sends, audited: ${afterFirst.refusals - before.refusals}`);

// ── C: THE RERUN ───────────────────────────────────────────────────────────

console.log(`\nC — THE RERUN. The same bundle, the same script. Every delta must be zero.`);
const rerunTally = await runInImportContext(IMPORT_LABEL, () => runImport('rerun'));
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

/** The first pass's own numbers. The rerun's are asserted zero beside them, never added in. */
const sumOf = (k: keyof FileTally): number => FILES.reduce((n, f) => n + tally[f]![k], 0);
const row = (f: (typeof FILES)[number], rows: number, rerunNote: string): string => {
  const t = tally[f]!;
  return `${f} | ${rows} | ${t.recordsCreated} | ${t.returnsCreated} | ${t.attested} | ${t.tasks} | ${t.facts} | ${t.refused} | ${t.skipped} | ${rerunNote}`;
};
const rehearsal = [
  'source file | rows | records created | returns created | attested at a stage | tasks | service fact rows | refused or not importable | skipped (already imported, or no unique match) | second pass',
  row('01_tax_wip.csv', f01.length, `engagements ${rerunDeltas.engagements}, returns ${rerunDeltas.returns}, attestations ${rerunDeltas.attestations}`),
  row('02_tax_ar_worklist.csv', f02.length, `tasks ${rerunDeltas.tasks}`),
  row('03_tax_completed_roster.csv', 388, `never imported: the script refuses it in code, and its ${enrichmentCount} missing row(s) go to out/enrichment_file03.csv and are not created`),
  row('04_business_services.csv', f04.length, `businesses ${rerunDeltas.businesses}, service facts ${rerunDeltas.facts}`),
  `ALL FILES | ${f01.length + f02.length + 388 + f04.length} | ${sumOf('recordsCreated')} | ${sumOf('returnsCreated')} | ${sumOf('attested')} | ${sumOf('tasks')} | ${sumOf('facts')} | ${sumOf('refused')} | ${sumOf('skipped')} | every delta on the second pass: ${Object.entries(rerunDeltas).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  `REFUSED CLIENT SENDS (audited, both passes) | - | - | - | - | - | - | ${afterRerun.refusals - before.refusals} | - | outbox rows the import itself added: ${afterRerun.outbox - before.outbox - probeOn.delta - (probeOff ? probeOff.delta : 0)}`,
  `THE 8879 GATE ON AN IMPORTED ready_to_file RETURN | - | - | - | - | - | - | - | - | ${proof}`,
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
