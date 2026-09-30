/*
 * EVERY OUTWARD ADAPTER IN A TEST PROCESS IS A STUB OR A TEST TARGET (Brian, 2026-09-29, receipt run 47).
 *
 * The alert-center test pushed to the local ntfy container because the local .env said PUSH_MODE=ntfy
 * and the test configuration inherited it. That was a class, not a one-off: whatever the local .env
 * says, a test process's base configuration forces push, mail, Stripe, SMS, the transcriber and the
 * summarizer to their stubs, the scanner off, and the object store and the database to the local test
 * targets. A spec that needs a fake (a local clamd, a synthetic Twilio account whose calls it
 * intercepts, a Stripe test-mode key) sets it on its own config after createTestConfig, in the open.
 *
 * Whatever cannot be forced (the database is wherever the local .env points) is refused: a test
 * process whose base configuration still reaches a live target does not start.
 *
 * apps/api/scripts/check-test-targets.ts (the root chain) builds this configuration from a HOSTILE
 * environment, every adapter set live, and fails if any live target survives.
 */
import { loadConfig, type Config } from '../src/config.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The overrides every test process's base configuration carries, over any environment. */
export const TEST_OUTWARD_OVERRIDES = {
  MAIL_TRANSPORT: 'console',
  SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASS: undefined,
  STRIPE_MODE: 'stub',
  STRIPE_SECRET_KEY: undefined,
  PUSH_MODE: 'stub',
  TRANSCRIBER_MODE: 'stub',
  SUMMARIZER_MODE: 'stub',
  ANTHROPIC_API_KEY: undefined,
  TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_PHONE_NUMBER: undefined,
  CLAMAV_HOST: undefined,
  MINIO_ENDPOINT: 'localhost',
  MINIO_USE_SSL: 'false',
} as const;

/** A test process's base configuration, over whatever environment it is given. */
export function testConfig(env: Record<string, string | undefined> = process.env, databaseUrl?: string): Config {
  const saved = { ...process.env };
  try {
    // loadConfig reads process.env under its overrides; the environment under test stands in for it.
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, env);
    const config = loadConfig({ NODE_ENV: 'test', ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}), ...TEST_OUTWARD_OVERRIDES });
    // What cannot be forced (the database lives wherever the local .env says) is refused instead.
    const live = liveTargets(config);
    if (live.length) throw new Error(`refusing: a test process's configuration would reach a live target (${live.join('; ')})`);
    return config;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** Every live target a configuration can reach; empty for a proper test configuration. */
export function liveTargets(c: Config): string[] {
  const out: string[] = [];
  const host = (u: string) => { try { return new URL(u).hostname; } catch { return u; } };
  if (c.MAIL_TRANSPORT !== 'console' || c.SMTP_HOST) out.push(`mail: ${c.MAIL_TRANSPORT}${c.SMTP_HOST ? ` via ${c.SMTP_HOST}` : ''}`);
  if (c.STRIPE_MODE !== 'stub' || c.STRIPE_SECRET_KEY) out.push(`Stripe: ${c.STRIPE_MODE}${c.STRIPE_SECRET_KEY ? ' with a secret key' : ''}`);
  if (c.PUSH_MODE !== 'stub') out.push(`push: ${c.PUSH_MODE} at ${host(c.NTFY_URL)}`);
  if (c.TRANSCRIBER_MODE !== 'stub') out.push(`transcriber: ${c.TRANSCRIBER_MODE}`);
  if (c.SUMMARIZER_MODE !== 'stub' || c.ANTHROPIC_API_KEY) out.push(`summarizer: ${c.SUMMARIZER_MODE}${c.ANTHROPIC_API_KEY ? ' with an API key' : ''}`);
  if (c.TWILIO_ACCOUNT_SID || c.TWILIO_AUTH_TOKEN || c.TWILIO_PHONE_NUMBER) out.push('SMS: Twilio credentials');
  if (c.CLAMAV_HOST && !LOCAL_HOSTS.has(c.CLAMAV_HOST)) out.push(`scanner: ${c.CLAMAV_HOST}`);
  if (!LOCAL_HOSTS.has(c.MINIO_ENDPOINT) || c.MINIO_USE_SSL) out.push(`object store: ${c.MINIO_ENDPOINT}`);
  if (!LOCAL_HOSTS.has(host(c.DATABASE_URL))) out.push(`database: ${host(c.DATABASE_URL)}`);
  return out;
}
