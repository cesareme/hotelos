# e2e del portal del huésped (proyecto Playwright `guest`)

Tanda L7 · lotes L7-03 (`precheckin.spec.ts`, helpers) y L7-09 (`stay-checkout`, `kiosk`, `journey`, este README).
Las specs recorren `apps/guest-web` (portal y kiosco) y una pantalla de `apps/admin-web` (Recepción › Reservas ›
Recorrido) contra un API real, sobre el tenant aislado **CHK** de `packages/database/prisma/seed-checkin.ts`
(`org_chk` / `prop_chk`, «Hotel CHK (prueba)», usuarios `recepcion@chk.test` y `direccion@chk.test`, contraseña
`chk-demo` o `E2E_CHK_PASSWORD`). Cada corrida crea por API sus propias reservas con titular **inventado**
(«Prueba Portal», `prueba.portal.<marca>@chk.test`): nunca datos de Faranda ni nombres reales, ni en capturas, ni en
los JSON de objetivos, ni en este documento. Sin skip: sin API, seed, portal o admin-web la spec **falla con el motivo**.

## Los tres procesos

Desde `hotelos/` (BD del carril en `DATABASE_URL` del `.env`; puertos de ejemplo :3937 / :5237 / :5207):

```bash
# 0) seed CHK (idempotente; --reset lo rearma: reservas CHK-*, política, kiosco chk_kiosk_01, habitaciones limpias)
corepack pnpm --filter @hotelos/database db:seed:checkin -- --reset

# 1) API propio · GUEST_WEB_BASE_URL = base del portal (enlace de invitación) · RATE_LIMIT_MAX alto (UX1-REV-06)
(cd apps/api && PORT=3937 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 \
  GUEST_WEB_BASE_URL=http://127.0.0.1:5237 node --env-file-if-exists=../../.env --import tsx src/server.ts &)

# 2) portal del huésped (apps/guest-web) en :5237 apuntando a ese API y al hotel CHK
(VITE_GUEST_API_BASE=http://127.0.0.1:3937 VITE_GUEST_PROPERTY_ID=prop_chk \
  corepack pnpm --filter @hotelos/guest-web dev --host 127.0.0.1 --port 5237 --strictPort &)

# 3) admin-web en :5207 (solo journey.spec.ts la necesita)
(VITE_API_URL=http://127.0.0.1:3937 corepack pnpm --filter @hotelos/admin-web dev --host 127.0.0.1 --port 5207 --strictPort &)
```

## Ejecutar

```bash
# solo el proyecto guest (sin «--» antes de las opciones: pnpm las pasaría literales)
E2E_API_URL=http://127.0.0.1:3937 E2E_GUEST_BASE_URL=http://127.0.0.1:5237 E2E_ADMIN_BASE_URL=http://127.0.0.1:5207 \
  corepack pnpm --filter @hotelos/admin-web e2e --project guest

# una spec (con «=»: tras `--project guest` Playwright leería «kiosk» como otro proyecto):
#   … e2e --project=guest kiosk        (también stay-checkout · journey · precheckin · survey)
```

Variables:

| Variable | Uso | Por defecto |
| --- | --- | --- |
| `E2E_API_URL` | API de pruebas (login real de `*@chk.test`) | `http://127.0.0.1:3000` |
| `E2E_GUEST_BASE_URL` | base del portal / kiosco (`baseURL` del proyecto) | `http://127.0.0.1:5237` |
| `E2E_ADMIN_BASE_URL` | base de admin-web para `journey.spec.ts` (si falta, `E2E_BASE_URL`) | `http://127.0.0.1:5207` |
| `E2E_CHK_PASSWORD` | contraseña de los usuarios CHK | `chk-demo` |
| `E2E_SHOTS_DIR` | carpeta de capturas (`shot`) | `apps/admin-web/test-results/guest-portal-shots` (ignorada por git) |
| `TARGET_SIZE_OUT` | carpeta de los JSON de objetivos `targets-<pantalla>.json` | outputDir de la prueba |
| `E2E_GUEST_ARRIVAL_OFFSET_DAYS` | `precheckin`: llegada de la reserva (0 → espera 200 en «Ya estoy en el hotel») | `3` |
| `E2E_KIOSK_ARRIVAL_OFFSET_DAYS` | `kiosk`: llegada de la reserva (no compite por las habitaciones de hoy) | `7` |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright 1.63 exige `chromium_headless_shell-1243`; si está fuera de la caché por defecto | — |

`corepack pnpm --filter @hotelos/admin-web e2e` sin `--project` ejecuta los cuatro proyectos (measure, chromium, touch y
guest); el proyecto `chromium` excluye `e2e/guest-portal` por su `testMatch`. El proyecto `guest` emula un Pixel 5
(393 × 851, `hasTouch`, es-ES); cada spec fija su propio viewport con `test.use`.

## Specs

| Spec | Pantalla | Qué recorre | Fixture por API |
| --- | --- | --- | --- |
| `precheckin.spec.ts` (L7-03) | móvil 393 × 851, coarse | enlace mágico → viajeros → «foto» sin proveedor (400) → MRZ sintética → datos y consentimientos → complete → firma → pago honesto (`no_folio` / `at_reception` / `settled` solo con saldo 0) → llegada (409 fuera de la ventana ±1 día o 200 con offset 0) → estancia | reserva a +3 días + invitación |
| `stay-checkout.spec.ts` | móvil 390 × 844, coarse | sign-in por código + correo → «En el hotel» (check-in hecho, llave, habitación, saldo) → Información del hotel → Salida y cuenta (cargo real; «Quiero pagar ahora» → `at_reception`, nunca «Pagar ahora») → petición «Salida tardía» → `SRQ-<8>` en pantalla, en `GET /reservations/:id/activity` y en «Tus peticiones» → cobro en efectivo + check-out por API → «Estancia terminada» | reserva de hoy → invitación → pre-check-in cerrado por las rutas del huésped (MRZ, residencia, consentimientos, complete, firma PNG) → `POST /reservations/:id/check-in/complete` (habitación + llave) → `POST /folios/:id/lines` (minibar 12,50 €) → faq del hotel si prop_chk no la tiene |
| `kiosk.spec.ts` | tablet 1024 × 768, `hasTouch` | `?kiosk=1&device=&property=prop_chk` → emparejar con el código de 8 dígitos → «Toca para empezar» → localizar por código + correo → asistente (sin persistir la sesión) → aviso de inactividad a los 75 s con `page.clock` («Continuar» prolonga) → reinicio a los 90 s sin restos en `sessionStorage` y con la credencial del kiosco intacta | dirección crea y empareja un kiosco nuevo (`POST …/kiosks`, `…/pair`); reserva a +7 días; al final el kiosco queda `disabled` |
| `journey.spec.ts` | escritorio 1280 × 900 sobre admin-web, coarse por CDP | `/recepcion/reservas/:id/recorrido`: invitación **simulada** con destinatario enmascarado, pre-check-in alojado 1/1 firmados, habitación, check-in, llave móvil (serie real, QR de demo), bienvenida simulada, 1 petición abierta; «Avisos al huésped» con badge «Simulado»; «Peticiones y mensajes» | como stay-checkout + `POST /guest-portal/stay/requests` (consigna) antes del check-in |
| `survey.spec.ts` (L7-08, si existe) | móvil | encuesta post-estancia | ver su cabecera |

Todas: captura por pantalla (`shot`), contrato de tamaño de objetivos (`assertTargets`: 0 objetivos interactivos
< 24 × 24 px CSS, WCAG 2.2 · 2.5.8; los < 44 px se escriben en `targets-<pantalla>.json` descritos por tipo, sin
textos), 0 excepciones de página, 0 errores de consola (salvo los «Failed to load resource» de las respuestas ≥ 400 que
la spec declara esperadas), ninguna respuesta ≥ 400 no declarada y **ningún token del portal en una URL** (viaja en
`x-guest-token`; en el kiosco tampoco el código de emparejamiento).

## Datos que deja cada corrida y cómo se limpian

- Reservas `RES-*` nuevas en `prop_chk` (una por spec). `stay-checkout` y `journey` dejan la suya `checked_out` y
  **vuelven a marcar limpia** la habitación usada (`POST /rooms/:id/mark-clean`, dirección) para que la spec sea
  repetible el mismo día: el check-out marca la habitación sucia y, con 17 Dobles, unas pocas corridas agotarían las
  habitaciones listas (`409 ROOM_NOT_READY` en el check-in). `precheckin` deja la suya `confirmed` a +3 días con sesión
  `ready_for_arrival`; `kiosk` la deja `confirmed` a +7 días con sesión `invited`. Las `confirmed` ocupan inventario
  de su tipo hasta su salida: desde el corrector L7-REV-10 `db:seed:checkin -- --reset` las purga (titular
  `prueba.portal.*` de `prop_chk`, solo sin factura; las CHK-* y las facturadas siguen su regla), y `precheckin` y
  `survey` dejan limpia la habitación usada en `finally` (`releaseReservationRoom`).
- Sin `E2E_API_URL` el proyecto `guest` apunta a `http://127.0.0.1:3937` (el carril documentado), nunca al `:3000` de
  la BD principal.
- El enlace de la encuesta abre una sesión `purpose=survey` que SOLO vale para la encuesta (`survey.spec` lo comprueba:
  `/guest-portal/stay` y `/reservation` → 401 con ese token); la estancia se ve entrando con código + correo.
- Sesiones del portal (`guest_portal_sessions`, 24 h), sesiones de check-in, capturas MRZ, firmas, `service_requests`,
  entregas simuladas, llaves móviles, pagos en efectivo y tareas de limpieza: el `--reset` los limpia (`deleteScoped`).
- Kioscos de prueba «Tablet e2e <marca>» `disabled`: el `--reset` borra todos salvo `chk_kiosk_01`.
- La faq del hotel (`PropertyAiSetting.configurationJson.faq`) solo se escribe si prop_chk no la tiene.

## Cifras de referencia (2026-09-20, Mac, API :3937 sin PSP ni proveedor de correo)

Corrida completa del proyecto `guest` (5 specs, 1 worker, Vite ya calientes): **5/5 en verde en 41,2 s**, 140
peticiones al API (sin `/health`), medidas con el reporter JSON de Playwright y el log del API:

| Spec | Duración | Peticiones al API (guest-portal · personal) | Pantallas medidas | < 24 px | < 44 px |
| --- | --- | --- | --- | --- | --- |
| `journey.spec.ts` | 32,7 s (primera carga de admin-web en dev) | 42 (7 · 35) | 1 (+1 filtrada, solo registro) | 0 | 0 (filtrada: 1, botón de borrar de `CocoaSearchInput`, 20 × 20) |
| `kiosk.spec.ts` | 0,8 s (reloj falso) | 16 (8 · 8) | 6 (las 4 posteriores a la pantalla completa se registran con `coarse:false`: el Chromium headless deja de responder `pointer: coarse` tras `requestFullscreen`; los objetivos del kiosco son ≥ 56 px en cualquier caso) | 0 | 0 |
| `precheckin.spec.ts` | 3,2 s | 31 (27 · 4) | 12 | 0 | 3 (casillas `.gp-check` de «Datos», 26 px) |
| `stay-checkout.spec.ts` | 2,1 s | 33 (22 · 11) | 7 | 0 | 0 |
| `survey.spec.ts` | 1,2 s | 18 (11 · 7) | 6 | 0 | 0 |

Las fixtures por API (reserva, invitación, pre-check-in cerrado, check-in de recepción, cargos y cobros) son la
mayoría de las peticiones «personal»; el portal en sí hace entre 5 y 27 llamadas por recorrido.
