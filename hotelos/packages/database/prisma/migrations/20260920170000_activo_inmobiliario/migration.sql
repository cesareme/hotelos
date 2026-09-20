-- ============================================================================
-- 20260920170000_activo_inmobiliario · Gestión del activo inmobiliario (Tanda ACT · L0b)
-- ============================================================================
-- Generada y aplicada en local el 2026-09-20 sobre la BD del carril (hotelos_act, copia de la
-- viva con las 24 migraciones anteriores aplicadas y «No difference detected.») con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
-- Lo que emitió el generador está VERBATIM debajo de esta cabecera (sin ediciones a mano):
-- 1 ALTER TABLE "capex_projects" con 12 ADD COLUMN (obra: activo, tipo, licencia, ICIO,
-- documentos de proyecto/final de obra, prefijos de cuenta de ejecución, ejecutado según diario,
-- capitalización), 10 CREATE TABLE (real_estate_assets, real_estate_units, real_estate_charges,
-- real_estate_valuations, real_estate_tenures, property_taxes, property_tax_receipts,
-- real_estate_documents, real_estate_inspections, real_estate_insurances), 12 CREATE INDEX +
-- 4 CREATE UNIQUE INDEX y 9 ADD FOREIGN KEY internos (todos ON DELETE CASCADE:
-- units/valuations/tenures/taxes/documents/inspections/insurances → real_estate_assets,
-- charges → real_estate_units, receipts → property_taxes). 0 CREATE TYPE: los catálogos son
-- String documentados con `///` en schema.prisma (finanzas-schema-contract pina los enums de
-- finanzas y migrations-squash-contract exige CREATE TYPE = enums). Sin FK a properties ni
-- organizations (solo ids, como capex_projects). 0 DROP, 0 backfill, 0 DO $$: aditiva, no toca
-- ninguna fila existente.
--
-- Rollback (reversible; hijos antes que padres para respetar las FK):
--   DROP TABLE "real_estate_charges";
--   DROP TABLE "property_tax_receipts";
--   DROP TABLE "real_estate_units";
--   DROP TABLE "real_estate_valuations";
--   DROP TABLE "real_estate_tenures";
--   DROP TABLE "property_taxes";
--   DROP TABLE "real_estate_documents";
--   DROP TABLE "real_estate_inspections";
--   DROP TABLE "real_estate_insurances";
--   DROP TABLE "real_estate_assets";
--   DROP INDEX "capex_projects_real_estate_asset_id_status_idx";
--   ALTER TABLE "capex_projects"
--     DROP COLUMN "capitalized_at", DROP COLUMN "capitalized_fixed_asset_id",
--     DROP COLUMN "completion_document_id", DROP COLUMN "executed_amount_ledger",
--     DROP COLUMN "execution_account_prefixes", DROP COLUMN "icio_amount",
--     DROP COLUMN "licence_document_id", DROP COLUMN "licence_granted_at",
--     DROP COLUMN "licence_required", DROP COLUMN "project_document_id",
--     DROP COLUMN "real_estate_asset_id", DROP COLUMN "work_kind";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260920170000_activo_inmobiliario';
-- ============================================================================

-- AlterTable
ALTER TABLE "capex_projects" ADD COLUMN     "capitalized_at" DATE,
ADD COLUMN     "capitalized_fixed_asset_id" TEXT,
ADD COLUMN     "completion_document_id" TEXT,
ADD COLUMN     "executed_amount_ledger" DECIMAL(14,2),
ADD COLUMN     "execution_account_prefixes" TEXT,
ADD COLUMN     "icio_amount" DECIMAL(14,2),
ADD COLUMN     "licence_document_id" TEXT,
ADD COLUMN     "licence_granted_at" DATE,
ADD COLUMN     "licence_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "project_document_id" TEXT,
ADD COLUMN     "real_estate_asset_id" TEXT,
ADD COLUMN     "work_kind" TEXT;

-- CreateTable
CREATE TABLE "real_estate_assets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year_built" INTEGER,
    "year_last_refurbished" INTEGER,
    "built_surface_m2" DECIMAL(12,2),
    "plot_surface_m2" DECIMAL(12,2),
    "floors_above" INTEGER,
    "floors_below" INTEGER,
    "rooms_count" INTEGER,
    "protection_level" TEXT NOT NULL DEFAULT 'none',
    "energy_rating" TEXT,
    "energy_cert_valid_until" DATE,
    "cadastral_value_total" DECIMAL(14,2),
    "cadastral_value_year" INTEGER,
    "reference_value" DECIMAL(14,2),
    "last_valuation_value" DECIMAL(14,2),
    "last_valuation_at" DATE,
    "current_tenure_kind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_units" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'finca_registral',
    "registry_office" TEXT,
    "registry_finca_number" TEXT,
    "registry_tomo" TEXT,
    "registry_libro" TEXT,
    "registry_folio" TEXT,
    "cru" TEXT,
    "cadastral_reference" TEXT,
    "use_code" TEXT,
    "surface_m2" DECIMAL(12,2),
    "cadastral_value_land" DECIMAL(14,2),
    "cadastral_value_building" DECIMAL(14,2),
    "title_kind" TEXT NOT NULL DEFAULT 'pleno_dominio',
    "title_holder_tax_id" TEXT,
    "title_holder_name" TEXT,
    "title_deed_date" DATE,
    "notary" TEXT,
    "fixed_asset_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_charges" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "holder_name" TEXT,
    "holder_tax_id" TEXT,
    "amount" DECIMAL(14,2),
    "outstanding_amount" DECIMAL(14,2),
    "registered_at" DATE,
    "expires_at" DATE,
    "cancelled_at" DATE,
    "document_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_valuations" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "purpose" TEXT,
    "valued_at" DATE NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "value_per_room" DECIMAL(14,2),
    "cap_rate_pct" DECIMAL(6,2),
    "method" TEXT,
    "appraiser" TEXT,
    "document_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_tenures" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "counterparty_name" TEXT,
    "counterparty_tax_id" TEXT,
    "counterparty_non_resident" BOOLEAN NOT NULL DEFAULT false,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "notice_months" INTEGER,
    "renewal" TEXT NOT NULL DEFAULT 'tacita',
    "rent_kind" TEXT,
    "rent_monthly" DECIMAL(14,2),
    "rent_variable_pct" DECIMAL(6,2),
    "rent_variable_base" TEXT,
    "rent_review_index" TEXT,
    "rent_review_month" INTEGER,
    "deposit_amount" DECIMAL(14,2),
    "vat_applies" BOOLEAN NOT NULL DEFAULT true,
    "withholding_applies" BOOLEAN NOT NULL DEFAULT false,
    "withholding_rate_pct" DECIMAL(6,2),
    "ibi_payer" TEXT NOT NULL DEFAULT 'propietario',
    "insurance_payer" TEXT NOT NULL DEFAULT 'propietario',
    "capex_responsibility" TEXT NOT NULL DEFAULT 'propietario',
    "ffe_reserve_pct" DECIMAL(6,2),
    "brand_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'borrador',
    "document_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_tenures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_taxes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "kind" TEXT NOT NULL,
    "taxpayer" TEXT NOT NULL DEFAULT 'sociedad',
    "authority_name" TEXT NOT NULL,
    "ine_municipality_code" TEXT,
    "fiscal_reference" TEXT,
    "tax_base" DECIMAL(14,2),
    "rate_pct" DECIMAL(8,4),
    "expected_annual_amount" DECIMAL(14,2),
    "periodicity" TEXT NOT NULL DEFAULT 'anual',
    "voluntary_from" TEXT,
    "voluntary_to" TEXT,
    "direct_debit" BOOLEAN NOT NULL DEFAULT false,
    "direct_debit_bonus_pct" DECIMAL(6,2),
    "installments_json" JSONB,
    "account_code" TEXT NOT NULL DEFAULT '631',
    "capitalizable" BOOLEAN NOT NULL DEFAULT false,
    "legal_basis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'activo',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_tax_receipts" (
    "id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'anual',
    "issued_at" DATE,
    "due_from" DATE,
    "due_to" DATE,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "surcharge_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'previsto',
    "paid_at" DATE,
    "paid_with" TEXT,
    "journal_entry_id" TEXT,
    "capex_project_id" TEXT,
    "document_id" TEXT,
    "appeal_ref" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_tax_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer_name" TEXT,
    "issue_date" DATE,
    "valid_from" DATE,
    "valid_until" DATE,
    "renewal_days" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" TEXT,
    "superseded_by_id" TEXT,
    "cde_state" TEXT NOT NULL DEFAULT 'publicado',
    "confidentiality" TEXT NOT NULL DEFAULT 'interno',
    "linked_entity_type" TEXT,
    "linked_entity_id" TEXT,
    "compliance_requirement_code" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "storage_kind" TEXT NOT NULL DEFAULT 'inline',
    "storage_key" TEXT,
    "inline" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by" TEXT,
    "retention_until" DATE,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_inspections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "legal_basis" TEXT,
    "periodicity_months" INTEGER,
    "installation_ref" TEXT,
    "technical_asset_id" TEXT,
    "provider_name" TEXT,
    "supplier_id" TEXT,
    "scheduled_at" DATE,
    "performed_at" DATE,
    "result" TEXT,
    "defects_json" JSONB,
    "correction_due_at" DATE,
    "corrected_at" DATE,
    "next_due_at" DATE,
    "document_id" TEXT,
    "compliance_requirement_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'programada',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_insurances" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "insurer_name" TEXT NOT NULL,
    "policy_number" TEXT NOT NULL,
    "broker_name" TEXT,
    "policyholder" TEXT NOT NULL DEFAULT 'sociedad',
    "insured_sum" DECIMAL(14,2),
    "deductible" DECIMAL(14,2),
    "premium_annual" DECIMAL(14,2),
    "valid_from" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "auto_renew" BOOLEAN NOT NULL DEFAULT true,
    "notice_days" INTEGER NOT NULL DEFAULT 60,
    "mandatory_basis" TEXT,
    "document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'vigente',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "real_estate_insurances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "real_estate_assets_organization_id_status_idx" ON "real_estate_assets"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "real_estate_assets_property_id_key" ON "real_estate_assets"("property_id");

-- CreateIndex
CREATE INDEX "real_estate_units_asset_id_idx" ON "real_estate_units"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "real_estate_units_organization_id_cadastral_reference_key" ON "real_estate_units"("organization_id", "cadastral_reference");

-- CreateIndex
CREATE INDEX "real_estate_charges_unit_id_cancelled_at_idx" ON "real_estate_charges"("unit_id", "cancelled_at");

-- CreateIndex
CREATE INDEX "real_estate_valuations_asset_id_valued_at_idx" ON "real_estate_valuations"("asset_id", "valued_at");

-- CreateIndex
CREATE INDEX "real_estate_tenures_asset_id_status_idx" ON "real_estate_tenures"("asset_id", "status");

-- CreateIndex
CREATE INDEX "property_taxes_property_id_kind_status_idx" ON "property_taxes"("property_id", "kind", "status");

-- CreateIndex
CREATE INDEX "property_tax_receipts_journal_entry_id_idx" ON "property_tax_receipts"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_tax_receipts_tax_id_fiscal_year_period_key" ON "property_tax_receipts"("tax_id", "fiscal_year", "period");

-- CreateIndex
CREATE UNIQUE INDEX "real_estate_documents_storage_key_key" ON "real_estate_documents"("storage_key");

-- CreateIndex
CREATE INDEX "real_estate_documents_asset_id_category_valid_until_idx" ON "real_estate_documents"("asset_id", "category", "valid_until");

-- CreateIndex
CREATE INDEX "real_estate_documents_property_id_deleted_at_idx" ON "real_estate_documents"("property_id", "deleted_at");

-- CreateIndex
CREATE INDEX "real_estate_inspections_asset_id_kind_next_due_at_idx" ON "real_estate_inspections"("asset_id", "kind", "next_due_at");

-- CreateIndex
CREATE INDEX "real_estate_insurances_asset_id_valid_until_idx" ON "real_estate_insurances"("asset_id", "valid_until");

-- CreateIndex
CREATE INDEX "capex_projects_real_estate_asset_id_status_idx" ON "capex_projects"("real_estate_asset_id", "status");

-- AddForeignKey
ALTER TABLE "real_estate_units" ADD CONSTRAINT "real_estate_units_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_charges" ADD CONSTRAINT "real_estate_charges_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "real_estate_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_valuations" ADD CONSTRAINT "real_estate_valuations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_tenures" ADD CONSTRAINT "real_estate_tenures_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_taxes" ADD CONSTRAINT "property_taxes_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_tax_receipts" ADD CONSTRAINT "property_tax_receipts_tax_id_fkey" FOREIGN KEY ("tax_id") REFERENCES "property_taxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_documents" ADD CONSTRAINT "real_estate_documents_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_inspections" ADD CONSTRAINT "real_estate_inspections_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_insurances" ADD CONSTRAINT "real_estate_insurances_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "real_estate_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

