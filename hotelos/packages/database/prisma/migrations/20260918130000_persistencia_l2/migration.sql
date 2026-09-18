-- ============================================================================
-- 20260918130000_persistencia_l2 · Persistencia L2 (Tanda L2 · lote L2-01)
-- ============================================================================
-- Generada el 2026-09-18 con:
--   cd packages/database && corepack pnpm exec prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- y revisada a mano. Todo lo que emitió el generador está aquí VERBATIM (3 ALTER
-- TABLE … ADD COLUMN, 18 DROP TABLE, 2 CREATE TABLE, 4 índices). Lo escrito a mano
-- —DDL que Prisma no declara y que `migrate diff --from-schema-datasource` ignora
-- (igual que los triggers de 20260916102000 y los CHECK de 20260918100000 →
-- db:drift:check sigue en «No difference»)— es:
--   · el relleno de notifications.organization_id (ADD COLUMN NULL → UPDATE desde
--     properties → comprobación de 0 NULL → SET NOT NULL → DEFAULT '');
--   · las comprobaciones DO $$ … $$ previas a cada paso destructivo o restrictivo
--     (tablas vacías antes de DROP, 0 duplicados antes de cada índice único parcial,
--     0 NULL antes de cada NOT NULL): la migración se detiene en lugar de perder datos;
--   · la restricción CHECK invoice_sequences_year_not_null (ver §4);
--   · los 14 índices únicos parciales de §7 (uniques compuestos con columnas
--     opcionales: en Postgres NULL ≠ NULL, así que el unique de Prisma no protegía
--     las filas de nivel superior / de organización).
--
-- Fuente: docs/audits/TANDA-5-PLAN-2026-09-15.md §3 fila L2 y ~/anfitorio-demo/pilots
-- app-recon-3.md §C (22 tablas muertas, 51 modelos sin escritor, 16 uniques con NULL).
-- Cifras verificadas hoy con psql sobre la demo local: notifications 2 filas (prop_123
-- → org_123), offline_sync_records 0, worker_job_runs 0, invoice_sequences 26 (0 NULL
-- en year), las 18 tablas retiradas 0 filas, 0 duplicados en los 14 grupos de §7.
--
-- ORDEN: §1 notificaciones · §2 offline sync · §3 worker · §4 series de factura ·
-- §5 tablas nuevas · §6 retirada de tablas · §7 índices únicos parciales.

-- ----------------------------------------------------------------------------
-- §1 notifications.organization_id (NOT NULL, rellenado desde properties)
-- ----------------------------------------------------------------------------
-- AlterTable (generador: ADD COLUMN … NOT NULL DEFAULT ''; aquí en tres pasos para
-- rellenar la organización REAL de las filas existentes antes del NOT NULL).
ALTER TABLE "notifications" ADD COLUMN     "organization_id" TEXT;

UPDATE "notifications" n
SET "organization_id" = p."organization_id"
FROM "properties" p
WHERE p."id" = n."property_id" AND n."organization_id" IS NULL;

DO $$
DECLARE
  huerfanas INTEGER;
BEGIN
  SELECT count(*) INTO huerfanas FROM "notifications" WHERE "organization_id" IS NULL;
  IF huerfanas > 0 THEN
    RAISE EXCEPTION 'persistencia_l2: % notificaciones sin organización resoluble (property_id sin fila en properties); corrige o borra esas filas antes de migrar', huerfanas;
  END IF;
END $$;

ALTER TABLE "notifications" ALTER COLUMN "organization_id" SET NOT NULL;
-- El DEFAULT '' existe solo para que el escritor previo (auth.service.ts ·
-- notificationToDbRow, que no pasa organization_id; fuera de este lote) siga
-- compilando contra el cliente Prisma. En HEAD ningún flujo crea notificaciones
-- nuevas (solo se materializan las 2 fixtures de prop_123, ya rellenadas aquí),
-- así que ninguna fila queda con '' ; y una fila con '' sería invisible para todo
-- tenant (las lecturas filtran por organización). Deuda L2 (lote de
-- /notifications): pasar organizationId en el escritor y, en la migración
-- siguiente, retirar el DEFAULT y añadir CHECK ("organization_id" <> '').
ALTER TABLE "notifications" ALTER COLUMN "organization_id" SET DEFAULT '';

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_status_created_at_idx" ON "notifications"("organization_id", "user_id", "status", "created_at");

-- ----------------------------------------------------------------------------
-- §2 offline_sync_records.organization_id (NOT NULL directo: la tabla está vacía)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  filas INTEGER;
BEGIN
  SELECT count(*) INTO filas FROM "offline_sync_records";
  IF filas > 0 THEN
    RAISE EXCEPTION 'persistencia_l2: offline_sync_records tiene % filas; la columna organization_id NOT NULL exige rellenarlas primero', filas;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "offline_sync_records" ADD COLUMN     "organization_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "offline_sync_records_organization_id_property_id_created_at_idx" ON "offline_sync_records"("organization_id", "property_id", "created_at");

-- ----------------------------------------------------------------------------
-- §3 worker_job_runs: tenant opcional (un job de plataforma no tiene organización)
-- ----------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "worker_job_runs" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "property_id" TEXT;

-- CreateIndex
CREATE INDEX "worker_job_runs_organization_id_job_name_created_at_idx" ON "worker_job_runs"("organization_id", "job_name", "created_at");

-- ----------------------------------------------------------------------------
-- §4 invoice_sequences.year: nunca NULL
-- ----------------------------------------------------------------------------
-- Comprobación previa (hoy: 0 NULL de 26 filas):
--   SELECT count(*) FROM invoice_sequences WHERE year IS NULL;   -- = 0
-- Los tres escritores ya pasan year (backoffice.service.ts:5982-5995,
-- property-provisioning.service.ts:1012-1023, invoice.service.ts:562-566). La
-- columna se protege con una restricción CHECK en lugar de SET NOT NULL porque el
-- cliente Prisma sigue declarando `year Int?`: invoice.service.ts:527,
-- backoffice.service.ts:5901 y series-prefix.service.ts:72 aún consultan filas
-- heredadas con `year: null` (fuera de este lote). Al retirar esas búsquedas:
-- `year Int` + `ALTER COLUMN "year" SET NOT NULL` + DROP de esta CHECK.
DO $$
DECLARE
  nulos INTEGER;
BEGIN
  SELECT count(*) INTO nulos FROM "invoice_sequences" WHERE "year" IS NULL;
  IF nulos > 0 THEN
    RAISE EXCEPTION 'persistencia_l2: % series de factura sin ejercicio (year IS NULL); rellénalas antes de migrar', nulos;
  END IF;
END $$;

ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_year_not_null" CHECK ("year" IS NOT NULL);

-- ----------------------------------------------------------------------------
-- §5 Tablas nuevas: líder de schedulers y confirmaciones IA pendientes (HITL)
-- ----------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "scheduler_leases" (
    "key" TEXT NOT NULL,
    "holder_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduler_leases_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ai_pending_confirmations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "room_id" TEXT,
    "guest_id" TEXT NOT NULL,
    "guest_register_record_id" TEXT NOT NULL,
    "card_json" JSONB NOT NULL,
    "required_signature" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_pending_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_pending_confirmations_organization_id_property_id_status_idx" ON "ai_pending_confirmations"("organization_id", "property_id", "status", "created_at");

-- ----------------------------------------------------------------------------
-- §6 Retirada de 18 tablas muertas (0 lectores/escritores en runtime, 0 filas)
-- ----------------------------------------------------------------------------
-- Criterio (plan §3 L2 · punto 4): sin consumidor en ningún front, sin filas en
-- Faranda ni en org_123, fuera de todo flujo fiscal. Verificado con
--   grep -rnE "\b<Modelo>\b|\.<delegado>\." apps/ packages/ scripts/ tests/
-- (únicas referencias: apps/api/src/lib/tenancy.ts —retiradas en este lote— y los
-- contratos por texto tests/*.test.mjs —asserts retirados en este lote—).
-- guest_portal_actions se CONSERVA (el plan la listaba): apps/api/src/scripts/
-- refresh-demo-dataset.ts:213 la dereferencia como delegado Prisma en demo:refresh
-- (línea 814 lanza si el delegado no existe); se retira cuando ese script deje de
-- listarla. Orden: hijos de onboarding_projects primero (onboarding_projects se
-- conserva: resolver `onboardingProject` de tenancy.ts). Ninguna tiene FK (verificado
-- en pg_constraint). Cada DROP va precedido de la comprobación de tabla vacía.
DO $$
DECLARE
  tabla TEXT;
  filas BIGINT;
BEGIN
  FOREACH tabla IN ARRAY ARRAY[
    'onboarding_migration_batch_records', 'onboarding_migration_batches',
    'onboarding_mapping_suggestions', 'onboarding_extracted_entities', 'onboarding_files',
    'onboarding_source_connections', 'ai_onboarding_runs', 'room_feature_assignments',
    'room_beds', 'reservation_resources', 'property_map_positions', 'property_imports',
    'backoffice_ai_suggestions', 'revenue_report_views', 'revenue_scenarios',
    'revenue_automation_rules', 'api_usage_logs', 'module_dependencies'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %I', tabla) INTO filas;
    IF filas > 0 THEN
      RAISE EXCEPTION 'persistencia_l2: la tabla % tiene % filas; no se retira una tabla con datos (haz pg_dump y vacíala a mano si procede)', tabla, filas;
    END IF;
  END LOOP;
END $$;

-- DropTable
DROP TABLE "onboarding_migration_batch_records";

-- DropTable
DROP TABLE "onboarding_migration_batches";

-- DropTable
DROP TABLE "onboarding_mapping_suggestions";

-- DropTable
DROP TABLE "onboarding_extracted_entities";

-- DropTable
DROP TABLE "onboarding_files";

-- DropTable
DROP TABLE "onboarding_source_connections";

-- DropTable
DROP TABLE "ai_onboarding_runs";

-- DropTable
DROP TABLE "room_feature_assignments";

-- DropTable
DROP TABLE "room_beds";

-- DropTable
DROP TABLE "reservation_resources";

-- DropTable
DROP TABLE "property_map_positions";

-- DropTable
DROP TABLE "property_imports";

-- DropTable
DROP TABLE "backoffice_ai_suggestions";

-- DropTable
DROP TABLE "revenue_report_views";

-- DropTable
DROP TABLE "revenue_scenarios";

-- DropTable
DROP TABLE "revenue_automation_rules";

-- DropTable
DROP TABLE "api_usage_logs";

-- DropTable
DROP TABLE "module_dependencies";

-- ----------------------------------------------------------------------------
-- §7 Índices únicos parciales (uniques compuestos con columnas opcionales)
-- ----------------------------------------------------------------------------
-- En Postgres dos NULL nunca son iguales, así que el @@unique de Prisma no impide
-- duplicar la fila «de nivel superior» (sin desglose) ni la «de organización»
-- (property_id IS NULL). Prisma no declara índices parciales y `migrate diff` los
-- ignora (verificado: db:drift:check en «No difference» con ellos creados), así
-- que viven aquí como SQL crudo. Antes de cada índice, la consulta de duplicados
-- ejecutada hoy (resultado: 0 filas en todos) y su comprobación en la migración.
-- Los uniques de Payment, RateChangeJournal, Invoice, JournalEntry, SupplierBill,
-- CommissionAccrual y PmsShadowRun no cambian (idempotencia / borradores por
-- diseño); Property [legalEntityId, code] tampoco (una propiedad sin sociedad no
-- tiene código de serie que colisionar).

-- 7.1 revenue_daily_snapshots · unique real = (property_id, snapshot_date, room_type_id,
--     rate_plan_id, channel_id, segment, market). Las 1.398 filas son de nivel superior.
--   SELECT property_id, snapshot_date, count(*) FROM revenue_daily_snapshots
--   WHERE room_type_id IS NULL AND rate_plan_id IS NULL AND channel_id IS NULL
--     AND segment IS NULL AND market IS NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;                                   -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "revenue_daily_snapshots"
    WHERE "room_type_id" IS NULL AND "rate_plan_id" IS NULL AND "channel_id" IS NULL AND "segment" IS NULL AND "market" IS NULL
    GROUP BY "property_id", "snapshot_date" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: revenue_daily_snapshots tiene instantáneas de nivel superior duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "revenue_daily_snapshots_top_level_key"
  ON "revenue_daily_snapshots" ("property_id", "snapshot_date")
  WHERE "room_type_id" IS NULL AND "rate_plan_id" IS NULL AND "channel_id" IS NULL AND "segment" IS NULL AND "market" IS NULL;

-- 7.2 revenue_forecast_snapshots (0 filas) · unique real añade model_version: la
--     clave de nivel superior lo incluye con COALESCE para cubrir NULL y no NULL.
--   SELECT property_id, forecast_date, COALESCE(model_version, ''), count(*)
--   FROM revenue_forecast_snapshots
--   WHERE room_type_id IS NULL AND rate_plan_id IS NULL AND channel_id IS NULL
--     AND segment IS NULL AND market IS NULL
--   GROUP BY 1, 2, 3 HAVING count(*) > 1;                                -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "revenue_forecast_snapshots"
    WHERE "room_type_id" IS NULL AND "rate_plan_id" IS NULL AND "channel_id" IS NULL AND "segment" IS NULL AND "market" IS NULL
    GROUP BY "property_id", "forecast_date", COALESCE("model_version", '') HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: revenue_forecast_snapshots tiene previsiones de nivel superior duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "revenue_forecast_snapshots_top_level_key"
  ON "revenue_forecast_snapshots" ("property_id", "forecast_date", COALESCE("model_version", ''))
  WHERE "room_type_id" IS NULL AND "rate_plan_id" IS NULL AND "channel_id" IS NULL AND "segment" IS NULL AND "market" IS NULL;

-- 7.3 forecast_accuracy · (property_id, stay_date, metric) sin segmento.
--   SELECT property_id, stay_date, metric, count(*) FROM forecast_accuracy
--   WHERE segment IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;           -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "forecast_accuracy" WHERE "segment" IS NULL
    GROUP BY "property_id", "stay_date", "metric" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: forecast_accuracy tiene métricas sin segmento duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "forecast_accuracy_no_segment_key"
  ON "forecast_accuracy" ("property_id", "stay_date", "metric")
  WHERE "segment" IS NULL;

-- 7.4 fiscal_periods · periodo de organización (property_id IS NULL).
--   SELECT organization_id, period_code, count(*) FROM fiscal_periods
--   WHERE property_id IS NULL GROUP BY 1, 2 HAVING count(*) > 1;         -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "fiscal_periods" WHERE "property_id" IS NULL
    GROUP BY "organization_id", "period_code" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: fiscal_periods tiene periodos de organización duplicados'; END IF;
END $$;
CREATE UNIQUE INDEX "fiscal_periods_organization_key"
  ON "fiscal_periods" ("organization_id", "period_code")
  WHERE "property_id" IS NULL;

-- 7.5 fiscal_years · ejercicio de organización.
--   SELECT organization_id, code, count(*) FROM fiscal_years
--   WHERE property_id IS NULL GROUP BY 1, 2 HAVING count(*) > 1;         -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "fiscal_years" WHERE "property_id" IS NULL
    GROUP BY "organization_id", "code" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: fiscal_years tiene ejercicios de organización duplicados'; END IF;
END $$;
CREATE UNIQUE INDEX "fiscal_years_organization_key"
  ON "fiscal_years" ("organization_id", "code")
  WHERE "property_id" IS NULL;

-- 7.6 payroll_periods · periodo de nómina de organización.
--   SELECT organization_id, period_code, count(*) FROM payroll_periods
--   WHERE property_id IS NULL GROUP BY 1, 2 HAVING count(*) > 1;         -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payroll_periods" WHERE "property_id" IS NULL
    GROUP BY "organization_id", "period_code" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: payroll_periods tiene periodos de organización duplicados'; END IF;
END $$;
CREATE UNIQUE INDEX "payroll_periods_organization_key"
  ON "payroll_periods" ("organization_id", "period_code")
  WHERE "property_id" IS NULL;

-- 7.7 notification_templates · plantilla de organización (hoy 1 fila).
--   SELECT organization_id, code, channel, language, count(*) FROM notification_templates
--   WHERE property_id IS NULL GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;   -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "notification_templates" WHERE "property_id" IS NULL
    GROUP BY "organization_id", "code", "channel", "language" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: notification_templates tiene plantillas de organización duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "notification_templates_organization_key"
  ON "notification_templates" ("organization_id", "code", "channel", "language")
  WHERE "property_id" IS NULL;

-- 7.8-7.11 user_role_assignments · una asignación VIVA y sin caducidad por tupla
--     (usuario, rol, tipo de ámbito, referencia). El servicio (modules/rbac/
--     assignments.service.ts:437-451) revoca con UPDATE (revoked_at) y vuelve a
--     crear una fila nueva al reasignar; contracts.service.ts:194 cierra con
--     valid_to (baja) sin revocar y la readmisión crea otra fila. Por eso el
--     predicado es `revoked_at IS NULL AND valid_to IS NULL`: es exactamente la
--     tupla que el servicio trata como idempotente; las concesiones temporales
--     (valid_to fijado) las sigue deduplicando el servicio.
--   SELECT user_id, role_id, scope_type, property_id, count(*) FROM user_role_assignments
--   WHERE property_id IS NOT NULL GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;            -- 0 filas
--   … ídem property_group_id / legal_entity_id …                                         -- 0 filas
--   SELECT user_id, role_id, scope_type, count(*) FROM user_role_assignments
--   WHERE property_id IS NULL AND property_group_id IS NULL AND legal_entity_id IS NULL
--   GROUP BY 1, 2, 3 HAVING count(*) > 1;                                                -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "user_role_assignments" WHERE "property_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL
    GROUP BY "user_id", "role_id", "scope_type", "property_id" HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "user_role_assignments" WHERE "property_group_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL
    GROUP BY "user_id", "role_id", "scope_type", "property_group_id" HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "user_role_assignments" WHERE "legal_entity_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL
    GROUP BY "user_id", "role_id", "scope_type", "legal_entity_id" HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "user_role_assignments"
    WHERE "property_id" IS NULL AND "property_group_id" IS NULL AND "legal_entity_id" IS NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL
    GROUP BY "user_id", "role_id", "scope_type" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: user_role_assignments tiene asignaciones vivas duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "user_role_assignments_live_property_key"
  ON "user_role_assignments" ("user_id", "role_id", "scope_type", "property_id")
  WHERE "property_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL;
CREATE UNIQUE INDEX "user_role_assignments_live_property_group_key"
  ON "user_role_assignments" ("user_id", "role_id", "scope_type", "property_group_id")
  WHERE "property_group_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL;
CREATE UNIQUE INDEX "user_role_assignments_live_legal_entity_key"
  ON "user_role_assignments" ("user_id", "role_id", "scope_type", "legal_entity_id")
  WHERE "legal_entity_id" IS NOT NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL;
CREATE UNIQUE INDEX "user_role_assignments_live_organization_key"
  ON "user_role_assignments" ("user_id", "role_id", "scope_type")
  WHERE "property_id" IS NULL AND "property_group_id" IS NULL AND "legal_entity_id" IS NULL AND "revoked_at" IS NULL AND "valid_to" IS NULL;

-- 7.12 exchange_rates · tipo de cambio global (organization_id IS NULL).
--   SELECT base_currency, quote_currency, effective_date, count(*) FROM exchange_rates
--   WHERE organization_id IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;  -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "exchange_rates" WHERE "organization_id" IS NULL
    GROUP BY "base_currency", "quote_currency", "effective_date" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: exchange_rates tiene tipos globales duplicados'; END IF;
END $$;
CREATE UNIQUE INDEX "exchange_rates_global_key"
  ON "exchange_rates" ("base_currency", "quote_currency", "effective_date")
  WHERE "organization_id" IS NULL;

-- 7.13 esrs_indicators · indicador de organización.
--   SELECT organization_id, fiscal_year, disclosure_code, count(*) FROM esrs_indicators
--   WHERE property_id IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;      -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "esrs_indicators" WHERE "property_id" IS NULL
    GROUP BY "organization_id", "fiscal_year", "disclosure_code" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: esrs_indicators tiene indicadores de organización duplicados'; END IF;
END $$;
CREATE UNIQUE INDEX "esrs_indicators_organization_key"
  ON "esrs_indicators" ("organization_id", "fiscal_year", "disclosure_code")
  WHERE "property_id" IS NULL;

-- 7.14 app_installations · instalación de organización.
--   SELECT app_id, organization_id, count(*) FROM app_installations
--   WHERE property_id IS NULL GROUP BY 1, 2 HAVING count(*) > 1;         -- 0 filas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "app_installations" WHERE "property_id" IS NULL
    GROUP BY "app_id", "organization_id" HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'persistencia_l2: app_installations tiene instalaciones de organización duplicadas'; END IF;
END $$;
CREATE UNIQUE INDEX "app_installations_organization_key"
  ON "app_installations" ("app_id", "organization_id")
  WHERE "property_id" IS NULL;
