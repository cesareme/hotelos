-- ============================================================================
-- 20260917110000_sage200_importacion · Importación contable desde Sage 200 (Tanda 7c · L0)
-- ============================================================================
-- Generada el 2026-09-17 con:
--   cd packages/database && corepack pnpm exec prisma migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- y revisada a mano. Todo lo que emitió el generador está aquí VERBATIM y no hay
-- nada escrito a mano (ni índices parciales ni funciones ni triggers ni pasos de
-- datos): la regla «un lote no revertido por hash de contenido», el reparto de
-- líneas por centro y la exclusión de documentos nativos los impone el servicio
-- de L2 bajo pg_advisory_xact_lock → db:drift:check sigue en 0.
--
-- Diseño: docs/design/FINANZAS-IMPORTACION-SAGE200.md §4.2 (modelo de datos),
-- §4.6 (sourceType, idempotencia, numeración, reverso), §5.2 (reconciliación) y
-- §6 (saldos sin diario). Catálogos de los estados y acciones (texto; el único
-- enum nuevo es LedgerImportStatus): packages/shared/src/ledger-import-types.ts.
--
-- ADITIVA (ninguna tabla ni columna existente se toca: journal_entries y
-- journal_lines NO ganan columnas —bloques pinados por
-- tests/finanzas-schema-contract.test.mjs— y vat_book_entries conserva su
-- unicidad (organization_id, book, source_type, source_id, rate); sin paso de datos):
--   · ALTER TYPE "VatBookSourceType" ADD VALUE — el enum gana el valor sage200
--     (filas de los libros de IVA importadas desde Sage; rebuildVatBooks las
--     conserva, cambio de L2). Es el PRIMER ADD VALUE de la cadena de migraciones:
--     PostgreSQL ≥ 12 lo admite dentro de la transacción de migrate deploy siempre
--     que el valor nuevo NO se use en la misma transacción (error 55P04 si se
--     usara), por eso esta migración es DDL puro y ese literal aparece UNA sola
--     vez, en el ADD VALUE (tests/sage200-schema-contract.test.mjs lo pina).
--     Ninguna columna lleva DEFAULT con ese valor: la columna `system` de
--     ledger_imports / ledger_account_maps / ledger_analytics_maps /
--     ledger_third_parties la escribe siempre el servicio (LEDGER_IMPORT_SYSTEMS);
--   · CREATE TYPE "LedgerImportStatus" (draft | posted | reversed), gemelo de
--     PayrollCostImportStatus;
--   · ledger_imports — lote (un fichero de un tipo: plan | fiscal_years | journal |
--     vat_books | third_parties | balances; formato sage_excel | sage_ime_csv |
--     sage_xml | canonical_csv | canonical_json): sociedad, sha256 de las filas
--     normalizadas, empresa Sage, ejercicio, rango de meses (period_from /
--     period_to "YYYY-MM"), estado, contadores, mapeo aplicado y avisos (JSON),
--     totales DECIMAL(14,2), asientos y reversos (ids), lote que lo sustituyó,
--     notas, autor y datos del reverso; índices (organization_id, kind, status,
--     period_from, period_to) para solapes e historial y (organization_id,
--     content_hash) para el duplicado;
--   · ledger_import_entries — un asiento Sage por (asiento, centro) dentro del
--     lote: clave Sage (empresa, ejercicio, periodo, asiento, canal), fecha,
--     centro (property_code "SOC" a nivel sociedad: la unicidad no puede apoyarse
--     en un property_id NULL), asiento Anfitorio producido, estado (draft | posted
--     | skipped_native | skipped_existing | unmapped | unbalanced | error), tipo
--     (normal | opening | regularization | closing), nº de líneas, debe / haber,
--     asiento nativo con el que colisiona y avisos; única por (import_id,
--     source_company_code, source_fiscal_year, source_period, source_entry_number,
--     property_code); índices (organization_id, source_fiscal_year,
--     source_entry_number) y (journal_entry_id);
--   · ledger_import_balances — fila del sumas y saldos de Sage (nivel 0) por
--     ejercicio × periodo ("YYYY-MM" | "YYYY-Qn" | "YYYY" | "apertura") × centro
--     ("SOC" si sociedad) × cuenta Sage, con la cuenta PGC mapeada y sumas de
--     apertura / periodo / saldo DECIMAL(14,2); única por (import_id, period_code,
--     property_code, source_account); índice (organization_id, fiscal_year_code,
--     period_code);
--   · ledger_account_maps — mapa de cuentas Sage → PGC por (organización,
--     sistema, cuenta Sage): acción (map | map_by_rate | create | collapse |
--     block), cuenta destino (NULL solo en block), USALI de la subcuenta nueva,
--     carry_counterparty y autor; única por (organization_id, system,
--     source_account);
--   · ledger_analytics_maps — mapa analítico por (organización, sistema,
--     dimensión canal | delegacion | departamento | seccion | proyecto, código):
--     centro de trabajo y/o centro de coste USALI; única por (organization_id,
--     system, dimension, source_code);
--   · ledger_third_parties — tercero contable de Sage por (organización,
--     sistema, rol customer | supplier, código): subcuenta Sage, NIF normalizado,
--     país, razón social y Supplier enlazado; única por (organization_id, system,
--     role, source_code); índice (organization_id, tax_id) para el 347;
--   · ledger_reconciliations — ejecución de la reconciliación (balance Sage del
--     rango frente al diario de Anfitorio): lote que la lanzó, rango de fechas,
--     centro, sha256 del balance, estado ok | differences | error, cuentas
--     comparadas, nº de diferencias, filas y resumen (JSON), autor; índice
--     (organization_id, period_from, period_to, created_at).
--   Claves ajenas: ledger_import_entries.import_id y ledger_import_balances
--   .import_id → ledger_imports (ON DELETE CASCADE: el lote arrastra su detalle).
--   Sin FK a properties / suppliers / journal_entries / organizations (misma
--   convención que payroll_cost_imports y pms_shadow_revenue_imports).
--
-- Comprobaciones previas en la BD demo local antes de escribir (psql, 2026-09-17):
--   · 11 migraciones aplicadas («Database schema is up to date!»), drift 0,
--     277 tablas en public (276 de modelo + _prisma_migrations) / 32 enums,
--     VatBookSourceType con 5 valores;
--   · Faranda (cmrhw9jy30002fyvb6tsdiugt): 112 asientos / 599 líneas (61 previos
--     + 48 nómina + 3 OPERA), 25 facturas · 33 envíos VeriFactu · 1 lote de
--     nómina · 22 secuencias de factura;
--   · 0 fiscal_years, 0 vat_book_entries, 0 suppliers en toda la BD.
-- Esperado tras aplicar: 12 migraciones, drift 0, 283 tablas de modelo / 33 enums,
-- VatBookSourceType con 6 valores, asientos e invariantes de Faranda intactos
-- (solo DDL: ninguna fila cambia).
-- ============================================================================

-- CreateEnum
CREATE TYPE "LedgerImportStatus" AS ENUM ('draft', 'posted', 'reversed');

-- AlterEnum
ALTER TYPE "VatBookSourceType" ADD VALUE 'sage200';

-- CreateTable
CREATE TABLE "ledger_imports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "system" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "file_name" TEXT,
    "content_hash" TEXT NOT NULL,
    "source_company_code" TEXT,
    "fiscal_year_code" TEXT,
    "period_from" TEXT,
    "period_to" TEXT,
    "status" "LedgerImportStatus" NOT NULL DEFAULT 'draft',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "mapping_json" JSONB NOT NULL DEFAULT '{}',
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "total_debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reversal_journal_entry_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "replaced_by_id" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "reversed_by" TEXT,
    "reversal_reason" TEXT,

    CONSTRAINT "ledger_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_import_entries" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "source_company_code" TEXT NOT NULL,
    "source_fiscal_year" TEXT NOT NULL,
    "source_period" TEXT NOT NULL,
    "source_entry_number" TEXT NOT NULL,
    "source_channel" TEXT,
    "entry_date" DATE NOT NULL,
    "property_id" TEXT,
    "property_code" TEXT NOT NULL,
    "journal_entry_id" TEXT,
    "status" TEXT NOT NULL,
    "entry_kind" TEXT NOT NULL DEFAULT 'normal',
    "line_count" INTEGER NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL,
    "credit" DECIMAL(14,2) NOT NULL,
    "source_type" TEXT,
    "source_id" TEXT,
    "warnings_json" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ledger_import_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_import_balances" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "fiscal_year_code" TEXT NOT NULL,
    "period_code" TEXT NOT NULL,
    "property_id" TEXT,
    "property_code" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "source_name" TEXT,
    "account_code" TEXT NOT NULL,
    "opening_debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "opening_credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "period_debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "period_credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closing_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ledger_import_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_account_maps" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "source_name" TEXT,
    "action" TEXT NOT NULL,
    "account_code" TEXT,
    "usali_department" TEXT,
    "usali_line" TEXT,
    "carry_counterparty" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_account_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_analytics_maps" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "source_code" TEXT NOT NULL,
    "source_name" TEXT,
    "property_id" TEXT,
    "cost_centre_code" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_analytics_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_third_parties" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "source_code" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source_account" TEXT,
    "tax_id" TEXT,
    "country_code" TEXT NOT NULL DEFAULT 'ES',
    "name" TEXT NOT NULL,
    "supplier_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_third_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_reconciliations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "import_id" TEXT,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "property_id" TEXT,
    "source_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "accounts_compared" INTEGER NOT NULL,
    "difference_count" INTEGER NOT NULL,
    "rows_json" JSONB NOT NULL DEFAULT '[]',
    "summary_json" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_imports_organization_id_kind_status_period_from_peri_idx" ON "ledger_imports"("organization_id", "kind", "status", "period_from", "period_to");

-- CreateIndex
CREATE INDEX "ledger_imports_organization_id_content_hash_idx" ON "ledger_imports"("organization_id", "content_hash");

-- CreateIndex
CREATE INDEX "ledger_import_entries_organization_id_source_fiscal_year_so_idx" ON "ledger_import_entries"("organization_id", "source_fiscal_year", "source_entry_number");

-- CreateIndex
CREATE INDEX "ledger_import_entries_journal_entry_id_idx" ON "ledger_import_entries"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_import_entries_import_id_source_company_code_source__key" ON "ledger_import_entries"("import_id", "source_company_code", "source_fiscal_year", "source_period", "source_entry_number", "property_code");

-- CreateIndex
CREATE INDEX "ledger_import_balances_organization_id_fiscal_year_code_per_idx" ON "ledger_import_balances"("organization_id", "fiscal_year_code", "period_code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_import_balances_import_id_period_code_property_code__key" ON "ledger_import_balances"("import_id", "period_code", "property_code", "source_account");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_maps_organization_id_system_source_account_key" ON "ledger_account_maps"("organization_id", "system", "source_account");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_analytics_maps_organization_id_system_dimension_sour_key" ON "ledger_analytics_maps"("organization_id", "system", "dimension", "source_code");

-- CreateIndex
CREATE INDEX "ledger_third_parties_organization_id_tax_id_idx" ON "ledger_third_parties"("organization_id", "tax_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_third_parties_organization_id_system_role_source_cod_key" ON "ledger_third_parties"("organization_id", "system", "role", "source_code");

-- CreateIndex
CREATE INDEX "ledger_reconciliations_organization_id_period_from_period_t_idx" ON "ledger_reconciliations"("organization_id", "period_from", "period_to", "created_at");

-- AddForeignKey
ALTER TABLE "ledger_import_entries" ADD CONSTRAINT "ledger_import_entries_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "ledger_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_import_balances" ADD CONSTRAINT "ledger_import_balances_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "ledger_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

