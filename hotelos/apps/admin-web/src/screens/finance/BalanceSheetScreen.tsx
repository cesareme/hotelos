// Balance de situación — Finanzas › Estados contables › Balance
// (/finanzas/estados-contables/balance, hosted in EstadosContablesTabs).
// Cocoa 22 · lote 6-C (migrated from the legacy `.bo-*` screen).
//
// Consumes the ledger statement GET /accounting/annual-accounts/balance
// ?from&to[&propertyId][&comparative=1] (PGC Pymes model computed from the
// journal with the single reading rule; replaces the legacy
// /accounting/reports/balance-sheet). Toolbar: preset or free inclusive
// period, propiedad, comparative. CocoaKpiStrip (activo · patrimonio neto ·
// pasivo · cuadre · resultado) → CocoaGrid 6/6 with the two sides of the
// balance as CocoaTable (a row opens the drawer with its PGC accounts) →
// warnings and the unregularised prior result as callouts. «Descargar»
// fetches pdf / xlsx / csv from the API.

import { useEffect, useMemo, useState } from "react";
import type { PgcBalanceSheet, StatementAccountAmount, StatementLine } from "@hotelos/shared";
import { downloadStatement, getBalanceSheet, statementsErrorMessage } from "../../services/financialStatementsApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, money, plural } from "../../lib/format";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import { firstDayOfYear, lastDayOfYear, readQueryParam, saveDownload, signTone } from "../accounting/accounting-ui";
import { FinanceEntityNote, FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { DOWNLOAD_FORMAT_OPTIONS, PERIOD_PRESET_OPTIONS, isDownloadFormat, isMeaningfulLine, presetOf, presetRange, statementColumns, type DateRange, type PeriodPresetKey } from "./statement-ui";

const ACCOUNT_COLUMNS: CocoaTableColumn<StatementAccountAmount>[] = [
  { key: "code", label: "Cuenta", width: "10ch", render: (row) => row.code },
  { key: "name", label: "Nombre", render: (row) => row.name },
  { key: "amount", label: "Importe", align: "right", render: (row) => money(row.amount) }
];

/** One side of the balance: its epigraphs as pseudo-lines (level 0) followed by the model lines. */
function sideRows(groups: Array<{ id: string; label: string; lines: StatementLine[]; total: string }>, showZero: boolean): StatementLine[] {
  const rows: StatementLine[] = [];
  for (const group of groups) {
    rows.push({ id: group.id, label: group.label, level: 0, amount: group.total, accounts: [] });
    for (const line of group.lines) if (showZero || isMeaningfulLine(line)) rows.push(line);
  }
  return rows;
}

function BalanceSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={420} />
    </div>
  );
}

export function BalanceSheetScreen() {
  const header = treeHeaderFor("BalanceSheetScreen", { eyebrow: "Finanzas · Estados contables", title: "Balance de situación" });
  const { showToast } = useToast();
  // Tanda 6b · L7 (design §5.3): the balance is FORCED to the sociedad — there is no balance per centre (R1).
  const finance = useFinanceScope(financeScopePolicy("BalanceSheetScreen"));
  const propertyId = finance.propertyId ?? "";

  const [range, setRange] = useState<DateRange>(() => ({ from: readQueryParam("desde") ?? firstDayOfYear(), to: readQueryParam("hasta") ?? lastDayOfYear() }));
  const [comparative, setComparative] = useState(false);
  const [showZero, setShowZero] = useState(false);
  const preset = presetOf(range);

  const [report, setReport] = useState<PgcBalanceSheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBalanceSheet({ from: range.from, to: range.to, propertyId: propertyId || undefined, comparative })
      .then((view) => {
        if (!cancelled) setReport(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, propertyId, comparative, nonce]);

  const [format, setFormat] = useState("pdf");
  const [downloading, setDownloading] = useState(false);
  async function download() {
    if (!isDownloadFormat(format)) return;
    setDownloading(true);
    try {
      saveDownload(await downloadStatement("balance", { from: range.from, to: range.to, propertyId: propertyId || undefined, comparative }, format));
    } catch (err) {
      showToast(statementsErrorMessage(err, "No se pudo descargar el balance."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const [selected, setSelected] = useState<StatementLine | null>(null);
  const columns = useMemo(() => statementColumns(comparative), [comparative]);
  const k = report;
  const assetRows = useMemo(
    () =>
      k
        ? sideRows(
            [
              { id: "A", label: "A) Activo no corriente", lines: k.assets.nonCurrent, total: k.assets.totalNonCurrent },
              { id: "B", label: "B) Activo corriente", lines: k.assets.current, total: k.assets.totalCurrent }
            ],
            showZero
          )
        : [],
    [k, showZero]
  );
  const equityRows = useMemo(
    () =>
      k
        ? sideRows(
            [
              { id: "PN", label: "A) Patrimonio neto", lines: k.equity.lines, total: k.equity.total },
              { id: "PNC", label: "B) Pasivo no corriente", lines: k.liabilities.nonCurrent, total: k.liabilities.totalNonCurrent },
              { id: "PC", label: "C) Pasivo corriente", lines: k.liabilities.current, total: k.liabilities.totalCurrent }
            ],
            showZero
          )
        : [],
    [k, showZero]
  );
  const difference = k ? Math.round((Number(k.totalAssets) - Number(k.totalEquityAndLiabilities)) * 100) / 100 : 0;
  const priorUnregularised = k ? Number(k.priorUnregularisedResult) : 0;
  const state = loading && !k ? "loading" : error && !k ? "error" : "ready";

  // Header actions: the balanced/unbalanced badge is a direct child of the
  // (wrapping) actions row, never a sibling of the select inside the nowrap
  // cluster. CocoaSelect's wrapper is `width: 100%`, so in a nowrap row it
  // claims the whole line and the badge — the only shrinkable sibling — was
  // squeezed to «CUA…» (qa#3). Format + download stay together as one cluster.
  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle={k ? `Modelo de Pymes a ${date(k.asOf, "long")} · ${k.entity?.legalName ?? finance.scope.label} · generado ${dateTime(k.generatedAt)}` : "Activo, patrimonio neto y pasivo del PGC de Pymes calculados desde el libro diario: Activo = Patrimonio neto + Pasivo."}
      actions={
        <>
          {k ? <CocoaBadge tone={k.balanced ? "success" : "danger"}>{k.balanced ? "Cuadrado" : "Descuadrado"}</CocoaBadge> : null}
          <FinanceScopeSelector scope={finance} />
          <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
            <CocoaSelect value={format} onChange={setFormat} options={[...DOWNLOAD_FORMAT_OPTIONS]} size="small" aria-label="Formato de descarga" />
            <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={downloading} disabled={!k} onClick={() => void download()}>
              {ACTIONS.download}
            </CocoaButton>
          </div>
        </>
      }
      state={state}
      skeleton={<BalanceSkeleton />}
      error={{ title: "No se pudo calcular el balance", message: statementsErrorMessage(error), onRetry: () => setNonce((n) => n + 1) }}
      commands={[
        { id: "balance-download", label: "Descargar el balance de situación", run: () => void download() },
        { id: "balance-refresh", label: "Recalcular el balance de situación", run: () => setNonce((n) => n + 1) }
      ]}
      id="balance-sheet-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Periodo y ámbito"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Periodo">
              <CocoaSelect value={preset} onChange={(value) => setRange((current) => presetRange(value as PeriodPresetKey, current))} options={[...PERIOD_PRESET_OPTIONS]} size="small" aria-label="Periodo predefinido" />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={range.from} onChange={(value) => setRange((current) => ({ ...current, from: value }))} size="small" aria-label="Fecha de inicio" />
            </CocoaField>
            <CocoaField label="Fecha de cierre">
              <CocoaDatePicker value={range.to} onChange={(value) => setRange((current) => ({ ...current, to: value }))} size="small" aria-label="Fecha de cierre del balance (incluida)" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="4">
            <CocoaField label="Comparar con el periodo anterior" inline>
              <CocoaSwitch checked={comparative} onChange={setComparative} size="small" />
            </CocoaField>
            <CocoaField label="Partidas a cero" inline>
              <CocoaSwitch checked={showZero} onChange={setShowZero} size="small" />
            </CocoaField>
          </div>
        }
      />

      <FinanceEntityNote scope={finance} subject="El balance de situación" />
      {k?.format && !k.format.depositable ? (
        <CocoaCallout tone="warning" title="Formato Pymes no depositable para esta sociedad" role="status">
          {k.format.reason} El balance se muestra a título informativo.
        </CocoaCallout>
      ) : null}

      {k ? (
        <>
          <CocoaKpiStrip stagger aria-label="Totales del balance">
            <CocoaKpi label="Total activo" value={money(k.totalAssets)} deltaLabel={`no corriente ${money(k.assets.totalNonCurrent)}`} polarity="neutral" />
            <CocoaKpi label="Patrimonio neto" value={money(k.equity.total)} deltaLabel={`resultado ${money(k.periodResult)}`} polarity="neutral" tone={signTone(k.equity.total)} />
            <CocoaKpi label="Total pasivo" value={money(k.liabilities.total)} deltaLabel={`corriente ${money(k.liabilities.totalCurrent)}`} polarity="neutral" />
            <CocoaKpi label="Cuadre" value={money(difference)} deltaLabel={k.balanced ? "activo = patrimonio neto + pasivo" : "diferencia entre ambos lados"} polarity="neutral" status={k.balanced ? "ok" : "critical"} />
            <CocoaKpi label="Resultado del periodo" value={money(k.periodResult)} deltaLabel={Number(k.periodResult) >= 0 ? "beneficio" : "pérdida"} polarity="neutral" tone={signTone(k.periodResult)} />
          </CocoaKpiStrip>

          {!k.balanced ? (
            <CocoaCallout tone="danger" title="El balance no cuadra" role="alert">
              Activo y patrimonio neto más pasivo difieren en {money(difference)}. Revisa los avisos del cálculo y los asientos del periodo en el diario antes de dar el estado por bueno.
            </CocoaCallout>
          ) : null}

          {priorUnregularised !== 0 ? (
            <CocoaCallout tone="warning" title="Resultado de ejercicios anteriores sin regularizar" role="status">
              Hay {money(k.priorUnregularisedResult)} de ingresos y gastos anteriores al periodo que nunca se regularizaron: se muestran en su propia partida del patrimonio neto. Cierra esos ejercicios en Contabilidad › Cierre de ejercicio.
            </CocoaCallout>
          ) : null}

          {k.warnings.length > 0 ? (
            <CocoaCallout tone="warning" title={plural(k.warnings.length, "aviso del cálculo", "avisos del cálculo")} role="status">
              <ul className="c22-section__list">
                {k.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}

          <CocoaGrid align="start" aria-label="Activo y patrimonio neto más pasivo">
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Activo" meta={money(k.totalAssets)} padding="none" style={{ overflow: "clip" }}>
                <CocoaTable
                  columns={columns}
                  rows={assetRows}
                  rowKey="id"
                  density="compact"
                  rowTone={(line) => (line.level === 0 ? "neutral" : undefined)}
                  onSelect={(line) => setSelected(line)}
                  selectedKey={selected?.id}
                  footer={{ label: "Total activo (A + B)", amount: money(k.totalAssets) }}
                  caption="Partidas del activo"
                  aria-label="Partidas del activo"
                />
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Patrimonio neto y pasivo" meta={money(k.totalEquityAndLiabilities)} padding="none" style={{ overflow: "clip" }}>
                <CocoaTable
                  columns={columns}
                  rows={equityRows}
                  rowKey="id"
                  density="compact"
                  rowTone={(line) => (line.level === 0 ? "neutral" : undefined)}
                  onSelect={(line) => setSelected(line)}
                  selectedKey={selected?.id}
                  footer={{ label: "Total patrimonio neto y pasivo (A + B + C)", amount: money(k.totalEquityAndLiabilities) }}
                  caption="Partidas del patrimonio neto y del pasivo"
                  aria-label="Partidas del patrimonio neto y del pasivo"
                />
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>
        </>
      ) : null}

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.label : "Partida"}
        subtitle={selected ? `${money(selected.amount)}${selected.previousAmount !== undefined ? ` · periodo anterior ${money(selected.previousAmount)}` : ""}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          selected.accounts.length > 0 ? (
            <CocoaTable columns={ACCOUNT_COLUMNS} rows={selected.accounts} rowKey="code" density="compact" footer={{ name: "Suma", amount: money(selected.amount) }} caption="Cuentas de la partida" aria-label="Cuentas de la partida" />
          ) : (
            <div className="cocoa-stack" data-gap="3">
              <CocoaStat label="Importe" value={money(selected.amount)} size="large" />
              <CocoaState kind="empty" inline title={selected.level === 0 ? "Total del epígrafe: abre una partida para ver sus cuentas." : "Ninguna cuenta del plan tiene saldo en esta partida a la fecha de cierre."} />
            </div>
          )
        ) : (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default BalanceSheetScreen;
