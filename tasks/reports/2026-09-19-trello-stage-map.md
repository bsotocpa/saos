# trello-stage-map (2026-09-19)

Generated 2026-09-19T23:46:43.747Z by scripts/report-table.mjs from the log stage-map.log; 16 row(s).

Item 12. Targets are TAX_STAGES in apps/api/src/modules/tax/pipeline.ts (intake_started, scheduled, documents_requested, pending_client_response, in_preparation, internal_review, client_review, ready_to_file, filed, rejected, completed, on_hold, withdrawn) and engagement_status (draft, active, on_hold, completed, withdrawn). GAP means no equivalent exists and the value is NOT forced into the nearest enum member. Four gaps, and each is a gap for a different reason: an amendment has no stage and no 1040X in the return_type enum (it exists only as the price-book item IND_AMENDMENT_1040X); 'blocked on business return/financials' and 'awaiting year-end financials' are task_dependencies shapes (blocked-by), not return stages; 'awaiting CPA review of financials' is Brian reviewing the BOOKS (close_cycles.statements_ready_at), which internal_review - the review of the return - is not. 'paper filed' is PARTIAL rather than GAP and it is the sharpest finding here: the stage and the paper-lane columns exist, but no acceptance can ever be recorded for a paper return, so completion is a bare hand move. See the R2 answer in the report. Two caveats on the targets. (1) apps/api/src/modules/tax/pipeline.ts is UNCOMMITTED-MODIFIED in the working tree (737 lines, the R2 declared-jurisdictions work) while the code running in saos-api-1 is the shipped 562-line version; TAX_STAGES and TRANSITIONS are identical in both, and neither version gates filed -> completed on acceptance. (2) 'ready to prepare' and 'awaiting signature' map to a real stage but not to a Trello-equivalent one: SAOS has no queued-for-preparation stage between documents_requested and in_preparation, and no separate awaiting-signature stage, because the 8879 gate sits on entering filed.

```sql
DATABASE_URL=postgresql://saos:***@postgres:5432/saos_trello_copy node --experimental-strip-types scripts/trello-match.ts --dir /trello_import   (the STAGE_MAP section of apps/api/scripts/trello-match.ts; counts are the script's own tally of proposed_stage_plain across files 01 and 02, targets are TAX_STAGES from apps/api/src/modules/tax/pipeline.ts)
```

| proposed_stage_plain | file 01 | file 02 | total | SAOS stage | mapping |
|---|---|---|---|---|---|
| ready to prepare | 14 | 0 | 14 | in_preparation | maps; entering in_preparation needs estimate_locked_at (gate 2), so an import lands these behind a lock that Trello never held |
| awaiting client response | 14 | 0 | 14 | pending_client_response | maps exactly; waiting_on = client |
| awaiting documents | 13 | 0 | 13 | documents_requested | maps exactly |
| awaiting documents (exempt org) | 3 | 0 | 3 | documents_requested | maps exactly; the exempt-org part is return_type 990/990ez, not a stage |
| awaiting signature | 13 | 0 | 13 | ready_to_file | maps; the 8879 gate sits on entering filed, so "awaiting signature" IS ready_to_file |
| prepared, not yet sent for signature | 4 | 0 | 4 | internal_review | maps |
| extended, awaiting documents | 3 | 0 | 3 | documents_requested | maps; Extended is tax_engagements.extension_filed, a parallel flag, never a stage |
| e-file rejected | 2 | 0 | 2 | rejected | maps exactly; a reject also carries a perfection_deadline SAOS computes, which Trello has no field for |
| prior-year return in progress | 1 | 0 | 1 | in_preparation | maps; the filing lane is derived from the year (filingLane), never carried over from Trello |
| accepted, client not yet notified | 6 | 5 | 11 | completed | maps; acceptance is recorded per jurisdiction by the ATX acknowledgment ingest, and "not yet notified" is the efile_acknowledgment automation, not a stage |
| accepted, balance open | 0 | 105 | 105 | completed | maps; "balance open" is an invoice status (invoices.status), not a stage |
| paper filed | 7 | 4 | 11 | filed | PARTIAL: filed exists, and so do filing_lane/paper_mailed_on/certified_tracking, but no acceptance can ever be RECORDED for a paper return (ack rows come only from the ATX report upload), so completion is a bare hand move with nothing accepted — see the R2 answer in the report |
| amendment in progress | 8 | 0 | 8 | GAP | no amendment stage and no 1040X in the return_type enum; amendments exist only as the price-book item IND_AMENDMENT_1040X |
| blocked on business return/financials | 7 | 0 | 7 | GAP | no blocked stage; the dependency is a task_dependencies row ("blocked by"), so this is a task shape, not a stage |
| awaiting year-end financials (bookkeeping dependency) | 4 | 0 | 4 | GAP | same shape: documents_requested is close but the wait is on a close_cycles period, which is a task dependency, not a return stage |
| awaiting CPA review of financials | 1 | 0 | 1 | GAP | internal_review is the REVIEW OF THE RETURN; this is Brian reviewing the books (close_cycles.statements_ready_at). Not the same thing, not forced |
