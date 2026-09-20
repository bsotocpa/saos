/*
 * SHARED, PURE, AND IMPORTABLE (Brian, 2026-09-19).
 *
 * The copy guard and the two normalizers live here rather than in either script, because
 * scripts/trello-import.ts needs all three and a script with top-level work is not a module you
 * can import — importing trello-match.ts to borrow a function would run the whole match.
 *
 * Nothing in this file touches a database or a file. Everything here is a pure function, which is
 * also what makes the copy guard testable.
 */
// ── the copy guard ──────────────────────────────────────────────────────────

/**
 * Refuse any database whose name does not end in `_copy`.
 *
 * Brian's constraint, 2026-09-19: "never point anything at the production database name `saos`
 * for writes; the match and import scripts must refuse to run unless DATABASE_URL's database
 * name ends with `_copy`." Asserted in code rather than trusted to the command line, because the
 * command line is where the mistake happens.
 */
export function assertCopyDatabase(url: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('refusing: DATABASE_URL is not a URL, so its database name cannot be checked');
  }
  if (!name) throw new Error('refusing: DATABASE_URL names no database');
  if (!name.endsWith('_copy')) {
    throw new Error(
      `refusing: the database is '${name}'. This script runs against a COPY only — a name ending ` +
        `in '_copy'. Production is never the target (Brian, 2026-09-19).`
    );
  }
  return name;
}

// ── normalization ───────────────────────────────────────────────────────────

/** The legal-suffix and form-number tokens the bundle's key() drops. Same list, same order. */
const SUFFIX = /\b(LLC|L L C|INC|CORP|CORPORATION|PLLC|NFP|CO|COMPANY|LTD|THE|PC)\b/g;
const FORMS = /\b(1120S?|1065|990N?|SCH ?C)\b/g;

/** extract.py's cut(): drop a leading year, then keep the part before the first separator. */
function cut(raw: string): string {
  const s = raw.trim();
  const noYear = s.replace(/^\s*20\d\d\s*[-–_]?\s*/, '') || s;
  const first = noYear.trim().split(/\s+-\s*|\s+–\s*|\s*\(|_|\s+=\s*|\s{3,}|\s+\/\s*|\s*\*|\s+-$|\n/)[0] ?? '';
  return first.replace(/^[-.,\s]+|[-.,\s]+$/g, '');
}

/** extract.py's key(), mirrored exactly. The bundle's match_key column IS this function's output. */
export function trelloKey(raw: string): string {
  let s = cut(raw).toUpperCase().replace(/&/g, ' AND ');
  s = s.replace(/[^A-Z0-9 ]/g, '');
  s = s.replace(SUFFIX, '');
  s = s.replace(FORMS, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** `norm` from crm/duplicates.ts, verbatim: the duplicate scan's own idea of the same person. */
export function contactNorm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Trigram Jaccard, 0..1. Named in the report so the score in the CSV means something. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** A household row: "A & B Lastname" (or "A and B Lastname"). */
export function splitHousehold(nameClean: string): { firsts: string[]; last: string } | null {
  const m = /^(.+?)\s+(?:&|and)\s+(.+)$/i.exec(nameClean.trim());
  if (!m) return null;
  const left = m[1]!.trim().split(/\s+/);
  const right = m[2]!.trim().split(/\s+/);
  if (right.length < 2) return null; // "A & B" with no surname is not a household we can resolve
  const last = right[right.length - 1]!;
  const firstB = right.slice(0, right.length - 1).join(' ');
  const firstA = left.join(' ');
  if (!firstA || !firstB) return null;
  return { firsts: [firstA, firstB], last };
}

// -- the stage map, one copy ------------------------------------------------

/**
 * EVERY PLAIN-ENGLISH TRELLO STAGE, AND WHAT THE IMPORT DOES WITH IT.
 *
 * This lived in trello-match.ts as a reporting table and in nobody's head as a rule. Now both the
 * report and the import read the SAME object, because on 2026-09-20 they stopped being able to
 * disagree harmlessly: the match report says a value is a GAP and the import has to DO something
 * with that row. Two copies would let the report claim a gap the import silently filed anyway.
 *
 * `saosStage` is the report's label and may read 'GAP'. `stage` is what the import actually sets,
 * and is null wherever there is no stage to set. `handling` says which of the three shapes the row
 * takes (Brian, 2026-09-20, item g):
 *
 *   'stage'          create the engagement and the return, place it at `stage` by attestation
 *   'preparer_task'  no return at all -- a task for the preparer, because SAOS has no shape for it
 *   'ceo_task'       no return at all -- a task for Brian, because the work is his review of BOOKS
 *
 * A VALUE NOT IN HERE IS NOT GUESSED. Both scripts treat an unlisted value as unreviewed: the
 * report prints it as UNREVIEWED and the import refuses the row rather than picking a near stage.
 */
export interface StageMapping {
  /** The stage the import sets, or null when the row becomes a task instead. */
  stage: string | null;
  handling: 'stage' | 'preparer_task' | 'ceo_task';
  /** The label the stage-map report prints — 'GAP' where SAOS has no equivalent. */
  saosStage: string;
  /** Why, in a person's words. Goes in the report, and into the stage note or task description. */
  mapping: string;
}

export const STAGE_MAP: Record<string, StageMapping> = {
  'ready to prepare': { stage: 'in_preparation', handling: 'stage', saosStage: 'in_preparation', mapping: 'maps; entering in_preparation needs estimate_locked_at (gate 2), which the import does not stamp — the stage is set by attestation and the lock stays absent (R16)' },
  'awaiting client response': { stage: 'pending_client_response', handling: 'stage', saosStage: 'pending_client_response', mapping: 'maps exactly; waiting_on = client' },
  'awaiting documents': { stage: 'documents_requested', handling: 'stage', saosStage: 'documents_requested', mapping: 'maps exactly' },
  'awaiting documents (exempt org)': { stage: 'documents_requested', handling: 'stage', saosStage: 'documents_requested', mapping: 'maps exactly; the exempt-org part is return_type 990/990ez, not a stage' },
  'awaiting signature': { stage: 'ready_to_file', handling: 'stage', saosStage: 'ready_to_file', mapping: 'maps; the 8879 gate sits on entering filed, so "awaiting signature" IS ready_to_file — and the imported return is refused filed until a scan is uploaded' },
  'prepared, not yet sent for signature': { stage: 'internal_review', handling: 'stage', saosStage: 'internal_review', mapping: 'maps' },
  'extended, awaiting documents': { stage: 'documents_requested', handling: 'stage', saosStage: 'documents_requested', mapping: 'maps; Extended is tax_engagements.extension_filed, a parallel flag, never a stage' },
  'e-file rejected': { stage: 'rejected', handling: 'stage', saosStage: 'rejected', mapping: 'maps exactly; a reject also carries a perfection_deadline SAOS computes, which Trello has no field for' },
  'prior-year return in progress': { stage: 'in_preparation', handling: 'stage', saosStage: 'in_preparation', mapping: 'maps; the filing lane is derived from the year (filingLane), never carried over from Trello' },
  'accepted, client not yet notified': { stage: 'completed', handling: 'stage', saosStage: 'completed', mapping: 'maps; acceptance is recorded per jurisdiction by the ATX acknowledgment ingest, and "not yet notified" is the efile_acknowledgment automation, not a stage' },
  'accepted, balance open': { stage: 'completed', handling: 'stage', saosStage: 'completed', mapping: 'maps; "balance open" is an invoice status (invoices.status), not a stage' },
  'accepted and paid': { stage: 'completed', handling: 'stage', saosStage: 'completed', mapping: 'maps; the money is an invoice fact, not a stage. File 03 carries these and is never imported' },
  'paper filed': { stage: 'filed', handling: 'stage', saosStage: 'filed', mapping: 'PARTIAL: filed exists, and so do filing_lane/paper_mailed_on/certified_tracking, but no acceptance can ever be RECORDED for a paper return (ack rows come only from the ATX report upload), so completion is a bare hand move with nothing accepted' },
  'amendment in progress': { stage: null, handling: 'preparer_task', saosStage: 'GAP', mapping: 'no amendment stage and no 1040X in the return_type enum; amendments exist only as the price-book item IND_AMENDMENT_1040X. Imported as a PREPARER TASK until a 1040-X return type is ruled — a return typed 1040 at some stage would claim the original return is being prepared again' },
  'blocked on business return/financials': { stage: 'documents_requested', handling: 'stage', saosStage: 'documents_requested (+ note)', mapping: 'no blocked stage; the dependency is a task_dependencies row ("blocked by"), which needs the blocker to exist. Imported at documents_requested — what is true of it today — with the blocker named in the note' },
  'awaiting year-end financials (bookkeeping dependency)': { stage: 'documents_requested', handling: 'stage', saosStage: 'documents_requested (+ note)', mapping: 'same shape: the wait is on a close_cycles period that the import does not create. Imported at documents_requested with the dependency named in the note' },
  'awaiting CPA review of financials': { stage: null, handling: 'ceo_task', saosStage: 'GAP', mapping: 'internal_review is the REVIEW OF THE RETURN; this is Brian reviewing the BOOKS (close_cycles.statements_ready_at). Not the same thing, not forced — imported as a CEO TASK' },
};

/** The stage the import sets for a plain-English Trello value, or null when it becomes a task. */
export function stageFor(plain: string): StageMapping | null {
  return STAGE_MAP[plain.trim()] ?? null;
}
