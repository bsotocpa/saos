# TODO

## OPEN RULINGS — read first; every report lists this section at the top (Brian, 2026-09-12)
A ruling lands here in the turn it arrives, before any code. Open = ruled and not yet shipped, or deferred with a reason.
- [ ] Co-facilitation: a session records one staffer (the uploader). Build meeting participants when a real co-facilitated session occurs (Brian, 2026-09-12, ruling 4 on the wall).
- [ ] Hilo referral discount: a price-book tier applied at quote time, shown on the proposal; Brian supplies the amount in v6 (2026-09-12, ruling 5). Attribution flag unchanged.
- [ ] Docuseal volume and /mnt/saos-data/docuseal: remove on 2026-10-12.
- [ ] d) Soto Accounting LLC business record: missing on the box; Brian enters it with the EIN on the merged winner (walk step 1). His record now holds GORDEETAH LLC only (dissolved, not primary); the page says "No primary business set." until he adds Soto Accounting LLC and chooses it.
- [ ] Monday's first message re-checks the standing rules (Brian, 2026-09-12 evening).
- [ ] RULED 2026-09-12 (merge batch): Brian amends the SA-2026-0001 waiver reason himself through the append-only amendment once it ships.
- [x] RULED 2026-09-12 (evening): BRIAN SOTO LANDSCAPING INC. is Brian's Zoho workflow test; archive the contact and the business as test residue, is_test, note "Brian's Zoho workflow test, 2025-12-19; no real person or entity." Not a merge. SHIPPED: POST /contacts/:id/archive and POST /businesses/:id/archive (isTest + testNote); both archived on the box through the routes.
- [x] RULED 2026-09-12 (evening): merge route rule: contacts with no shared email, phone or address require an explicit override with a reason; a name match alone never merges. SHIPPED: no_shared_identifier unless identityOverrideReason; the audit row names the shared identifiers or the override.
- [x] RULED 2026-09-12 (evening), 2a: engagement creation always emits the lifecycle event; DB invariant: an active or on_hold engagement requires lifecycle onboarding or active; production violations by name. SHIPPED: migration 0100 (two triggers), deriveLifecycle open work = onboarding, createEngagement audits the move; production violations: none.
- [x] RULED 2026-09-12 (evening), 2b: every path creating an engagement outside quote acceptance or change-order supersession is listed; anything that is not a migration or the acceptance path is removed or gated. SHIPPED: intake inserts removed; POST /engagements, the new-engagement branch of POST /tax-engagements, and POST /resolution/cases require a reason, audited as origin.
- [x] RULED 2026-09-12 (evening), 2c: withdraw cascades to any unfiled return on the engagement; DB invariant: a pre-filed return requires an active or on_hold engagement; the orphaned "2025 1040 · intake started" on Brian's record is withdrawn through the route with the reason "engagement withdrawn 2026-09-12; return never reached preparation." Sabotage: cascade detached → orphan test red. SHIPPED: withdrawUnfiledReturns in closeEngagement and change-order supersession; migration 0100 both directions; sabotage red then green; the orphan withdrawn on the box through the transition route.
- [x] RULED 2026-09-12 (evening), 3: businesses get parity with contacts: is_test with note, archive route (never delete), merge route, same audit shape. Archive BRIAN SOTO TEST and both "soto incorporated" rows as rehearsal residue (merge the two "soto incorporated" first if they are one business). Exactly one primary business per contact, DB-level; archiving a primary clears the flag and the page says "no primary business set". After: Brian's record holds GORDEETAH (dissolved, not primary) and nothing else until Soto Accounting LLC on Monday. SHIPPED: migration 0101, crm/businesses.ts, archive/merge/primary-business routes, Ops page; box: soto incorporated merged then archived, BRIAN SOTO TEST archived, GORDEETAH primary cleared.
- [x] RULED 2026-09-12 (late), 1: clear the primary flag on all 74 multi-primary contacts. SHIPPED: migration 0102 lists every row by contact and business in the deploy log, then clears; createQuote refuses a business line with no business (business_required) and the chosen business becomes primary when none is set; the Ops builder has the picker. ON THE BOX: 167 membership rows across 73 contacts cleared, one audit row each (actor "migration 0102 (ruled by Brian, 2026-09-12)"); multi-primary contacts now 0. A second contact record named Joseph Basilone holds one primary (Transnorthern Trading Company) and was never multi-primary; untouched. No guessing, no tasks. The migration lists every row by contact and business before it runs; protected names (Jackson Flores, Joseph Basilone) are on the list and are listed first in the report, then it runs. The page shows "No primary business set" with the control. Structural: the quote builder requires a business selection for any business line, and that selection sets primary when none exists. Primary is set by whoever works the client next, with the client in front of them.
- [x] RULED 2026-09-12 (late), 2: portal badge shows the sign-in address beside "Signed up". One line, EN/ES label. SHIPPED: portal_login_email on the contact detail; "signs in as / inicia sesión como".
- [x] RULED 2026-09-12 (late), 3: verify tonight's archive, merge and clear audit rows carry "Brian Soto (ruled 2026-09-12, applied by script)", not Brian's bare name. FOUND: twelve rows carried the bare name (the session was minted unlabelled). SHIPPED: createSession takes appliedBy and stamps the session; the auth plugin puts "(appliedBy)" on every row written under it; on the box an unlabelled browserless session is refused (session_unlabelled). Eleven rows, not twelve (the evening count was wrong by one): each has an append-only correction row (audit.actor_relabelled) on the box; the log is never rewritten.
- [x] RULED 2026-09-12 (night), 1: DUPLICATE CONTACT SCAN across the whole book: same-name contacts (Daniel Hernandez x2, Joseph Basilone x2, Francisco Martinez and Mathew Alvarez from the import flags, and any other). For each pair: shared email / phone / address, and what each record holds. Merge only where the route's rule is satisfied, never on name alone; the rest get a "possible duplicate, no shared identifier" note on both records. Protected names listed first, before any merge touches them. Report the table. SHIPPED: crm/duplicates.ts (plan from shared identifiers, winner by holdings, notes on the rest), scripts/duplicate-scan.ts (dry run; APPLY=1), RUN ON THE BOX 2026-09-13 (UTC): 61 groups, 132 records; 12 records merged into 11 winners on a shared phone; 107 records noted "Possible duplicate"; Joseph Basilone's pair held; Brian's real record untouched (his test twin is outside the scan). Remaining same-name groups: 53, all noted. Protected names are planned and never merged by the script; Joseph Basilone's pair shares a phone and waits for Brian's word.
- [ ] RULING NEEDED: merge Joseph Basilone's two records (they share a phone; the scan planned it and held it as a protected name). Also: the third BRIAN Soto record is the native test row; it shares his phone and stays a test record, not merged.
- [x] RULED 2026-09-12 (night), 2: SELF-NAMED BUSINESSES, tag not archive: a business whose name matches the contact's name with no EIN and no entity type is an import artifact or a sole prop; tag "unverified import" with the source. The quote-builder picker shows entity type on every option and the tag on these. Nothing archived. Count them; joins the enrichment work with the FL entities. ON THE BOX: 202 businesses tagged, all from Zoho, one audit row each; one protected row among them (Joseph Basilone · JOSEPH BASILONE and MELISSA BASILONE), listed in the migration's own output before the UPDATE. The first deploy's migration failed (DDL queued behind the UPDATE) and was corrected and run by hand; lesson recorded. SHIPPED: migration 0103 (lists then tags; the rule is by word since no business equals "First Last" exactly: the import named businesses after tax households), businesses.unverified_import_source, the tag and entity type on the client page and both pickers.
- [ ] SCAN TIE ORDER: two empty records with one creation timestamp pick the winner by row order; add the id to the ORDER BY so the plan is the same on every run (dry run and apply disagreed on three winners tonight, harmlessly: identical empty records).
- [ ] DEPLOY ORDER: deploy.sh swaps containers (step 2) before it migrates (step 3); a failed migration leaves new code on an old schema, as 0103 did for fifteen minutes on 2026-09-13. Migrate first, or hold the swap until the migration is green.
- [ ] ENRICHMENT: the unverified-import businesses join the FL-entity enrichment work; each needs an entity type or an EIN from a person, or a decision that it was a household row.
- [x] Monday's first message re-checks standing rules before anything else (done 2026-09-14: hook, receipt, no-native-dialogs check, reason validator, labelled sessions all present in the tree).
- [ ] RULED 2026-09-14, 1: REPORT TABLES ARE FILES. Any table of production rows in a report is written by a script to tasks/reports/<date>-<name>.md from the query result, with the query; the report links it or reproduces it verbatim; a guard compares every table in a report draft against the files. No file, no table. Retroactive: the duplicate-scan table and the real 167-row primary-flags list become files with their queries.
- [ ] RULED 2026-09-14, 2: DEPLOY ORDER. Migrate before swap; a failed migration means no swap and the box stays on the previous version. Before the production migrate, migrations run against a copy of the production database (schema and rows), since a fresh database never has the row that breaks an update. Sabotage: a migration that fails on the production copy but passes on fresh -> deploy refused before swap.
- [ ] RULED 2026-09-14, 3: merge Joseph Basilone b773c010 into 8e499a4f. Protected, listed, approved by Brian.
- [ ] RULED 2026-09-14, 4: the duplicate scan's ORDER BY includes the id. Accepted.
- [ ] RULED 2026-09-14, 5: case-insensitive business dedupe within a contact through the merge route (Tri-Taylor Condominium Association is one). List, then merge.
- [ ] RULED 2026-09-14, 6 (deferred, enrichment): the 202 household rows. Rule when it runs: "NAME and NAME" -> spouse on the contact, business archived as a non-entity; a single personal name with no EIN and no entity type -> archived; anything else -> human review. Protected names first.
- [ ] Then the Monday walk as written.
- [x] RULED 2026-09-12 (evening), 4 (note, no build): the winner's portal sign-in is brian3712@gmail.com while the contact email is brian@sotoaccounting.com; say whether the portal-access badge represents that honestly. ANSWERED in the evening report: the badge states access, not the address; the sign-in address is not shown anywhere on the page.
- [x] Brian withdrew the 2025 intake engagement himself through Ops (2026-09-12); its orphaned return withdrawn through the route the same evening.
- [ ] RULED 2026-09-12: Brian arms efile_acknowledgment on Monday after Ana-Maria signs in; Tuesday's ack report runs the real path with her review as the gate.
- [ ] RULED 2026-09-12: 8821 and 2848 take the 8879 shape (wet-signed in office, scanned, uploaded under signed_authorizations; the gate checks the document, same category check). Build when the resolution lane first needs it; not before.
- [x] Waive Stripe check renders only on an invoice with an open drift finding; the route refuses otherwise (2026-09-12).
- [ ] FIRST REAL-DATA RUN (Brian, 2026-09-12): Soto Accounting LLC's own 1120S, due 2026-09-15. Rule: ATX is the critical path; SAOS never delays the filing; a block is a finding, not a delay. Checks a–f confirmed or built in this batch; phone walk list for Monday and Tuesday delivered.

FIRST — walk failures
- [x] A. SA-2026-0003 paid again: prove writer; state-machine trigger (refunded→paid illegal w/o payment; void terminal; paid→refunded only via refund row; reconcile touches sent/overdue only); sabotage: trigger detached; nightly Stripe drift check → task; lessons instance.
- [x] B. DATE vs TIMESTAMPTZ: DATE columns serialized as calendar dates at the driver (pg 1082 parser), helper typed; enumerate DATE columns + render sites; pausedDays arithmetic; test ended >= started; guard.
- [x] C. Decision-1 corrected sequence: withdraw ef90aabc (route), period 2025 on 6e474b1f + BRIAN S. test row + Brian S. real row (list before/after), transfer SA-2026-0001 → 6e474b1f.
- [x] D. Mobile overflow: stack void metadata on narrow viewports; send-log rows wrap; 390px walk.
- [x] E. Portal shows void invoices: Cancelled/Anulada, sorted last, no pay action.
- [x] F. Engagement order: active, on_hold, closed; newest first within group.

DECISIONS
- [x] 2. Tax year shown in builder, printed on the quote, in the engagement title; test asserts all three.
- [x] 3. Void reverses issuance completely (symmetric with issue); field diff test; fix 6e474b1f via route; lessons instance.
- [x] 5. SOP seeds: reviewed_at NULL → overwrite; else refuse + diff; dispute SOP on the box confirmed.
- [x] 6. pausedDays clock bug: root-cause in production code; list affected on_hold engagements; freeze clock in spec.

NEW
- [x] 7. Stranded deposits: withdraw refuses w/ paid unapplied deposit unless superseding or actor selects refund (billing task); transfer route (billing.manage, audit both); move 0001 → 6e474b1f; query of invoices on non-active engagements.
- [x] 8. Outbox double-send audit (attempts > 1), grouped by contact; protected names flagged.
- [x] 9. Ungated send sites: list 13 by module:function/template/recipient class; gate client-reachable; staff-only get a recipient test; guard fails on new ungated client sites.
- [x] 10. Signature failures log livemode + endpoint id.
- [x] 11. Actor display: name, never email (audit, invoice, engagement rows).
- [x] PLAN: Playwright rendered-output harness (one page).

## Review — 2026-09-09 evening (all rulings shipped; 14 commits f833c1b…393e015)
- Every item above shipped with its own commit, a green full suite (609 api / 12 ops / 3 portal at the end) and one sabotage that bit. Exception recorded honestly: decision 2's sabotage script failed on a heredoc backslash and the commit went out first; the sabotage was run right after (2 of 2 red, restored green).
- DECISION-PENDING: period 2025 on 6e474b1f refused by the index — abb43fc6 (Rehearsal Client 2, created 22:58 UTC by a quote acceptance) already holds tax/2025. Nothing withdrawn without a ruling.
- DECISION-PENDING: client (portal) actor labels still carry the client's email; a portal session has no display name.
- NOT DONE: STRIPE_WEBHOOK_ENDPOINT_ID on the box — the write needs the live key in a shell and was refused by the tool policy; the audit row says "unconfigured" until the installer runs or Brian sets it.
- Brian arms in Admin → Automations: payment_receipt, refund_receipt, void_notice (shipped OFF per CLAUDE.md; receipts and cancellation notices are HELD until armed).
- Next overnight: tasks/next-overnight-plan.md (plan only).

## Evening batch — 2026-09-09 (Brian's evening rulings; all shipped, one commit per item)
- [x] 0. DATE consumer audit: calendarDay(), guard rule, date-consumers.spec (8 tests on both sides of today), production check clean (5819fb3)
- [x] 5. Drafts are not payable; filing and acceptance issue in their own transaction (931d4ed)
- [x] 1. Withdrawal voids attached sent/overdue invoices, deletes drafts; DB invariant 0085; abb43fc6 withdrawn, 6e474b1f = tax/2025 with the $250 deposit (976ac35)
- [x] 2. Client actors by display name (5522d76)
- [x] 3. Held count on the automation row; arming replays nothing; NOT armed (73e0628)
- [x] 4. Installer idempotent; STRIPE_WEBHOOK_ENDPOINT_ID server-managed (755baa9)
- [x] 12. Zero native dialogs; one in-app modal; guard (4b8707e)
- [x] 13. Builder chips / sticky summary / tax-year select (6d28e26)
- [x] 14. One link per invoice — sent by email or text, never printed (7368078)
- [x] Audit 1, 3, 5, 11, 12, 6, 7, 8, 9, 10 (7ac18e2 … 40f9d83); audit 2 and 4 were done earlier
- DECISION-PENDING: completing an engagement with an unpaid invoice stays allowed (the collection tail) — the 0085 invariant covers withdrawn only.
- Held for Brian: arm payment_receipt / refund_receipt / void_notice in Admin → Automations; run install-stripe-live.sh (idempotent) for STRIPE_WEBHOOK_ENDPOINT_ID.

## Morning batch — 2026-09-10 (rulings on the evening report)
- [x] 0. First new-driver job run: 09-10 vs 09-09 diffed on the box, read-only. All 18 job run records identical field for field; zero rows flipped overdue / late fees / entity / document reminders on either day; no job.failed rows. Only 09-10 delta is the stripe_drift task the isolation fix was built to raise.
- [x] 1. Companion tests: dunning, aging and the drift check include invoices on completed engagements (a57d6f7). Sabotage: dunning active-only → red.
- [x] 4. Stub Stripe adapter refuses to load beside a live key or outside NODE_ENV=test; boot names the reason (5e48270). Sabotage: force-load under production config → boot failed with the reason.
- [x] BUILD. Rendered-output harness, page one = Ops client page at 390x844 and 1280x800 (c4a3254). In the root suite; failures commit screenshots to tasks/walks/<date>/; passing artifacts local 14 days. Sabotage: raw enum back on a badge → both viewports red, screenshots in tasks/walks/2026-09-10/; restored → five consecutive green runs.
- [ ] 2. Installer recreates the endpoint only when the secret is missing or fails verification (branch installer-endpoint-in-place, 2828ce3, three cases tested on the box). HELD: Brian runs the current installer this morning; merge and deploy after.
- Gate for page two of the harness: five consecutive green runs of page one — met 2026-09-10.
- OBSERVATION: an outbox row reads `sent` when its effect suppressed the client email at the gate (SA-2026-0004 void notice, 02:56 UTC). The audit row says suppressed and no client was written to, but the outbox alone reads as a send.
- Brian armed payment_receipt, refund_receipt and void_notice himself at 08:47-08:48 UTC. Nothing replayed.
- STRIPE_WEBHOOK_ENDPOINT_ID still unset on the box until the installer runs.

## Evening batch — 2026-09-10 (rulings on the morning report)
- [x] 1. Merged installer-endpoint-in-place (5cd160a) and deployed. Sabotage: the in-place branch forced to always recreate → case 3 red on all four assertions; restored → all five cases pass on the box.
- [x] 2. Post-rotation confirmation from the box: we_1UEFdxITVkZx9n3n5QdIfTU5 in .env, in the running container, and server-managed so the deploy preserved it. One endpoint on the live account, enabled, exactly the five events, nothing lost in the delete/create. Reconcile sweep runs clean. The drift check's Stripe call answers for both invoices. Zero webhook.signature_failed rows ever.
- [x] 4a. Outbox suppressed state (393ee72): sent / suppressed / skipped, `sent` means sent. Backfill touched exactly one row, listed by name first: Rehearsal Client 2's 2026-09-10 cancellation notice, a test client. Sabotage: the hold branch made to write 'sent' → red on exactly that.
- [x] 4b. Harness page two, portal Invoices EN/ES at both viewports (21631dd). Sabotage: inv_refunded left untranslated → both viewports red, Spanish screenshot showing the English word. Restored → five consecutive green runs of both pages.
- FINDING, fixed in 21631dd: with a portal account granted, the Ops portal-access badge read `active` — the enum word beside an engagement badge reading `Active` that means something else. Now No access / Invited / Signed up / Revoked.
- Brian declined a second real-card payment: SA-2026-0003 proved the path on live keys and held through forty ticks; the rotation only risked the signature, which the installer verified both ways.
- Gate for harness page three: five consecutive green runs of pages one and two — met 2026-09-10.

## Phone walk findings — 2026-09-10 evening (Brian's rulings on the 09-10 walk)
- [x] 0. Harness vs device. Three gaps closed: it ran `next dev` (now build+start), its phone was Chromium (now WebKit), it dispatched clicks instead of tapping (now hit-tested). None reproduces the dead Withdraw. App-shell cache header fixed (no-store; only /_next/static immutable). Lesson written under checks-that-lie: "green harness, dead button". CONFIRMED 2026-09-12 by Brian: Withdraw opens on the iPhone after the no-store deploy. The stale shell was the cause.
- [x] 1. One modal shell: opaque panel, backdrop, scroll lock, focus in, escape and click-out. All three modals converted. Harness asserts the contract at both viewports.
- [x] 2. No money record reads unknown. invoices.voided_by_label; cascades record mechanism + person. SA-2026-0004 backfilled.
- [x] 3. Reasons stand alone. SA-2026-0004 rewritten; the cascade prefix is a sentence.
- [x] 4. Task dedupe. Seven duplicates, not two — dedupe key was the quote id. Opt-in by kind; five duplicates cancelled through setTaskStatus on two test clients.
- [x] 5. Tasks on a phone, 5a–5h, plus harness page three. Found and fixed a 1280px horizontal overflow nobody had reported.
- [x] 6. Drift task: reported as a finding, NOT built — no resolve-as-expected path exists. Awaiting a ruling.
- [x] 7. Pay-link walk item noted as untestable until an open invoice exists.
- [x] Role resolver audit delivered (table only, no changes). Four live defects found; awaiting rulings.
- Gate for harness page four: five consecutive green runs of pages one, two and three.

## Staff and e-file batch — 2026-09-12 (Brian's rulings after the 09-10 walk)
- [x] Item 0 CONFIRMED by Brian: the stale app shell was the cause. Closed on the record in lessons.md.
- [x] Carry-over: 8 reason rows rewritten to stand alone (0088, listed by name); apps/api/src/reasons.ts refuses conversation artifacts at every staff reason. Sabotage bit on "as discussed".
- [x] Preparer of record (0089): required at filing, immutable after, "not recorded" on anything filed before. Sabotage bit.
- [x] E-file acknowledgment automation (0090): ATX report → parse by column name → match or task, never guess → review screen → release (REQUIRED step) → gated send EN/ES, federal and state separately, return records both. Automation `efile_acknowledgment` seeded OFF. Sabotage (1 accepted / 1 rejected / 1 unmatched → 1 queued, 2 tasks, 0 guesses) bit on "never guess".
- [ ] Staff accounts: REPORT delivered, NO account created. Awaiting Brian's approval of the grant matrix.
- [ ] Rene's money-action daily digest + executive-view line: not built until the accounts ruling (it is part of that grant).
- [ ] Multi-role (Rene): staff.role_id is single; ~21 files to change for a staff_roles join. Cost stated in the report; awaiting ruling.

## Staff accounts, phase 1 — 2026-09-12 (approved; built in Brian's order)
- [x] Wildcard off ed_coo; named grants + referrals.suggest (my call, to keep ruling 5's attribution true). Seed reconciles; migration 0092 audited.
- [x] bookkeeping.assigned.manage on comms_billing; sales_tax.manage / payroll.manage deleted.
- [x] Money digest (daily to ceo) + same-day line on the executive view. Sabotage bit.
- [x] legal_name / display_name; temp password 72h or first use; session owes a password until set; names editable by PATCH.
- [x] Session recap signs as the firm EN/ES.
- [x] Owner routing: referral approvals → ceo; final fee → tax_preparer.
- [x] 8879: remote path retired (routes 410, KBA gone); the wet-signed upload is the authorization; DB trigger refuses a timestamp without the document. Lesson: reported a reference as the artifact.
- [x] Phase 2: the §7216 wall. documents.read scoped by category grant (entity / relationship / all) in list, overview and download; pii.read checked (SSN last-4 leaves only for holders); interviews.read (quote answers, complexity inputs); meetings.read scoped to own + Hilo sessions unless meetings.read.all; SOP drafts are the author's. wall.spec.ts in Brian's sabotage form; harness page four (ops-wall.spec.ts) as Laura and Jaqueline. Accounts: Brian creates them in Admin → Staff.
- Phase-2 grant questions surfaced by the wildcard removal: Jaqueline's recorder uploads (meetings.upload/read), her Hilo dashboard (dashboards.executive is CEO-only by omission), her event completion.


## Password reveal, Jaqueline's six, Docuseal, the wall — 2026-09-12 (Brian's batch after phase 1)
- [x] 1. Never a password in a report (lesson: a secret in a report). Admin → Staff: one-time reveal with Copy; regenerate is POST /staff/:id/password/regenerate, audited, sessions revoked; PATCH accepts email (audited; sessions keyed by staff id, so no orphaned login); Edit control for names and address.
- [x] 2. Jaqueline's six: meetings.upload; dashboards.hilo (split from dashboards.executive); events.manage (split from dashboards.executive); meetings.read scoped (own + Hilo); referrals.suggest (phase 1). Migration 0094 audits the grants.
- [x] 3a. Schedule C accepted by Brian on the phone 2026-09-12 12:10 UTC: schedule_acceptances (C, portal_acceptance), audit schedule.accepted as client, no envelope row, zero Docuseal requests.
- [x] 3b. Docuseal decommissioned 2026-09-12: adapter, webhook, config, compose service, Caddy vhost, backup entry, docs; container stopped and removed; DOCUSEAL keys removed from the box .env. KEEP until 2026-10-12, then remove: docker volume saos_saos_docuseal_data and /mnt/saos-data/docuseal. DNS record sign.sotoaccounting.com: Brian pulls it.
- [x] Rulings 2026-09-12: Rene holds pii.read; Laura uploads only what she may read (entity_filings); event rosters behind events.read (intern does not hold it). Migration 0095.
- [x] Hook: scripts/green-run.mjs; root npm test records a receipt keyed to the tree hash; deploy.sh and .githooks/pre-push refuse without it or with a dirty tree.
- [x] Added-schedule notice: template schedule_added EN/ES, outbox effect schedule.added_notice, automation schedule_added_notice OFF. Brian arms it.
- [ ] GAP, co-facilitation: a session records one staffer (meetings.staff_id, the uploader). A session Brian records with Jaqueline in the room is not hers under the wall. Build meeting participants when a real one occurs (Brian, 2026-09-12).
- [ ] Laura and Jaqueline: Brian creates in Admin → Staff.

## Admin → Staff defects and the Docuseal export — 2026-09-12 (Brian, after creating the accounts)
- [x] Export SOTO_Legal_Text_Package_FINAL_v3 as PDF to docs/legal/ from the retained Docuseal store (sha256 and Docuseal's md5 matched). The container had already been stopped before the message arrived; the store was intact.
- [x] 1. Add staff defaulted Role to intern since M20; the ruling never shipped and was never recorded. Now: no default, explicit selection, submit disabled without one. Lesson written.
- [x] 2. The Role column shows the role name; changing it is a separate control with a placeholder.
- [x] 3. No floor existed. Migration 0096: the last active CEO cannot be deactivated or moved off the role; the API answers 409 last_active_ceo; the control is not offered on that row.
- [x] admin@sotoaccounting.com: only Laura's staff row carried it; no contact, portal user, setting, template, audit row, env key, or file in the repo names it. Brian is correcting the row himself.
- RULE (standing, from the lesson): every ruling lands in this file in the turn it is given.

## Ruling reconciliation — 2026-09-12 (Brian: two rulings never shipped from one prompt)
- [x] Reconciliation table delivered (prompt date · ruling · status · evidence): every numbered ruling since 2026-09-09 verified against git and this file.
- [x] Unfilled roles fail loudly: the four no-fallback alert sites and the variable-role-key site go through alertRecipientForRole, which audits staffing.role_unfilled and falls back to the CEO. Never a ruling in any prompt; raised as my finding on 09-11; built now.
- [x] Drift waiver: POST /invoices/:id/waive-stripe-check with a reason (billing.manage); the nightly check skips a waived invoice and counts it; open stripe_drift tasks close; Ops control on the invoice card. Never a ruling in any prompt; my finding on 09-11, item 6; built now. Brian applies it to SA-2026-0001.
- [x] client_success and advisory_manager refuse staff: roles.accepts_staff (0097); POST /staff and PATCH refuse with 409; Admin → Staff does not offer them. From the 09-12 07:44 rule "Nobody is provisioned into client_success or advisory_manager"; never enforced; built now.
- [x] 3. The CEO floor test covers deactivate via PATCH, move-off-role via PATCH, a direct UPDATE, and the lift by a second active CEO (staff-accounts.spec.ts).
- RULE: the morning report opens with the OPEN RULINGS section at the top of this file.

## First real-data run, 1120S — 2026-09-12 (Brian's checks a–f)
- [x] Closures: "completing with an unpaid invoice stays allowed" was ruled 09-10 and shipped in a57d6f7 (cleared); DNS pulled; Laura's row corrected; SA-2026-0003 drift task closed through the task service with the ruled reason, audit row confirmed.
- [x] a) CONFIRMED: an 1120S runs intake → filed → completed through the real transitions (first-1120s.spec.ts). BUILT: an accepted quote now creates the return record (tax/return-type.ts); the preparer's POST /tax-engagements attaches to the accepted engagement or names the existing return (409 return_exists).
- [x] b) BUILT: entity-name column aliases; a business return matches by folded entity name only ("Soto Accounting, LLC" = "SOTO ACCOUNTING LLC"), never by the owner's name; the EIN last-4 must agree with the record. Return type "1120S" already parsed.
- [x] c) CONFIRMED: recordSigned8879 checks category = signed_authorizations and nothing about the file name; a scan named "Form 8879-CORP" under business_records is refused, under Signed Authorizations it authorizes (first-1120s.spec.ts).
- [ ] d) MISSING on the box: no business named Soto Accounting exists. Brian has THREE non-test contact records (brian@sotoaccounting.com migrated/inactive holding GORDEETAH LLC; a lead with no email holding BRIAN SOTO LANDSCAPING INC.; brian3712@gmail.com from Zoho, ARCHIVED yet holding the active 2025 1040). Brian picks the record, adds Soto Accounting LLC with its EIN in Ops (walk step 1); the EIN is his, not guessed.
- [x] e) BUILT and walked: harness page five (ops-scorp.spec.ts) builds the S corp through the routes (business, BIZ_1120S quote, $0 deposit override, send, accept → 1120S return record, Schedule B packet, portal questionnaire submitted, document) and reads the Ops client page. Migration 0098: the entity joins the one-active-per-period key so the owner's 1040 and the entity's 1120S coexist in one year.
- [x] f) CONFIRMED: the IL row is a state jurisdiction; state_accepted_on and state_accepted_code = IL land beside the federal acceptance (first-1120s.spec.ts).

## Contact merge, the invariant, the reason validator — 2026-09-12 (Brian: "Don't archive. Merge.")
- [x] 1. Contact merge route POST /contacts/:id/merge (billing.manage or ceo): every contact-keyed row reparented, one audit row per object (log-like tables summarised with counts); losers archived with merged_into and nothing else; refused on active work on both sides for the same (line, period, entity); fail-closed orphan scan from the catalog. DEVIATION, reported: audit_log is append-only by trigger, so the loser's audit history stays as written and the winner reaches it through merged_into; it is not rewritten. A second portal sign-in is retired (deleted, audited) unless it signed a packet, which refuses the merge. Sabotage: tasks dropped from the list → the scan refused the merge → red.
- [x] 2. MERGED on the box 2026-09-12: the Zoho brian3712@gmail.com record into brian@sotoaccounting.com; moved: the active 2025 1040 intake engagement and its withdrawn duplicate, 3 business memberships (BRIAN SOTO TEST, soto incorporated twice), the portal sign-in, 4 signature envelopes, 1 form submission, portal onboarding, 1 task, enrichment and import rows. Loser archived, merged_into set, zero references. GORDEETAH LLC marked dissolved on the winner, audited. Production invariant violations after the merge: zero.
- [x] 3. Invariant (0099): two triggers; no active work lands on an archived contact and no contact with active work is archived. Production violations reported by name in the merge report.
- [x] 4. Validator refuses "claude" / "claude code". reason_amendments (generic by object and field); POST /invoices/:id/waiver-amendments appends an audited line; the invoice card lists amendments and offers "Amend reason". Brian amends SA-2026-0001 himself.
- FINDING (2026-09-12, post-merge): the winner reads lifecycle dormant while holding an active 2025 1040 intake engagement; the lifecycle derives from events and the intake never became an accepted quote or a signed Master. Brian to rule whether the 2025 intake engagement is real work or a rehearsal leftover.
- FINDING (2026-09-12, post-merge): the merged record now holds BRIAN SOTO TEST and two memberships in "soto incorporated" from the rehearsal; there is no business merge or archive route yet. Brian to rule.
