-- ============================================================================
-- 20260920170000_asistente_unificado · Memoria del asistente unificado (Tanda L6b · L6b-01)
-- ============================================================================
-- Generada y aplicada en local el 2026-09-20 sobre la BD del carril (hotelos_l6b, 24
-- migraciones aplicadas, deriva 0 antes de esta) con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- Lo que emitió el generador para los dos modelos de este lote está VERBATIM debajo:
-- 2 CREATE TABLE (assistant_conversations, assistant_messages), 2 CREATE INDEX y
-- 1 ADD FOREIGN KEY (assistant_messages.conversation_id → assistant_conversations
-- ON DELETE CASCADE). 0 CREATE TYPE: surface/status/role/routed_by son String
-- documentados con `///` en schema.prisma (como AiPendingConfirmation.status).
-- 0 columnas nuevas en tablas existentes (ai_tool_calls ya tenía conversation_id),
-- 0 backfill, 0 DO $$, 0 DROP. Nada eliminado a mano: el diff contra la BD del carril
-- no propuso sentencias ajenas.
-- Nombre del índice compuesto truncado por Prisma al límite de 63 caracteres de
-- PostgreSQL: assistant_conversations_organization_id_property_id_user_id_idx cubre
-- (organization_id, property_id, user_id, last_message_at).
-- Reversible (en este orden, por la FK):
--   DROP TABLE "assistant_messages";
--   DROP TABLE "assistant_conversations";
-- PII: assistant_messages.content se cifra en reposo por la extensión Prisma
-- (PII_FIELDS.AssistantMessage), mismo envelope que guest_register_records; sin
-- columna *_lookup_hash porque nunca se busca por igualdad de contenido.
-- Sin seed ni datos: la memoria se rellena en uso por el núcleo conversacional (L6b-02+).
-- ============================================================================

-- CreateTable
CREATE TABLE "assistant_conversations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "screen_context_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_calls_json" JSONB,
    "routed_by" TEXT,
    "model" TEXT,
    "tokens_input" INTEGER,
    "tokens_output" INTEGER,
    "cost_eur" DECIMAL(12,6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_conversations_organization_id_property_id_user_id_idx" ON "assistant_conversations"("organization_id", "property_id", "user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

