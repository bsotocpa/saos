// Passing artifacts stay local for 14 days (decision 3, 2026-09-10). Failures live in tasks/walks/ and are committed.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '.artifacts');
const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
let entries = [];
try { entries = readdirSync(artifacts); } catch { process.exit(0); }
for (const name of entries) {
  const full = resolve(artifacts, name);
  if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
}
