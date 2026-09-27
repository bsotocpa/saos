# Trello cutover: two fact values the extract must carry (proposal, 2026-09-27)

**Report only. Build nothing until Brian rules.** Counts are Brian's; no client is named.

Brian's input: Rene's answers show that about 30 of the 55 sales-tax cards are clients who file their own ST-1. Marian's board update moved 28 quarterly and semi-annual clients to "Up to Jun 2025", which may be a mislabel.

## How facts travel today (read from the code)

- **Where facts come from.** `04b_service_facts.csv` has one row per fact: `fact_type`, `trello_source_id`, `match_key`, `as_of` and `values_json`. The `service_fact_imports` ledger (0114), keyed `(source, trello_source_id, fact_type)`, makes a rerun a no-op.
- **`sales_tax` rows** carry `values_json` `{frequency, closed_or_not_client, last_period_label}`. `engagements/import-facts.ts` handles them in two ways:
  - When `closed_or_not_client` is true, the importer writes a ledger row and creates nothing, because "an active engagement for it would be a claim the card contradicts".
  - When the service is live, it finds or creates an active `sales_tax` engagement (`period_key = 'ongoing'`, `source = 'trello'`), writes `filing_frequency` only where it is NULL, and places the R68 billing hold.
- **`bookkeeping` rows** carry `{books_current_through: "Mon YYYY", firm_has_bank_access}`.
  - The importer writes the month-end to `businesses.books_current_through`, with `books_current_through_as_of` set to the row's `as_of` (0105 requires both).
  - It overwrites whenever the value differs (`IS DISTINCT FROM`). The sales-tax branch, by contrast, writes only where the column is NULL.
  - The value is displayed on the business page and computed from nowhere today.
- **Precedents for the shapes below.**
  - `businesses.qbo_paid_by`: `client | soto | unknown`, with an as-of date required whenever the value is not unknown (0110).
  - `declared_by_import_default` (0114) and `f8879_sent_declared_by_import` (0120): flags meaning "the import said so; a person has not".

## The two values

| | 1. Sales tax filed by the client | 2. Books current through, unconfirmed |
|---|---|---|
| **Name in the extract** | New key in the `sales_tax` row's `values_json`: `sales_tax_status` (file 04 already uses that field name) | Existing `books_current_through` ("Jun 2025", with the "Up to" stripped), plus a new key `books_current_through_status` |
| **Allowed values** | `firm_files` or `client_self_files`. If the key is absent, it reads as `firm_files`, so today's rows import unchanged. `closed_or_not_client: true` still wins. | `confirmed` or `unconfirmed`. If the key is absent, today's behaviour applies. |
| **Source on the card** | Rene's answer for that card id (about 30 of the 55). `as_of` is the day she answered. | The list name on Marian's board. The 28 cards her update moved to "Up to Jun 2025" carry `unconfirmed`. `as_of` is the day of her update. |
| **Importer behaviour** | <ul><li>Creates no `sales_tax` engagement, places no hold, and writes no `filing_frequency`.</li><li>Writes the new `businesses.sales_tax_filed_by = 'client'` plus `sales_tax_filed_by_as_of`, in `qbo_paid_by`'s shape (enum `client`/`soto`/`unknown`, default `unknown`, as-of required when not unknown).</li><li>Writes the ledger row and the usual `engagement.service_fact_imported` audit row, with `sales_tax_status` and the card's frequency in its details.</li><li>Raises no task, because Rene has already answered.</li></ul> | <ul><li>Writes the value and its as-of as today, plus the new `businesses.books_current_through_unconfirmed = true` (boolean, default false; the `declared_by_import` pattern).</li><li>Never replaces a value that is not itself unconfirmed.</li><li>Nothing may read an unconfirmed value to compute anything: no catch-up scope, no billing periods, no close-cycle start. Every future reader filters on the flag.</li><li>Raises one task per affected business: type `trello_confirm_books_through`, owner is the `bookkeeper` role through `alertRecipientForRole` (which falls back to the CEO), `sourceId` is the card id, and the SOP is `marian-trello-confirm-books-through`.</li></ul> |
| **What Ops shows** | <ul><li>The business page's Service facts line reads "Sales tax: client files their own ST-1 (as of …)" instead of "no open sales-tax engagement says".</li><li>No sales-tax row appears on the Engagements card.</li><li>No ST-1 task and no invoice, ever.</li></ul> | <ul><li>"Books current through Jun 30, 2025 (as of …)", with an **unconfirmed** badge.</li><li>A Confirm / Correct control on that line for `bookkeeping.assigned.manage`. Confirming clears the flag (audited with who, when, before and after) and completes the task.</li><li>The task sits in Marian's My Tasks and in the owner rollup.</li></ul> |

## Why no engagement for a client who files their own ST-1

The billing hold answers "when does billing start", not "does the firm do this work". An active `sales_tax` engagement is a claim that the firm files the ST-1:

- The R33 recurring-obligations proposal turns every active `sales_tax` engagement into dated ST-1 tasks for Rene.
- A later hold lift would start invoicing a filing nobody performs, because the lift is made per engagement by a person reading "Sales tax filings".

Declining to create the engagement is the importer's existing reasoning for a closed card.

**Alternative (not proposed):** create the engagement as a non-billing record (on hold, billing hold placed, titled "Sales tax: client self-files"). Every reader of live `sales_tax` engagements would then have to learn to skip it: the frequency line, the one-active-per-line index, and any ST-1 job.

## Why one task per business, not one per board list

- **The fact belongs to each client.** Each client's own QBO file shows its last reconciled month.
- **A list-level task hides what is left.** It closes only when all 28 are checked, and until then the rollup cannot say which remain.
- **Reruns stay safe.** `createTask` dedupes on `(source_type, source_id)`, and 0114 allows one task of each kind per card, so a rerun creates nothing twice.
- **A wholesale mislabel is still quick to fix.** If Marian finds the list was simply mislabelled, she clears all 28 in one sitting from the same task list.

## Open questions for Brian

1. **Existing engagement.** A client may already have a live `sales_tax` engagement opened in SAOS while their card says `client_self_files`. Proposal: the importer changes nothing on the engagement and raises one task to Rene (`trello_sales_tax_filer_conflict`, with an SOP) so a person decides. Should the task go to Rene, or to you?
2. **Sole proprietors.** A card matched to a contact with no business has no business row to carry `sales_tax_filed_by`. Proposal: record it on the ledger and the audit row only, and count it in the run report. Should there be a contact-level home instead?
3. **Other sales-tax work.** Does the firm do any sales-tax work for self-filers, such as preparing the figures they file? The proposal assumes none. If it does, that is a different service line and a different ruling.
4. **Scope of `unconfirmed`.** Should every Marian-board row carry `unconfirmed`? The bundle's own README calls all bookkeeping facts stale as of 2026-07-01. The proposal marks only the 28.

## What building it would take (none started)

- One migration: the `sales_tax_filed_by` enum and its as-of column with a CHECK, and the `books_current_through_unconfirmed` boolean.
- The two importer branches.
- Two task types in `TASK_TYPE_SOPS`, with their SOP pages.
- The business-page line and the audited confirm control.
- Specs and sabotage entries for:
  - no engagement for `client_self_files`;
  - no overwrite of a confirmed value;
  - no reader of an unconfirmed value.
