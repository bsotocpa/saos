// Programmatic entry points for @saos/db — used by service integration tests
// (and later by deploy tooling) to migrate/seed a database without shelling
// out to npm. The CLI scripts (scripts/migrate.cjs, seeds/run.mjs) stay the
// human-facing path; both delegate to the same migrations and seed modules.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { seedRoles } from './seeds/data/roles.mjs';
import { seedSettings } from './seeds/data/settings.mjs';
import { seedTemplates } from './seeds/data/templates.mjs';
import { seedPriceBook } from './seeds/data/price_book.mjs';
import { seedForms } from './seeds/data/forms.mjs';
import { seedAutomations } from './seeds/data/automations.mjs';
import { seedBundles } from './seeds/data/bundles.mjs';
import { seedSops } from './seeds/data/sops.mjs';
import { seedLegalV3 } from './seeds/data/legal_v3.mjs';
import { seedScheduleF } from './seeds/data/schedule_f.mjs';
import { seedTaxInterview } from './seeds/data/tax_interview.mjs';
import { seedSchedulePriceLines } from './seeds/data/schedule_price_lines.mjs';
import { seedLegalV3Es } from './seeds/data/legal_v3_es.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Apply migrations (direction 'up' | 'down') against the given database URL. */
export async function migrate(databaseUrl, direction = 'up') {
  const mod = require('node-pg-migrate');
  const runner = mod.default ?? mod.runner ?? mod;
  return runner({
    databaseUrl,
    dir: path.resolve(here, 'migrations'),
    direction,
    migrationsTable: 'pgmigrations',
    count: direction === 'up' ? Infinity : 1,
    verbose: false,
    log: () => {}, // quiet — callers report their own status
  });
}

/**
 * THE seed list — named, ordered, and the single source of truth.
 *
 * There used to be two: this one (used by tests via seedAll) and a second copy inside
 * seeds/run.mjs (used by `npm run seed` and every deploy). A seed added to one and not
 * the other silently did not exist on the other side, which is how the price-line →
 * schedule mapping passed a deploy and then failed every test that depended on it.
 * Divergence between "what production seeds" and "what tests seed" is not a bug you
 * find quickly — it looks like the feature is broken.
 *
 * Order matters: legal_v3 creates the service_schedules rows that
 * schedule_price_lines references.
 */
export const SEEDS = [
  ['roles', seedRoles],
  ['settings', seedSettings],
  ['templates', seedTemplates],
  ['price_book', seedPriceBook],
  ['forms', seedForms],
  ['automations', seedAutomations],
  ['bundles', seedBundles],
  ['sops', seedSops],
  ['legal_v3', seedLegalV3],
  ['schedule_f', seedScheduleF],
  ['tax_interview', seedTaxInterview],
  ['schedule_price_lines', seedSchedulePriceLines],
  ['legal_v3_es', seedLegalV3Es],
];

/** Run all seeds (idempotent) using an already-connected pg client. */
export async function seedAll(client) {
  const results = [];
  for (const [, fn] of SEEDS) {
    results.push(await fn(client));
  }
  return results;
}
