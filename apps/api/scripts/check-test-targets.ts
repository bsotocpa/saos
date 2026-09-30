/*
 * NO TEST PROCESS REACHES A LIVE TARGET (Brian, 2026-09-29, receipt run 47; the root chain).
 *
 * The ntfy finding was a class: a test inherited PUSH_MODE=ntfy from the local .env. Three proofs:
 *
 *   1. hostile    the test configuration built over an environment with EVERY outward adapter set
 *                 live (SES relay, Stripe live, ntfy, Whisper, the summarizer API, Twilio, a remote
 *                 scanner, a remote object store) comes out with no live target;
 *   2. refused    what cannot be forced, a database that is not local, stops the test process;
 *      and over process.env itself, every other setting kept (receipt run 48);
 *   3. in the open  a spec or harness file that sets an adapter live on its own config after the
 *                 fact is named below with what makes it safe (a fake it intercepts, a pure function,
 *                 Stripe's own test mode). A new one is red until it is named here.
 *
 *   npm run check:test-targets   (root)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveTargets, testConfig } from '../test/test-targets.ts';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const problems: string[] = [];

const LOCAL_DB = 'postgres://saos:synthetic@localhost:5432/saos';
const HOSTILE: Record<string, string> = {
  MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'email-smtp.us-east-1.amazonaws.com', SMTP_PORT: '587', SMTP_USER: 'synthetic', SMTP_PASS: 'synthetic',
  STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
  PUSH_MODE: 'ntfy', NTFY_URL: 'https://ntfy.example.com',
  TRANSCRIBER_MODE: 'whisper',
  SUMMARIZER_MODE: 'api', ANTHROPIC_API_KEY: 'synthetic',
  TWILIO_ACCOUNT_SID: 'ACsynthetic', TWILIO_AUTH_TOKEN: 'synthetic', TWILIO_PHONE_NUMBER: '+15005550006',
  CLAMAV_HOST: 'clamav.example.com',
  MINIO_ENDPOINT: 'minio.example.com', MINIO_USE_SSL: 'true',
  DATABASE_URL: LOCAL_DB,
};

// 1. Hostile: every adapter live in the environment, none live in the configuration.
try {
  const live = liveTargets(testConfig(HOSTILE));
  if (live.length) problems.push(`the test configuration kept live targets over a hostile environment: ${live.join('; ')}`);
} catch (e) {
  problems.push(`the test configuration refused a hostile environment it should have forced: ${(e as Error).message}`);
}
// And over this machine's own .env, as every test process sees it, keeping what is not an adapter:
// the harness boot sets its portal and Ops addresses in process.env before it reads its config.
{
  const saved = process.env.PORTAL_BASE_URL;
  process.env.PORTAL_BASE_URL = 'http://localhost:3999';
  try {
    const own = testConfig();
    if (own.PORTAL_BASE_URL !== 'http://localhost:3999') problems.push(`the test configuration over process.env lost a setting that is not an adapter (PORTAL_BASE_URL read ${own.PORTAL_BASE_URL})`);
  } catch (e) {
    problems.push(`this machine's .env: ${(e as Error).message}`);
  } finally {
    if (saved === undefined) delete process.env.PORTAL_BASE_URL; else process.env.PORTAL_BASE_URL = saved;
  }
}

// 2. Refused: a remote database cannot be forced local, so the test process must not start.
try {
  testConfig({ ...HOSTILE, DATABASE_URL: 'postgres://saos:synthetic@db.example.com:5432/saos' });
  problems.push('a test configuration over a remote DATABASE_URL was built instead of refused');
} catch (e) {
  if (!/refusing: .*database: db\.example\.com/.test((e as Error).message)) problems.push(`a remote database was refused for the wrong reason: ${(e as Error).message}`);
}

// 3. In the open: adapters set live after the test configuration, each named with what keeps it off the wire.
const NAMED: Record<string, string> = {
  'apps/api/test/comms.spec.ts': 'synthetic Twilio credentials; globalThis.fetch intercepts api.twilio.com for the whole spec',
  'apps/api/test/document-scans.spec.ts': 'CLAMAV_HOST is a local fake clamd; the SMTP settings only feed the production-boot refusal, no mailer is built',
  'apps/api/test/payment-reconcile.spec.ts': 'the live adapter is built to read its key mode; no call is made',
  'apps/api/test/refund-control.spec.ts': 'the live adapter is built to assert its type; no call is made',
  'apps/api/test/stripe-key-mode.spec.ts': 'a pure function over plain objects',
  'apps/api/test/stub-refusal.spec.ts': 'a pure function over plain objects',
  'apps/api/test/stripe-refund-live.spec.ts': "Stripe's TEST mode: skipped unless STRIPE_TEST_SECRET_KEY is an sk_test_ key, which the spec asserts",
};
const LIVE_SETTING = new RegExp(
  [
    String.raw`PUSH_MODE\s*[:=]\s*['"]ntfy`,
    String.raw`MAIL_TRANSPORT\s*[:=]\s*['"]smtp`,
    String.raw`STRIPE_MODE\s*[:=]\s*['"]live`,
    String.raw`SUMMARIZER_MODE\s*[:=]\s*['"](api|ollama)`,
    String.raw`TRANSCRIBER_MODE\s*[:=]\s*['"]whisper`,
    String.raw`\b(SMTP_HOST|NTFY_URL|TWILIO_ACCOUNT_SID|ANTHROPIC_API_KEY|MINIO_ENDPOINT|CLAMAV_HOST)\s*[:=]\s*['"\x60]`,
    String.raw`\b(config|cfg)\.(SMTP_HOST|NTFY_URL|TWILIO_ACCOUNT_SID|ANTHROPIC_API_KEY|MINIO_ENDPOINT|CLAMAV_HOST|MINIO_USE_SSL)\s*=[^=]`,
  ].join('|'),
);
const files: string[] = [];
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue; }
    if (/\.(ts|mjs|js)$/.test(n)) files.push(p);
  }
};
walk(join(root, 'apps', 'api', 'test'));
walk(join(root, 'apps', 'api', 'scripts', 'e2e-fixtures'));
walk(join(root, 'apps', 'e2e'));
files.push(join(root, 'apps', 'api', 'scripts', 'e2e-boot.ts'));
const OWN = new Set(['apps/api/test/test-targets.ts']);
const seen = new Set<string>();
for (const f of files) {
  const rel = relative(root, f).split(sep).join('/');
  if (OWN.has(rel) || rel.includes('/node_modules/') || rel.includes('/test-results/') || rel.includes('/playwright-report/')) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  const hits = lines.map((l, i) => (LIVE_SETTING.test(l) && !/^\s*(\/\/|\*)/.test(l) ? i + 1 : 0)).filter(Boolean);
  if (hits.length && !NAMED[rel]) problems.push(`${rel}:${hits[0]} sets an outward adapter live and is not named in check-test-targets.ts with what keeps it off the wire`);
  if (hits.length) seen.add(rel);
}
for (const rel of Object.keys(NAMED)) {
  if (!seen.has(rel)) problems.push(`${rel} is named in check-test-targets.ts but no longer sets an adapter live; remove it`);
}

if (problems.length) {
  console.error('check:test-targets: a test process could reach a live target.');
  for (const p of problems) console.error(`RED ${p}`);
  process.exit(1);
}
console.log(`check:test-targets: every outward adapter forced over a hostile environment; a remote database refused; ${Object.keys(NAMED).length} specs set an adapter in the open, each named; ${files.length} test files scanned.`);
