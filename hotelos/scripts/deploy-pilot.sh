#!/usr/bin/env bash
# ehotelOS · envoltorio de compatibilidad para el piloto Docker (Tanda 4).
#
# El compose piloto de infra/docker (Dockerfiles con npm, nunca funcionales)
# se eliminó. Este script conserva los subcomandos de siempre sobre
# deploy/docker-compose.production.yml (Dockerfiles pnpm + tsx de deploy/):
#
#   ./scripts/deploy-pilot.sh init        # primera vez: deploy.sh --role compose
#   ./scripts/deploy-pilot.sh up          # arranca todo
#   ./scripts/deploy-pilot.sh down        # para todo
#   ./scripts/deploy-pilot.sh status      # ps + health
#   ./scripts/deploy-pilot.sh logs api    # logs de un servicio
#   ./scripts/deploy-pilot.sh seed-demo   # seed base + comercial (org_123/prop_123)
#   ./scripts/deploy-pilot.sh reset       # borra volúmenes (PELIGRO)
#
# Requiere deploy/.env.production (copia deploy/.env.production.example).
# La vía recomendada es la nativa: deploy/README-INSTALL.md.

set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="deploy/.env.production"
COMPOSE="docker compose -f deploy/docker-compose.production.yml --env-file $ENV_FILE"

cmd=${1:-help}
[[ "$cmd" == "help" ]] || [[ -f "$ENV_FILE" ]] || { echo "Falta $ENV_FILE (cp deploy/.env.production.example $ENV_FILE)"; exit 2; }

case "$cmd" in
  init)
    bash deploy/scripts/deploy.sh --role compose --env-file "$ENV_FILE" --yes
    ;;
  up)
    $COMPOSE up -d
    echo "Servicios arriba. Caddy en :80/:443, API interno en api:3000."
    ;;
  down)
    $COMPOSE down
    ;;
  logs)
    $COMPOSE logs -f "${2:-api}"
    ;;
  seed-demo)
    $COMPOSE run --rm --no-deps --entrypoint "" api sh -lc \
      'cd /app/packages/database && node --import tsx prisma/seed.ts && node --import tsx prisma/seed-commercial-demo.ts'
    ;;
  status)
    $COMPOSE ps
    echo ""
    domain="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
    curl -s -o /dev/null -w "  https://$domain/health: HTTP %{http_code}\n" "https://$domain/health" || echo "  health: DOWN"
    ;;
  reset)
    read -r -p "ESTO BORRA TODOS LOS DATOS (volúmenes). Escribe 'BORRAR' para confirmar: " confirm
    if [[ "$confirm" == "BORRAR" ]]; then
      $COMPOSE down -v
      echo "Datos borrados. Ejecuta 'init' para empezar de cero."
    else
      echo "Cancelado."
    fi
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
