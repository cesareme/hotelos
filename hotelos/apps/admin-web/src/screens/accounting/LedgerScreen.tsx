// Mayor — Finanzas › Contabilidad › Mayor (/finanzas/contabilidad/mayor,
// hosted in ContabilidadTabs). Cocoa 22 · lote 6-C, archetype «lista / tabla».
//
// CocoaToolbar: account picker (postable accounts only, hierarchy by
// parentCode/level with the headers disabled, plus a text filter over code and
// name), fecha desde/hasta, propiedad → GET /accounting/ledger/:code. Body:
// CocoaKpiStrip (saldo inicial · Σ debe · Σ haber · saldo final, all computed
// by the API over the WHOLE window) → CocoaTable of movements with the running
// balance → footer with the totals. When the API answers `truncated: true`
// the screen says so («detalle limitado a 5.000 apuntes; totales y saldo final
// completos») instead of pretending the list is whole. «Descargar CSV» calls
// the same route with format=csv. A row opens the entry in the Diario
// (?asiento=<id>). Deep link: ?cuenta=&desde=&hasta=&propiedad=.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AccountLedgerView, ChartAccountView, LedgerMovementView } from "@hotelos/shared";
import { accountingErrorMessage, downloadLedgerCsv, getAccountLedger, listChartAccounts } from "../../services/accountingApi";
import { financeErrorCode, financeErrorStatus } from "../../services/finance-contracts";
import { urlForScreen } from "../../navigation/nav-tree";
import { useToast } from "../../components/Toast";
import { STATUS_LABELS } from "../../content/actions";
import { date, money, number, plural } from "../../lib/format";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  accountDisplay,
  chartSelectOptions,
  firstDayOfYear,
  kindLabel,
  kindTone,
  readQueryParam,
  saveDownload,
  signTone,
  sourceTypeLabel,
  todayIso,
  withQuery
} from "./accounting-ui";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { centreNameFor, financeScopePolicy, useFinanceScope } from "../../services/financeScope";

const LEDGER_DETAIL_CAP = 5_000;

const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

function entryLabel(movement: LedgerMovementView): string {
  if (movement.entryNumber === null) return "Sin numerar";
  return movement.fiscalYearCode ? `${movement.entryNumber} / ${movement.fiscalYearCode}` : String(movement.entryNumber);
}

const COLUMNS: CocoaTableColumn<LedgerMovementView>[] = [
  { key: "entryDate", label: "Fecha", width: "11ch", render: (m) => date(m.entryDate, "short") },
  { key: "entryNumber", label: "Nº asiento", width: "12ch", render: (m) => entryLabel(m), hideOnNarrow: true },
  {
    key: "description",
    label: "Concepto",
    render: (m) => (
      <>
        <span>{m.description ?? "—"}</span>
        {m.reference ? <span style={subStyle}>{m.reference}</span> : null}
      </>
    )
  },
  { key: "sourceType", label: "Origen", render: (m) => sourceTypeLabel(m.sourceType), hideOnNarrow: true },
  { key: "debit", label: "Debe", align: "right", render: (m) => (m.debit !== "0.00" ? money(m.debit) : "") },
  { key: "credit", label: "Haber", align: "right", render: (m) => (m.credit !== "0.00" ? money(m.credit) : "") },
  { key: "balance", label: "Saldo", align: "right", render: (m) => <strong>{money(m.balance)}</strong> }
];

type LedgerRange = { accountCode: string; from: string; to: string; propertyId: string };

export function LedgerScreen() {
  const header = treeHeaderFor("LedgerScreen", { eyebrow: "Finanzas · Contabilidad", title: "Mayor" });
  const { showToast } = useToast();
  // Tanda 6b · L7: the «Ámbito» of the header (sociedad by default, a centre as filter) feeds `range.propertyId`.
  const finance = useFinanceScope(financeScopePolicy("LedgerScreen"));

  const [range, setRange] = useState<LedgerRange>(() => ({
    accountCode: readQueryParam("cuenta") ?? "",
    from: readQueryParam("desde") ?? firstDayOfYear(),
    to: readQueryParam("hasta") ?? todayIso(),
    propertyId: readQueryParam("propiedad") ?? ""
  }));
  const [accountFilter, setAccountFilter] = useState("");
  useEffect(() => {
    setRange((current) => (current.propertyId === (finance.propertyId ?? "") ? current : { ...current, propertyId: finance.propertyId ?? "" }));
  }, [finance.propertyId]);

  // ---- chart of accounts (picker) --------------------------------------------
  const [chart, setChart] = useState<ChartAccountView[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<unknown>(null);
  useEffect(() => {
    let mounted = true;
    listChartAccounts()
      .then((response) => {
        if (mounted) setChart(response.accounts);
      })
      .catch((err: unknown) => {
        if (mounted) setChartError(err);
      })
      .finally(() => {
        if (mounted) setChartLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const accountOptions = useMemo(() => chartSelectOptions(chart, { filter: accountFilter }), [chart, accountFilter]);
  const account = useMemo(() => chart.find((candidate) => candidate.code === range.accountCode) ?? null, [chart, range.accountCode]);

  // ---- ledger ------------------------------------------------------------------
  const [ledger, setLedger] = useState<AccountLedgerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!range.accountCode) {
      setLedger(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAccountLedger(range.accountCode, { from: range.from || undefined, to: range.to || undefined, propertyId: range.propertyId || undefined })
      .then((view) => {
        if (!cancelled) setLedger(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLedger(null);
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range.accountCode, range.from, range.to, range.propertyId, reloadNonce]);

  const [downloading, setDownloading] = useState(false);
  async function downloadCsv() {
    if (!range.accountCode) return;
    setDownloading(true);
    try {
      saveDownload(await downloadLedgerCsv(range.accountCode, { from: range.from || undefined, to: range.to || undefined, propertyId: range.propertyId || undefined }));
      showToast(`Mayor de la cuenta ${range.accountCode} descargado.`, { variant: "success" });
    } catch (err) {
      showToast(accountingErrorMessage(err, "No se pudo descargar el mayor."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  function set<K extends keyof LedgerRange>(key: K, value: LedgerRange[K]) {
    setRange((current) => ({ ...current, [key]: value }));
  }

  const journalUrl = urlForScreen("JournalScreen");
  const chartUrl = urlForScreen("ChartOfAccountsScreen");
  const movements = ledger?.movements ?? [];
  const ready = !loading && !error && ledger !== null;
  const notFound = financeErrorStatus(error) === 404;
  const chartMissing = financeErrorCode(chartError) === "CHART_NOT_PROVISIONED";

  const footer =
    ready && ledger ? (
      <>
        <span>
          {number(movements.length)} {movements.length === 1 ? "apunte" : "apuntes"}
          {ledger.truncated ? ` (detalle limitado a ${number(LEDGER_DETAIL_CAP)})` : ""}
        </span>
        <span>
          Saldo final <strong>{money(ledger.closingBalance)}</strong>
        </span>
      </>
    ) : undefined;

  let body;
  if (!range.accountCode) {
    body = (
      <CocoaState
        kind="empty"
        illustration="search"
        title="Elige una cuenta"
        message="Selecciona una cuenta imputable del plan para ver sus apuntes con el saldo corrido, el saldo inicial del periodo y los totales."
        secondaryAction={chartUrl ? { label: "Ver el plan de cuentas", onClick: () => openTabPath(chartUrl) } : undefined}
      />
    );
  } else if (loading && !ledger) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Apuntes del mayor" />;
  } else if (error) {
    body = (
      <CocoaState
        kind="error"
        title={notFound ? "Cuenta no encontrada" : "No se pudo cargar el mayor"}
        message={accountingErrorMessage(error, notFound ? `La cuenta ${range.accountCode} no existe en el plan de la sociedad.` : undefined)}
        onRetry={() => setReloadNonce((n) => n + 1)}
      />
    );
  } else if (movements.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration="box"
        title="Sin apuntes en el periodo"
        message={`La cuenta ${ledger ? accountDisplay(chart, ledger.accountCode) : range.accountCode} no tiene movimientos entre ${date(range.from, "short")} y ${date(range.to, "short")}. El saldo inicial del periodo es ${money(ledger?.openingBalance ?? "0.00")}.`}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={movements}
        rowKey={(m) => `${m.journalEntryId}-${m.entryDate}-${m.debit}-${m.credit}-${m.balance}`}
        density="compact"
        onSelect={journalUrl ? (m) => openTabPath(withQuery(journalUrl, { asiento: m.journalEntryId })) : undefined}
        rowTitle={() => "Abrir el asiento en el diario"}
        footer={{ description: "Totales del periodo", debit: money(ledger?.totals.debit), credit: money(ledger?.totals.credit), balance: money(ledger?.closingBalance) }}
        caption="Apuntes del mayor"
        aria-label="Apuntes del mayor"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle="Apuntes de una cuenta con su saldo inicial, el saldo corrido tras cada movimiento y los totales exactos del periodo."
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={downloading} disabled={!range.accountCode || !ready} onClick={() => void downloadCsv()}>
            Descargar CSV
          </CocoaButton>
        </>
      }
      commands={[
        { id: "ledger-download-csv", label: "Descargar el mayor en CSV", run: () => void downloadCsv() },
        { id: "ledger-refresh", label: "Actualizar el mayor", run: () => setReloadNonce((n) => n + 1) }
      ]}
      id="ledger-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Cuenta y periodo del mayor"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Buscar cuenta" hint={chartLoading ? STATUS_LABELS.loading : plural(chart.filter((c) => c.isPostable).length, "cuenta imputable", "cuentas imputables")}>
              <CocoaSearchInput value={accountFilter} onChange={setAccountFilter} placeholder="Código o nombre…" aria-label="Filtrar las cuentas del selector por código o nombre" />
            </CocoaField>
            <CocoaField label="Cuenta" required>
              <CocoaSelect
                value={range.accountCode}
                onChange={(value) => set("accountCode", value)}
                options={accountOptions}
                placeholder={chartLoading ? STATUS_LABELS.loading : "Elegir cuenta…"}
                disabled={chartLoading || chart.length === 0}
                size="small"
                aria-label="Cuenta del mayor"
              />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={range.from} onChange={(value) => set("from", value)} size="small" aria-label="Fecha desde" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={range.to} onChange={(value) => set("to", value)} size="small" aria-label="Fecha hasta" />
            </CocoaField>
          </div>
        }
        rightSlot={
          account ? (
            <div className="cocoa-cluster">
              <CocoaBadge tone={kindTone(account.kind)}>{kindLabel(account.kind)}</CocoaBadge>
              <CocoaBadge tone="neutral" uppercase={false}>
                {account.parentCode ? `Cabecera ${account.parentCode}` : `Grupo ${account.group}`}
              </CocoaBadge>
            </div>
          ) : undefined
        }
      />

      {chartError ? (
        <CocoaCallout tone={chartMissing ? "danger" : "warning"} title={chartMissing ? "Sin plan de cuentas" : "Plan de cuentas no disponible"} role="alert">
          {accountingErrorMessage(chartError, "No se pudo cargar el plan de cuentas; escribe el código de la cuenta en la URL (?cuenta=) o vuelve a intentarlo.")}
        </CocoaCallout>
      ) : null}

      {ready && ledger ? (
        <CocoaKpiStrip aria-label="Resumen del periodo">
          <CocoaKpi label="Saldo inicial" value={money(ledger.openingBalance)} deltaLabel={ledger.from ? `al ${date(ledger.from, "short")}` : "sin fecha de inicio"} polarity="neutral" tone={signTone(ledger.openingBalance)} />
          <CocoaKpi label="Suma del debe" value={money(ledger.totals.debit)} deltaLabel="todo el periodo" polarity="neutral" />
          <CocoaKpi label="Suma del haber" value={money(ledger.totals.credit)} deltaLabel="todo el periodo" polarity="neutral" />
          <CocoaKpi label="Saldo final" value={money(ledger.closingBalance)} deltaLabel={`al ${date(ledger.to, "short")} · ${ledger.propertyId ? centreNameFor(finance.structure, ledger.propertyId) : finance.entityName}`} polarity="neutral" tone={signTone(ledger.closingBalance)} status={ledger.truncated ? "warning" : undefined} />
        </CocoaKpiStrip>
      ) : null}

      {ready && ledger?.truncated ? (
        <CocoaCallout tone="warning" title={`Detalle limitado a ${number(LEDGER_DETAIL_CAP)} apuntes`} role="status">
          Los totales y el saldo final son los de todo el periodo; la lista muestra los primeros {number(LEDGER_DETAIL_CAP)} apuntes y el último saldo corrido no es el saldo final. Acota las fechas o descarga el CSV para ver el resto.
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title={ledger ? accountDisplay(chart, ledger.accountCode) : undefined}
        meta={ledger ? `${date(ledger.from ?? range.from, "short")} – ${date(ledger.to, "short")}` : undefined}
        padding={ready && movements.length > 0 ? "none" : "md"}
        footer={footer}
        style={{ overflow: "clip" }}
        aria-label="Apuntes del mayor"
      >
        {body}
      </CocoaSection>
    </CocoaPage>
  );
}

export default LedgerScreen;
