#!/usr/bin/env bash
# HotelOS · bootstrap a fresh Hostinger VPS into a remote DEV environment.
#
# Use this on a VPS where you'll edit code via VS Code Remote-SSH from a
# travel laptop. Different from `bootstrap-vps.sh` (which is production):
# this script optimises for developer ergonomics, not container hardening.
#
# Run once as root on a fresh Ubuntu 24.04:
#   ssh root@<VPS_IP>
#   curl -fsSL https://raw.githubusercontent.com/cesareme/hotelos/main/deploy/scripts/bootstrap-dev-vps.sh | bash
#
# After this finishes, you SSH in as `cesareme` and code as if it were
# your laptop — except it's a €9/month VPS you can replace in minutes if
# anything goes wrong.

set -euo pipefail

log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m⚠ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }

DEV_USER="${DEV_USER:-cesareme}"
REPO_URL="${REPO_URL:-https://github.com/cesareme/hotelos.git}"

log "1/12 · apt update + base packages"
apt-get update
apt-get upgrade -y
apt-get install -y \
    curl wget git ca-certificates gnupg lsb-release \
    build-essential python3 python3-pip \
    htop tmux vim neovim nano \
    ufw fail2ban unattended-upgrades \
    postgresql-client redis-tools \
    jq ripgrep fd-find tree

log "2/12 · Automatic security updates"
dpkg-reconfigure -plow unattended-upgrades || true

log "3/12 · Firewall (SSH + dev server ports for tunnelling)"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
# 80/443 only needed if you also run a public site on this box. For pure dev
# (where you tunnel everything through SSH), keep them closed.
# ufw allow 80/tcp
# ufw allow 443/tcp
ufw --force enable

log "4/12 · Harden SSH (key-only auth)"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
# Allow agent + tcp forwarding (we need them for VS Code Remote-SSH + tunnels)
sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
sed -i 's/^#\?AllowAgentForwarding.*/AllowAgentForwarding yes/' /etc/ssh/sshd_config
systemctl reload ssh

log "5/12 · Create dev user '$DEV_USER' with sudo"
if ! id -u "$DEV_USER" >/dev/null 2>&1; then
    adduser --disabled-password --gecos "" "$DEV_USER"
    usermod -aG sudo "$DEV_USER"
    mkdir -p "/home/$DEV_USER/.ssh"
    chmod 700 "/home/$DEV_USER/.ssh"
    if [[ -f /root/.ssh/authorized_keys ]]; then
        cp /root/.ssh/authorized_keys "/home/$DEV_USER/.ssh/authorized_keys"
        chown -R "$DEV_USER:$DEV_USER" "/home/$DEV_USER/.ssh"
        chmod 600 "/home/$DEV_USER/.ssh/authorized_keys"
    else
        warn "No /root/.ssh/authorized_keys to copy. Paste your laptop's id_ed25519.pub into /home/$DEV_USER/.ssh/authorized_keys manually."
    fi
    # Passwordless sudo for the dev user (convenience for dev box only).
    echo "$DEV_USER ALL=(ALL) NOPASSWD: ALL" > "/etc/sudoers.d/$DEV_USER"
    chmod 0440 "/etc/sudoers.d/$DEV_USER"
fi

log "6/12 · 4 GB swap (helps with TypeScript + Vite build)"
if ! swapon --show | grep -q '/swapfile'; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "7/12 · Install Node 22 via NodeSource (works for all workspaces)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi
npm install -g pnpm@latest npm@latest

log "8/12 · Install PostgreSQL 16 (local dev DB)"
if ! command -v psql >/dev/null 2>&1; then
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list
    apt-get update
    apt-get install -y postgresql-16
fi
systemctl enable --now postgresql
# Create dev DB + user matching repo's .env.example
sudo -u postgres psql <<'SQL' || true
CREATE USER hotelos WITH PASSWORD 'hotelos' CREATEDB;
CREATE DATABASE hotelos OWNER hotelos;
GRANT ALL PRIVILEGES ON DATABASE hotelos TO hotelos;
SQL

log "9/12 · Install Redis 7"
if ! command -v redis-server >/dev/null 2>&1; then
    apt-get install -y redis-server
    systemctl enable --now redis-server
fi

log "10/12 · Clone repo as $DEV_USER (if REPO_URL is HTTPS, gh auth login first)"
if [[ ! -d "/home/$DEV_USER/projects/hotelos/.git" ]]; then
    sudo -u "$DEV_USER" mkdir -p "/home/$DEV_USER/projects"
    sudo -u "$DEV_USER" git clone "$REPO_URL" "/home/$DEV_USER/projects/hotelos" || \
        warn "Clone failed — repo may be private. Run as $DEV_USER after auth: gh auth login && gh repo clone cesareme/hotelos /home/$DEV_USER/projects/hotelos"
fi

log "11/12 · Install gh CLI (so you can clone private repos + push)"
if ! command -v gh >/dev/null 2>&1; then
    type -p curl >/dev/null || apt-get install -y curl
    install -dm 0755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list
    apt-get update && apt-get install -y gh
fi

log "12/12 · Pre-create tmux config for $DEV_USER"
cat > "/home/$DEV_USER/.tmux.conf" <<'TMUX'
# HotelOS dev box · sensible tmux defaults
set -g mouse on
set -g history-limit 100000
set -g default-terminal "screen-256color"
setw -g mode-keys vi
# Prefix on Ctrl-a (more reachable than Ctrl-b).
unbind C-b
set -g prefix C-a
bind C-a send-prefix
# Split panes with | and -
bind | split-window -h
bind - split-window -v
# Status bar tweaks
set -g status-style "bg=colour234,fg=white"
set -g status-left "#[fg=green][#S] "
set -g status-right "#[fg=cyan]%H:%M %d-%b "
TMUX
chown "$DEV_USER:$DEV_USER" "/home/$DEV_USER/.tmux.conf"

log "✅ Dev VPS ready. Next steps from your travel laptop:"
cat <<NEXT

  1. From your laptop, add this VPS to ~/.ssh/config:

       Host hotelos-dev
           HostName        $(hostname -I | awk '{print $1}')
           User            $DEV_USER
           IdentityFile    ~/.ssh/id_ed25519
           ForwardAgent    yes
           ServerAliveInterval 60

  2. Test the connection:
       ssh hotelos-dev

  3. Install VS Code (or Cursor / Zed) on the laptop, then the
     "Remote - SSH" extension. Cmd+Shift+P → "Remote-SSH: Connect to Host"
     → pick "hotelos-dev". VS Code opens, looking like the project is
     local, but the files + terminal + Node + Postgres all live on the VPS.

  4. First-time inside the repo (on the VPS):
       cd ~/projects/hotelos
       cp .env.example .env
       nano .env                                  # generate real secrets
       npm install
       npm --workspace @hotelos/database run prisma:generate
       npm --workspace @hotelos/database run db:push
       npm --workspace @hotelos/api      run dev    # in one tmux pane
       npm --workspace @hotelos/admin-web run dev   # in another tmux pane

  5. From your laptop browser, open http://localhost:5173/
     SSH port-forward it the first time:
       ssh -L 5173:localhost:5173 -L 3000:localhost:3000 hotelos-dev
     Or VS Code Remote-SSH detects the dev server and offers to forward
     the port automatically.

  6. Persistent sessions (so SSH drop doesn't kill 'npm run dev'):
       tmux new -s dev      # start
       # Ctrl-a d            # detach (server keeps running)
       tmux attach -t dev   # re-attach later from any laptop

NEXT
