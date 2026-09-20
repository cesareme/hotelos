-- ============================================================================
-- 20260920150000_checkin_automatizado · Check-in automatizado y recepcionista IA (Tanda CHK · W1-A)
-- ============================================================================
-- Generada y aplicada en local el 2026-09-19 sobre la BD del carril (hotelos_chk) con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- Lo que emitió el generador para los modelos de esta tanda está VERBATIM debajo:
-- 9 CREATE TABLE (checkin_sessions, checkin_guests, document_captures, signatures,
-- assignment_suggestions, kiosk_devices, property_checkin_policies, room_blocks,
-- room_connections), 14 CREATE INDEX + 3 CREATE UNIQUE INDEX y 1 ADD FOREIGN KEY
-- (checkin_guests.session_id → checkin_sessions ON DELETE CASCADE). 0 CREATE TYPE:
-- los estados son String documentados con `///` en schema.prisma (como
-- PropertyAiToolSetting.automationLevel). 0 columnas nuevas en tablas existentes,
-- 0 backfill, 0 DO $$.
-- ELIMINADO A MANO del SQL generado (ajeno a esta tanda): contra la BD del carril el
-- diff proponía además `DROP INDEX vat_book_entries_organization_id_book_regime_idx`,
-- `ALTER TABLE vat_book_entries DROP COLUMN regime`, `ALTER TABLE vat_settings DROP
-- COLUMN opening_compensation, DROP COLUMN opening_compensation_period` y
-- `DROP TYPE "VatBookRegime"`, porque esa BD lleva aplicadas las migraciones
-- 20260920100000_iva_regimen y 20260920110000_iva_compensacion_inicial de otro carril
-- cuyas carpetas no existen en este árbol. Comprobado con
--   migrate diff --from-schema-datamodel <schema.prisma de f77820d> \
--     --to-schema-datamodel prisma/schema.prisma --script
-- que emite exactamente las sentencias de abajo (0 DROP, 0 CREATE TYPE, 0 ADD COLUMN).
-- Reversible: DROP TABLE de las 9 tablas (checkin_guests antes que checkin_sessions
-- por la FK; el resto no tiene FK).
-- NO incluye, por decisión de la tanda (docs/design/CHECKIN-AUTOMATIZADO-IA.md §6):
--   · MobileKey: la llave móvil sigue en GuestPortalAction (actionType mkey_*);
--   · RoomFeatureAssignment: 0 room_features en la BD;
--   · índice único guest_register_records(reservation_id, guest_id): 0 duplicados
--     hoy pero sin dueño; deuda documentada (dedupe en código en
--     apps/api/src/modules/compliance/compliance.service.ts).
-- PII: CheckInGuest.document_number / document_support_number / email / phone_mobile /
-- residence_full_address se cifran en reposo por la extensión Prisma
-- (PII_FIELDS.CheckInGuest) con hashes de búsqueda *_lookup_hash
-- (LOOKUP_HASH_FIELDS.CheckInGuest), mismo envelope que guest_register_records.
-- ============================================================================

-- CreateTable
CREATE TABLE "checkin_sessions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "guest_portal_session_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "channel" TEXT NOT NULL,
    "invited_at" TIMESTAMP(3),
    "reminder_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "arrived_at" TIMESTAMP(3),
    "checked_in_at" TIMESTAMP(3),
    "eta_declared" TEXT,
    "preferences_json" JSONB NOT NULL DEFAULT '[]',
    "consent_json" JSONB NOT NULL DEFAULT '{}',
    "payment_status" TEXT NOT NULL DEFAULT 'none',
    "payment_intent_id" TEXT,
    "payment_token_id" TEXT,
    "handoff_kind" TEXT,
    "handoff_reason" TEXT,
    "kiosk_device_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkin_guests" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "guest_id" TEXT,
    "guest_register_record_id" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "age_at_arrival" INTEGER,
    "is_minor" BOOLEAN NOT NULL DEFAULT false,
    "provided_by_checkin_guest_id" TEXT,
    "kinship" TEXT,
    "guardian_title" TEXT,
    "identity_verification_method" TEXT,
    "identity_verified_at" TIMESTAMP(3),
    "identity_verified_by" TEXT,
    "first_name" TEXT,
    "surname_1" TEXT,
    "surname_2" TEXT,
    "sex" TEXT,
    "nationality" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "document_type" TEXT,
    "document_expiry_date" TIMESTAMP(3),
    "residence_locality" TEXT,
    "residence_country" TEXT,
    "document_number" TEXT,
    "document_number_lookup_hash" TEXT,
    "document_support_number" TEXT,
    "email" TEXT,
    "email_lookup_hash" TEXT,
    "phone_mobile" TEXT,
    "phone_mobile_lookup_hash" TEXT,
    "residence_full_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkin_guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_captures" (
    "id" TEXT NOT NULL,
    "checkin_guest_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mrz_format" TEXT,
    "checks_json" JSONB NOT NULL DEFAULT '{}',
    "fields_json" JSONB NOT NULL DEFAULT '{}',
    "confidence_json" JSONB NOT NULL DEFAULT '{}',
    "needs_review_json" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "tokens_input" INTEGER,
    "tokens_output" INTEGER,
    "cost_eur" DECIMAL(10,4),
    "image_stored" BOOLEAN NOT NULL DEFAULT false,
    "image_discarded_at" TIMESTAMP(3) NOT NULL,
    "processing_ms" INTEGER,
    "purge_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "checkin_guest_id" TEXT,
    "guest_register_record_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "pdf_object_key" TEXT,
    "pdf_sha256" TEXT,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "stroke_meta_json" JSONB NOT NULL DEFAULT '{}',
    "method" TEXT NOT NULL,
    "retention_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_suggestions" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "session_id" TEXT,
    "candidates_json" JSONB NOT NULL,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "chosen_room_id" TEXT,
    "confidence" DECIMAL(5,4) NOT NULL,
    "rules_version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "automation_level" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "ai_tool_call_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kiosk_devices" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pairing_code_hash" TEXT,
    "pairing_expires_at" TIMESTAMP(3),
    "paired_at" TIMESTAMP(3),
    "device_token_hash" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'unpaired',
    "capabilities_json" JSONB NOT NULL DEFAULT '{}',
    "lock_provider" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kiosk_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_checkin_policies" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "self_checkin_enabled" BOOLEAN NOT NULL DEFAULT false,
    "invite_days_before" INTEGER NOT NULL DEFAULT 3,
    "reminder_days_before" INTEGER NOT NULL DEFAULT 1,
    "allowed_verification_methods_json" JSONB NOT NULL DEFAULT '["visual_reception","mrz_checksum","otp_email"]',
    "require_visual_check_at_kiosk" BOOLEAN NOT NULL DEFAULT true,
    "require_inspected_room" BOOLEAN NOT NULL DEFAULT false,
    "deposit_policy" TEXT NOT NULL DEFAULT 'balance',
    "deposit_amount" DECIMAL(12,2),
    "allow_walk_in" BOOLEAN NOT NULL DEFAULT false,
    "allow_upgrade_suggestion" BOOLEAN NOT NULL DEFAULT true,
    "auto_assign_level" TEXT NOT NULL DEFAULT 'suggest_and_confirm',
    "assignment_weights_json" JSONB NOT NULL DEFAULT '{}',
    "welcome_channel_order_json" JSONB NOT NULL DEFAULT '["whatsapp","email","sms"]',
    "guest_consent_text" TEXT,
    "ai_disclosure_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_checkin_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_blocks" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "work_order_id" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_connections" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "room_a_id" TEXT NOT NULL,
    "room_b_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "room_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkin_sessions_property_id_status_idx" ON "checkin_sessions"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checkin_sessions_reservation_id_key" ON "checkin_sessions"("reservation_id");

-- CreateIndex
CREATE INDEX "checkin_guests_session_id_ordinal_idx" ON "checkin_guests"("session_id", "ordinal");

-- CreateIndex
CREATE INDEX "checkin_guests_guest_register_record_id_idx" ON "checkin_guests"("guest_register_record_id");

-- CreateIndex
CREATE INDEX "checkin_guests_property_id_idx" ON "checkin_guests"("property_id");

-- CreateIndex
CREATE INDEX "document_captures_checkin_guest_id_idx" ON "document_captures"("checkin_guest_id");

-- CreateIndex
CREATE INDEX "document_captures_purge_at_idx" ON "document_captures"("purge_at");

-- CreateIndex
CREATE INDEX "signatures_guest_register_record_id_idx" ON "signatures"("guest_register_record_id");

-- CreateIndex
CREATE INDEX "signatures_retention_until_idx" ON "signatures"("retention_until");

-- CreateIndex
CREATE INDEX "assignment_suggestions_property_id_status_created_at_idx" ON "assignment_suggestions"("property_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "assignment_suggestions_reservation_id_idx" ON "assignment_suggestions"("reservation_id");

-- CreateIndex
CREATE INDEX "kiosk_devices_property_id_status_idx" ON "kiosk_devices"("property_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "property_checkin_policies_property_id_key" ON "property_checkin_policies"("property_id");

-- CreateIndex
CREATE INDEX "room_blocks_room_id_from_date_to_date_idx" ON "room_blocks"("room_id", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "room_blocks_property_id_idx" ON "room_blocks"("property_id");

-- CreateIndex
CREATE INDEX "room_connections_property_id_idx" ON "room_connections"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_connections_room_a_id_room_b_id_key" ON "room_connections"("room_a_id", "room_b_id");

-- AddForeignKey
ALTER TABLE "checkin_guests" ADD CONSTRAINT "checkin_guests_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "checkin_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

