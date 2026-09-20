# migration-0104-rows (2026-09-19)

Generated 2026-09-20T00:07:45.081Z by scripts/report-table.mjs from production; 0 row(s).

The rows migration 0104 backfills on production (every return at or past filed gets its declared jurisdictions, derived from the business's state else the contact's, with acceptances copied from the existing columns). Listed by name before the deploy runs it; protected names, if any, would be listed first.

```sql
SELECT te.id, c.first_name || ' ' || c.last_name AS contact, b.name AS business, te.tax_year, te.return_type::text AS return_type, te.stage::text AS stage, COALESCE(b.state, c.state, '') AS state, te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_code, te.state_accepted_on::text AS state_accepted_on FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id JOIN contacts c ON c.id = e.contact_id LEFT JOIN businesses b ON b.id = e.business_id WHERE te.stage IN ('filed','completed','rejected') ORDER BY c.last_name, te.tax_year, te.id
```

| id | contact | business | tax_year | return_type | stage | state | federal_accepted_on | state_accepted_code | state_accepted_on |
|---|---|---|---|---|---|---|---|---|---|
