// Flujos de efectivo — Finanzas › Estados contables › Flujos de efectivo
// (/finanzas/estados-contables/flujos, hosted in EstadosContablesTabs).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «DashboardAlojado»): content toolbar
// with the period (desde · hasta · «Mes actual») → KPI strip (tesorería
// inicial · variación · final · resultado) → grid 8/4 (explotación por el
// método indirecto · flujo por actividad) → 6/6 (inversión · financiación).
// Data: GET /accounting/reports/cash-flow?propertyId&fromDate&toDate
// (accounting.reports.read; `reconciled` says whether the closing cash agrees
// with the ledger), polled every 5 minutes as before. Hosted: the container
// paints eyebrow and title; the page adds its toolbar and actions.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { FinanceEntityNote, FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { STATUS_LABELS } from "../../content/actions";
import { date, dateRange, dateTime, money } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaToolbar,
  toneInk,
  type CocoaBarsDatum,
  type CocoaTone
} from "../../components/cocoa";

type Item = { description: string; amount: number };
type WorkingCapitalChange = { category: string; amount: number };

type CashFlowStatement = {
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  operating: {
    netIncome: number;
    depreciation: number;
    workingCapitalChanges: WorkingCapitalChange[];
    subtotal: number;
  };
  investing: { items: Item[]; subtotal: number };
  financing: { items: Item[]; subtotal: number };
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
  /** true when openingCash + netChangeInCash equals the ledger's closing cash. */
  reconciled?: boolean;
};

const POLL_MS = 300000;

function currentMonth(): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mm = String(month + 1).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

function signedTone(value: number): CocoaTone {
  return Math.abs(value) < 0.005 ? "neutral" : value > 0 ? "success" : "danger";
}

// Text styles (tokens only).
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
const totalRowStyle: CSSProperties = { fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"] };

/** Small toned amount (≤ 13 px): AA ink of its sign, plain label at zero. */
function amountStyle(value: number): CSSProperties {
  const tone = signedTone(value);
  return { color: tone === "neutral" ? "var(--cocoa-label)" : toneInk(tone) };
}

function Amount({ value }: { value: number }) {
  return <strong style={amountStyle(value)}>{money(value)}</strong>;
}

/** One line of the statement: label at the left, toned amount at the right. */
function LineRow({ label, amount, total = false }: { label: string; amount: number; total?: boolean }) {
  return (
    <li style={total ? totalRowStyle : undefined}>
      <span style={total ? undefined : secondaryStyle}>{label}</span>
      <Amount value={amount} />
    </li>
  );
}

// Mirror skeleton: KPI strip, 8/4 row and 6/6 row.
function CashFlowSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6]]} height={200} />
    </div>
  );
}

export function CashFlowScreen() {
  const hosted = useTabHost() !== null;
  // Tanda 6b · L7 (design §5.3): the cash-flow statement is FORCED to the sociedad (no `propertyId`); a
  // centre-scoped reader keeps its own centre.
  const finance = useFinanceScope(financeScopePolicy("CashFlowScreen"));
  const propertyId = finance.propertyId;
  const initial = useMemo(currentMonth, []);
  const [fromDate, setFromDate] = useState(initial.from);
  const [toDate, setToDate] = useState(initial.to);
  const rangeInverted = fromDate !== "" && toDate !== "" && fromDate > toDate;

  const { data, loading, error, refresh } = useApiData<CashFlowStatement>(rangeInverted ? null : "/accounting/reports/cash-flow", {
    query: { propertyId, fromDate, toDate },
    pollIntervalMs: POLL_MS
  });

  const changes = toArray<WorkingCapitalChange>(data?.operating.workingCapitalChanges);
  const investing = toArray<Item>(data?.investing.items);
  const financing = toArray<Item>(data?.financing.items);
  const workingCapitalTotal = changes.reduce((sum, change) => sum + change.amount, 0);

  const activityBars: CocoaBarsDatum[] = data
    ? [
        { label: "Explotación", value: data.operating.subtotal, tone: signedTone(data.operating.subtotal) },
        { label: "Inversión", value: data.investing.subtotal, tone: signedTone(data.investing.subtotal) },
        { label: "Financiación", value: data.financing.subtotal, tone: signedTone(data.financing.subtotal) }
      ]
    : [];

  const state = rangeInverted ? "ready" : !data ? (loading ? "loading" : error ? "error" : "ready") : "ready";
  const periodLabel = data ? dateRange(data.periodStart, data.periodEnd) : dateRange(fromDate, toDate);

  function resetToCurrentMonth() {
    const month = currentMonth();
    setFromDate(month.from);
    setToDate(month.to);
  }

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Flujos de efectivo"
      subtitle={hosted ? undefined : "Método indirecto: del resultado del periodo a la variación de tesorería, ajustando amortizaciones y capital circulante y separando inversión y financiación."}
      actions={
        <>
          {data ? (
            <CocoaBadge tone={data.reconciled === false ? "warning" : "success"} title="Comprobación: tesorería inicial más variación neta frente al saldo final del libro">
              {data.reconciled === false ? "No cuadra con el libro" : "Cuadra con el libro"}
            </CocoaBadge>
          ) : null}
          {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} title="Recalcular el estado con el periodo elegido">
            Recalcular
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<CashFlowSkeleton />}
      error={{ title: "No se pudieron calcular los flujos de efectivo", message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "cash-flow-refresh", label: "Recalcular los flujos de efectivo", run: refresh }]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Periodo del estado de flujos"
        leftSlot={
          <div className="cocoa-row" data-gap="4">
            <div className="cocoa-row" data-gap="2">
              <span className="cocoa-caption" style={secondaryStyle}>Desde</span>
              <CocoaDatePicker value={fromDate} onChange={setFromDate} max={toDate || undefined} aria-label="Inicio del periodo" />
            </div>
            <div className="cocoa-row" data-gap="2">
              <span className="cocoa-caption" style={secondaryStyle}>Hasta</span>
              <CocoaDatePicker value={toDate} onChange={setToDate} min={fromDate || undefined} aria-label="Fin del periodo" />
            </div>
          </div>
        }
        rightSlot={
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={resetToCurrentMonth}>
            Mes actual
          </CocoaButton>
        }
      />

      <FinanceEntityNote scope={finance} subject="El estado de flujos de efectivo" />
      {rangeInverted ? (
        <CocoaCallout tone="warning" title="Revisa el periodo">
          La fecha de inicio ({date(fromDate, "short")}) es posterior a la de fin ({date(toDate, "short")}). Corrige las fechas para calcular el estado.
        </CocoaCallout>
      ) : null}

      {data ? (
        <>
          <CocoaKpiStrip stagger aria-label="Resumen de tesorería del periodo">
            <CocoaKpi label="Tesorería inicial" value={money(data.openingCash)} polarity="neutral" deltaLabel={`a ${date(data.periodStart, "short")}`} />
            <CocoaKpi label="Variación neta" value={money(data.netChangeInCash)} polarity="neutral" status={data.netChangeInCash >= 0 ? "ok" : "warning"} tone={signedTone(data.netChangeInCash)} />
            <CocoaKpi label="Tesorería final" value={money(data.closingCash)} polarity="neutral" deltaLabel={`a ${date(data.periodEnd, "short")}`} status={data.reconciled === false ? "warning" : "ok"} />
            <CocoaKpi label="Resultado del periodo" value={money(data.operating.netIncome)} polarity="neutral" tone={signedTone(data.operating.netIncome)} />
          </CocoaKpiStrip>

          <CocoaGrid align="start" aria-label="Explotación y flujo por actividad">
            <CocoaSpan cols={8} min={480}>
              <CocoaSection title="Actividades de explotación" meta={periodLabel} headingLevel={2} action={<Amount value={data.operating.subtotal} />}>
                <ul className="c22-section__list" aria-label="Resultado y ajustes no monetarios">
                  <LineRow label="Resultado del periodo (pérdidas y ganancias)" amount={data.operating.netIncome} />
                  <LineRow label="(+) Amortización del inmovilizado (68x)" amount={data.operating.depreciation} />
                  <LineRow label="Resultado ajustado" amount={data.operating.netIncome + data.operating.depreciation} total />
                </ul>
                <ul className="c22-section__list" aria-label="Variaciones del capital circulante">
                  {changes.map((change) => (
                    <LineRow key={change.category} label={change.category} amount={change.amount} />
                  ))}
                  <LineRow label="Variación del capital circulante" amount={workingCapitalTotal} total />
                </ul>
                <ul className="c22-section__list" aria-label="Subtotal de explotación">
                  <LineRow label="Flujos de efectivo de las actividades de explotación" amount={data.operating.subtotal} total />
                </ul>
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={4} min={320}>
              <CocoaSection title="Flujo por actividad" meta="explotación · inversión · financiación" headingLevel={2}>
                <CocoaChart.Bars data={activityBars} height={140} valueFormat={(value) => money(value)} aria-label="Flujo neto de efectivo por actividad" />
                <ul className="c22-section__list" aria-label="Conciliación de la tesorería">
                  <LineRow label="Tesorería inicial" amount={data.openingCash} />
                  <LineRow label="(+) Variación neta del efectivo" amount={data.netChangeInCash} />
                  <LineRow label="Tesorería final" amount={data.closingCash} total />
                </ul>
                {data.reconciled === false ? (
                  <CocoaState kind="degraded" inline title="El saldo final no coincide con el libro." message="Revisa asientos de tesorería fechados fuera del periodo o cuentas 57x sin clasificar." />
                ) : null}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaGrid align="start" aria-label="Inversión y financiación">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Actividades de inversión" headingLevel={2} action={<Amount value={data.investing.subtotal} />}>
                {investing.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin movimientos de inversión en el periodo." />
                ) : (
                  <ul className="c22-section__list" aria-label="Movimientos de inversión">
                    {investing.map((item) => (
                      <LineRow key={item.description} label={item.description} amount={item.amount} />
                    ))}
                    <LineRow label="Flujos de efectivo de las actividades de inversión" amount={data.investing.subtotal} total />
                  </ul>
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Actividades de financiación" headingLevel={2} action={<Amount value={data.financing.subtotal} />}>
                {financing.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin movimientos de financiación en el periodo." />
                ) : (
                  <ul className="c22-section__list" aria-label="Movimientos de financiación">
                    {financing.map((item) => (
                      <LineRow key={item.description} label={item.description} amount={item.amount} />
                    ))}
                    <LineRow label="Flujos de efectivo de las actividades de financiación" amount={data.financing.subtotal} total />
                  </ul>
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <p className="cocoa-caption" style={secondaryStyle}>
            Calculado el {dateTime(data.generatedAt)} para el periodo {periodLabel}. Se recalcula cada cinco minutos.
          </p>
        </>
      ) : null}
    </CocoaPage>
  );
}

export default CashFlowScreen;
