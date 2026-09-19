-- ============================================================================
-- 20260919090000_operaciones_l5 · Operaciones y puesta en marcha (Tanda L5 · lote L5-A)
-- ============================================================================
-- Generada el 2026-09-19 con:
--   cd packages/database && node --env-file-if-exists=../../.env \
--     node_modules/prisma/build/index.js migrate diff \
--     --from-schema-datasource prisma/schema.prisma \
--     --to-schema-datamodel prisma/schema.prisma --script   (Prisma CLI 6.19.3, PostgreSQL 16)
-- Todo lo que emitió el generador está aquí VERBATIM (2 ALTER TABLE: 1 ADD COLUMN
-- y 1 con 4 ALTER COLUMN). Migración ADITIVA: ningún DROP; el único NOT NULL nuevo
-- lleva DEFAULT y va precedido de una normalización idempotente para que ninguna
-- fila existente lo viole.
--
-- §1 properties.go_live_at — fecha de la aprobación del go-live (la escribe el
--    lote L5-C en approveGoLive). NULL = sin aprobar. Property.status NO cambia
--    de valores (lo leen server.ts, portfolio, property-overview, tenant-admin y
--    legal-entity).
-- §2 rooms: estado de habitación UNIFICADO (recon §2.1, nueve escritores con
--    semánticas distintas). Modelo objetivo:
--      · status              = ocupación / disponibilidad (occupied | out_of_order |
--                              out_of_service) y, si la habitación está libre,
--                              ESPEJO de la limpieza (clean | dirty | inspected);
--      · housekeeping_status = limpieza con vocabulario cerrado dirty | clean |
--                              inspected, NOT NULL DEFAULT 'clean';
--      · maintenance_status  = ok | blocked | needs_attention, NOT NULL DEFAULT 'ok'.
--    Normalización ANTES del NOT NULL (en la BD local de 2026-09-19 las cuatro
--    UPDATE afectan 0 filas: 934 habitaciones, 0 NULL o fuera de vocabulario;
--    las 4 filas con status <> housekeeping_status son room_108 (out_of_order/dirty)
--    y las 3 ocupadas de RA (occupied/clean), que el modelo conserva tal cual):
--      (a) hk NULL          → espejo de status si es un valor de limpieza, si no 'clean';
--      (b) alias históricos → ready → clean · stayover | cleaning | in_progress → dirty
--                             · occupied (seed-operations) → clean · resto → dirty;
--      (c) status de limpieza divergente del hk → se alinea con el hk (status ocupado
--          u OOO no se toca);
--      (d) maintenance_status NULL o fuera de vocabulario → 'ok'.

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "go_live_at" TIMESTAMP(3);

-- Normalización (idempotente) del estado de habitación ANTES de los NOT NULL.
UPDATE rooms SET housekeeping_status = CASE WHEN status IN ('clean','dirty','inspected') THEN status::text ELSE 'clean' END WHERE housekeeping_status IS NULL;
UPDATE rooms SET housekeeping_status = CASE housekeeping_status WHEN 'ready' THEN 'clean' WHEN 'stayover' THEN 'dirty' WHEN 'cleaning' THEN 'dirty' WHEN 'in_progress' THEN 'dirty' WHEN 'occupied' THEN 'clean' ELSE 'dirty' END WHERE housekeeping_status NOT IN ('clean','dirty','inspected');
UPDATE rooms SET status = housekeeping_status::"RoomStatus" WHERE status IN ('clean','dirty','inspected') AND status::text <> housekeeping_status;
UPDATE rooms SET maintenance_status = 'ok' WHERE maintenance_status IS NULL OR maintenance_status NOT IN ('ok','blocked','needs_attention');

-- AlterTable
ALTER TABLE "rooms" ALTER COLUMN "housekeeping_status" SET NOT NULL,
ALTER COLUMN "housekeeping_status" SET DEFAULT 'clean',
ALTER COLUMN "maintenance_status" SET NOT NULL,
ALTER COLUMN "maintenance_status" SET DEFAULT 'ok';
