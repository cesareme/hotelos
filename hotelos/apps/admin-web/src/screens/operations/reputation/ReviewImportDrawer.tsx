// Importación de reseñas por CSV (Tanda T8 · lote T8-G · Cocoa 22): la vía sin
// credenciales. CocoaFileInput (el único input de fichero que tolera la
// regla 4 vive dentro de la primitiva) → `file.text()` → base64 →
// POST /reputation/properties/:propertyId/imports { source, scaleMax?,
// sourceId?, fileName, contentBase64 } (ImportSchema; ≤ 2 MiB decodificados,
// ≤ 5.000 filas) → ImportResult { created, updated, duplicates, invalid[] }.
// El resultado se pinta con cifras y una tabla de filas inválidas con su
// motivo; los duplicados son reseñas que ya existían (idempotencia por
// external_id). Sin estilos en línea, sin colores literales, sin inputs crudos.

import { useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDrawer, CocoaField, CocoaFileInput, CocoaFormRow, CocoaInput, CocoaSelect, CocoaStat, CocoaTable, type CocoaTableColumn } from "../../../components/cocoa";
import { number } from "../../../lib/format";
import { providerScaleMax, type ImportResult, type ReviewProvider } from "../../../services/reputation-contracts";
import { importReviews, reputationErrorMessage, type ReviewSourceDto } from "../../../services/reputationApi";
import { IMPORT_ACCEPT, IMPORT_MAX_BYTES, encodeBase64Utf8, importSummaryCopy, providerOptions } from "./reputation-helpers";

export type ReviewImportDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Fuentes de la propiedad (para elegir una fuente CSV concreta). */
  sources: ReviewSourceDto[];
  /** Tras una importación con éxito (la pantalla refresca). */
  onImported: (result: ImportResult) => void;
};

type InvalidRow = { row: number; reason: string };

const PROVIDER_OPTIONS = providerOptions();

const INVALID_COLUMNS: CocoaTableColumn<InvalidRow>[] = [
  { key: "row", label: "Fila", align: "right", fit: true, render: (item) => number(item.row) },
  { key: "reason", label: "Motivo", render: (item) => item.reason }
];

function isProvider(value: string): value is ReviewProvider {
  return PROVIDER_OPTIONS.some((option) => option.value === value);
}

export function ReviewImportDrawer({ open, onClose, sources, onImported }: ReviewImportDrawerProps) {
  const { showToast } = useToast();
  const [provider, setProvider] = useState<ReviewProvider>("csv");
  const [sourceId, setSourceId] = useState("");
  const [scaleText, setScaleText] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider("csv");
    setSourceId("");
    setScaleText("");
    setFile(null);
    setFileError(null);
    setError(null);
    setResult(null);
    setBusy(false);
  }, [open]);

  const providerScale = providerScaleMax(provider);
  const csvSources = sources.filter((source) => source.mode === "csv" && source.status !== "disabled" && (source.provider === provider || source.provider === `${provider}_demo`));
  const scale = scaleText.trim() ? Number(scaleText.trim().replace(",", ".")) : null;
  const scaleError = scaleText.trim() && (!Number.isFinite(scale) || (scale as number) <= 0 || (scale as number) > 100) ? "La escala debe ser un número entre 1 y 100." : null;

  const pick = async (picked: File) => {
    setFileError(null);
    setResult(null);
    try {
      const text = await picked.text();
      setFile({ name: picked.name, text });
    } catch {
      setFile(null);
      setFileError("No se pudo leer el fichero.");
    }
  };

  const submit = async () => {
    setError(null);
    if (!file) {
      setError("Elige un fichero CSV.");
      return;
    }
    if (scaleError) {
      setError(scaleError);
      return;
    }
    setBusy(true);
    try {
      const outcome = await importReviews({
        source: provider,
        fileName: file.name,
        contentBase64: encodeBase64Utf8(file.text),
        ...(sourceId ? { sourceId } : {}),
        ...(scale !== null && !providerScale ? { scaleMax: scale } : {})
      });
      setResult(outcome);
      showToast(`Importación terminada: ${importSummaryCopy(outcome)}.`, { variant: outcome.created + outcome.updated > 0 ? "success" : "info" });
      onImported(outcome);
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo importar el fichero."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title="Importar reseñas (CSV)"
      subtitle="Exporta las reseñas desde el portal y súbelas aquí: la importación es idempotente por identificador externo."
      size="md"
      footer={
        <div className="cocoa-row" data-gap="2" data-justify="end">
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            {result ? "Cerrar" : "Cancelar"}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={submit} loading={busy} disabled={busy || !file}>
            Importar
          </CocoaButton>
        </div>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}

        {result ? (
          <div className="cocoa-stack" data-gap="3" role="status" aria-label="Resultado de la importación">
            <div className="cocoa-row" data-gap="4" data-wrap="true">
              <CocoaStat label="Creadas" value={number(result.created)} tone={result.created > 0 ? "success" : undefined} />
              <CocoaStat label="Actualizadas" value={number(result.updated)} tone={result.updated > 0 ? "info" : undefined} />
              <CocoaStat label="Duplicadas" value={number(result.duplicates)} hint="ya existían" />
              <CocoaStat label="Inválidas" value={number(result.invalid.length)} tone={result.invalid.length > 0 ? "danger" : undefined} />
            </div>
            <span className="cocoa-note">
              {number(result.total)} {result.total === 1 ? "fila leída" : "filas leídas"} · {importSummaryCopy(result)}
            </span>
            {result.invalid.length > 0 ? (
              <CocoaTable columns={INVALID_COLUMNS} rows={result.invalid} rowKey={(row) => String(row.row)} density="compact" caption="Filas inválidas" aria-label="Filas inválidas" maxHeight={240} />
            ) : null}
          </div>
        ) : null}

        <CocoaFormRow columns={2}>
          <CocoaField label="Portal de origen" required help={providerScale ? `Notas sobre ${providerScale}.` : "Indica la escala si el fichero no trae la columna scale_max."}>
            <CocoaSelect value={provider} onChange={(value) => (isProvider(value) ? (setProvider(value), setSourceId("")) : undefined)} options={PROVIDER_OPTIONS} aria-label="Portal de origen" />
          </CocoaField>
          {!providerScale ? (
            <CocoaField label="Escala por defecto" error={scaleError ?? undefined} help="Máximo de la nota (5, 6, 10…).">
              <CocoaInput value={scaleText} onChange={setScaleText} inputMode="decimal" maxLength={5} placeholder="10" />
            </CocoaField>
          ) : null}
        </CocoaFormRow>

        {csvSources.length > 0 ? (
          <CocoaField label="Fuente destino" help="En blanco se usa (o se crea) la fuente CSV del portal.">
            <CocoaSelect
              value={sourceId}
              onChange={setSourceId}
              options={[{ value: "", label: "Fuente CSV del portal (automática)" }, ...csvSources.map((source) => ({ value: source.id, label: source.displayName }))]}
              aria-label="Fuente destino"
            />
          </CocoaField>
        ) : null}

        <CocoaField label="Fichero CSV" required error={fileError ?? undefined} help="Hasta 2 MB y 5.000 filas. Columnas admitidas: external_id, date, rating, scale_max, title, body, language, author, country, url (obligatorias date y rating).">
          <div className="cocoa-cluster">
            <CocoaFileInput accept={IMPORT_ACCEPT} maxBytes={IMPORT_MAX_BYTES} onPick={pick} onReject={setFileError} fileName={file?.name ?? null} label="Elegir fichero" disabled={busy} />
            {file ? (
              <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false}>
                {number(file.text.split(/\r?\n/).filter((line) => line.trim()).length)} líneas
              </CocoaBadge>
            ) : null}
          </div>
        </CocoaField>

        <CocoaCallout tone="neutral" role="note" title="Qué pasa al importar">
          Cada fila se normaliza a una nota sobre 10, se analiza (IA si está configurada; si no, diccionario) y, si es negativa, abre un caso de calidad. Las reseñas ya conocidas se actualizan solo si cambió su contenido.
        </CocoaCallout>
      </div>
    </CocoaDrawer>
  );
}

export default ReviewImportDrawer;
