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
