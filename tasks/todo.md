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
- [x] Hetzner CPX41 (encrypted volume), DNS subdomains, Caddy + Let's
      Encrypt, prod stack up — DEPLOYED 2026-07-07 on Brian's directive:
      code shipped via git archive (tracked files only) + .env; LUKS2 data
      volume auto-unlocks via root-disk keyfile (crypttab+fstab, reboots
      unattended per Brian; recovery passphrase staged at
      /root/saos-luks-recovery.txt for his Vaultwarden pickup); postgres/
      minio/docuseal/vaultwarden data verified ON the encrypted mount;
      13 services up incl. intel (whisper+ollama, model pulled) + booking
      (Cal.com); migrations 10/10 + production seeds (no demo data);
      ALL EIGHT domains serving over Let's Encrypt TLS (api /health 200
      against prod DB); nightly encrypted-backup cron installed.
      · Brian's admin account created on prod (create-staff, ceo) +
        /account change-password page shipped 2026-07-07
      · M22 PROD IMPORT EXECUTED 2026-07-07 (prod dry-run matched the
        approved report exactly; Brian's explicit go): 862 contacts /
        617 businesses + 637 owner links / 54 grants ($9.49M tracked
        across all statuses, incl. the $7.46M denied application) /
        611 enrichment rows / 49 skips;
        aggregates verified in prod DB; 12 credential markers, 0 credential
        values; exports staged on the LUKS volume during the run and
        REMOVED after; prod import-report fetched to
        migration-data/import-report-prod.md
      Deliberately still pending: staging clone on the server · console
      wiring per RUNBOOK "Launch wiring" (Twilio number webhooks, SNS
      topic, Zoom events, Stripe webhook→whsec then STRIPE_MODE=live) ·
      Docuseal/Cal.com/Kuma first-boot setup · Twilio 312 port post-launch
      (config swap) · migrated-client onboarding SEND (staged only —
      launch-gate action)
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
- [x] Launch-gate trio (Brian, 2026-07-06): (1) Twilio inbound SMS/voice on
      +1 708 300 0375 — X-Twilio-Signature validated, matched texts land in
      the client's message thread, Rene notified, STOP revokes consent
      (rollup + consent event + audit), voice greeting is the admin-editable
      twilio_voice_greeting template; 312-715-8599 ports later as a
      TWILIO_PHONE_NUMBER swap. (2) SES bounce/complaint handling via SNS —
      RSA signature verification against Amazon certs, auto-confirms its own
      subscription (amazonaws-host-validated), feeds the existing Rene
      bounce-task flow + audit. (3) SMS consent: TCPA/A2P disclosure (EN+ES)
      now IN both intake form definitions at the point of consent, and
      intake writes a versioned consents EVENT (type sms, intake_checkbox)
      — the opt-in evidence the privacy page + A2P campaign reference.
      7 new tests; 119/119 green. Console wiring steps in RUNBOOK_OPS.md
      "Launch wiring".
      · Hetzner PROVISIONED 2026-07-06 (Brian green-lit US pricing):
        saos-prod, CPX41 in Ashburn (id 148628619), IPv4 SERVER_IPV4-in-env-production,
        Ubuntu 24.04 + Docker 29.6.1 via cloud-init, firewall 22/80/443
        only, ssh deploy key ~/.ssh/saos_hetzner_ed25519 (local machine).
        ⛔ Brian: create the 8 DNS records (list in .env.production notes /
        provision script output). Then: LUKS data volume decision, Caddy +
        stack deploy, staging clone, smoke suite
- [ ] LAUNCH GATE (new 2026-08-09): the 5 engagement-letter templates must
      carry the late-fee disclosure block AND have has_late_fee_disclosure
      set in Admin → Templates before any late fee can ever apply. The seed
      added the block to the placeholder bodies, but existing rows were left
      untouched (admin edits win) — so today every letter reads
      disclosure = false and fees are impossible. Flip it with the final
      legal text, not before.
- [ ] Launch-gate checklist (verified counts as of 2026-07-07):
      · 7 PLACEHOLDER templates (§7216 use/disclose + 5 engagement letters)
        remain BLOCKED from production sends — gate enforced in code + test;
        Brian clears each in Admin → Templates when final legal text lands
      · 12 ⚠ price confirmations open in the seed (Brian said "six" — the
        real count is twelve: the spec's 7 conflicts expanded per-item plus
        the payroll billing-unit question) — one-click confirm in
        Admin → Pricing
      · SNS bounce/complaint handling BUILT + signature-verified (committed
        124bac5) — wire the SNS topic post-deploy per RUNBOOK Launch wiring,
        BEFORE any real-client mail goes out
      · SMS consent checkbox + TCPA/A2P disclosure (EN/ES) live in both
        intake definitions; consent EVENT recorded (124bac5)
      · Twilio inbound wired to +1 708 300 0375; 312-715-8599 ports later
        as a TWILIO_PHONE_NUMBER config swap (124bac5)
      · restore tested (M21 drill PASSED) · MFA enforced (M4, tested) ·
        audit export works (WISP, M21) · portal copy EN/ES review by
        Brian/Jackson still pending
- [ ] Prove it: smoke suite against staging; `docker-compose up -d` from clean
      server per MP one-command requirement

─────────────────────────────────────────────────────────────────────────
# PHASE 1.5 — SPEC v4.3/v4.4 REFACTOR (sequenced by Brian, 2026-07-07)
Spec: SAOS_Fable_Master_Prompt_v4.4.md + SAOS_Onboarding_Forms_Spec_v4.4.md
(addenda equal in authority) · UI reference for ALL portal/ops screens:
docs/SAOS_Wireframes.html (customer / owner / preparer personas).
✓ Twilio RESOLVED (Brian 2026-07-07): config is current, spec §Communication
is stale — 708-300-0375 is the live number (A2P registered; no 312 inventory
existed); 312-715-8599 stays the published office number on Google Voice and
ports post-launch as a Messaging Service config swap. Corrected spec file
incoming from Brian. System stays number-agnostic.
✓ Notification-vs-task design principle approved as stated (alerts = channel,
tasks = work). Trello JSONs arriving in migration-data this week.

## M24 — Authoritative deadline-table migration (v4.3) ✅ 2026-07-09
- [x] return_type coverage extended: 1041 (Apr 15/Sep 30 — NOT a +6mo
      pattern), 1120-F US office (Apr 15/Oct 15), 1120-F no US office
      (Jun 15/Dec 15), 1040 expat (Jun 15 auto/Oct 15), FBAR rider
      (Apr 15/Oct 15 automatic), 990 ORIGINAL May 15 (already correct in
      code; spec text corrected) — migration 0011 + THE_TABLE constant
      mirroring the spec row-for-row (fiscal = month 4, month 5 for 990)
- [x] BUSINESS-DAY ROLL added per the spec's roll rule: weekends + observed
      federal holidays + DC Emancipation Day. Proof case: 1040 TY2027 →
      2028-04-18 (Sat 15th → Sun Emancipation observed Mon 17 → Tue 18),
      matching the IRS calendar
- [x] Estimated-payment dates (Q1–Q4, rolled) on the staff deadline board
      — always shown, toggle-independent
- [x] Client estimate-reminder toggle (portal notification settings card,
      default ON): /portal/me carries it + nextEstimate; dashboard shows
      the next due date; T-7 bilingual reminder job (template
      estimated_payment_reminder, live) honors the toggle; FBAR's automatic
      extension excluded from T-21 decision lists
- [x] Prove it: table-driven tests for EVERY spec row (calendar + fiscal
      incl. 990-month-5 and 1041), compound-roll case, FBAR exclusion,
      toggle-gated reminder job idempotence — 121/121 green

## M25 — Unified task system (v4.4 — the connective layer) ✅ 2026-07-09
- [x] Schema (migration 0012, all additive): boards/columns, comments,
      checklists, task-documents, templates, tasks gain engagement link +
      client_visible + sop_link + board placement; time_entries gain
      task/engagement links + start/stop + rate_item_code (price-book) +
      invoice marker. Open enrichment rows BACKFILLED as tasks in-migration
- [x] Views: My Tasks · client-record tasks (API) · owner rollup
      (approvals + stalled/day-60/voucher counters wired for M26) · team
      workload · kanban boards (custom columns, move controls; drag polish
      = M28 wireframe pass). Internal UI: /tasks, /tasks/boards, Executive
      "Needs you today" tile
- [x] Client to-dos in portal: ONE list aggregating staff-added
      client-visible tasks + open upload items + pending signatures —
      auto-close inherent (upload fulfills its item); client check-off for
      staff-added items; internal tasks never leak to the portal (tested)
- [x] AI auto-creation from sessions — already gate-free for internal
      tasks (M17); confirmed against v4.4
- [x] Recurring checklist templates (create + instantiate per client) ·
      lightweight time log (manual + start/stop timer, 0.25h rounding,
      rate_item_code for billing flow-through) · Trello importer BUILT +
      tested on synthetic exports (idempotent; done-list detection;
      assignee name-matching) — ⛔ RUN awaits Brian's Trello JSONs
- [x] LOCAL-WORK-ITEM MIGRATION (audited 2026-07-07 — modules whose work
      items must become task objects):
      1. notices — notices exist w/ notifications only → owned Ana-Maria
         ticket-task per notice (v4.3 flow 1)
      2. billing/AR — invoice_overdue + invoice_needed notifyOnce → dunning
         call tasks + work-pause states (v4.3 flow 4)
      3. tax/extension — T-21 decision list (query+email only) → batch
         work items + Brian review task (v4.3 flow 3)
      4. documents chase — reminder/7-day alert notifications → D14 Rene
         call task + D30 stalled flag (ladder)
      5. referrals — approval-queue rows → approval tasks (auto-close on
         decision)
      6. enrichment_queue — module-local table (611 open rows in prod) →
         task per contact w/ gap checklist; table stays as auto-resolution
         source of truth
      7. crm/health — red-transition alert → check-in task for manager
      8. comms — unmatched SMS / missed-call notifyOnce → Rene phone
         tickets (v4.4 "My Tasks" example)
      9. admin/ops — restore-drill due + backup-stale → Brian tasks
         (owner rollup)
      10. booking — not-Zoom + unmapped-event flags → follow-up tasks
      11. forms — IRS-letter intake flag + onboarding module flags →
          routed tasks
      (Correct already: booking lane-2, annual-report, SOS adverse, portal
      service request, magic-link bounce, meeting auto-tasks — they gain
      the new fields + SOP links but stay as-is.)
      Notifications REMAIN the alert channel (push/read state); tasks are
      the WORK channel — every alert that demands action now carries one.
      → ALL 11 MIGRATED 2026-07-09: notices (owned ticket, closes on
      resolve — tested) · billing (dunning + fee-needed tasks, paid
      auto-close) · extension (Brian review task per decision list) ·
      documents (non-response call task, closes on docs-received) ·
      referrals (approval task, closes on decision) · enrichment (task
      follows the gaps — tested lifecycle) · health (red check-in task) ·
      comms (unmatched-SMS + missed-call phone tickets) · ops (drill +
      backup tasks) · booking (unmapped/non-Zoom tasks) · forms
      (IRS-letter triage + onboarding-flag tasks)
- [x] Prove it: 8-test suite green (dedupe/auto-close, views, templates,
      client to-do aggregation + check-off + internal-task isolation,
      notice ticket lifecycle, enrichment lifecycle, Trello idempotence,
      intern execute-own-only scope) — 129/129 total

## M25.5 — v4.5 task-UX revision (Zoho parity; docs/reference = benchmark)
- [x] Docs swapped to v4.5 (both specs + CLAUDE.md) · docs/reference/ holds
      the 3 Zoho screenshots · lessons.md: "match the tool being replaced"
- [x] Status set (migration 0013): open→not_started, done→completed,
      + waiting_for_input + deferred (cancelled stays internal). RENAME
      VALUE converts rows in place; all status literals swept (crm, portal
      to-dos, dashboards capacity, Trello importer, StatusBody, tests)
- [x] Waiting-for-input IS the escalation ladder: waiting_since +
      ladder_rung per task; runLadderJob (daily, date-guarded, ladder.days
      setting) fires D3 portal-reminder email → D7 SMS nudge (TCPA
      consent-gated, email fallback; comms/send-sms.ts built) → D14 Rene
      call task → D30 STALLED task for Brian; only the highest
      newly-reached rung fires; every rung audited on the client record.
      Client-visible tasks arm the clock at creation (v4.4 to-do ladder)
- [x] Recurrence (recur_freq/interval): completing a repeating task spawns
      the next occurrence (month-end clamping); reminders (remind_at →
      assignee notification via 15-min tick, exactly-once)
- [x] Dual Contact + Business lookups on tasks (business_id + /businesses
      search endpoint) · tags (GIN-indexed) · parent_task_id chains
- [x] Filter rail: /tasks/search — q, status[], priority[], owner/
      unassigned, contact, business, tag, source, client-visible, due
      (overdue/today/week/range), created-by/delegated-by, untouched-N-days,
      sortable allowlist. task_views table: saved views private or shared
      (list/kanban/calendar/timeline + filters + sort + columns + group_by)
- [x] Record actions: general PATCH (inline edit), POST /tasks/bulk (mass
      status/owner/priority/due/tags), duplicate, close-and-follow-up;
      GET /tasks/layout serves the admin-editable tasks.layout setting
- [x] Internal UI rebuilt (thin v1 replaced): view switcher List/Kanban/
      Calendar/Timeline · filter rail · saved-views chip bar w/ system
      views (My Open/All Open/Waiting/Overdue) · dense sortable list w/
      inline status/priority/due/owner edits + column chooser + multi-
      select bulk bar (incl. mass complete) · kanban group-by any picklist
      w/ column counts + empty columns · month calendar · 4-week timeline
      by owner · create/edit modal rendered from tasks.layout w/ Save and
      New, dual lookups, Reminder, Repeat, Tags, Edit Page Layout
      affordance · workload table w/ v4.5 status columns
- [x] Meeting auto-tasks renamed to the live convention:
      "Meeting: {Client} — {Session type}" (action item = description)
- [x] Prove it: 137/137 green (8 new v4.5 tests: waiting stamps/clears,
      ladder D3 + highest-rung-only + D30 rollup + date guard, recurrence
      spawn + no double-spawn, reminder exactly-once, filter-rail combos,
      saved-view sharing/ownership, bulk ops, duplicate/follow-up/PATCH)
- [x] Live-board flags RESOLVED (corrected v4.5 master prompt, July 11):
      · AG990-IL folded into the deadline table (M24 artifact): return_type
        gains 'ag990il' (migration 0014); THE_TABLE row = last day of
        FYE+6 (Jun 30 calendar-year), 60-day AG extensions on written
        request clamped at two, INDEPENDENT of the federal 990's extension
        clock; deadline dashboard derives a per-client AG990-IL row from
        FYE for every IL-registered nonprofit — table-driven tests added
      · Hector Pardo / Michelle Zhang: DO NOT create — roster stays as-is;
        Trello/Zoho migration maps their historical items to unassigned
        (importer already does; ruling documented in trello.ts) or Brian

## M25.6 — Task dependencies (v4.6 — lands inside the task-system work; schema) ✅ 2026-07-12 deployed
- [x] task_dependencies table (blocked_task_id ↔ blocker_task_id, no
      self/cycles); blocked tasks CANNOT complete before their blockers
      (status route + portal check-off + bulk both refuse); completing or
      cancelling a blocker cascades unblock notifications to assignees
- [x] Blocked tasks visually distinct (list badge + kanban); manage
      blockers from the task modal; open_blockers in search payload
- [x] Prove it: block/refuse/unblock-notify/cycle-reject tests
      (oldest-year-first auto-chaining is resolution-lane scope → M26.5)

## Ops interlude ✅ 2026-08-09 (Brian's resume directives, worked in order)
- [x] Formal green on the Twilio fixture swap (143/143 after fixing three
      calendar-rotted job tests: now()-relative fixtures vs fixed asOf)
- [x] Restore drill: FIRST REAL PASS (15/15 vs B2 snapshot 77f4aa09) —
      exposed that the backup cron was NEVER INSTALLED on prod (zero
      backups since launch). Cron installed + env-loader fixed + exec
      bits set + deploy.sh now (re)installs it every deploy; drill pass
      recorded (prod+dev); quarterly drill task auto-closes on a
      recorded pass (creation already existed, assigned to CEO)
- [x] Mobile defect pass: no page-level h-scroll at 390px on all 14 ops
      routes (probed + screenshotted); filter bottom sheet ("Filters·n",
      chips stay visible); task cards at phone width; nav fade
      affordance; lessons.md: phone screenshots ship with every UI
      milestone
- [x] Inbound attachment policy (email+MMS): accept→scan→quarantine on
      thread→warm ack w/ portal link (block-and-nudge, both channels)→
      Inbox review→confirm-tap filing w/ origin audit; unmatched =
      triage-only; infected hard-blocked; ClamAV profile OFF by default
      (~1.3GB flagged); email receiver seam until Phase-2 inbound mail
- [x] Client-health baseline: stored bands — gray never-engaged /
      yellow only on real signals / green active+clean; dev recompute
      426 gray · 1 yellow · 0 red (prod recompute lands with deploy)
- ⛔ NOT YET DEPLOYED: migrations 0016+0017 + all of the above are
      committed locally; deploy on Brian's word (impact note in report)

## M26 — Seven v4.3 operational flows ✅ ALL SEVEN 2026-08-09 (consume M24+M25)
- [x] KILL SWITCHES (Brian's directive 2026-08-09, prerequisite for the rest):
      every client-acting automation registered in `automations` + gated by
      isAutomationEnabled(), ALL SEEDED OFF; Admin → Automations arms them
      individually (audited). Gate covers the client SEND only — internal
      alerts/tasks/A-R truth keep running and each job counts what it
      suppressed. Ladder freezes rungs while disarmed so arming later can't
      dump everyone at D30. CLAUDE.md rule added.
- [x] 1. E-file rejects ✅ 2026-08-09 (Filed→Rejected re-queue, perfection-period
      clocks: 10d business/5d individual) + notice tickets w/ client-
      visible plain-language status EN/ES + notice billing from price book
- [x] 2. Entity-group workflow ✅ 2026-08-09: consolidated packet, ONE bundled Docuseal
      envelope/KBA for group 8879s, billing mode consolidated|per-entity,
      per-entity estimates + rollup
- [x] 3. Escalation ladder ✅ (v4.5) + auto-extension batch ✅ 2026-08-09 —
      sweep DERIVED per engagement (original due date − 10-day offset,
      admin-editable; Brian corrected the spec's fixed Mar 25 / Apr 1
      cutoffs, which fell AFTER the Mar 15 deadline and protected nothing).
      Batches key on the deadline they protect; never sweeps on/after it
      (D3 portal/D7 SMS/D14 Rene call/D30 STALLED)
      on every waiting state + auto-extension batch (Mar 25 business /
      Apr 1 individual cutoffs, Brian reviews before filing)
- [x] 4. AR dunning ✅ 2026-08-09 (invoice ladder ×3/10d → call task → 30d work pause) +
      late fees 1.5%/mo 30d+ (price-book rate, engagement-letter
      disclosure GATE, deposits/credits net first) + late-fee disclosure
      block added to all engagement-letter templates (stay placeholder)
- [x] 5. Books close cycle ✅ 2026-08-09 (Marian workbench): per-cadence checklists,
      statements AUTO-POST to portal on close, calendar cross-check
      (attach to existing session; task only when none)
- [x] 6. Grant vouchering tracker ✅ 2026-08-09: Brian-operated, status-only
      (Due→In progress→Submitted→Reimbursed), period reminders + T-7
      funder-deadline, dashboard tile — NEVER generates files
- [x] 7. Stalled-onboarding rescue ✅ 2026-08-09: Deposit→Questionnaire→Docs→Complete
      pipeline + ladder; deposits held as credit, Day-60 to Brian, never
      auto-refunded
- [x] Prove it ✅ 163/163: per-flow integration tests incl. reject re-queue clock,
      group envelope bundling, ladder timing, letter-gated late fee
      refusal, close cross-check both branches, Day-60 surfacing

## M26.5 — Tax resolution lane + Bundle builder ✅ 2026-08-09 (v4.6)
- [x] Resolution intake: unfiled-years multi-select per return type
      (6-year norm default, per-client override) + per-year books-exist
      matrix (Partial/No pairs a reconstruction engagement); quote accept
      spawns ONE engagement per year per return type + reconstruction
      pairs, auto-chained oldest-year-first via task dependencies
- [x] Authorization gating: 8821 Docuseal at onboarding (before document
      work; signature auto-creates the transcript-request task); 2848
      swaps in per-engagement when representation begins, scope years
      tracked
- [x] Prior-year deadline mode: refund-statute expiry countdown (3 years
      from original due date — derives from THE_TABLE, never hardcoded),
      6-year lookback boundary, SFR-risk flag; client portal shows the
      client's own statute clocks
- [x] Filing-method derivation (hard rule): current + 2 prior years →
      e-file/KBA lane; older → paper lane (print-packet checklist, wet
      8879, certified-mail task w/ tracking + mailed-date, distinct
      closing checklist). System derives; staff never choose
- [x] Resolution engagement types: penalty abatement + installment
      agreement (price book, seed Specialized $500 each ⚠ confirm),
      2848 required
- [x] Bundle builder: bundles compose from price_book items ONLY (fixed +
      optional components, percent/fixed discount or manual override,
      effective-dated + versioned); sellable (quote builder + shareable
      link + campaign attribution); +$100/return surcharge >2 years back
      AUTOMATIC wherever prior-year returns are quoted; seed S-Corp
      Conversion Package + Tax Resolution Package
- [x] Prove it: per-year spawn + dependency chain e2e; paper-lane
      derivation table test; statute-clock derivation tests; bundle
      price = components − discount (no ad-hoc literals); surcharge
      auto-applies bundled AND unbundled

## LAUNCH READINESS → see tasks/launch-readiness.md
(Single page, generated from the live production DB: the 4 hard blockers,
vendor state, migration state, automation arming order, and the decisions
only Brian can make. Regenerate after any gate clears.)

## M27 — Remaining v4.4 modules (task system shipped in M25)
- [x] Quote builder: live-quote from price book → quote record on lead →
      portal link EN/ES → accept = engagement + deposit checkout, zero
      re-entry; declined/expired → leads pipeline w/ reason; pipeline
      stages Call booked→Quoted→Deposit→Onboarding→Client + conversion
      metrics by stage/referral source ✅ 2026-08-09
      (migration 0027; quotes.ts + pipeline.ts + quote-routes.ts;
      /pipeline internal board+builder; portal /quote/[token] public page)
- [x] Reports & KPIs: revenue by line/month, AR aging, pipeline
      conversion, session utilization, team throughput, client counts,
      referral-source performance — CSV export, configurable tiles
      ✅ 2026-08-09 (migration 0028; reports/service.ts registry +
      csv.ts + routes.ts; /reports internal page, table on desktop /
      cards at 390px)
- [x] Announcements + review requests: segmented broadcast (SES/Twilio,
      EN/ES) w/ CAN-SPAM unsubscribe + TCPA opt-out + suppression at
      send + approval gate; milestone-triggered Google-review asks
      (throttled, opt-out, never post-notice/dispute); portal broadcast-
      consent settings beside the estimate toggle ✅ 2026-08-09
      (migration 0030; comms/broadcast.ts + review-requests.ts;
      /announcements internal, portal /unsubscribe/[id]/[token])
- [x] SOP knowledge base: versioned searchable wiki per role/process;
      task types carry "how to do this" links (CLAUDE.md: task-generating
      features without SOP hooks are incomplete); Whisper-seeded drafts
      w/ approval before publish ✅ 2026-08-09
      (sops/service.ts + routes.ts + task-types.ts; /sops internal page;
      scripts/check-task-sop-hooks.mjs wired into root `npm test` so a new
      task type without an SOP hook fails the BUILD, not a review)
- [x] Hilo events (Eventbrite replacement): bilingual pages, capacity
      caps, confirm/remind email+SMS, check-in list, post-event follow-up
      → Hilo CRM + §7216-gated referral pipeline ✅ 2026-08-09
      (events/service.ts + routes.ts; /events internal, portal /events/[slug];
      capacity held by a DB constraint, not a counter)
- [x] Prove it: quote→engagement zero-re-entry e2e; broadcast suppression
      + approval-gate tests; SOP link on every task type; event
      registration → check-in → follow-up e2e ✅ 2026-08-09

## M28 — Wireframe conformance pass ✅ 2026-08-09 (see tasks/m28-wireframe-conformance.md)
- [x] SAOS_Wireframes.html applied as the UI reference DURING M25–M27
      builds; this milestone is the final sweep: customer portal, owner
      ops, and preparer screens conformed; Brian/Jackson EN/ES copy
      review rides along (existing launch-gate item)
- [x] All five gaps closed 2026-08-09: client packet, preparer queue, client
      notice view, SESSION RECAPS (v4.2 #6 module), public intake renderer.
      Nine partials: Brian ruled do-not-build — signals-as-tasks is the design.
- [x] Prove it: all 24 wireframe steps verdicted in
      tasks/m28-wireframe-conformance.md; 3 of 5 real gaps closed and tested
      (client packet, preparer queue, client notice view). 2 remain open and
      named: session recaps (a missing MODULE) and the public intake renderer
      (whose §7216 consent template is still PLACEHOLDER anyway).

## M29 — Legal package v3 FINAL: Master + Schedules ✅ 2026-08-10 (awaiting deploy approval)
- [x] Restructure: five per-service-line engagement letters → ONE Master
      Engagement Agreement + Service Schedules A–E, packet assembling
      dynamically from the client's service selection. One signature covers
      every schedule attached at signing; services added later are accepted
      per-schedule in the portal, no re-execution (Master §1)
- [x] All text loaded verbatim from SOTO_Legal_Text_Package_FINAL_v3.docx;
      every PLACEHOLDER flag on an ACTIVE template cleared (0 remaining);
      the five old letters RETIRED with a recorded reason, not deleted
- [x] `has_late_fee_disclosure` moved to the Master and set true — after
      verifying Master §3 (1.5%/month after 30 days) against the
      `LATE_FEE_MONTHLY` price-book metadata rather than trusting the heading
- [x] §7216 presentation split: USE to every client at onboarding AFTER the
      Master signature, benefit-framed; DISCLOSE only to a Hilo bridge or at
      an actual referral moment; both optional, neither ever conditioning
      service; nothing presentable before the signature exists
- [x] English controls: every v3 template ships `needs_es_review = true` with
      NO Spanish body; the render path falls back to English and logs it;
      admin ES queue + approval endpoint; editing an approved translation
      re-queues it and clears the stale approval
- [x] Prove it: 15 new tests in `apps/api/test/master-schedules.spec.ts`
      (one-signature-covers-attached, no-re-execution incl. the DB index,
      portal per-schedule acceptance, schedule-before-Master refusal, A/B
      split from RETURN TYPE, attest refusal, ES fallback ×3, consent
      presentation ×4). Root `npm test`: **285/285 green**
- [ ] **Deploy** migration 0038 + the legal v3 seed — awaiting Brian's approval
      (production still reads 7 placeholders / 37 migrations until it lands)

## M30 — Rehearsal walkthrough findings #1–#12 (Brian's dress rehearsal, 2026-08-11)
Findings numbered as Brian reported them, with his rulings. Backend-complete-but-
unreachable was the theme: see lessons.md "API-level verification proves capability,
not reachability."
- [x] **#1** Pipeline card not clickable → whole card is a `<Link>` to `/clients/[id]`
- [x] **#2** No client directory at all → `/clients` list (table desktop, cards at
      390px, error state with retry) + nav entry; `/clients/[id]` reachable
- [x] **#3** (A) Direct URL supplied so Brian could keep moving that night
- [x] **#4** Returns card read as if it held engagements → copy distinguishes
      engagements from returns; the missing packet action added
- [x] **#5** Duplicate quote from a real double-submit → duplicate guard on client
      selection; the 8/10 marked canonical, dupe `6d3e20d4` VOIDED (migration 0042
      added `void` to `quote_status` rather than misfiling as `declined`, which would
      have corrupted the lost-reasons report), engagement `94fce63c` withdrawn
- [x] **#6** Packet card not actionable → explicit **Review document** (text/html
      render route) and **Send for signature** buttons, plus "Grant portal access
      first" when the client has no portal user
- [x] **#7** Packet send pointed at Docuseal → repointed at portal-native signing.
      **Option 2 is permanent**: portal-native IS the engagement-packet signing path;
      Docuseal stays for 8879s only (Pub 1345 KBA)
- [x] **#8** After signing, the portal re-offered Schedule A as "a service we added
      since then" — "pending" meant not-yet-accepted, which every schedule is before
      the Master exists. Fixed: `const pending = preview.alreadySigned ? preview.newSchedules : []`
- [x] **#9** "Book your consultation" Go button routed to Estimates → miswire fixed
- [x] **#10** Signing dead-ended → returns to the home checklist with step 2 marked
      done (`step_sign_docs_at = COALESCE(step_sign_docs_at, now())`)
- [x] **#11** Messages had no attachment affordance → attach control; ruling was
      "reference plus immutable text". Body keeps `[Attached: receipt.pdf]` forever;
      `messages.document_id` is ON DELETE SET NULL so the link degrades to plain text
      and the thread never develops a hole. Brian's requirement — Messages files stamp
      IDENTICAL provenance to direct uploads, no silent fork — enforced by a
      DIFFERENTIAL test (every `documents` column compared both ways + no
      `source`/`origin`/`message_id`/`via` column may exist), mutation-proven to fail
- [x] **#12** §7216 consent rendered under the signature confirmation → isolated
      `/consent` screen, nav suppressed, duration stated, equally-weighted decline.
      **Launch-gate-tier rule added to lessons.md** per Brian: same class as
      no-hardcoded-prices. Rehearsal consent row stands (test client)
- [x] Also folded in: Caddy `lb_try_duration 10s`; `merge-env.sh` so a deploy can
      never blank a server-set secret; container-health cron
- [x] Root `npm test`: **338/338 green** (285 → 334 → 338)
- [ ] **#13 — LOGGED, NO CHANGE (awaiting Brian's deliberate ruling)**: the portal
      shell decides "signed in" from a `sessionStorage` marker (`saos_portal_authed`),
      not from the session cookie. A client with a VALID cookie who closes the browser
      is shown the sign-in page and must request a fresh magic link.
      **Mobile cost, stated explicitly** (Brian's note): iPhone Safari clears
      sessionStorage on tab close, so valid-cookie clients on iOS re-request a magic
      link EVERY visit — and the friction lands hardest on the document-upload
      surface, which is exactly where a client is most likely to bounce.
      Security argument for keeping it: a closed browser on a shared or family
      computer does not leave the portal open.
      This is a security-vs-friction tradeoff **to be decided deliberately, not
      defaulted**. Found during the booking walkthrough; restraint on changing auth
      inside a booking task was the right call, so nothing was touched
- [ ] **#14 — PORTAL UPLOADS ARE NOT VIRUS-SCANNED (found 2026-08-12, needs Brian's
      ruling before building)**. Correcting my own claim: when I described the #11
      deploy I said the Messages attachment route "reuses the existing upload path,
      ClamAV scan included." That was wrong. `scanBuffer()` is called from exactly one
      place — `modules/comms/attachments.ts`, the inbound EMAIL/MMS attachment path.
      `documents/service.ts` never scans, and the `documents` table has no
      `scan_status` column at all. So no portal upload has ever been scanned: not
      Documents, not Messages attachments.
      What the email path does right, for reference: a dead clamd yields `skipped`,
      and `attachments.ts` refuses to file anything that is not `clean` — it fails
      CLOSED, per the "a skipped scan is not a pass" rule.
      Why this is a ruling and not a bug fix I just do: adding a scan to the portal
      path is a client-facing behavior change (uploads can start being REFUSED), needs
      a `scan_status` column + backfill decision for existing documents, and needs a
      fail-open/fail-closed choice — refusing every upload whenever clamd is down is a
      real availability cost on the surface clients use most. Sequencing is Brian's
- [x] **#14 BUILT to Brian's ruling (2026-08-12), deployed, migration 0045.** Intake
      never refuses — a client upload is always accepted and stored, infected included.
      Filing fails closed: a document does not satisfy a request until the verdict
      allows it, with the deferred target held in `documents.pending_request_item_id`.
      The rescan job runs EVERY TICK (a document at `skipped` is a client being chased
      for something they already sent). Infected → quarantined, task for Brian,
      undownloadable by anyone including the uploader, and the client is told nothing
      automatically — SOP `brian-infected-upload` covers that conversation.
      **The subtle part**: `skipped` conflated a BROKEN scanner with a deployment that
      has none, and dev/test have no `CLAMAV_HOST`, so gating on clean would mean no
      document could ever file locally. Rather than loosen the gate at runtime, the
      states are now distinct (`not_configured` may file) and production is made unable
      to reach that state — `loadConfig()` refuses to boot without `CLAMAV_HOST`, with
      a test that fails if the assertion is removed.
      Backfill run in production: **4 documents, all clean**.
      Ops dashboard verified in a browser at 390px: "Virus scanning unreachable for
      13h 5m" plus the upload backlog and what it means for clients; silent when
      healthy. Root `npm test`: **352/352**
- [x] **#15 — RESOLVED: production DID contain real client data (Brian's ruling,
      2026-08-12). Not a data-hygiene defect — a corrected premise.**
      The backfill checked rather than assumed and found 3 `recording` documents on
      non-test contacts with `soto_status = 'active'`.
      **CORRECTION (mine, caught by the #16 page): those are THREE DIFFERENT
      contacts, not one** — Jackson Flores, Josean Irizarry, Joseph Basilone, one
      recording each. My first report said "3 recordings on a contact" because I never
      grouped by `contact_id`; the ops Documents list showed three distinct client
      names side by side and made the error obvious.
      **Brian then ruled explicitly for ALL THREE (2026-08-12)**: Jackson Flores,
      Josean Irizarry and Joseph Basilone are all real contacts, same ruling — no
      `is_test` flags, recordings stay on their records as client documents. All three
      scanned clean in the backfill, so the corrected record stands: real client data
      was present in production during the rehearsal, and there was no exposure.
      For Jackson Flores — business partner AND a real tax client — the record was
      already correct in every respect:
      · `is_test` stays FALSE — he is a real client, and flagging him would have
        excluded a real client from measurement, the mirror image of the bug the flag
        exists to prevent
      · `soto_status = 'active'` is correct
      · the 3 meeting recordings STAY on his record as client notes/documents — real
        artifacts on a real client, not rehearsal debris
      · nothing was archived, reclassified or deleted
      **Correction to the record**: the rehearsal ran against production while real
      client data was present. My earlier statement, repeating Brian's premise, that
      "production is still all test data" was wrong. The backfill scanned every one of
      those files against current signatures (daily 28089) and all came back
      **clean — no exposure**. They had been sitting unscanned from creation until the
      backfill, which is precisely the gap finding #14 closed.
      **Forward cover confirmed**: `meetings/routes.ts` creates recordings through
      `uploadDocument`, as does every other path that inserts a `documents` row
      (bookkeeping close, attachment filing, Docuseal webhook) — so his future
      recordings are scanned inline at upload, and the `pending_scan` default plus the
      rescan job would catch any path that ever bypassed it
- [ ] Still open from the rehearsal: document upload, session recap approval

## M31 — Booking: Cal.com event types + prefilled portal link (2026-08-11)
- [x] `scripts/provision-calcom.mjs` — six event types, two America/Chicago
      schedules, twelve blackout dates, as DATA in one reviewable file. Dry run by
      default; `--execute` applies in a single transaction then READS BACK what
      landed. Re-running it is the January Busy Season flip
- [x] Direct SQL is the only interface available: this deployment runs the Cal.com
      v6.2.0 monolith with no API service — `/api/v1` is absent from the image,
      `/api/v2` proxies to port 5555 which is not deployed. Every column read from
      `information_schema` on the live DB, not recalled. Confirmed in the container
      source that `getBookingFieldsWithSystemFields()` parses `bookingFields || []`
      and ensures system fields on read, so storing only custom questions is correct
- [x] No dollar amount anywhere in it: `price`/`currency` are never written, because
      "no payment at booking" is the ABSENCE of payment config. Deposits stay in the
      price book → engagement quote
- [x] Portal step 4 carries Cal.com prefill (`?name=&email=`), built SERVER-side so
      identity comes from the session, not the browser. Name and email only — asking
      an authenticated client their phone or client status is the system forgetting
      who it is talking to. Non-http schemes and unparseable settings degrade instead
      of reaching the href
- [x] Verified in a browser at 390px, both states: with the setting, step 4 is a real
      prefilled link (`target=_blank rel=noreferrer`); with it null, the finding-#9
      copy still says scheduling is not open. Root `npm test`: **343/343**
- [x] ~~BLOCKED on Brian~~: the Cal.com DB had ZERO users — first boot never done.
      Event types belong to a user and the username IS the booking URL. Brian signed
      up at https://book.sotoaccounting.com/auth/signup (account creation sets a
      password, which I do not handle) and the provisioner ran against his account
- [x] Executed in order: prefill code deployed → dry run reviewed by Brian →
      `--execute` → `booking.client_booking_url` set to the sotocpa
      onboarding-consultation link → step 4 walked in production at 390px
- [ ] Flagged choices in the provisioner he may want to flip (one toggle each):
      `in-person-tax-prep` and `customer-support` are PUBLIC (he specified hidden only
      for 1, 4, 5); service-interest is REQUIRED; "+ other" read as an
      "Something else" option rather than a free-text field; public-event question
      labels are bilingual EN · ES per the standing Spanish-copy rule, which he did
      not ask for and can strip
- [ ] Deferred by Brian, no action: session recaps depend on Zoom→Whisper and Cal
      Video meetings will not feed that pipeline. Revisit when recaps are armed

## M32 — Findings #13–#24 (Brian's own 16-step run, 2026-08-12 → 2026-08-13)
Findings numbered as Brian reported them. #13–#17 came out of preparing the run;
#20–#24 are dead ends he hit DURING it, under his standing instruction: "after your
confirmation, every dead end is a new finding."

- [ ] **#13** Portal sign-in state lives in `sessionStorage` — iPhone Safari clears it
      on tab close, so a client who closes the tab is signed out. Brian: log it, no
      change now
- [x] **#14** Portal uploads were stored unscanned. Ruling: the email-path model
      exactly — **intake never refuses**. Uploads are always accepted and held
      `pending_scan`; the **filing gate** requires clean (fail-closed at filing, never
      at intake); a dead clamd yields `skipped` → auto-rescan every tick until a
      verdict. Migration 0045 + `mayFile()`. Backfill scanned every existing MinIO
      object — all clean. `not_configured` added so a *broken* scanner and an
      *unconfigured* one are never the same state, with a production boot assertion
      making the distinction safe. ClamAV `mem_limit` 1600m → 3g after an OOM during
      concurrent signature reload (costs 1.4 GB of the 16 GB box)
- [x] **#15** A real client's data was in the rehearsal. Jackson Flores is a business
      partner AND a real tax client — Brian: do NOT flag `is_test`, do NOT archive the
      recordings. Record corrected: production DID contain real client data during the
      rehearsal; the backfill scanned all of it clean, no exposure
- [x] **#16** No Documents section reachable from the ops dashboard on mobile →
      `/documents` ops page built and in the shell nav; Brian confirmed it in his run
      (both uploads listed, scan status Clean, rows naming Rehearsal Client 2)
- [x] **#17** Quote acceptance could complete and produce nothing. Ruling: acceptance
      must ALWAYS produce visible consequence — either engagement work/tasks for that
      schedule, or, if the schedule is already covered, **block at SEND time** with
      "this client already has an active Schedule A — adding work or duplicating?"
      Silent acceptance into the void is never valid. Root cause was class-wide (no
      owner → task silently dropped), so the fix is `ownerForRole()`: role holder →
      CEO → null, never a silent drop
- [x] **#18** Recording summaries. The Whisper→Ollama pipeline already existed and
      worked — Josean's and Joseph's sessions were transcribed and summarized. What
      was missing was (a) anywhere to SEE it and (b) a reason Jackson's never ran:
      - **The recovery hole**: his 7-minute session went to `transcribing` 352ms after
        upload on 2026-08-11 and sat there two days. The API container restarted
        mid-transcription, so `processMeeting`'s catch never ran — status never
        reached `failed`, no alert fired — and `recoverStuckMeetings` only looked at
        `recorded`, i.e. work that never STARTED. Work that started and vanished was
        recovered by nothing. Now covers `transcribing`/`summarizing` on a 45-minute
        grace (a genuinely-running Whisper is left alone; re-processing is safe
        because transcripts and summaries are ON CONFLICT DO UPDATE)
      - **No Whisper timeout**: an un-timed fetch to a hung Whisper never settles, so
        the catch can never run. 20-minute ceiling; a hang is now a loud failure
      - **Sessions section** on the client record: summary is the BODY of each row,
        not behind a click — reviewing a conversation without replaying it is the
        whole point. Decisions, action items, tax-need flag, duration, staff. A
        stalled session says "stalled — re-queued" instead of looking busy, and
        carries a Retry control
      - **Full transcript** is a separate call behind `meetings.read` and is AUDITED
        on every read (`transcript.read`), like any other document access. The log
        records engine, language and character count — never content
      - **Placeholder action items**: Jackson's summary text said "no major decisions
        or action items" and the model emitted one anyway whose text was literally
        "...", which became a task in the queue described as "...". An action item now
        has to say something before it earns a place in the task system. The already-
        created junk task was CANCELLED with a reason, not deleted
      - Backfill: the deploy's own recovery sweep picked Jackson's up and re-processed
        it. All three sessions now `ready` — Jackson 431s / 4160-char transcript /
        284-char summary, Josean 31s, Joseph 21s. Jackson's summary is coherent and
        covers the CCSA reimbursement discussion and the rescheduled DCO plan meeting
      - ⚠️ **Not verified by eye**: the ops app needs staff credentials + TOTP, which I
        do not have and will not enter. Verified instead by build, typecheck, tests,
        live endpoints (401-gated), correct DB state, and the presence of every
        Sessions string in the deployed client-record bundle. Brian should open
        Clients → Jackson Flores and confirm it reads right at 390px
- [ ] **#19** `acceptQuote` hardcodes `serviceLine: 'tax'`. Brian: not tonight — hard
      gate in `launch-readiness.md` instead (GATE 1: no non-tax quote may be SENT
      until fixed). Scope expanded by his later ruling: the fix must also make
      engagement labels **service-line distinct**, so a client with two engagements
      never reads "2 active engagements (tax, tax)" (RC2 ambiguity)
- [ ] **#20** Packet heading renders "A — Schedule A —" (redundant label composition)
- [~] **#21** Portal invite email. **BUILT, NOT VERIFIED — see below.** Brian received an
      invoice link, clicked it, was asked to sign in, and had never been sent a way to set
      the portal up; requesting a sign-in link produced no email either. The one that most
      directly blocks a real first client.

      **Diagnosis — read from the production audit trail, not guessed.** Two defects behind
      one experience:

      1. A brand-new client's first-ever email from us was `portal_magic_link` — "Here is
         your secure link to sign in to your Soto Accounting portal" — for a portal nobody
         had told them existed, expiring in 15 minutes, with no explanation of what it was.
         `welcome_soto` went out beside it promising "a sign-in link is on its way", so
         the promise was kept by an email that explained nothing. That reads like phishing,
         and a careful person is right not to click it.
      2. The invoice went to the +tagged rehearsal address; Brian typed his base address,
         which had no portal account at that moment. The endpoint correctly refused to
         enumerate and answered "a link is on its way" while sending nothing — leaving a
         real person at the door and nobody on our side aware of it.

      **Built.** `portal_invite` (EN + ES) on FIRST access: what the portal is, what is
      waiting there, and how to get a fresh link when this one expires — because it will,
      and "ask for another" has to be an instruction rather than a dead end. The bare link
      only on later requests, when they know what the portal is. `magic_link.issued` now
      records which was sent, so "did they ever get an invite" is answerable.

      The client-facing answer to a failed request does not change by a word — that
      vagueness is what stops the endpoint confirming who our clients are. The system just
      stops being the only party unaware: a KNOWN contact who cannot get in raises a task
      for Rene, deduped per contact, SOP `rene-portal-access` (which covers the
      address-mismatch case explicitly). An unrecognised address is a log line, so nobody
      can flood the queue by typing strangers' emails.

      Also fixed `welcome_soto`, which still promised a "4-step checklist … upload last
      year's return, and book your consultation" — the redesign made it five steps,
      generalised the upload, and removed booking entirely, because a client only reaches
      this point after the discovery meeting.

      ⚠ **NOT VERIFIED, NOT DEPLOYED.** Docker Desktop was stopped, so the 398-test suite
      could not run. All four workspaces typecheck and all four build guards pass, but
      those are static checks. This touches the sign-in path and two client-facing emails;
      it needs `npm test` green before it ships.
- [x] **#22** Pay Now was dead on click with no feedback of any kind — `void pay(id)`
      with no catch and no busy state, so a 503 produced NOTHING. Now: busy state,
      button disabled during the call, server message surfaced, `role="alert"`
- [x] **#23** Returning from Stripe with `?paid=1` was ignored — Brian paid and landed
      back on a screen still showing the invoice Open, with no acknowledgement. Now
      three honest states on return: confirming / paid / not-confirmed-yet
- [x] **#24** **Payment reconciliation.** The invoice stayed Open because the webhook
      endpoint had vanished from the Stripe account (`pending_webhooks=0`) — SAOS only
      ever waited to be TOLD about payments, so a lost webhook meant a client who paid
      stayed marked unpaid forever. Now SAOS **asks**: `reconcileInvoice()` on the
      client's return, and `runPaymentReconcileJob()` every tick for the client who
      closed the tab. Both funnel into `markInvoicePaid` — one settlement path, or
      two would eventually disagree about what "paid" means and a receipt would send
      twice or not at all. Cannot be abused: it reads a session id already stored on
      the invoice and settles only when STRIPE says paid, so a client hammering the
      endpoint changes nothing. `StripeAdapter` is now decorated on the app
      (`overrides.stripe`) instead of each module building its own, which is what made
      the settle path testable — the stub deliberately never reports paid
- [x] Enrichment tasks: 611 open `source_type='enrichment'` tasks traced to the July
      migration backlog, not a runaway. Brian: don't bulk-close — build the cheap
      version, a separate filtered view, excluded from My Tasks by default. Migration
      backlog to triage deliberately later, not noise to delete. **Shipped**:
      `BACKLOG_SOURCE_TYPES` in the task service; `myTasks` and `ownerRollup` exclude
      it and *report the count* rather than hiding it; `/tasks/search` takes
      `excludeSourceType` as a visible filter, never an implicit one; internal Tasks
      page gets a "Migration backlog (N)" chip beside Overdue. One tap to the backlog,
      zero rows of it in the daily list
- [ ] Rehearsal's one open step: **intake in Spanish** was never walked. Brian offered
      "I'll walk it myself today" or "assign to Rene or Laura once staff accounts
      exist" — staff accounts do not exist, so him walking it is the only real option

## Review

### M29 legal package v3 — Master + Schedules (completed 2026-08-10)
- **Migration 0038**: `template_kind` + `acceptance_via` enums; templates gains
  `kind`, `is_active`, `retired_at/reason`, `schedule_code`, `needs_es_review`,
  `es_approved_by_staff_id/at`; new `service_schedules` (service_line → A–E, as
  DATA so adding a line to a schedule is an admin edit), `engagement_packets`,
  `schedule_acceptances`.
- **Master §1 is enforced, not described.** `idx_one_signed_master_per_contact`
  is a partial unique index, so a second signed Master is impossible even if a
  future code path forgets to ask. Every acceptance row records HOW it arrived
  (`master_signature` vs `portal_acceptance`) because "did this client agree to
  bookkeeping terms" must be answerable per service, not inferred.
- **The A/B split derives from the RETURN TYPE**, not the service line: a
  business-only client never signs the individual schedule, an owner with both
  gets both, and a tax client with no return type yet defaults to A.
- **Attest is refused by name.** Schedules A–E do not cover CPA review/audit
  work, so packet assembly throws `service_line_unscheduled` with the reason
  instead of filing attest under Advisory terms. That is a real gap for Brian's
  attorney (a Schedule F), and the build says so rather than papering it.
- **`templateKeyFor('engagement_letter')` now returns `engagement_master`.** It
  had to: the five per-line letters are retired, so the old return value pointed
  every engagement-letter envelope at a retired placeholder. This is also what
  makes the late-fee stamp fire, since the disclosure lives on the Master.
- **Two real bugs found by writing the tests.** (1) `service_line[]` came back
  from node-postgres as the raw string `'{tax}'` — no parser exists for an array
  of a custom enum — so every `.filter()` in packet assembly threw; fixed with
  `::text[]`. (2) The Master carries `{{schedules_attached}}`, and nothing filled
  it; `renderMasterForPacket` now fills it from the packet's own schedule_codes,
  so the sentence defining what the signature covered can never come from a
  caller's guess.
- **Three stale test fixtures corrected, not deleted.** admin/signatures/forms
  specs asserted that real legal templates were placeholders. They now flag a
  template deliberately and assert the gate both directions — the gate is about
  the flag, not about the launch state, and these tests will keep working the
  next time text goes back under review.
- **`packages/db` seed spec inverted** (`engagement_letter_tax` is placeholder →
  no ACTIVE template is a placeholder) plus a new test pinning the late-fee flag
  to exactly one active template. Disclosed: that suite is NOT in root
  `npm test` and reports 9/10 — the failure is `ACCT_SEMI_ANNUAL should be
  flagged needs_confirmation`, which fails *because Brian confirmed that price*.
  It asserts pristine seed state against the live dev DB; it needs a fresh-DB
  harness like the API suite, which I have not built rather than quietly delete
  the assertion.
- **A decline never revokes a signature.** `recordConsentAnswer` writes
  `consent_7216_status = 'declined'` only `WHERE consent_7216_status <> 'signed'`
  — declining the Hilo disclosure must not wipe a USE consent the client gave.
- **The portal can only answer what it was offered.** `POST /portal/consents`
  re-runs the presentation rules and refuses `consent_not_offered`, so a crafted
  request cannot record a consent the rules withheld. Verified live against the
  dev API: 409 with nothing written.
- **Verified end to end on a local throwaway fixture** (created, exercised,
  deleted; dev test-client count back to 0): Schedule C accepted by
  `master_signature` with its packet id, Schedule D accepted later by
  `portal_acceptance` with no packet, USE consent `signed` /
  `method=portal_checkbox` / `policy_version=v3-t2`, and the crafted DISCLOSE
  refused. Audit trail carries both actions.
- **Screenshot not captured**: the Browser pane is not displayed in this
  session, so screenshots and clicks time out. The page was verified by
  accessibility tree + rendered text + live API calls instead. Worth a 390px
  capture next session when the pane is open.
- **One flake seen, named**: the meetings e2e failed once in a full parallel run
  (49s, vs 3.4s in isolation) and passed alone and on the immediate re-run —
  contention between parallel spec processes each building their own database,
  not a v3 regression. If it recurs, the fix is a longer timeout on that spec,
  not a retry loop.

### M27 quote builder + leads pipeline (completed 2026-08-09)
- **Migration 0027**: `quotes` (pins `price_book_version_id`, stores ONLY the
  SHA-256 of the client link token, range min/max, deposit item, decline
  reason, conversion links), `quote_line_items` (both `description_en` and
  `description_es` frozen per line), `contacts.lead_stage/lead_stage_at/
  lost_reason`, `lead_stage_history`.
- **Zero re-entry proven**: accepting the client link creates the engagement
  from the accepted lines and issues the deposit invoice from the price-book
  deposit item. Nobody retypes a scope or a number.
- **Version pinning proven**: a test raises the live book price by $50 AFTER
  the quote is sent and asserts the client still sees the quoted figure.
- **Range from a setting, not a literal**: one-time work quotes as a range
  whose width is `pricing.estimate_band_percent` (15, admin-tunable). The
  portal re-derives the band from max÷min so ticking an add-on keeps the
  range a range instead of silently becoming an exact number.
- **The funnel refuses to lie** (design rule, tested): once a contact reaches
  `client`, quote-driven stage moves are RECORDED IN HISTORY BUT SKIPPED.
  Quoting extra work to a current client used to be able to demote them to
  `quoted` — and an expired add-on quote would have marked a paying client
  `lost`. Win rate is measured against DECIDED quotes only; open proposals
  are not losses, and `null` (not 0%) shows before the first decision.
- **Two defects found and fixed during the build**, not after:
  1. `sendQuote` marked the quote 'sent' with a token hash BEFORE the email;
     a failed send (placeholder gate, bad address) stranded a link nobody
     had, and re-sending was refused because the quote was no longer a draft.
     Now a failed send rolls status/sent_at/token_hash back to draft, audits
     `quote.send_failed`, and rethrows — staff fix the cause and resend the
     same quote. Caught by actually sending in dev, then covered by a test.
  2. Spanish readers saw Spanish chrome around ENGLISH service names, because
     the line description was frozen in one language. Migration 0027 was
     amended (not yet deployed, so no patch migration needed) to carry both.
- **Client-facing page is public by design**: the emailed token is the
  credential, so a prospect reads and accepts a proposal without an account.
  A wrong token is a 404; only the hash is at rest (same rule as magic links).
- **Also shipped**: `GET /quotes/catalog` so building a quote needs
  `engagements.read`, not the Admin→Pricing permission that can CHANGE
  prices; nightly `runQuoteExpiryJob` (date-guarded) expires quotes with
  "expired without a response" recorded as the reason.
- **Dubsado retirement trigger** (Brian's accepted ruling) built and tested:
  25 migrated clients with a `portal.login` audit row AND ≥1 completed
  monthly close. Counts DISTINCT contacts (not login events), ignores native
  signups, ignores unfinished closes, and alerts exactly once — proven by a
  test that walks all four states. Readiness shows on the Executive
  dashboard as `0/25` and `0/1` so the distance is a number.
- **Price guard regression caught**: `npm test` was failing `check:prices` on
  code committed at M26.5 — a comment in `bundles.ts` restated the surcharge
  as a dollar figure. My earlier "172/172 green" came from running the
  workspace tests directly, which skips the guard. Comment fixed; the guard
  passes; full `npm test` is the standard from here.
- 187/187 tests green (14 new quote tests, 1 new retirement test, dashboards
  extended). 13/13 screens pass 390×844 with no horizontal page scroll.
- Two 390px layout defects fixed from screenshot evidence: the global
  `input { width: 100% }` rule was stretching inline checkboxes on both the
  portal proposal and the internal builder, and the builder's 5-column
  picked-lines table clipped on a phone (now stacked rows).

### M27 reports & KPIs (completed 2026-08-09)
- **Seven reports, one registry.** The catalog the UI lists, the JSON the tiles
  render, and the CSV columns all come from the same definition, so an export
  cannot disagree with the screen. A test walks every report and fails if a row
  carries a key the columns don't declare, or omits one they do.
- **CSV is spreadsheet-honest**: money exports as decimal dollars (raw cents
  under a "Collected" header reads 100× too large), RFC 4180 quoting, CRLF, and
  any text cell starting with `= + - @` gets a leading apostrophe. That last one
  matters because client names and notes reach these files — a client called
  "-Smith" should not become a formula in the recipient's spreadsheet.
- **Every export is audited** by report key, range, and row count. Reading the
  JSON on screen is not an export and is not logged as one.
- **Caveats are part of the data, not fine print.** Each report states what it
  is and isn't, rendered with the numbers:
  - revenue counts money COLLECTED, not billed
  - A/R aging and client counts are snapshots and say the date range doesn't
    apply (the date inputs disable themselves)
  - throughput reports **returns filed and returns accepted as separate
    columns**, because Filed is not the finish line — a rejected return would
    otherwise inflate the filed number
  - session utilization admits it cannot compare usage to an entitlement,
    because the sessions-per-cadence number isn't stored anywhere yet. It does
    enforce the one entitlement that IS a rule: an active S corp below two CPA
    sessions a year is flagged BELOW FLOOR. (The configurator-time gate on that
    floor is still open — this is a report, not the gate.)
  - revenue that can't be attributed to a service line is reported as
    `unattributed`; a test asserts the lines sum to everything collected
- **Tiles**: `staff.dashboard_tiles` jsonb. NULL and `[]` deliberately differ —
  never-configured gets a default board, deliberately-cleared stays empty.
  Pinning an unknown report key is refused rather than rendering a blank card.
- **Leadership-only** (`dashboards.executive`); a preparer gets 403. Per-staff
  own-only scorecards are Phase 4 and deliberately not faked here.
- Two defects caught from screenshots: zero hours rendered as `0.` with a
  dangling decimal (`FM990.99` → `FM990.00`, now regression-tested), and
  "Unpin from dashboard" was styled destructive-red for a preference toggle.
- 195/195 tests green. 14/14 screens verified — all seven reports at 390×844
  AND at 1280px, because a report is mostly numbers and a horizontally
  scrolling grid of numbers on a phone is unreadable even when it fits. The
  table is replaced by one card per row under 768px.

### S corp session floor — configurator-time GATE (completed 2026-08-09)
Brian's call: the report shows violations, the gate prevents new ones. Both.
- **Migration 0029**: the two-dial configurator the v4.2 Service Delivery Model
  specifies — `prep_cadence` (weekly/monthly/quarterly/semi-annual),
  `session_cadence` (weekly→annual), derived-and-stored `sessions_per_year`,
  `scope_rung`, `maintenance_mode`, plus `engagement_config_history` so a later
  downgrade is answerable: who reduced it, when, and what the floor did.
- **`S_CORP_SESSION_FLOOR = 2` is a CONSTANT, not an app_setting.** Every other
  knob is admin-editable because Brian shouldn't need a deploy to change his own
  policy — but a floor that can be edited to zero isn't a floor. CLAUDE.md calls
  it non-negotiable, so there is no column and no toggle for it. The
  `s_corp_floor_applied` column is *evidence that it bound*, not a switch.
- **Every path down runs through the same gate**, which is the whole test file:
  configure straight to annual (409), configure legally then reconfigure down
  (409, and the good config survives), and **maintenance mode** — the likeliest
  real-world route down — which calls the configurator rather than going around
  it. A refused configuration writes nothing: no columns, no history row.
- **S election is detected two ways, either sufficient**: a business typed
  `s_corp`, or a Form 1120-S engagement on record. A client whose entity_type was
  never captured but who files an 1120-S still gets the floor. Safe direction for
  a compliance floor — a missed S corp costs owner-comp calibration, a false
  positive costs one session a year. The refusal quotes its evidence.
- **It throws, it does not clamp.** Silently raising a client's session count to
  satisfy the floor would change what they're billed without anyone deciding to.
- Also enforced (same spec section, same configurator): **sessions can never be
  more frequent than prep** — nothing to review in a session whose books haven't
  closed.
- **Price-book discipline held**: weekly prep is a real spec dial position with
  NO price-book line, so configuring it is refused naming the gap ("add the item
  in Admin → Pricing — I will not estimate a price"). Same for the session dial:
  the book has no session-cadence item, so the UI states the sessions are priced
  by the prep line rather than showing a misleading $0.
  **⚠ Two price-book gaps for Brian**: no weekly accounting line, and no separate
  session-cadence line. Neither blocks anything today.
- `GET /contacts/:id/configurator-options` lets the UI DISABLE what the floor
  forbids instead of letting staff pick it and be refused. Verified in the
  browser: `annual` is the only disabled option for an S corp, and the API still
  refuses independently — the UI check is a courtesy, never the control.
- **The utilization report now measures against a real entitlement** (used vs
  `sessions_per_year`), and distinguishes unconfigured ("—") from zero. Its
  caveat was rewritten to credit the gate rather than the report.
- 204/204 green. Configurator verified at 390×844 and 1280px.
- **One flake, disclosed**: the meetings pipeline spec failed on the first full
  run at 26s (passes alone in 3.2s). Root cause was an 8-second status-poll
  budget starved by full-suite CPU contention, not a logic fault — raised to 30s
  with a comment, since the loop exits on success and the timeout exists to catch
  a genuine hang, not to enforce a performance budget.

### M27 announcements + review requests (completed 2026-08-09)
Every compliance clause made STRUCTURAL, and the test file is written as
attempts to violate each one rather than demonstrations of the happy path.
- **Approval is a database CHECK**, not service-layer convention: a `broadcasts`
  row cannot reach `status='sent'` without a named approver. A test proves even
  direct SQL is refused. Approving is also a leadership permission and the
  author cannot approve their own — a bulk client send gets a second pair of eyes.
- **The unsubscribe footer is appended by the SENDER, not the template.** An
  admin editing announcement copy cannot delete what they never had. Test sends a
  body containing no unsubscribe language and asserts the footer, the postal
  identification, and the contact's own token all arrive anyway.
- **Suppression is evaluated at SEND, per contact.** Test approves a broadcast,
  has a recipient opt out *during the approval wait*, then sends and asserts that
  person was skipped with the reason recorded as a row.
- **Every intended recipient gets a row, including suppressions, with the
  reason.** A send that quietly reaches 300 of 400 teaches nothing; "88
  suppressed: opted out" is an audit trail. Same shape in the audit log.
- **Marketing opt-out ≠ transactional.** `broadcast_opt_out_at` is separate from
  `sms_consent` and the §7216 consents: a client who mutes firm news still gets
  "your return is ready". The unsubscribe page says so in both languages, because
  a client who believes they switched off service messages is worse off.
- **No unsubscribe token at rest** — an HMAC of the contact id keyed by
  APP_ENCRYPTION_KEY. Stable for the 30+ days CAN-SPAM wants, verifiable without
  a lookup, nothing extra stored. One-click, no login, idempotent (a second click
  or a mail-client prefetch does not error or move the opt-out date).
- **Review asks refuse the embarrassing moment.** Ordered by how badly it would
  land: open IRS notice → notice within 90 days → overdue invoice → paused work →
  stalled onboarding → opted out → archived → no email → already asked in 180
  days. Resolving a notice is *not* enough; "we fixed your CP2000 last month,
  please review us" is exactly the wrong ask. Every suppressed attempt is a row,
  so the rule is provable from the near-misses.
- **Review asks fire on ACCEPTED returns, never merely filed** — consistent with
  Filed-is-not-terminal. Registered as automation #9, ships OFF, and while
  disarmed the decision still runs and the skip is counted.
- The review email routes a *bad* experience back to us ("if something fell
  short, reply to this email instead") rather than to Google.
- `sendSms` gained a narrow `bodyOverride` for broadcast copy (authored
  per-send, so there is no template row). It replaces the template LOOKUP only —
  consent gate, phone check, thread logging and audit all still run — and the
  combination of override + `transactionalReply` is refused outright, since that
  pairing is the shape of an accidental consent bypass.
- **⚠ Worth knowing from live dev data**: of 433 active clients, 433 are
  emailable and **0 have SMS consent**. An SMS announcement to the migrated book
  would suppress 100% today. Email announcements work; SMS needs consent captured
  at onboarding first. Not a bug — the TCPA gate doing its job.
- 215/215 green. Announcements + unsubscribe verified at 390×844 and 1280px.

### Pricing rulings + SMS consent backfill (completed 2026-08-09)
Brian's four pricing rulings, implemented in the price book with the presentation
rule made structural.
- **Two layers.** BUNDLED PLANS are client-facing and quotable (weekly $300/wk,
  monthly $250/mo, quarterly $600/qtr, semi-annual $1,000/6mo). COMPONENTS are
  derivation-only: prep per close period ($200/$150/$500/$900) + $100 per CPA
  session. A test asserts bundled = prep + one session to the cent, so the layers
  cannot drift into a quote/invoice discrepancy.
- **Weekly unblocked** (ruling 1) — that was the point; weekly clients had no
  priceable cadence. **Nothing re-prices** (ruling 2): components were calibrated
  to the totals already in force, and matched-cadence configs are asserted to
  still land on them.
- **Presentation rule enforced in code** (ruling 3). `display_on_quote` existed in
  the schema since 0007 but was enforced nowhere. The quote builder and the
  invoice builder now REFUSE a flagged code, and the builder catalog does not
  offer components at all — so a session fee cannot be itemized to a client even
  if a staffer asks for it by item code. The internal configurator still shows the
  breakdown, shaped so it cannot be handed to a client-facing renderer.
- **Ruling 4 verified**: maintenance mode (monthly prep + semi-annual sessions)
  derives $2,000/yr = $166.67/mo, presented as one monthly figure and cheaper than
  the full plan; utilization entitlement reads sessions_per_year as built.
- Brian's semi-annual confirmation cleared a launch gate: 14 → **13** items
  awaiting price confirmation.
- **⚠ Note**: the s-corp-conversion bundle still offers ACCT_QUARTERLY as an
  optional add-on, which is correct — that is the bundled plan, not a component.

**Portal SMS opt-in** (Brian's addition): 433 active clients, zero SMS consent, so
consent could only ever arrive through new onboarding. Now offered in the welcome
flow, EN/ES, with the disclosure above the control, an unticked box, a disabled
submit until ticked, a real decline button, and off-switch in the same card. The
policy version is written into the consents row; migration 0032 adds a
`portal_checkbox` method rather than mislabelling it as intake. A test asserts
the classic trap: adding a phone and preferring 'text' is NOT consent.
- **sendSms reordered** to check consent BEFORE Twilio credentials — the gate was
  unreachable, and therefore untestable, in every environment without creds.

**Two PRE-EXISTING flakes found and root-caused** (verified failing on HEAD before
my changes): fixtures compared a timestamptz against a midnight-Chicago date
window with one day of slack, so they flipped during the five hours when UTC and
Chicago disagree on the date. Three assertions in document-chase, one in billing.

227/227 green. Deployed through migration 0032.

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

## Post-season review items (logged, deliberately not built now)

- [ ] **Item E scope note — cross-linking sessions to the Hilo client record.** Brian's
      ruling 2026-08-14 on Jackson Flores's session: **no visibility change**. Jackson
      is a tax client, and Hilo is itself a bookkeeping and tax client of the firm, so
      Hilo-related discussion on his record is client-adjacent, not out of place. When
      the Hilo workspace exists, sessions like this one may warrant cross-linking to
      the Hilo client record. E-scope design note, not a task now.

- [ ] **Base-return price ranges.** The four `IND_BASE_*` items carry flat amounts
      with no `price_min_cents`/`price_max_cents`, so a derived interview quote takes
      its range from `pricing.estimate_band_percent` (15% for launch). Brian's ruling
      2026-08-11: neither of us invents min/max numbers. **Revisit after one season of
      real derived quotes**, which will show what base complexity actually varies by;
      then set explicit ranges in Admin → Pricing and the interview prefers them over
      the band automatically (already implemented that way).
- [ ] **Lead self-quoting.** The tax interview was built client-readable and bilingual
      for exactly this; only the staff-side surface exists so far.
- [ ] **Attest Schedule F variants.** Schedule F covers review / audit / insurance-WC.
      If Brian sells a compilation or an agreed-upon-procedures engagement, that needs
      its own schedule — assembly refuses unscheduled attest work by name today.

## Standing constraint — test-vs-real exists only at CONTACT level (Brian, 2026-08-12)
- [ ] `is_test` is a column on `contacts`. Nothing marks a SESSION, a document, a
      recording or a quote as test. So a staff member running a test session against a
      REAL contact — exactly what happened on Jackson Flores's record — produces real
      artifacts and test artifacts that are indistinguishable, and the "excluded from
      measurement" rule has no hook to grab.
      **Constraint for future work, no build now** (Brian's call). Anything that adds a
      test/rehearsal mode must decide where the flag lives, and per-contact is already
      known to be the wrong altitude. Related: [#15 ruling]
