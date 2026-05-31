#!/usr/bin/env bash
# Script de deploy para piloto/demo en un VPS Linux limpio (Ubuntu 22.04+).
# Asume Docker y docker-compose ya instalados.
#
# Uso:
#   ./scripts/deploy-pilot.sh init        # primera vez: build + migrate + seed
#   ./scripts/deploy-pilot.sh up          # arranca todo
#   ./scripts/deploy-pilot.sh down        # para todo
#   ./scripts/deploy-pilot.sh logs api    # logs de un servicio
#   ./scripts/deploy-pilot.sh seed-iberia # repuebla cadena demo
#   ./scripts/deploy-pilot.sh reset       # borra todo y empieza de cero (PELIGRO)

set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f infra/docker/docker-compose.pilot.yml"

cmd=${1:-help}

case "$cmd" in
  init)
    echo "🔨 Build de imágenes…"
    $COMPOSE build
    echo ""
    echo "🚀 Levantando servicios…"
    $COMPOSE up -d
    echo ""
    echo "⏳ Esperando a Postgres…"
    until $COMPOSE exec -T postgres pg_isready -U "${POSTGRES_USER:-hotelos}"; do sleep 2; done
    echo ""
    echo "🗄️  Aplicando schema Prisma…"
    $COMPOSE exec -T api npm --workspace @hotelos/database run db:push
    echo ""
    echo "🌱 Seeding cadena Iberia (8 hoteles)…"
    $COMPOSE exec -T api npx tsx src/seeds/chain-8-hotels.ts
    echo ""
    echo "🌱 Seeding reservas demo…"
    $COMPOSE exec -T api npx tsx src/seeds/chain-reservations.ts
    echo ""
    echo "✅ Listo. Abre http://$(hostname -I | awk '{print $1}'):8080"
    ;;
  up)
    $COMPOSE up -d
    echo "✅ Servicios arriba. Admin-web en :8080, API en :3000"
    ;;
  down)
    $COMPOSE down
    ;;
  logs)
    $COMPOSE logs -f "${2:-api}"
    ;;
  seed-iberia)
    $COMPOSE exec api npx tsx src/seeds/chain-8-hotels.ts
    $COMPOSE exec api npx tsx src/seeds/chain-reservations.ts
    ;;
  status)
    $COMPOSE ps
    echo ""
    echo "Health checks:"
    curl -s -o /dev/null -w "  api:    HTTP %{http_code}\n" http://localhost:3000/health || echo "  api: DOWN"
    curl -s -o /dev/null -w "  admin:  HTTP %{http_code}\n" http://localhost:8080/ || echo "  admin: DOWN"
    ;;
  reset)
    read -p "⚠️  ESTO BORRA TODOS LOS DATOS. Escribe 'BORRAR' para confirmar: " confirm
    if [ "$confirm" = "BORRAR" ]; then
      $COMPOSE down -v
      echo "Datos borrados. Ejecuta 'init' para empezar de cero."
    else
      echo "Cancelado."
    fi
    ;;
  *)
    cat <<EOF
HotelOS · Deploy piloto

Comandos:
  init           Build + arranque + schema + seeds (primera vez)
  up             Arrancar servicios
  down           Parar servicios
  status         Estado + health checks
  logs <svc>     Tail logs (default: api)
  seed-iberia    Re-sembrar la cadena demo Iberia (8 hoteles)
  reset          Borrar todos los datos (PELIGRO)
EOF
    ;;
esac
