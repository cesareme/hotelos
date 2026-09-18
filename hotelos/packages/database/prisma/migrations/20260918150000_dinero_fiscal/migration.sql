-- ============================================================================
-- 20260918150000_dinero_fiscal · Dinero y fiscal (Tanda L3 · lote L3-S)
-- ============================================================================
-- Generada el 2026-09-18 con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- Todo lo que emitió el generador está aquí VERBATIM (2 ALTER TABLE … ADD COLUMN,
-- 1 CREATE INDEX). Migración ADITIVA: ninguna fila cambia, ningún NOT NULL sin
-- DEFAULT, ningún DROP. Sin backfill:
--   · `reservations.price_source` queda NULL en las filas existentes (fila
--     heredada = origen del importe desconocido; las nuevas lo escriben A/T7);
--   · `folio_lines.tax_category` NO se rellena (decisión §6.8 del recon: sigue
--     nullable y el lote T la infiere al escribir).
--
-- §1 cancellation_policies.is_default — política por defecto del centro para las
--    reservas sin `cancellation_policy_id` / `_code` (hasta hoy regía la primera
--    activa por código). «Como mucho UNA por centro» lo garantiza el servicio de
--    políticas en transacción; no hay índice único parcial a propósito: Prisma no
--    lo declara y `db:drift:check` compara datasource ↔ datamodel.
-- §2 reservations.price_source — origen de `total_amount`:
--    rate_plan | partial | none | manual | file | quoted (NULL = fila heredada).
-- §3 índice (property_id, is_default) para resolver el default por centro.

-- AlterTable
ALTER TABLE "cancellation_policies" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "price_source" TEXT;

-- CreateIndex
CREATE INDEX "cancellation_policies_property_id_is_default_idx" ON "cancellation_policies"("property_id", "is_default");
