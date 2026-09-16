// History & Forecast detailed report (contract frozen 2026-07-15).
//
// Dense Opera-style daily table: one row per date plus ISO-week/month
// subtotals and a final total, all computed server-side by
// GET /revenue/properties/:id/history-forecast/board. Nothing is invented
// client-side; missing blocks (forecast/budget/STLY/pickup) render as "—".
// Exports go through the Export Center (hf_daily, CSV/XLS).
//
// Cocoa 22 (ola 5 · lote 5-B): list hosted in HistoricoPrevisionTabs
// (ListaTabla). Range toolbar with the export buttons at the right → honest
// callouts → one CocoaTable (sticky first column, own scroller, compact
// density, subtotal rows toned, the server total as the tfoot) → metric
// dictionary. CocoaTable has no grouped header row: the block name travels
// in the column label («Prev. ADR», «STLY hab», «Ppto. € día»).
import { useTabHost } from "../tabs/TabHost";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { fetchHistoryForecastBoard, type BoardRow, type HistoryForecastBoard } from "../../services/revenueApi";
import { downloadGeneratedExport, generateRevenueExport } from "../../services/revenueExportApi";
import { getActiveProperty } from "../../services/activeProperty";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
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
function dash<T>(value: T | null | undefined, fmt: (v: T) => string): string {
  return value === null || value === undefined ? "—" : fmt(value);
}

// ---- column model ------------------------------------------------------------
// Each cell renders straight from the server row; subtotal/total rows reuse
// the same renderers (the server already weights occ/ADR/RevPAR and nulls
// pickupAdr7 on subtotals). Past rows read in the secondary label (audited
// close), subtotal rows in bold; the total row is the table footer.
type CellDef = { key: string; label: string; text: (r: BoardRow) => string; hideOnNarrow?: boolean };

const CELLS: CellDef[] = [
  // Actual / OTB
  { key: "roomsSold", label: "Hab", text: (r) => fmtInt(r.roomsSold) },
  { key: "occPct", label: "Occ %", text: (r) => fmtPct1(r.occPct) },
  { key: "adr", label: "ADR", text: (r) => dash(r.adr, money) },
  { key: "revpar", label: "RevPAR", text: (r) => dash(r.revpar, money) },
  { key: "roomRevenue", label: "Ingresos", text: (r) => money(r.roomRevenue) },
  { key: "arrivals", label: "Entr.", text: (r) => fmtInt(r.arrivals), hideOnNarrow: true },
  { key: "departures", label: "Sal.", text: (r) => fmtInt(r.departures), hideOnNarrow: true },
  { key: "noShows", label: "No-show", text: (r) => fmtInt(r.noShows), hideOnNarrow: true },
  { key: "ooo", label: "OOO", text: (r) => fmtInt(r.ooo), hideOnNarrow: true },
  // Pickup
  { key: "pickup1", label: "Pickup Δ1d", text: (r) => dash(r.pickup1, signedInt), hideOnNarrow: true },
  { key: "pickup7", label: "Pickup Δ7d", text: (r) => dash(r.pickup7, signedInt), hideOnNarrow: true },
  { key: "pickup28", label: "Pickup Δ28d", text: (r) => dash(r.pickup28, signedInt), hideOnNarrow: true },
  { key: "pickupAdr7", label: "Pickup ΔADR 7d", text: (r) => dash(r.pickupAdr7, signedMoney), hideOnNarrow: true },
  // Previsión
  { key: "fcRooms", label: "Prev. hab", text: (r) => dash(r.fcRooms, fmtInt) },
  { key: "fcOccPct", label: "Prev. occ %", text: (r) => dash(r.fcOccPct, fmtPct1) },
  { key: "fcAdr", label: "Prev. ADR", text: (r) => dash(r.fcAdr, money) },
  { key: "fcRevenue", label: "Prev. ingresos", text: (r) => dash(r.fcRevenue, money) },
  { key: "fcConfidence", label: "Conf.", text: (r) => dash(r.fcConfidence, fmtConfidence) },
  // STLY
  { key: "stlyRooms", label: "STLY hab", text: (r) => dash(r.stlyRooms, fmtInt), hideOnNarrow: true },
  { key: "stlyOccPct", label: "STLY occ %", text: (r) => dash(r.stlyOccPct, fmtPct1), hideOnNarrow: true },
  { key: "stlyAdr", label: "STLY ADR", text: (r) => dash(r.stlyAdr, money), hideOnNarrow: true },
  { key: "stlyRevenue", label: "STLY ingresos", text: (r) => dash(r.stlyRevenue, money), hideOnNarrow: true },
  { key: "deltaRoomsVsStly", label: "Δ hab STLY", text: (r) => dash(r.deltaRoomsVsStly, signedInt), hideOnNarrow: true },
  { key: "deltaRevVsStly", label: "Δ € STLY", text: (r) => dash(r.deltaRevVsStly, signedMoney), hideOnNarrow: true },
  // Presupuesto
  { key: "budgetRevenue", label: "Ppto. € día", text: (r) => dash(r.budgetRevenue, money), hideOnNarrow: true },
  { key: "deltaRevVsBudget", label: "Δ € ppto.", text: (r) => dash(r.deltaRevVsBudget, signedMoney), hideOnNarrow: true }
];

// Audited past reads in the secondary label (named object: rule 6).
const pastStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
// Explanatory line (callout size, secondary label).
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-leading-text)", color: "var(--cocoa-label-secondary)" };

function isSubtotal(r: BoardRow): boolean {
  return r.rowType === "weekSubtotal" || r.rowType === "monthSubtotal";
}

function cell(r: BoardRow, text: string): ReactNode {
  if (isSubtotal(r)) return <strong>{text}</strong>;
  if (r.isPast) return <span style={pastStyle}>{text}</span>;
  return text;
}

function firstCell(r: BoardRow): ReactNode {
  if (r.rowType === "data") {
    return (
      <>
        <strong>{r.date ? date(r.date, "dayMonth") : "—"}</strong> <span style={pastStyle}>{r.dow ?? ""}</span>
        {r.isToday ? (
          <>
            {" "}
            <CocoaBadge tone="accent" size="small">
              hoy
            </CocoaBadge>
          </>
        ) : null}
      </>
    );
  }
  return <strong>{r.label ?? "Subtotal"}</strong>;
}

const COLUMNS: CocoaTableColumn<BoardRow>[] = [
  { key: "date", label: "Fecha", fit: true, render: firstCell },
  ...CELLS.map<CocoaTableColumn<BoardRow>>((c) => ({ key: c.key, label: c.label, align: "right", fit: true, hideOnNarrow: c.hideOnNarrow, render: (r) => cell(r, c.text(r)) }))
];

function rowTone(r: BoardRow): CocoaTone | undefined {
  if (isSubtotal(r)) return "neutral";
  if (r.isToday) return "accent";
  return undefined;
}

// Stable, unique keys: subtotal labels can repeat across the window, so the
// position of the row inside the board is part of the key.
function rowKeys(rows: BoardRow[]): WeakMap<BoardRow, string> {
  const keys = new WeakMap<BoardRow, string>();
  rows.forEach((r, idx) => keys.set(r, `${r.rowType}-${r.date ?? r.label ?? ""}-${idx}`));
  return keys;
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

function ReportSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Grid rows={[[12]]} height={420} />
    </div>
  );
}

export function RevenueHistoryForecastReport() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const header = treeHeaderFor("RevenueHistoryForecastReport", { eyebrow: "Revenue · Histórico y previsión", title: "Informe" });
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
      setExportError(e instanceof Error ? e.message : "No se pudo generar la exportación.");
    } finally {
      setExporting(null);
    }
  }

  const dataDays = useMemo(() => (board?.rows ?? []).filter((r) => r.rowType === "data").length, [board]);
  // The server total closes the table as its footer; every other row is a body row.
  const bodyRows = useMemo(() => (board?.rows ?? []).filter((r) => r.rowType !== "total"), [board]);
  const bodyKeys = useMemo(() => rowKeys(bodyRows), [bodyRows]);
  const totalRow = useMemo(() => (board?.rows ?? []).find((r) => r.rowType === "total") ?? null, [board]);
  const footerCells = useMemo<Record<string, ReactNode> | undefined>(() => {
    if (!totalRow) return undefined;
    const cells: Record<string, ReactNode> = { date: totalRow.label ?? "Total" };
    for (const c of CELLS) cells[c.key] = c.text(totalRow);
    return cells;
  }, [totalRow]);

  const exportDisabled = exporting !== null || loading || !board;
  const openBoard = () => navigateTo("RevenueHistoryForecastDashboard");

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle={hosted ? undefined : "Tabla diaria de histórico y previsión con subtotales por semana ISO y mes, calculados por el servidor."}
      actions={
        <>
          <CocoaBadge tone="success" variant="dot">
            En vivo
          </CocoaBadge>
          {error && board ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={openBoard}>
            Volver al cuadro
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !board ? "loading" : error && !board ? "error" : "ready"}
      skeleton={<ReportSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "historico-prevision-informe-refresh", label: "Actualizar el informe de histórico y previsión", run: () => void load() },
        { id: "historico-prevision-informe-csv", label: "Exportar el informe de histórico y previsión (CSV)", run: () => void handleExport("csv") },
        { id: "historico-prevision-informe-xls", label: "Exportar el informe de histórico y previsión (Excel)", run: () => void handleExport("xls") },
        { id: "historico-prevision-informe-print", label: "Imprimir el informe de histórico y previsión", run: () => window.print() }
      ]}
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Rango y exportación"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Rango">
              <CocoaSegmentedControl value={preset} onChange={applyPreset} options={PRESET_OPTIONS} size="small" aria-label="Rango predefinido" />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={from} max={to} size="small" onChange={(v) => { setPreset(""); setFrom(v); }} aria-label="Inicio del rango" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={to} min={from} size="small" onChange={(v) => { setPreset(""); setTo(v); }} aria-label="Fin del rango" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleExport("csv")} loading={exporting === "csv"} disabled={exportDisabled}>
              Exportar CSV
            </CocoaButton>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleExport("xls")} loading={exporting === "xls"} disabled={exportDisabled}>
              Exportar Excel
            </CocoaButton>
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => window.print()} disabled={loading || !board}>
              {ACTIONS.print}
            </CocoaButton>
          </div>
        }
      />

      {exportError ? (
        <CocoaCallout tone="danger" role="alert" title="No se pudo generar la exportación">
          {exportError}
        </CocoaCallout>
      ) : null}

      {board ? (
        <>
          {board.forecastMissing ? (
            <CocoaCallout tone="warning" title="Sin previsión">
              No hay previsión generada en la ventana: el bloque de previsión aparece vacío. Genera la previsión desde el cuadro de histórico y previsión.
            </CocoaCallout>
          ) : null}
          {board.budgetMissing ? (
            <CocoaCallout tone="info" title="Sin presupuesto">
              Carga el presupuesto mensual para ver desviaciones frente a presupuesto.
            </CocoaCallout>
          ) : null}

          <CocoaSection
            title={`Informe diario · ${board.propertyName}`}
            meta={`${plural(dataDays, "día", "días")} · ${plural(board.totalRooms, "habitación", "habitaciones")}`}
            padding={dataDays > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
            footer={
              dataDays > 0 ? (
                <span>
                  Datos a cierre de {date(board.businessDate, "short")} · OTB a las {time(board.generatedAt)} (Europe/Madrid) · {date(board.from, "short")} → {date(board.to, "short")} · pasado en gris = cierre auditado · hoy resaltado · previsión y pickup solo en fechas futuras · subtotales por semana ISO y mes calculados por el servidor.
                </span>
              ) : undefined
            }
          >
            {dataDays === 0 ? (
              <CocoaState kind="empty" illustration="search" title="No hay fechas en el rango seleccionado" message="Ajusta el rango y vuelve a cargar." primaryAction={{ label: ACTIONS.refresh, onClick: () => void load(), loading }} />
            ) : (
              <CocoaTable
                columns={COLUMNS}
                rows={bodyRows}
                rowKey={(r) => bodyKeys.get(r) ?? `${r.rowType}-${r.date ?? r.label ?? ""}`}
                rowTone={rowTone}
                footer={footerCells}
                stickyFirstColumn
                density="compact"
                maxHeight={560}
                loading={loading && bodyRows.length === 0}
                caption={`Informe diario de histórico y previsión de ${board.propertyName}`}
                aria-label={`Informe diario de histórico y previsión de ${board.propertyName}`}
              />
            )}
          </CocoaSection>

          <p style={noteStyle}>Bloques del informe: Real / OTB (habitaciones, ocupación, ADR, RevPAR, ingresos, entradas, salidas, no-show, fuera de servicio) · Pickup · Previsión (Prev.) · Mismo periodo del año anterior (STLY) · Presupuesto (Ppto.).</p>

          <DefinitionsFooter notes={board.metricNotes} sources={board.sources} />
        </>
      ) : null}
    </CocoaPage>
  );
}
