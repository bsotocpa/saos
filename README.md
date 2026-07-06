# SAOS — Soto Accounting Operating System

Self-hosted business operating system for **Soto Accounting LLC** (CPA firm) and
**Hilo NFP**, replacing Zoho One, Zapier, Otter.ai, Calendly, Adobe Sign, and
Eventbrite-dependent workflows. One codebase, one database, two branded front
doors. Spec: [docs/SAOS_Fable_Master_Prompt_v4.2.md](docs/SAOS_Fable_Master_Prompt_v4.2.md)
and [docs/SAOS_Onboarding_Forms_Spec_v4.2.md](docs/SAOS_Onboarding_Forms_Spec_v4.2.md)
— when code and spec conflict, the spec wins.

Build plan + progress: [tasks/todo.md](tasks/todo.md)

## Quickstart (dev)

```sh
cp .env.example .env        # dev defaults work as-is
docker compose up -d        # PostgreSQL 16 + MinIO (+ bucket bootstrap)
npm install
npm run migrate             # apply versioned SQL migrations
npm run seed                # roles, settings, templates, price book v1
npm run test:db             # integration spot-checks against the seeded DB
```

MinIO console: http://localhost:9001 (credentials from `.env`).

## Layout

| Path | What |
|---|---|
| `apps/api` | Backend API — Fastify (from M4) |
| `apps/portal` | Client portal — Next.js, bilingual EN/ES (M15) |
| `apps/internal` | Staff app + admin interface (M6+) |
| `packages/db` | Migrations + seeds — see its README |
| `packages/shared` | Shared types/enums mirroring DB enums |
| `tasks/` | Build plan (`todo.md`) + lessons log |

## Non-negotiable guardrails (enforced, not conventional)

- **No hardcoded prices** — every dollar comes from the versioned
  `price_book` tables; `npm run check:prices` fails the build on literals.
- **audit_log is append-only** — DB trigger rejects UPDATE/DELETE.
- **Placeholder templates cannot be sent** to production clients (§7216 +
  engagement letters ship as placeholders until Brian's final legal text).
- **Approved external vendors only**: Stripe, Twilio, Amazon SES, KBA API.
  No analytics SDKs, no error-tracking SaaS, no CDN fonts.
- **No PII in logs or test fixtures** — synthetic data everywhere.
- Client documents move by portal only — never SMS or email attachment.
