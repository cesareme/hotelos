-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "auto_push_on_save" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "credentials_encrypted" TEXT,
ADD COLUMN     "default_markup_percent" DECIMAL(5,2),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'stub';

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EUR';

-- AlterTable
ALTER TABLE "rate_change_journals" ADD COLUMN     "client_request_id" TEXT,
ADD COLUMN     "reverted_by_journal_id" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'draft';

-- AlterTable
ALTER TABLE "rate_days" ADD COLUMN     "occupancy_prices_json" JSONB,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "restriction_days" ADD COLUMN     "closed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "max_advance_days" INTEGER,
ADD COLUMN     "min_advance_days" INTEGER,
ADD COLUMN     "min_stay_through" INTEGER,
ADD COLUMN     "updated_by" TEXT,
ALTER COLUMN "rate_plan_id" SET NOT NULL,
ALTER COLUMN "rate_plan_id" SET DEFAULT '*',
ALTER COLUMN "channel_id" SET NOT NULL,
ALTER COLUMN "channel_id" SET DEFAULT '*';

-- CreateTable
CREATE TABLE "channel_product_mappings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    "external_room_code" TEXT NOT NULL,
    "external_rate_code" TEXT NOT NULL,
    "pricing_model" TEXT NOT NULL DEFAULT 'per_day',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_product_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_deliveries" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL DEFAULT '*',
    "date" DATE NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "payload_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "last_error" TEXT,
    "external_ref" TEXT,
    "sync_job_id" TEXT,
    "journal_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_change_journal_items" (
    "id" TEXT NOT NULL,
    "journal_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "channel_id" TEXT,
    "field" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,

    CONSTRAINT "rate_change_journal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_product_mappings_property_id_channel_id_status_idx" ON "channel_product_mappings"("property_id", "channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_product_mappings_channel_id_room_type_id_rate_plan__key" ON "channel_product_mappings"("channel_id", "room_type_id", "rate_plan_id");

-- CreateIndex
CREATE INDEX "channel_deliveries_property_id_channel_id_status_idx" ON "channel_deliveries"("property_id", "channel_id", "status");

-- CreateIndex
CREATE INDEX "channel_deliveries_channel_id_room_type_id_rate_plan_id_dat_idx" ON "channel_deliveries"("channel_id", "room_type_id", "rate_plan_id", "date");

-- CreateIndex
CREATE INDEX "channel_deliveries_status_next_retry_at_idx" ON "channel_deliveries"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "channel_deliveries_channel_id_idempotency_key_key" ON "channel_deliveries"("channel_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "rate_change_journal_items_journal_id_idx" ON "rate_change_journal_items"("journal_id");

-- CreateIndex
CREATE INDEX "rate_change_journal_items_rate_plan_id_room_type_id_date_idx" ON "rate_change_journal_items"("rate_plan_id", "room_type_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "channels_property_id_provider_code_key" ON "channels"("property_id", "provider_code");

-- CreateIndex
CREATE INDEX "rate_days_property_id_date_idx" ON "rate_days"("property_id", "date");

-- CreateIndex
CREATE INDEX "restriction_days_property_id_date_idx" ON "restriction_days"("property_id", "date");

-- AddForeignKey
ALTER TABLE "rate_change_journal_items" ADD CONSTRAINT "rate_change_journal_items_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "rate_change_journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

