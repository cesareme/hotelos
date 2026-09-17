-- ============================================================================
-- 20260917100000_opera_modo_sombra · OPERA Cloud en modo sombra (Tanda 7b · L0)
-- ============================================================================
-- Generada el 2026-09-17 con:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- y revisada a mano. Todo lo que emitió el generador está aquí VERBATIM y no hay
-- nada escrito a mano (ni índices parciales ni funciones ni triggers): la regla
-- «un lote de ingresos no revertido por (propiedad, business date)» la impone el
-- servicio de L2 bajo pg_advisory_xact_lock → db:drift:check sigue en 0.
--
-- Diseño: docs/design/OPERA-CLOUD-MODO-SOMBRA.md §5 (semántica de sincronización,
-- reconciliación y alertas) y §6.1 (modelo). Catálogos de los estados (texto, sin
-- enums nuevos): packages/shared/src/pms-shadow-types.ts. GDPR: los ficheros
-- recibidos NO se guardan; ninguna de estas tablas registra nombre, e-mail,
-- teléfono ni documento del huésped (solo nº de confirmación, códigos OPERA,
-- métricas e importes; los mensajes de alerta no citan valores personales).
--
-- ADITIVA (ninguna tabla ni columna existente se toca; `reservations` no gana
-- columnas: la relación 1:1 vive en la tabla de enlace; sin paso de datos):
--   · pms_shadow_profiles — perfil «modo sombra» por (propiedad, sistema):
--     código de hotel OPERA, estado active | paused, mapeos de códigos maestros
--     (JSON), mapeo transaction code → cuenta PGC / USALI (JSON), feeds esperados
--     y horas (JSON), buzón y carpeta SFTP; única por (property_id, system);
--   · pms_shadow_links — enlace (propiedad, nº de confirmación OPERA) → reserva:
--     hash de la última fila vista, estado destino, última vista y último
--     business date, lote que lo creó y último que lo tocó, racha de cortes en
--     los que faltó (missing_streak), lastModifiedDate de OHIP; única por
--     (property_id, confirmation_no) y por reservation_id; índice (property_id,
--     last_business_date) para la ventana del diff;
--   · pms_shadow_runs — un corte recibido (fichero o llamada OHIP): feed, origen,
--     business date (opcional; el ingest siempre la rellena), nombre y sha256
--     del fichero, estado received | processing | done | partial | failed,
--     lote de reservas y lote de ingresos producidos, contadores (creadas,
--     actualizadas, sin cambios, con transición, omitidas, con error), resumen y
--     alertas (JSON), correlación y autor; única por (property_id, feed,
--     business_date, content_hash): el mismo fichero byte a byte en dos business
--     dates son dos cortes legítimos y el mismo fichero el mismo día es el
--     duplicado (NULL en business_date no colisiona en PostgreSQL);
--   · pms_shadow_revenue_imports — lote de ingresos diarios (un fichero de un
--     business date) → asiento(s) con sourceType pms_shadow_revenue y sus
--     reversos: origen (xml_revenue | findeptcodes_xml | findeptcodes_csv |
--     responsys_trx), hash, estado draft | posted | reversed, líneas por
--     transaction code (JSON), totales DECIMAL(14,2) de ingresos / impuestos /
--     cobros / otros, valores declarados por OPERA para el cuadre (JSON), lote
--     que lo sustituyó, datos del reverso. SIN unicidad por (propiedad, día):
--     reverso + nuevo del mismo día conviven; la regla la impone el servicio;
--   · pms_shadow_alerts — alerta del modo sombra (código de §5.5 + severidad),
--     mensaje en español sin PII, esperado / obtenido (JSON), corte que la emitió,
--     nº de confirmación afectado y resolución (fecha, autor, motivo); índices
--     (property_id, resolved_at, business_date) para «abiertas del día» y
--     (property_id, code, created_at) para el histórico por código.
--   Claves ajenas: pms_shadow_links.reservation_id → reservations (ON DELETE
--   CASCADE: si la reserva desapareciera, el enlace también); pms_shadow_runs
--   .reservation_import_id → reservation_imports y .revenue_import_id →
--   pms_shadow_revenue_imports (ON DELETE SET NULL: el run se conserva);
--   pms_shadow_alerts.run_id → pms_shadow_runs (ON DELETE SET NULL). Sin FK a
--   properties / organizations (misma convención que reservation_imports).
--   Relaciones inversas añadidas SIN columna: Reservation.pmsShadowLink y
--   ReservationImport.shadowRuns.
--
-- Comprobaciones previas en la BD demo local antes de escribir (psql, 2026-09-17):
--   · 10 migraciones aplicadas («Database schema is up to date!»), drift 0,
--     272 tablas en public (271 de modelo + _prisma_migrations) / 32 enums;
--   · Rías Altas (cmrhw9jy40003fyvbuu2ec2w7): 105 reservas (43 confirmed · 9
--     checked_out · 53 cancelled), 30 con referencia IMP-RA-2026-1xx; 4 lotes
--     de importación de reservas;
--   · Faranda (cmrhw9jy30002fyvb6tsdiugt): 25 facturas · 33 envíos VeriFactu ·
--     109 asientos.
-- Esperado tras aplicar: 11 migraciones, drift 0, 276 tablas de modelo / 32 enums,
-- reservas e invariantes fiscales de Faranda intactas.
-- ============================================================================

-- CreateTable
CREATE TABLE "pms_shadow_profiles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "system" TEXT NOT NULL DEFAULT 'opera_cloud',
    "opera_hotel_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mapping_json" JSONB NOT NULL DEFAULT '{}',
    "trx_mapping_json" JSONB NOT NULL DEFAULT '[]',
    "schedule_json" JSONB NOT NULL DEFAULT '{}',
    "inbox_email" TEXT,
    "sftp_folder" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pms_shadow_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pms_shadow_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "confirmation_no" TEXT NOT NULL,
    "opera_reservation_id" TEXT,
    "crs_reference" TEXT,
    "reservation_id" TEXT NOT NULL,
    "row_hash" TEXT NOT NULL,
    "last_status" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "last_business_date" DATE NOT NULL,
    "first_import_id" TEXT NOT NULL,
    "last_import_id" TEXT,
    "missing_streak" INTEGER NOT NULL DEFAULT 0,
    "opera_last_modified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pms_shadow_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pms_shadow_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "business_date" DATE,
    "file_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "reservation_import_id" TEXT,
    "revenue_import_id" TEXT,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "unchanged_count" INTEGER NOT NULL DEFAULT 0,
    "transitioned_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "result_json" JSONB NOT NULL DEFAULT '{}',
    "alerts_json" JSONB NOT NULL DEFAULT '[]',
    "error_message" TEXT,
    "correlation_id" TEXT,
    "created_by" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pms_shadow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pms_shadow_revenue_imports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "file_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lines_json" JSONB NOT NULL DEFAULT '[]',
    "total_revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_payments" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_other" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reversal_journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reconciliation_json" JSONB NOT NULL DEFAULT '{}',
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "replaced_by_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "reversal_reason" TEXT,

    CONSTRAINT "pms_shadow_revenue_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pms_shadow_alerts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "business_date" DATE,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expected_json" JSONB NOT NULL DEFAULT '{}',
    "actual_json" JSONB NOT NULL DEFAULT '{}',
    "run_id" TEXT,
    "confirmation_no" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pms_shadow_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pms_shadow_profiles_organization_id_status_idx" ON "pms_shadow_profiles"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pms_shadow_profiles_property_id_system_key" ON "pms_shadow_profiles"("property_id", "system");

-- CreateIndex
CREATE UNIQUE INDEX "pms_shadow_links_reservation_id_key" ON "pms_shadow_links"("reservation_id");

-- CreateIndex
CREATE INDEX "pms_shadow_links_property_id_last_business_date_idx" ON "pms_shadow_links"("property_id", "last_business_date");

-- CreateIndex
CREATE UNIQUE INDEX "pms_shadow_links_property_id_confirmation_no_key" ON "pms_shadow_links"("property_id", "confirmation_no");

-- CreateIndex
CREATE INDEX "pms_shadow_runs_property_id_business_date_feed_idx" ON "pms_shadow_runs"("property_id", "business_date", "feed");

-- CreateIndex
CREATE INDEX "pms_shadow_runs_property_id_status_created_at_idx" ON "pms_shadow_runs"("property_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pms_shadow_runs_property_id_feed_business_date_content_hash_key" ON "pms_shadow_runs"("property_id", "feed", "business_date", "content_hash");

-- CreateIndex
CREATE INDEX "pms_shadow_revenue_imports_property_id_business_date_status_idx" ON "pms_shadow_revenue_imports"("property_id", "business_date", "status");

-- CreateIndex
CREATE INDEX "pms_shadow_revenue_imports_property_id_content_hash_idx" ON "pms_shadow_revenue_imports"("property_id", "content_hash");

-- CreateIndex
CREATE INDEX "pms_shadow_alerts_property_id_resolved_at_business_date_idx" ON "pms_shadow_alerts"("property_id", "resolved_at", "business_date");

-- CreateIndex
CREATE INDEX "pms_shadow_alerts_property_id_code_created_at_idx" ON "pms_shadow_alerts"("property_id", "code", "created_at");

-- AddForeignKey
ALTER TABLE "pms_shadow_links" ADD CONSTRAINT "pms_shadow_links_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pms_shadow_runs" ADD CONSTRAINT "pms_shadow_runs_reservation_import_id_fkey" FOREIGN KEY ("reservation_import_id") REFERENCES "reservation_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pms_shadow_runs" ADD CONSTRAINT "pms_shadow_runs_revenue_import_id_fkey" FOREIGN KEY ("revenue_import_id") REFERENCES "pms_shadow_revenue_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pms_shadow_alerts" ADD CONSTRAINT "pms_shadow_alerts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "pms_shadow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

