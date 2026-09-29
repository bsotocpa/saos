#!/usr/bin/env node
/*
 * THE DUPLICATE SWEEP, REPORT-ONLY (Brian, 2026-09-27, R80).
 *
 * The duplicate scan's normalizer (crm/duplicates.ts `norm`: lowercase, single spaces, trimmed; the
 * merge's identifiers: the same email, the same last ten phone digits) run across every production
 * contact that is not archived and not a test record, and the same idea for businesses: the legal
 * name with punctuation and the entity ending (LLC, Inc, Corp, ...) removed, and the EIN by its
 * digits. Read-only: one SELECT inside a READ ONLY transaction on the box. Nothing is merged, noted
 * or changed: Brian rules on each pair before any merge.
 *
 *   node scripts/duplicate-sweep.mjs [--date 2026-09-28]
 *
 * Writes the REVIEW FILE (names and ids, client data) to C:\Users\brian\saos-review\<date>-duplicates.csv,
 * outside the repository and outside any synced folder; prints COUNTS ONLY on stdout, " | "-separated,
 * for scripts/report-table.mjs --from-log. The merge proposal per pair:
 *   contacts sharing an email or a phone  merge the record holding less into the one holding more
 *                                         (the scan's own score: portal, engagements, invoices, ...)
 *   contacts sharing only a name          no merge (a name alone never merges); a possible duplicate
 *   businesses sharing an EIN             merge the one holding less into the one holding more
 *   businesses sharing only a name        review: the same name, no shared EIN
 *   a protected name (duplicates.ts)      never proposed: Brian names the record himself
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dateIx = process.argv.indexOf('--date');
const date = dateIx > 0 ? process.argv[dateIx + 1] : new Date().toISOString().slice(0, 10);
const PROTECTED = new Set(['jackson flores', 'josean irizarry', 'joseph basilone']);
const REVIEW_DIR = 'C:\\Users\\brian\\saos-review';

const SQL = `
WITH c AS (
  SELECT c.id, c.first_name || ' ' || c.last_name AS name,
         lower(regexp_replace(btrim(c.first_name || ' ' || c.last_name), '\\s+', ' ', 'g')) AS nname,
         NULLIF(lower(btrim(COALESCE(c.email::text, ''))), '') AS nemail,
         right(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 10) AS nphone,
         (CASE WHEN EXISTS (SELECT 1 FROM portal_users pu WHERE pu.contact_id = c.id) THEN 1000 ELSE 0 END
          + 50 * (SELECT count(*) FROM engagements x WHERE x.contact_id = c.id)
          + 40 * (SELECT count(*) FROM invoices x WHERE x.contact_id = c.id)
          + 40 * (SELECT count(*) FROM engagement_packets x WHERE x.contact_id = c.id)
          + 20 * (SELECT count(*) FROM documents x WHERE x.contact_id = c.id)
          + 10 * (SELECT count(*) FROM quotes x WHERE x.contact_id = c.id)
          + 10 * (SELECT count(*) FROM business_members x WHERE x.contact_id = c.id)
          +  5 * (SELECT count(*) FROM tasks x WHERE x.contact_id = c.id))::int AS score
    FROM contacts c
   WHERE NOT c.is_archived AND c.contact_status <> 'archived' AND NOT c.is_test
), cp AS (
  SELECT 'contact' AS kind, a.id AS a_id, a.name AS a_name, a.score AS a_score, b.id AS b_id, b.name AS b_name, b.score AS b_score,
         (a.nname = b.nname) AS same_name,
         (a.nemail IS NOT NULL AND a.nemail = b.nemail) AS same_email,
         (length(a.nphone) = 10 AND a.nphone = b.nphone) AS same_phone,
         false AS same_ein
    FROM c a JOIN c b ON a.id < b.id
     AND (a.nname = b.nname OR (a.nemail IS NOT NULL AND a.nemail = b.nemail) OR (length(a.nphone) = 10 AND a.nphone = b.nphone))
), b AS (
  SELECT b.id, b.name,
         btrim(regexp_replace(regexp_replace(lower(b.name), '[^a-z0-9 ]+', ' ', 'g'),
               '(\\s+(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|pllc|pc|lp|llp))+\\s*$', '')) AS nname,
         NULLIF(regexp_replace(COALESCE(b.ein, ''), '\\D', '', 'g'), '') AS nein,
         (10 * (SELECT count(*) FROM business_members x WHERE x.business_id = b.id)
          + 50 * (SELECT count(*) FROM engagements x WHERE x.business_id = b.id)
          + 20 * (SELECT count(*) FROM documents x WHERE x.business_id = b.id))::int AS score
    FROM businesses b
   WHERE NOT b.is_archived
), bp AS (
  SELECT 'business' AS kind, x.id, x.name, x.score, y.id, y.name, y.score,
         (x.nname <> '' AND x.nname = y.nname), false, false,
         (x.nein IS NOT NULL AND length(x.nein) = 9 AND x.nein = y.nein)
    FROM b x JOIN b y ON x.id < y.id
     AND ((x.nname <> '' AND x.nname = y.nname) OR (x.nein IS NOT NULL AND length(x.nein) = 9 AND x.nein = y.nein))
)
SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb)::text FROM (SELECT * FROM cp UNION ALL SELECT * FROM bp) p`;

const ip = readFileSync(resolve(root, '.env.production'), 'utf8').match(/^SERVER_IPV4=(.+)$/m)?.[1]?.trim();
if (!ip) { console.error('no SERVER_IPV4 in .env.production'); process.exit(2); }
const key = resolve(process.env.HOME ?? process.env.USERPROFILE ?? '', '.ssh', 'saos_hetzner_ed25519');
const out = execFileSync('ssh', ['-i', key, '-o', 'BatchMode=yes', `root@${ip}`, 'docker exec -i saos-postgres-1 psql -U saos -d saos -t -A -v ON_ERROR_STOP=1'], {
  input: `BEGIN READ ONLY;\n${SQL};\nROLLBACK;\n`, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
});
const json = out.split(/\r?\n/).find((l) => l.startsWith('['));
if (!json) { console.error('no rows came back'); process.exit(1); }
const pairs = JSON.parse(json);

const reasonsOf = (p) => [p.same_name && 'name', p.same_email && 'email', p.same_phone && 'phone', p.same_ein && 'EIN'].filter(Boolean);
const proposalOf = (p) => {
  const isProtected = p.kind === 'contact' && (PROTECTED.has(String(p.a_name).toLowerCase().replace(/\s+/g, ' ').trim()) || PROTECTED.has(String(p.b_name).toLowerCase().replace(/\s+/g, ' ').trim()));
  if (isProtected) return { key: 'protected: never proposed', keep: '', merge: '' };
  const strong = p.kind === 'contact' ? p.same_email || p.same_phone : p.same_ein;
  if (!strong) return { key: p.kind === 'contact' ? 'no merge: name only' : 'review: same name, no shared EIN', keep: '', merge: '' };
  const aKeeps = p.a_score >= p.b_score;
  return { key: 'merge proposed', keep: aKeeps ? p.a_id : p.b_id, merge: aKeeps ? p.b_id : p.a_id };
};

// The review file: client data, local only.
mkdirSync(REVIEW_DIR, { recursive: true });
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lines = [['kind', 'record A id', 'record A', 'A holds (score)', 'record B id', 'record B', 'B holds (score)', 'shared', 'proposal', 'keep id', 'merge id', 'decision (merge / keep)'].map(csvCell).join(',')];
const counts = new Map();
for (const p of pairs) {
  const reasons = reasonsOf(p);
  const prop = proposalOf(p);
  lines.push([p.kind, p.a_id, p.a_name, p.a_score, p.b_id, p.b_name, p.b_score, reasons.join(' + '), prop.key, prop.keep, prop.merge, ''].map(csvCell).join(','));
  const k = `${p.kind} | ${reasons.join(' + ')} | ${prop.key}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
const reviewFile = resolve(REVIEW_DIR, `${date}-duplicates.csv`);
writeFileSync(reviewFile, lines.join('\r\n') + '\r\n');

// Counts only, for the report.
console.log('kind | shared | proposal | pairs');
for (const [k, n] of [...counts.entries()].sort()) console.log(`${k} | ${n}`);
console.error(`review file: ${reviewFile} (${pairs.length} pair(s); client data, not in the repository)`);
