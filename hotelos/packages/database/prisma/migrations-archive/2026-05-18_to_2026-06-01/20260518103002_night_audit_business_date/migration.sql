-- CreateTable
CREATE TABLE "business_dates" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "current_date" DATE NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_runs" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "started_by" TEXT,
    "step_results_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "night_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_dates_property_id_key" ON "business_dates"("property_id");

-- CreateIndex
CREATE INDEX "night_audit_runs_property_id_status_idx" ON "night_audit_runs"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_runs_property_id_business_date_key" ON "night_audit_runs"("property_id", "business_date");
