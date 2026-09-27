# return-delivered-as-deployed (2026-09-27)

Generated 2026-09-27T10:10:41.081Z by scripts/report-table.mjs from production; 11 row(s).

R48 confirm: the return-delivered notice as it stands on production (the templates row) and its automation. The ruled sentences are the ones from the R48 ruling; the seed's ruled copy correction put them there on 2026-09-27 (audit template.updated, ruling R48).

```sql
SELECT item, value FROM (VALUES (1, 'automation return_delivered enabled', (SELECT enabled::text FROM automations WHERE key='return_delivered')), (2, 'template version', (SELECT version::text FROM templates WHERE key='return_delivered')), (3, 'English body carries "We''ll be in touch about signing next."', (SELECT (position('We’ll be in touch about signing next.' in body_en) > 0)::text FROM templates WHERE key='return_delivered')), (4, 'Spanish body carries "Luego le escribiremos sobre la firma."', (SELECT (position('Luego le escribiremos sobre la firma.' in body_es) > 0)::text FROM templates WHERE key='return_delivered')), (5, 'the old English sentence remains', (SELECT (position('We’ll follow up on the e-file authorization next.' in body_en) > 0)::text FROM templates WHERE key='return_delivered')), (6, 'the old Spanish sentence remains', (SELECT (position('Luego le enviaremos la autorización de presentación electrónica.' in body_es) > 0)::text FROM templates WHERE key='return_delivered')), (7, 'Spanish approved for sending (needs_es_review false)', (SELECT (NOT needs_es_review)::text FROM templates WHERE key='return_delivered')), (8, 'English subject', (SELECT subject_en FROM templates WHERE key='return_delivered')), (9, 'English body, as deployed', (SELECT body_en FROM templates WHERE key='return_delivered')), (10, 'Spanish subject', (SELECT subject_es FROM templates WHERE key='return_delivered')), (11, 'Spanish body, as deployed', (SELECT body_es FROM templates WHERE key='return_delivered'))) t(n, item, value) ORDER BY n
```

| item | value |
|---|---|
| automation return_delivered enabled | true |
| template version | 2 |
| English body carries "We'll be in touch about signing next." | true |
| Spanish body carries "Luego le escribiremos sobre la firma." | true |
| the old English sentence remains | false |
| the old Spanish sentence remains | false |
| Spanish approved for sending (needs_es_review false) | true |
| English subject | Your {{tax_year}} tax return is ready to review |
| English body, as deployed | Hi {{first_name}},  Your {{tax_year}} tax return is ready and waiting in your portal under “My Returns”:  {{portal_link}}  Review it at your convenience — it’s available for download any time. We’ll be in touch about signing next.  — Soto Accounting |
| Spanish subject | Su declaración de impuestos {{tax_year}} está lista para revisar |
| Spanish body, as deployed | Hola {{first_name}}:  Su declaración de impuestos {{tax_year}} está lista en su portal, en “Mis Declaraciones”:  {{portal_link}}  Revísela con calma — puede descargarla en cualquier momento. Luego le escribiremos sobre la firma.  — Soto Accounting |
