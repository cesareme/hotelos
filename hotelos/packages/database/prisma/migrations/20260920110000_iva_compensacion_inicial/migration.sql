-- ============================================================================
-- 20260920110000_iva_compensacion_inicial · Saldo inicial a compensar del IVA (Tanda FIX-1 · lote F3, B-2)
-- ============================================================================
-- Generada en local el 2026-09-19 (tras pg_dump previo, ~/anfitorio-demo/backups/hotelos-pre-fix1-*.dump) con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- VERBATIM: 1 ALTER TABLE … ADD COLUMN × 2 (DEFAULT 0 y nullable). ADITIVA y REVERSIBLE: ningún DROP, ningún
-- backfill. `opening_compensation` = cuotas a compensar (casilla 110) arrastradas de periodos anteriores a la
-- primera liquidación de ehotelOS; `opening_compensation_period` = código del periodo (2025-Q1 · 2025-01) desde el
-- que aplica (NULL = no aplica). Las filas existentes quedan a 0 / NULL: el 303 no cambia hasta que la sociedad
-- guarde el ajuste en Configuración › Contabilidad (PUT /fiscal/vat-settings, auditado VAT_SETTINGS_UPDATED).
-- Reverso manual: ALTER TABLE "vat_settings" DROP COLUMN "opening_compensation_period", DROP COLUMN "opening_compensation";

-- AlterTable
ALTER TABLE "vat_settings" ADD COLUMN     "opening_compensation" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "opening_compensation_period" TEXT;
