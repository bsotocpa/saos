#!/usr/bin/env bash
# LUKS-encrypt the Hetzner data volume and mount it at /mnt/saos-data (MP:
# "encrypted volume"). Runs ON THE SERVER as root, once; safe to rerun.
#
#   ./setup-encrypted-volume.sh /dev/disk/by-id/scsi-0HC_Volume_<id>
#
# Key posture (standard cloud data-at-rest): the unlock KEYFILE lives on the
# root disk so the box reboots unattended; it protects the volume when it is
# detached, snapshotted, or recycled by the provider. A human RECOVERY
# passphrase is added as a second LUKS slot and written to
# /root/saos-luks-recovery.txt — move it to Vaultwarden and delete the file.
set -euo pipefail

DEVICE="${1:?usage: setup-encrypted-volume.sh /dev/disk/by-id/scsi-0HC_Volume_<id>}"
[ -b "$DEVICE" ] || { echo "setup-luks: $DEVICE is not a block device"; exit 1; }
MAPPER=saos-data
MOUNT=/mnt/saos-data
KEYFILE=/root/.saos-luks.key
RECOVERY=/root/saos-luks-recovery.txt

command -v cryptsetup >/dev/null || { apt-get update -qq && apt-get install -y -qq cryptsetup; }

if [ ! -f "$KEYFILE" ]; then
  dd if=/dev/urandom of="$KEYFILE" bs=64 count=1 status=none
  chmod 600 "$KEYFILE"
  echo "setup-luks: keyfile generated."
fi

if ! cryptsetup isLuks "$DEVICE"; then
  echo "setup-luks: formatting $DEVICE as LUKS2 (destroys anything on the raw volume)..."
  cryptsetup luksFormat --batch-mode --type luks2 "$DEVICE" "$KEYFILE"
  # Recovery passphrase in a second slot — for Vaultwarden, then delete.
  head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-28 > "$RECOVERY"
  chmod 600 "$RECOVERY"
  cryptsetup luksAddKey "$DEVICE" "$RECOVERY" --key-file "$KEYFILE"
  echo "setup-luks: RECOVERY PASSPHRASE written to $RECOVERY -> move to Vaultwarden, then: shred -u $RECOVERY"
fi

if [ ! -e "/dev/mapper/$MAPPER" ]; then
  cryptsetup open "$DEVICE" "$MAPPER" --key-file "$KEYFILE"
fi

if ! blkid "/dev/mapper/$MAPPER" >/dev/null 2>&1; then
  mkfs.ext4 -q "/dev/mapper/$MAPPER"
  echo "setup-luks: ext4 created."
fi

mkdir -p "$MOUNT"
mountpoint -q "$MOUNT" || mount "/dev/mapper/$MAPPER" "$MOUNT"

grep -q "^$MAPPER " /etc/crypttab 2>/dev/null || echo "$MAPPER $DEVICE $KEYFILE luks" >> /etc/crypttab
grep -q "/dev/mapper/$MAPPER" /etc/fstab || echo "/dev/mapper/$MAPPER $MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab

mkdir -p "$MOUNT"/{postgres,minio,docuseal,vaultwarden}
echo "setup-luks: encrypted volume mounted at $MOUNT (postgres/minio/docuseal/vaultwarden subdirs ready)."
