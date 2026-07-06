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
  // Client portal auth (M5).
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  PORTAL_SESSION_DAYS: z.coerce.number().int().positive().default(30),
  PORTAL_BASE_URL: z.url().default('http://localhost:3000'),
  // Shared secret for inbound delivery-status webhooks (bounce fallback).
  WEBHOOK_SECRET: z.string().min(8).default('dev-webhook-secret'),
  // Daily job scheduler (extension decision list, summer chase, health).
  JOBS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // MinIO object storage (documents). The API is the ONLY thing that talks to
  // MinIO — clients never get direct/presigned access, so every read passes
  // the auth + audit path and MinIO stays off the public internet.
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MINIO_ROOT_USER: z.string().default('saos'),
  MINIO_ROOT_PASSWORD: z.string().default('saos_dev_password'),
  // Upload limits (client tax documents are PDFs/photos — 25MB is generous).
  DOC_MAX_SIZE_MB: z.coerce.number().int().positive().default(25),
  // Docuseal (self-hosted e-signature). 'stub' needs no instance (dev/test);
  // 'http' talks to the real container. Production send paths refuse 'stub'.
  DOCUSEAL_MODE: z.enum(['stub', 'http']).default('stub'),
  DOCUSEAL_URL: z.string().default('http://localhost:3002'),
  DOCUSEAL_API_TOKEN: z.string().optional(),
  // KBA for remote 8879 (IRS Pub 1345). 'sandbox' until Brian picks the
  // vendor; production refuses remote 8879 without a real vendor.
  KBA_MODE: z.enum(['sandbox', 'vendor']).default('sandbox'),
  // Stripe (approved vendor — payment tokens only). 'stub' for dev/test;
  // 'live' needs the secret key + webhook signing secret. Production
  // checkout refuses stub mode at runtime.
  STRIPE_MODE: z.enum(['stub', 'live']).default('stub'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // IL SOS good-standing checker: 'stub' (dev/test) or 'live' (self-hosted
  // scraper against ilsos.gov — no third-party service).
  SOS_MODE: z.enum(['stub', 'live']).default('stub'),
  // Meeting intelligence (M17). Transcription stays on owned infrastructure;
  // the API summarizer fallback receives CLEANED TEXT ONLY (MP stack rule).
  TRANSCRIBER_MODE: z.enum(['stub', 'whisper']).default('stub'),
  WHISPER_URL: z.string().default('http://localhost:9010'),
  SUMMARIZER_MODE: z.enum(['stub', 'ollama', 'api']).default('stub'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2:3b'),
  ANTHROPIC_API_KEY: z.string().optional(),
  // ntfy push (self-hosted — Brian + Jackson iPhones, MP Alert Center).
  PUSH_MODE: z.enum(['stub', 'ntfy']).default('stub'),
  NTFY_URL: z.string().default('http://localhost:8093'),
  NTFY_TOPIC: z.string().default('saos-alerts'),
  // Where scripts/backup.sh drops its machine-readable result. Read by the
  // WISP security summary and the backup-staleness check (no client data in
  // the file — timestamps, snapshot id, row counts).
  BACKUP_STATUS_PATH: z.string().default(path.resolve(here, '../../../backups/status.json')),
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
    if (config.WEBHOOK_SECRET === 'dev-webhook-secret') {
      throw new Error('WEBHOOK_SECRET is the well-known dev value — refusing to start in production.');
    }
    if (config.STRIPE_MODE === 'live' && (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET)) {
      throw new Error('STRIPE_MODE=live requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
    }
  }
  return config;
}
