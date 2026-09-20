-- Tanda UX-3 · lote M1 (diseño §4.6, D2): fotos del parte de mantenimiento almacenadas EN LA FILA
-- de work_order_media (almacén «inline», como documents; sin S3, regla 7). Cinco columnas aditivas:
--   content_base64  bytes de la foto en base64 (≤ 1,5 MiB decodificada; NULL en las filas legacy
--                   que solo guardan object_key)
--   mime_type       image/jpeg | image/png | image/webp verificado por magic bytes
--   size_bytes      tamaño decodificado
--   created_at      momento del adjunto (TIMESTAMP(3), como las otras 174 columnas created_at del esquema)
--   created_by      id del usuario que adjuntó (texto, sin FK: como work_orders.created_by)
-- Sin backfill, sin tabla nueva, sin índice nuevo. Reversible:
--   ALTER TABLE "work_order_media" DROP COLUMN "content_base64", DROP COLUMN "mime_type",
--     DROP COLUMN "size_bytes", DROP COLUMN "created_at", DROP COLUMN "created_by";
ALTER TABLE "work_order_media"
  ADD COLUMN "content_base64" TEXT,
  ADD COLUMN "mime_type" TEXT,
  ADD COLUMN "size_bytes" INTEGER,
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "created_by" TEXT;
