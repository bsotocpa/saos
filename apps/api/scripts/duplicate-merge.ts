/*
 * THE DUPLICATE MERGES BRIAN MARKED (Brian, 2026-09-29, R92).
 *
 * Reads the review file (C:\Users\brian\saos-review\<date>-duplicates.csv, copied to the box for the run;
 * client data, never committed) and, for every CONTACT pair whose decision is "merge", applies the pair
 * door POST /contacts/merge-pair in a labelled script session: the survivor is chosen by the door (the
 * portal user, else the most engagements, else the older record), the retired record is kept with a
 * redirect and leaves search. A pair Brian marked "keep", or left blank, is untouched. A pair naming a
 * protected person (Jackson F., Josean I., Joseph B.) is never merged by a script, whatever the file
 * says: the standing rule is that nothing touches those records; Brian merges them himself if ever.
 * A name-only pair Brian marked merge carries his decision as the identity reason the merge requires.
 *
 * ONLY "merge proposed" (Brian, 2026-09-29, R92 decisions): "Merge only the 2 pairs marked yes under
 * 'merge proposed' ... Nothing else in the file merges." The file carries a yes on the name-only and
 * protected rows too; those are R97's (the banner and Compare, or the empty-record archive), never this
 * script's. A row whose decision reads "other: ..." is Brian's instruction for a person to carry out,
 * counted here and never merged.
 *
 * Prints counts only. The decision column is "decision (merge / keep)"; the first file's header,
 * "Brian rules (yes / no / other)", is read the same way (yes = merge, no = keep).
 *
 *   docker compose ... run --rm --no-deps -v /opt/saos/imports:/imports api \
 *     node --experimental-strip-types scripts/duplicate-merge.ts /imports/2026-09-28-duplicates.csv
 */
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { createSession } from '../src/modules/auth/service.ts';
import { parseCsvObjects } from '../src/migration/csv.ts';
import { PROTECTED_NAMES, norm } from '../src/modules/crm/duplicates.ts';

const file = process.argv[2];
if (!file) throw new Error('usage: duplicate-merge.ts <review file>');
const rows = parseCsvObjects(readFileSync(file, 'utf8'));
const decisionOf = (r: Record<string, string>): 'merge' | 'keep' | 'blank' => {
  const raw = norm(r['decision (merge / keep)'] ?? r['Brian rules (yes / no / other)'] ?? '');
  if (raw === 'merge' || raw === 'yes') return 'merge';
  if (raw === 'keep' || raw === 'no') return 'keep';
  return 'blank';
};

const config = loadConfig(process.env);
const app = buildServer(config);
await app.ready();
const counts = { pairs: rows.length, contact_pairs: 0, not_merge_proposed: 0, marked_merge: 0, marked_keep: 0, marked_other: 0, blank: 0, protected_skipped: 0, merged: 0, refused: 0, business_pairs_skipped: 0 };
const refusals: Record<string, number> = {};
try {
  const ceo = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id WHERE r.key = 'ceo' AND s.is_active ORDER BY s.created_at LIMIT 1`
  );
  if (!ceo.rows[0]) throw new Error('no active CEO');
  const token = await createSession(app.db, config, ceo.rows[0].id, { appliedBy: 'R92 duplicate merges Brian marked in the 2026-09-28 review file', ip: null, userAgent: null });
  const headers = { authorization: `Bearer ${token}` };
  try {
    for (const r of rows) {
      if (r['kind'] !== 'contact') { counts.business_pairs_skipped++; continue; }
      counts.contact_pairs++;
      if ((r['proposal'] ?? '').trim() !== 'merge proposed') { counts.not_merge_proposed++; continue; }
      if (norm(r['decision (merge / keep)'] ?? r['Brian rules (yes / no / other)'] ?? '').startsWith('other')) { counts.marked_other++; continue; }
      const d = decisionOf(r);
      if (d === 'keep') { counts.marked_keep++; continue; }
      if (d === 'blank') { counts.blank++; continue; }
      counts.marked_merge++;
      if (PROTECTED_NAMES.has(norm(r['record A'] ?? '')) || PROTECTED_NAMES.has(norm(r['record B'] ?? ''))) { counts.protected_skipped++; continue; }
      const nameOnly = !/email|phone/.test(r['shared'] ?? '');
      const res = await app.inject({
        method: 'POST', url: '/contacts/merge-pair', headers,
        payload: {
          aId: r['record A id'], bId: r['record B id'],
          reason: 'Duplicate review 2026-09-28: Brian marked this pair merge.',
          ...(nameOnly ? { identityOverrideReason: 'Brian marked this name-only pair merge in the 2026-09-28 duplicate review.' } : {}),
        },
      });
      if (res.statusCode === 200) counts.merged++;
      else { counts.refused++; const code = String(res.json().error ?? res.statusCode); refusals[code] = (refusals[code] ?? 0) + 1; }
    }
  } finally {
    await app.inject({ method: 'POST', url: '/auth/logout', headers });
  }
  console.log('count | value');
  for (const [k, v] of Object.entries(counts)) console.log(`${k.replaceAll('_', ' ')} | ${v}`);
  for (const [k, v] of Object.entries(refusals)) console.log(`refused: ${k} | ${v}`);
} finally {
  await app.close();
}
