-- ============================================================================
-- 20260916120000_coste_personal_importado · Finanzas / coste de personal importado (Tanda 6c · L0)
-- ============================================================================
-- Generada el 2026-09-16 con:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- y revisada a mano (reviewed by hand). Todo lo que emitió el generador está aquí
-- VERBATIM y no hay nada escrito a mano: ni índice parcial «un lote vivo por hash»
-- (la idempotencia la da pg_advisory_xact_lock por organización dentro de la
-- transacción del servicio) ni funciones ni triggers → db:drift:check sigue en 0.
--
-- Diseño: docs/design/FINANZAS-COSTE-PERSONAL.md §2. Contrato:
-- docs/runbooks/finanzas-contabilidad.md §18. GDPR: las tablas guardan SOLO
-- agregados centro × mes × grupo × departamento; nunca nombres ni datos por persona.
--
-- ADITIVA (ninguna fila existente se reescribe; sin paso de datos):
--   · enum PayrollCostImportStatus (draft · posted · reversed);
--   · payroll_cost_imports — un lote por fichero importado: organización, sociedad
--     opcional, origen (csv | json | informe_rrhh), nombre de fichero, sha256 del
--     contenido normalizado (idempotencia), rango de meses, estado, totales
--     (bruto, SS empresa, coste = bruto + SS, coste_total informativo del informe,
--     media de empleados), mapeo aplicado (JSON), asientos contabilizados y reversos;
--   · payroll_cost_lines — filas AGREGADAS del informe: centro × mes × grupo ×
--     departamento (nunca una persona), con organization_id desnormalizado. La
--     clave natural conserva la etiqueta ORIGINAL del centro porque varias
--     etiquetas del informe van al mismo centro del ERP (OFICINA ASTURIAS /
--     OFICINA MADRID / REG. CORUÑA → OC): (import, etiqueta, mes, grupo,
--     departamento) es única; (import, centro, mes, grupo, departamento) NO;
--   · payroll_cost_references — referencia del informe por centro × mes
--     (empleados, inventario de habitaciones, ventas sin IVA) para los ratios,
--     con organization_id desnormalizado;
--   · journal_lines(cost_center_id) — índice para el lector USALI por centro de
--     coste (L2): hasta hoy solo journal_entry_id y account_code estaban indexados.
--   Claves ajenas: líneas y referencias pertenecen a su lote (ON DELETE CASCADE;
--   un lote contabilizado nunca se borra: se revierte). Sin FK a properties /
--   cost_centers, misma convención que payroll_periods / journal_lines.
--
-- Comprobaciones previas en la BD demo local antes de escribir (psql, 2026-09-16):
--   · 8 migraciones aplicadas («Database schema is up to date!»), drift 0
--     («No difference detected.»), check-migrations-vs-schema 266 tablas / 30 enums;
--   · Faranda (cmrhw9jy30002fyvb6tsdiugt): 61 journal_entries / 150 journal_lines;
--     0 cost_centers en toda la BD (los centros de coste USALI los crea el
--     servicio al contabilizar);
--   · 4 funciones / 4 triggers en public, que esta migración no toca (Prisma no
--     declara funciones ni triggers).
-- Esperado tras aplicar: 9 migraciones, drift 0, 269 tablas / 31 enums, los 61
-- asientos de Faranda intactos.
-- ============================================================================

-- CreateEnum
CREATE TYPE "PayrollCostImportStatus" AS ENUM ('draft', 'posted', 'reversed');

-- CreateTable
CREATE TABLE "payroll_cost_imports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "source" TEXT NOT NULL,
    "file_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "period_from" TEXT NOT NULL,
    "period_to" TEXT NOT NULL,
    "status" "PayrollCostImportStatus" NOT NULL DEFAULT 'draft',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "total_gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_employer_ss" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reported_total_cost" DECIMAL(14,2),
    "headcount_average" DECIMAL(8,2),
    "mapping_json" JSONB NOT NULL DEFAULT '{}',
    "journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reversal_journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "reversal_reason" TEXT,

    CONSTRAINT "payroll_cost_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_cost_lines" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "work_center_label" TEXT NOT NULL,
    "cost_group" TEXT NOT NULL,
    "department_label" TEXT NOT NULL,
    "usali_department" TEXT NOT NULL,
    "cost_center_id" TEXT,
    "period_code" TEXT NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "employer_ss" DECIMAL(14,2) NOT NULL,
    "total_cost" DECIMAL(14,2) NOT NULL,
    "reported_total_cost" DECIMAL(14,2),
    "headcount" DECIMAL(8,2) NOT NULL DEFAULT 0,

    CONSTRAINT "payroll_cost_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_cost_references" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "work_center_label" TEXT,
    "period_code" TEXT NOT NULL,
    "employees_reported" DECIMAL(8,2),
    "rooms_available_reported" INTEGER,
    "net_sales_reported" DECIMAL(14,2),

    CONSTRAINT "payroll_cost_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_cost_imports_organization_id_status_period_from_per_idx" ON "payroll_cost_imports"("organization_id", "status", "period_from", "period_to");

-- CreateIndex
CREATE INDEX "payroll_cost_imports_organization_id_content_hash_idx" ON "payroll_cost_imports"("organization_id", "content_hash");

-- CreateIndex
CREATE INDEX "payroll_cost_lines_import_id_property_id_period_code_idx" ON "payroll_cost_lines"("import_id", "property_id", "period_code");

-- CreateIndex
CREATE INDEX "payroll_cost_lines_property_id_period_code_idx" ON "payroll_cost_lines"("property_id", "period_code");

-- CreateIndex
CREATE INDEX "payroll_cost_lines_organization_id_period_code_idx" ON "payroll_cost_lines"("organization_id", "period_code");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_cost_lines_import_id_work_center_label_period_code__key" ON "payroll_cost_lines"("import_id", "work_center_label", "period_code", "cost_group", "department_label");

-- CreateIndex
CREATE INDEX "payroll_cost_references_property_id_period_code_idx" ON "payroll_cost_references"("property_id", "period_code");

-- CreateIndex
CREATE INDEX "payroll_cost_references_organization_id_period_code_idx" ON "payroll_cost_references"("organization_id", "period_code");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_cost_references_import_id_property_id_period_code_key" ON "payroll_cost_references"("import_id", "property_id", "period_code");

-- CreateIndex
CREATE INDEX "journal_lines_cost_center_id_idx" ON "journal_lines"("cost_center_id");

-- AddForeignKey
ALTER TABLE "payroll_cost_lines" ADD CONSTRAINT "payroll_cost_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "payroll_cost_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_cost_references" ADD CONSTRAINT "payroll_cost_references_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "payroll_cost_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

