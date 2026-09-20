#!/usr/bin/env bash
# Puertas deterministas de ehotelOS · uso: bash scripts/gates.sh [--quick] [--json <fichero>]
# Con --json, la salida completa de cada puerta queda en <fichero sin .json>.<puerta>.log (L6B-REV-10).
# Ejecuta las puertas del repo en orden y resume cifras; salida 0 solo si todas pasan.
# --quick: typecheck + unitarios + contratos (sin build, sin integración, sin e2e).
# Pensado para que lo invoque el orquestador/CI y los agentes solo diagnostiquen fallos.
set -uo pipefail
cd "$(dirname "$0")/.."
QUICK=0; JSON=""; while [ $# -gt 0 ]; do case "$1" in --quick) QUICK=1;; --json) JSON="$2"; shift;; esac; shift; done
CSV="${NAV_TREE_CSV:-$(git rev-parse --show-toplevel 2>/dev/null)/pilots/tanda5-nav-tree.csv}"
declare -a NAMES=() STATUS=() FIGS=(); FAILS=0
run() { # nombre · comando (se evalúa en este shell) · patrón de cifra (grep -E, última coincidencia)
  local name="$1" cmd="$2" pat="$3" out rc fig
  out="$(eval "$cmd" 2>&1 </dev/null)"; rc=$?
  # Corrector L6b (L6B-REV-10): con --json se guarda la salida COMPLETA de cada puerta junto al JSON
  # (<json sin .json>.<puerta>.log) para poder nombrar un test intermitente cuando la cifra sea roja.
  if [ -n "$JSON" ]; then printf '%s\n' "$out" > "${JSON%.json}.$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_').log"; fi
  fig="$(printf '%s\n' "$out" | grep -E "$pat" | tail -1 | tr -s ' ' | cut -c1-160)"
  if printf '%s\n' "$out" | grep -qE '^ℹ fail [1-9]|^not ok|FAIL  |error TS|✖'; then rc=1; fi
  NAMES+=("$name"); STATUS+=("$rc"); FIGS+=("${fig:-sin cifra}")
  if [ "$rc" -ne 0 ]; then FAILS=$((FAILS+1)); printf '[FAIL] %s\n%s\n' "$name" "$(printf '%s\n' "$out" | grep -E 'not ok|FAIL|error|✖' | head -12)"; else printf '[ OK ] %s → %s\n' "$name" "${fig:-ok}"; fi
}
sum() { grep -E '^ℹ (tests|pass|fail|skipped)' | tr '\n' ' '; }
run "typecheck:all" "corepack pnpm run typecheck:all" '^[0-9]+ workspaces|PASS · '
run "api unit" "corepack pnpm --filter @hotelos/api test | sum" 'tests [0-9]+'
run "admin-web unit" "corepack pnpm --filter @hotelos/admin-web test | sum" 'tests [0-9]+'
run "ai-core" "corepack pnpm --filter @hotelos/ai-core test | sum" 'tests [0-9]+'
run "worker" "corepack pnpm --filter @hotelos/worker test | sum" 'tests [0-9]+'
run "contratos raíz" "node --test tests/*.test.mjs | sum" 'tests [0-9]+'
run "discoverability" "node scripts/check-discoverability.mjs" 'URLs|pantallas'
run "nav-tree --check" "node scripts/build-nav-tree.mjs --check --csv '$CSV'" 'up to date|items'
run "route-access" "node scripts/check-route-access.mjs" '^OK|tokens'
run "cocoa waves --check" "node scripts/cocoa-22-waves.mjs --check" '§6|pendientes'
run "rbac:sync --dry-run" "corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run" 'DRY-RUN|claves'
run "migrate status + drift" "corepack pnpm --filter @hotelos/database db:migrate:status && corepack pnpm --filter @hotelos/database db:drift:check" 'up to date|No difference'
if [ "$QUICK" -eq 0 ]; then
  run "admin-web build" "corepack pnpm --filter @hotelos/admin-web build" 'built in'
  # Como `pnpm run test:integration`: desde apps/api (ahí se resuelven @hotelos/* y tsx; en la raíz no hay enlaces de workspace) y con el cargador tsx (los fuentes importan `.js` → `.ts`).
  # `--env-file-if-exists=../../.env` (como los scripts db:* y el arranque del API): fija la DATABASE_URL del carril ANTES de que las suites
  # que hacen `process.env.DATABASE_URL ??= …/hotelos` (rbac-scope, rbac-sod, ledger-import, treasury-banking…) caigan en la BD principal.
  run "integración" "(cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/*.test.mts) | sum" 'tests [0-9]+'
fi
echo "== $((${#NAMES[@]}-FAILS))/${#NAMES[@]} puertas en verde"
if [ -n "$JSON" ]; then { echo '['; for i in "${!NAMES[@]}"; do printf '  {"gate":"%s","ok":%s,"figures":"%s"}%s\n' "${NAMES[$i]}" "$([ "${STATUS[$i]}" -eq 0 ] && echo true || echo false)" "$(printf '%s' "${FIGS[$i]}" | sed 's/"/\\"/g')" "$([ $i -lt $((${#NAMES[@]}-1)) ] && echo ,)"; done; echo ']'; } > "$JSON"; fi
[ "$FAILS" -eq 0 ]
