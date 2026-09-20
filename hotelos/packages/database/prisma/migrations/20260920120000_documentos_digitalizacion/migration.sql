-- ============================================================================
-- 20260920120000_documentos_digitalizacion · Documentos y digitalización con IA
-- (Tanda T9 · lote T9-01)
-- ============================================================================
-- Generada el 2026-09-19 con:
--   cd packages/database && createdb hotelos_t9_shadow && \
--   node node_modules/prisma/build/index.js migrate diff \
--     --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url postgresql://…/hotelos_t9_shadow --script   (Prisma CLI 6.19.3, PostgreSQL 16.14)
--   && dropdb hotelos_t9_shadow
-- y revisada a mano. NO se usó `migrate dev` ni `--from-schema-datasource`: la BD del
-- carril (hotelos_t9) tiene aplicadas dos migraciones de otro carril que este árbol
-- aún no contiene (20260920100000_iva_regimen y 20260920110000_iva_compensacion_inicial),
-- y por eso esta carpeta lleva un timestamp POSTERIOR a ambas (orden monótono cuando
-- se fusionen; `migrate deploy` aplica las pendientes sin exigir orden). Todo lo que
-- emitió el generador está aquí VERBATIM y nada más: 7 CREATE TYPE, 2 ALTER TABLE …
-- ADD COLUMN (supplier_bills: reception_date, incoming_document_id, source DEFAULT 'manual',
-- match_status DEFAULT 'none'; supplier_bill_lines: quantity, unit_price, delivery_note_ref),
-- 10 CREATE TABLE (incoming_documents, document_files, document_pages, document_extractions,
-- document_actions, document_dispatch_batches, goods_receipts, goods_receipt_lines,
-- bill_line_matches, document_settings), 21 CREATE INDEX / CREATE UNIQUE INDEX y
-- 7 ADD FOREIGN KEY (ON DELETE CASCADE hacia incoming_documents, goods_receipts,
-- supplier_bill_lines y goods_receipt_lines).
-- Migración ADITIVA: ningún DROP, ningún NOT NULL sin DEFAULT sobre tablas con datos,
-- sin CREATE EXTENSION (pg_trgm queda para una migración propia con previewFeatures
-- postgresqlExtensions), sin funciones, triggers ni vistas, sin paso de datos.
-- Los enums pinados por tests/finanzas-schema-contract (SupplierBillStatus, VatBookSourceType)
-- no se tocan; SupplierBill.source y matchStatus son TEXT con catálogo en código
-- (mismo criterio que JournalEntry.source_type).
-- Fuente: docs/design/DOCUMENTOS-DIGITALIZACION.md §8 (modelo de datos) y §6-§7.
-- Pre-checks en hotelos_t9 (2026-09-19): 18 migraciones del árbol aplicadas + las 2 del
-- otro carril (db:drift:check con exactamente esos 3 ítems heredados: enum VatBookRegime,
-- vat_book_entries.regime + índice, vat_settings.opening_compensation*); schema.prisma
-- 277 → 287 modelos y 38 → 45 enums; supplier_bills 2 filas y supplier_bill_lines 2
-- filas (reciben los DEFAULT 'manual' / 'none' y NULL en el resto).
-- ============================================================================

-- CreateEnum
CREATE TYPE "IncomingDocumentKind" AS ENUM ('invoice', 'delivery_note', 'receipt', 'letter', 'administrative_notice', 'contract', 'e_invoice_status', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "IncomingDocumentStatus" AS ENUM ('captured', 'sent_to_office', 'in_review', 'approved', 'posted', 'archived', 'returned_to_centre', 'rejected');

-- CreateEnum
CREATE TYPE "IncomingDocumentSource" AS ENUM ('upload', 'mobile', 'email', 'scanner', 'e_invoice', 'api');

-- CreateEnum
CREATE TYPE "DocumentStorageKind" AS ENUM ('inline', 'disk', 's3');

-- CreateEnum
CREATE TYPE "DocumentPhysicalStatus" AS ENUM ('at_centre', 'in_transit', 'at_office', 'filed', 'not_applicable');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('received', 'matched', 'billed', 'disputed');

-- CreateEnum
CREATE TYPE "DocumentActionStatus" AS ENUM ('open', 'done', 'cancelled');

-- AlterTable
ALTER TABLE "supplier_bill_lines" ADD COLUMN     "delivery_note_ref" TEXT,
ADD COLUMN     "quantity" DECIMAL(12,3),
ADD COLUMN     "unit_price" DECIMAL(12,4);

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "incoming_document_id" TEXT,
ADD COLUMN     "match_status" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "reception_date" DATE,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "incoming_documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "property_id" TEXT NOT NULL,
    "registry_number" TEXT NOT NULL,
    "registry_year" INTEGER NOT NULL,
    "registry_seq" INTEGER NOT NULL,
    "kind" "IncomingDocumentKind" NOT NULL DEFAULT 'unknown',
    "kind_confidence" DECIMAL(5,4),
    "classification_source" TEXT,
    "status" "IncomingDocumentStatus" NOT NULL DEFAULT 'captured',
    "physical_status" "DocumentPhysicalStatus" NOT NULL DEFAULT 'at_centre',
    "source" "IncomingDocumentSource" NOT NULL DEFAULT 'upload',
    "original_format" TEXT,
    "title" TEXT,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "supplier_id" TEXT,
    "supplier_tax_id" TEXT,
    "document_number" TEXT,
    "document_date" DATE,
    "total_amount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "extraction_status" TEXT NOT NULL DEFAULT 'pending',
    "proposed_action" TEXT,
    "proposed_action_json" JSONB NOT NULL DEFAULT '{}',
    "checks_json" JSONB NOT NULL DEFAULT '[]',
    "reviewed_fields_json" JSONB,
    "search_text" TEXT,
    "email_meta_json" JSONB,
    "captured_by" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "assigned_to" TEXT,
    "review_started_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "reject_note" TEXT,
    "supplier_bill_id" TEXT,
    "expense_id" TEXT,
    "goods_receipt_id" TEXT,
    "review_item_id" TEXT,
    "dispatch_batch_id" TEXT,
    "merged_into_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "retention_until" DATE,
    "extended_retention" BOOLEAN NOT NULL DEFAULT false,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "blocked_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "guest_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incoming_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_files" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'original',
    "page_no" INTEGER,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_kind" "DocumentStorageKind" NOT NULL DEFAULT 'disk',
    "storage_key" TEXT,
    "inline" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_pages" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "page_no" INTEGER NOT NULL,
    "kind" TEXT,
    "is_continuation" BOOLEAN NOT NULL DEFAULT false,
    "text_extracted" TEXT,
    "image_file_id" TEXT,
    "width" INTEGER,
    "height" INTEGER,

    CONSTRAINT "document_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_extractions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "run_no" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT,
    "model_version" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "fields_json" JSONB NOT NULL DEFAULT '{}',
    "confidence_json" JSONB NOT NULL DEFAULT '{}',
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "tokens_input" INTEGER,
    "tokens_output" INTEGER,
    "cost_eur" DECIMAL(10,4),
    "duration_ms" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'done',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_actions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigned_to" TEXT,
    "due_at" TIMESTAMP(3),
    "status" "DocumentActionStatus" NOT NULL DEFAULT 'open',
    "outcome_note" TEXT,
    "completed_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_dispatch_batches" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "closed_by" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by" TEXT,
    "received_at" TIMESTAMP(3),
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "sheet_file_id" TEXT,

    CONSTRAINT "document_dispatch_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "supplier_tax_id" TEXT,
    "delivery_note_number" TEXT NOT NULL,
    "delivery_date" DATE NOT NULL,
    "purchase_order_id" TEXT,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'received',
    "received_by" TEXT,
    "incoming_document_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "goods_receipt_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "inventory_item_id" TEXT,
    "purchase_order_line_id" TEXT,
    "quantity_ordered" DECIMAL(12,3),
    "quantity_received" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unit_price" DECIMAL(12,4),
    "base" DECIMAL(12,2),
    "tax_rate" DECIMAL(5,2),
    "stock_movement_id" TEXT,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_line_matches" (
    "id" TEXT NOT NULL,
    "supplier_bill_line_id" TEXT NOT NULL,
    "goods_receipt_line_id" TEXT NOT NULL,
    "purchase_order_line_id" TEXT,
    "matched_quantity" DECIMAL(12,3),
    "matched_base" DECIMAL(12,2),
    "quantity_variance" DECIMAL(12,3),
    "price_variance" DECIMAL(12,4),
    "status" TEXT NOT NULL DEFAULT 'auto',
    "matched_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_line_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "office_sla_business_days" INTEGER NOT NULL DEFAULT 2,
    "auto_send_to_office" BOOLEAN NOT NULL DEFAULT false,
    "ai_allowed_kinds_json" JSONB NOT NULL DEFAULT '[]',
    "price_tolerance_pct" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "quantity_tolerance" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "amount_tolerance_abs" DECIMAL(12,2) NOT NULL DEFAULT 1.00,
    "require_match_for_approval" BOOLEAN NOT NULL DEFAULT false,
    "retention_years_default" INTEGER NOT NULL DEFAULT 6,
    "letter_retention_years" INTEGER NOT NULL DEFAULT 4,
    "extended_retention_years" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incoming_documents_organization_id_status_sent_at_idx" ON "incoming_documents"("organization_id", "status", "sent_at");

-- CreateIndex
CREATE INDEX "incoming_documents_property_id_status_captured_at_idx" ON "incoming_documents"("property_id", "status", "captured_at");

-- CreateIndex
CREATE INDEX "incoming_documents_organization_id_sha256_idx" ON "incoming_documents"("organization_id", "sha256");

-- CreateIndex
CREATE INDEX "incoming_documents_organization_id_supplier_id_document_num_idx" ON "incoming_documents"("organization_id", "supplier_id", "document_number");

-- CreateIndex
CREATE INDEX "incoming_documents_organization_id_retention_until_idx" ON "incoming_documents"("organization_id", "retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_documents_property_id_registry_number_key" ON "incoming_documents"("property_id", "registry_number");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_documents_property_id_registry_year_registry_seq_key" ON "incoming_documents"("property_id", "registry_year", "registry_seq");

-- CreateIndex
CREATE INDEX "document_files_document_id_role_page_no_idx" ON "document_files"("document_id", "role", "page_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_files_storage_key_key" ON "document_files"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_pages_document_id_page_no_key" ON "document_pages"("document_id", "page_no");

-- CreateIndex
CREATE UNIQUE INDEX "document_extractions_document_id_run_no_key" ON "document_extractions"("document_id", "run_no");

-- CreateIndex
CREATE INDEX "document_actions_organization_id_status_due_at_idx" ON "document_actions"("organization_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "document_actions_property_id_status_idx" ON "document_actions"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_dispatch_batches_property_id_batch_number_key" ON "document_dispatch_batches"("property_id", "batch_number");

-- CreateIndex
CREATE INDEX "goods_receipts_property_id_delivery_date_idx" ON "goods_receipts"("property_id", "delivery_date");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_supplier_id_delivery_note_nu_key" ON "goods_receipts"("organization_id", "supplier_id", "delivery_note_number");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_goods_receipt_id_idx" ON "goods_receipt_lines"("goods_receipt_id");

-- CreateIndex
CREATE INDEX "bill_line_matches_goods_receipt_line_id_idx" ON "bill_line_matches"("goods_receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_line_matches_supplier_bill_line_id_goods_receipt_line__key" ON "bill_line_matches"("supplier_bill_line_id", "goods_receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_settings_organization_id_key" ON "document_settings"("organization_id");

-- CreateIndex
CREATE INDEX "supplier_bills_incoming_document_id_idx" ON "supplier_bills"("incoming_document_id");

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "incoming_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "incoming_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "incoming_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_actions" ADD CONSTRAINT "document_actions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "incoming_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_line_matches" ADD CONSTRAINT "bill_line_matches_supplier_bill_line_id_fkey" FOREIGN KEY ("supplier_bill_line_id") REFERENCES "supplier_bill_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_line_matches" ADD CONSTRAINT "bill_line_matches_goods_receipt_line_id_fkey" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "goods_receipt_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

