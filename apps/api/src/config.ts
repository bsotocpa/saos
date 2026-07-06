// Environment configuration — zod-validated so a bad deploy fails at boot,
// not at 2am mid-request. Loads the repo-root .env (shared with compose).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });

// Well-known DEV-ONLY key (matches .env.example). Refused in production.
export const DEV_ENCRYPTION_KEY = 'decade00'.repeat(8);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .default('postgres://saos:saos_dev_password@localhost:5432/saos'),
  // 32-byte hex key for column-level encryption (TOTP secrets, SSNs).
  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'APP_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)')
    .default(DEV_ENCRYPTION_KEY),
  // WISP: session timeout. Sliding idle window, capped by an absolute lifetime.
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  // WISP: failed-login lockout.
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  // Outbound mail. 'console' prints to stdout (dev); 'smtp' relays through the
  // configured smart host — Amazon SES in production (approved vendor), and
  // later the self-hosted Postal instance. No other mail vendors, ever.
  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('Soto Accounting <no-reply@sotoaccounting.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const config = schema.parse({ ...process.env, ...overrides });

  if (config.NODE_ENV === 'production') {
    // Fail loudly rather than silently degrade (CLAUDE.md).
    if (config.APP_ENCRYPTION_KEY.toLowerCase() === DEV_ENCRYPTION_KEY) {
      throw new Error('APP_ENCRYPTION_KEY is the well-known dev key — refusing to start in production.');
    }
    if (config.MAIL_TRANSPORT === 'console') {
      throw new Error('MAIL_TRANSPORT=console in production — configure the SES smart host (SMTP_*).');
    }
    if (config.MAIL_TRANSPORT === 'smtp' && (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS)) {
      throw new Error('MAIL_TRANSPORT=smtp requires SMTP_HOST, SMTP_USER, SMTP_PASS.');
    }
  }
  return config;
}
