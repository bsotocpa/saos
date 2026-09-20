# checkout-files (2026-09-20)

Generated 2026-09-20T06:43:00.098Z by scripts/report-table.mjs from the log checkout-files.log; 21 row(s).

R19: file names only, never a value. Every row marked rotation list held a secret under the Dropbox root. Hard-coded absolute paths: none in scripts or the harness (the build output goes to LOCALAPPDATA/saos-e2e, the backup staging dir must be outside the repo); only historical run logs under tasks/receipts mention the old path.

```sql
node scripts/checkout-files.mjs  (git status --ignored on the Dropbox checkout, joined with Dropbox's info.json root)
```

| path | needed by the new checkout | lives now | under the Dropbox root | holds | rotation list |
|---|---|---|---|---|---|
| .claude/settings.local.json | optional: per-user permission allow-list for Claude Code | C:\Users\brian\Dropbox\AI AGENT\saos\.claude\settings.local.json | yes | tool permissions, no secrets | no |
| .env | yes: the dev API, harness and migrations read it | C:\Users\brian\Dropbox\AI AGENT\saos\.env | yes | dev database, MinIO, app encryption key, webhook secret (dev values) | yes: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, APP_ENCRYPTION_KEY, WEBHOOK_SECRET |
| .env.production | yes: deploy.sh ships it to the box | C:\Users\brian\Dropbox\AI AGENT\saos\.env.production | yes | every production secret: database, MinIO, app encryption key, Stripe live key and webhook secret, SMTP, Twilio, Zoom, Cal.com, Vaultwarden admin token, restic and B2, Hetzner API token | yes: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, APP_ENCRYPTION_KEY, WEBHOOK_SECRET, SMTP_PASS, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DOCUSEAL_API_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ZOOM_CLIENT_SECRET, ZOOM_SECRET_TOKEN, CALCOM_NEXTAUTH_SECRET, CALCOM_ENCRYPTION_KEY, VAULTWARDEN_ADMIN_TOKEN, RESTIC_REPOSITORY, RESTIC_PASSWORD, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, HETZNER_API_TOKEN |
| .green-runs/ | yes, or the next receipt run recreates it | C:\Users\brian\Dropbox\AI AGENT\saos\.green-runs | yes | receipt hashes of green root-suite runs, no secrets | no |
| apps/e2e/.artifacts/ | no: every harness run rebuilds it | C:\Users\brian\Dropbox\AI AGENT\saos\apps\e2e\.artifacts | yes | synthetic fixtures (synthetic TOTP secret and passwords), screenshots, the run record | no (synthetic) |
| backups/ | no | C:\Users\brian\Dropbox\AI AGENT\saos\backups | yes | empty or local backup staging; must stay outside any synced folder (backup.sh refuses a path inside the repo) | no |
| imports/ | no: removed 2026-09-20 | C:\Users\brian\Dropbox\AI AGENT\saos\imports | yes | held the Trello bundle (client names) 2026-09-19 to 2026-09-20 | no |
| migration-data/Attachments_001.zip | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\Attachments_001.zip | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/Data_001.zip | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\Data_001.zip | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/DishRoulette Kitchen - Grant Tracker .xlsx | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\DishRoulette Kitchen - Grant Tracker .xlsx | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/SOTO_Legal_Text_Package_FINAL_v3.docx | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\SOTO_Legal_Text_Package_FINAL_v3.docx | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/SOTO_Schedule_F_Attest_FINALFORM.docx | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\SOTO_Schedule_F_Attest_FINALFORM.docx | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/console.docuseal.com-api.docx | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\console.docuseal.com-api.docx | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/dubsado_clients.csv | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\dubsado_clients.csv | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/dubsado_invoices.csv | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\dubsado_invoices.csv | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/dubsado_projects_2026-07-06.csv | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\dubsado_projects_2026-07-06.csv | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/dubsado_transactions.csv | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\dubsado_transactions.csv | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/import-report-prod.md | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\import-report-prod.md | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/import-report.md | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\import-report.md | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
| migration-data/vaultwarden-import.json | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\vaultwarden-import.json | yes | a Vaultwarden export (12 items; the file says encrypted) | yes: every credential inside it (12 items) |
| migration-data/zoho-extracted/ | no: legacy import inputs, finished | C:\Users\brian\Dropbox\AI AGENT\saos\migration-data\zoho-extracted | yes | legacy client data (Dubsado, Zoho, grant tracker, legal text) | no |
