-- ============================================================================
-- 20260919124000_reputacion · Reputación y reseñas (Tanda T8 · parche T8-L0)
-- ============================================================================
-- Generada y aplicada en local el 2026-09-19 (tras pg_dump previo) con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- y revisada a mano. Lo que emitió el generador está VERBATIM en §1-§4 (3 ALTER TABLE …
-- ADD COLUMN, 3 CREATE TABLE, 8 CREATE INDEX / CREATE UNIQUE INDEX, 2 ADD FOREIGN KEY);
-- reordenado a mano UN solo punto: los dos `CREATE UNIQUE INDEX` van al final de §6,
-- después del backfill de §5.
-- DECISIÓN (desviación respecto a docs/design/olas/T8-SCHEMA-PATCH.md): external_reference
-- se queda NULLABLE (String? en schema.prisma) y NO hay `SET NOT NULL`, porque el motor
-- genérico (POST del motor y tests/integration/l2-motor-generico.test.mts) crea
-- guest_reviews sin referencia externa; el índice único (property_id, source,
-- external_reference) trata NULL como distinto y el store de T8 (review-meta.store.ts)
-- siempre escribe la referencia. La comprobación de 0 NULL del DO $$ de §6 se conserva
-- como salvaguarda del backfill de §5.4 (`legacy:<id>` para las filas previas).
-- Lo escrito a mano (DDL/DML que Prisma no declara y
-- que `db:drift:check` ignora, igual que los DO $$ de 20260918130000) es:
--   · §5 backfill desde los JSON que la Tanda T8 escribió antes del parche
--     (guest_reviews.topics_json = ReviewMeta v1, review_sources.config_json =
--     ReviewSourceConfig v1: apps/api/src/modules/reputation/reputation-types.ts);
--   · §6 comprobaciones DO $$ … $$ antes de cada índice único (0 duplicados) y
--     0 NULL tras el backfill de §5.4: la migración se detiene en lugar de perder datos;
--   · §7 quality_cases.review_id desde el marcador `[reseña:<id>]` de la descripción
--     (review-alerts.service.ts buildCaseDescription).
-- Migración ADITIVA: ningún DROP, ningún NOT NULL sin DEFAULT (external_reference sigue
-- nullable). Idempotente en los INSERT (ON CONFLICT DO NOTHING) y en los UPDATE.
--
-- ORDEN: §1 review_sources · §2 guest_reviews · §3 quality_cases · §4 tablas nuevas,
-- índices y FKs · §5 backfill · §6 comprobaciones + unicidad · §7 casos.

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
-- §2 guest_reviews: columnas de ReviewMeta v1 (external_reference sigue nullable: ver cabecera)
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
-- §6 comprobaciones (se detiene sin perder datos) y unicidad
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
