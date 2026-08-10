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

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'merge-env.sh');

const dir = mkdtempSync(join(tmpdir(), 'saos-envmerge-'));
let failures = 0;
const check = (label, actual, expected) => {
  if (actual !== expected) {
    console.error(`  ✖ ${label}\n      expected: ${expected}\n      actual:   ${actual}`);
    failures++;
  }
};

function run(incoming, existing) {
  const inPath = join(dir, 'incoming.env');
  const target = join(dir, 'target.env');
  writeFileSync(inPath, incoming);
  writeFileSync(target, existing);
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncheck:env-merge FAILED (${failures}) — the deploy could destroy a server-set secret.`);
  process.exit(1);
}
console.log('check:env-merge: server-set secrets survive a deploy (6 cases)');
