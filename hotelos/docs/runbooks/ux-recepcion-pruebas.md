# Runbook · Pruebas con recepcionistas (Tanda UX-1 · kit del moderador)

Fuente: diseño [`docs/design/UX-RECEPCION-FEEL.md`](../design/UX-RECEPCION-FEEL.md) §8 (8.1 estudio, 8.2 tareas, 8.3 métricas,
8.4 instrumentación, 8.6 medida automatizada, 8.7 kit del moderador). Código del lote U1: seed
`packages/database/prisma/seed-ux-day.ts` («día de prueba», tenant aislado `UXDAY`), trazas `apps/admin-web/src/lib/ux-trace.ts` +
`providers/UxTraceProvider.tsx` (modo prueba `VITE_UX_TRACE=1`), dev-bypass `apps/admin-web/e2e/_helpers.ts` y medida automatizada
`apps/admin-web/e2e/measure/*.spec.ts` (baseline en `docs/audits/ux-recepcion/measure-baseline-2026-09-19.json`).

Todo lo que ve la persona es INVENTADO: hotel «Hotel UXDAY (prueba)», huéspedes con apellidos griegos («Alfa», «Beta», «Zeta»…),
empresa «Empresa UXDAY SL». Nunca se usan datos de Faranda ni nombres reales, ni en pantalla ni en las hojas de registro.

## 1 · Preparar la demo (una vez por sesión, 10 min)

Desde `~/anfitorio-demo/hotelos` (o el worktree de la tanda). El seed se ejecuta SIEMPRE con el API parado (la cadena de auditoría
vive en memoria del proceso del API).

```bash
# 1) Día de prueba (idempotente; --reset lo rearma: llegadas sin check-in, la 204 con 120 € pendientes, etc.)
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
#    Solo ver el plan sin escribir: corepack pnpm --filter @hotelos/database db:seed:ux-day -- --dry-run

# 2) API de la demo local (:3000) y admin-web en modo prueba (:5173)
cd apps/api && PORT=3000 node --env-file-if-exists=../../.env --import tsx src/server.ts
cd apps/admin-web && VITE_UX_TRACE=1 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
#    (con instancia propia para no tocar la demo: PORT=3913 / --port 5183 y VITE_API_URL=http://127.0.0.1:3913)
```

Credenciales (solo de prueba, contraseña `uxday-demo`): `recepcion@uxday.test` (Recepción · la que usa la persona),
`direccion@uxday.test` (Dirección general), `sistemas@uxday.test` (Administración de sistema). Propiedad `prop_uxday`
(«Hotel UXDAY (prueba)», organización `org_uxday`). En la pantalla de acceso, entra como `recepcion@uxday.test`; la app
aterriza en Hoy › Mi día.

Estado que deja el seed (relativo a HOY, Europe/Madrid): 6 llegadas (UXDAY-T1 y UXDAY-A2 sin habitación; UXDAY-A3 con la 110
sucia; UXDAY-A4 VIP en la 305; UXDAY-A5 en la 111 con 128 € pendientes; UXDAY-A6 en la 401), 5 salidas (UXDAY-T3 en la 204 con
120 € pendientes; UXDAY-D2 en la 205 con 45 €; D3/D4/D5 saldadas), 41 alojados (UXDAY-T4 en la 310 con orden de trabajo de
avería; UXDAY-T6 con apellido «Zeta» en la 212; UXDAY-E1 de «Empresa UXDAY SL» en la 213; H01…H38). Habitaciones 101-104 y 217-220
(Dobles) y 311-312 (Superior) libres y limpias. Tarifas BAR publicadas hoy−7…hoy+60 (DBL 89 € · SUP 119 € · JS 159 €). Las
reservas de pasadas anteriores con factura numerada (hash VeriFactu) se conservan pero `--reset` las cierra: no retienen habitación.

Comprobación rápida antes de sentar a la persona: Mi día muestra «Llegadas hoy 6 · Salidas hoy 5 · En el hotel 41» y la consola
del navegador dice `[ux-trace] modo prueba · sesión ux-… · ⌘⇧T tarea siguiente · ⌘⇧E exportar`.

## 2 · Material

Portátil con la demo local (`db:seed:ux-day -- --reset`; API :3000, admin :5173 con `VITE_UX_TRACE=1`), ratón y teclado externos,
cronómetro, hoja de registro por tarea (§5), grabación de pantalla solo con consentimiento verbal y sin cámara, tablet si
existe (D4). Sesión de 45 min; una persona por sesión; el moderador no toca el ratón.

## 3 · Guion de la sesión (45 min)

Encuadre (leer tal cual, 1 min): «Probamos el programa, no a ti. No hay respuestas buenas ni malas. Piensa en voz alta: di lo
que buscas y lo que esperas que pase. Si te atascas, sigue intentándolo; solo te ayudaré si pasan más de dos minutos. Los datos
son inventados. ¿Empezamos?»

Modo prueba: al empezar cada tarea pulsa **⌘⇧T** (Ctrl+Shift+T en Windows) para pasar a la tarea siguiente (T1 → T2 → …; la
región de estado oculta anuncia «Tarea T2»). El orden de las tareas se rota entre personas, así que la tarea Tn del registro NO
coincide con el orden de lectura: anota en la hoja qué escenario corresponde a cada Tn del `ux-trace`.

Tareas (leer el escenario; arrancar el cronómetro al terminar de leer; parar en el evento de dominio o a los 5 min):

| T | Escenario (leer tal cual) | Éxito (dato) |
|---|---|---|
| T1 | «Acaba de llegar el huésped de la reserva UXDAY-T1 sin habitación asignada. Dale habitación y haz el check-in.» | reserva alojada con habitación |
| T2 | «Entra una persona sin reserva: quiere una doble hoy y se va mañana. Cóbrale y hazle el check-in.» | reserva nueva `walk_in` + cobro + alojada |
| T3 | «Se va el huésped de la 204 con 120 € pendientes. Cobra y cierra la estancia.» | cobro de 120 € + salida hecha |
| T4 | «El huésped de la 310 tiene una avería. Cámbialo a otra habitación.» | reserva alojada en otra habitación |
| T5 | «Llama una empresa para reservar una doble del [hoy+7] al [hoy+9]; la factura irá a nombre de la empresa. Crea la reserva.» | reserva + empresa de facturación |
| T6 | «Un huésped alojado, apellido Zeta, ha consumido 12 € del minibar. Añádeselo a la cuenta.» | línea de 12 € en el folio |

Orden por persona: P1: T1-T2-T3-T4-T5-T6 · P2: T4-T6-T1-T3-T2-T5 · P3: T3-T5-T2-T6-T1-T4. Alternativa si dirección lo prefiere:
T6 = cierre de turno.

Tras cada tarea, SEQ (1 pregunta, escala 1-7): «En general, ¿cómo de difícil o fácil te ha resultado esta tarea?» 1 = muy
difícil … 7 = muy fácil. Si < 5: «¿qué la ha hecho difícil?» (anotar literal).

Al final, UMUX-Lite (2 ítems, 1-7, de «totalmente en desacuerdo» a «totalmente de acuerdo»): (1) «Las funciones de este programa
cubren lo que necesito en recepción.» (2) «Este programa es fácil de usar.» SUS-eq = 0,65 × ((i1 + i2 − 2) × 100 / 12) + 22,9.
Después, 3 preguntas abiertas: «¿Qué te ha frenado más?», «¿Cómo lo harías en tu programa actual?», «¿Qué palabra o botón no has
entendido?».

Qué no hacer: no ayudar antes de 2 min ni orientar («prueba arriba a la derecha»); no explicar el diseño; no anotar nombres (solo
P1-P3 y hotel A/B); no cronometrar la lectura del escenario; no repetir la tarea si se completó mal (se anota como error crítico
y se sigue).

Baseline en el PMS actual (D3): misma hoja y mismas seis tareas, cronómetro del moderador, sin instrumentar su sistema; el PMS
actual de Faranda es OPERA (versión —Cloud u on-premise— por confirmar).

## 4 · Cierre de cada sesión

1. Exportar el JSON del `ux-trace`: **⌘⇧E** (descarga `ux-trace-<sessionId>.json`) o en la consola del navegador
   `await window.__hotelosUxTrace.download()` (también `window.__hotelosUxTrace.exportJson()`, `.nextTask()`, `.setTask("T3")`,
   `.clear()`). El JSON lleva `sessionId`, `taskId` y los eventos (clic, tecla normalizada —nunca el carácter—, ruta sin query,
   overlay abierto/cerrado, fetch inicio/fin con estado y ms) sin ningún dato personal.
2. Copiar la hoja a `docs/audits/ux-recepcion/<fecha>-P<n>.md` sin nombres (guardar el JSON junto a ella con el mismo prefijo).
3. Restaurar el seed antes de la siguiente persona (API parado): `corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset`.
4. Los clics y teclas del JSON se comparan con el camino óptimo automatizado (§6) para la tarea.

## 5 · Hoja de registro por tarea (una fila por tarea y persona)

| Persona | Tarea | Escenario | Hora inicio | Hora fin | Resultado (sin ayuda / con 1 pista / no completada) | Clics · teclas (ux-trace; a mano si falla) | Errores (destino equivocado · retroceso · dato corregido · diálogo cancelado · ayuda) | Error crítico (S/N: check-in de otra reserva, cobro doble, dato en reserva equivocada) | SEQ (1-7) | Verbatim literal | Jerga no entendida | Pista dada (palabra por palabra) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | T1 | | | | | | | | | | | |
| P1 | T2 | | | | | | | | | | | |
| P1 | T3 | | | | | | | | | | | |
| P1 | T4 | | | | | | | | | | | |
| P1 | T5 | | | | | | | | | | | |
| P1 | T6 | | | | | | | | | | | |

Al final de la sesión: UMUX-Lite i1 __ · i2 __ → SUS-eq __ · respuestas abiertas (3) · hotel A/B · dispositivo (portátil / tablet).

## 6 · Medida automatizada del camino óptimo (§8.6)

Los seis specs `apps/admin-web/e2e/measure/t1…t6-*.spec.ts` recorren el mejor camino disponible hoy con clics/teclas contados,
cuentan las peticiones al API y escriben `apps/admin-web/e2e/measure/results.json` (ignorado por git; la baseline de la tanda está
copiada en `docs/audits/ux-recepcion/measure-baseline-2026-09-19.json`). Con `MEASURE_STRICT=1` afirman los objetivos de §8.3
(T1 ≤ 4 · T2 ≤ 11 · T3 ≤ 3 · T4 ≤ 4 · T5 ≤ 7 · T6 ≤ 6 y el presupuesto de peticiones); en la baseline va apagado.

```bash
# seed rearmado (API parado) → API y Vite propios → medida
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
# RATE_LIMIT_MAX=5000 solo en el API de pruebas: la suite completa hace ~1.250 peticiones contadas en 2 min con un usuario e IP
# (techo base 600/min); el limitador del API (AUTH-05) no se toca (corrector UX1-REV-06 / R3).
(cd apps/api && PORT=3913 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 node --env-file-if-exists=../../.env --import tsx src/server.ts &)
(cd apps/admin-web && VITE_API_URL=http://127.0.0.1:3913 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5183 --strictPort &)
E2E_BASE_URL=http://127.0.0.1:5183 E2E_API_URL=http://127.0.0.1:3913 corepack pnpm --filter @hotelos/admin-web e2e:measure
# todo (humo + medida): E2E_BASE_URL=… E2E_API_URL=… corepack pnpm --filter @hotelos/admin-web e2e
# Navegador (CIERRE-1 · C4a): si la versión instalada de @playwright/test pide una build de Chromium que no está en
# ~/Library/Caches/ms-playwright («Executable doesn't exist … chromium_headless_shell-NNNN») y no se puede descargar,
# E2E_CHROMIUM_EXECUTABLE apunta al binario de otra build ya en caché (proyectos `chromium` y `touch`; opcional):
E2E_CHROMIUM_EXECUTABLE=$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  E2E_BASE_URL=http://127.0.0.1:5183 E2E_API_URL=http://127.0.0.1:3913 \
  corepack pnpm --filter @hotelos/admin-web e2e e2e/quick-checkin.spec.ts --project chromium --grep "solo teclado"
```

Notas de la baseline 2026-09-19: T4 no era completable (`completed: false`: la ficha no ofrecía «Cambiar habitación» a un
alojado; U7 lo añadió). El velo de los drawers (`styles/cocoa-22-shell.css` ocultaba `.c22-scrim`) se corrigió en U4
(`styles/cocoa-22.css` `.c22-scrim[data-open] { display: block; }`); e2e ya no inyecta ningún override CSS y
`quick-checkin.spec` comprueba que el velo real se pinta (corrector UX1-REV-08 / R8).

El tenant `UXDAY` es compartido por todas las instancias sobre la misma base de datos: antes de dar por buena una medida,
comprueba que nadie más usa `prop_uxday` (`lsof -nP -iTCP:3913 -iTCP:5183`, y los `audit_events` del tenant en la ventana de
la corrida); dos suites a la vez se consumen mutuamente UXDAY-T1/T3 (R6).
