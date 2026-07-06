# SAOS Phase 1 — Build Plan (v4.2 specs are source of truth)

Sequence is dependency-ordered. Nothing ships unverified; every milestone ends
with its "Prove it" step. Spec refs: MP = SAOS_Fable_Master_Prompt_v4.2.md,
OF = SAOS_Onboarding_Forms_Spec_v4.2.md.

## Definition of Done (applies to every item)
- Touches client documents/PII → audit logging in place (MP: WISP) — no exceptions
- Client-facing copy exists in EN **and** ES, admin-editable, professional voice
- No dollar literal in app code — all prices resolve from price_book (CI-enforced)
- Gates/derivations (deadlines, complexity, signature gates, placeholder block,
  §7216 checks, independence check) carry unit tests
- Verified working (test run, log, or demo) before its box is checked

## M0 — Repo bootstrap
- [x] `git init` + .gitignore (node_modules, .env, dist) + .editorconfig
- [x] npm-workspaces monorepo: apps/api, apps/portal, apps/internal,
      packages/db, packages/shared; TypeScript strict everywhere
- [x] `.env.example` documented per MP Output Requirements
- [x] `tasks/lessons.md` created; README with one-command quickstart
- [x] Prove it: fresh `npm install` + typecheck passes

## M1 — Docker Compose skeleton (PostgreSQL + MinIO)
- [x] `docker-compose.yml`: postgres:16 + minio, named volumes only (repo is in
      Dropbox — DB files must never bind-mount), healthchecks, single network,
      ports/creds from .env
- [x] MinIO bootstrap job: create buckets (documents, returns, signed-docs,
      recordings) private-by-default
- [x] Placeholder app services (api, portal, internal) wired but optional via
      profiles, so `docker compose up -d` works from day one
- [x] Prove it: `docker compose up -d` → both services healthy; psql connects;
      MinIO console reachable; volumes survive `down` + `up`

## M2 — Core database schema (versioned migrations, documented)
- [x] Migration tooling (node-pg-migrate, raw SQL) + `npm run migrate` up/down
- [x] Staff & auth: staff, roles/permissions (all 8 current roles + future ones:
      MP Team & Access), MFA secrets, sessions, failed-login lockout
- [x] audit_log — append-only (trigger blocks UPDATE/DELETE): who/what/when/where,
      exportable (MP WISP)
- [x] Contacts domain (MP Unified Contact Record): contacts (identity, language
      pref, relationship statuses, compliance fields incl. §7216 status,
      BR1–BR6 bridge fields, health-score inputs, referral attribution, source
      flag Dubsado/Zoho/native), businesses (EIN, entity type, NAICS/IRS code…),
      entity_groups + members (v4.2 module 2)
- [x] consents (§7216 et al.: status, signed-doc link, method, timestamps)
- [x] Engagements: engagements (service line, price-lock fields,
      price_book_version ref) + tax_engagements (full MP Tax Engagement field
      set: pricing incl. fee range, complexity score + inputs, extension block,
      compliance gates, signature method) + stage history (client-vs-staff
      delay attribution)
- [x] irs_notices (MP IRS Notice Module) · entity_compliance (annual-report
      dues, PLLC-conversion flag)
- [x] documents + document_requests (categories per MP Document Center)
- [x] signature_envelopes + kba_verifications (pluggable vendor field)
- [x] templates (EN/ES bodies, **is_placeholder flag**), message_threads/messages,
      notifications
- [x] Portal auth: portal_users, magic_link_tokens, portal_sessions
- [x] meetings/transcripts/summaries/suggested_actions · tasks · referrals
      (direction, disclosure timestamp, policy version) · import_batches +
      enrichment_queue · grants_received (minimal, for tracker migration) ·
      form_definitions/form_submissions (admin-editable selects, Form 5 modules
      as data) · resource_library · admin settings (SLA windows, thresholds)
- [x] Schema docs: every table/field/constraint/index annotated (MP Output Reqs)
      — documented in the migration SQL itself (inline comments + COMMENT ON)
- [x] Prove it: migrate up → down → up clean on fresh volume; constraint spot-checks

## M3 — price_book + seed (Pricing Seed Data, MP v4.2 addendum)
- [x] Tables: price_book_versions (effective-dated, admin edits create new
      version) · price_book_items (stable item_code, service_line, EN/ES names,
      amount_cents, unit [flat/hourly/per-form/per-month/…], min/max for ranges,
      is_pass_through, needs_confirmation + note) · bundle_rules
      (bundle-price + free-with rules)
- [x] Engagements reference the version in force at signing; price-lock fields
      (locked price + lock expiry) per MP Billing Architecture
- [x] Seed v1 — every line of Pricing Seed Data (73 items): individual base +
      17 add-ons + other; business returns (Sch C 180 … 1120 800, addl state
      350…); recurring accounting; scope-ladder rungs; setups & conversions;
      QBO/payroll software pass-throughs (display-only); 1099/W-2 ($50 + $10/form);
      entity services; attest; specialized CPA; COO $150/unit; deposits (1040
      $250…). Owner-comp default (⅓ net profits) as config, not a price
- [x] Seed the 3 bundle rules: QBO+payroll setup = one $250 · ST-1 filings free
      w/ monthly package · forecasting+margin analysis free w/ monthly package
- [x] ⚠ items seeded with primary value + needs_confirmation=true: CPA
      letters/planning $250–500 · semi-annual $1,000 · sales-tax full-mgmt $100
      · formation w/ EIN $500 · annual report $130 · specialized CPA $500 ·
      business-tax deposit $300 — Brian confirms before launch (launch-gate item)
      (12 item-level flags incl. payroll full-mgmt billing-unit question)
- [x] CI guard: build fails on dollar/cents literals in app code outside
      packages/db seeds + test fixtures (CLAUDE.md hard rule)
- [x] Prove it: seed idempotent; version-2 edit leaves v1 engagements priced at
      v1; spot queries (MFJ base 200.00, 1120-S 700.00) pass in tests

## M4 — API skeleton, staff auth, audit middleware
- [x] Fastify app + health endpoint + zod-validated config; request logging with
      **no PII in logs** (CLAUDE.md)
- [x] Staff auth: password + TOTP MFA (required), session timeout, lockout,
      RBAC middleware (role → permission checks per MP Team table)
- [x] Audit middleware: document/PII reads + permission changes emit audit rows
      (writeAudit fail-closed helper; permission.change asserted; document-read
      wiring lands with the document service in M10)
- [x] Mailer interface: SES transport (prod) / console transport (dev) — approved
      vendors only, no other SaaS
- [x] Prove it: auth + RBAC + lockout integration tests; audit rows asserted

## M5 — Client magic-link auth
- [x] Magic-link issue/verify (single-use, expiring), optional password + MFA,
      clients see only their own records (row-level checks)
      (password/MFA columns live on portal_users; set-password UX lands with
      the portal UI in M15 — magic link is the primary path per spec)
- [x] Bounce fallback: delivery-failure webhook → Rene task (MP Portal Auth)
- [x] Prove it: e2e login via console transport; cross-client access test fails closed
- [x] BONUS (pulled forward from M11): templated-email service with the
      **placeholder send-gate enforced + regression-tested** — placeholder
      templates are unsendable in every environment

## M6 — CRM core
- [x] Contacts/businesses/entity-groups CRUD + search; assigned manager;
      enrichment-gap surfacing (missing EIN/entity type…)
- [x] Health score job (5×20 weights, MP) + Red alert / Green+tenure upsell flag
      (upsell **§7216-gated**) — transition-based alerts, no duplicates on re-run
- [x] §7216 enforcement helper used by every cross-entity/referral/upsell code
      path — blocked until signed consent on file; migrated clients default
      "Not on file" (MP §7216)
- [x] Attest independence check: block attest engagement creation when active
      bookkeeping/payroll/mgmt services exist, absent Brian's documented
      override (CLAUDE.md hard rule) + test — override is CEO-only (Jackson 403)
- [x] Prove it: unit tests incl. gate tests; seeded demo data walkthrough
      (walkthrough scripted as the CRM e2e test; UI demo lands with M15)

## M7 — Tax engagement module
- [x] Pipeline stages + transitions (MP): Intake Started → … → Completed |
      On Hold | Withdrawn; parallel "Extended" tag; Pending Client Response
      auto-set on doc request ("Extended" lives on extension_filed — M8 wires it)
- [x] Signature gates enforced in code: engagement letter → past Scheduled;
      8879 → Filed (MP automations 7) — incl. wet-signature path with
      signature method recorded; Docuseal remote path (M11) sets the same fields
- [x] Complexity score fn (base 1 … cap L5) + scope-creep auto-flag (final >
      estimate top) with required reason enum ('other' requires description)
- [x] Estimated-fee-locked → preparation unlocked (automation 8)
- [x] Prove it: table-driven tests for gates/score/creep; stage-history rows

## M8 — Extension workflow + deadline engine
- [x] Deadline derivation as pure fn from return type + fiscal-year end
      (1065/1120-S→Sep 15 · 1040/1120→Oct 15 · 990→Nov 15 · fiscal-year→+6mo)
      — table-driven tests, **never a hardcoded date swap** (CLAUDE.md)
      (model: 15th of Nth month after FYE, extension = original + 6 months;
      weekend/holiday observance + June-30-FYE special rule documented as
      not modeled in v1)
- [x] T-21 Extension Decision List job; Extend → client notice (EN/ES) +
      payment-estimate flow; filed → deadline swap + Extended tag
- [x] Summer chase scheduler (Jun 1 / Jul 15 / Aug 15, escalating copy) +
      at-risk flag (extended, no docs by Aug 15)
- [x] Deadline dashboard data (countdowns, at-risk counts)
- [x] Prove it: clock-injected job tests around Mar 15/Apr 15 boundaries

## M9 — IRS notices + entity compliance
- [x] Notice records + auto response-deadline + Ana-Maria default routing;
      escalations (<14d → Brian; unactioned 48h → Brian+Jackson)
      (routing is by ROLE — tax_preparer — never by name; auto deadline =
      notice date + admin-configurable 30 days)
- [x] Entity module: annual-report due dates per state, Laura T-60 / client
      T-30 reminders; PLLC-conversion pipeline (Module I flag → Laura +
      advisory flag; license-verification checklist step)
      (state rules: IL = first day of anniversary month, default =
      anniversary date; filed → history row + due date rolls)
- [x] Prove it: alert-timing tests; notice-upload → record within minutes
      (createIrsNotice service ready — M10's upload handler calls it)

## M10 — Document center backend (MinIO)
- [x] Upload/download service: presigned or streamed, category enum, per-file
      status, size/type limits; **every access audit-logged**
      (DECIDED: streamed through the API, not presigned — MinIO never faces
      the internet and no byte moves without the auth+audit path; audit row
      writes BEFORE the stream, fail-closed)
- [x] Document requests → Pending Client Response + 3-day reminder + 7-day
      non-response alert (automations 4–5) — itemized requests, initial
      bilingual email, per-item fulfillment, completion stamps docs_received_at
- [x] IRS-notice-category upload → auto-create notice record + alert (minutes)
- [x] Prove it: audit-log assertions on every path; reminder job tests
- [x] BONUS (pulled from M15's backend half): return delivery — ATX PDF upload
      → saos-returns bucket, stage → client_review, client notified EN/ES

## M11 — Docuseal + signature flows
- [ ] Docuseal container (sign. subdomain in prod); envelope create/webhook sync;
      signed PDFs → MinIO + contact link + audit
- [ ] Engagement-letter (per service type) + §7216 templates as clearly-marked
      PLACEHOLDERs, admin-editable
- [ ] **Placeholder gate enforced in code**: any template flagged PLACEHOLDER is
      blocked from sending to any production client — plus regression test
      (CLAUDE.md non-negotiable)
- [ ] 8879 remote flow: pluggable KBA interface → stub/sandbox adapter first
      (vendor = Brian decision; $1–3/sig) → KBA pass required before envelope;
      in-person wet path = scan/upload to "Signed Authorizations"; signature
      method recorded per 8879
- [ ] Signature status feeds gates from M7
- [ ] Prove it: placeholder-block test; KBA-required test; wet-path test

## M12 — Pricing calculator (range)
- [ ] Range calculator from live price_book (itemized per Pricing Seed Data
      structure); output = RANGE, never exact (MP Get an Estimate); writes
      range + version ref to engagement
- [ ] Bundle rules applied; pass-throughs shown on quotes as non-revenue
- [ ] Prove it: golden tests from seed values; range logic reviewed with Brian

## M13 — Stripe one-time billing
- [ ] Invoices (from price_book items) + Stripe Checkout/PaymentIntents +
      webhooks; receipt template; unpaid-14-day reminder + Rene flag; Filed →
      invoice generated + QB export flag (automations 12, 17)
- [ ] Prove it: Stripe test-mode e2e incl. webhook signature verification

## M14 — Intake forms
- [ ] Form 1 Soto intake (OF): 4 screens, conditional logic exactly as specced,
      ≤3 min mobile, autosave/resume via magic link, admin-editable selects,
      entity-group question, SSN by-phone escape hatch, hidden BR1–BR6 only via
      Hilo link; on-submit automation #1 (contact + lead + welcome + engagement
      letter & §7216 queued + Rene notified; 3.3=Yes → Ana-Maria flag)
- [ ] IL SOS good-standing check at intake (v4.2): lookup + stamp result +
      adverse → task + fix-steps notification; scheduled re-check job
- [ ] Form 2 Hilo intake (90-second, warm voice, demographics optional →
      reporting tables only, never day-to-day views)
- [ ] Form 4 portal first-login checklist (4 steps, migrated-client variant)
- [ ] Form 5 framework: modules as data; ship F (tax → complexity inputs),
      B (F&B fires on industry alone — v4.1 fix), I (healthcare → PLLC flag);
      A/C/D/E defined but deferred to their service phases
- [ ] Form analytics counters (started/completed/drop-off per screen)
- [ ] Prove it: e2e submits for all branches; module-firing rule tests

## M15 — Soto client portal (bilingual)
- [ ] Next.js portal, i18n EN/ES from day one (toggle persists to contact,
      applied to outbound comms); Soto brand tokens (Forest Teal #0D3B38,
      Electric Teal #00C9BF, Inter **self-hosted** — no CDN fonts per vendor rule)
- [ ] Empty-state 4-step checklist · Dashboard (status plain-English, doc
      requests, unsigned docs, invoices w/ Pay Now, messages, quick actions)
- [ ] Document Center (drag-drop/camera, categories, per-file status,
      portal-only policy copy) · My Returns + internal return-upload UI (ATX
      PDF → portal delivery, auto-notify in client language, stage → Client
      Review) · Sign Documents (Docuseal embed) · Invoices & Payments ·
      Messages thread · Request a Service (→ opportunity, 24h commitment) ·
      Get an Estimate (range + Cal.com embed) · Resource Library EN/ES
- [ ] Prove it: full client journey demo on mobile viewport, both languages

## M16 — Referral flows both directions (§7216-gated)
- [ ] Form 3 Hilo→Soto transition: pre-filled, BR1–BR6 locked, referral-
      integrity disclosure block (ack + timestamp + policy version logged),
      <60s to submit; Soto lead w/ attribution + Brian notified + warm handoff
- [ ] Soto→Hilo referral + both approval queues (one-tap mobile approve);
      portal CTA fires only with consent on file (automations 14–15)
- [ ] Prove it: gating tests (no consent → no referral/CTA); disclosure audit trail

## M17 — Meeting intelligence
- [ ] Whisper + Ollama containers sized for shared 16GB box (small/medium
      Whisper, ~3–8B quantized LLM); job queue serializes heavy work; flag if
      memory budget doesn't hold (CLAUDE.md) — API fallback text-only
- [ ] Zoom webhook → download → transcribe → summary/decisions/actions/referral
      recs → contact record + auto tasks + referral queue + suggested time entry
- [ ] Browser-based mobile recorder (no app) + voice-memo upload → same pipeline;
      meeting type tagged
- [ ] Prove it: e2e on a sample recording; peak-memory measured and recorded

## M18 — Cal.com + booking
- [ ] Cal.com container (book. subdomain); event types; **Zoom-only enforced on
      initial consultations**; booking → Form 1 handoff
- [ ] Two-lane booking (v4.2): Lane 1 discovery collects service-level deposit
      via Stripe (true-up language at checkout, deposit amounts from
      price_book); Lane 2 questions always free
- [ ] Prove it: booking e2e; deposit charge in Stripe test mode

## M19 — Dashboards + alerts (Phase 1 set)
- [ ] Executive (Brian): open returns by stage+value, revenue MTD/YTD, A/R,
      alerts, capacity, health distribution, deadline-countdown widget
- [ ] Hilo Ops (Jackson): entrepreneurs by status, sessions, referral queues,
      summaries 7-day, milestones 30-day, live funder metrics
- [ ] ntfy push (Brian+Jackson) + Phase-1 alert set (IRS 48h, SLA, non-response
      7d, scope creep, health Red, magic-link bounce, unsigned 8879 near
      deadline, extension at-risk…)
- [ ] Prove it: dashboards over seeded demo data; test push received on iPhone

## M20 — Admin interface core
- [ ] Price-book editor (new-version-on-edit semantics + needs_confirmation
      queue for the ⚠ items) · template editor EN/ES with placeholder flag
      badge · staff + permissions · SLA windows + alert thresholds
- [ ] Copy changes never require deploy (CLAUDE.md) — templates fully DB-driven
- [ ] Prove it: price edit → new version; old engagements keep old version

## M21 — Ops hardening
- [ ] docker-compose.staging.yml (full clone) · Uptime Kuma monitors all
      services · Vaultwarden up (funder-portal creds migrate in, Sheet purged)
- [ ] Encrypted backups → Backblaze B2 (pg_dump + MinIO mirror), documented +
      **tested** restore script; quarterly-restore-test reminder
- [ ] WISP security-summary export (MFA status, audit stats, backup status)
- [ ] Prove it: restore drill from a real backup on a clean stack

## M22 — Data migration
- [ ] Import pipeline w/ per-record source flags: Dubsado (24–36mo active),
      Zoho (full, skip 36mo+ inactive unless flagged), Grant Tracker →
      grants_received; dedupe/merge into unified schema; enrichment queue for
      gaps  ⛔ needs export files from Brian
- [ ] Migrated-client onboarding sequence staged (EN/ES "we upgraded our
      portal" + magic link + checklist w/ pending signatures) — **not sent**
      until launch gates pass
- [ ] Prove it: dry-run counts/dedupe report reviewed with Brian before commit

## M23 — Deploy + launch gates
- [ ] Hetzner CPX41 (encrypted volume), DNS subdomains, Caddy/Traefik +
      Let's Encrypt, prod + staging up, Twilio 312 number provisioned (client-
      facing in Phase 2)  ⛔ needs Brian's accounts (Hetzner, DNS, Stripe,
      Twilio, SES prod access, B2, Zoom app, KBA vendor)
- [ ] Launch-gate checklist: no PLACEHOLDER template sendable (verified by
      test) · ⚠ prices confirmed by Brian · restore tested · MFA enforced ·
      audit export works · portal copy EN/ES review by Brian/Jackson
- [ ] Prove it: smoke suite against staging; `docker-compose up -d` from clean
      server per MP one-command requirement

## Review

### M0–M3 (completed 2026-07-05)
- Stack as approved: Node 24 + TypeScript strict, npm workspaces, Fastify (M4),
  node-pg-migrate **v8** (upgraded from v7 during build — v7 pulled a
  high-severity glob advisory; v8 audits clean), raw-SQL migrations.
- 7 migrations, ~45 tables/28 enums covering the full Phase 1 data model.
  Verified: up → down ×7 → up clean; audit_log append-only trigger and
  scope-creep CHECK proven by tests.
- Price book v1: **73 items** (every Pricing Seed Data line), 3 bundle rules,
  **12 item-level needs_confirmation flags** (the spec's 7 ⚠ conflicts, expanded
  per item, + 1 honest question: payroll full-mgmt $500 has no billing unit in
  the spec — seeded as monthly, flagged for Brian).
- 9/9 integration tests green incl. grandfathering (new version never touches
  v1) and placeholder-template flags. `npm run check:prices` guard active.
- DB-level guardrails beyond the plan: Hilo→Soto referrals CANNOT reach 'sent'
  without a disclosure timestamp (CHECK); f8879 envelopes require a recorded
  signature method before sending (CHECK).
- Deviation from README quickstart: none — fresh-clone sequence verified end
  to end on this machine (compose up → migrate → seed → test:db).
- Not yet done: initial git commit (awaiting Brian's go-ahead), MinIO image
  tag pinning (M21), generated human-readable schema doc (docs live in
  migration SQL comments for now).

### M4 (completed 2026-07-05)
- Fastify 5 API running directly on Node 24 native type-stripping (no build
  step; erasableSyntaxOnly enforced). 10/10 integration tests against a fresh
  migrated+seeded throwaway database (`saos_api_test`) via @saos/db's new
  programmatic migrate/seed exports.
- Auth: argon2id passwords, TOTP (otpauth) REQUIRED for staff — password-only
  accounts get a 15-min HMAC-scoped token usable solely for MFA enrollment;
  no full session exists until an authenticator is proven. Sliding session
  expiry (60m idle / 12h absolute), failed-login lockout (5 → 15m), sessions
  revoked on password change and deactivation. All flows audit-logged
  (login_success/failed/locked_out, mfa_enrolled, permission.change, …).
- No-PII logging: path-only URLs, redacted auth headers, no bodies ever;
  pg errors logged as SQLSTATE+constraint only (pg `detail` echoes column
  values). Verified against live server log output.
- Mailer behind one interface: console (dev) / SMTP smart host (SES prod;
  Postal-compatible later). Production config REFUSES console transport and
  the well-known dev encryption key. SMTP path not live-tested (no SES creds
  yet — M23 dependency).
- `create-staff` CLI solves first-admin bootstrap (temp password shown once).
- Fixes en route: price guard was flagging SQL positional params ($1, $2) —
  patterns now require price-shaped amounts; guard self-tested both ways.
  nodemailer bumped to v9 (v7 carried six advisories); audit clean.

### M5 (completed 2026-07-05)
- Client auth: staff (magic_links.manage → Rene) grants portal access; magic
  links are single-use (atomic redemption — racing requests can't double-
  spend), 30-min expiry, throttled (3/user/10min, silent), token hashes only
  in DB. Portal sessions 30 days; logout revokes. All flows audit-logged.
- ALL client-facing copy renders from DB templates EN/ES per contact language
  (Spanish contact verified receiving Spanish mail; missing-ES falls back to
  EN with a warning log). sendTemplatedEmail carries the PLACEHOLDER GATE:
  refuses flagged templates in every environment — regression test asserts
  the engagement-letter template cannot send and nothing reaches the mailer.
- Row-level isolation proven: client A sees zero of client B's documents,
  client-supplied ids ignored for scoping, anonymous requests fail closed.
- Bounce webhook (shared-secret auth, provider-neutral shape; SES adapter at
  M23) → verification task auto-assigned to the comms_billing role + ntfy-
  ready notification row + audit trail.
- Fix en route: test DBs are now per-suite (node --test runs spec files in
  parallel processes; a shared DROP/CREATE raced). 18/18 API tests green.

### M6 (completed 2026-07-05)
- CRM: contacts CRUD + search (name/email/phone, status/manager filters),
  businesses with EIN-format validation, entity groups with XOR membership.
  Contact detail reads audit 'contact.viewed' (PII under WISP); SSN never
  returned (status + last4 only). Enrichment gaps auto-refresh on every
  contact/business write and resolve in enrichment_queue.
- §7216: has/require/record helpers; gate throws 403 'consent_7216_required';
  recording maintains the contact rollup. This is THE chokepoint referrals
  (M16) and Docuseal completion (M11) will call.
- Health job: 5×20 components (v1 heuristics: portal logins 90d, doc-request
  completion, payment status, docs-turnaround, tenure+engagement depth);
  thresholds read from app_settings; alerts fire on band TRANSITIONS only
  (re-run produces no duplicates). Red → assigned manager; green+2yr-tenure
  upsell fires ONLY with signed §7216 (both sides tested). Manual trigger
  POST /jobs/health-refresh; cron wiring lands with M8's scheduler.
- Attest independence: conflict lines = bookkeeping/payroll/sales_tax/coo/
  nonprofit_cfo (deliberately broad — override path exists; narrowing is
  Brian's call). 409 without override; override restricted to CEO role
  (Jackson's '*' does NOT bypass — tested); documented note required (min 10
  chars), audited as engagement.independence_override.
- Engagements pin price_book_version_id at creation (grandfathering root).
- 22/22 API tests green.

### M7 (completed 2026-07-05)
- Pipeline state machine with explicit transition map; on_hold/withdrawn
  reachable from any non-terminal stage; resuming from on_hold re-applies all
  gates (tested). Every transition writes a stage-history row with client/
  staff delay attribution (pending_client_response + client_review = client
  court). filed_date auto-stamps on → filed.
- Three gates enforced in code, all 409 with distinct error codes:
  engagement_letter_required (past Scheduled), estimate_lock_required
  (into preparation, automation 8), f8879_required (into filed).
- Wet-signature endpoint (in-office ~10%): records letter/8879 with
  signature_method='in_person_wet', maintains contact letter rollup, audited.
  M11's Docuseal webhook will set the same timestamps for the remote path.
- Scope creep: final > estimate top auto-flags; reason REQUIRED at that
  moment (409 without), 'other' requires description; audited with
  over-estimate delta. Complexity: pure fn, 12 table-driven cases, cap L5
  (interpretation documented: multi-state counts states beyond the first).
- Document-request creation triggers the pending_client_response side-effect
  (automation 4's pipeline half; reminders/items land in M10).
- 28/28 API tests green.

### M8 (completed 2026-07-05)
- Deadlines derive: due = 15th of Nth month after fiscal year end (1065/
  1120-S: 3rd · 1040/1120 family: 4th · 990: 5th), extended = original + 6
  months. Calendar filers reproduce the spec table exactly; fiscal filers
  proven by test (1120 FYE-June → extended 2027-04-15 — a date no
  Sep/Oct/Nov swap could produce). tax_year convention: the calendar year
  the fiscal year ENDS in. Not modeled in v1 (documented): weekend/holiday
  shifts (countdowns err conservative), June-30-FYE C-corp special rule.
- Daily jobs are idempotent PER DATE via audit-log run records — safe across
  restarts, clock-injectable (?asOf=) for tests and admin replays. Scheduler
  ticks every 15 min in index.ts (JOBS_ENABLED=false in tests), and runs the
  health refresh once per day.
- T-21 job stamps missing original_deadlines (business FYE; individuals
  calendar), then notifies CEO + tax preparers per deadline with counts;
  decision list queryable sorted by preparer; tested at both the Mar 15 and
  Apr 15 boundaries.
- Extend decision → bilingual notice (explicitly: extension of time to FILE,
  not to PAY — Spanish verified); payment estimate → instructions email with
  formatted amount + payment-made checkbox; filed → Extended tag + derived
  deadline swap.
- Summer chase (dates from app_settings): June gentle / July firmer / August
  urgent, all EN+ES; clients with docs received are skipped; on/after the
  at-risk date preparers get critical extension_at_risk alerts.
- Deadline dashboard endpoint: per-engagement countdowns, per-deadline
  buckets, extended + at-risk counts.
- 6 new bilingual templates seeded (notice, payment reminder, 3 chases; all
  functional copy, admin-editable, not placeholder-flagged).
- 34/34 API tests green.

### M9 (completed 2026-07-05)
- IRS notices: creation (staff route + createIrsNotice service for M10's
  portal-upload hook), auto response-deadline (notice date + configurable 30
  days), handler routed to the tax_preparer ROLE with immediate notification,
  first_actioned_at stamps once on leaving 'received' (the 48h SLA basis).
- Escalations run on every 15-min scheduler tick (48h precision), idempotent
  per notice via notification-existence checks (notifyOnce): unactioned-48h →
  Brian + Jackson (critical); deadline ≤14d → Brian + status 'escalated' +
  escalated_at stamped. Re-runs verifiably duplicate nothing.
- Entity compliance: due-date rule engine (IL: first day of anniversary
  month; default: anniversary date; admin override always wins), status
  upkeep (good/due_soon/overdue), T-60 staff notification + task (assigned
  staff or va_entity role), T-30 bilingual client email (Spanish verified),
  filed → annual_report_filings history + due date rolls to next period.
- PLLC conversions: flag → Laura (va_entity) + advisory flag → Brian, 6-step
  conversion checklist seeded per record, license-verification step, loose
  status machine. createPllcConversion is the fn Module I firing (M14) calls.
- New staffing helpers: role→staff resolution + notifyOnce (idempotent
  alerts) — routing is always by role, never by name.
- 40/40 API tests green.

### M10 (completed 2026-07-05)
- Streamed (not presigned) document storage: MinIO stays entirely internal;
  the API is the only thing that touches it. Audit rows write BEFORE bytes
  stream (no audit → no access, fail closed). Uploads: mime allowlist
  (pdf/images/office/csv/txt), 25MB configurable cap, sha256, per-contact
  object keys, bucket per family (documents / signed-docs / returns).
- Row-level isolation on downloads: another client's document = the same 404
  as a nonexistent one, and no audit access row (verified). Staff downloads
  and status changes separately audited.
- IRS-notice uploads from the portal auto-create the notice record (source
  portal_upload, linked document) and alert the tax_preparer role in the
  same request — "within minutes" is actually "within the request".
- Document requests now itemized: initial bilingual email lists the items in
  the client's language; per-item fulfillment rolls request status; full
  completion stamps tax_engagements.docs_received_at (feeds health + at-risk).
- Chase job (daily, date-guarded): recurring reminder every N days (settings)
  per open request; 7-day non-response alert to Brian + Jackson via notifyOnce
  (recurs never, reminder recurs — both proven).
- Return delivery: preparer uploads the final PDF with category
  return_deliverable → lands in saos-returns, stage advances to client_review
  when the pipeline allows, client notified in their language.
- 3 new bilingual templates (doc_request, doc_request_reminder,
  return_delivered). 46/46 API tests green (MinIO round-trip byte-verified).
