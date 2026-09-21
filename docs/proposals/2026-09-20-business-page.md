# Business page (R40, report-only, 2026-09-20)

R40: "Business page, report-only this batch. Build it next batch. Needed before the bookkeeping
and billing cutovers, because the Trello service facts attach to businesses."

## Route and read

- **Route**: `/businesses/[id]` — new `apps/internal/app/businesses/[id]/page.tsx`. No nav
  item.
- **API**: one new aggregate `GET /businesses/:id` in `apps/api/src/modules/crm/routes.ts`
  (next to `GET /businesses`, line 543; gate `read` = `contacts.read`, line 140) returning
  `{ business, members, entityCompliance, accessFacts, factImports }`. The four lists reuse the
  existing endpoints with a `businessId` filter added: `GET /engagements` (ListQuery is
  `contactId` only, engagements/routes.ts line 56), `GET /tax-engagements` (tax/routes.ts
  370-377), `GET /invoices` (billing/routes.ts 257-262), `GET /documents` (documents/routes.ts
  301-303, where `contactId` is required today).

## Cards, in order

| Card | Columns | Source | Reuses |
|---|---|---|---|
| Entity details | name, status active/dissolved (0099:23-24), entity_type, EIN on file / last four, state, fiscal_year_end_month, industry, naics_code, formation_date + source (0078:42-45), il_sos_status + checked_at, is_test/test_note, unverified_import_source (0103:23), archived/merged_into (0101:18-24) | `businesses` (0002:106-129) | badges from the client page's Businesses card (clients/[id]/page.tsx 740-760); `PATCH /businesses/:id` (crm 609) |
| Owners | person (link to `/clients/[id]`), member_role, "primary for this person" | `business_members` (0002:131-136) | lead-card markup |
| Engagements | service_line, status, title, lead staff, started/ended, prep_cadence, filing_frequency (0106:30), payroll_provider (0107:27) | `engagements.business_id` (0003:23) | Engagements card (page.tsx 1045+), `engagementStatusLabel` |
| Returns | tax_year, return_type, stage, preparer of record, extension, filed/accepted dates, fees | `tax_engagements` via `engagements.business_id` | `ReturnControls` (components/return-controls.tsx), lib/return-controls |
| Service facts | books_current_through + as_of (0105:37-39); qbo_paid_by + as_of (0110:36-38); annual-report anniversary_mmdd/kind, due date, status (0108:33-35, 0003 entity_compliance); access facts: fact, as_of, source (0109:43-50); sales-tax frequency and payroll provider (from engagements); provenance line per fact from `service_fact_imports` fact_type/as_of/applied_at/rows_written (0114:79-93) | those tables | new component — nothing exists |
| Invoices | invoice_number, status, total, paid, sent/paid, void/refund | invoices joined through engagement | invoice row + lib/invoice-display.ts |
| Documents | category, filename, status, uploaded, scan | `documents.business_id` (0004:25) | Documents card (page.tsx 828), the wall (`readableCategories`) |

### What "owner" means in the data today

`business_members.member_role` is free text from intake ("your role": 'owner', 'co-owner', …).
`is_primary` means **this business is that person's primary business** (one per contact,
trigger 0101:29-45), not "primary owner". No ownership percentage, officer title, or start/end
date exists. The card shows what exists, labelled honestly; `ownership_percent` and a role
vocabulary are a later migration when an 1120-S/1065 needs them.

## Reaching the page

- **Person's Businesses card**: `<strong>{b.name}</strong>` at clients/[id]/page.tsx line 742
  becomes a `Link` to `/businesses/{b.id}`.
- **Search**: the Clients list already matches a business name through `business_members`
  (crm/routes.ts 206-213) but returns the *person*. Proposal: the clients page (apps/internal/
  app/clients/page.tsx, `search` state line 44) also calls `GET /businesses?search=` and shows a
  "Businesses" section above the people. Extend that route (crm 543-557): name `ILIKE`; when the
  query is exactly four digits, `right(regexp_replace(ein,'\D','','g'),4) = $q` (EIN never
  returned, only matched). **DBA: no column exists** (migrations grep, 2026-09-20) — the
  migration adds `businesses.dba text`; until then search matches name only.

## Permissions per card

Page, Entity, Owners, Service facts: `contacts.read` (the business GET). Engagements and
Returns: `engagements.read`. Invoices: `billing.manage` (billing 36, as on the client page).
Documents: `documents.read` plus the category wall; opens stay audit-logged. Edits: entity
fields `businesses.write` or `contacts.write` (the Add-a-business door, page.tsx 278-281, 395);
compliance facts `entity.manage`. A card whose permission is missing is hidden, as
`canAddBusiness` hides its button.

## What is missing for each card to be truthful

- **Invoices have no `business_id`** (0008:18-40): attribution is only through `engagement_id`
  or `tax_engagement_id → engagement`. A standalone invoice cannot appear. Before the billing
  cutover: migration adds `invoices.business_id` (nullable, backfilled from the engagement), and
  the quote→engagement→invoice path writes it.
- **Documents carry `business_id`** but the list route requires `contactId`; uploads accept
  `businessId` (documents/routes.ts 36, 246) yet the upload forms do not send it, so most rows
  are NULL. Coverage on the box is **unverified** (no production count was run; the 2026-09-20
  backup manifest totals 6 documents, 11 engagements, 4 invoices). The card says "documents
  filed to this business" and links to the owner's full list.
- **Engagements/returns**: `business_id` is set by the Trello importer and the tax create path
  (tax/routes.ts 292-300); hand-made engagements may lack it — shown as "no business on this
  engagement" with a set-business control.
- **Service facts**: complete for the Trello-imported set; `qbo_paid_by` defaults to 'unknown'.
- **Owners**: role text and no percentage, stated above.
- **Entity**: EIN display rule (last four for `contacts.read`, full for `pii.read`) is a
  decision for Brian; the client page shows only "EIN on file".

## Build estimate by file (next batch)

| File | Change | Lines |
|---|---|---|
| packages/db/migrations/<next>_business_page.js (0116 is taken by in-flight price-book work) | `invoices.business_id` + backfill, `businesses.dba` | ~50 |
| apps/api/src/modules/crm/routes.ts | `GET /businesses/:id` aggregate; EIN-4/DBA search | ~130 |
| apps/api/src/modules/engagements/routes.ts, tax/routes.ts, billing/routes.ts, documents/routes.ts | `businessId` filters (invoices via join; documents `contactId` OR `businessId`) | ~50 |
| apps/internal/app/businesses/[id]/page.tsx | new page, seven cards lifted from clients/[id] | ~600 |
| apps/internal/app/clients/[id]/page.tsx | link from the Businesses card | ~5 |
| apps/internal/app/clients/page.tsx | Businesses section in search | ~40 |
| apps/api/test/business-page.spec.ts | aggregate, filters, EIN-4 search, permission hiding | ~180 |

About 1,050 lines; one batch, migration first.

## Recorded for Design Phase 1 (no change now)

The Ops top navigation carries more than twenty items and overflows the bar: **25 items**
(`apps/internal/app/shell.tsx` lines 9-33, Executive through Account).
