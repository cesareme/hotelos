// Pérdidas y ganancias — Finanzas › Estados contables › Pérdidas y ganancias
// (/finanzas/estados-contables/perdidas-y-ganancias, hosted in
// EstadosContablesTabs). Cocoa 22 · lote 6-C, archetype «dashboard».
//
// GET /accounting/annual-accounts/pyg?from&to[&propertyId][&comparative=1]:
// the PGC Pymes account (income positive, expenses negative, subtotals from
// the ledger with the single reading rule of the statements) for an inclusive
// date range chosen with a preset (ejercicio · trimestre · mes) or by hand,
// with the previous period as comparative. CocoaKpiStrip (ingresos · gastos ·
// explotación · financiero · antes de impuestos · resultado) → CocoaTable of
// the model lines (a row opens the drawer with the PGC accounts behind it) →
// warnings of the API as callouts. «Descargar» fetches the same statement as
// pdf / xlsx / csv through the API (no client-side rendering).
//
// Tanda 6b · L7 (design §5.3): the header carries the ONE «Ámbito» (sociedad by
// default, a centre as filter → `propertyId`) and a «Sociedad · Por centro»
// view: the matrix account × centre of GET /accounting/pnl/by-property with the
// columns «Oficina central» (office centres), «Sin asignar» (entries without a
// work centre) and «Total sociedad», plus the informative allocation row
// (`allocation`, never posted) behind a CocoaSwitch.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PgcProfitAndLoss, PnlByProperty, PnlByPropertyRow, StatementAccountAmount, StatementLine } from "@hotelos/shared";
import { apiRequest } from "../../services/api-client";
import { compactQuery } from "../../services/finance-contracts";
import { downloadStatement, getProfitAndLoss, statementsErrorMessage } from "../../services/financialStatementsApi";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { ALLOCATION_ROW_LABEL, ENTITY_TOTAL_FOOTNOTE, ENTITY_TOTAL_LABEL, PROPERTY_KIND_LABELS, UNASSIGNED_COLUMN_LABEL, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
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
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import { firstDayOfYear, lastDayOfYear, readQueryParam, saveDownload, signTone } from "../accounting/accounting-ui";
import { DOWNLOAD_FORMAT_OPTIONS, PERIOD_PRESET_OPTIONS, isDownloadFormat, isMeaningfulLine, presetOf, presetRange, statementColumns, type DateRange, type PeriodPresetKey } from "./statement-ui";

const ACCOUNT_COLUMNS: CocoaTableColumn<StatementAccountAmount>[] = [
  { key: "code", label: "Cuenta", width: "10ch", render: (row) => row.code },
  { key: "name", label: "Nombre", render: (row) => row.name },
  { key: "amount", label: "Importe", align: "right", render: (row) => money(row.amount) }
];

type PnlView = "sociedad" | "centros";

const VIEW_OPTIONS: Array<{ value: PnlView; label: string }> = [
  { value: "sociedad", label: "Sociedad" },
  { value: "centros", label: "Por centro" }
];

/** Columns of the matrix account × centre: label, one per centre, «Sin asignar», «Total sociedad» (declared outside the component: §4.2 A5 via useMemo on the centres). */
function pnlByCentreColumns(view: PnlByProperty): CocoaTableColumn<PnlByPropertyRow>[] {
  const columns: CocoaTableColumn<PnlByPropertyRow>[] = [
    { key: "label", label: "Cuenta", minWidth: 220, render: (row) => `${row.accountCode} · ${row.label}` }
  ];
  for (const centre of view.properties) {
    columns.push({
      key: centre.propertyId,
      label: centre.kind === "office" ? `Oficina central${centre.code ? ` (${centre.code})` : ""}` : `${centre.code ?? centre.name}${centre.kind !== "hotel" ? ` · ${PROPERTY_KIND_LABELS[centre.kind]}` : ""}`,
      align: "right",
      fit: true,
      hideOnNarrow: true,
      render: (row) => money(row.byProperty[centre.propertyId] ?? "0.00")
    });
  }
  columns.push({ key: "unassigned", label: UNASSIGNED_COLUMN_LABEL, align: "right", fit: true, hideOnNarrow: true, render: (row) => money(row.unassigned) });
  columns.push({ key: "total", label: ENTITY_TOTAL_LABEL, align: "right", fit: true, render: (row) => <strong>{money(row.total)}</strong> });
  return columns;
}

/** GET /accounting/pnl/by-property?from&to[&allocation=none] — `allocation` omitted applies the stored key (informative). */
function getPnlByProperty(input: { from: string; to: string; applyAllocation: boolean }): Promise<PnlByProperty> {
  return apiRequest<PnlByProperty>("/accounting/pnl/by-property", { query: compactQuery({ from: input.from, to: input.to, allocation: input.applyAllocation ? undefined : "none" }) });
}

function ProfitAndLossSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[12]]} height={420} />
    </div>
  );
}

export function ProfitAndLossScreen() {
  const header = treeHeaderFor("ProfitAndLossScreen", { eyebrow: "Finanzas · Estados contables", title: "Pérdidas y ganancias" });
  const { showToast } = useToast();
  // Tanda 6b · L7: the «Ámbito» of the header (sociedad by default, a centre as filter) is the `propertyId` of the statement.
  const finance = useFinanceScope(financeScopePolicy("ProfitAndLossScreen"));
  const propertyId = finance.propertyId ?? "";
  const multiCentre = Boolean(finance.structure && finance.structure.mode !== "single_hotel");

  const [range, setRange] = useState<DateRange>(() => ({ from: readQueryParam("desde") ?? firstDayOfYear(), to: readQueryParam("hasta") ?? lastDayOfYear() }));
  const [comparative, setComparative] = useState(false);
  const [showZero, setShowZero] = useState(false);
  const [view, setView] = useState<PnlView>("sociedad");
  const [applyAllocation, setApplyAllocation] = useState(false);
  const preset = presetOf(range);
  const byCentre = view === "centros" && multiCentre;

  // «Por centro»: the matrix of GET /accounting/pnl/by-property for the same window (whole sociedad by definition).
  const [matrix, setMatrix] = useState<PnlByProperty | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<unknown>(null);
  const [matrixNonce, setMatrixNonce] = useState(0);
  useEffect(() => {
    if (!byCentre) return undefined;
    let cancelled = false;
    setMatrixLoading(true);
    setMatrixError(null);
    getPnlByProperty({ from: range.from, to: range.to, applyAllocation })
      .then((value) => {
        if (!cancelled) setMatrix(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMatrixError(err);
      })
      .finally(() => {
        if (!cancelled) setMatrixLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [byCentre, range.from, range.to, applyAllocation, matrixNonce]);
  const matrixColumns = useMemo(() => (matrix ? pnlByCentreColumns(matrix) : []), [matrix]);
  const matrixRows = useMemo(() => (matrix ? matrix.rows.filter((row) => showZero || Number(row.total) !== 0 || Number(row.unassigned) !== 0) : []), [matrix, showZero]);

  const [report, setReport] = useState<PgcProfitAndLoss | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProfitAndLoss({ from: range.from, to: range.to, propertyId: propertyId || undefined, comparative })
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
      saveDownload(await downloadStatement("pyg", { from: range.from, to: range.to, propertyId: propertyId || undefined, comparative }, format));
    } catch (err) {
      showToast(statementsErrorMessage(err, "No se pudo descargar la cuenta de pérdidas y ganancias."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const [selected, setSelected] = useState<StatementLine | null>(null);
  const columns = useMemo(() => statementColumns(comparative), [comparative]);
  const lines = useMemo(() => (report ? report.lines.filter((line) => showZero || isMeaningfulLine(line)) : []), [report, showZero]);
  const hiddenLines = report ? report.lines.length - lines.length : 0;

  const k = report;
  const state = loading && !k ? "loading" : error && !k ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle={k ? `Modelo de Pymes desde el libro diario · ${finance.scope.label} · generado ${dateTime(k.generatedAt)}` : "Cuenta de pérdidas y ganancias del PGC de Pymes calculada desde el libro diario."}
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          {multiCentre ? <CocoaSegmentedControl value={view} onChange={(value) => setView(value === "centros" ? "centros" : "sociedad")} options={VIEW_OPTIONS} size="small" aria-label="Vista de la cuenta de resultados" /> : null}
          <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
            <CocoaSelect value={format} onChange={setFormat} options={[...DOWNLOAD_FORMAT_OPTIONS]} size="small" aria-label="Formato de descarga" />
            <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={downloading} disabled={!k} onClick={() => void download()}>
              {ACTIONS.download}
            </CocoaButton>
          </div>
        </>
      }
      state={state}
      skeleton={<ProfitAndLossSkeleton />}
      error={{ title: "No se pudo calcular la cuenta de pérdidas y ganancias", message: statementsErrorMessage(error), onRetry: () => setNonce((n) => n + 1) }}
      commands={[
        { id: "pyg-download", label: "Descargar pérdidas y ganancias", run: () => void download() },
        { id: "pyg-refresh", label: "Recalcular pérdidas y ganancias", run: () => setNonce((n) => n + 1) }
      ]}
      id="profit-and-loss-screen"
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
            <CocoaField label="Hasta">
              <CocoaDatePicker value={range.to} onChange={(value) => setRange((current) => ({ ...current, to: value }))} size="small" aria-label="Fecha de fin (incluida)" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="4">
            {byCentre ? (
              <CocoaField label="Aplicar reparto de oficina central (informativo)" inline>
                <CocoaSwitch checked={applyAllocation} onChange={setApplyAllocation} size="small" />
              </CocoaField>
            ) : (
              <CocoaField label="Comparar con el periodo anterior" inline>
                <CocoaSwitch checked={comparative} onChange={setComparative} size="small" />
              </CocoaField>
            )}
            <CocoaField label="Partidas a cero" inline>
              <CocoaSwitch checked={showZero} onChange={setShowZero} size="small" />
            </CocoaField>
          </div>
        }
      />

      {byCentre ? (
        <PnlByCentreView matrix={matrix} loading={matrixLoading} error={matrixError} columns={matrixColumns} rows={matrixRows} hidden={matrix ? matrix.rows.length - matrixRows.length : 0} onRetry={() => setMatrixNonce((n) => n + 1)} />
      ) : null}

      {k && !byCentre ? (
        <>
          <CocoaKpiStrip stagger aria-label="Resultados del periodo">
            <CocoaKpi label="Ingresos" value={money(k.revenueTotal)} deltaLabel="grupo 7" polarity="neutral" />
            <CocoaKpi label="Gastos" value={money(k.expenseTotal)} deltaLabel="grupo 6" polarity="neutral" />
            <CocoaKpi label="Resultado de explotación" value={money(k.operatingResult)} polarity="neutral" tone={signTone(k.operatingResult)} status={signTone(k.operatingResult) === "danger" ? "warning" : "ok"} />
            <CocoaKpi label="Resultado financiero" value={money(k.financialResult)} polarity="neutral" tone={signTone(k.financialResult)} />
            <CocoaKpi label="Antes de impuestos" value={money(k.resultBeforeTax)} deltaLabel={`impuesto ${money(k.incomeTax)}`} polarity="neutral" tone={signTone(k.resultBeforeTax)} />
            <CocoaKpi label="Resultado del ejercicio" value={money(k.netResult)} deltaLabel={Number(k.netResult) >= 0 ? "beneficio" : "pérdida"} polarity="neutral" tone={signTone(k.netResult)} status={Number(k.netResult) < 0 ? "critical" : "ok"} />
          </CocoaKpiStrip>

          {k.warnings.length > 0 ? (
            <CocoaCallout tone="warning" title={plural(k.warnings.length, "aviso del cálculo", "avisos del cálculo")} role="status">
              <ul className="c22-section__list">
                {k.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}

          <CocoaSection
            title="Cuenta de pérdidas y ganancias"
            meta={`${date(k.period.from, "short")} – ${date(k.period.to, "short")}${comparative ? " · con periodo anterior" : ""}`}
            padding={lines.length > 0 ? "none" : "md"}
            footer={hiddenLines > 0 ? <span>{plural(hiddenLines, "partida a cero oculta", "partidas a cero ocultas")}</span> : undefined}
            style={{ overflow: "clip" }}
          >
            {lines.length > 0 ? (
              <CocoaTable
                columns={columns}
                rows={lines}
                rowKey="id"
                density="compact"
                rowTone={(line) => (line.level === 0 ? "neutral" : undefined)}
                onSelect={(line) => setSelected(line)}
                selectedKey={selected?.id}
                rowTitle={(line) => (line.accounts.length > 0 ? plural(line.accounts.length, "cuenta detrás de la partida", "cuentas detrás de la partida") : "Sin cuentas con saldo en esta partida")}
                footer={{ label: "Resultado del ejercicio", amount: money(k.netResult) }}
                caption="Partidas de la cuenta de pérdidas y ganancias"
                aria-label="Partidas de la cuenta de pérdidas y ganancias"
              />
            ) : (
              <CocoaState kind="empty" inline title="Sin movimientos de ingresos ni gastos en el periodo." />
            )}
          </CocoaSection>
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
              <CocoaState kind="empty" inline title="Ninguna cuenta del plan tiene saldo en esta partida durante el periodo." />
            </div>
          )
        ) : (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}

type PnlByCentreViewProps = {
  matrix: PnlByProperty | null;
  loading: boolean;
  error: unknown;
  columns: CocoaTableColumn<PnlByPropertyRow>[];
  rows: PnlByPropertyRow[];
  hidden: number;
  onRetry: () => void;
};

/** «Por centro»: KPIs per column, the account × centre matrix with totals, the informative allocation and the reconciliation. */
function PnlByCentreView({ matrix, loading, error, columns, rows, hidden, onRetry }: PnlByCentreViewProps) {
  if (!matrix && loading) return <ProfitAndLossSkeleton />;
  if (!matrix) return <CocoaState kind="error" title="No se pudo calcular la cuenta de resultados por centro" message={statementsErrorMessage(error)} onRetry={onRetry} />;
  const office = matrix.properties.filter((centre) => centre.kind !== "hotel");
  const footer: Record<string, ReactNode> = { label: <strong>Resultado</strong>, unassigned: <strong>{money(matrix.netResult.unassigned)}</strong>, total: <strong>{money(matrix.netResult.total)}</strong> };
  for (const centre of matrix.properties) footer[centre.propertyId] = <strong>{money(matrix.netResult.byProperty[centre.propertyId] ?? "0.00")}</strong>;
  const allocation = matrix.allocation;

  return (
    <>
      {error ? (
        <CocoaCallout tone="danger" title="No se pudo actualizar la vista por centro" role="alert">
          {statementsErrorMessage(error)} Se muestran los últimos datos cargados.
        </CocoaCallout>
      ) : null}
      <CocoaKpiStrip stagger aria-label="Resultado por centro">
        {matrix.properties.map((centre) => (
          <CocoaKpi key={centre.propertyId} label={centre.kind === "office" ? "Oficina central" : centre.code ?? centre.name} caption={centre.kind === "office" ? centre.name : PROPERTY_KIND_LABELS[centre.kind]} value={money(matrix.netResult.byProperty[centre.propertyId] ?? "0.00")} polarity="neutral" tone={signTone(matrix.netResult.byProperty[centre.propertyId] ?? "0.00")} />
        ))}
        <CocoaKpi label={UNASSIGNED_COLUMN_LABEL} caption="asientos de sociedad sin centro" value={money(matrix.netResult.unassigned)} polarity="neutral" tone={signTone(matrix.netResult.unassigned)} />
        <CocoaKpi label={ENTITY_TOTAL_LABEL} caption={matrix.entity.legalName} value={money(matrix.netResult.total)} polarity="neutral" tone={signTone(matrix.netResult.total)} status={matrix.reconciliation.ok ? "ok" : "critical"} />
      </CocoaKpiStrip>

      {!matrix.reconciliation.ok ? (
        <CocoaCallout tone="danger" title="La suma de centros no cuadra con el total de la sociedad" role="alert">
          Filas afectadas: {matrix.reconciliation.rowsOff.join(", ")}. Revisa los asientos del periodo antes de dar la vista por buena.
        </CocoaCallout>
      ) : null}
      {matrix.warnings.length > 0 ? (
        <CocoaCallout tone="warning" title={plural(matrix.warnings.length, "aviso del cálculo", "avisos del cálculo")} role="status">
          <ul className="c22-section__list">
            {matrix.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}

      <CocoaSection
        title="Cuenta de resultados por centro"
        meta={`${date(matrix.period.from, "short")} – ${date(matrix.period.to, "short")}${office.length > 0 ? ` · ${plural(office.length, "centro no alojativo", "centros no alojativos")}` : ""}`}
        footer={
          <span>
            {ENTITY_TOTAL_FOOTNOTE}
            {hidden > 0 ? ` ${plural(hidden, "cuenta a cero oculta", "cuentas a cero ocultas")}.` : ""}
          </span>
        }
      >
        {rows.length > 0 ? (
          <CocoaTable columns={columns} rows={rows} rowKey="accountCode" density="compact" stickyFirstColumn footer={footer} caption="Cuenta de resultados por centro de trabajo" aria-label="Cuenta de resultados por centro de trabajo" />
        ) : (
          <CocoaState kind="empty" inline title="Sin movimientos de ingresos ni gastos en el periodo." />
        )}
      </CocoaSection>

      <CocoaSection title={ALLOCATION_ROW_LABEL} meta={allocation ? allocation.basisLabel : undefined}>
        {!allocation || allocation.method === "none" ? (
          <CocoaState kind="empty" inline title="Sin reparto: la clave de reparto de la oficina central es «ninguno» o no se ha aplicado. Se configura en Configuración › Estructura societaria › Reparto." />
        ) : (
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row" data-gap="4" data-align="start">
              <CocoaStat label="Coste corporativo repartido" value={money(allocation.corporateCost)} hint={allocation.applied ? `${allocation.basisLabel} · repartido ${money(allocation.allocated)}` : "no se ha repartido nada"} />
              <CocoaStat label="Contabilizado" value={<CocoaBadge tone="info">No: solo informativo</CocoaBadge>} tabular={false} />
            </div>
            <ul className="c22-section__list" aria-label="Reparto por hotel">
              {allocation.shares.map((share) => {
                const centre = matrix.properties.find((row) => row.propertyId === share.propertyId);
                return (
                  <li key={share.propertyId}>
                    <span>{centre ? (centre.code ? `${centre.name} (${centre.code})` : centre.name) : share.propertyId}</span>
                    <span>
                      {money(share.amount)} · resultado tras reparto {money(allocation.netResultAfterAllocation[share.propertyId] ?? "0.00")}
                    </span>
                  </li>
                );
              })}
            </ul>
            {allocation.warnings.length > 0 ? (
              <ul className="c22-section__list">
                {allocation.warnings.map((warning) => (
                  <li key={warning}>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CocoaSection>
    </>
  );
}

export default ProfitAndLossScreen;
