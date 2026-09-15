-- Rate grid v2 · cierre 2026-09-15 · idempotency of bulk-update retries.
-- Generated with:
--   prisma migrate diff --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script
-- plus the data step below (hand-written): entries written BEFORE the engine
-- took the per-property advisory lock could race two retries with the same
-- clientRequestId into two rows (one such pair exists in the local demo DB,
-- residue of a concurrency probe). The FIRST attempt (oldest timestamp, then
-- id) keeps the key — it is the one a replay returns — and the later ones are
-- detached (client_request_id NULL: the entry, its items and its status stay).
-- NULLs are distinct for the unique index, so entries without a key are fine.

-- DetachDuplicateClientRequestIds
UPDATE "rate_change_journals" AS j
SET "client_request_id" = NULL
WHERE j."client_request_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "rate_change_journals" AS first
    WHERE first."propertyId" = j."propertyId"
      AND first."client_request_id" = j."client_request_id"
      AND (first."timestamp" < j."timestamp" OR (first."timestamp" = j."timestamp" AND first."id" < j."id"))
  );

-- CreateIndex
CREATE UNIQUE INDEX "rate_change_journals_propertyId_client_request_id_key" ON "rate_change_journals"("propertyId", "client_request_id");
