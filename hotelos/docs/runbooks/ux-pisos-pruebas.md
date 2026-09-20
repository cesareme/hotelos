# Runbook · Pruebas de pisos y mantenimiento en la tablet de pasillo (Tanda UX-3 · kit del moderador)

Fuente: diseño [`docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md`](../design/UX-PISOS-MANTENIMIENTO-FEEL.md) (§2 tareas p1…p6, §5 confirmar / deshacer,
§6 tablet y accesibilidad, §7 medida). Hermano de [`ux-recepcion-pruebas.md`](ux-recepcion-pruebas.md) (mismo tenant `UXDAY`, mismo
método): aquí solo lo que cambia para pisos y mantenimiento. Código: seed `packages/database/prisma/seed-ux-day-pisos.ts` (usuarios y
partes de pisos sobre el día de prueba de `seed-ux-day.ts`), arnés `apps/admin-web/e2e/measure/_measure-pisos.ts`, specs
`apps/admin-web/e2e/measure/p1…p6-*.spec.ts`, objetivos táctiles `apps/admin-web/e2e/pisos/pisos-target-size.spec.ts`; baseline en
`docs/audits/ux-pisos/measure-baseline-2026-09-20.json`.

Todo lo que ve la persona es INVENTADO: hotel «Hotel UXDAY (prueba)», huéspedes con apellidos griegos, usuarios `*@uxday.test`. Nunca se
usan datos ni nombres reales, ni en pantalla ni en las hojas de registro ni en los JSON.

## 1 · Preparar la demo (una vez por sesión, 10 min)

Desde `~/anfitorio-demo/hotelos` (o el worktree de la tanda). Los dos seeds se ejecutan SIEMPRE con el API parado (la cadena de auditoría
vive en memoria del proceso del API) y en este orden: el día de prueba primero, los datos de pisos después.

```bash
# 1) Día de prueba de recepción (idempotente; --reset lo rearma) …
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
# 2) … y encima los usuarios, secciones, habitaciones y partes de pisos/mantenimiento (idempotente: borra antes SOLO sus filas *_uxday_p*)
corepack pnpm --filter @hotelos/database db:seed:ux-day-pisos
#    Solo ver el plan sin escribir: corepack pnpm --filter @hotelos/database db:seed:ux-day-pisos -- --dry-run

# 3) Instancia PROPIA (nunca la demo :3000/:5173 ni la de otro carril): API con el límite de peticiones alto para las corridas de medida
(cd apps/api && PORT=3931 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 node --env-file-if-exists=../../.env --import tsx src/server.ts &)
(cd apps/admin-web && VITE_API_URL=http://127.0.0.1:3931 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5201 --strictPort &)
#    Al terminar: matar los dos procesos por PID (lsof -nP -iTCP:3931 -iTCP:5201 -sTCP:LISTEN), nunca `pkill -f` a ciegas.
```

Credenciales (solo de prueba, contraseña `uxday-demo`; `SEED_UXDAY_PASSWORD` la sustituye): `pisos@uxday.test` (Pisos · camarera, la
persona de p1, p2 y p4), `gobernanta@uxday.test` (Gobernanta · p1 inspección, p3 y p6 en el Tablero de habitaciones),
`mantenimiento@uxday.test` (Mantenimiento · técnico, p5) y `encargado@uxday.test` (Encargado de mantenimiento · p6 desde el parte).
Propiedad `prop_uxday` («Hotel UXDAY (prueba)», organización `org_uxday`). En un móvil o una tablet la app aterriza directamente en Mi turno
(pisos) o en Mis averías (mantenimiento); con ratón, en Mi día › Operaciones.

Estado que deja el seed de pisos (ids fijos `*_uxday_p*`): 3 secciones («Planta 1» 101-120, «Planta 2» 201-220, «Plantas 3-4»
301-315 + 401-405); 5 habitaciones sucias con tarea de salida pendiente para p1 (`hkt_uxday_p1_1…5`), 1 sucia con tarea en curso asignada
a la camarera, 2 limpias sin inspeccionar; partes: 2 abiertos sin asignar con habitación (p5), 1 en curso asignado al técnico, 2 abiertos
urgentes con habitación que no la bloquean (p6) y 1 emergencia. Las habitaciones las elige el seed entre las libres sin reserva viva y
fuera de las que usan las specs t1…t6 de recepción; si no quedan libres toma ocupadas (la tarjeta dirá «Stayover · limpieza diaria»).

Comprobación rápida antes de sentar a la persona (tablet a 820 × 1180, tema claro): Mi turno de `pisos@` muestra los chips de sección y la
tarjeta «Siguiente»; Mis averías de `mantenimiento@` muestra «Mías · 1» y la cola en «Todas»; en el navegador de la tablet no hay sesión
de otra persona (el `localStorage` es por origen: cada instancia y cada carril con su puerto, ver §6).

## 2 · Tareas (leer el escenario tal cual; cronómetro al terminar de leer; parar en el evento de dominio o a los 5 min)

| T | Persona · pantalla | Escenario (leer tal cual) | Éxito (dato, verificado por API) |
|---|---|---|---|
| p1 | `pisos@` Mi turno · `gobernanta@` tablero de pisos | «Acabas de limpiar la <sucia del seed>. Márcala limpia. Después la gobernanta la inspecciona.» | `housekeepingStatus` `clean` → `inspected`; la tarea de salida `done` |
| p2 | `pisos@` Mi turno | «Entra en tu turno y dime cuál es la siguiente habitación que te toca.» | la tarjeta «Siguiente» coincide con `rooms[0]` de la sección recordada |
| p3 | `gobernanta@` tablero de pisos | «Pide una limpieza a fondo de la 304 y asígnasela a la camarera de pisos.» | tarea `deep_clean` con `assignedTo` |
| p4 | `pisos@` Mi turno (tablet) | «El grifo del lavabo de la <sucia del seed> gotea: repórtalo a mantenimiento con una foto.» | parte «Hab. NNN: Fuga de agua» con `mediaCount 1` |
| p5 | `mantenimiento@` Mis averías | «Toma el parte de la <habitación p5a> y, cuando lo arregles, dalo por resuelto.» | parte `in_progress` + `assignedTo` → `resolved` (tras los 8 s) |
| p6 | `encargado@` tablero de mantenimiento · `gobernanta@` Tablero de habitaciones | «La <habitación p6a> no se puede vender hasta arreglar la avería: bloquéala. Luego libérala.» | `blocksRoom true` → resolver libera; casilla «Desbloquear» + deshacer |

Orden por persona, SEQ (1-7) tras cada tarea, UMUX-Lite al final, qué no hacer y hoja de registro: iguales que en
[`ux-recepcion-pruebas.md`](ux-recepcion-pruebas.md) §3-§5 (cambia solo la columna «Tarea»: p1…p6). Dispositivo: tablet de pasillo
820 × 1180 con el dedo (una mano, guantes de limpieza si la persona los usa); segunda pasada con ratón a 1280 × 900 si hay tiempo.

Tras cada persona, rearmar (API parado): `db:seed:ux-day -- --reset` + `db:seed:ux-day-pisos`. Las escrituras con «Deshacer» viajan a los
8 s: espera al menos 10 s (o cambia de pantalla) antes de comprobar el dato por API.

## 3 · Lo que la persona debe poder hacer sin ayuda (copia exacta, diseño §4)

- Mi turno: chips de sección («Todas · n», «Planta 1 · n»…, recordado como «Mi sección»), tarjeta «Siguiente», botones «Iniciar» · «Limpia» ·
  «Inspeccionada» · «Reportar»; avisos «Hab. 203 → Limpia · tarea cerrada» con «Deshacer» 8 s.
- Reportar: motivo con un toque («Fuga de agua», «Bombilla», «Aire acondicionado», «TV/Wi-Fi», «Cerradura», «Otro»), «Foto» (cámara trasera,
  ≤ 3, miniaturas con «Quitar»), «Enviar a mantenimiento»; aviso «Avería de la 203 enviada a mantenimiento · 1 foto». 3 toques, 0 teclas.
- Mis averías: chips «Mías · Todas», «Tomar» (aviso «Parte a1c3n6 → En curso · asignado a ti» con «Deshacer»), «Nota», «Resuelta» («Parte
  a1c3n6 resuelto.» con «Deshacer» 8 s), botón «1 foto» → galería «Fotos del parte a1c3n6».
- Tablero de mantenimiento: «Asignarme» / «Asignar a», «Bloquear habitación» → diálogo «Bloquear la 305» / «Mantenerla en venta», «Resolver»
  con «Deshacer»; Tablero de habitaciones: «Desbloquear habitación» con «Deshacer».

## 4 · Cierre de cada sesión

1. Hoja de registro a `docs/audits/ux-pisos/<fecha>-P<n>.md` sin nombres (P1-P3, hotel A/B, dispositivo).
2. Restaurar el seed antes de la siguiente persona (API parado): `db:seed:ux-day -- --reset` + `db:seed:ux-day-pisos`.
3. Comparar clics y toques con el camino óptimo automatizado (§6) para la tarea.

## 5 · Qué mirar en la tablet (diseño §6)

Objetivos ≥ 44 px con el dedo en las cinco rutas (`/operaciones/pisos`, `/operaciones/pisos/mi-turno`, `/operaciones/mantenimiento`,
`/operaciones/mantenimiento/mis-averias`, `/recepcion/reservas/tablero`), primario en la mitad inferior de la tarjeta, ayuda plegada bajo la
lista («Ayuda: Mi turno»), barra inferior con «Actualizar» y la hora de los datos, avisos anunciados por la región viva y «Deshacer»
alcanzable con Tab. El proyecto `touch` de Playwright lo afirma en los dos temas (§6).

## 6 · Medida automatizada del camino óptimo (§7)

Los seis specs `apps/admin-web/e2e/measure/p1…p6-*.spec.ts` recorren el mejor camino con acciones contadas (clic o toque, tecla, escritura),
cuentan las peticiones al API y escriben `apps/admin-web/e2e/measure/results-pisos.json` (ignorado por git; la baseline está copiada en
`docs/audits/ux-pisos/measure-baseline-2026-09-20.json`). Cada spec corre dos veces: ratón 1280 × 900 y tablet 820 × 1180 con `hasTouch` y
puntero grueso emulado por CDP. Con `MEASURE_STRICT=1` afirman los objetivos de §7 (≤ 3 toques por tarea, p2 ≤ 1, p4 completada con
`mediaCount 1`, presupuesto de peticiones); en la baseline va apagado.

```bash
# seed rearmado (API parado) → API y Vite propios (§1) → medida
corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
corepack pnpm --filter @hotelos/database db:seed:ux-day-pisos
(cd apps/api && PORT=3931 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true RATE_LIMIT_MAX=5000 node --env-file-if-exists=../../.env --import tsx src/server.ts &)
(cd apps/admin-web && VITE_API_URL=http://127.0.0.1:3931 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5201 --strictPort &)
# medida de pisos (solo p1…p6: el proyecto «measure» también contiene t1…t6 de recepción)
E2E_BASE_URL=http://127.0.0.1:5201 E2E_API_URL=http://127.0.0.1:3931 corepack pnpm --filter @hotelos/admin-web e2e:measure --grep "p[1-6] · "
# final con objetivos afirmados y segunda corrida para la variación
MEASURE_STRICT=1 E2E_BASE_URL=http://127.0.0.1:5201 E2E_API_URL=http://127.0.0.1:3931 corepack pnpm --filter @hotelos/admin-web e2e:measure --grep "p[1-6] · "
# objetivos táctiles y contraste en las 5 rutas × 2 viewports × 2 temas (proyecto touch)
E2E_BASE_URL=http://127.0.0.1:5201 E2E_API_URL=http://127.0.0.1:3931 corepack pnpm --filter @hotelos/admin-web e2e --project=touch pisos
```

Notas de operación:

- Sintaxis de los scripts: `pnpm` pasa `--` a Playwright y `--project` es variádico, así que `e2e:measure -- p` o `e2e --project touch pisos`
  no filtran lo que parece: usar `e2e:measure --grep "p[1-6] · "` y `e2e --project=touch pisos`.
- Navegadores: si `browserType.launch` falla porque falta el Chromium de la versión de Playwright del árbol, instala el navegador
  (`corepack pnpm --filter @hotelos/admin-web exec playwright install chromium`, descarga) o apunta `PLAYWRIGHT_BROWSERS_PATH` a una caché con
  esa build; sin uno de los dos fallan TODAS las specs (también t1…t6).
- Un origen por instancia: el `localStorage` (sesión, propiedad activa, sección recordada de Mi turno) es por origen. Dos personas o dos
  carriles en el mismo `127.0.0.1:<puerto>` se pisan la sesión (403 / «Sin acceso»): cada instancia con su puerto y, en las sesiones con
  personas, un perfil de navegador limpio por persona.
- Escrituras diferidas: «Limpia», «Inspeccionada», «Resuelta» y «Resolver» viajan a los 8 s (o al salir de la pantalla / `pagehide`). Una
  verificación por API justo después del clic ve el estado ANTERIOR; espera > 8 s o navega antes de leer. «Actualizar» envía las pendientes
  en el acto en las cinco pantallas (tablero de pisos, Mi turno, tablero de habitaciones, Mis averías y tablero de mantenimiento; corrector
  UX-3-REV-02) y se pierde el «Deshacer» de esa ventana: si la persona lo pulsa después, el aviso «… ya enviada: no se puede deshacer.» es
  el comportamiento esperado (REV-01), no un fallo. El toast con «Deshacer» ya no se pausa al dejar el ratón encima: los 8 s son los 8 s.
- Seed consumido por una pasada: p1 deja habitaciones inspeccionadas y su tarea cerrada, p3 crea tareas, p4 crea partes «Hab. NNN: …» con
  foto, p5/p6 resuelven `wo_uxday_p5*` / `wo_uxday_p6*`. Una segunda pasada sin rearmar deja p5/p6 en `completed:false` («rearma el seed»).
- Verificación del parte con foto (p4) sin navegador, como el técnico (maintenance.read): `GET /work-orders/:id/media` (metadatos, sin bytes),
  `GET /work-orders/media/:mediaId` (bytes con `Content-Type` de la foto y `Cache-Control: private, no-store`; sin sesión no se sirve) y
  `GET /dashboards/maintenance-mobile?propertyId=prop_uxday` (`items[].mediaCount`).
- Resultado de referencia de P4 (2026-09-20, tenant de prueba, tablet 820 × 1180 con el dedo): Reportar → «Fuga de agua» → Foto → Enviar =
  3 toques · 0 teclas · POST 201 en 0,6 s; una PNG de 2,1 MB (2000 × 1500) viajó como JPEG de 0,5 MB (1600 × 1200); toast «Avería de la 118
  enviada a mantenimiento · 1 foto»; `mediaCount 1`; galería de Mis averías con la foto a 600 px de ancho; todos los objetivos del cajón a 44 px.
- El tenant `UXDAY` es compartido por todas las instancias sobre la misma base de datos: antes de dar por buena una medida, comprueba que
  nadie más usa `prop_uxday` (`lsof -nP -iTCP:3931 -iTCP:5201`) y rearma el seed entre pasadas.
