# Handover readiness for 2026-10-19 (report, 2026-09-26, R59)

Report only; nothing is built. Line numbers are at HEAD 00b8352; the door-by-door table is
`tasks/reports/2026-09-26-preparer-gates.md`. Her tax_preparer account exists in production: active,
MFA not enrolled, temp password expired 2026-09-15, never signed in
(`tasks/reports/2026-09-19-status-staff-accounts.md`).

## 1. Account handover, in order

1. **Ops -> Staff** (`/admin/staff`, nav "Staff", heading "Staff & permissions"): her row reads
   "Tax Preparer / IRS Notice Handler (tax_preparer)", MFA "pending", status "active", badge "owes a
   password". Role and name are fixed from the row's "Change role…" select and "Edit"
   (`apps/internal/app/admin/staff/page.tsx:162-172`; `PATCH /staff/:id`,
   `apps/api/src/modules/staff/routes.ts:127-184`).
2. **"New temp password"** on her row (`page.tsx:209`) -> modal -> **"Issue a new password"**
   (`:197`; `POST /staff/:id/password/regenerate`, `routes.ts:196-220`, `staff.manage`, CEO only).
   The old password and every session die; 72-hour expiry; audited. Mandatory: the 2026-09-12
   password is dead.
3. **Reveal panel** "Temporary password for …" (`page.tsx:110-121`): **"Copy"**, hand it over out
   of band, then **"I have handed it over"**. Shown once, never stored in clear.
4. **She signs in** at `/login` ("Staff sign-in": Email, Password, "Sign in";
   `apps/internal/app/login/page.tsx:76-99`). The API answers `mfa_setup_required`
   (`apps/api/src/modules/auth/service.ts:183-199`).
5. **MFA enrollment, same screen**: "MFA is required for all staff accounts…", the secret as text
   (no QR code), "Code from your authenticator", **"Enable MFA + sign in"**
   (`login/page.tsx:103-120`; `POST /auth/mfa/setup`, `/auth/mfa/verify`, `auth/routes.ts:51-61`).
   Verify spends the temp password (`service.ts:276-277`). No recovery codes, no MFA reset route.
6. **Forced password change** at `/account?set-password=1` ("Account security": current = the temp
   password, "New password (12+ characters)", **"Change password"**;
   `apps/internal/app/account/page.tsx:59-111`; `POST /auth/password`, `auth/routes.ts:87-101`).
   Until then every other call is 403 `password_change_required` (`apps/api/src/plugins/auth.ts:77-79`).
   Stopping between steps 5 and 6 spends the temp password; repeat step 2.
7. **Assign her the return**: Returns card -> **"Assign preparer"**
   (`apps/internal/components/return-controls.tsx:219-221`; `POST /tax-engagements/:id/preparer`,
   `apps/api/src/modules/tax/routes.ts:694`).

## 2. What she sees on first login with a return assigned

- **`/` is the Executive page and stays on "Loading…" forever**: it calls `GET /dashboards/executive`
  (`dashboards.executive`, which she lacks; `apps/api/src/modules/dashboards/routes.ts:12,16`) with no
  catch (`apps/internal/app/page.tsx:136,146`). The "Needs you today" rollup she could read never
  renders.
- The nav is not gated by role (`apps/internal/app/shell.tsx:8-34`): all 25 items show; Staff,
  Automations, Pricing and Settings fail at the API for her.
- **My Queue** (`/queue`; `GET /my-queue`, `tax/routes.ts:356`; `tax/queue.ts:61-81`): only returns
  with `preparer_id = self`, completed/withdrawn excluded, rejected first then deadline. Tiles
  "Returns assigned", "Rejected", "At risk", "Waiting on docs"; each row: year and type, raw stage,
  docs state, due date, one button "Client packet" (`apps/internal/app/queue/page.tsx:78-163`). No
  8879 field of any kind (`QueueRow`, `queue.ts:17-39`).
- On the client page she sees every return control (`engagements.tax.manage`;
  `apps/internal/lib/return-controls.ts:11-16`), including the 8879 upload ("Signed 8879 (scan)",
  "Signed on", "PTIN holder"; `return-controls.tsx:494-503`). The Invoices card reads "Invoices (0)
  · Nothing invoiced yet." because the `billing.manage` 403 is swallowed
  (`apps/internal/app/clients/[id]/page.tsx:351`); Refund and Add business are hidden.

## 3. "8879 sent" in the queue

**It cannot show today.** `tax_stage` has 13 values (`packages/db/migrations/0003_engagements.js:49-53`,
`0018_efile_rejects.js:9`); the 8879 columns are `f8879_signed_at`, `f8879_signature_method`,
`f8879_document_id` only (`0003:114-115`, `0093_signed_8879_is_a_document.js:24-40`); no label or
route carries the state. The import maps "awaiting signature" to `ready_to_file`
(`apps/api/scripts/trello-normalize.ts:151`). R53 must add: (a) `f8879_sent_at` and
`f8879_sent_method` (adobe_sign / in_office / mailed) on `tax_engagements`; (b) both in the
`/my-queue` select and `QueueRow` (`queue.ts:17-39, 61-81`); (c) an "awaiting signature" badge and
tile on `/queue` (`queue/page.tsx:78-163`); (d) "Record 8879 sent" in `return-controls.tsx`.

## 4. Blockers for a preparer end to end

She holds 17 grants (`packages/db/seeds/data/roles.mjs:45-72`); every return-level door is hers,
from create through all four gates (`tax/pipeline.ts:233-288`) to e-file result, mailing, ATX acks,
extension filing and quotes. What needs someone else:

- **Executive home**: `dashboards.executive`, `dashboards/routes.ts:12` (CEO). Her landing page.
- **Extension batch approve / remove item**: `jobs.run`, `tax/extension-routes.ts:129,137` (no role
  by name; CEO via `*`). She files an item only after approval (`:145`).
- **Deposit override / waiver**: `deposits.override`, explicit-only, `pricing/quote-routes.ts:196`
  (CEO; `*` does not reach it, `plugins/auth.ts:97-101`).
- **Save quote lines as a package**: `pricing.packages.save`, `quote-routes.ts:175` (CEO).
- **Invoices and refunds**: `billing.manage`, `billing/routes.ts:36` (CEO, comms_billing). The
  invoice is created automatically at `filed` (`pipeline.ts:333`); she cannot see or send it.
- **Engagement close / pause / resume**: `engagements.write`, `engagements/routes.ts:177-250` (CEO).
  Acceptance closes the engagement for her (`pipeline.ts:726-741`).
- **Create or configure an engagement directly**: `engagements.create`, `engagements/routes.ts:60`;
  she reaches one through `POST /tax-engagements` or a quote acceptance.
- **Reopen a completed return**: no door for anyone (`pipeline.ts:54`).

## 5. What a Form 990 needs that the 1040 and 1120-S paths do not

- **8868 extension form: missing.** `EXTENSION_FORMS = ['4868', '7004']` (`tax/extension.ts:33`);
  `defaultExtensionForm` returns 7004 for anything but 1040 (`:37-38`); the CHECK allows only those
  two (`packages/db/migrations/0112_extension_form_on_the_return.js:74`); the auto batch files a 990
  as 7004 (`extension-batch.ts:261`). A 990 extension is recorded on the wrong form today.
- **8879-TE: missing.** The upload takes no form variant (`documents/routes.ts:31-46`), the envelope
  type is fixed `'f8879'` (`tax/signed-8879.ts:128`; enum `0004_documents_signatures.js:94`), gate 3
  names "Form 8879" for every type (`pipeline.ts:262-264`). The upload works for a 990; nothing
  records that the paper was an 8879-TE.
- **11/15 deadline: present and correct.** `'990'` and `'990ez'` sit at `monthsAfterYearEnd: 5`
  (`tax/deadlines.ts:51-52`): original = 15th of FYE + 5 months (`originalDeadline`, `:145`),
  extended = +6 months (`extendedDeadline`, `:164`), business-day rolled; a 2025 calendar-year 990
  derives 2026-05-15 and 2026-11-15.
- **Return types.** `990` and `990ez` exist (`0003_engagements.js:54`; `tax/routes.ts:32-35`);
  `990pf` and `990t` exist nowhere. `ag990il` is in the enum (`0014_ag990il_v45.js:11`) and the
  table (`deadlines.ts:62`), tracked per IL nonprofit business (`extension.ts:451-464`).
- **Form family / lane.** No form-family table; the only lane is year-based (`tax/resolution.ts:38`).
  `BIZ_990` maps to `990` (`price_book.mjs:235`, `return-type.ts:30`); nothing maps to `990ez`.
