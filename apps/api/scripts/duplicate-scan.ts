/*
 * THE DUPLICATE CONTACT SCAN (2026-09-12 night, Brian's ruling 1). Reproducible.
 *
 *   node scripts/duplicate-scan.ts            prints the plan: every same-name group, what each
 *                                             record holds, what the merge route would do.
 *   APPLY=1 node scripts/duplicate-scan.ts    does it: merges through mergeContacts (the route's
 *                                             function), notes on the rest. Protected names are
 *                                             listed first and merged only when APPROVED names the
 *                                             losing record (comma-separated ids, Brian's word).
 *
 * The actor is the active CEO, labelled as applied by script, so every audit row says so.
 * Prints names and counts; no secret, no PII beyond the names the book already holds.
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { sameNameGroups, applyDuplicatePlan } from '../src/modules/crm/duplicates.ts';

const apply = process.env.APPLY === '1';
const today = new Date().toISOString().slice(0, 10);
const app = buildServer(loadConfig(), {});
await app.ready();

const groups = await sameNameGroups(app);
const short = (id: string): string => id.slice(0, 8);
console.log(`duplicate scan: ${groups.length} same-name group(s), ${groups.reduce((n, g) => n + g.records.length, 0)} record(s)`);
for (const g of groups) {
  console.log(`\n${g.protectedName ? 'PROTECTED  ' : ''}${g.name}`);
  for (const r of g.records) {
    const h = r.holds;
    console.log(`  ${short(r.id)}  ${r.source.padEnd(7)} ${r.isTest ? 'TEST ' : '     '} added ${r.createdAt.slice(0, 10)}  phone:${r.hasPhone ? 'y' : 'n'} addr:${r.hasAddress ? 'y' : 'n'} portal:${r.portal ? 'y' : 'n'}  biz:${h.businesses} tasks:${h.tasks} eng:${h.engagements}(${h.openEngagements} open) inv:${h.invoices} docs:${h.documents} quotes:${h.quotes} packets:${h.packets}  score:${r.score}`);
  }
  for (const m of g.merges) {
    const shared = [...new Set(Object.values(m.shared).flat())].join(',');
    console.log(`  MERGE ${m.loserIds.map(short).join(', ')} -> ${short(m.winnerId)}  (shared: ${shared})${g.protectedName ? '  HELD: protected name' : ''}`);
  }
  for (const id of g.noteIds) console.log(`  NOTE  ${short(id)}  possible duplicate, no shared identifier`);
}

if (apply) {
  const ceo = await app.db.query<{ id: string; email: string; display_name: string }>(
    `SELECT st.id, st.email, st.display_name FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1`);
  if (!ceo.rows[0]) throw new Error('refusing: no active CEO');
  const actor = { id: ceo.rows[0].id, email: ceo.rows[0].email, fullName: `${ceo.rows[0].display_name} (ruled ${today}, applied by script)` };
  const approvedLoserIds = new Set((process.env.APPROVED ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const results = await applyDuplicatePlan(app, groups, actor, {
    dateIso: today,
    reason: 'The same person imported twice from the old systems; the records share a phone or address and nothing on either side is open',
    approvedLoserIds,
  });
  console.log('\nAPPLIED');
  for (const r of results) {
    for (const m of r.merged) console.log(`  merged   ${r.name}: ${m.loserIds.map(short).join(', ')} -> ${short(m.winnerId)}`);
    for (const m of r.held) console.log(`  held     ${r.name}: ${m.loserIds.map(short).join(', ')} -> ${short(m.winnerId)}  ${m.why}`);
    for (const m of r.refused) console.log(`  refused  ${r.name}: ${m.loserIds.map(short).join(', ')} -> ${short(m.winnerId)}  ${m.error}`);
    if (r.noted.length) console.log(`  noted    ${r.name}: ${r.noted.map(short).join(', ')}`);
  }
}

await app.close();
process.exit(0);
