-- CreateTable
CREATE TABLE "taxes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "tax_region" TEXT NOT NULL,
    "liability_account_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "rate_code" TEXT NOT NULL,
    "rate_percent" DECIMAL(5,2) NOT NULL,
    "applies_to" TEXT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifactu_submissions" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "endpoint" TEXT,
    "xml_payload" TEXT,
    "response_ack" TEXT,
    "accepted_hash" TEXT,
    "csv_code" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifactu_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "taxes_organization_id_code_tax_region_key" ON "taxes"("organization_id", "code", "tax_region");

-- CreateIndex
CREATE INDEX "tax_rates_applies_to_valid_from_idx" ON "tax_rates"("applies_to", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_tax_id_rate_code_applies_to_valid_from_key" ON "tax_rates"("tax_id", "rate_code", "applies_to", "valid_from");

-- CreateIndex
CREATE INDEX "verifactu_submissions_property_id_status_idx" ON "verifactu_submissions"("property_id", "status");

-- CreateIndex
CREATE INDEX "verifactu_submissions_status_next_retry_at_idx" ON "verifactu_submissions"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "verifactu_submissions_invoice_id_key" ON "verifactu_submissions"("invoice_id");
