# @saos/db — migrations & seeds

## Why plain JavaScript here (in a TypeScript repo)
Migrations and seeds run directly with `node` against the database — no build
step can sit between "deploy" and "migrate". Migration files are JavaScript
wrappers around **raw SQL** (`pgm.sql`) so every table, constraint, and index
is explicit and reviewable. All application code stays strict TypeScript.

## Commands (run from repo root)
- `npm run migrate` — apply pending migrations
- `npm run migrate:down` — roll back the most recent migration
- `npm run seed` — apply seeds (idempotent — safe to re-run)
- `npm run test:db` — integration spot-checks against the running database

Both need `DATABASE_URL` (see `.env.example` at repo root). Migration state
lives in the `pgmigrations` table.

## Layout
- `migrations/` — numbered, immutable once applied. Schema changes are always a
  NEW migration, never an edit to an applied one.
- `seeds/` — `run.mjs` orchestrates `seeds/data/*.mjs`. Seeds upsert on natural
  keys (`roles.key`, `app_settings.key`, `templates.key`,
  `price_book_items(version_id, item_code)`), so re-running is safe.

## Non-negotiables encoded at this layer
- `audit_log` is append-only — a trigger rejects UPDATE/DELETE (FTC Safeguards).
- Every price lives in the versioned, effective-dated `price_book_*` tables.
  Application code must never carry a dollar literal (CI enforces).
- Templates carry `is_placeholder`; the send path must block placeholder
  templates to production clients (enforced in code in M11, flagged in data here).
- Pricing seed values flagged `needs_confirmation` (the spec's ⚠ items) must be
  confirmed by Brian before launch — they are seeded with the spec's primary
  value so the calculator works in the meantime.
