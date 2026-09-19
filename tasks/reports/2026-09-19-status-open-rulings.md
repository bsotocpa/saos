# status-open-rulings (2026-09-19)

Generated 2026-09-19T19:10:09.316Z by scripts/report-table.mjs from the log open-rulings.log; 46 row(s).

Every line in the OPEN RULINGS section of tasks/todo.md after the 2026-09-19 batch, with its checkbox state and outcome; read from the file, not from memory.

```sql
grep -E '^- \[[ x]\]' tasks/todo.md (OPEN RULINGS section), name = text before the first sentence end, outcome = the SHIPPED/DONE/ANSWERED clause
```

| ruling | state | outcome |
|---|---|---|
| Co-facilitation | OPEN |  |
| Hilo referral discount | OPEN |  |
| Docuseal volume and /mnt/saos-data/docuseal | OPEN |  |
| d) Soto Accounting LLC business record | OPEN |  |
| Monday's first message re-checks the standing rules (Brian, 2026-09-12 evening). | OPEN |  |
| RULED 2026-09-12 (merge batch) | OPEN |  |
| RULED 2026-09-12 (evening) | closed | SHIPPED: POST /contacts/:id/archive and POST /businesses/:id/archive (isTest + testNote); both archived on the box through the routes. |
| RULED 2026-09-12 (evening) | closed | SHIPPED: no_shared_identifier unless identityOverrideReason; the audit row names the shared identifiers or the override. |
| RULED 2026-09-12 (evening), 2a | closed | SHIPPED: migration 0100 (two triggers), deriveLifecycle open work = onboarding, createEngagement audits the move; production violations: none. |
| RULED 2026-09-12 (evening), 2b | closed | SHIPPED: intake inserts removed; POST /engagements, the new-engagement branch of POST /tax-engagements, and POST /resolution/cases require a reason, audited as |
| RULED 2026-09-12 (evening), 2c | closed | SHIPPED: withdrawUnfiledReturns in closeEngagement and change-order supersession; migration 0100 both directions; sabotage red then green; the orphan withdrawn |
| RULED 2026-09-12 (evening), 3 | closed | SHIPPED: migration 0101, crm/businesses.ts, archive/merge/primary-business routes, Ops page; box: soto incorporated merged then archived, BRIAN SOTO TEST archiv |
| RULED 2026-09-12 (late), 1 | closed | SHIPPED: migration 0102 lists every row by contact and business in the deploy log, then clears; createQuote refuses a business line with no business (business_r |
| RULED 2026-09-12 (late), 2 | closed | SHIPPED: portal_login_email on the contact detail; "signs in as / inicia sesión como". |
| RULED 2026-09-12 (late), 3 | closed | SHIPPED: createSession takes appliedBy and stamps the session; the auth plugin puts "(appliedBy)" on every row written under it; on the box an unlabelled browse |
| RULED 2026-09-12 (night), 1 | closed | SHIPPED: crm/duplicates.ts (plan from shared identifiers, winner by holdings, notes on the rest), scripts/duplicate-scan.ts (dry run; APPLY=1), RUN ON THE BOX 2 |
| RULING NEEDED: merge Joseph Basilone's two records (they share a phone; the scan planned it and held it as a protected n | closed | closed |
| RULED 2026-09-12 (night), 2 | closed | ON THE BOX: 202 businesses tagged, all from Zoho, one audit row each; one protected row among them (Joseph Basilone · JOSEPH BASILONE and MELISSA BASILONE), lis |
| SCAN TIE ORDER (shipped 2026-09-12, late night) | closed | closed |
| DEPLOY ORDER (shipped 2026-09-12, late night) | closed | closed |
| ENRICHMENT: the unverified-import businesses join the FL-entity enrichment work; each needs an entity type or an EIN fro | OPEN |  |
| Monday's first message re-checks standing rules before anything else (done 2026-09-12 night | closed | closed |
| RULED 2026-09-12 (late night), 1 | closed | SHIPPED: scripts/report-table.mjs, scripts/check-report-draft.mjs, check:report-files in the root suite; tasks/reports holds the 167, the 12 merged, the 107 not |
| RULED 2026-09-12 (late night), 2 | closed | SHIPPED: deploy.sh builds, preflights on a copy (scripts/preflight-migrate.sh), migrates, then swaps; sabotage on the box red then green; first deploy through t |
| RULED 2026-09-12 (late night), 3 | closed | DONE on the box through the scan with APPROVED naming the loser; tasks/reports/2026-09-12-joseph-basilone-merge.md. |
| RULED 2026-09-12 (late night), 4 | closed | SHIPPED with the tie-break by id in the ranking too. |
| RULED 2026-09-12 (late night), 5 | closed | SHIPPED: sameNameBusinessesWithinContact, scripts/business-dedupe.ts; on the box: one group, Erica Gonzalez's Tri-Taylor rows merged; tasks/reports/2026-09-12-b |
| RULED 2026-09-12 (late night), 6 (deferred, enrichment) | OPEN |  |
| RULED 2026-09-19, 0 | closed | SHIPPED: Ops -> client page -> Businesses card -> "Add a business" (components/add-business.tsx); POST /contacts/:id/businesses takes formationDate (staff_verif |
| RULED 2026-09-19, STATUS: every open ruling with its state, everything shipped since 09-13, staff accounts (five temp pa | closed | DONE: tasks/reports/2026-09-19-status-*.md (open rulings from this file, staff accounts, automations, the waiver amendment); nothing shipped between 09-13 and 0 |
| RULED 2026-09-19, DRY RUN IS SOLO: Brian acts as every role before the team sees it; handovers wait until the dry run is | closed | ANSWERED: the E-file acks screen, the review transitions and the billing controls are permission-gated and the CEO holds every permission; the preparer queue WA |
| RULED 2026-09-19, defect 1 | closed | SHIPPED (reasons.ts, reasons.spec). |
| RULED 2026-09-19, defect 2 | closed | SHIPPED: ask() takes run (Ops and portal); 122 handlers surveyed and converted; ops-inline-error.spec.ts at 390px. |
| RULED 2026-09-19, defect 3 | closed | SHIPPED: outbox.holdLine(at); old rows dated from their suppression audit row; the acks screen reads suppressed_at. |
| RULED 2026-09-19, defect 4 | closed | SHIPPED (client page). |
| RULED 2026-09-19, THE 1120S DRY RUN (filed in ATX on time, outside SAOS; the ruled fallback exercised deliberately) on t | closed | SHIPPED on the harness: e2e-boot delivers the S corp return; ops-scorp-dry-run.spec.ts does 3, 4, 5 as the CEO on the phone project and both projects read the f |
| RULING NEEDED (harness finding, 2026-09-19) | OPEN |  |
| BRIAN, LIVE (after this deploy) | OPEN |  |
| STILL BRIAN'S: Trello exports, FL entity classification, client #1 name; 26 days to 2026-10-15. | OPEN |  |
| Then the Monday walk as written. | OPEN |  |
| RULED 2026-09-12 (evening), 4 (note, no build) | closed | ANSWERED in the evening report: the badge states access, not the address; the sign-in address is not shown anywhere on the page. |
| Brian withdrew the 2025 intake engagement himself through Ops (2026-09-12); its orphaned return withdrawn through the ro | closed | closed |
| RULED 2026-09-12 | OPEN |  |
| RULED 2026-09-12 | OPEN |  |
| Waive Stripe check renders only on an invoice with an open drift finding; the route refuses otherwise (2026-09-12). | closed | closed |
| FIRST REAL-DATA RUN (Brian, 2026-09-12) | OPEN |  |
