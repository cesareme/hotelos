-- Corrector L5 (CS-05) · backfill de guest_register_records.is_primary_guest.
--
-- La migración 20260919090000_operaciones_l5 añadió la semántica «isPrimaryGuest
-- = ReservationGuest.isPrimary» (L5-B1) solo para los partes creados a partir de
-- entonces; los existentes seguían en false aunque su vínculo fuese el titular
-- (16 filas / 15 vínculos is_primary en la BD local del 2026-09-19). Solo datos:
-- idempotente (WHERE is_primary_guest = false), sin DDL, nunca borra ni
-- desmarca (un parte ya true no se toca).
UPDATE "guest_register_records" AS r
SET "is_primary_guest" = true
FROM "reservation_guests" AS rg
WHERE rg."reservation_id" = r."reservation_id"
  AND rg."guest_id" = r."guest_id"
  AND rg."is_primary" = true
  AND r."is_primary_guest" = false;
