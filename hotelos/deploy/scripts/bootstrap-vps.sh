#!/usr/bin/env bash
# HotelOS · bootstrap a fresh Hostinger VPS (Ubuntu 24.04 LTS) into a
# production-ready Docker host. Run this once after `ssh`-ing in as root.
#
# Idempotent: re-runnable, skips steps already done.
#
# Usage:
#   ssh root@your-vps-ip
#   curl -fsSL https://raw.githubusercontent.com/<USER>/hotelos/main/deploy/scripts/bootstrap-vps.sh | bash
#   # or copy the file and: bash bootstrap-vps.sh

set -euo pipefail

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m⚠ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }

log "1/9 · Update apt and install base packages"
apt-get update
apt-get upgrade -y
apt-get install -y curl ufw fail2ban git ca-certificates gnupg lsb-release htop unattended-upgrades

log "2/9 · Enable automatic security updates"
dpkg-reconfigure -plow unattended-upgrades || true

log "3/9 · Configure firewall (allow SSH + 80 + 443 only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "4/9 · Harden SSH (disable password auth, root login key-only)"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh

log "5/9 · Install Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

log "6/9 · Create non-root deploy user 'hotelos'"
if ! id -u hotelos >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" hotelos
    usermod -aG docker,sudo hotelos
    mkdir -p /home/hotelos/.ssh
    chmod 700 /home/hotelos/.ssh
    if [[ -f /root/.ssh/authorized_keys ]]; then
        cp /root/.ssh/authorized_keys /home/hotelos/.ssh/authorized_keys
        chown -R hotelos:hotelos /home/hotelos/.ssh
        chmod 600 /home/hotelos/.ssh/authorized_keys
    else
        warn "No /root/.ssh/authorized_keys found — add your public key to /home/hotelos/.ssh/authorized_keys manually."
    fi
fi

log "7/9 · Configure swap (4 GB) if missing"
if ! swapon --show | grep -q '/swapfile'; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10 || true
fi

log "8/9 · Clone HotelOS repo to /opt/hotelos (if not present)"
mkdir -p /opt/hotelos
chown hotelos:hotelos /opt/hotelos
if [[ -z "${REPO_URL:-}" ]]; then
    warn "REPO_URL not set; skipping clone. Once your GitHub repo exists, run:"
    warn "    su - hotelos -c 'git clone REPO_URL /opt/hotelos'"
else
    su - hotelos -c "git clone ${REPO_URL} /opt/hotelos" || true
fi

log "9/9 · Install nightly Postgres backup cron (root crontab)"
cat > /etc/cron.d/hotelos-backup <<'CRON'
# Nightly Postgres dump at 03:15 server-time. Output lands in
# /opt/hotelos/deploy/postgres-backups (rotated 14 days by the sidecar).
15 3 * * * root cd /opt/hotelos && /usr/bin/docker compose -f deploy/docker-compose.production.yml --env-file deploy/.env.production --profile backup run --rm postgres-backup >> /var/log/hotelos-backup.log 2>&1
CRON
chmod 0644 /etc/cron.d/hotelos-backup

log "✅ Bootstrap complete. Next steps:"
cat <<NEXT

  1. Switch to the deploy user:
       su - hotelos

  2. Clone the repo (if you skipped step 8):
       git clone <REPO_URL> /opt/hotelos
       cd /opt/hotelos

  3. Fill the env file:
       cp deploy/.env.production.example deploy/.env.production
       nano deploy/.env.production    # set DOMAIN, POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY

  4. Point your DNS A record at this VPS's public IP, then launch:
       cd /opt/hotelos
       bash deploy/scripts/deploy.sh

  5. First-time DB seed (creates demo properties + admin user):
       docker compose -f deploy/docker-compose.production.yml --env-file deploy/.env.production exec api node packages/database/seeds/demo-pre-demo-enrichment.mjs

  6. Verify HTTPS at https://\$DOMAIN/  — Caddy issues a Let's Encrypt cert
     automatically. Health endpoint: https://\$DOMAIN/health

NEXT
