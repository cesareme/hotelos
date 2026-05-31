-- ============================================================
-- Baseline migration: tables present in schema.prisma but missing
-- from the historical migration history (createdb push drift).
--
-- Generated from: prisma migrate diff --from-empty --to-schema-datamodel.
-- Contents: 50 CREATE TABLE + their CREATE INDEX statements only.
-- No DROPs, no ALTERs of pre-existing tables.
--
-- For environments where the DB already has these tables (dev/staging),
-- mark this migration as already applied:
--   prisma migrate resolve --applied 20260601000000_baseline_missing_tables
--
-- For fresh environments, prisma migrate deploy will execute it normally.
-- ============================================================

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_pace_snapshots" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "capture_date" DATE NOT NULL,
    "stay_date" DATE NOT NULL,
    "rooms_otb" INTEGER NOT NULL DEFAULT 0,
    "revenue_otb" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reservations" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_pace_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_accuracy" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "segment" TEXT,
    "forecast_value" DECIMAL(14,4) NOT NULL,
    "actual_value" DECIMAL(14,4) NOT NULL,
    "abs_error" DECIMAL(14,4) NOT NULL,
    "pct_error" DECIMAL(8,2),
    "model_version" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecast_accuracy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_shop_jobs" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "shop_date" DATE NOT NULL,
    "days_ahead" INTEGER NOT NULL DEFAULT 30,
    "competitors" INTEGER NOT NULL DEFAULT 0,
    "snapshots" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'deterministic',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "rate_shop_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "min_occupancy" DECIMAL(5,2),
    "max_occupancy" DECIMAL(5,2),
    "adjust_type" TEXT NOT NULL DEFAULT 'percent',
    "adjust_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "min_price" DECIMAL(12,2),
    "max_price" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_levels" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bar_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "period_month" TEXT NOT NULL,
    "budgeted_rooms_sold" INTEGER,
    "budgeted_occupancy" DECIMAL(5,2),
    "budgeted_adr" DECIMAL(12,2),
    "budgeted_room_revenue" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_segments" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_connections" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_auth',
    "email_address" TEXT,
    "oauth_refresh_token" TEXT,
    "imap_password" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "cursor" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_emails" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "thread_id" TEXT,
    "from_address" TEXT,
    "subject" TEXT,
    "received_at" TIMESTAMP(3),
    "snippet" TEXT,
    "detected_source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "parse_source" TEXT,
    "confidence" DECIMAL(5,2),
    "draft_json" JSONB NOT NULL DEFAULT '{}',
    "review_item_id" TEXT,
    "reservation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transactions" (
    "id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT,
    "external_reference" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "property_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "outlet_id" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "tax_rate" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_recipes" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upsell_impressions" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "property_id" TEXT NOT NULL,
    "channel" TEXT,
    "shown_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "converted" BOOLEAN NOT NULL DEFAULT false,
    "conversion_purchase_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upsell_impressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tour_operators" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "default_commission_pct" DECIMAL(5,2),
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tour_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allotments" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "tour_operator_id" TEXT,
    "channel_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "rate_plan_id" TEXT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "total_rooms" INTEGER NOT NULL,
    "release_days" INTEGER NOT NULL DEFAULT 14,
    "contracted_rate" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allotments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allotment_days" (
    "id" TEXT NOT NULL,
    "allotment_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "blocked_rooms" INTEGER NOT NULL,
    "picked_up_rooms" INTEGER NOT NULL DEFAULT 0,
    "released_rooms" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allotment_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "free_cancel_hours" INTEGER NOT NULL DEFAULT 48,
    "penalty_type" TEXT NOT NULL DEFAULT 'first_night',
    "penalty_value" DECIMAL(12,2),
    "no_show_penalty_type" TEXT NOT NULL DEFAULT 'first_night',
    "no_show_penalty_value" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_routing_rules" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "target_folio_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folio_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gdpr_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "subject_type" TEXT NOT NULL DEFAULT 'guest',
    "subject_id" TEXT,
    "subject_email" TEXT,
    "request_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "requestor_email" TEXT NOT NULL,
    "payload_json" JSONB,
    "fulfillment_metadata_json" JSONB,
    "document_object_key" TEXT,
    "assignee_user_id" TEXT,
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gdpr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withholding_tax_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "recipient_nif" TEXT,
    "recipient_name" TEXT,
    "recipient_address" TEXT,
    "cadastral_reference" TEXT,
    "gross_amount" DECIMAL(14,2) NOT NULL,
    "retention_rate" DECIMAL(5,2) NOT NULL,
    "retention_amount" DECIMAL(14,2) NOT NULL,
    "row_code" TEXT NOT NULL,
    "payment_date" DATE NOT NULL,
    "fiscal_period_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withholding_tax_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bank_name" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    "ledger_account_code" TEXT,
    "opening_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" TEXT NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "opening_balance" DECIMAL(14,2) NOT NULL,
    "closing_balance" DECIMAL(14,2) NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "tx_date" TIMESTAMP(3) NOT NULL,
    "value_date" TIMESTAMP(3),
    "amount" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    "description" TEXT,
    "reference" TEXT,
    "counterparty" TEXT,
    "raw_json" JSONB,
    "matched_to" TEXT,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "id" TEXT NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "bank_line_id" TEXT NOT NULL,
    "match_type" TEXT NOT NULL,
    "matched_entity_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matched_by_user_id" TEXT,
    "confidence" TEXT,
    "notes" TEXT,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "channel_code" TEXT,
    "rate_pct" DECIMAL(5,2) NOT NULL,
    "applies_to" TEXT NOT NULL DEFAULT 'net_revenue',
    "ledger_account_code" TEXT NOT NULL DEFAULT '6230',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMP(3),
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_accruals" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "invoice_id" TEXT,
    "channel_id" TEXT,
    "channel_code" TEXT,
    "base_amount" DECIMAL(14,2) NOT NULL,
    "rate_pct" DECIMAL(5,2) NOT NULL,
    "commission_amount" DECIMAL(14,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    "accrued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "journal_entry_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accrued',

    CONSTRAINT "commission_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_contracts" (
    "id" TEXT NOT NULL,
    "staff_profile_id" TEXT NOT NULL,
    "property_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "contract_type" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "gross_salary" DECIMAL(14,2) NOT NULL,
    "pay_frequency" TEXT NOT NULL DEFAULT 'monthly',
    "pay_count" INTEGER NOT NULL DEFAULT 14,
    "irpf_rate_pct" DECIMAL(5,2),
    "social_security_category" TEXT,
    "cost_center_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employment_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "property_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "period_code" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "total_gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_net" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_irpf" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_ss" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_slips" (
    "id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "staff_profile_id" TEXT NOT NULL,
    "contract_id" TEXT,
    "gross_salary" DECIMAL(14,2) NOT NULL,
    "irpf_retention" DECIMAL(14,2) NOT NULL,
    "ss_employee" DECIMAL(14,2) NOT NULL,
    "ss_employer" DECIMAL(14,2) NOT NULL,
    "net_salary" DECIMAL(14,2) NOT NULL,
    "days_worked" INTEGER NOT NULL DEFAULT 30,
    "document_object_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" TEXT NOT NULL,
    "slip_id" TEXT NOT NULL,
    "line_type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "rate" DECIMAL(14,8) NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "organization_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "code" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_at" TIMESTAMP(3),
    "closing_entry_id" TEXT,
    "opening_entry_id" TEXT,
    "net_result" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "code" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables_json" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "notification_id" TEXT,
    "template_code" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_message_id" TEXT,
    "subject" TEXT,
    "body_rendered" TEXT,
    "payload_json" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_areas" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_requirements" (
    "id" TEXT NOT NULL,
    "area_code" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "jurisdiction" TEXT NOT NULL DEFAULT 'STATE',
    "autonomous_community" TEXT,
    "municipality" TEXT,
    "legal_reference" TEXT,
    "applies_when" TEXT,
    "applies_rule" TEXT,
    "default_applies" BOOLEAN NOT NULL DEFAULT true,
    "hotel_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "required_documents" TEXT[],
    "renewal_required" BOOLEAN NOT NULL DEFAULT false,
    "default_renewal_period_days" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_property_profiles" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "autonomous_community" TEXT,
    "hotel_type" TEXT,
    "has_restaurant" BOOLEAN NOT NULL DEFAULT false,
    "has_kitchen" BOOLEAN NOT NULL DEFAULT false,
    "has_pool" BOOLEAN NOT NULL DEFAULT false,
    "has_spa" BOOLEAN NOT NULL DEFAULT false,
    "has_parking" BOOLEAN NOT NULL DEFAULT false,
    "has_events" BOOLEAN NOT NULL DEFAULT false,
    "has_terrace" BOOLEAN NOT NULL DEFAULT false,
    "has_laundry" BOOLEAN NOT NULL DEFAULT false,
    "building_protected" BOOLEAN NOT NULL DEFAULT false,
    "expiring_soon_days" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_property_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_items" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "requirement_code" TEXT NOT NULL,
    "applies" BOOLEAN NOT NULL DEFAULT true,
    "applies_override" BOOLEAN,
    "not_applicable_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "responsible_user_id" TEXT,
    "responsible_name" TEXT,
    "external_advisor_name" TEXT,
    "issue_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "last_review_date" TIMESTAMP(3),
    "next_review_date" TIMESTAMP(3),
    "notes" TEXT,
    "corrective_action" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "requirement_code" TEXT,
    "area_code" TEXT,
    "title" TEXT NOT NULL,
    "document_type" TEXT,
    "file_name" TEXT NOT NULL,
    "object_key" TEXT,
    "mime_type" TEXT,
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "issue_date" TIMESTAMP(3),
    "expiry_date" TIMESTAMP(3),
    "issuing_authority" TEXT,
    "provider_name" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_by_user_id" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tags" TEXT[],
    "notes" TEXT,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_tasks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "requirement_code" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigned_to_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tourist_tax_rates" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "ccaa_code" TEXT NOT NULL,
    "municipality" TEXT,
    "establishment_class" TEXT NOT NULL,
    "amount_per_person_night" DECIMAL(6,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "valid_from" DATE NOT NULL,
    "valid_until" DATE,
    "max_nights_per_stay" INTEGER NOT NULL DEFAULT 0,
    "high_season_surcharge" DECIMAL(5,4),
    "high_season_from_mmdd" TEXT,
    "high_season_until_mmdd" TEXT,
    "taxable_age_from" INTEGER NOT NULL DEFAULT 16,
    "legal_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tourist_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tourist_tax_applications" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "folio_id" TEXT,
    "folio_line_id" TEXT,
    "rate_id" TEXT NOT NULL,
    "ccaa_code" TEXT NOT NULL,
    "municipality" TEXT,
    "establishment_class" TEXT NOT NULL,
    "amount_per_person_night" DECIMAL(6,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "adults_taxable" INTEGER NOT NULL,
    "nights_taxable" INTEGER NOT NULL,
    "total_amount" DECIMAL(10,2) NOT NULL,
    "stay_from" DATE NOT NULL,
    "stay_until" DATE NOT NULL,
    "exemptions_applied" JSONB,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tourist_tax_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tourist_tax_exemptions" (
    "id" TEXT NOT NULL,
    "ccaa_code" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "age_from" INTEGER,
    "age_to" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "legal_source" TEXT,

    CONSTRAINT "tourist_tax_exemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esrs_indicators" (
    "id" TEXT NOT NULL,
    "property_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "fiscal_year" TEXT NOT NULL,
    "standard_code" TEXT NOT NULL,
    "disclosure_code" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "numeric_value" DECIMAL(16,4),
    "text_value" TEXT,
    "unit" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "metadata_json" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_at" TIMESTAMP(3),

    CONSTRAINT "esrs_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esrs_reports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "fiscal_year" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "format" TEXT NOT NULL DEFAULT 'json',
    "content_hash" TEXT,
    "summary_json" JSONB,
    "payload_xbrl" TEXT,
    "generated_by" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "esrs_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "user_id" TEXT,
    "code_hash" TEXT NOT NULL,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "user_id" TEXT,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "rotated_from_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "category" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon_url" TEXT,
    "screenshots_json" JSONB,
    "pricing" TEXT,
    "privacy_url" TEXT,
    "terms_url" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "installs_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_installations" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "scopes" TEXT[],
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalled_at" TIMESTAMP(3),
    "installed_by_user_id" TEXT,

    CONSTRAINT "app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "revenue_pace_snapshots_property_id_stay_date_idx" ON "revenue_pace_snapshots"("property_id", "stay_date");

-- CreateIndex
CREATE INDEX "revenue_pace_snapshots_property_id_capture_date_idx" ON "revenue_pace_snapshots"("property_id", "capture_date");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_pace_snapshots_property_id_capture_date_stay_date_key" ON "revenue_pace_snapshots"("property_id", "capture_date", "stay_date");

-- CreateIndex
CREATE INDEX "forecast_accuracy_property_id_stay_date_idx" ON "forecast_accuracy"("property_id", "stay_date");

-- CreateIndex
CREATE UNIQUE INDEX "forecast_accuracy_property_id_stay_date_metric_segment_key" ON "forecast_accuracy"("property_id", "stay_date", "metric", "segment");

-- CreateIndex
CREATE INDEX "rate_shop_jobs_property_id_shop_date_idx" ON "rate_shop_jobs"("property_id", "shop_date");

-- CreateIndex
CREATE INDEX "pricing_rules_property_id_active_priority_idx" ON "pricing_rules"("property_id", "active", "priority");

-- CreateIndex
CREATE INDEX "bar_levels_property_id_active_idx" ON "bar_levels"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_property_id_period_month_key" ON "budgets"("property_id", "period_month");

-- CreateIndex
CREATE INDEX "market_segments_property_id_active_idx" ON "market_segments"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "market_segments_property_id_code_key" ON "market_segments"("property_id", "code");

-- CreateIndex
CREATE INDEX "email_connections_property_id_status_idx" ON "email_connections"("property_id", "status");

-- CreateIndex
CREATE INDEX "inbound_emails_property_id_status_idx" ON "inbound_emails"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_emails_connection_id_message_id_key" ON "inbound_emails"("connection_id", "message_id");

-- CreateIndex
CREATE INDEX "loyalty_transactions_membership_id_occurred_at_idx" ON "loyalty_transactions"("membership_id", "occurred_at");

-- CreateIndex
CREATE INDEX "loyalty_transactions_property_id_type_occurred_at_idx" ON "loyalty_transactions"("property_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "menu_items_property_id_outlet_id_active_idx" ON "menu_items"("property_id", "outlet_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "menu_items_property_id_outlet_id_name_key" ON "menu_items"("property_id", "outlet_id", "name");

-- CreateIndex
CREATE INDEX "menu_recipes_menu_item_id_idx" ON "menu_recipes"("menu_item_id");

-- CreateIndex
CREATE INDEX "menu_recipes_inventory_item_id_idx" ON "menu_recipes"("inventory_item_id");

-- CreateIndex
CREATE INDEX "upsell_impressions_property_id_shown_at_idx" ON "upsell_impressions"("property_id", "shown_at");

-- CreateIndex
CREATE INDEX "upsell_impressions_offer_id_shown_at_idx" ON "upsell_impressions"("offer_id", "shown_at");

-- CreateIndex
CREATE INDEX "tour_operators_organization_id_active_idx" ON "tour_operators"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "tour_operators_organization_id_code_key" ON "tour_operators"("organization_id", "code");

-- CreateIndex
CREATE INDEX "allotments_property_id_status_valid_from_valid_to_idx" ON "allotments"("property_id", "status", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "allotments_tour_operator_id_idx" ON "allotments"("tour_operator_id");

-- CreateIndex
CREATE UNIQUE INDEX "allotments_property_id_code_key" ON "allotments"("property_id", "code");

-- CreateIndex
CREATE INDEX "allotment_days_allotment_id_idx" ON "allotment_days"("allotment_id");

-- CreateIndex
CREATE UNIQUE INDEX "allotment_days_allotment_id_date_key" ON "allotment_days"("allotment_id", "date");

-- CreateIndex
CREATE INDEX "cancellation_policies_property_id_active_idx" ON "cancellation_policies"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_policies_property_id_code_key" ON "cancellation_policies"("property_id", "code");

-- CreateIndex
CREATE INDEX "folio_routing_rules_reservation_id_active_priority_idx" ON "folio_routing_rules"("reservation_id", "active", "priority");

-- CreateIndex
CREATE INDEX "gdpr_requests_organization_id_status_requested_at_idx" ON "gdpr_requests"("organization_id", "status", "requested_at");

-- CreateIndex
CREATE INDEX "gdpr_requests_subject_id_request_type_idx" ON "gdpr_requests"("subject_id", "request_type");

-- CreateIndex
CREATE INDEX "withholding_tax_records_property_id_payment_date_idx" ON "withholding_tax_records"("property_id", "payment_date");

-- CreateIndex
CREATE INDEX "withholding_tax_records_source_type_source_id_idx" ON "withholding_tax_records"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "withholding_tax_records_organization_id_payment_date_idx" ON "withholding_tax_records"("organization_id", "payment_date");

-- CreateIndex
CREATE INDEX "bank_accounts_property_id_active_idx" ON "bank_accounts"("property_id", "active");

-- CreateIndex
CREATE INDEX "bank_accounts_organization_id_idx" ON "bank_accounts"("organization_id");

-- CreateIndex
CREATE INDEX "bank_statements_bank_account_id_period_end_idx" ON "bank_statements"("bank_account_id", "period_end");

-- CreateIndex
CREATE INDEX "bank_statement_lines_statement_id_tx_date_idx" ON "bank_statement_lines"("statement_id", "tx_date");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bank_account_id_tx_date_idx" ON "bank_statement_lines"("bank_account_id", "tx_date");

-- CreateIndex
CREATE INDEX "reconciliation_matches_match_type_matched_entity_id_idx" ON "reconciliation_matches"("match_type", "matched_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_bank_line_id_key" ON "reconciliation_matches"("bank_line_id");

-- CreateIndex
CREATE INDEX "commission_rules_property_id_active_idx" ON "commission_rules"("property_id", "active");

-- CreateIndex
CREATE INDEX "commission_rules_channel_id_active_idx" ON "commission_rules"("channel_id", "active");

-- CreateIndex
CREATE INDEX "commission_accruals_property_id_accrued_at_idx" ON "commission_accruals"("property_id", "accrued_at");

-- CreateIndex
CREATE INDEX "commission_accruals_channel_id_status_idx" ON "commission_accruals"("channel_id", "status");

-- CreateIndex
CREATE INDEX "commission_accruals_reservation_id_idx" ON "commission_accruals"("reservation_id");

-- CreateIndex
CREATE INDEX "employment_contracts_staff_profile_id_active_idx" ON "employment_contracts"("staff_profile_id", "active");

-- CreateIndex
CREATE INDEX "employment_contracts_property_id_active_idx" ON "employment_contracts"("property_id", "active");

-- CreateIndex
CREATE INDEX "payroll_periods_organization_id_status_idx" ON "payroll_periods"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_organization_id_period_code_property_id_key" ON "payroll_periods"("organization_id", "period_code", "property_id");

-- CreateIndex
CREATE INDEX "payroll_slips_staff_profile_id_idx" ON "payroll_slips"("staff_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_slips_period_id_staff_profile_id_key" ON "payroll_slips"("period_id", "staff_profile_id");

-- CreateIndex
CREATE INDEX "payroll_lines_slip_id_line_type_idx" ON "payroll_lines"("slip_id", "line_type");

-- CreateIndex
CREATE INDEX "exchange_rates_effective_date_idx" ON "exchange_rates"("effective_date");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_currency_quote_currency_effective_date__key" ON "exchange_rates"("base_currency", "quote_currency", "effective_date", "organization_id");

-- CreateIndex
CREATE INDEX "fiscal_years_organization_id_status_idx" ON "fiscal_years"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_organization_id_property_id_code_key" ON "fiscal_years"("organization_id", "property_id", "code");

-- CreateIndex
CREATE INDEX "notification_templates_code_channel_idx" ON "notification_templates"("code", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_organization_id_property_id_code_cha_key" ON "notification_templates"("organization_id", "property_id", "code", "channel", "language");

-- CreateIndex
CREATE INDEX "notification_deliveries_property_id_status_scheduled_for_idx" ON "notification_deliveries"("property_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "notification_deliveries_channel_status_idx" ON "notification_deliveries"("channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_areas_code_key" ON "compliance_areas"("code");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_requirements_code_key" ON "compliance_requirements"("code");

-- CreateIndex
CREATE INDEX "compliance_requirements_area_code_idx" ON "compliance_requirements"("area_code");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_property_profiles_property_id_key" ON "compliance_property_profiles"("property_id");

-- CreateIndex
CREATE INDEX "compliance_items_property_id_idx" ON "compliance_items"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_items_property_id_requirement_code_key" ON "compliance_items"("property_id", "requirement_code");

-- CreateIndex
CREATE INDEX "compliance_documents_property_id_idx" ON "compliance_documents"("property_id");

-- CreateIndex
CREATE INDEX "compliance_documents_property_id_requirement_code_idx" ON "compliance_documents"("property_id", "requirement_code");

-- CreateIndex
CREATE INDEX "compliance_tasks_property_id_idx" ON "compliance_tasks"("property_id");

-- CreateIndex
CREATE INDEX "tourist_tax_rates_country_ccaa_code_municipality_idx" ON "tourist_tax_rates"("country", "ccaa_code", "municipality");

-- CreateIndex
CREATE INDEX "tourist_tax_rates_valid_from_valid_until_idx" ON "tourist_tax_rates"("valid_from", "valid_until");

-- CreateIndex
CREATE INDEX "tourist_tax_applications_property_id_stay_from_idx" ON "tourist_tax_applications"("property_id", "stay_from");

-- CreateIndex
CREATE INDEX "tourist_tax_applications_reservation_id_idx" ON "tourist_tax_applications"("reservation_id");

-- CreateIndex
CREATE INDEX "tourist_tax_exemptions_ccaa_code_active_idx" ON "tourist_tax_exemptions"("ccaa_code", "active");

-- CreateIndex
CREATE INDEX "esrs_indicators_organization_id_fiscal_year_standard_code_idx" ON "esrs_indicators"("organization_id", "fiscal_year", "standard_code");

-- CreateIndex
CREATE UNIQUE INDEX "esrs_indicators_organization_id_property_id_fiscal_year_dis_key" ON "esrs_indicators"("organization_id", "property_id", "fiscal_year", "disclosure_code");

-- CreateIndex
CREATE INDEX "esrs_reports_organization_id_status_idx" ON "esrs_reports"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "esrs_reports_organization_id_fiscal_year_key" ON "esrs_reports"("organization_id", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_hash_key" ON "oauth_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_authorization_codes_app_id_expires_at_idx" ON "oauth_authorization_codes"("app_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_token_hash_key" ON "oauth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "oauth_tokens_app_id_kind_expires_at_idx" ON "oauth_tokens"("app_id", "kind", "expires_at");

-- CreateIndex
CREATE INDEX "oauth_tokens_token_hash_idx" ON "oauth_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_app_id_key" ON "marketplace_listings"("app_id");

-- CreateIndex
CREATE INDEX "marketplace_listings_status_category_idx" ON "marketplace_listings"("status", "category");

-- CreateIndex
CREATE INDEX "app_installations_organization_id_property_id_idx" ON "app_installations"("organization_id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_installations_app_id_organization_id_property_id_key" ON "app_installations"("app_id", "organization_id", "property_id");

