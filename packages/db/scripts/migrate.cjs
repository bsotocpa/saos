#!/usr/bin/env node
// Migration runner wrapper. Why not the node-pg-migrate CLI directly?
// - .env lives at the repo root (shared with docker compose), not in this
//   package — the CLI only auto-loads .env from its cwd.
// - The programmatic API behaves identically on Windows and Linux.
//
// Usage: node scripts/migrate.cjs up | down

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const mod = require('node-pg-migrate');
const runner = mod.default ?? mod.runner ?? mod;

// Dev fallback mirrors docker-compose defaults so a fresh clone works
// before anyone writes a .env. Production always sets DATABASE_URL.
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://saos:saos_dev_password@localhost:5432/saos';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('Usage: node scripts/migrate.cjs up|down');
  process.exit(1);
}

runner({
  databaseUrl,
  dir: path.resolve(__dirname, '../migrations'),
  direction,
  migrationsTable: 'pgmigrations',
  count: direction === 'up' ? Infinity : 1, // down rolls back ONE migration at a time
  verbose: false,
})
  .then((migrations) => {
    if (migrations.length === 0) {
      console.log(`No migrations to run (${direction}).`);
    } else {
      for (const m of migrations) console.log(`${direction === 'up' ? '↑' : '↓'} ${m.name}`);
      console.log(`✓ ${migrations.length} migration(s) ${direction === 'up' ? 'applied' : 'rolled back'}.`);
    }
  })
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
