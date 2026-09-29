/*
 * The 2026-09-29 batch 10, step 2: the deploy order (build, preflight with migrations and seeds on
 * the copy, migrate, seed, swap; no seed after the swap). The seed moved back after the swap in
 * deploy.sh, as it stood until 2026-09-28: the dry run (`bash scripts/deploy.sh --preflight-only`,
 * npm run deploy:dry-run) refuses before anything runs.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-b-deploy-order.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const SEED = `"\${SSH[@]}" 'cd /opt/saos && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps api node packages/db/seeds/run.mjs'`;
const SWAP = `"\${SSH[@]}" 'cd /opt/saos && docker compose --profile intel --profile booking --profile scan -f docker-compose.yml -f docker-compose.prod.yml up -d --quiet-pull'`;

export const items = [
  {
    item: 'deploy order: no seed after the swap: the seed placed after the swap in deploy.sh',
    file: 'scripts/deploy.sh',
    change: 'the production seed line moved below the container swap, the order that let the 2026-09-28 seed fail with the new code serving: the dry run refuses',
    test: { kind: 'guard', spec: 'deploy:dry-run' },
    apply: (t) => {
      const nl = t.includes('\r\n') ? '\r\n' : '\n';
      must(t, SEED); must(t, SWAP);
      return t.replace(SEED + nl, '').replace(SWAP, SWAP + nl + SEED);
    },
    expectRed: /after the swap/,
  },
];
