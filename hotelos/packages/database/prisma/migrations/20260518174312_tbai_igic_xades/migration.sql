-- AlterTable
ALTER TABLE "verifactu_submissions" ADD COLUMN     "signature_mode" TEXT,
ADD COLUMN     "signed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "tbai_submissions" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "territory" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "endpoint" TEXT,
    "xml_payload" TEXT,
    "response_ack" TEXT,
    "tbai_code" TEXT,
    "tbai_hash" TEXT,
    "previous_tbai_hash" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tbai_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "igic_submissions" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "endpoint" TEXT,
    "xml_payload" TEXT,
    "response_ack" TEXT,
    "csv_code" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "igic_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tbai_submissions_property_id_territory_status_idx" ON "tbai_submissions"("property_id", "territory", "status");

-- CreateIndex
CREATE INDEX "tbai_submissions_status_next_retry_at_idx" ON "tbai_submissions"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "tbai_submissions_invoice_id_key" ON "tbai_submissions"("invoice_id");

-- CreateIndex
CREATE INDEX "igic_submissions_property_id_status_idx" ON "igic_submissions"("property_id", "status");

-- CreateIndex
CREATE INDEX "igic_submissions_status_next_retry_at_idx" ON "igic_submissions"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "igic_submissions_invoice_id_key" ON "igic_submissions"("invoice_id");
