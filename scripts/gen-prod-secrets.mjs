// Fill every EMPTY secret in .env.production with a strong random value —
// idempotent (existing values untouched), silent about the values themselves.
// DATABASE_URL is kept in sync with the generated Postgres password.

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.production');
let env = await readFile(envPath, 'utf8');

const hex = (n) => randomBytes(n).toString('hex');
const b64url = (n) => randomBytes(n).toString('base64url');

const wanted = {
  POSTGRES_PASSWORD: () => b64url(24),
  MINIO_ROOT_PASSWORD: () => b64url(24),
  APP_ENCRYPTION_KEY: () => hex(32), // 64 hex chars, per loadConfig
  WEBHOOK_SECRET: () => hex(24),
  CALCOM_NEXTAUTH_SECRET: () => b64url(32),
  CALCOM_ENCRYPTION_KEY: () => b64url(24),
  VAULTWARDEN_ADMIN_TOKEN: () => b64url(36),
  RESTIC_PASSWORD: () => b64url(32),
};

const filled = [];
for (const [key, gen] of Object.entries(wanted)) {
  const re = new RegExp(`^${key}=\\s*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, `${key}=${gen()}`);
    filled.push(key);
  }
}

// DATABASE_URL follows POSTGRES_PASSWORD.
const pgPass = env.match(/^POSTGRES_PASSWORD=(\S+)$/m)?.[1];
if (pgPass && /^DATABASE_URL=postgres:\/\/saos:(CHANGE_ME|\S*)@/m.test(env)) {
  env = env.replace(/^DATABASE_URL=postgres:\/\/saos:[^@]*@/m, `DATABASE_URL=postgres://saos:${pgPass}@`);
  filled.push('DATABASE_URL(password sync)');
}

await writeFile(envPath, env, 'utf8');
console.log(filled.length > 0 ? `gen-prod-secrets: filled ${filled.join(', ')}` : 'gen-prod-secrets: nothing empty — no changes.');
const stillEmpty = [...env.matchAll(/^([A-Z0-9_]+)=\s*$/gm)].map((m) => m[1]);
if (stillEmpty.length > 0) console.log(`gen-prod-secrets: still awaiting values: ${stillEmpty.join(', ')}`);
