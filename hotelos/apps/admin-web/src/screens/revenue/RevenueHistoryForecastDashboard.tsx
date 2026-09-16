// History & Forecast board (contract frozen 2026-07-15).
//
// Every figure on this screen comes from GET
// /revenue/properties/:id/history-forecast/board (fetchHistoryForecastBoard) —
// nothing is invented client-side. Forecast confidence is displayed as a
// percentage badge, never as a fabricated confidence band. When the server
// reports forecastMissing/budgetMissing the UI says so honestly and offers
// the real remediation (generate forecasts / load budget).
//
// Cocoa 22 (ola 5 · lote 5-B): dashboard hosted in HistoricoPrevisionTabs
// (DashboardAlojado). Range toolbar (segmented presets + two date pickers) →
// honest callouts (forecast / budget missing) → KPI strip → month outlook
// cards in a 3-column grid → 6/6 line charts (real/OTB vs forecast) →
// critical dates table → metric dictionary. Same endpoint, same actions.
import { useTabHost } from "../tabs/TabHost";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  fetchHistoryForecastBoard,
  generateForecasts,
  type BoardRow,
  type CriticalDate,
  type HistoryForecastBoard,
  type MonthOutlook
} from "../../services/revenueApi";
import { getActiveProperty } from "../../services/activeProperty";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaField,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  toneInk,
  type CocoaKpiStatus,
  type CocoaLineSeries,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

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
const PRESET_OPTIONS = RANGE_PRESETS.map((p) => ({ value: p.id, label: p.label }));

// ---- number/date formatting (es-ES) ----------------------------------------

function fmtInt(n: number): string {
  return number(n, { maximumFractionDigits: 0 });
}
function fmtPct1(n: number): string {
  return percent(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
/** Confidence can arrive as 0..1 or 0..100 depending on the model row; normalize defensively. */
function fmtConfidence(n: number): string {
  const pct = n > 1.5 ? n : n * 100;
  return percent(pct, { maximumFractionDigits: 0 });
}
function signedInt(n: number): string {
  return number(n, { maximumFractionDigits: 0, signDisplay: "exceptZero" });
}
function signedMoney(n: number): string {
  return money(n, { signDisplay: "exceptZero" });
}
function signedPct1(n: number): string {
  return percent(n, { signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function dash<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  return value === null || value === undefined ? "—" : fmt(value);
}
function confidenceStatus(c: number): CocoaKpiStatus {
  const pct = c > 1.5 ? c : c * 100;
  if (pct >= 75) return "ok";
  if (pct >= 50) return "warning";
  return "critical";
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
    <CocoaSection
      title="Definiciones"
      meta="Diccionario único de métricas"
      footer={sourceEntries.length > 0 ? <span>Fuentes: {sourceEntries.map(([key, value]) => `${SOURCE_LABELS[key] ?? key}: ${value}`).join(" · ")}</span> : undefined}
    >
      {props.notes.length > 0 ? (
        <ul className="c22-section__list" aria-label="Definiciones de las métricas">
          {props.notes.map((note) => (
            <li key={note}>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : (
        <CocoaState kind="empty" inline title="El servidor no devolvió notas de métricas." />
      )}
    </CocoaSection>
  );
}

// ---- line charts wired to real board rows -----------------------------------
// Solid line = actual (past, audited) / OTB (today and future); dashed line =
// server forecast, which only exists from today on. CocoaChart.Line aligns the
// series by index and cannot leave a gap, so before today the forecast series
// follows the real figure (the dashed line sits under the solid one and only
// diverges from today): the legend says «desde hoy». Handoff: gaps in
// CocoaLinePoint (`y: number | null`).
function boardSeries(rows: BoardRow[], pick: (r: BoardRow) => number, pickForecast: (r: BoardRow) => number | null, forecastAvailable: boolean): CocoaLineSeries[] {
  const label = (r: BoardRow) => `${date(r.date, "dayMonth")}${r.isToday ? " · hoy" : ""}`;
  const series: CocoaLineSeries[] = [{ id: "real", label: "Real / OTB", points: rows.map((r) => ({ x: label(r), y: pick(r) })), tone: "accent", width: 2 }];
  if (forecastAvailable) {
    series.push({
      id: "forecast",
      label: "Previsión (desde hoy)",
      points: rows.map((r) => ({ x: label(r), y: pickForecast(r) ?? pick(r) })),
      tone: "warning",
      dashed: true,
      width: 2
    });
  }
  return series;
}

// ---- month outlook cards ("mes en curso +3") --------------------------------
const MONTH_STATUS: Record<MonthOutlook["status"], { label: string; tone: CocoaTone }> = {
  ok: { label: "En objetivo", tone: "success" },
  warn: { label: "Vigilar", tone: "warning" },
  risk: { label: "Riesgo", tone: "danger" },
  no_budget: { label: "Sin presupuesto", tone: "neutral" }
};

// Text ≤ 13 px in a tone: AA ink (rule 6, named object outside the literal).
function inkStyle(tone: CocoaTone): CSSProperties {
  return { color: toneInk(tone) };
}
// Secondary explanatory line under a figure (callout size, secondary label).
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-leading-text)", color: "var(--cocoa-label-secondary)" };

/** «Occ x % · ADR y €» caption under a revenue figure; nothing when neither is known. */
function occAdrHint(occPct: number | null, adr: number | null): string | undefined {
  const parts = [occPct !== null ? `Occ ${fmtPct1(occPct)}` : "", adr !== null ? `ADR ${money(adr)}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function MonthCard(props: { month: MonthOutlook }) {
  const m = props.month;
  const meta = MONTH_STATUS[m.status];
  return (
    <CocoaSection title={m.label} meta={<CocoaBadge tone={meta.tone}>{meta.label}</CocoaBadge>}>
      <CocoaStat label="Proyección del mes" value={money(m.projectedRevenue)} size="large" hint={occAdrHint(m.projectedOccPct, m.projectedAdr)} />
      <p style={noteStyle}>
        {m.forecastRevenue !== null
          ? `Proyección = real ${money(m.actualRevenue)} + previsión del resto del mes ${money(m.forecastRevenue)} · OTB actual ${money(m.otbRevenue)}`
          : `Proyección = real ${money(m.actualRevenue)} + OTB ${money(m.otbRevenue)} (sin previsión)`}
      </p>
      {/* Last year's close mirrors the projection (figure + «Occ · ADR» caption).
          As a list value the three fragments shared one nowrap <strong> (266 px)
          inside the 245 px card of the 3-column grid at 1440 and pushed `main`
          into horizontal scroll (qa#2); CocoaStat wraps its own value and hint. */}
      <CocoaStat label="Cierre del año anterior" value={dash(m.lyRevenue, money)} hint={occAdrHint(m.lyOccPct, m.lyAdr)} />
      <ul className="c22-section__list" aria-label={`Presupuesto y avance de ${m.label}`}>
        {m.budgetRevenue !== null ? (
          <>
            <li>
              <span>Presupuesto</span>
              <strong>{money(m.budgetRevenue)}</strong>
            </li>
            <li>
              <span>Diferencia con el presupuesto</span>
              <strong style={inkStyle(meta.tone)}>
                {dash(m.gapToBudget, signedMoney)}
                {m.gapPct !== null ? ` (${signedPct1(m.gapPct)})` : ""}
              </strong>
            </li>
          </>
        ) : (
          <li>
            <span>Presupuesto</span>
            <span>Sin presupuesto cargado</span>
          </li>
        )}
        {m.daysElapsed > 0 && m.daysElapsed < m.daysTotal ? (
          <li>
            <span>Avance del mes</span>
            <strong>
              Día {fmtInt(m.daysElapsed)} de {fmtInt(m.daysTotal)}
            </strong>
          </li>
        ) : null}
      </ul>
    </CocoaSection>
  );
}

// ---- critical dates table ----------------------------------------------------
const CRITICAL_COLUMNS: CocoaTableColumn<CriticalDate>[] = [
  {
    key: "date",
    label: "Fecha",
    fit: true,
    render: (d) => (
      <>
        <strong>{date(d.date, "dayMonth")}</strong> <span style={noteStyle}>{d.dow}</span>
      </>
    )
  },
  { key: "daysOut", label: "Vista", align: "right", fit: true, render: (d) => `${fmtInt(d.daysOut)} d` },
  { key: "severity", label: "Severidad", fit: true, render: (d) => <CocoaBadge tone={d.severity === "high" ? "danger" : "warning"}>{d.severity === "high" ? "Alta" : "Media"}</CocoaBadge> },
  { key: "reason", label: "Motivo", minWidth: 200, render: (d) => d.reason },
  { key: "occPct", label: "Occ OTB", align: "right", fit: true, render: (d) => fmtPct1(d.occPct) },
  { key: "fcOccPct", label: "Occ prev.", align: "right", fit: true, render: (d) => dash(d.fcOccPct, fmtPct1), showFrom: "laptop" },
  { key: "stlyOccPct", label: "Occ STLY", align: "right", fit: true, render: (d) => dash(d.stlyOccPct, fmtPct1), showFrom: "laptop" },
  { key: "pickup7", label: "Pickup 7 d", align: "right", fit: true, render: (d) => dash(d.pickup7, signedInt), hideOnNarrow: true },
  { key: "recommendation", label: "Recomendación BAR", minWidth: 160, render: (d) => d.recommendation ?? "—", showFrom: "desktop" },
  { key: "compsetMedian", label: "Compset (mediana)", align: "right", fit: true, render: (d) => dash(d.compsetMedian, money), showFrom: "laptop" }
];

// Skeleton espejo: strip of 4 KPI, then 12 · 6/6 · 12.
function BoardSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[12], [6, 6], [12]]} height={240} />
    </div>
  );
}

export function RevenueHistoryForecastDashboard() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const header = treeHeaderFor("RevenueHistoryForecastDashboard", { eyebrow: "Revenue", title: "Histórico y previsión" });
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
      setError(e instanceof Error ? e.message : "No se pudo cargar el cuadro de histórico y previsión.");
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
  const forecastAvailable = useMemo(() => dataRows.some((r) => r.fcOccPct !== null), [dataRows]);
  const occSeries = useMemo(() => boardSeries(dataRows, (r) => r.occPct, (r) => r.fcOccPct, forecastAvailable), [dataRows, forecastAvailable]);
  const revenueSeries = useMemo(() => boardSeries(dataRows, (r) => r.roomRevenue, (r) => r.fcRevenue, forecastAvailable), [dataRows, forecastAvailable]);

  const k = board?.kpis;
  const confidence = k?.forecastConfidenceAvg ?? null;
  const mtdVsStly = k?.mtd.vsStlyRevenuePct ?? null;
  const openReport = () => navigateTo("RevenueHistoryForecastReport");

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle={hosted ? undefined : "Cuadro de histórico y previsión: ventana de fechas, indicadores, proyección mensual, gráficos y fechas críticas."}
      actions={
        <>
          {board ? <CocoaBadge tone="neutral">{plural(board.totalRooms, "habitación total", "habitaciones totales")}</CocoaBadge> : null}
          <CocoaBadge tone="success" variant="dot">
            En vivo
          </CocoaBadge>
          {error && board ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openReport}>
            Ver informe detallado
          </CocoaButton>
        </>
      }
      state={loading && !board ? "loading" : error && !board ? "error" : "ready"}
      skeleton={<BoardSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "historico-prevision-refresh", label: "Actualizar histórico y previsión", run: () => void load() },
        { id: "historico-prevision-report", label: "Ver informe detallado de histórico y previsión", run: openReport },
        { id: "historico-prevision-generate", label: "Generar previsión (90 días)", run: () => void handleGenerate() }
      ]}
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Ventana de fechas"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Rango">
              <CocoaSegmentedControl value={preset} onChange={applyPreset} options={PRESET_OPTIONS} size="small" aria-label="Rango predefinido" />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={from} max={to} size="small" onChange={(v) => { setPreset(""); setFrom(v); }} aria-label="Inicio de la ventana" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={to} min={from} size="small" onChange={(v) => { setPreset(""); setTo(v); }} aria-label="Fin de la ventana" />
            </CocoaField>
          </div>
        }
        rightSlot={
          board ? (
            <p style={noteStyle}>
              Datos a cierre de {date(board.businessDate, "short")} · OTB a las {time(board.generatedAt)} (Europe/Madrid) · Ventana {date(board.from, "short")} → {date(board.to, "short")}
            </p>
          ) : undefined
        }
      />

      {board ? (
        <>
          {board.forecastMissing ? (
            <CocoaCallout
              tone="warning"
              title="Sin previsión generada en la ventana"
              actions={
                <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleGenerate()} loading={generating} disabled={generating}>
                  Generar previsión (90 días)
                </CocoaButton>
              }
            >
              No hay filas de previsión para estas fechas, así que los bloques de previsión y la confianza aparecen vacíos: este cuadro nunca inventa datos.
            </CocoaCallout>
          ) : null}
          {genError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo generar la previsión">
              {genError}
            </CocoaCallout>
          ) : null}
          {board.budgetMissing ? (
            <CocoaCallout tone="info" title="Sin presupuesto">
              Carga el presupuesto mensual para ver desviaciones frente a presupuesto.
            </CocoaCallout>
          ) : null}

          {k ? (
            <CocoaKpiStrip stagger aria-label="Indicadores de la ventana">
              <CocoaKpi
                label="Próximos 7 días (OTB)"
                value={money(k.next7.revenue)}
                caption={`${fmtInt(k.next7.roomsSold)} hab · ${fmtPct1(k.next7.occPct)} · ADR ${dash(k.next7.adr, money)}`}
                delta={k.next7.pickup7 ?? undefined}
                deltaLabel={k.next7.pickup7 === null ? "sin pickup a 7 días" : "hab · pickup 7 días"}
                polarity="positive-good"
                status={k.next7.pickup7 !== null && k.next7.pickup7 < 0 ? "warning" : "ok"}
              />
              <CocoaKpi
                label="Próximos 30 días (OTB)"
                value={money(k.next30.revenue)}
                caption={`${fmtInt(k.next30.roomsSold)} hab · ${fmtPct1(k.next30.occPct)} · ADR ${dash(k.next30.adr, money)}`}
                delta={k.next30.pickup7 ?? undefined}
                deltaLabel={k.next30.pickup7 === null ? "sin pickup a 7 días" : "hab · pickup 7 días"}
                polarity="positive-good"
                status={k.next30.pickup7 !== null && k.next30.pickup7 < 0 ? "warning" : "ok"}
              />
              <CocoaKpi
                label="Mes en curso (MTD)"
                value={money(k.mtd.revenue)}
                caption={`${fmtInt(k.mtd.roomsSold)} hab · ${fmtPct1(k.mtd.occPct)} · ADR ${dash(k.mtd.adr, money)}`}
                delta={mtdVsStly ?? undefined}
                deltaUnit="%"
                deltaLabel={mtdVsStly === null ? "sin comparación con el año anterior" : "vs STLY"}
                polarity="positive-good"
                status={mtdVsStly !== null && mtdVsStly < 0 ? "warning" : "ok"}
              />
              <CocoaKpi
                label="Confianza media de la previsión"
                value={dash(confidence, fmtConfidence)}
                caption={confidence === null ? "Genera la previsión para activar este indicador" : "Media de la ventana con previsión"}
                polarity="neutral"
                status={confidence === null ? "warning" : confidenceStatus(confidence)}
              />
            </CocoaKpiStrip>
          ) : null}

          <CocoaSection variant="plain" padding="none" title="Mes en curso +3: proyección frente a presupuesto" meta={plural(board.months.length, "mes", "meses")} headingLevel={2}>
            {board.months.length > 0 ? (
              <CocoaGrid aria-label="Proyección mensual" align="start">
                {board.months.map((m) => (
                  <CocoaSpan key={m.month} cols={3} min={240}>
                    <MonthCard month={m} />
                  </CocoaSpan>
                ))}
              </CocoaGrid>
            ) : (
              <CocoaState kind="empty" inline title="El servidor no devolvió proyección mensual." />
            )}
          </CocoaSection>

          <CocoaGrid aria-label="Real y previsión por día">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Ocupación: real frente a previsión" meta="Real / OTB · Previsión">
                {dataRows.length > 0 ? (
                  <CocoaChart.Line series={occSeries} yLabel="Ocupación" valueFormat={fmtPct1} aria-label="Ocupación diaria real u OTB frente a la previsión" />
                ) : (
                  <CocoaState kind="empty" inline title="Sin datos para el gráfico en la ventana seleccionada." />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Ingresos de habitaciones por día" meta="Real / OTB · Previsión">
                {dataRows.length > 0 ? (
                  <CocoaChart.Line series={revenueSeries} yLabel="€ por día" valueFormat={(n) => money(n)} aria-label="Ingresos diarios de habitaciones reales u OTB frente a la previsión" />
                ) : (
                  <CocoaState kind="empty" inline title="Sin datos para el gráfico en la ventana seleccionada." />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection title="Fechas críticas" meta={`${fmtInt(board.criticalDates.length)} de un máximo de 10`} padding={board.criticalDates.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {board.criticalDates.length > 0 ? (
              <CocoaTable columns={CRITICAL_COLUMNS} rows={board.criticalDates} rowKey="date" density="compact" caption="Fechas críticas de la ventana" aria-label="Fechas críticas de la ventana" />
            ) : (
              <CocoaState kind="empty" inline title="Sin fechas críticas detectadas en la ventana: ninguna fecha supera los umbrales de demanda, ritmo o pickup." />
            )}
          </CocoaSection>

          <DefinitionsFooter notes={board.metricNotes} sources={board.sources} />
        </>
      ) : null}
    </CocoaPage>
  );
}
