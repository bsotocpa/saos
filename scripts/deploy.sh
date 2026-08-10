#!/usr/bin/env bash
# Deploy SAOS to the production server from this machine.
#
#   ./scripts/deploy.sh            # ship code + up --build + migrate + seed
#
# Ships TRACKED files only (git archive) — client exports, backups, and env
# files never leave via this path; the single secret artifact copied is
# .env.production -> /opt/saos/.env. Requires: server provisioned
# (scripts/provision-hetzner.mjs), encrypted volume set up
# (scripts/setup-encrypted-volume.sh).
set -euo pipefail
export MSYS_NO_PATHCONV=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
IP="$(sed -n 's/^SERVER_IPV4=//p' .env.production | tr -d '[:space:]')"
[ -n "$IP" ] || { echo "deploy: no SERVER_IPV4 in .env.production — run provision-hetzner first."; exit 1; }
SSH_KEY="$HOME/.ssh/saos_hetzner_ed25519"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "root@$IP")

echo "deploy: [1/5] shipping tracked sources to root@$IP:/opt/saos ..."
"${SSH[@]}" 'mkdir -p /opt/saos'
git archive HEAD | "${SSH[@]}" 'tar -x -C /opt/saos'

# .env is MERGED, not overwritten. A blank key in .env.production must never
# destroy a secret Brian pasted directly on the server — that is how the Docuseal
# API token vanished mid-rehearsal on 2026-08-10, presenting as a 401 from a
# service that had worked minutes earlier. A non-blank local value still wins, so
# rotating a secret from .env.production works exactly as before.
scp -q -i "$SSH_KEY" .env.production "root@$IP:/opt/saos/.env.incoming"
"${SSH[@]}" 'cd /opt/saos && sh scripts/merge-env.sh .env.incoming .env && rm -f .env.incoming'

echo "deploy: [1b/5] ensuring the encrypted data volume is mounted..."
"${SSH[@]}" 'mountpoint -q /mnt/saos-data || bash /opt/saos/scripts/setup-encrypted-volume.sh "$(ls /dev/disk/by-id/scsi-0HC_Volume_* | head -1)"'

# Enforced here, not in a runbook: the drill of 2026-08 found the nightly
# backup cron had never been installed — prod ran with ZERO backups. Every
# deploy now (re)installs it idempotently so it can't silently be missing.
echo "deploy: [1c/5] ensuring the nightly backup cron is installed..."
"${SSH[@]}" 'mkdir -p /var/lib/saos/backup-staging && (crontab -l 2>/dev/null | grep -v "scripts/backup.sh"; echo "15 2 * * * cd /opt/saos && ENV_FILE=/opt/saos/.env bash scripts/backup.sh >> /var/log/saos-backup.log 2>&1") | crontab - && crontab -l | grep -q "scripts/backup.sh"'

echo "deploy: [2/5] building + starting the FULL stack incl. intel + booking (first build takes minutes)..."
"${SSH[@]}" 'cd /opt/saos && docker compose --profile intel --profile booking --profile scan -f docker-compose.yml -f docker-compose.prod.yml up -d --build --quiet-pull'

echo "deploy: [3/5] running migrations..."
"${SSH[@]}" 'cd /opt/saos && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps api node packages/db/scripts/migrate.cjs up'

echo "deploy: [4/5] seeding (idempotent — roles, settings, templates, price book, forms; NO demo data)..."
"${SSH[@]}" 'cd /opt/saos && docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps api node packages/db/seeds/run.mjs'

echo "deploy: [5/5] service status:"
"${SSH[@]}" 'cd /opt/saos && docker compose --profile intel --profile booking --profile scan -f docker-compose.yml -f docker-compose.prod.yml ps --format "table {{.Name}}\t{{.Status}}"'
echo "deploy: done. Smoke-check the subdomains next (curl -sI https://portal.sotoaccounting.com)."
