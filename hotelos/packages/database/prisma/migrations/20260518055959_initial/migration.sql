-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('clean', 'dirty', 'inspected', 'occupied', 'out_of_order', 'out_of_service');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "FolioStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'captured', 'refunded', 'failed');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'cancelled', 'rectified');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('draft', 'posted', 'reversed');

-- CreateEnum
CREATE TYPE "HousekeepingTaskStatus" AS ENUM ('pending', 'assigned', 'in_progress', 'done', 'rejected');

-- CreateEnum
CREATE TYPE "WorkOrderStatus" AS ENUM ('open', 'assigned', 'in_progress', 'waiting_vendor', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('draft', 'missing_data', 'ready_to_sign', 'signed', 'ready_to_submit', 'queued', 'exported', 'submitted', 'accepted', 'rejected', 'failed', 'annulled', 'corrected', 'expired');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('queued', 'sent', 'accepted', 'rejected', 'failed', 'annulled');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'ai', 'system');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "tax_id" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "address" TEXT,
    "municipality" TEXT,
    "province" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "tax_region" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "ses_hospedajes_enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifactu_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "full_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "push_token" TEXT,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "delivery_channel" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_sync_records" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "action_json" JSONB NOT NULL,
    "result_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offline_sync_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_job_runs" (
    "id" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "queue_name" TEXT NOT NULL DEFAULT 'default',
    "payload_json" JSONB NOT NULL,
    "result_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "correlation_id" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "retention_months" INTEGER,
    "legal_hold_allowed" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_modules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "enabled_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_dependencies" (
    "id" TEXT NOT NULL,
    "module_id" TEXT NOT NULL,
    "required_module_id" TEXT NOT NULL,

    CONSTRAINT "module_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_health_checks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "check_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "module_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_setup_steps" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "step_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "property_setup_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_setup_form_submissions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "form_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'saved',
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "validation_errors_json" JSONB NOT NULL DEFAULT '[]',
    "target_entity_type" TEXT,
    "target_entity_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_setup_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_setup_submissions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "option_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'saved',
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "validation_errors_json" JSONB NOT NULL DEFAULT '[]',
    "target_tables_json" JSONB NOT NULL DEFAULT '[]',
    "input_categories_json" JSONB NOT NULL DEFAULT '[]',
    "completion_checks_json" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_setup_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_readiness_checks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "check_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_readiness_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_departments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "role_label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_compliance_settings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "tax_region" TEXT,
    "vat_regime" TEXT,
    "tourism_tax_region" TEXT,
    "ses_hospedajes_enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifactu_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ticketbai_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sii_enabled" BOOLEAN NOT NULL DEFAULT false,
    "b2b_einvoice_enabled" BOOLEAN NOT NULL DEFAULT false,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_compliance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "sequence_code" TEXT NOT NULL,
    "prefix" TEXT,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "invoice_type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "chart_template" TEXT,
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_ai_settings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "default_automation_level" TEXT NOT NULL DEFAULT 'suggest_and_confirm',
    "guest_facing_disclosure" TEXT,
    "voice_locales" TEXT[],
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_ai_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_ai_tool_settings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "automation_level" TEXT NOT NULL DEFAULT 'suggest_and_confirm',
    "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
    "requires_approval_role" TEXT,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "property_ai_tool_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_codes" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "qr_value" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_imports" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "import_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "preview_json" JSONB NOT NULL DEFAULT '{}',
    "error_json" JSONB NOT NULL DEFAULT '{}',
    "committed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backoffice_ai_suggestions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposed_changes_json" JSONB NOT NULL DEFAULT '{}',
    "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backoffice_ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_forecasts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "forecast_date" TIMESTAMP(3) NOT NULL,
    "room_type_id" TEXT,
    "rate_plan_id" TEXT,
    "channel_id" TEXT,
    "segment" TEXT,
    "expected_occupancy" DECIMAL(5,2),
    "expected_rooms_sold" DECIMAL(8,2),
    "expected_adr" DECIMAL(12,2),
    "expected_revpar" DECIMAL(12,2),
    "expected_trevpar" DECIMAL(12,2),
    "expected_goppar" DECIMAL(12,2),
    "expected_room_revenue" DECIMAL(12,2),
    "expected_total_revenue" DECIMAL(12,2),
    "expected_profit" DECIMAL(12,2),
    "cancellation_probability" DECIMAL(5,2),
    "no_show_probability" DECIMAL(5,2),
    "confidence" DECIMAL(5,2),
    "model_version" TEXT,
    "drivers_json" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_recommendations" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "recommendation_type" TEXT NOT NULL,
    "target_date" TIMESTAMP(3) NOT NULL,
    "room_type_id" TEXT,
    "rate_plan_id" TEXT,
    "channel_id" TEXT,
    "current_value_json" JSONB NOT NULL DEFAULT '{}',
    "recommended_value_json" JSONB NOT NULL DEFAULT '{}',
    "expected_impact_json" JSONB NOT NULL DEFAULT '{}',
    "reason_json" JSONB NOT NULL DEFAULT '[]',
    "confidence" DECIMAL(5,2),
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "rejected_by" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_calendar_events" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "event_type" TEXT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "expected_impact" TEXT,
    "impact_score" DECIMAL(5,2),
    "source" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demand_calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_profitability_snapshots" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "gross_revenue" DECIMAL(12,2),
    "commission_cost" DECIMAL(12,2),
    "payment_cost" DECIMAL(12,2),
    "operating_cost" DECIMAL(12,2),
    "net_revenue" DECIMAL(12,2),
    "profit" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_profitability_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_daily_snapshots" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "room_type_id" TEXT,
    "rate_plan_id" TEXT,
    "channel_id" TEXT,
    "segment" TEXT,
    "market" TEXT,
    "total_occ" INTEGER NOT NULL DEFAULT 0,
    "arrival_rooms" INTEGER NOT NULL DEFAULT 0,
    "departure_rooms" INTEGER NOT NULL DEFAULT 0,
    "comp_rooms" INTEGER NOT NULL DEFAULT 0,
    "house_use_rooms" INTEGER NOT NULL DEFAULT 0,
    "day_use_rooms" INTEGER NOT NULL DEFAULT 0,
    "no_show_rooms" INTEGER NOT NULL DEFAULT 0,
    "ooo_rooms" INTEGER NOT NULL DEFAULT 0,
    "deduct_individual_rooms" INTEGER NOT NULL DEFAULT 0,
    "non_deduct_individual_rooms" INTEGER NOT NULL DEFAULT 0,
    "deduct_group_rooms" INTEGER NOT NULL DEFAULT 0,
    "non_deduct_group_rooms" INTEGER NOT NULL DEFAULT 0,
    "adults_children" INTEGER NOT NULL DEFAULT 0,
    "room_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_room_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gross_operating_profit" DECIMAL(12,2),
    "adr" DECIMAL(12,2),
    "revpar" DECIMAL(12,2),
    "trevpar" DECIMAL(12,2),
    "goppar" DECIMAL(12,2),
    "occupancy_percent" DECIMAL(5,2),
    "data_source" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_daily_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_forecast_snapshots" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "forecast_date" TIMESTAMP(3) NOT NULL,
    "room_type_id" TEXT,
    "rate_plan_id" TEXT,
    "channel_id" TEXT,
    "segment" TEXT,
    "market" TEXT,
    "expected_total_occ" DECIMAL(8,2),
    "expected_arrival_rooms" DECIMAL(8,2),
    "expected_departure_rooms" DECIMAL(8,2),
    "expected_comp_rooms" DECIMAL(8,2),
    "expected_house_use_rooms" DECIMAL(8,2),
    "expected_day_use_rooms" DECIMAL(8,2),
    "expected_no_show_rooms" DECIMAL(8,2),
    "expected_ooo_rooms" DECIMAL(8,2),
    "expected_deduct_individual_rooms" DECIMAL(8,2),
    "expected_non_deduct_individual_rooms" DECIMAL(8,2),
    "expected_deduct_group_rooms" DECIMAL(8,2),
    "expected_non_deduct_group_rooms" DECIMAL(8,2),
    "expected_adults_children" DECIMAL(8,2),
    "expected_room_revenue" DECIMAL(12,2),
    "expected_total_revenue" DECIMAL(12,2),
    "expected_net_room_revenue" DECIMAL(12,2),
    "expected_gross_operating_profit" DECIMAL(12,2),
    "expected_adr" DECIMAL(12,2),
    "expected_revpar" DECIMAL(12,2),
    "expected_trevpar" DECIMAL(12,2),
    "expected_goppar" DECIMAL(12,2),
    "expected_occupancy_percent" DECIMAL(5,2),
    "confidence" DECIMAL(5,2),
    "confidence_low_json" JSONB NOT NULL DEFAULT '{}',
    "confidence_high_json" JSONB NOT NULL DEFAULT '{}',
    "drivers_json" JSONB NOT NULL DEFAULT '[]',
    "model_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_forecast_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_report_views" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "report_type" TEXT NOT NULL DEFAULT 'history_forecast',
    "filters_json" JSONB NOT NULL DEFAULT '{}',
    "layout_json" JSONB NOT NULL DEFAULT '{}',
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_report_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_profiles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "primary_guest_id" TEXT,
    "display_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "preferred_language" TEXT,
    "vip_level" TEXT,
    "lifetime_value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_stays" INTEGER NOT NULL DEFAULT 0,
    "total_nights" INTEGER NOT NULL DEFAULT 0,
    "total_spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "preferences_json" JSONB NOT NULL DEFAULT '{}',
    "consent_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_profile_links" (
    "id" TEXT NOT NULL,
    "guest_profile_id" TEXT NOT NULL,
    "guest_id" TEXT NOT NULL,
    "link_confidence" DECIMAL(5,2),
    "link_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_profile_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_campaigns" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaign_type" TEXT NOT NULL,
    "segment_id" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "schedule_json" JSONB NOT NULL DEFAULT '{}',
    "content_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_programs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_memberships" (
    "id" TEXT NOT NULL,
    "loyalty_program_id" TEXT NOT NULL,
    "guest_profile_id" TEXT NOT NULL,
    "tier" TEXT,
    "points_balance" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT,
    "contact_json" JSONB NOT NULL DEFAULT '{}',
    "billing_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_opportunities" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "account_id" TEXT,
    "name" TEXT NOT NULL,
    "opportunity_type" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "estimated_value" DECIMAL(12,2),
    "expected_close_date" TIMESTAMP(3),
    "owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_bookings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "account_id" TEXT,
    "opportunity_id" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "arrival_date" TIMESTAMP(3) NOT NULL,
    "departure_date" TIMESTAMP(3) NOT NULL,
    "release_date" TIMESTAMP(3),
    "master_folio_id" TEXT,
    "billing_rules_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_room_blocks" (
    "id" TEXT NOT NULL,
    "group_booking_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "blocked_count" INTEGER NOT NULL,
    "picked_up_count" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_spaces" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "space_id" TEXT,
    "capacity_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "group_booking_id" TEXT,
    "event_space_id" TEXT,
    "name" TEXT NOT NULL,
    "event_type" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "setup_json" JSONB NOT NULL DEFAULT '{}',
    "catering_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_orders" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "order_type" TEXT NOT NULL,
    "content_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "employee_code" TEXT,
    "department_id" TEXT,
    "employment_type" TEXT,
    "hourly_cost" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "staff_profile_id" TEXT,
    "department_id" TEXT,
    "shift_date" TIMESTAMP(3) NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "role_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_clock_entries" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "staff_profile_id" TEXT NOT NULL,
    "clock_type" TEXT NOT NULL,
    "clock_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "device_id" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_clock_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "absence_requests" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "staff_profile_id" TEXT NOT NULL,
    "absence_type" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "absence_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labor_forecasts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "forecast_date" TIMESTAMP(3) NOT NULL,
    "department_id" TEXT,
    "required_staff_count" DECIMAL(8,2),
    "required_labor_hours" DECIMAL(8,2),
    "reason_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labor_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT,
    "contact_json" JSONB NOT NULL DEFAULT '{}',
    "payment_terms_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location_type" TEXT NOT NULL,
    "room_id" TEXT,
    "space_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit" TEXT NOT NULL,
    "default_supplier_id" TEXT,
    "min_level" DECIMAL(12,2),
    "max_level" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "stock_location_id" TEXT NOT NULL,
    "movement_type" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "source_type" TEXT,
    "source_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "approved_by" TEXT,
    "ordered_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "inventory_item_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_portal_sessions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_portal_actions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "action_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_portal_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upsell_offers" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "offer_type" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "tax_code" TEXT,
    "availability_rules_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upsell_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_upsell_purchases" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "upsell_offer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_upsell_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_sources" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_reviews" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "source" TEXT NOT NULL,
    "rating" DECIMAL(3,2),
    "title" TEXT,
    "body" TEXT,
    "language" TEXT,
    "sentiment" TEXT,
    "topics_json" JSONB NOT NULL DEFAULT '{}',
    "external_reference" TEXT,
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "survey_type" TEXT NOT NULL,
    "questions_json" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" TEXT NOT NULL,
    "survey_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "responses_json" JSONB NOT NULL DEFAULT '{}',
    "score" DECIMAL(5,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_cases" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "room_id" TEXT,
    "case_type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "quality_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_meters" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "meter_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "building_id" TEXT,
    "floor_id" TEXT,
    "zone_id" TEXT,
    "unit" TEXT NOT NULL,
    "provider" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utility_meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "utility_readings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "meter_id" TEXT NOT NULL,
    "reading_date" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "utility_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sustainability_metrics" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "metric_date" TIMESTAMP(3) NOT NULL,
    "metric_code" TEXT NOT NULL,
    "value" DECIMAL(14,4),
    "unit" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sustainability_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sustainability_actions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "estimated_cost" DECIMAL(12,2),
    "estimated_savings" DECIMAL(12,2),
    "linked_capex_project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sustainability_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_incidents" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "incident_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location_entity_type" TEXT,
    "location_entity_id" TEXT,
    "guest_id" TEXT,
    "reservation_id" TEXT,
    "reported_by" TEXT,
    "assigned_to" TEXT,
    "occurred_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "safety_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_evidence" (
    "id" TEXT NOT NULL,
    "incident_id" TEXT NOT NULL,
    "evidence_type" TEXT NOT NULL,
    "object_key" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_checks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "frequency" TEXT,
    "location_entity_type" TEXT,
    "location_entity_id" TEXT,
    "assigned_to" TEXT,
    "next_due_date" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_check_results" (
    "id" TEXT NOT NULL,
    "safety_check_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "completed_by" TEXT,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_definitions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "metric_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "formula_json" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "metric_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "metric_code" TEXT NOT NULL,
    "value" DECIMAL(14,4),
    "dimensions_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "anomaly_type" TEXT NOT NULL,
    "metric_code" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "anomaly_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "name" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "schedule_json" JSONB NOT NULL DEFAULT '{}',
    "recipients_json" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "developer_apps" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "app_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "client_id" TEXT NOT NULL,
    "client_secret_hash" TEXT,
    "scopes" TEXT[],
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "developer_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "developer_app_id" TEXT NOT NULL,
    "property_id" TEXT,
    "event_types" TEXT[],
    "target_url" TEXT NOT NULL,
    "secret_ref" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_subscription_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "response_status" INTEGER,
    "error_message" TEXT,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage_logs" (
    "id" TEXT NOT NULL,
    "developer_app_id" TEXT,
    "organization_id" TEXT,
    "property_id" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status_code" INTEGER,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "policy_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_registry" (
    "id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "module_code" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "input_schema_version" TEXT,
    "output_schema_version" TEXT,
    "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prompt_versions" (
    "id" TEXT NOT NULL,
    "prompt_code" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_evaluations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "property_id" TEXT,
    "evaluation_name" TEXT NOT NULL,
    "evaluation_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "results_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_incidents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "incident_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "related_ai_tool_call_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "ai_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_human_review_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "review_type" TEXT NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assigned_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_human_review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "integration_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_providers" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "auth_type" TEXT NOT NULL,
    "supported_regions" TEXT[],
    "capabilities_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "credentials_secret_ref" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buildings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "building_id" TEXT,
    "name" TEXT NOT NULL,
    "floor_number" INTEGER,
    "code" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_zones" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "building_id" TEXT,
    "floor_id" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "zone_type" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_spaces" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "building_id" TEXT,
    "floor_id" TEXT,
    "zone_id" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "space_type" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_map_positions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "floor_id" TEXT,
    "x" DECIMAL(10,2) NOT NULL,
    "y" DECIMAL(10,2) NOT NULL,
    "width" DECIMAL(10,2),
    "height" DECIMAL(10,2),
    "rotation" DECIMAL(10,2),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_map_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate_plan_type" TEXT NOT NULL,
    "parent_rate_plan_id" TEXT,
    "derivation_json" JSONB NOT NULL DEFAULT '{}',
    "cancellation_policy_id" TEXT,
    "meal_plan" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'inactive',
    "commission_percent" DECIMAL(5,2),
    "payment_cost_percent" DECIMAL(5,2),
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "credentials_secret_ref" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_room_mappings" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "external_room_code" TEXT NOT NULL,
    "external_room_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "channel_room_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_rate_mappings" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    "external_rate_code" TEXT NOT NULL,
    "external_rate_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "channel_rate_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_days" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total_inventory" INTEGER NOT NULL,
    "available_count" INTEGER NOT NULL,
    "out_of_order_count" INTEGER NOT NULL DEFAULT 0,
    "overbooking_limit" INTEGER NOT NULL DEFAULT 0,
    "stop_sell" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restriction_days" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "rate_plan_id" TEXT,
    "channel_id" TEXT,
    "date" DATE NOT NULL,
    "min_stay" INTEGER,
    "max_stay" INTEGER,
    "closed_to_arrival" BOOLEAN NOT NULL DEFAULT false,
    "closed_to_departure" BOOLEAN NOT NULL DEFAULT false,
    "stop_sell" BOOLEAN NOT NULL DEFAULT false,
    "restriction_source" TEXT NOT NULL DEFAULT 'manual',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restriction_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_days" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "min_price" DECIMAL(12,2),
    "max_price" DECIMAL(12,2),
    "manually_overridden" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "restrictions_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "rate_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sync_jobs" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "sync_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "date_range_start" DATE,
    "date_range_end" DATE,
    "request_payload_json" JSONB NOT NULL DEFAULT '{}',
    "response_payload_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "idempotency_key" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_hotels" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location_json" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT,
    "star_rating" DECIMAL(3,1),
    "comparable_score" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_rate_snapshots" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "competitor_hotel_id" TEXT,
    "source_channel" TEXT,
    "shop_date" DATE NOT NULL,
    "stay_date" DATE NOT NULL,
    "room_type_label" TEXT,
    "rate_plan_label" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "availability_status" TEXT,
    "cancellation_policy_label" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_parity_alerts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "alert_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "source_channel" TEXT,
    "direct_rate" DECIMAL(12,2),
    "channel_rate" DECIMAL(12,2),
    "currency" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_parity_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_automation_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "automation_level" TEXT NOT NULL,
    "scope_json" JSONB NOT NULL DEFAULT '{}',
    "constraints_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_scenarios" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scenario_type" TEXT NOT NULL,
    "input_json" JSONB NOT NULL DEFAULT '{}',
    "output_json" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_reservations" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "channel_id" TEXT,
    "external_reservation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "guest_name" TEXT,
    "arrival_date" DATE,
    "departure_date" DATE,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_provider_connections" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "credentials_secret_ref" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "folio_id" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "provider_reference" TEXT,
    "payment_link_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "approved_by" TEXT,
    "provider_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlets" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outlet_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "outlets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_products" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "outlet_id" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "tax_code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pos_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_orders" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "outlet_id" TEXT NOT NULL,
    "room_id" TEXT,
    "reservation_id" TEXT,
    "status" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_lines" (
    "id" TEXT NOT NULL,
    "pos_order_id" TEXT NOT NULL,
    "product_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "pos_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_property_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "user_property_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_types" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "max_occupancy" INTEGER NOT NULL,
    "base_capacity" INTEGER NOT NULL,
    "description" TEXT,
    "default_bed_configuration_json" JSONB NOT NULL DEFAULT '{}',
    "default_amenities_json" JSONB NOT NULL DEFAULT '{}',
    "default_photos_json" JSONB NOT NULL DEFAULT '{}',
    "default_rate_category" TEXT,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "building_id" TEXT,
    "floor_id" TEXT,
    "zone_id" TEXT,
    "number" TEXT NOT NULL,
    "floor" TEXT,
    "room_code" TEXT,
    "display_name" TEXT,
    "max_occupancy" INTEGER,
    "standard_occupancy" INTEGER,
    "bed_configuration_json" JSONB NOT NULL DEFAULT '{}',
    "features_json" JSONB NOT NULL DEFAULT '{}',
    "accessibility_json" JSONB NOT NULL DEFAULT '{}',
    "view_type" TEXT,
    "orientation" TEXT,
    "square_meters" DECIMAL(10,2),
    "status" "RoomStatus" NOT NULL DEFAULT 'clean',
    "housekeeping_status" TEXT,
    "maintenance_status" TEXT,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_features" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "room_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_feature_assignments" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "room_feature_id" TEXT NOT NULL,

    CONSTRAINT "room_feature_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_types" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bed_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_definitions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_group" TEXT NOT NULL,
    "entity_type" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'property_extendable',
    "value_schema_json" JSONB NOT NULL DEFAULT '{}',
    "is_core" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_category_options" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "category_definition_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "color_token" TEXT,
    "icon_name" TEXT,
    "parent_option_id" TEXT,
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "is_system_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_category_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_category_option_translations" (
    "id" TEXT NOT NULL,
    "category_option_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "property_category_option_translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_custom_field_definitions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "data_type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "visible_in_list" BOOLEAN NOT NULL DEFAULT false,
    "visible_in_detail" BOOLEAN NOT NULL DEFAULT true,
    "options_category_definition_id" TEXT,
    "validation_json" JSONB NOT NULL DEFAULT '{}',
    "visibility_rules_json" JSONB NOT NULL DEFAULT '{}',
    "default_value_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_custom_field_values" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field_definition_id" TEXT NOT NULL,
    "value_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_beds" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "bed_type_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "room_beds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "surname_1" TEXT,
    "surname_2" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "nationality" TEXT,
    "document_type" TEXT,
    "document_number" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "residence_address" TEXT,
    "gdpr_consent_flags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'draft',
    "arrival_date" DATE NOT NULL,
    "departure_date" DATE NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "room_type_id" TEXT,
    "assigned_room_id" TEXT,
    "rate_plan_id" TEXT,
    "market_segment" TEXT,
    "source_code" TEXT,
    "guarantee_type" TEXT,
    "cancellation_policy_code" TEXT,
    "billing_instruction" TEXT,
    "booker_name" TEXT,
    "booker_email" TEXT,
    "notes" TEXT,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "cancellation_policy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_resources" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "room_id" TEXT,
    "space_id" TEXT,
    "asset_id" TEXT,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "bookable" BOOLEAN NOT NULL DEFAULT true,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "hourly_bookable" BOOLEAN NOT NULL DEFAULT false,
    "daily_bookable" BOOLEAN NOT NULL DEFAULT true,
    "monthly_bookable" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'available',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_resources" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "inventory_resource_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "pricing_mode" TEXT NOT NULL DEFAULT 'nightly',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_guests" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "guest_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "relationship_type" TEXT,

    CONSTRAINT "reservation_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stays" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "checkin_at" TIMESTAMP(3),
    "checkout_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "stays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "guest_id" TEXT,
    "status" "FolioStatus" NOT NULL DEFAULT 'open',
    "currency" TEXT NOT NULL DEFAULT 'EUR',

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_lines" (
    "id" TEXT NOT NULL,
    "folio_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_code" TEXT,
    "total" DECIMAL(12,2) NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "posted_by" TEXT,

    CONSTRAINT "folio_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "folio_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "method" TEXT NOT NULL,
    "psp_reference" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "invoice_number" TEXT,
    "invoice_type" TEXT NOT NULL,
    "customer_type" TEXT NOT NULL,
    "customer_tax_id" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "issued_at" TIMESTAMP(3),
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "verifactu_hash" TEXT,
    "previous_invoice_hash" TEXT,
    "qr_payload" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "tax_code" TEXT NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "parent_id" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "status" "JournalStatus" NOT NULL DEFAULT 'draft',
    "posted_at" TIMESTAMP(3),
    "created_by" TEXT,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "journal_entry_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "description" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_bills" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "invoice_number" TEXT,
    "issue_date" DATE,
    "due_date" DATE,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "document_object_key" TEXT,

    CONSTRAINT "supplier_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_tasks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" "HousekeepingTaskStatus" NOT NULL DEFAULT 'pending',
    "assigned_to" TEXT,
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "note" TEXT,
    "photo_object_key" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "housekeeping_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_sections" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "housekeeping_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_section_rooms" (
    "id" TEXT NOT NULL,
    "housekeeping_section_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,

    CONSTRAINT "housekeeping_section_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "housekeeping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "building_id" TEXT,
    "floor_id" TEXT,
    "zone_id" TEXT,
    "space_id" TEXT,
    "room_id" TEXT,
    "asset_type" TEXT NOT NULL,
    "asset_code" TEXT,
    "name" TEXT NOT NULL,
    "serial_number" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "installation_date" DATE,
    "warranty_until" DATE,
    "purchase_cost" DECIMAL(12,2),
    "useful_life_months" INTEGER,
    "qr_code_value" TEXT,
    "supplier_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_id" TEXT,
    "asset_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" "WorkOrderStatus" NOT NULL DEFAULT 'open',
    "blocks_room" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "assigned_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_media" (
    "id" TEXT NOT NULL,
    "work_order_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,

    CONSTRAINT "work_order_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_areas" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "maintenance_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_area_rooms" (
    "id" TEXT NOT NULL,
    "maintenance_area_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,

    CONSTRAINT "maintenance_area_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "rule_code" TEXT NOT NULL,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "maintenance_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_projects" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "budget" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "start_date" DATE,
    "target_end_date" DATE,
    "owner_approved_by" TEXT,

    CONSTRAINT "capex_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capex_items" (
    "id" TEXT NOT NULL,
    "capex_project_id" TEXT NOT NULL,
    "room_id" TEXT,
    "asset_id" TEXT,
    "description" TEXT NOT NULL,
    "estimated_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "actual_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',

    CONSTRAINT "capex_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_assets" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "asset_id" TEXT,
    "name" TEXT NOT NULL,
    "acquisition_date" DATE,
    "acquisition_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "depreciation_method" TEXT,
    "useful_life_months" INTEGER,
    "accumulated_depreciation" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "guest_id" TEXT,
    "reservation_id" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata_json" JSONB,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "attachment_type" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "privacy_review_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "request_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_department" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_register_records" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "record_type" TEXT NOT NULL DEFAULT 'checkin',
    "status" "ComplianceStatus" NOT NULL DEFAULT 'draft',
    "is_primary_guest" BOOLEAN NOT NULL DEFAULT false,
    "is_minor" BOOLEAN NOT NULL DEFAULT false,
    "provided_by_adult_guest_id" TEXT,
    "first_name" TEXT,
    "surname_1" TEXT,
    "surname_2" TEXT,
    "sex" TEXT,
    "nationality" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "document_type" TEXT,
    "document_number" TEXT,
    "document_support_number" TEXT,
    "residence_full_address" TEXT,
    "residence_locality" TEXT,
    "residence_country" TEXT,
    "phone_landline" TEXT,
    "phone_mobile" TEXT,
    "email" TEXT,
    "traveller_count" INTEGER,
    "kinship_relation_if_minor" TEXT,
    "contract_reference" TEXT,
    "contract_date" TIMESTAMP(3),
    "checkin_at" TIMESTAMP(3),
    "checkout_at" TIMESTAMP(3),
    "property_full_address" TEXT,
    "contracted_room_count" INTEGER,
    "internet_connection" BOOLEAN,
    "payment_type" TEXT,
    "payment_method_identifier" TEXT,
    "payment_holder" TEXT,
    "payment_card_expiry_month" INTEGER,
    "payment_card_expiry_year" INTEGER,
    "payment_date" TIMESTAMP(3),
    "payment_reference" TEXT,
    "required_payload_json" JSONB NOT NULL,
    "validation_errors_json" JSONB NOT NULL DEFAULT '[]',
    "signature_required" BOOLEAN NOT NULL DEFAULT true,
    "signature_object_key" TEXT,
    "signed_at" TIMESTAMP(3),
    "identity_verified" BOOLEAN NOT NULL DEFAULT false,
    "identity_verified_by" TEXT,
    "identity_verified_at" TIMESTAMP(3),
    "identity_verification_method" TEXT,
    "id_image_stored" BOOLEAN NOT NULL DEFAULT false,
    "id_image_discarded" BOOLEAN NOT NULL DEFAULT false,
    "id_image_discarded_at" TIMESTAMP(3),
    "retention_until" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_register_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ses_hospedajes_submissions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "guest_register_record_id" TEXT NOT NULL,
    "submission_type" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'queued',
    "request_payload_json" JSONB NOT NULL,
    "response_payload_json" JSONB,
    "error_message" TEXT,
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "ses_hospedajes_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_reporting_settings" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "region_code" TEXT,
    "authority_type" TEXT NOT NULL DEFAULT 'ses_hospedajes',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "professional_activity" BOOLEAN NOT NULL DEFAULT true,
    "establishment_code" TEXT,
    "landlord_code" TEXT,
    "web_service_enabled" BOOLEAN NOT NULL DEFAULT false,
    "web_service_username" TEXT,
    "web_service_secret_ref" TEXT,
    "batch_export_enabled" BOOLEAN NOT NULL DEFAULT true,
    "automatic_submission_enabled" BOOLEAN NOT NULL DEFAULT false,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_reporting_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lodging_legal_profiles" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "municipality" TEXT,
    "province" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "listing_url" TEXT,
    "establishment_type" TEXT,
    "establishment_name" TEXT,
    "full_address" TEXT NOT NULL,
    "postal_code" TEXT,
    "locality" TEXT,
    "establishment_province" TEXT,
    "room_count" INTEGER,
    "internet_connection" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lodging_legal_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_submission_batches" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "authority_type" TEXT NOT NULL,
    "batch_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "period_from" TIMESTAMP(3),
    "period_to" TIMESTAMP(3),
    "file_format" TEXT,
    "file_object_key" TEXT,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT,
    "generated_by" TEXT,
    "submitted_by" TEXT,
    "generated_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "response_received_at" TIMESTAMP(3),
    "response_payload_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_submission_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_submission_batch_records" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "guest_register_record_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'included',
    "response_payload_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,

    CONSTRAINT "authority_submission_batch_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_submissions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "guest_register_record_id" TEXT,
    "batch_id" TEXT,
    "authority_type" TEXT NOT NULL,
    "submission_type" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'queued',
    "external_reference" TEXT,
    "request_payload_json" JSONB NOT NULL DEFAULT '{}',
    "response_payload_json" JSONB NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "error_message" TEXT,
    "submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authority_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_document_processing_events" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "guest_id" TEXT,
    "event_type" TEXT NOT NULL,
    "processor" TEXT,
    "fields_extracted_json" JSONB NOT NULL DEFAULT '{}',
    "confidence_json" JSONB NOT NULL DEFAULT '{}',
    "image_stored" BOOLEAN NOT NULL DEFAULT false,
    "image_discarded" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_document_processing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_routing_rules" (
    "id" TEXT NOT NULL,
    "property_id" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ES',
    "region_code" TEXT,
    "authority_type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "configuration_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authority_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "name" TEXT NOT NULL,
    "source_system" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "target_go_live_date" DATE,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_source_connections" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentials_secret_ref" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "last_tested_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_source_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_files" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" TEXT,
    "object_key" TEXT NOT NULL,
    "detected_document_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "extraction_status" TEXT NOT NULL DEFAULT 'not_started',
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_extracted_entities" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "onboarding_file_id" TEXT,
    "source_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "source_identifier" TEXT,
    "raw_json" JSONB NOT NULL DEFAULT '{}',
    "normalized_json" JSONB NOT NULL DEFAULT '{}',
    "confidence" DECIMAL(5,2),
    "status" TEXT NOT NULL DEFAULT 'extracted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_extracted_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_mapping_suggestions" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "source_entity_id" TEXT,
    "target_entity_type" TEXT NOT NULL,
    "suggested_target_json" JSONB NOT NULL DEFAULT '{}',
    "confidence" DECIMAL(5,2),
    "risk_level" TEXT NOT NULL DEFAULT 'medium',
    "reason_json" JSONB NOT NULL DEFAULT '[]',
    "warnings_json" JSONB NOT NULL DEFAULT '[]',
    "missing_data_json" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_mapping_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_migration_batches" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "batch_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dry_run_result_json" JSONB NOT NULL DEFAULT '{}',
    "applied_result_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_by" TEXT,
    "applied_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "onboarding_migration_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_migration_batch_records" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "mapping_suggestion_id" TEXT,
    "target_entity_type" TEXT NOT NULL,
    "target_entity_id" TEXT,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "before_json" JSONB NOT NULL DEFAULT '{}',
    "after_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_migration_batch_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_onboarding_runs" (
    "id" TEXT NOT NULL,
    "onboarding_project_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input_json" JSONB NOT NULL DEFAULT '{}',
    "output_json" JSONB NOT NULL DEFAULT '{}',
    "confidence" DECIMAL(5,2),
    "trace_id" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ai_onboarding_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "actor_user_id" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before_json" JSONB,
    "after_json" JSONB,
    "ip_address" TEXT,
    "device_id" TEXT,
    "correlation_id" TEXT,
    "hash_algorithm" TEXT NOT NULL DEFAULT 'sha256',
    "previous_hash" TEXT,
    "current_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_calls" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT,
    "user_id" TEXT,
    "conversation_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "input_json" JSONB NOT NULL,
    "output_json" JSONB,
    "confidence" DECIMAL(5,4),
    "required_confirmation" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_stream" (
    "event_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "hash_algorithm" TEXT NOT NULL DEFAULT 'sha256',
    "previous_hash" TEXT,
    "current_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_stream_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "properties_organization_id_idx" ON "properties"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- CreateIndex
CREATE INDEX "devices_user_id_trusted_idx" ON "devices"("user_id", "trusted");

-- CreateIndex
CREATE INDEX "sessions_user_id_status_idx" ON "sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_status_expires_at_idx" ON "mfa_challenges"("user_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_created_at_idx" ON "notifications"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "offline_sync_records_property_id_device_id_created_at_idx" ON "offline_sync_records"("property_id", "device_id", "created_at");

-- CreateIndex
CREATE INDEX "worker_job_runs_status_scheduled_for_idx" ON "worker_job_runs"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "worker_job_runs_job_name_status_idx" ON "worker_job_runs"("job_name", "status");

-- CreateIndex
CREATE INDEX "retention_policies_entity_type_enabled_idx" ON "retention_policies"("entity_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_organization_id_property_id_entity_type_key" ON "retention_policies"("organization_id", "property_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "modules_code_key" ON "modules"("code");

-- CreateIndex
CREATE INDEX "modules_category_is_core_idx" ON "modules"("category", "is_core");

-- CreateIndex
CREATE INDEX "property_modules_property_id_status_idx" ON "property_modules"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "property_modules_property_id_module_id_key" ON "property_modules"("property_id", "module_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_dependencies_module_id_required_module_id_key" ON "module_dependencies"("module_id", "required_module_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_health_checks_property_id_module_code_check_code_key" ON "module_health_checks"("property_id", "module_code", "check_code");

-- CreateIndex
CREATE UNIQUE INDEX "property_setup_steps_property_id_step_code_key" ON "property_setup_steps"("property_id", "step_code");

-- CreateIndex
CREATE INDEX "property_setup_form_submissions_property_id_form_code_creat_idx" ON "property_setup_form_submissions"("property_id", "form_code", "created_at");

-- CreateIndex
CREATE INDEX "manual_setup_submissions_property_id_option_code_created_at_idx" ON "manual_setup_submissions"("property_id", "option_code", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "property_readiness_checks_property_id_check_code_key" ON "property_readiness_checks"("property_id", "check_code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_property_id_code_key" ON "departments"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "user_departments_user_id_department_id_key" ON "user_departments"("user_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_compliance_settings_property_id_key" ON "property_compliance_settings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_sequences_property_id_sequence_code_key" ON "invoice_sequences"("property_id", "sequence_code");

-- CreateIndex
CREATE INDEX "accounting_settings_organization_id_property_id_idx" ON "accounting_settings"("organization_id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_property_id_code_key" ON "cost_centers"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "property_ai_settings_property_id_key" ON "property_ai_settings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_ai_tool_settings_property_id_tool_name_key" ON "property_ai_tool_settings"("property_id", "tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_property_id_template_code_language_key" ON "document_templates"("property_id", "template_code", "language");

-- CreateIndex
CREATE UNIQUE INDEX "qr_codes_property_id_entity_type_entity_id_purpose_key" ON "qr_codes"("property_id", "entity_type", "entity_id", "purpose");

-- CreateIndex
CREATE INDEX "property_imports_property_id_import_type_status_idx" ON "property_imports"("property_id", "import_type", "status");

-- CreateIndex
CREATE INDEX "backoffice_ai_suggestions_property_id_status_created_at_idx" ON "backoffice_ai_suggestions"("property_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "revenue_forecasts_property_id_forecast_date_idx" ON "revenue_forecasts"("property_id", "forecast_date");

-- CreateIndex
CREATE INDEX "revenue_recommendations_property_id_status_target_date_idx" ON "revenue_recommendations"("property_id", "status", "target_date");

-- CreateIndex
CREATE INDEX "demand_calendar_events_property_id_start_date_end_date_idx" ON "demand_calendar_events"("property_id", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "channel_profitability_snapshots_property_id_date_channel_idx" ON "channel_profitability_snapshots"("property_id", "date", "channel");

-- CreateIndex
CREATE INDEX "revenue_daily_snapshots_property_id_snapshot_date_idx" ON "revenue_daily_snapshots"("property_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_daily_snapshots_property_id_snapshot_date_room_type_key" ON "revenue_daily_snapshots"("property_id", "snapshot_date", "room_type_id", "rate_plan_id", "channel_id", "segment", "market");

-- CreateIndex
CREATE INDEX "revenue_forecast_snapshots_property_id_forecast_date_idx" ON "revenue_forecast_snapshots"("property_id", "forecast_date");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_forecast_snapshots_property_id_forecast_date_room_t_key" ON "revenue_forecast_snapshots"("property_id", "forecast_date", "room_type_id", "rate_plan_id", "channel_id", "segment", "market", "model_version");

-- CreateIndex
CREATE INDEX "revenue_report_views_property_id_report_type_is_shared_idx" ON "revenue_report_views"("property_id", "report_type", "is_shared");

-- CreateIndex
CREATE INDEX "guest_profiles_organization_id_email_idx" ON "guest_profiles"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "guest_profile_links_guest_profile_id_guest_id_key" ON "guest_profile_links"("guest_profile_id", "guest_id");

-- CreateIndex
CREATE INDEX "crm_segments_organization_id_active_idx" ON "crm_segments"("organization_id", "active");

-- CreateIndex
CREATE INDEX "crm_campaigns_organization_id_status_idx" ON "crm_campaigns"("organization_id", "status");

-- CreateIndex
CREATE INDEX "loyalty_programs_organization_id_active_idx" ON "loyalty_programs"("organization_id", "active");

-- CreateIndex
CREATE INDEX "loyalty_memberships_loyalty_program_id_guest_profile_id_idx" ON "loyalty_memberships"("loyalty_program_id", "guest_profile_id");

-- CreateIndex
CREATE INDEX "sales_accounts_organization_id_status_idx" ON "sales_accounts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sales_opportunities_property_id_stage_idx" ON "sales_opportunities"("property_id", "stage");

-- CreateIndex
CREATE INDEX "group_bookings_property_id_status_arrival_date_idx" ON "group_bookings"("property_id", "status", "arrival_date");

-- CreateIndex
CREATE INDEX "group_room_blocks_group_booking_id_date_idx" ON "group_room_blocks"("group_booking_id", "date");

-- CreateIndex
CREATE INDEX "event_spaces_property_id_active_idx" ON "event_spaces"("property_id", "active");

-- CreateIndex
CREATE INDEX "events_property_id_start_at_end_at_idx" ON "events"("property_id", "start_at", "end_at");

-- CreateIndex
CREATE INDEX "event_orders_event_id_status_idx" ON "event_orders"("event_id", "status");

-- CreateIndex
CREATE INDEX "staff_profiles_property_id_active_idx" ON "staff_profiles"("property_id", "active");

-- CreateIndex
CREATE INDEX "shifts_property_id_shift_date_idx" ON "shifts"("property_id", "shift_date");

-- CreateIndex
CREATE INDEX "time_clock_entries_property_id_staff_profile_id_clock_at_idx" ON "time_clock_entries"("property_id", "staff_profile_id", "clock_at");

-- CreateIndex
CREATE INDEX "absence_requests_property_id_status_start_date_idx" ON "absence_requests"("property_id", "status", "start_date");

-- CreateIndex
CREATE INDEX "labor_forecasts_property_id_forecast_date_idx" ON "labor_forecasts"("property_id", "forecast_date");

-- CreateIndex
CREATE INDEX "suppliers_organization_id_active_idx" ON "suppliers"("organization_id", "active");

-- CreateIndex
CREATE INDEX "stock_locations_property_id_active_idx" ON "stock_locations"("property_id", "active");

-- CreateIndex
CREATE INDEX "inventory_items_property_id_active_idx" ON "inventory_items"("property_id", "active");

-- CreateIndex
CREATE INDEX "stock_movements_property_id_inventory_item_id_created_at_idx" ON "stock_movements"("property_id", "inventory_item_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_orders_property_id_status_idx" ON "purchase_orders"("property_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchase_order_id_idx" ON "purchase_order_lines"("purchase_order_id");

-- CreateIndex
CREATE INDEX "guest_portal_sessions_property_id_status_expires_at_idx" ON "guest_portal_sessions"("property_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "guest_portal_actions_property_id_action_type_status_idx" ON "guest_portal_actions"("property_id", "action_type", "status");

-- CreateIndex
CREATE INDEX "upsell_offers_property_id_active_idx" ON "upsell_offers"("property_id", "active");

-- CreateIndex
CREATE INDEX "guest_upsell_purchases_property_id_status_idx" ON "guest_upsell_purchases"("property_id", "status");

-- CreateIndex
CREATE INDEX "review_sources_property_id_provider_idx" ON "review_sources"("property_id", "provider");

-- CreateIndex
CREATE INDEX "guest_reviews_property_id_rating_created_at_idx" ON "guest_reviews"("property_id", "rating", "created_at");

-- CreateIndex
CREATE INDEX "surveys_property_id_active_idx" ON "surveys"("property_id", "active");

-- CreateIndex
CREATE INDEX "survey_responses_survey_id_created_at_idx" ON "survey_responses"("survey_id", "created_at");

-- CreateIndex
CREATE INDEX "quality_cases_property_id_status_priority_idx" ON "quality_cases"("property_id", "status", "priority");

-- CreateIndex
CREATE INDEX "utility_meters_property_id_meter_type_active_idx" ON "utility_meters"("property_id", "meter_type", "active");

-- CreateIndex
CREATE INDEX "utility_readings_property_id_meter_id_reading_date_idx" ON "utility_readings"("property_id", "meter_id", "reading_date");

-- CreateIndex
CREATE INDEX "sustainability_metrics_property_id_metric_code_metric_date_idx" ON "sustainability_metrics"("property_id", "metric_code", "metric_date");

-- CreateIndex
CREATE INDEX "sustainability_actions_property_id_status_idx" ON "sustainability_actions"("property_id", "status");

-- CreateIndex
CREATE INDEX "safety_incidents_property_id_status_severity_idx" ON "safety_incidents"("property_id", "status", "severity");

-- CreateIndex
CREATE INDEX "incident_evidence_incident_id_idx" ON "incident_evidence"("incident_id");

-- CreateIndex
CREATE INDEX "safety_checks_property_id_active_next_due_date_idx" ON "safety_checks"("property_id", "active", "next_due_date");

-- CreateIndex
CREATE INDEX "safety_check_results_safety_check_id_completed_at_idx" ON "safety_check_results"("safety_check_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "metric_definitions_organization_id_metric_code_key" ON "metric_definitions"("organization_id", "metric_code");

-- CreateIndex
CREATE INDEX "analytics_snapshots_organization_id_property_id_snapshot_da_idx" ON "analytics_snapshots"("organization_id", "property_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "anomaly_events_organization_id_property_id_status_idx" ON "anomaly_events"("organization_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "scheduled_reports_organization_id_property_id_active_idx" ON "scheduled_reports"("organization_id", "property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "developer_apps_client_id_key" ON "developer_apps"("client_id");

-- CreateIndex
CREATE INDEX "developer_apps_organization_id_status_idx" ON "developer_apps"("organization_id", "status");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_developer_app_id_active_idx" ON "webhook_subscriptions"("developer_app_id", "active");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_subscription_id_status_attempted_idx" ON "webhook_deliveries"("webhook_subscription_id", "status", "attempted_at");

-- CreateIndex
CREATE INDEX "api_usage_logs_organization_id_property_id_created_at_idx" ON "api_usage_logs"("organization_id", "property_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_policies_organization_id_property_id_active_idx" ON "ai_policies"("organization_id", "property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ai_tool_registry_tool_name_key" ON "ai_tool_registry"("tool_name");

-- CreateIndex
CREATE INDEX "ai_tool_registry_module_code_active_idx" ON "ai_tool_registry"("module_code", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompt_versions_prompt_code_version_key" ON "ai_prompt_versions"("prompt_code", "version");

-- CreateIndex
CREATE INDEX "ai_evaluations_organization_id_property_id_status_idx" ON "ai_evaluations"("organization_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "ai_incidents_organization_id_property_id_status_idx" ON "ai_incidents"("organization_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "ai_human_review_items_organization_id_property_id_status_idx" ON "ai_human_review_items"("organization_id", "property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_categories_code_key" ON "integration_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "integration_providers_code_key" ON "integration_providers"("code");

-- CreateIndex
CREATE INDEX "integration_providers_category_id_idx" ON "integration_providers"("category_id");

-- CreateIndex
CREATE INDEX "integration_connections_property_id_status_idx" ON "integration_connections"("property_id", "status");

-- CreateIndex
CREATE INDEX "integration_events_connection_id_created_at_idx" ON "integration_events"("connection_id", "created_at");

-- CreateIndex
CREATE INDEX "buildings_property_id_active_sort_order_idx" ON "buildings"("property_id", "active", "sort_order");

-- CreateIndex
CREATE INDEX "floors_property_id_building_id_active_sort_order_idx" ON "floors"("property_id", "building_id", "active", "sort_order");

-- CreateIndex
CREATE INDEX "property_zones_property_id_building_id_floor_id_zone_type_idx" ON "property_zones"("property_id", "building_id", "floor_id", "zone_type");

-- CreateIndex
CREATE INDEX "property_spaces_property_id_building_id_floor_id_zone_id_idx" ON "property_spaces"("property_id", "building_id", "floor_id", "zone_id");

-- CreateIndex
CREATE INDEX "property_map_positions_property_id_floor_id_entity_type_idx" ON "property_map_positions"("property_id", "floor_id", "entity_type");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_code_key" ON "rate_plans"("property_id", "code");

-- CreateIndex
CREATE INDEX "channels_property_id_status_idx" ON "channels"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_room_mappings_channel_id_room_type_id_external_room_key" ON "channel_room_mappings"("channel_id", "room_type_id", "external_room_code");

-- CreateIndex
CREATE UNIQUE INDEX "channel_rate_mappings_channel_id_rate_plan_id_external_rate_key" ON "channel_rate_mappings"("channel_id", "rate_plan_id", "external_rate_code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_days_property_id_room_type_id_date_key" ON "inventory_days"("property_id", "room_type_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "restriction_days_property_id_room_type_id_rate_plan_id_chan_key" ON "restriction_days"("property_id", "room_type_id", "rate_plan_id", "channel_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "rate_days_property_id_rate_plan_id_room_type_id_date_key" ON "rate_days"("property_id", "rate_plan_id", "room_type_id", "date");

-- CreateIndex
CREATE INDEX "channel_sync_jobs_property_id_channel_id_status_idx" ON "channel_sync_jobs"("property_id", "channel_id", "status");

-- CreateIndex
CREATE INDEX "competitor_hotels_property_id_active_idx" ON "competitor_hotels"("property_id", "active");

-- CreateIndex
CREATE INDEX "competitor_rate_snapshots_property_id_stay_date_source_chan_idx" ON "competitor_rate_snapshots"("property_id", "stay_date", "source_channel");

-- CreateIndex
CREATE INDEX "rate_parity_alerts_property_id_severity_status_idx" ON "rate_parity_alerts"("property_id", "severity", "status");

-- CreateIndex
CREATE INDEX "revenue_automation_rules_property_id_active_idx" ON "revenue_automation_rules"("property_id", "active");

-- CreateIndex
CREATE INDEX "revenue_scenarios_property_id_scenario_type_created_at_idx" ON "revenue_scenarios"("property_id", "scenario_type", "created_at");

-- CreateIndex
CREATE INDEX "external_reservations_property_id_channel_id_status_idx" ON "external_reservations"("property_id", "channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "external_reservations_property_id_external_reservation_id_key" ON "external_reservations"("property_id", "external_reservation_id");

-- CreateIndex
CREATE INDEX "payment_provider_connections_property_id_status_idx" ON "payment_provider_connections"("property_id", "status");

-- CreateIndex
CREATE INDEX "payment_intents_property_id_status_idx" ON "payment_intents"("property_id", "status");

-- CreateIndex
CREATE INDEX "payment_refunds_payment_id_status_idx" ON "payment_refunds"("payment_id", "status");

-- CreateIndex
CREATE INDEX "outlets_property_id_status_idx" ON "outlets"("property_id", "status");

-- CreateIndex
CREATE INDEX "pos_products_property_id_active_idx" ON "pos_products"("property_id", "active");

-- CreateIndex
CREATE INDEX "pos_orders_property_id_status_idx" ON "pos_orders"("property_id", "status");

-- CreateIndex
CREATE INDEX "pos_order_lines_pos_order_id_idx" ON "pos_order_lines"("pos_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_name_key" ON "roles"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_property_roles_user_id_property_id_role_id_key" ON "user_property_roles"("user_id", "property_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_code_key" ON "room_types"("property_id", "code");

-- CreateIndex
CREATE INDEX "rooms_property_id_status_idx" ON "rooms"("property_id", "status");

-- CreateIndex
CREATE INDEX "rooms_property_id_building_id_floor_id_zone_id_idx" ON "rooms"("property_id", "building_id", "floor_id", "zone_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_property_id_number_key" ON "rooms"("property_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "room_features_property_id_code_key" ON "room_features"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "room_feature_assignments_room_id_room_feature_id_key" ON "room_feature_assignments"("room_id", "room_feature_id");

-- CreateIndex
CREATE UNIQUE INDEX "bed_types_property_id_code_key" ON "bed_types"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "category_definitions_code_key" ON "category_definitions"("code");

-- CreateIndex
CREATE INDEX "property_category_options_property_id_category_definition_i_idx" ON "property_category_options"("property_id", "category_definition_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "property_category_options_property_id_category_definition_i_key" ON "property_category_options"("property_id", "category_definition_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "property_category_option_translations_category_option_id_la_key" ON "property_category_option_translations"("category_option_id", "language");

-- CreateIndex
CREATE INDEX "property_custom_field_definitions_property_id_entity_type_a_idx" ON "property_custom_field_definitions"("property_id", "entity_type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "property_custom_field_definitions_property_id_entity_type_f_key" ON "property_custom_field_definitions"("property_id", "entity_type", "field_key");

-- CreateIndex
CREATE INDEX "property_custom_field_values_property_id_entity_type_entity_idx" ON "property_custom_field_values"("property_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "property_custom_field_values_entity_type_entity_id_field_de_key" ON "property_custom_field_values"("entity_type", "entity_id", "field_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_beds_room_id_bed_type_id_key" ON "room_beds"("room_id", "bed_type_id");

-- CreateIndex
CREATE INDEX "guests_organization_id_document_number_idx" ON "guests"("organization_id", "document_number");

-- CreateIndex
CREATE INDEX "reservations_property_id_arrival_date_departure_date_idx" ON "reservations"("property_id", "arrival_date", "departure_date");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_property_id_code_key" ON "reservations"("property_id", "code");

-- CreateIndex
CREATE INDEX "inventory_resources_property_id_resource_type_status_idx" ON "inventory_resources"("property_id", "resource_type", "status");

-- CreateIndex
CREATE INDEX "inventory_resources_room_id_idx" ON "inventory_resources"("room_id");

-- CreateIndex
CREATE INDEX "inventory_resources_space_id_idx" ON "inventory_resources"("space_id");

-- CreateIndex
CREATE INDEX "reservation_resources_reservation_id_idx" ON "reservation_resources"("reservation_id");

-- CreateIndex
CREATE INDEX "reservation_resources_inventory_resource_id_start_at_end_at_idx" ON "reservation_resources"("inventory_resource_id", "start_at", "end_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_guests_reservation_id_guest_id_key" ON "reservation_guests"("reservation_id", "guest_id");

-- CreateIndex
CREATE INDEX "stays_reservation_id_idx" ON "stays"("reservation_id");

-- CreateIndex
CREATE INDEX "folios_reservation_id_idx" ON "folios"("reservation_id");

-- CreateIndex
CREATE INDEX "folio_lines_folio_id_idx" ON "folio_lines"("folio_id");

-- CreateIndex
CREATE INDEX "payments_property_id_folio_id_idx" ON "payments"("property_id", "folio_id");

-- CreateIndex
CREATE INDEX "invoices_property_id_status_idx" ON "invoices"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_property_id_invoice_number_key" ON "invoices"("property_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organization_id_code_key" ON "accounts"("organization_id", "code");

-- CreateIndex
CREATE INDEX "journal_entries_organization_id_property_id_idx" ON "journal_entries"("organization_id", "property_id");

-- CreateIndex
CREATE INDEX "journal_lines_journal_entry_id_idx" ON "journal_lines"("journal_entry_id");

-- CreateIndex
CREATE INDEX "supplier_bills_property_id_status_idx" ON "supplier_bills"("property_id", "status");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_property_id_room_id_status_idx" ON "housekeeping_tasks"("property_id", "room_id", "status");

-- CreateIndex
CREATE INDEX "housekeeping_events_task_id_idx" ON "housekeeping_events"("task_id");

-- CreateIndex
CREATE INDEX "housekeeping_sections_property_id_active_idx" ON "housekeeping_sections"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "housekeeping_section_rooms_housekeeping_section_id_room_id_key" ON "housekeeping_section_rooms"("housekeeping_section_id", "room_id");

-- CreateIndex
CREATE UNIQUE INDEX "housekeeping_rules_property_id_rule_code_key" ON "housekeeping_rules"("property_id", "rule_code");

-- CreateIndex
CREATE INDEX "assets_property_id_building_id_floor_id_zone_id_idx" ON "assets"("property_id", "building_id", "floor_id", "zone_id");

-- CreateIndex
CREATE INDEX "assets_property_id_room_id_idx" ON "assets"("property_id", "room_id");

-- CreateIndex
CREATE INDEX "work_orders_property_id_status_idx" ON "work_orders"("property_id", "status");

-- CreateIndex
CREATE INDEX "work_order_media_work_order_id_idx" ON "work_order_media"("work_order_id");

-- CreateIndex
CREATE INDEX "maintenance_areas_property_id_active_idx" ON "maintenance_areas"("property_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_area_rooms_maintenance_area_id_room_id_key" ON "maintenance_area_rooms"("maintenance_area_id", "room_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_rules_property_id_rule_code_key" ON "maintenance_rules"("property_id", "rule_code");

-- CreateIndex
CREATE INDEX "capex_projects_property_id_status_idx" ON "capex_projects"("property_id", "status");

-- CreateIndex
CREATE INDEX "capex_items_capex_project_id_idx" ON "capex_items"("capex_project_id");

-- CreateIndex
CREATE INDEX "fixed_assets_property_id_idx" ON "fixed_assets"("property_id");

-- CreateIndex
CREATE INDEX "conversations_property_id_status_idx" ON "conversations"("property_id", "status");

-- CreateIndex
CREATE INDEX "messages_conversation_id_idx" ON "messages"("conversation_id");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");

-- CreateIndex
CREATE INDEX "message_attachments_attachment_type_idx" ON "message_attachments"("attachment_type");

-- CreateIndex
CREATE INDEX "service_requests_property_id_status_idx" ON "service_requests"("property_id", "status");

-- CreateIndex
CREATE INDEX "guest_register_records_property_id_status_idx" ON "guest_register_records"("property_id", "status");

-- CreateIndex
CREATE INDEX "ses_hospedajes_submissions_property_id_status_idx" ON "ses_hospedajes_submissions"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "authority_reporting_settings_property_id_key" ON "authority_reporting_settings"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "lodging_legal_profiles_property_id_key" ON "lodging_legal_profiles"("property_id");

-- CreateIndex
CREATE INDEX "authority_submission_batches_property_id_status_idx" ON "authority_submission_batches"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "authority_submission_batch_records_batch_id_guest_register__key" ON "authority_submission_batch_records"("batch_id", "guest_register_record_id");

-- CreateIndex
CREATE INDEX "authority_submissions_property_id_status_idx" ON "authority_submissions"("property_id", "status");

-- CreateIndex
CREATE INDEX "identity_document_processing_events_property_id_event_type_idx" ON "identity_document_processing_events"("property_id", "event_type");

-- CreateIndex
CREATE INDEX "authority_routing_rules_country_region_code_active_idx" ON "authority_routing_rules"("country", "region_code", "active");

-- CreateIndex
CREATE INDEX "onboarding_projects_organization_id_property_id_status_idx" ON "onboarding_projects"("organization_id", "property_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_source_connections_onboarding_project_id_provide_idx" ON "onboarding_source_connections"("onboarding_project_id", "provider_code", "status");

-- CreateIndex
CREATE INDEX "onboarding_files_onboarding_project_id_status_extraction_st_idx" ON "onboarding_files"("onboarding_project_id", "status", "extraction_status");

-- CreateIndex
CREATE INDEX "onboarding_extracted_entities_onboarding_project_id_entity__idx" ON "onboarding_extracted_entities"("onboarding_project_id", "entity_type", "status");

-- CreateIndex
CREATE INDEX "onboarding_mapping_suggestions_onboarding_project_id_target_idx" ON "onboarding_mapping_suggestions"("onboarding_project_id", "target_entity_type", "status");

-- CreateIndex
CREATE INDEX "onboarding_migration_batches_onboarding_project_id_batch_ty_idx" ON "onboarding_migration_batches"("onboarding_project_id", "batch_type", "status");

-- CreateIndex
CREATE INDEX "onboarding_migration_batch_records_batch_id_target_entity_t_idx" ON "onboarding_migration_batch_records"("batch_id", "target_entity_type", "status");

-- CreateIndex
CREATE INDEX "ai_onboarding_runs_onboarding_project_id_agent_name_status_idx" ON "ai_onboarding_runs"("onboarding_project_id", "agent_name", "status");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_property_id_created_at_idx" ON "audit_events"("organization_id", "property_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_current_hash_idx" ON "audit_events"("current_hash");

-- CreateIndex
CREATE INDEX "ai_tool_calls_organization_id_property_id_created_at_idx" ON "ai_tool_calls"("organization_id", "property_id", "created_at");

-- CreateIndex
CREATE INDEX "event_stream_organization_id_property_id_created_at_idx" ON "event_stream"("organization_id", "property_id", "created_at");

-- CreateIndex
CREATE INDEX "event_stream_current_hash_idx" ON "event_stream"("current_hash");
