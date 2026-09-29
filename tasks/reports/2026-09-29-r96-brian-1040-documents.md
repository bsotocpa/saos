# r96-brian-1040-documents (2026-09-29)

Generated 2026-09-29T09:45:32.785Z by scripts/report-table.mjs from production; 2 row(s).

R96: Brian's contact's live documents, by whether each counts as a checklist item; counts only. Matching is Brian's to do from the Documents card or the portal.

```sql
SELECT CASE WHEN d.tax_engagement_id = te.id THEN 'filed to the 2025 1040' WHEN d.tax_engagement_id IS NULL THEN 'no return named' ELSE 'another return' END AS document_scope, d.uploaded_by_type::text AS uploaded_by, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_request_items i JOIN document_requests r ON r.id = i.request_id WHERE i.document_id = d.id AND r.source = 'checklist'))::int AS under_a_checklist_item, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM document_request_items i JOIN document_requests r ON r.id = i.request_id WHERE i.document_id = d.id AND r.source = 'checklist'))::int AS unmatched FROM documents d CROSS JOIN (SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = '250b24a3-7335-444d-9105-c8a00baa72fc' AND te.return_type = '1040' AND te.tax_year = 2025) te WHERE d.contact_id = '250b24a3-7335-444d-9105-c8a00baa72fc' AND d.archived_at IS NULL AND d.withdrawn_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2
```

| document_scope | uploaded_by | under_a_checklist_item | unmatched |
|---|---|---|---|
| another return | staff | 0 | 9 |
| no return named | client | 0 | 3 |
