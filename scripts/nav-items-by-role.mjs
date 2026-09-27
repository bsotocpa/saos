#!/usr/bin/env node
/*
 * THE NAVIGATION, PER ROLE (R64 for the R42 Design Phase 1 record, 2026-09-26).
 *
 * One row per seeded role: the role key, how many top-navigation items its session sees, and their
 * names — computed from the seeded grants (packages/db/seeds/data/roles.mjs) joined with the shell's
 * own table (apps/internal/lib/nav.ts, the same visibleNav the shell renders). Nothing is typed by
 * hand; the row for a role is what the shell would show that role.
 *
 *   node scripts/nav-items-by-role.mjs > <log>
 *   node scripts/report-table.mjs --name nav-items-by-role --from-log <log> --sql "node scripts/nav-items-by-role.mjs"
 *
 * The first printed line is the header row report-table.mjs expects, then one row per role:
 * role | items shown | item names
 *
 * `rows()` is exported so a spec can assert against the same computation.
 */
import { fileURLToPath } from 'node:url';
import { roles } from '../packages/db/seeds/data/roles.mjs';
import { visibleNav } from '../apps/internal/lib/nav.ts';

export function rows() {
  return roles.map((role) => {
    const items = visibleNav(role.permissions);
    return { role: role.key, count: items.length, names: items.map((i) => i.label) };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log('role | items shown | item names');
  for (const r of rows()) console.log(`${r.role} | ${r.count} | ${r.names.join(', ')}`);
}
