#!/usr/bin/env node
/*
 * WHICH SCHEDULE EACH PRICE-BOOK LINE TRIGGERS (Brian, 2026-09-26, R46, report part). Reads the
 * seeded price book (packages/db/seeds/data/price_book.mjs), the seeded service_schedules mapping
 * (legal_v3.mjs SCHEDULES plus the Schedule F insert in schedule_f.mjs), the per-price-line
 * mapping in schedule_price_lines.mjs, and the quote-to-engagement line map the API uses
 * (apps/api/src/modules/pricing/engagement-lines.ts), and prints one row per item:
 *
 *   code | price service line | pricing mode | active | engagement line | schedules today | schedules under the ruled rule
 *
 * "Today" is resolveSchedules in apps/api/src/modules/engagements/packet.ts as built for R46
 * (2026-09-26): the schedules come from each live engagement's accepted quote lines through
 * schedule_for_price_line, so a quoted line's schedule is a property of the line, and withdrawn
 * engagements contribute nothing. Before the build, "today" read every tax_engagement on the contact
 * in any status for the A/B split. "Ruled" is R46 as ruled: the two columns now agree.
 *
 *   node --experimental-strip-types scripts/price-book-schedules.mjs > out.log
 *   node scripts/report-table.mjs --name price-book-schedules --from-log out.log --sql "..."
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { items } from '../packages/db/seeds/data/price_book.mjs';
import { SCHEDULES } from '../packages/db/seeds/data/legal_v3.mjs';
import { engagementLineFor } from '../apps/api/src/modules/pricing/engagement-lines.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');

// service_schedules as the seeds fill it: A..E from legal_v3, F from the literal in schedule_f.mjs.
const scheduleLines = Object.fromEntries(SCHEDULES.map((s) => [s.code, s.serviceLines]));
const fLiteral = /VALUES \('F', \$1, '[^']*', ARRAY\[([^\]]+)\]::service_line\[\]/.exec(read('packages/db/seeds/data/schedule_f.mjs'));
if (!fLiteral) throw new Error('schedule_f.mjs: the service_schedules insert for F was not found');
scheduleLines.F = [...fLiteral[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

// schedule_price_lines as seeded: [price service line, schedule code, note].
const priceLineSchedule = Object.fromEntries(
  [...read('packages/db/seeds/data/schedule_price_lines.mjs').matchAll(/^\s*\[?\s*'([a-z_0-9]+)',\s*\n?\s*'([A-F])',/gm)].map((m) => [m[1], m[2]]),
);
if (!priceLineSchedule.individual_tax) throw new Error('schedule_price_lines.mjs: the MAPPINGS rows were not found');

const ruledFor = (priceLine) => priceLineSchedule[priceLine] ?? 'none (schedule_price_lines maps nothing; not a service)';
/*
 * "Today" is the ruled rule since the R46 build (2026-09-26): resolveSchedules reads each live
 * engagement's accepted quote lines (engagement_scope_items) through schedule_for_price_line, so a
 * quoted line's schedule IS a property of the line; withdrawn engagements contribute nothing. Only an
 * engagement opened by hand (no quote) falls back to service_schedules by service line (kept in
 * scheduleLines above for that case), and for tax to its own return's type. The column below is the
 * quoted case, the one every price-book item produces.
 */
const todayFor = (engLine, priceLine) => {
  if (engLine === null) return 'none (no engagement is created for this line)';
  const ruled = ruledFor(priceLine);
  if (ruled.startsWith('none')) {
    const codes = Object.entries(scheduleLines).filter(([, lines]) => lines.includes(engLine)).map(([c]) => c);
    return codes.length ? `${codes.join('+')} (by service line: the price line maps to no schedule)` : ruled;
  }
  return ruled;
};

const rows = [['code', 'price service line', 'pricing mode', 'active', 'engagement line (engagement-lines.ts)', 'schedules today (packet.ts resolveSchedules)', 'schedules under the ruled rule (accepted quote lines → schedule_price_lines)']];
for (const it of items) {
  const engLine = engagementLineFor(it.serviceLine, it.code);
  rows.push([it.code, it.serviceLine, it.pricingMode, it.isActive ? 'yes' : 'no', engLine ?? 'none', todayFor(engLine, it.serviceLine), ruledFor(it.serviceLine)]);
}
process.stdout.write(rows.map((r) => r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
