# SAOS Master Build Prompt — v4.6 (PRODUCTION — LOCKED FOR BUILD)
### For Fable AI — Full Stack Build + Business Automation
### Client: Brian Soto, CPA | Soto Accounting LLC + Hilo NFP | Chicago, IL
### Last Updated: July 5, 2026 | Supersedes all prior versions | All blocking decisions resolved — changelogs at end
### v4.2 adds: Service Delivery Model (two-axis), 8 new modules, and the Pricing Seed Data section — grounded in 147 client session transcripts + the 2025 pricing workbook
### v4.3 adds: authoritative deadline table (990 May 15 original corrected; 1041 estate + foreign returns added) and seven operational flows — rejects/notices, entity groups, escalation + auto-extension, AR dunning/late fees, books close cycle, grant vouchering tracker, stalled-onboarding rescue
### v4.4 adds: unified task & project management (full Trello replacement), quote builder, reports & KPIs, client announcements + review requests, SOP knowledge base, Hilo events, and the stack disposition table
### v4.5 adds: Task System UX spec (Zoho CRM parity — views, filters, saved views, recurrence, layouts) from review of the firm's live Zoho usage
### v4.6 adds: Tax Resolution lane (multi-year non-filer engagements, statute clocks, paper-file workflow, task dependencies) + the Bundle Builder (composable service packages, S-Corp conversion package seeded)

---

## WHAT YOU ARE BUILDING

A self-hosted, Docker-deployable business operating system that fully replaces Zoho One, Zapier, Otter.ai, Calendly, Adobe Sign, and Eventbrite-dependent workflows. It serves two entities — Soto Accounting LLC (CPA firm) and Hilo NFP (nonprofit entrepreneurship development) — from a single unified codebase and database. All client data lives on infrastructure owned by the business. The only external vendors are Stripe (payments), Twilio (SMS/voice — message routing only, no document storage), Amazon SES (outbound email relay — delivery routing only; all content originates on owned infrastructure), and a per-signature KBA identity-verification API for remote 8879 signatures (APPROVED).

Five layers:
1. **Internal operations platform** — CRM, pipelines, tasks, team KPIs, dashboards, time tracking
2. **Client portal (bilingual EN/ES)** — documents, status, payments, messages, e-signatures, service requests
3. **Automation engine** — meeting intelligence, referral flows, billing, extensions, SLA alerts, IRS notice routing
4. **Compliance layer** — e-signatures, engagement letters, §7216 consents, WISP-grade security, audit logs
5. **CEO command center** — exception-based dashboards for Brian and Jackson

---

## WHO YOU ARE

1. **A full-stack app development team** — architect, backend, frontend, UX/UI, DevOps, automation, QA. You design, build, test, and deploy end-to-end.
2. **A fractional COO** — every decision must reduce Brian's operational time, increase dashboard visibility, and protect CEO-level capacity. If a feature requires manual work a system could do, redesign it.

Output is a working, deployed system packaged for a one-session developer handoff. Not documentation. A running system.

---

## INFRASTRUCTURE

### Deployment
- **Docker Compose** — entire system starts with `docker-compose up -d` on a fresh Linux VPS
- Server: **Hetzner CPX41, 16GB RAM (DECIDED)** — 8GB is insufficient for Whisper + Ollama running alongside the full container stack; 16GB keeps transcription/summarization responsive and total infra under the $75/month target
- SSL via Let's Encrypt, auto-renewed
- Subdomains: `app.sotoaccounting.com` (internal) | `portal.sotoaccounting.com` (Soto clients) | `portal.teamhilo.org` (Hilo) | `admin.sotoaccounting.com` | `sign.sotoaccounting.com` (Docuseal) | `book.sotoaccounting.com` (Cal.com)
- **Staging environment**: full clone via `docker-compose -f docker-compose.staging.yml up` — no update ever pushed directly to production during tax season
- Automated daily backups to Backblaze B2, encrypted, with documented restore procedure (test restore quarterly)
- **Uptime Kuma** (self-hosted) monitors all services — alerts Brian, Jackson, and the maintenance developer via push + SMS
- Post-launch: maintenance developer on retainer (~$100–200/month) for updates, patches, on-call during tax season — **post-build hire**; recruiting starts once Phase 1 ships. Until hired, Uptime Kuma alerts route to Brian + Jackson only

### Stack
- Backend: Node.js or Python — Fable's choice for maintainability
- Database: PostgreSQL, containerized, **encrypted at rest**
- Frontend: Next.js — mobile-compatible; **fully bilingual English/Spanish** (i18n from day one, client chooses language, all client-facing copy in both languages)
- Files: MinIO, encrypted buckets
- Email: Postal (self-hosted) for composition, inbound processing, and message management; **outbound relayed through Amazon SES smart host** — self-hosted SMTP from a fresh VPS IP lands in spam, and magic links + engagement letters cannot tolerate silent delivery failure. SES sees routing metadata only, never stored documents
- **SMS/Voice: Twilio — 708-300-0375 live at launch; 312-715-8599 ports in post-launch (DECIDED, updated July 7)** (see Communication section)
- Transcription: Whisper (local container)
- Summarization: Ollama local LLM primary; Claude/GPT-4 API fallback (cleaned text only, never audio/raw transcripts)
- Payments: Stripe (one-time + Stripe Billing recurring)
- **E-signatures: Docuseal (self-hosted)** at sign.sotoaccounting.com
- **Scheduling: Cal.com (self-hosted)** — replaces Calendly; enforces Zoom-only on initial consultation event types
- **Secrets: Vaultwarden (self-hosted Bitwarden)** — team password vault; migrate funder-portal credentials out of the plaintext Google Sheet immediately
- Auth: RBAC, magic link + optional password, **MFA required for all staff accounts**
- Push: ntfy (iPhone, Brian + Jackson)

### Cost Target
Infrastructure under $75/month (Hetzner CPX41 ~$35 + B2 + Twilio usage + SES pennies + per-signature KBA at volume). Replaces Zoho One (~$90) + Zapier (~$50) + Otter (~$20) + Adobe Sign (~$25) + Calendly (~$12). Net savings ~$120–200/month with strictly better data control.

---

## COMPLIANCE LAYER (NON-NEGOTIABLE — BUILD IN PHASE 1)

### WISP-Grade Security (FTC Safeguards Rule)
- Encryption at rest: Postgres volume + MinIO buckets
- MFA on all staff accounts
- **Audit log**: every view/download/edit of a client document or PII field is logged (who, what, when, from where); log immutable and exportable
- Session timeout, failed-login lockout, role-based least privilege
- System generates a security summary export Brian can attach to his written WISP document

### E-Signature Module (Docuseal)
- **Engagement letters** — template per service type (tax, bookkeeping, advisory, COO, entity), auto-populated from engagement record. GATE: tax engagement cannot advance past "Scheduled" until engagement letter is signed
- **Form 8879 e-file authorization** — remote signature flow. IRS Pub 1345 requires knowledge-based authentication (KBA) for remote 8879 e-signatures; Docuseal does not provide KBA natively. **DECIDED: integrate a per-signature KBA API (~$1–3/signature)** as a pluggable identity-verification step ahead of the Docuseal 8879 envelope — keep the interface pluggable so the KBA vendor can be swapped without touching the signing flow. In-office clients (~10%) sign wet; staff scans and uploads to the client's document folder (upload category: "Signed Authorizations"). Signature method recorded per 8879 (remote-KBA / in-person wet)
- **§7216 consent forms** — captured at Soto intake (see below)
- **Grant agreements and W9s** — Hilo grant recipients sign via Docuseal
- All executed documents stored in MinIO, linked to contact record, audit-logged

### IRC §7216 Consent
- Soto onboarding includes a §7216 consent-to-use/consent-to-disclose form with IRS-mandated language. **BUILD WITH PLACEHOLDERS (APPROVED)**: ship clearly-marked placeholder text for the §7216 consent and all engagement letter templates; Brian supplies final legal language before client-facing launch. System provides capture, signature, storage, and enforcement mechanics; all template copy is admin-editable so final legal text drops in without a code change. **LAUNCH GATE: no production client may ever be sent a placeholder document — system blocks sending any template still flagged PLACEHOLDER**
- **ENFORCEMENT**: the referral engine, upsell flagging, and any cross-entity use of tax return information is BLOCKED per-client until a signed 7216 consent is on file. Consent status is a field on the contact record; automations check it before firing
- Migrated legacy clients: consent status = "Not on file"; system queues consent requests into their portal onboarding checklist

### Nonprofit Referral Integrity (Hilo → Soto)
- Every Hilo→Soto referral record includes: disclosure that alternatives exist, referral policy version shown, timestamp. Creates the arms-length audit trail protecting Hilo's exempt status
- Board-level conflict-of-interest and referral policies are Brian's to adopt; the system logs compliance with them
- Grant scoring includes per-reviewer conflict-of-interest attestation (see Grant Module)

---

## THE BUSINESS

### Soto Accounting LLC
- CPA firm, Chicago. Published office number: **312-715-8599** (Google Voice, unchanged for clients). System/SMS number: **Twilio 708-300-0375** at launch — see Communication section | contact@sotoaccounting.com
- Services: Tax (1040, Sch C, Sch E, 1065, 1120-S, 1120, 990, **1041 estate/trust**, 1120-C housing co-op, 1120-H, **1120-F foreign**, 1120-POL, ITIN/W-7, **expat/foreign filings incl. FBAR**), **Payroll (setup, review, training, full management)**, **Sales & Use Tax (setup, review, training, full management)**, Bookkeeping & Financial Statements, Advisory/CFO, **Nonprofit CFO & Grant Vouchering**, COO Services, Entity Formation & Annual Reports (incl. BOI, DBA, amendments), **Attest (CPA financial statement review/audit — see independence rule in Service Delivery Model)**, Specialized CPA Services, IRS Notice Handling. Full catalog + prices in PRICING SEED DATA. Essential/Growth/Full Management survives as internal complexity scoping only — clients buy cadences and scope rungs per the Service Delivery Model section
- **Tax prep happens in ATX Tax Software (external, no integration)** — this system handles everything around the return: intake, documents, pipeline, pricing, signatures, delivery, billing. Delivery step: preparer manually uploads the final return PDF to the client's portal (replaces the current Dropbox-link-by-email process)
- 300+ clients; import last 24–36 months (Dubsado + Zoho CRM exports); QuickBooks for accounting via weekly CSV export
- **Extensions: 30–40% of clients file extensions** — full workflow required (see Tax Operations)

### Hilo NFP (formerly DishRoulette Kitchen / DRK)
- 501(c)(3), Chicago. teamhilo.org
- Mission: weave equity into the fabric of entrepreneurship
- Model: on-demand thought partnership — hotline-style access via Jackson's Cal.com and phone; 1-on-1 advisory sessions + monthly workshops; curriculum delivered through sessions, adapted per entrepreneur; no fixed cohorts
- **Two grant flows** (see Grant Modules): distributes micro-grants to entrepreneurs AND raises grants from funders with post-award reporting obligations
- **CCSA Corridor Lead**: Hilo assists entrepreneurs applying for City of Chicago grants — "Grant Application Assistance" is a tracked Hilo service type (hours logged, feeds pro bono metrics)
- Historic applicant base: heavily minority- and women-owned businesses, Spanish-speaking corridors (Pilsen, Little Village) — hence bilingual portal requirement

### Entity Relationship
- One database, two branded front doors. Hilo is top-of-funnel; referrals flow both directions with 6 bridge fields; §7216 consent gates all cross-entity data use

---

## TEAM & ACCESS

| Person | Role | Access |
|---|---|---|
| **Brian Soto** | CEO / CPA | Full. iPhone. Default view: Executive dashboard. Approval gate for pricing/scope commitments. Target <5 hrs/week admin |
| **Jackson Flores** | ED Hilo / Fractional COO Soto / Grants Lead | **Equal to Brian.** iPhone. Default view: Hilo operations. Heavy phone-call communicator. Independent on all Hilo-side decisions |
| **Ana-Maria** | Tax Preparer / IRS Notice Handler | Assigned engagements + all IRS notices. Premium-tier clients: she responds on client's behalf; standard: she preps, client sends. No pricing changes |
| **Laura** | Remote VA / Entity Formation & Annual Reports | Entity module, admin tickets. Fully remote access |
| **Cristian Borcan** | Auditor (contract) | Attest engagements only; access scoped per engagement; system enforces the independence check before any attest engagement is created |
| **Rene** | Phone/Text Handler / Sales Tax / Payroll / Billing | Unified comms inbox, Stripe billing queue, sales tax + payroll workflows, magic-link bounce follow-ups |
| **Marian** | Bookkeeper | Bookkeeping engagements only. Works in each client's QBO as accountant user — **this system does NOT build a ledger**; it handles document collection, workflow, review gates, and delivery around QBO |
| **Juan** | Intern | Read-only on assigned records, task execution, no PII/financial access |

Future roles: additional Tax Preparer, Client Success, Advisory Manager — permission levels built now.

---

## BRAND IDENTITY

### Hilo NFP (complete, agency-delivered March 2026)
- Colors: Deep Navy `#1C2632` (primary) | Off-White `#E2D5D2` | Burgundy `#2D061B` (sparing) | Burnt Orange `#BB5400` (CTAs)
- Type: GT Ultra Median Regular + Bold (license: grillitype.com/shops/gt-ultra; fallback Playfair Display). Headlines 2× body; subheads Bold same size; buttons sentence case Regular
- Logo: "hilo" wordmark with thread ligatures; H monogram (avatars); H thread monogram (horizontal). Min 64px
- The Thread: solid/dotted flowing line as connector/divider; never overlaps letterforms or faces; always contrasting
- Voice: optimistic, welcoming, earnest; entrepreneur is the hero, never Hilo; never corporate
- **All Hilo client-facing copy produced in English AND Spanish**

### Soto Accounting (complete brand system — DECIDED; supersedes the v4.0 working palette)
- Colors: Forest Teal `#0D3B38` (primary) | Electric Teal `#00C9BF` (accent — CTAs, highlights, and the wordmark period) | supporting neutrals per the Soto Brand Brain
- Wordmark: "SOTO." set in Inter 800, with the period rendered in Electric Teal as the logo device
- Type: Inter across product UI
- Voice: direct, expert, warm; fintech-adjacent; plain language; the client is a capable professional making smart moves — never someone who needs rescuing; a CFO in their corner, not a vendor
- **All Soto client-facing copy produced in English AND Spanish**

---

## CLIENT PORTAL (BILINGUAL EN/ES)

Primary product. Mobile-compatible. Language toggle persistent per user; language preference stored on contact record and applied to all outbound communications.

### Auth
- Magic link on intake; optional password after; MFA optional for clients
- Bounce fallback: bounced magic link → alert to Rene → verify contact info → re-send; clients can call the office number for access reset
- Clients see only their own records

### Empty State (first login, new + migrated clients)
4-step checklist: (1) confirm contact info (pre-filled) → (2) sign pending documents (engagement letter, §7216 consent via Docuseal, embedded) → (3) upload prior-year return → (4) schedule consultation (Cal.com embed). Progress bar; collapses on completion.

### Soto Portal
- **Dashboard**: engagement status in plain English + current stage; outstanding document requests; unsigned documents (signature requests surface here); outstanding invoices with Pay Now; recent messages; quick actions
- **Document Center**: drag-drop/camera upload; categories: Tax Documents / Business Records / ID Verification / IRS Notices / Signed Authorizations / Other; per-file status; portal-only policy enforced in copy; IRS Notice upload auto-creates IRS Notice record + alerts Ana-Maria
- **Sign Documents**: embedded Docuseal — engagement letters, 8879s, consents; signed copies auto-filed
- **My Returns**: all years, status, preparer, filed date; **final return PDF delivered here** (preparer uploads from ATX output); download anytime — replaces Dropbox links
- **Invoices & Payments**: Stripe inline; card on file; history; PDF invoices
- **Subscription Management** (bookkeeping): tier, billing date, payment method, history, upgrade/downgrade request (routes to team)
- **Messages**: threaded, includes texts and emails the client sent (see Communication) — one conversation history regardless of channel
- **Request a Service**: Tax / Bookkeeping / Advisory / Entity / IRS Notice Help / Other → CRM opportunity, 24-hour response commitment
- **Get an Estimate**: guided questionnaire → **price RANGE** (never exact figure) → Cal.com booking embed; range feeds engagement record
- **Resource Library**: all guides/templates (Schedule C, Schedule E, tax guides, Dos & Don'ts, FAQ, IRS Notice guide, welcome packet), EN/ES

### Hilo Portal
- **Dashboard**: relationship status in plain English; next session/workshop; latest session summary; milestone tracker; contextual Soto referral CTA (§7216-aware — only fires with consent on file)
- **My Journey**: sessions, workshops, milestones, referrals timeline
- **Session Notes**: auto-generated summaries + action items + recommended resources
- **Milestone Tracker**: log First Sale / First Employee / First Loan / First Tax Return / First Grant / Revenue Milestone / Other; timestamped + zip code; celebratory UX; feeds funder report
- **Workshops**: upcoming events (synced from Eventbrite), registration link, past attendance, post-event survey prompts
- **Grants**: open grant applications (when a cycle is active), application status, award onboarding (W9 via Docuseal, payment details), post-award check-in surveys
- **Resources**: curriculum by domain (Accounting & Tax / Legal & Licensing / Operations & Training / Branding & Marketing), workshop recordings

---

## UNIFIED CONTACT RECORD

Identity: name, email, phone, secondary phone, preferred contact method (Phone/Email/Portal/Text), **language preference (EN/ES)**, address
Business: name, EIN, entity type, IRS activity code, NAICS, industry, years in business, revenue range, employees
Relationship: Soto status (Lead/Active/Inactive/Former) | Hilo status (Awareness/Exploring/Active/Referral/Alumni/Partner/Inactive) | client-since | Hilo first contact | assigned manager
Compliance: **§7216 consent status + signed doc link** | engagement letter status | 8879 status per tax year
Hilo bridge fields (6): referred by Hilo | Hilo status at referral | referred by Jackson | program participant | Hilo first engagement date | referring staff
Health score (0–100, auto): portal logins 20 | document timeliness 20 | payment history 20 | response time 20 | tenure/depth 20. Green 70+ / Yellow 40–69 / Red <40. Red alerts assigned staff; Green+tenure flags upsell (7216-gated)
Referral tracking: referred by | to Hilo/to Soto + dates | converted | CPA network source | **disclosure-shown timestamp**

---

## TAX OPERATIONS

### Tax Engagement Module
Core: tax year | return type | client type | preparer | reviewer | stage
Pricing: estimated fee RANGE (from calculator) | final fee | discount | tier (admin-configurable price points — Brian adjusts anytime, nothing hardcoded) | scope creep flag (auto when final > estimate top) | scope creep reason (required: additional states / additional Sch C / additional Sch E / foreign / late docs / prior-year cleanup / IRS notice / other+description)
Operational: complexity score L1–5 (formula below) | complexity inputs | client responsiveness score | docs requested/received dates | filed date | gross revenue/contributions (990s)
**Extension fields: extension recommended (Y/N) | extension filed (Y/N) | extension filed date | extension payment estimate | extension payment made (Y/N) | extended deadline (auto-derived from the AUTHORITATIVE TAX DEADLINE TABLE in the v4.3 addendum — never hardcoded)**
Financial: invoice amount/number | payment status | sent/received dates | QB export flag
Compliance: engagement letter signed (GATE past "Scheduled") | 8879 signed (GATE before "Filed") | signature method (remote-KBA / in-person wet)

### Pipeline
Intake Started → Scheduled → Documents Requested → **Pending Client Response** (auto-set on doc request; separates client delay from staff delay) → In Preparation → Internal Review → Client Review → Ready to File → Filed → Completed | On Hold | Withdrawn
**Parallel extension track**: any engagement can carry status "Extended" alongside its stage.

### Extension Workflow (30–40% of clients — full build)
1. **T-minus 21 days** before deadline (Mar 15 / Apr 15): system generates the Extension Decision List — every engagement not yet at Internal Review, sorted by preparer. Brian/Ana-Maria mark: Extend / Push to finish
2. Marked "Extend" → client notification (EN/ES, their channel): extension being filed, what it means (extension of time to FILE not to PAY), estimated payment amount if applicable, new deadline
3. Extension payment estimate workflow: Ana-Maria enters estimate → client notified with payment instructions → payment-made checkbox tracked
4. Extension filed in ATX → preparer checks "Extension Filed" → engagement tagged Extended, deadline swaps per the return-type table above (Sep 15 / Oct 15 / Nov 15 / fiscal-year offset)
5. **Summer document chase cadence**: automated reminders to extended clients at Jun 1, Jul 15, Aug 15 ("beat the fall rush") — escalating copy; stops the October pile-up
6. **Deadline Dashboard**: all engagements against their original and extended deadlines per the AUTHORITATIVE TAX DEADLINE TABLE (v4.3 addendum), with countdown, at-risk flags (extended + docs not received by Aug 15 = red), and estimated-payment due dates (Apr 15 / Jun 15 / Sep 15 / Jan 15) shown alongside return deadlines
7. Q-estimate reminders (Apr/Jun/Sep/Jan) as a bonus automation for business clients flagged for estimates

### Complexity Score
Base 1 | Sch C +1 | Sch E +0.5/property | K-1 +0.5 each | multi-state +0.5/state | foreign +1 | depreciation +0.5 | late docs +0.5 | cleanup +1 | IRS notice +1. Cap L5.

### Return Delivery (ATX handoff)
Preparer finishes in ATX → exports PDF → uploads to client's My Returns via internal UI (drag-drop, auto-files, auto-notifies client in their language) → stage moves to Client Review. One manual step, everything else automatic.

### IRS Notice Module
Linked contact | notice type dropdown + Other | tax year | notice date | response deadline (auto) | handler (Ana-Maria default) | service tier (Standard: client sends / Premium: firm sends on behalf) | status (Received → Under Review → Response Drafted → Response Sent → Resolved / Escalated) | dollar amount | resolution notes
Automations: portal upload → record + Ana-Maria alert (minutes) | deadline <14 days → Brian escalation | unactioned 48h → Brian+Jackson alert | premium tier auto-flags handling

---

## BOOKKEEPING & ADVISORY

Bookkeeping module: tier (Essential/Growth/Full Mgmt) | fee (admin-set) | frequency | Stripe Billing auto-charge + retry | start/renewal | Marian assigned | status
Monthly close: client uploads statements to portal → Marian works **in client's QBO** (no ledger here) → reviewer approves → advisory summary (Full Mgmt) → portal delivery confirmation
Add-ons: sales tax (Rene) | payroll (Rene) | entity maintenance (Laura) | audit support | forecasting/budgeting/planning
Renewal automations: 60/30/7-day notices; failed payment → Rene + client notified, 3-day retry; success → receipt, QB export flag
Advisory/COO module: type | subscription or fixed-fee | advisor (Brian/Jackson) | scope | deliverables | cadence | Discovery→Planning→Active→Review→Renewal→Closed | revenue tracked separately | Jackson's COO utilization on her dashboard
Entity module (Laura): entity type | state | filing date | status | annual report due dates auto-calculated per state | Laura reminded T-60, client T-30 | **PLLC conversion workflow — Illinois licensed professionals (new service line): improper-LLC detection via onboarding Module I, conversion filing checklist, license verification step**

---

## GRANT MODULES (HILO) — TWO PIPELINES

### A. Grants Distributed (micro-grants to entrepreneurs)
Replaces Google Forms + manual scoring + spreadsheet tracking.

**1. Grant Cycle setup (admin)**: name, budget, award size(s), application window, eligibility rules, rubric weights, required documents
**2. Application (bilingual, portal-based)**: eligibility gate questions FIRST — ineligible applicants get a kind auto-message + redirect to other resources (never a dead end). Full application: business details, demographics (drives funder reporting), need/impact narratives, document uploads (bank statement, business license, ID, W9). Duplicate detection against existing contacts — every applicant becomes/links to a contact record
**3. Blind independent scoring**: digitized rubric — TEAM / NEED / GROWTH, each 1–5 with written anchor definitions, weighted. Brian and Jackson score independently; **neither sees the other's scores until both submit** (kills anchoring bias). Composite auto-calculated. **Per-reviewer conflict-of-interest attestation per applicant** — existing Soto clients auto-flagged; reviewer documents or recuses
**4. Selection meeting view**: ranked composite list, side-by-side profiles, **variance highlight** (largest Brian-vs-Jackson score gaps surfaced first — those are the discussion). Decision + one-line rationale recorded per applicant → audit trail for funders and the 990
**5. Award & onboarding**: automated award notification (EN/ES) → recipient portal onboarding: W9 signed via Docuseal, payment method + ACH details captured securely, grant agreement e-signed
**6. Disbursement**: Rene logs ACH initiation via bank (no additional payment vendor); status tracked Award → Onboarding → Disbursed → Closed
**7. Post-award impact**: automated check-in surveys at 30/90/180 days (fund usage, revenue change, jobs, milestones) → feeds funder report + milestone tracker
**8. Decline path**: kind decline (EN/ES) + **automatic invitation into Hilo's advisory pipeline** — the applicant pool converts to relationships, not rejections
**9. Year-end**: recipient export with W9 data + award totals → Ana-Maria. **DECIDED: default treatment is 1099-MISC (Box 3, Other Income) — never 1099-NEC** (grants are not compensation for services). Form type remains configurable per grant cycle in admin so treatment can be adjusted if a future cycle's structure differs; Brian confirms per cycle before forms issue

### B. Grants Received (fundraising pipeline — Jackson leads)
Replaces the Grant Tracker spreadsheet.
Record: funder | program | amount | submission type (LOI/Application/Proposal/RFP) | lead (Jackson default) | internal deadline | hard deadline | status (Prospect → LOI → In Progress → Submitted → Pending → Approved / Denied / Ineligible) | link to materials | notes
**Credentials for funder portals live in Vaultwarden — never in this module, never in spreadsheets**
**Post-award compliance**: per approved grant — disbursement schedule (installments + conditions, e.g. matching-funds triggers), **reporting obligations calendar** (report type + due date, e.g. Matching Funds Report, Final Financial & Narrative), auto-reminders to Jackson T-30/T-14/T-3, report submission logged
Dashboard: pipeline value, submitted vs pending, win rate, upcoming deadlines (application + reporting), awarded-but-unreported flags

### C. Grant Application Assistance (Corridor Lead service)
Lightweight: entrepreneur contact + external grant program + status + hours logged → feeds pro bono service-hours metric and funder report.

---

## WORKSHOPS & EVENTS

- Keep **Eventbrite** for public listing/registration/discovery (free for free events)
- **Eventbrite API sync**: registrants auto-imported → matched/created as contacts → registered on the event record
- **In-survey**: registration triggers a short pre-event survey (portal link): goals, business stage, baseline questions
- Check-in: QR code at door (staff scans or self-serve) → attendance recorded → attendance by neighborhood/zip auto-aggregates
- **Out-survey**: post-event survey auto-sent same evening: satisfaction, learning outcomes, NPS, what next → feeds funder report
- Event record: attendance count, survey response rates, pre/post deltas, neighborhoods reached
- No-shows get a "sorry we missed you + recording/resources" message → nurture

---

## TIME TRACKING (LIGHTWEIGHT)

10-second logging, not timesheets: staff logs time against contact + service type + pro bono flag (Hilo work auto-suggests pro bono). Timer or quick-add (0.25h increments). Feeds: pro bono hours + dollar value (hours × standard rate) for funder reports | staff utilization KPIs | COO/advisory engagement profitability. Session summaries auto-suggest a time entry (duration from recording length) — staff confirms with one tap.

---

## MEETING INTELLIGENCE

Zoom (primary): webhook on end → download recording → Whisper transcribes locally → LLM summary (local; API fallback, text only): 3–5 sentence summary | decisions | action items (owner+due) | tax/accounting need (Y/N+desc) | Hilo→Soto referral rec (Y/N) | Soto→Hilo referral rec (Y/N) → saved to contact → tasks auto-created → referral drafts queued for Jackson/Brian approval (one tap from mobile) → suggested time entry
Phone/in-person: browser-based recorder (no app install) on iPhone — tap record, meeting runs, upload on stop → same pipeline. Voice memo uploads accepted → same pipeline. Meeting type tagged Zoom/Phone/In-Person
Cal.com enforces Zoom-only on initial-consultation event types ("Initial consultations are held via Zoom; link sent after booking")

---

## COMMUNICATION SYSTEM

### The Number (UPDATED July 7 — launch reality): Twilio 708-300-0375 now · 312-715-8599 ports in post-launch
Twilio had no 312/773 inventory at purchase, so the decision changed: launch on Twilio **708-300-0375** (A2P brand approved + campaign registered on this number), and **port 312-715-8599 from Google Voice into Twilio post-launch** as a pure config swap — re-point the Messaging Service to the ported number; nothing else changes.
- **Interim state**: 312-715-8599 remains the published office number on Google Voice, ringing exactly as today. SAOS sends and receives on 708. Rene continues checking the GV inbox for SMS until the port completes
- **Port timing**: after launch, once SAOS inbound call/SMS handling is proven on 708 — never mid-build, never Jan–Apr. Port cutover scheduled mid-morning on a light day
- **Build requirement**: the system is number-agnostic — the Twilio number lives in config, the Messaging Service SID is the send path, and the port must require zero code changes
- **Every SMS and call on the new number flows into the unified inbox AND the client's portal thread**. Team texts clients FROM the system (any staff member, one shared number, full history) — no personal phones
- Voice: inbound calls ring configured staff (Rene primary) with simultaneous ring rules; voicemail transcribed via Whisper → ticket
- Twilio stores nothing beyond message routing; documents never travel by SMS (auto-reply nudges document texts to the portal upload link)

### Unified Inbox (grace period → portal-first)
Email to contact@sotoaccounting.com, SMS, and call tickets all land in one inbox AND mirror into the client's portal thread. Clients keep emailing/texting as long as they like — they see everything in the portal, and history never fragments. Routing: Rene (calls/texts/general) | Ana-Maria (IRS) | Laura (entity/admin) | Marian (bookkeeping). SLA timers per ticket type. No client is ever told their channel "doesn't work."

### Templates (all EN + ES)
Welcomes (Soto/Hilo) | document request | pending-response reminders 3/7/14-day | **extension notice + extension payment reminder + summer doc-chase Jun/Jul/Aug** | return filed | return delivered | invoice sent | payment received/failed | renewal 60/30/7 | IRS notice acknowledgment + resolved | referral intros both directions | portal welcome + bounce fallback | annual report reminders | **grant award / decline+advisory invite / W9 request / impact check-ins** | workshop confirmation + pre-survey + post-survey + no-show

---

## AUTOMATIONS (priority order)

1. Soto intake → contact + engagement + welcome + engagement letter & 7216 signature requests + Rene notified
2. Zoom end → transcribe → summarize → tasks + referral queue + suggested time entry
3. Phone/in-person recording upload → same pipeline
4. Doc request → Pending Client Response + 3-day reminder
5. Client non-response 7 days → Brian+Jackson alert
6. IRS notice upload → record + Ana-Maria alert; <14-day deadline → Brian escalation
7. Engagement letter signed → unlock past Scheduled; 8879 signed → unlock Filed
8. Estimated fee locked → preparation unlocked
9. Final fee > estimate → scope creep reason required
10. **T-21 before deadline → Extension Decision List generated**
11. **Extension marked → client notice + payment estimate flow; filed → deadline swap + summer chase Jun 1/Jul 15/Aug 15**
12. Filed → invoice generated → portal notice → Rene → QB export flag
13. Completed → KPIs + bonus refresh
14. Referral flagged (7216-gated) → pre-filled intake link → Jackson/Brian approval queue
15. Hilo status "Referral" or session flags financial need (7216-aware) → Soto CTA in portal
16. Subscription renewal 60-day → workflow; failed payment → retry + Rene
17. Invoice unpaid 14 days → reminder + Rene flag
18. Health score Red → staff alert; Green+tenure → upsell flag (7216-gated)
19. Annual report T-60 Laura / T-30 client
20. Magic link bounce → Rene verification task
21. **Grant application submitted → eligibility screen → scoring queue; both scores in → selection view ready**
22. **Grant awarded → onboarding (W9/agreement/ACH); disbursed → 30/90/180 surveys; declined → advisory invite**
23. **Funder report deadline T-30/T-14/T-3 → Jackson**
24. **Eventbrite registration → contact sync + pre-survey; event end → post-survey; no-show → resource message**
25. SMS containing attachment/document intent → auto-reply with portal upload link

---

## DASHBOARDS

**Brian default — Executive**: open returns by stage + value | revenue MTD/YTD | MRR | A/R aging | active alerts | staff capacity | health distribution | **deadline countdown widget (next tax deadline + at-risk count)**
**Jackson default — Hilo Ops**: entrepreneurs by status | sessions this month | referral queues (both directions) | session summaries 7-day | milestones 30-day | live funder metrics (entrepreneurs impacted by neighborhood, pro bono hours + $ value, grants distributed #/$, workshop attendance) | **grant cycle status (applications, scoring progress, disbursements)**
**Tax Ops**: pipeline | SLA by preparer | complexity mix | pricing variance | client vs staff delay | **extension board (extended count, docs-received %, Sep/Oct/Nov at-risk reds)** | signature status (unsigned 8879s/engagement letters)
**Bookkeeping**: MRR trend | Marian utilization | upsell candidates | churn risk | Rene billing queue
**Grants (Jackson)**: fundraising pipeline value | win rate | application + reporting deadlines | distribution cycle status | post-award compliance flags
**Team**: KPI scorecards (own-only for staff; all for Brian/Jackson) | SLA by role | bonus projections | capacity | time-log compliance
**Financial**: revenue by line (Tax/Bookkeeping/Advisory/COO/Entity) | collections aging | profitability by line | QB export status
**Alert Center (iPhone push, Brian+Jackson)**: IRS notice 48h | SLA overdue | missing invoice on Filed | non-response 7d | undocumented scope creep | capacity >90% | renewal 30d uncontacted | health Red | magic-link bounce | new service request | **unsigned 8879 within 7 days of deadline | extension at-risk (no docs by Aug 15) | funder report due 14d | grant disbursement pending >7 days**

---

## HILO IMPACT REPORTING

Captured from day one: entrepreneurs impacted (total + by neighborhood/zip) | pro bono hours + dollar value (time log × standard rates) | grants distributed (# + $, from distribution module) | grants received (# + $, from fundraising module) | workshop attendance + survey outcomes | milestones | applicant demographics (from grant applications) | Soto referrals + conversion (ecosystem impact)
Funder report generator: date range → all metrics, neighborhood breakdown, milestone highlights (anonymize toggle), demographic aggregates → PDF/CSV. **The 990 and any grant report should be pullable in minutes, any day of the year.**

---

## DATA MIGRATION

Dubsado: 24–36 months active clients → unified schema, flagged "Source: Dubsado"
Zoho CRM: full export (most complete list) → schema mapping; enrichment queue flags missing email/EIN/entity type/industry; skip 36+ month-inactive unless Brian flags; flagged "Source: Zoho"
Grant history: import Grant Tracker spreadsheet into Grants-Received module (2024–2026 records, statuses, outcomes); move credentials to Vaultwarden and purge from the Sheet
Existing client onboarding: one "we upgraded our portal" email (EN/ES per preference) → magic link → pre-loaded history → 4-step checklist including pending signatures (engagement letter + 7216) → bounce fallback via Rene. Zero-friction goal: open email, tap, see account.

---

## ADMIN INTERFACE (Brian-configurable, no code)

Pricing tiers + points (all services) | SLA windows | alert thresholds | staff + permissions | template copy EN/ES | grant cycle setup + rubric weights | survey questions | **onboarding module builder (no-code: trigger + question pack EN/ES + flags/routing — new industry modules deploy without a developer)** | Cal.com event types | funder report ranges/export | QB export schedule | backup schedule | **content publishing: push distilled second-brain content into Soto/Hilo resource libraries with domain + level tags** (Accounting & Tax / Legal & Licensing / Operations & Training / Branding & Marketing × Foundation / Growth / Scale)

---

## IMPLEMENTATION PHASES

**Phase 1 — Infrastructure, Compliance, Tax, Migration (ship first)**
Docker + staging + Uptime Kuma + Vaultwarden | schema + encryption + audit logs + MFA | CRM + tax module + IRS notices + entity module | pipeline + complexity + scope creep + **extension workflow** | pricing calculator (range) | Docuseal: engagement letters + 7216 + 8879 flow (KBA decision point) | Stripe one-time | Soto portal (bilingual): documents, returns delivery, messages, invoices, signatures, empty state, resources | meeting intelligence (Zoom + mobile recorder) | Cal.com | referral flows both directions (7216-gated) | ntfy push | Executive + Hilo dashboards | Dubsado/Zoho/grant-tracker migration | magic-link onboarding + bounce fallback | admin interface core

**Phase 2 — Communication + Full Client Experience**
**Twilio 708 number goes client-facing** + unified inbox (SMS/email/voice→portal threads); 312-715-8599 port scheduled post-launch as config swap | SLA ticket routing | all templates EN/ES | Hilo portal full (journey, milestones, session notes, workshops, grants) | automation sequences | staff onboarding module | CPA referral network (schema + basic UI) | time tracking

**Phase 3 — Bookkeeping, Advisory, Grants**
Bookkeeping module + Stripe Billing recurring + monthly close + MRR | advisory/COO module + upsell pipeline | Rene billing queue | **Grant distribution module (application → blind scoring → selection → award → disbursement → surveys)** | **Grants-received pipeline + funder reporting calendar (Jackson)** | Eventbrite sync + surveys + QR check-in

**Phase 4 — Team Ops & Compensation**
KPI scorecards live | bonus dashboards | full RBAC for all roles | capacity planning | annual report workflow polish

**Phase 5 — Advanced Intelligence**
Funder impact report generator (full) | revenue + capacity forecasting | pricing optimization (scope creep + complexity data) | CPA network reporting | health trend analysis | content pipeline polish

---

## OUTPUT REQUIREMENTS

Code: fully functional, commented for non-developers, `.env.example` documented
Docker: complete compose (prod + staging), one-command startup, health checks, backup + tested restore scripts
Database: versioned migrations, all fields/constraints/indexes documented
Admin guide: plain English for Brian, no terminal, ≤2 pages per feature; includes WISP security summary export instructions
Per feature: what Brian approves | what runs without him | what alerts him | estimated weekly hours saved

---

## SUCCESS DEFINITION

- Brian opens one screen and knows every return, invoice, delay, deadline, and staff metric — without asking
- A Hilo entrepreneur taps one link and lands in a pre-filled Soto intake; engagement auto-created; consent and disclosure trail intact
- A return moves Intake → Filed with zero Brian involvement unless an exception fires; no return files without a signed 8879; no work starts without a signed engagement letter
- Extension season runs itself: decision list appears T-21, clients are notified in their language, summer chase prevents the October pile-up
- Jackson taps record on her iPhone for a phone call or in-person session and gets summary, tasks, referral draft, and a suggested time entry
- A client texts the office number and the thread appears in their portal; no conversation ever lives on a personal phone
- Grant cycles run application → blind scoring → documented selection → Docuseal onboarding → ACH → impact surveys, and declined applicants become advisory relationships
- Jackson never misses a funder deadline — application or report
- Any funder report or 990 data pull takes minutes, any day of the year
- Client PII never touches a third-party server beyond Stripe payment tokens, Twilio message routing, SES email routing, and the per-signature KBA check; every document access is audit-logged; infra <$75/month
- Brian's admin time <5 hours/week; new staff onboarded <2 hours

---

*Sources: SAOS v1.0 Blueprint (all volumes), Tax Operations Manual, Hilo Brand Guidelines (Mar 2026), Hilo MORA Report (2026), DRK Grant Tracker + K2K application materials + funder grant letters (Google Drive), and planning sessions with Brian Soto.*
*Stack: Docker | PostgreSQL | MinIO | Whisper | Ollama | Docuseal | Cal.com | Vaultwarden | Uptime Kuma | Postal + SES relay | ntfy | Stripe | Twilio | KBA API*
*Replaces: Zoho One + Zapier + Otter.ai + Adobe Sign + Calendly | Net savings ~$120–200/month*

---

## v4.1 CHANGELOG (July 5, 2026 — all blocking decisions locked)
1. **KBA approved** — per-signature KBA API is the remote 8879 path; pluggable vendor interface; wet signature remains for in-office clients
2. **Twilio, new 312 number** — no port of 312-715-8599; legacy-number transition plan added; off-season porting constraint removed; number provisions in Phase 1
3. **Soto brand corrected** to the Forest Teal system (`#0D3B38` primary, Electric Teal `#00C9BF` accent, "SOTO." Inter 800 wordmark) — supersedes the v4.0 Deep Navy working palette
4. **teamhilo.org confirmed** registered and current — Hilo subdomains build as specced
5. **Hosting locked**: Hetzner CPX41 16GB (up from 8GB — Whisper/Ollama headroom); maintenance developer is a post-build hire
6. **Placeholders approved** for §7216 consent + engagement letter templates; final legal text is a launch gate enforced by the system, not a build gate
7. **Extended-deadline logic corrected**: derived from return type + fiscal year end (990 → Nov 15; 1120 → Oct 15; fiscal-year offsets) — was a hardcoded Sep/Oct swap that missed 990s and C-corps
8. **Grant-recipient 1099 export**: default is 1099-MISC Box 3 (Brian's determination — grants aren't service compensation, so never NEC); form type stays configurable per cycle
9. **Outbound email relays through Amazon SES** (deliverability risk mitigation for magic links + compliance documents); Postal retained for everything else
10. **Companion forms spec (v4.1)**: bridge fields renamed BR1–BR6 (ID collision with Module B fields); Module B now fires on Food & Beverage industry alone so tax-only restaurant clients still get delivery-app / cash % / tips scoping

---

# v4.2 ADDENDUM — SERVICE DELIVERY MODEL, NEW MODULES, PRICING SEED DATA
*Grounded in review of 147 Soto Accounting client session transcripts (2026) + the 2025 pricing workbook + client-facing service sheet. This addendum is spec, equal in authority to everything above.*

## SERVICE DELIVERY MODEL (two-axis + scope ladder) — DECIDED
The recurring engagement configurator has two independent dials plus a per-service scope ladder:

**Dial 1 — Prep cadence**: how often books are closed and financial statements compiled. Options: weekly / monthly / quarterly / semi-annual. Prices bookkeeper labor.
**Dial 2 — Session cadence**: how often the client gets a CPA session with Brian. Options: weekly / biweekly / monthly / quarterly / semi-annual / annual. Must be equal to or less frequent than prep cadence. Prices Brian's time.
**Scope ladder** (per service line — Accounting, Payroll, Sales Tax): Registration & Setup → Review/Audit → Admin & Training Support → Full Management & Compliance. The Training rung is the deliberate Hilo bridge product: DIY-minded DRK participants buy training; scaling businesses buy Full Management.

Rules:
- Engagement price = prep-cadence base + session-cadence component + scope add-ons, all from the price book
- **S corp floor**: any client with an active S election gets a minimum of 2 sessions/year regardless of configuration (owner-comp calibration + estimated payments). Configurator enforces
- **Maintenance mode**: a downgrade path (keep prep cadence, reduce session cadence) presented as a positive state — prevents both over-servicing and churn. Renewal flow offers it explicitly when session utilization is low
- Custom high-touch (e.g., weekly financials + biweekly payroll sessions) is just a configuration, not a bespoke SKU
- **Independence rule (attest)**: before an attest engagement (CPA review/audit) can be created for a client, the system checks for active bookkeeping/payroll/management services at Soto and blocks with a warning if found — independence conflict requires Brian's explicit documented override or referral out. Cristian Borcan's attest work is walled from firm-prepared books

## NEW MODULES (all DECIDED — build)
1. **Grant Vouchering / Nonprofit CFO service line**: budget-to-actual tracking per grant/contract with allocation percentages per expense line, indirect-rate calculation, remaining-budget view, and voucher export. Serves paying nonprofit/co-op clients (18th St Casa, Healthy Hood, PIHCO, Community WEB, CCSA pattern) AND shares its engine with Hilo's internal grant management. Session screen-share replaces the current ad-hoc spreadsheet
2. **Entity groups**: data-model construct linking multiple entities + their owners into one relationship (e.g., Koziura Construction + Frio Equity; Bueno Days + building LLC; Sente Foundry + Sente Advisory). Consolidated dashboard, one session can attach to a group, cross-entity notes, group-level billing option. Intake asks "Do you own or co-own other businesses?" and links/creates group membership
3. **IL SOS compliance monitor**: self-hosted scraper checks Illinois Secretary of State good standing at intake (Brian currently does this by hand on every discovery call) and on a schedule for active clients; portal shows a compliance badge; not-in-good-standing triggers a task + client notification with fix steps. Feeds the existing annual-report reminder engine (Laura T-60 / client T-30)
4. **Client W9/1099 tool**: from the portal, a client sends a W9 request link to their own contractor; contractor completes via Docuseal; W9 stored under the client; year-end 1099 prep pulls the client's W9s + payment totals. Extends the Docuseal W9 flow already built for Hilo grants. Replaces the current email-print-Dropbox loop
5. **Estimated payment tracker**: each CPA session can log a quarterly recommendation (federal $ / state $ / due date) per client; client marks paid (or uploads confirmation); dashboard shows rec vs. paid by quarter; full history hands to Ana-Maria at return prep. Client-facing framing uses Brian's "IRS bank / state bank" language (EN/ES)
6. **Session recaps (client-facing)**: after the meeting-intelligence summary, a bilingual client recap (what we covered, your action items, our action items, next session) is drafted and queued for Brian's one-tap approval before sending to the client's portal thread + email. Approval-gated, never auto-sent. This is the client-visible half of the session product
7. **Resource & referral directory**: curated directory in both portals — lenders, attorneys, insurance, licensing help, Hilo programs, CPA network — each entry with intro-request button that logs a referral record (both directions, ties into existing referral tracking + §7216 gating where tax data is involved). Institutionalizes the verbal routing Brian does in nearly every session
8. **Two-lane booking (Cal.com)**: Lane 1 "New Client Discovery" — collects the service-level deposit via Stripe at booking (true-up model below). Lane 2 "General Inquiries / Customer Support" — free, available to clients and prospects; policy: questions are always free (retention asset — codified, surfaced in portal as "Book a question call — no charge"). Existing-client session bookings come from their engagement's session allotment

## BILLING ARCHITECTURE (v4.2)
- **Price book**: every price in the system lives in a versioned, effective-dated price_book table. Admin edits create a new version; engagements reference the version in force at signing. NO price is ever hardcoded — launch-day increases are a data change
- **Price lock / grandfathering**: engagement-level field (locked price + lock expiry, e.g., "first-year base hold") — matches Brian's observed practice
- **Deposit + true-up**: bookings collect the service's deposit (Stripe); completed work reconciles against the itemized final quote — overpayment auto-credits the client balance, underpayment bills the difference. Language from the current pricing sheet carries into engagement letters
- **Bundling rules engine**: price book supports bundle rules (e.g., QBO setup + payroll setup together = one $250 fee; ST-1 filings free with monthly package; forecasting + margin analysis free with monthly package)

## PRICING SEED DATA (price book v1 — seed values; Brian confirms flagged items before launch)
*Source: 2025_new_process_buildoutpricing_v2.xlsx ("pricing packages" sheets = canonical calculator), 2025 Business/Personal Service Sheet, and 2026 session transcripts. Where sources conflict, the most recent verbal quote wins and the conflict is flagged ⚠.*

**Individual tax — itemized calculator** (one federal + one state included):
Base: Single $150 · MFJ/MFS $200 · HOH $200 · Additional state $150
Add-ons: Sch C $180 · Sch A $100 · Sch B/D $120 · Sch E rental $180 · Sch E K-1 $120 · Sch H $120 · Sch EIC $150 · Form 8863 education $100 · Form 8995 QBI $75 · Form 4562 depreciation $120 · Form 2441 dependent care $50 · Form 8812 CTC $50 · Form W-7 ITIN $350 (+$250 each additional) · Form 5695 energy $50 · NOL carryover $150 · Form 8949 §121 home sale $150 · Form 8936 clean vehicle $150
Other: Amendment (1040-X) $300 · Notice/penalty/installment support $150 · Audit defense $150 · CPA letters / wealth statements / tax planning $250–500 ⚠ (sheets conflict) · Specialized hourly $150/hr

**Business tax returns** (one federal + one state included):
Sch C (sole prop or SMLLC) $180 · 1065 $600 · 1120-S $700 · 1120 $800 · 990/EZ $800 · 1120-C housing co-op $800 · 1120-F $800 · 1120-H $800 · 1120-POL $800 · Additional state $350 · Amendment $600 · Notice support $300

**Recurring accounting (Full Management)**: Monthly $250/mo · Quarterly $600/qtr · Semi-annual $1,000/6mo ⚠ (service sheet $900, workbook $800, most recent verbal $1,000 — confirm) · Catch-up/cleanup $75/hr
**Scope ladder prices** (per line): Registration & Setup $250 · Review/Audit $150 · Admin & Training Support $150 · Full Management: Payroll $500 (W-2/940/941/944/UI) · Sales tax $100 ⚠ (ST-1 $50/filing on service sheet; free with monthly package — encode as bundle rule)
**Setups & conversions**: QBO setup $250 · Payroll setup $250 · Both bundled $250 · S corp conversion (Form 2553) $250 · Owner-comp default: ⅓ of net profits
**Software pass-through** (not Soto revenue; show on quotes): QBO from ~$40/mo · QBO Payroll from ~$50/mo (~$90–100/mo combined typical)
**1099/W-2 filings**: $50 base + $10 per form
**Entity services**: Formation w/ EIN $500 ⚠ (older sheet $250 — confirm) · 501(c)(3) Form 1023 $500 · Annual report $130 ⚠ (older sheet $60 — confirm) · Amendment $120 · DBA $120 · BOI report $120
**Attest**: CPA financial statement review $2,500 · CPA audit $5,000 · Workers comp/payroll insurance audit $250
**Specialized CPA** ($500 each, or $150/hr per service sheet ⚠ — confirm canonical): CPA letters of confirmation · Loan/funding due diligence · Tax planning & analysis · Forecasting/budgeting (forecasting + profit-margin analysis free with monthly package — bundle rule)
**COO services** (ops/people/branding catalog): $150/unit; engagement styles: advisory retainer · fixed-scope project · fractional ops retainer
**Deposits (true-up model)**: 1040 $250 · business tax per-service ⚠ (observed $300 discovery deposit — confirm one standard discovery deposit vs. per-service deposit schedule)

## MIGRATION & INTAKE NOTES (v4.2)
- **Dropbox → portal transition**: existing clients are trained on Dropbox upload links; migration comms sequence (EN/ES) required at portal launch; Dropbox links continue accepting for 2 transition months with auto-import into the client's portal folder
- **SSN capture**: intake keeps the "provide by phone" escape hatch (current form behavior) alongside secure portal entry; returning clients see "on file" state
- Session titles auto-generated as "CLIENT — Session Type" to match existing convention

## v4.2 CHANGELOG (July 5, 2026)
1. Service Delivery Model decided: two-axis (prep cadence × session cadence) + per-service scope ladder (Setup/Review/Training/Full Mgmt); S corp 2-session floor; maintenance-mode downgrade path
2. Eight new modules approved: grant vouchering/nonprofit CFO, entity groups, IL SOS compliance monitor, client W9/1099 tool, estimated payment tracker, approval-gated session recaps, resource & referral directory, two-lane booking with deposit collection
3. Billing architecture: versioned effective-dated price book, engagement price locks, deposit + true-up reconciliation, bundle rules engine
4. Pricing seed data embedded (with ⚠ flags on the 6 cross-source conflicts for Brian's confirmation)
5. Payroll, Sales & Use Tax, Nonprofit CFO/Grant Vouchering, Attest, and Specialized CPA added to the service catalog (payroll was an omission — it's actively sold)
6. Cristian Borcan (contract auditor) added to staff; attest independence check enforced in code
7. Dropbox migration plan, SSN-by-phone option, session title convention

---

# v4.3 ADDENDUM — DEADLINE TABLE + SEVEN OPERATIONAL FLOWS
*Corrects the 990 deadline error (May 15 is the ORIGINAL due date; Nov 15 is extended), adds estate and foreign returns, and closes the seven workflow gaps identified in wireframe review. Equal in authority to everything above.*

## AUTHORITATIVE TAX DEADLINE TABLE (replaces every prior partial list in this document)
Calendar-year filers; all deadlines roll to next business day per IRS rules.

| Return type | Original due | Extended due |
|---|---|---|
| 1065 (partnership) | Mar 15 | Sep 15 |
| 1120-S (S corp) | Mar 15 | Sep 15 |
| 1040 (individual) | Apr 15 | Oct 15 |
| 1120 / 1120-C / 1120-H / 1120-POL | Apr 15 | Oct 15 |
| 1041 (estate/trust) | Apr 15 | Sep 30 |
| 990 / 990-EZ (nonprofit) | **May 15** | **Nov 15** |
| 1120-F (foreign corp, US office) | Apr 15 | Oct 15 |
| 1120-F (foreign corp, no US office) | Jun 15 | Dec 15 |
| 1040 expat (abroad on Apr 15) | Jun 15 (automatic) | Oct 15 |
| FBAR (FinCEN 114) | Apr 15 | Oct 15 (automatic) |
| Fiscal-year filers | 15th day of month 4 after year-end (month 5 for 990) | +6 months |
| **AG990-IL (IL Attorney General charity annual report)** | Within 6 months of FYE (Jun 30 for calendar-year orgs) | 60-day extensions available on written request (up to two) |

**Estimated payments**: Q1 Apr 15 · Q2 Jun 15 · Q3 Sep 15 · Q4 Jan 15. Shown on the staff deadline board alongside return deadlines. **Client portal: estimate due dates are a per-client toggle (default ON)** in notification settings — clients who don't want estimate reminders turn them off; the staff board always shows them.

Deadline derivation is ALWAYS from this table + entity fiscal year end. Any hardcoded date pair anywhere in the codebase is a build failure.

## SEVEN OPERATIONAL FLOWS (all DECIDED — build)

### 1. E-file rejection & IRS notice management
- **Rejects**: a return marked e-filed can bounce. Reject event re-enters the preparer's queue at top priority with the reject code + reason, engagement status flips from Filed → Rejected, deadline clock recalculates (IRS perfection period: 10 days business / 5 days individual after reject — tracked). No dead-end states: Filed is not terminal until acceptance confirmed.
- **Notices**: any IRS/state notice creates a ticket owned by Ana-Maria, tied to the client record, with the notice type (CP2000, balance due, ID verify, etc.), response deadline, and document upload slot for the notice scan. Notice support billing per price book ($150 individual / $300 business).
- **Client-visible status (DECIDED)**: the client portal shows notice state in plain language — "Notice received — we're handling it. Response due [date]." — with EN/ES copy. Status auto-updates as the ticket moves. Kills "did you get my letter?" calls.

### 2. Entity-group workflow
- **Consolidated packet**: an entity group (e.g., construction co + equity LLC, same owner) presents one packet to the preparer covering all group returns; one session covers the group; group dashboard shows all entities' engagement states.
- **Signatures**: 8879s remain per-return (IRS requirement) but bundle into ONE Docuseal envelope = one KBA check, one signing session for the owner.
- **Billing (DECIDED — per-group option)**: default is one consolidated invoice at group level, line-itemed per entity. Each group carries a billing-mode setting: `consolidated` (default) or `per-entity` — some clients want separate invoices per entity for clean books. Set in the service configurator, changeable anytime.
- **Estimates**: tracked per-entity with a group rollup view.

### 3. Silent-client escalation ladder + auto-extension batch
- **Ladder** (any waiting-on-client state, applies to active engagements AND in-progress onboarding): Day 3 portal reminder → Day 7 SMS nudge → Day 14 call task assigned to Rene → Day 30 engagement flagged STALLED (owner dashboard, work paused). All automatic; every rung logged on the client record.
- **Auto-extension batch (DECIDED)**: in season, tax engagements with incomplete docs at the cutoff — **Mar 25 (business returns) / Apr 1 (individual)** — are automatically added to the extension batch. Client is notified ("we're filing a protective extension — this is normal and protects you"), Brian reviews the batch list before preparers file. Extended engagements re-enter the normal flow with extended deadlines from the table above.

### 4. AR dunning & late fees
- **Failed recurring charge (Stripe)**: auto-retry 3× over 10 days with client notification each attempt → unresolved: call task to Rene → 30 days unpaid: engagement work pauses (status visible to client: "account needs attention").
- **Unpaid true-up invoices**: same ladder from invoice due date.
- **Late fees (DECIDED)**: industry-standard **1.5% per month (18% APR) on balances 30+ days past due**, admin-configurable in the price book, applied automatically, itemized on the invoice. GATE: late fees only apply to clients whose signed engagement letter contains the late-fee disclosure — the system checks before applying. (Add the disclosure to all engagement letter templates; placeholder set included.)
- Deposits and credits always net against balance before any fee calculates.

### 5. Bookkeeping close cycle (Marian's workbench)
- Per-client close checklist per prep cadence (weekly/monthly/quarterly/semi-annual): transactions categorized → reconciliations done → statements generated → close marked complete.
- **Statements auto-post to the client portal on close** — no owner review gate (the session discusses what the client has already seen).
- **Session cross-check (DECIDED)**: on close, the system checks the calendar for an existing recurring session with that client. Recurring bookkeeping clients already have sessions scheduled → statements simply attach to the upcoming session, no action created. Only when NO session exists — new bookkeeping client's first review, one-time/cleanup client's first walkthrough — does the system create a scheduling task/booking link. Never double-book; never assume.

### 6. Grant vouchering tracker (Brian-operated)
- **Operator: Brian.** Status-only tracking, NO file generation — Brian prepares vouchers in his own working files; the system tracks that the work happened.
- Per client grant/contract: voucher periods (monthly/quarterly per grant calendar) each with status Due → In progress → Submitted → Reimbursed, amount fields, and reminders to Brian at period open and T-7 before funder deadline.
- Dashboard tile: vouchers due this month across all nonprofit clients, overdue in red. History per grant feeds the client's nonprofit-CFO session.

### 7. Stalled-onboarding rescue
- Onboarding is a tracked pipeline: Deposit paid → Questionnaire → Docs → Complete. Any stage idle triggers the same Day 3/7/14 ladder (portal → SMS → Rene call); Day 30 flags the onboarding STALLED on the owner dashboard.
- **Deposit policy (DECIDED)**: stalled deposits are held as client credit indefinitely — never auto-refunded. At Day 60 the record surfaces to Brian for a personal decision (rescue call, refund, or hold). The system prevents forgotten deposits; the refund call stays human.

## v4.3 CHANGELOG (July 7, 2026)
1. **990 deadline corrected**: May 15 is the original due date, Nov 15 the extension — prior versions listed only Nov 15
2. **Authoritative deadline table** added: 1041 estate (Apr 15/Sep 30), 1120-F foreign (both variants), expat Jun 15, FBAR; all derivation from the table, estimates on staff board, client-side estimate toggle (default ON)
3. **Rejects & notices**: reject re-queue with perfection-period clocks; Ana-Maria notice tickets; client-visible plain-language notice status (EN/ES)
4. **Entity groups**: consolidated packet + one bundled KBA envelope; billing mode per group — consolidated (default) or per-entity by client preference
5. **Escalation ladder** (D3 portal / D7 SMS / D14 Rene call / D30 stalled) + **auto-extension batch** at Mar 25 / Apr 1 cutoffs with owner review before filing
6. **AR dunning**: Stripe retry ×3/10d → call task → 30-day work pause; **late fees 1.5%/mo after 30 days**, engagement-letter-disclosure gated, admin-configurable
7. **Books close cycle**: statements auto-post on close; calendar cross-check — attach to existing recurring session, only create scheduling task when none exists (first reviews, cleanup clients)
8. **Grant vouchering tracker**: Brian-operated, status-only (Due/In progress/Submitted/Reimbursed), no file output, funder-deadline reminders
9. **Stalled onboarding**: pipeline rescue ladder; deposits held as credit, surfaced to Brian at Day 60, never auto-refunded

---

# v4.4 ADDENDUM — UNIFIED TASK SYSTEM + FULL-STACK REPLACEMENT AUDIT
*Decisions: full Trello replacement (1), client-visible to-do lists (2), auto task creation from sessions (3). Plus the modules the stack audit surfaced. Equal in authority to everything above.*

## UNIFIED TASK & PROJECT MANAGEMENT (full Trello replacement — DECIDED)
The connective layer every other module writes into. One task table, many views.

**Task object**: title, description, assignee, due date, priority, status, optional client/engagement link, source (which module or human or AI created it), comments thread, checklist items, linked documents, optional SOP link, optional time log.

**Views**:
- **My Tasks** — every person's single list across all modules (Rene's escalation calls + phone tickets + anything manual, one screen)
- **Client record tasks** — all open/done tasks on any client, staff-side
- **Owner rollup** — Brian's "needs you today" tile expands to: approvals waiting, stalled flags, Day-60 deposits, vouchers due, plus anything assigned to him
- **Team workload** — open tasks per person for assignment balancing and coverage when someone's out (the Jackson-recovery scenario, systematized)
- **Project boards** — kanban boards for non-client work: firm projects (Hilo rebrand, 10-year event), Brian's personal board, custom columns, drag between columns

**Mechanics**:
- **AI auto-creation (DECIDED)**: meeting intelligence auto-creates staff tasks from sessions — no approval gate on internal tasks; the client-facing recap approval remains the safety layer
- **Client to-dos (DECIDED)**: the portal shows each client a standing "Your to-dos" list (upload P&L, sign 8879, mark Q2 estimate paid). Staff can add items; system items auto-close on completion (an upload closes its request). Client to-dos drive the D3/D7/D14 escalation ladder
- **Recurring tasks & checklist templates**: tax-season opening checklist, onboarding checklist, month-close checklist — instantiable per client or per season
- **Trello import**: one-time importer for Trello board export JSON (Soto Accounting workspace + Brian's workspace) — boards, lists, cards, due dates, assignees mapped
- **Lightweight time log**: manual minutes or start/stop on any task/engagement; hourly work ($75 cleanup, $150 specialized) flows from time logs to invoices — no separate time-tracking product

## QUOTE BUILDER (closes the pre-client pipeline)
Brian quotes live on discovery calls from the pricing sheet; the system makes that a record instead of a verbal.
- Live-quote screen: pick services from the price book → itemized quote exactly mirroring the call flow (base by filing status + schedule add-ons + first-time discount) → save as quote record on the lead
- Quote sends as a portal link; client accepts → converts to engagement + deposit checkout, zero re-entry
- Leads pipeline stages: Call booked → Quoted → Deposit paid → Onboarding → Client; conversion metrics per stage and per referral source

## REPORTS & KPIs
Owner-facing analytics, exportable CSV: revenue by service line and month, AR aging, pipeline conversion, session utilization per client (feeds maintenance-mode suggestions), team throughput (tasks/returns completed), client counts by industry and cadence, referral-source performance (client-to-client, Hilo bridge, partners). Dashboard tiles configurable.

## CLIENT ANNOUNCEMENTS + REVIEW REQUESTS
- **Broadcast module**: segmented announcements (all clients / by service / by language) over SES email and Twilio SMS — deadline-season reminders, firm news, EN/ES. CAN-SPAM unsubscribe on every email, TCPA opt-out on every SMS, suppression enforced at send. Every broadcast is approval-gated; nothing bulk sends itself
- **Review-request automation**: milestone-triggered (return accepted, onboarding complete) Google review link supporting the GBP strategy — throttled per client, opt-out respected, never after a notice/dispute engagement

## SOP KNOWLEDGE BASE (the runs-without-Brian layer)
- Internal wiki: SOPs per role and process (Rene's phone flows, Marian's close checklist, Ana-Maria's notice playbook, Laura's annual-report steps), versioned, searchable
- Task types link to their SOP ("how to do this" on the task itself) — new hires execute from tasks, not tribal knowledge
- Whisper-transcribed training/handoff sessions can seed SOP drafts (approval before publish)

## HILO EVENTS (Eventbrite replacement)
Bilingual event pages for Hilo workshops: registration with capacity caps, confirmation + reminder email/SMS, attendee check-in list, post-event follow-up sequence into the Hilo CRM and (7216-gated) referral pipeline.

## STACK DISPOSITION TABLE (the replacement verdict)
| Current tool | SAOS verdict |
|---|---|
| Zoho One, Zapier, Otter, Adobe Sign, Calendly, Dubsado, Google Voice | **Replaced** (as previously specced) |
| Trello (both workspaces) | **Replaced — fully** (task system + project boards + importer, this addendum) |
| Dropbox (client uploads + Otter sync) | **Replaced** (portal uploads; Whisper) |
| Grant Tracker sheet, Eventbrite | **Replaced** (grant module + vouchering tracker; events module) |
| Squarespace (website) | **Replace post-launch**: v2 website moves to the SAOS server once the portal has run a real onboarding — root-domain DNS cutover is the last flip |
| ATX | **Kept by design** — no integration, PDF handoff |
| Client QuickBooks Online | **Kept — client property.** Marian continues as accountant user in client files; SAOS tracks the work, never replaces the client's ledger |
| Soto's own firm books (QBO) | **Deferred candidate** — SAOS already owns invoicing/AR; migrating the firm's own general ledger is a post-launch evaluation, not v1 |
| Zoom | **Kept** — recordings feed Whisper; video conferencing isn't worth rebuilding |
| Outlook (general business email) | **Kept** — client communication threads live in SAOS; the general inbox stays Outlook |
| Team payroll provider | **Kept** — regulated domain, out of scope |
| Obsidian / second brain | **Kept for notes (PKM)** per the existing markdown architecture; SAOS takes all tasks and projects |
| Stripe, Twilio, SES, KBA | **Kept** — the four approved vendors |

## CONFIG CORRECTION (July 7, 2026)
The Communication section previously said "NEW 312 number, no port" — superseded: no 312/773 Twilio inventory existed, so launch is on 708-300-0375 (A2P registered) with 312-715-8599 as a post-launch port. Spec now matches deployed config. Number-agnostic build requirement added.

## v4.4 CHANGELOG (July 7, 2026)
1. Unified task & project management: one task table under every module, My Tasks per person, owner rollup, team workload, kanban project boards, recurring checklists, Trello importer, lightweight time log feeding hourly invoices
2. AI session tasks auto-create for staff (client-facing recaps stay approval-gated); clients get a standing portal to-do list wired to the escalation ladder
3. Quote builder + leads pipeline: live quotes from the price book that convert to engagements without re-entry
4. Reports & KPIs module; client announcements (compliance-gated broadcast) + milestone review requests; SOP knowledge base linked from tasks; Hilo events module
5. Stack disposition table: full replacement verdict per tool — ATX, client QBO, Zoom, Outlook, team payroll, and Obsidian PKM kept; everything else replaced or scheduled

---

# v4.5 ADDENDUM — TASK SYSTEM UX SPEC (Zoho CRM parity)
*Source: review of the firm's live Zoho CRM (screenshots in docs/reference/). The v4.4 task system defined the data layer correctly; this addendum defines the UI/UX depth it must ship with. Supersedes any thinner task-view implementation.*

## VIEWS & NAVIGATION (every view, not one)
- **View switcher per task surface**: List (dense table, sortable columns, inline edit, column chooser) · **Kanban** (group-by ANY picklist field — default Status; column headers show counts; drag cards between columns updates the field) · Calendar (by due date) · Timeline
- **Saved views**: "All Tasks" system default plus user-created saved views — a saved view persists filters + sort + visible columns, is nameable, and can be shared to the team or kept private (e.g., Rene's "My calls this week", Brian's "Everything overdue")
- **Filter panel** (left rail, collapsible): free-text search; system filters (overdue, due today, due this week, created by me, delegated by me, touched/untouched in X days, locked); field filters on every task field — due date, priority, status, assignee, client, business, subject, tag, created/modified by and time
- Sort control on any field, persistent per view

## TASK RECORD (full field set)
Owner/assignee · Subject · Due date · **linked Contact AND linked Business/Account — two independent lookups** (a task can attach to Hector the person, Mi & Co Collective the business, both, or neither) · Status · Priority (High/Normal/Low) · **Reminder toggle** (date/time → notification through the unified channel) · **Repeat toggle** (recurrence rules: daily/weekly/monthly/quarterly/annually + custom — quarterly ST-1 filings, monthly QBO edits, annual AG990 are live recurring patterns) · Description · Tags · Checklist · Comments thread · SOP link · Time log · Source

## STATUSES (updated set — matches live usage)
**Not Started · In Progress · Waiting for input · Completed · Deferred**
"Waiting for input" is load-bearing: it is the waiting-on-client state, and entering it AUTOMATICALLY attaches the D3/D7/D14/D30 escalation ladder to the task's client. The firm already works this way in Zoho; SAOS makes the column self-chasing.

## RECORD ACTIONS & PRODUCTIVITY
- **Save and New** (rapid sequential entry), duplicate task, close-and-create-follow-up
- **Bulk operations**: multi-select in list view → mass update status/owner/due date, mass complete
- **Editable page layouts**: admins can reorder fields, add sections, and set required fields on the task layout (extends the existing no-code module builder to tasks) — "Edit Page Layout" affordance on the record
- **Meeting auto-tasks** keep the live naming convention: "Meeting: {Client} — {Session type}"

## MODULE PARITY MAP (Zoho → SAOS disposition)
| Zoho module | SAOS |
|---|---|
| Tasks / Meetings / Calls | Unified task system + comms threads (this spec) |
| Quotes + Price Books | Quote builder + versioned price book (v4.4) |
| Invoices | Billing/AR (v4.2–4.3) |
| Campaigns | Client announcements (v4.4) |
| Cases | Tickets: notices, phone tickets, service requests |
| Solutions | SOP knowledge base (v4.4) |
| Documents | Client document vault |
| Tax Engagements (custom) | Engagement module (native) |
| Appointments | Cal.com booking |
| Reports / Analytics / Forecasts | Reports & KPIs (v4.4); revenue forecast = report, not module |
| **Sales Orders, Purchase Orders, Vendors, CPQ, Social, Visits** | **OUT OF SCOPE — inventory-commerce and social modules a CPA firm doesn't need; CPQ's conditional pricing is covered by price-book bundle rules** |

## LIVE-BOARD DISCOVERIES (resolved July 11)
1. **AG990-IL — CONFIRMED, IN ARCHITECTURE**: added to the authoritative deadline table above. Due within 6 months of FYE (Jun 30 for calendar-year orgs); IL AG grants 60-day extensions on written request. Applies to every client with an IL charitable registration (the nonprofit cluster) — the compliance calendar derives it per-client from FYE, and it appears on the deadline dashboard alongside the 990. Note for build: AG990-IL is a STATE charity filing independent of the federal 990 — a client can be extended federally and still owe the AG990-IL on its own clock.
2. **Hector Pardo / Michelle Zhang — RESOLVED: do not add.** Staff roster stays as the existing table; ignore these Zoho task owners in any Trello/Zoho migration mapping (map their historical items to unassigned or to Brian, do not create accounts).
3. Confirmed live patterns now encoded: meeting→task auto-creation, "Waiting for input" as a first-class state, recurring compliance filings (ST-1, 1099 season, QBO edit cycles, AG990-IL annual) as repeat tasks.

## v4.5 CHANGELOG (July 11, 2026)
1. Task System UX spec at Zoho parity: four view types, saved/shared views, full filter rail, dual contact+business lookups, reminder + recurrence, Save-and-New, bulk ops, admin-editable layouts
2. Status set updated — "Waiting for input" added and wired to the escalation ladder; "Deferred" added
3. Module parity map: Sales/Purchase Orders, Vendors, CPQ, Social, Visits formally out of scope
4. AG990-IL added to the deadline table (6 months post-FYE, independent of federal 990 extensions); Hector Pardo + Michelle Zhang excluded from roster — historical migration items map to unassigned/Brian

---

# v4.6 ADDENDUM — TAX RESOLUTION LANE + BUNDLE BUILDER
*Multi-year non-filer clients (the classic Hilo-pipeline entrant) and the general bundle mechanism. All items DECIDED. Equal in authority to everything above.*

## TAX RESOLUTION LANE (multi-year engagements)

### Intake & engagement spawning
- Resolution intake path: "Which years are unfiled?" multi-select per return type, plus per-year "do books exist for this year?" — **default scope is the 6-year non-filer norm (DECIDED)**, with per-client override to include older years
- Accepting the quote spawns **one engagement per year per return type**, plus a paired bookkeeping-reconstruction engagement for each year without books
- Quote builder renders a **years × services grid** composed from the price book

### Authorization gating (DECIDED)
- **Form 8821 signs via Docuseal at onboarding** for every resolution client — before any document work; transcript-request task auto-creates on signature
- **Form 2848 (POA) swaps in only when representation begins** (abatement, installment agreement, exam) — a per-engagement upgrade, tracked on the client record with scope years

### Prior-year deadline mode (statute clocks, not filing deadlines)
- Per unfiled year, the dashboard shows: **refund statute expiry (3 years from the original due date — after which the client's refund is forfeited)** with countdown; 6-year lookback boundary; SFR-risk flag when IRS transcripts show a substitute return
- Refund-statute countdowns are urgency that sells and serves: surfaced on the client portal for their own years ("your 2023 refund expires April 2027")

### Filing-method derivation (DECIDED — automatic)
- Current + two prior tax years → standard e-file lane (KBA remote 8879)
- Older years → **paper lane**: print-packet checklist, wet-signature 8879, certified-mail task with tracking-number field, mailed-date stamp, and a distinct closing checklist. The system derives the lane from the year; staff never choose

### Task dependencies (new task-system capability, general)
- Tasks gain **"blocked by"** relations; blocked tasks render distinctly, cannot complete before blockers, and unblocking cascades notifications to assignees
- Resolution engagements auto-chain **oldest-year-first (DECIDED)**: books(Y) → return(Y) → books(Y+1) → return(Y+1)…, honoring carryforwards

### Resolution engagement types
- Penalty abatement (first-time + reasonable-cause) and installment-agreement setup as engagement types with price-book entries (seed at Specialized $500 each ⚠ confirm), each requiring active 2848

## BUNDLE BUILDER (general mechanism — DECIDED)
- Admin composes a **bundle** from price-book items: fixed components + **optional components** (client-selectable at quote time, e.g., "add recurring quarterly package")
- Bundle pricing: sum of components minus a **discount (percent or fixed)** or a manual bundle price override; effective-dated and versioned like everything else in the price book
- Bundles are sellable objects: they appear in the quote builder, each gets a shareable quote/landing link, and the announcements module can run a **campaign around a bundle** with pipeline attribution (campaign → quote link → engagement)
- **Multi-year pricing rules (DECIDED)**: per-year multiplication from the price book; **+$100/return surcharge automatically applied to any return more than 2 years back**; multi-year discount set per bundle/quote (admin judgment, no fixed default)
- **Seed bundle #1 — S-Corp Conversion Package**: 2553 conversion ($250) + 1120-S return ($700) + one year book cleanup ($75/hr est.) + QBO & payroll systems setup ($250 bundled) + analysis & owner-compensation calc ($500) · optional add-on: recurring quarterly bookkeeping package ($600/qtr). Bundle discount: admin-set at publish
- **Seed bundle #2 — Tax Resolution Package**: per-year returns (surcharge rules auto-applied) + per-year reconstruction + 8821/transcript step, multi-year discount admin-set — the resolution lane IS a bundle instance, proving the mechanism

## v4.6 CHANGELOG (July 12, 2026)
1. Tax Resolution lane: 6-year-norm multi-select intake spawning per-year engagements + reconstruction pairs; 8821-at-onboarding gating with 2848 upgrade; refund-statute/SFR clocks on dashboards and client portal; automatic e-file vs paper lane derivation with certified-mail workflow
2. Task dependencies ("blocked by") added to the task system generally; resolution chains enforce oldest-year-first
3. Bundle Builder: composable price-book bundles with optional components, discounts, campaign attribution; +$100 prior-year surcharge (>2 years back) automatic everywhere; S-Corp Conversion Package and Tax Resolution Package seeded
