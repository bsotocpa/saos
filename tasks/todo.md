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
- [x] Docuseal container (sign. subdomain in prod); envelope create/webhook sync;
      signed PDFs → MinIO + contact link + audit
      (adapter pattern: stub for dev/test, http for the real instance;
      production send path refuses stub; webhook idempotent on replays)
- [x] Engagement-letter (per service type) + §7216 templates as clearly-marked
      PLACEHOLDERs, admin-editable (seeded since M0–M3)
- [x] **Placeholder gate enforced in code**: any template flagged PLACEHOLDER is
      blocked from sending to any production client — plus regression test
      (CLAUDE.md non-negotiable) — now covers ENVELOPES too: drafting/queueing
      allowed, sending blocked until Brian finalizes copy in admin
- [x] 8879 remote flow: pluggable KBA interface → stub/sandbox adapter first
      (vendor = Brian decision; $1–3/sig) → KBA pass required before envelope;
      in-person wet path = scan/upload to "Signed Authorizations"; signature
      method recorded per 8879 (production refuses remote 8879 without a real
      vendor — sandbox never reaches prod; wet path always available)
- [x] Signature status feeds gates from M7 (webhook completion sets letter/
      8879 timestamps; §7216 completion records consent via M6; pipeline
      unblocking verified end-to-end)
- [x] Prove it: placeholder-block test; KBA-required test; wet-path test

## M12 — Pricing calculator (range)
- [x] Range calculator from live price_book (itemized per Pricing Seed Data
      structure); output = RANGE, never exact (MP Get an Estimate); writes
      range + version ref to engagement
      (range = line minimums … banded maximums; band 15% on ONE-TIME work only
      — recurring prices stay contractual/exact; band is an app_setting)
- [x] Bundle rules applied; pass-throughs shown on quotes as non-revenue
- [x] Prove it: golden tests from seed values ✓; range logic reviewed with
      Brian ⚠ PENDING — band methodology + 15% default surfaced for his
      confirmation (admin-tunable, no deploy)

## M13 — Stripe one-time billing
- [x] Invoices (from price_book items) + Stripe Checkout/PaymentIntents +
      webhooks; receipt template; unpaid-14-day reminder + Rene flag; Filed →
      invoice generated + QB export flag (automations 12, 17)
- [x] Prove it: Stripe test-mode e2e incl. webhook signature verification
      — full e2e proven against the stub adapter; LIVE test-mode run
      COMPLETED 2026-07-06 with Brian's sk_test key
      (scripts/live-stripe-check.ts): real checkout session created via our
      adapter with a price-book amount; stripe.webhooks.constructEvent
      accepted a correctly signed payload and refused a tampered one

## M14 — Intake forms
- [x] Form 1 Soto intake (OF): 4 screens, conditional logic exactly as specced,
      ≤3 min mobile, autosave/resume via magic link, admin-editable selects,
      entity-group question, SSN by-phone escape hatch, hidden BR1–BR6 only via
      Hilo link; on-submit automation #1 (contact + lead + welcome + engagement
      letter & §7216 queued + Rene notified; 3.3=Yes → Ana-Maria flag)
      (BR fields server-written only — client attempts at the reserved '_'
      namespace are stripped and proven ignored)
- [x] IL SOS good-standing check at intake (v4.2): lookup + stamp result +
      adverse → task + fix-steps notification; scheduled re-check job
      (adapter: stub | live ilsos.gov scraper — self-hosted, no third party)
- [x] Form 2 Hilo intake (90-second, warm voice, demographics optional →
      reporting tables only, never day-to-day views) — demographics proven to
      exist ONLY in the submission row; contacts has no demographic columns
- [x] Form 4 portal first-login checklist (4 steps, migrated-client variant)
      — state endpoints live; checklist row auto-created with portal access;
      migrated variant set by the M22 import
- [x] Form 5 framework: modules as data; ship F (tax → complexity inputs),
      B (F&B fires on industry alone — v4.1 fix), I (healthcare → PLLC flag);
      A/C/D/E defined but deferred to their service phases
      (all 9 modules seeded as data with triggers + flag rules — the Phase 2
      no-code builder edits rows, not code)
- [x] Form analytics counters (started/completed/drop-off per screen)
- [x] Prove it: e2e submits for all branches; module-firing rule tests

## M15 — Soto client portal (bilingual)
- [x] Next.js portal, i18n EN/ES from day one (toggle persists to contact,
      applied to outbound comms); Soto brand tokens (Forest Teal #0D3B38,
      Electric Teal #00C9BF, Inter **self-hosted** — no CDN fonts per vendor rule)
- [x] Empty-state 4-step checklist · Dashboard (status plain-English, doc
      requests, unsigned docs, invoices w/ Pay Now, messages, quick actions)
- [x] Document Center (drag-drop/camera, categories, per-file status,
      portal-only policy copy) · My Returns · Sign Documents (status list;
      Docuseal emails signing links — inline embed when http-mode configured)
      · Invoices & Payments · Messages thread · Request a Service (→
      opportunity, 24h commitment) · Get an Estimate (range; Cal.com embed
      lands with M18) · Resource Library EN/ES
      ⛔ internal return-upload UI deferred to the internal app scaffold
      (M19/M20) — the API flow is fully built + tested since M10
- [x] Prove it: full client journey demo on mobile viewport, both languages

## M16 — Referral flows both directions (§7216-gated)
- [x] Form 3 Hilo→Soto transition: pre-filled, BR1–BR6 locked, referral-
      integrity disclosure block (ack + timestamp + policy version logged),
      <60s to submit; Soto lead w/ attribution + Brian notified + warm handoff
- [x] Soto→Hilo referral + both approval queues (one-tap mobile approve);
      portal CTA fires only with consent on file (automations 14–15)
- [x] Prove it: gating tests (no consent → no referral/CTA); disclosure audit
      trail — PLUS live browser demo of the full ES transition journey

## M17 — Meeting intelligence
- [x] Whisper + Ollama containers sized for shared 16GB box (small/medium
      Whisper, ~3–8B quantized LLM); job queue serializes heavy work; flag if
      memory budget doesn't hold (CLAUDE.md) — API fallback text-only
      (compose profile 'intel': faster-whisper small + llama3.2:3b; the
      in-process queue is strictly serial — one recording at a time)
- [x] Zoom webhook → download → transcribe → summary/decisions/actions/referral
      recs → contact record + auto tasks + referral queue + suggested time entry
      (webhook shared-secret now; signed Zoom app validation + download token
      wired at M23 with Brian's Zoom credentials — pipeline behind it complete)
- [x] Browser-based mobile recorder (no app) + voice-memo upload → same pipeline;
      meeting type tagged (upload API complete incl. the "CLIENT — Session
      Type" title convention; recorder UI ships with the internal app M19/M20)
- [x] Prove it: e2e on a sample recording (stub adapters — deterministic,
      full pipeline) — AND the LIVE whisper+ollama run completed this session:
      word-perfect transcript of a TTS speech sample (17.8s), valid strict-
      JSON summary from llama3.2:3b (71.9s; taxNeed detected, action item +
      due date extracted). PEAK MEMORY MEASURED: whisper-small 1.07 GiB +
      ollama/llama3.2:3b 3.83 GiB ≈ 4.9 GiB combined — the 16GB budget HOLDS
      with the serialized queue (no flag needed)

## M18 — Cal.com + booking
- [x] Cal.com container (book. subdomain); event types; **Zoom-only enforced on
      initial consultations**; booking → Form 1 handoff
      (compose profile 'booking' + calcom db-init sidecar; event-type config +
      webhook pointing happen in its admin UI at M23; non-Zoom discovery
      bookings raise a staff flag from our side)
- [x] Two-lane booking (v4.2): Lane 1 discovery collects service-level deposit
      via Stripe (true-up language at checkout, deposit amounts from
      price_book); Lane 2 questions always free
      (slug→deposit-item map + free-slug list are app_settings — admin adds
      event types without code)
- [x] Prove it: booking e2e; deposit charge in Stripe test mode — e2e proven
      via the stub adapter (⛔ live Stripe test-mode still parked on Brian's
      keys, same as M13; identical code path)

## M19 — Dashboards + alerts (Phase 1 set)
- [x] Executive (Brian): open returns by stage+value, revenue MTD/YTD, A/R,
      alerts, capacity, health distribution, deadline-countdown widget
      (MRR shows an explicit Phase 3 note — never an invented number;
      capacity is the open-work proxy until Phase 4)
- [x] Hilo Ops (Jackson): entrepreneurs by status, sessions, referral queues,
      summaries 7-day, milestones 30-day, live funder metrics
      (milestones/grants/workshops carry explicit Phase 2/3 notes; pro bono
      value = hours × price-book rate via funder.pro_bono_rate_item_code)
- [x] ntfy push (Brian+Jackson) + Phase-1 alert set — every module's
      notifications already flow here; warning/critical to leadership pushes
      within 60s via the fast sweep, stamped once
- [x] Prove it: dashboards over seeded demo data ✓ (live browser run) +
      ntfy round-trip verified server-side; ⛔ literal iPhone subscription =
      Brian installs the ntfy app → server + topic saos-alerts (M23 sets up
      auth + the public hostname)
- [x] BONUS: internal app scaffold shipped with the two deferred pages —
      Deliver Return (M10/M15 deferral) + Session Recorder (M17 deferral) —
      plus Alert Center and the staff MFA-enrollment login flow

## M20 — Admin interface core
- [x] Price-book editor (new-version-on-edit semantics + needs_confirmation
      queue for the ⚠ items) · template editor EN/ES with placeholder flag
      badge · staff + permissions · SLA windows + alert thresholds
- [x] Copy changes never require deploy (CLAUDE.md) — templates fully DB-driven
      (proven end to end: clearing a placeholder in admin made the blocked
      M11 envelope sendable — zero deploy)
- [x] Prove it: price edit → new version; old engagements keep old version
      (v2 created future-dated; pinned engagement stayed on v1; the
      calculator followed v2 on its effective date)

## M21 — Ops hardening
- [x] docker-compose.staging.yml (full clone) · Uptime Kuma monitors all
      services · Vaultwarden up (funder-portal creds migrate in, Sheet purged)
      — the creds migration itself is Brian's launch task (RUNBOOK_OPS.md)
- [x] Encrypted backups → Backblaze B2 (pg_dump + MinIO mirror), documented +
      **tested** restore script; quarterly-restore-test reminder
      (restic client-side encryption; local repo until Brian's B2 lands —
      switching targets is an env change only)
- [x] WISP security-summary export (MFA status, audit stats, backup status)
- [x] Prove it: restore drill from a real backup on a clean stack
      (RESTORE DRILL PASSED — 15/15: 7 table counts + 4 bucket object counts
      + 4 volume archives verified against the backup-time manifest)
- [x] (parked from M15) httpOnly-cookie hardening — both apps' sessions moved
      out of sessionStorage into httpOnly SameSite=Lax cookies
- [x] Pin every compose image tag (digest-matched to the running containers)

## M22 — Data migration
- [x] Import pipeline w/ per-record source flags: Dubsado (24–36mo active),
      Zoho (full, skip 36mo+ inactive unless flagged), Grant Tracker →
      grants_received; dedupe/merge into unified schema; enrichment queue for
      gaps — Brian's exports landed 2026-07-06; Login Details columns route
      to a Vaultwarden import file and are stripped BEFORE anything touches
      the database (Brian's instruction; grants_received table comment)
- [x] Migrated-client onboarding sequence staged (EN/ES "we upgraded our
      portal" + magic link + checklist w/ pending signatures) — **not sent**
      until launch gates pass (portal_migration_welcome seeded live,
      admin-editable; 426 staged clients listed in the dry-run report)
- [x] Prove it: dry-run counts/dedupe report reviewed with Brian before commit
      → report reviewed and APPROVED by Brian 2026-07-06; executed same day:
      862 contacts / 617 businesses (637 owner links) / 54 grants /
      611 enrichment entries / 49 skips recorded — DB aggregates verified
      identical to the approved report; 12 credential markers confirmed in
      import_records, zero credential values anywhere in the database

## M23 — Deploy + launch gates
- [ ] Hetzner CPX41 (encrypted volume), DNS subdomains, Caddy/Traefik +
      Let's Encrypt, prod + staging up, Twilio 312 number provisioned (client-
      facing in Phase 2)  ⛔ needs Brian's accounts (Hetzner, DNS, Stripe,
      Twilio, SES prod access, B2, Zoom app, KBA vendor)
      · SES SMTP wired 2026-07-06: IAM keys received, SMTP password derived
        (scripts/wire-ses.ts — rerun at key rotation), AUTH verified against
        us-east-2, .env.production patched. Still on AWS: verify the
        sotoaccounting.com domain identity (DKIM CNAMEs in DNS) + request
        production access (sandbox currently rejects unverified recipients)
      · Stripe wired 2026-07-06: sk_test key in .env.production, auth
        verified, live test-mode e2e passed (scripts/live-stripe-check.ts).
        Still on Stripe: swap in sk_live_ at launch + create the webhook
        endpoint (api subdomain → /webhooks/stripe) which mints the whsec_
      · B2 wired + verified 2026-07-06: key restricted to bucket
        saos-backups, full read/write; RESTIC_REPOSITORY=b2:saos-backups:prod
      · Zoom wired + verified 2026-07-06: S2S app activated, token + API
        probe OK, scopes cover cloud_recording/meeting/user reads; webhook
        Secret Token stored. Post-deploy: register the event endpoint
        (api subdomain /webhooks/zoom, recording.completed)
      · Twilio wired + verified 2026-07-06: account active, existing number
        +1 708 300 0375 stored. NOTE: spec says "312 number" — Brian to
        confirm the 708 number is the keeper or buy a 312 at launch
      · SES DKIM + MAIL FROM records live; TEST EMAIL DELIVERED 2026-07-06;
        production access requested (pending AWS review)
      · Remaining vendor gaps: KBA vendor pick (last unstarted account),
        Stripe sk_live + whsec at launch, Docuseal token at first boot
      · Hetzner PROVISIONED 2026-07-06 (Brian green-lit US pricing):
        saos-prod, CPX41 in Ashburn (id 148628619), IPv4 SERVER_IPV4-in-env-production,
        Ubuntu 24.04 + Docker 29.6.1 via cloud-init, firewall 22/80/443
        only, ssh deploy key ~/.ssh/saos_hetzner_ed25519 (local machine).
        ⛔ Brian: create the 8 DNS records (list in .env.production notes /
        provision script output). Then: LUKS data volume decision, Caddy +
        stack deploy, staging clone, smoke suite
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

### M11 (completed 2026-07-05)
- Docuseal behind an adapter (stub | http via DOCUSEAL_MODE): stub needs no
  instance and mints deterministic ids + synthetic signed PDFs; http talks to
  the real container (API token from its admin UI). Container added to
  compose (:3002, SQLite volume) — verified up and serving. Production send
  refuses stub mode at runtime.
- Envelope lifecycle: CREATE is always allowed (intake queues envelopes into
  the portal checklist), SEND is where all three gates live — placeholder
  block (unsendable in any environment, regression-tested), KBA-passed
  requirement for remote 8879s, production-stub refusal. Completion webhook
  (shared-secret, idempotent on replays): fetches the signed PDF → MinIO
  saos-signed-docs via the audited M10 path → links signed_document_id →
  sets the M7 gate fields (letter/8879 timestamps, §7216 consent via M6's
  record7216Consent). Pipeline unblocking proven end-to-end.
- KBA: pluggable KbaVerifier interface; sandbox adapter + simulate endpoint
  that exists only in sandbox mode; production + no vendor = remote 8879
  refused with a clear 503 (wet path remains). KBA pass auto-sends the
  envelope; failure keeps it unsendable; double-resolution refused.
- Wet path upgraded: records a completed envelope (method in_person_wet)
  linking the scanned document — one queryable signature-status source for
  both paths. Portal "Sign Documents" endpoint scoped to the session contact.
- 52/52 API tests green.
- ⛔ Brian decisions parked here: KBA vendor selection (M23); Docuseal API
  token + template setup when going http-mode; final legal text for letters +
  §7216 (the gate holds until then).

### M12 (completed 2026-07-05)
- computeQuote: resolves the effective price book version (asOf-able), prices
  item×qty lines with EN/ES names, applies bundle rules (bundle_price replaces
  ONE unit of each component; free_with zeroes component lines when the
  condition item is present), separates software pass-throughs from revenue,
  groups totals by recurrence (one_time / monthly / quarterly / semi_annual).
- RANGE semantics (for Brian's review): floor = sum of line minimums;
  top = sum of line maximums widened by pricing.estimate_band_percent
  (seeded 15%) — applied to ONE-TIME work only; recurring is contractual and
  stays exact. Range-priced items (CPA letters $250–500) spread before the
  band. needs_confirmation items flag the whole quote.
- POST /pricing/quote (compute only) + POST /tax-engagements/:id/quote:
  locks estimated_fee_min/max (automation 8), RE-pins the parent engagement's
  price_book_version at estimate time, full line detail into the audit trail.
- Fix en route: price guard now permits literal 0 cents (accumulator init /
  free-marker, never a price) — re-verified against a planted 15000 sentinel.
- 9 golden tests, all deriving from seed values (they SHOULD break if a seed
  price changes). 61/61 API tests green.

### M13 (completed 2026-07-05)
- Migration 0008: invoices (SA-YYYY-NNNN numbers via a global sequence,
  Stripe refs = tokens/ids only, qb_exported_at NULL = pending export) +
  line items (rendered in the client's language at creation).
- Invoice creation: price-book lines (unit prices from the book; pass-
  throughs refused — vendor-billed; range items require explicit amounts) +
  staff-entered custom lines (runtime data, not code literals). Creation
  emails the bilingual portal notice and rolls up onto the tax engagement.
- Automation 12 wired into the pipeline: → filed with a final fee = invoice
  (fee − discount) + ES/EN portal notice + Rene queue notification; filed
  WITHOUT a fee = invoice_needed exception to Rene — never a silent skip.
  Idempotent (already-invoiced engagements skip).
- Stripe adapter (stub | live): stub mints deterministic checkout sessions +
  shared-secret webhooks; live uses the SDK with checkout.sessions.create and
  verifies webhooks via stripe.webhooks.constructEvent against the RAW body
  (encapsulated buffer parser scope). Production checkout refuses stub.
- Portal Pay Now: own invoices only (foreign = 404), checkout URL, session id
  stored. Webhook completion: paid + receipt email + TE payment rollup,
  replay-idempotent, bad secret refused.
- Automation 17: daily date-guarded job — unpaid >14d (setting) → status
  overdue + bilingual reminder + Rene notifyOnce; re-runs duplicate nothing.
- 3 new bilingual templates (invoice_sent, payment_received,
  invoice_reminder). 67/67 API tests green.
- Test-design note: the webhook test initially tripped the scope-creep guard
  (fee > estimate top without a reason) — the system refused correctly; test
  now supplies the reason. Cross-test date sweep in the overdue job replaced
  with a same-date guard assertion.

### M14 (completed 2026-07-05)
- Forms are DATA: Form 1 (4 screens, every OF field incl. the v4.2 additions —
  entity-group question, SSN escape hatch) and Form 2 seeded as definitions;
  all selects admin-editable. Validator honors conditional logic (hidden
  fields never required; selects validate against definition options).
- Public form API: start → per-screen autosave (mobile interruptions) →
  resume by token (wrong token 404; submitted forms refuse writes) → submit
  with sanitized validation issues.
- Automation #1 verified end to end: contact (duplicate detection by email —
  links, never duplicates), business + IL SOS check + stamp, entity group
  from co-owned businesses, tax engagement at intake_started, engagement
  letter + §7216 envelopes QUEUED as drafts (placeholder gate governs
  sending), ES welcome + ES magic link, Rene notified, IRS-letters flag to
  Ana, SSN-by-phone task to Rene. Reserved '_hilo' namespace stripped from
  client input — bridge fields are server-written only (M16 supplies the
  verified transition link).
- Form 5: 9 modules seeded (triggers + flag rules as data). Assembly proven:
  B fires on food_beverage industry ALONE (the v4.1 fix); F for tax feeds
  complexity inputs (states count); I fires for healthcare and its processor
  enforces the PLLC auto-flag (licensed + LLC/sole-prop + IL →
  pllc_conversions record routed to Laura + advisory flag) + the 1099-
  clinician worker-classification flag. A/C/D/E/G/H defined, dormant until
  their services flow.
- IL SOS: stub|live adapter (live = self-hosted ilsos.gov scrape, best-effort
  parse failing safe to not_found); adverse → Laura task + bilingual
  fix-steps email; daily re-check job (90-day cadence setting, date-guarded).
- Analytics: started/submitted per form + drop-off by screen for abandons.
- 3 new templates (welcome_soto, welcome_hilo, sos_fix_steps). 73/73 tests.

### M15 (completed 2026-07-05)
- Next.js 15 portal (11 pages) on the Soto brand system: Forest Teal /
  Electric Teal tokens, "SOTO." wordmark with the Electric Teal period,
  Inter VARIABLE self-hosted (352KB woff2 in-repo — no CDN fonts).
- Hand-rolled i18n (~120 keys EN/ES, zero deps); the toggle PATCHes the
  contact record — proven: Spanish survived a full reload from the server.
- API gap-fill: PATCH /portal/me (profile + language), /portal/returns,
  /portal/resources (+3 starter guides seeded), /portal/service-requests
  (task + Rene notification + 24h due date), /portal/estimate (guided
  answers → price-book quote → RANGE ONLY, no itemization to clients),
  /portal/messages (threads + composer + Rene notification).
- Same-origin /api rewrite proxy (no CORS; mirrors the prod reverse proxy).
  Session bearer in sessionStorage for Phase 1 dev — ⛔ M21 hardening moves
  to an httpOnly-cookie BFF before production.
- LIVE DEMO VERIFIED (mobile 375px, both languages): magic-link sign-in →
  EN dashboard (checklist, plain-English return status with deadline) →
  toggle → ES dashboard → estimate flow returning $530.00–$609.50 for
  MFJ + Sch C + extra state — the exact golden-test value, through the
  whole stack. Single-use link semantics confirmed live (a raced first
  attempt burned the token, correctly).
- Fixes en route: hydration mismatch in the shell (auth state now resolves
  in an effect — Next dev overlay clear); sign-out button got a distinct
  test id (a coordinate-based click in the demo hit it — tool artifact, not
  an app bug, but the markup is better for it).
- packages/db/seeds/demo.mjs: reusable synthetic demo client + magic link
  (reuse-if-exists; the schema's referential integrity resists
  delete-recreate, as it should). .claude/launch.json runs api + portal.
- 73/73 API tests still green; full-repo typecheck + price guard green.

### M16 (completed 2026-07-05)
- §7216 INTERPRETATION (⚠ for Brian's review, documented in
  referrals/service.ts): soto→hilo referrals ALWAYS require signed consent
  (tax client data crossing entities); hilo→soto requires it ONLY when the
  contact already has Soto tax engagements — a pure Hilo entrepreneur has no
  tax return information to protect, and their §7216 gets queued AT the Soto
  intake the transition lands them in. Both sides tested.
- Referral lifecycle: suggest (staff/portal CTA/session flags) →
  pending_approval (ED/COO queue notification) → one-tap approve/decline →
  send. hilo→soto send = warm-handoff email (EN/ES) with an HMAC transition
  link (14-day expiry); conversion happens only when the client submits
  Form 3 WITH the disclosure acknowledged. soto→hilo send = warm Hilo intro.
- Form 3: token-authed prefill (contact + business + services pre-checked
  from session-summary tax-need flags + disclosure text in the client's
  language + policy version); submit REQUIRES the acknowledgement (400
  without), reuses intake automation #1 with server-injected BR1–BR6
  (BR3 from the suggester's role), stamps disclosure_shown_at + policy
  version, notifies Brian, refuses replays (409).
- Disclosure trail is DB-enforced: direct SQL conversion without a
  disclosure timestamp violates the CHECK (tested). Disclosure copy is an
  admin-editable template; policy version is an app_setting
  ('2026-07-05.v1' — bump when the board adopts a revised policy).
- Portal CTA (automation 15): fires on hilo_status='referral' or session
  tax-need; §7216-aware (suppressed for consented-less tax clients, returns
  with consent); tapping it files a referral into Jackson's queue.
- LIVE DEMO: Rosa (ES contact) → transition link → Spanish page with her
  data pre-filled, full disclosure block ("la Directora Ejecutiva de Hilo
  también tiene un cargo en Soto Accounting"), submit disabled until
  acknowledged → success screen → DB shows converted + policy version +
  soto_status lead + br1 true. Under a minute of taps.
- 78/78 API tests green. New: demo-transition.mjs link minter.

### M17 (completed 2026-07-05)
- Adapters (same discipline as Docuseal/KBA/Stripe): Transcriber stub|whisper
  (faster-whisper webservice, self-hosted), Summarizer stub|ollama|api. The
  api fallback is Claude with CLEANED TEXT ONLY — audio never leaves the box
  (MP stack rule). Ollama prompt demands strict JSON, zod-validated.
- Pipeline: recording (MinIO, audited M10 path, new 'recording' category →
  saos-recordings bucket) → transcribe → summarize → auto tasks from action
  items → referral recs into the approval queue (§7216-aware: a gate block
  becomes a staff notification, NEVER a silent skip — tested) → suggested
  time entry (0.25h increments, Hilo-only contacts auto-suggest pro bono).
  Failures land in 'failed' + staff notification; recovery sweep re-enqueues
  stuck recordings (restart safety, on the scheduler tick).
- THE QUEUE IS SERIAL (in-process promise chain): Whisper and Ollama never
  crunch two recordings concurrently on the shared 16GB box.
- Upload API: multipart audio (webm/mp4/mpeg/wav/ogg), contact required
  (recordings file under the client record), v4.2 title convention applied.
  Zoom webhook: secret-checked, recording.completed → meeting row; unfetchable
  recordings triage to 'failed' (contact matching is manual in Phase 1).
- LIVE RUN PROCEDURE (staging, M21/M23): `docker compose --profile intel up
  -d` → `docker compose exec ollama ollama pull llama3.2:3b` → set
  TRANSCRIBER_MODE=whisper SUMMARIZER_MODE=ollama → upload a sample →
  `docker stats` during processing; record peak RSS here. Budget expectation:
  whisper-small ~1GB + llama3.2:3b ~2.5GB, serialized. Image pulls were
  started this session (multi-GB) — deferred rather than block on bandwidth.
- erasableSyntaxOnly caught a constructor parameter property (Node
  type-stripping constraint working as designed). 83/83 API tests green.
- LIVE VERIFICATION (same session, after the pulls finished): TTS-generated
  speech sample → Whisper transcribed it word-perfect (17.8s) → llama3.2:3b
  returned schema-valid JSON (71.9s): taxNeed=true + description, action item
  with due date. The 3B model was conservative on referral recs (missed one
  cue) — acceptable: the queue is human-approved; prompt tuning is a data/
  admin matter. Peak memory: whisper 1.07 GiB + ollama 3.83 GiB ≈ 4.9 GiB —
  16GB budget holds. scripts/live-intel-check.ts is the rerunnable procedure.

### M18 (completed 2026-07-05)
- Cal.com in compose (profile 'booking', :3003) with a db-init sidecar
  creating its own database on the shared Postgres. Admin-UI setup (event
  types, webhook → /webhooks/calcom + shared secret) is an M23 task.
- Webhook drives the two-lane flow: BOOKING_CREATED → find-or-create contact
  (email dedupe) → Lane 1 (slug in booking.deposit_items): deposit invoice
  from the price book (DEPOSIT_1040 $250 / DEPOSIT_BUSINESS_TAX $300 ⚠) +
  Stripe checkout link + bilingual deposit email WITH the true-up language
  ("applies in full toward your final invoice") → Lane 2 (booking.
  question_slugs): task only, never billed. Unmapped slugs accepted + flagged
  to staff; non-Zoom discovery bookings flagged (Zoom-only rule lives in the
  Cal.com event-type config).
- 7 booking tests; 90/90 API tests green.

### M19 (completed 2026-07-06)
- Dashboard endpoints (leadership-only RBAC — preparer 403 tested): every
  figure traces to module tables; deferred sources carry EXPLICIT notes
  (MRR → Phase 3, milestones → Phase 2, grants/workshops → Phase 3) — no
  invented numbers. Pro bono valued from the price book (2.5h × $150 = $375
  asserted in tests).
- Alert Center endpoints (own notifications, mark-read, foreign 404) + ntfy
  push: self-hosted container (default profile), 60-second sweep pushes
  leadership warning/critical once (info never pushes; non-leadership stays
  in-app; re-sweep pushes zero — all tested).
- Internal app (apps/internal, :3005): staff login WITH the full MFA
  enrollment flow (password → setup secret → verify → session), Executive +
  Hilo dashboards, Alert Center, Deliver Return (ATX PDF → client portal +
  stage move), Session Recorder (MediaRecorder → meeting pipeline).
- LIVE VERIFICATION: demo staff account created via CLI → first-login MFA
  enrollment completed in the browser (secret → computed code → session) →
  Executive + Hilo dashboards rendered over dev data → critical test alert
  was pushed by the AUTOMATIC 60s sweep before the manual trigger could run
  → polled ntfy: message present at priority urgent, title+body intact.
- 93/93 API tests green.

### M20 (completed 2026-07-06)
- Price book admin: a new version is a FULL COPY of the current one (73
  items + 3 bundle rules verified) with the listed changes applied inside a
  transaction; the old version closes at the handover date; future-dated
  increases supported (schedule a season adjustment in advance). THE
  prove-it passed: pinned engagement kept v1 while asOf-dated quotes
  followed v2. Confirming a ⚠ seed item is metadata (no version churn) —
  the admin UI surfaces all 12 as the "awaiting your confirmation" launch-
  gate queue with one-click confirm.
- Template admin: EN/ES side-by-side editor, version bump per edit,
  PLACEHOLDER badges sorted first; "Save as FINAL" clears the flag behind a
  confirm dialog and is audited as template.placeholder_cleared. Cross-
  checked against M11: the blocked engagement-letter envelope became
  sendable the moment the flag cleared — copy changes require zero deploys.
- Settings admin: every app_setting editable inline; updates audit old→new;
  unknown keys refused. Staff admin: role dropdown (permissions preview),
  create-with-temp-password (shown once, never emailed), deactivate/
  reactivate — all on M4's audited endpoints.
- RBAC: pricing.edit / admin.settings are '*'-only — Ana's 403s tested
  (spec: "No pricing changes" for preparers).
- Browser-verified: pricing page (v1 badge, ⚠ queue with 12 items,
  new-version staging form) + templates page (27 templates, 7 PLACEHOLDER
  sorted first, 20 live). 98/98 API tests green.

### M21 (completed 2026-07-06)
- Backups: scripts/backup.sh = pg_dumpall (test DBs excluded) + mc mirror of
  all four buckets + tarballs of the Docuseal/Vaultwarden/Uptime-Kuma/ntfy
  volumes + a row/object-count manifest, shipped as a restic snapshot
  (client-side AES — B2 only ever sees ciphertext). Retention 14d/8w/12m.
  Writes backups/status.json (timestamps + counts only, no client data).
- THE prove-it: scripts/restore-drill.sh restored the latest snapshot into a
  brand-new stack (saos-restore-drill project, fresh volumes, shifted ports)
  and PASSED 15/15 checks against the backup-time manifest. The drill runs
  with a READ-ONLY repo mount (--no-lock) — a drill physically cannot damage
  the backups; production can use a read-only B2 key for it.
- Watchdogs: daily restore-drill reminder (nags Brian once per quarter until
  ops.last_restore_drill_at is fresh — fires on day one in prod by design)
  + backup-staleness check (>26h once status.json exists → critical push;
  silent on dev boxes that never back up). Both date-guarded + notifyOnce.
- WISP export: GET /admin/wisp/security-summary (+ ?format=markdown for the
  binder) — live MFA enrollment, session/lockout policy, audit statistics,
  backup + drill recency, vendor list. /admin/wisp page in the internal app.
  Browser-verified showing the day's real snapshot (ca1aa6b4, "fresh") and
  the drill-overdue badge.
- Cookie hardening (parked at M15, landed here): staff + portal sessions now
  ride httpOnly SameSite=Lax first-party cookies via each app's /api rewrite
  — page JS can never read a token (document.cookie verified empty in the
  browser). Bearer-header auth remains for tests/programmatic clients.
  sessionStorage keeps only a boolean "signed in" marker. Sign-out now
  revokes server-side AND clears the cookie (verified: logout 200 → replayed
  cookie 401). CSRF posture: Lax + JSON-only body parsing.
- Ops stack: Uptime Kuma :3006 + Vaultwarden :8094 (signups closed) live on
  pinned images; every compose tag now pinned, digest-matched to what the
  stack was verified against. docker-compose.staging.yml boots a full clone
  under -p saos-staging (verified: healthy on +1000 ports, 0 tables, own
  buckets — nothing shared). docs/RUNBOOK_OPS.md: monitor list, cron line,
  drill procedure, Vaultwarden launch task.
- Bug found by the new nag + fixed at the root: ntfy titles travel as HTTP
  headers (Latin-1) — em-dashes/Spanish text made fetch throw. Pusher now
  RFC-2047-encodes non-ASCII titles; verified end to end (em-dash decoded
  correctly in the delivered ntfy message, pushed_at stamped).
- Compose gotcha encoded in both override files: ports lists MERGE across
  -f files; !override prevents staging/drill from binding dev ports.
- 106/106 API tests green (cookies ×3, WISP ×2, watchdogs ×2, header
  encoding ×1 added); price guard clean.

### M22 (completed 2026-07-06 — dry run reviewed by Brian, then executed)
- EXECUTED after Brian's approval: 862 contacts created / 0 duplicates,
  617 businesses + 637 owner links, 54 grants, 611 enrichment-queue rows,
  49 skips recorded. Post-load verification: source/status aggregates match
  the approved report line for line; native records untouched; exactly 12
  '[routed-to-vaultwarden]' markers and zero credential values in the DB.
- Brian's remaining launch-side steps: import vaultwarden-import.json
  (Tools → Import → Bitwarden json), DELETE that file, purge the Sheet's
  credential columns; work the report's review lists in the CRM (18
  no-activity clients, 35 business-name billing names, 59 same-name pairs).

#### Build notes
- Importer (apps/api/src/migration/*): zero-dep RFC-4180 CSV reader + exceljs
  for the Grant Tracker xlsx (read path only; its uuid advisory sits in the
  write path we never call — noted like the postcss precedent). Pure rule
  engine (plan.ts) so the dry run IS the run; executor is one transaction,
  idempotent (re-runs mark duplicates), never UPDATEs native records.
- Sources: Dubsado clients+invoices+transactions (name-keyed) + PROJECTS
  export (EMAIL-keyed — added by Brian mid-build; rescued 38 clients whose
  billing runs under business names, active 388→426, unexplained skips
  56→18) · Zoho backup (contacts/accounts/leads/junction; Brian's custom
  EIN/Entity/Formation/IRS-code fields map onto businesses) · Grant Tracker
  (3 year sheets, month-label section rows skipped).
- CREDENTIAL ROUTING (Brian's rule, enforced at parse time): Login Details
  columns (split 2024/25 + combined 2023 shapes) separate BEFORE grant rows
  exist; import_records.raw carries '[routed-to-vaultwarden]' markers; the
  test suite greps the whole DB for a planted secret and finds nothing.
  12 real credential items → migration-data/vaultwarden-import.json
  (Bitwarden format) for Tools→Import, then delete + purge the Sheet.
- Dry-run numbers (as-of 2026-07-06): 862 contacts (426 active Dubsado
  clients, 417 Zoho leads, 19 unconverted Zoho leads; 604 Zoho rows merged
  fill-don't-overwrite), 617 businesses (263 personal shells + 142
  ownerless accounts skipped), 54 grants ($771K approved tracked), 49
  skipped, enrichment queue seeded (523 missing industry / 514 EIN).
  Review lists in the report: 18 no-activity clients, 35 business-name
  billing names, 59 same-name pairs, unmapped entity strings (LL, COR).
- Migration 0010: record_source gains 'grant_tracker' (full enum-rebuild
  down). portal_migration_welcome template seeded (EN/ES, live) — staged
  onboarding sends at launch via the existing portal-access grant.
- 112/112 API tests green ×2 (migration suite ×6 on synthetic fixtures).
