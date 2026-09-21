# edit-doors (2026-09-20)

Generated 2026-09-21T02:21:11.633Z by scripts/report-table.mjs from the log edit-doors.log; 37 row(s).

Every entity with a create control has an edit control tapped at both viewports, or an explicit "immutable because" entry (R38); the guard scripts/check-edit-doors.mjs fails the root chain when a create route has no update route with a UI caller and the entity is not marked immutable.

```sql
node scripts/edit-doors.mjs  (the API route registrations under apps/api/src/modules joined with scripts/edit-doors.json; tapped columns from apps/e2e/.artifacts/last-run.json, the full harness run of 2026-09-20: 65 passed, 0 failed)
```

| entity | create route | update route | UI caller (file) | tapped phone | tapped desk | immutable because |
|---|---|---|---|---|---|---|
| contact | POST /contacts (apps/api/src/modules/crm/routes.ts:342) | PATCH /contacts/:id (apps/api/src/modules/crm/routes.ts:492) | apps/internal/app/clients/[id]/page.tsx | yes (apps/e2e/tests/ops-path-b.spec.ts:173) | yes (apps/e2e/tests/ops-path-b.spec.ts:173) |  |
| business | POST /contacts/:id/businesses (apps/api/src/modules/crm/routes.ts:527) | PATCH /businesses/:id (apps/api/src/modules/crm/routes.ts:654) | apps/internal/components/edit-business.tsx | yes (apps/e2e/tests/ops-scorp-dry-run.spec.ts:132) | yes (apps/e2e/tests/ops-scorp-dry-run.spec.ts:132) |  |
| staff member | POST /staff (apps/api/src/modules/staff/routes.ts:84) | PATCH /staff/:id (apps/api/src/modules/staff/routes.ts:114) | apps/internal/app/admin/staff/page.tsx | yes (apps/e2e/tests/ops-edit-doors.spec.ts:96) | yes (apps/e2e/tests/ops-edit-doors.spec.ts:96) |  |
| task | POST /tasks (apps/api/src/modules/tasks/routes.ts:265) | PATCH /tasks/:id (apps/api/src/modules/tasks/routes.ts:291) | apps/internal/app/tasks/task-form.tsx | yes (apps/e2e/tests/ops-edit-doors.spec.ts:53) | yes (apps/e2e/tests/ops-edit-doors.spec.ts:53) |  |
| quote | POST /quotes (apps/api/src/modules/pricing/quote-routes.ts:162) | — | create only: apps/internal/app/pipeline/page.tsx | — | — | immutable because edited by superseding: a draft is withdrawn with a reason and rebuilt; a sent quote pins its price-book version and is the client's to answer; a change to accepted work is a change-order quote |
| engagement packet | POST /contacts/:id/packet (apps/api/src/modules/engagements/packet-routes.ts:52) | — | create only: apps/internal/app/clients/[id]/page.tsx | — | — | immutable because a document assembled from the record and signed as assembled; a change is a new packet, never an edit of one sent for signature |
| invoice | POST /invoices (apps/api/src/modules/billing/routes.ts:39) | — | — | — | — | immutable because an issued document: voided or refunded through their own audited doors, never edited |
| task board | POST /boards (apps/api/src/modules/tasks/routes.ts:529) | — | create only: apps/internal/app/tasks/boards/page.tsx | — | — | immutable because named once; its content is its columns and cards, each moved or added through their own doors |
| task column | POST /boards/:id/columns (apps/api/src/modules/tasks/routes.ts:560) | — | — | — | — | immutable because named once; cards move between columns |
| saved task view | POST /task-views (apps/api/src/modules/tasks/routes.ts:221) | — | create only: apps/internal/app/tasks/page.tsx | — | — | immutable because a snapshot of its filters and sort; changed by saving the view again, not by editing the saved one |
| task comment | POST /tasks/:id/comments (apps/api/src/modules/tasks/routes.ts:467) | — | — | — | — | immutable because what was said, when it was said |
| task checklist item | POST /tasks/:id/checklist (apps/api/src/modules/tasks/routes.ts:488) | PATCH /tasks/:id/checklist/:itemId (apps/api/src/modules/tasks/routes.ts:509) | — | — | — | no create control in Ops: no Ops screen adds one yet |
| task dependency | POST /tasks/:id/dependencies (apps/api/src/modules/tasks/routes.ts:339) | — | create only: apps/internal/app/tasks/task-form.tsx | — | — | immutable because a link between two tasks: added or removed, nothing on it to edit |
| task template | POST /task-templates (apps/api/src/modules/tasks/routes.ts:591) | — | — | — | — | no create control in Ops: seeded definitions; API only |
| time entry | POST /time-entries (apps/api/src/modules/tasks/routes.ts:614) | — | — | — | — | immutable because a timer record: started and stopped |
| broadcast | POST /broadcasts (apps/api/src/modules/comms/broadcast-routes.ts:49) | — | create only: apps/internal/app/announcements/page.tsx | — | — | immutable because approved and sent as composed (approval-gated, unsubscribe appended at send); a change is a new broadcast |
| event | POST /events (apps/api/src/modules/events/routes.ts:60) | — | — | — | — | immutable because published and completed as created; registrations are their own records |
| SOP | POST /sops (apps/api/src/modules/sops/routes.ts:57) | PATCH /sops/:slug (apps/api/src/modules/sops/routes.ts:64) | — | — | — | no create control in Ops: seeded from meetings (seed-sop) and the API; the SOP screen reads |
| IRS notice | POST /irs-notices (apps/api/src/modules/notices/routes.ts:39) | PATCH /irs-notices/:id (apps/api/src/modules/notices/routes.ts:68) | — | — | — | no create control in Ops: no Ops screen creates one yet; notices are entered through the API and inbound mail |
| grant voucher | POST /grant-vouchers (apps/api/src/modules/grants/routes.ts:29) | PATCH /grant-vouchers/:id (apps/api/src/modules/grants/routes.ts:44) | — | — | — | no create control in Ops: status tracking only; no Ops screen creates one yet |
| PLLC conversion | POST /pllc-conversions (apps/api/src/modules/entity/routes.ts:293) | PATCH /pllc-conversions/:id (apps/api/src/modules/entity/routes.ts:338) | — | — | — | no create control in Ops: no Ops screen creates one yet |
| entity group | POST /entity-groups (apps/api/src/modules/crm/routes.ts:722) | PATCH /entity-groups/:id (apps/api/src/modules/crm/routes.ts:763) | — | — | — | no create control in Ops: groups come from the onboarding form and the API; the group screens are not built |
| entity group member | POST /entity-groups/:id/members (apps/api/src/modules/crm/routes.ts:731) | — | — | — | — | immutable because a membership is added, never edited |
| entity compliance item | POST /entity-compliance (apps/api/src/modules/entity/routes.ts:57) | — | — | — | — | immutable because a derived obligation, marked filed through its own door |
| close cycle | POST /close-cycles (apps/api/src/modules/bookkeeping/routes.ts:60) | — | — | — | — | immutable because a ledger of steps for one period; steps are recorded, the period never changes |
| client session | POST /client-sessions (apps/api/src/modules/bookkeeping/routes.ts:107) | — | — | — | — | immutable because a scheduled occurrence; rescheduling is a new session |
| document request | POST /document-requests (apps/api/src/modules/tax/routes.ts:724) | — | — | — | — | immutable because a request as made; fulfilment and chasing are the record |
| tax engagement (return) | POST /tax-engagements (apps/api/src/modules/tax/routes.ts:276) | — | — | — | — | immutable because no free-form edit by design: each field has its own audited door in return-controls.tsx (estimate, final fee, preparer, extension, transition, signatures, paper mailing) |
| resolution case | POST /resolution/cases (apps/api/src/modules/tax/resolution-routes.ts:74) | — | — | — | — | immutable because a case as opened; representation and forms are its own doors |
| signature envelope | POST /signature-envelopes (apps/api/src/modules/signatures/routes.ts:19) | — | — | — | — | immutable because an issued envelope |
| e-file acknowledgment report | POST /efile-acks (apps/api/src/modules/tax/efile-ack-routes.ts:21) | — | create only: apps/internal/app/efile-acks/page.tsx | — | — | immutable because an uploaded report; its rows are held, unheld and released through their own doors |
| recording | POST /meetings/upload (apps/api/src/modules/meetings/routes.ts:65) | — | create only: apps/internal/app/recorder/page.tsx | — | — | immutable because an uploaded recording; its recap is drafted and edited through PATCH /meetings/:id/recap |
| price book version | POST /admin/price-book/versions (apps/api/src/modules/admin/routes.ts:148) | — | create only: apps/internal/app/admin/pricing/page.tsx | — | — | immutable because effective-dated and versioned: a price change is a new version, never an edit of one in force |
| referral | POST /referrals (apps/api/src/modules/referrals/routes.ts:48) | — | — | — | — | immutable because approved, declined or sent as suggested |
| document | POST /documents (apps/api/src/modules/documents/routes.ts:222) | — | create only: apps/internal/app/upload-return/page.tsx | — | — | immutable because an uploaded file, scanned and filed as uploaded; withdrawn or superseded by another upload, never edited, every access audited |
| engagement | POST /engagements (apps/api/src/modules/engagements/routes.ts:58) | — | — | — | — | immutable because no free-form edit by design: each change is its own audited door (configure, maintenance mode, pause, resume, close, period, deposit transfer) |
| quote package | POST /quotes/packages (apps/api/src/modules/pricing/quote-routes.ts:175) | — | create only: apps/internal/app/pipeline/page.tsx | — | — | immutable because composed from the price book only and saved by the CEO alone; a change is a new package, and the discount is admin-set at publish |
