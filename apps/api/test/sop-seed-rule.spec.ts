// DECISION 5 (2026-09-09, Brian's ruling): an unreviewed SOP row is the seed's to overwrite;
// a reviewed one (published_by_staff_id set) is refused, with the difference reported.
// "Reviewed" is the column, not a feeling. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
// The seed itself, run against the test database.
// @ts-expect-error — the seed is plain JavaScript with no declaration file; its shape is asserted below.
import { seedSops, sops, diffSummary } from '../../../packages/db/seeds/data/sops.mjs';

let app: FastifyInstance;
let config: Config;
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

before(async () => {
  config = await createTestConfig('sopseed');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

const first = () => (sops as Array<{ slug: string; title: string; bodyMd: string }>)[0]!;

test('an unreviewed row whose seed text moved is overwritten, and its version bumps', async () => {
  const slug = first().slug;
  await app.db.query(`UPDATE sops SET body_md = 'stale skeleton text', version = 1, published_by_staff_id = NULL WHERE slug = $1`, [slug]);
  const summary = await seedSops(app.db);
  assert.match(summary, /1 unreviewed row\(s\) overwritten/, summary);
  const row = (await app.db.query<{ body_md: string; version: number }>(`SELECT body_md, version FROM sops WHERE slug = $1`, [slug])).rows[0]!;
  assert.equal(row.body_md, first().bodyMd, 'the seed text is back');
  assert.equal(row.version, 2, 'the version bumped');
});

test('a REVIEWED row is refused, and the summary names it with the size of the difference', async () => {
  const slug = first().slug;
  const brian = await makeStaff(app.db, config, { email: 'ceo-sopseed@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' });
  const reviewed = 'Reviewed by a person.\nThis line is theirs.\n' + first().bodyMd;
  await app.db.query(`UPDATE sops SET body_md = $2, published_by_staff_id = $3, version = 7 WHERE slug = $1`, [slug, reviewed, brian.id]);
  const summary = await seedSops(app.db);
  assert.match(summary, new RegExp(`REFUSED 1 reviewed row\\(s\\): ${slug} \\(reviewed; seed differs: \\+0/-2 lines\\)`), summary);
  const row = (await app.db.query<{ body_md: string; version: number }>(`SELECT body_md, version FROM sops WHERE slug = $1`, [slug])).rows[0]!;
  assert.equal(row.body_md, reviewed, 'the reviewed text is untouched');
  assert.equal(row.version, 7, 'the version is untouched');
  // Cleanup so other seeds in this database see the row as the seed left it.
  await app.db.query(`UPDATE sops SET published_by_staff_id = NULL WHERE slug = $1`, [slug]);
});

test('the seed is idempotent when nothing differs', async () => {
  await seedSops(app.db); // settle whatever the earlier tests left
  const summary = await seedSops(app.db);
  assert.match(summary, /0 inserted; 0 unreviewed row\(s\) overwritten/, summary);
  assert.doesNotMatch(summary, /REFUSED/);
  assert.deepEqual(diffSummary('a\nb', 'a\nb'), { added: 0, removed: 0 });
  assert.deepEqual(diffSummary('a\nb', 'a\nc\nd'), { added: 2, removed: 1 });
});
