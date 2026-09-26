# day-two-deltas (2026-09-26)

Generated 2026-09-26T21:40:14.899Z by scripts/report-table.mjs from the log day-two-deltas.log; 204 row(s).

R58 (2026-09-26, report-only). A pg_dump copy of production (saos_r58_copy, at migration 0117, 864 contacts) in a throwaway container built from the deployed api image f3dc0827a73d with the current tree's importer mounted; NODE_ENV=test, MAIL_TRANSPORT=console with the mailer replaced by a counter, STRIPE_MODE=stub, PUSH_MODE=stub, Twilio/SMTP/Stripe keys blanked, automations as copied from production. Three snapshots; 56 metrics that were zero in all three (every tasks.on_imported_sales_tax_or_payroll.* row among them) are omitted. 'delta from jobs' = after the daily jobs minus after import. The mailer was called 0 times during the jobs; every job returned skipped=true except health_refresh (scored 363, redAlerts 0); job.failed rows: 0. Money columns are cents. Production was read only (audit rows 20900 -> 20901 during the run: one row from production's own live scheduler tick, not from this exercise); the copy was dropped and the box cleaned afterwards.

```sql
scripts/r58-runner.ts snapshot (three passes on saos_r58_copy: before the import, after trello-import.ts --rehearsal-preparer, after every DAILY_JOB in apps/api/src/jobs/daily.ts plus runHealthRefresh ran once) — each metric is one SQL count on the copy, or a field of executiveDashboard() / ownerRollup(ceo); merged by merge-deltas.mjs
```

| metric | before import | after import | after the daily jobs | delta from jobs | note |
|---|---|---|---|---|---|
| audit.new_since_by_action.contact.status_changed | — | 90 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.engagement.created | — | 106 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.engagement.service_fact_imported | — | 74 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.health.refresh_completed | — | — | 1 | +1 (jobs) | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.invoice.created | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.ops.dependencies_probed | — | — | 1 | +1 (jobs) | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.outbox.refused_in_import | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.signature.recorded_wet | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.tax_engagement.imported_at_stage | — | 44 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.new_since_by_action.tax_engagement.stage_changed | — | 7 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| audit.outbox_refused_in_import | 0 | 1 | 1 | 0 |  |
| audit.total | 20901 | 21225 | 21227 | 2 |  |
| automations.enabled.attachment_acks | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.efile_acknowledgment | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.payment_receipt | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.portal_upload_acks | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.refund_receipt | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.schedule_added_notice | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| automations.enabled.void_notice | 1 | 1 | 1 | 0 | toggle as copied from production (1 = armed); not a delta |
| contacts.by_source.dubsado | 426 | 426 | 426 | 0 |  |
| contacts.by_source.native | 2 | 2 | 2 | 0 |  |
| contacts.by_source.trello | — | 13 | 13 | 0 |  |
| contacts.by_source.zoho | 436 | 436 | 436 | 0 |  |
| contacts.health_band_updated_since | — | 102 | 375 | 273 | rows touched after the import / the jobs started |
| engagements.active_by_source_line.null/bookkeeping | 1 | 1 | 1 | 0 |  |
| engagements.active_by_source_line.null/tax | 3 | 4 | 4 | 0 |  |
| engagements.active_by_source_line.trello/payroll | — | 31 | 31 | 0 |  |
| engagements.active_by_source_line.trello/sales_tax | — | 30 | 30 | 0 |  |
| engagements.active_by_source_line.trello/tax | — | 44 | 44 | 0 |  |
| engagements.by_source_line.null/bookkeeping | 1 | 1 | 1 | 0 |  |
| engagements.by_source_line.null/tax | 11 | 12 | 12 | 0 |  |
| engagements.by_source_line.trello/payroll | — | 31 | 31 | 0 |  |
| engagements.by_source_line.trello/sales_tax | — | 30 | 30 | 0 |  |
| engagements.by_source_line.trello/tax | — | 44 | 44 | 0 |  |
| engagements.updated_since | — | 106 | 0 | -106 | rows touched after the import / the jobs started |
| exec.capacity.ceo.open_returns | 1 | 2 | 2 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.capacity.ceo.open_tasks | 5 | 25 | 25 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.capacity.comms_billing.open_tasks | 3 | 103 | 103 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.capacity.tax_preparer.open_returns | 0 | 34 | 34 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.capacity.tax_preparer.open_tasks | 500 | 508 | 508 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.capacity.va_entity.open_tasks | 4 | 4 | 4 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.dubsado_retirement.keys | 6 | 6 | 6 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.flows.efileRejectsOpen | 0 | 2 | 2 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.health.green | 1 | 1 | 1 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.documents_requested | — | 11 | 11 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.filed | 1 | 2 | 2 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.in_preparation | — | 7 | 7 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.internal_review | — | 3 | 3 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.pending_client_response | — | 6 | 6 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.ready_to_file | — | 5 | 5 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.by_stage.rejected | — | 2 | 2 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.total | 1 | 36 | 36 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.open_returns.value_cents | 1000 | 21000 | 21000 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.pipeline.accepted_value_cents | 80000 | 80000 | 80000 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.pipeline.by_stage.onboarding | 1 | 1 | 1 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.pipeline.win_rate_percent | 100 | 100 | 100 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.revenue.mtd_cents | 1000 | 1000 | 1000 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| exec.revenue.ytd_cents | 1000 | 1000 | 1000 | 0 | the executive view: executiveDashboard() as GET /dashboards/executive computes it |
| invoices.by_status.paid | 2 | 2 | 2 | 0 |  |
| invoices.by_status.refunded | 1 | 1 | 1 | 0 |  |
| invoices.by_status.sent | — | 1 | 1 | 0 |  |
| invoices.by_status.void | 2 | 2 | 2 | 0 |  |
| invoices.new_since_by_engagement_source_line.?/tax | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| invoices.new_since_by_status.sent | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| invoices.on_imported_contacts | 0 | 1 | 1 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| invoices.total | 5 | 6 | 6 | 0 |  |
| invoices.total_cents | 68000 | 88000 | 88000 | 0 |  |
| invoices.total_cents_by_status.paid | 26000 | 26000 | 26000 | 0 |  |
| invoices.total_cents_by_status.refunded | 2000 | 2000 | 2000 | 0 |  |
| invoices.total_cents_by_status.sent | — | 20000 | 20000 | 0 |  |
| invoices.total_cents_by_status.void | 40000 | 40000 | 40000 | 0 |  |
| meta.database | saos_r58_copy | saos_r58_copy | saos_r58_copy |  | run context |
| meta.label | before-import | after-import | after-jobs |  | run context |
| meta.today_chicago | 2026-09-26 | 2026-09-26 | 2026-09-26 |  | run context |
| notifications.by_recipient_role.ceo | 13 | 13 | 13 | 0 |  |
| notifications.by_recipient_role.comms_billing | 1 | 1 | 1 | 0 |  |
| notifications.by_recipient_role.ed_coo | 1 | 1 | 1 | 0 |  |
| notifications.by_recipient_role.tax_preparer | 1 | 2 | 2 | 0 |  |
| notifications.by_severity.critical | 6 | 6 | 6 | 0 |  |
| notifications.by_severity.info | 7 | 8 | 8 | 0 |  |
| notifications.by_severity.warning | 3 | 3 | 3 | 0 |  |
| notifications.by_type.container_unhealthy | 4 | 4 | 4 | 0 |  |
| notifications.by_type.dependency_unreachable | 2 | 2 | 2 | 0 |  |
| notifications.by_type.invoice_generated | 1 | 2 | 2 | 0 |  |
| notifications.by_type.irs_notice_unactioned | 2 | 2 | 2 | 0 |  |
| notifications.by_type.quote_accepted | 6 | 6 | 6 | 0 |  |
| notifications.by_type.restore_drill_due | 1 | 1 | 1 | 0 |  |
| notifications.new_since_by_recipient_role.tax_preparer | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| notifications.new_since_by_type.invoice_generated | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| notifications.new_since_on_imported_contacts | — | 1 | 0 | -1 | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| notifications.on_imported_contacts | 0 | 1 | 1 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| notifications.total | 16 | 17 | 17 | 0 |  |
| notifications.unread | 16 | 17 | 17 | 0 |  |
| outbox.by_effect.invoice.refund_receipt | 1 | 1 | 1 | 0 |  |
| outbox.by_effect.invoice.send | 4 | 4 | 4 | 0 |  |
| outbox.by_effect.invoice.void_notice | 2 | 2 | 2 | 0 |  |
| outbox.by_effect.packet.send_signature_link | 1 | 1 | 1 | 0 |  |
| outbox.by_effect_status.invoice.refund_receipt/sent | 1 | 1 | 1 | 0 |  |
| outbox.by_effect_status.invoice.send/sent | 4 | 4 | 4 | 0 |  |
| outbox.by_effect_status.invoice.void_notice/sent | 1 | 1 | 1 | 0 |  |
| outbox.by_effect_status.invoice.void_notice/suppressed | 1 | 1 | 1 | 0 |  |
| outbox.by_effect_status.packet.send_signature_link/sent | 1 | 1 | 1 | 0 |  |
| outbox.by_status.sent | 7 | 7 | 7 | 0 |  |
| outbox.by_status.suppressed | 1 | 1 | 1 | 0 |  |
| outbox.total | 8 | 8 | 8 | 0 |  |
| rollup.ceo.mine | 5 | 25 | 25 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.(none) | 1 | 1 | 1 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.container_unhealthy | 1 | 1 | 1 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.meeting_action_item | 1 | 1 | 1 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.quote_accepted | 2 | 2 | 2 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.trello_ar_worklist | — | 19 | 19 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_by_source_type.trello_books_review | — | 1 | 1 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| rollup.ceo.mine_start_onboarding | 2 | 2 | 2 | 0 | needs-you-today: ownerRollup() for the active CEO, as GET /tasks/rollup computes it |
| staff.active_by_role.bookkeeper | 1 | 1 | 1 | 0 |  |
| staff.active_by_role.ceo | 1 | 1 | 1 | 0 |  |
| staff.active_by_role.comms_billing | 1 | 1 | 1 | 0 |  |
| staff.active_by_role.ed_coo | 1 | 1 | 1 | 0 |  |
| staff.active_by_role.tax_preparer | 1 | 1 | 1 | 0 |  |
| staff.active_by_role.va_entity | 1 | 1 | 1 | 0 |  |
| tasks.by_owner_role.ceo | 19 | 39 | 39 | 0 |  |
| tasks.by_owner_role.comms_billing | 3 | 103 | 103 | 0 |  |
| tasks.by_owner_role.tax_preparer | 500 | 508 | 508 | 0 |  |
| tasks.by_owner_role.unassigned | 627 | 627 | 627 | 0 |  |
| tasks.by_owner_role.va_entity | 4 | 4 | 4 | 0 |  |
| tasks.by_source_type.(none) | 2 | 2 | 2 | 0 |  |
| tasks.by_source_type.client_session_scheduling | 1 | 1 | 1 | 0 |  |
| tasks.by_source_type.container_unhealthy | 4 | 4 | 4 | 0 |  |
| tasks.by_source_type.efile_ack_review | 500 | 500 | 500 | 0 |  |
| tasks.by_source_type.enrichment | 622 | 622 | 622 | 0 |  |
| tasks.by_source_type.irs_notice | 1 | 1 | 1 | 0 |  |
| tasks.by_source_type.meeting_action_item | 3 | 3 | 3 | 0 |  |
| tasks.by_source_type.onboarding_deposit | 2 | 2 | 2 | 0 |  |
| tasks.by_source_type.onboarding_docs | 2 | 2 | 2 | 0 |  |
| tasks.by_source_type.portal_access_blocked | 1 | 1 | 1 | 0 |  |
| tasks.by_source_type.quote_accepted | 8 | 8 | 8 | 0 |  |
| tasks.by_source_type.restore_drill | 1 | 1 | 1 | 0 |  |
| tasks.by_source_type.sos_verify | 4 | 4 | 4 | 0 |  |
| tasks.by_source_type.stripe_drift | 2 | 2 | 2 | 0 |  |
| tasks.by_source_type.trello_amendment | — | 8 | 8 | 0 |  |
| tasks.by_source_type.trello_ar_worklist | — | 114 | 114 | 0 |  |
| tasks.by_source_type.trello_books_review | — | 1 | 1 | 0 |  |
| tasks.by_source_type.trello_notify_client | — | 5 | 5 | 0 |  |
| tasks.by_status.cancelled | 6 | 6 | 6 | 0 |  |
| tasks.by_status.completed | 10 | 10 | 10 | 0 |  |
| tasks.by_status.not_started | 1137 | 1265 | 1265 | 0 |  |
| tasks.new_since_by_owner_role.ceo | — | 20 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_owner_role.comms_billing | — | 100 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_owner_role.tax_preparer | — | 8 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_source_type.trello_amendment | — | 8 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_source_type.trello_ar_worklist | — | 114 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_source_type.trello_books_review | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_by_source_type.trello_notify_client | — | 5 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_on_imported_by_service_line.(no_engagement) | — | 128 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_on_imported_by_source_type.trello_amendment | — | 8 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_on_imported_by_source_type.trello_ar_worklist | — | 114 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_on_imported_by_source_type.trello_books_review | — | 1 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.new_since_on_imported_by_source_type.trello_notify_client | — | 5 | — |  | created after the import started (after-import column) or after the jobs started (after-jobs column); blank where not measured |
| tasks.on_imported.by_source_type.trello_amendment | — | 8 | 8 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| tasks.on_imported.by_source_type.trello_ar_worklist | — | 114 | 114 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| tasks.on_imported.by_source_type.trello_books_review | — | 1 | 1 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| tasks.on_imported.by_source_type.trello_notify_client | — | 5 | 5 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| tasks.on_imported.total | 0 | 128 | 128 | 0 | rows whose contact or engagement carries source=trello, or a trello_card_id |
| tasks.open_by_owner_role.ceo | 5 | 25 | 25 | 0 |  |
| tasks.open_by_owner_role.comms_billing | 3 | 103 | 103 | 0 |  |
| tasks.open_by_owner_role.tax_preparer | 500 | 508 | 508 | 0 |  |
| tasks.open_by_owner_role.unassigned | 625 | 625 | 625 | 0 |  |
| tasks.open_by_owner_role.va_entity | 4 | 4 | 4 | 0 |  |
| tasks.open_by_source_type.(none) | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.client_session_scheduling | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.container_unhealthy | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.efile_ack_review | 500 | 500 | 500 | 0 |  |
| tasks.open_by_source_type.enrichment | 620 | 620 | 620 | 0 |  |
| tasks.open_by_source_type.irs_notice | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.meeting_action_item | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.onboarding_deposit | 2 | 2 | 2 | 0 |  |
| tasks.open_by_source_type.onboarding_docs | 2 | 2 | 2 | 0 |  |
| tasks.open_by_source_type.portal_access_blocked | 1 | 1 | 1 | 0 |  |
| tasks.open_by_source_type.quote_accepted | 3 | 3 | 3 | 0 |  |
| tasks.open_by_source_type.sos_verify | 4 | 4 | 4 | 0 |  |
| tasks.open_by_source_type.trello_amendment | — | 8 | 8 | 0 |  |
| tasks.open_by_source_type.trello_ar_worklist | — | 114 | 114 | 0 |  |
| tasks.open_by_source_type.trello_books_review | — | 1 | 1 | 0 |  |
| tasks.open_by_source_type.trello_notify_client | — | 5 | 5 | 0 |  |
| tasks.start_onboarding.by_owner_role.ceo | 7 | 7 | 7 | 0 | tasks titled 'Start onboarding: …' (quotes.ts:1307 creates them on quote acceptance) |
| tasks.start_onboarding.by_owner_role.comms_billing | 1 | 1 | 1 | 0 | tasks titled 'Start onboarding: …' (quotes.ts:1307 creates them on quote acceptance) |
| tasks.start_onboarding.total | 8 | 8 | 8 | 0 | tasks titled 'Start onboarding: …' (quotes.ts:1307 creates them on quote acceptance) |
| tasks.total | 1153 | 1281 | 1281 | 0 |  |
| tax_engagements.by_source.null | 3 | 4 | 4 | 0 |  |
| tax_engagements.by_source.trello | — | 44 | 44 | 0 |  |
| tax_engagements.imported_by_stage.completed | — | 10 | 10 | 0 |  |
| tax_engagements.imported_by_stage.documents_requested | — | 11 | 11 | 0 |  |
| tax_engagements.imported_by_stage.in_preparation | — | 7 | 7 | 0 |  |
| tax_engagements.imported_by_stage.internal_review | — | 3 | 3 | 0 |  |
| tax_engagements.imported_by_stage.pending_client_response | — | 6 | 6 | 0 |  |
| tax_engagements.imported_by_stage.ready_to_file | — | 5 | 5 | 0 |  |
| tax_engagements.imported_by_stage.rejected | — | 2 | 2 | 0 |  |
| tax_engagements.stage_changed_since_by_stage.completed | — | 10 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.documents_requested | — | 11 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.filed | — | 1 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.in_preparation | — | 7 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.internal_review | — | 3 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.pending_client_response | — | 6 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.ready_to_file | — | 5 | — |  | rows touched after the import / the jobs started |
| tax_engagements.stage_changed_since_by_stage.rejected | — | 2 | — |  | rows touched after the import / the jobs started |
