# checkout-files-after-switch (2026-09-20)

Generated 2026-09-20T21:37:59.785Z by scripts/report-table.mjs from the log checkout-files-after.log; 4 row(s).

R19 after the switch: every ignored file the checkout needs, and none of them under a Dropbox root. migration-data moved to C:\Users\brian\saos-archive\migration-data (outside Dropbox and outside the repo); the Vaultwarden export deleted, not archived.

```sql
node scripts/checkout-files.mjs  (git status --ignored on the new checkout C:\Users\brian\saos, joined with Dropbox's info.json root)
```

| path | needed by the new checkout | lives now | under the Dropbox root | holds | rotation list |
|---|---|---|---|---|---|
| .claude/settings.local.json | optional: per-user permission allow-list for Claude Code | C:\Users\brian\saos\.claude\settings.local.json | no | tool permissions, no secrets | no |
| .env | yes: the dev API, harness and migrations read it | C:\Users\brian\saos\.env | no | dev database, MinIO, app encryption key, webhook secret (dev values) | yes: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, APP_ENCRYPTION_KEY, WEBHOOK_SECRET |
| .env.production | yes: deploy.sh ships it to the box | C:\Users\brian\saos\.env.production | no | every production secret: database, MinIO, app encryption key, Stripe live key and webhook secret, SMTP, Twilio, Zoom, Cal.com, Vaultwarden admin token, restic and B2, Hetzner API token | yes: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, APP_ENCRYPTION_KEY, WEBHOOK_SECRET, SMTP_PASS, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ZOOM_CLIENT_SECRET, ZOOM_SECRET_TOKEN, CALCOM_NEXTAUTH_SECRET, CALCOM_ENCRYPTION_KEY, VAULTWARDEN_ADMIN_TOKEN, RESTIC_REPOSITORY, RESTIC_PASSWORD, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, HETZNER_API_TOKEN |
| .green-runs/ | yes, or the next receipt run recreates it | C:\Users\brian\saos\.green-runs | no | receipt hashes of green root-suite runs, no secrets | no |
