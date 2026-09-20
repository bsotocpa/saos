# status-role-grants (2026-09-19)

Generated 2026-09-20T01:21:54.359Z by scripts/report-table.mjs from production; 2 row(s).

R3 and R4 on the box after the deploy's seed: efile.manage on tax_preparer, businesses.write on va_entity.

```sql
SELECT r.key AS role, rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission IN ('efile.manage','businesses.write') ORDER BY 2, 1
```

| role | permission |
|---|---|
| va_entity | businesses.write |
| tax_preparer | efile.manage |
