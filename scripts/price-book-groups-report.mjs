#!/usr/bin/env node
/*
 * THE CATALOG GROUPS, CODE BY CODE (Brian, 2026-09-20). Reads the seed's item list and the group
 * mapping the seed and migration 0116 use, and prints one ` | `-joined row per price-book code for
 * scripts/report-table.mjs --from-log: the code, its name, the group it sits in, its position, and —
 * for a code the ruled list did not name — the note saying which group is closest and why. A code
 * the seed has and the mapping lacks, or the other way round, goes to stderr and fails the script.
 * Rows:
 *   code | name | group | sort | note
 *
 *   node scripts/price-book-groups-report.mjs > price-book-groups.log
 *   node scripts/report-table.mjs --name price-book-groups --from-log price-book-groups.log --sql "node scripts/price-book-groups-report.mjs"
 */
import { GROUPS, ITEM_GROUPS } from '../packages/db/seeds/data/price_book_groups.mjs';
import { items } from '../packages/db/seeds/data/price_book.mjs';

const label = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));
const order = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));
const seeded = new Set(items.map((i) => i.code));
const mapped = new Set(Object.keys(ITEM_GROUPS));
const unmapped = [...seeded].filter((c) => !mapped.has(c));
const unseeded = [...mapped].filter((c) => !seeded.has(c));

const rows = [['code', 'name', 'group', 'sort', 'note']];
const placed = items
  .map((i) => ({ code: i.code, name: i.nameEn, ...(ITEM_GROUPS[i.code] ?? { group: '(none)', sort: 0, note: 'NOT MAPPED' }) }))
  .sort((a, b) => (order[a.group] ?? 99) - (order[b.group] ?? 99) || a.sort - b.sort || a.code.localeCompare(b.code));
for (const p of placed) rows.push([p.code, p.name, `${label[p.group] ?? p.group} (${p.group})`, String(p.sort), p.note ?? '']);

process.stdout.write(rows.map((r) => r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
const noted = placed.filter((p) => p.note).length;
process.stderr.write(`${placed.length} rows, ${noted} with a note; seeded but not mapped: ${unmapped.length === 0 ? 'none' : unmapped.join(', ')}; mapped but not seeded: ${unseeded.length === 0 ? 'none' : unseeded.join(', ')}\n`);
if (unmapped.length > 0 || unseeded.length > 0) process.exitCode = 1;
