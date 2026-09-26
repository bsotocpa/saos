# preparer-gates (2026-09-26)

Generated 2026-09-26T21:35:20.311Z by scripts/report-table.mjs from the log preparer-gates.log; 55 row(s).

R59 (2026-09-26, report-only). Every pipeline transition and door a return passes, the permission it needs, and whether the seeded tax_preparer role (packages/db/seeds/data/roles.mjs:45-72: contacts.read, engagements.read, engagements.tax.manage, quotes.manage, irs_notices.manage, efile.manage, documents.read, documents.read.all, documents.write, pii.read, interviews.read, tasks.read, tasks.manage, meetings.read, meetings.read.all, meetings.upload, time.log) holds it. Only the ceo role holds '*' (roles.mjs:21); deposits.override and pricing.packages.save are explicit-only (auth.ts:97-101). Line numbers are at HEAD 00b8352; the working tree had uncommitted edits to tax/routes.ts and pipeline.ts by other agents when this was written.

```sql
git show HEAD:<file> | grep -n (the guards read at HEAD 00b8352: apps/api/src/plugins/auth.ts requirePermission/holds/EXPLICIT_ONLY_PERMISSIONS; the route files named in the guard column; packages/db/seeds/data/roles.mjs:45-72 for the 17 tax_preparer grants)
```

| transition or door | route | guard (file:line at HEAD 00b8352) | permission or role required | tax_preparer holds it | note |
|---|---|---|---|---|---|
| Create a return | POST /tax-engagements | apps/api/src/modules/tax/routes.ts:276 (guard :273) | engagements.tax.manage | yes | reason required when the client has no active engagement (:302-307); body enum lacks ag990il (:32-35) |
| My queue | GET /my-queue | apps/api/src/modules/tax/routes.ts:356 (guard :274) | engagements.read | yes (own returns only) | leadership = '*' or dashboards.executive (:359-360) may pass all=1 or a preparerId; a preparer is scoped to preparer_id = self (queue.ts:78) |
| List returns | GET /tax-engagements | apps/api/src/modules/tax/routes.ts:370 (:274) | engagements.read | yes \| |
| Return detail | GET /tax-engagements/:id | apps/api/src/modules/tax/routes.ts:397 (:274) | engagements.read | yes | complexity_inputs stripped without interviews.read (:407); she holds it |
| Stage transition (every move) | POST /tax-engagements/:id/transition | apps/api/src/modules/tax/routes.ts:468 (:273); logic pipeline.ts:210-347 | engagements.tax.manage | yes | allowed moves in TRANSITIONS pipeline.ts:40-57; no role check inside transitionStage |
| Gate 1: letter signed (any move past scheduled) | same | apps/api/src/modules/tax/pipeline.ts:233-235 | engagements.tax.manage | yes | 409 engagement_letter_required; stamped by the paper-letter upload or the portal packet signature |
| Gate 2: estimate locked (into in_preparation) | same | apps/api/src/modules/tax/pipeline.ts:241-243 | engagements.tax.manage | yes | 409 estimate_lock_required |
| Gate 2b: preparer assigned (into in_preparation) | same | apps/api/src/modules/tax/pipeline.ts:254-256 | engagements.tax.manage | yes | 409 preparer_required; assignee must be an active tax_preparer or ceo (PREPARER_ROLE_KEYS :114) |
| Gate 3: signed 8879 on file (into filed) | same | apps/api/src/modules/tax/pipeline.ts:262-264 | engagements.tax.manage | yes | 409 f8879_required; needs f8879_signed_at AND f8879_document_id; the message names only "Form 8879" (no TE variant) |
| Gate 4: preparer of record + jurisdictions + filing method (into filed) | same | apps/api/src/modules/tax/pipeline.ts:278-288 | engagements.tax.manage | yes | 409 preparer_of_record_required; the invoice is created at filed (:333) |
| Hold or withdraw | same | apps/api/src/modules/tax/pipeline.ts:222-225 | engagements.tax.manage | yes | from anything but completed/withdrawn; withdrawn is terminal (:56) |
| Resume from on_hold | same | apps/api/src/modules/tax/pipeline.ts:55 (RESUMABLE :34-37) | engagements.tax.manage | yes | every gate re-applies |
| Manual complete (filed -> completed) | same | apps/api/src/modules/tax/pipeline.ts:52 | engagements.tax.manage | yes | offered by legalNextStages; skips the per-jurisdiction awaiting check the auto-complete path runs |
| Reopen a completed return | none | apps/api/src/modules/tax/pipeline.ts:54 (completed: []) | — | n/a | NO DOOR for anyone: completed has no outgoing move and no reopen route exists |
| Auto-complete on acceptance or mailing | inside efile-result and mailing | apps/api/src/modules/tax/pipeline.ts:726-741 | the calling route's permission | yes | closes the engagement once every return on it is done |
| Paper mailing per jurisdiction | POST /tax-engagements/:id/jurisdictions/:jurisdiction/mailing | apps/api/src/modules/tax/routes.ts:485-487 (:273) | engagements.tax.manage | yes | recordJurisdictionMailing pipeline.ts:816 |
| Resolution-lane paper mailing | POST /tax-engagements/:id/paper-mailing | apps/api/src/modules/tax/resolution-routes.ts:124 (:31) | engagements.tax.manage | yes | refused on e-file years |
| E-file result on one return | POST /tax-engagements/:id/efile-result | apps/api/src/modules/tax/routes.ts:514 (:273) | engagements.tax.manage | yes | return must be in filed (pipeline.ts:944) |
| Lock the estimate by hand | POST /tax-engagements/:id/estimate | apps/api/src/modules/tax/routes.ts:535 (:273) | engagements.tax.manage | yes \| |
| Lock the estimate from the price book | POST /tax-engagements/:id/quote | apps/api/src/modules/pricing/routes.ts:30 (:16) | engagements.tax.manage | yes | pins the price book version |
| Set the final fee | POST /tax-engagements/:id/final-fee | apps/api/src/modules/tax/routes.ts:556 (:273) | engagements.tax.manage | yes | reason required outside the quoted range |
| Complexity score | POST /tax-engagements/:id/complexity | apps/api/src/modules/tax/routes.ts:649 (:273) | engagements.tax.manage | yes \| |
| Wet signature (retired path) | POST /tax-engagements/:id/signatures/wet | apps/api/src/modules/tax/routes.ts:664 (:273) | engagements.tax.manage | yes | always 410 |
| Assign or change the preparer | POST /tax-engagements/:id/preparer | apps/api/src/modules/tax/routes.ts:694 (:273) | engagements.tax.manage | yes | she can assign herself |
| Request documents from the client | POST /document-requests | apps/api/src/modules/tax/routes.ts:724 (:273) | engagements.tax.manage | yes | emails the client; marks documents_requested |
| Upload the signed 8879 | POST /documents (signed_authorizations + taxEngagementId + signedOn + preparerPtinHolderId) | apps/api/src/modules/documents/routes.ts:223-224, branch :254-260 -> tax/signed-8879.ts:89 | documents.write | yes | NO form-variant field (routes.ts:31-46); envelope type fixed at 'f8879' (signed-8879.ts:128) |
| Upload the paper engagement letter | POST /documents (signed_authorizations + engagementLetterSignedOn) | apps/api/src/modules/documents/routes.ts:224, branch :266-272 -> signed-8879.ts:160 | documents.write | yes | also sets the contact's letter status to signed |
| Deliver the return (return_deliverable) | POST /documents (category return_deliverable) | apps/api/src/modules/documents/routes.ts:275 | documents.write | yes | advances the stage |
| Document status or archive | PATCH /documents/:id | apps/api/src/modules/documents/routes.ts:452-453 | documents.write | yes \| |
| Remote 8879 / KBA (retired) | POST /tax-engagements/:id/signatures/remote-8879, /kba/:kbaId/simulate | apps/api/src/modules/signatures/routes.ts:66, :69 (:16) | engagements.tax.manage | yes | 410 |
| Extension: recommend decision | POST /tax-engagements/:id/extension/decision | apps/api/src/modules/tax/extension-routes.ts:55 (:46) | engagements.tax.manage | yes \| |
| Extension: payment estimate / payment made | POST .../extension/payment-estimate, .../payment-made | apps/api/src/modules/tax/extension-routes.ts:62, :69 (:46) | engagements.tax.manage | yes \| |
| Extension: mark filed | POST /tax-engagements/:id/extension/filed | apps/api/src/modules/tax/extension-routes.ts:76 (:46); body enum :36-39 | engagements.tax.manage | yes | form limited to 4868 or 7004; no 8868 |
| Extension decision list / deadline dashboard | GET /tax-engagements/extension-decision-list, GET /dashboards/deadlines | apps/api/src/modules/tax/extension-routes.ts:50, :85 (:47) | engagements.read | yes \| |
| Extension jobs by hand | POST /jobs/extension-decision-list, /jobs/summer-chase, /jobs/estimate-reminder, /jobs/auto-extension-batch | apps/api/src/modules/tax/extension-routes.ts:92-108 (:48) | jobs.run | NO | granted to no role by name; only '*' (CEO) |
| Extension batches: list/read | GET /extension-batches, /extension-batches/:id | apps/api/src/modules/tax/extension-routes.ts:113, :124 (:47) | engagements.read | yes \| |
| Extension batch: approve | POST /extension-batches/:id/approve | apps/api/src/modules/tax/extension-routes.ts:129 (:48) | jobs.run | NO | CEO only |
| Extension batch: remove an item | DELETE /extension-batches/:id/items/:teId | apps/api/src/modules/tax/extension-routes.ts:137 (:48) | jobs.run | NO | CEO only |
| Extension batch: file an item | POST /extension-batches/:id/items/:teId/filed | apps/api/src/modules/tax/extension-routes.ts:145 (:46) | engagements.tax.manage | yes | refused until the batch is approved; form defaults from return type (extension-batch.ts:261) |
| ATX ack upload / list / read | POST /efile-acks, GET /efile-acks, GET /efile-acks/:id | apps/api/src/modules/tax/efile-ack-routes.ts:21, :34, :36 (:18) | efile.manage | yes \| |
| ATX ack row hold / unhold / release | POST /efile-acks/rows/:id/hold, /unhold, POST /efile-acks/:id/release | apps/api/src/modules/tax/efile-ack-routes.ts:41, :47, :53 (:18) | efile.manage | yes \| |
| Resolution preview / quote grid / bundles | POST /resolution/preview, /resolution/quote-grid, GET /bundles, /bundles/:slug | apps/api/src/modules/tax/resolution-routes.ts:38, :56, :135, :149 (:30) | engagements.read | yes \| |
| Resolution case create / 2848 / representation check | POST /resolution/cases, /resolution/cases/:id/f2848, /representation-check | apps/api/src/modules/tax/resolution-routes.ts:74, :102, :116 (:31) | engagements.tax.manage | yes \| |
| Compute a quote (no persistence) | POST /pricing/quote | apps/api/src/modules/pricing/routes.ts:19 (:15) | engagements.read | yes \| |
| Quote create / send / client link / withdraw draft / lead stage | POST /quotes, /quotes/:id/send, /quotes/:id/client-link, /quotes/:id/withdraw-draft, /contacts/:id/lead-stage | apps/api/src/modules/pricing/quote-routes.ts:162, :219, :239, :337, :360 (:103) | quotes.manage OR engagements.tax.manage | yes \| |
| Quote catalog / read / pipeline / interview | GET /quotes/catalog, /quotes/:id, /contacts/:id/quotes, /pipeline, /quotes/tax-interview | apps/api/src/modules/pricing/quote-routes.ts:111, :254, :304, :354, :83 (:96, :81) | engagements.read | yes \| |
| Save quote lines as a package | POST /quotes/packages | apps/api/src/modules/pricing/quote-routes.ts:175 | pricing.packages.save (explicit-only) | NO | CEO only; '*' does not reach it (auth.ts:97-101) |
| Deposit override or waiver | POST /quotes/:id/deposit-override | apps/api/src/modules/pricing/quote-routes.ts:196-197 | deposits.override (explicit-only) | NO | CEO only |
| Client accepts the quote (creates engagement + return) | POST /public/quote/:token/accept | apps/api/src/modules/pricing/quote-routes.ts:379 | client token (no staff auth) | n/a \| |
| Create or configure an engagement directly | POST /engagements, POST /engagements/:id/configure | apps/api/src/modules/engagements/routes.ts:59-60, :138-139 | engagements.create | NO | she reaches an engagement only through a quote acceptance or POST /tax-engagements |
| Engagement close / pause / resume | POST /engagements/:id/close, /pause, /resume | apps/api/src/modules/engagements/routes.ts:179, :242, :250 (:177) | engagements.write | NO | granted to no role by name; CEO via '*' |
| Deposit transfer / restamp / period | POST /engagements/:id/transfer-deposit, /restamp-deposit, PATCH /engagements/:id/period | apps/api/src/modules/engagements/routes.ts:201-202, :219-220, :235 | billing.manage | NO | ceo and comms_billing |
| Invoices (create, send, list, refund) | /invoices... | apps/api/src/modules/billing/routes.ts:36 | billing.manage | NO | the client page shows her "Invoices (0)" because the 403 is swallowed (clients/[id]/page.tsx:349-351) |
| Executive home (the landing page) | GET /dashboards/executive | apps/api/src/modules/dashboards/routes.ts:12, :16 | dashboards.executive | NO | apps/internal/app/page.tsx:136 has no catch, so she sees "Loading…" (:146) forever |
| Staff page (temp password, MFA state) | GET /staff, POST /staff, POST /staff/:id/password/regenerate | apps/api/src/modules/staff/routes.ts:62, :84, :196 | staff.manage | NO | CEO via '*' |
