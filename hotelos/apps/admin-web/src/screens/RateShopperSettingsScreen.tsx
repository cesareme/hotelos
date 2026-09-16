// Competencia — Revenue › Competencia (/revenue/competencia, standalone).
// Cocoa 22 · ola 5 · lote 5-C (migrated from the legacy `.bo-*` screen),
// archetype «dashboard».
//
// Reads services/revenueApi.ts: fetchCompetitors · fetchCompetitorRates ·
// fetchParityAlerts · createCompetitor · runRateShop (the internal survey;
// no external rate-shopping provider is connected, the rates are recorded by
// hand or by the survey and stored in the property's database).
//
// Layout: CocoaPage → CocoaKpiStrip (competidores · tarifas · mediana ·
// alertas) → CocoaGrid 7/5 (competitors table with the «add competitor» form
// in the section footer · parity alerts list) → market position by stay date
// (CocoaChart.Line min / median / max + table) → sample of rates per
// competitor.
//
// Wire codes never reach the hotelier raw (qa#18, rule C19): the competitor
// category, the source channel and the availability of a rate read in Spanish
// (lib/format hotelCategoryLabel · availabilityLabel; ./rate-shopper-labels
// shopSourceLabel · alertHeadLabel) inside a CodeCell that keeps the raw code
// in `title` when it differs from the label.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  fetchCompetitors,
  fetchCompetitorRates,
  fetchParityAlerts,
  createCompetitor,
  runRateShop,
  type Competitor,
  type CompetitorRate,
  type ParityAlert
} from "../services/revenueApi";
import { getActiveProperty } from "../services/activeProperty";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../content/actions";
import { availabilityLabel, date, hotelCategoryLabel, money, number, percent, plural, toNumber } from "../lib/format";
import { CodeCell, alertHeadLabel, shopSourceLabel } from "./rate-shopper-labels";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtDate(iso: string): string {
  return date(iso, "medium");
}

// Spanish labels for the alert enums the API sends; an unknown value is painted as it arrives.
const SEVERITY_ES: Record<string, string> = { critical: "Crítica", high: "Alta", warning: "Aviso", medium: "Media", low: "Baja", info: "Información" };
const ALERT_STATUS_ES: Record<string, string> = { open: "Abierta", resolved: "Resuelta", closed: "Cerrada", acknowledged: "Revisada", dismissed: "Descartada" };

// Message of an alert under its title: callout size in secondary (never inside a style literal, rule 6).
const alertMessageStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

type StayRow = { stayDate: string; min: number; median: number; max: number; count: number };
type RateRow = CompetitorRate & { competitorName: string };

const COMPETITOR_COLUMNS: CocoaTableColumn<Competitor>[] = [
  { key: "name", label: "Hotel", minWidth: 160, render: (c) => <strong>{c.name}</strong> },
  { key: "category", label: "Categoría", fit: true, render: (c) => <CodeCell code={c.category} label={hotelCategoryLabel(c.category)} /> },
  { key: "comparableScore", label: "Comparabilidad", align: "right", fit: true, hideOnNarrow: true, render: (c) => (c.comparableScore ? percent(Number(c.comparableScore), { ratio: true, maximumFractionDigits: 0 }) : "—") },
  {
    key: "active",
    label: FIELD_LABELS.status,
    fit: true,
    render: (c) => <CocoaBadge tone={c.active ? "success" : "neutral"}>{c.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}</CocoaBadge>
  }
];

const STAY_COLUMNS: CocoaTableColumn<StayRow>[] = [
  { key: "stayDate", label: "Fecha de estancia", fit: true, render: (b) => <strong>{fmtDate(b.stayDate)}</strong> },
  { key: "min", label: "Mínimo", align: "right", render: (b) => money(b.min) },
  { key: "median", label: "Mediana", align: "right", render: (b) => money(b.median) },
  { key: "max", label: "Máximo", align: "right", render: (b) => money(b.max) },
  { key: "count", label: "Competidores", align: "right", hideOnNarrow: true, render: (b) => number(b.count) }
];

const RATE_COLUMNS: CocoaTableColumn<RateRow>[] = [
  { key: "competitorName", label: "Competidor", minWidth: 160 },
  { key: "stayDate", label: "Fecha de estancia", fit: true, render: (r) => fmtDate(r.stayDate) },
  { key: "sourceChannel", label: FIELD_LABELS.channel, fit: true, hideOnNarrow: true, render: (r) => <CodeCell code={r.sourceChannel} label={shopSourceLabel(r.sourceChannel)} /> },
  { key: "price", label: "Tarifa", align: "right", fit: true, render: (r) => <strong>{money(r.price, r.currency)}</strong> },
  { key: "availabilityStatus", label: "Disponibilidad", fit: true, showFrom: "laptop", render: (r) => <CodeCell code={r.availabilityStatus} label={availabilityLabel(r.availabilityStatus)} /> }
];

function CompSetSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[7, 5], [12], [12]]} height={220} />
    </div>
  );
}

export function RateShopperSettingsScreen() {
  const property = getActiveProperty();
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [rates, setRates] = useState<CompetitorRate[]>([]);
  const [alerts, setAlerts] = useState<ParityAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: CocoaTone; text: string } | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("4*");
  const [score, setScore] = useState("0.85");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, r, a] = await Promise.all([fetchCompetitors(), fetchCompetitorRates(), fetchParityAlerts()]);
      setCompetitors(c);
      setRates(r);
      setAlerts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar la competencia.");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleShop() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await runRateShop(14);
      setNotice({ tone: "success", text: `Sondeo completado: ${plural(r.snapshots, "tarifa", "tarifas")} de ${plural(r.competitors, "competidor", "competidores")}.` });
      await load();
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : "No se pudo ejecutar el sondeo." });
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCompetitor() {
    if (!name.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await createCompetitor({ name: name.trim(), category, comparableScore: toNumber(score) ?? Number(score) });
      setName("");
      await load();
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : "No se pudo añadir el competidor." });
    } finally {
      setBusy(false);
    }
  }

  // Market position by stay date (min / median / max competitor price).
  const byStay = useMemo<StayRow[]>(() => {
    const map = new Map<string, number[]>();
    for (const r of rates) {
      if (!r.price) continue;
      const arr = map.get(r.stayDate) ?? [];
      arr.push(r.price);
      map.set(r.stayDate, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stayDate, prices]) => ({
        stayDate,
        min: Math.min(...prices),
        median: Math.round(median(prices) * 100) / 100,
        max: Math.max(...prices),
        count: prices.length
      }));
  }, [rates]);

  const compName = useMemo(() => new Map(competitors.map((c) => [c.id, c.name])), [competitors]);
  const rateRows = useMemo<RateRow[]>(
    () => rates.slice(0, 16).map((r) => ({ ...r, competitorName: r.competitorHotelId ? compName.get(r.competitorHotelId) ?? r.competitorHotelId : "—" })),
    [rates, compName]
  );
  const stayRows = useMemo(() => byStay.slice(0, 14), [byStay]);
  const marketSeries = useMemo(
    () => [
      { id: "min", label: "Mínimo", tone: "info" as const, points: stayRows.map((b) => ({ x: date(b.stayDate, "dayMonth"), y: b.min })) },
      { id: "median", label: "Mediana", tone: "accent" as const, width: 2 as const, points: stayRows.map((b) => ({ x: date(b.stayDate, "dayMonth"), y: b.median })) },
      { id: "max", label: "Máximo", tone: "warning" as const, points: stayRows.map((b) => ({ x: date(b.stayDate, "dayMonth"), y: b.max })) }
    ],
    [stayRows]
  );
  const openAlerts = alerts.filter((a) => a.status === "open").length;

  return (
    <CocoaPage
      eyebrow={`Revenue · ${property.propertyName}`}
      title="Competencia"
      subtitle="Las tarifas de tus competidores y las alertas de paridad, para decidir tu precio público. Hoy no hay ningún proveedor de sondeo externo conectado: las tarifas se registran a mano o con el sondeo interno y se guardan en tu base de datos."
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading && loaded} disabled={loading || busy}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleShop()} loading={busy} disabled={busy || loading}>
            {busy ? "Sondeando…" : "Ejecutar sondeo"}
          </CocoaButton>
        </>
      }
      state={!loaded && loading ? "loading" : error ? "error" : "ready"}
      skeleton={<CompSetSkeleton />}
      error={{ title: "No se pudo cargar", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "rate-shopper-run", label: "Ejecutar el sondeo de la competencia", run: () => void handleShop() },
        { id: "rate-shopper-refresh", label: "Actualizar la competencia", run: () => void load() }
      ]}
    >
      {notice ? (
        <CocoaCallout tone={notice.tone} role="status">
          {notice.text}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Resumen de la competencia">
        <CocoaKpi label="Competidores" value={number(competitors.length)} caption="en el conjunto" polarity="neutral" status="ok" />
        <CocoaKpi label="Tarifas sondeadas" value={number(rates.length)} caption="registros guardados" polarity="neutral" status="ok" />
        <CocoaKpi label="Mediana de mercado" value={byStay.length ? money(median(byStay.map((b) => b.median))) : "—"} caption="de las medianas por fecha" polarity="neutral" status="ok" />
        <CocoaKpi label="Alertas de paridad" value={number(openAlerts)} caption="abiertas" polarity="negative-good" status={openAlerts > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      <CocoaGrid align="start">
        <CocoaSpan cols={7} min={480}>
          <CocoaSection
            title="Competidores"
            meta={plural(competitors.length, "hotel", "hoteles")}
            padding={competitors.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
            aria-label="Competidores"
            footer={
              <CocoaFormRow columns={4} min={140}>
                <CocoaField label="Hotel">
                  <CocoaInput value={name} onChange={setName} placeholder="Nombre del hotel" size="small" disabled={busy} />
                </CocoaField>
                <CocoaField label="Categoría">
                  <CocoaInput value={category} onChange={setCategory} placeholder="4*" size="small" disabled={busy} />
                </CocoaField>
                <CocoaField label="Comparabilidad (0–1)">
                  <CocoaInput value={score} onChange={setScore} placeholder="0,85" inputMode="decimal" size="small" disabled={busy} />
                </CocoaField>
                <div className="cocoa-row" data-align="end">
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void handleAddCompetitor()} disabled={busy || !name.trim()}>
                    Añadir competidor
                  </CocoaButton>
                </div>
              </CocoaFormRow>
            }
          >
            {competitors.length === 0 ? (
              <CocoaState kind="empty" inline title="Aún no hay competidores. Añade uno para empezar a sondear." />
            ) : (
              <CocoaTable columns={COMPETITOR_COLUMNS} rows={competitors} rowKey="id" caption="Competidores" aria-label="Competidores" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={5} min={320}>
          <CocoaSection title="Alertas de paridad" meta={`${number(openAlerts)} abiertas`} aria-label="Alertas de paridad">
            {alerts.length === 0 ? (
              <CocoaState kind="empty" title="Sin alertas de paridad" message="No hay desviaciones de paridad registradas para esta propiedad." />
            ) : (
              <ol className="c22-section__list" aria-label="Alertas de paridad">
                {alerts.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <CocoaBadge tone={a.severity === "critical" ? "danger" : "warning"} variant="dot" size="small">
                      {SEVERITY_ES[a.severity] ?? a.severity}
                    </CocoaBadge>
                    <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                      <strong><CodeCell code={a.sourceChannel ?? a.alertType} label={alertHeadLabel(a.sourceChannel, a.alertType)} /></strong> · {fmtDate(a.stayDate)}
                      <span style={alertMessageStyle}>{a.message}</span>
                    </span>
                    <CocoaBadge tone={a.status === "open" ? "warning" : "success"} size="small">
                      {ALERT_STATUS_ES[a.status] ?? a.status}
                    </CocoaBadge>
                  </li>
                ))}
              </ol>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={12}>
          <CocoaSection title="Posición de mercado por fecha" meta="mín · mediana · máx" aria-label="Posición de mercado por fecha de estancia">
            {byStay.length === 0 ? (
              <CocoaState kind="empty" inline title="Ejecuta un sondeo para ver las tarifas de la competencia por fecha de estancia." />
            ) : (
              <>
                <CocoaChart.Line
                  series={marketSeries}
                  height={200}
                  valueFormat={(v) => money(v, { decimals: "auto" })}
                  aria-label="Tarifa mínima, mediana y máxima de la competencia por fecha de estancia"
                />
                <CocoaTable columns={STAY_COLUMNS} rows={stayRows} rowKey="stayDate" density="compact" caption="Posición de mercado por fecha de estancia" aria-label="Posición de mercado por fecha de estancia" />
              </>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={12}>
          <CocoaSection
            title="Tarifas por competidor (muestra)"
            meta={plural(rates.length, "registro", "registros")}
            padding={rates.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
            aria-label="Tarifas por competidor"
          >
            {rates.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin tarifas. Ejecuta un sondeo." />
            ) : (
              <CocoaTable columns={RATE_COLUMNS} rows={rateRows} rowKey="id" density="compact" caption="Tarifas por competidor" aria-label="Tarifas por competidor" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}
