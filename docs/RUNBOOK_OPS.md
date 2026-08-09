# SAOS Ops Runbook (M21)

Operational procedures for the SAOS stack. Audience: Brian (and whoever
operates the box later). Everything here assumes the repo checkout is the
working directory.

## Stacks on one box

| Stack   | Command                                   | Volumes prefix        |
|---------|-------------------------------------------|-----------------------|
| primary | `docker compose up -d`                    | `saos_`               |
| staging | `npm run staging:up` / `npm run staging:down` | `saos-staging_`   |
| drill   | created/destroyed by `scripts/restore-drill.sh` | `saos-restore-drill_` |

Staging is a full clone with host ports shifted +1000 (postgres 6432, MinIO
10000/10001, Docuseal 4002, ntfy 9093, Uptime Kuma 4006, Vaultwarden 9094,
Cal.com 4003). It shares **nothing** with the primary stack — separate
volumes, separate network. Point a staging API at it with a separate `.env`
(different `DATABASE_URL`/ports); never reuse the primary `DATABASE_URL`.

Image tags are pinned to the exact versions the stack was verified against.
Upgrading = bump the tag, `docker compose up -d`, run the test suite, commit.

## Uptime Kuma (monitoring)

UI: http://localhost:3006 (prod: status subdomain, internal only). Create the
admin account on first boot — store the credentials in Vaultwarden.

Canonical monitor list (add each as an HTTP(s)/TCP monitor, 60s interval,
3 retries):

| Monitor        | Type | Target (dev)                                  |
|----------------|------|-----------------------------------------------|
| API health     | HTTP | http://host.docker.internal:3001/health       |
| Client portal  | HTTP | http://host.docker.internal:3000              |
| Internal app   | HTTP | http://host.docker.internal:3005              |
| PostgreSQL     | TCP  | postgres:5432                                 |
| MinIO          | HTTP | http://minio:9000/minio/health/live           |
| Docuseal       | HTTP | http://docuseal:3000                          |
| ntfy           | HTTP | http://ntfy:80/v1/health                      |
| Vaultwarden    | HTTP | http://vaultwarden:80/alive                   |
| Cal.com        | HTTP | http://calcom:3000 (when booking profile runs)|

In production replace `host.docker.internal` targets with the public
subdomains so monitoring exercises the full TLS + proxy path. Add an ntfy
notification (server `http://ntfy:80`, topic `saos-alerts`) so downtime pushes
to Brian's and Jackson's phones through the same channel as app alerts.

## Vaultwarden (passwords)

UI: http://localhost:8094 (prod: vault subdomain, HTTPS via Caddy — WebAuthn
requires it). Signups are disabled; create accounts via the admin panel
(`VAULTWARDEN_ADMIN_TOKEN` in `.env`; empty token = admin panel disabled).

Launch task (WISP): move every funder-portal credential from the shared
Google Sheet into a Vaultwarden collection shared with Jackson, then purge
the Sheet. Also store here: `RESTIC_PASSWORD`, `APP_ENCRYPTION_KEY`,
Vaultwarden admin token, Uptime Kuma admin login, B2 keys, Stripe keys.

## Backups (encrypted, Backblaze B2)

`scripts/backup.sh` — nightly via cron on the server:

```
15 2 * * *  cd /opt/saos && ./scripts/backup.sh >> /var/log/saos-backup.log 2>&1
```

What it captures, per run:
1. `pg_dumpall` (every database: saos, docuseal-adjacent, calcom; test DBs excluded)
2. `mc mirror` of the four MinIO buckets (documents, returns, signed-docs, recordings)
3. tarballs of the Docuseal / Vaultwarden / Uptime Kuma / ntfy volumes
4. `manifest.tsv` — row/object counts the restore drill verifies against
5. restic snapshot → `RESTIC_REPOSITORY`, then retention prune
   (14 daily / 8 weekly / 12 monthly)

restic encrypts client-side with `RESTIC_PASSWORD` **before** upload — B2
only ever sees ciphertext. The password lives in Vaultwarden; losing it means
losing every backup. `BACKUP_STAGING_DIR` must sit outside any synced folder
(the script refuses paths inside the repo) and is wiped after each run.

The script writes `backups/status.json` (timestamps, snapshot id, counts —
no client data). The WISP export reads it, and the daily job raises an
urgent alert if it goes stale (>26h) once it exists.

Until Brian's B2 account lands (M23), point `RESTIC_REPOSITORY` at a local
directory on a separate disk — same tooling, same drill; switching to B2 is
an env change only.

## Restore drill (quarterly — WISP requirement)

```
DRILL_DIR=/var/lib/saos/drill RESTIC_REPOSITORY=... RESTIC_PASSWORD=... ./scripts/restore-drill.sh
```

The drill restores the **latest** snapshot into a brand-new stack
(`saos-restore-drill` project, fresh volumes, ports 7432/11000), replays the
pg dump and bucket mirror, then compares row counts and object counts against
the backup-time manifest. Exit 0 + `RESTORE DRILL PASSED` is the only
acceptable outcome; anything else means the backups are decorative — fix
before moving on.

After a passing drill, record it: **Admin → Settings →
`ops.last_restore_drill_at`** (ISO timestamp). The daily job opens a task for
Brian when the last recorded drill is older than
`ops.restore_drill_interval_days` (default 90).

## Launch wiring (post-deploy, once api.sotoaccounting.com serves)

- **Twilio number** (+1 708 300 0375; the 312 number ports in later — swap
  `TWILIO_PHONE_NUMBER`, nothing else): in the Twilio console, on the number,
  set Messaging webhook → `https://api.sotoaccounting.com/webhooks/twilio/sms`
  (HTTP POST) and Voice webhook → `…/webhooks/twilio/voice`. Both endpoints
  validate X-Twilio-Signature; the voice greeting script is the
  `twilio_voice_greeting` template (Admin → Templates). STOP texts revoke
  consent automatically (contact rollup + consent event, audited).
- **SES bounces/complaints**: SES console → verified identity
  `sotoaccounting.com` → Notifications → create one SNS topic for Bounce +
  Complaint → add an HTTPS subscription to
  `https://api.sotoaccounting.com/webhooks/ses-notifications`. The endpoint
  verifies SNS signatures and CONFIRMS THE SUBSCRIPTION ITSELF — no manual
  confirm. Bounces/complaints feed the Rene verification task + audit trail.
- **Zoom events**: Marketplace app → Feature → Event Subscriptions → endpoint
  `https://api.sotoaccounting.com/webhooks/zoom`, event `recording.completed`.
- **Stripe webhook**: dashboard → endpoint
  `https://api.sotoaccounting.com/webhooks/stripe`, event
  `checkout.session.completed`; paste the minted `whsec_` into the server's
  `/opt/saos/.env` (`STRIPE_WEBHOOK_SECRET`) and restart the api service.

## WISP security summary

**Admin → WISP** (or `GET /admin/wisp/security-summary`, `?format=markdown`
for the binder copy). Pulls live posture: staff MFA enrollment, session and
lockout policy, audit-log statistics, backup + restore-drill recency, vendor
list. Export it for the written WISP whenever the IRS checklist or an insurer
asks.

## Inbound attachments (email + MMS) — accept, never reject (2026-08-09)

MMS media is live: the Twilio SMS webhook ingests every media item → virus
scan → `saos-quarantine` bucket + `inbound_attachments` row on the client
thread → warm ack SMS with the portal link (transactional reply — allowed
without the standing consent flag because the client initiated the exchange).
Staff review in ops → Inbox: file (confirm tap → client folder, origin
audited), reassign, or discard. Infected verdicts hard-block filing.

Email attachments use the same pipeline via `POST /inbound-email/ingest`
(staff-auth). The inbound RECEIVER (Postal or SES receiving) is Phase 2 —
until it lands, email attachments forwarded by staff can be ingested through
the endpoint; block-and-nudge acks apply to both channels.

Virus scanning: ClamAV ships as compose profile `scan` (`CLAMAV_HOST=clamav`)
but is OFF by default — clamd wants ~1.3GB RSS and the box shares 16GB with
Whisper/Ollama. Until enabled, scans record `skipped` and the staff confirm
tap remains the gate. Enable after checking memory headroom:
`docker compose --profile scan up -d clamav` + set CLAMAV_HOST in .env.
