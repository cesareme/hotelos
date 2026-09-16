// Period comparison — /revenue/comparativa (standalone).
//
// Compares the KPIs of a period (GET /revenue/properties/:id/period-metrics)
// with the previous period, the same period last year or a custom window.
//
// Cocoa 22 (ola 5 · lote 5-B): standalone dashboard (DashboardStandalone).
// The period toolbar stays visible in every state (as the list pilot does),
// so the body section holds the skeleton, the error, the empty state or the
// KPI strip with the deltas. Same endpoint, same actions.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { fetchPeriodMetrics, type PeriodMetrics } from "../../services/revenueApi";
import { getActiveProperty } from "../../services/activeProperty";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, money, number, percent, plural } from "../../lib/format";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDatePicker,
  CocoaField,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaToolbar
} from "../../components/cocoa";

const MS_DAY = 86_400_000;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  const n = new Date();
  return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())));
}
function addDaysIso(isoDate: string, n: number): string {
  return iso(new Date(new Date(isoDate).getTime() + n * MS_DAY));
}
function shiftYearIso(isoDate: string, years: number): string {
  const d = new Date(isoDate);
  return iso(new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate())));
}
function startOfMonthIso(): string {
  const n = new Date();
  return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), 1)));
}
function diffDays(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / MS_DAY) + 1;
}
function fmtNum(n: number): string {
  return number(Math.round(n));
}
function fmtPct(n: number): string {
  return percent(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

type CompareMode = "none" | "previous" | "last_year" | "custom";

const MODE_LABEL: Record<CompareMode, string> = {
  none: "Sin comparación",
  previous: "Periodo anterior",
  last_year: "Mismo periodo, año anterior",
  custom: "Periodo personalizado"
};
const MODE_SHORT: Record<CompareMode, string> = {
  none: "—",
  previous: "periodo anterior",
  last_year: "año anterior",
  custom: "periodo personalizado"
};
const MODE_OPTIONS = (Object.keys(MODE_LABEL) as CompareMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }));

type MetricDef = { key: keyof PeriodMetrics; label: string; fmt: (n: number) => string };
const METRICS: MetricDef[] = [
  { key: "occupancyPct", label: "Ocupación", fmt: fmtPct },
  { key: "adr", label: "ADR", fmt: (n) => money(n) },
  { key: "revpar", label: "RevPAR", fmt: (n) => money(n) },
  { key: "roomRevenue", label: "Ingresos de habitación", fmt: (n) => money(n) },
  { key: "totalRevenue", label: "Ingresos totales", fmt: (n) => money(n) },
  { key: "roomsSold", label: "Habitaciones vendidas", fmt: fmtNum }
];

const PRESETS: { id: string; label: string; range: () => { from: string; to: string } }[] = [
  { id: "7d", label: "Últimos 7 días", range: () => ({ from: addDaysIso(todayIso(), -6), to: todayIso() }) },
  { id: "30d", label: "Últimos 30 días", range: () => ({ from: addDaysIso(todayIso(), -29), to: todayIso() }) },
  { id: "90d", label: "Últimos 90 días", range: () => ({ from: addDaysIso(todayIso(), -89), to: todayIso() }) },
  { id: "mtd", label: "Este mes", range: () => ({ from: startOfMonthIso(), to: todayIso() }) }
];
const PRESET_OPTIONS = PRESETS.map((p) => ({ value: p.id, label: p.label }));

function comparisonWindow(mode: CompareMode, from: string, to: string, customFrom: string, customTo: string) {
  if (mode === "none") return null;
  if (mode === "custom") return customFrom && customTo ? { from: customFrom, to: customTo } : null;
  if (mode === "last_year") return { from: shiftYearIso(from, -1), to: shiftYearIso(to, -1) };
  // previous: the equally-long window ending the day before `from`.
  const len = diffDays(from, to);
  const cTo = addDaysIso(from, -1);
  return { from: addDaysIso(cTo, -(len - 1)), to: cTo };
}

// Explanatory line (callout size, secondary label; rule 6 named object).
const noteStyle: CSSProperties = { margin: 0, fontSize: "var(--cocoa-fs-callout)", lineHeight: "var(--cocoa-leading-text)", color: "var(--cocoa-label-secondary)" };

export function RevenueComparisonDashboard() {
  const header = treeHeaderFor("RevenueComparisonDashboard", { eyebrow: "Revenue", title: "Comparativa" });
  const [preset, setPreset] = useState("30d");
  const [from, setFrom] = useState(() => PRESETS[1].range().from);
  const [to, setTo] = useState(() => PRESETS[1].range().to);
  const [mode, setMode] = useState<CompareMode>("previous");
  const [customFrom, setCustomFrom] = useState(() => addDaysIso(todayIso(), -59));
  const [customTo, setCustomTo] = useState(() => addDaysIso(todayIso(), -30));

  const [current, setCurrent] = useState<PeriodMetrics | null>(null);
  const [compare, setCompare] = useState<PeriodMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    const r = p.range();
    setPreset(id);
    setFrom(r.from);
    setTo(r.to);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cmp = comparisonWindow(mode, from, to, customFrom, customTo);
      const [cur, comp] = await Promise.all([
        fetchPeriodMetrics(from, to),
        cmp ? fetchPeriodMetrics(cmp.from, cmp.to) : Promise.resolve(null)
      ]);
      setCurrent(cur);
      setCompare(comp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar la comparación.");
    } finally {
      setLoading(false);
    }
  }, [from, to, mode, customFrom, customTo]);

  useEffect(() => {
    void load();
  }, [load]);

  const cmpWindow = comparisonWindow(mode, from, to, customFrom, customTo);
  const hasData = Boolean(current && current.hasData);

  return (
    <CocoaPage
      eyebrow={`${header.eyebrow} · ${getActiveProperty().propertyName}`}
      title={header.title}
      subtitle="Compara el rendimiento de un periodo con el periodo anterior, el mismo periodo del año pasado o un rango a tu elección."
      actions={
        <>
          {loading && current ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[{ id: "comparativa-revenue-refresh", label: "Actualizar la comparativa de revenue", run: () => void load() }]}
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Periodo y comparación"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Periodo">
              <CocoaSegmentedControl value={preset} onChange={applyPreset} options={PRESET_OPTIONS} size="small" aria-label="Periodo predefinido" />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={from} max={to} size="small" onChange={(v) => { setPreset(""); setFrom(v); }} aria-label="Inicio del periodo" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={to} min={from} max={todayIso()} size="small" onChange={(v) => { setPreset(""); setTo(v); }} aria-label="Fin del periodo" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Comparar con">
              <CocoaSelect value={mode} onChange={(v) => setMode(v as CompareMode)} options={MODE_OPTIONS} size="small" aria-label="Periodo de comparación" />
            </CocoaField>
            {mode === "custom" ? (
              <>
                <CocoaField label="Desde">
                  <CocoaDatePicker value={customFrom} max={customTo} size="small" onChange={setCustomFrom} aria-label="Inicio del periodo de comparación" />
                </CocoaField>
                <CocoaField label="Hasta">
                  <CocoaDatePicker value={customTo} min={customFrom} size="small" onChange={setCustomTo} aria-label="Fin del periodo de comparación" />
                </CocoaField>
              </>
            ) : (
              <p style={noteStyle}>{cmpWindow ? `${date(cmpWindow.from, "short")} → ${date(cmpWindow.to, "short")}` : "Mostrando solo el periodo actual"}</p>
            )}
          </div>
        }
      />

      <CocoaSection
        title="Indicadores del periodo"
        meta={current ? `${date(current.from, "short")} → ${date(current.to, "short")}` : undefined}
        aria-label="Indicadores del periodo"
        footer={
          hasData && current ? (
            <span>
              Periodo actual: {plural(current.days, "día con datos", "días con datos")}
              {compare ? ` · comparación: ${plural(compare.days, "día con datos", "días con datos")}` : ""}.
            </span>
          ) : undefined
        }
      >
        {loading && !current ? (
          <div aria-hidden="true">
            <CocoaSkeleton.Strip count={6} min={240} />
          </div>
        ) : error ? (
          <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={() => void load()} />
        ) : !hasData || !current ? (
          <CocoaState kind="empty" illustration="search" title="Sin datos en el periodo" message="No hay cierres de revenue en el rango seleccionado. Prueba otro periodo." />
        ) : (
          <CocoaKpiStrip min={240} stagger aria-label="Indicadores del periodo frente a la comparación">
            {METRICS.map((m) => {
              const cur = current[m.key] as number;
              const cmpVal = compare && compare.hasData ? (compare[m.key] as number) : null;
              const hasCmp = cmpVal !== null;
              const absDelta = hasCmp ? cur - (cmpVal as number) : 0;
              const pctDelta = hasCmp && (cmpVal as number) !== 0 ? (absDelta / (cmpVal as number)) * 100 : null;
              return (
                <CocoaKpi
                  key={String(m.key)}
                  label={m.label}
                  value={m.fmt(cur)}
                  caption={hasCmp ? `Antes: ${m.fmt(cmpVal as number)} · ${absDelta > 0 ? "+" : ""}${m.fmt(absDelta)}` : "Sin periodo de comparación"}
                  delta={pctDelta ?? undefined}
                  deltaUnit="%"
                  deltaLabel={hasCmp ? `vs ${MODE_SHORT[mode]}` : undefined}
                  polarity="positive-good"
                />
              );
            })}
          </CocoaKpiStrip>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
