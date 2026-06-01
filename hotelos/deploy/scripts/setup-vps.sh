#!/usr/bin/env bash
# HotelOS · setup-vps.sh · ORQUESTADOR MAESTRO
#
# Corre ESTO desde tu laptop (Mac Pro o Neo). Hace el flujo completo de
# configuración de un VPS dev de cero a "Claude Code listo":
#
#   1. Verifica conectividad (ping + puerto 22)
#   2. Autoriza tu SSH key en el VPS (ssh-copy-id, te pedirá el root password 1 vez)
#   3. Añade/actualiza el alias en ~/.ssh/config
#   4. Ejecuta el bootstrap remoto (Node, Postgres, Redis, git, gh, tmux, claude CLI)
#   5. Verifica que todo quedó instalado
#   6. Imprime los next steps
#
# Es IDEMPOTENTE: re-ejecutarlo es seguro. Salta lo que ya está hecho.
#
# USO:
#   bash deploy/scripts/setup-vps.sh <IP_DEL_VPS> [usuario_dev]
#
# Ejemplos:
#   bash deploy/scripts/setup-vps.sh 72.61.194.216
#   bash deploy/scripts/setup-vps.sh 72.61.194.216 cesareme
#
# Variables de entorno opcionales:
#   SSH_ALIAS   (default: hotelos-dev)   alias en ~/.ssh/config
#   SSH_KEY     (default: ~/.ssh/id_ed25519)
#   REPO_URL    (default: https://github.com/cesareme/hotelos.git)
#   SKIP_KEYCOPY=1   no intenta ssh-copy-id (si ya autorizaste la key)

set -euo pipefail

# ---------- args ----------
VPS_IP="${1:-}"
DEV_USER="${2:-cesareme}"
SSH_ALIAS="${SSH_ALIAS:-hotelos-dev}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REPO_URL="${REPO_URL:-https://github.com/cesareme/hotelos.git}"
BOOTSTRAP_URL="https://raw.githubusercontent.com/cesareme/hotelos/main/hotelos/deploy/scripts/bootstrap-dev-vps.sh"

# ---------- colors ----------
c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
step()    { printf '\n'; c_blue "▶ $*"; }
ok()      { c_green "  ✓ $*"; }
warn()    { c_yellow "  ⚠ $*"; }
die()     { c_red "  ✗ $*"; exit 1; }

# ---------- usage ----------
if [[ -z "$VPS_IP" ]]; then
    c_red "Falta la IP del VPS."
    echo ""
    echo "Uso:   bash deploy/scripts/setup-vps.sh <IP_DEL_VPS> [usuario_dev]"
    echo "Ej:    bash deploy/scripts/setup-vps.sh 72.61.194.216 cesareme"
    exit 1
fi

c_blue "═══════════════════════════════════════════════════════════"
c_blue " HotelOS · Setup VPS dev · $VPS_IP (user: $DEV_USER)"
c_blue "═══════════════════════════════════════════════════════════"

# ---------- 1. conectividad ----------
step "1/6 · Verificando conectividad con $VPS_IP"
if ping -c 1 -t 5 "$VPS_IP" >/dev/null 2>&1; then
    ok "El VPS responde a ping"
else
    warn "No responde a ping (algunos VPS bloquean ICMP · seguimos igualmente)"
fi
if nc -z -G 5 "$VPS_IP" 22 >/dev/null 2>&1; then
    ok "Puerto SSH (22) abierto"
else
    die "Puerto 22 cerrado o filtrado. ¿El VPS está encendido? ¿Firewall?"
fi

# ---------- 2. SSH key ----------
step "2/6 · Autorizando tu SSH key en el VPS"
[[ -f "$SSH_KEY" ]] || die "No existe la key $SSH_KEY. Genérala con: ssh-keygen -t ed25519"
[[ -f "$SSH_KEY.pub" ]] || die "No existe la pública $SSH_KEY.pub"

# Carga la key en el agente (para que no pida passphrase si la tiene)
ssh-add --apple-use-keychain "$SSH_KEY" 2>/dev/null || ssh-add "$SSH_KEY" 2>/dev/null || true

# ¿Ya entra sin password como root?
if ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
       "root@$VPS_IP" 'true' 2>/dev/null; then
    ok "La key ya está autorizada (root entra sin password)"
elif [[ "${SKIP_KEYCOPY:-0}" == "1" ]]; then
    warn "SKIP_KEYCOPY=1 · saltando ssh-copy-id"
else
    warn "La key aún no está autorizada · ejecutando ssh-copy-id"
    warn "Te pedirá el ROOT PASSWORD del VPS (el que pusiste al reinstalar)"
    echo ""
    ssh-copy-id -i "$SSH_KEY.pub" -o StrictHostKeyChecking=accept-new "root@$VPS_IP" \
        || die "ssh-copy-id falló. ¿Password correcto? ¿root login permitido?"
    # Re-verifica
    if ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$VPS_IP" 'true' 2>/dev/null; then
        ok "Key autorizada · root entra sin password"
    else
        die "La key se copió pero root sigue pidiendo password. Revisa /root/.ssh/authorized_keys"
    fi
fi

# ---------- 3. ~/.ssh/config ----------
step "3/6 · Configurando alias '$SSH_ALIAS' en ~/.ssh/config"
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"

if grep -q "^Host $SSH_ALIAS\$" "$HOME/.ssh/config" 2>/dev/null; then
    # Actualiza el HostName del bloque existente (líneas tras "Host alias")
    # Usamos un tmpfile para portabilidad macOS/Linux.
    awk -v alias="$SSH_ALIAS" -v ip="$VPS_IP" '
        $0 ~ "^Host "alias"$" { inblock=1; print; next }
        inblock && /^[[:space:]]*HostName/ { print "    HostName            " ip; next }
        inblock && /^Host / { inblock=0 }
        { print }
    ' "$HOME/.ssh/config" > "$HOME/.ssh/config.tmp" && mv "$HOME/.ssh/config.tmp" "$HOME/.ssh/config"
    chmod 600 "$HOME/.ssh/config"
    ok "Alias '$SSH_ALIAS' actualizado a $VPS_IP"
else
    cat >> "$HOME/.ssh/config" <<EOF

Host $SSH_ALIAS
    HostName            $VPS_IP
    User                $DEV_USER
    IdentityFile        $SSH_KEY
    ForwardAgent        yes
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF
    ok "Alias '$SSH_ALIAS' creado (apunta a $DEV_USER@$VPS_IP)"
fi

# ---------- 4. bootstrap remoto ----------
step "4/6 · Ejecutando bootstrap en el VPS (Node, Postgres, Redis, git, gh, tmux, claude)"
warn "Esto tarda ~10 min la primera vez. Sé paciente."
echo ""
ssh -o StrictHostKeyChecking=accept-new "root@$VPS_IP" \
    "curl -fsSL '$BOOTSTRAP_URL' | DEV_USER='$DEV_USER' REPO_URL='$REPO_URL' bash" \
    || die "El bootstrap remoto falló. Revisa el output de arriba."
ok "Bootstrap completado"

# ---------- 5. verificación ----------
step "5/6 · Verificando el entorno instalado"
VERIFY=$(ssh -o BatchMode=yes "$DEV_USER@$VPS_IP" 'bash -lc "
    echo node=$(node --version 2>/dev/null || echo MISSING)
    echo npm=$(npm --version 2>/dev/null || echo MISSING)
    echo psql=$(psql --version 2>/dev/null | head -1 || echo MISSING)
    echo redis=$(redis-cli ping 2>/dev/null || echo MISSING)
    echo git=$(git --version 2>/dev/null || echo MISSING)
    echo gh=$(gh --version 2>/dev/null | head -1 || echo MISSING)
    echo claude=$(command -v claude >/dev/null 2>&1 && echo present || echo MISSING)
    echo repo=$([ -d ~/projects/hotelos/.git ] && echo cloned || echo MISSING)
"' 2>&1) || warn "No pude conectar como $DEV_USER (puede que el bootstrap aún esté terminando el usuario)"

echo "$VERIFY" | while read -r line; do
    if echo "$line" | grep -q 'MISSING'; then
        warn "$line"
    else
        ok "$line"
    fi
done

# ---------- 6. next steps ----------
step "6/6 · Listo. Próximos pasos:"
cat <<NEXT

  Entra al VPS como tu usuario dev:
      ssh $SSH_ALIAS

  Levanta una sesión persistente + Claude Code:
      tmux new -s claude
      cd ~/projects/hotelos/hotelos      # ojo: doble hotelos (subdir)
      claude                              # carga CLAUDE.md automáticamente

  Primer arranque de la app (dentro del VPS):
      cd ~/projects/hotelos/hotelos
      cp .env.example .env && nano .env   # genera secrets con: openssl rand -base64 32
      npm install
      npm --workspace @hotelos/database run prisma:generate
      npm --workspace @hotelos/database run db:push
      node packages/database/seeds/demo-pre-demo-enrichment.mjs   # datos demo
      tmux new -s dev
      # pane 1: npm --workspace @hotelos/api run dev
      # pane 2: npm --workspace @hotelos/admin-web run dev

  Ver la app desde el navegador del laptop (túnel SSH):
      ssh -L 5173:localhost:5173 -L 3000:localhost:3000 $SSH_ALIAS
      # luego abre http://localhost:5173/

  Guía completa de Claude Code:  docs/CLAUDE-CODE-GUIA.md
  Playbook remoto completo:      deploy/README-REMOTE-DEV.md

NEXT

c_green "✅ Setup del VPS completado para $DEV_USER@$VPS_IP"
