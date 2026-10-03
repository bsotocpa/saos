# r126-roadmap-audit (2026-10-03)

Generated 2026-10-03T08:35:56.334Z by scripts/report-table.mjs from the log roadmap-audit.log; 103 row(s).

```sql
the spec's Phase 1-5 roadmap (docs/SAOS_Fable_Master_Prompt_v4.6.md, lines 384-400) and its addenda, read against the code at this commit by five read-only research passes; the claims that carry the most weight were checked again by hand (greps, the code itself, read-only production counts). A row not checked by hand is the research pass's own reading
```

| phase | roadmap item | status | what is built | what is missing, or what superseded it | where it is covered |
|---|---|---|---|---|---|
| 1 | Docker Compose stack | built | every service in compose; a production override with Caddy; health checks, backup and restore-drill scripts; deploy.sh | nothing | done |
| 1 | Staging environment | partly built | a staging compose file and npm scripts | no staging route or env template; deploy.sh never passes through staging (the preflight on a copy of production stands in for it); nothing shows staging was ever run | neither: added to the plan, unranked |
| 1 | Uptime Kuma | partly built | the service and its status subdomain; a container-health check that raises an alert and a task | monitors and alert routing are set by hand in its own screen, so the repo cannot show they exist; no SMS alert path | neither: added to the plan, unranked |
| 1 | Vaultwarden | built | the service on the encrypted volume, backed up | nothing in code; whether the funder credentials left the old spreadsheet is an operational step I cannot see | done |
| 1 | Database schema | built | 139 versioned migrations with constraints and invariant triggers | nothing | done |
| 1 | Encryption | built | encrypted data volume, encrypted backups, AES-256-GCM for TOTP secrets and link tokens | full SSNs are never stored (the ssn_encrypted column is unused), yet the WISP summary says "AES-256-GCM for SSNs"; the app key has no re-encryption path, so it cannot be rotated | neither: added to the plan, unranked |
| 1 | Audit logs | partly built | an append-only audit log; downloads, uploads, record views, transcript reads and permission changes are logged | no export of the audit log (the spec says exportable); listing a file is not logged as a view | neither: added to the plan, unranked |
| 1 | MFA for staff | built | no session without TOTP; lockout; recovery codes; QR enrolment | nothing | done |
| 1 | CRM | built | contacts, businesses, groups, merge, duplicates, health, the leads pipeline | nothing | done |
| 1 | Tax module | built | returns, stages, the five-phase stepper, jurisdictions, the paper lane, the 990 family | nothing | done |
| 1 | IRS notices | partly built | the notice record, owned task, 48-hour and 14-day escalations, billing route, the client-facing status page | no Ops screen: staff cannot list, update, resolve or bill a notice except through its task | neither: added to the plan, unranked |
| 1 | Entity module | partly built | annual-report rules for IL and FL, the T-60 task, the T-30 client email (gated), the manual SOS lookup, the PLLC task | no Ops screen for the compliance list, recording a filing, an SOS result or a PLLC conversion; no portal compliance badge. The SOS scraper was retired on 2026-09-06 | neither: added to the plan, unranked |
| 1 | Tax pipeline and escalation ladder | partly built | transitions and gates, rejects with perfection clocks, the D3/D7/D14/D30 ladder on waiting tasks and client to-dos | a return waiting on documents gets the document-chase reminders, not the four rungs; the D30 rung flags the work stalled without pausing it | neither: added to the plan, unranked |
| 1 | Complexity score | partly built | the exact formula and its route | no Ops control to enter inputs and no place the score is shown; intake does not recompute it; no complexity-mix view | neither: added to the plan, unranked |
| 1 | Scope creep flagging | built | the flag, the required category and reason, the database check | nothing | done |
| 1 | Extension workflow | partly built | deadlines from the authoritative table; the Record extension control; the decision-list, estimate and batch logic in the API | no Ops screens for the Extension Decision List, Extend or Push, the payment estimate, the auto-extension batch review, or a deadline board | neither: added to the plan, unranked |
| 1 | Pricing calculator with a range | partly built | the price book, quotes, bundles, the prior-year surcharge, the portal estimate | the portal estimate is not carried onto the lead or engagement; no landing page per bundle; campaign attribution is not wired | neither: added to the plan, unranked (R89b is plan item 7) |
| 1 | Engagement letters (Docuseal) | superseded by a ruling | signing is in the portal: the Master and its Schedules, placeholder-gated, the letter gate on the return | Docuseal retired 2026-09-12. One gap in the replacement: the signed copy is stored, and nobody can open or download it | neither: added to the plan, unranked |
| 1 | §7216 consent (Docuseal) | superseded by a ruling | consent captured in the portal, after the Master is signed; the wall enforces it | Docuseal retired 2026-09-12; nothing missing in the replacement | done |
| 1 | 8879 flow with KBA (Docuseal) | superseded by a ruling | the wet-signed scan, its date and PTIN holder are the authorization; the filed gate checks the document | retired by the 2026-09-12 ruling. One stale line: CLAUDE.md still says "e-file/KBA lane" | neither: added to the plan, unranked |
| 1 | Stripe one-time payments | built | invoices, deposits, checkout, webhooks, refunds, voids, reconcile | nothing; the booking deposit was retired on 2026-08-14 | done |
| 1 | Portal: documents | partly built | categories, per-file status, checklist slots, grouping by return, notice upload | drag-and-drop | neither: added to the plan, unranked |
| 1 | Portal: returns delivery | partly built | delivery from Ops, the gated notice, My Returns with next steps | My Returns shows neither the preparer nor the filed date | neither: added to the plan, unranked |
| 1 | Portal: messages | partly built | the client side: threads, attachments, texts and recaps in one history | staff cannot read or answer a thread anywhere in Ops | neither: added to the plan, unranked |
| 1 | Portal: invoices | partly built | history, line detail, Pay now through hosted Checkout | no PDF invoice, no card on file, payment is a redirect and not inline | neither: added to the plan, unranked |
| 1 | Portal: signatures | partly built | packet and consent signing; unsigned items on Home | signed copies cannot be opened; the 8879 is out of the portal by ruling | neither: added to the plan, unranked |
| 1 | Portal: empty state | built | the onboarding checklist with progress, per the 2026-08-16 journey ruling | the spec's migrated-client variant and the Cal.com embed are absent | done |
| 1 | Portal: resources | partly built | the page and three seeded entries | the entries open nothing (no file or link); most of the listed guides are absent; no admin publishing | neither: added to the plan, unranked |
| 1 | Meeting intelligence: Zoom | partly built | a webhook route and the shared pipeline | Zoom cannot call it (it checks a custom header, not Zoom's signature) and it never transcribes: in effect not working | neither: added to the plan, unranked |
| 1 | Meeting intelligence: mobile recorder | built | the browser recorder, Whisper transcript, summary, tasks, referral drafts, suggested time | no file picker for a voice memo | done |
| 1 | Cal.com scheduling | partly built | self-hosted Cal.com, its webhook, six event types by script | links only, no embed; event types are not admin-editable. Video is Cal Video (Daily.co) "per Brian", a vendor not on the approved list | neither: added to the plan, unranked |
| 1 | Referral flows, §7216-gated | built | both directions, the approval queue, the disclosure record | nothing | done |
| 1 | ntfy push | built | the push sweep every minute for warning and critical alerts | the server accepts anonymous subscribers on the default topic; see OPEN RULINGS 1 | neither: added to the plan, unranked |
| 1 | Executive dashboard | partly built | returns by stage, revenue, A/R aging, health, deadlines, the money line | MRR is a fixed 0; capacity is a proxy; no alerts tile | neither: added to the plan, unranked |
| 1 | Hilo dashboard | partly built | entrepreneurs by status, sessions, referrals, pro bono hours | milestones, grants distributed and workshop attendance are placeholders (one still says "Eventbrite sync"); no grant-cycle status | neither: added to the plan, unranked |
| 1 | Dubsado, Zoho and grant-tracker migration | built | the importers, run on production | nothing | done |
| 1 | Magic-link onboarding with bounce fallback | partly built | magic links, the bounce task, the onboarding rescue | no optional client password or MFA; the migration-welcome email is seeded and never sent | neither: added to the plan, unranked |
| 1 | Admin interface core | built | pricing, templates, settings, staff, automations, the document checklist | outside the five named areas: no admin screen for onboarding modules, event types or resources | done |
| 2 | Twilio number client-facing | partly built | inbound and outbound SMS with consent, STOP handling, MMS quarantine, a spoken greeting on calls | calls ring nobody and take no voicemail; staff cannot text a client from the system. Defect: every inbound text, even from a known client, opens an "unrecognized number" ticket | neither: added to the plan, unranked |
| 2 | Unified inbox | partly built | client threads with texts, portal messages and recaps | no staff inbox or reply; inbound email never reaches a thread; calls never do | neither: added to the plan, unranked |
| 2 | SLA ticket routing | partly built | SLA settings; timers on notices, document chase, invoices and internal tasks | no ticket types, no routing by type, no SLA-overdue alert; one SLA setting is read by nothing | neither: added to the plan, unranked |
| 2 | All templates EN/ES | partly built | about 55 bilingual templates, admin-editable, placeholder-gated | several listed templates are absent; the Hilo event emails are written in code, not templates | neither: added to the plan, unranked |
| 2 | Hilo portal: journey | not started | nothing; only Hilo-branded invite emails exist | the whole Hilo portal | neither: added to the plan, unranked |
| 2 | Hilo portal: milestones | not started | nothing | schema, logging and the funder feed | neither: added to the plan, unranked |
| 2 | Hilo portal: session notes | partly built | approved recaps delivered to the Messages thread | no session-notes page, no recommended resources | neither: added to the plan, unranked |
| 2 | Hilo portal: workshops | partly built | the events module and a public bilingual event page | no signed-in workshops view, no pre-event survey, no no-show message | neither: added to the plan, unranked |
| 2 | Hilo portal: grants | not started | nothing | everything, including the Phase 3 back end it needs | neither: added to the plan, unranked |
| 2 | Automation sequences | partly built | 24 automations seeded off and gated; the ladder, dunning, reminders | the send guard does not see the event emails sent straight through the mailer; renewal and grant sequences wait on Phase 3 | neither: added to the plan, unranked |
| 2 | Staff onboarding module | partly built | staff accounts, temporary passwords, MFA, SOPs, a written handover guide | no in-app onboarding plan or checklist per hire | neither: added to the plan, unranked (multi-role is plan item 8) |
| 2 | CPA referral network | not started | one free-text field on the contact | the network schema, records and screens | neither: added to the plan, unranked |
| 2 | Time tracking | partly built | the table, API routes, a timer, entries suggested from meetings | no Ops screen at all; no confirm for a suggested entry; hours never reach an invoice | neither: added to the plan, unranked |
| 3 | Bookkeeping module | partly built | engagements, the cadence configurator, books-current-through facts, the billing hold | the configurator and close cycles refuse an annual cadence though the facts migration counts 35 annual clients; no renewals, no portal subscription page | neither: added to the plan, unranked (the cutover itself is plan item 5) |
| 3 | Stripe Billing recurring | not started | nothing | subscriptions, saved payment method, retries, their webhooks | neither: added to the plan, unranked |
| 3 | Monthly close | partly built | close cycles, ordered steps, statements auto-posted, the calendar cross-check, in the API | no Ops screen; nothing opens a cycle on schedule; closing does not update books current through | neither: added to the plan, unranked |
| 3 | MRR reporting | not started | a placeholder that reads 0 | the calculation and its trend | neither: added to the plan, unranked |
| 3 | Advisory and COO module | partly built | the configurator, the S corp two-session floor, the session utilization report | no advisory stages, scope or deliverables | neither: added to the plan, unranked |
| 3 | Upsell pipeline | partly built | the consent-gated trigger | no list or pipeline; the flag is a notification, not a task | neither: added to the plan, unranked |
| 3 | Billing queue | partly built | billing work arrives as tasks in My Tasks; invoice controls on each client | no cross-client billing screen | neither: added to the plan, unranked (Rene's digest is plan item 8) |
| 3 | Grant distribution: application | not started | nothing | all of it | neither: added to the plan, unranked |
| 3 | Grant distribution: blind scoring | not started | nothing | all of it | neither: added to the plan, unranked |
| 3 | Grant distribution: selection and award | not started | nothing | all of it; the spec's W9 path named Docuseal, now retired, and no ruling covers that | neither: added to the plan, unranked |
| 3 | Grant distribution: disbursement and 1099 export | not started | the separate status-only voucher tracker, in the API | disbursement tracking and the 1099-MISC export; the voucher tracker has no Ops screen | neither: added to the plan, unranked |
| 3 | Grant distribution: surveys | not started | nothing | all of it | neither: added to the plan, unranked |
| 3 | Grants-received pipeline and funder calendar | partly built | the table and the Grant Tracker import | no routes or screen, no reporting calendar or reminders | neither: added to the plan, unranked |
| 3 | Eventbrite sync | superseded by a ruling | the native events module that replaced it | superseded by the spec's own v4.4 addendum. In the replacement: no Ops form to create an event | neither: added to the plan, unranked |
| 3 | Event surveys | partly built | the out-survey email at close-out; staff-entered replies | no pre-event survey, no public form, no no-show message; the wording is in code | neither: added to the plan, unranked |
| 3 | QR check-in | partly built | a tap-to-check-in door list | no QR code, scanner or self-serve check-in | neither: added to the plan, unranked |
| 4 | KPI scorecards | partly built | the owner-side team throughput report | no per-staff scorecard, nothing own-only; the code says so on purpose | neither: added to the plan, unranked |
| 4 | Bonus dashboards | not started | nothing | all of it | neither: added to the plan, unranked |
| 4 | Full RBAC for all roles | partly built | ten roles, explicit-only CEO doors, the §7216 wall | one role per person; the auditor and intern "assigned only" grants are enforced by nothing, so those roles can do nothing; grants are not admin-editable | plan item 8 (multi-role); the rest neither: added to the plan, unranked |
| 4 | Capacity planning | partly built | open tasks and returns per person; the team workload table | no hours or targets to measure against; no over-90% alert | neither: added to the plan, unranked |
| 4 | Annual report workflow polish | partly built | the entity rules, tasks and reminders | no Ops screen (as the entity module row) | neither: added to the plan, unranked |
| 5 | Funder impact report generator | not started | pieces on the Hilo dashboard | the generator, its export, milestones | neither: added to the plan, unranked |
| 5 | Revenue forecasting | not started | nothing | all of it | neither: added to the plan, unranked |
| 5 | Capacity forecasting | not started | nothing | all of it | neither: added to the plan, unranked |
| 5 | Pricing optimization | not started | the data is captured (scope creep reasons, complexity) | any analysis of it | neither: added to the plan, unranked |
| 5 | CPA network reporting | not started | nothing | all of it | neither: added to the plan, unranked |
| 5 | Health trend analysis | not started | today's score and bands | no score history to trend | neither: added to the plan, unranked |
| 5 | Content pipeline polish | not started | the resource table and portal page | the publishing pipeline | neither: added to the plan, unranked |
| addenda | Service delivery configurator, S corp floor, attest block | built | built and tested | nothing | done |
| addenda | Grant vouchering as a nonprofit CFO tool | superseded by a ruling | the status-only tracker | superseded by the spec's own v4.3 flow and CLAUDE.md (status-tracking only) | done |
| addenda | Entity groups and group billing | built | built in the API; the bundled 8879 envelope is retired | a thin Ops surface | done |
| addenda | Client W9 and 1099 tool | not started | nothing | all of it | neither: added to the plan, unranked |
| addenda | Estimated payment tracker | partly built | date reminders and the client toggle | no recommendation, no paid mark, no rec-versus-paid view | neither: added to the plan, unranked |
| addenda | Session recaps, approval-gated | built | built and tested | nothing | done |
| addenda | Resource and referral directory | not started | nothing | all of it | neither: added to the plan, unranked |
| addenda | Two-lane booking | built | built; the Lane 1 deposit was retired on 2026-08-14 | nothing | done |
| addenda | Billing architecture and pricing seed | built | the versioned price book, price lock, deposit credit, bundle rules | nothing | done |
| addenda | Dropbox two-month auto-import and transition emails | not started | nothing | all of it | neither: added to the plan, unranked |
| addenda | Authoritative deadline table | built | built and tested | nothing | done |
| addenda | E-file rejects, notice tickets, client notice status | built | built and tested | nothing | done |
| addenda | Escalation ladder and auto-extension batch | built | built; the fixed cutoffs became a per-return offset on 2026-08-09 | as the pipeline row: which waiting states the ladder covers | done |
| addenda | AR dunning and letter-gated late fees | built | built and tested | nothing | done |
| addenda | Stalled-onboarding rescue | built | built and tested | nothing | done |
| addenda | Unified task system | partly built | My Tasks, the owner rollup, workload, boards, client to-dos, the Trello importer | logged time never reaches an invoice; the production Trello import waits on the cutovers | plan item 5 (cutover); time to invoice neither: added to the plan, unranked |
| addenda | Quote builder and leads pipeline | built | built and tested | nothing | done |
| addenda | Reports and KPIs (seven owner reports) | built | built and tested | nothing | done |
| addenda | Client announcements and review requests | built | built, compliance-gated | nothing | done |
| addenda | SOP knowledge base | built | built; task types link to SOPs | nothing | done |
| addenda | Task system at Zoho parity | built | views, saved views, filters, bulk operations | nothing | done |
| addenda | Tax resolution lane | partly built | cases, per-year engagements, oldest-year-first chaining, the paper lane | 8821 and 2848 (deferred by ruling); the refund-statute countdown is not on the portal | plan item 11 (8821, 2848); the countdown neither: added to the plan, unranked |
| addenda | Bundle builder | partly built | bundles with optional components, discounts, the surcharge | no landing page per bundle; campaign attribution is not wired | neither: added to the plan, unranked |
| addenda | Website move and firm ledger | not started | nothing | post-launch by design | neither: added to the plan, unranked |
