-- ============================================================================
-- 20260916102000_estructura_societaria_property_immutable · Finanzas / estructura societaria (Tanda 6b · L1, corrección t6b#10)
-- ============================================================================
-- Hand-written (no DDL Prisma can declare: only functions and triggers, which
-- `prisma migrate diff --from-schema-datasource` ignores → drift stays 0, as
-- verified for 20260916100000). No column, index or constraint changes; end
-- state == schema.prisma. Nothing existing is rewritten (no data step).
--
-- Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.2 R10:
--   R10.1 · every Property has a legalEntityId of ITS OWN organisation;
--   R10.5 · a Property with issued invoices or an assigned VeriFactu
--           installation never changes sociedad nor organisation: the transfer
--           of an establishment is a NEW Property and a RETIRED installation.
-- Finding t6b#10: 20260916100000 shipped triggers only for numero_instalacion
-- and for the issuer snapshot; a raw `UPDATE properties SET legal_entity_id`
-- moved a centre with issued invoices to the sociedad of another organisation.
-- Why this belongs in the database and not only in a service: the issued
-- invoices of the centre carry the sociedad's NIF in their immutable snapshot
-- (RD 1619/2012 art. 6.1.c-d), their numbers are unique per emisor + serie
-- (art. 6.1.a) and the VeriFactu chain belongs to the pair (obligado;
-- instalación) (RD 1007/2023 art. 8, Orden HAC/1177/2024 art. 7.c). Moving the
-- centre would silently re-attribute all of that to another obligado.
--
-- Triggers (hand-written):
--   properties_sociedad_inmutable (BEFORE INSERT OR UPDATE OF legal_entity_id,
--     organization_id ON properties):
--       · R10.1 — a non-NULL legal_entity_id must reference a legal entity of
--         NEW.organization_id (INSERT and UPDATE; a missing entity is left to
--         the FK properties_legal_entity_id_fkey);
--       · R10.5 — when legal_entity_id changes from a NON-NULL value (to another
--         entity or to NULL) or organization_id changes, and the centre has at
--         least one invoice with status <> 'draft' (soft-deleted ones included:
--         an issued invoice is a fiscal record whatever its deleted_at) or at
--         least one verifactu_installations row (active OR retired: the number
--         is never reused and its chain stays with this centre), the update is
--         rejected with integrity_constraint_violation.
--       · Still ALLOWED: filling a NULL legal_entity_id (the backfill on a
--         database that predates L1 — apps/api/src/scripts/backfill-legal-structure.ts —
--         and the L2 provisioning fill), any change on a centre without issued
--         invoices nor installation, and every other column of properties.
--   legal_entities_organizacion_inmutable (BEFORE UPDATE OF organization_id ON
--     legal_entities): the other side of R10.1 — a sociedad never changes
--     organisation (a sociedad of another grupo is a new row).
--
-- Rollback of the backfill (runbook §17.3) on a centre with invoices now needs
-- `ALTER TABLE properties DISABLE TRIGGER properties_sociedad_inmutable` inside
-- the same transaction (and ENABLE afterwards): R10.5 is deliberately not
-- bypassable by an ordinary UPDATE.
--
-- Pre-checks run on the local demo DB before writing (psql, 2026-09-16):
--   · 4 properties, 4 with legal_entity_id, 0 whose legal entity belongs to
--     another organisation (R10.1 holds on existing rows);
--   · 2 functions / 2 triggers in public before this migration (the two of
--     20260916100000); scripts/check-fresh-install.sh step 6 counts the
--     `CREATE FUNCTION` / `CREATE TRIGGER` lines of every migration, so the
--     census stays consistent (4 / 4 after this one).
-- ============================================================================

-- PropertyLegalEntityGuard
CREATE OR REPLACE FUNCTION hotelos_property_legal_entity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entity_organization_id TEXT;
BEGIN
  -- R10.1 · the sociedad of a centre belongs to the centre's organisation.
  IF NEW."legal_entity_id" IS NOT NULL THEN
    SELECT le."organization_id" INTO entity_organization_id
      FROM "legal_entities" le
     WHERE le."id" = NEW."legal_entity_id";
    IF entity_organization_id IS NOT NULL AND entity_organization_id IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'La sociedad % pertenece a otra organización: el centro % solo puede asignarse a una sociedad de su propia organización (R10.1).', NEW."legal_entity_id", NEW."id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- R10.5 · a centre with issued invoices or an installation never moves.
  IF TG_OP = 'UPDATE'
     AND (
       (OLD."legal_entity_id" IS NOT NULL AND NEW."legal_entity_id" IS DISTINCT FROM OLD."legal_entity_id")
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     )
     AND (
       EXISTS (SELECT 1 FROM "invoices" i WHERE i."property_id" = OLD."id" AND i."status"::text <> 'draft')
       OR EXISTS (SELECT 1 FROM "verifactu_installations" vi WHERE vi."property_id" = OLD."id")
     ) THEN
    RAISE EXCEPTION 'El centro % tiene facturas emitidas o una instalación VeriFactu asignada y no puede cambiar de sociedad ni de organización: el traspaso de un establecimiento es un centro nuevo y una instalación retirada (R10.5).', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER properties_sociedad_inmutable
  BEFORE INSERT OR UPDATE OF "legal_entity_id", "organization_id" ON "properties"
  FOR EACH ROW EXECUTE FUNCTION hotelos_property_legal_entity_guard();

-- LegalEntityOrganizationImmutable
CREATE OR REPLACE FUNCTION hotelos_legal_entity_organization_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'La sociedad % no puede cambiar de organización (R10.1): una sociedad de otro grupo es una sociedad nueva.', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER legal_entities_organizacion_inmutable
  BEFORE UPDATE OF "organization_id" ON "legal_entities"
  FOR EACH ROW EXECUTE FUNCTION hotelos_legal_entity_organization_immutable();
