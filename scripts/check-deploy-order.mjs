#!/usr/bin/env node
/*
 * THE DEPLOY ORDER (Brian, 2026-09-29, standing rule): build -> preflight (migrations AND seeds on a
 * copy of production) -> migrate -> seed -> swap. No seed runs after the swap.
 *
 * Why: on 2026-09-28 the R81 display-name seed ran after the swap, failed on a grandfathered
 * production row, and rolled back with the new code already serving (the site stayed up on the old
 * names, but only by luck). A seed is an update: it meets production rows on the copy first, then on
 * production before the new code takes traffic, so a red seed leaves the box on the previous version.
 *
 * This reads scripts/deploy.sh and scripts/preflight-migrate.sh and prints one RED line per breach:
 *   - the preflight runs the migrations and then the seeds on the copy;
 *   - deploy.sh runs, in this order: the preflight, the production migrate, the production seed, the swap;
 *   - exactly one production seed, and nothing seeds after the swap.
 * deploy.sh runs it before anything else (so `bash scripts/deploy.sh --preflight-only` is the dry run
 * that refuses), and the root `npm test` chain runs it as check:deploy-order.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const code = (file) => readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)
  .map((text, i) => ({ n: i + 1, text }))
  .filter((l) => l.text.trim() && !l.text.trim().startsWith('#') && !/^\s*echo\s/.test(l.text));

const red = [];
const deploy = code('scripts/deploy.sh');
const at = (re) => deploy.filter((l) => re.test(l.text)).map((l) => l.n);
const preflight = at(/preflight-migrate\.sh/);
const migrate = at(/migrate\.cjs up/);
const seed = at(/seeds\/run\.mjs/);
const swap = at(/\bup -d\b/).filter((n) => !deploy.find((l) => l.n === n).text.includes('force-recreate caddy'));

if (preflight.length !== 1) red.push(`deploy.sh runs the preflight ${preflight.length} time(s); it runs once`);
if (migrate.length !== 1) red.push(`deploy.sh runs the production migrate ${migrate.length} time(s); it runs once`);
if (seed.length !== 1) red.push(`deploy.sh runs the production seed ${seed.length} time(s); it runs once`);
if (swap.length !== 1) red.push(`deploy.sh swaps the containers ${swap.length} time(s); it swaps once`);
const order = [['preflight', preflight[0]], ['migrate', migrate[0]], ['seed', seed[0]], ['swap', swap[0]]];
for (let i = 1; i < order.length; i++) {
  const [a, na] = order[i - 1];
  const [b, nb] = order[i];
  if (na !== undefined && nb !== undefined && na > nb) red.push(`deploy.sh runs the ${b} (line ${nb}) before the ${a} (line ${na}); the order is preflight, migrate, seed, swap`);
}
for (const n of seed) if (swap[0] !== undefined && n > swap[0]) red.push(`deploy.sh seeds at line ${n}, after the swap at line ${swap[0]}: no seed runs after the swap`);

const pre = code('scripts/preflight-migrate.sh');
const preMigrate = pre.filter((l) => /migrate\.cjs up/.test(l.text)).map((l) => l.n);
const preSeed = pre.filter((l) => /seeds\/run\.mjs/.test(l.text)).map((l) => l.n);
if (preMigrate.length !== 1) red.push('the preflight runs the migrations on the copy once');
if (preSeed.length !== 1) red.push('the preflight runs the seeds on the copy once');
if (preMigrate[0] !== undefined && preSeed[0] !== undefined && preSeed[0] < preMigrate[0]) red.push('the preflight seeds the copy before migrating it');

if (red.length > 0) {
  for (const r of red) console.log(`RED ${r}`);
  console.log('check:deploy-order: REFUSED. The deploy order is build, preflight (migrations and seeds on the copy), migrate, seed, swap.');
  process.exit(1);
}
console.log('check:deploy-order: build, preflight (migrations and seeds on the copy), migrate, seed, swap; no seed after the swap.');
