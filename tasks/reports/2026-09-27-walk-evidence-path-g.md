# walk-evidence-path-g (2026-09-27)

Generated 2026-09-27T08:51:55.467Z by scripts/report-table.mjs from the log walk-g.log; 4 row(s).

The portal Documents page (R49): G1 reads the three kinds of row on a fixture client (a signed engagement letter and a delivered return filed through POST /documents at boot, the client upload made by the spec through the page control); G2 forces a render failure through the harness-only /harness/documents-crash switch and reads the sentence, the Reload control, the portal_page_error task and the Ops alert through the CEO API.

```sql
node scripts/walk-evidence.mjs G  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-27: 115 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| G1 | Documents lists a signed agreement copy, a delivered return and a client upload made through the page's own control, with no console error | phone + laptop | portal /documents at phone: a signed agreement copy (signed_authorizations), a delivered return (return_deliverable) and a client upload made through the page's file control, three rows, no console error | client (portal sign-in link) | apps/e2e/tests/portal-documents.spec.ts:71 | phone | passed | tap | yes |
| G1 | Documents lists a signed agreement copy, a delivered return and a client upload made through the page's own control, with no console error | phone + laptop | portal /documents at desk: a signed agreement copy (signed_authorizations), a delivered return (return_deliverable) and a client upload made through the page's file control, three rows, no console error | client (portal sign-in link) | apps/e2e/tests/portal-documents.spec.ts:71 | desk | passed | tap | yes |
| G2 | A page that fails to render shows one plain sentence and a Reload control, the firm gets a task and an Ops alert naming the route, and Reload shows the page again | phone + laptop | portal /documents at phone made to fail through the harness switch: the sentence, the Reload control, the portal_page_error task and the Ops alert read through the CEO API, then Reload shows the rows | client (portal sign-in link); ceo (API) | apps/e2e/tests/portal-documents.spec.ts:115 | phone | passed | tap | yes |
| G2 | A page that fails to render shows one plain sentence and a Reload control, the firm gets a task and an Ops alert naming the route, and Reload shows the page again | phone + laptop | portal /documents at desk made to fail through the harness switch: the sentence, the Reload control, the portal_page_error task and the Ops alert read through the CEO API, then Reload shows the rows | client (portal sign-in link); ceo (API) | apps/e2e/tests/portal-documents.spec.ts:115 | desk | passed | tap | yes |
