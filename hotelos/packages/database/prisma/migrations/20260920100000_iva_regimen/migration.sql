-- ============================================================================
-- 20260920100000_iva_regimen · Régimen de IVA en los libros (Tanda FIX-1 · lote F2, B-1/B-4/B-6)
-- ============================================================================
-- Generada en local el 2026-09-19 (tras pg_dump previo, ~/anfitorio-demo/backups/hotelos-pre-fix1-*.dump) con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- VERBATIM: 1 CREATE TYPE, 1 ALTER TABLE … ADD COLUMN (nullable, sin DEFAULT), 1 CREATE INDEX.
-- ADITIVA y REVERSIBLE: ningún DROP, ningún NOT NULL, ningún backfill. Las filas existentes quedan con
-- regime NULL («sin clasificar»: el 303 las trata como operaciones interiores, igual que antes); las
-- rellenan el importador de Sage (clave de operación / calificación / tipo F5) o la acción de producto
-- POST /fiscal/vat-books/reclassify (dry-run por defecto, apply explícito, auditada).
-- Reverso manual: DROP INDEX "vat_book_entries_organization_id_book_regime_idx";
--                 ALTER TABLE "vat_book_entries" DROP COLUMN "regime"; DROP TYPE "VatBookRegime";

-- CreateEnum
CREATE TYPE "VatBookRegime" AS ENUM ('interior', 'isp', 'aib', 'importacion', 'exento_no_sujeto');

-- AlterTable
ALTER TABLE "vat_book_entries" ADD COLUMN     "regime" "VatBookRegime";

-- CreateIndex
CREATE INDEX "vat_book_entries_organization_id_book_regime_idx" ON "vat_book_entries"("organization_id", "book", "regime");
