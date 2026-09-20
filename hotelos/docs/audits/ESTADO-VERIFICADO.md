# Estado verificado por tanda (ehotelOS)

Bloques «Estado verificado (Tanda …)» que antes vivían en CLAUDE.md §Sistema de calidad. Cada integrador de tanda añade aquí su bloque (más reciente al final). Las cifras son las de la puerta del cierre de cada tanda; el detalle está en `docs/audits/TANDA-*.md`.

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda CIERRE-1 · restos de FIX-1, T9, CHK y manual, 2026-09-20, integrador;
informe `docs/audits/TANDA-CIERRE-1-2026-09-20.md`):
- rama `tanda-cierre` sobre a069906 (BD VIVA `hotelos`, solo lectura sobre la organización piloto),
  run 1: 7 lotes en 2 olas (C1a, C1b, C2, C4a · C3a, C3b, C4b) + C5 no ejecutada por brief; run 2
  (10:16-11:20 CEST): R1 e2e, R2 docs de API, R3 manual/RBAC, revisor REV, corrector COR, informe;
  2.ª pasada del corrector (12:00-12:45) tras la revisión funcional en runtime; commit único del
  integrador en la rama `tanda-cierre` al cierre de este bloque (2026-09-20, ~13:15 CEST): 59
  ficheros modificados (+2.003/−253, incluidos este bloque y CLAUDE.md) + 4 nuevos (3 de
  código/tests, 221 líneas, y el informe); `pnpm-lock.yaml` (+64/−25) previo a la tanda, excluido
  del commit y aún modificado en el árbol; sin migraciones (24/24, drift 0), dependencias ni claves
  RBAC nuevas
  (`schema.prisma:150` solo comentario `///`)
- seguridad: `GET /accounting/ledger-imports/third-parties` con `assertFinanceReadScope(context, null)`
  (R11 → 404 `ENTITY_SCOPE_REQUIRED`); `POST /webhooks/subscriptions` valida `propertyId` de la
  organización (400) y `DELETE` borra `webhook_deliveries` (`deliveriesDeleted`, también en la
  referencia pública `GET /developer/api-reference`, R2); `/dashboards/procurement` lee proveedores
  solo de la organización del contexto (T9 17e; por HTTP el hook de tenencia ya la re-apunta a la de
  la propiedad, también para plataforma); `POST /treasury/sepa/supplier-payments` con
  `assertSupplierBillPaymentAuthorized` por factura, fail-closed 409 `RBAC_SOD_CONFLICT` (T9 17d) y,
  desde el corrector (REV-01), `billIds` + `sod` en la respuesta y en el `payloadJson` de la remesa
  persistida + auditoría `SEPA_REMITTANCE_GENERATED` en toda remesa (`sepa-remittance.service.ts:345-364`,
  `auditoria-eventos.md` §6.3); tests: `ledger-import-routes` 19/19, `l2-modulos-plataforma` 29/29,
  `rbac-sod` 20/20, `procurement-org-scope` 2/2
- revisión (seguridad-regresiones, `scratchpad/CIERRE-1/review-seguridad.md`): 0 high · 2 medium ·
  6 low; REV-01 corregido (arriba); REV-02 corregido en la 2.ª pasada del corrector:
  `POST /treasury/sepa/remittances` `kind: norma34` → 403 `SUPPLIER_PAYMENT_ROUTE_REQUIRED` en
  `createRemittance` antes de parsear y sin fila (la genérica persiste adeudos Norma 19; las
  transferencias solo por `supplier-payments`; L2-04 pasa a Norma 19, `treasury-banking` y
  `rbac-sod` pinan el 403); low REV-03/05/08 con dueño (informe §3), REV-06 (frase con las 3 rutas
  de `users.read` en los runbooks) y REV-07 (zod `.strict()` en `POST /webhooks/subscriptions`)
  corregidos; COR-01 (`structure-l4.test.mts:96` con `payables.pay`) aplicado en el árbol;
  revisiones posteriores (funcional en runtime + seguridad-datos-regresiones): 3 medium
  confirmados y corregidos (FUN-01 mensaje y pestaña del directorio de terceros, FUN-02 = REV-02,
  REVF-01 tenant aislado en `api-integration`), 1 refutado (REVF-02: ventana transitoria de una
  sonda, BD limpia después), low corregidos salvo el lock (FUN-06/REVF-05); balance en el informe §3.2
- corrector · 2.ª pasada (revisión funcional en runtime FUN-01…07 + REVF-01/04/06/07/08): 404 de
  `GET /accounting/ledger-imports/third-parties` con mensaje propio (sin «indica el centro
  (propertyId)», que la ruta no admite) y pestaña «Terceros» con estado propio para perfiles de
  centro (`thirdPartiesEntityLocked`, `ledgerThirdPartiesErrorMessage`); `billIds` + `sod` en
  `SepaRemittanceRecord` (lista y detalle, `banking.read`); `topSuppliers` omite proveedores no
  resueltos (sin «Unknown supplier»); `openapi.yaml` 761/1.031 operaciones (+14 a mano);
  `api-integration.test.mts` con tenant aislado `org_l2_it<run>` (las dos suites «Tanda 4» ya no
  escriben en la primera propiedad de la BD); recuento en la organización piloto el 2026-09-20:
  21 `RESERVATION_CREATED` + 7 `ROLE_CREATED_FROM_TEMPLATE` en `audit_events`, 0 filas residuales
- tests y RBAC: `pms-shadow-{routes,sync}` con «hoy» en la zona del hotel (`tests/integration/helpers/local-day.mts`,
  sin flake 00:00-02:00 CEST; 19/19 y 10/10); `quick-checkin.spec.ts` «solo teclado» crea su llegada
  (`provisionArrival`) y CORRIÓ en run 2 (R1): `playwright.config.ts` acepta `E2E_CHROMIUM_EXECUTABLE`
  (headless shell 1228 en caché, sin descarga ni cambio del lock) → 1 passed (3,8 s) con API :3927 y
  Vite :5197 propios; residuos low: ventana 00:00-02:00 CEST de `front-desk.service.ts:303` (REV-04) y
  sin teardown (REV-05: RES-00056 `checked_in` en `room_uxday_101`, RES-00055 cancelada con
  penalización de 89 €, hasta `db:seed:ux-day -- --reset`); `payroll_hr` + `users.read` aditiva sin
  bump (`rbac:sync --dry-run` `+0 created · 3 topped up`; el arranque del API tras la fusión la
  entrega a los 3 roles; REV-06: la clave abre 3 rutas GET, no solo `/rbac/users`)
- docs: manual sin los defectos ya corregidos por FIX-1 (8 guías/fichas) y en concordancia con
  F9/F10 y C4b (R3: «Falta 1 comprobación» ×10, `30-rrhh.md` alta de fichas + `users.read`,
  ficha 10 «Tomar» asigna, `RBAC-DEPARTAMENTOS.md` M21 RRHH `V⁴`; contrato 45/45);
  `docs/runbooks/auditoria-eventos.md` §6 (T9, CHK, FIX-1, `SEPA_REMITTANCE_GENERATED`);
  `openapi.yaml` sin las 2 rutas retiradas de T9, con `PATCH …/check-in/guests/{guestId}`,
  `POST …/check-in/resolve-handoff` y `dryRun`; `api-contracts.md:236` bullet CIERRE-1 y `:595`
  `DOCUMENT_SETTINGS_UPDATED` con entidad `document_settings`; `[:<recepción>]` en `schema.prisma:150`
  y `finanzas-contabilidad.md:50`; §13 con `third-parties` y la remesa con `payables.pay` + SoD +
  auditoría; runbook Sage §3.2 (re-enmascarado por id, tokens de 7 cifras); residuo: ayuda in-app
  `manual-guides.ts:154` («No hay alta de fichas») contradice F10
- PII (fuera del repo): plan `prep/apply/remask-pii-vat.plan.json` (39 filas de
  `vat_book_entries.counterparty_name`) + `prep/tools/remask-pii-vat.sql`, dry-run `pendientes=39`,
  `remask-pii.test.mts` 8/8; el apply de F12 (331 entradas) YA está hecho (2026-09-20 03:48 UTC,
  `LEDGER_PII_REMASKED`), el de vat lo aplica César (informe §7.1)
- puertas `--quick` 12/12 en línea base (08:56 y 10:13), olas 1-2 de run 1 y olas 1-3 de run 2
  (11:07): typecheck 15 PASS · api unit 3.572 (3.571 pass · 1 skip; base 3.569) · admin-web 2.014 ·
  ai-core 119 · worker 34 · contratos raíz 765 (763 · 2 skip) · discoverability 197 · nav-tree
  70/104/205 · route-access 15 × 197 · cocoa §6 · rbac dry-run OK · migrate 24/24 + drift «No
  difference detected.»; puerta completa final (2026-09-20 11:13, `scratchpad/CIERRE-1/gates-final.json`):
  13/14 en ese run — las 12 anteriores + admin-web build OK · integración 994 (985 pass · 1 fail · 8 skip;
  CHK final 881/873/0/8) en rojo SOLO por COR-01 (`structure-l4` R2, 403 `payables.pay`; suite sola
  9 tests · 8 pass · 1 fail); **run 2 del orquestador con el fix de `:96` (`scratchpad/CIERRE-1/gates-full.json`):
  14/14, integración 994 · 986 pass · 0 fail · 8 skip**; puerta completa tras la 2.ª pasada del
  corrector (12:49-12:55, `gates-final.json` sobrescrito): **13/14** — typecheck 15 PASS · api unit
  3.574 (3.573 · 1 skip) · admin-web 2.015 (2.014 · 1 skip) · ai-core 119 · worker 34 · contratos
  raíz 765 (763 · 2 skip) · discoverability 197 · route-access 15 × 197 · cocoa §6 · rbac dry-run OK ·
  migrate 24/24 + drift 0 · build OK · integración 996 (989 pass · 0 fail · 7 skip); la única roja,
  `nav-tree --check`, es EXTERNA al carril: el CSV compartido `pilots/tanda5-nav-tree.csv` cambió a
  las 12:19 (+6 filas de la Tanda ACT, `/finanzas/activo-inmobiliario*`, sin pantalla en este
  worktree), `nav-tree.generated.json` es idéntico a HEAD y estaba en verde con ese JSON a las 11:45;
  vuelve a verde al fusionar ACT y regenerar el árbol (informe §2.4); `--quick` del integrador tras
  sus ediciones (13:05): 11/12 con la misma roja; hook `hotelos/.husky/pre-commit` a mano rc 0
- datos: 0 escrituras de negocio en la organización piloto por los lotes (53.291 filas Sage siguen
  con `regime IS NULL`, 0 `VAT_BOOKS_RECLASSIFIED`); tenants de tests creados y borrados (0 residuos
  antes y después de la completa; `organizations` = 3); los audit_events de la organización piloto
  (08:50-08:52 y 11:09:53 CEST: rol + 3 reservas, borrados) los produce la suite preexistente
  `tests/integration/api-integration.test.mts` (`findFreeRoom` = `room.findFirst` sin filtro de
  propiedad) al correr contra la BD viva → tenant propio para la suite o BD de carril para la
  completa (informe §4); 49 `webhook_deliveries` huérfanas anteriores a la tanda (REV-08, César);
  recuento del integrador (13:00, SQL de solo lectura): `organizations` = 3, residuos de tenants 0,
  organización piloto con 21 `RESERVATION_CREATED` / 7 `ROLE_CREATED_FROM_TEMPLATE` en el día y 0
  eventos desde las 12:45 → la completa de las 12:49-12:55 ya no escribió en ella (REVF-01 cerrado)
- para César: apply de `remask-pii-vat` (informe §7.1; decidir antes si `after` = solo token),
  decisión C5 `POST /fiscal/vat-books/reclassify` 2025/2026 (§7.2: dry-run → apply → comprobar
  `/fiscal/regime`, 390 y 303), reset de `prop_uxday` y huérfanas de webhooks, y el lock: HEAD
  `a069906` no instala con `--frozen-lockfile` (falta `packages/ai-core`, `@playwright/test`,
  `@fontsource-variable/inter`, `zod` del admin-web, `qrcode-terminal`; conserva `apps/ai-gateway`)
  → commit `chore(deps)` propio con el lock regenerado; orquestador: sellar la v4 de plantillas
  (`--upgrade-templates`), fusión de `tanda-cierre` (commit único sin `pnpm-lock.yaml`; regenerar el
  nav-tree tras ACT; decidir si el bloque CIERRE-1 de CLAUDE.md se conserva o queda solo este) y
  alinear `core.hooksPath` (hoy `.husky` relativo a la raíz del worktree, donde no existe: `git
  commit` no ejecuta `hotelos/.husky/pre-commit` en ningún carril; el integrador lo corrió a mano)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda UX-2 · «Feel» de dirección + ronda de corrección UX2-REV + integrador,
2026-09-20; worktree `~/anfitorio-demo-wt-ux2/hotelos`, rama `tanda-ux2` sobre `a069906`, BD `hotelos_ux2`;
commit del integrador en la rama, sin push; `:3000` y `:5173` sin reiniciar — sirven el código anterior a
la tanda; informe `docs/audits/TANDA-UX2-DIRECCION-2026-09-20.md`; diseño `docs/design/UX-DIRECCION-FEEL.md`;
runbook `docs/runbooks/ux-direccion-pruebas.md`):
- sin migración (24 aplicadas, `migrate status` «up to date», drift «No difference detected.»), sin rutas
  nuevas ni cambios en el manifiesto, `permissions.ts` ni `pilots/tanda5-nav-tree.csv`; seed aditivo e
  idempotente `db:seed:ux-direccion` (tenant `org_uxday` / `prop_uxday_b` «Hotel UXDAY B (prueba)», 20 hab.,
  17 reservas `UXDB-*`, cierre de anteayer pendiente de revisión, 3 aprobaciones, 3 ítems IA y 20 snapshots
  diarios, `director@uxday.test` con la contraseña de demo por defecto —nunca impresa—, `--reset` acotado a
  `prop_uxday_b`, con el API parado); Faranda solo lectura en toda la tanda
- 10 lotes (D0 diseño · D1 seed · D2 medida «antes» · D3 servicio y panel del director · D4 aprobaciones e
  IA · D5 cartera y ficha · D6 centro de informes y catálogo · D7 cierre del día · D8 contenido y persona ·
  D9 cierre) + corrección UX2-REV + integrador: 40 ficheros modificados (+2.222/−609 sin el lock) y 31 nuevos
  (4.884 líneas); `GET /dashboards/general-manager`, `portfolio` y `property-overview` resuelven «hoy» con
  la fecha de negocio de cada propiedad (`readGmBusinessDate` + `resolveGmWindow`; `businessDate` /
  `businessDateSource` aditivos) y cada pantalla dice su ventana; catálogo de informes en español y fichero
  `informe-<tipo>-<propiedad>-<desde>_<hasta>.<ext>`; Mi día › Dirección en español con «Riesgos de hoy» y
  subtítulo con la ventana; tarjeta «Pendientes · N aprobaciones · M de la IA»; una primaria «Aprobar» por
  fila con diálogo nominal (dinero) y commit diferido + `CocoaUndoBar` 8 s en la cola de la IA; Cartera
  «Tabla · Comparar» con delta vs media y «PyG del hotel» desde la ficha; Centro de informes con rango real
  y formato honesto; «Cerrar día» solo con `night_audit.run` y callout «Marcar como revisado» (⌥V) del
  último cierre pendiente; letras de acceso A · E · V y comandos ⌘K de tarea en las ocho pantallas; 0
  `style=` inline nuevos (inventario Cocoa regenerado); contratos nuevos
  `tests/ux-direccion-contract.test.mjs` (72) y `tests/seed-ux-direccion-contract.test.mjs` (9)
- medida estricta (`MEASURE_STRICT=1`, specs `e2e/measure/d1…d6` desde el árbol, 8/8,
  `docs/audits/ux-direccion/measure-correccion-2026-09-20.json`, 12:37Z; baseline
  `measure-baseline-2026-09-20.json`, 09:41Z, antes de tocar pantallas): d1 0 clics · 11 pet. · ventana
  pintada; d2 4 → 3 clics; d3 2 (teclado 0 clics · 41 teclas); d4 2 (2 hoteles con delta; vista Comparar 3);
  d5 2 (teclado 0 · 41); d6 4 → 3; las seis completadas y dentro de objetivo (≤ 4 brief, d2-d6 ≤ 3, ≥ 2 solo
  teclado); pasada completa d + t 11/14 en D9 (d2/d6 corregidas después; t1 15 pet. > 12 por el cajón de
  check-in de CHK, no por UX-2)
- revisión v3: 9 hallazgos confirmados (1 high · 8 medium), 0 refutados; corregidos 8 + 10 low (Cartera y
  ficha en la fecha de negocio con el mismo lector que Mi día; commit diferido en la IA; rótulos ingleses a
  0; specs d2/d6 al camino entregado; seed con snapshots y tercer ítem; contrato de dirección; D-1 corregida
  —solo `manager` revisa el cierre—; `business_dates."current_date"` leída como columna —prop_123 =
  2026-09-14, Faranda 09-16/09-17/09-19— y `l2-paginacion` anclado en `businessDate`; `CocoaState`
  `role="none"`; `CocoaUndoBar` sin nacer pausada; bandeja sin desplazamiento a 1024; callout del cierre en
  el primer viewport); sin cambio con motivo: lock (regla del carril), dos `GET /approvals` al aterrizar
  (UX-3), generados y nav-tree (orquestador)
- puerta completa final (`scratchpad/UX-2/gates-final.json`): 13/14 — typecheck:all 15 PASS · 0 FAIL · 1
  SKIP (28,1 s) · api unit 3.589 (3.588 pass · 0 fail · 1 skip) · admin-web unit 2.133 (2.132 · 0 · 1) ·
  ai-core 119/119 · worker 34/34 · contratos raíz 833 (831 pass · 0 fail · 2 skip) · discoverability 197 URL
  · route-access 15 × 197 · cocoa waves al día · rbac dry-run 187 ms · migrate 24/24 + drift 0 · build
  2,97 s · integración 983 (975 pass · 0 fail · 8 skip); puerta rápida del integrador
  (`scratchpad/UX-2-INT/gates-integrador-quick.json`) 11/12 con las mismas cifras (typecheck 22,5 s, rbac
  249 ms); `.husky/pre-commit` ejecutado a mano desde `hotelos/` (el `hooksPath` relativo `.husky` no existe
  en la raíz del worktree): 15 PASS · 23,0 s; `nav-tree --check` rojo SOLO por el CSV compartido (304 filas
  con `DirectorLaborCostsScreen` y pestañas `HrEmployeesScreen` de RRHH/ACT sin pantalla aquí): regenerar
  `nav-tree.generated.json` en la fusión
- pendientes con dueño (informe §6-§7): `pnpm-lock.yaml` NO se commitea desde el carril (diff ajeno
  +64/−25; navegadores 1243 ausentes: enlaces en el scratchpad); decisión RBAC para César sobre
  `night_audit.review` en `general_manager` (d6 no completable para dirección general); sesiones con
  directores reales (kit en el runbook); bloque UX-2 en `CLAUDE.md` añadido por el corrector (retirar en la
  fusión si main mantiene la política de L6a); recortes: sin menú «Más ▾» y `RevenueExportCenter` sin
  comandos de tarea; dos `GET /approvals` al aterrizar (UX-3); DOC: `docs/manual/10-direccion.md:87-88`,
  `:223`, `:226`, `:258` obsoletos

Estado verificado (Tanda UX-2 · «Feel» de dirección + ronda de corrección UX2-REV, 2026-09-20,
rama `tanda-ux2` sobre `a069906`; detalle en `docs/audits/ESTADO-VERIFICADO.md` y en el informe
`docs/audits/TANDA-UX2-DIRECCION-2026-09-20.md` §6):
- diseño `docs/design/UX-DIRECCION-FEEL.md` (9 lotes D0-D9): persona de dirección (director de
  hotel `manager` · dirección general `general_manager`), seis tareas medidas d1…d6 sobre el tenant
  `org_uxday` / `prop_uxday_b` (`db:seed:ux-direccion -- --reset`, con el API parado); sin migración,
  sin rutas nuevas ni cambios en `permissions.ts`
- una verdad por dato: `GET /dashboards/general-manager`, `portfolio` y `property-overview` resuelven
  «hoy» con la FECHA DE NEGOCIO de cada propiedad (`readGmBusinessDate` + `resolveGmWindow`;
  `businessDate` / `businessDateSource` aditivos) y cada pantalla dice su ventana; Mi día › Dirección
  en español con «Riesgos de hoy» y comandos ⌘K de tarea; una primaria «Aprobar» por fila con diálogo
  nominal (dinero) y commit diferido + `CocoaUndoBar` 8 s en la cola de la IA; Cartera «Tabla · Comparar»
  y «PyG del hotel» desde la ficha; Centro de informes con rango real y formato honesto; «Cerrar día»
  solo con `night_audit.run` y callout «Marcar como revisado» (⌥V) del último cierre pendiente
- medida estricta desde el árbol (`e2e/measure/d1…d6`, `measure-correccion-2026-09-20.json`): d1 0 ·
  d2 4 → 3 · d3 2 (teclado 0) · d4 2 · d5 2 (teclado 0) · d6 4 → 3 clics; contratos
  `tests/ux-direccion-contract.test.mjs` (regiones vivas, comandos, 0 inglés, 0 fechas literales,
  specs y helper) y `tests/seed-ux-direccion-contract.test.mjs`
- pendientes con dueño: `pnpm-lock.yaml` no se commitea desde el carril (bump ajeno de Playwright);
  `nav-tree --check` con el CSV compartido tras fusionar ACT; decisión RBAC para César sobre
  `night_audit.review` en `general_manager` (hoy solo `manager` revisa el cierre); dos `GET /approvals`
  al aterrizar (UX-3); manual `docs/manual/10-direccion.md` obsoleto (DOC)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda L8 · Integraciones honestas, 2026-09-20, worktree
`~/anfitorio-demo-wt-l8/hotelos`, rama `tanda-l8` sobre `a069906`, BD `hotelos_l8`, commit del integrador en
`tanda-l8` (sin push, sin fusión en `main`); `:3000` sin reiniciar; informe `docs/audits/TANDA-L8-INTEGRACIONES-2026-09-20.md`; runbook
`docs/runbooks/integraciones.md`):
- qué se construyó por lote: L8-01 contrato compartido `packages/shared/src/integrations-status-types.ts`
  (`INTEGRATION_KEYS` 18, `IntegrationStatusDto`, `IntegrationsHealthBlock`, etiquetas y pantallas en español) +
  servicio `apps/api/src/modules/integrations/integrations-status.service.ts` (una función pura por integración,
  `collectIntegrationsStatus` con `createDegradedCollector`, `describeIntegrationsHealth` sin BD; 44 casos) + hub
  heredado honesto (readiness `payment_provider_connected` por `pspStatusFor`, `checks.redis` «configured (sin
  consumidor en este build)», `dependencies.redis` `unconfigured`); L8-02 proveedores del hub «… (demostración)»
  con `demo:true` / `mode sandbox`, prueba de conexión `{ status: "simulated" }` + evento `IntegrationTestSimulated`,
  `PATCH` de estado persistido y auditado (9 casos); L8-03 `delivery-outcome.ts` (`simulated` = `sent` + «SIMULADO»),
  KPI «Enviadas» solo reales + «N simuladas (sin proveedor)», `GET /notifications/template-stats` con `simulated`
  (8 casos); L8-04 runbook v1 + auditoría de textos (`scratchpad/L8/audit-textos.md`: 9 éxitos falsos, 9 parciales,
  0 descargas vacías); L8-05 `GET /integrations/status?propertyId=` (`integrations-status.routes.ts`,
  `route-permissions.partial.ts`) + clave superior `integrations` de `/health` (14 claves `INTEGRATION_HEALTH_KEYS`)
  en `server.ts` y `docs/api-contracts.md`; L8-06 `IntegrationsStatusPanel.tsx` + `integrations-status-helpers.ts` +
  `services/integrationsApi.ts` encima de `MarketplaceCatalogScreen` (KPI por modo, tabla por área, «Configurar»,
  aviso de consultas degradadas; 15 casos); L8-07 Pagos lee la fila `psp` del estado y muestra el hub como
  «Conexiones de demostración (catálogo heredado)», Exportar a gestoría «compatible ContaPlus / Sage 50» y A3 «no
  disponible», `GoLiveChecklist` «PSP configurado», guía de revenue y `api-reference` sin «sincronizadas con las
  agencias» / «descargar reservas», manual §3.3 (8 casos); L8-08 contrato raíz `tests/integrations-honesty-contract.test.mjs`
  (21 casos, fuente sin BD: una función por clave en el servicio, una fila por clave en el runbook §1 y una entrada
  en `api-contracts.md`, 14 claves de `/health`, `none` / `sandbox` nunca simulan un éxito, Pagos sin `gatewayReady`
  del hub), integración `tests/integration/integraciones-estado.test.mts` (10 casos: 401 / 403 recepción y owner /
  200 dirección general y sistemas sobre organización aislada con `RBAC_STRICT`, `withEnv` con tope `stub` y sin
  claves, `/health.integrations` público, hub `simulated`, invariantes de Faranda) y
  `apps/admin-web/e2e/integrations-status.spec.ts` (entradas en el árbol a las 13:27); L8-09 runbook v2 (§0-§6: línea base real, códigos, `degraded`, panel, comandos exactos), CLAUDE.md (deuda 19
  + «Docs prioritarios») y este bloque
- rutas y permisos: 1 ruta nueva `GET /integrations/status` (`integrations.read`, riskLevel low; manifiesto vía
  `INTEGRATIONS_STATUS_ROUTE_PERMISSIONS`; tenencia `grantPropertyAccess`: 404 opaco fuera de la organización o sin
  asignación, 400 con `propertyId` vacío, 403 recepción) y la clave superior `integrations` de `/health` (pública:
  solo modo + frase, ≤ 260 caracteres por contrato y 198 la más larga hoy, sin URLs ni variables secretas; nunca
  degrada `status`); 0 claves RBAC nuevas (`rbac:sync --dry-run` limpio), 0 migraciones (`migrate status` 24/24,
  drift «No difference detected.»; nombre reservado `20260920180000_integraciones_honestas` sin usar), 0 rutas de
  front nuevas (panel en `/configuracion/modulos/integraciones`, fila 85 del CSV; `IntegrationsStatusPanel` en
  `.discoverability-whitelist.json`), 0 dependencias nuevas
- línea base real del carril (2026-09-20, `scratchpad/L8/health-base.json` + SQL solo lectura): `/health` healthy,
  `checks.redis` «configured» sin consumidor, `checks.sentry` disabled, `checks.verifactu` `mode=sandbox` +
  `software.ok:false` (3 errores: razón social y NIF del productor, número de instalación), `checks.sesHospedajes`
  `mode=sandbox`, `checks.ai` `provider=none`, `objectStorage inline`; BD: 7 canales `sandbox` (6 activos, en dos
  propiedades), 1 perfil OPERA `active` (9 runs), 50 lotes Sage 200 `posted`, 0 PSP, 0 buzones OAuth, 1 fuente de
  reseñas `csv`, 222 entregas de correo «SIMULADO» + 1 real, 66 acuses VeriFactu y 9 SES del stub + 149 SES
  fallidas, 1 conexión ficticia del hub
- verificado en runtime (L8-09, 13:33, instancia propia `:3949` con el árbol final, PID matado al terminar; `:3935`
  lo sirve una instancia hermana del worktree, PID 86954, no tocada): `/health.integrations` 14 claves → 1 real
  (`gestoria_export`) · 7 sandbox · 6 none; `GET /integrations/status` `prop_123` (contexto demo) → 18 filas, 2 real
  (`gestoria_export`, `gbp` por CSV con requisitos pendientes) · 7 sandbox (`channels` «3 de 3 canales activos, todos
  en simulador local», `whatsapp`, `email_out`, `sms`, `ses` con `lastError`, `verifactu`, `storage`) · 9 none,
  `degraded: []`; `prop_uxday` con `direccion@uxday.test` → 200 (1 · 6 · 11; 1 · 5 · 12 tras el corrector L8: `ses` `none` por el interruptor del establecimiento); `recepcion@` 403; `direccion@` sobre
  `prop_123` 404 «Propiedad no encontrada.»; `propertyId=` vacío 400; sin `propertyId` 200 (contexto). Ningún nombre
  de persona en ninguna salida; Faranda solo lectura
- tests de la tanda (2026-09-20 13:35, ficheros de los lotes): api `integrations-status` + `legacy-hub` 53/53 ·
  admin-web `integrations-status-helpers` + `integrations-copy` + `delivery-outcome` 31/31 ·
  `node --test tests/brand-contract.test.mjs tests/integrations-honesty-contract.test.mjs` 31/31 (13:40, el
  contrato de honestidad lee el runbook §1) · contratos que leen CLAUDE.md (`manual-contract`,
  `rate-grid-docs-contract`, `migrations-squash-contract`) 35/35; `integraciones-estado` (integración) y la spec e2e
  de L8-08 las ejecuta la puerta de la ola 3
- puertas (`--quick`, `scratchpad/L8/gates-*.json`): base 11:56 12/12 (api unit 3.569 · admin-web 2.014 · contratos
  raíz 765 · discoverability 197 · nav-tree 70/104/205 · route-access 15 × 197); ola 1 12:48 11/12 (api 3.622 ·
  admin-web 2.022); ola 2 13:15 11/12 — typecheck:all 15 PASS · 0 FAIL · 1 SKIP (22,7 s) · api unit 3.622 (3.621
  pass · 1 skip) · admin-web unit 2.045 (2.044 pass · 1 skip) · ai-core 119 · worker 34 · contratos raíz 765 (763
  pass · 2 skip) · discoverability 197 URL · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK ·
  migrate 24/24 + drift 0; el único rojo desde la ola 1 es `nav-tree --check` por el CSV compartido
  `pilots/tanda5-nav-tree.csv` (filas de otro carril, 294 → 300): no es de L8. Puerta completa final del orquestador
  (`scratchpad/L8/gates-full.json`): **13/14** — typecheck 15 PASS · 0 FAIL · 1 SKIP; api 3.622; admin-web 2.045; ai-core 119;
  worker 34; contratos raíz 786 (784 pass · 0 fail · 2 skip) tras añadir `integrations-status.spec.ts` a
  `seed-ux-day-contract` (l.164/188) y corregir el flaky de `payments-tenancy` #1 (`correlationId` fuera del cuerpo
  comparado); discoverability 197; route-access 15 × 197; cocoa waves §6 al día; rbac OK; migrate 24/24 + drift 0; build
  OK; integración 993 (985 pass · 0 fail · 8 skip); único rojo `nav-tree --check` (CSV compartido, externo).
  **Puerta completa tras el corrector** (`scratchpad/L8/gates-final.json`, 15:09): **13/14** — typecheck 15 PASS · 0 FAIL ·
  1 SKIP (34,3 s); api 3.636 (3.635 pass · 1 skip); admin-web 2.053 (2.052 · 1 skip); ai-core 119; worker 34; contratos
  raíz 787 (785 · 0 fail · 2 skip); discoverability 197; route-access 15 × 197; cocoa waves §6 al día; rbac OK; migrate
  24/24 + drift 0; build 3,24 s; integración 993 (985 · 0 fail · 8 skip); único rojo `nav-tree --check` (`stale`: el CSV
  compartido tiene 304 filas —L6b / L7: `/hoy/costes-personal`, `/finanzas/nominas/*`, «RRHH y nóminas»; ACT:
  `/finanzas/activo-inmobiliario/*`— frente a 294 del JSON del worktree, que se entrega sin diff)
- corrector L8 (2026-09-20, tarde; revisión funcional + seguridad): (REV-01) `ses` / `verifactu` / `tbai` de
  `GET /integrations/status` aplican el interruptor del establecimiento o el uso real (`complianceGates`,
  `integrations-status.service.ts`): apagado y sin uso → `none` «Desactivado para este establecimiento…» + «Activar … para
  el establecimiento» en `missingForReal`; activo solo por uso → nota en la frase; `/health` habla del proceso; (REV-03)
  `/health.integrations` ya no consulta la BD: `describeComplianceEnvironment()` (solo entorno, `getTbaiHealth(null)`)
  sustituye a `getComplianceHealth()` sin organización (leía las propiedades de todos los tenants por petición pública);
  (REV-02) textos: KPI «Enviadas · registradas como enviadas (sin motor de envío)» en Campañas, SES «Aceptado (simulador)»
  y «Simulador local» en vez de `stub://` (`simulatorAwareStatusLabel`, `fiscal-shared.ts`), manifiesto de
  `packages/integrations` con `demo:true` / `mode:"sandbox"` / «(demostración)» y `apps/mobile` sin «connected», manuales
  10/20 con la pestaña Pagos real; (low) «Actualizar todo» recarga también el panel (`refreshKey`), vacío honesto de
  «Aplicaciones instaladas», badge de estado persistido en las conexiones de demostración de Pagos y fixture sin
  `lastSyncAt` (fila `iconn_mock_payments` de `hotelos_l8` puesta a NULL), `sage200` «en la sociedad», `missingForReal`
  sin punto final, `propertyId` sin `trim` (documentado: espacios ⇒ 404), `CocoaStatusBar` borrado,
  `countPropertyIntegrationErrors` solo siembra las fixtures del hub para la propiedad demo (`legacyFixturesApplyTo`);
  tests: `integrations-status.test.mts` 50 (+6), `integrations-status-routes.test.mts` 3 (nuevo), `legacy-hub` 11,
  `compliance-health` 6, `fiscal-shared` +3, `integrations-copy` +7, contrato de honestidad 22
- pendientes con dueño: (orquestador / fusión) la puerta completa tras el corrector ya incluye `integraciones-estado` (10/10);
  la e2e de L8-08 queda fuera de `gates.sh` hasta alinear `@playwright/test` con el navegador instalado (lock de `main`:
  fijar 1.61.x o instalar chromium 1243); regenerar
  `nav-tree.generated.json` en el carril dueño de las filas nuevas del CSV; comprobar en la fusión
  `node scripts/cocoa-22-inventory.mjs` y `node scripts/env-census.mjs --write` (ya regenerados en el carril por
  otros lotes); `git checkout -- pnpm-lock.yaml`; reiniciar las instancias hermanas `:3935` / `:5205` para ver el
  panel con datos; (producto) `gestoria_export` declarado `real` / `manual` aunque nada cruce por red (D-04), `disk`
  como `sandbox` del almacén (D-13), «Formatos A3 y Sage 200 no implementados» solo en el API (unificar con la
  pantalla de gestoría), `redis` (D-16), catálogo del hub (D-17); B2-B6 de la auditoría de textos y los comentarios
  `QuickCheckInDrawer.tsx:45` / `e2e/quick-checkin.spec.ts:18` (el manifiesto de `apps/mobile`, los manuales 10/20,
  A8, A9, B1 y los lectores solo-configuración de `/health` los cerró el corrector L8); (César)
  D-01…D-18 del runbook §4 (hotel codes y muestras OPERA, decisiones Sage, cuenta Channex, PSP, WhatsApp Business,
  correo transaccional, declaración responsable VeriFactu, alta SES y certificado, OAuth de buzones, Google Business,
  almacén, clave de IA con DPA, Sentry, Redis, marketplace, EIPD)
- integrador (cierre de la tanda, 2026-09-20 tarde): `git status` / `git diff --stat` del worktree confirmados —
  40 ficheros modificados (sin `pnpm-lock.yaml`), 1 borrado (`CocoaStatusBar.tsx`) y 19 nuevos (informe §8); `pnpm-lock.yaml`
  excluido del commit (`git reset -q hotelos/pnpm-lock.yaml`), `apps/admin-web/dist/` y `test-results/` ignorados; ninguna
  instancia del carril viva; informe con §10 (por lote), §11 (hallazgos: 5 medium confirmados, 0 refutados, 4 + 7 low
  corregidos, 4 sin corregir con dueño), §12 (14 decisiones para César con el defecto aplicado) y §13 (cierre); contratos que
  leen `docs/audits` tras la edición: `node --test tests/brand-contract.test.mjs tests/manual-contract.test.mjs tests/integrations-honesty-contract.test.mjs` → 47/47 (brand 10 · manual 15 · honesty 22); puerta `--quick` del integrador (`scratchpad/L8-int/gates-quick.json`):
  **11/12** — typecheck:all 15 PASS · 0 FAIL · 1 SKIP (23,6 s); api unit 3.636 (3.635 pass · 1 skip); admin-web unit 2.053 (2.052 · 1 skip); ai-core 119; worker 34; contratos raíz 787 (785 · 2 skip); discoverability 197 URLs; route-access 15 × 197; cocoa waves §6 al día; rbac:sync dry-run OK; migrate status + drift «No difference detected.»; único rojo `nav-tree --check` (externo, sin cambio en el árbol tras la puerta); commit en `tanda-l8` con el pre-commit del repo (`check-discoverability` + `typecheck-all`): un solo commit con `git add -A hotelos` + `git reset -q hotelos/pnpm-lock.yaml` + `git commit -F <mensaje>` (autor cesareme), 60 ficheros (40 modificados · 1 borrado · 19 nuevos), título «feat(integraciones): estado honesto none|sandbox|real, GET /integrations/status, bloque integrations en /health y panel de la pestaña Integraciones (Tanda L8)», cuerpo por lote, pre-commit (`check-discoverability` + `typecheck-all`) sin `--no-verify`; el sha va en el informe estructurado del integrador al orquestador

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda ACT · Activo inmobiliario, 2026-09-20; rama `tanda-act` sobre a069906,
worktree `~/anfitorio-demo-wt-act/hotelos`, BD `hotelos_act`; informe
`docs/audits/TANDA-ACT-ACTIVOS-2026-09-20.md` §1-§12; revisado (2 revisores + refutador + corrector) y
commiteado en la rama por el integrador ACT-INT, sin push ni fusión):
- entregables: módulo `apps/api/src/modules/real-estate/*` (32 ficheros · 5.808 líneas + 14 suites puras · 2.715;
  diseño `docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md` con las notas «Estado tras la implementación» §7/§9, runbook
  `docs/runbooks/activo-inmobiliario.md`, contrato `docs/api-contracts.md` «Activo inmobiliario (Tanda ACT · 2026-09-20)»):
  **42 rutas en 6 partials** (`core-` 12 · `taxes-` 9 · `documents-` 6 · `works-` 4 · `inspections-` 7 · `group-` 4;
  agregador `route-permissions.partial.ts` solo spreads; manifiesto 1.031 → **1.073**, cargado con tsx) bajo
  `/properties/:propertyId/real-estate*`, `/organizations/:organizationId/real-estate/{overview,calendar,export}` y
  `/capex-projects/:id/{approve,work,capitalize}`, todas registradas por `real-estate.register.ts` desde `server.ts`
  (`real-estate-core` cruza las 42 entradas de los partials con `app.hasRoute`; las suites ya no cablean rutas de
  reserva); **0 claves RBAC nuevas** (las 4 de T8a: `real_estate.read | manage | documents.manage`,
  `property_tax.manage`; catálogo 254, `rbac:sync --dry-run` +0 / 0 stale); ficha con unidades registrales, cargas,
  valoraciones (sin asiento), tenencia (una vigente; al activarla propone el `taxpayer` de los IBI) y **KPIs y alertas
  completos** (= vista de grupo = `/alerts`); tributos con recibos previstos por `installmentsJson` o calendario municipal
  (Madrid 28079; resto LGT 62.3) y **asiento 631 propuesto en borrador** (`createJournalEntryDraft`,
  `PropertyTaxReceipt.journalEntryId`) que contabiliza `accountant` — un asiento contabilizado no se desenlaza (409
  `RECEIPT_ENTRY_EXISTS`), no hay segundo 631 por recibo, pagar con borrador lo regenera y con asiento contabilizado
  propone el asiento de pago D 475 / H 57x, `pagado → recurrido` permitido y los recurridos siguen en el motor de alertas;
  documentos con fichero sobre el almacén de T9 (`inline | disk | s3`, sha256, magic bytes, versiones, `legalHold`, sin
  `DocumentFile`; `cdeState wip` solo lo ve quien lo subió, `solo_propiedad` solo `real_estate.manage` / `owner`); obras
  con **aprobación por `POST /capex-projects/:id/approve`** (`asset.capex.approve`), `PATCH` heredado con máquina
  CAPEX_WORK, licencia, ICIO, ejecución por prefijos 21x del diario y capitalización sin asiento con fecha de fin de obra;
  inspecciones y pólizas con máquinas de estado, sucesora automática y `ComplianceItem` sincronizado; motor de alertas
  90 / 30 / 7 calculado en cada lectura; vista de grupo, calendario anual (etiquetas en español, periodos previstos con
  `entityType property_tax`) y CSV (BOM, `;`, CRLF, `csvCell` sin fórmulas); `REAL_ESTATE_ERROR_CODES` 18; NIF
  enmascarados en la auditoría de tenencias / unidades / cargas
- esquema: **10 modelos** (`RealEstateAsset`, `RealEstateUnit`, `RealEstateCharge`, `RealEstateValuation`,
  `RealEstateTenure`, `PropertyTax`, `PropertyTaxReceipt`, `RealEstateDocument`, `RealEstateInspection`,
  `RealEstateInsurance`) **+ 12 columnas** en `capex_projects`, migración aditiva y reversible
  `20260920170000_activo_inmobiliario` (SQL verbatim de `migrate diff`: 10 `CREATE TABLE`, 12 `ADD COLUMN`, 16 índices, 9
  FK en cascada, 0 enums, 0 `DROP`; tablas 296 → 306, enums 46); `migrate status` 25/25 «up to date» · `db:drift:check`
  «No difference detected.» · `check-migrations-vs-schema` OK
- front Cocoa 22: ítem **Finanzas › Activo inmobiliario** (`/finanzas/activo-inmobiliario`, core, orden 9, roles
  `finanzas|direccion|admin|activos|auditoria`; `roleHome("activos")` cambia de `/cumplimiento/centro`) con 6 pantallas
  `screens/realEstate/*` (Ficha · Documentación · Tributos · Obras · Inspecciones y seguros · Grupo; 7 ficheros · 6.515
  líneas + 7 suites · 2.377) y tab host `screens/tabs/finanzas/ActivoInmobiliarioTabs.tsx`, cliente
  `services/realEstateApi.ts` (42 funciones + `approve` y cuerpo opcional de capitalizar), 0 `style={}` nuevos (techo 647
  sin cambio), 6 filas en `pilots/tanda5-nav-tree.csv:295-300`, `nav-tree.generated.json` 71 ítems · 109 pestañas · 203 URLs
- seed `db:seed:real-estate` (tenant aislado `org_act` / `le_act` / `prop_act_a` propietaria + `prop_act_b` arrendataria de
  industria, usuarios `activos | contabilidad | direccion | recepcion@act.test`, contraseña `Act-Demo-2026!` o
  `ACT_DEMO_PASSWORD`, `--dry-run` / `--reset`, `assertDemoTarget` con `org_act` en `DEMO_ORG_IDS`; 2 fichas · 4 tributos
  · 5 recibos · 11 documentos · 4 inspecciones · 2 pólizas · 1 obra con asiento posted 212/572; Norte 7 alertas, Sur 2;
  OCA de ascensor con base «RD 355/2024 art. 11.4.a»); resto conocido: el asiento n.º 2 que contabilizó F4 quedó huérfano
  tras el `--reset` (informe §9.1 #15: enlazarlo al IBI PAC-01 o anularlo); Faranda solo lectura en toda la tanda (0
  escrituras; suites con tenants `org_l2_*` y limpieza, 0 residuales)
- ronda de revisión (20/09 13:20-14:56, informe §7): **12 hallazgos confirmados** (6 altos: rutas de documentos sin
  registrar, `PATCH /capex-projects/:id` sin máquina, 631 duplicable al desenlazar, borrador H 475 de un recibo pagado,
  aprobación de obras imposible por HTTP, ficha sin KPIs ni alertas; 6 medios: `taxpayer` del IBI, recurridos fuera del
  motor, `pagado` final, `cdeState wip`, suites que cableaban rutas, `solo_propiedad` sin aplicar) **+ 11 menores, todos
  corregidos con test** (51 ficheros del corrector; api unit 3.738 → 3.753, integración 1.048 → 1.060), **1 refutado**
  (alta de ficha sin tributos: decisión de arquitectura documentada) y 3 sin corregir con motivo (instancia huérfana
  inexistente, 403 de primera carga no reproducido, `pnpm-lock.yaml` intocable)
- puerta completa final (20/09 14:56, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD `hotelos_act`,
  `scratchpad/ACT/gates-final.json`): **13/14** · typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit
  3.753 (3.752 pass · 0 fail · 1 skip; base 3.569, +184) · admin-web unit 2.111 (2.110 · 0 · 1; base 2.014, +97) ·
  ai-core 119/119 · worker 34/34 · contratos raíz 789 (787 · 0 · 2; base 765, +24) · integración **1.060 · 1.052 pass ·
  0 fail · 8 skip** (las 6 suites `real-estate-*` incluidas: 77 tests) · discoverability 203 URLs · 0 huérfanas ·
  route-access 15 tokens × 203 URLs · cocoa waves §6 al día (inventario 252 pantallas · 175 puntos, techo 647 sin cambio)
  · rbac:sync dry-run OK (+0 claves · 0 stale) · migrate 25/25 + drift «No difference detected.» · admin-web build OK
  (3,1 s); **`nav-tree --check` en rojo por causa externa**: el CSV compartido `pilots/tanda5-nav-tree.csv` lleva 4 filas
  del carril RRHH (302-305, 71 ítems · 113 pestañas) sin pantalla en este worktree — contra una copia sin ellas «up to date
  (71 · 109 · 205)»; regenerar en main al fusionar con `tanda-rrhh` (esperado 71 · 113 · 207). Línea base del carril
  (`gates-base.json`) 12/12, puerta completa pre-revisión (`gates-full.json`) 14/14, cada ola 12/12 salvo la 5 (11/12:
  pantallas huérfanas hasta F4); ningún skip nuevo ni test debilitado (tests existentes editados: 3 pines de
  `DEMO_ORG_IDS` / seeds guardados + `refresh-demo-dataset` + `api-reference` (+1 `it`, literal de capitalizar pinado) +
  7 recuentos de navegación por el ítem y las 5 pestañas + `rbac-nav-contract` que ya lee `*route-permissions.partial.ts`
  + `ledger-engine` (+1 `it` de `csvCell`); 14 asserts eliminados = 14 re-anclados)
- verificación en runtime tras la corrección (ACT-INT, instancia propia `:3925` PID 37752 parada por PID, solo lectura,
  `scratchpad/ACT/smoke-int.out`; la de escritura en navegador la dejaron F4 y el revisor funcional en `:5195`):
  `activos@act.test` → ficha con `annualTaxBurden` 32.340,00 · `documentsValidPct` 87,50 · `inspectionsOnTimePct` 66,67
  · 7 alertas (2 altas) · 3 tributos = fila del grupo; documentos 200 (9; `?category=licencias` 1); `POST …/approve` 403
  «requiere: asset.capex.approve»; calendario «Pagado el 15/06/2026 · IBI 2026 (PAC-01)»; CSV con bytes `EF BB BF`;
  `propose-entry` sobre el PAC-01 del demo → 409 `RECEIPT_ENTRY_EXISTS` apuntando al asiento huérfano;
  `contabilidad@act.test` no ve el contrato `solo_propiedad` de Sur (1 documento frente a 2) y recibe 403
  `property_tax.manage` al crear tributos; `recepcion@act.test` 403 `real_estate.read`; 0 respuestas 5xx
- pendientes con dueño (informe §9): orquestador — docs desalineadas (runbook §11 `:469-470` aún dice «cableado
  pendiente» de tres cosas ya cerradas y §10 `:442` `dev -- --port`; `api-contracts:842` «1031 entradas» → 1.073; diseño
  §8 con 7 pestañas), asiento huérfano del demo, **hook pre-commit que git no encuentra** (`core.hooksPath=.husky` se
  resuelve contra la raíz del worktree; el hook vive en `hotelos/.husky` → ACT-INT lo ejecutó a mano), `export` de
  `real-estate.schemas` en `schemas/index.ts`, comentario `installmentsJson`, `PROPERTY_TAX_INACTIVE` fuera del
  catálogo, tipos duplicados del front (`RECEIPT_TRANSITIONS`, calendario, respuestas compuestas), `DEMO_PROPERTY_IDS`,
  `pnpm-lock.yaml` (+64 / −25 preexistente, excluido del commit: `git checkout --` para limpiar), regenerar
  `nav-tree.generated.json` en main; deuda funcional — `SafetyCheck` / mantenimiento, previstos en tesorería, fila FF&E
  de USALI, resumen diario, OCR, `PATCH /capex-projects/:id` sin `supervisorAuthorizationId` (`server.ts:6260`),
  comentario desfasado de `assets.service.ts:39-43 / :418-424`, datos reales de Faranda (catastral NULL ×8, titularidad,
  ordenanzas, pólizas, prefijos 21x, parámetros del asesor, almacén y umbrales: solo César, informe §10)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda L6b · Asistente ehotelOS unificado, 2026-09-20, integrador de la
tanda; informe `docs/audits/TANDA-L6B-ASISTENTE-2026-09-20.md` v3, runbook
`docs/runbooks/asistente-ia.md`):
- rama `tanda-l6b` sobre a069906 (BD `hotelos_l6b`, `:3933/:5203`), 11 lotes en 4 olas con
  ficheros exclusivos + puertas completas + 2 revisores (11 hallazgos confirmados, 0 refutados)
  + corrector (17 corregidos, 1 fuera del carril) + commit del integrador en la rama del carril:
  43 ficheros modificados (+2.958/−597) + 22 nuevos (6.538 líneas); `pnpm-lock.yaml` restaurado
  a HEAD y fuera del commit; sin dependencias nuevas; 0 `style=` nuevos (inventario Cocoa 22
  regenerado: 107.680 líneas · 171 puntos)
- núcleo conversacional único `modules/assistant/assistant-core.service.ts` (`runAssistantTurn`)
  sobre `@hotelos/ai-core`: memoria por usuario + propiedad + superficie (migración
  `20260920170000_asistente_unificado`: `assistant_conversations` + `assistant_messages`, 0
  enums; `content` y `title` cifrados por `PII_FIELDS`, redacción solo de tratamientos,
  documentos, teléfonos, correos y tarjetas; purga `[assistant.purge]` a los 90 días y supresión
  RGPD de los hilos `guest:<id>`), catálogo de 37 lecturas (12 locales + 10 del copiloto + 15 del
  registro) filtrado por RBAC × superficie × módulos, router por reglas con las 19 sugeridas al
  100 % sin proveedor y «otra fecha» explícita reconocida, tool use con proveedor (≤ 3 turnos,
  respaldo por reglas con aviso, puerta de propiedad `assistant-gate.ts` —aiEnabled · nivel ·
  presupuesto— antes de cada llamada directa, 13 escrituras solo como `awaiting_confirmation` y
  solo las que el usuario podría confirmar), prompts `assistant_backoffice/reception/guest`
  publicables, `screen` saneado en el núcleo (solo ids seguros), `AssistantTurn` v2 (`routedBy`,
  `citations`, `cost`, `pendingToolCalls`) y una fila `answerAnalyticsQuestion` por turno con
  huella de la pregunta (`questionChars` + `questionSha256`) y `cost_eur` 0 por reglas; rutas
  `GET /assistant/tools`, `POST /assistant/chat`, `GET/DELETE /assistant/conversations[/:id]`,
  `GET /assistant/pending` (manifiesto 1.031 → 1.035, 0 claves nuevas, resolver
  `assistantConversation` con 404 opaco; pendientes acotados a conversaciones y propuestas del
  propio usuario); `/copilot/ask` alias sobre el núcleo con el `UserContext` real y bot del
  huésped con clasificación y respuesta sobre el núcleo (superficie `guest`, actor
  `guest:<conversación>`)
- front: panel `components/assistant/*` montado una vez en `BackOfficeLayout` (botón «Asistente
  ehotelOS», menú compacto, ⌘K «Preguntar al asistente…» que abre hilo nuevo, evento
  `hotelos-open-assistant`, superficie `reception` en la categoría «Recepción», lista de
  conversaciones por superficie, citas correctas al reabrir), `/asistente` con el mismo hilo,
  Pendientes IA ejecuta al aprobar (`POST /ai/tool-calls/:id/confirm`), pantallas de IA honestas
  («Sin modelo»/«En uso», coste NULL «—», `skipped`); e2e `apps/admin-web/e2e/assistant-panel.spec.ts`
  (5/6 medidos por L6b-10 antes de corregir la cita al reabrir; fuera de las puertas hasta
  instalar chromium 1243)
- verificación en runtime sin proveedor (instancias propias, tenant UXDAY y `org_chk`; runbook
  §11; `scratchpad/L6b-REV/*`, `scratchpad/L6b-corr-walk.json`): catálogo 31 herramientas · 19
  sugeridas, turno por reglas con cita `get_arrivals_today · prisma:…today(Property.timezone)` y
  coste 0, «hoy (20/09/2026)» en el resumen, memoria por `conversationId`, privacidad entre
  usuarios de la misma propiedad (lista sin ella · 404 · 404), `title` en reposo `v1.`,
  `input_json` sin `question`, `screen.url '/recepcion/huespedes/_'`, recepción solo ve
  `assignRoom` como escritura, alias del copiloto a nombre del usuario, `shift_summary`/
  `aggregated`, 204 → 404, 401 sin sesión, 400 vacía; navegador: ⌘K → panel «POR REGLAS» ·
  «sin coste», conversación reabierta con citas, compositor 591/640 px, cola con «Aprobar y
  ejecutar» → «Ejecutada» / «Rechazada» / «Caducada» / «Sin permiso»
- cifras de la puerta completa final (2026-09-20 15:00, `scratchpad/L6b/gates-final.json`):
  13/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP · 22,6 s · api unit 3.647 (3.646 pass ·
  0 fail · 1 skip) · admin-web unit 2.063 (2.062 · 0 · 1) · ai-core 119 (119 · 0 · 0) · worker 34
  (34 · 0 · 0) · contratos raíz 772 (770 · 0 · 2) · discoverability 197 · nav-tree --check ROJO ·
  route-access 15 tokens × 197 URLs · cocoa waves §6 al día · rbac:sync dry-run OK (+0 claves) ·
  migrate status 25/25 + drift «No difference detected.» · admin-web build 3,07 s · integración
  993 (985 pass · 0 fail · 8 skip). Única roja externa al carril: `nav-tree.generated.json`
  (idéntico a HEAD) frente al CSV compartido avanzado por RRHH/ACT con pantallas que no existen en
  este worktree → regenerar en la fusión. Línea base del día: 12/12 rápidas (api unit 3.569 ·
  admin-web 2.014 · contratos 765). Puerta rápida del integrador tras las docs: informe §3.2
- pendientes con dueño (informe §6, runbook §12 N1-N9): regenerar `nav-tree.generated.json` sobre
  el árbol con RRHH/ACT y el lock una sola vez (`--frozen-lockfile` falla por `@playwright/test`/
  `zod`/`@fontsource-variable/inter` de admin-web, preexistente); renumerar la migración si otro
  carril aporta una marca posterior; `CLAUDE.md` conflicto manual (tomar `tanda-l6b`); e2e del
  panel con navegador instalado; `general_manager` sin `maintenance.workorder.manage`; `/copilot/*`
  alias (resolvers en UTC) y `AiIntent` sin consumidor; tool use y prompts publicados sin humo con
  clave real; residuos sintéticos en `hotelos_l6b` borrables por id; `core.hooksPath=.husky` no
  resuelve en este layout (hook ejecutado a mano por el integrador)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda UX-3 · «Feel» de pisos y mantenimiento, 2026-09-20, lote Q1 de cierre +
corrector UX-3-REV + integrador; worktree `tanda-ux3` sobre a069906 con los lotes U0 · D0 · P1 · P2 · P3 ·
M1 · P4 · Q1, BD `hotelos_ux3`; commit del integrador en `tanda-ux3` («feat(ux-pisos): feel de pisos y
mantenimiento de ehotelOS (Tanda UX-3)», 68 ficheros: 35 modificados +2.859/−669 · 33 nuevos, 10.904
líneas; `pnpm-lock.yaml` M preexistente, excluido); informe `docs/audits/TANDA-UX3-PISOS-2026-09-20.md`):
- diseño `docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md` (§2 con las cifras finales) implementado: copia
  única `content/pisos-actions.ts` (avisos con número), `screens/operations/deferred-commit.ts` (copia
  idéntica de la ficha de reserva; escritura diferida 8 s con «Deshacer», `keepalive` en pagehide);
  tablero de pisos y tablero de habitaciones (P1: busy por habitación, «Marcar limpia» / «Inspeccionar»
  optimistas con deshacer, «Nueva tarea» con «Asignar a» e Intro, diálogo nominal «Bloquear la NNN» /
  «Mantenerla en venta», «Desbloquear» y «Marcar sucia» con deshacer); Mi turno (P2: `sections[]` y
  `sectionId/sectionName` en `GET /dashboards/housekeeping-mobile`, chips de sección recordados por
  propiedad «Mi sección», tarjeta «Siguiente», «Limpia» cierra la tarea (D1), ayuda plegada con el dedo,
  `CocoaActionBar` en tablet); Mis averías y tablero de mantenimiento (P3: «Mías · Todas», «Tomar» con
  deshacer, «Resuelta» / «Resolver» diferidas, «Asignarme» / «Asignar a», diálogo nominal de bloqueo);
  fotos del parte (M1: migración aditiva `20260920170000_ux3_parte_fotos` en `work_order_media`,
  `POST /work-orders` con `photos[]` → 201, `POST …/:id/media` base64, `GET …/:id/media` y
  `GET /work-orders/media/:mediaId` bajo `maintenance.read`, `mediaCount`); `ReportIncidentDrawer`
  (P4: chips de motivo, ≤ 3 fotos con cámara trasera y compresión por canvas, título automático) y
  galería en Mis averías; `density="operational"` en las cuatro páginas; manual 40, fichas 09/10 y
  runbook `docs/runbooks/ux-pisos-pruebas.md`; 0 `style=` nuevos (inlineStyles 624)
- medida automatizada del camino óptimo (`apps/admin-web/e2e/measure/p1…p6`, `MEASURE_STRICT=1`, tenant
  aislado `org_uxday/prop_uxday` de `db:seed:ux-day -- --reset` + `db:seed:ux-day-pisos` rearmado con el API
  parado; baseline y final en `docs/audits/ux-pisos/measure-*.json`; ratón 1280 × 900 = tablet 820 × 1180):
  p1 2 = 2 toques (ahora con deshacer y tarea cerrada) · p2 1 = 1 (chip de sección recordado; 0 al volver)
  · p3 2 → 1 clic + Intro (tablet 2) con asignación · p4 no completable → 3 toques · 0 teclas con
  `mediaCount 1` · p5 2 → 3 (chip «Todas»; 2 acciones de dominio, con deshacer) · p6 bloquear 2 → 3
  (diálogo nominal) + desbloquear 1; peticiones iguales o menores; 12/12 estricto en dos corridas
  idénticas en clics, teclas y peticiones (11:53Z y 11:55Z)
- táctil (`e2e/pisos/pisos-target-size.spec.ts`, proyecto `touch`, 20/20 · 40 corridas, 2 viewports × 2
  temas × 5 rutas con cajones; `target-size-pisos-2026-09-20.json`): 0 objetivos < 24 px · 0 < 44 px ·
  `operational/comfortable` en las 4 páginas · barra del pulgar en Mi turno y Mis averías con controles
  de 44 px · badges texto ≥ 5,91:1 · borde/punto ≥ 4,57:1 en oscuro (el «Baja» a 1,35:1 de U0 corregido);
  en claro warning/success 2,02–2,87 informativo (heredado de UX-1)
- puerta completa final tras el corrector (2026-09-20 15:24, `scratchpad/UX-3/gates-final.json`; informe §7):
  13/14 — typecheck:all 15 PASS · 0 FAIL · 1 SKIP · api unit 3.594 (3.593 pass · 0 fail · 1 skip) · admin-web
  unit 2.149 (2.148 · 0 · 1) · ai-core 119 · worker 34 · contratos raíz 777 (775 · 0 · 2 skip) · discoverability
  197 URL · route-access 15 × 197 · cocoa waves §6 al día (regenerado) · rbac dry-run OK · migrate 25/25 +
  «No difference detected.» · build 3,16 s · integración 996 (988 pass · 0 fail · 8 skip); en rojo SOLO
  `nav-tree --check` (CSV compartido con rutas de otros carriles sin pantalla aquí; regenerar en la fusión);
  puerta rápida del integrador sobre el árbol commiteado 11/12 (mismas cifras, solo nav-tree);
  e2e measure estricta 12/12 (Q1 ×2 y de nuevo por el integrador tras el corrector, 13:31Z: p1 2 · p2 1 ·
  p3 1+Intro / 2 · p4 3 · p5 3 · p6 3 + 1, peticiones 4 · 7 · 2 · 2 · 3 · 2 + 1) · touch 20/20 · 40 corridas (13:31-13:32Z, 42,8 s) (integrador,
  tras el corrector; Q1 20/20)
- corrector UX-3-REV (informe §11): toast con «Deshacer» sin pausa y «Deshacer» tardío honesto
  (`undoDeferred`, `capToasts`), «Actualizar» de mantenimiento vacía y espera las diferidas, POST + PATCH a
  la vez en `pagehide` (D1), «Asignarme» sin blur, fotos del parte con 404 opaco entre propiedades + lectura
  de bytes tras la tenencia + tope de 3 en transacción, EXIF fuera (`force`), estricto del arnés con la
  baseline (p5/p6 +1 aceptado), api-contracts con `GET /dashboards/housekeeping-mobile`, plan de formación
  y FAQ con la copia de UX-3 pinzada por `manual-contract`; runtime C1-C8 en verde (`scratchpad/UX-3-COR`)
- pendientes con dueño (informe §9): chip «Mías» por defecto (+1 toque en p5, aceptado en §2 del diseño;
  recordar alcance o arrancar en «Todas» con cola sin asignar si se quiere volver a 2), recuento único de p6
  (contrato U0 `clicks: [1-3]`), `nav-tree --check` rojo por el CSV compartido cambiado tras el JSON
  (regenerar en la fusión), capturas del manual anteriores a UX-3, guarda `mutating` en `apiCache.loadApiKey`
  (endurecimiento), `accessKey` en primarios, consolidar `deferredCommit` en `lib/`, `playwright install
  chromium` (hoy shim), `pnpm-lock.yaml` fuera del commit (deriva preexistente), sesiones con personas
  reales (kit del runbook)
- integrador: ficheros confirmados por `git status` (69 entradas; 68 en el commit; 4 fuera de las listas de
  lote por las puertas: whitelist de discoverability, `env-contract.json`, inventario y §6 de Cocoa 22);
  revisión UX-3-REV: 16 hallazgos, 15 confirmados (13 corregidos con test, 2 documentados) y 1 refutado (M04:
  nav-tree rojo por el CSV compartido, no por UX-3); `pre-commit` de `hotelos/.husky` NO lo dispara git desde
  la raíz del worktree (`core.hooksPath=.husky` relativo; «cannot find a hook named pre-commit») → ejecutado a
  mano antes del commit (discoverability OK · typecheck:all 15 PASS · 23,9 s), sin `--no-verify`; decisión
  para César: `core.hooksPath hotelos/.husky` o enlace en la raíz (informe §12)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda L7 · Huésped y móvil, 2026-09-20, cierre L7-10 + revisión del carril +
corrector L7-REV + integrador; informe `docs/audits/TANDA-L7-HUESPED-MOVIL-2026-09-20.md`, runbook
`docs/runbooks/portal-huesped.md`):
- rama `tanda-l7` sobre a069906 (BD `hotelos_l7`, puertos :3937/:5207/:5237), 10 lotes en 4 olas sobre el
  recon `scratchpad/L7/recon-delta.md` (§18 D1-D10, §19 contratos) → cierre L7-10 → revisión en runtime por
  dos revisores (8 hallazgos medium confirmados + 10 low, 0 refutados; informe §8.1) → corrector L7-REV (18
  corregidos con test; segunda migración) → integrador (informe definitivo, este bloque, puertas y commit).
  Hitos del working tree: tras L7-09 48 modificados (+3.353/−893) + 33 nuevos (9.374 líneas); tras L7-10 51
  (+3.520/−894) + 36 (10.034); **en el commit 65 modificados (+4.111/−969) + 37 nuevos (10.649 líneas)**;
  `pnpm-lock.yaml` limpio y fuera del commit; sin dependencias nuevas
- portal `apps/guest-web` (8.925 líneas) de punta a punta en español + inglés (`wizard.ts` 384 claves,
  selector es/en con `<html lang>`, skip link, regiones vivas, `--gp-muted` 5,7:1, 0 `style=`, objetivos
  ≥ 44 px): acceso por código + correo o enlace (token fuera de la URL, `sessionStorage`), asistente de 6
  pasos de CHK con `progressbar`/`aria-current`, cámara por teclado, «Firmar en recepción» (2.5.7, D6),
  páginas nuevas `CheckOutPage` (folio REAL con cargos y pagos, facturas PDF por token, peticiones
  `express_checkout · late_checkout · invoice_email · luggage` → `SRQ-<8>`, «Quiero pagar ahora» → sin
  PSP «Se cobra en recepción», nunca «pagado»; folio vacío = «sin cargos todavía»), `StayInfoPage` (faq
  del bot + dirección, nada inventado), `SurveyPage` (`?survey=1`, NPS 0-10 como radiogroup, 409 →
  «Ya has respondido», enlace caducado → acceso); `StayOverviewPage` con etapa `pre_arrival · arrival_day
  · in_house · departure_day · post_stay · cancelled`, acción principal/secundaria (`stay/stay.ts`),
  llave, chat salvo cancelada; modo sin API marcado «vista previa sin API»; kiosco con aviso de
  inactividad `role="alert"` a 75 s + «Continuar», reinicio a 90 s sin restos, ticket `K-nnnn`,
  selector de idioma, objetivos ≥ 56 px
- API `apps/api/src/modules/guest-portal/*` (3.184 líneas): `GET /guest-portal/stay`
  (`GuestStayView`: etapa por fecha local, folio principal real, facturas emitidas, info, peticiones,
  encuesta), `POST /guest-portal/stay/requests` (201 `SRQ-<8>`, `ServiceRequest front_office` + evento
  `GuestCheckoutRequested`, 409 `STAY_CLOSED`), `POST /guest-portal/stay/payment-link` (`at_reception`
  sin PSP, nunca registra pago), `GET /guest-portal/invoices/:id/pdf` (solo `Invoice.reservationId` de la
  sesión, `?token=` solo aquí), `GET|POST /guest-portal/survey` (cuestionario `post_stay` del hotel o
  NPS + comentario por defecto; 201 → 409 `SURVEY_ALREADY_ANSWERED`; 409 `SURVEY_NOT_AVAILABLE` fuera de
  `post_stay`), `POST /reservations/:id/post-stay/survey-invite` (`pms.reservation.modify`, medium;
  `surveyUrl` solo si simulado), `GET /reservations/:id/guest-journey` (`pms.reservation.read`, low;
  `GuestJourneyView` sin PII, wire type en `guest-portal-types.ts` y sección propia en `api-contracts.md`
  tras el corrector L7-REV); token opaco en `x-guest-token` (`?token=` ÚNICAMENTE en el PDF de la factura;
  corrector L7-REV-09), prefijos `/guest-portal/{stay,invoices, survey}` en `PUBLIC_PREFIXES`, 401
  `GUEST_SESSION_INVALID`; legado `GET /guest-portal/session/:token`
  verifica y redacta (D8); 0 claves RBAC nuevas (2 partials); migración `20260920190000_portal_huesped_l7`
  (`property_checkin_policies.post_stay_survey_enabled` boolean default false ·
  `post_stay_survey_delay_hours` int default 24; reversible, sin índices ni enums; 25/25, deriva cero);
  plantilla de sistema `post_stay_survey` (email es/en, whatsapp es, sms es; `redact` del token);
  `issueGuestPortalSession` de 30 días con ámbito `purpose = survey` (migración
  `20260920210000_guest_portal_session_purpose`, corrector L7-REV-01: esa sesión SOLO abre `GET|POST
  /guest-portal/survey`; el resto del portal → 401); `runPostStaySurveyStep` como paso 5 independiente del tick del
  check-in (ventana `[hoy − 3 d, día local de (ahora − delay)]`, consentimiento `gdprAt` o `marketing !==
  false`, idempotente por `notificationId post_stay_survey:<reservationId>`, `summary.postStaySurvey`);
  sin `EMAIL_PROVIDER` entrega `sent` + «SIMULADO…» fuera de producción y `failed` en producción; copy de
  `GET /reservations/:id/activity` en español (`pms/guest-activity.service.ts`); seed `db:seed:checkin`
  con la encuesta activa (24 h) y `Survey chk_survey_post_stay`, `--reset` borra sus respuestas
- back office: «Recorrido» de la reserva (`/recepcion/reservas/:id/recorrido`, `journey.ts` puro) con 13
  pasos reales (reserva · invitación · pre-check-in n/m firmados · identidad · pago · habitación ·
  check-in · llave con serie y «QR de demo» · bienvenida · estancia · peticiones · check-out · encuesta),
  avisos con badge «Simulado» y destinatario enmascarado, botones «Invitar / Reenviar invitación» y
  «Enviar encuesta ahora» (resultado honesto, `isRouteUnavailable`); sin recorrido del API los pasos
  quedan `unknown` y nunca se proponen; «Portal del huésped» (`/comercial/ventas-adicionales/portal`)
  persiste SOLO `postStaySurveyEnabled` / `postStaySurveyDelayHours` (0-72) / `allowPayAtReception` con
  `PUT /properties/:id/check-in/policy` (`guestPortalApi.ts`; pantalla 292 → 270 líneas)
- pruebas: proyecto Playwright `guest` (`apps/admin-web/playwright.config.ts`; `apps/admin-web/e2e/guest-portal/`:
  helpers + `precheckin` · `stay-checkout` · `kiosk` · `journey` · `survey` .spec.ts + README; tenant CHK
  con titulares inventados, Pixel 5 / tablet / escritorio; `assertTargets` 0 objetivos < 24 px en 32
  pantallas, < 44 px solo 3 casillas `.gp-check` de 26 px; 0 excepciones, ninguna respuesta ≥ 400 no
  declarada, token nunca en una URL) **5/5 en 42,9 s** el 2026-09-20 14:45 contra la instancia del cierre
  (`scratchpad/L7/l710-e2e/`); unitarios nuevos api 50 (`guest-stay` 21 · `post-stay-survey` 17 ·
  `guest-journey` 12), admin-web 26 (`journey` 15 · `guest-portal-settings` 11), guest-web 70 (`wizard`
  38 · `stay` 32), contratos raíz +31 (`guest-portal-a11y-contract` 11 nuevo; `guest-portal-ui-contract`
  32 y `seed-checkin-contract` 14 ampliados), integración 27 (`guest-stay` 11 · `guest-survey` 11 ·
  `guest-journey` 5, tenants aislados + invariantes de Faranda 13.457 reservas · 13.436 huéspedes)
- puertas rápidas (`scratchpad/L7/gates-{base,ola1,ola2,ola3}.json`): base 12/12 → 11/12 en las tres olas
  (typecheck 15 PASS · 1 SKIP guest-web; api unit 3.569 → 3.625; admin-web 2.014 → 2.040; contratos 765 →
  796; ai-core 119; worker 34; discoverability 197; route-access 15 × 197; cocoa; rbac; migrate + drift),
  única roja `nav-tree --check`: el CSV compartido `pilots/tanda5-nav-tree.csv` cambió a las 12:19 por la
  Tanda ACT y `nav-tree.generated.json` del worktree queda stale (L7 no añade rutas; regenerar en la
  fusión); puerta completa final (`scratchpad/L7/gates-final.json`): 13/14 el 2026-09-20 (14:51 → 14:58, `scratchpad/L7/gates-final.json`): typecheck 15 PASS · 0 FAIL · 1 SKIP (guest-web) · api unit 3.625 (3.624 pass · 0 fail · 1 skip) · admin-web unit 2.040 (2.039 · 0 · 1) · ai-core 119 · worker 34 · contratos raíz 796 (794 · 0 · 2 skip) · discoverability 197 URL · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status + drift «No difference detected.» · admin-web build OK (3,13 s) · integración 1.010 (1.002 pass · 0 fail · 8 skip); única roja `nav-tree --check` (CSV compartido cambiado por la Tanda ACT, JSON generado stale; ajeno al carril)
- runtime con capturas sintéticas (`scratchpad/L7/`, sin nombres reales): `l701-*` (24: portal es/en,
  oscuro, stub sin API), `l705-kiosk-*`/`l705-movil-*` (21: kiosco y asistente accesibles),
  `l706-*` (13: estancia por etapa, salida y cuenta, información), `l707-recorrido*` (2), `l708-admin-portal-*`
  (5: ajustes), `e2e/*.png` (32, L7-09) y `l710-e2e/shots` (32, cierre); sondas de API `l704-runtime.json`,
  `l706-runtime-rerun.json`, `l707-runtime.json`, `l708-admin-runtime.json`
- `apps/mobile` congelada como demo interna (D5, `apps/mobile/README.md`): 110 pantallas / 9.243 líneas de
  maqueta, `AuthProvider` definido sin montar, `loginDemo()` → `demo.jwt.token` + `prop_123`,
  `services/api.ts` con `prop_123` × 16 / `org_123` × 2 y respaldos inventados, check-in por IA
  (`screens/ai/checkin/*`) sin cámara ni firma (`sig_mobile_demo`) y no enrutado, `GuestJourneyScreen`
  fijo; typecheck 0 errores; sin cambios de código
- datos del carril (solo lectura): `prop_chk` 63 reservas (11 `CHK-*` + 52 `RES-*` de e2e), 54 sesiones de
  check-in, 4 respuestas de encuesta, 4 entregas `post_stay_survey` simuladas, 83 sesiones de portal
  activas, 8 kioscos «Tablet e2e» `disabled`; desde el corrector L7-REV `--reset` purga también las `RES-*`
  de e2e (titular `prueba.portal.*`, sin factura)
- **corrector L7-REV (2026-09-20, tras la revisión del carril)** — 7 medium + 10 low cerrados: (1) sesión
  del enlace de la encuesta acotada (`guest_portal_sessions.purpose`; `verifyGuestToken(token, { purposes })`;
  el portal verifica `?survey=1&token=` contra `GET /guest-portal/survey`, monta solo `SurveyPage` y ofrece
  «Entrar en el portal con mi código»); (2) `POST /guest-portal/stay/requests` exige las listas por etapa
  (`GUEST_STAY_REQUEST_KINDS_BY_STAGE`): `checked_out` → 409 `STAY_CLOSED` salvo `invoice_email`, resto → 409
  `STAY_REQUEST_NOT_ALLOWED`; (3) enlace de pago con folio sin líneas → `no_charges` / `none` (también
  `/check-in/payment-link`, que ya no persiste `paid` sobre una cuenta vacía); (4) recorrido: la encuesta se
  busca por igualdad (`res_07` ya no hereda la de `res_07p`), test `r1`/`r1x`; (5) encuesta solo con la reserva
  `checked_out` (`surveyOpenFor`; el portal no da las gracias ni la ofrece a una confirmada con la salida
  pasada: «La fecha de salida ya pasó sin registrar tu llegada»); (6) reserva cancelada sin «Salida y cuenta»
  (`folioActionKey`), cabecera «Reserva cancelada · cargos de cancelación» sin CTA de pago; (7) «Firmar en
  recepción» del kiosco deriva en el servidor: `POST /guest-portal/check-in/handoff` → `handed_off ·
  signature_pending · ticket K-nnnn (handoffTicketFor) · kioskDeviceId · CheckInHandedOff`, kind
  `signature_pending` en la cola de Mi día, `resolve-handoff` lo cierra; la tablet solo pinta el ticket del API
  (`kiosk-mode.ts` ya no calcula ninguno); low: `/service-request` y `/chat` → 409 `STAY_CLOSED` con la
  reserva cerrada y sin «Pedir un servicio» tras la salida; `Router key` + página inicial a la estancia tras
  «Cerrar sesión»; `redactTokenInUrl` cubre `/guest-portal/session/<token>`; `returnUrl` solo `http(s)` (400) en
  ambos esquemas; cabecera de `playwright.config.ts` con `--project=guest`; copy del Recorrido sin número de
  lote; `E2E_API_URL` por defecto :3937; `--reset` purga las `RES-*` de e2e (`prueba.portal.*`, sin factura) y
  `precheckin`/`survey` dejan limpia su habitación (`releaseReservationRoom`); legado `/guest-portal/{reservation,
  pre-check-in,service-request}` con 401 tipado. Tests: api unit `guest-journey` 13 · `guest-stay` 28 ·
  `post-stay-survey` 18 · `front-desk-checkin` 12 · `checkin-session` 20; guest-web 72; contratos
  `guest-portal-ui` 32 · `guest-portal-a11y` 11 · `seed-checkin` 14 · `cors` 12 · `api-route-permissions` 32;
  integración `guest-survey` 13 · `guest-stay` 14 · `kiosk-pairing` 8 (handoff de punta a punta); migración
  26/26 y deriva cero en `hotelos_l7`; e2e proyecto `guest` **5/5 en 39,6 s** (2026-09-20, API :3937 + portal
  :5237 + admin :5207 del carril, `scratchpad/L7/corr-e2e-run2.log`, capturas `corr-e2e/`: la encuesta por
  enlace termina en «Entrar en el portal con mi código» → acceso → «Estancia terminada · Gracias por tu
  opinión»); sondas de API `scratchpad/L7/corr-probe.json` (sesión `survey` → 401 en 8 rutas, `no_charges`,
  409 `STAY_CLOSED`/`STAY_REQUEST_NOT_ALLOWED`, handoff → `handed_off` + ticket + `resolve-handoff`, recorrido
  de `CHK-07` sin la invitación de `CHK-07P`, log con `/guest-portal/session/<redacted>`); puerta completa
  **12/14** el 2026-09-20 (`scratchpad/L7/corr-gates-full.json`): typecheck 15 PASS · 0 FAIL · 1 SKIP
  (guest-web) · api unit 3.637 (3.636 · 0 · 1) · admin-web 2.040 (2.039 · 0 · 1) · ai-core 119 · worker 34 ·
  contratos raíz 796 (794 · 0 · 2) · discoverability 197 · route-access 15 × 197 · rbac dry-run · migrate
  status + drift «No difference detected.» (26/26) · admin-web build OK (2,96 s) · integración 1.016 (1.008 ·
  0 · 8 skip); rojas: `nav-tree --check` (CSV compartido cambiado por la Tanda ACT, ajeno al carril) y `cocoa
  waves --check` (§6 regenerado con `cocoa-22-waves.mjs --write` tras `cocoa-22-inventory.mjs`; puerta rápida
  posterior `corr-gates-quick2.json` **11/12** con `cocoa waves` en verde y solo `nav-tree` rojo); `db:seed:checkin
  -- --reset` ejecutado en `hotelos_l7` (`scratchpad/L7/corr-seed-reset.sh`): `e2eReservation=68` purgadas,
  `prop_chk` 79 → 11 reservas (las 11 `CHK-*`), Faranda 13.556 reservas antes y después
- pendientes con dueño (`CLAUDE.md` deuda 19; informe §8; runbook §10): `ensureSession` crea sesiones en
  reservas alojadas/salidas; `survey_detractor` no se crea; `answers` sin validar rango; `failed` sin reintento
  en producción; `@types/react` (D7);
  `signIn` con `Error` inglés; toggle de idioma duplicado; casillas 26 px / fechas 39 px;
  `identityVerifiedAt` con `mrz_checksum`; `CocoaSearchInput` 20 × 20; `e2e/**` sin typecheck; en la
  fusión `nav-tree`, `env-census --write`, `cocoa-22-waves --write`, renumerar las dos migraciones si L8
  aporta una marca posterior; PSP / correo / WhatsApp / dominio `huesped.ehotelos.com` (César, D1-D4, D10)
- **integrador (2026-09-20 16:27 → commit)** — working tree confirmado con `git status`/`diff --numstat`
  (65 M +4.111/−969 · 37 nuevos 10.649 líneas · `pnpm-lock.yaml` limpio); recuento de la revisión corregido
  respecto al resumen del corrector: son **8** medium (3 funcionales + 5 de seguridad/datos, ids
  `funcional-runtime-REV-L7-01…03` y `seguridad-datos-regresiones-L7-REV-01…05`) + 10 low, 0 refutados, 18
  corregidos (tabla con hallazgo → corrección → test en el informe §8.1); puerta completa FINAL sobre el árbol
  del commit (`scratchpad/L7/gates-final.json`, 16:23, tras el corrector y la regeneración de Cocoa §6):
  **13/14** — typecheck 15 PASS · 0 FAIL · 1 SKIP (guest-web) · 21,0 s · api unit 3.637 (3.636 · 0 · 1) ·
  admin-web 2.040 (2.039 · 0 · 1) · ai-core 119 · worker 34 · contratos raíz 796 (794 · 0 · 2) ·
  discoverability 197 · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status +
  drift «No difference detected.» (26/26) · admin-web build 2,85 s · integración 1.016 (1.008 · 0 · 8 skip);
  única roja `nav-tree --check`: el CSV compartido tiene 304 filas (el JSON del worktree se generó con 294) y
  las 10 nuevas son pantallas de los carriles RRHH/ACT inexistentes aquí (`HrEmployees/HrOverview/HrForecast/
  DirectorLaborCosts/RealEstate*`) más la etiqueta de `PayrollScreen`; regenerar aquí rompería
  discoverability/route-access, así que el JSON se dejó intacto y se regenera tras fusionar RRHH/ACT;
  puerta rápida tras las ediciones documentales (`gates-integrador-quick.json`, 16:35 → 16:36): **11/12** con
  las mismas cifras (contratos raíz 796 verdes con este bloque y el informe ya editados; solo `nav-tree` rojo);
  `bash .husky/pre-commit` (discoverability 197 URL · 0 broken · 16/20 + `typecheck-all` 15 PASS · 1 SKIP,
  22,4 s) ejecutado A MANO desde `hotelos/` porque
  `core.hooksPath = .husky` (ruta relativa) se resuelve contra la raíz del worktree, donde no existe el
  directorio (vive en `hotelos/`): git no dispara el hook solo (informe §8.2 fila 10); BD `hotelos_l7` por SQL de
  solo lectura tras el `--reset` del corrector: 26 migraciones aplicadas (última
  `20260920210000_guest_portal_session_purpose`), `prop_chk` 11 reservas (todas `CHK-*`: 9 confirmadas · 1
  alojada · 1 salida), 9 sesiones de check-in, 0 respuestas de encuesta, 8 sesiones de portal `invitation`,
  política encuesta ON / 24 h / pago en recepción OFF; reservas totales 13.567 = 13.556 fuera de `prop_chk`
  (sin cambio) + 11; ningún proceso en :3937/:5207/:5237 (`lsof`), :3000/:5173 y el PID ajeno intactos;
  commit único en `tanda-l7` (`feat(huesped): …`, cuerpo por lote + corrector, autor cesareme, sin
  `--no-verify`, sin `push`; sha en el informe del orquestador)

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)

Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19/20, worktree
`tanda-t9` sobre f77820d con los lotes T9-01…T9-15 + corrector; informe
`docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md`; fusión pendiente por
`docs/design/olas/T9-MERGE-LINES.md`):
- módulo `apps/api/src/modules/documents/*` (diseño `docs/design/DOCUMENTOS-DIGITALIZACION.md`
  con las correcciones «[actualizado 2026-09-19]», runbook `docs/runbooks/documentos-digitalizacion.md`):
  captura por subida / foto PWA / buzón de correo `purpose=documents` (también `POST …/email/ingest`
  con `attachments`) / XML Facturae-UBL (→ `source e_invoice`) con registro `DOC-<centro>-<año>-<n>`,
  sha256 y magic bytes; almacén `inline` (demo, caché LRU 8 MiB; rechazado en producción) / `disk`
  (AES-256-GCM en reposo) / `s3` (SigV4 propio con tiempo límite y tope de lectura, sin SDK ni cuenta
  real); pipeline clasificación → extracción → validación (NIF, cuadre, IVA, duplicados, retención,
  cotejo) → propuesta, con IA por ai-core (`classifyIncomingDocument` · `extractIncomingDocumentFields` ·
  `proposeIncomingDocumentAction`) y fallback honesto por reglas sin proveedor (nunca campos
  inventados; `totals` en `warn` sin líneas ni total); flujo centro → oficina (`captured →
  sent_to_office → in_review → approved | posted | archived | rejected | returned_to_centre`, SLA 2 días
  laborables con aviso a la oficina al enviar y aviso diario de SLA vencido, `autoSendToOffice`
  operativo, valija con hoja de remesa, split lógico por páginas físicas (`sourcePagesJson`: cada trozo
  extrae SOLO su rango; origen repartido entero → `archived` + `mergedIntoId`), merge, tareas con
  plazo); aprobar crea la factura de proveedor en `draft` por payables (`receptionDate`, `source
  digitized | e_invoice`, `matchStatus`, enlace factura ↔ documento solo desde el flujo: 400 por HTTP,
  404 cross-tenant; quien aprueba queda como registrador → SoD), el gasto, la recepción de mercancía
  (`GoodsReceipt` + `StockMovement` en la misma transacción) o la tarea; cotejo a 2 vías (`POST
  …/supplier-bills/:billId/match`, tolerancias por organización, 409 `SUPPLIER_BILL_MATCH_REQUIRED`
  opcional al aprobar); archivo con búsqueda por texto, retención 6 / 10 / 6 / +1 años (4 solo con
  `guestId`) fijada también al contabilizar, bloqueo y purga (job diario del líder), GDPR en
  `executeErasure`; las 9 rutas `authenticated` exigen sesión real (`requireRealSession` → 401 al
  fallback demo) y la disyunción `capture | review` la aplica el servicio; auditoría sin nota ni
  remitente; copia «digital no certificada»: el papel se conserva
- cifras: manifiesto 948 → **981** (+35 rutas: 30 en los cuatro partials del módulo + 5 en el
  de payables; −2 heredadas retiradas: `GET /properties/:propertyId/supplier-bills` y
  `POST /supplier-bills/drafts`), tablas 277 → **287** (38 → 45 enums; migraciones aditivas
  `20260920120000_documentos_digitalizacion` y `20260920130000_documentos_split_paginas_retencion`
  (`incoming_documents.source_pages_json` + `capture_note`, `letter_retention_years` 4 → 6), en `main`
  tras las dos de fix1), claves 250 → **254** (`documents.capture | review | archive.read | admin`;
  `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas), herramientas IA 146 → **147**,
  `DOCUMENT_ERROR_CODES` **20**, pantallas +4 (Operaciones › Digitalizar `/operaciones/digitalizar`;
  Finanzas › Proveedores › Documentos y Archivo; Compras › Recepciones), `/health`
  `dependencies.objectStorage = inline | disk | s3 | unconfigured`, `DOCUMENT_STORAGE_KIND` obligatoria
  con `NODE_ENV=production`; 191 ficheros del carril (73 ` M` + 118 nuevos, +3.332/−736 y 34.663 líneas
  nuevas); `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (refutación
  SEC-05/R1 del informe §4.2) y se excluye de la fusión
- revisión: 3 revisores → 18 hallazgos confirmados (2 altos funcionales: split sin separar, rutas
  `authenticated` servidas al fallback demo; 1 alto de seguridad: enlace factura ↔ documento
  cross-tenant; 15 medios) + 13 menores, todos corregidos con test por el corrector (informe §4;
  `T9-MERGE-LINES.md` §16); 2 refutados (lock del worktree)
- puerta completa final (20/09 08:03-08:07, `NAV_TREE_CSV=… bash scripts/gates.sh --json`, BD
  `hotelos_t9`, `scratchpad/T9/gates-final.json`; JSON del corrector en
  `docs/audits/T9-corrector-gates-{quick,full}.json`): **12/14** · typecheck:all 15 PASS · 0 FAIL · 1
  SKIP · api unit 3.242 (3.241 pass · 1 skip) · admin-web unit 1.916 (1.915 pass · 1 skip) · ai-core
  119/119 · worker 34/34 · contratos raíz 608 (606 pass · 0 fail · 2 skip) · discoverability 196 URLs ·
  0 enlaces rotos · route-access 15 × 196 · cocoa waves al día · rbac:sync dry-run OK (+0 sobre
  `hotelos_t9`: las 4 claves `documents.*` ya las escribió el arranque del API; en `main` dará +4) ·
  admin-web build OK · integración (`--test-concurrency=1`, loader tsx, `.env` del carril) **865 · 857
  pass · 0 fail · 8 skip condicionales** (el run del corrector dio 856 · 1 fail por un flake AJENO:
  `l2-persistencia-plataforma.test.mts` L2-04, dos `offline_sync_records` en el mismo milisegundo, verde
  en la suite sola; las 7 suites T9 verdes en todos los runs) · `db:migrations:check` 20 migraciones →
  287 tablas / 45 enums. Rojos estables (2/14), externos al carril: `nav-tree --check`
  (`nav-tree.generated.json` «stale» por la fila `CheckInAutomationSettingsScreen` del CSV compartido,
  carril CHK; el árbol generado es 70 · 103 · 205) y «migrate status + drift» (`migrate status` 20/20
  al día; `db:drift:check` con EXACTAMENTE los 3 ítems heredados de fix1 en `hotelos_t9`:
  `VatBookRegime`, `vat_book_entries.regime` + índice, `vat_settings.opening_compensation*`).
  Incidente registrado (informe §3): los runs 1-2 de la puerta «integración» de T9-15 corrieron 12
  suites con `DATABASE_URL ??= …/hotelos` contra la BD PRINCIPAL (tenants de prueba creados y
  limpiados; 0 residuales verificados); `scripts/gates.sh`, `package.json` `test:integration` y
  `tests/integration/helpers/load-env.mts` cierran la trampa. Invariantes de Faranda idénticas al
  inicio y al final; 0 organizaciones residuales; seed de demo purgado (0 `incoming_documents`)
- pendientes: fusión (mergeLines §1-§16 y regeneración de `nav-tree.generated.json` con CHK
  fusionado), `db:migrate:deploy` + `db:generate`, reinicio de `:3000` y `POST
  /ai-operations/tools/sync`, `rbac:sync` real (autorización: escribe `role_permissions`),
  `env:census:write` el último; `openapi.yaml` con las 2 rutas retiradas, `emailApi.ts` con dos
  propósitos, `anyOf` en el manifiesto; decisiones de César (informe §9, runbook §11): S3 o disco +
  backup en el VPS, buzón por centro y OAuth, escáneres, IA con clave y DPA, retención firmada,
  tolerancias / SLA; deuda 17

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-19,
worktree `tanda-chk` sobre f77820d, BD `hotelos_chk`; pendiente de fusión a main):
- diseño `docs/design/CHECKIN-AUTOMATIZADO-IA.md` implementado en 4 olas (W1 modelo,
  MRZ, motor y seed · W2 sesión, captura, firma, asignación y plantillas · W3 llegada,
  rutas, jobs y cola · W4 front de recepción, portal, kiosco y bot); apéndice «Estado
  tras la implementación» con los deltas; runbook `docs/runbooks/checkin-automatizado.md`;
  contrato `docs/api-contracts.md` «Check-in automatizado (Tanda CHK)»
- migraciones `20260920150000_checkin_automatizado` (9 tablas: `checkin_sessions`, `checkin_guests`,
  `document_captures`, `signatures`, `assignment_suggestions`, `kiosk_devices`,
  `property_checkin_policies`, `room_blocks`, `room_connections`; 14 índices + 3 únicos, 1 FK en
  cascada, 0 enums, reversible) y `20260920160000_checkin_pago_en_recepcion` (corrector REV3-02:
  columna `allow_pay_at_reception`); `migrate status` 21/21 en el carril · `db:drift:check` «No
  difference detected.»; sin `MobileKey`, `RoomFeatureAssignment` ni el índice único de partes
  (deuda 17)
- API: 32 rutas en `modules/checkin/route-permissions.partial.ts` (15 de huésped con
  token opaco por `x-guest-token` —`?token=` solo en GET—, 17 de personal con claves existentes;
  el corrector añadió `PATCH /reservations/:id/check-in/guests/:guestId` y
  `POST /reservations/:id/check-in/resolve-handoff`) + 10 en
  `modules/pms/room-assignment-route-permissions.partial.ts` + `GET/POST /webhooks/whatsapp`;
  sin claves RBAC nuevas (`rbac:sync --dry-run` limpio); contexto de servicio
  `service-context.ts` (`guest:`/`kiosk:`/`system:checkin:`) sin claves de dinero ni de
  override; parser MRZ ICAO 9303 puro (`packages/compliance/src/spain/mrz.ts`, TD1/TD2/TD3,
  `buildMrz` para fixtures); motor de asignación puro (`room-assignment.engine.ts`,
  `rulesVersion chk-rules-1`, pesos por propiedad en `PropertyCheckInPolicy.assignmentWeightsJson`);
  captura con MRZ + visión opcional (imagen nunca persistida, `ID_IMAGE_DISCARDED`, purga
  a 30 días); firma con evidencias y PDF del parte (`signatureObjectKey` = id de
  `signatures`; almacén provisional `data:` URI); `completeCheckIn` único cierre (guest,
  kiosk y recepción) con precondiciones deterministas y 409 tipados; OTP con hash y TTL;
  kiosco con emparejamiento por código de 8 dígitos y adaptadores `none`/`sandbox`
  fail-closed; jobs in-process del líder (`checkin-jobs.ts`: invitación J-3, recordatorio
  J-1, lote de sugerencias a `CHECKIN_ASSIGNMENT_RUN_AT`, purga; `worker_job_runs`
  `checkin.assignment`); bot del huésped web + WhatsApp con aviso de IA, lecturas por
  reglas o modelo y escrituras SIEMPRE `AiToolCall awaiting_confirmation` confirmadas en
  `POST /ai/tool-calls/:id/confirm` (recepción *medium*; *high* exige `ai.high_risk.confirm`);
  `executeConfirmation` tolera `SES_DISABLED` / `GUEST_REGISTER_INVALID` /
  `SES_SUBMISSION_IN_FLIGHT` como avisos; 4 plantillas de sistema `checkin_*`;
  `matchGuestToReservation` acotada a organización y propiedad
- front: Mi día con columnas Pre-check-in / Habitación sugerida / Llave y KPI
  `preCheckInCompleted`, cola con 8 `kind` nuevos y acción `confirm_assignment`, cajón
  de check-in con escaneo/MRZ/top-3/pad/cotejo/`/complete`, `ArrivalPreCheckInDrawer`,
  pestaña `/hoy/check-in-automatizado` (`CheckInAutomationSettingsScreen`: política, pesos,
  kioscos, métricas §1.8; roles recepcion·direccion·admin·auditoria), `SignaturePad`;
  portal guest-web con asistente de 6 pasos (`/checkin?token=`), cámara, firma, llegada y
  chat; modo kiosco `?kiosk=1&device=` (90 s de inactividad, sin `localStorage`)
- seed `db:seed:checkin` (tenant aislado `org_chk`/`prop_chk`, usuarios `*@chk.test`,
  contraseña `chk-demo`/`SEED_CHK_PASSWORD`, allowlist de `demo-guard.ts` ampliada);
  Faranda solo lectura en toda la tanda
- corrector (2026-09-20, revisión 3 · 16 hallazgos confirmados + 11 low): RoomBlock como filtro duro
  (`validateRoomUnderLock` → 409 `ROOM_BLOCKED`; `completeCheckIn` reasigna la asignada bloqueada);
  `at_reception` sin PSP solo satisface el depósito con `allowPayAtReception` (si no, 409 `BALANCE_DUE`
  + `handed_off payment_failed`); el cajón comprueba `/complete { dryRun }` ANTES de asignar y cobrar,
  dice el importe ya cobrado si el check-in falla después y recuerda el intento entre aperturas
  (`sessionStorage`); recepción cierra sesiones que el huésped no cerró (partes desde los viajeros
  completos en `/complete` y en la firma del mostrador; `PATCH …/guests/:guestId`;
  `POST …/resolve-handoff`); «Pegar MRZ» con el cotejo de nombre de §4d; menores < 14 sin documento
  ni móvil propios (validador, parte y XML SES); `documentNumberLast3` real; `consentJson.otp` no se
  pisa; `handed_off` fuera del KPI «Pre-check-in hecho»; bot web con `{ text }` y widget de chat en
  estancia y asistente; «Volver a leer el documento» en el paso 2; token y OTP nunca persistidos en
  `notification_deliveries` (redacción + `GET /notifications/deliveries` sin cuerpo salvo
  `notifications.manage`; filas de org_chk limpiadas); `PII_FIELDS.Signature` (trazo y PDF cifrados;
  filas de org_chk re-cifradas); supresión RGPD sobre `checkin_guests` / `document_captures` /
  `signatures` / `checkin_sessions`; `whatsappPhoneId` único entre propiedades (409) y webhook sin
  firma solo con `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1` fuera de producción; CORS con `x-guest-token` /
  `x-kiosk-token`, `?token=` solo en GET y logger que redacta `token=`; firma idempotente (200);
  métrica de llaves solo con pase firmado; QR SVG y validez en hora del hotel; alfa-3 y `paymentType`
  en el parte; claim del kiosco con el gate antes de consumir el código; contrato `code` del
  emparejamiento; runbook §12 con el comando de integración correcto; `test:integration` con
  `--env-file-if-exists`; walkthrough del seed solo contra BD `*_chk` (o `CHK_WALKTHROUGH=1`);
  `schema.prisma.orig` eliminado; bloque de estado movido aquí (CLAUDE.md = main + deltas CHK)
- cifras de la puerta completa del corrector (2026-09-20, `scratchpad/CHK/gates-corrector-full.json`):
  10/14 puertas: typecheck:all 15 PASS · 0 FAIL · 1 SKIP (apps/guest-web) · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119/119 · worker 34/34 · admin-web unit 1.901 (1.872 pass · 28 fail: recuentos del árbol de navegación compartido con T9, idénticos a la línea base) · contratos raíz 617 (613 pass · 2 fail: `SCREEN_COMPONENTS` / `GoodsReceiptsScreen` de T9, idénticos a la línea base) · discoverability 197 URL (rojo por los 4 enlaces de T9, como antes) · nav-tree al día (70 · 104 · 205) · route-access 15 × 197 · cocoa waves §6 al día · rbac dry-run OK · migrate status 21/21 + drift «No difference detected.» · admin-web build OK · integración 881 (872 pass · 1 fail · 8 skips: en la puerta el único fallo fue el escenario nuevo SEC-4 del corrector, cuyo PATCH real pasa por backoffice.service.ts#patchAiSettings y no por el guardia recién añadido; guardia compartido `assertWhatsappPhoneIdFree` en ambos escritores y reejecución completa de tests/integration: 881 · 873 pass · 0 fail · 8 skips, `scratchpad/CHK/corrector-integration-2.log`)
- pendientes con dueño (runbook §13; informe de la tanda): `node scripts/env-census.mjs --write` y
  `node scripts/cocoa-22-waves.mjs --write` en la fusión (el corrector ya regeneró el censo con
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED`); renumerar las migraciones si otro carril aporta una marca
  posterior; `pnpm-lock.yaml` NO se commitea desde el carril (`git checkout -- pnpm-lock.yaml` en la
  fusión); plantillas *utility* de WhatsApp, PSP con `authorize`, certificado SES, hardware de llaves
  y EIPD (solo César, diseño §10.2 y §11.1)

Estado verificado (Tanda CHK · Check-in automatizado y recepcionista IA, 2026-09-20, integrador;
resumen — bloque completo en `docs/audits/ESTADO-VERIFICADO.md`, informe de cierre
`docs/audits/TANDA-CHK-CHECKIN-IA-2026-09-19.md`):
- rama `tanda-chk` sobre f77820d (BD `hotelos_chk`), 19 lotes en 5 olas, sin commit: 85 ficheros
  modificados (+11.113/−2.092) + 92 nuevos (31.231 líneas), `pnpm-lock.yaml` fuera; revisión 3 →
  20 hallazgos confirmados (8 high · 12 medium) + 12 low, 0 refutados, 30 corregidos, 2 low con motivo
- módulo `apps/api/src/modules/checkin/*` (44 rutas nuevas en el manifiesto: 32 en su partial —16
  públicas por token opaco, 16 de personal—, 10 de asignación, 2 del webhook de WhatsApp; 0 claves
  RBAC nuevas), migraciones `20260920150000_checkin_automatizado` (9 tablas) +
  `20260920160000_checkin_pago_en_recepcion` (`migrate status` 21/21, deriva cero), parser MRZ ICAO
  9303, motor de asignación `chk-rules-1`, Mi día/cola/cajón/pestaña `/hoy/check-in-automatizado`,
  portal y kiosco guest-web, bot con HITL, seed `org_chk` (`db:seed:checkin`)
- puerta completa final (2026-09-20 08:17, `scratchpad/CHK/gates-final.json`): 11/14 — typecheck 15
  PASS · api unit 3.099 (3.098 pass · 0 fail · 1 skip) · ai-core 119 · worker 34 · integración 881
  (873 pass · 0 fail · 8 skip) · migrate 21/21 + drift «No difference detected.» · build OK ·
  nav-tree 70/104/205 · route-access 15 × 197 · cocoa waves · rbac dry-run; en rojo SOLO por las 4
  pantallas de T9 del CSV compartido sin componente aquí (admin-web unit 1.901: 28 fail · contratos
  raíz 617: 2 fail · discoverability 4 enlaces); con el CSV sin T9, 14/14
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena),
  CLAUDE.md = main + deltas CHK (conflicto manual: tomar `tanda-chk`), regenerar nav-tree tras T9,
  renumerar las migraciones CHK si hay marca posterior; lo que solo César puede aportar: runbook
  `docs/runbooks/checkin-automatizado.md` §13 e informe §6

Estado verificado (Tanda RRHH · Plantilla, previsión, nómina y panel de costes de dirección,
2026-09-20, integrador; worktree `tanda-rrhh` sobre a069906, BD `hotelos_rrhh`; commit en la rama,
pendiente de fusión a main; informe de cierre `docs/audits/TANDA-RRHH-NOMINA-2026-09-20.md`):
- diseños `docs/design/RRHH-PLANTILLA-NOMINA.md` (apéndice «Estado tras la implementación» A.1-A.3)
  y `docs/design/PANEL-COSTES-DIRECCION.md` implementados en 12 lotes y 6 olas (RRHH-1 cimientos ·
  RRHH-2/3/4/7 servicios y demo · RRHH-6 rutas · RRHH-8/9/10 front · RRHH-11 + PANEL-A navegación,
  docs y API del panel · PANEL-B panel de costes); runbook `docs/runbooks/rrhh-plantilla-nomina.md`
  (12 secciones), manual `docs/manual/30-rrhh.md` (386 → 512 l.) y `10-direccion.md` §11, runbook
  finanzas §20, `docs/api-contracts.md` (viñetas RRHH, corrector y panel), CLAUDE.md deuda 19
- migración aditiva `20260920173000_rrhh_plantilla_nomina` (217 l.: 6 tablas `employees`,
  `collective_agreements`, `agreement_rules`, `labor_standards`, `staffing_plans`,
  `staffing_plan_lines`; 21 columnas nulables / con default en `staff_profiles`,
  `employment_contracts`, `absence_requests`, `labor_forecasts` (+ único por departamento),
  `payroll_periods` (`mode` external, `closed_at`), `properties.agreement_id`; 1 CHECK
  `absence_requests_requested_ne_approved`; 0 DROP / triggers, públicos siguen 4); `migrate status`
  25/25 en el carril · `db:drift:check` «No difference detected.»; 296 → 302 modelos;
  `PII_FIELDS.Employee` (NIF, NAF, correo, teléfono, IBAN) + `taxIdLookupHash`
- RBAC: 5 claves `hr.employee.read` / `hr.employee.manage` / `hr.config.manage` /
  `hr.standards.manage` / `hr.staffing.approve` (catálogo 254 → 259), plantillas v4 → v5
  (`payroll_hr` 13 → 18 sin `users.read`; `general_manager` +read +approve; `manager` /
  `operations_director` / `owner` +read), `SOD_STATIC_PAIRS` + `{payroll.manage, hr.staffing.approve}`
  (35); `rbac:sync --dry-run` limpio, el sync real queda para la BD viva (69 roles «behind v5»)
- API: `modules/hr/*` (expedientes con PII cifrada y `?pii=1` auditado, convenios con reglas
  versionadas, estándares por estrellas, motor de previsión puro con drivers reales / OTB /
  `pms_import` y `driver_missing:*` → null, plantilla máxima con SoD 409 `APPROVAL_SELF_DECISION`,
  KPIs y alertas con `degraded[]`, motor de reglas ET / convenio, ausencias con `requestedBy ≠`
  decisor y máscara de salud) con 22 entradas en `modules/hr/route-permissions.partial.ts` (21
  `/hr/*` + `POST /workforce/me/absences`); nómina: `GET /payroll/incidences` (JSON / CSV sin NIF),
  `GET /payroll/labor-cost-panel` (diario 64x por cc USALI o «sin desglose», lote `posted` por
  departamento, 70x y USALI, RN reales, nunca 0 inventado), `GET /workforce/properties/:id/staff-profiles`
  (`workforce.read`, sin coste ni correo), `POST /payroll/staff-profiles` con `employeeId`,
  `POST /payroll/contracts` con convenio / jornada / porcentaje / FD / grupo y `warnings`
  (`HR_STAFFING_EXCEEDED`), aprobación `calculated → approved → exported` con 409
  `PAYROLL_PERIOD_APPROVED` / `PAYROLL_NOT_APPROVED` / `PAYROLL_MODE_CONFLICT`, tipos 2026 (6,50 /
  32,15; temporales 6,55 / 33,35; jornada parcial prorrateada), fichaje solo propio con
  `timeclock.use` (403 `HR_TIMECLOCK_SELF_ONLY`); redacción de PII en logs y Sentry
- front: ítem «RRHH y nóminas» (`NominasTabs`: Nóminas · Plantilla `/finanzas/nominas/plantilla` ·
  Previsión de plantilla `/prevision` · Panel RRHH `/panel`), pestaña de Mi día «Costes de personal»
  `/hoy/costes-personal` (`DirectorLaborCostsScreen`), `EmployeeDrawer` (PII nunca precargada),
  Nóminas con Aprobar / Incidencias del mes / aviso de modo, Personal y turnos con selector de ficha;
  0 `style={` nuevos; árbol 70 ítems · 108 pestañas · 201 URL (antes 104 · 197)
- seed `db:seed:hr` (tenant aislado `org_hr` / `le_hr` / `prop_hr`, 12 usuarios `*@hr.test`
  contraseña `hr-demo` / `SEED_HR_PASSWORD`, 24 expedientes ficticios con NIE sintético cifrado,
  convenio ES-15-HOST, turnos, fichajes, ausencias, planes aprobados; tras el corrector el seed llama
  a `resetLaborStandardDefaults` + `generateLaborForecast`: 112 previsiones, 0 días degradados);
  Faranda solo lectura en toda la tanda (recuentos idénticos por lote; el panel se cotejó sobre Sage
  real: LT 2026-05 44.798,47 «sin desglose», agosto por lote, FN / LL sin datos)
- revisión (2 revisores → dedupe → corrector, 2026-09-20 15:1x-16:44): 18 hallazgos confirmados
  (5 high · 13 medium) + 14 low, 0 refutados; corregidos en código 16 + 12 (fichaje por persona,
  circuito de aprobación, ausencias solo propias, día sin datos degradado, position control, tipos
  temporales y parcial, headcount por personas, Excedencias, coste del mes desde la nómina calculada,
  bloqueo de modo, `employeeId` en la ficha, fichas para plantillas operativas, `JUSTIFIED_GAPS`,
  SoD estática, máscara en el cuadro heredado, seed único escritor, riesgo `high` en generate, reloj
  inyectable, catálogos de auditoría, `mode` / `closedAt` en `PayrollPeriodRecord`, búsqueda sin NIF);
  sin código: `nav-tree` con el CSV compartido (decisión de fusión) y `pnpm-lock.yaml` (fuera)
- puerta completa final (2026-09-20 16:52, `scratchpad/RRHH/gates-final.json`): 13/14 — typecheck
  15 PASS · 0 FAIL · 1 SKIP · api unit 3.730 (3.729 pass · 0 fail · 1 skip) · admin-web unit 2.119
  (2.118 · 0 · 1) · ai-core 119 · worker 34 · contratos raíz 800 (798 · 0 · 2) · discoverability
  201 URL · route-access 15 × 201 · cocoa waves §6 al día · rbac dry-run OK · migrate 25/25 + drift
  «No difference detected.» · admin-web build OK · integración 1.029 (1.021 pass · 0 fail · 8 skip);
  en rojo SOLO `nav-tree --check` por las 6 filas RealEstate* de la Tanda ACT en el CSV compartido
  sin componente aquí (con el CSV filtrado «up to date» 70 · 108 · 205: 14/14); base 12/12
  (api unit 3.569 · admin-web 2.014 · contratos 765 · 197 URL)
- commit del integrador: `feat(rrhh): plantilla, previsión, nómina y panel de costes de dirección
  (Tanda RRHH)` en `tanda-rrhh` (78 modificados +2.971 / −364, 60 nuevos 21.696 l., informe y este
  bloque); `pnpm-lock.yaml` (`M` +64 / −25 preexistente) fuera; pre-commit ejecutado a mano desde
  `hotelos/` (el hook no se dispara: `core.hooksPath = .husky` se resuelve contra la raíz del árbol
  y el fichero vive en `hotelos/.husky/`): discoverability OK · typecheck 15 PASS · 1 SKIP
- fusión: `merge-lane.sh` (censo, Cocoa, whitelist, lock; `ESTADO-VERIFICADO.md` concatena);
  CLAUDE.md = main + deltas RRHH (deuda 19, docs prioritarios, allowlist `org_hr`, `db:seed:hr`);
  regenerar `nav-tree.generated.json` con el CSV consolidado tras ACT y subir los pins (71 · 113 ·
  206); `rbac:sync` real; fila `WorkforceDashboard` de `pilots/screens-inventory.csv`
  (+`/workforce/properties/:p/staff-profiles`); renumerar la migración si otro carril aporta una
  marca posterior; lo que solo César puede aportar: convenio real por centro, CCC y códigos de
  centro, formato de la gestoría, `users.read` / `accounting.entity.read` para `payroll_hr`,
  aprobación de plantilla por dirección de hotel, origen de la ocupación prevista sin H&F

Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; fusionada en main
`ca24ed6` el 2026-09-19; `:3000` sin reiniciar; informe
`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`):
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)

Estado verificado (Tanda L2 · Persistencia y API + ronda de corrección 1,
2026-09-18 18:20; working tree sin commit; :3000 sin reiniciar — sirve el código
anterior a la tanda; informe `docs/audits/TANDA-L2-PERSISTENCIA-2026-09-18.md`):
- manifiesto = rutas registradas: 935 (L2-02 retiró 82 rutas y añadió
  `GET /admin/worker/job-runs`) · tras la fusión T8 (2026-09-19): 948;
  `demo-store.ts` 3.987 → 3.605 líneas y 115 → 89
  claves (26 retiradas sin lector); migración `20260918130000_persistencia_l2`
  (18 DROP + 2 CREATE → 274 tablas = 274 modelos)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · admin-web
  build OK · `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205
  redirecciones) · discoverability OK (placeholders 16/20) · `check-route-access`
  OK (15 tokens × 192 URL; no está en package.json) · Cocoa 22 inventario 226
  pantallas · 193 puntos · waves 0 pendientes · contrato 18/18
- unitarios api 2.244 (2.243 pass · 1 skipped · 0 fail) · worker 20/20 · front
  1.219/1.219 · contratos raíz 532/532 · integración COMPLETA (46 ficheros):
  633 tests · 626 pass · 0 fail · 0 cancelados · 7 skips conocidos · 0 «too many
  clients» (las suites L2 limitan su pool: `connection_limit=4`) · 0
  organizaciones residuales (3 restos de la revisión borrados, informe §9)
- migraciones 14/14 (`migrate status` al día, drift 0) · `db:install:check` OK
  (274 tablas) · `rbac:sync -- --dry-run` +0 · 0 stale · 0 behind · Faranda solo
  lectura (25 facturas · 33 VeriFactu · 4.951 asientos · 34 lotes Sage · 1 nóminas
  · 7 importaciones de reservas · 2 OPERA · 110 reservas · 250 claves · 24
  plantillas · 31 asignaciones vivas (+1 revocada) idénticas antes y después)
- corrección 1 (SEC-L2-01/03/04/05/06, DP-01/02/03/04/06/08/11, FC-01…08):
  llaves móviles por `guest_portal_actions`, rutas por id del motor en la
  propiedad de la entidad y padre desde el path, retención de `worker_job_runs`
  (`WORKER_JOB_RUN_RETENTION_DAYS`), `/health` sin `holder_id`, copia previa
  `backups/hotelos-pre-l2-correccion-20260918-174934.dump`
- integración final (18:16-19:05, informe §3.1/§7.2-§7.5): copia previa
  `backups/hotelos-pre-l2-integracion-20260918-181652.dump`; reinicio real con
  instancia propia `:3901` (4 procesos): 36 escrituras por API de los usuarios de
  departamento de T8a (Carmen no tiene claves de ejecución del motor: 403 por
  diseño) → 36/36 filas por SQL → 22/22 relecturas por API con Carmen tras matar
  y arrancar otra instancia (motor 25 tablas, offline, SES, setup, regla de
  precios, notificación); matriz Carmen 200 · `recepcion.tilos` 403 finanzas /
  404 RA · `sistemas` 403 · plataforma 200 en `/admin/worker/job-runs`; 14 rutas
  retiradas → 404 genérico; 0 llamadas a rutas retiradas en los fronts;
  `demo:refresh` en seco `residual: []`; los 8 módulos del motor NO están
  activados en Faranda (se activaron en Rías Altas para la prueba y se
  desactivaron; todo lo escrito se borró, invariantes idénticas); INT-01: el mapa
  de setup manual llevaba 7 endpoints fuera del manifiesto (`/ai/governance/*` no
  existe: la canónica es `/ai-operations/governance/*`) → 40/40; puertas
  repetidas en verde; `:3000` estaba parado (lo arranca el orquestador); `:3901`
  cerrado.

Estado verificado (Tanda L3 · Dinero y fiscal + ronda de corrección 1 + integrador,
2026-09-18 23:1x; working tree sin commit — 68 modificados + 15 sin seguimiento, de
los que `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`
son de la carga real de Sage 200 en paralelo, NO de L3; :3000 sin reiniciar — estaba
parado toda la tanda; informe `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md`):
- migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default`
  + índice, `reservations.price_source`; sin backfill) → 15/15 al día, drift 0;
  copia previa `backups/hotelos-pre-l3-20260918-224133.dump` (17,9 MB, 285 TABLE DATA)
- precio desde tarifa al crear (`createReservation` → `quoteReservationTotal`, plan →
  BAR → mínimo publicado; `priceSource`, `pricing.warning` si salta de plan; quote
  alineado con `quotedRatePlanId` / `ratePlanSwitched`; importador `quoted|none`);
  políticas seeded en Faranda: 24 (FLEX* 24 h primera noche · SEMI 72 h · NREF toda
  la estancia × 8 centros; `isDefault` una por centro); cancelar / no-show por
  `reservation-lifecycle.service.ts` (guarda de estado 409 RESERVATION_NOT_ACTIVE,
  transición condicional, penalización idempotente `cancellation_fee|no_show_fee`
  `not_subject` → 705.3 sin 477, folio no se cierra sin factura: 409
  FOLIO_UNINVOICED_LINES, renuncia = descuento por tramos con 409 APPROVAL_REQUIRED
  y PIN, rutas heredadas `/apply-*-fee` = reparación 409 RESERVATION_STATUS_MISMATCH);
  `taxCategory` inferida y validada por tipo en `postFolioLine` (400 incompatible);
  303 = libros nativos + `sage200` sin doble cómputo con contrafilas `#sustituida`
  derivadas en memoria y cotejo que excluye `pms_shadow_revenue` / liquidaciones Sage;
  PDF heredado con desglose reconstruido; centro de facturación con buscador q+cursor,
  cargo con categoría, PIN al anular; quick check-out sin `status`; TPV honesto
- puertas: typecheck 15 PASS · 0 FAIL · 1 SKIP · api 2.302 (2.301 pass · 1 skipped)
  · worker 20/20 · front 1.276/1.276 (desde apps/admin-web con el tsx de apps/api) ·
  contratos raíz 532/532 · integración COMPLETA (49 ficheros) 661 tests · 654 pass ·
  0 fail · 7 skips conocidos · discoverability OK (16/20) · build-nav-tree al día (68
  · 101 · 205) · check-route-access OK (15 × 192) · Cocoa 226 pantallas · 193 puntos ·
  inlineStyles 679 = techo · contrato 18/18 · admin-web build OK · rbac:sync dry-run
  250 · +0 · 0 stale · 0 behind (NO solapar con la integración: 26 suites borran orgs)
- flujo real por HTTP en `:3903` (A pid 57621 → B 61334) como `recepcion.rias`,
  `direccion.rias`, `contabilidad` y Carmen: 4 reservas con precio desde tarifa
  (196 / 390 / 98 con aviso BAR-NR → BAR / 253), preview del CSV de T7 en dry-run
  (1 fila cotizada 306,00; con referencias nuevas 3 cotizadas 734,00), cancelación
  gratuita (folio cerrado) y tardía (126,50 primera noche, renuncia 409 T2, 2º cancel
  409, cobro, close 409, F2 `FS-RA-2026-000003` IVA 0, close 200), cobro desde la
  reserva en 2 rutas (cargo room → accommodation, 390 cash, F2 `FS-RA-2026-000002`
  IVA 35,45), 4 PDF `%PDF-` 1 página con QR (35.208 / 36.586 / 34.908 / 34.943 B),
  303 2026-Q3 con pruebas 239.530,75 / 76.220,42 / 163.310,33 (200 registros,
  cuadra) = SQL nativas 40 filas 110,66 + sage200 61 filas 239.424,64 − 4,55 derivados
  · 0 nº nativos entre filas Sage; tras limpieza 239.495,03 / 76.220,42 / 163.274,61
  (197 registros, cuadra); TPV ?status 200/200/200 y 400, ticket 3,00 → simplificada
  automática `FS-RA-2026-000001`; arqueo abierto en A, releído en B tras matar A,
  cerrado (103,00 = 100 + 3, diferencia 0) y aprobado por contabilidad (recepción 403)
- limpieza por SQL con ids explícitos (5 asientos, 3 facturas + VeriFactu + libro,
  1 comanda, 1 arqueo, 2 pagos, 4 folios, 4 reservas; serie SIM 4 → 1); invariantes
  idénticas antes / después / tras la integración: 25 facturas · 33 VeriFactu · 110
  reservas · 4.951 asientos (63 núcleo) · 34 lotes Sage · 250 / 24 / 31 · 2 orgs;
  quedan 34 `audit_events` encadenados de la prueba (por diseño) y 8 `journal_lines`
  huérfanas ANTERIORES (deuda); hallazgos INT-L3-01…09 (VeriFactu envía en sandbox
  con `verifactu_enabled=false`; el TPV emite simplificadas en la serie real SIM;
  `out_bar` vs id de fila; cadena fija de política en el quote); decisiones para
  César en el informe §9 (políticas reales por hotel, categorías fiscales de la
  penalización, PSP, plantilla de PDF, rebuild Q3, cierre del día de RA)

Estado verificado (Tanda L5 · Operaciones y puesta en marcha + rondas de corrección 1 y 2,
2026-09-19; working tree sin commit sobre HEAD e6acd8c (TL fusionada) — los lotes L5-A/B/C/D
más el corrector; `pnpm-lock.yaml` modificado NO es de L5 (lock por detrás de los
package.json de HEAD): dejarlo fuera del commit; informe
`docs/audits/TANDA-L5-OPERACIONES-2026-09-19.md`):
- migraciones `20260919090000_operaciones_l5` (estado de habitación unificado: hk / mnt
  NOT NULL con vocabulario cerrado, `properties.go_live_at`, índice de partes) y
  `20260919120000_operaciones_l5_backfill_parte_titular` (solo datos, corrector CS-05:
  `is_primary_guest = true` donde el vínculo es titular; 15 filas en local, copia
  previa de la tabla en el scratchpad) → **17/17 al día, drift 0**
- estado de habitación: `modules/housekeeping/room-state.service.ts` (máquina pura +
  `applyRoomTransition` idempotente y auditada `ROOM_STATE_CHANGED`; 9 eventos: los
  siete de L5-A + `mark_sellable` / `mark_unsellable` de `POST /rooms/:id/sellable`);
  corrector: bloqueo sobre OCUPADA conserva `occupied` (OP-01), check-out de bloqueada
  → `out_of_order`, eventos DIFERIDOS al commit dentro de transacciones
  (`emitRoomStateEvents`, OP-03), `canAssignRoom` y `computeRealAvailability` rechazan
  OOO/OOS sin bloqueo (OP-02), importación de onboarding no crea `blocked` sin orden
  (OP-07), bulk PATCH en transacción (OP-09), Room Rack cuenta ocupada la alojada con
  bloqueo, instantánea del cierre plegada como los dashboards (OP-06)
- SES honesto (`ses-submission.service.ts`): interruptor = OR de `properties` y
  `property_compliance_settings` (CS-01, `sesHospedajesEnabledFor`), bajas nunca
  bloqueadas por `SES_DISABLED` (CS-09), retry / programador / pipeline con las mismas
  puertas que el encolado (`sesRequeueGate`, CS-02: el programador descarta duplicadas
  «sustituidas» y partes aceptados, falla definitivamente inválidos; `SES_DISABLED`
  recuperable), XML con sexo / residencia / bloque de menor (CS-03), descartadas fuera
  de `sesOverdue`, `sesPending` (GM, portfolio), del KPI de la pantalla SES y de
  `?status=failed` salvo `includeDiscarded` (CS-04; `property-overview.service.ts` de
  T8 sigue contándolas: pendiente), negativa auditada con actor usuario (CS-07),
  descarte con `compliance.ses.configure` (CS-10), retención RGPD desde la salida
  prevista (CS-06), seed sin forzar interruptores en el re-seed (CS-11); test unitario
  del validador dentro de la puerta raíz (`tests/compliance-package-tests.test.mjs`)
- cierre del día: reapertura del ÚLTIMO día cerrado rebobina `business_dates` y el run
  `reopened` se re-ejecuta (`businessDateRewound`); un día anterior solo se revisa
  (review admite `reopened`) (OP-04); preflight «folios liquidados» medido por folio
  (OP-08, `computeBalancesForFolios`)
- puesta en marcha: `POST /onboarding/projects/:id/go-live` delega en la aprobación real
  (`approveGoLive` de backoffice; 409 `ONBOARDING_NOT_APPLIED` sin propiedad aplicada)
  (L5F-04); pasos con `label` desde el API (L5F-06); Setup Center distingue el fallo de
  readiness (sin «Bloqueantes 0», L5F-05); tests de pantalla del banner, de la cabecera
  de Salida en vivo y de la sección de lanzamiento (`layouts/setup-banner.ts`,
  `screens/go-live-state.ts`, `screens/backoffice/launch-readiness.ts`) (L5F-02);
  `go_live_at` de demo en el seed (prop_123 / prop_canary, 2026-06-01) y en
  `chain-8-hotels` (2026-09-14) solo si está vacío (L5F-07); Cocoa §6 regenerado
  (95.990 líneas, inlineStyles 679 = techo, 227 pantallas)
- puertas del corrector (03:0x): typecheck api + admin-web OK · api unit 2.356
  (2.355 pass · 1 skipped) · front 1.447/1.447 · contratos raíz 535/535 (tras
  regenerar el inventario Cocoa) · waves --check OK · admin-web build OK · integración
  lote 1 (l5-estado-habitacion, l5-parte-viajeros-ses, l5-night-audit-canceladas,
  l5-readiness-golive, l2-persistencia-plataforma, l2-persistencia-backoffice,
  rbac-sod, l2-robustez) 88/88 · lote 2 (api-integration, pos-cash-night,
  l2-modulos-operaciones, l2-rutas-api, l2-modulos-ia, l2-persistencia-ses,
  structure-l2) 101/106 + 2 skips: los 5 fallos son la invariante «cifras de Faranda»
  (reservas 5.974 → 6.136 DURANTE el lote: carga real de OPERA en paralelo), no código
- ronda de corrección 2 (informe §2.3): los 21 arreglos re-verificados en el árbol y por las
  puertas (api unit 2.356 · front 1.447 · raíz 535 · integración lote 1 88/88); puerta 5:
  `LiveTimeline` (Tanda TL fusionada sin montar) en `.discoverability-whitelist.json` de forma
  TEMPORAL hasta aplicar las líneas §6 del informe TL; puerta 9: `structure-l5` 14/14,
  `structure-e2e` 29/29 y `fiscal-models` 11/11 sin `in: [143k ids]` (JOIN / subconsulta) y con
  expectativas por regla (origen del 303 según `loadVatBookRows`, 390 según filas Sage de 2026,
  reversos de nómina excluidos como su original), sin re-fijar cifras del piloto (303 real de
  Faranda 2026-Q3 hoy 27 = 71 = 70,39 · 38 registros); `go_live_at` por SQL NO aplicado (escritura
  sobre la BD compartida denegada por el arnés): sigue en §5.4 del informe
- integrador (2026-09-19 03:38-04:00, informe §7-§9): copia previa
  `backups/hotelos-pre-l5-integracion-20260919-033833.dump`; flujo real por HTTP en `:3907`
  (organización aislada `org_l2_*` con las plantillas de T8a + `@faranda.test`): check-in deja
  `occupied` con la limpieza intacta, mark-clean sobre ocupada no libera, inspección ×2 → un solo
  `ROOM_STATE_CHANGED`, alias `ready` / 400 `foo`, check-out 409 `BALANCE_DUE` → cobro → `dirty/dirty`
  + tarea, «Iniciar» = PATCH de la tarea; parte sin firma → 409 `GUEST_REGISTER_INVALID`, firmado →
  `accepted` (sandbox), reenvío → 409 `GUEST_REGISTER_NOT_QUEUEABLE`; readiness calculada en el GET y
  go-live real (`approved` → `alreadyLive`); cierre del día con puerta (409 `NIGHT_AUDIT_PREFLIGHT_BLOCKED`
  → `force` + motivo auditado), revisión SoD, reapertura del último día con `businessDateRewound` y
  re-cierre sobre la misma fila. **Faranda**: RA cerrada 13/09→19/09 (6 runs, 70 cargos 7.314,63 €,
  477 folios liquidados cerrados, 14 con saldo 854,75 € forzados, 1 reabierto/re-cerrado/revisado) y
  LT 14/09→19/09 (5 runs, 83 cargos 8.552,72 €, 343 cerrados, 1 revisado); go-live real de LT, PG,
  MC, AS, FN y LL (`go_live_at`, paso `go_live`); RA `blocked` (registro SES + sandbox) y OC (oficina).
  Arreglos del integrador: **INT-L5-01** `night-audit-in-house.ts` (solo se carga la noche a la
  reserva alojada ESA noche: min(llegada, check-in físico) ≤ fecha de negocio; `metrics.notYetInHouse`;
  RA 13/09 habría facturado a 20 huéspedes no llegados), **INT-L5-03** `admin_user_exists` cuenta las
  `user_role_assignments` vivas (la ruta T8a no escribe el espejo), **INT-L5-07** `/dashboards/housekeeping`,
  `GET /properties/:id/dashboard` e instantánea del cierre solo con habitaciones `active` (RA: 147 vs 102);
  helper `l2-tenant` con vocabulario cerrado. Abiertos: INT-L5-02 (`guests[]` de la reserva se
  descarta → 1 parte de 2), INT-L5-04 («Limpia» no cierra la tarea), INT-L5-05 (día anterior reabierto
  no admite revisión nueva), INT-L5-06 (gating de módulo: `admin` / `owner` 403 en backoffice).
  Corrección de la ronda 2: `business_dates` se leyó con la FUNCIÓN SQL `current_date` (RA seguía en
  2026-09-13 y LT en 09-14; hoy ambas 09-19 con 11 runs). Puertas (04:00): typecheck 15/15 + 1 skip ·
  api unit 2.365 (2.364 pass · 1 skip) · front 1.447/1.447 · raíz 535/535 · integración completa
  707 (700 pass · 0 fail · 7 skips conocidos) · discoverability / nav-tree / route-access OK ·
  Cocoa inventario idéntico + waves + 18/18 · build OK · migraciones 17/17 + drift 0 · rbac +0 (46
  plantillas) · worker 20/20; invariantes 25 · 33 · 13.457 · 250/24/31 · 2 orgs · 0 residuales;
  `:3907` parado, `:3000` intacto (código anterior a L5: reiniciar antes del cierre de esta noche).
- pendientes para el integrador / L6a: `modules/ai/check-in.command.ts` debe tolerar
  409 `SES_DISABLED` (hoy solo `SES_ESTABLISHMENT_INCOMPLETE`; el test de plataforma
  activa SES en su tenant); `dashboards/property-overview.service.ts` (T8) excluir
  `SES_DISCARDED`; `go_live_at` de los 8 centros Faranda por SQL o re-seed
  `chain-8-hotels`; las 15 filas SES aparcadas de RA las clasifica el programador en el
  primer tick tras reiniciar el API (11 «sustituidas», 3 de partes aceptados
  descartadas, 1 inválida definitiva)

Estado verificado (Tanda T8 · Reputación y reseñas + fusión E1/E2, 2026-09-19,
main tras 9966c4f):
- fusión cableada: las 12 rutas de `modules/reputation/route-permissions.partial.ts`
  registradas en `server.ts` y en el manifiesto (+12 → 948); job diario del líder
  (`reputation-sync.job.ts`, 24 h, lease + advisory lock por propiedad,
  `REPUTATION_SYNC_DISABLED|INTERVAL_MS|RUN_AT_BOOT`); cola `reputation.maintenance`
  del worker (5 colas; cron `15 4 * * *` Europe/Madrid); clasificador
  `review_notification` en el buzón (`email-reservation.service.ts`); hook
  `ReviewReceived` no-op documentado en `event-hooks.service.ts`; seed
  `demo:seed-reputation` (no activa módulos; Faranda sin `reputation_quality` por
  decisión del propietario)
- IA: `draftReviewResponse` riskLevel high (`packages/ai-tools/src/registry.ts`) +
  adaptador `modules/reputation/reputation-ai.core-adapter.ts` sobre ai-core
  (siempre redactPii/restorePii), registrado en el arranque del API solo con
  proveedor configurado; sin proveedor el borrador es `source: rules`
- esquema: parche T8-L0 aplicado (migración `20260919124000_reputacion`;
  `external_reference` nullable) + T8-L0b fase 1 (doble escritura columnas +
  `topicsJson`, runs de fuente en tabla, menciones, `reviewId` en casos)
- E1: `createId` → `<prefijo>_` + 16 hex (`aud_`/`evt_` incluidos); P2002 en los
  persistidores se registra por pino (`setAuditLogger(app.log)` en server.ts; sin
  logger, CLI/tests, línea JSON por console.error) y suma `auditPersistFailures`, expuesto
  en `/health` `checks.audit`; runbook `docs/runbooks/auditoria-eventos.md` (rotura
  de la cadena local del 2026-09-19 documentada, no reparada)
- E2: coordinador de apagado `lib/shutdown.ts` (SIGTERM/SIGINT → schedulers →
  `app.close` → `audit.flush` (`flushAuditQueues`) → `prisma.$disconnect`;
  `SHUTDOWN_TIMEOUT_MS` 10 s con el plazo referenciado (sin `unref`: un paso
  colgado sin handles vivos también sale con 1); segunda señal sale ya);
  `docs/deployment.md` TimeoutStopSec / stop_grace_period ≥ 15 s
- cifras de la puerta final (lote 3A-final, 2026-09-19): typecheck:all 15 PASS · 0 FAIL ·
  1 SKIP · api unit 2.860 (2.859 pass · 0 fail · 1 skip `PMS_HF_REAL_CSV`; +2 casos del
  corrector T8: plazo de apagado con temporizadores reales y logger de auditoría) · ai-core
  119/119 · front 1.505/1.505 · contratos raíz 541/541 (+1: `QualityCaseUpdated`) · worker 34/34
  · integración completa (`--test-concurrency=1`) 782 (775 pass · 0 fail · 7 skips
  condicionales de entorno; `api-reference` qa#17, `l8-reputation-sync` y `l2-modulos-comercial`
  ya corregidos en el árbol: la plantilla `admin` v3 lee huéspedes desde 2613f47) ·
  `l8-reputation-routes` 13/13 con el cableado real (sin empuje del manifiesto; PATCH valida
  `assignedUserId` contra la organización) ·
  admin-web build OK · rbac:sync dry-run 250 claves · +0 · 0 stale · 46 plantillas · 0
  behind · migraciones 18/18 + drift 0 · Cocoa 232 pantallas · 182 puntos · inlineStyles
  647 = techo · rawTables 1 · contrato 18/18 · waves §6 al día · build-nav-tree al día (69 ·
  100 · 205) · discoverability OK (16/20) · check-route-access OK (15 × 192) · env census
  153/153 + contrato 9/9 · `:3911` healthy (`checks.audit` ok, schedulers y reputationSync
  disabled por `RUN_SCHEDULERS=false`), SIGTERM → exit 0 en 24 ms
- pendientes: reinicio de `:3000` (sirve código anterior a T8); `POST
  /ai-operations/tools/sync` tras el reinicio (`draftReviewResponse` high);
  verificación en navegador (bandeja, fuentes, dashboards Cocoa); T8-L0b fase 2
  (lectura desde las columnas/tablas nuevas y retirada de la doble escritura);
  T8-L5 OAuth Google Business (`GOOGLE_BUSINESS_*`); plantilla
  `review_negative_received`; envío real de encuestas

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

Estado verificado (Tanda UX-1 · «Feel» de recepción, 2026-09-19, main tras 150a713 +
fusión de `tanda-ux1` 4e7fdee):
- diseño `docs/design/UX-RECEPCION-FEEL.md` implementado en 13 lotes (U0a…U10):
  check-in sin habitación con candidata sugerida; diccionario de estados
  (`content/status-dictionary.ts`, `CocoaStatusBadge`, vocabulario «Llega hoy · En el
  hotel · Sale hoy · Salida hecha · No-show · Cancelada»); `useApiData` v2 (caché,
  SWR 30 s, mutate optimista con rollback, abort, prefetch) y dedupe de GET en
  `api-client`; toast con acción y pausa, `CocoaUndoBar`, región viva única del
  shell, skip link, esqueletos a 300 ms, `CocoaTable` selección/columnas/keepData,
  `CocoaInspector`; ⌘K con comandos de página, ⌥+letra, teclas de acceso, `PaymentDialog`
  como form; check-in con cobro real (saldo/depósito/sin cobro, sin «preautorizar»);
  Mi día con acción contextual, inspector, lote de check-out de salidas de hoy,
  `WalkInDrawer` (⌥W); ficha con primaria única por estado, cambio de habitación
  con deshacer, `LifecycleDialog`; lista/huéspedes/mensajes con keepData e inspector;
  `ReservationQuickCreate`; Live Timeline con deshacer sin diálogo, teclado
  ⌥←→↑↓ y objetivos táctiles ≥ 44 px; densidad operativa por dispositivo
- medida automatizada del camino óptimo: `apps/admin-web/e2e/measure` (MEASURE_STRICT=1,
  tenant aislado `org_uxday/prop_uxday` del seed `db:seed:ux-day -- --reset`);
  baseline y final en `docs/audits/ux-recepcion/measure-*.json`: T1 2 clics · T2 13 → 2
  clics · T3 3 · T4 no completable → 4 · T5 9 → 1 clic · T6 2 → 0 clics (solo teclado);
  los seis objetivos de §8.3 cumplidos
- `corepack pnpm --filter @hotelos/admin-web test` existe (unitarios del front con el
  tsx de apps/api); e2e 44/45 (la spec solo-teclado de quick-checkin depende del
  orden de specs: pendiente), informe `docs/audits/TANDA-UX1-RECEPCION-2026-09-19.md`
- API: `POST /properties/:id/reservations` responde 400 `PAST_ARRIVAL_DATE` salvo
  `allowPastArrival` con `pms.reservation.modify`; la lista devuelve `primaryGuestName`;
  `/search` enruta los hits de habitación al tablero
- pendientes con dueño (informe §9-§10): folio del walk-in sin cargo de alojamiento
  hasta el cierre («anticipo»), sin deshacer de la primera asignación desde la cola,
  contraste 1.4.11 en claro de badges warning/success, `role=grid` para selección
  múltiple, sesiones con recepcionistas reales (kit en `docs/runbooks/ux-recepcion-pruebas.md`)
