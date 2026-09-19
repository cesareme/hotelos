#!/usr/bin/env bash
# Fusiona la rama de un carril en main resolviendo los ficheros generados y pasa las puertas rápidas.
# Uso: bash scripts/merge-lane.sh <rama> [--full]   (desde cualquier sitio; opera en la raíz git)
# Conflictos que resuelve solo: .discoverability-whitelist.json (unión), cocoa-22-inventory.json y
# COCOA-22-MIGRACION.md §6 (regenerados), scripts/env-contract.json + .env.example + deploy/.env.production.example
# (censo regenerado), docs/audits/ESTADO-VERIFICADO.md (concatena ambos lados). Cualquier otro conflicto
# detiene el script con la lista para resolver a mano (el merge queda abierto).
set -uo pipefail
BRANCH="${1:?rama del carril}"; FULL="${2:-}"
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
H="$ROOT/hotelos"
git -c user.name="cesareme" -c user.email="yakutatsa@gmail.com" merge --no-commit --no-ff "$BRANCH" >/dev/null 2>&1
CONFL="$(git diff --name-only --diff-filter=U)"
for f in $CONFL; do
  case "$f" in
    hotelos/apps/admin-web/.discoverability-whitelist.json)
      git show ":2:$f" > /tmp/ml-ours.json; git show ":3:$f" > /tmp/ml-theirs.json
      node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("/tmp/ml-ours.json"));const b=JSON.parse(fs.readFileSync("/tmp/ml-theirs.json"));const u=(x,y)=>Array.isArray(x)?[...x,...y.filter(v=>!x.includes(v))]:(x&&typeof x==="object"?Object.fromEntries([...new Set([...Object.keys(x),...Object.keys(y)])].map(k=>[k,k in x&&k in y?u(x[k],y[k]):(k in y?y[k]:x[k])])):y);fs.writeFileSync(process.argv[1],JSON.stringify(u(a,b),null,2)+"\n")' "$f"; git add "$f";;
    hotelos/docs/design/cocoa-22-inventory.json|hotelos/docs/design/COCOA-22-MIGRACION.md|hotelos/scripts/env-contract.json|hotelos/.env.example|hotelos/deploy/.env.production.example)
      git checkout --theirs "$f" && git add "$f";;
    hotelos/docs/audits/ESTADO-VERIFICADO.md)
      { git show ":2:$f"; echo; git show ":3:$f" | sed -n '/^Estado verificado (Tanda/,$p'; } > /tmp/ml-estado.md; cp /tmp/ml-estado.md "$f"; git add "$f";;
    *) echo "CONFLICTO manual: $f";;
  esac
done
LEFT="$(git diff --name-only --diff-filter=U)"
if [ -n "$LEFT" ]; then echo "Merge abierto con conflictos manuales:"; echo "$LEFT"; exit 2; fi
( cd "$H" && node scripts/cocoa-22-inventory.mjs >/dev/null 2>&1; node scripts/cocoa-22-waves.mjs --write >/dev/null 2>&1; node scripts/env-census.mjs --write >/dev/null 2>&1 )
git add hotelos/docs/design/cocoa-22-inventory.json hotelos/docs/design/COCOA-22-MIGRACION.md hotelos/scripts/env-contract.json hotelos/.env.example hotelos/deploy/.env.production.example 2>/dev/null
git reset -q hotelos/pnpm-lock.yaml 2>/dev/null; git checkout -q -- hotelos/pnpm-lock.yaml 2>/dev/null || true
echo "== merge de $BRANCH preparado (sin commit); puertas $([ "$FULL" = "--full" ] && echo completas || echo rápidas):"
( cd "$H" && bash scripts/gates.sh $([ "$FULL" = "--full" ] || echo --quick) --json /tmp/ml-gates.json ); RC=$?
echo "== puertas rc=$RC · resumen en /tmp/ml-gates.json · commit: git commit -F <mensaje> (el merge sigue abierto)"
exit $RC
