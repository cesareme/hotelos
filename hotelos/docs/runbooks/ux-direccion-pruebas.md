# Runbook · Pruebas con dirección (Tanda UX-2 · kit del moderador)

Fuente: diseño [`docs/design/UX-DIRECCION-FEEL.md`](../design/UX-DIRECCION-FEEL.md) (§1 principios para dirección, §2 tareas medidas y
objetivos, §4 lotes D1 seed · D2 medida · D9 cierre) sobre el método de UX-1 (`docs/design/UX-RECEPCION-FEEL.md` §8 y
[`ux-recepcion-pruebas.md`](ux-recepcion-pruebas.md)). Código: seed `packages/database/prisma/seed-ux-direccion.ts` (hotel B del tenant
aislado `UXDAY`), trazas `apps/admin-web/src/lib/ux-trace.ts` + `providers/UxTraceProvider.tsx` (modo prueba `VITE_UX_TRACE=1`, las mismas
de UX-1), dev-bypass `apps/admin-web/e2e/_helpers-direccion.ts`, medida automatizada `apps/admin-web/e2e/measure/d1…d6-*.spec.ts` +
`_measure-direccion.ts` (baseline en `docs/audits/ux-direccion/measure-baseline-2026-09-20.json`, final en `measure-final-2026-09-20.json`;
informe `docs/audits/TANDA-UX2-DIRECCION-2026-09-20.md`).

Todo lo que ve la persona es INVENTADO: hoteles «Hotel UXDAY (prueba)» y «Hotel UXDAY B (prueba)», reservas `UXDB-*`, huéspedes con
apellidos griegos, solicitudes de recepción (reembolso de 60 €, ajuste de folio de 25 €, pedido de lencería de 900 €) y dos propuestas de la
IA (respuesta a un mensaje, cambio de tarifa). Nunca se usan datos de Faranda ni nombres reales, ni en pantalla ni en las hojas de registro.

## 1 · Preparar la demo (una vez por sesión, 10 min)

Desde `~/anfitorio-demo/hotelos` (o el worktree de la tanda). Los seeds se ejecutan SIEMPRE con el API parado (la cadena de auditoría
vive en memoria del proceso del API). El seed de dirección exige el tenant de UX-1 ya sembrado (`org_uxday` / `prop_uxday`): primero
`db:seed:ux-day`, después `db:seed:ux-direccion`.

```bash
# 1) Tenant UXDAY (recepción; --reset lo rearma) y hotel B de dirección (idempotente; --reset rearma SOLO prop_uxday_b)
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
corepack pnpm --filter @hotelos/database db:seed:ux-direccion -- --reset
#    Solo ver el plan sin escribir: corepack pnpm --filter @hotelos/database db:seed:ux-direccion -- --dry-run

# 2) API de la demo local (:3000) y admin-web en modo prueba (:5173)
cd apps/api && PORT=3000 node --env-file-if-exists=../../.env --import tsx src/server.ts
cd apps/admin-web && VITE_UX_TRACE=1 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort
#    (con instancia propia para no tocar la demo: PORT=3929 / --port 5199 y VITE_API_URL=http://127.0.0.1:3929)
```

Credenciales (solo de prueba, contraseña `uxday-demo`): `director@uxday.test` (Dirección de hotel, plantilla `manager`, asignado a
`prop_uxday` y `prop_uxday_b` · **la que usa la persona**), `direccion@uxday.test` (Dirección general, `general_manager`, también en
`prop_uxday_b`), `recepcion@uxday.test` (Recepción; solo `prop_uxday`: no ve el hotel B). En la pantalla de acceso, entra como
`director@uxday.test`; la app aterriza en Hoy › Mi día › **Dirección** (`/hoy/direccion`). Antes de sentar a la persona, pon como
propiedad activa «Hotel UXDAY B (prueba)» con el selector de propiedad de la cabecera (lista «Cambiar propiedad»): las seis tareas
escriben en el hotel B (`prop_uxday_b`, organización `org_uxday`); el hotel A (`prop_uxday`) solo se lee (comparativa de la cartera).

Estado que deja el seed (relativo a HOY, Europe/Madrid; el hotel B tiene 20 Dobles 101-120): fecha de negocio del hotel B = **ayer**
(el día que dirección tiene pendiente); 12 alojados (101-112; UXDB-H01 con un minibar de 25 € objeto del ajuste), 2 salidas hoy (113-114;
UXDB-S01 con el cargo duplicado objeto del reembolso), 3 llegadas hoy confirmadas (115-117), 118-120 libres y limpias; cierre del día de
**anteayer** completado ayer por recepción y **pendiente de la revisión de ingresos**; 3 solicitudes de aprobación pendientes solicitadas
por recepción (reembolso 60 € · ajuste de folio 25 € · pedido 900 €, caducan en 7 días); 3 propuestas de la IA pendientes (respuesta a un
mensaje del huésped, cambio de tarifa, respuesta a una reseña); 20 días de snapshots diarios de ocupación/ADR (ayer 70 %, anteayer 10 %, antes
histórico sintético) para que Cartera y detalle comparen; tarifa BAR publicada. Las reservas con factura numerada (hash VeriFactu) de pasadas anteriores se conservan pero `--reset` las cierra.

Comprobación rápida antes de sentar a la persona: Mi día › Dirección dice en el subtítulo «Datos de la fecha de negocio DD/MM» (ayer) y la
tarjeta de la cabecera «Pendientes · 3 aprobaciones · 3 de la IA»; Cierre del día muestra el aviso «Pendiente de la revisión de ingresos»
con la primaria «Marcar como revisado» encima de las comprobaciones (solo con `director@uxday.test`, plantilla «Dirección de hotel»:
`direccion@uxday.test` —dirección general— no tiene la clave de revisión y solo consulta el informe); Cartera de propiedades lista los dos hoteles; y la consola del navegador dice
`[ux-trace] modo prueba · sesión ux-… · ⌘⇧T tarea siguiente · ⌘⇧E exportar`.

## 2 · Material

Portátil con la demo local (seeds rearmados; API :3000, admin :5173 con `VITE_UX_TRACE=1`), ratón y teclado externos, cronómetro, hoja
de registro por tarea (§5), grabación de pantalla solo con consentimiento verbal y sin cámara, tablet si existe. Sesión de 45 min; una
persona por sesión; el moderador no toca el ratón.

## 3 · Guion de la sesión (45 min)

Encuadre (leer tal cual, 1 min): «Probamos el programa, no a ti. No hay respuestas buenas ni malas. Piensa en voz alta: di lo que buscas
y lo que esperas que pase. Si te atascas, sigue intentándolo; solo te ayudaré si pasan más de dos minutos. Los datos son inventados: dos
hoteles de prueba, el A y el B. ¿Empezamos?»

Modo prueba: al empezar cada tarea pulsa **⌘⇧T** (Ctrl+Shift+T en Windows) para pasar a la tarea siguiente (T1 → T2 → …; la región de
estado oculta anuncia «Tarea T2»). El orden de las tareas se rota entre personas, así que la tarea Tn del registro NO coincide con el orden
de lectura: anota en la hoja qué escenario Dn corresponde a cada Tn del `ux-trace`. D1 se hace siempre la primera (es el aterrizaje).

Tareas (leer el escenario; arrancar el cronómetro al terminar de leer; parar en el evento de dominio o a los 5 min):

| D | Escenario (leer tal cual) | Éxito (dato) | Camino óptimo medido (§6) |
|---|---|---|---|
| D1 | «Acabas de entrar por la mañana. ¿Cómo va hoy el hotel B y qué riesgos tienes?» | dice la ocupación del día con su fecha y nombra al menos un riesgo del bloque «Riesgos de hoy» | 0 clics (aterrizaje en Mi día › Dirección) |
| D2 | «Recepción te ha pedido un reembolso de 60 € por un cargo duplicado. Apruébalo.» | la solicitud del reembolso queda «Aprobada» (aviso «Aprobada: reembolso 60,00 € · solicitud …») | 3 clics: tarjeta «Pendientes» → «Aprobar» en la fila → «Aprobar reembolso de 60,00 €» |
| D3 | «¿Cómo va este mes el hotel B en ocupación e ingresos? Abre su cuenta de resultados.» | detalle del hotel B en la cartera («Ingresos del mes») y Pérdidas y ganancias con ámbito «Hotel UXDAY B (prueba)» | 3 clics: Cartera → fila → «PyG del hotel» (⌘K «PyG del hotel») |
| D4 | «¿Cuál de los dos hoteles va peor de ocupación y cuánto por debajo de la media de la cartera?» | nombra el hotel y lee su delta en la vista «Comparar» | 3 clics: Cartera → «Comparar» → ordenar por ocupación (⌘K «Comparar hoteles» / «Ordenar por ocupación») |
| D5 | «Sácame en un fichero el informe de reservas de este mes para el consejo.» | «Exportación lista: informe-reservation-prop_uxday_b-<desde>_<hasta>.<ext> · disponible hasta HH:MM» | 2 clics: Centro de informes → «Generar exportación» (⌥E; ⌘K «Exportar informe de reservas») |
| D6 | «Recepción cerró anteayer el día. Revisa ese cierre (auditoría de ingresos).» | el cierre queda revisado por la persona (aviso «Cierre del DD/MM/AAAA marcado como revisado») | 3 clics: Cierre del día → «Marcar como revisado» (aviso del último cierre pendiente; ⌥V, ⌘K «Marcar el cierre como revisado») → confirmar |

Tras cada tarea, SEQ (leer tal cual): «En una escala de 1 (muy difícil) a 7 (muy fácil), ¿cómo de fácil te ha resultado esta tarea?» y
anotar el verbatim literal del porqué.

Al final, UMUX-Lite (1-7, leer tal cual): (1) «Las funciones de este programa cubren lo que necesito para dirigir el hotel.» (2) «Este
programa es fácil de usar.» SUS-eq = 0,65 × ((i1 + i2 − 2) × 100 / 12) + 22,9. Después, 3 preguntas abiertas: «¿Qué te ha frenado más?»,
«¿Cómo lo harías con tus herramientas de hoy (PMS, hojas de cálculo, informes por correo)?», «¿Qué palabra, cifra o botón no has entendido?».

Qué no hacer: no ayudar antes de 2 min ni orientar («prueba en la cartera»); no explicar el diseño ni justificar una cifra; no anotar nombres
(solo P1-P3 y hotel A/B); no cronometrar la lectura del escenario; no repetir la tarea si se completó mal (se anota como error crítico y se
sigue); no cambiar de propiedad activa por la persona (si lo hace ella, se anota como retroceso).

Baseline con las herramientas actuales: misma hoja y mismas seis tareas, cronómetro del moderador, sin instrumentar su sistema; el PMS
actual de Faranda es OPERA (versión —Cloud u on-premise— por confirmar) y los informes de dirección llegan hoy por correo o por hoja de
cálculo (por confirmar con César, informe §5).

## 4 · Cierre de cada sesión

1. Exportar el JSON del `ux-trace`: **⌘⇧E** (descarga `ux-trace-<sessionId>.json`) o en la consola del navegador
   `await window.__hotelosUxTrace.download()` (también `.exportJson()`, `.nextTask()`, `.setTask("T3")`, `.clear()`). El JSON lleva
   `sessionId`, `taskId` y los eventos (clic, tecla normalizada —nunca el carácter—, ruta sin query, overlay abierto/cerrado, fetch inicio/fin
   con estado y ms) sin ningún dato personal.
2. Copiar la hoja a `docs/audits/ux-direccion/<fecha>-P<n>.md` sin nombres (guardar el JSON junto a ella con el mismo prefijo).
3. Restaurar el seed antes de la siguiente persona (API parado): `corepack pnpm --filter @hotelos/database db:seed:ux-direccion -- --reset`
   (rearma las 3 solicitudes, las 3 propuestas de la IA, los 20 snapshots, el cierre pendiente de revisión y la fecha de negocio a ayer; no toca el hotel A).
4. Los clics y teclas del JSON se comparan con el camino óptimo automatizado (§6) para la tarea.

## 5 · Hoja de registro por tarea (una fila por tarea y persona)

| Persona | Tarea | Escenario | Hora inicio | Hora fin | Resultado (sin ayuda / con 1 pista / no completada) | Clics · teclas (ux-trace; a mano si falla) | Errores (destino equivocado · retroceso · dato corregido · diálogo cancelado · ayuda) | Error crítico (S/N: aprobar la solicitud equivocada, revisar otro cierre, exportar o leer el hotel equivocado, cifra leída sin su ventana) | SEQ (1-7) | Verbatim literal | Jerga o cifra no entendida | Pista dada (palabra por palabra) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | T1 | | | | | | | | | | | |
| P1 | T2 | | | | | | | | | | | |
| P1 | T3 | | | | | | | | | | | |
| P1 | T4 | | | | | | | | | | | |
| P1 | T5 | | | | | | | | | | | |
| P1 | T6 | | | | | | | | | | | |

Al final de la sesión: UMUX-Lite i1 __ · i2 __ → SUS-eq __ · respuestas abiertas (3) · rol (director de hotel / dirección general) ·
dispositivo (portátil / tablet).

## 6 · Medida automatizada del camino óptimo

Los seis specs `apps/admin-web/e2e/measure/d1…d6-*.spec.ts` recorren el mejor camino con clics/teclas contados, cuentan las peticiones al
API y escriben `apps/admin-web/e2e/measure/results-direccion.json` (ignorado por git; baseline y final de la tanda copiados a
`docs/audits/ux-direccion/`). d3 y d5 miden además una variante solo teclado (⌘K), guardada bajo `variants.teclado`. Con
`MEASURE_STRICT=1` afirman los objetivos de `TARGETS` de `_measure-direccion.ts` (d1 0 clics · d2-d6 ≤ 3 clics · presupuesto de
peticiones 20/16/14/14/16/14); en la baseline va apagado.

```bash
# seeds rearmados (API parado) → API y Vite propios → medida de dirección (grep SIN «--»: con «--» pnpm se lo pasa literal a Playwright y corren también t1…t6)
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
corepack pnpm --filter @hotelos/database db:seed:ux-direccion -- --reset
# RATE_LIMIT_MAX=5000 solo en el API de pruebas (mismo motivo que UX-1: la suite completa supera el techo base de 600/min por usuario e IP)
(cd apps/api && PORT=3929 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 node --env-file-if-exists=../../.env --import tsx src/server.ts &)
(cd apps/admin-web && VITE_API_URL=http://127.0.0.1:3929 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort &)
MEASURE_STRICT=1 E2E_BASE_URL=http://127.0.0.1:5199 E2E_API_URL=http://127.0.0.1:3929 corepack pnpm --filter @hotelos/admin-web e2e:measure --grep "d[1-6] ·"
# todo (dirección + recepción): MEASURE_STRICT=1 E2E_BASE_URL=… E2E_API_URL=… corepack pnpm --filter @hotelos/admin-web e2e:measure
```

Notas de la tanda (2026-09-20): las specs `d2-aprobar-pendiente` y `d6-revisar-cierre` miden desde la ronda de corrección UX2-REV el camino
entregado (tarjeta «Pendientes · N aprobaciones · M de la IA» → «Aprobar» en la fila → diálogo nominal; menú → primaria del callout →
diálogo; 3 clics) y las ocho pruebas `d[1-6] ·` pasan en estricto desde el árbol (`docs/audits/ux-direccion/measure-correccion-2026-09-20.json`).
Al consultar `business_dates` por SQL, entrecomilla la columna (`select property_id, "current_date" from business_dates`): sin comillas
`current_date` es la función CURRENT_DATE de Postgres y devuelve el día del calendario para todas las filas (así nació el dato falso «2026-09-20»
del informe de D9). Una medida solo vale si ninguna otra instancia usa `prop_uxday_b` durante la corrida
(`lsof -nP -iTCP:3929 -iTCP:5199` y los `audit_events` del tenant en la ventana de la corrida): d2 consume una solicitud y d6 el cierre
pendiente, así que hace falta `db:seed:ux-direccion -- --reset` (API parado) antes de repetir. Cada medida «después» debe correr con un
API arrancado tras los lotes D3/D6 (catálogo en español, ventana de la fecha de negocio): una instancia levantada antes sirve el código viejo.
