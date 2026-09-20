# dropbox-paths (2026-09-20)

Generated 2026-09-20T02:06:05.747Z by scripts/report-table.mjs from the log dropbox.log; 6 row(s).

The repository itself is inside the Dropbox root and carries Dropbox's sync attribute, so everything under it syncs; the Trello bundle synced from 2026-09-19 until it was moved out on 2026-09-20.

```sql
node scripts/dropbox-paths.mjs  (reads Dropbox's info.json for its roots and the NTFS streams on each SAOS path)
```

| path | under a Dropbox root | ignored marker | holds |
|---|---|---|---|
| C:\Users\brian\Dropbox\AI AGENT\saos | yes | no | the repository checkout: source, tasks/, tasks/reports (counts only), tasks/receipts (synthetic run logs), apps/e2e/.artifacts (synthetic screenshots and fixtures); no com.dropbox.attrs on package.json |
| C:\Users\brian\Dropbox\AI AGENT\saos\imports | yes | absent | removed 2026-09-20; held the Trello bundle (client names) from 2026-09-19 until the move |
| C:\Users\brian\saos-imports\trello_import | no | no | the Trello bundle now (client names); outside every Dropbox root |
| C:\Users\brian\Downloads\trello_import_bundle.zip | no | no | the zip Brian downloaded (client names) |
| C:\Users\brian\AppData\Local\Temp\claude | no | n/a | the session scratchpad: run logs and the harness run record (synthetic) |
| /opt/saos on the box (pg_dump copies saos_preflight, saos_trello_copy) | no | n/a | the only place a pg_dump copy of production ever lived; both dropped |
