#!/usr/bin/env node
// BUILD GUARD: the deploy's .env merge must never destroy a server-set secret.
//
// This guards a mechanism whose failure is invisible until something 401s. On
// 2026-08-10 the deploy overwrote /opt/saos/.env with the local .env.production,
// silently wiping the Docuseal API token Brian had just installed — twice, because
// the second time we did not yet know the deploy was the cause. The merge script
// exists to make that impossible; this proves the merge script still works.
//
// Runs as part of root `npm test`, alongside check:prices and check:sops.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'merge-env.sh');

const dir = mkdtempSync(join(tmpdir(), 'saos-envmerge-'));
let failures = 0;
let cases = 0;
const check = (label, actual, expected) => {
  cases++;
  if (actual !== expected) {
    console.error(`  ✖ ${label}\n      expected: ${expected}\n      actual:   ${actual}`);
    failures++;
  }
};

function run(incoming, existing, managed = null) {
  const inPath = join(dir, 'incoming.env');
  const target = join(dir, 'target.env');
  writeFileSync(inPath, incoming);
  writeFileSync(target, existing);
  // The server-managed list lives beside the target, as it does on the box.
  const managedPath = target + '.server-managed';
  if (managed === null) rmSync(managedPath, { force: true });
  else writeFileSync(managedPath, managed);
  execFileSync('sh', [script, inPath, target], { stdio: ['ignore', 'ignore', 'ignore'] });
  const out = readFileSync(target, 'utf8');
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return { out, map };
}

try {
  // THE BUG THIS EXISTS FOR: blank locally, real value on the server.
  {
    const { map } = run('DOCUSEAL_API_TOKEN=\n', 'DOCUSEAL_API_TOKEN=server_token_xyz\n');
    check('a blank local value must NOT overwrite a server secret', map.get('DOCUSEAL_API_TOKEN'), 'server_token_xyz');
  }

  // Rotation from .env.production must still work.
  {
    const { map } = run('DOCUSEAL_API_TOKEN=rotated_new\n', 'DOCUSEAL_API_TOKEN=server_old\n');
    check('a non-blank local value still wins (rotation)', map.get('DOCUSEAL_API_TOKEN'), 'rotated_new');
  }

  // Server-only keys survive.
  {
    const { map } = run('A=1\n', 'A=1\nSERVER_ONLY=keepme\n');
    check('a key only on the server is preserved', map.get('SERVER_ONLY'), 'keepme');
  }

  /*
   * SERVER-MANAGED KEYS (2026-09-09). The hole in "non-blank local wins": a STALE local
   * value looks exactly like a rotation. Brian installed the live Stripe key on the
   * server; the laptop's .env.production still held the August test key; the next three
   * deploys each "rotated" it back. A key named in <target>.server-managed belongs to
   * the server — the shipped value is ignored whenever the server has one.
   */
  {
    const { map } = run(
      'STRIPE_SECRET_KEY=sk_test_stale_from_laptop\n',
      'STRIPE_SECRET_KEY=sk_live_installed_on_server\n',
      'STRIPE_SECRET_KEY\n'
    );
    check('a server-managed key keeps the SERVER value even over a non-blank local one', map.get('STRIPE_SECRET_KEY'), 'sk_live_installed_on_server');
  }
  {
    const { map } = run('STRIPE_SECRET_KEY=sk_test_first_install\n', 'STRIPE_SECRET_KEY=\n', 'STRIPE_SECRET_KEY\n');
    check('a server-managed key with NO server value still takes the shipped one (nothing to protect)', map.get('STRIPE_SECRET_KEY'), 'sk_test_first_install');
  }
  {
    const { map } = run(
      'STRIPE_SECRET_KEY=sk_test_stale\nDOCUSEAL_API_TOKEN=rotated\n',
      'STRIPE_SECRET_KEY=sk_live_real\nDOCUSEAL_API_TOKEN=old\n',
      '# keys the server owns\n\nSTRIPE_SECRET_KEY\n'
    );
    check('the list tolerates comments and blank lines', map.get('STRIPE_SECRET_KEY'), 'sk_live_real');
    check('and an UNLISTED non-blank local value still rotates', map.get('DOCUSEAL_API_TOKEN'), 'rotated');
  }

  // Blank on both stays blank (not "undefined", not dropped).
  {
    const { map } = run('STRIPE_WEBHOOK_SECRET=\n', 'STRIPE_WEBHOOK_SECRET=\n');
    check('blank on both sides stays blank', map.get('STRIPE_WEBHOOK_SECRET'), '');
  }

  // Values containing '=' and '#' must survive intact.
  {
    const weird = 'whsec_ab=cd#ef/gh+ij';
    const { map } = run('STRIPE_WEBHOOK_SECRET=\n', `STRIPE_WEBHOOK_SECRET=${weird}\n`);
    check("a value containing '=' and '#' survives", map.get('STRIPE_WEBHOOK_SECRET'), weird);
  }

  // Comments and ordering are preserved (a mangled .env is its own outage).
  {
    const { out } = run('# lead comment\nA=1\nB=\n', 'A=9\nB=server\n');
    if (!out.startsWith('# lead comment')) {
      console.error('  ✖ comments must be preserved in order');
      failures++;
    }
  }

  /*
   * RUNTIME-MODE KEYS MUST BE BLANK IN .env.production.
   *
   * The merge rule "non-blank local wins" is right for SECRETS — shipping a rotated
   * token should replace the old one. It is exactly wrong for a mode switch, because
   * nobody ever intends "every deploy turns payments back off", and that is precisely
   * what a literal here does. STRIPE_MODE=stub silently disabled live payments three
   * times (2026-08-12, twice on 2026-08-13); each time the only symptom was a client's
   * Pay Now returning 503 hours after it had worked.
   *
   * These keys are set on the SERVER and must survive a deploy, so the shipped file
   * has to leave them blank. .env.production is gitignored, so this is skipped where
   * the file does not exist (CI, a fresh clone) rather than failing.
   */
  {
    const envProd = resolve(here, '..', '.env.production');
    if (existsSync(envProd)) {
      // 2026-09-09: the SECRETS join the mode. They are installed on the server by
      // scripts/install-stripe-*.sh and registered as server-managed there; a value here
      // is a stale copy that would have overwritten the live key on every deploy — and did.
      const MODE_KEYS = ['STRIPE_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
      const text = readFileSync(envProd, 'utf8');
      for (const key of MODE_KEYS) {
        const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
        if (m && m[1].trim() !== '') {
          console.error(
            `  ✖ ${key} is set to ${key === 'STRIPE_MODE' ? `"${m[1].trim()}"` : 'a value'} in .env.production — it must be BLANK.\n` +
            `      A literal beats the server's value on every deploy. Set ${key} on the server.`
          );
          failures++;
        }
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncheck:env-merge FAILED (${failures}) — the deploy could destroy a server-set secret.`);
  process.exit(1);
}
console.log('check:env-merge: server-set secrets and runtime modes survive a deploy (${cases} cases)');
