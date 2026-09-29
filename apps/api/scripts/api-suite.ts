/*
 * THE API SUITE (Brian, 2026-09-29): prepare the test databases (R95), run every spec, then print how
 * many connect-phase retries the Docker Desktop relay cost (the bounded retry in test/connect-retry.ts).
 * A suite with more than 20 retries is red even when every test passed: the relay is then worse than
 * the ruling tolerates, and it needs a look before the next receipt.
 *
 *   npm test   (apps/api)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { retryLogPath, MAX_CONNECT_RETRIES_PER_SUITE } from '../test/connect-retry.ts';
import { TEST_CHECKOUT_TAG } from '../test/helpers.ts';

const log = retryLogPath(TEST_CHECKOUT_TAG);
writeFileSync(log, '');
const node = process.execPath;
const prep = spawnSync(node, ['--experimental-strip-types', 'scripts/test-db-prepare.ts'], { stdio: 'inherit' });
if (prep.status !== 0) process.exit(prep.status ?? 1);
const run = spawnSync(node, ['--test', '--test-timeout=300000', '--test-force-exit', 'test/*.spec.ts'], { stdio: 'inherit', shell: false });
const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
const byKind: Record<string, number> = {};
for (const l of lines) { const k = l.split(' ').slice(1).join(' '); byKind[k] = (byKind[k] ?? 0) + 1; }
const detail = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ');
console.log(`test-db: ${lines.length} connect retr${lines.length === 1 ? 'y' : 'ies'} this suite${detail ? ` (${detail})` : ''}; the limit is ${MAX_CONNECT_RETRIES_PER_SUITE}.`);
if ((run.status ?? 1) !== 0) process.exit(run.status ?? 1);
if (lines.length > MAX_CONNECT_RETRIES_PER_SUITE) {
  console.error(`test-db: RED. ${lines.length} connect retries is over the limit of ${MAX_CONNECT_RETRIES_PER_SUITE}; the relay needs a look before the next receipt.`);
  process.exit(1);
}
