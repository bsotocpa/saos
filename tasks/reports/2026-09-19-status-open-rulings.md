# status-open-rulings (2026-09-19)

Generated 2026-09-19T18:08:13.436Z by scripts/report-table.mjs from the log open-rulings.log; 44 row(s).

Every line in the OPEN RULINGS section of tasks/todo.md, with its checkbox state; read from the file, not from memory.

```sql
grep -E '^- \[[ x]\]' tasks/todo.md (OPEN RULINGS section only), split on the first period or colon
```

| ruling | state | note |
|---|---|---|
| Co-facilitation | OPEN | itated session occurs (Brian, 2026-09-12, ruling 4 on the wall). |
| Hilo referral discount | OPEN | unt in v6 (2026-09-12, ruling 5). Attribution flag unchanged. |
| Docuseal volume and /mnt/saos-data/docuseal | OPEN |  |
| d) Soto Accounting LLC business record | OPEN | (walk step 1). His record now holds GORDEETAH LLC only (dissolved, not primary); the page says "No primary business set." until he adds Soto Accounting LLC and chooses it. |
| Monday's first message re-checks the standing rules (Brian, 2026-09-12 evening) | OPEN |  |
| RULED 2026-09-12 (merge batch) | OPEN | endment once it ships. |
| RULED 2026-09-12 (evening) | closed | the business as test residue, is_test, note "Brian's Zoho workflow test, 2025-12-19; no real person or entity." Not a merge. SHIPPED: POST /contacts/:id/archive and POST /businesses/:id/arc |
| RULED 2026-09-12 (evening) | closed | cit override with a reason; a name match alone never merges. SHIPPED: no_shared_identifier unless identityOverrideReason; the audit row names the shared identifiers or the override. |
| RULED 2026-09-12 (evening), 2a | closed | or on_hold engagement requires lifecycle onboarding or active; production violations by name. SHIPPED: migration 0100 (two triggers), deriveLifecycle open work = onboarding, createEngagement |
| RULED 2026-09-12 (evening), 2b | closed | ersession is listed; anything that is not a migration or the acceptance path is removed or gated. SHIPPED: intake inserts removed; POST /engagements, the new-engagement branch of POST /tax-e |
| RULED 2026-09-12 (evening), 2c | closed | -filed return requires an active or on_hold engagement; the orphaned "2025 1040 · intake started" on Brian's record is withdrawn through the route with the reason "engagement withdrawn 2026- |
| RULED 2026-09-12 (evening), 3 | closed | lete), merge route, same audit shape. Archive BRIAN SOTO TEST and both "soto incorporated" rows as rehearsal residue (merge the two "soto incorporated" first if they are one business). Exact |
| RULED 2026-09-12 (late), 1 | closed | ists every row by contact and business in the deploy log, then clears; createQuote refuses a business line with no business (business_required) and the chosen business becomes primary when n |
| RULED 2026-09-12 (late), 2 | closed | SHIPPED: portal_login_email on the contact detail; "signs in as / inicia sesión como". |
| RULED 2026-09-12 (late), 3 | closed | -09-12, applied by script)", not Brian's bare name. FOUND: twelve rows carried the bare name (the session was minted unlabelled). SHIPPED: createSession takes appliedBy and stamps the sessio |
| RULED 2026-09-12 (night), 1 | closed | z x2, Joseph Basilone x2, Francisco Martinez and Mathew Alvarez from the import flags, and any other). For each pair: shared email / phone / address, and what each record holds. Merge only w |
| RULING NEEDED | closed | rotected name). Ruled and done 2026-09-12, late night. Also: the third BRIAN Soto record is the native test row; it shares his phone and stays a test record, not merged. |
| RULED 2026-09-12 (night), 2 | closed | 's name with no EIN and no entity type is an import artifact or a sole prop; tag "unverified import" with the source. The quote-builder picker shows entity type on every option and the tag o |
| SCAN TIE ORDER (shipped 2026-09-12, late night) | closed | by row order; add the id to the ORDER BY so the plan is the same on every run (dry run and apply disagreed on three winners tonight, harmlessly: identical empty records). |
| DEPLOY ORDER (shipped 2026-09-12, late night) | closed | tion leaves new code on an old schema, as 0103 did for fifteen minutes on 2026-09-13. Migrate first, or hold the swap until the migration is green. |
| ENRICHMENT | OPEN | an EIN from a person, or a decision that it was a household row. |
| Monday's first message re-checks standing rules before anything else (done 2026-09-12 night | closed | -native-dialogs check, reason validator, labelled sessions all present in the tree). |
| RULED 2026-09-12 (late night), 1 | closed | by a script to tasks/reports/<date>-<name>.md from the query result, with the query; the report links it or reproduces it verbatim; a guard compares every table in a report draft against th |
| RULED 2026-09-12 (late night), 2 | closed | box stays on the previous version. Before the production migrate, migrations run against a copy of the production database (schema and rows), since a fresh database never has the row that br |
| RULED 2026-09-12 (late night), 3 | closed | Brian. DONE on the box through the scan with APPROVED naming the loser; tasks/reports/2026-09-12-joseph-basilone-merge.md. |
| RULED 2026-09-12 (late night), 4 | closed | e-break by id in the ranking too. |
| RULED 2026-09-12 (late night), 5 | closed | ri-Taylor Condominium Association is one). List, then merge. SHIPPED: sameNameBusinessesWithinContact, scripts/business-dedupe.ts; on the box: one group, Erica Gonzalez's Tri-Taylor rows mer |
| RULED 2026-09-12 (late night), 6 (deferred, enrichment) | OPEN | NAME" -> spouse on the contact, business archived as a non-entity; a single personal name with no EIN and no entity type -> archived; anything else -> human review. Protected names first. |
| RULED 2026-09-19, 0 | OPEN | ormation date, set-as-primary at creation; the same modal component as everything else. Walk step 1 is blocked until it is deployed; the report says where it is. |
| RULED 2026-09-19, STATUS | OPEN | ve temp passwords expired 09-15 unused, MFA pending on all), efile_acknowledgment ARMED by Brian 09-19, SA-2026-0001 waiver amended 09-19; a table from queries, file in tasks/reports. |
| RULED 2026-09-19, DRY RUN IS SOLO | OPEN | dry run is clean. Confirm that as ceo he can see and act on work routed to tax_preparer, bookkeeper and comms_billing (preparer queue, E-file acks screen, review step, billing controls); say |
| RULED 2026-09-19, defect 1 | OPEN | . Test: "rehearsal client" passes; "per ruling 3" still fails. |
| RULED 2026-09-19, defect 2 | OPEN | ge verbatim, and the field keeps its text; the page-top flash is for navigation results only. Every form in Ops and the portal; the harness asserts the message beside the field on a refused |
| RULED 2026-09-19, defect 3 | OPEN | nse, dated, everywhere a suppression is shown (SA-2026-0004's send log read present tense a week after arming). |
| RULED 2026-09-19, defect 4 | OPEN | riod control on non-tax lines. |
| RULED 2026-09-19, THE 1120S DRY RUN (filed in ATX on time, outside SAOS; the ruled fallback exercised delibera | OPEN | tely) on the harness with an already-filed 1120S fixture, Brian in every role: 1) business-tax quote against Soto Accounting LLC, $0 deposit override with reason, accept in the portal, Sched |
| STILL BRIAN'S | OPEN |  |
| Then the Monday walk as written | OPEN |  |
| RULED 2026-09-12 (evening), 4 (note, no build) | closed | ontact email is brian@sotoaccounting.com; say whether the portal-access badge represents that honestly. ANSWERED in the evening report: the badge states access, not the address; the sign-in |
| Brian withdrew the 2025 intake engagement himself through Ops (2026-09-12); its orphaned return withdrawn thro | closed | ugh the route the same evening. |
| RULED 2026-09-12 | OPEN | s the real path with her review as the gate. |
| RULED 2026-09-12 | OPEN | orizations; the gate checks the document, same category check). Build when the resolution lane first needs it; not before. |
| Waive Stripe check renders only on an invoice with an open drift finding; the route refuses otherwise (2026-09 | closed | -12). |
| FIRST REAL-DATA RUN (Brian, 2026-09-12) | OPEN | tical path; SAOS never delays the filing; a block is a finding, not a delay. Checks a–f confirmed or built in this batch; phone walk list for Monday and Tuesday delivered. |
