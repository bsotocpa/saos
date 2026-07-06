#!/usr/bin/env node
// Seed runner — idempotent, transactional. Safe to re-run any time:
//   roles            → upsert (spec-defined)
//   settings         → insert-if-missing (admin edits are never clobbered)
//   templates        → insert-if-missing (admin edits are never clobbered)
//   price book v1    → upsert (v1 is defined as the spec seed; admin edits create v2+)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

import { seedRoles } from './data/roles.mjs';
import { seedSettings } from './data/settings.mjs';
import { seedTemplates } from './data/templates.mjs';
import { seedPriceBook } from './data/price_book.mjs';
import { seedForms } from './data/forms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://saos:saos_dev_password@localhost:5432/saos';

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query('BEGIN');
  for (const [name, fn] of [
    ['roles', seedRoles],
    ['settings', seedSettings],
    ['templates', seedTemplates],
    ['price_book', seedPriceBook],
    ['forms', seedForms],
  ]) {
    const result = await fn(client);
    console.log(`✓ ${name}: ${result}`);
  }
  await client.query('COMMIT');
  console.log('✓ Seeds applied.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✖ Seed failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
