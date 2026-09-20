-- ============================================================================
-- 20260920130000_documentos_split_paginas_retencion · Documentos (Tanda T9 · corrector)
-- ============================================================================
-- Aditiva y reversible (tres ALTER; ninguna fila se toca):
--   · incoming_documents.source_pages_json: páginas físicas del fichero original
--     que forman el documento tras un `split` lógico (RV-01); null = todas;
--   · incoming_documents.capture_note: nota de captura que el pipeline conserva
--     en search_text (RV-18);
--   · document_settings.letter_retention_years: defecto 4 → 6 (correspondencia
--     de proveedores, art. 30 CCom; diseño §3.2 / §8) (RV-05). Las filas ya
--     creadas conservan su valor.
-- Reversión: ALTER TABLE "incoming_documents" DROP COLUMN "source_pages_json", DROP COLUMN "capture_note";
--            ALTER TABLE "document_settings" ALTER COLUMN "letter_retention_years" SET DEFAULT 4;

ALTER TABLE "incoming_documents" ADD COLUMN "source_pages_json" JSONB;
ALTER TABLE "incoming_documents" ADD COLUMN "capture_note" TEXT;
ALTER TABLE "document_settings" ALTER COLUMN "letter_retention_years" SET DEFAULT 6;
