-- ============================================================================
-- 20260916100000_estructura_societaria · Finanzas / estructura societaria (Tanda 6b · L1, paso 1)
-- ============================================================================
-- Generated on 2026-09-16 with:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- then reviewed by hand. Everything the generator emitted is here verbatim; the
-- only additions are the two immutability triggers at the end (Prisma cannot
-- declare triggers; `migrate diff --from-schema-datasource` ignores functions and
-- triggers, so the drift check stays at 0 — verified on a probe database).
--
-- Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.1 / §5.5. Contract:
-- docs/runbooks/finanzas-contabilidad.md §17.
--
-- Step 1 (this file) is ADDITIVE and NULLABLE: nothing existing is rewritten.
--   · enums PropertyKind, LegalForm, PgcVariant, VerifactuChainScope,
--     LegalEntityStatus, VerifactuRoute;
--   · tables legal_entities (sociedad = NIF) and verifactu_installations
--     (one chain per (obligado; instalación));
--   · properties: legal_entity_id (FK, nullable until L2 makes every writer set
--     it), kind (default 'hotel'), code, trade_name and the census columns;
--   · invoice_sequences.legal_entity_id, invoices.legal_entity_id /
--     installation_id, verifactu_submissions.installation_id,
--     bank_accounts.legal_entity_id (all nullable, backfilled by
--     apps/api/src/scripts/backfill-legal-structure.ts);
--   · triggers (hand-written):
--       verifactu_installations_numero_inmutable — numero_instalacion (and the
--         owning legal entity) of an installation never change: a scope change
--         retires the row and opens a new number (Orden HAC/1177/2024 7.c; the
--         number "no puede repetirse nunca");
--       invoices_issuer_inmutable — issuer_tax_id / issuer_legal_name of an
--         invoice that is no longer a draft are never rewritten once set
--         (RD 1619/2012 6.1.c-d; a fiscal correction is a rectificativa). A
--         NULL snapshot may still be FILLED (legacy rows: backfillInvoiceIssuerSnapshots).
--
-- Step 2 (20260916101000_estructura_societaria_harden) adds the constraints
-- that need a clean data report first. Nothing here needs a data step.
--
-- Pre-checks run on the local demo DB before writing (psql, 2026-09-16):
--   · 2 organizations, 4 properties, 8 invoice_sequences (all with prefix),
--     33 invoices, 0 bank_accounts, 41 verifactu_submissions;
--   · 0 functions / 0 triggers in public before this migration.
-- ============================================================================

-- CreateEnum
CREATE TYPE "PropertyKind" AS ENUM ('hotel', 'office', 'other');

-- CreateEnum
CREATE TYPE "LegalForm" AS ENUM ('sa', 'sl', 'slu', 'coop', 'persona_fisica', 'otra');

-- CreateEnum
CREATE TYPE "PgcVariant" AS ENUM ('pymes', 'general');

-- CreateEnum
CREATE TYPE "VerifactuChainScope" AS ENUM ('per_center', 'per_entity');

-- CreateEnum
CREATE TYPE "LegalEntityStatus" AS ENUM ('active', 'dormant');

-- CreateEnum
CREATE TYPE "VerifactuRoute" AS ENUM ('verifactu', 'tbai', 'igic');

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "legal_entity_id" TEXT;

-- AlterTable
ALTER TABLE "invoice_sequences" ADD COLUMN     "legal_entity_id" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "installation_id" TEXT,
ADD COLUMN     "legal_entity_id" TEXT;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "bed_capacity" INTEGER,
ADD COLUMN     "cadastral_reference" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "iae_epigraph" TEXT,
ADD COLUMN     "kind" "PropertyKind" NOT NULL DEFAULT 'hotel',
ADD COLUMN     "labor_center_code" TEXT,
ADD COLUMN     "legal_entity_id" TEXT,
ADD COLUMN     "opening_months" INTEGER,
ADD COLUMN     "ses_establishment_code" TEXT,
ADD COLUMN     "social_security_ccc" TEXT,
ADD COLUMN     "star_rating" INTEGER,
ADD COLUMN     "surface_m2" DECIMAL(10,2),
ADD COLUMN     "tourism_registry_number" TEXT,
ADD COLUMN     "trade_name" TEXT;

-- AlterTable
ALTER TABLE "verifactu_submissions" ADD COLUMN     "installation_id" TEXT;

-- CreateTable
CREATE TABLE "legal_entities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT,
    "legal_form" "LegalForm",
    "fiscal_address" TEXT,
    "fiscal_postal_code" TEXT,
    "fiscal_municipality" TEXT,
    "fiscal_ine_code" TEXT,
    "fiscal_province" TEXT,
    "registered_office_address" TEXT,
    "registered_office_postal_code" TEXT,
    "registered_office_municipality" TEXT,
    "registered_office_province" TEXT,
    "mercantile_registry" TEXT,
    "cnae" TEXT,
    "pgc_variant" "PgcVariant" NOT NULL DEFAULT 'pymes',
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "large_company" BOOLEAN NOT NULL DEFAULT false,
    "sii_enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifactu_chain_scope" "VerifactuChainScope" NOT NULL DEFAULT 'per_center',
    "ccc_principal" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "status" "LegalEntityStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifactu_installations" (
    "id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "property_id" TEXT,
    "numero_instalacion" TEXT NOT NULL,
    "route" "VerifactuRoute" NOT NULL DEFAULT 'verifactu',
    "territory" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "verifactu_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_entities_organization_id_is_default_idx" ON "legal_entities"("organization_id", "is_default");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entities_organization_id_code_key" ON "legal_entities"("organization_id", "code");

-- CreateIndex
CREATE INDEX "verifactu_installations_property_id_active_idx" ON "verifactu_installations"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "verifactu_installations_legal_entity_id_numero_instalacion_key" ON "verifactu_installations"("legal_entity_id", "numero_instalacion");

-- CreateIndex
CREATE INDEX "bank_accounts_legal_entity_id_active_idx" ON "bank_accounts"("legal_entity_id", "active");

-- CreateIndex
CREATE INDEX "invoice_sequences_legal_entity_id_year_idx" ON "invoice_sequences"("legal_entity_id", "year");

-- CreateIndex
CREATE INDEX "invoices_legal_entity_id_invoice_number_idx" ON "invoices"("legal_entity_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoices_installation_id_idx" ON "invoices"("installation_id");

-- CreateIndex
CREATE INDEX "properties_legal_entity_id_kind_idx" ON "properties"("legal_entity_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "properties_legal_entity_id_code_key" ON "properties"("legal_entity_id", "code");

-- CreateIndex
CREATE INDEX "verifactu_submissions_installation_id_idx" ON "verifactu_submissions"("installation_id");

-- AddForeignKey
ALTER TABLE "verifactu_installations" ADD CONSTRAINT "verifactu_installations_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Hand-written: immutability triggers (outside Prisma's model; see header).
-- ============================================================================

-- ImmutableInstallationNumber
CREATE OR REPLACE FUNCTION hotelos_verifactu_installation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."numero_instalacion" IS DISTINCT FROM OLD."numero_instalacion" THEN
    RAISE EXCEPTION 'El número de instalación VeriFactu es inmutable (instalación %): retire la instalación y abra otra con un número nuevo.', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."legal_entity_id" IS DISTINCT FROM OLD."legal_entity_id" THEN
    RAISE EXCEPTION 'La instalación VeriFactu % no puede cambiar de sociedad.', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER verifactu_installations_numero_inmutable
  BEFORE UPDATE ON "verifactu_installations"
  FOR EACH ROW EXECUTE FUNCTION hotelos_verifactu_installation_immutable();

-- ImmutableIssuerSnapshot
CREATE OR REPLACE FUNCTION hotelos_invoice_issuer_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text <> 'draft'
     AND (
       (OLD."issuer_tax_id" IS NOT NULL AND NEW."issuer_tax_id" IS DISTINCT FROM OLD."issuer_tax_id")
       OR (OLD."issuer_legal_name" IS NOT NULL AND NEW."issuer_legal_name" IS DISTINCT FROM OLD."issuer_legal_name")
     ) THEN
    RAISE EXCEPTION 'El emisor (NIF y razón social) de la factura emitida % es inmutable: una corrección fiscal es una rectificativa, no una edición.', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invoices_issuer_inmutable
  BEFORE UPDATE OF "issuer_tax_id", "issuer_legal_name" ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION hotelos_invoice_issuer_immutable();
