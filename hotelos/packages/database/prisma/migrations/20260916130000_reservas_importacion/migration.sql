-- ============================================================================
-- 20260916130000_reservas_importacion · PMS / importación masiva de reservas (Tanda 7 · L0)
-- ============================================================================
-- Generada el 2026-09-16 con:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- y revisada a mano. Todo lo que emitió el generador está aquí VERBATIM y no hay
-- nada escrito a mano (ni índices parciales ni funciones ni triggers): la
-- idempotencia por hash la da el servicio (pg_advisory_xact_lock por propiedad
-- dentro de su transacción) → db:drift:check sigue en 0.
--
-- Diseño: docs/design/RESERVAS-IMPORTACION-MASIVA.md §4. Contrato:
-- docs/runbooks/reservas-importacion.md. GDPR: el fichero NO se guarda; la fila
-- del lote registra SOLO nº de fila, referencia externa, fechas/tipo/tarifa
-- resueltos, código de reserva creado o código de error (nunca nombre, e-mail,
-- teléfono ni documento del huésped).
--
-- ADITIVA (ninguna fila existente se reescribe; sin paso de datos):
--   · enum ReservationImportStatus (processing · imported · partial · failed ·
--     undone): el lote nace `processing` ANTES de la primera reserva y cierra en
--     imported | partial | failed; `undone` tras deshacer. Un lote que se quedó
--     en `processing` («Interrumpida») se deshace igual: el deshacer busca las
--     reservas por booking_source = 'import:<id>', no por las filas guardadas;
--   · reservation_imports — un lote por fichero importado en UNA propiedad:
--     organización y propiedad (desnormalizadas, sin FK como PayrollCostLine),
--     formato (csv | xlsx), nombre de fichero, sha256 de las filas normalizadas
--     (idempotencia: 409 RESERVATION_IMPORT_DUPLICATE salvo `force`), estado
--     (DEFAULT 'processing'), contadores (filas, creadas, omitidas, con error,
--     avisos), mapeo y opciones aplicados (JSON), rango de llegadas e importe
--     total informativos, autor, y datos del deshacer (fecha, autor, motivo,
--     canceladas / conservadas);
--   · reservation_import_rows — resultado por fila SIN datos personales:
--     (import, nº de fila) única; reservation_id único (una reserva procede como
--     máximo de una fila); índice (propiedad, referencia externa) para el aviso
--     «ya existe» y (import, outcome) para los filtros de la pantalla de
--     resultado; undo_outcome cancelled · kept · skipped tras deshacer.
--   Clave ajena: las filas pertenecen a su lote (ON DELETE CASCADE; un lote
--   importado nunca se borra: se deshace). Sin FK a properties / reservations.
--
-- Comprobaciones previas en la BD demo local antes de escribir (psql, 2026-09-16):
--   · 9 migraciones aplicadas («Database schema is up to date!»), drift 0,
--     check-migrations-vs-schema 269 tablas / 31 enums;
--   · Rías Altas (cmrhw9jy40003fyvbuu2ec2w7): 35 reservas (14 confirmed · 12
--     cancelled · 9 checked_out), 120 habitaciones en 5 tipos, 3 planes de tarifa;
--   · Faranda (cmrhw9jy30002fyvb6tsdiugt): 25 facturas · 33 envíos VeriFactu ·
--     109 asientos · 1 lote de nómina.
-- Esperado tras aplicar: 10 migraciones, drift 0, 271 tablas / 32 enums, reservas
-- e invariantes fiscales de Faranda intactas.
-- ============================================================================

-- CreateEnum
CREATE TYPE "ReservationImportStatus" AS ENUM ('processing', 'imported', 'partial', 'failed', 'undone');

-- CreateTable
CREATE TABLE "reservation_imports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "file_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "status" "ReservationImportStatus" NOT NULL DEFAULT 'processing',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "mapping_json" JSONB NOT NULL DEFAULT '{}',
    "options_json" JSONB NOT NULL DEFAULT '{}',
    "arrival_from" DATE,
    "arrival_to" DATE,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMP(3),
    "undone_by" TEXT,
    "undo_reason" TEXT,
    "undone_count" INTEGER NOT NULL DEFAULT 0,
    "undo_kept_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "reservation_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_import_rows" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "external_reference" TEXT,
    "arrival_date" DATE,
    "departure_date" DATE,
    "room_type_code" TEXT,
    "rate_plan_code" TEXT,
    "rooms_count" INTEGER NOT NULL DEFAULT 1,
    "reservation_id" TEXT,
    "reservation_code" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "undo_outcome" TEXT,

    CONSTRAINT "reservation_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservation_imports_property_id_status_created_at_idx" ON "reservation_imports"("property_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "reservation_imports_property_id_content_hash_idx" ON "reservation_imports"("property_id", "content_hash");

-- CreateIndex
CREATE INDEX "reservation_imports_organization_id_created_at_idx" ON "reservation_imports"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_import_rows_reservation_id_key" ON "reservation_import_rows"("reservation_id");

-- CreateIndex
CREATE INDEX "reservation_import_rows_import_id_outcome_idx" ON "reservation_import_rows"("import_id", "outcome");

-- CreateIndex
CREATE INDEX "reservation_import_rows_property_id_external_reference_idx" ON "reservation_import_rows"("property_id", "external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_import_rows_import_id_row_number_key" ON "reservation_import_rows"("import_id", "row_number");

-- AddForeignKey
ALTER TABLE "reservation_import_rows" ADD CONSTRAINT "reservation_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "reservation_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

