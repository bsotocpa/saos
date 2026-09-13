/*
 * SAME-NAME BUSINESSES ON ONE CONTACT (2026-09-14, Brian's ruling 5). Reproducible.
 *
 *   node scripts/business-dedupe.ts            lists every contact holding two businesses whose
 *                                              names differ only by case or spacing, and the
 *                                              winner the merge route would keep.
 *   APPLY=1 node scripts/business-dedupe.ts    merges them through mergeBusinesses (the route's
 *                                              function) as the CEO, labelled applied by script.
 *                                              Protected names are listed first and merged only
 *                                              when APPROVED names the losing rows.
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { sameNameBusinessesWithinContact, applyBusinessDedupe } from '../src/modules/crm/businesses.ts';

const apply = process.env.APPLY === '1';
const today = new Date().toISOString().slice(0, 10);
const app = buildServer(loadConfig(), {});
await app.ready();
const short = (id: string): string => id.slice(0, 8);

const groups = await sameNameBusinessesWithinContact(app);
console.log(`business dedupe: ${groups.length} group(s)`);
for (const g of groups) {
  console.log(`\n${g.protectedName ? 'PROTECTED  ' : ''}${g.contactName}  ·  ${g.name}`);
  for (const b of g.businesses) console.log(`  ${short(b.id)}  "${b.name}"  ein:${b.hasEin ? 'y' : 'n'} type:${b.entityType ?? '-'} eng:${b.engagements} added ${b.createdAt.slice(0, 10)}${b.id === g.winnerId ? '  <- winner' : ''}`);
}

if (apply) {
  const ceo = await app.db.query<{ id: string; email: string; display_name: string }>(
    `SELECT st.id, st.email, st.display_name FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1`);
  if (!ceo.rows[0]) throw new Error('refusing: no active CEO');
  const actor = { id: ceo.rows[0].id, email: ceo.rows[0].email, fullName: `${ceo.rows[0].display_name} (ruled ${today}, applied by script)` };
  const approvedLoserIds = new Set((process.env.APPROVED ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const results = await applyBusinessDedupe(app, groups, actor, {
    reason: 'The same business entered twice by the import, differing only in capitalisation; one entity',
    approvedLoserIds,
  });
  console.log('\nAPPLIED');
  for (const r of results) console.log(`  ${r.merged ? 'merged ' : r.held ? 'held   ' : 'refused'}  ${r.contactName}  ·  ${r.name}${r.held ? `  ${r.held}` : ''}${r.error ? `  ${r.error}` : ''}`);
}

await app.close();
process.exit(0);
