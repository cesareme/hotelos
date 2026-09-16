// Tesorería — Finanzas › Tesorería (/finanzas/tesoreria, base tab of TesoreriaTabs).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «DashboardAlojado»): KPI strip → grid
// 8/4 (previsión 30 · 60 · 90 días · cuentas bancarias) → 6/6 (cuentas a
// cobrar · cuentas a pagar, con antigüedad y documentos) → 6/6 (principales
// deudores · últimos cobros). Hosted, the container paints eyebrow and title.
//
// Data (Tanda 6 · módulo treasury, banking.read): GET /treasury/position
// (caja 570 + bancos 572 desde el libro y el último extracto, `source` y
// `warnings` dicen cuán honesta es la cifra), /treasury/receivables,
// /treasury/payables (aging + documentos, `method` explica el cálculo) and
// /treasury/forecast (30/60/90, `assumptions`). The legacy GET
// /dashboards/finance-position (analytics.read) keeps feeding `labels`,
// `kpis.monthCollectedPct`, top debtors and the latest payments. Money on the
// treasury contract travels as decimal strings ("1234.50"): lib/format turns
// it into es-ES text only when painting. Everything polls every 60 s as before.
//
// Tanda 6b · L7 (design §5.3): the header carries the ONE «Ámbito» — the
// sociedad by default (`GET /treasury/*?scope=entity`: every account, with and
// without centre) or one centre (`propertyId`); the legacy dashboard stays
// per centre (it has no sociedad scope) and says so.

import { useState, type CSSProperties } from "react";
import type { ForecastBucket, ForecastBucketLabel, PayableItem, ReceivableItem, TreasuryAgingBuckets, TreasuryBankRow } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { SOCIETY_NO_CENTRE_LABEL, centreNameFor, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import type { TreasuryForecast, TreasuryPayables, TreasuryPosition, TreasuryReceivables } from "../../services/treasuryApi";
import { navigateTo } from "../../lib/navigate";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, money, number, percent, plural, toNumber } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  toneInk,
  type CocoaBarsDatum,
  type CocoaKpiStatus,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Legacy dashboard (labels, % cobrado del mes, top debtors, últimos cobros).
// ---------------------------------------------------------------------------

type LegacyAging = { current: number; days0_30: number; days31_60: number; days61_90: number; days90Plus: number };

type LegacyDashboard = {
  kpis: { accountsReceivableTotal: number; accountsPayableTotal: number; cashOnHand: number; monthCollectedPct: number; pendingSettlements?: number };
  arAging: LegacyAging;
  apAging: LegacyAging;
  topDebtors: Array<{ guestOrAccount: string; invoiceCount: number; outstanding: number }>;
  topCreditors: Array<{ supplierName: string; billCount: number; outstanding: number }>;
  recentPayments: Array<{ id: string; amount: number; method: string; methodLabel?: string; capturedAt?: string; reference?: string }>;
  source?: string;
  warnings?: string[];
  labels?: Record<string, string>;
};

type Debtor = LegacyDashboard["topDebtors"][number];
type RecentPayment = LegacyDashboard["recentPayments"][number];

const POLL_MS = 60000;
const MAX_DOCUMENTS = 8;

// Spanish fallbacks for the `labels` the legacy dashboard sends.
const LABELS: Record<string, string> = {
  accountsReceivableTotal: "Pendiente de cobro",
  accountsPayableTotal: "Pendiente de pago",
  cashOnHand: "Caja y bancos",
  monthCollectedPct: "% cobrado del mes",
  arAging: "Antigüedad de cobros",
  apAging: "Antigüedad de pagos",
  topDebtors: "Principales deudores",
  topCreditors: "Principales acreedores",
  recentPayments: "Últimos cobros",
  banks: "Cuentas bancarias",
  current: "No vencido",
  days0_30: "0-30 días",
  days31_60: "31-60 días",
  days61_90: "61-90 días",
  days90Plus: "> 90 días"
};

const BUCKET_LABEL: Record<ForecastBucketLabel, string> = { overdue: "Vencido", "0-30": "0-30 días", "31-60": "31-60 días", "61-90": "61-90 días", "90+": "> 90 días" };

const RECEIVABLE_KIND: Record<ReceivableItem["kind"], string> = { invoice: "Factura", folio: "Folio abierto" };
const PAYABLE_KIND: Record<PayableItem["kind"], string> = { supplier_bill: "Factura recibida", payroll_period: "Nómina", commission_accrual: "Comisión de canal", tax_liability: "Obligación fiscal" };

// Text styles (tokens only; layout comes from the utility classes).
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
const captionStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const growStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

/** Small toned amount (≤ 13 px): AA ink of the tone, plain label for neutral. */
function amountStyle(value: number | null): CSSProperties {
  const tone: CocoaTone = value === null || Math.abs(value) < 0.005 ? "neutral" : value < 0 ? "danger" : "success";
  return { color: tone === "neutral" ? "var(--cocoa-label)" : toneInk(tone) };
}

function agingStatus(aging: TreasuryAgingBuckets | undefined): CocoaKpiStatus {
  if (!aging) return "ok";
  if ((toNumber(aging.days90Plus) ?? 0) > 0) return "critical";
  if ((toNumber(aging.days61_90) ?? 0) > 0) return "warning";
  return "ok";
}

function collectedStatus(pct: number | undefined): CocoaKpiStatus {
  if (pct === undefined) return "ok";
  return pct >= 80 ? "ok" : pct >= 50 ? "warning" : "critical";
}

function signedTone(value: number): CocoaTone {
  return Math.abs(value) < 0.005 ? "neutral" : value > 0 ? "success" : "danger";
}

// ---------------------------------------------------------------------------
// Columns (outside the component, typed with the row).
// ---------------------------------------------------------------------------

const RECEIVABLE_COLUMNS: CocoaTableColumn<ReceivableItem>[] = [
  {
    key: "reference",
    label: "Documento",
    render: (r) => (
      <>
        <strong>{r.reference}</strong>
        <span style={captionStyle}>
          {RECEIVABLE_KIND[r.kind] ?? r.kind} · {r.counterparty}
        </span>
      </>
    )
  },
  {
    key: "expectedOn",
    label: "Cobro previsto",
    hideOnNarrow: true,
    render: (r) => (
      <span className="cocoa-cluster">
        {date(r.expectedOn, "short")}
        {r.assumedDate ? <CocoaBadge tone="neutral" size="small" title="Fecha estimada: emisión más 30 días">estimada</CocoaBadge> : null}
        {r.daysOverdue > 0 ? <CocoaBadge tone="danger" size="small">{plural(r.daysOverdue, "día vencido", "días vencido")}</CocoaBadge> : null}
      </span>
    )
  },
  { key: "outstanding", label: "Pendiente", align: "right", render: (r) => <strong>{money(r.outstanding)}</strong> }
];

const PAYABLE_COLUMNS: CocoaTableColumn<PayableItem>[] = [
  {
    key: "reference",
    label: "Documento",
    render: (r) => (
      <>
        <strong>{r.reference}</strong>
        <span style={captionStyle}>
          {PAYABLE_KIND[r.kind] ?? r.kind} · {r.counterparty}
        </span>
      </>
    )
  },
  {
    key: "expectedOn",
    label: "Pago previsto",
    hideOnNarrow: true,
    render: (r) => (
      <span className="cocoa-cluster">
        {date(r.expectedOn, "short")}
        {r.assumedDate ? <CocoaBadge tone="neutral" size="small" title="Fecha estimada por convención">estimada</CocoaBadge> : null}
        {r.daysOverdue > 0 ? <CocoaBadge tone="danger" size="small">{plural(r.daysOverdue, "día vencido", "días vencido")}</CocoaBadge> : null}
      </span>
    )
  },
  { key: "outstanding", label: "Pendiente", align: "right", render: (r) => <strong>{money(r.outstanding)}</strong> }
];

const DEBTOR_COLUMNS: CocoaTableColumn<Debtor>[] = [
  { key: "guestOrAccount", label: "Cliente", render: (d) => <strong>{d.guestOrAccount}</strong> },
  { key: "invoiceCount", label: "Facturas", align: "right", hideOnNarrow: true, render: (d) => number(d.invoiceCount) },
  { key: "outstanding", label: "Pendiente", align: "right", render: (d) => <strong>{money(d.outstanding)}</strong> }
];

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Five aging buckets as a list; the > 90 bucket is painted in danger when it holds money. */
function AgingList({ aging, labels }: { aging: TreasuryAgingBuckets; labels: (key: string) => string }) {
  const rows: Array<[string, string]> = [
    ["current", aging.current],
    ["days0_30", aging.days0_30],
    ["days31_60", aging.days31_60],
    ["days61_90", aging.days61_90],
    ["days90Plus", aging.days90Plus]
  ];
  return (
    <ul className="c22-section__list" aria-label="Antigüedad de los saldos">
      {rows.map(([key, value]) => {
        const amount = toNumber(value) ?? 0;
        const late = (key === "days90Plus" || key === "days61_90") && amount > 0;
        return (
          <li key={key}>
            <span style={secondaryStyle}>{labels(key)}</span>
            <strong style={amountStyle(late ? -amount : null)}>{money(value)}</strong>
          </li>
        );
      })}
    </ul>
  );
}

/** «Cómo se calcula» — the `method` / `assumptions` sentences of the API, folded by default. */
function MethodNote({ id, items }: { id: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="cocoa-stack" data-gap="2">
      <div className="cocoa-row" data-gap="2">
        <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={id}>
          {open ? "Ocultar el método de cálculo" : "Cómo se calcula"}
        </CocoaButton>
      </div>
      {open ? (
        <ul id={id} className="c22-section__list" aria-label="Método de cálculo">
          {items.map((item, index) => (
            <li key={index}>
              <span style={secondaryStyle}>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <CocoaState kind="error" inline title="No se pudo cargar este bloque." message={message} onRetry={onRetry} />;
}

// Mirror skeleton: the KPI strip and the three grid rows, same spans.
function TreasurySkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[8, 4], [6, 6], [6, 6]]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function FinancePositionDashboard() {
  const hosted = useTabHost() !== null;
  const finance = useFinanceScope(financeScopePolicy("FinancePositionDashboard"));
  const entityScope = finance.scope.kind === "entity";
  // Treasury routes: `scope=entity` for the sociedad, `propertyId` for a centre. The legacy
  // dashboard has no sociedad scope: it keeps the active centre.
  const query = finance.treasuryQuery;
  const legacyQuery = { propertyId: finance.propertyId ?? finance.active.propertyId };

  const dash = useApiData<LegacyDashboard>("/dashboards/finance-position", { pollIntervalMs: POLL_MS, query: legacyQuery });
  const position = useApiData<TreasuryPosition & { scope?: string; entityLabel?: string; banks: Array<TreasuryBankRow & { propertyId?: string | null }> }>("/treasury/position", { pollIntervalMs: POLL_MS, query });
  const receivables = useApiData<TreasuryReceivables>("/treasury/receivables", { pollIntervalMs: POLL_MS, query });
  const payables = useApiData<TreasuryPayables>("/treasury/payables", { pollIntervalMs: POLL_MS, query });
  const forecast = useApiData<TreasuryForecast>("/treasury/forecast", { pollIntervalMs: POLL_MS, query });

  const refreshAll = () => {
    dash.refresh();
    position.refresh();
    receivables.refresh();
    payables.refresh();
    forecast.refresh();
  };

  const pos = position.data;
  const legacy = dash.data;
  const labels = (key: string) => legacy?.labels?.[key] ?? LABELS[key] ?? key;

  const banks = toArray<TreasuryBankRow & { propertyId?: string | null }>(pos?.banks);
  const warnings = toArray<string>(pos?.warnings);
  const topDebtors = toArray<Debtor>(legacy?.topDebtors);
  const recentPayments = toArray<RecentPayment>(legacy?.recentPayments);
  const receivableItems = toArray<ReceivableItem>(receivables.data?.items);
  const payableItems = toArray<PayableItem>(payables.data?.items);
  const buckets = toArray<ForecastBucket>(forecast.data?.buckets);
  const horizons = toArray<TreasuryForecast["horizons"][number]>(forecast.data?.horizons);

  const anyLoading = dash.loading || position.loading || receivables.loading || payables.loading || forecast.loading;
  const state = !pos && !legacy ? (position.loading || dash.loading ? "loading" : "error") : "ready";
  const fatalError = position.error ?? dash.error ?? undefined;

  const cashAndBanks = toNumber(pos?.totals.cashAndBanks);
  const monthCollected = legacy?.kpis.monthCollectedPct;

  const forecastBars: CocoaBarsDatum[] = buckets.map((bucket) => {
    const net = toNumber(bucket.net) ?? 0;
    return {
      label: BUCKET_LABEL[bucket.label] ?? bucket.label,
      value: net,
      tone: signedTone(net),
      hint: `Cobros ${money(bucket.inflows)} · Pagos ${money(bucket.outflows)}`
    };
  });

  const asOfLabel = pos ? `datos a ${date(pos.asOf, "short")}` : undefined;
  const subtitle = hosted ? undefined : `Caja, bancos, cobros y pagos pendientes desde el libro contable, con previsión a 30, 60 y 90 días.${asOfLabel ? ` Se actualiza cada minuto · ${asOfLabel}.` : ""}`;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Tesorería"
      subtitle={subtitle}
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          {pos ? (
            <CocoaBadge tone={pos.source === "ledger+statements" ? "success" : "info"} title="Origen de la posición de tesorería">
              {pos.source === "ledger+statements" ? "Libro y extractos" : "Solo libro contable"}
            </CocoaBadge>
          ) : null}
          {anyLoading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<TreasurySkeleton />}
      error={{ title: "No se pudo cargar la tesorería", message: fatalError, onRetry: refreshAll }}
      commands={[{ id: "treasury-refresh", label: "Actualizar la tesorería", run: refreshAll }]}
    >
      {entityScope && finance.structure && finance.structure.mode !== "single_hotel" ? (
        <CocoaCallout tone="info" title={`Posición de toda la sociedad${pos?.entityLabel ? ` · ${pos.entityLabel}` : ""}`}>
          Caja, bancos, cobros y pagos de todos los centros bajo un solo NIF; las cuentas sin centro aparecen como «{SOCIETY_NO_CENTRE_LABEL}». El porcentaje cobrado del mes, los principales deudores y los últimos cobros siguen siendo del centro {centreNameFor(finance.structure, legacyQuery.propertyId)}.
        </CocoaCallout>
      ) : null}
      {warnings.length > 0 ? (
        <CocoaCallout tone="info" title="Lo que hay detrás de las cifras">
          <ul className="c22-section__list">
            {warnings.map((warning, index) => (
              <li key={index}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de tesorería">
        <CocoaKpi
          label={labels("cashOnHand")}
          value={money(pos?.totals.cashAndBanks)}
          polarity="neutral"
          status={cashAndBanks !== null && cashAndBanks < 0 ? "critical" : "ok"}
          degraded={!pos}
        />
        <CocoaKpi
          label={labels("accountsReceivableTotal")}
          value={money(receivables.data?.total ?? pos?.totals.receivables)}
          polarity="neutral"
          status={agingStatus(receivables.data?.aging)}
          degraded={!receivables.data && !pos}
        />
        <CocoaKpi
          label={labels("accountsPayableTotal")}
          value={money(payables.data?.total ?? pos?.totals.payables)}
          polarity="neutral"
          status={agingStatus(payables.data?.aging)}
          degraded={!payables.data && !pos}
        />
        {/* Fixed short headline: the legacy `labels.pendingSettlements` is a full sentence («Datáfono y pasarela pendientes de liquidar») that overflows a six-tile strip (qa#7); the qualifier goes to the caption. */}
        <CocoaKpi label="Datáfono y pasarela" caption="pendiente de liquidar" value={money(pos?.pendingSettlements.total)} polarity="neutral" status="ok" degraded={!pos} />
        <CocoaKpi label={labels("monthCollectedPct")} value={percent(monthCollected, { maximumFractionDigits: 1 })} polarity="positive-good" status={collectedStatus(monthCollected)} degraded={!legacy} />
        <CocoaKpi
          label="Posición neta"
          value={money(pos?.totals.net)}
          polarity="neutral"
          status={(toNumber(pos?.totals.net) ?? 0) < 0 ? "warning" : "ok"}
          degraded={!pos}
        />
      </CocoaKpiStrip>

      <CocoaGrid align="start" aria-label="Previsión y bancos">
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Previsión de tesorería" meta="30 · 60 · 90 días" headingLevel={2}>
            {forecast.error && !forecast.data ? (
              <SectionError message={forecast.error} onRetry={forecast.refresh} />
            ) : !forecast.data ? (
              <CocoaSkeleton variant="chart" />
            ) : (
              <>
                <div className="cocoa-row" data-gap="4" data-align="start">
                  <CocoaStat label="Saldo de partida" value={money(forecast.data.opening)} hint={`a ${date(forecast.data.asOf, "short")}`} />
                  {horizons.map((horizon) => (
                    <CocoaStat
                      key={horizon.days}
                      label={`Saldo previsto a ${number(horizon.days)} días`}
                      value={money(horizon.projectedBalance)}
                      tone={signedTone(toNumber(horizon.projectedBalance) ?? 0)}
                      hint={`cobros ${money(horizon.inflows)} · pagos ${money(horizon.outflows)}`}
                    />
                  ))}
                </div>
                {forecastBars.length > 0 ? (
                  <CocoaChart.Bars data={forecastBars} height={140} valueFormat={(value) => money(value)} aria-label="Flujo neto previsto por tramo de vencimiento" />
                ) : (
                  <CocoaState kind="empty" inline title="Sin cobros ni pagos previstos." />
                )}
                <MethodNote id="treasury-forecast-method" items={toArray<string>(forecast.data.assumptions)} />
              </>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={4} min={320}>
          <CocoaSection title={labels("banks")} meta={pos ? plural(banks.length, "cuenta", "cuentas") : undefined} headingLevel={2}>
            {pos ? (
              <CocoaStat label={`Caja (${pos.cash.ledgerAccountCode})`} value={money(pos.cash.balance)} hint="saldo contable" />
            ) : null}
            {banks.length === 0 ? (
              <CocoaState
                kind="empty"
                dashed
                title="Sin cuentas bancarias"
                message="Da de alta las cuentas del hotel e importa sus extractos para comparar el saldo del banco con el libro."
                primaryAction={{ label: "Abrir conciliación bancaria", onClick: () => navigateTo("BankReconciliationScreen") }}
              />
            ) : (
              <ul className="c22-section__list" aria-label="Cuentas bancarias">
                {banks.map((bank) => {
                  const drift = toNumber(bank.drift) ?? 0;
                  return (
                    <li key={bank.bankAccountId}>
                      <div className="cocoa-stack" data-gap="1" style={growStyle}>
                        <strong>{bank.name}</strong>
                        <span style={captionStyle}>
                          {bank.ibanMasked ?? "sin IBAN"} · cuenta {bank.ledgerAccountCode}
                          {bank.statementDate ? ` · extracto a ${date(bank.statementDate, "short")}` : " · sin extractos"}
                          {entityScope ? ` · ${centreNameFor(finance.structure, bank.propertyId ?? null)}` : ""}
                        </span>
                        {bank.unmatchedLines > 0 ? (
                          <span style={captionStyle}>{plural(bank.unmatchedLines, "movimiento sin conciliar", "movimientos sin conciliar")} · {money(bank.unmatchedAmount)}</span>
                        ) : null}
                      </div>
                      <div className="cocoa-stack" data-gap="1">
                        <strong>{money(bank.ledgerBalance)}</strong>
                        {bank.statementClosing !== null ? (
                          <CocoaBadge tone={Math.abs(drift) < 0.01 ? "success" : Math.abs(drift) < 10 ? "warning" : "danger"} size="small" title="Saldo del extracto menos saldo del libro">
                            dif. {money(bank.drift)}
                          </CocoaBadge>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Cuentas a cobrar y a pagar">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Cuentas a cobrar" meta={receivables.data ? money(receivables.data.total) : undefined} headingLevel={2}>
            {receivables.error && !receivables.data ? (
              <SectionError message={receivables.error} onRetry={receivables.refresh} />
            ) : !receivables.data ? (
              <CocoaSkeleton variant="card" height={200} />
            ) : (
              <>
                <div className="cocoa-row" data-gap="4">
                  <CocoaStat label="Facturas emitidas" value={money(receivables.data.invoices)} />
                  <CocoaStat label="Folios abiertos" value={money(receivables.data.openFolios)} />
                </div>
                <AgingList aging={receivables.data.aging} labels={labels} />
                {receivableItems.length === 0 ? (
                  <CocoaState kind="empty" inline title="Nada pendiente de cobro." />
                ) : (
                  <CocoaTable
                    columns={RECEIVABLE_COLUMNS}
                    rows={receivableItems.slice(0, MAX_DOCUMENTS)}
                    rowKey="id"
                    density="compact"
                    caption="Documentos pendientes de cobro"
                    aria-label="Documentos pendientes de cobro"
                  />
                )}
                {receivableItems.length > MAX_DOCUMENTS ? <span style={captionStyle}>Se muestran {number(MAX_DOCUMENTS)} de {plural(receivableItems.length, "documento", "documentos")}.</span> : null}
                <MethodNote id="treasury-receivables-method" items={toArray<string>(receivables.data.method)} />
              </>
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Cuentas a pagar" meta={payables.data ? money(payables.data.total) : undefined} headingLevel={2}>
            {payables.error && !payables.data ? (
              <SectionError message={payables.error} onRetry={payables.refresh} />
            ) : !payables.data ? (
              <CocoaSkeleton variant="card" height={200} />
            ) : (
              <>
                <div className="cocoa-row" data-gap="4">
                  <CocoaStat label="Facturas recibidas" value={money(payables.data.supplierBills)} />
                  <CocoaStat label="Nóminas" value={money(payables.data.payroll)} />
                  <CocoaStat label="Comisiones" value={money(payables.data.commissions)} />
                  <CocoaStat label="Obligaciones fiscales" value={money(payables.data.taxLiabilities)} />
                </div>
                <AgingList aging={payables.data.aging} labels={labels} />
                {payableItems.length === 0 ? (
                  <CocoaState kind="empty" inline title="Nada pendiente de pago." />
                ) : (
                  <CocoaTable
                    columns={PAYABLE_COLUMNS}
                    rows={payableItems.slice(0, MAX_DOCUMENTS)}
                    rowKey="id"
                    density="compact"
                    caption="Documentos pendientes de pago"
                    aria-label="Documentos pendientes de pago"
                  />
                )}
                {payableItems.length > MAX_DOCUMENTS ? <span style={captionStyle}>Se muestran {number(MAX_DOCUMENTS)} de {plural(payableItems.length, "documento", "documentos")}.</span> : null}
                <MethodNote id="treasury-payables-method" items={toArray<string>(payables.data.method)} />
              </>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaGrid align="start" aria-label="Deudores y últimos cobros">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title={labels("topDebtors")}
            meta={legacy ? plural(topDebtors.length, "cliente", "clientes") : undefined}
            headingLevel={2}
            padding={topDebtors.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {dash.error && !legacy ? (
              <SectionError message={dash.error} onRetry={dash.refresh} />
            ) : !legacy ? (
              <CocoaSkeleton variant="card" height={160} />
            ) : topDebtors.length === 0 ? (
              <CocoaState kind="empty" inline title="No hay clientes con saldo pendiente." />
            ) : (
              <CocoaTable columns={DEBTOR_COLUMNS} rows={topDebtors} rowKey={(d) => `${d.guestOrAccount}-${d.outstanding}`} caption="Principales deudores" aria-label="Principales deudores" />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title={labels("recentPayments")} meta={legacy ? plural(recentPayments.length, "cobro", "cobros") : undefined} headingLevel={2}>
            {dash.error && !legacy ? (
              <SectionError message={dash.error} onRetry={dash.refresh} />
            ) : !legacy ? (
              <CocoaSkeleton variant="card" height={160} />
            ) : recentPayments.length === 0 ? (
              <CocoaState kind="empty" inline title="Todavía no se ha registrado ningún cobro." />
            ) : (
              <ul className="c22-section__list" aria-label="Últimos cobros">
                {recentPayments.map((payment) => (
                  <li key={payment.id}>
                    <div className="cocoa-stack" data-gap="1" style={growStyle}>
                      <span>{payment.methodLabel ?? payment.method}</span>
                      <span style={captionStyle}>
                        {dateTime(payment.capturedAt)}
                        {payment.reference ? ` · ref. ${payment.reference}` : ""}
                      </span>
                    </div>
                    <strong>{money(payment.amount)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

export default FinancePositionDashboard;
