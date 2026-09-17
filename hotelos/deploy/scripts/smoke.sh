#!/usr/bin/env bash
# ehotelOS · post-deploy smoke test (HTTP real: health, auth, lecturas, front).
#
# Uso:
#   bash deploy/scripts/smoke.sh [opciones]
#
# Opciones (o variables de entorno equivalentes):
#   --base-url URL        API pública, p. ej. https://demo.ehotelos.com/api   (BASE_URL)
#   --web-url URL         origen del front, p. ej. https://demo.ehotelos.com  (WEB_URL)
#   --email / --password  credenciales del usuario de smoke                  (SMOKE_EMAIL / SMOKE_PASSWORD)
#   --property-id ID      propiedad a leer (por defecto prop_123)            (SMOKE_PROPERTY_ID)
#                         (alias admitido: --property; deploy.sh la pasa vía SMOKE_PROPERTY_ID)
#   --web-dist DIR        dist de admin-web para verificar la URL horneada   (WEB_DIST)
#   --expect-api-url URL  URL que debe estar horneada (por defecto BASE_URL) (EXPECT_API_URL)
#   --skip-web            no comprobar el front (index.html ni dist)
#                         (sin --web-url/WEB_URL la comprobación 7 se omite sola, con aviso;
#                         la 8 sigue si hay --web-dist)
#   --skip-login          no hacer login ni lecturas autenticadas (solo health + 401)
#   --json                salida JSON en una línea al final
#   --timeout SEG         timeout por petición (por defecto 20)
#
# Comprobaciones (en orden):
#   1. GET  /health                         → 200, ok=true y checks.database.ok=true
#   2. GET  /properties sin token           → 401 (prueba que el modo demo NO está activo)
#   3. POST /auth/login                     → 200 con token
#   4. GET  /properties (token)             → 200 y lista no vacía
#   5. GET  /properties/:id/dashboard       → 200  (no existe GET /properties/:id plano)
#   6. GET  /backoffice/properties/:id/readiness → 200
#   7. GET  WEB_URL/                        → 200 y contiene id="root"; index.html sin caché
#                                             (omitida, no fallida, si WEB_URL está vacío)
#   8. dist/assets/*.js contiene EXPECT_API_URL y no http://localhost:3000
#
# Salida: 0 todo OK · 1 alguna comprobación falló · 2 argumentos/entorno inválidos.
# Solo necesita bash, curl y node (para parsear JSON); no requiere jq.

set -uo pipefail

BASE_URL="${BASE_URL:-}"
WEB_URL="${WEB_URL:-}"
SMOKE_EMAIL="${SMOKE_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-}"
SMOKE_PROPERTY_ID="${SMOKE_PROPERTY_ID:-prop_123}"
WEB_DIST="${WEB_DIST:-}"
EXPECT_API_URL="${EXPECT_API_URL:-}"
SKIP_WEB=0
SKIP_LOGIN=0
JSON=0
TIMEOUT="${SMOKE_TIMEOUT:-20}"

# Help = the comment header above, up to its last line (never the `set` line).
usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base-url) BASE_URL="$2"; shift 2 ;;
        --web-url) WEB_URL="$2"; shift 2 ;;
        --email) SMOKE_EMAIL="$2"; shift 2 ;;
        --password) SMOKE_PASSWORD="$2"; shift 2 ;;
        --property|--property-id) SMOKE_PROPERTY_ID="$2"; shift 2 ;;
        --web-dist) WEB_DIST="$2"; shift 2 ;;
        --expect-api-url) EXPECT_API_URL="$2"; shift 2 ;;
        --skip-web) SKIP_WEB=1; shift ;;
        --skip-login) SKIP_LOGIN=1; shift ;;
        --json) JSON=1; shift ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ -z "$BASE_URL" ]]; then
    echo "Falta --base-url (o BASE_URL), p. ej. https://demo.ehotelos.com/api" >&2
    exit 2
fi
BASE_URL="${BASE_URL%/}"
[[ -n "$WEB_URL" ]] && WEB_URL="${WEB_URL%/}"
[[ -z "$EXPECT_API_URL" ]] && EXPECT_API_URL="$BASE_URL"
for tool in curl node; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Falta '$tool' en PATH" >&2; exit 2; }
done
if [[ $SKIP_LOGIN -eq 0 && ( -z "$SMOKE_EMAIL" || -z "$SMOKE_PASSWORD" ) ]]; then
    echo "Faltan SMOKE_EMAIL / SMOKE_PASSWORD (o usa --skip-login para limitarte a health + 401)" >&2
    exit 2
fi

PASSED=0
FAILED=0
RESULTS=()   # "name|ok|detail"

ok()   { PASSED=$((PASSED + 1)); RESULTS+=("$1|true|$2"); [[ $JSON -eq 1 ]] || printf '  \033[1;32m✓\033[0m %-42s %s\n' "$1" "$2"; }
fail() { FAILED=$((FAILED + 1)); RESULTS+=("$1|false|$2"); [[ $JSON -eq 1 ]] || printf '  \033[1;31m✗\033[0m %-42s %s\n' "$1" "$2"; }

# http METHOD URL [BODY] [TOKEN] → sets HTTP_CODE and HTTP_BODY; returns curl exit code.
HTTP_CODE=""
HTTP_BODY=""
http() {
    local method="$1" url="$2" body="${3:-}" token="${4:-}"
    local tmp code rc
    tmp="$(mktemp)"
    local -a args=(-sS -m "$TIMEOUT" -o "$tmp" -w '%{http_code}' -X "$method" -H 'accept: application/json')
    [[ -n "$token" ]] && args+=(-H "authorization: Bearer $token")
    [[ -n "$body" ]] && args+=(-H 'content-type: application/json' --data "$body")
    code="$(curl "${args[@]}" "$url" 2>"$tmp.err")"
    rc=$?
    HTTP_CODE="$code"
    HTTP_BODY="$(cat "$tmp" 2>/dev/null)"
    if [[ $rc -ne 0 ]]; then
        HTTP_BODY="curl error $rc: $(tr -d '\n' <"$tmp.err")"
    fi
    rm -f "$tmp" "$tmp.err"
    return $rc
}

# json_check EXPRESSION — evaluates a JS boolean over the parsed HTTP_BODY (`j`).
json_check() {
    printf '%s' "$HTTP_BODY" | node -e '
      let raw = ""; process.stdin.on("data", (d) => (raw += d)); process.stdin.on("end", () => {
        let j; try { j = JSON.parse(raw); } catch { process.exit(3); }
        let ok = false; try { ok = Boolean(eval(process.argv[1])); } catch { ok = false; }
        process.exit(ok ? 0 : 1);
      });' "$1"
}
json_get() {
    printf '%s' "$HTTP_BODY" | node -e '
      let raw = ""; process.stdin.on("data", (d) => (raw += d)); process.stdin.on("end", () => {
        let j; try { j = JSON.parse(raw); } catch { process.exit(3); }
        let v; try { v = eval(process.argv[1]); } catch { v = undefined; }
        process.stdout.write(v === undefined || v === null ? "" : String(v));
      });' "$1"
}

[[ $JSON -eq 1 ]] || printf '\n\033[1;34m▶ Smoke ehotelOS · API %s · web %s\033[0m\n' "$BASE_URL" "${WEB_URL:-(omitido)}"

# 1. /health
if http GET "$BASE_URL/health"; then
    if [[ "$HTTP_CODE" == "200" ]] && json_check 'j.ok === true && j.checks && j.checks.database && j.checks.database.ok === true'; then
        ok "GET /health" "200 ok=true db=ok ($(json_get 'j.status') · schedulers: $(json_get 'j.checks.schedulers.message'))"
    else
        fail "GET /health" "HTTP $HTTP_CODE · $(printf '%s' "$HTTP_BODY" | head -c 300)"
    fi
else
    fail "GET /health" "$HTTP_BODY"
fi

# 2. sin token → 401 (demo mode must be OFF)
http GET "$BASE_URL/properties" || true
if [[ "$HTTP_CODE" == "401" ]]; then
    ok "GET /properties sin token" "401 (modo demo desactivado)"
else
    fail "GET /properties sin token" "esperado 401, recibido HTTP $HTTP_CODE — ¿HOTELOS_ALLOW_DEMO_AUTH activo?"
fi

TOKEN=""
if [[ $SKIP_LOGIN -eq 0 ]]; then
    # 3. login
    login_body="$(node -e 'process.stdout.write(JSON.stringify({ email: process.argv[1], password: process.argv[2] }))' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")"
    if http POST "$BASE_URL/auth/login" "$login_body" && [[ "$HTTP_CODE" == "200" ]]; then
        TOKEN="$(json_get 'j.token')"
        if [[ -n "$TOKEN" ]]; then
            ok "POST /auth/login" "200 token recibido ($SMOKE_EMAIL)"
        else
            fail "POST /auth/login" "200 pero sin campo token: $(printf '%s' "$HTTP_BODY" | head -c 200)"
        fi
    else
        fail "POST /auth/login" "HTTP $HTTP_CODE · $(printf '%s' "$HTTP_BODY" | head -c 300)"
    fi

    if [[ -n "$TOKEN" ]]; then
        # 4. /properties autenticado
        if http GET "$BASE_URL/properties" "" "$TOKEN" && [[ "$HTTP_CODE" == "200" ]] && json_check 'Array.isArray(j) ? j.length > 0 : (Array.isArray(j.items) && j.items.length > 0)'; then
            ok "GET /properties (token)" "200 · $(json_get 'Array.isArray(j) ? j.length : j.items.length') propiedades"
        else
            fail "GET /properties (token)" "HTTP $HTTP_CODE · $(printf '%s' "$HTTP_BODY" | head -c 200)"
        fi
        # 5. dashboard de la propiedad
        if http GET "$BASE_URL/properties/$SMOKE_PROPERTY_ID/dashboard" "" "$TOKEN" && [[ "$HTTP_CODE" == "200" ]] && json_check 'typeof j === "object" && j !== null'; then
            ok "GET /properties/$SMOKE_PROPERTY_ID/dashboard" "200"
        else
            fail "GET /properties/$SMOKE_PROPERTY_ID/dashboard" "HTTP $HTTP_CODE · $(printf '%s' "$HTTP_BODY" | head -c 200)"
        fi
        # 6. readiness backoffice
        if http GET "$BASE_URL/backoffice/properties/$SMOKE_PROPERTY_ID/readiness" "" "$TOKEN" && [[ "$HTTP_CODE" == "200" ]] && json_check 'typeof j === "object" && j !== null'; then
            ok "GET /backoffice/properties/$SMOKE_PROPERTY_ID/readiness" "200"
        else
            fail "GET /backoffice/properties/$SMOKE_PROPERTY_ID/readiness" "HTTP $HTTP_CODE · $(printf '%s' "$HTTP_BODY" | head -c 200)"
        fi
    else
        fail "lecturas autenticadas" "omitidas: sin token"
    fi
fi

if [[ $SKIP_WEB -eq 0 ]]; then
    # 7. index.html
    if [[ -n "$WEB_URL" ]]; then
        tmp="$(mktemp)"
        code="$(curl -sS -m "$TIMEOUT" -D "$tmp.h" -o "$tmp" -w '%{http_code}' "$WEB_URL/" 2>"$tmp.err")" || true
        if [[ "$code" == "200" ]] && grep -q 'id="root"' "$tmp"; then
            cache="$(grep -i '^cache-control:' "$tmp.h" | tr -d '\r' | head -1)"
            if printf '%s' "$cache" | grep -qi 'no-store'; then
                ok "GET $WEB_URL/ (index.html)" "200 id=\"root\" · $cache"
            else
                fail "GET $WEB_URL/ (index.html)" "200 pero sin Cache-Control: no-store (recibido: '${cache:-ninguna}')"
            fi
        else
            fail "GET $WEB_URL/ (index.html)" "HTTP $code · $(head -c 200 "$tmp.err" "$tmp" 2>/dev/null | tr -d '\n')"
        fi
        # /accept-invite y /reset-password deben servir la SPA
        for deep in /accept-invite /reset-password; do
            code="$(curl -sS -m "$TIMEOUT" -o "$tmp" -w '%{http_code}' "$WEB_URL$deep?token=smoke" 2>/dev/null)" || true
            if [[ "$code" == "200" ]] && grep -q 'id="root"' "$tmp"; then
                ok "GET $deep (SPA fallback)" "200"
            else
                fail "GET $deep (SPA fallback)" "HTTP $code"
            fi
        done
        rm -f "$tmp" "$tmp.h" "$tmp.err"
    else
        # An unset WEB_URL is a deliberate omission (deploy.sh always passes it),
        # not a failed check: report it as skipped so the exit code reflects the
        # checks that actually ran.
        [[ $JSON -eq 1 ]] || printf '  \033[1;33m·\033[0m %-42s %s\n' "front" "omitido (WEB_URL no definido; pásalo con --web-url para comprobar la URL horneada)"
    fi
    # 8. URL horneada en dist
    if [[ -n "$WEB_DIST" ]]; then
        if [[ -d "$WEB_DIST/assets" ]]; then
            if grep -rlF "$EXPECT_API_URL" "$WEB_DIST/assets" --include='*.js' >/dev/null 2>&1; then
                if grep -rlF "http://localhost:3000" "$WEB_DIST/assets" --include='*.js' >/dev/null 2>&1; then
                    fail "VITE_API_URL horneada" "el bundle contiene $EXPECT_API_URL pero también http://localhost:3000"
                else
                    ok "VITE_API_URL horneada" "$EXPECT_API_URL presente en $WEB_DIST/assets"
                fi
            else
                fail "VITE_API_URL horneada" "$EXPECT_API_URL no aparece en $WEB_DIST/assets/*.js (¿build sin VITE_API_URL?)"
            fi
        else
            fail "VITE_API_URL horneada" "no existe $WEB_DIST/assets"
        fi
    fi
fi

if [[ $JSON -eq 1 ]]; then
    node -e '
      const [passed, failed, ...rows] = process.argv.slice(1);
      const checks = rows.map((r) => { const [name, ok, detail] = r.split("|"); return { name, ok: ok === "true", detail }; });
      process.stdout.write(JSON.stringify({ ok: Number(failed) === 0, passed: Number(passed), failed: Number(failed), checks }) + "\n");
    ' "$PASSED" "$FAILED" "${RESULTS[@]}"
else
    if [[ $FAILED -eq 0 ]]; then
        printf '\n\033[1;32m✅ Smoke OK · %d comprobaciones\033[0m\n' "$PASSED"
    else
        printf '\n\033[1;31m✗ Smoke con %d fallo(s) de %d comprobaciones\033[0m\n' "$FAILED" "$((PASSED + FAILED))"
    fi
fi
[[ $FAILED -eq 0 ]] && exit 0 || exit 1
