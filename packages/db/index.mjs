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

/** Run all seeds (idempotent) using an already-connected pg client. */
export async function seedAll(client) {
  const results = [];
  for (const fn of [seedRoles, seedSettings, seedTemplates, seedPriceBook]) {
    results.push(await fn(client));
  }
  return results;
}
