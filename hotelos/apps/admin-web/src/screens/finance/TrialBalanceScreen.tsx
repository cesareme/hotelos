// Sumas y saldos — Finanzas › Estados contables (/finanzas/estados-contables;
// base tab «Sumas y saldos» of EstadosContablesTabs). Cocoa 22 · lote 6-C
// (migrated from the legacy «Balance de comprobación» screen), archetype
// «dashboard».
//
// GET /accounting/reports/trial-balance?asOf[&fromDate&toDate][&propertyId]:
// the sums and balances by account computed from the ledger with the same
// reading rule as the statements (aggregateAccountBalances). Toolbar: fecha de
// corte, desde/hasta opcionales, propiedad. CocoaKpiStrip (Σ debe · Σ haber ·
// diferencia · cuentas) → CocoaTable (código · cuenta · debe · haber · saldo
// deudor · saldo acreedor; a row opens the Mayor of the account with the same
// window) → footer with the totals and the «cuadra / no cuadra» verdict.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { urlForScreen } from "../../navigation/nav-tree";
import { ACTIONS } from "../../content/actions";
import { date, dateTime, money, number, plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDatePicker,
  CocoaField,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import { kindLabel, kindTone, readQueryParam, todayIso, withQuery } from "../accounting/accounting-ui";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";

type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  kind: string;
  debitTotal: number;
  creditTotal: number;
  balance: number;
  debitBalance: number;
  creditBalance: number;
};

type TrialBalance = {
  organizationId: string;
  propertyId?: string | null;
  asOf: string;
  fromDate?: string;
  toDate?: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totals: { debit: number; credit: number; debitBalance: number; creditBalance: number };
  balanced: boolean;
};

const codeStyle: CSSProperties = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

const COLUMNS: CocoaTableColumn<TrialBalanceRow>[] = [
  { key: "accountCode", label: "Código", width: "10ch", render: (row) => <strong style={codeStyle}>{row.accountCode}</strong> },
  { key: "accountName", label: "Cuenta", render: (row) => row.accountName },
  { key: "kind", label: "Naturaleza", render: (row) => <CocoaBadge tone={kindTone(row.kind)}>{kindLabel(row.kind)}</CocoaBadge>, hideOnNarrow: true },
  { key: "debitTotal", label: "Suma del debe", align: "right", render: (row) => money(row.debitTotal) },
  { key: "creditTotal", label: "Suma del haber", align: "right", render: (row) => money(row.creditTotal) },
  { key: "debitBalance", label: "Saldo deudor", align: "right", render: (row) => (row.debitBalance !== 0 ? money(row.debitBalance) : ""), hideOnNarrow: true },
  { key: "creditBalance", label: "Saldo acreedor", align: "right", render: (row) => (row.creditBalance !== 0 ? money(row.creditBalance) : ""), hideOnNarrow: true }
];

function TrialBalanceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[12]]} height={420} />
    </div>
  );
}

export function TrialBalanceScreen() {
  // Base tab of the item: the container paints «Finanzas» + «Estados contables»; standalone the page names the tab.
  const header = { eyebrow: "Finanzas · Estados contables", title: "Sumas y saldos" };
  // Tanda 6b · L7: the «Ámbito» of the header (sociedad by default, a centre as filter) is the `propertyId` of the report.
  const finance = useFinanceScope(financeScopePolicy("TrialBalanceScreen"));
  const [asOf, setAsOf] = useState(() => readQueryParam("hasta") ?? todayIso());
  const [fromDate, setFromDate] = useState(() => readQueryParam("desde") ?? "");
  const [toDate, setToDate] = useState("");
  const propertyId = finance.propertyId ?? "";

  const query = useMemo(() => {
    const q: Record<string, string> = { asOf };
    if (propertyId) q.propertyId = propertyId;
    if (fromDate) q.fromDate = fromDate;
    if (toDate) q.toDate = toDate;
    return q;
  }, [asOf, fromDate, toDate, propertyId]);

  const { data, loading, error, refresh } = useApiData<TrialBalance>("/accounting/reports/trial-balance", { query, pollIntervalMs: 300_000 });
  const k = data;
  const rows = k?.rows ?? [];
  const difference = k ? Math.round((k.totals.debit - k.totals.credit) * 100) / 100 : 0;
  const ledgerUrl = urlForScreen("LedgerScreen");
  const windowLabel = k ? (k.fromDate ? `${date(k.fromDate, "short")} – ${date(k.toDate ?? k.asOf, "short")}` : `acumulado hasta ${date(k.asOf, "short")}`) : "";

  function openLedger(row: TrialBalanceRow) {
    if (!ledgerUrl) return;
    openTabPath(withQuery(ledgerUrl, { cuenta: row.accountCode, desde: fromDate || undefined, hasta: toDate || asOf, ambito: finance.value }));
  }

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle={k ? `Sumas y saldos por cuenta desde el libro diario · ${windowLabel} · ${finance.scope.label} · calculado ${dateTime(k.generatedAt)}` : "Suma del debe y del haber de cada cuenta del PGC con su saldo: comprueba que la partida doble cuadra."}
      actions={
        <>
          {k ? <CocoaBadge tone={k.balanced ? "success" : "danger"}>{k.balanced ? "Cuadra" : "No cuadra"}</CocoaBadge> : null}
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && !!k}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !k ? "loading" : error && !k ? "error" : "ready"}
      skeleton={<TrialBalanceSkeleton />}
      error={{ title: "No se pudo calcular el balance de sumas y saldos", message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "trial-balance-refresh", label: "Recalcular sumas y saldos", run: refresh }]}
      id="trial-balance-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Fechas y ámbito"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Fecha de corte" required>
              <CocoaDatePicker value={asOf} onChange={setAsOf} size="small" aria-label="Fecha de corte" />
            </CocoaField>
            <CocoaField label="Desde" hint="opcional">
              <CocoaDatePicker value={fromDate} onChange={setFromDate} size="small" aria-label="Movimientos desde" />
            </CocoaField>
            <CocoaField label="Hasta" hint="opcional">
              <CocoaDatePicker value={toDate} onChange={setToDate} size="small" aria-label="Movimientos hasta" />
            </CocoaField>
          </div>
        }
        rightSlot={
          fromDate || toDate ? (
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              {ACTIONS.clearFilters}
            </CocoaButton>
          ) : undefined
        }
      />

      {k ? (
        <>
          <CocoaKpiStrip stagger aria-label="Totales de sumas y saldos">
            <CocoaKpi label="Suma del debe" value={money(k.totals.debit)} deltaLabel={plural(rows.length, "cuenta con movimiento", "cuentas con movimiento")} polarity="neutral" />
            <CocoaKpi label="Suma del haber" value={money(k.totals.credit)} deltaLabel={plural(rows.length, "cuenta con movimiento", "cuentas con movimiento")} polarity="neutral" />
            <CocoaKpi label="Diferencia" value={money(difference)} deltaLabel={k.balanced ? "la partida doble cuadra" : "descuadre: revisa el diario"} polarity="neutral" status={k.balanced ? "ok" : "critical"} />
            <CocoaKpi label="Saldos" value={money(k.totals.debitBalance)} unit="deudores" deltaLabel={`acreedores ${money(k.totals.creditBalance)}`} polarity="neutral" />
          </CocoaKpiStrip>

          <CocoaSection
            title="Detalle por cuenta"
            meta={windowLabel}
            padding={rows.length > 0 ? "none" : "md"}
            footer={rows.length > 0 ? <span>{plural(rows.length, "cuenta", "cuentas")} · una fila abre el mayor de la cuenta</span> : undefined}
            style={{ overflow: "clip" }}
          >
            {rows.length > 0 ? (
              <CocoaTable
                columns={COLUMNS}
                rows={rows}
                rowKey="accountCode"
                density="compact"
                onSelect={ledgerUrl ? openLedger : undefined}
                rowTitle={() => "Abrir el mayor de la cuenta"}
                footer={{
                  accountName: "Totales",
                  debitTotal: money(k.totals.debit),
                  creditTotal: money(k.totals.credit),
                  debitBalance: money(k.totals.debitBalance),
                  creditBalance: money(k.totals.creditBalance)
                }}
                caption="Sumas y saldos por cuenta"
                aria-label="Sumas y saldos por cuenta"
              />
            ) : (
              <CocoaState
                kind="empty"
                illustration="box"
                title="Sin movimientos contables"
                message={fromDate ? `No hay asientos contabilizados entre ${date(fromDate, "short")} y ${date(toDate || asOf, "short")}.` : `No hay asientos contabilizados hasta ${date(asOf, "short")}${propertyId ? " en este centro" : ""}. Los asientos nacen al emitir facturas, registrar cobros y cerrar comandas.`}
              />
            )}
          </CocoaSection>
          <p className="cocoa-caption">{number(rows.length)} cuentas · saldos deudores en positivo, acreedores en su columna; las parejas de anulación se excluyen como en el resto de estados.</p>
        </>
      ) : null}
    </CocoaPage>
  );
}

export default TrialBalanceScreen;
