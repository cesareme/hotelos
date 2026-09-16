-- ============================================================================
-- 20260916101000_estructura_societaria_harden · Finanzas / estructura societaria (Tanda 6b · L1, paso 2)
-- ============================================================================
-- Generated on 2026-09-16 with:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- after the step-1 migration was applied, then reviewed by hand. The generator
-- emitted `ALTER COLUMN "prefix" SET NOT NULL` and the unique index below; the
-- NOT NULL is NOT applied yet (see the deferred list: backoffice.service
-- patchBillingSettings — L2's file — still stores NULL to reset a series prefix,
-- and typecheck of the API breaks with a non-nullable column), so this step only
-- fills legacy NULL prefixes (data preparation, idempotent) and creates the NIF
-- unique index. End state == schema.prisma (prefix stays String?).
--
-- Duplicate report of the local demo DB (psql, 2026-09-16, before writing):
--   · NIF per organization: 2 organizations, 2 distinct checksum-valid NIFs
--     (org_123 B12345674, Faranda B99999997 — fictitious) → CLEAN → the unique
--     index on legal_entities.tax_id IS created here. A plain unique index is the
--     `WHERE tax_id IS NOT NULL` partial index of the design: PostgreSQL treats
--     NULLs as distinct, and Prisma can declare it (@unique). The backfill
--     (apps/api/src/scripts/backfill-legal-structure.ts) leaves tax_id NULL with
--     a warning for an invalid, placeholder or already-used NIF, so this index
--     never blocks a later run on a dirtier database (VPS).
--   · invoice_sequences.prefix: 8/8 rows carry a prefix; the fill below only
--     acts on databases with legacy NULLs (preparation for the NOT NULL of L2).
--   · Series prefixes per legal entity (upper(prefix), year): NOT CLEAN —
--     org_123 uses FAC-2026- / 2026 in BOTH prop_123 and prop_canary (demo
--     sandbox data, 1 issued invoice in prop_canary with the placeholder NIF).
--   · Invoice numbers per legal entity: NOT CLEAN — org_123 has FAC-2026-000001
--     twice (prop_123 and prop_canary). Faranda is clean (FAC-/REC- vs -LT-).
--
-- DEFERRED (not in this migration, by design §5.1 / §8.2 — "solo tras el informe
-- de duplicados limpio"); the service guard assertSeriesPrefixFree
-- (apps/api/src/modules/invoicing/series-prefix.service.ts) is the uniqueness
-- until they exist:
--   · CREATE UNIQUE INDEX invoice_sequences_legal_entity_prefix_year_key
--       ON invoice_sequences (legal_entity_id, upper(prefix), year)
--       WHERE legal_entity_id IS NOT NULL;                       -- after org_123's FAC-2026- clash is resolved (L8: close prop_canary's series, never renumber)
--   · CREATE UNIQUE INDEX invoices_legal_entity_id_invoice_number_key
--       ON invoices (legal_entity_id, invoice_number)
--       WHERE deleted_at IS NULL AND status <> 'draft' AND legal_entity_id IS NOT NULL;  -- after the duplicated demo invoice is dealt with (L8)
--   · ALTER TABLE invoice_sequences ALTER COLUMN prefix SET NOT NULL;         -- with L2: patchBillingSettings maps an empty prefix to the R3 default instead of NULL (backoffice.service.ts:5480,5514)
--   · ALTER TABLE properties        ALTER COLUMN legal_entity_id SET NOT NULL; -- after L2 (createTenant / provisioning write it)
--   · ALTER TABLE invoice_sequences ALTER COLUMN legal_entity_id SET NOT NULL; -- after L2/L3 (allocateInvoiceNumber, patchBillingSettings write it)
--   · ALTER TABLE invoices          ALTER COLUMN legal_entity_id SET NOT NULL; -- after L3 (issue flow writes it)
--   · ALTER TABLE bank_accounts     ALTER COLUMN property_id DROP NOT NULL;    -- L4 (treasury/banking readers)
-- Both partial indexes are invisible to `migrate diff --from-schema-datasource`
-- (verified on a probe DB), so they can land in a later migration without drift.
-- ============================================================================

-- BackfillSequencePrefix (legacy rows created before the prefix existed; idempotent)
UPDATE "invoice_sequences"
SET "prefix" = "sequence_code" || '-' || COALESCE("year"::text || '-', '')
WHERE "prefix" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "legal_entities_tax_id_key" ON "legal_entities"("tax_id");
