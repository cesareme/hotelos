-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "period_code" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "closing_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fiscal_periods_organization_id_property_id_status_idx" ON "fiscal_periods"("organization_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "fiscal_periods_start_date_end_date_idx" ON "fiscal_periods"("start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_organization_id_property_id_period_code_key" ON "fiscal_periods"("organization_id", "property_id", "period_code");
