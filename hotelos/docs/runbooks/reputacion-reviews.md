# Runbook · Reputación y reseñas (Tanda T8 · módulo `reputation_quality`)

Fuente: diseño [`docs/design/REPUTACION-REVIEWS.md`](../design/REPUTACION-REVIEWS.md) (§3 fuentes por portal, §4 el bot,
§5 índice, §6 bandeja, §7 modelo, §8 API); mergeLines [`docs/design/olas/T8-MERGE-LINES.md`](../design/olas/T8-MERGE-LINES.md)
(re-basadas al árbol principal en el informe de integración
[`docs/audits/TANDA-8-REPUTACION-2026-09-19.md`](../audits/TANDA-8-REPUTACION-2026-09-19.md) §7); parche de esquema
[`docs/design/olas/T8-SCHEMA-PATCH.md`](../design/olas/T8-SCHEMA-PATCH.md). Código:
`apps/api/src/modules/reputation/*` (tipos y bloque compartido `reputation-types.ts`; bot puro `review-normalize.ts`,
`review-language.ts`, `review-categories.dictionary.ts`, `review-csv.parser.ts`, `review-email.parser.ts`, `mask-pii.ts`,
`collectors/*`, `reputation-index.ts`, `reputation-ai.{port,rules}.ts`; servicios `review-meta.store.ts`,
`review-sources.service.ts`, `review-inbox.service.ts`, `review-draft.service.ts`, `review-alerts.service.ts`,
`reputation-sync.service.ts`, `reputation-sync.job.ts`, `reputation-lock.ts`, `reputation-score.service.ts`,
`reputation-summary.ts`; rutas `reputation.routes.ts` + `route-permissions.partial.ts` + `schemas/reputation.schemas.ts`;
entorno `env.partial.ts`), dashboards `apps/api/src/modules/dashboards/{reputation,surveys,quality,general-manager,property-overview}.service.ts`,
front `apps/admin-web/src/screens/operations/{ReputationDashboard,SurveysDashboard,QualityDashboard}.tsx` +
`operations/reputation/*` + `services/reputationApi.ts`, seed ficticio `apps/api/src/scripts/seed-reputation-demo.ts`,
job de mantenimiento del worker `apps/worker/src/jobs/reputation-maintenance.job.ts` (sin cablear). Rutas, cuerpos y
permisos: `docs/api-contracts.md` «Reputación y reseñas (Tanda T8)» (sección entregada en las mergeLines).

**Todos los datos de este documento son ficticios**: hotel «Hotel Ejemplo», autores «Huésped A.», ids `grev_demo_…`.
Nunca se pega aquí una reseña real ni el nombre de una persona.

Estado 2026-09-19: escrito en el worktree `~/anfitorio-demo-wt-t8/hotelos` (rama `tanda-t8`, base `776782a`) y verificado
por el integrador (§11). Hasta que el orquestador aplique las mergeLines, las 12 rutas y el job **no están cableados** en
`server.ts` (una instancia arrancada desde el worktree responde 404 en `/reputation/properties/:id/inbox`); los tests de
integración `tests/integration/l8-reputation-*.test.mts` los montan sobre `buildApiServer()` para probarlos.

## 1 · Qué hace el módulo y qué NO hace

- **Hace**: guarda reseñas normalizadas (nota sobre 10, idioma, autor minimizado «Nombre A.», enlace al portal) por
  fuente y propiedad; las analiza (12 categorías, sentimiento, resumen ≤ 200 caracteres) con diccionario o, si L6a
  engancha ai-core, con modelo; calcula el **Índice de Reputación (IRE, 0-100)** ponderado por portal (peso por fuente
  0,1-2, tope 60 % por portal) y recencia (semivida W/2) en ventanas 30/90/365 con mínimo 10 reseñas; abre un **caso de
  calidad** `review_negative` por cada reseña < 6,0 (urgente < 4,0), plazo 48 h; ofrece una **bandeja** con estados
  `new → assigned → drafted → responded → closed` (+ `ignored`), plazo de respuesta por sentimiento (48/72/96 h);
  genera **borradores** que SIEMPRE pasan por revisión humana; **purga** el texto por retención (Google 30 d, resto 730 d).
- **No hace**: scraping ni agregadores; no publica nada sin un usuario; no lee portales sin credenciales oficiales
  (Google: OAuth `business.manage`; Booking/Expedia: solo connectivity partners → hoy `unavailable`); no activa el
  módulo en ninguna propiedad (activar `reputation_quality` exige `ai_concierge`: decisión del propietario).

## 2 · El tick diario (`reputation-sync.job.ts` → `runReputationSync`)

Corre en el **API** (no en el worker: los colectores, la IA, el HITL y la auditoría viven ahí) y solo en la instancia
líder (`RUN_SCHEDULERS=true` + lease `scheduler_leases` en cada vuelta). Variables (`env.partial.ts`; sección
«Schedulers»): `REPUTATION_SYNC_DISABLED` (`false`), `REPUTATION_SYNC_INTERVAL_MS` (`86400000` = 24 h; mínimo 60 000,
máximo 7 días), `REPUTATION_SYNC_RUN_AT_BOOT` (`true`). Cada vuelta toma `pg_try_advisory_xact_lock(hashtext('reputation.sync'))`
en una transacción que **solo sostiene el lock** (`reputation-lock.ts`; tope de 4 h como red de seguridad): si otra
réplica lo tiene, la vuelta queda `skipped` sin duplicar nada. El tick corre **fuera** de esa transacción, sobre el
cliente normal (cada escritura se confirma por sí sola: nada se revierte en bloque y los eventos `ReviewReceived` nunca
apuntan a casos revertidos), y cada propiedad va bajo su propio lock `reputation.sync:<propertyId>` (30 min de tope),
el mismo que toman `POST …/sources/:id/sync` y `POST …/imports`: la propiedad ocupada se salta (`skipReason: lock`) y
las rutas responden **409 `REPUTATION_SYNC_BUSY`** (verificado el 19/09 con un lock ajeno: importación y sincronización
→ 409; liberado → `completed`). Si la transacción del lock expira antes de acabar, el resultado se conserva y el log lo
avisa (`[reputation.lock]`). Log: `[reputation.sync.job] tick` / `tick skipped` / `tick with source errors`. Cupo de
análisis: `maxAnalysisPerTick` (50) es **por propiedad** y vuelta.

Qué hace por cada propiedad con `reputation_quality` activo y por cada fuente no desactivada (`reputation-sync.service.ts`):

0. **Ejecuciones** (`configJson.runs`, ≤ 20): `completed` (lectura completa; avanza `lastSuccessAt` y limpia `lastError`),
   `partial` (el colector devolvió ítems pero cortó antes de terminar: cuota, 5xx a mitad de paginación o tope de
   páginas de Google; lo leído se guarda, `lastSuccessAt` **no** avanza, `lastError` conserva el motivo y la fuente
   queda `degraded`/`error`; cuenta como error de fuente en el tick), `failed` (excepción del colector) y `skipped`
   (fuente no conectada). La ventana `since` parte siempre de la última ejecución `completed` − 2 días.
1. **Estado honesto sin red** (`describeState`): si la fuente no está `connected` la ejecución queda `skipped` con el
   motivo (§3) y no se llama al cliente HTTP.
2. **Recogida**: modo `email` → lee `InboundEmail` de la propiedad con estado `ignored | review | review_notification`
   desde la última sincronización correcta (primera vez: 30 días; solape 2 días), clasifica y parsea el extracto;
   modo `api` → `collector.fetchSince` con el cliente HTTP inyectado; `csv`/`manual`/`demo` → nada (se alimentan por importación).
3. **Upsert idempotente** por `(propiedad, fuente, referencia externa)` + `contentHash`: `created`, `updated` (texto
   cambiado → vuelve a analizarse) o `unchanged`.
4. **Análisis** acotado (50 reseñas por propiedad y tick) de las pendientes, con el texto enmascarado
   (`maskReviewForLlm`); etiqueta `dictionary` (reglas) o `llm` (modelo).
5. **Alertas**: reseña con nota < 6,0 sin caso → `QualityCase` `review_negative` (título «Reseña negativa · Booking.com ·
   3,5/10», descripción con el marcador `[reseña:<id>]`), asignado al responsable por defecto del hotel
   (`PropertyModule.configurationJson.reputation.defaultOwnerUserId`), evento de dominio y auditoría `ReviewReceived`.
6. **Reconciliación**: reseñas respondidas por `POST …/respond` cuya meta seguía abierta pasan a `responded` (≤ 200 por
   vuelta) y su ítem HITL pendiente se aprueba.
7. **Registro de la ejecución** por fuente (`configJson.runs`, las 20 más recientes; `lastRunAt`, `lastSuccessAt`,
   `lastError`; la fuente pasa a `error` si el colector falló).
8. **Purga** por retención de la propiedad e invalidación de la caché del índice (60 s).

Un fallo en una fuente no tumba el tick: queda en `errors` y se sigue con las demás. Lanzarlo a mano para UNA fuente:
`POST /reputation/properties/:propertyId/sources/:id/sync` (permiso `reputation.respond`) → `{ run, summary }` y
auditoría `ReviewSourceSynced`. No hay ruta «sincronizar todo»: el tick completo lo ejecuta el líder. En seco desde
código (tests, integrador): `runReputationSyncJobTick({ now, log })` recorre TODAS las propiedades con el módulo
(en local: `prop_123`, sin fuentes → 0 escrituras) y devuelve `{ skipped, summary: { properties, sources, fetched,
created, updated, unchanged, analyzed, alerts, reconciled, purged, skipped[], errors[], byProperty[] } }`.

## 3 · Cómo leer el estado de una fuente («sin conexión» honesto)

`GET /reputation/properties/:propertyId/sources` (`?includeDisabled=1` para ver las dadas de baja) devuelve por fuente
`status`, `lastError` (motivo), `lastRunAt`/`lastSuccessAt`, `capabilities` (`fetch`, `reply`, `fullText`, `categories`)
y `runs`. `GET …/runs?limit=50&sourceId=` lista las ejecuciones de todas las fuentes. Vocabulario y qué significa:

| `status` | Significado | Qué hacer |
|---|---|---|
| `connected` | El colector puede trabajar (csv/manual/demo siempre; `email` con buzón vinculado en `externalAccountId`; google con cliente, autorización y ubicación) | Nada |
| `pending` | Falta un paso del propietario: Google sin autorizar («Pendiente de autorizar la cuenta de Google del hotel (OAuth business.manage) desde Ajustes de fuentes.») o sin ubicación («Falta el identificador de ubicación de Google (accounts/{a}/locations/{l}).»); fuente `email` sin buzón («Sin buzón conectado: vincula una conexión de correo (Gmail o Microsoft) en Ajustes de fuentes.»); Booking/Expedia con token de partner («Token de partner recibido; el cliente … llega en T8-L5 (hoy no sincroniza).») | Completar el paso (autorización, ubicación, buzón) o esperar a T8-L5 |
| `unavailable` | La vía oficial no está disponible: «Google Business Profile: sin credenciales (GOOGLE_BUSINESS_CLIENT_ID)», «Booking solo da acceso a connectivity partners; indica tu channel manager», «No disponible hasta certificar a ehotelOS como connectivity provider de Expedia…» | Decisión del propietario (informe §9 #2-#4); mientras tanto CSV o correo |
| `degraded` | La última ejecución no pudo traer datos aunque la fuente esté configurada: «El servicio de buzones no ha entregado correos en este tick.», «Sin cliente HTTP inyectado: el colector no hace red por su cuenta.», «Token de acceso de Google ausente o caducado: reautorizar…» | Revisar el buzón / reautorizar y relanzar con `…/sync` |
| `error` | La última ejecución lanzó un error (`lastError` con el mensaje del colector) | Corregir y relanzar con `…/sync` |
| `disabled` | Baja lógica (`DELETE …/sources/:id`); las reseñas importadas conservan su `sourceId` | `PATCH …/sources/:id { enabled: true }` para reactivar |

Las fuentes `csv` y `demo` dicen en `lastError`/motivo «Importación manual: sube un CSV…» y «Fuente de demostración
con reseñas ficticias sembradas; el bot diario no sincroniza esta fuente.»: no es un error, es la descripción honesta.
El panel del director muestra `reputationIndex.status`: `module_off` (módulo apagado), `no_sources` (0 fuentes),
`no_reviews`, `insufficient` (< 10 reseñas en la ventana) u `ok`, y `sourcesConnected`.

## 4 · Importar reseñas por CSV (o filas JSON)

`POST /reputation/properties/:propertyId/imports` (`reputation.respond`; ≤ 4 MiB de cuerpo, ≤ 5.000 filas, 10
peticiones/minuto). Cuerpo: `{ source, scaleMax?, sourceId?, fileName?, contentBase64 }` **o** `{ source, …, rows: [...] }`
(uno de los dos, nunca ambos). `source` es el portal de origen (`google`, `booking`, `expedia`, `tripadvisor`,
`holidaycheck`, `csv`…): fija la escala si el portal la publica (Google/TripAdvisor/Expedia 5, Booking 10,
HolidayCheck 6; `csv` no fija: usa `scale_max` de la fila o `scaleMax` del cuerpo). Si no se indica `sourceId`, se usa (o
se crea) la fuente CSV de ese portal en la propiedad.

Columnas canónicas (cabecera obligatoria; separador `,` o `;` autodetectado; comillas dobles con `""`; BOM y CRLF
tolerados; alias admitidos entre paréntesis):

| Columna | Obligatoria | Contenido |
|---|---|---|
| `external_id` (`external_reference`, `id`, `review_id`) | no | Id de la reseña en el portal; sin él, la referencia se deriva del contenido (`h:<sha256>`) |
| `date` (`received_at`, `fecha`) | sí | Fecha de publicación (ISO `2026-08-14` o `14/08/2026`) |
| `rating` (`nota`, `score`, `puntuacion`) | no | Nota original en la escala del portal |
| `scale_max` (`rating_scale_max`, `escala`) | no | Escala máxima de la fila (5, 6, 10) |
| `title` (`titulo`) | no | ≤ 200 caracteres |
| `body` (`text`, `texto`, `comment`, `comentario`) | no | ≤ 8.000 caracteres |
| `language` (`idioma`, `lang`) | no | ISO 639-1; si falta se detecta (es/en completos; de/fr/pt reducidos) |
| `author` (`author_display_name`, `autor`, `reviewer`) | no | Se minimiza a «Nombre A.» |
| `country` (`pais`, `author_country`) | no | ISO 3166-1 alfa-2 o nombre conocido; otro valor se descarta |
| `url` (`portal_url`, `link`) | no | Enlace a la reseña en el portal |

Ejemplo ficticio (`reseñas-ficticias.csv`):

```csv
external_id,date,rating,scale_max,title,body,language,author,country,url
demo-001,2026-08-14,9,10,"Estancia perfecta","Personal atento y desayuno variado. Repetiremos.",es,"Huésped A.",ES,https://example.com/r/demo-001
demo-002,2026-08-20,4,10,"Ruido por la noche","La habitación daba a la calle y no pudimos descansar.",es,"Huésped B.",PT,https://example.com/r/demo-002
```

```bash
# Desde apps/api con un token de un usuario con reputation.respond (RBAC_STRICT=true) sobre :3908
B64=$(base64 < reseñas-ficticias.csv | tr -d '\n')
curl -s -X POST "http://localhost:3908/reputation/properties/$PROPERTY_ID/imports" \
  -H "Authorization: Bearer $TOKEN" -H "x-property-id: $PROPERTY_ID" -H "Content-Type: application/json" \
  -d "{\"source\":\"booking\",\"fileName\":\"reseñas-ficticias.csv\",\"contentBase64\":\"$B64\"}"
```

Respuesta 201 `ImportResult { created, updated, duplicates, invalid: [{ row, reason }], total, sourceId, correlationId }`.
Repetir el mismo fichero deja `created: 0` y `duplicates = total` (idempotente por referencia + `contentHash`); una fila
con el mismo id y texto distinto → `updated` y vuelve a analizarse. Filas inválidas se devuelven con motivo en español
y no bloquean el resto; fichero sin cabecera, vacío, con comillas sin cerrar o > 5.000 filas → 400 `REVIEW_IMPORT_INVALID`.
La importación corre bajo el lock por propiedad (otra importación o el tick en curso → 409 `REPUTATION_SYNC_BUSY`),
analiza hasta 200 reseñas en la propia petición (el resto las analiza el tick), abre los casos `review_negative` que
toquen, registra una ejecución `import` en la fuente y audita `ReviewsImported`. Normalización verificada el 19/09:
`5/5 → 10,0`, `9/10 → 9,0`, `1,5/5 → 3,0`, `3/10 → 3,0`; idioma detectado `es` sin columna; `en` y `pt` respetados. En
el front: Comercial › Reputación y calidad › Reseñas › «Importar CSV» (`ReviewImportDrawer`).

## 5 · Borrador de respuesta y por qué aprobar en HITL no publica

`POST /reputation/reviews/:id/draft` `{ tone?: cordial | formal | breve, language? }` (`reputation.respond`; con IA
configurada exige además `ai.tool.execute`) → 201 `ReviewDraftResult` (`requiresHumanReview: true`, `body` ≤ 120
palabras con firma «Dirección de <hotel>», `source: rules` (plantilla; «IA no configurada») o `ai` (modelo), `reviewItemId`).
Qué ocurre por dentro (`review-draft.service.ts`): el texto de la reseña se enmascara (`maskReviewForLlm`: nunca correos,
teléfonos ni nombres, tampoco el del autor), el puerto de IA (`ReputationAiPort`; por defecto reglas) genera el borrador,
se guarda en la reseña (`draft`, estado `drafted`), se encola un ítem de **revisión humana** `review_response` en
Operaciones de IA › Revisión humana (SLA 60 min; un solo ítem pendiente por reseña: el anterior se rechaza como
«sustituido»), se registra la llamada de herramienta (`draftReviewResponse`) y se audita `ReviewResponseDrafted`. Un
borrador con un marcador de máscara jamás llega al portal: cae a la plantilla. El detalle (`GET /reputation/reviews/:id`)
expone `draftReviewStatus` = estado vivo del ítem (`pending | approved | rejected | escalated | null`).

**Aprobar el ítem en HITL (`POST /ai-operations/review/:id/approve`, permiso `ai.high_risk.confirm`: dirección de hotel,
operaciones, revenue, contabilidad, dirección financiera; NO comercial ni dirección general) solo cambia el estado del
ítem.** No escribe `responseBody`, no cambia `respondedAt` y no llama a ningún portal (`review-draft.test.mts`,
`l8-reputation-sync.test.mts` y la verificación del integrador §11 lo pinan). **Rechazar** (`…/reject { reason }`)
deja `draftReviewStatus: rejected`: el cajón no precarga ese texto y `assertDraftPublishable` lo rechaza con 409
`REVIEW_DRAFT_REJECTED` (el texto editado por la persona sí pasa); la guarda en `POST …/respond` del motor entra con la
mergeLine §7 #5(a) del informe (hoy esa ruta aún acepta el texto rechazado). La publicación es SIEMPRE un acto de un
usuario (§6). Por eso el borrador puede llegar por IA con etiqueta honesta sin riesgo de autopublicación; y por eso
`draftReviewResponse` debe subir a `riskLevel: high` (mergeLine #13) para que nadie lo ponga en modo autónomo.

## 6 · Responder manualmente

1. Redacta (o edita el borrador) en el cajón de la reseña (`ReviewDetailDrawer`, Comercial › Reputación y calidad › Reseñas).
2. **Publicar en ehotelOS**: `POST /reputation/reviews/:id/respond { responseBody }` (`reputation.respond`; ruta del motor
   genérico en `server.ts`): escribe `responseBody` y `respondedAt` **una sola vez** (segunda vez → 409 «La reseña ya tiene
   respuesta.», código `REVIEW_ALREADY_RESPONDED`/`INVALID_TRANSITION`). El cajón hace después
   `PATCH /reputation/reviews/:id { status: "responded", responseSource: "manual" }` para cerrar el estado de la bandeja
   (la bandeja y el detalle ya muestran `responded` en cuanto existe `respondedAt`; el tick reconcilia la meta si nadie lo hace).
3. **Publicar en el portal**: si la fuente tiene `capabilities.reply` (Google con OAuth; Booking/Expedia con partner) se
   podrá enviar por API (`PATCH … { publish: true }`; hoy 409 `REVIEW_NOT_REPLYABLE` en todas las fuentes salvo Google
   autorizado — T8-L5). En TripAdvisor, HolidayCheck, CSV y correo la respuesta se **copia y pega en el portal** («Esta
   reseña no admite respuesta desde aquí: copia el texto y publícalo en el portal.»); la bandeja registra que se respondió
   y cuándo.
4. Cerrar: `PATCH { status: "closed" }` cuando el caso de calidad asociado (si lo hay) esté resuelto.

Transiciones válidas: `new → assigned | drafted | ignored`, `assigned → drafted | responded | ignored`, `drafted → assigned |
responded`, `responded → closed`; cualquier otra → 409 `INVALID_TRANSITION`. Asignar (`assignedUserId`) desde `new` pasa a
`assigned`; `assignedUserId: null` retira el responsable. «Nuevo plazo» del cajón → `PATCH { slaTargetAt }`.

## 7 · Seed de demo FICTICIO y purga (`apps/api/src/scripts/seed-reputation-demo.ts`)

Nunca escribe reseñas reales: dataset determinista (`seed-reputation-demo.dataset.ts`) con autores «Huésped A.»,
fuentes `google_demo` (`unavailable`), `booking_demo` (`unavailable`) y `csv_demo` (`connected`), N reseñas
(`demo:<seed>:<n>`, 40 % ya respondidas), 2 encuestas «… (demo)» con 30 respuestas y, si el módulo está activo, un
tick que analiza y abre los casos `review_negative`. Marca todo con `isDemo` (`topicsJson.isDemo`, `configJson.isDemo`).
**No activa el módulo** (solo avisa si está apagado). Desde `apps/api` (o `corepack pnpm --filter @hotelos/api demo:seed-reputation --`
cuando el orquestador añada el script, mergeLine #12):

```bash
cd ~/anfitorio-demo-wt-t8/hotelos/apps/api
# Plan sin escribir (por defecto) sobre prop_123
node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts --dry-run
# Aplicar en prop_123 (allowlist demo: org_123 / prop_123 / prop_canary)
node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts --apply --property prop_123 --reviews 90 --days 180 --seed 42
# Faranda (fuera de la allowlist): exige --allow-real y --confirm con el id de la organización O de la propiedad
node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts --apply \
  --property cmrhw9jy40003fyvbuu2ec2w7 --property cmu1mifcp0000fyo1wzvq7txo \
  --allow-real --confirm cmrhw9jy30002fyvb6tsdiugt
# Purgar SOLO las filas marcadas isDemo de esas propiedades (nunca deleteMany sin filtro isDemo)
node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts --apply --purge --property prop_123
```

Flags: `--dry-run` (defecto) · `--apply` · `--property <id>` (repetible) · `--allow-real` + `--confirm <organizationId|propertyId>`
(repetible; `--confirm` sin `--allow-real` es error) · `--purge` · `--days 1-730` · `--reviews 60-120` · `--seed <n>` · `--json`.
Exit codes: `0` ok · `1` fallo (propiedad inexistente, BD) · `2` flags o guarda demo (imprime el plan y no escribe). Repetir
`--apply` cualquier día deja las reseñas «sin cambios» (identidad por referencia `demo:<seed>:<n>`; verificado: `created 0 /
unchanged 60`). Deja auditoría `ReputationDemoSeeded` con actor de sistema `system:reputation` y termina siempre con «Datos
ficticios: ninguna reseña procede de un portal real.». La purga borra `guest_reviews` por `topicsJson.isDemo`,
`review_sources` por `configJson.isDemo`, encuestas «(demo)» y sus respuestas, y casos `review_negative` cuya descripción
empieza por `[reseña:<id demo>]`; las reseñas no demo y sus casos se conservan. Ejecutar los CLI con los API parados
(cadena de auditoría en memoria, deuda 12(c)) o reiniciar el API después.

## 8 · Puertas y comandos desde el worktree

```bash
cd ~/anfitorio-demo-wt-t8/hotelos
node scripts/typecheck-all.mjs                                        # 15 PASS · 0 FAIL · 1 SKIP (guest-web)
node --test tests/*.test.mjs                                          # contratos raíz (2 skips: pilots/*.csv fuera del repo)
corepack pnpm --filter @hotelos/api test                              # unitarios api (incluye modules/reputation/__tests__ y scripts/__tests__)
corepack pnpm --filter @hotelos/worker test                           # incluye jobs/__tests__/reputation-maintenance.job.test.ts
cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts') && cd ../..
# (en zsh el $(find …) va inline; con una variable sin comillas node recibe UN argumento y falla «Could not find …»)
corepack pnpm --filter @hotelos/admin-web build
cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/l8-reputation-*.test.mts && cd ../..
# (desde la ronda de corrección 1 las tres suites también pasan en paralelo: cada hook `after` solo comprueba SU organización
#  aislada; --test-concurrency=1 sigue siendo recomendable con la BD ocupada por otros procesos)
# Solo el módulo (rápido):
cd apps/api && node --import tsx --test src/modules/reputation/__tests__/*.test.mts src/modules/dashboards/__tests__/*.test.mts src/scripts/__tests__/seed-reputation-demo.test.mts
```

Los tests de integración `l8-*` crean organizaciones aisladas (`tests/integration/helpers/l2-tenant.mts`), activan el
módulo insertando `property_modules` sin pasar por la dependencia `ai_concierge`, y comprueban que las invariantes de
Faranda son idénticas antes y después; con otro proceso escribiendo en Faranda (API `:3000`, carga Sage, scripts de L5)
esa comprobación puede fallar de forma transitoria: repetir con la BD en reposo. Servidor propio para verificación
manual: `cd apps/api && PORT=3908 RUN_SCHEDULERS=false RBAC_STRICT=true node --env-file-if-exists=../../.env --import tsx src/server.ts`
(nunca :3000/:5173); `/health` debe decir `schedulers: disabled on this instance`; mátalo al terminar y comprueba
`lsof -nP -iTCP:3908 -sTCP:LISTEN` vacío. Cifras del 19/09 en el informe de integración §3.

## 9 · Degradaciones SIN el parche T8-L0 y qué desbloquea

Hoy todo persiste en las tablas existentes (`review_sources`, `guest_reviews`, `surveys`, `survey_responses`,
`quality_cases`, `ai_human_review_items`) usando `GuestReview.topicsJson` (`ReviewMeta v1`) y `ReviewSource.configJson`
(`ReviewSourceConfig v1`). `detectSchemaPatch()` (`reputation-score.service.ts`) consulta `to_regclass` de
`reputation_daily_scores`, `review_source_runs` y `review_category_mentions` cada 10 min y expone `schemaPatchApplied`
(hoy `false`) en el snapshot del índice. Degradaciones documentadas:

| Sin el parche | Consecuencia | Con el parche (`T8-SCHEMA-PATCH.md` §4) |
|---|---|---|
| Sin `@@unique([propertyId, source, externalReference])` | El upsert es `findFirst + create`: dos escritores concurrentes con la misma referencia podrían crear dos filas. Mitigación real: el tick, `POST …/sources/:id/sync` y `POST …/imports` toman el advisory lock por propiedad `reputation.sync:<propertyId>` (`reputation-lock.ts`); el segundo escritor recibe 409 `REPUTATION_SYNC_BUSY` (rutas) o salta la propiedad (`skipReason: lock`, tick) | Upsert atómico por la clave única; 0 duplicados garantizados |
| Filtros de bandeja en JSON | Se cargan las **500** reseñas más recientes de la propiedad y se filtra/pagina en memoria; una propiedad con > 500 solo ve las 500 últimas en la bandeja | `where` SQL con el índice `[propertyId, status, slaTargetAt]` y paginación real |
| Sin `reputation_daily_scores` | El índice se calcula al vuelo (últimos 365 días, ≤ 5.000 filas por propiedad) con caché de 60 s; `staleDays` siempre 0; sin histórico del índice ni comparativa entre hoteles materializada | Una fila por (propiedad, día, ventana), `trendDelta` real a 30 días, `staleDays`, ranking de organización |
| Ejecuciones en ring buffer | `configJson.runs` guarda las **20** más recientes por fuente (`GET …/runs` las une en memoria) | Tabla `review_source_runs` con historial completo e índices |
| Categorías en JSON | Filtro por categoría y «impacto por categoría» recorren `topicsJson.categories` en memoria | `review_category_mentions` con `@@unique([reviewId, category])` |
| Estado de reseña y de fuente en JSON | `patchReviewMeta` es lee-modifica-escribe sobre `topicsJson` (carrera teórica entre dos PATCH simultáneos); `status` de la fuente sí es columna | Columnas y actualizaciones atómicas |
| Sin `credentialsJson` | `hasCredentials` siempre `false`; Google no puede quedar autorizado (`pending`) | Credenciales cifradas con `encryptField` (`HOTELOS_FIELD_KEY`), nunca en `configJson` |
| `QualityCase` sin `reviewId` | Enlace por `topicsJson.qualityCaseId` y marcador `[reseña:<id>]` en la descripción (el panel de calidad lo lee de ahí) | Columna `reviewId` indexada |

Sin IA (`AI_PROVIDER_API_KEY` placeholder o L6a sin enganchar): análisis `dictionary`, borrador `rules`, `describe()` →
`{ configured: false, provider: "none" }`; `POST …/draft` no exige `ai.tool.execute`. Nada de lo anterior cambia el
contrato de las rutas ni de los DTOs: el parche y la IA solo cambian de dónde se lee y quién redacta.

## 10 · Diagnóstico rápido (solo lectura)

```sql
-- Fuentes y su estado por propiedad
SELECT property_id, provider, status, config_json->>'lastRunAt' AS last_run, config_json->>'lastError' AS last_error FROM review_sources ORDER BY 1, 2;
-- Reseñas por estado de bandeja y fuente (JSON hasta el parche)
SELECT property_id, source, topics_json->>'status' AS status, count(*) FROM guest_reviews GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
-- Casos abiertos por reseñas negativas
SELECT property_id, status, count(*) FROM quality_cases WHERE case_type = 'review_negative' GROUP BY 1, 2;
-- Ítems HITL de respuesta pendientes
SELECT status, count(*) FROM ai_human_review_items WHERE review_type = 'review_response' GROUP BY 1;
-- Eventos del bot
SELECT action, count(*) FROM audit_events WHERE action IN ('ReviewReceived', 'ReviewsImported', 'ReviewSourceSynced', 'ReviewResponseDrafted', 'ReviewResponseSent') GROUP BY 1;
```

Logs del API: `[reputation.sync.job]` (tick, skipped, failed), `[reputation.sync]` (por fuente y propiedad, `correlationId`),
`[reputation.lock]` (transacción del lock expirada). `/health` (tras la mergeLine #4): `checks.reputationSync.message` dice
si el job está habilitado y su cadencia.

## 11 · Verificación del integrador (2026-09-19) — qué se probó y cómo repetirlo

Suite temporal por `app.inject` (registro local de las 12 rutas + manifiesto empujado en vivo, tenant aislado con usuarios
que replican las plantillas de T8a, `RBAC_STRICT=true`, `NODE_ENV=production` y demo auth apagado en cada llamada;
borrada tras la ejecución, 8/8 en 4,8 s; detalle y cifras en el informe §5):

| Qué | Resultado |
|---|---|
| CSV ficticio (12 filas, escalas 5/10, es/en/pt) → reseñas normalizadas | `created 12`, repetición `duplicates 12`; `score10` 10 / 9 / 3 / 3; idioma detectado; 12/12 analizadas por diccionario; 4 casos `review_negative` |
| Índice por hotel | `/dashboards/reputation` `ok` · `index30 70,7` (hotel con módulo) y `module_off` (hotel sin módulo); el director y la ficha leen el mismo valor; `schemaPatchApplied false` |
| Bandeja + borrador por plantilla | 201 `source rules`, 66 palabras, ítem HITL `pending`, `responseBody null` |
| HITL no publica | comercial approve → 403; dirección approve → 200 y `responseBody` sigue `null`; recepción respond → 403; comercial respond → 200; segunda → 409; borrador rechazado → `REVIEW_DRAFT_REJECTED` en el servicio (la ruta del motor lo aceptará hasta la mergeLine #5(a)) |
| Job diario en seco | `runReputationSyncJobTick`: 2 propiedades, google `skipped` «sin credenciales», `errors 0`, `prop_123` intacta; lock ajeno → 409 `REPUTATION_SYNC_BUSY` en importación y sync |
| Permisos (tenant aislado) | recepción / dirección general / propiedad solo leen (403 «No tienes permiso…» al escribir); contabilidad y sistemas 403 al leer; hotel sin asignación 404; hotel sin módulo 403 «El módulo reputation_quality no está activado…» |
| Usuarios reales de T8a sobre Faranda (módulo apagado) | `comercial.galicia`, `direccion.rias`, `recepcion.tilos` y la dirección general: 403 por módulo, 403 por RBAC o 404 por ámbito exactamente donde toca; director y `/dashboards/reputation` → `module_off`; 0 escrituras en Faranda |
| Seed CLI en el tenant aislado | sin `--allow-real` exit 2; dry-run sin escribir; `--apply` 3 fuentes / 60 reseñas / 2 encuestas / casos 4 → 10; repetición `unchanged 60`; `--purge` deja solo las 12 del CSV |
| Instancia `:3908` | `/health` `healthy`, `schedulers disabled`; `GET …/inbox` sin cablear → 404; matada, puerto libre |

Para repetirlo tras la fusión: `tests/integration/l8-reputation-{routes,sync,dashboards}.test.mts` cubren lo mismo con
las rutas ya cableadas (retirar el `push`/`registerReputationRoutes` de `l8-reputation-routes` cuando entren las
mergeLines #2 y #6); para los usuarios reales, matriz de `GET /reputation/properties/<RA|LT>/inbox` y
`GET /dashboards/general-manager?propertyId=` con `curl` sobre `:3908` y un token de `POST /auth/login`.

## 12 · Migración propuesta (cuando el propietario decida el parche)

`packages/database/prisma/migrations/20260919124000_reputacion/migration.sql` (patrón `2026091912xxxx_reputacion`,
posterior a `20260919120000_operaciones_l5_backfill_parte_titular`; subir `xxxx` si L5 añade otra carpeta): bloque Prisma,
SQL con backfill idempotente, comprobaciones `DO $$`, puertas y plan de activación en `docs/design/olas/T8-SCHEMA-PATCH.md`.
Se aplica en el árbol principal con L5 fusionada; nunca desde el worktree (BD compartida).
