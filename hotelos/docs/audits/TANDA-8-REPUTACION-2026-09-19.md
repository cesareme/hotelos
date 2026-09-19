# Tanda T8 · Reputación y reseñas · Integración y verificación — 19 de septiembre de 2026

**Para:** César. **Encargo (16/09/2026):** «módulo tipo review pro: un bot que haga investigación diaria de todos los
portales de reseñas (Google, TripAdvisor, Booking, Expedia, HolidayCheck…) y un score medio como parte fundamental del
panel de dirección y de Mi día». **Método:** diseño (`docs/design/REPUTACION-REVIEWS.md`) → reconocimiento
(`tandaT8-recon.md`, re-verificado fichero:línea) → nueve lotes en el worktree `~/anfitorio-demo-wt-t8/hotelos` (rama
`tanda-t8`, base `776782a`; T8-A tipos, T8-B bot puro, T8-C servicios y job, T8-D rutas, T8-E dashboards, T8-F job de
mantenimiento del worker, T8-G front Cocoa 22, T8-H seed ficticio, T8-I mergeLines) → ronda de corrección 1 (27 hallazgos
BD/HP/T8F, todos corregidos con test) → **integración (este documento, 19/09 03:5x-04:3x CEST):** nueve puertas en verde
desde el worktree, verificación funcional por `app.inject` con registro local de las 12 rutas (colector CSV → reseñas
normalizadas → índice por hotel → bandeja con borrador por plantilla → HITL que no publica → job diario en seco → permisos
con las plantillas de T8a en un tenant aislado y con los usuarios REALES de T8a sobre Faranda → seed ficticio aplicado y
revertido por CLI), instancia propia `:3908` arrancada y cerrada, BD limpia, mergeLines EXACTAS re-basadas al árbol
principal (`ca24ed6`, con L6a fusionada) y parche de esquema con la migración `2026091912xxxx_reputacion`.

**Resultado en una línea:** el módulo funciona de punta a punta SIN migración, SIN clave de IA y SIN credenciales de
portal (todo ello degradado de forma honesta y documentada): 12 reseñas ficticias importadas por CSV con escalas 5/10 e
idiomas es/en/pt quedan normalizadas sobre 10 (5/5→10, 9/10→9, 1,5/5→3, 3/10→3), analizadas por diccionario y con 4 casos
`review_negative` abiertos; el hotel obtiene un Índice de Reputación 70,7/100 que el panel del director y la ficha de la
propiedad leen igual (y `module_off` donde el módulo está apagado); el borrador de respuesta sale por plantilla (66
palabras, etiqueta `rules`) a un ítem de revisión humana cuya aprobación NO publica (publicar es `POST …/respond` de una
persona con `reputation.respond`, y solo una vez: 409 la segunda); el tick diario en seco recorre 2 propiedades, salta
Google «sin credenciales» y deja `prop_123` intacta; un lock ajeno por propiedad convierte importación y sincronización en
409 `REPUTATION_SYNC_BUSY`; recepción, contabilidad, sistemas y la dirección general reciben 403 donde toca y 404 fuera de
su ámbito (también con `comercial.galicia`, `direccion.rias`, `recepcion.tilos` y la dirección general reales sobre Rías
Altas y Los Tilos, sin escribir nada en Faranda); el seed ficticio siembra 3 fuentes, 60 reseñas, 2 encuestas y 6 casos
en un tenant aislado y `--purge` los retira dejando las 12 reseñas del CSV; **Faranda queda idéntica** y las **12 rutas y
el job no están cableados** hasta que el orquestador aplique las mergeLines de §7 (ficheros prohibidos para la tanda).

---

## 1. Alcance y qué cambia

| Antes (recon §1) | Ahora (verificado hoy) |
|---|---|
| 5 tablas de reputación vacías, sin escritor ni ingesta; `ReviewSource.status` fijo en `connected` | Ingesta real por CSV / filas JSON / correo de notificación (extracto); fuentes con estado honesto `pending · connected · degraded · error · disabled · unavailable` + `lastError`, ejecuciones (`configJson.runs` ≤ 20), todo sobre las tablas EXISTENTES (`topicsJson` = `ReviewMeta v1`, `configJson` = `ReviewSourceConfig v1`) |
| Tres lectores con tres medias simples de `rating` sin escala (GM 0-10, Reputación «/ 5», overview sin ventana) | `score10` normalizado (escalas 5/6/10), Índice de Reputación 0-100 ponderado por portal (peso 0,1-2, tope 60 %) y recencia (semivida W/2), ventanas 30/90/365, mínimo 10 reseñas → `insufficient`; el director (`reputationIndex`, aditivo sobre `reputation` de L2), la ficha (`guestExperience.reputationIndex30`) y `/dashboards/reputation` leen el MISMO snapshot (caché 60 s) |
| Sin análisis, sin borrador, sin bandeja; `ai-draft-response` retirada en L2 | 12 categorías + sentimiento + resumen por diccionario (o modelo por `ReputationAiPort` cuando L6a lo enganche), bandeja `new → assigned → drafted → responded → closed` (+ `ignored`) con plazos 48/72/96 h, borrador `POST /reputation/reviews/:id/draft` → ítem HITL `review_response`; aprobar nunca publica |
| Sin job; worker con 4 colas | Job diario del líder en el API (`REPUTATION_SYNC_*`, lease + advisory lock global 4 h + lock por propiedad 30 min); job de mantenimiento del worker escrito y probado pero NO cableado (decisión §9 #2) |
| 8 rutas del motor genérico; 0 pantallas operativas | +12 rutas (`modules/reputation/reputation.routes.ts` + `route-permissions.partial.ts`, 0 claves nuevas); Reseñas/Encuestas/Calidad operativas en Cocoa 22 (6 cajones nuevos a 0 `style={}`, `ReputationDashboard` 6 → 0, GM 12 → 10) y fila «Índice de reputación (30 d)» en Mi día › Dirección |
| Sin datos demo | Seed FICTICIO por CLI (`seed-reputation-demo.ts`, dry-run por defecto, `--allow-real --confirm`, `--purge` solo `isDemo`); 0 reseñas reales en la BD |

Sin cambios en `permissions.ts`/`types.ts` (las 6 claves `reputation.*`/`surveys.*`/`quality_cases.*` de T8a bastan), sin
migración (parche entregado en §8), sin dependencias nuevas, sin tocar `pnpm-lock.yaml` (su ` M` +52 es deuda previa de
la carga Sage y **se excluye de la fusión**).

## 2. Lotes y ficheros (worktree `~/anfitorio-demo-wt-t8`, `git status`: 15 ` M` + 74 `??`, 22.768 líneas nuevas)

| Lote | Qué | Ficheros exclusivos (líneas) |
|---|---|---|
| T8-A | Tipos wire y bloque `SHARED-BEGIN…SHARED-END` byte a byte API ↔ front | `apps/api/src/modules/reputation/reputation-types.ts` (1.064), `apps/admin-web/src/services/reputation-contracts.ts`, tests de paridad |
| T8-B | Bot puro: normalización a `score10`, idioma, diccionario 12 categorías (es/en completos; de/fr/pt reducidos), parser CSV, parser de correo (`classifyInboundEmail`), enmascarado PII provisional, 6 colectores honestos, índice IRE, puerto de IA con reglas | `review-normalize.ts` (193), `review-language.ts` (157), `review-categories.dictionary.ts` (702), `review-csv.parser.ts` (405), `review-email.parser.ts` (343), `mask-pii.ts` (129), `collectors/*` (856), `reputation-index.ts` (342), `reputation-ai.{port,rules}.ts` (104 + 301) |
| T8-C | Servicios con Prisma: store sobre JSON, fuentes, bandeja, borrador HITL, alertas, tick, job del líder, snapshot del índice, `env.partial.ts` (6 variables) | `review-meta.store.ts` (429), `review-sources.service.ts` (338), `review-inbox.service.ts` (408), `review-draft.service.ts` (305), `review-alerts.service.ts` (177), `reputation-sync.service.ts` (585), `reputation-sync.job.ts` (161), `reputation-lock.ts` (84), `reputation-score.service.ts` (258), `reputation-context.ts` (37), `env.partial.ts` (63) |
| T8-D | 12 rutas + partial + esquemas zod | `reputation.routes.ts` (465), `route-permissions.partial.ts` (52), `schemas/reputation.schemas.ts` (276), `tests/integration/l8-reputation-routes.test.mts` (507) |
| T8-E | Dashboards aditivos (reputation, general-manager, surveys, quality, property-overview) | 5 servicios modificados (+281/−176), `reputation-summary.ts` (498), `dashboards/__tests__/`, `l8-reputation-dashboards.test.mts` (353) |
| T8-F | Job de mantenimiento del worker (purga por retención, plazos vencidos, recorte de runs) SIN cablear | `apps/worker/src/jobs/reputation-maintenance.job.ts` (377) + test |
| T8-G | Front Cocoa 22: 6 cajones nuevos, 4 pantallas migradas, servicio tipado, fila del director | `screens/operations/reputation/*` (2.183), `services/reputationApi.ts`, 4 pantallas modificadas (+1.034/−…), 3 tests, `cocoa-22-inventory.json` regenerado |
| T8-H | Seed ficticio por CLI | `scripts/seed-reputation-demo.ts` (608) + `.dataset.ts` (685) + test |
| T8-I | mergeLines, parche de esquema, runbook | `docs/design/olas/T8-MERGE-LINES.md` (807), `docs/design/olas/T8-SCHEMA-PATCH.md` (709), `docs/runbooks/reputacion-reviews.md` |
| Fuera de lote (permitidos, anotar) | `gdpr.service.ts` (+18/−4: pseudonimización de la meta de reseña, HP-04), `MoreScreen.tsx` (1 línea, español), `tests/sidebar-nav-contract.test.mjs` (+3/−1, `reputation_quality` ya no «en memoria»), `ModuleManager.tsx` | — |

Convención anotada para `CLAUDE.md`: los comentarios de `modules/reputation/**` están en español por instrucción del
orquestador (la regla del repo dice «comentarios en inglés»).

## 3. Puertas (desde el worktree, 19/09, sin las mergeLines aplicadas)

| # | Puerta | Resultado |
|---|---|---|
| 1 | `node scripts/typecheck-all.mjs` | 16 workspaces · **15 PASS · 0 FAIL · 1 SKIP** (apps/guest-web, deuda preexistente) · 19,1 s |
| 2 | `corepack pnpm --filter @hotelos/api test` | **2.647 tests · 2.646 pass · 1 skipped · 0 fail** (770 suites; +21 sobre §16.2) |
| 3 | Front admin-web (105 ficheros `__tests__/*.test.mts` desde `apps/api`, `$(find …)` inline en zsh) | **1.333 tests · 1.332 pass · 1 skipped · 0 fail** |
| 4 | `node --test tests/*.test.mjs` (contratos raíz) | **525 tests · 523 pass · 2 skipped · 0 fail** (skips: `nav-tree-contract` «JSON = CSV» y `rbac-nav-contract` «cada plantilla…»: `pilots/*.csv` vive fuera del repo y no existe bajo el worktree → correr en el árbol principal tras la fusión) |
| 5 | `corepack pnpm --filter @hotelos/worker test` | **34/34** (20 + 14 de T8-F; la cola sigue sin registrar en `scheduler.ts`) |
| 6 | `corepack pnpm --filter @hotelos/admin-web build` | OK · «built in 2.55s» · chunk mayor `screens-operations-rest` 712,85 kB |
| 7 | Integración `tests/integration/l8-reputation-{dashboards,routes,sync}.test.mts` | **31/31** (en paralelo y serializado; junto a `l2-{motor-generico,paginacion,robustez}` **73/73**); BD después: 0 `org_l2_*`, 0 filas de reputación |
| 8 | grep de ficheros prohibidos en `git status` | 0 coincidencias salvo `pnpm-lock.yaml` (deuda previa, excluir); `route-permissions.partial.ts` es el fichero NUEVO autorizado |
| 9 | Cocoa 22 (`scripts/cocoa-22-inventory.mjs` + contrato 18/18) | 232 pantallas · 191 puntos · `inlineStyles` **671 ≤ 679** (JSON regenerado byte a byte = el del worktree); pendiente bajar el techo (§7 #19) |

## 4. Hallazgos de la ronda de corrección 1 y estado (todos corregidos y pinados con test)

| Id | Sev. | Hallazgo → corrección (fichero:línea) |
|---|---|---|
| BD-01 | alta | Lectura incompleta del colector contaba como éxito → estado `partial` (SHARED) en `reputation-sync.service.ts:326`; `appendSourceRun` (`reputation-types.ts:1060`) solo avanza `lastSuccessAt` con `completed` |
| BD-02 | media | Peso por fuente pisado entre dos fuentes del mismo proveedor → `reviewWeight`/`resolveReviewWeight` (`reputation-index.ts:95,111`), peso por reseña en `reputation-score.service.ts:76` y `reputation-summary.ts:315` |
| BD-03 | alta | Transacción larga del lock con trabajo dentro → `reputation-lock.ts` `withAdvisoryLock` (la tx solo sostiene el lock; trabajo en autocommit; `lockExpired`); lock global 4 h + `withPropertyLock` 30 min; el seed corre el tick tras confirmar |
| BD-04 | alta | Dos importaciones/sync simultáneas duplicaban → `reputation.routes.ts:133` `underPropertyLock` → 409 `REPUTATION_SYNC_BUSY` (**verificado hoy**, §5.5) |
| BD-05 | media | «del 3/10/2026» leído como nota → `review-email.parser.ts:150` `looksLikeDate` |
| BD-06 | baja | País recortado → `review-csv.parser.ts:276` `countryCodeFor` (ISO-2 o nombre conocido; resto se descarta) |
| BD-07 | media | Hash con `receivedAt` → repetir el seed re-analizaba 90 reseñas → identidad por referencia explícita (`review-meta.store.ts:146`) (**verificado hoy**: repetición created 0 / unchanged 60) |
| BD-08 | media | Cupo de análisis global → por propiedad y tick (`reputation-sync.service.ts:468`) |
| BD-09 | baja | «Viajero 12» perdía el dígito → `review-normalize.ts:191` |
| BD-10 | media | Google no retomaba la paginación → cursor `nextPageToken` (`google-business-profile.ts:216,261`) |
| BD-11 | media | Fecha de la reseña en correo = fecha del correo → `extractLabeledDate` (`review-email.parser.ts:263`) |
| HP-01 | alta | Borrador rechazado en HITL publicable tal cual → `assertDraftPublishable` (`review-draft.service.ts:137`, 409 `REVIEW_DRAFT_REJECTED`), `draftReviewStatus` en el detalle, cajón bloquea; **la guarda en `POST …/respond` (server.ts) va como mergeLine §7 #5(a)** (hoy la ruta del motor acepta el texto rechazado: verificado, §5.4) |
| HP-02 | media | La purga del worker conservaba el nombre → `reputation-maintenance.job.ts:211` |
| HP-03 | media | Nombre completo del huésped en título/extracto del correo → `scrubAuthorName` (`review-email.parser.ts:236`); `mask-pii.ts` acepta `extraNames` |
| HP-04 | alta | Borrado RGPD no tocaba la meta → `scrubReviewMetaForErasure` (`review-meta.store.ts:350`) + `gdpr.service.ts:538` |
| HP-05 | media | `POST …/quality-case` solo con `quality_cases.manage` → + `reputation.read` (`route-permissions.partial.ts:51`) |
| HP-06 | media | Dashboard leía reseñas con módulo apagado y exponía el cuerpo → `module_off` sin leer; extracto ≤ 160 (`dashboards/reputation.service.ts:92,141`) |
| T8F-01…10 | baja/media | «Configurar» solo con `reputation.respond`; estado efectivo `responded` reconciliado (`effectiveReviewStatus`, `reconcileRespondedReviews` ≤ 200/vuelta); anclas de mergeLines corregidas; `pageBody` (array salvo `?envelope=1`); `ModuleManager`/sidebar sin `reputation_quality` «en memoria»; doc de `env.partial.ts` sin ruta inexistente; «Nuevo plazo» en el cajón (0 `style={}`); `MoreScreen` en español; paridad por texto worker ↔ API |

## 5. Verificación funcional del integrador (19/09 04:1x, `app.inject`, RBAC_STRICT=true, `NODE_ENV=production` y demo auth apagado en cada llamada)

Suite temporal `tests/integration/l8-t8-integrador-temp.test.mts` (borrada tras la ejecución; log
`scratchpad/t8-integrador-verificacion-2.log`): registro local de las 12 rutas + manifiesto empujado en vivo (patrón de
`l8-reputation-routes`), tenant aislado `org_l2_t…` con dos hoteles (módulo activado solo en A por `enableModules`, sin
pasar por la dependencia `ai_concierge`) y usuarios que replican las plantillas de T8a (`sales` = comercial, `manager` =
dirección, `receptionist`, `general_manager` + `owner` = dirección general, `accountant`, `admin`). **8/8 pasos en 4,8 s.**

| Paso | Evidencia |
|---|---|
| 5.1 Colector CSV → reseñas normalizadas | 12 filas ficticias (escalas 5 y 10 por fila; idiomas es/en/pt, una sin columna de idioma) → `created 12`, repetición `duplicates 12`; `score10` 5/5→10, 9/10→9, 1,5/5→3, 3/10→3; idioma detectado `es` sin columna, `en`, `pt`; sentimiento `positive`/`negative`; 12/12 analizadas en la importación (`analysis.source dictionary`); ningún cuerpo conserva el nombre del autor; **4 casos `review_negative`** (nota < 6) |
| 5.2 Índice por hotel | `GET /dashboards/reputation?propertyId=A` → `status ok`, `index.index30 70,7` (12 reseñas, `degraded []`); hotel B (módulo apagado) → `status module_off`; `GET /dashboards/general-manager` → `reputationIndex { status ok, index30 70,7, reviewCount30 12 }`; `GET /dashboards/property-overview` → `guestExperience.reputationIndex30 70,7`; snapshot `schemaPatchApplied false`, `staleDays 0` |
| 5.3 Bandeja + borrador por plantilla | Bandeja `sentiment=negative&responded=0` → 4 ítems `new` (extracto, sin cuerpo); `POST …/draft { tone: cordial }` → 201 `source rules`, `requiresHumanReview true`, 66 palabras, sin el nombre del autor; ítem `ai_human_review_items` `review_response` `pending`; reseña `drafted`, `responseBody null`; detalle `draftReviewStatus pending` |
| 5.4 HITL no publica; publicar es de la persona | comercial (sin `ai.high_risk.confirm`) approve → **403** «No tienes permiso…»; dirección approve → 200 y `responseBody`/`respondedAt` siguen **null**, ítem `approved`, detalle `draftReviewStatus approved` y estado `drafted`; recepción `POST …/respond` → 403; comercial `POST …/respond { responseBody }` → 200 (persistido); segunda → **409**; `PATCH { status: responded }` → 200. Borrador rechazado (dirección `reject { reason }`): `assertDraftPublishable` → `REVIEW_DRAFT_REJECTED`, texto editado pasa; **hoy `POST …/respond` del motor acepta el texto rechazado (200)** hasta la mergeLine §7 #5(a) |
| 5.5 Job diario en seco | Fuente `google` → 201 `unavailable`; `runReputationSyncJobTick()` → lock global obtenido, `properties 2` (la aislada + `prop_123`), `sources 2`, `fetched/created 0`, `reconciled 1` (la reseña respondida en 5.4), `purged 0`, `skipped 1` («Google Business Profile: sin credenciales (GOOGLE_BUSINESS_CLIENT_ID)»), `errors 0`; `prop_123` sin cambios (0 fuentes / 0 reseñas antes y después); `GET …/runs?sourceId=google` → run `skipped`. Con un lock ajeno `pg_try_advisory_xact_lock(hashtext('reputation.sync:<A>'))` en otra transacción: `POST …/imports` → **409 `REPUTATION_SYNC_BUSY`**, `POST …/sources/:id/sync` → **409**; liberado → sync `completed` |
| 5.6 Permisos (plantillas de T8a, tenant aislado) | recepción: GET inbox/sources 200 · POST sources/imports/draft y PATCH review **403** «No tienes permiso…» · hotel sin asignación **404** «Propiedad no encontrada.»; dirección general: GET 200 · POST sources 403 · `/dashboards/general-manager` 200; propiedad (owner): GET 200 · POST 403; contabilidad y sistemas (admin): GET inbox **403**; comercial en hotel sin módulo: GET y POST **403** «El módulo reputation_quality no está activado en esta propiedad.»; dirección en hotel sin asignación: 404; `POST …/quality-case` sobre reseña ya enlazada: 409 `QUALITY_CASE_ALREADY_LINKED` |
| 5.7 Usuarios REALES de T8a sobre Faranda (módulo apagado en los 8 centros; sesiones por `createSessionForUser`, sin contraseñas; solo lecturas y escrituras rechazadas antes de tocar datos) | `comercial.galicia` (sales, grupo RA + LT): GET inbox RA/LT **403 módulo** · POST sources RA **403 módulo** (RBAC pasa) · GET inbox del tenant ajeno **404** · `/dashboards/general-manager?propertyId=RA` 200 `reputationIndex.status module_off`; `direccion.rias` (manager RA): GET inbox RA 403 módulo · GET inbox LT **404** (fuera de ámbito) · POST sources RA 403 módulo · director 200 `module_off`; `recepcion.tilos` (receptionist LT): GET inbox LT 403 módulo · POST sources LT **403 RBAC** (sin `reputation.respond`) · GET inbox RA **404**; dirección general (`owner` + `general_manager` de organización): GET inbox RA/LT 403 módulo · POST sources RA **403 RBAC** (owner sin manage, general_manager solo lectura) · director y `/dashboards/reputation` de RA 200 `module_off`. `review_sources`/`guest_reviews` de Faranda **0/0 antes y después** |
| 5.8 Seed ficticio por CLI (tenant aislado) | `--apply --property A` sin `--allow-real` → **exit 2 sin escribir**; dry-run (`--allow-real --confirm <org>`) → exit 0, `applied false`, sin escribir; `--apply --reviews 60 --days 90 --seed 7` → exit 0: **3 fuentes `*_demo`, 60 reseñas `demo:7:*`, 2 encuestas, casos 4 → 10, `sync.ran true`, `index30 { ok, 79, 40 reseñas }`**; repetición → `created 0 / unchanged 60`; `--apply --purge` → 0 filas `isDemo`, las 12 reseñas del CSV y sus 4 casos conservados |
| Cierre | `cleanupTenant` → organización aislada desaparecida; manifiesto restaurado; **invariantes de Faranda idénticas** (facturas, VeriFactu, asientos, lotes Sage, reservas) |

**Instancia propia `:3908`** (`PORT=3908 RUN_SCHEDULERS=false RBAC_STRICT=true node --import tsx src/server.ts` desde el
worktree, pid 92071): `/health` 200 `healthy`, `schedulers: disabled on this instance (RUN_SCHEDULERS=false)`; sin token,
`GET /reputation/properties/prop_123/inbox` → **404** (las rutas NO están registradas en `server.ts`: es lo esperado hasta
§7 #1-#2) y `GET /dashboards/reputation?propertyId=prop_123` → 200 (fallback demo de dev en ruta de riesgo bajo,
`HOTELOS_ALLOW_DEMO_AUTH=true` del `.env` local; con `RBAC_STRICT` + `NODE_ENV=production` la suite anterior lo prueba
sin fallback). 0 errores en el log; proceso matado, `:3908` libre. `:3000`/`:5173` (árbol principal, L5) no se tocaron.

**BD después (SELECT):** organizaciones 2 (0 `org_l2_*`), `review_sources`/`guest_reviews`/`quality_cases`/`surveys`/
`survey_responses` 0/0/0/0/0, `ai_human_review_items` `review_response` 1 (semilla base `rev_review_004` → `grev_5521`,
preexistente), 0 `audit_events` de Faranda y 0 `sessions` en la última hora (los eventos `AUTH_LOGIN` de las sesiones de
5.7 quedaron en la cola en memoria al cerrar la app), 0 `audit_events` `org_l2_*` (barridos con el tenant); las 3 filas
`event_stream` `org_l2_*` son `ScheduledReportGenerated` del 18/09 15:08-15:16 (era L2, previas). Migraciones aplicadas en
la BD: `20260919120000_operaciones_l5_backfill_parte_titular` (última), `20260919090000_operaciones_l5`,
`20260918150000_dinero_fiscal`; el worktree `776782a` solo contiene la tercera → **nunca `prisma migrate` desde el worktree**.

## 6. Qué es real y qué no · degradación sin tablas nuevas y sin IA

- **Real hoy:** importación CSV/JSON (≤ 4 MiB, ≤ 5.000 filas, 10/min, idempotente por referencia + `contentHash`),
  correo de notificación como extracto (`bodyComplete: false`) cuando exista buzón y el hook de §7 #9, análisis por
  diccionario con etiqueta `dictionary`, borrador por plantilla con etiqueta `rules` y firma «Dirección de <hotel>»,
  publicación manual (`POST …/respond`, copiar y pegar en el portal donde no hay API), índice al vuelo, casos de calidad,
  encuestas y NPS reales, seed ficticio.
- **Preparado sin credenciales:** Google Business Profile (cliente HTTP inyectado; sin `GOOGLE_BUSINESS_*` la fuente nace
  `unavailable` «sin credenciales»; con cliente pero sin autorización `pending`; el intercambio OAuth y el refresco van a
  T8-L5); Booking/Expedia `unavailable` por política de los portales (solo connectivity partners/providers).
- **Sin IA (L6a fusionada en `ca24ed6` pero no enganchada):** `getReputationAiPort()` devuelve `RulesReputationAi`
  (`configured: false`, `provider: none`); el adaptador ai-core es la mergeLine §7 #13 (fichero nuevo + 1 línea); con IA
  `POST …/draft` exige además `ai.tool.execute` y pasa por `redactPii` además de `maskReviewForLlm`.
- **Sin el parche T8-L0** (runbook §9): upsert `findFirst + create` mitigado por el lock por propiedad (409
  `REPUTATION_SYNC_BUSY`); bandeja filtra en memoria sobre las 500 más recientes; índice al vuelo (≤ 5.000 filas / 365 d,
  caché 60 s, `staleDays 0`, sin histórico ni ranking materializado); ejecuciones en ring buffer de 20; categorías en JSON;
  `hasCredentials` siempre `false` (Google no puede quedar autorizado); casos enlazados por `topicsJson.qualityCaseId` +
  marcador `[reseña:<id>]`. Nada de esto cambia el contrato de las rutas ni de los DTOs.

## 7. mergeLines EXACTAS para el orquestador (re-basadas al árbol principal `ca24ed6` «Merge branch 'tanda-l6a'» + working tree de L5 a las 04:24; **el ancla es el TEXTO citado, único en cada fichero; la línea es orientativa porque L5 sigue editando `server.ts`**)

Verificación de anclas sin red (desde `~/anfitorio-demo/hotelos`; cada `grep` debe dar exactamente una línea):

```bash
cd ~/anfitorio-demo/hotelos
grep -n 'import { startPmsShadowJob } from "./modules/pms-shadow/pms-shadow.job.js";' apps/api/src/server.ts      # 107
grep -n '^  registerLedgerImportRoutes(app);' apps/api/src/server.ts                                                # 2883
grep -n '^  if (schedulerLeader && process.env.PMS_SHADOW_JOB_DISABLED !== "true") {' apps/api/src/server.ts       # 8713 (bloque hasta 8728; la función cierra en 8729)
grep -n 'app.post("/reputation/reviews/:id/respond"' apps/api/src/server.ts                                         # 3262
grep -n 'import { rbacRoutePermissions }' apps/api/src/security/route-permissions.ts                               # 52 (spread en 172; POST /surveys/:id/responses en 395)
grep -n 'PMS_SHADOW_ENV_CONTRACT' apps/api/src/lib/env.ts                                                          # 22 y 762 (doc RUN_SCHEDULERS en 697)
grep -n 'advancedTool("draftReviewResponse"' packages/ai-tools/src/registry.ts                                      # 152 (firma de 6 argumentos tras L6a: …, "medium", true, "read")
grep -n 'relatedEntityId: "grev_5521"\|moduleCode: "reputation",\|const minutesAgo' packages/database/prisma/seed.ts # 901 · 962 · 1060
grep -n '^## Tanda L2 · Persistencia y API' docs/api-contracts.md                                                   # 464 («935 entradas» en 466)
grep -n '^- Schedulers integrados\|^- manifiesto = rutas registradas' CLAUDE.md                                     # 115 · 288
grep -n '"demo:fix-identity"' apps/api/package.json                                                                 # 22
grep -n '^model ReviewSource \|^model GuestReview \|^model QualityCase \|^model UtilityMeter ' packages/database/prisma/schema.prisma  # 1878 · 1890 · 1939 · 1961
```

Orden: fusionar los ficheros exclusivos de T8 (todos los `??`/` M` del worktree salvo `pnpm-lock.yaml`) → #1-#8 (API) →
#9-#12 → #13 (IA) → #15-#17 (docs) → #19 (tests) → `node scripts/env-census.mjs --write` UNA vez (#7) → puerta final →
#20 (parche, cuando César lo decida) → #18 solo con decisión «sí».

### #1 `apps/api/src/server.ts` (L5) · imports · tras `import { startPmsShadowJob } from "./modules/pms-shadow/pms-shadow.job.js";` (:107)

```ts
// Reputación y reseñas (Tanda T8): /reputation/properties/:propertyId/{inbox,sources,runs,imports,
// sources/:id,sources/:id/sync} y /reputation/reviews/:id{,/draft,/quality-case}
// (modules/reputation/reputation.routes.ts; permisos en modules/reputation/route-permissions.partial.ts);
// job diario del líder (modules/reputation/reputation-sync.job.ts) en el bloque de schedulers.
import { registerReputationRoutes } from "./modules/reputation/reputation.routes.js";
import { reputationSyncIntervalMs, startReputationSyncJob } from "./modules/reputation/reputation-sync.job.js";
import { assertDraftPublishable } from "./modules/reputation/review-draft.service.js";
```

### #2 `apps/api/src/server.ts` (L5) · registro · tras `  registerLedgerImportRoutes(app);` (:2883)

```ts
  // Reputación y reseñas (Tanda T8 · T8-D): bandeja, detalle/PATCH/borrador/caso de una reseña, fuentes,
  // sincronización manual, ejecuciones e importación CSV (/reputation/properties/:propertyId/* y /reputation/reviews/:id/*).
  registerReputationRoutes(app, {
    collectorOptions: {
      ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
      ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
      ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
    }
  }); // Reputación y reseñas (Tanda T8)
```

### #3 `apps/api/src/server.ts` (L5) · scheduler · ENTRE la línea `  }` que cierra el bloque `if (schedulerLeader && process.env.PMS_SHADOW_JOB_DISABLED !== "true") {` (:8713-8728) y la `}` que cierra la función (:8729)

```ts

  // Reputación y reseñas (Tanda T8 · T8-C): job diario del líder — sincroniza las
  // fuentes de reseñas de las propiedades con reputation_quality, analiza (diccionario
  // o IA por ReputationAiPort), abre casos review_negative (score10 < 6) y purga por
  // retención; cada vuelta bajo pg_try_advisory_xact_lock(hashtext('reputation.sync'))
  // (modules/reputation/reputation-sync.job.ts). Vive aquí porque apps/worker no
  // depende de @hotelos/api. Disable with REPUTATION_SYNC_DISABLED=true. Como el modo
  // sombra: el arranque del módulo (runAtBoot + log) conserva la cadencia, pero su
  // temporizador propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.REPUTATION_SYNC_DISABLED !== "true") {
    const reputationIntervalMs = reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000));
    const reputationSync = startReputationSyncJob({
      log: app.log,
      intervalMs: reputationIntervalMs,
      runAtBoot: process.env.REPUTATION_SYNC_RUN_AT_BOOT !== "false",
      collectorOptions: {
        ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
        ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
        ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
      }
    });
    reputationSync.stop();
    const reputationTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await reputationSync.runNow();
    };
    const reputationTimer = setInterval(() => {
      void reputationTick().catch((error) => app.log.error({ err: error }, "[reputation.sync.job] failed"));
    }, reputationIntervalMs);
    reputationTimer.unref();
    const reputationJob = { stop: () => clearInterval(reputationTimer) };
    process.once("SIGTERM", reputationJob.stop);
    process.once("SIGINT", reputationJob.stop);
  }
```

(`schedulerLeader` y `holdsSchedulerLease` ya existen en el ámbito: el bloque pms-shadow los usa en las líneas
inmediatamente anteriores. Comprobado con `tsc` en el worktree, T8-MERGE-LINES §16.1.)

### #4 `apps/api/src/server.ts` (L5, opcional) · `/health` · tras la línea `    };` que cierra `checks.schedulers = {` (:1708-1715)

```ts
    // Reputación (Tanda T8): el job diario corre solo en el líder; REPUTATION_SYNC_DISABLED lo apaga.
    checks.reputationSync = {
      ok: true,
      message: !schedulerLeader
        ? "disabled on this instance (RUN_SCHEDULERS=false)"
        : process.env.REPUTATION_SYNC_DISABLED === "true"
          ? "disabled (REPUTATION_SYNC_DISABLED=true)"
          : `enabled (every ${Math.round(reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000)) / 3_600_000)} h · lease + advisory lock)`
    };
```

### #5 `apps/api/src/server.ts` (L5) · tres retoques en las rutas vivas del motor (decisión §9 #15)

(a) **HP-01** · dentro de `app.post("/reputation/reviews/:id/respond", …)` (:3262), ENTRE la línea
`    const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id: (request.params as { id: string }).id });`
y la línea `    return transitionAdvancedRecord({ … auditAction: "ReviewResponseSent" … });`:

```ts
    // Reputación (Tanda T8): 409 REVIEW_DRAFT_REJECTED si el texto es el borrador cuyo ítem HITL fue rechazado (texto editado → pasa).
    await assertDraftPublishable({ reviewId: (request.params as { id: string }).id, responseBody: (request.body as { responseBody?: string; body?: string } | null)?.responseBody ?? (request.body as { body?: string } | null)?.body });
```

(b) **T8F-04** · en la línea de `PATCH /quality/cases/:id` que contiene `auditAction: "QualityCaseResolved"` (:3275)
sustituir ese fragmento por:

```ts
auditAction: ["resolved", "closed"].includes(String((request.body as { status?: string } | null)?.status ?? "")) ? "QualityCaseResolved" : "QualityCaseUpdated"
```

(c) **T8F-04** · en la línea de `POST /surveys/:id/responses` que contiene `requiredPermissions: ["surveys.read"]` (:3286)
sustituir por `requiredPermissions: ["surveys.manage"]`, y en `security/route-permissions.ts` la entrada
`{ method: "POST", path: "/surveys/:id/responses", permissions: ["surveys.read"], riskLevel: "low" }` (:395) →
`permissions: ["surveys.manage"], riskLevel: "medium"`. (Si un auditor debe registrar respuestas a mano, dejar
`surveys.read` y anotarlo en §9.)

### #6 `apps/api/src/security/route-permissions.ts` (L5)

Tras `import { rbacRoutePermissions } from "../modules/rbac/route-permissions.partial.js";` (:52):

```ts
import { reputationRoutePermissions } from "../modules/reputation/route-permissions.partial.js";
```

Tras `  ...rbacRoutePermissions,` (:172):

```ts
  // Reputación y reseñas (Tanda T8): 12 entradas, ver modules/reputation/route-permissions.partial.ts.
  ...reputationRoutePermissions,
```

Sin cambios en las entradas de `POST /reputation/reviews/:id/respond` ni `GET …/reviews` (las 8 rutas del motor siguen
en `server.ts`; `tests/advanced-modules-contract.test.mjs:10,122` sigue encontrando el literal). Tras la fusión,
`tests/api-route-permissions-contract.test.mjs` exige igualdad rutas ↔ manifiesto: hoy el árbol principal tiene 696
`path: "` en el manifiesto principal + 20 partials; la cifra final sale del test.

### #7 `apps/api/src/lib/env.ts` (L5/L6a)

Tras `import { PMS_SHADOW_ENV_CONTRACT } from "../modules/pms-shadow/env.partial.js";` (:22):

```ts
import { REPUTATION_ENV_CONTRACT } from "../modules/reputation/env.partial.js";
```

Tras `  ...PMS_SHADOW_ENV_CONTRACT,` (:762):

```ts
  // Reputación y reseñas (Tanda T8): job diario del líder (REPUTATION_SYNC_DISABLED,
  // REPUTATION_SYNC_INTERVAL_MS, REPUTATION_SYNC_RUN_AT_BOOT · sección Schedulers) y OAuth
  // de Google Business Profile (GOOGLE_BUSINESS_CLIENT_ID/SECRET/REDIRECT_URI · sección OTA)
  // en modules/reputation/env.partial.ts.
  ...REPUTATION_ENV_CONTRACT,
```

Opcional: en la `doc` de `RUN_SCHEDULERS` (:697) añadir `, reputación` tras `modo sombra OPERA`. Después, UNA sola vez al
final de la fusión: `node scripts/env-census.mjs --write` (regenera `scripts/env-contract.json`, `.env.example`,
`deploy/.env.production.example`) y `node --test tests/env-contract.test.mjs`. Sin la regeneración el test falla: #1-#3
hacen que `server.ts` lea `REPUTATION_SYNC_*`/`GOOGLE_BUSINESS_*`.

### #8 `apps/api/src/lib/scheduler-leader.ts` (L5) y `apps/worker/src/index.ts`

`scheduler-leader.ts` :4 `The eight in-process schedulers` → `The nine in-process schedulers`; :6 `PMS shadow) MUST run` →
`PMS shadow, reputation sync) MUST run`. `apps/worker/src/index.ts`: tras `//   - Drain del channel manager: vaciado de la cola de sincronización.`
(:43, última línea de la lista de responsabilidades del API) añadir
`//   - Reputación: sincronización diaria de reseñas, análisis, alertas y purga (REPUTATION_SYNC_*).`

### #9 `apps/api/src/modules/integrations/email/email-reservation.service.ts` (L3-A)

Tras `import { enqueueReview, approveReview, rejectReview } from "../../ai-operations/human-review.service.js";` (:20):

```ts
// Reputación (Tanda T8): un correo de notificación de reseña no es una reserva
// (modules/reputation/review-email.parser.ts, clasificador puro sin red).
import { classifyInboundEmail } from "../../reputation/review-email.parser.js";
```

ANTES de `  if (!looksLikeBooking(email)) {` (:380; después de `const base = { … };` y su línea en blanco):

```ts
  // Reputación (Tanda T8): TripAdvisor, HolidayCheck, Google y los correos de
  // Booking/Expedia cuyo asunto habla de una reseña quedan en `review_notification`
  // (los lee el colector `email` del tick diario: REPUTATION_SYNC_EMAIL_STATUSES) y
  // NO entran en el HITL email_reservation como reserva falsa.
  if (classifyInboundEmail({ messageId: email.messageId, fromAddress: email.from, subject: email.subject, snippet, bodyText: email.bodyText, receivedAt: email.receivedAt ?? null }) === "review_notification") {
    return prisma.inboundEmail.upsert({
      where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } },
      create: { ...base, status: "review_notification" },
      update: { status: "review_notification", snippet, detectedSource }
    });
  }

```

Test a añadir en ese lote: correo de `noreply@booking.com` con asunto «Nueva reseña de un huésped» → fila
`review_notification`, 0 ítems HITL. Opcional (L5): comentario de `schema.prisma` en `InboundEmail.status` → `| review_notification`.

### #10 `apps/api/src/modules/notifications/event-hooks.service.ts` · antes de `    default:` (:66)

```ts
    case "ReviewReceived":
      // Reputación (Tanda T8): review-alerts.service.ts emite el evento al abrir un
      // caso review_negative (payload { score10, source, negative, qualityCaseId }).
      // No existe la plantilla `review_negative_received` ni el destinatario por
      // hotel (PropertyModule.configurationJson.reputation.defaultOwnerUserId):
      // hasta que el seed cree la plantilla y el propietario decida el canal, no se
      // despacha nada (el caso de calidad y la auditoría ya avisan en la bandeja).
      return;
```

(Variante completa `handleReviewReceived` con `dispatch` de `review_negative_received` en T8-MERGE-LINES §7, a insertar
tras el cierre de `handlePaymentCaptured` (:144-179), cuando exista plantilla y responsable por hotel: decisión §9 #7.)

### #11 `packages/database/prisma/seed.ts` (L5-B3/L3)

Tras `  const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);` (:901):

```ts
  // Tanda T8: rev_review_004 apunta a una reseña FICTICIA real (la peor de las
  // sembradas por `demo:seed-reputation` en prop_123) si ese seed ya corrió; si no,
  // conserva el marcador grev_5521. No se crea ninguna reseña aquí: l2-paginacion
  // .test.mts:653-666 pina prop_123 sin reseñas en 30 días.
  const demoReviewId =
    (await prisma.guestReview.findFirst({ where: { propertyId: "prop_123", source: { endsWith: "_demo" } }, orderBy: { rating: "asc" }, select: { id: true } }))?.id ?? "grev_5521";
```

`      relatedEntityId: "grev_5521",` (:962) → `      relatedEntityId: demoReviewId,`;
`      { toolName: "summarizeReview", moduleCode: "reputation", riskLevel: "low" },` (:1060) → `moduleCode: "reputation_quality"`.

### #12 `apps/api/package.json` · tras `    "demo:fix-identity": …` (:22)

```json
    "demo:seed-reputation": "node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts",
```

### #13 IA (L6a ya fusionada en `ca24ed6`: `packages/ai-core` con `client/redaction/messages/runner`, `lib/llm.ts` shim, `lib/ai-client.ts` `getAiCore()`, `tool-runner.service.ts` `runAiTool/confirmToolCall`)

`packages/ai-tools/src/registry.ts` :152 (firma de 6 argumentos tras L6a):
`  advancedTool("draftReviewResponse", "reputation_quality", "reputation.respond", "medium", true, "read"),` →
`  advancedTool("draftReviewResponse", "reputation_quality", "reputation.respond", "high", true, "read"),`
(el guardrail de `tool-registry.service.ts` solo bloquea `autonomous` en high/critical).

Enganche del puerto (lote pequeño posterior, ficheros de T8 + 1 línea en el arranque): fichero NUEVO
`apps/api/src/modules/reputation/reputation-ai.core-adapter.ts` que implemente `ReputationAiPort`
(`reputation-ai.port.ts`: `describe()`, `analyzeReview(input)`, `draftResponse(input)`) sobre `getAiCore()` de
`lib/ai-client.ts` (`structured` para `{ language, sentiment, summary ≤ 200, categories: CategoryMention[] }` con
`source: "llm"` y `model`; `complete` para el borrador ≤ 120 palabras con `source: "ai"`), pasando SIEMPRE por
`redactPii`/`restorePii` de `@hotelos/ai-core` además de `maskReviewForLlm`; y en el arranque del API, junto al resto de
inicialización de IA:

```ts
import { isLlmConfigured } from "./lib/llm.js";
import { setReputationAiPort } from "./modules/reputation/reputation-ai.port.js";
import { createAiCoreReputationPort } from "./modules/reputation/reputation-ai.core-adapter.js";
if (isLlmConfigured()) setReputationAiPort(createAiCoreReputationPort());
```

Sin esa línea todo sigue con `RulesReputationAi` (etiquetas honestas `dictionary`/`rules`). `createReviewDraft` exige
`ai.tool.execute` solo si `describe().configured`.

### #14 `apps/api/src/lib/auth-context.ts` `PUBLIC_PREFIXES` — sin cambio

Ninguna de las 12 rutas es pública. Solo si T8-L5 añade el callback OAuth de Google: tras
`  "/integrations/email/oauth/callback",` (:93) → `  "/reputation/google/oauth/callback",` con `riskLevel: "public"` en el partial.

### #15 `docs/api-contracts.md` (L3-E) · insertar la sección «## Reputación y reseñas (Tanda T8 · 2026-09-19)» de T8-MERGE-LINES §11 ANTES de `## Tanda L2 · Persistencia y API (2026-09-18)` (:464); en :466 «**935 entradas**» → cifra del contrato tras la fusión (+12)

Fila resumen de la sección: `GET …/inbox` array salvo `?envelope=1`/`?cursor=` (siempre `X-Total-Count`/`X-Next-Cursor`);
`GET/PATCH /reputation/reviews/:id`; `POST …/draft` (201, `requiresHumanReview: true`, un solo ítem pendiente por reseña);
`POST …/quality-case` (`quality_cases.manage` + `reputation.read`); `GET/POST …/sources`, `PATCH/DELETE …/sources/:id`
(DELETE = `disabled`), `POST …/sources/:id/sync` → `{ run, summary }` (`completed|partial|failed|skipped`; 409
`REPUTATION_SYNC_BUSY`), `GET …/runs`, `POST …/imports` → 201 `ImportResult` (409 `REPUTATION_SYNC_BUSY`); errores
`REPUTATION_ERROR_CODES` (incl. `REPUTATION_SYNC_BUSY`, `REVIEW_DRAFT_REJECTED`); dashboards aditivos; variables
`REPUTATION_SYNC_*` y `GOOGLE_BUSINESS_*`; nota: el front consume `/quality` y `/surveys` con `?envelope=1`.

### #16 `CLAUDE.md` (integrador)

- :115-116 «Schedulers integrados: … VeriFactu queue» → añadir «, PMS sombra (15min), reputación (24h · `REPUTATION_SYNC_*`, lease + advisory lock)».
- :288 «manifiesto = rutas registradas: 935 …» → cifra vigente + 12.
- Bloque «Estado verificado (Tanda T8 · Reputación y reseñas, 2026-09-19 …)» tras el último bloque de estado (hoy L5,
  :384) con las cifras de §3 y §5; sección «Seeds»: párrafo del CLI `demo:seed-reputation` (T8-H) tras el de
  `demo:refresh`; nota «comentarios en español en `modules/reputation/**` por instrucción del orquestador»; en «Docs
  prioritarios»:
  ```
  - `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` — cierre de la Tanda T8 · Reputación y reseñas: bot diario honesto por fuente, índice 0-100, bandeja con borrador HITL, encuestas y casos, seed ficticio; verificación, mergeLines y decisiones del propietario
  - `docs/runbooks/reputacion-reviews.md` — operación del módulo de reputación: tick, estados de fuente, importación CSV, borrador y respuesta, seed/purga, puertas y degradaciones sin el parche T8-L0 (`docs/design/olas/T8-SCHEMA-PATCH.md`)
  ```

### #17 `~/anfitorio-demo/pilots/screens-inventory.csv` (fuera del repo) · filas 32/38/39, columnas 11-12

- Fila 32 (`ReputationDashboard`): `/dashboards/reputation /reputation/properties/:propertyId/inbox /reputation/reviews/:id /reputation/reviews/:id/draft /reputation/reviews/:id/quality-case /reputation/reviews/:id/respond /reputation/properties/:propertyId/sources /reputation/properties/:propertyId/sources/:id /reputation/properties/:propertyId/sources/:id/sync /reputation/properties/:propertyId/runs /reputation/properties/:propertyId/imports` · `11`.
- Fila 38 (`SurveysDashboard`): `/dashboards/surveys /surveys/properties/:propertyId /surveys/:id/responses` · `3`.
- Fila 39 (`QualityDashboard`): `/dashboards/quality /quality/properties/:propertyId/cases /quality/cases/:id` · `3`.
- `tanda5-nav-tree.csv` y `nav-tree.generated.json` sin cambios. Después: `node --test tests/rbac-nav-contract.test.mjs tests/nav-tree-contract.test.mjs` y `node scripts/build-nav-tree.mjs --check` en el árbol principal.

### #18 Worker · cola `reputation.maintenance` (SOLO con decisión §9 #2 = sí) — T8-MERGE-LINES §5 (6 puntos: `scheduler.ts` :4/:40-44/:51-56/tras :230 `track("schedule:notifications.sending-sweep", …)`; `catalog.test.ts:39-49` «cuatro» → «cinco»; `worker-integration-contract.test.mjs:28,55,59`; `index.ts:28-30`; `docs/deployment.md:18,31,40,66`)

### #19 Tests que deben ajustarse EN el commit de la fusión

- `tests/integration/l8-reputation-routes.test.mts`: retirar `routePermissionManifest.push(...reputationRoutePermissions);` y `registerReputationRoutes(app);` del `before` (:128-130) y el `splice` del `after` (:152) una vez cableados #2 y #6 (si no, entradas duplicadas en memoria durante el test).
- `tests/integration/l2-robustez.test.mts:63-72` `DEGRADED_DASHBOARDS`: añadir `  "/dashboards/reputation",` tras `  "/dashboards/surveys"` (el servicio ya usa `createDegradedCollector`).
- `tests/cocoa-22-contract.test.mjs:176` `inlineStyles: 679` → `671` y en el comentario :175 añadir «Tanda T8 · Reputación integrada el 2026-09-19: 679 → 671 (ReputationDashboard 6 → 0, GeneralManagerScreen 12 → 10; 6 cajones nuevos a 0)».
- `tests/sidebar-nav-contract.test.mjs:299` ya viene modificado en el worktree (sin `reputation_quality` en `IN_MEMORY_MODULE_CODES`) junto con `ModuleManager.tsx:54`.

### #20 Esquema (L5) → `docs/design/olas/T8-SCHEMA-PATCH.md` (§8 de este informe)

### #21 `pnpm-lock.yaml` del worktree: **EXCLUIR** (` M` +52 previo a T8: `@fontsource-variable/inter`, `zod`, `@playwright/test`, `qrcode-terminal`, `fsevents`; ninguna dependencia de reputación).

Puerta final tras la fusión (árbol principal, BD en reposo): `node scripts/typecheck-all.mjs` · `node --test tests/*.test.mjs`
· `corepack pnpm --filter @hotelos/api test` · `corepack pnpm --filter @hotelos/worker test` · front (105 ficheros) ·
`corepack pnpm --filter @hotelos/admin-web build` · `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/l8-reputation-*.test.mts ../../tests/integration/l2-motor-generico.test.mts ../../tests/integration/l2-paginacion.test.mts ../../tests/integration/l2-robustez.test.mts`
· `node scripts/build-nav-tree.mjs --check` · `node scripts/cocoa-22-inventory.mjs` (JSON idéntico) · reinicio de `:3000`
(las 12 rutas, el job y el espejo de módulos solo existen en el proceso reiniciado).

## 8. Parche de esquema y migración propuesta (`docs/design/olas/T8-SCHEMA-PATCH.md`, re-basado hoy)

- **Nombre:** `packages/database/prisma/migrations/20260919124000_reputacion/migration.sql` (patrón
  `2026091912xxxx_reputacion`: posterior a `20260919120000_operaciones_l5_backfill_parte_titular`, última aplicada en la BD
  local; si L5 añade otra antes de aplicar, subir `xxxx`). Se aplica en el árbol principal, NUNCA desde el worktree.
- **Bloque Prisma (anclas en el principal, 6.426 l.):** sustituir `model ReviewSource` (:1878-1888), `model GuestReview`
  (:1890-1911) y `model QualityCase` (:1939-1959); insertar `ReviewSourceRun`, `ReviewCategoryMention` y
  `ReputationDailyScore` tras :1959, antes de `model UtilityMeter` (:1961). `Survey`/`SurveyResponse` sin cambios.
- **Qué añade:** `review_sources` +14 columnas (`mode`, `display_name`, `external_account_id`, `external_location_id`,
  `credentials_json` cifrado, `email_connection_id`, `retention_days` 730, `weight`, `capabilities_json`, `last_run_at`,
  `last_success_at`, `last_error`, `cursor_json`, `updated_at`; `status` por defecto `pending`); `guest_reviews` +27
  (`score10`, `rating_scale_max`, `source_id`, `source_mode`, autor/país/url, `body_complete`, `content_hash`,
  `body_purged_at`, `status`, `assigned_user_id`, `sla_target_at`, `reply_capability`, `draft_*`, `response_*`,
  `analysis_*`, `summary`, `updated_at`, `updated_at_source`, `deleted_at_source`; `external_reference` NOT NULL tras
  backfill `legacy:<id>`); `quality_cases` +5 (`review_id`, `survey_response_id`, `assigned_at`, `closed_by`,
  `updated_at`); 3 tablas nuevas; 2 índices únicos (`review_sources (property_id, provider, external_location_id)`,
  `guest_reviews (property_id, source, external_reference)`), 5 índices, 2 FK en cascada.
- **Backfill escrito a mano e idempotente** desde `config_json`/`topics_json` (§5 del SQL), comprobaciones `DO $$` que
  detienen la migración ante duplicados o NULL (§6), `quality_cases.review_id` desde el marcador `[reseña:<id>]` (§7).
- **Puertas** (§3 del parche): `prisma validate/format`, `db:migrate:status` («1 migration not yet applied»),
  `db:migrate:deploy`, `db:drift:check` «No difference detected.», `db:migrations:check` (+3 tablas), `db:generate`,
  contratos, `typecheck-all`, `api test`, integración `l8-*` + `l2-*`.
- **Activación en código** (lote T8-L0b, §4 del parche): upsert atómico, filtros SQL de bandeja, `reputation_daily_scores`
  materializado con `trendDelta`/`staleDays`/ranking, menciones por tabla, `credentialsJson` cifrado (T8-L5), `reviewId` en
  casos, purga del worker por columnas; **NO** añadir las tablas nuevas a `GUEST_REFERENCE_TABLES` de
  `refresh-demo-dataset.ts` (no tienen `guest_id`).

## 9. Decisiones para César

| # | Decisión | Estado en el código | Qué cambia según la respuesta |
|---|---|---|---|
| 1 | **Activar `reputation_quality` en Faranda** (exige `ai_concierge`; 0 filas en los 8 centros; activar da 409 `MODULE_DEPENDENCIES_MISSING`) | Todo responde `module_off` honesto (verificado con los 4 usuarios reales); pantallas «Módulo no activado»; el seed no activa módulos | Sí → `PATCH /properties/:p/modules/ai_concierge/enable` y luego `reputation_quality` en Rías Altas `cmrhw9jy40003fyvbuu2ec2w7` y Los Tilos `cmu1mifcp0000fyo1wzvq7txo`; alternativa de producto: retirar `ai_concierge` de `dependencies` (`module-conflicts.test.mts:14-32`) |
| 2 | **Credenciales de portales — Google Business Profile**: cuenta propietaria/gestora de cada perfil, OAuth `business.manage`, proyecto Cloud y solicitud de acceso (perfiles verificados 60+ días) | Sin `GOOGLE_BUSINESS_*` la fuente nace `unavailable`; con cliente y sin autorización `pending`; el callback OAuth, el refresco y `credentialsJson` cifrado van a T8-L5 (+ parche) | Aportar `GOOGLE_BUSINESS_CLIENT_ID/SECRET/REDIRECT_URI` (#7) y autorizar |
| 3 | **Booking.com / Expedia**: channel manager y si expone Review API (`review-api`) / alta como connectivity provider | Stubs honestos `unavailable`; mientras tanto CSV manual y correo | Con partner → colector real (T8-L5); sin partner → CSV + correo |
| 4 | **TripAdvisor / HolidayCheck**: activar los correos de nueva reseña hacia un buzón dedicado y conectarlo (`GMAIL_*` o `MS_*`, hoy ausentes) | Colector `email` listo sobre `InboundEmail` `review_notification` (#9) | Buzón + #9 → reseñas con extracto y enlace al portal (nunca texto completo) |
| 5 | **Umbrales de alerta**: 8,5 / 6,0 sobre 10 y 85 / 70 sobre 100; caso automático < 6,0 (urgente < 4,0) | Constantes `SCORE10_POSITIVE/NEGATIVE`, `INDEX_GOOD/WARN` en el bloque `SHARED` | Otro valor (p. ej. 8,0/80 como el GRI) = 1 cambio en API y front a la vez |
| 6 | **Quién responde y en qué plazo**: responsable por hotel (`PropertyModule.configurationJson.reputation.defaultOwnerUserId`), SLA 48/72/96 h por sentimiento, canal de la alerta «Reseña negativa recibida» | El caso y la reseña se asignan al responsable si existe; notificación = no-op documentado (#10) hasta que exista plantilla `review_negative_received` | Usuarios por hotel + canal → plantilla en el seed y variante completa del hook |
| 7 | **Clave para escribir fuentes**: `reputation.respond` (T8-D; la tienen sales, front_office_manager, manager, break_glass) frente a `integrations.connect` | 6 entradas del partial | `integrations.connect` → cambiar el partial y `docs/api-contracts.md`; sin tocar `permissions.ts` |
| 8 | **Ruta del borrador** `POST /reputation/reviews/:id/draft` (no recuperar `…/ai-draft-response`) y **confirmar que aprobar en HITL nunca publica** | Verificado hoy (§5.4) | Confirmar |
| 9 | **Tres retoques en las rutas del motor** (#5): 409 con borrador rechazado; `QualityCaseUpdated` salvo cierre; `POST /surveys/:id/responses` con `surveys.manage` | Verificado que hoy el motor acepta el texto rechazado (§5.4) | Aplicar #5 (a)-(c); si un auditor debe registrar respuestas, dejar (c) en `surveys.read` |
| 10 | **Retención y aviso de privacidad**: 30 días Google (términos de Google), 730 el resto; texto art. 14 RGPD con el DPO | `RETENTION_DAYS_GOOGLE 30`, `RETENTION_DAYS_DEFAULT 730`, editable por fuente 1-3650; la purga vacía título/cuerpo/respuesta/fragmentos/autor y conserva nota y categorías | Otro plazo → `retentionDays` por fuente o defecto |
| 11 | **Parche de esquema T8-L0** (§8): aplicarlo tras L5 o seguir sobre JSON | Funciona sin él (§6); `schemaPatchApplied: false` | Sí → #20 + lote T8-L0b |
| 12 | **Sede del mantenimiento**: solo tick del API (recomendado) o también cola `reputation.maintenance` del worker | El tick purga y recorta; el job del worker existe y está probado (34/34) sin cablear | Sí → #18 (6 puntos de contrato) |
| 13 | **IA**: proveedor y clave (`AI_PROVIDER`, `AI_PROVIDER_API_KEY`; hoy placeholder) y presupuesto mensual | L6a fusionada; puerto por reglas hasta #13 | Clave + #13 → análisis y borradores por modelo con `redactPii` |
| 14 | **Encuestas/NPS**: enviar encuesta post-estancia a todos los huéspedes con e-mail; remitente por hotel y `EMAIL_PROVIDER` (hoy `SIMULADO`) | Encuestas, respuestas y NPS reales; sin envío automático | Sí → lote de envío fuera de T8 |
| 15 | **Agregadores de pago** (DataForSEO/Outscraper/Apify) | No hay colector `aggregator` | Recomendación: no (ToS de los portales, RGPD) |

## 10. Pendientes y deuda que deja la tanda

- T8-L5: OAuth de Google (callback, `state` firmado, refresco de token, `credentialsJson` cifrado tras el parche), colectores
  reales de Booking/Expedia si hay partner, categoría `reviews` en `packages/integrations` + espejo `demo-store.ts`.
- T8-L0b: activación del parche en código (§8). Envío de encuestas y plantilla `review_negative_received`.
- Diccionario de/fr/pt reducidos (ampliar con reseñas reales en esos idiomas, nunca en tests); firma del borrador no
  localizada («Dirección de <hotel>» en los 5 idiomas: cambio de una línea en `reputation-ai.rules.ts:187`).
- Sin `@@unique` hasta el parche: la unicidad la garantiza el lock por propiedad (verificado), no la BD.
- Asignación de reseña/caso por id de usuario en el front (sin selector de usuarios de la propiedad; candidato:
  `rbacApi.listUsersInScope`). Pantallas no verificadas con sesión en navegador (AuthGate exige contraseña; queda para el
  recorrido tras la fusión y el reinicio de `:3000`/`:5173`).
- `tests/integration/l8-reputation-*`: exigen la BD en reposo respecto a Faranda (otro proceso escribiendo en Faranda
  puede hacer fallar «Faranda debe quedar idéntica» de forma transitoria; ocurrió una vez el 19/09 02:49).
- Cadena de auditoría en memoria (deuda 12(c)): el CLI del seed y las suites hidratan el tip desde Postgres; el `:3000`
  del árbol principal bifurcará su siguiente escritura → reiniciarlo tras la fusión.
- `pilots/screens-inventory.csv` (#17) y placeholders `/desarrollo/*-ajustes` (filas 227-229 del árbol) fuera del repo.

## 11. Servidores, residuos y ficheros tocados por esta integración

- Servidores: `:3908` arrancado y matado (pid 92071, puerto libre al cerrar); `:3000`/`:5173` del árbol principal intactos
  (siguen sirviendo el código de L5; el reinicio lo hace el orquestador tras la fusión).
- Residuos de la verificación: **ninguno** (organización aislada borrada, 0 filas de reputación, 0 auditoría de Faranda,
  0 sesiones; Faranda idéntica).
- Ficheros de esta integración en el worktree: este informe (nuevo), `docs/runbooks/reputacion-reviews.md` (reescrito con
  §11 verificación y §12 migración), `docs/design/olas/T8-SCHEMA-PATCH.md` (re-basado: migración `20260919124000_reputacion`,
  anclas del principal), `docs/design/olas/T8-MERGE-LINES.md` (nota de re-base). Suite temporal borrada. Ningún fichero
  prohibido tocado; `pnpm-lock.yaml` sin tocar.
