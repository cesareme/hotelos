// Revenue Export Center — Informes › Centro de informes › Exportaciones de
// revenue (/informes/exportaciones-revenue). Catalog-driven, on-demand export
// generation.
//
// Consumes the frozen Export Center contract (2026-07-15):
//   GET  /revenue/properties/:propertyId/export-center/catalog   → ExportCatalog
//   POST /revenue/properties/:propertyId/export-center/generate  → GenerateExportResponse
// via services/revenueExportApi.ts (canonical types — do not duplicate).
//
// Honesty rules baked into this screen:
// - Nothing is hardcoded as available: exports, formats, params and
//   conventions all come from the catalog endpoint.
// - The "pdf" format is served by the backend as printable A4 HTML, so the
//   UI labels it "PDF (imprimir)" and explains the print/save flow instead
//   of pretending a binary PDF is produced.
// - Generation errors are surfaced verbatim next to the export card.
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CentroInformesTabs. One
// plain CocoaSection per ritual (heading + short caption; the «when» sentence
// is a lead paragraph in the body so it wraps on phones — the section `meta`
// is nowrap, see export-center-rituals.ts) holding a 6/6 grid of export
// cards (CocoaSection with CocoaField/CocoaDatePicker params, a CocoaButton
// per format and a CocoaCallout note); the files generated in this session
// go in a CocoaTable with a re-download row action.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  downloadGeneratedExport,
  fetchExportCatalog,
  generateRevenueExport,
  type ExportCatalog,
  type ExportDef,
  type ExportFormat,
  type GenerateExportResponse
} from "../../services/revenueExportApi";
import { getActiveProperty } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { number, plural, time } from "../../lib/format";
import { FIELD_LABELS } from "../../content/actions";
import { RITUAL_META, RITUAL_ORDER, type Ritual } from "./export-center-rituals";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const MS_DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  const n = new Date();
  return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())));
}
function addDaysIso(isoDate: string, days: number): string {
  return iso(new Date(new Date(isoDate).getTime() + days * MS_DAY));
}
/** Previous calendar month as YYYY-MM (default for month-close exports). */
function previousMonthIso(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth() - 1, 1)).toISOString().slice(0, 7);
}
function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${number(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${number(kb, { maximumFractionDigits: 1 })} KB`;
  return `${number(kb / 1024, { maximumFractionDigits: 1 })} MB`;
}
function fmtTime(isoTs: string): string {
  return time(isoTs, { seconds: true });
}

/** Default date windows per export code (contract §3); generic fallback for unknown codes. */
function defaultRangeFor(code: string): { from: string; to: string } {
  const today = todayIso();
  switch (code) {
    case "hf_daily":
      return { from: addDaysIso(today, -7), to: addDaysIso(today, 90) };
    case "pickup_daily":
      return { from: today, to: addDaysIso(today, 60) };
    case "pace_segmento":
      return { from: today, to: addDaysIso(today, 90) };
    default:
      return { from: today, to: addDaysIso(today, 30) };
  }
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: "Descargar CSV",
  xls: "Descargar Excel",
  pdf: "PDF (imprimir)",
  json: "Descargar JSON"
};

const PDF_HINT =
  "Descarga una página HTML maquetada en A4: ábrela en el navegador e imprímela o guárdala como PDF (Cmd/Ctrl+P).";

// Hint lines under the parameters: caption secondary (not a live region).
const hintStyle: CSSProperties = { fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };

// «When» of a ritual: lead paragraph under the group heading, same metrics as
// the form-section description (callout 12 · 1.35 · secondary); it wraps.
const ritualLeadStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-callout)",
  lineHeight: "var(--cocoa-leading-text)",
  color: "var(--cocoa-label-secondary)"
};

type ExportParams = { from: string; to: string; month: string };
type CardNote = { kind: "ok" | "error"; text: string };
type SessionEntry = { key: string; exportName: string; resp: GenerateExportResponse };

function currentMonthIso(): string {
  return new Date().toISOString().slice(0, 7);
}

function initialParamsFor(code: string): ExportParams {
  // The meeting pack is a "this month so far" ritual (REV-03c); the monthly
  // close and the other month-addressed exports default to the closed month.
  return { ...defaultRangeFor(code), month: code === "meeting_pack" ? currentMonthIso() : previousMonthIso() };
}

function ExportCard(props: {
  def: ExportDef;
  value: ExportParams;
  busyKey: string | null;
  note: CardNote | undefined;
  onParamChange: (code: string, field: keyof ExportParams, value: string) => void;
  onGenerate: (def: ExportDef, format: ExportFormat) => void;
}) {
  const { def, value, busyKey, note, onParamChange, onGenerate } = props;
  const anyBusy = busyKey !== null;

  return (
    <CocoaSection
      title={def.name}
      meta={def.recommendedSchedule ? <CocoaBadge tone="info" uppercase={false}>{def.recommendedSchedule}</CocoaBadge> : undefined}
      footer={
        <div className="cocoa-row" data-gap="2">
          {def.formats.map((format) => {
            const busy = busyKey === `${def.code}:${format}`;
            return (
              <CocoaButton
                key={format}
                variant={format === "pdf" ? "bordered" : "tinted"}
                tone="accent"
                size="small"
                onClick={() => onGenerate(def, format)}
                disabled={anyBusy && !busy}
                loading={busy}
                title={format === "pdf" ? PDF_HINT : undefined}
              >
                {busy ? "Generando…" : (FORMAT_LABEL[format] ?? format)}
              </CocoaButton>
            );
          })}
        </div>
      }
    >
      <p>{def.description}</p>

      {def.params === "dateRange" ? (
        <CocoaFormRow columns={2} min={160}>
          <CocoaField label={FIELD_LABELS.from} htmlFor={`exp-${def.code}-from`}>
            <CocoaDatePicker id={`exp-${def.code}-from`} size="small" value={value.from} max={value.to || undefined} onChange={(v) => onParamChange(def.code, "from", v)} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.to} htmlFor={`exp-${def.code}-to`}>
            <CocoaDatePicker id={`exp-${def.code}-to`} size="small" value={value.to} min={value.from || undefined} onChange={(v) => onParamChange(def.code, "to", v)} />
          </CocoaField>
        </CocoaFormRow>
      ) : def.params === "month" ? (
        <CocoaFormRow columns={2} min={160}>
          <CocoaField label="Mes" htmlFor={`exp-${def.code}-month`}>
            <CocoaInput id={`exp-${def.code}-month`} type="month" size="small" value={value.month} onChange={(v) => onParamChange(def.code, "month", v)} />
          </CocoaField>
        </CocoaFormRow>
      ) : (
        <p style={hintStyle}>Sin parámetros: se genera con los datos vigentes en el momento de la descarga.</p>
      )}

      {def.formats.includes("pdf") ? (
        <p style={hintStyle}>«PDF (imprimir)» descarga HTML listo para imprimir o guardar como PDF desde el navegador.</p>
      ) : null}

      {note ? (
        <CocoaCallout tone={note.kind === "error" ? "danger" : "success"} role={note.kind === "error" ? "alert" : undefined}>
          {note.text}
        </CocoaCallout>
      ) : null}
    </CocoaSection>
  );
}

const SESSION_COLUMNS: CocoaTableColumn<SessionEntry>[] = [
  { key: "exportName", label: "Informe" },
  { key: "filename", label: "Fichero", render: (entry) => <code>{entry.resp.export.filename}</code> },
  { key: "format", label: "Formato", render: (entry) => entry.resp.export.format.toUpperCase(), hideOnNarrow: true },
  { key: "generatedAt", label: "Hora", render: (entry) => fmtTime(entry.resp.export.generatedAt) },
  { key: "sizeBytes", label: "Tamaño", align: "right", render: (entry) => fmtBytes(entry.resp.export.sizeBytes), hideOnNarrow: true }
];

// Skeleton espejo: conventions card, one ritual with two export cards, the session table.
function ExportCenterSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={88} />
      <CocoaSkeleton.Grid rows={[[6, 6], [6, 6]]} height={220} />
      <CocoaSkeleton variant="card" height={160} />
    </div>
  );
}

export function RevenueExportCenter() {
  // Hosted inside the Centro de informes container (Tanda 5): CocoaPage reads the host and lets the container paint eyebrow + H1.
  const { showToast } = useToast();

  const [catalog, setCatalog] = useState<ExportCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ExportParams>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, CardNote>>({});
  const [session, setSession] = useState<SessionEntry[]>([]);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const cat = await fetchExportCatalog();
      setCatalog(cat);
      // Seed per-export param defaults, preserving anything the user already touched.
      setParams((prev) => {
        const next: Record<string, ExportParams> = {};
        for (const def of cat.exports) {
          next[def.code] = prev[def.code] ?? initialParamsFor(def.code);
        }
        return next;
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setParam = useCallback((code: string, field: keyof ExportParams, value: string) => {
    setParams((prev) => ({
      ...prev,
      [code]: { ...(prev[code] ?? initialParamsFor(code)), [field]: value }
    }));
  }, []);

  const generate = useCallback(
    async (def: ExportDef, format: ExportFormat) => {
      const p = params[def.code] ?? initialParamsFor(def.code);

      // Client-side guards: never fire a request we know is malformed.
      if (def.params === "dateRange") {
        if (!p.from || !p.to) {
          setNotes((prev) => ({ ...prev, [def.code]: { kind: "error", text: "Indica las fechas «Desde» y «Hasta»." } }));
          return;
        }
        if (p.from > p.to) {
          setNotes((prev) => ({
            ...prev,
            [def.code]: { kind: "error", text: "La fecha «Desde» no puede ser posterior a «Hasta»." }
          }));
          return;
        }
      }
      if (def.params === "month" && !p.month) {
        setNotes((prev) => ({ ...prev, [def.code]: { kind: "error", text: "Selecciona el mes a exportar." } }));
        return;
      }

      const key = `${def.code}:${format}`;
      setBusyKey(key);
      setNotes((prev) => {
        const next = { ...prev };
        delete next[def.code];
        return next;
      });
      try {
        const payload: { exportCode: string; format: ExportFormat; from?: string; to?: string; month?: string } = {
          exportCode: def.code,
          format
        };
        if (def.params === "dateRange") {
          payload.from = p.from;
          payload.to = p.to;
        } else if (def.params === "month") {
          payload.month = p.month;
        }
        const resp = await generateRevenueExport(payload);
        downloadGeneratedExport(resp);
        const sizeLabel = fmtBytes(resp.export.sizeBytes);
        seqRef.current += 1;
        setSession((prev) => [
          { key: `${resp.export.id}-${seqRef.current}`, exportName: def.name, resp },
          ...prev
        ]);
        setNotes((prev) => ({
          ...prev,
          [def.code]: { kind: "ok", text: `Descargado ${resp.export.filename} (${sizeLabel})` }
        }));
        showToast(`Descargado ${resp.export.filename} (${sizeLabel})`, { variant: "success" });
      } catch (e) {
        // Surface the backend error verbatim — never swallow it.
        const msg = e instanceof Error ? e.message : String(e);
        setNotes((prev) => ({ ...prev, [def.code]: { kind: "error", text: `No se pudo generar el informe: ${msg}` } }));
      } finally {
        setBusyKey(null);
      }
    },
    [params, showToast]
  );

  const handleGenerate = useCallback(
    (def: ExportDef, format: ExportFormat) => {
      void generate(def, format);
    },
    [generate]
  );

  const sections = useMemo(() => {
    const defs = catalog?.exports ?? [];
    const known = new Set<Ritual>(RITUAL_ORDER);
    const grouped = RITUAL_ORDER.map((ritual) => ({
      ritual,
      meta: RITUAL_META[ritual],
      defs: defs.filter((d) => d.ritual === ritual)
    })).filter((s) => s.defs.length > 0);
    // Runtime-defensive: anything outside the three contract rituals still renders.
    const other = defs.filter((d) => !known.has(d.ritual));
    return { grouped, other };
  }, [catalog]);

  const renderCards = (defs: ExportDef[]) => (
    <CocoaGrid align="start">
      {defs.map((def) => (
        <CocoaSpan key={def.code} cols={6} min={320}>
          <ExportCard
            def={def}
            value={params[def.code] ?? initialParamsFor(def.code)}
            busyKey={busyKey}
            note={notes[def.code]}
            onParamChange={setParam}
            onGenerate={handleGenerate}
          />
        </CocoaSpan>
      ))}
    </CocoaGrid>
  );

  const state = loadError && !catalog ? "error" : loading && !catalog ? "loading" : !catalog || catalog.exports.length === 0 ? "empty" : "ready";

  return (
    <CocoaPage
      eyebrow={`Informes · ${getActiveProperty().propertyName}`}
      title="Exportaciones de revenue"
      subtitle="Los informes del ritual de revenue se generan bajo demanda con los datos de la propiedad y se descargan al momento: CSV y Excel para trabajar, páginas imprimibles para dirección."
      actions={
        <>
          {catalog ? <CocoaBadge tone="neutral">{plural(catalog.exports.length, "informe", "informes")}</CocoaBadge> : null}
          {loadError && catalog ? <CocoaBadge tone="danger">{loadError}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} disabled={loading} loading={loading && Boolean(catalog)}>
            Actualizar catálogo
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<ExportCenterSkeleton />}
      empty={{ title: "Catálogo vacío", message: "El servidor no ha devuelto ningún informe exportable para esta propiedad." }}
      error={{ title: "No se pudo cargar el catálogo de exportaciones", message: loadError ?? undefined, onRetry: () => void load() }}
      commands={[{ id: "exportaciones-revenue-refresh", label: "Actualizar el catálogo de exportaciones", run: () => void load() }]}
    >
      {catalog ? (
        <>
          <CocoaSection title="Convenciones de los ficheros" aria-label="Convenciones de los ficheros">
            <div className="cocoa-cluster">
              {catalog.conventions.map((c) => (
                <CocoaBadge key={c} tone="neutral" uppercase={false}>
                  {c}
                </CocoaBadge>
              ))}
            </div>
          </CocoaSection>

          {sections.grouped.map((s) => (
            <CocoaSection key={s.ritual} variant="plain" padding="none" title={s.meta.title} meta={s.meta.meta} headingLevel={2}>
              <p style={ritualLeadStyle}>{s.meta.when}</p>
              {renderCards(s.defs)}
            </CocoaSection>
          ))}

          {sections.other.length > 0 ? (
            <CocoaSection variant="plain" padding="none" title="Otros informes" headingLevel={2}>
              {renderCards(sections.other)}
            </CocoaSection>
          ) : null}

          <CocoaSection
            title="Generados en esta sesión"
            meta={plural(session.length, "fichero", "ficheros")}
            padding={session.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
            footer={
              session.length > 0
                ? "Esta lista vive solo en la memoria de la pestaña: al recargar la página se vacía. «Volver a descargar» reutiliza el contenido ya generado, sin llamar de nuevo al servidor."
                : undefined
            }
          >
            {session.length === 0 ? (
              <CocoaState
                kind="empty"
                inline
                title="Aún no has generado ningún informe."
                message="Los ficheros que descargues en esta sesión aparecerán aquí para poder volver a descargarlos sin regenerarlos."
              />
            ) : (
              <CocoaTable
                columns={SESSION_COLUMNS}
                rows={session}
                rowKey="key"
                caption="Ficheros generados en esta sesión"
                aria-label="Ficheros generados en esta sesión"
                rowActions={(entry) => (
                  <CocoaButton variant="plain" tone="accent" size="small" onClick={() => downloadGeneratedExport(entry.resp)}>
                    Volver a descargar
                  </CocoaButton>
                )}
              />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
