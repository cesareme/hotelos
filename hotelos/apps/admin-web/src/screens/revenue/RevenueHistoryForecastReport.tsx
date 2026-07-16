// History & Forecast detailed report (contract frozen 2026-07-15).
//
// Dense Opera-style daily table: one row per date plus ISO-week/month
// subtotals and a final total, all computed server-side by
// GET /revenue/properties/:id/history-forecast/board. Nothing is invented
// client-side; missing blocks (forecast/budget/STLY/pickup) render as "—".
// Exports go through the Export Center (hf_daily, CSV/XLS).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchHistoryForecastBoard,
  money,
  type BoardRow,
  type HistoryForecastBoard
} from "../../services/revenueApi";
import { downloadGeneratedExport, generateRevenueExport } from "../../services/revenueExportApi";
import { ErrorState, LoadingBlock, SkeletonLines, Spinner } from "../../components/States";
import { NarrowViewportBanner } from "../../components/NarrowViewportBanner";

// ---- date helpers (UTC slicing, module convention) -------------------------
const MS_DAY = 86_400_000;

function todayIso(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())).toISOString().slice(0, 10);
}
function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * MS_DAY).toISOString().slice(0, 10);
}
function currentMonthRange(): { from: string; to: string } {
  const n = new Date();
  const from = new Date(Date.UTC(n.getFullYear(), n.getMonth(), 1));
  const to = new Date(Date.UTC(n.getFullYear(), n.getMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const RANGE_PRESETS: { id: string; label: string; range: () => { from: string; to: string } }[] = [
  { id: "-7+30", label: "−7/+30", range: () => ({ from: addDaysIso(todayIso(), -7), to: addDaysIso(todayIso(), 30) }) },
  { id: "-7+90", label: "−7/+90", range: () => ({ from: addDaysIso(todayIso(), -7), to: addDaysIso(todayIso(), 90) }) },
  { id: "month", label: "Mes actual", range: currentMonthRange },
  { id: "next90", label: "Próximos 90", range: () => ({ from: todayIso(), to: addDaysIso(todayIso(), 90) }) }
];

// ---- number/date formatting (es-ES) ----------------------------------------
const nfInt = new Intl.NumberFormat("es-ES", { useGrouping: true, maximumFractionDigits: 0 });
const nfPct1 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmtInt(n: number): string {
  return nfInt.format(Math.round(n));
}
function fmtPct1(n: number): string {
  return `${nfPct1.format(n)} %`;
}
/** Confidence can arrive as 0..1 or 0..100 depending on the model row; normalize defensively. */
function fmtConfidence(n: number): string {
  const pct = n > 1.5 ? n : n * 100;
  return `${nfInt.format(Math.round(pct))}%`;
}
function signedInt(n: number): string {
  return `${n > 0 ? "+" : ""}${fmtInt(n)}`;
}
function signedMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${money(n)}`;
}
function dash<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  return value === null || value === undefined ? "—" : fmt(value);
}
function fmtDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}
function fmtDateFull(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
/** OTB timestamp → HH:MM in Europe/Madrid (spec convention: "OTB a las HH:MM"). */
function fmtOtbTime(isoTimestamp: string): string {
  try {
    return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit" }).format(new Date(isoTimestamp));
  } catch {
    return isoTimestamp.slice(11, 16);
  }
}

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

// ---- column model ------------------------------------------------------------
// Labelled column groups, Opera style. Each cell renders straight from the
// server row; subtotal/total rows reuse the same renderers (the server already
// weights occ/ADR/RevPAR and nulls pickupAdr7 on subtotals).
type ColumnDef = { label: string; render: (r: BoardRow) => string };
type ColumnGroup = { label: string; cols: ColumnDef[] };

const COLUMN_GROUPS: ColumnGroup[] = [
  {
    label: "Actual / OTB",
    cols: [
      { label: "Hab", render: (r) => fmtInt(r.roomsSold) },
      { label: "Occ %", render: (r) => fmtPct1(r.occPct) },
      { label: "ADR", render: (r) => dash(r.adr, money) },
      { label: "RevPAR", render: (r) => dash(r.revpar, money) },
      { label: "Ingresos", render: (r) => money(r.roomRevenue) },
      { label: "Entr.", render: (r) => fmtInt(r.arrivals) },
      { label: "Sal.", render: (r) => fmtInt(r.departures) },
      { label: "No-show", render: (r) => fmtInt(r.noShows) },
      { label: "OOO", render: (r) => fmtInt(r.ooo) }
    ]
  },
  {
    label: "Pickup",
    cols: [
      { label: "Δ1d", render: (r) => dash(r.pickup1, signedInt) },
      { label: "Δ7d", render: (r) => dash(r.pickup7, signedInt) },
      { label: "Δ28d", render: (r) => dash(r.pickup28, signedInt) },
      { label: "ΔADR 7d", render: (r) => dash(r.pickupAdr7, signedMoney) }
    ]
  },
  {
    label: "Previsión",
    cols: [
      { label: "Hab", render: (r) => dash(r.fcRooms, fmtInt) },
      { label: "Occ %", render: (r) => dash(r.fcOccPct, fmtPct1) },
      { label: "ADR", render: (r) => dash(r.fcAdr, money) },
      { label: "Ingresos", render: (r) => dash(r.fcRevenue, money) },
      { label: "Conf.", render: (r) => dash(r.fcConfidence, fmtConfidence) }
    ]
  },
  {
    label: "STLY",
    cols: [
      { label: "Hab", render: (r) => dash(r.stlyRooms, fmtInt) },
      { label: "Occ %", render: (r) => dash(r.stlyOccPct, fmtPct1) },
      { label: "ADR", render: (r) => dash(r.stlyAdr, money) },
      { label: "Ingresos", render: (r) => dash(r.stlyRevenue, money) },
      { label: "Δ hab", render: (r) => dash(r.deltaRoomsVsStly, signedInt) },
      { label: "Δ €", render: (r) => dash(r.deltaRevVsStly, signedMoney) }
    ]
  },
  {
    label: "Presupuesto",
    cols: [
      { label: "€ día", render: (r) => dash(r.budgetRevenue, money) },
      { label: "Δ €", render: (r) => dash(r.deltaRevVsBudget, signedMoney) }
    ]
  }
];

function rowClass(r: BoardRow): string | undefined {
  if (r.rowType === "total") return "hfr-total";
  if (r.rowType === "monthSubtotal") return "hfr-month";
  if (r.rowType === "weekSubtotal") return "hfr-week";
  if (r.isToday) return "hfr-today";
  if (r.isPast) return "hfr-past";
  return undefined;
}

function firstCell(r: BoardRow): ReactNode {
  if (r.rowType === "data") {
    return (
      <>
        <strong>{r.date ? fmtDay(r.date) : "—"}</strong>
        <span className="hfr-dow"> {r.dow ?? ""}</span>
        {r.isToday ? <span className="hfr-hoy">hoy</span> : null}
      </>
    );
  }
  return r.label ?? (r.rowType === "total" ? "Total" : "Subtotal");
}

// ---- shared footer: metric dictionary + honest sources ---------------------
const SOURCE_LABELS: Record<string, string> = {
  history: "Histórico",
  otb: "OTB",
  forecast: "Previsión",
  stly: "STLY",
  budget: "Presupuesto",
  pickup: "Pickup"
};

function DefinitionsFooter(props: { notes: string[]; sources: Record<string, string> }) {
  const sourceEntries = Object.entries(props.sources ?? {});
  return (
    <article className="bo-card">
      <div className="bo-card-head">
        <h3>Definiciones</h3>
        <span className="bo-chip">Diccionario único de métricas</span>
      </div>
      {props.notes.length > 0 ? (
        <ul className="bo-list">
          {props.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="bo-muted">El servidor no devolvió notas de métricas.</p>
      )}
      {sourceEntries.length > 0 ? (
        <p className="bo-muted" style={{ textTransform: "none", fontSize: 12, marginTop: 8 }}>
          Fuentes: {sourceEntries.map(([key, value]) => `${SOURCE_LABELS[key] ?? key}: ${value}`).join(" · ")}
        </p>
      ) : null}
    </article>
  );
}

// Component-scoped styles. Design tokens only (theme-aware); the print block
// flattens sticky positioning and uses paper-neutral greys on purpose.
const REPORT_CSS = `
.hfr-wrap {
  overflow: auto;
  max-height: 72vh;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  margin-top: var(--space-2);
}
.hfr-table {
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  min-width: 1860px;
  font-size: 12px;
  font-feature-settings: "tnum" on;
}
.hfr-table th, .hfr-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-soft);
  text-align: right;
  white-space: nowrap;
}
.hfr-table thead th {
  box-sizing: border-box;
  height: 30px;
  background: var(--surface-soft);
  color: var(--ink-muted);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--line);
}
.hfr-h-groups th { position: sticky; top: 0; z-index: 3; text-align: left; font-weight: 700; color: var(--ink); }
.hfr-h-cols th { position: sticky; top: 30px; z-index: 3; }
.hfr-table th:first-child, .hfr-table td:first-child {
  position: sticky;
  left: 0;
  z-index: 2;
  text-align: left;
  background: var(--surface);
  border-right: 1px solid var(--line);
  min-width: 108px;
}
.hfr-h-groups th:first-child, .hfr-h-cols th:first-child { z-index: 4; background: var(--surface-soft); }
.hfr-gstart { border-left: 1px solid var(--line); }
.hfr-dow { color: var(--ink-muted); font-weight: 400; }
.hfr-hoy {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
tr.hfr-past td { color: var(--ink-muted); }
tr.hfr-today td { background: var(--accent-soft); font-weight: 600; border-top: 1px solid var(--accent); border-bottom: 1px solid var(--accent); }
tr.hfr-today td:first-child { background: var(--accent-soft); }
tr.hfr-week td { background: var(--surface-soft); font-weight: 700; }
tr.hfr-week td:first-child { background: var(--surface-soft); }
tr.hfr-month td { background: var(--surface-soft); font-weight: 700; border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); }
tr.hfr-month td:first-child { background: var(--surface-soft); }
tr.hfr-total td { background: var(--inverse-surface); color: var(--inverse-ink); font-weight: 700; border-bottom: none; }
tr.hfr-total td:first-child { background: var(--inverse-surface); color: var(--inverse-ink); }
@media print {
  @page { size: A4 landscape; margin: 10mm; }
  .hfr-controls, .hfr-legend-note { display: none !important; }
  .hfr-wrap { max-height: none !important; overflow: visible !important; border: none !important; border-radius: 0; }
  .hfr-table { min-width: 0 !important; font-size: 8px; }
  .hfr-table th, .hfr-table td { padding: 2px 4px !important; height: auto !important; }
  .hfr-h-groups th, .hfr-h-cols th, .hfr-table th:first-child, .hfr-table td:first-child { position: static !important; }
  tr.hfr-total td { background: #e5e5e5 !important; color: #000 !important; }
  tr.hfr-today td { border-color: #999 !important; }
}
`;

export function RevenueHistoryForecastReport() {
  const [preset, setPreset] = useState<string>("-7+90");
  const [from, setFrom] = useState<string>(() => addDaysIso(todayIso(), -7));
  const [to, setTo] = useState<string>(() => addDaysIso(todayIso(), 90));
  const [board, setBoard] = useState<HistoryForecastBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"csv" | "xls" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBoard(await fetchHistoryForecastBoard({ from, to }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el informe.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyPreset(id: string) {
    const p = RANGE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    const r = p.range();
    setPreset(id);
    setFrom(r.from);
    setTo(r.to);
  }

  async function handleExport(format: "csv" | "xls") {
    setExporting(format);
    setExportError(null);
    try {
      const resp = await generateRevenueExport({ exportCode: "hf_daily", format, from, to });
      downloadGeneratedExport(resp);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "No se pudo generar el export.");
    } finally {
      setExporting(null);
    }
  }

  const dataDays = useMemo(() => (board?.rows ?? []).filter((r) => r.rowType === "data").length, [board]);

  return (
    <>
      <NarrowViewportBanner />
      <style>{REPORT_CSS}</style>
      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Revenue · Informe detallado</p>
            <h2>Informe History &amp; Forecast{board ? ` — ${board.propertyName}` : ""}</h2>
            {board ? (
              <p className="bo-muted" style={{ margin: "4px 0 0", textTransform: "none", fontSize: 12 }}>
                Datos a cierre de {fmtDateFull(board.businessDate)} · OTB a las {fmtOtbTime(board.generatedAt)} (Europe/Madrid) · {fmtDateFull(board.from)} → {fmtDateFull(board.to)} · {fmtInt(board.totalRooms)} hab. totales
              </p>
            ) : null}
          </div>
          <div className="bo-pill-row">
            <span className="bo-status info" style={{ textTransform: "none" }}>En vivo</span>
            <button type="button" onClick={() => navigateTo("RevenueHistoryForecastDashboard")}>← Panel H&amp;F</button>
            <button type="button" onClick={() => void load()} disabled={loading}>
              {loading ? <><Spinner size="sm" /> Cargando…</> : "↻ Actualizar"}
            </button>
          </div>
        </div>

        <div className="bo-row hfr-controls" style={{ gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
          <span className="bo-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Rango</span>
          <div className="bo-pill-row">
            {RANGE_PRESETS.map((p) => (
              <button key={p.id} type="button" className={`bo-pill${preset === p.id ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => applyPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
            <input type="date" value={from} max={to} onChange={(e) => { setPreset(""); setFrom(e.target.value); }} />
            <span className="bo-muted">→</span>
            <input type="date" value={to} min={from} onChange={(e) => { setPreset(""); setTo(e.target.value); }} />
          </div>
          <div className="bo-row" style={{ gap: 8, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" onClick={() => void handleExport("csv")} disabled={exporting !== null || loading || !board}>
              {exporting === "csv" ? <><Spinner size="sm" /> Generando…</> : "Exportar CSV"}
            </button>
            <button type="button" onClick={() => void handleExport("xls")} disabled={exporting !== null || loading || !board}>
              {exporting === "xls" ? <><Spinner size="sm" /> Generando…</> : "Exportar Excel"}
            </button>
            <button type="button" onClick={() => window.print()} disabled={loading || !board}>Imprimir</button>
          </div>
        </div>
        {exportError ? (
          <p role="alert" style={{ color: "var(--danger-ink)", fontSize: 13, margin: "8px 0 0" }}>
            {exportError}
          </p>
        ) : null}

        {loading && !board ? (
          <>
            <LoadingBlock label="Cargando informe History & Forecast…" />
            <div style={{ marginTop: 16 }}>
              <SkeletonLines lines={10} />
            </div>
          </>
        ) : error ? (
          <ErrorState title="No se pudo cargar el informe" message={error} onRetry={() => void load()} />
        ) : board ? (
          <>
            {board.forecastMissing || board.budgetMissing ? (
              <p className="bo-muted" style={{ textTransform: "none", fontSize: 13, margin: "12px 0 0" }}>
                {board.forecastMissing ? (
                  <>
                    <span className="bo-status warn" style={{ textTransform: "none" }}>Sin previsión</span>{" "}
                    No hay previsión generada en la ventana — el bloque Previsión aparece vacío. Genera la previsión desde el panel H&amp;F.{" "}
                  </>
                ) : null}
                {board.budgetMissing ? (
                  <>
                    <span className="bo-status info" style={{ textTransform: "none" }}>Sin presupuesto</span>{" "}
                    Carga el presupuesto mensual para ver desviaciones frente a presupuesto.
                  </>
                ) : null}
              </p>
            ) : null}

            {dataDays === 0 ? (
              <p className="bo-muted" style={{ marginTop: 16 }}>
                No hay fechas en el rango seleccionado. Ajusta el rango y vuelve a cargar.
              </p>
            ) : (
              <>
                <p className="bo-muted hfr-legend-note" style={{ textTransform: "none", fontSize: 12, margin: "12px 0 0" }}>
                  {fmtInt(dataDays)} días · pasado atenuado = cierre auditado · hoy resaltado · previsión y pickup solo en fechas futuras · subtotales por semana ISO y mes calculados por el servidor.
                </p>
                <div className="hfr-wrap">
                  <table className="hfr-table">
                    <thead>
                      <tr className="hfr-h-groups">
                        <th aria-label="Fecha" />
                        {COLUMN_GROUPS.map((g) => (
                          <th key={g.label} colSpan={g.cols.length} className="hfr-gstart">
                            {g.label}
                          </th>
                        ))}
                      </tr>
                      <tr className="hfr-h-cols">
                        <th>Fecha</th>
                        {COLUMN_GROUPS.flatMap((g) =>
                          g.cols.map((c, i) => (
                            <th key={`${g.label}-${c.label}`} className={i === 0 ? "hfr-gstart" : undefined}>
                              {c.label}
                            </th>
                          ))
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {board.rows.map((row, idx) => (
                        <tr key={`${row.rowType}-${row.date ?? row.label ?? ""}-${idx}`} className={rowClass(row)}>
                          <td>{firstCell(row)}</td>
                          {COLUMN_GROUPS.flatMap((g) =>
                            g.cols.map((c, i) => (
                              <td key={`${g.label}-${c.label}`} className={i === 0 ? "hfr-gstart" : undefined}>
                                {c.render(row)}
                              </td>
                            ))
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ marginTop: 16 }}>
              <DefinitionsFooter notes={board.metricNotes} sources={board.sources} />
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
