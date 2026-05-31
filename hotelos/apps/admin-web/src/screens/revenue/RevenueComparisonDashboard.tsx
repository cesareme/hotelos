import { useCallback, useEffect, useState } from "react";
import { fetchPeriodMetrics, money, type PeriodMetrics } from "../../services/revenueApi";
import { LoadingBlock, ErrorState, EmptyState } from "../../components/States";

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
  return new Intl.NumberFormat("es-ES", { useGrouping: true }).format(Math.round(n));
}
function fmtPct(n: number): string {
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)} %`;
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

function comparisonWindow(mode: CompareMode, from: string, to: string, customFrom: string, customTo: string) {
  if (mode === "none") return null;
  if (mode === "custom") return customFrom && customTo ? { from: customFrom, to: customTo } : null;
  if (mode === "last_year") return { from: shiftYearIso(from, -1), to: shiftYearIso(to, -1) };
  // previous: the equally-long window ending the day before `from`.
  const len = diffDays(from, to);
  const cTo = addDaysIso(from, -1);
  return { from: addDaysIso(cTo, -(len - 1)), to: cTo };
}

export function RevenueComparisonDashboard() {
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

  return (
    <section className="bo-card" style={{ display: "grid", gap: 16 }}>
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">Comparación</p>
          <h2>Comparación de revenue</h2>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>↻ Actualizar</button>
      </div>
      <p className="bo-muted" style={{ textTransform: "none", marginTop: -8 }}>
        Compara el rendimiento de un periodo con el periodo anterior, el mismo periodo del año pasado o un rango a tu elección.
      </p>

      <div className="bo-row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="bo-stack" style={{ gap: 6 }}>
          <span className="bo-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Periodo</span>
          <div className="bo-pill-row">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className={`bo-pill${preset === p.id ? " is-active" : ""}`} style={{ cursor: "pointer" }} onClick={() => applyPreset(p.id)}>{p.label}</button>
            ))}
          </div>
          <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
            <input type="date" value={from} max={to} onChange={(e) => { setPreset(""); setFrom(e.target.value); }} />
            <span className="bo-muted">→</span>
            <input type="date" value={to} min={from} max={todayIso()} onChange={(e) => { setPreset(""); setTo(e.target.value); }} />
          </div>
        </div>

        <div className="bo-stack" style={{ gap: 6 }}>
          <span className="bo-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>Comparar con</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as CompareMode)}>
            {(Object.keys(MODE_LABEL) as CompareMode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABEL[m]}</option>
            ))}
          </select>
          {mode === "custom" ? (
            <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="bo-muted">→</span>
              <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          ) : cmpWindow ? (
            <span className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>{cmpWindow.from} → {cmpWindow.to}</span>
          ) : (
            <span className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>Mostrando solo el periodo actual</span>
          )}
        </div>
      </div>

      {loading ? (
        <LoadingBlock label="Calculando KPIs del periodo…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => void load()} />
      ) : !current || !current.hasData ? (
        <EmptyState title="Sin datos en el periodo" message="No hay snapshots de revenue en el rango seleccionado. Prueba otro periodo." />
      ) : (
        <>
          <div className="bo-grid three">
            {METRICS.map((m) => {
              const cur = current[m.key] as number;
              const cmpVal = compare && compare.hasData ? (compare[m.key] as number) : null;
              const hasCmp = cmpVal !== null;
              const absDelta = hasCmp ? cur - (cmpVal as number) : 0;
              const pctDelta = hasCmp && (cmpVal as number) !== 0 ? (absDelta / (cmpVal as number)) * 100 : null;
              const up = absDelta > 0.0001;
              const down = absDelta < -0.0001;
              const trendClass = up ? "ok" : down ? "error" : "info";
              const arrow = up ? "▲" : down ? "▼" : "■";
              return (
                <article key={String(m.key)} className="bo-card">
                  <div className="bo-card-head">
                    <h3 style={{ fontSize: 14 }}>{m.label}</h3>
                    {hasCmp ? (
                      <span className={`bo-status ${trendClass}`} style={{ textTransform: "none" }}>
                        {arrow} {pctDelta !== null ? `${pctDelta > 0 ? "+" : ""}${pctDelta.toFixed(1)} %` : "—"}
                      </span>
                    ) : null}
                  </div>
                  <div className="bo-metric" style={{ fontVariantNumeric: "tabular-nums" }}>{m.fmt(cur)}</div>
                  {hasCmp ? (
                    <p className="bo-muted" style={{ textTransform: "none", fontSize: 12.5 }}>
                      vs {m.fmt(cmpVal as number)} ({MODE_SHORT[mode]})
                      {" · "}
                      <span style={{ color: up ? "var(--accent-strong)" : down ? "#c2413a" : "var(--ink-muted)", fontWeight: 600 }}>
                        {absDelta > 0 ? "+" : ""}{m.fmt(absDelta)}
                      </span>
                    </p>
                  ) : (
                    <p className="bo-muted" style={{ textTransform: "none", fontSize: 12.5 }}>Sin periodo de comparación</p>
                  )}
                </article>
              );
            })}
          </div>
          <p className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>
            Periodo actual: {current.days} día(s) con datos
            {compare ? ` · comparación: ${compare.days} día(s) con datos` : ""}.
          </p>
        </>
      )}
    </section>
  );
}
