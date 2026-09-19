# Tanda T8 · Reputación y reseñas — parche de esquema T8-L0 (para aplicar TRAS L5)

**Para:** el orquestador/integrador de la Tanda T8. **Qué es:** el bloque Prisma y la migración SQL
exactos que el código de la Tanda T8 (lotes T8-A…T8-H, worktree `~/anfitorio-demo-wt-t8/hotelos`, rama
`tanda-t8` desde `776782a`) está preparado para usar pero **no necesita** para funcionar. Hasta que se aplique,
todo lo que aquí pasa a columnas y tablas vive en los JSON existentes (`GuestReview.topicsJson` = `ReviewMeta v1`,
`ReviewSource.configJson` = `ReviewSourceConfig v1`, ambos tipados en
`apps/api/src/modules/reputation/reputation-types.ts:625-760`), con las degradaciones documentadas en
`docs/runbooks/reputacion-reviews.md` §9. El código detecta el parche en caliente
(`reputation-score.service.ts:218-249` `detectSchemaPatch()`: `to_regclass` de las 3 tablas nuevas, caché 10 min).

**Reglas de aplicación.** `packages/database/prisma/**` es de L5: este parche se aplica en el árbol principal
(`~/anfitorio-demo/hotelos`) **después** de la última migración de L5 y **nunca** desde el worktree de T8 (BD
compartida: una migración desde el worktree rompería el `db:drift:check` de L5). Una sola migración, timestamp
posterior a `20260919120000_operaciones_l5_backfill_parte_titular` (última carpeta del árbol principal y última aplicada en la BD local el 2026-09-19; el worktree `776782a` solo llega a `20260918150000_dinero_fiscal`) y a cualquier otra que L5 añada antes de aplicar. Patrón acordado con el integrador: `2026091912xxxx_reputacion`. Fuente de diseño:
`docs/design/REPUTACION-REVIEWS.md` §7 (l.211-238) y §5.2 (l.174-176), re-basado sobre el esquema vigente
(`schema.prisma` del árbol principal `ca24ed6`, 6.426 l.: `ReviewSource` :1878-1888, `GuestReview` :1890-1911, `Survey` :1913-1924,
`SurveyResponse` :1926-1937, `QualityCase` :1939-1959; `UtilityMeter` empieza en :1961; en el worktree `776782a` todo va 2 líneas antes).

Estado verificado en el worktree (2026-09-19): `git -C ~/anfitorio-demo-wt-t8 status` no muestra
`packages/database/prisma/**`; las 5 tablas de reputación tienen exactamente las columnas del esquema; las 3 tablas
nuevas no existen (`to_regclass` NULL en la BD local según el recon §1.12).

**Re-base del integrador (2026-09-19 04:2x):** el árbol principal está en `ca24ed6` (L6a fusionada) con L5 aún editando; la BD local
tiene aplicadas `20260919090000_operaciones_l5` y `20260919120000_operaciones_l5_backfill_parte_titular` (que el worktree no
contiene) → la migración de T8 se llama **`20260919124000_reputacion`** (patrón `2026091912xxxx_reputacion`; subir `xxxx` si
aparece otra carpeta antes de aplicar). Las anclas de línea de este documento citan el principal (modelos 2 líneas más abajo
que en el worktree); el ancla real es el nombre del modelo. Verificado hoy (SELECT): las 3 tablas nuevas siguen sin existir y
las 5 de reputación tienen 0 filas; el código funciona sin el parche (informe `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` §5-§6).

---

## 1 · Bloque Prisma EXACTO

Sustituye los tres modelos (líneas vigentes citadas) y añade los tres nuevos **justo después** de `QualityCase`
(tras la línea 1957, antes de `model UtilityMeter` :1959). `Survey` y `SurveyResponse` no cambian. Mantén el
formato de dos espacios y alineación de `prisma format` (el bloque ya viene alineado).

### 1.1 `ReviewSource` (sustituye `schema.prisma:1878-1888` del principal; :1876-1886 en el worktree)

```prisma
/// Fuente de reseñas de una propiedad (Tanda T8 · parche T8-L0). Antes del parche todo lo que no fuera
/// id/propertyId/provider/status/configJson/createdAt vivía en configJson (ReviewSourceConfig v1,
/// apps/api/src/modules/reputation/reputation-types.ts); configJson se conserva para el cursor libre del colector.
model ReviewSource {
  id                 String    @id @default(cuid())
  propertyId         String    @map("property_id")
  /// google · booking · expedia · tripadvisor · holidaycheck · csv · email · demo (REVIEW_PROVIDERS); sufijo `_demo` en fuentes de demostración.
  provider           String
  /// pending · connected · degraded · error · disabled · unavailable (REVIEW_SOURCE_STATUSES).
  status             String    @default("pending")
  /// api · email · csv · manual · demo (REVIEW_SOURCE_MODES).
  mode               String    @default("manual")
  displayName        String    @default("") @map("display_name")
  externalAccountId  String?   @map("external_account_id")
  externalLocationId String?   @map("external_location_id")
  /// Sobre cifrado (formato v1.{iv}.{ct}.{tag}) producido por encryptField (apps/api/src/lib/crypto.service.ts) sobre el JSON de credenciales; NUNCA en configJson.
  credentialsJson    String?   @map("credentials_json")
  emailConnectionId  String?   @map("email_connection_id")
  retentionDays      Int       @default(730) @map("retention_days")
  weight             Decimal   @default(1) @db.Decimal(3, 2)
  capabilitiesJson   Json      @default("{}") @map("capabilities_json")
  lastRunAt          DateTime? @map("last_run_at")
  lastSuccessAt      DateTime? @map("last_success_at")
  lastError          String?   @map("last_error")
  cursorJson         Json      @default("{}") @map("cursor_json")
  configJson         Json      @default("{}") @map("config_json")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @default(now()) @updatedAt @map("updated_at")
  runs               ReviewSourceRun[]

  @@unique([propertyId, provider, externalLocationId])
  @@index([propertyId, provider])
  @@map("review_sources")
}
```

### 1.2 `GuestReview` (sustituye `schema.prisma:1890-1911` del principal; :1888-1909 en el worktree)

```prisma
/// Reseña de un portal (Tanda T8 · parche T8-L0). `rating` conserva la nota original; `score10` es la nota
/// normalizada sobre 10 (review-normalize.ts). topicsJson (ReviewMeta v1) se conserva: categorías y análisis
/// también se materializan en review_category_mentions.
model GuestReview {
  id                    String    @id @default(cuid())
  propertyId            String    @map("property_id")
  reservationId         String?   @map("reservation_id")
  guestId               String?   @map("guest_id")
  source                String
  sourceId              String?   @map("source_id")
  /// api · email · csv · manual · demo (REVIEW_SOURCE_MODES).
  sourceMode            String    @default("manual") @map("source_mode")
  rating                Decimal?  @db.Decimal(3, 2)
  ratingScaleMax        Decimal?  @map("rating_scale_max") @db.Decimal(4, 2)
  score10               Decimal?  @db.Decimal(4, 2)
  title                 String?
  body                  String?
  bodyComplete          Boolean   @default(true) @map("body_complete")
  language              String?
  sentiment             String?
  authorDisplayName     String?   @map("author_display_name")
  authorCountry         String?   @map("author_country")
  portalUrl             String?   @map("portal_url")
  topicsJson            Json      @default("{}") @map("topics_json")
  externalReference     String    @map("external_reference")
  contentHash           String    @default("") @map("content_hash")
  receivedAt            DateTime? @map("received_at")
  updatedAtSource       DateTime? @map("updated_at_source")
  deletedAtSource       DateTime? @map("deleted_at_source")
  bodyPurgedAt          DateTime? @map("body_purged_at")
  /// new · assigned · drafted · responded · closed · ignored (REVIEW_STATUSES).
  status                String    @default("new")
  assignedUserId        String?   @map("assigned_user_id")
  slaTargetAt           DateTime? @map("sla_target_at")
  replyCapability       Boolean   @default(false) @map("reply_capability")
  draftBody             String?   @map("draft_body")
  /// ai · rules
  draftSource           String?   @map("draft_source")
  draftModel            String?   @map("draft_model")
  draftedAt             DateTime? @map("drafted_at")
  respondedAt           DateTime? @map("responded_at")
  responseBody          String?   @map("response_body")
  /// api · manual
  responseSource        String?   @map("response_source")
  responseExternalState String?   @map("response_external_state")
  /// pending · done · failed (ANALYSIS_STATUSES).
  analysisStatus        String    @default("pending") @map("analysis_status")
  /// llm · dictionary · portal_subscore · none (ANALYSIS_SOURCES).
  analysisSource        String?   @map("analysis_source")
  analyzedAt            DateTime? @map("analyzed_at")
  summary               String?
  createdAt             DateTime  @default(now()) @map("created_at")
  updatedAt             DateTime  @default(now()) @updatedAt @map("updated_at")
  mentions              ReviewCategoryMention[]

  @@unique([propertyId, source, externalReference])
  @@index([propertyId, rating, createdAt])
  @@index([propertyId, respondedAt])
  @@index([propertyId, receivedAt])
  @@index([propertyId, status, slaTargetAt])
  @@map("guest_reviews")
}
```

Notas: `externalReference` pasa de `String?` a `String` (NOT NULL); el SQL de §2 rellena las filas antiguas antes
del `SET NOT NULL`. `authorRef?` del diseño §7 se omite a propósito (no lo usa ningún lote). Los dos índices
existentes se conservan.

> **Aplicado el 2026-09-19 con una desviación (fusión T8):** `external_reference` se queda **nullable** (`String?`) y la
> migración `20260919124000_reputacion` omite el `SET NOT NULL` (las filas del motor genérico sin referencia no se
> rellenan); el índice único `(property_id, source, external_reference)` admite por tanto varias filas con NULL. Ver la
> cabecera de la migración, `docs/runbooks/reputacion-reviews.md` §9 y CLAUDE.md (bloque T8). Pendiente de decisión: backfill
> `legacy:<id>` en el motor genérico + `SET NOT NULL` en una migración posterior.

### 1.3 `QualityCase` (sustituye `schema.prisma:1939-1959` del principal; :1937-1957 en el worktree)

```prisma
model QualityCase {
  id               String    @id @default(cuid())
  propertyId       String    @map("property_id")
  reservationId    String?   @map("reservation_id")
  guestId          String?   @map("guest_id")
  roomId           String?   @map("room_id")
  /// Reseña que abrió el caso (review_negative); referencia blanda, como reservationId/guestId.
  reviewId         String?   @map("review_id")
  surveyResponseId String?   @map("survey_response_id")
  caseType         String    @map("case_type")
  priority         String    @default("normal")
  status           String    @default("open")
  title            String
  description      String?
  ownerUserId      String?   @map("owner_user_id")
  assignedAt       DateTime? @map("assigned_at")
  slaTargetAt      DateTime? @map("sla_target_at")
  rootCause        String?   @map("root_cause")
  closedBy         String?   @map("closed_by")
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @default(now()) @updatedAt @map("updated_at")
  resolvedAt       DateTime? @map("resolved_at")

  @@index([propertyId, status, priority])
  @@index([propertyId, slaTargetAt])
  @@index([propertyId, reviewId])
  @@map("quality_cases")
}
```

### 1.4 Modelos NUEVOS (insertar tras la línea 1959 del principal, antes de `model UtilityMeter` :1961)

Vocabularios alineados con el código de T8 (manda sobre el diseño §7 donde difieren): `trigger` =
`scheduler · manual · import` (`REVIEW_SOURCE_RUN_TRIGGERS`, `reputation-types.ts:166`; el diseño decía
`webhook`), `status` = `completed · partial · failed · skipped` (`REVIEW_SOURCE_RUN_STATUSES`; `partial` = lectura
incompleta que no avanza `lastSuccessAt`, corrección ronda 1 BD-01; el diseño decía
`running`/`skipped_lock`: el salto por advisory lock no escribe run, `reputation-sync.job.ts:78-80`). El campo del
índice se llama `indexValue` (`index` es palabra ambigua en Prisma/SQL).

```prisma
/// Ejecución de un colector sobre una fuente (Tanda T8 · parche T8-L0). Antes del parche: ring buffer
/// configJson.runs (RUN_HISTORY_LIMIT = 20). FK con borrado en cascada: sin fuente no hay ejecuciones.
model ReviewSourceRun {
  id            String       @id @default(cuid())
  propertyId    String       @map("property_id")
  sourceId      String       @map("source_id")
  provider      String
  /// scheduler · manual · import (REVIEW_SOURCE_RUN_TRIGGERS).
  trigger       String
  /// completed · partial · failed · skipped (REVIEW_SOURCE_RUN_STATUSES).
  status        String       @default("completed")
  startedAt     DateTime     @map("started_at")
  finishedAt    DateTime?    @map("finished_at")
  fetched       Int          @default(0)
  created       Int          @default(0)
  updated       Int          @default(0)
  unchanged     Int          @default(0)
  purged        Int          @default(0)
  lastError     String?      @map("last_error")
  correlationId String       @default("") @map("correlation_id")
  resultJson    Json         @default("{}") @map("result_json")
  createdAt     DateTime     @default(now()) @map("created_at")
  source        ReviewSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@index([propertyId, startedAt])
  @@index([sourceId, startedAt])
  @@map("review_source_runs")
}

/// Mención de una categoría en una reseña (Tanda T8 · parche T8-L0): una de las 12 REVIEW_CATEGORIES,
/// sentimiento −1/0/+1, confianza 0-1 y fragmento ≤ 160 caracteres. Antes del parche: topicsJson.categories[].
model ReviewCategoryMention {
  id             String      @id @default(cuid())
  reviewId       String      @map("review_id")
  propertyId     String      @map("property_id")
  /// limpieza · habitacion · personal · desayuno · restauracion · ubicacion · precio_valor · instalaciones · ruido · wifi · recepcion_checkin · mantenimiento.
  category       String
  sentiment      Int         @default(0)
  confidence     Decimal     @default(0) @db.Decimal(3, 2)
  snippet        String?
  /// llm · dictionary · portal_subscore · none (ANALYSIS_SOURCES).
  analysisSource String      @default("dictionary") @map("analysis_source")
  createdAt      DateTime    @default(now()) @map("created_at")
  review         GuestReview @relation(fields: [reviewId], references: [id], onDelete: Cascade)

  @@unique([reviewId, category])
  @@index([propertyId, category, createdAt])
  @@map("review_category_mentions")
}

/// Índice de reputación materializado (Tanda T8 · parche T8-L0): una fila por (propiedad, día, ventana 30/90/365).
/// Antes del parche el índice se calcula al vuelo con caché de 60 s (reputation-score.service.ts) y staleDays = 0.
model ReputationDailyScore {
  id                  String    @id @default(cuid())
  propertyId          String    @map("property_id")
  scoreDate           DateTime  @map("score_date") @db.Date
  windowDays          Int       @map("window_days")
  /// ok · insufficient · no_reviews · no_sources · module_off (REPUTATION_INDEX_STATUSES).
  status              String    @default("ok")
  /// 0-100 con un decimal; null salvo status ok.
  indexValue          Decimal?  @map("index_value") @db.Decimal(5, 1)
  reviewCount         Int       @default(0) @map("review_count")
  /// ReputationIndexBySource[] ({ provider, count, avg10, weightShare }).
  sourceBreakdownJson Json      @default("[]") @map("source_breakdown_json")
  /// ReputationCategoryImpact[] ({ category, mentions, negativeMentions, impact }).
  categoryImpactJson  Json      @default("[]") @map("category_impact_json")
  responseRatePct     Decimal?  @map("response_rate_pct") @db.Decimal(5, 2)
  medianResponseHours Decimal?  @map("median_response_hours") @db.Decimal(8, 2)
  trendDelta          Decimal?  @map("trend_delta") @db.Decimal(5, 1)
  orgAverage          Decimal?  @map("org_average") @db.Decimal(5, 1)
  orgRank             Int?      @map("org_rank")
  orgSize             Int?      @map("org_size")
  computedAt          DateTime  @default(now()) @map("computed_at")
  correlationId       String?   @map("correlation_id")

  @@unique([propertyId, scoreDate, windowDays])
  @@index([scoreDate, windowDays])
  @@map("reputation_daily_scores")
}
```

---

## 2 · Migración SQL

Fichero: `packages/database/prisma/migrations/20260919124000_reputacion/migration.sql`. El prefijo
`20260919124000` es el propuesto: **sustitúyelo por uno posterior a la última carpeta de `migrations/` en el momento
de aplicar** (hoy `20260919120000_operaciones_l5_backfill_parte_titular`; L5 puede añadir otra). Tras editar el esquema de §1 y **antes** de
aplicar, regenera el DDL y compara con §2.1-§2.4 (todo lo generado debe coincidir; lo escrito a mano es §2.5-§2.7):

```bash
cd ~/anfitorio-demo/hotelos/packages/database && node --env-file-if-exists=../../.env \
  node_modules/prisma/build/index.js migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
```

Contenido completo del fichero (cabecera al estilo de `20260918130000_persistencia_l2` y
`20260918150000_dinero_fiscal`):

```sql
-- ============================================================================
-- 20260919124000_reputacion · Reputación y reseñas (Tanda T8 · parche T8-L0)
-- ============================================================================
-- Generada el 2026-09-19 con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- y revisada a mano. Lo que emitió el generador está VERBATIM en §1-§4 (3 ALTER TABLE …
-- ADD COLUMN, 3 CREATE TABLE, 8 CREATE INDEX / CREATE UNIQUE INDEX, 2 ADD FOREIGN KEY);
-- reordenado a mano UN solo punto: `ALTER COLUMN "external_reference" SET NOT NULL`
-- va después del backfill de §5. [APLICADO 2026-09-19 SIN ese SET NOT NULL: external_reference
-- queda nullable; ver la nota de re-base de §1.2 y la cabecera de 20260919124000_reputacion.]
-- Lo escrito a mano (DDL/DML que Prisma no declara y
-- que `db:drift:check` ignora, igual que los DO $$ de 20260918130000) es:
--   · §5 backfill desde los JSON que la Tanda T8 escribió antes del parche
--     (guest_reviews.topics_json = ReviewMeta v1, review_sources.config_json =
--     ReviewSourceConfig v1: apps/api/src/modules/reputation/reputation-types.ts);
--   · §6 comprobaciones DO $$ … $$ antes de cada índice único (0 duplicados) y
--     antes del NOT NULL (0 NULL): la migración se detiene en lugar de perder datos;
--   · §7 quality_cases.review_id desde el marcador `[reseña:<id>]` de la descripción
--     (review-alerts.service.ts buildCaseDescription).
-- Migración ADITIVA: ningún DROP, ningún NOT NULL sin DEFAULT salvo external_reference
-- (rellenada antes). Idempotente en los INSERT (ON CONFLICT DO NOTHING) y en los UPDATE.
--
-- ORDEN: §1 review_sources · §2 guest_reviews · §3 quality_cases · §4 tablas nuevas,
-- índices y FKs · §5 backfill · §6 comprobaciones + unicidad + NOT NULL · §7 casos.

-- ----------------------------------------------------------------------------
-- §1 review_sources: columnas de ReviewSourceConfig v1 + status por defecto `pending`
-- ----------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "review_sources" ADD COLUMN     "capabilities_json" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "credentials_json" TEXT,
ADD COLUMN     "cursor_json" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "display_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "email_connection_id" TEXT,
ADD COLUMN     "external_account_id" TEXT,
ADD COLUMN     "external_location_id" TEXT,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_run_at" TIMESTAMP(3),
ADD COLUMN     "last_success_at" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "retention_days" INTEGER NOT NULL DEFAULT 730,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "weight" DECIMAL(3,2) NOT NULL DEFAULT 1,
ALTER COLUMN "status" SET DEFAULT 'pending';

-- ----------------------------------------------------------------------------
-- §2 guest_reviews: columnas de ReviewMeta v1 (external_reference → NOT NULL en §6)
-- ----------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "guest_reviews" ADD COLUMN     "analysis_source" TEXT,
ADD COLUMN     "analysis_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "analyzed_at" TIMESTAMP(3),
ADD COLUMN     "assigned_user_id" TEXT,
ADD COLUMN     "author_country" TEXT,
ADD COLUMN     "author_display_name" TEXT,
ADD COLUMN     "body_complete" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "body_purged_at" TIMESTAMP(3),
ADD COLUMN     "content_hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deleted_at_source" TIMESTAMP(3),
ADD COLUMN     "draft_body" TEXT,
ADD COLUMN     "draft_model" TEXT,
ADD COLUMN     "draft_source" TEXT,
ADD COLUMN     "drafted_at" TIMESTAMP(3),
ADD COLUMN     "portal_url" TEXT,
ADD COLUMN     "rating_scale_max" DECIMAL(4,2),
ADD COLUMN     "reply_capability" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "response_external_state" TEXT,
ADD COLUMN     "response_source" TEXT,
ADD COLUMN     "score10" DECIMAL(4,2),
ADD COLUMN     "sla_target_at" TIMESTAMP(3),
ADD COLUMN     "source_id" TEXT,
ADD COLUMN     "source_mode" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'new',
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at_source" TIMESTAMP(3);

-- ----------------------------------------------------------------------------
-- §3 quality_cases: enlace con la reseña / respuesta de encuesta, asignación y cierre
-- ----------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "quality_cases" ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "closed_by" TEXT,
ADD COLUMN     "review_id" TEXT,
ADD COLUMN     "survey_response_id" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ----------------------------------------------------------------------------
-- §4 tablas nuevas, índices y claves foráneas
-- ----------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "review_source_runs" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "purged" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "correlation_id" TEXT NOT NULL DEFAULT '',
    "result_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_source_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_category_mentions" (
    "id" TEXT NOT NULL,
    "review_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sentiment" INTEGER NOT NULL DEFAULT 0,
    "confidence" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "snippet" TEXT,
    "analysis_source" TEXT NOT NULL DEFAULT 'dictionary',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_category_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_daily_scores" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "score_date" DATE NOT NULL,
    "window_days" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "index_value" DECIMAL(5,1),
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "source_breakdown_json" JSONB NOT NULL DEFAULT '[]',
    "category_impact_json" JSONB NOT NULL DEFAULT '[]',
    "response_rate_pct" DECIMAL(5,2),
    "median_response_hours" DECIMAL(8,2),
    "trend_delta" DECIMAL(5,1),
    "org_average" DECIMAL(5,1),
    "org_rank" INTEGER,
    "org_size" INTEGER,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT,

    CONSTRAINT "reputation_daily_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_source_runs_property_id_started_at_idx" ON "review_source_runs"("property_id", "started_at");

-- CreateIndex
CREATE INDEX "review_source_runs_source_id_started_at_idx" ON "review_source_runs"("source_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "review_category_mentions_review_id_category_key" ON "review_category_mentions"("review_id", "category");

-- CreateIndex
CREATE INDEX "review_category_mentions_property_id_category_created_at_idx" ON "review_category_mentions"("property_id", "category", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_daily_scores_property_id_score_date_window_days_key" ON "reputation_daily_scores"("property_id", "score_date", "window_days");

-- CreateIndex
CREATE INDEX "reputation_daily_scores_score_date_window_days_idx" ON "reputation_daily_scores"("score_date", "window_days");

-- CreateIndex
CREATE INDEX "guest_reviews_property_id_received_at_idx" ON "guest_reviews"("property_id", "received_at");

-- CreateIndex
CREATE INDEX "guest_reviews_property_id_status_sla_target_at_idx" ON "guest_reviews"("property_id", "status", "sla_target_at");

-- CreateIndex
CREATE INDEX "quality_cases_property_id_review_id_idx" ON "quality_cases"("property_id", "review_id");

-- AddForeignKey
ALTER TABLE "review_source_runs" ADD CONSTRAINT "review_source_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "review_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_category_mentions" ADD CONSTRAINT "review_category_mentions_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "guest_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- §5 BACKFILL desde los JSON de la Tanda T8 (escrito a mano; idempotente)
-- ----------------------------------------------------------------------------
-- §5.1 review_sources ← config_json (ReviewSourceConfig v1). Las fechas ISO llegan
-- en UTC («…Z»): se convierten a timestamp sin zona en UTC, como escribe Prisma.
UPDATE "review_sources" s SET
  "mode"                 = CASE WHEN s."config_json"->>'mode' IN ('api','email','csv','manual','demo') THEN s."config_json"->>'mode' ELSE s."mode" END,
  "display_name"         = COALESCE(NULLIF(s."config_json"->>'displayName', ''), s."provider"),
  "external_account_id"  = NULLIF(s."config_json"->>'externalAccountId', ''),
  "external_location_id" = NULLIF(s."config_json"->>'externalLocationId', ''),
  "retention_days"       = COALESCE(floor(NULLIF(s."config_json"->>'retentionDays', '')::numeric)::integer, 730),
  "weight"               = LEAST(GREATEST(COALESCE(NULLIF(s."config_json"->>'weight', '')::numeric, 1), 0.1), 2),
  "capabilities_json"    = CASE WHEN jsonb_typeof(s."config_json"->'capabilities') = 'object' THEN s."config_json"->'capabilities' ELSE '{}'::jsonb END,
  "last_run_at"          = (NULLIF(s."config_json"->>'lastRunAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "last_success_at"      = (NULLIF(s."config_json"->>'lastSuccessAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "last_error"           = NULLIF(s."config_json"->>'lastError', ''),
  "cursor_json"          = CASE WHEN jsonb_typeof(s."config_json"->'cursor') = 'object' THEN s."config_json"->'cursor' ELSE '{}'::jsonb END
WHERE jsonb_typeof(s."config_json") = 'object';

-- §5.2 review_source_runs ← config_json->'runs' (ring buffer ≤ 20 por fuente).
INSERT INTO "review_source_runs" ("id", "property_id", "source_id", "provider", "trigger", "status", "started_at", "finished_at", "fetched", "created", "updated", "unchanged", "purged", "last_error", "correlation_id", "result_json", "created_at")
SELECT
  COALESCE(NULLIF(r.run->>'id', ''), 'run_' || md5(s."id" || ':' || COALESCE(r.run->>'startedAt', r.ordinality::text))),
  s."property_id",
  s."id",
  s."provider",
  CASE WHEN r.run->>'trigger' IN ('scheduler','manual','import') THEN r.run->>'trigger' ELSE 'scheduler' END,
  CASE WHEN r.run->>'status' IN ('completed','partial','failed','skipped') THEN r.run->>'status' ELSE 'completed' END,
  COALESCE((NULLIF(r.run->>'startedAt', '')::timestamptz AT TIME ZONE 'UTC'), s."created_at"),
  (NULLIF(r.run->>'finishedAt', '')::timestamptz AT TIME ZONE 'UTC'),
  COALESCE(NULLIF(r.run->>'fetched', '')::integer, 0),
  COALESCE(NULLIF(r.run->>'created', '')::integer, 0),
  COALESCE(NULLIF(r.run->>'updated', '')::integer, 0),
  COALESCE(NULLIF(r.run->>'unchanged', '')::integer, 0),
  COALESCE(NULLIF(r.run->>'purged', '')::integer, 0),
  NULLIF(r.run->>'error', ''),
  COALESCE(r.run->>'correlationId', ''),
  r.run,
  COALESCE((NULLIF(r.run->>'startedAt', '')::timestamptz AT TIME ZONE 'UTC'), s."created_at")
FROM "review_sources" s
CROSS JOIN LATERAL jsonb_array_elements(s."config_json"->'runs') WITH ORDINALITY AS r(run, ordinality)
WHERE jsonb_typeof(s."config_json"->'runs') = 'array'
ON CONFLICT ("id") DO NOTHING;

-- §5.3 guest_reviews ← topics_json (ReviewMeta v1). El estado de bandeja: el de la
-- meta; si la reseña ya tiene responded_at (POST …/respond del motor genérico) y la
-- meta sigue abierta, `responded`.
UPDATE "guest_reviews" g SET
  "score10"                 = NULLIF(g."topics_json"->>'score10', '')::numeric,
  "rating_scale_max"        = NULLIF(g."topics_json"->>'ratingScaleMax', '')::numeric,
  "source_id"               = NULLIF(g."topics_json"->>'sourceId', ''),
  "source_mode"             = CASE WHEN g."topics_json"->>'sourceMode' IN ('api','email','csv','manual','demo') THEN g."topics_json"->>'sourceMode' ELSE 'manual' END,
  "author_display_name"     = NULLIF(g."topics_json"->>'authorDisplayName', ''),
  "author_country"          = NULLIF(g."topics_json"->>'authorCountry', ''),
  "portal_url"              = NULLIF(g."topics_json"->>'portalUrl', ''),
  "body_complete"           = COALESCE(NULLIF(g."topics_json"->>'bodyComplete', '')::boolean, true),
  "content_hash"            = COALESCE(g."topics_json"->>'contentHash', ''),
  "body_purged_at"          = (NULLIF(g."topics_json"->>'bodyPurgedAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "status"                  = CASE
                                WHEN g."responded_at" IS NOT NULL AND COALESCE(g."topics_json"->>'status', 'new') IN ('new','assigned','drafted') THEN 'responded'
                                WHEN g."topics_json"->>'status' IN ('new','assigned','drafted','responded','closed','ignored') THEN g."topics_json"->>'status'
                                WHEN g."responded_at" IS NOT NULL THEN 'responded'
                                ELSE 'new'
                              END,
  "assigned_user_id"        = NULLIF(g."topics_json"->>'assignedUserId', ''),
  "sla_target_at"           = (NULLIF(g."topics_json"->>'slaTargetAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "reply_capability"        = COALESCE(NULLIF(g."topics_json"->>'replyCapability', '')::boolean, false),
  "draft_body"              = NULLIF(g."topics_json"->'draft'->>'body', ''),
  "draft_source"            = NULLIF(g."topics_json"->'draft'->>'source', ''),
  "draft_model"             = NULLIF(g."topics_json"->'draft'->>'model', ''),
  "drafted_at"              = (NULLIF(g."topics_json"->'draft'->>'draftedAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "response_source"         = NULLIF(g."topics_json"->'response'->>'source', ''),
  "response_external_state" = NULLIF(g."topics_json"->'response'->>'externalState', ''),
  "analysis_status"         = CASE WHEN g."topics_json"->'analysis'->>'status' IN ('pending','done','failed') THEN g."topics_json"->'analysis'->>'status' ELSE 'pending' END,
  "analysis_source"         = NULLIF(g."topics_json"->'analysis'->>'source', ''),
  "analyzed_at"             = (NULLIF(g."topics_json"->'analysis'->>'analyzedAt', '')::timestamptz AT TIME ZONE 'UTC'),
  "summary"                 = NULLIF(g."topics_json"->'analysis'->>'summary', '')
WHERE jsonb_typeof(g."topics_json") = 'object';

-- §5.4 external_reference: las filas anteriores a T8 (creadas por el motor genérico o
-- por l2-motor-generico.test.mts) pueden tener NULL; reciben `legacy:<id>` (única por
-- construcción). La Tanda T8 siempre escribe la referencia (externalReferenceFor).
UPDATE "guest_reviews"
SET "external_reference" = 'legacy:' || "id"
WHERE "external_reference" IS NULL OR "external_reference" = '';

-- §5.5 review_category_mentions ← topics_json->'categories' (una fila por (reseña,
-- categoría); con menciones repetidas gana la de mayor confianza). Id determinista.
INSERT INTO "review_category_mentions" ("id", "review_id", "property_id", "category", "sentiment", "confidence", "snippet", "analysis_source", "created_at")
SELECT DISTINCT ON (g."id", c.mention->>'category')
  'rcm_' || md5(g."id" || ':' || (c.mention->>'category')),
  g."id",
  g."property_id",
  c.mention->>'category',
  CASE WHEN COALESCE(NULLIF(c.mention->>'sentiment', '')::numeric, 0) < 0 THEN -1 WHEN COALESCE(NULLIF(c.mention->>'sentiment', '')::numeric, 0) > 0 THEN 1 ELSE 0 END,
  LEAST(GREATEST(COALESCE(NULLIF(c.mention->>'confidence', '')::numeric, 0), 0), 1),
  NULLIF(left(c.mention->>'snippet', 160), ''),
  CASE WHEN c.mention->>'source' IN ('llm','dictionary','portal_subscore','none') THEN c.mention->>'source' ELSE 'dictionary' END,
  COALESCE(g."analyzed_at", g."created_at")
FROM "guest_reviews" g
CROSS JOIN LATERAL jsonb_array_elements(g."topics_json"->'categories') AS c(mention)
WHERE jsonb_typeof(g."topics_json"->'categories') = 'array'
  AND c.mention->>'category' IN ('limpieza','habitacion','personal','desayuno','restauracion','ubicacion','precio_valor','instalaciones','ruido','wifi','recepcion_checkin','mantenimiento')
ORDER BY g."id", c.mention->>'category', COALESCE(NULLIF(c.mention->>'confidence', '')::numeric, 0) DESC
ON CONFLICT ("review_id", "category") DO NOTHING;

-- ----------------------------------------------------------------------------
-- §6 comprobaciones (se detiene sin perder datos), unicidad y NOT NULL
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  nulos INTEGER;
  duplicadas INTEGER;
BEGIN
  SELECT count(*) INTO nulos FROM "guest_reviews" WHERE "external_reference" IS NULL OR "external_reference" = '';
  IF nulos > 0 THEN
    RAISE EXCEPTION 'reputacion_reviews: % reseñas sin external_reference tras el backfill de §5.4', nulos;
  END IF;
  SELECT count(*) INTO duplicadas FROM (
    SELECT 1 FROM "guest_reviews" GROUP BY "property_id", "source", "external_reference" HAVING count(*) > 1
  ) d;
  IF duplicadas > 0 THEN
    -- Carrera documentada de review-meta.store.ts (findFirst + create sin @@unique):
    -- repara antes de migrar conservando la fila más antigua, p. ej.
    --   UPDATE guest_reviews g SET external_reference = g.external_reference || ':dup:' || g.id
    --   FROM (SELECT id, row_number() OVER (PARTITION BY property_id, source, external_reference ORDER BY created_at, id) AS n FROM guest_reviews) r
    --   WHERE r.id = g.id AND r.n > 1;
    RAISE EXCEPTION 'reputacion_reviews: % grupos (property_id, source, external_reference) duplicados en guest_reviews; repara antes de migrar', duplicadas;
  END IF;
  SELECT count(*) INTO duplicadas FROM (
    SELECT 1 FROM "review_sources" WHERE "external_location_id" IS NOT NULL GROUP BY "property_id", "provider", "external_location_id" HAVING count(*) > 1
  ) d;
  IF duplicadas > 0 THEN
    RAISE EXCEPTION 'reputacion_reviews: % grupos (property_id, provider, external_location_id) duplicados en review_sources; repara antes de migrar', duplicadas;
  END IF;
END $$;

-- AlterTable (generador; reordenado tras el backfill)
ALTER TABLE "guest_reviews" ALTER COLUMN "external_reference" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "review_sources_property_id_provider_external_location_id_key" ON "review_sources"("property_id", "provider", "external_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "guest_reviews_property_id_source_external_reference_key" ON "guest_reviews"("property_id", "source", "external_reference");

-- ----------------------------------------------------------------------------
-- §7 quality_cases.review_id desde el marcador `[reseña:<id>]` (review-alerts.service.ts:60-66)
-- ----------------------------------------------------------------------------
UPDATE "quality_cases"
SET "review_id" = substring("description" from '^\[reseña:([^\]]+)\]')
WHERE "review_id" IS NULL
  AND "case_type" = 'review_negative'
  AND "description" ~ '^\[reseña:[^\]]+\]';
```

### 2.1-2.4 (generado) · 2.5-2.7 (a mano)

Los apartados §1-§4 del SQL son la salida del generador (comprobar con el `migrate diff` de arriba: mismo
número de sentencias; el generador emite el `ALTER COLUMN … SET NOT NULL` dentro del `ALTER TABLE "guest_reviews"`
de §2 y los dos `CREATE UNIQUE INDEX` junto a los demás índices: aquí van al final de §6, después del backfill).
§5-§7 son a mano y `db:drift:check` no los ve (compara datasource ↔ datamodel).

---

## 3 · Comprobaciones previas (solo SELECT) y puertas

Antes de aplicar, sobre la BD local con `psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"`:

```sql
SELECT to_regclass('public.reputation_daily_scores'), to_regclass('public.review_source_runs'), to_regclass('public.review_category_mentions');  -- NULL, NULL, NULL
SELECT count(*) FILTER (WHERE external_reference IS NULL OR external_reference = '') AS sin_ref, count(*) AS total FROM guest_reviews;
SELECT property_id, source, external_reference, count(*) FROM guest_reviews GROUP BY 1, 2, 3 HAVING count(*) > 1;          -- 0 filas
SELECT property_id, provider, config_json->>'externalLocationId' AS loc, count(*) FROM review_sources WHERE config_json->>'externalLocationId' IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;  -- 0 filas
SELECT count(*) FROM quality_cases WHERE case_type = 'review_negative' AND description ~ '^\[reseña:';                     -- casos que §7 enlazará
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 3;                             -- la última debe ser la de L5
```

Puertas, en este orden, desde `~/anfitorio-demo/hotelos` (árbol principal, con L5 fusionada):

```bash
corepack pnpm --filter @hotelos/database exec prisma validate                 # esquema válido
corepack pnpm --filter @hotelos/database exec prisma format                   # alineación (no cambia semántica)
pnpm db:migrate:status                                                        # «1 migration not yet applied»: 20260919124000_reputacion
pnpm db:migrate:deploy                                                        # aplica (idempotente; se detiene en los DO $$ de §6 si hay duplicados)
pnpm db:drift:check                                                           # «No difference detected.»
pnpm db:migrations:check                                                      # tablas = modelos (+3 respecto al recuento tras L5: 274 en L2 → 277 si L3/L5 no añadieron tablas)
pnpm db:generate                                                              # cliente Prisma con las columnas nuevas
node --test tests/migrations-squash-contract.test.mjs tests/advanced-modules-contract.test.mjs tests/worker-integration-contract.test.mjs tests/demo-seed-contract.test.mjs
node scripts/typecheck-all.mjs                                                # 15 PASS · 0 FAIL · 1 SKIP (guest-web)
corepack pnpm --filter @hotelos/api test
cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/l8-reputation-*.test.mts ../../tests/integration/l2-motor-generico.test.mts ../../tests/integration/l2-paginacion.test.mts ../../tests/integration/l2-robustez.test.mts
```

Después del `deploy`, comprobación de la BD (SELECT): `SELECT count(*) FROM review_source_runs;` (= Σ de
`jsonb_array_length(config_json->'runs')`), `SELECT count(*) FROM review_category_mentions;`, `SELECT status,
count(*) FROM guest_reviews GROUP BY 1;`, `SELECT count(*) FROM quality_cases WHERE review_id IS NOT NULL;`.

---

## 4 · Plan de activación en código (tras el parche; ficheros de T8, en un lote posterior «T8-L0b»)

El código de T8 funciona sin el parche y **no cambia de comportamiento** al aplicarlo (solo `schemaPatchApplied`
pasa a `true` en el snapshot). Activar las tablas exige estas ediciones, todas en ficheros exclusivos de T8 salvo
las marcadas ⚠:

| Fichero | Hoy | Tras el parche |
|---|---|---|
| `apps/api/src/modules/reputation/reputation-score.service.ts` | `detectSchemaPatch()` (:231) solo informa; índice al vuelo con caché 60 s (`snapshotCache` :130), `staleDays` siempre 0 | Nuevo `reputation-daily-score.store.ts`: `upsertDailyScore({ propertyId, scoreDate, windowDays, result, correlationId })` por `@@unique([propertyId, scoreDate, windowDays])` (30/90/365) al final de cada tick (`reputation-sync.service.ts` `runReputationSync`, tras `purgeExpiredBodies` :516) y en `POST …/imports`; `getReputationSnapshot` (:156) lee la fila de hoy o la última disponible (`staleDays = hoy − scoreDate`) cuando `schemaPatchApplied`, y solo recalcula si no hay fila; `trendDelta` = fila de hace 30 días; `computeOrgComparison` (`reputation-index.ts`) sobre las filas del día de la organización (`kind = hotel`). Ruta futura `POST /reputation/properties/:propertyId/scores/recompute?from=&to=` (no está entre las 12 de T8-D: entrada nueva en el partial + `docs/api-contracts.md`). |
| `apps/api/src/modules/reputation/review-meta.store.ts` | `upsertReviewFromNormalized` (:138) = `findFirst` + `create`/`update` (carrera documentada :16-20); `patchReviewMeta` (:257) lee-modifica-escribe `topicsJson`; `saveSourceRun` (:321) empuja al ring buffer `configJson.runs`; `listSourceConfigs` (:293) lee `configJson` | `upsert` atómico por `propertyId_source_externalReference` escribiendo columnas **y** `topicsJson` (doble escritura mientras el front lea la meta); `patchReviewMeta` escribe `status`, `assignedUserId`, `slaTargetAt`, `draft*`, `response*`, `analysis*`, `bodyPurgedAt` como columnas (update atómico) y mantiene la meta; `saveSourceRun` inserta `reviewSourceRun` + actualiza `lastRunAt/lastSuccessAt/lastError/cursorJson/status` (el ring buffer queda solo como respaldo si `!schemaPatchApplied`); `listSourceConfigs` lee las columnas. `scoreOfRow` prefiere `row.score10`. |
| `apps/api/src/modules/reputation/review-inbox.service.ts` | Filtros en memoria sobre `INBOX_SCAN_LIMIT` = 500 filas (:45, :191-235) | `where` SQL por `status`, `sourceId`, `score10`, `language`, `assignedUserId`, `respondedAt`, `slaTargetAt` con el índice `[propertyId, status, slaTargetAt]`; categoría vía `mentions: { some: { category } }`; paginación por cursor real (`lib/pagination.ts`). |
| `apps/api/src/modules/reputation/reputation-sync.service.ts` | `analyzePendingReviews` (:310) guarda `meta.categories`/`meta.analysis` | Además `reviewCategoryMention.deleteMany({ reviewId })` + `createMany` con las menciones (`analysisSource` honesto) y las columnas `analysisStatus/analysisSource/analyzedAt/summary`. |
| `apps/api/src/modules/reputation/review-alerts.service.ts` y `dashboards/quality.service.ts` | Enlace por `meta.qualityCaseId` + marcador `[reseña:<id>]` en la descripción (:60-66) | `qualityCase.create({ reviewId })` (el marcador se conserva por legibilidad); el panel de calidad lee `reviewId` (hoy lo deriva del marcador). |
| `apps/api/src/modules/reputation/review-sources.service.ts` | `hasCredentials` siempre `false` (:13-14); credenciales prohibidas en `configJson` | `credentialsJson = encryptField(JSON.stringify(credentials))` (`lib/crypto.service.ts`, `HOTELOS_FIELD_KEY`) al completar el OAuth de Google (T8-L5); el DTO devuelve `hasCredentials: true` y nunca el valor; `describeSourceStatus` recibe `credentials: decryptField(...)` solo en el proceso del tick. |
| `apps/worker/src/jobs/reputation-maintenance.job.ts` | Purga/plazo por `topicsJson` (`bodyPurgedAt`, `slaTargetAt`, `status`) y recorte de `configJson.runs` a 20 | Purga por columnas (`bodyPurgedAt IS NULL AND receivedAt < ahora − retentionDays`), plazo por `status IN (new, assigned, drafted) AND slaTargetAt < ahora`; el recorte de `runs` se sustituye por retención de `review_source_runs` (p. ej. 90 días) por `deleteMany` acotado por `startedAt`. |
| ⚠ `apps/api/src/modules/advanced/advanced-record-store.ts:841-852` (L2) | `respondGuestReview` escribe `responseBody`/`respondedAt` | Añadir `status: "responded"` al `update` (:850) para que la columna y la meta coincidan; `l2-motor-generico.test.mts:429-441` no cambia (la respuesta deriva `status` de `respondedAt`). |
| `apps/api/src/scripts/refresh-demo-dataset.ts:206-224` y `scripts/__tests__/refresh-demo-dataset.test.mts:114-115` | `GUEST_REFERENCE_TABLES` (tablas con `guest_id`) incluye `guestReview`, `surveyResponse`, `qualityCase` | **NO añadir** `reviewCategoryMention` ni `reputationDailyScore` a `GUEST_REFERENCE_TABLES`: el bucle de `:814-818` consulta cada delegado con `findMany({ where: { guestId } })` y esas tablas no tienen `guest_id` (Prisma lanzaría «Unknown argument guestId»). Las menciones se borran en cascada con `guest_reviews` (FK `ON DELETE CASCADE`) y `reputation_daily_scores` no referencia huéspedes. El test `:114-115` sigue verde sin cambios. Si el plan de limpieza de demo quiere vaciarlas explícitamente, hacerlo con `deleteMany` por `propertyId` en el seed de reputación (`apps/api/src/scripts/seed-reputation-demo.ts` `purgeDemoRows` :255) y no en este script. |
| `apps/admin-web/src/services/reputation-contracts.ts` + `apps/api/src/modules/reputation/reputation-types.ts` (bloque `SHARED-BEGIN…SHARED-END`, byte a byte) | DTOs sin cambio | Sin cambio de cable: los DTOs ya llevan `score10`, `status`, `categories`, `runs`, `staleDays`. Solo cambia de dónde se leen. |

---

## 5 · Riesgos y notas

1. **Tests de L2 que pinan `prop_123`**: `l2-paginacion.test.mts:653-666` (`reputation` undefined con 0 reseñas en 30 d) y
   `:634-638` (`avgReviewRating`), `l2-motor-generico.test.mts:429-456`. El parche no cambia datos de `prop_123`
   (solo columnas con DEFAULT y backfill de lo que ya existía). Rerun obligatorio tras `deploy`.
2. **`Decimal(3,2)` de `rating`** sigue sin admitir 10,00: la nota original de Booking (1-10) se guarda en `rating`
   solo si ≤ 9,99; `score10 Decimal(4,2)` y `ratingScaleMax Decimal(4,2)` sí admiten 10,00 (review-normalize.ts ya
   escribe `rating = null` cuando no cabe: comprobar en `normalizeRatingOrNull`).
3. **Índices únicos con NULL**: `review_sources (property_id, provider, external_location_id)` admite varias fuentes
   del mismo portal sin `external_location_id` (NULL ≠ NULL): es lo que hoy hace el seed de demo (3 fuentes `_demo`).
   Si se quiere una sola fuente por (propiedad, proveedor) sin ubicación, añadir a mano un índice único parcial
   `WHERE external_location_id IS NULL` (como los 14 de `20260918130000_persistencia_l2` §7; `db:drift:check` no lo ve).
4. **`worker-integration-contract.test.mjs:41-47`** solo exige `model WorkerJobRun` y sus columnas: no le afectan los
   modelos nuevos. `advanced-modules-contract.test.mjs:93-94` sigue encontrando `GuestReview`/`QualityCase`.
5. **Vocabularios**: donde el diseño §7 y el código de T8 difieren (`trigger`, `status` de la ejecución, `indexValue`),
   manda el código; el diseño se actualiza en `docs/design/REPUTACION-REVIEWS.md` §7/§4.4 en el lote de docs.
6. **Retención de Google (30 días)** sigue siendo responsabilidad del job (`purgeExpiredBodies` / worker): el parche
   solo aporta `bodyPurgedAt` como columna consultable.
