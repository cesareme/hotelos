// History & Forecast board (contract frozen 2026-07-15).
//
// Every figure on this screen comes from GET
// /revenue/properties/:id/history-forecast/board (fetchHistoryForecastBoard) —
// nothing is invented client-side. Forecast confidence is displayed as a
// percentage badge, never as a fabricated confidence band. When the server
// reports forecastMissing/budgetMissing the UI says so honestly and offers
// the real remediation (generate forecasts / load budget).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchHistoryForecastBoard,
  generateForecasts,
  money,
  type BoardRow,
  type CriticalDate,
  type HistoryForecastBoard,
  type MonthOutlook
} from "../../services/revenueApi";
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
const nfCompact = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });

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
function signedPct1(n: number): string {
  return `${n > 0 ? "+" : ""}${nfPct1.format(n)} %`;
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
function confidenceTone(c: number): "ok" | "warn" | "error" {
  const pct = c > 1.5 ? c : c * 100;
  if (pct >= 75) return "ok";
  if (pct >= 50) return "warn";
  return "error";
}

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
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

// ---- SVG line chart wired to real board rows --------------------------------
// Solid line = actual (past) / OTB (today); dashed line = server forecast.
// No confidence bands: confidence is a %, not a drawable interval.
type ChartPoint = { date: string; solid: number | null; dashed: number | null; isToday: boolean };

function buildPath(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let penDown = false;
  values.forEach((v, i) => {
    if (v === null) {
      penDown = false;
      return;
    }
    d += `${penDown ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    penDown = true;
  });
  return d.trim();
}

function BoardLineChart(props: { points: ChartPoint[]; fmtValue: (n: number) => string; fmtAxis: (n: number) => string; suggestedMax?: number }) {
  const { points } = props;
  const width = 760;
  const height = 230;
  const padL = 50;
  const padR = 14;
  const padT = 14;
  const padB = 30;

  const values = points.flatMap((p) => [p.solid, p.dashed].filter((v): v is number => v !== null));
  if (points.length === 0 || values.length === 0) {
    return <p className="bo-muted">Sin datos para el gráfico en el rango seleccionado.</p>;
  }
  const maxV = Math.max(...values, props.suggestedMax ?? 0, 1);
  const x = (i: number) => padL + (points.length === 1 ? 0 : (i / (points.length - 1)) * (width - padL - padR));
  const y = (v: number) => padT + (1 - v / maxV) * (height - padT - padB);

  const solidPath = buildPath(points.map((p) => p.solid), x, y);
  const dashedPath = buildPath(points.map((p) => p.dashed), x, y);
  const todayIdx = points.findIndex((p) => p.isToday);
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxV * f);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" style={{ width: "100%", height: "auto", display: "block" }}>
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line x1={padL} y1={y(t)} x2={width - padR} y2={y(t)} stroke="var(--line-soft)" strokeWidth={1} />
          <text x={padL - 6} y={y(t) + 3} fontSize={10} fill="var(--ink-muted)" textAnchor="end">
            {props.fmtAxis(t)}
          </text>
        </g>
      ))}
      {todayIdx >= 0 ? (
        <g>
          <line x1={x(todayIdx)} y1={padT} x2={x(todayIdx)} y2={height - padB} stroke="var(--warn-ink)" strokeWidth={1} strokeDasharray="3 3" />
          <text x={x(todayIdx)} y={padT - 2} fontSize={9} fill="var(--warn-ink)" textAnchor="middle" fontWeight={700}>
            HOY
          </text>
        </g>
      ) : null}
      {solidPath ? <path d={solidPath} fill="none" stroke="var(--inverse-surface)" strokeWidth={2} /> : null}
      {dashedPath ? <path d={dashedPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="6 4" /> : null}
      {points.map((p, i) =>
        p.solid !== null ? (
          <circle key={`s-${p.date}`} cx={x(i)} cy={y(p.solid)} r={2} fill="var(--inverse-surface)">
            <title>{`${fmtDay(p.date)} · actual/OTB: ${props.fmtValue(p.solid)}`}</title>
          </circle>
        ) : null
      )}
      {points.map((p, i) =>
        p.dashed !== null ? (
          <circle key={`f-${p.date}`} cx={x(i)} cy={y(p.dashed)} r={2} fill="var(--accent)">
            <title>{`${fmtDay(p.date)} · previsión: ${props.fmtValue(p.dashed)}`}</title>
          </circle>
        ) : null
      )}
      {points.map((p, i) =>
        i % labelStep === 0 ? (
          <text key={`x-${p.date}`} x={x(i)} y={height - 8} fontSize={9} fill="var(--ink-muted)" textAnchor="middle">
            {fmtDay(p.date)}
          </text>
        ) : null
      )}
    </svg>
  );
}

// ---- month outlook cards ("mes en curso +3") --------------------------------
const MONTH_STATUS: Record<MonthOutlook["status"], { label: string; badge: "ok" | "warn" | "error" | "info"; ink: string }> = {
  ok: { label: "En objetivo", badge: "ok", ink: "var(--ok-ink)" },
  warn: { label: "Vigilar", badge: "warn", ink: "var(--warn-ink)" },
  risk: { label: "Riesgo", badge: "error", ink: "var(--danger-ink)" },
  no_budget: { label: "Sin presupuesto", badge: "info", ink: "var(--ink-muted)" }
};

function MonthCard(props: { month: MonthOutlook }) {
  const m = props.month;
  const meta = MONTH_STATUS[m.status];
  return (
    <article className="bo-card">
      <div className="bo-card-head">
        <h3 style={{ fontSize: 14, textTransform: "capitalize" }}>{m.label}</h3>
        <span className={`bo-status ${meta.badge}`} style={{ textTransform: "none" }}>{meta.label}</span>
      </div>
      <div className="bo-metric" style={{ fontVariantNumeric: "tabular-nums" }}>{money(m.projectedRevenue)}</div>
      <p className="bo-muted" style={{ textTransform: "none", fontSize: 12, margin: "2px 0 0" }}>
        {m.forecastRevenue !== null
          ? `Proyección = real ${money(m.actualRevenue)} + prev. resto de mes ${money(m.forecastRevenue)} · OTB actual ${money(m.otbRevenue)}`
          : `Proyección = real ${money(m.actualRevenue)} + OTB ${money(m.otbRevenue)} (sin previsión)`}
      </p>
      {m.projectedOccPct !== null || m.projectedAdr !== null ? (
        <p className="bo-muted" style={{ textTransform: "none", fontSize: 12, margin: 0 }}>
          {m.projectedOccPct !== null ? `Occ ${fmtPct1(m.projectedOccPct)}` : ""}
          {m.projectedOccPct !== null && m.projectedAdr !== null ? " · " : ""}
          {m.projectedAdr !== null ? `ADR ${money(m.projectedAdr)}` : ""}
        </p>
      ) : null}
      <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 8, paddingTop: 8, display: "grid", gap: 4 }}>
        {m.budgetRevenue !== null ? (
          <>
            <p style={{ margin: 0, fontSize: 13 }}>
              Presupuesto: <strong>{money(m.budgetRevenue)}</strong>
            </p>
            <p style={{ margin: 0, fontSize: 13, color: meta.ink, fontWeight: 700 }}>
              Gap: {dash(m.gapToBudget, signedMoney)}
              {m.gapPct !== null ? ` (${signedPct1(m.gapPct)})` : ""}
            </p>
          </>
        ) : (
          <p className="bo-muted" style={{ margin: 0, fontSize: 12.5, textTransform: "none" }}>Sin presupuesto cargado</p>
        )}
        <p className="bo-muted" style={{ margin: 0, fontSize: 12, textTransform: "none" }}>
          Cierre LY: {dash(m.lyRevenue, money)}
          {m.lyOccPct !== null ? ` · Occ ${fmtPct1(m.lyOccPct)}` : ""}
          {m.lyAdr !== null ? ` · ADR ${money(m.lyAdr)}` : ""}
        </p>
        {m.daysElapsed > 0 && m.daysElapsed < m.daysTotal ? (
          <p className="bo-muted" style={{ margin: 0, fontSize: 12, textTransform: "none" }}>Día {m.daysElapsed} de {m.daysTotal}</p>
        ) : null}
      </div>
    </article>
  );
}

// ---- critical dates table ----------------------------------------------------
function CriticalDatesTable(props: { dates: CriticalDate[] }) {
  return (
    <div className="rev-report-wrap hfb-crit">
      <table className="rev-report-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Vista</th>
            <th>Severidad</th>
            <th className="hfb-left">Motivo</th>
            <th>Occ OTB</th>
            <th>Occ prev.</th>
            <th>Occ STLY</th>
            <th>Pickup 7d</th>
            <th className="hfb-left">Recomendación BAR</th>
            <th>Compset (med.)</th>
          </tr>
        </thead>
        <tbody>
          {props.dates.map((d) => (
            <tr key={d.date}>
              <td>
                {fmtDay(d.date)} <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>{d.dow}</span>
              </td>
              <td>{fmtInt(d.daysOut)} d</td>
              <td>
                <span className={`bo-status ${d.severity === "high" ? "error" : "warn"}`} style={{ textTransform: "none" }}>
                  {d.severity === "high" ? "Alta" : "Media"}
                </span>
              </td>
              <td className="hfb-left">{d.reason}</td>
              <td>{fmtPct1(d.occPct)}</td>
              <td>{dash(d.fcOccPct, fmtPct1)}</td>
              <td>{dash(d.stlyOccPct, fmtPct1)}</td>
              <td>{dash(d.pickup7, signedInt)}</td>
              <td className="hfb-left">{d.recommendation ?? "—"}</td>
              <td>{dash(d.compsetMedian, money)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Component-scoped styles: only design tokens, no hardcoded colors.
const BOARD_CSS = `
.hfb-crit td.hfb-left, .hfb-crit th.hfb-left { text-align: left; white-space: normal; }
.hfb-crit td.hfb-left { max-width: 280px; font-weight: 400; }
.hfb-months { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(235px, 1fr)); margin-top: var(--space-2); }
`;

export function RevenueHistoryForecastDashboard() {
  const [preset, setPreset] = useState<string>("-7+90");
  const [from, setFrom] = useState<string>(() => addDaysIso(todayIso(), -7));
  const [to, setTo] = useState<string>(() => addDaysIso(todayIso(), 90));
  const [board, setBoard] = useState<HistoryForecastBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBoard(await fetchHistoryForecastBoard({ from, to }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el board de History & Forecast.");
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

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      await generateForecasts();
      await load();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "No se pudo generar la previsión.");
    } finally {
      setGenerating(false);
    }
  }

  const dataRows = useMemo<BoardRow[]>(() => (board?.rows ?? []).filter((r) => r.rowType === "data" && Boolean(r.date)), [board]);

  const occPoints = useMemo<ChartPoint[]>(
    () =>
      dataRows.map((r) => ({
        date: r.date as string,
        solid: r.isPast || r.isToday ? r.occPct : null,
        dashed: r.fcOccPct,
        isToday: Boolean(r.isToday)
      })),
    [dataRows]
  );
  const revenuePoints = useMemo<ChartPoint[]>(
    () =>
      dataRows.map((r) => ({
        date: r.date as string,
        solid: r.isPast || r.isToday ? r.roomRevenue : null,
        dashed: r.fcRevenue,
        isToday: Boolean(r.isToday)
      })),
    [dataRows]
  );

  const k = board?.kpis;
  const confidence = k?.forecastConfidenceAvg ?? null;
  const mtdVsStly = k?.mtd.vsStlyRevenuePct ?? null;

  return (
    <>
      <NarrowViewportBanner />
      <style>{BOARD_CSS}</style>
      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Revenue · Histórico y previsión</p>
            <h2>{board?.propertyName ?? "Histórico y previsión"}</h2>
            {board ? (
              <p className="bo-muted" style={{ margin: "4px 0 0", textTransform: "none", fontSize: 12 }}>
                Datos a cierre de {fmtDateFull(board.businessDate)} · OTB a las {fmtOtbTime(board.generatedAt)} (Europe/Madrid) · Ventana {fmtDateFull(board.from)} → {fmtDateFull(board.to)}
              </p>
            ) : null}
          </div>
          <div className="bo-pill-row">
            {board ? <span className="bo-chip">{fmtInt(board.totalRooms)} hab. totales</span> : null}
            <span className="bo-status info" style={{ textTransform: "none" }}>En vivo</span>
            <button type="button" onClick={() => void load()} disabled={loading}>
              {loading ? <><Spinner size="sm" /> Cargando…</> : "↻ Actualizar"}
            </button>
            <button type="button" className="primary" onClick={() => navigateTo("RevenueHistoryForecastReport")}>
              Ver informe detallado
            </button>
          </div>
        </div>

        <div className="bo-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
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
        </div>

        {loading && !board ? (
          <>
            <LoadingBlock label="Cargando board de History & Forecast…" />
            <div style={{ marginTop: 16 }}>
              <SkeletonLines lines={8} />
            </div>
          </>
        ) : error ? (
          <ErrorState title="No se pudo cargar el board" message={error} onRetry={() => void load()} />
        ) : board ? (
          <>
            {board.forecastMissing ? (
              <article className="bo-card rev-alert" style={{ marginTop: 12 }}>
                <div className="bo-card-head">
                  <h3>Sin previsión generada en la ventana</h3>
                  <span className="bo-status warn" style={{ textTransform: "none" }}>Acción requerida</span>
                </div>
                <p>
                  No hay filas de previsión para estas fechas, así que los bloques de previsión y la confianza aparecen vacíos — este board nunca inventa datos.
                </p>
                {genError ? (
                  <p role="alert" style={{ color: "var(--danger-ink)", fontSize: 13, margin: "4px 0" }}>{genError}</p>
                ) : null}
                <div className="bo-actions">
                  <button type="button" className="primary" onClick={() => void handleGenerate()} disabled={generating}>
                    {generating ? <><Spinner size="sm" /> Generando previsión…</> : "Generar previsión (90 días)"}
                  </button>
                </div>
              </article>
            ) : null}
            {board.budgetMissing ? (
              <p className="bo-muted" style={{ textTransform: "none", fontSize: 13, margin: "12px 0 0" }}>
                <span className="bo-status info" style={{ textTransform: "none" }}>Sin presupuesto</span>{" "}
                Carga el presupuesto mensual para ver desviaciones frente a presupuesto.
              </p>
            ) : null}

            {k ? (
              <div className="rev-kpi-grid" style={{ marginTop: 16 }}>
                <article className="rev-kpi">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Próximos 7 días (OTB)</span></div>
                  <div className="rev-kpi-value">{money(k.next7.revenue)}</div>
                  <div className="rev-kpi-delta">
                    {fmtInt(k.next7.roomsSold)} hab · {fmtPct1(k.next7.occPct)} · ADR {dash(k.next7.adr, money)}
                  </div>
                  <div className="rev-kpi-delta" style={k.next7.pickup7 !== null && k.next7.pickup7 < 0 ? { color: "var(--danger-ink)" } : undefined}>
                    Pickup 7d: {dash(k.next7.pickup7, (n) => `${signedInt(n)} hab`)}
                  </div>
                </article>
                <article className="rev-kpi">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Próximos 30 días (OTB)</span></div>
                  <div className="rev-kpi-value">{money(k.next30.revenue)}</div>
                  <div className="rev-kpi-delta">
                    {fmtInt(k.next30.roomsSold)} hab · {fmtPct1(k.next30.occPct)} · ADR {dash(k.next30.adr, money)}
                  </div>
                  <div className="rev-kpi-delta" style={k.next30.pickup7 !== null && k.next30.pickup7 < 0 ? { color: "var(--danger-ink)" } : undefined}>
                    Pickup 7d: {dash(k.next30.pickup7, (n) => `${signedInt(n)} hab`)}
                  </div>
                </article>
                <article className={`rev-kpi${mtdVsStly !== null ? (mtdVsStly >= 0 ? " rev-kpi-ok" : " rev-kpi-warn") : ""}`}>
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Mes en curso (MTD)</span></div>
                  <div className="rev-kpi-value">{money(k.mtd.revenue)}</div>
                  <div className="rev-kpi-delta">
                    {fmtInt(k.mtd.roomsSold)} hab · {fmtPct1(k.mtd.occPct)} · ADR {dash(k.mtd.adr, money)}
                  </div>
                  <div className="rev-kpi-delta" style={mtdVsStly !== null ? { color: mtdVsStly >= 0 ? "var(--ok-ink)" : "var(--danger-ink)", fontWeight: 600 } : undefined}>
                    vs STLY: {dash(mtdVsStly, signedPct1)}
                  </div>
                </article>
                <article className={`rev-kpi${confidence !== null ? ` rev-kpi-${confidenceTone(confidence)}` : ""}`}>
                  <div className="rev-kpi-head">
                    <span className="rev-kpi-label">Confianza media</span>
                    <span className="rev-kpi-tag">previsión</span>
                  </div>
                  <div className="rev-kpi-value">{dash(confidence, fmtConfidence)}</div>
                  <div className="rev-kpi-delta">
                    {confidence === null ? "Genera la previsión para activar este KPI" : "Media de la ventana con previsión"}
                  </div>
                </article>
              </div>
            ) : null}

            <article className="bo-card" style={{ marginTop: 16 }}>
              <div className="bo-card-head">
                <h3>Mes en curso +3 — proyección vs presupuesto</h3>
                <span className="bo-chip">{board.months.length} meses</span>
              </div>
              {board.months.length > 0 ? (
                <div className="hfb-months">
                  {board.months.map((m) => (
                    <MonthCard key={m.month} month={m} />
                  ))}
                </div>
              ) : (
                <p className="bo-muted">El servidor no devolvió proyección mensual.</p>
              )}
            </article>

            <div className="rev-legend" style={{ marginTop: 16 }}>
              <span className="rev-legend-item history">Actual / OTB</span>
              <span className="rev-legend-item forecast">Previsión</span>
              <span className="rev-legend-business">Hoy marcado en ámbar</span>
            </div>

            <div className="bo-grid two" style={{ marginTop: 8 }}>
              <article className="bo-card">
                <h3>Ocupación % — actual vs previsión</h3>
                <BoardLineChart
                  points={occPoints}
                  fmtValue={fmtPct1}
                  fmtAxis={(n) => `${Math.round(n)} %`}
                  suggestedMax={100}
                />
              </article>
              <article className="bo-card">
                <h3>Ingresos de habitaciones (€/día)</h3>
                <BoardLineChart
                  points={revenuePoints}
                  fmtValue={money}
                  fmtAxis={(n) => `${nfCompact.format(n)} €`}
                />
              </article>
            </div>

            <article className="bo-card" style={{ marginTop: 16 }}>
              <div className="bo-card-head">
                <h3>Fechas críticas</h3>
                <span className="bo-chip">{board.criticalDates.length} de un máximo de 10</span>
              </div>
              {board.criticalDates.length > 0 ? (
                <CriticalDatesTable dates={board.criticalDates} />
              ) : (
                <p className="bo-muted">
                  Sin fechas críticas detectadas en la ventana: ninguna fecha supera los umbrales de demanda, ritmo o pickup.
                </p>
              )}
            </article>

            <div style={{ marginTop: 16 }}>
              <DefinitionsFooter notes={board.metricNotes} sources={board.sources} />
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}
