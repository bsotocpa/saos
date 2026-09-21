# Secret rotation runbook (R30, 2026-09-20)

Ruling R30 (Brian, 2026-09-20): rotation is deferred until **2026-10-12**. This file is the
procedure; nothing was rotated to write it. The order below is Brian's order. No secret value
appears in this file, in any command's output, or in any log; variable NAMES only.

## The one procedure, applied ten times

1. **Brian creates the new value in the vendor console** and types it himself into
   `C:\Users\brian\saos\.env.production`, on the line whose name is given below. Nobody else
   sees the value; no script generates a vendor secret.
2. **I deploy**: `bash scripts/deploy.sh` from `C:\Users\brian\saos`. It refuses under a sync root
   (`scripts/check-sync-root.mjs`), refuses without a green receipt on this exact tree
   (`scripts/green-run.mjs require`), ships `.env.production` to `/opt/saos/.env.incoming` and
   merges it with `scripts/merge-env.sh` (deploy.sh lines 43-45), then builds, preflights the
   migrations, migrates, swaps containers with `up -d`, and seeds.
3. **I run the named verification** for that secret (each one below is an existing script or a
   read-only command; where none exists it says so and proposes one).
4. **Brian revokes the old value** in the vendor console. The runbook says what and where.

### What the merge does with what Brian typed (scripts/merge-env.sh, read 2026-09-20)

| Local `.env.production` line | Server `/opt/saos/.env` | Result |
|---|---|---|
| non-blank | anything | **local wins** (a deliberate rotation ships) — merge-env.sh lines 17-19, 97-99 |
| blank | non-blank | **server kept** (a blank can never erase a secret) — lines 92-96 |
| absent | non-blank | server value appended under "Preserved from the server" — lines 103-114 |
| non-blank | non-blank **and the name is in `/opt/saos/.env.server-managed`** | **server wins, the local value is ignored** — lines 25-37, 86-91 |

The server-managed list on the box today (read 2026-09-20, names only): `STRIPE_MODE`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_ENDPOINT_ID`. **Typing a Stripe
value into `.env.production` does nothing**; Stripe has its own door (item 4).

Which container sees a change after `up -d`: `saos-api-1` reads every key through `env_file: .env`
(docker-compose.yml line 200, docker-compose.prod.yml line 33); `postgres`, `minio`, `minio-init`,
`vaultwarden`, `calcom`, `calcom-db-init` get the specific keys interpolated into their
`environment:` blocks (docker-compose.yml lines 22, 40-41, 69-70, 139, 160-183); compose recreates
a container whose environment changed. `scripts/backup.sh` (line 36-49) and
`scripts/container-health.sh` (line 19) re-read `/opt/saos/.env` on every cron run, so they follow
the merge with no restart. Crontab on the box (read 2026-09-20): backup daily 02:15 UTC,
container-health every 5 minutes.

Containers on the box (read 2026-09-20): saos-api-1, saos-portal-1, saos-internal-1, saos-caddy-1,
saos-postgres-1, saos-minio-1, saos-clamav-1, saos-calcom-1, saos-uptime-kuma-1, saos-whisper-1,
saos-vaultwarden-1, saos-ntfy-1, saos-ollama-1 (+ the two one-shot init containers). There is no
Docuseal container.

---

## 1. Backblaze B2 application key

- **Names**: `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`. Read by scripts/backup.sh line 16 (doc) and 128
  (passed to the restic container), scripts/restore-drill.sh lines 11 and 39. Nothing in
  apps/api reads them. Both non-blank on the box.
- **Consumed by**: the `restic/restic:0.19.1` container that backup.sh runs on the host (cron,
  02:15 UTC) against repository `b2:saos-backups:prod` (the box's last backup log; the
  `.env.example` line 121 name `soto-saos-backups` is stale).
- **Brian, vendor console**: Backblaze → App Keys → Add a New Application Key, scoped to bucket
  `saos-backups`, read and write (restic lists, reads, writes and deletes files during `forget
  --prune`; confirm the capability set against the restic B2 backend docs when creating it — not
  verified here). Type the keyID into `B2_ACCOUNT_ID` and the applicationKey into
  `B2_ACCOUNT_KEY`.
- **Deploy**: as above. No container restart matters; the cron reads the file.
- **Verification (existing)**: on the box, `cd /opt/saos && ENV_FILE=/opt/saos/.env bash
  scripts/backup.sh` — a full backup under the new key; it ends with `backup: OK — snapshot <id>
  (b2 repo, Ns)` and rewrites `/opt/saos/backups/status.json` (`last_backup_at` moves). Then a
  read-only listing using backup.sh's own container pattern (line 128), env loaded by name:
  `docker run --rm -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY
  restic/restic:0.19.1 snapshots --latest 1`.
- **Brian revokes**: Backblaze → App Keys → delete the old key. Update the Vaultwarden entry
  (RUNBOOK_OPS.md line 56 says B2 keys live there).

## 2. restic repository password

- **Name**: `RESTIC_PASSWORD`. Read by scripts/backup.sh lines 65 and 128, scripts/restore-drill.sh
  lines 30 and 39-43. Generated locally, not by a vendor (`scripts/gen-prod-secrets.mjs` line 24
  fills an EMPTY line only; for a rotation Brian generates one in Vaultwarden and types it).
- **The actual mechanism**: a restic repository is encrypted with a master key; each password
  only *wraps* that master key, and a repository can hold several wrapped keys at once. So the
  password rotates **without re-initialising or re-encrypting** any data: `restic key add` writes
  a second key file wrapped with the new password; `restic key remove <id>` deletes the old one.
  Every command needs a password that currently unlocks the repository.
- **Order (this one has three moves, not two)**:
  1. Brian types the new value into `RESTIC_PASSWORD` locally **and** into a file on the box that
     only root reads (for example `install -m 600 /dev/null /root/restic-new.pw`, then paste). I
     run, with the OLD password still in `/opt/saos/.env`: `docker run --rm -e RESTIC_REPOSITORY
     -e RESTIC_PASSWORD -e B2_ACCOUNT_ID -e B2_ACCOUNT_KEY -v /root/restic-new.pw:/new.pw:ro
     restic/restic:0.19.1 key add --new-password-file /new.pw`, then `… key list` (prints key ids
     and hostnames, never passwords). The exact flag name is per restic's `key add --help` in
     0.19.1; confirm at run time.
  2. `bash scripts/deploy.sh` ships the new value. `shred -u /root/restic-new.pw`.
  3. **Verification (existing)**: `ENV_FILE=/opt/saos/.env bash scripts/backup.sh` completes a
     snapshot under the new password; `… restic/restic:0.19.1 snapshots --latest 1` lists it.
  4. **Brian revokes**: I run `… key remove <old key id>` (the id from `key list`; the new
     password is now the one in the env). Brian replaces the Vaultwarden entry. Note for
     `scripts/restore-drill.sh`: any snapshot, old or new, opens with the new password from now
     on; there is no old-password restore to keep.

## 3. Hetzner Cloud API token

- **Name**: `HETZNER_API_TOKEN`. Read only by scripts/provision-hetzner.mjs lines 24-30 (env or
  `.env.production`) and line 163 (written back). **Nothing on the box reads it**; the copy in
  `/opt/saos/.env` (non-blank today) is unused and could be blanked — report-only observation.
- **Consumed by**: the laptop, `node scripts/provision-hetzner.mjs`, calls
  `https://api.hetzner.cloud/v1` with `Authorization: Bearer` (lines 34-38).
- **Brian, vendor console**: Hetzner Cloud Console → project → Security → API tokens → Generate
  API token, Read & Write (provisioning creates the firewall/server; a read token cannot).
- **Deploy**: `deploy.sh` ships it, though nothing consumes it there.
- **Verification**: no script does a pure read. **Proposed**, from the laptop, the same call
  provision-hetzner.mjs makes first (line 52, `GET /servers`) without its write steps:
  `node -e "import('node:fs').then(async fs=>{const t=fs.readFileSync('.env.production','utf8').match(/^HETZNER_API_TOKEN=(\S+)$/m)[1];const r=await fetch('https://api.hetzner.cloud/v1/servers',{headers:{Authorization:'Bearer '+t}});const j=await r.json();console.log(r.status, (j.servers||[]).map(s=>s.name))})"`
  — expected `200 [ 'saos-prod' ]`; the token never prints.
- **Brian revokes**: Hetzner Console → Security → API tokens → delete the old token.

## 4. Stripe secret key and webhook signing secret

- **Names**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, plus `STRIPE_WEBHOOK_ENDPOINT_ID`
  (apps/api/src/config.ts lines 71-74). Read by apps/api/src/modules/billing/stripe.ts lines 337-338
  (key) and 388 (`constructEvent` with the signing secret). All three are **server-managed**
  (`/opt/saos/.env.server-managed`, written by the installer at scripts/install-stripe-live.sh
  lines 157-164). `STRIPE_MODE=live` on the box.
- **Consumed by**: saos-api-1 only.
- **This item does not use `.env.production`**. The door is on the box:
  `bash /opt/saos/scripts/install-stripe-live.sh`. It reads the key with `read -rs` (never echoed,
  never in `ps` — curl auth via `--config` stdin, lines 85-91), checks `livemode=true` and
  `charges_enabled` read-only (lines 93-123), asks for a typed confirmation phrase, writes the
  three keys with `set_env` (lines 144-149), restarts the api (line 171) and runs the
  verification itself (step 7, lines 244-251).
- **Brian, vendor console**: Stripe Dashboard (test mode OFF) → Developers → API keys → Secret key
  → **Roll key**, choosing the expiry window for the old key (Stripe offers now / 1h / 24h / 7d).
  For the signing secret: Developers → Webhooks → the `api.sotoaccounting.com/webhooks/stripe`
  endpoint → **Roll secret** (Stripe keeps the old one valid for the delay chosen). Or leave the
  endpoint alone: when the stored secret still verifies, the installer keeps it
  (`ENDPOINT_ACTION=updated`, scripts/lib/stripe-endpoint.sh line 75); when it no longer verifies,
  the installer deletes and recreates the endpoint and captures the new secret (lines 46, 83-84,
  `recreated`). Brian pastes the new key at the installer prompt.
- **Verification (existing)**: `scripts/verify-stripe-live.mjs`, run inside saos-api-1 by the
  installer: adapter mode `live`; `stripe.accounts.retrieve()` charges_enabled; `balance.retrieve()`
  livemode=true; a locally signed synthetic event **accepted** and a forged signature **refused**
  in-process and over `https://api.sotoaccounting.com/webhooks/stripe` (lines 40-125). No charge,
  PaymentIntent or customer is created (line 19). `scripts/verify-webhook-secret.mjs` is the
  signing-secret check on its own (genuine 200 / forged 401). Afterwards
  `scripts/stripe-webhook-events.mjs` (docker cp + exec, header lines 12-15) prints the enabled
  events, which must be the five in `REQUIRED_EVENTS`.
- **Brian revokes**: the rolled key expires on the window he chose; a rolled signing secret
  likewise. If the installer *recreated* the endpoint, the old endpoint is already deleted (line
  83). Confirm in Dashboard → Webhooks that exactly one endpoint carries the URL
  (stripe-webhook-events.mjs warns when two do).

## 5. Vaultwarden admin token

- **Name**: `VAULTWARDEN_ADMIN_TOKEN` → container env `ADMIN_TOKEN` (docker-compose.yml line 139;
  empty disables the admin panel). No app code reads it. Non-blank on the box.
- **Consumed by**: saos-vaultwarden-1 (vault.sotoaccounting.com, deploy/Caddyfile).
- **Brian, vendor console**: none — it is self-hosted. Brian generates one (`.env.example` line
  112: `openssl rand -base64 48`, or Vaultwarden's generator) and types it. If he prefers an
  Argon2 PHC hash (`vaultwarden hash`), every `$` must be written `$$` in `.env` for compose
  interpolation; a plain random string avoids that.
- **Deploy**: `up -d` recreates the vaultwarden container (its environment changed). Vault data
  in `/mnt/saos-data/vaultwarden` is untouched; user vaults never depend on this token.
- **Verification**: liveness exists (Uptime Kuma target `http://vaultwarden:80/alive`,
  RUNBOOK_OPS.md line 40): from the api container,
  `docker exec saos-api-1 node -e "fetch('http://vaultwarden:80/alive').then(r=>console.log(r.status))"`
  → 200. The token itself: **no script verifies it today; proposed**: Brian signs in at
  `https://vault.sotoaccounting.com/admin` with the new token (his hand, his browser — a wrong
  token is refused on that page). An automated check would POST the token as form field `token`
  to `/admin` and expect a 200 with a session cookie; not written, because it would put the value
  on a command line.
- **Brian revokes**: nothing external; the old value stops working when the container is
  recreated. Update the Vaultwarden entry that holds it (RUNBOOK_OPS.md line 56).

## 6. SMTP (Amazon SES relay)

- **Names**: `SMTP_USER`, `SMTP_PASS` (with `SMTP_HOST`, `SMTP_PORT`). apps/api/src/config.ts lines
  37-40; production refuses `smtp` without all three (lines 121-123). Used by
  apps/api/src/mailer.ts lines 39-44 (`nodemailer.createTransport`, auth user/pass).
- **Consumed by**: saos-api-1, for every outbound email (portal magic links, ladders, notices).
- **Brian, vendor console**: SES credentials are an IAM access key; the SMTP password is
  **derived** from the secret access key (apps/api/scripts/wire-ses.ts lines 38-43). Two ways,
  either is fine: (a) AWS IAM → the SES SMTP user → Security credentials → Create access key →
  download `accessKeys.csv`, then Brian runs `node apps/api/scripts/wire-ses.ts <csv>` on his own
  laptop — it probes the regions with `transporter.verify()` (line 55, EHLO/STARTTLS/AUTH, no
  mail) and patches `SMTP_HOST/PORT/USER/PASS` in `.env.production` (lines 90-93), printing no
  secret; or (b) SES console → SMTP settings → Create SMTP credentials, which shows the SMTP
  username and password to type by hand into `SMTP_USER` and `SMTP_PASS`.
- **Deploy**: `up -d` recreates the api.
- **Verification**: the laptop-side one exists (wire-ses.ts's `verify()` probe; optional
  `--send-test=<Brian's firm address>` sends one email to Brian). On the box **no verification
  exists today; proposed**, run inside the api container with values by name, printing only a
  word: `docker exec saos-api-1 node -e "const n=require('nodemailer');n.createTransport({host:process.env.SMTP_HOST,port:+process.env.SMTP_PORT,secure:false,requireTLS:true,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}}).verify().then(()=>console.log('AUTH OK'),e=>{console.log('AUTH FAILED');process.exit(1)})"`.
  Then a real send Brian can see: a portal magic link to his own test client from Ops.
- **Brian revokes**: IAM → the user → Security credentials → deactivate the old access key, watch
  for one day of sends, then delete it.

## 7. Twilio

- **Names**: `TWILIO_ACCOUNT_SID` (does not change), `TWILIO_AUTH_TOKEN` (rotates),
  `TWILIO_PHONE_NUMBER` (unchanged). apps/api/src/config.ts lines 95-97. Used by
  apps/api/src/modules/comms/send-sms.ts lines 57-58 and 84-88 (Basic auth to
  `api.twilio.com`), comms/routes.ts line 40 (inbound `X-Twilio-Signature` validation uses the
  token) and 163-164 (MMS media fetch).
- **Consumed by**: saos-api-1, outbound SMS and every inbound SMS/voice webhook.
- **Brian, vendor console**: Twilio Console → Account → API keys & tokens → Auth Tokens →
  **Request a secondary token**. Type the secondary into `TWILIO_AUTH_TOKEN`. (Both tokens are
  valid until he promotes.)
- **Deploy**: `up -d` recreates the api.
- **Verification**: **no script exists today; proposed** (read-only account fetch from inside the
  api container, values by name): `docker exec saos-api-1 node -e "fetch('https://api.twilio.com/2010-04-01/Accounts/'+process.env.TWILIO_ACCOUNT_SID+'.json',{headers:{Authorization:'Basic '+Buffer.from(process.env.TWILIO_ACCOUNT_SID+':'+process.env.TWILIO_AUTH_TOKEN).toString('base64')}}).then(r=>console.log(r.status))"`
  → 200. Then the inbound path, which is the one that breaks silently: Brian texts
  +1 708 300 0375 from his phone; the thread appears in Ops → Inbox (signature validated with the
  new token at comms/routes.ts lines 46-51; a stale token answers 401 in the api log).
- **Brian revokes**: Twilio Console → **Promote secondary to primary**; Twilio retires the old
  primary at that moment (per the console flow; not verified here). The SID stays.

## 8. PostgreSQL

- **Names**: `POSTGRES_PASSWORD` **and** `DATABASE_URL` (the password is embedded in the URL;
  scripts/gen-prod-secrets.mjs lines 36-40 keep them in step — Brian types both lines).
- **Consumed by**: `postgres` container env (docker-compose.yml line 22 — **only at first
  initialisation**; changing the env does NOT change the role's password on an existing data
  directory), saos-api-1 (`DATABASE_URL`, config.ts line 18), calcom and calcom-db-init
  (lines 160-181 build their URLs from `POSTGRES_PASSWORD`), scripts/preflight-migrate.sh line 14,
  the migration and seed runs in deploy.sh. backup.sh uses `compose exec` (local trust; no
  password).
- **Order so nothing locks out**:
  1. Brian types the new value into both lines locally.
  2. I ship the env **only** (deploy.sh step 1 by hand): `scp .env.production
     root@…:/opt/saos/.env.incoming` and `sh scripts/merge-env.sh .env.incoming .env`. The
     running api still holds its pooled connections under the old password; nothing changes yet.
  3. I change the role, reading the new value from the merged file by name and piping it on stdin
     (never an argument, never printed): `PW="$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/saos/.env
     | tr -d '\r')"; printf "ALTER USER saos WITH PASSWORD '%s';\n" "$PW" | docker exec -i
     saos-postgres-1 psql -U saos -d postgres -q; unset PW`. Existing sessions stay up; any NEW
     connection under the old password now fails — so step 4 follows immediately.
  4. `bash scripts/deploy.sh` (idempotent merge, then migrate under the new `DATABASE_URL`, then
     `up -d` recreates api, calcom, calcom-db-init and postgres itself — its env changed, so expect
     a Postgres restart of a few seconds; data is on `/mnt/saos-data/postgres`). Do it outside
     office hours.
- **Verification (existing)**: `curl -s https://api.sotoaccounting.com/health` →
  `{"status":"ok","db":"ok"}` — apps/api/src/server.ts lines 146-149 runs `SELECT 1` through the
  api's pool, i.e. a fresh authenticated connection under the new URL. (`docker exec … psql` is
  NOT a proof: inside the container it authenticates by local trust.) Also
  `https://book.sotoaccounting.com` loads (Cal.com's URL carries the same password), and the
  02:15 backup runs green.
- **Brian revokes**: nothing external; the old password died at `ALTER USER`. Update Vaultwarden.

## 9. MinIO

- **Names**: `MINIO_ROOT_USER` (unchanged), `MINIO_ROOT_PASSWORD`. docker-compose.yml lines 40-41
  (minio), 64 and 69-70 (minio-init); apps/api/src/config.ts lines 59-60 and
  modules/documents/storage.ts lines 51-52 (the api's S3 client); scripts/backup.sh line 89 and
  restore-drill.sh lines 81, 114 (`mc alias set`).
- **Consumed by**: saos-minio-1, saos-minio-init-1, saos-api-1 (every document read/write),
  the backup mirror.
- **Brian, vendor console**: none — self-hosted. Generate and type.
- **Order**: MinIO reads root credentials from its environment at start, so one deploy flips
  everything: `up -d` recreates minio (env changed), re-runs minio-init (idempotent `mc mb
  --ignore-existing`) and recreates the api. Between minio's restart and the api's recreation
  (seconds) document reads fail; the api healthcheck covers it. Object data is not tied to the
  root credential.
- **Verification (existing pattern, backup.sh line 89)**: `cd /opt/saos && docker compose -f
  docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps --entrypoint /bin/sh
  minio-init -c 'mc alias set saos http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
  >/dev/null && mc ls saos'` → the five buckets (saos-documents, saos-returns, saos-signed-docs,
  saos-recordings, saos-quarantine). Then Brian opens one document in Ops (a streamed,
  audit-logged read through the api's client with the new key).
- **Brian revokes**: nothing external; the old root password died at restart. Update Vaultwarden.

## 10. WEBHOOK_SECRET (the internal shared secret)

- **Name**: `WEBHOOK_SECRET`. apps/api/src/config.ts line 50 (min 8; the dev value is refused in
  production, lines 124-126). `scripts/gen-prod-secrets.mjs` line 20 shows its shape (hex 24).
- **What it is**: it signs nothing. It is a bearer value carried in the header
  `x-webhook-secret` and compared with `timingSafeEqual` on four routes:
  `/webhooks/calcom` (modules/booking/routes.ts lines 61-65), `/webhooks/mail/delivery`
  (modules/portal-auth/routes.ts lines 152-156), `/webhooks/zoom` (modules/meetings/routes.ts
  lines 243-247), `/webhooks/container-health` (modules/admin/routes.ts lines 72-76). It is also
  passed to `stripe.parseWebhookEvent` (modules/billing/routes.ts line 465), but only the **stub**
  adapter uses it (stripe.ts lines 318-325); the live adapter verifies Stripe's own signature
  (lines 379-390). Not Docuseal (retired), not SES (that route is SNS-signed:
  modules/comms/routes.ts line 271).
- **Who else must hold it**:
  - `scripts/container-health.sh` on the box (line 19) reads it from `/opt/saos/.env` on every run
    — follows the deploy by itself.
  - **Cal.com**: the webhook Brian configured in Cal.com for `POST /webhooks/calcom` must send the
    header with the new value. How that header is set inside Cal.com is not recorded in this
    repository (`scripts/provision-calcom.mjs` has no webhook section; no doc names the field) —
    **not verified**; Brian updates it in Cal.com (Settings → Developer → Webhooks) in the same
    hour as the deploy, or bookings return 401 and no client record is created.
  - `/webhooks/zoom` and `/webhooks/mail/delivery` have no production caller today (Zoom cannot
    send a custom header; SES goes to `/webhooks/ses-notifications`). Nothing to update.
- **Deploy**: `up -d` recreates the api.
- **Verification (existing)**: `cd /opt/saos && ENV_FILE=/opt/saos/.env bash
  scripts/container-health.sh` — the host signs a real report with the value from the merged env
  and posts it through the api's own webhook door (lines 62-75); it prints `200 …` on success and
  exits non-zero on 401. For Cal.com: Brian books a free-lane test slot on
  book.sotoaccounting.com; the booking lands (booking/routes.ts writes the record and its tasks)
  rather than a 401 in `docker logs saos-api-1`.
- **Brian revokes**: nothing external; the old value dies at the api restart. Cal.com's stale
  copy is the only place it could linger.

---

## Report-only A: `APP_ENCRYPTION_KEY`

apps/api/src/config.ts lines 22-25 (64 hex chars; the well-known dev key is refused in
production, lines 115-116). AES-256-GCM via apps/api/src/crypto.ts lines 18-31; HMAC-SHA256
scoped tokens lines 50-73. It protects:

| What | Where written / read | Stored ciphertext? |
|---|---|---|
| Staff TOTP seeds, `staff.totp_secret_enc` (migration 0001 line 62) | modules/auth/service.ts line 243 (encrypt), 205 and 269 (decrypt on every MFA check) | yes |
| Invoice pay-link tokens, `invoices.pay_token_enc` (migration 0082 line 11) | modules/billing/pay-link.ts lines 48 (decrypt), 57 (encrypt) | yes |
| MFA-setup scoped tokens (minutes) | auth/service.ts lines 197, 229, 256 | no (HMAC only) |
| Referral transition tokens | modules/referrals/service.ts lines 194, 236, 291 | no |
| Broadcast unsubscribe tokens (CAN-SPAM, must stay valid 30+ days after a send — migration 0030 line 17) | modules/comms/broadcast.ts lines 48-51, 54-58 | no, but sent in every announcement email |
| `contacts.ssn_encrypted` (migration 0002 line 82, "encrypted app-side with APP_ENCRYPTION_KEY") | **no code in apps/api/src reads or writes this column** (grep 2026-09-20: only the migration) | column exists, unused |

**Re-encryption path: none exists.** No script or migration decrypts with an old key and
re-encrypts with a new one; the only key-aware code is the dev-key refusal. Rotating the value
today would: lock every staff member out at the MFA step (GCM auth-tag failure on
`totp_secret_enc`), kill every outstanding pay link (pay-link.ts line 48 throws), invalidate
every unsubscribe link in already-sent broadcasts (a CAN-SPAM exposure for 30 days), and orphan
the ciphertext inside every restic snapshot (a restore after rotation needs the OLD key — keep it
in Vaultwarden for the 12-month retention horizon regardless).

What a path needs, in order: (1) a `APP_ENCRYPTION_KEY_PREVIOUS` read window — `decryptSecret`
tries the current key, then the previous; `verifyUnsubToken` accepts either HMAC; (2) a batch job
`re-encrypt-app-key.mjs` that walks `staff.totp_secret_enc` and `invoices.pay_token_enc`
(both small tables), decrypts with the previous key and rewrites with the current one, in one
transaction per row, audit-logged as `system`; (3) a verification count: rows decryptable under
the current key alone equals the row count for both tables, printed as numbers only; (4) after
30 days (the unsubscribe horizon) the previous key is removed from the env and the read window
closes. Until that exists, this key is not rotatable; R30 rotates nothing here.

## Report-only B: Cal.com secrets

`CALCOM_NEXTAUTH_SECRET` → container env `NEXTAUTH_SECRET`; `CALCOM_ENCRYPTION_KEY` →
`CALENDSO_ENCRYPTION_KEY` (docker-compose.yml lines 182-183). No SAOS code reads either; only
saos-calcom-1 does. Both non-blank on the box.

- **NEXTAUTH_SECRET** signs Cal.com's NextAuth session cookies (documented NextAuth behaviour).
  Rotating it invalidates every Cal.com session: Brian and staff sign in again. Nothing stored
  breaks. Public booking pages and the webhook are unaffected.
- **CALENDSO_ENCRYPTION_KEY** — documented in Cal.com's own `.env.example` as the application key
  for symmetric encryption/decryption. **Inferred from Cal.com source, not verified against the
  running instance**: it encrypts the `key` column of stored app credentials — connected Google or
  Outlook calendars and the Zoom integration's tokens inside the `calcom` database. Rotating it
  without re-encryption makes every connected calendar and every Zoom meeting-link creation fail
  until each integration is disconnected and reconnected; I found no Cal.com re-encryption tool
  (not verified). Recommendation: do not rotate it on 2026-10-12; if it must rotate, plan the
  reconnection of every integration in the same session.

## Report-only C: Zoom secrets

`ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_SECRET_TOKEN` are present in
`.env.production` and `/opt/saos/.env` (non-blank). **No code reads any of them** (grep of apps/,
packages/, scripts/, compose, 2026-09-20: zero hits). Rotating them breaks nothing in SAOS.

- The first three are a Server-to-Server OAuth app's credentials (meeting creation via the Zoom
  API). SAOS never calls the Zoom API; Cal.com's Zoom integration uses credentials configured
  inside Cal.com (see B). Whether that is the *same* Zoom app is not recorded in the repo.
- `ZOOM_SECRET_TOKEN` is the Marketplace app's Event Subscription secret (CRC challenge +
  `x-zm-signature`). `/webhooks/zoom` (meetings/routes.ts lines 240-247) checks
  `x-webhook-secret` instead — the route's own comment says the signed Zoom app is not wired —
  so Zoom cannot successfully call it today; RUNBOOK_OPS.md line 121 describes the intended
  wiring.
- **What must change in the Zoom Marketplace app if rotated**: App Credentials → regenerate Client
  Secret (the Client ID and Account ID stay); Feature → Event Subscriptions → regenerate the
  Secret Token. If the same app is connected inside Cal.com, update its client secret there
  (Cal.com Settings → Admin → Apps → Zoom) — inferred.

## Recorded: Docuseal

`DOCUSEAL_API_TOKEN` was removed from the env files on 2026-09-20: it is no longer a key in
`C:\Users\brian\saos\.env.production`; no code reads it (config.ts lines 62-63: no `DOCUSEAL_*`
key is read). On the box, `/opt/saos/.env` still carries the NAME with a blank value (read
2026-09-20); the next deploy's merge drops the line (merge-env prints only incoming keys plus
non-blank server extras). `DOCUSEAL_MODE`, `DOCUSEAL_URL`, `DOCUSEAL_PORT` remain in both files
with values and are equally unread. There is no Docuseal container; the volume
`saos_saos_docuseal_data` and image `docuseal/docuseal:3.1.2` remain on the box and the volume
is removed on 2026-10-12.

## Not verified in this pass

- Restic 0.19.1's exact `key add` flag (`--new-password-file`); check `--help` before running.
- The B2 application-key capability set restic needs for `forget --prune`.
- How the `x-webhook-secret` header is configured inside Cal.com (no record in the repo).
- Twilio's retirement of the old primary token on promotion (console behaviour).
- Cal.com's use of `CALENDSO_ENCRYPTION_KEY` for stored credentials (inferred from source; the
  running instance was not inspected).
