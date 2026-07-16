// Revenue Export Center — catalog-driven, on-demand export generation.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadGeneratedExport,
  fetchExportCatalog,
  generateRevenueExport,
  type ExportCatalog,
  type ExportDef,
  type ExportFormat,
  type GenerateExportResponse
} from "../../services/revenueExportApi";
import { EmptyState, ErrorState, LoadingBlock, SkeletonLines } from "../../components/States";
import { useToast } from "../../components/Toast";

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
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("es-ES", { maximumFractionDigits: 1 })} KB`;
  return `${(kb / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB`;
}
function fmtTime(isoTs: string): string {
  const d = new Date(isoTs);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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

type Ritual = ExportDef["ritual"];

const RITUAL_ORDER: Ritual[] = ["diario", "semanal", "mensual"];

const RITUAL_META: Record<Ritual, { title: string; when: string }> = {
  diario: {
    title: "Ritual diario",
    when: "Cada mañana a las 7:00: repaso de pickup de 15 minutos para decidir acciones sobre la BAR del día."
  },
  semanal: {
    title: "Ritual semanal",
    when: "Miércoles: reunión semanal de revenue con la vista del mes en curso y los tres siguientes."
  },
  mensual: {
    title: "Cierre mensual",
    when: "Día 1 de cada mes: cierre del mes anterior, día a día y por segmento/canal."
  }
};

type ExportParams = { from: string; to: string; month: string };
type CardNote = { kind: "ok" | "error"; text: string };
type SessionEntry = { key: string; exportName: string; resp: GenerateExportResponse };

function initialParamsFor(code: string): ExportParams {
  return { ...defaultRangeFor(code), month: previousMonthIso() };
}

const FIELD_LABEL_STYLE = { fontSize: 11 } as const;

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
    <article className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="bo-card-head" style={{ alignItems: "flex-start" }}>
        <h3 style={{ fontSize: 14 }}>{def.name}</h3>
        {def.recommendedSchedule ? (
          <span className="bo-status info" style={{ textTransform: "none", whiteSpace: "nowrap" }}>
            {def.recommendedSchedule}
          </span>
        ) : null}
      </div>
      <p className="bo-muted" style={{ margin: 0, textTransform: "none", fontSize: 12.5, letterSpacing: 0 }}>
        {def.description}
      </p>

      {def.params === "dateRange" ? (
        <div className="bo-row" style={{ gap: 12, alignItems: "flex-end" }}>
          <div className="bo-stack" style={{ gap: 4 }}>
            <label className="bo-muted" style={FIELD_LABEL_STYLE} htmlFor={`exp-${def.code}-from`}>
              Desde
            </label>
            <input
              id={`exp-${def.code}-from`}
              type="date"
              value={value.from}
              max={value.to || undefined}
              onChange={(e) => onParamChange(def.code, "from", e.target.value)}
            />
          </div>
          <div className="bo-stack" style={{ gap: 4 }}>
            <label className="bo-muted" style={FIELD_LABEL_STYLE} htmlFor={`exp-${def.code}-to`}>
              Hasta
            </label>
            <input
              id={`exp-${def.code}-to`}
              type="date"
              value={value.to}
              min={value.from || undefined}
              onChange={(e) => onParamChange(def.code, "to", e.target.value)}
            />
          </div>
        </div>
      ) : def.params === "month" ? (
        <div className="bo-stack" style={{ gap: 4, alignSelf: "flex-start" }}>
          <label className="bo-muted" style={FIELD_LABEL_STYLE} htmlFor={`exp-${def.code}-month`}>
            Mes
          </label>
          <input
            id={`exp-${def.code}-month`}
            type="month"
            value={value.month}
            onChange={(e) => onParamChange(def.code, "month", e.target.value)}
          />
        </div>
      ) : (
        <p className="bo-muted" style={{ margin: 0, textTransform: "none", fontSize: 12, letterSpacing: 0 }}>
          Sin parámetros: se genera con los datos vigentes en el momento de la descarga.
        </p>
      )}

      <div className="bo-row" style={{ gap: 8, marginTop: "auto" }}>
        {def.formats.map((format) => {
          const busy = busyKey === `${def.code}:${format}`;
          return (
            <button
              key={format}
              type="button"
              onClick={() => onGenerate(def, format)}
              disabled={anyBusy}
              aria-busy={busy || undefined}
              title={format === "pdf" ? PDF_HINT : undefined}
            >
              {busy ? (
                <>
                  <span className="bo-spinner sm" aria-hidden /> Generando…
                </>
              ) : (
                FORMAT_LABEL[format] ?? format
              )}
            </button>
          );
        })}
      </div>

      {def.formats.includes("pdf") ? (
        <p className="bo-muted" style={{ margin: 0, textTransform: "none", fontSize: 11.5, letterSpacing: 0 }}>
          «PDF (imprimir)» descarga HTML listo para imprimir o guardar como PDF desde el navegador.
        </p>
      ) : null}

      {note ? (
        <p
          role={note.kind === "error" ? "alert" : "status"}
          style={{
            margin: 0,
            fontSize: 12.5,
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            background: note.kind === "error" ? "var(--danger-bg)" : "var(--ok-bg)",
            border: `1px solid ${note.kind === "error" ? "var(--danger-line)" : "var(--ok-line)"}`,
            color: note.kind === "error" ? "var(--danger-ink)" : "var(--ok-ink)",
            overflowWrap: "anywhere"
          }}
        >
          {note.text}
        </p>
      ) : null}
    </article>
  );
}

export function RevenueExportCenter() {
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

  return (
    <section className="bo-card" style={{ display: "grid", gap: 20 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Revenue · Exportación</p>
          <h2>Centro de exportación de Revenue</h2>
          <p className="bo-muted" style={{ margin: "4px 0 0", textTransform: "none", fontSize: 12, letterSpacing: 0 }}>
            Los informes del ritual de revenue se generan bajo demanda con los datos de la propiedad y se descargan
            al momento: CSV y Excel para trabajar, páginas imprimibles para dirección.
          </p>
        </div>
        <div className="bo-pill-row">
          {catalog ? <span className="bo-chip">{catalog.exports.length} informes</span> : null}
          <button type="button" onClick={() => void load()} disabled={loading}>
            ↻ Actualizar catálogo
          </button>
        </div>
      </div>

      {loadError ? (
        <ErrorState title="No se pudo cargar el catálogo de exportaciones" message={loadError} onRetry={() => void load()} />
      ) : loading && !catalog ? (
        <>
          <LoadingBlock label="Cargando catálogo de exportaciones…" />
          <SkeletonLines lines={6} />
        </>
      ) : !catalog || catalog.exports.length === 0 ? (
        <EmptyState
          title="Catálogo vacío"
          message="El servidor no ha devuelto ningún informe exportable para esta propiedad."
        />
      ) : (
        <>
          <div
            style={{
              border: "1px solid var(--line)",
              background: "var(--surface-soft)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
              display: "grid",
              gap: 8
            }}
          >
            <span className="bo-muted">Convenciones de los ficheros</span>
            <div className="bo-pill-row">
              {catalog.conventions.map((c) => (
                <span key={c} className="bo-pill" style={{ textTransform: "none" }}>
                  {c}
                </span>
              ))}
            </div>
          </div>

          {sections.grouped.map((s) => (
            <div key={s.ritual} className="bo-stack" style={{ gap: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>{s.meta.title}</h3>
                <p className="bo-muted" style={{ margin: "2px 0 0", textTransform: "none", fontSize: 12.5, letterSpacing: 0 }}>
                  {s.meta.when}
                </p>
              </div>
              <div className="bo-grid two">
                {s.defs.map((def) => (
                  <ExportCard
                    key={def.code}
                    def={def}
                    value={params[def.code] ?? initialParamsFor(def.code)}
                    busyKey={busyKey}
                    note={notes[def.code]}
                    onParamChange={setParam}
                    onGenerate={handleGenerate}
                  />
                ))}
              </div>
            </div>
          ))}

          {sections.other.length > 0 ? (
            <div className="bo-stack" style={{ gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Otros informes</h3>
              <div className="bo-grid two">
                {sections.other.map((def) => (
                  <ExportCard
                    key={def.code}
                    def={def}
                    value={params[def.code] ?? initialParamsFor(def.code)}
                    busyKey={busyKey}
                    note={notes[def.code]}
                    onParamChange={setParam}
                    onGenerate={handleGenerate}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <div className="bo-stack" style={{ gap: 10 }}>
            <div className="bo-card-head">
              <h3 style={{ fontSize: 15 }}>Generados en esta sesión</h3>
              <span className="bo-chip">
                {session.length === 1 ? "1 fichero" : `${session.length} ficheros`}
              </span>
            </div>
            {session.length === 0 ? (
              <EmptyState
                title="Aún no has generado ningún informe"
                message="Los ficheros que descargues en esta sesión aparecerán aquí para poder volver a descargarlos sin regenerarlos."
              />
            ) : (
              <>
                <div className="rev-report-wrap">
                  <table className="rev-report-table">
                    <thead>
                      <tr>
                        <th>Informe</th>
                        <th>Fichero</th>
                        <th>Formato</th>
                        <th>Hora</th>
                        <th>Tamaño</th>
                        <th aria-label="Acciones" />
                      </tr>
                    </thead>
                    <tbody>
                      {session.map((entry) => (
                        <tr key={entry.key}>
                          <td>{entry.exportName}</td>
                          <td>
                            <code style={{ fontSize: 12 }}>{entry.resp.export.filename}</code>
                          </td>
                          <td>{entry.resp.export.format.toUpperCase()}</td>
                          <td>{fmtTime(entry.resp.export.generatedAt)}</td>
                          <td>{fmtBytes(entry.resp.export.sizeBytes)}</td>
                          <td>
                            <button type="button" onClick={() => downloadGeneratedExport(entry.resp)}>
                              Volver a descargar
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="bo-muted" style={{ margin: 0, textTransform: "none", fontSize: 12, letterSpacing: 0 }}>
                  Esta lista vive solo en la memoria de la pestaña: al recargar la página se vacía. «Volver a descargar»
                  reutiliza el contenido ya generado, sin llamar de nuevo al servidor.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
