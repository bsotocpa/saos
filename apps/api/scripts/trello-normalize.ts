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
