// Costes de personal — Hoy › Mi día › Costes de personal (/hoy/costes-personal;
// Tanda RRHH · PANEL-B; diseño docs/design/PANEL-COSTES-DIRECCION.md §8 y §8.1
// recortados al bloque laboral por RRHH/recon-delta.md §3.8).
//
// Cocoa 22, pestaña alojada en MiDiaTabs: el «Ámbito» de Finanzas (sociedad o
// centro, política entity_default), mes + ventana Mes / Acumulado del año,
// CocoaKpiStrip de 4 (coste de personal con Δ frente al periodo anterior, % s/
// ventas con la fuente de las ventas, coste por empleado, CPOR laboral degradado
// sin habitaciones ocupadas reales), CocoaChart.Bars por departamento con «Sin
// desglose» como serie propia y CocoaCallout que lo explica (ene-jul del
// diario Sage sin centro de coste), CocoaTable centro × departamento con pie
// de totales, ranking de centros por % s/ ventas (solo sociedad) o los meses
// del centro, DegradedBanner con `degraded[]` y las fuentes al pie. Un mes sin
// coste llega como "0.00" con `source: null`: aquí es «—», nunca un 0. Sin
// estilos en línea; datos por services/laborCostPanelApi.ts (GET
// /payroll/labor-cost-panel, payroll.read); lógica pura en labor-costs-helpers.ts.

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { todayIso } from "../accounting/accounting-ui";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { plural } from "../../lib/format";
import { LABOR_COST_PANEL_PATH, laborCostPanelQuery, type LaborCostPanelDto } from "../../services/laborCostPanelApi";
import {
  LABOR_PANEL_DEGRADED_CODES,
  LABOR_WINDOW_OPTIONS,
  NO_BREAKDOWN,
  NO_BREAKDOWN_LABEL_ES,
  SALES_SOURCE_LABELS_ES,
  allMonths,
  centreFooter,
  centreRows,
  costPerEmployeeCaption,
  cporCaption,
  degradedCodes,
  degradedLabels,
  degradedMessages,
  deltaOf,
  departmentBars,
  departmentLabel,
  formatMoney,
  formatPct,
  hasLaborCost,
  laborCostCaption,
  laborWindow,
  monthCodeOf,
  monthOptions,
  monthRows,
  noBreakdownNote,
  overlapMonths,
  monthsLabel,
  parseWindowMode,
  presentDepartments,
  previousMonth,
  rankingRows,
  roomNightsCoverage,
  roomNightsSourceFor,
  roomNightsSourceOverall,
  salesCaption,
  sourcesSummary,
  windowLabel,
  type CentreRow,
  type LaborWindowMode,
  type MonthRow,
  type RankingRow
} from "./labor-costs-helpers";
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
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  DegradedBanner,
  isDegraded,
  type CocoaTableColumn
} from "../../components/cocoa";

// Etiquetas del árbol (Hoy › Mi día › Costes de personal), nunca retecleadas.
const HEADER = treeHeaderFor("DirectorLaborCostsScreen", { eyebrow: "Hoy · Mi día", title: "Costes de personal" });

const SUBTITLE = "Coste de personal del centro o de toda la sociedad frente a las ventas, por departamento y por centro, con la fuente de cada cifra: diario contable, lote de nómina contabilizado y habitaciones ocupadas reales.";

const EMPTY_TITLE = "Sin coste de personal en la ventana.";
const EMPTY_MESSAGE = "Ni el diario contable (cuentas 640/642) ni un lote de nómina contabilizado tienen importes para estos meses en el ámbito elegido. Importa el informe de nómina en Finanzas › RRHH y nóminas › Coste de personal o elige otro mes.";

/** Esqueleto espejo: tira de 4 KPI y rejilla 6/6. */
function LaborCostsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={220} />
    </div>
  );
}

export function DirectorLaborCostsScreen() {
  const finance = useFinanceScope(financeScopePolicy("DirectorLaborCostsScreen"));

  const today = todayIso();
  const [period, setPeriod] = useState<string>(monthCodeOf(today));
  const [mode, setMode] = useState<LaborWindowMode>("month");
  const periodOptions = useMemo(() => monthOptions(monthCodeOf(today), 24), [today]);

  // Ventana de la consulta: el mes, o de enero al mes (acumulado del año); sociedad sin propertyId, centro con él.
  const window = useMemo(() => laborWindow(period, mode), [period, mode]);
  const query = useMemo(() => laborCostPanelQuery({ from: window.from, to: window.to, propertyId: finance.propertyId ?? null }), [window, finance.propertyId]);
  const panelState = useApiData<LaborCostPanelDto>(finance.loading ? null : LABOR_COST_PANEL_PATH, { query });
  const panel = panelState.data;

  const months = useMemo(() => allMonths(panel), [panel]);
  const hasCost = useMemo(() => hasLaborCost(months), [months]);
  const codes = useMemo(() => degradedCodes(panel?.degraded), [panel]);
  const labels = useMemo(() => degradedLabels(panel?.degraded), [panel]);
  const messages = useMemo(() => degradedMessages(panel?.degraded), [panel]);
  const breakdownNote = useMemo(() => noBreakdownNote(months), [months]);
  const overlaps = useMemo(() => overlapMonths(months), [months]);
  const bars = useMemo(() => departmentBars(panel?.totals.byDepartment ?? []), [panel]);
  const departments = useMemo(() => presentDepartments(panel), [panel]);
  const rows = useMemo<CentreRow[]>(() => centreRows(panel), [panel]);
  const footer = useMemo(() => centreFooter(panel?.totals, hasCost), [panel, hasCost]);
  const ranking = useMemo<RankingRow[]>(() => rankingRows(panel?.ranking), [panel]);
  const centreMonths = useMemo<MonthRow[]>(() => (panel?.scope === "property" ? monthRows(panel.centres[0]?.months) : []), [panel]);
  const rnSource = useMemo(() => (panel?.scope === "property" ? roomNightsSourceFor(panel.sources, panel.centres[0]?.propertyId) : roomNightsSourceOverall(panel?.sources)), [panel]);
  const sourceLines = useMemo(() => sourcesSummary(panel?.sources), [panel]);

  const entityScope = panel?.scope === "entity";
  const scopeName = finance.propertyId === undefined ? finance.entityName : finance.centre?.name ?? finance.active.propertyName;

  const centreColumns = useMemo<CocoaTableColumn<CentreRow>[]>(
    () => [
      {
        key: "centre",
        label: "Centro",
        render: (row) => (
          <span className="cocoa-cluster" data-gap="2">
            <strong>{row.centre}</strong>
            {row.noBreakdown ? (
              <CocoaBadge tone="warning" variant="tinted" size="small" uppercase={false}>
                {NO_BREAKDOWN_LABEL_ES}
              </CocoaBadge>
            ) : null}
          </span>
        )
      },
      ...departments.map<CocoaTableColumn<CentreRow>>((department) => ({
        key: department,
        label: departmentLabel(department, true),
        align: "right",
        hideOnNarrow: department === "rooms" || department === "fnb" || department === NO_BREAKDOWN,
        showFrom: department === "rooms" || department === "fnb" || department === NO_BREAKDOWN ? undefined : "laptop",
        render: (row) => row.cells[department] ?? "—"
      })),
      { key: "total", label: "Total", align: "right", render: (row) => <strong>{row.total}</strong> },
      { key: "pctOfSales", label: "% s/ ventas", align: "right", hideOnNarrow: true, render: (row) => (row.pctOfSales === null ? "—" : `${row.pctOfSales}${row.salesSource === "reference" ? " (ref.)" : ""}`) },
      { key: "sources", label: "Fuente", showFrom: "desktop", render: (row) => row.sources }
    ],
    [departments]
  );

  const rankingColumns: CocoaTableColumn<RankingRow>[] = [
    { key: "position", label: "Nº", fit: true, render: (row) => row.position },
    { key: "centre", label: "Centro", render: (row) => <strong>{row.centre}</strong> },
    { key: "pctOfSales", label: "% s/ ventas", align: "right", render: (row) => row.pctOfSales },
    { key: "laborCost", label: "Coste", align: "right", hideOnNarrow: true, render: (row) => row.laborCost }
  ];

  const monthColumns: CocoaTableColumn<MonthRow>[] = [
    {
      key: "month",
      label: "Mes",
      render: (row) => (
        <span className="cocoa-cluster" data-gap="2">
          <strong>{row.month}</strong>
          {row.overlap ? (
            <CocoaBadge tone="info" variant="tinted" size="small" uppercase={false}>
              diario y lote
            </CocoaBadge>
          ) : null}
        </span>
      )
    },
    { key: "laborCost", label: "Coste", align: "right", render: (row) => row.laborCost },
    { key: "pctOfSales", label: "% s/ ventas", align: "right", render: (row) => `${row.pctOfSales}${row.salesSource === "reference" ? " (ref.)" : ""}` },
    { key: "cpor", label: "CPOR laboral", align: "right", hideOnNarrow: true, render: (row) => row.cpor },
    { key: "headcount", label: "Plantilla", align: "right", hideOnNarrow: true, render: (row) => row.headcount },
    { key: "source", label: "Fuente", hideOnNarrow: true, render: (row) => (row.noBreakdown ? `${row.source} · ${NO_BREAKDOWN_LABEL_ES.toLowerCase()}` : row.source) }
  ];

  function refresh() {
    panelState.refresh();
  }

  function goPreviousPeriod() {
    setPeriod((current) => previousMonth(current));
  }

  const loading = (panelState.loading || finance.loading) && !panel;
  const error = panelState.error;
  const state = loading ? "loading" : error && !panel ? "error" : panel && !hasCost && panel.centres.length === 0 ? "empty" : "ready";

  const costDegraded = !panel || !hasCost;
  // Δ frente a la ventana anterior de la misma longitud: solo con coste real en ambas (si no, ni cifra ni etiqueta).
  const delta = panel && hasCost ? deltaOf(panel.totals.deltaPrevious) : undefined;
  const pctDegraded = !panel || !hasCost || panel.totals.pctOfSales === null;
  const employeeDegraded = !panel || !hasCost || panel.totals.costPerEmployee === null;
  // CPOR laboral: «—» sin habitaciones ocupadas reales; con RN en solo parte de los centros o meses incompletos, cifra en aviso y el pie lo dice.
  const cporDegraded = !panel || !hasCost || panel.totals.laborCostPerOccupiedRoom === null;
  const cporStatus = cporDegraded || isDegraded([LABOR_PANEL_DEGRADED_CODES.rnMissing, LABOR_PANEL_DEGRADED_CODES.rnPartial], codes) ? "warning" : "ok";

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Hoy")}
      title={HEADER.title}
      subtitle={SUBTITLE}
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          <CocoaSelect size="small" inline aria-label="Mes" value={period} onChange={setPeriod} options={periodOptions} />
          <CocoaSegmentedControl size="small" aria-label="Ventana" value={mode} onChange={(value) => setMode(parseWindowMode(value))} options={[...LABOR_WINDOW_OPTIONS]} />
          {panelState.isValidating && panel ? (
            <CocoaBadge tone="info" size="small" aria-live="polite">
              {STATUS_LABELS.loading}
            </CocoaBadge>
          ) : null}
          <DegradedBanner degraded={labels} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<LaborCostsSkeleton />}
      empty={{ title: EMPTY_TITLE, message: EMPTY_MESSAGE, primaryAction: { label: ACTIONS.refresh, onClick: refresh } }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "costes-actualizar", label: "Actualizar los costes de personal", run: refresh },
        { id: "costes-periodo-anterior", label: "Costes de personal: mes anterior", run: goPreviousPeriod },
        { id: "costes-ventana-anual", label: "Costes de personal: acumulado del año", run: () => setMode("ytd") }
      ]}
    >
      {error && panel ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.loadError}>
          {error}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de coste de personal">
        <CocoaKpi
          label="Coste de personal"
          value={panel ? formatMoney(panel.totals.laborCost, hasCost) : "—"}
          caption={panel ? laborCostCaption(months, window) : undefined}
          delta={delta}
          deltaUnit="%"
          deltaLabel={delta === undefined ? undefined : "vs periodo anterior"}
          polarity="negative-good"
          degraded={costDegraded}
          status="ok"
        />
        <CocoaKpi label="% sobre ventas" value={panel && hasCost ? formatPct(panel.totals.pctOfSales) : "—"} caption={panel ? salesCaption(panel.totals.sales, months) : undefined} degraded={pctDegraded} status="ok" />
        <CocoaKpi label="Coste por empleado" value={panel && hasCost ? formatMoney(panel.totals.costPerEmployee) : "—"} caption={panel ? costPerEmployeeCaption(panel.totals.headcount) : undefined} degraded={employeeDegraded} status="ok" />
        <CocoaKpi label="CPOR laboral" value={panel && hasCost ? formatMoney(panel.totals.laborCostPerOccupiedRoom) : "—"} unit="por habitación ocupada" caption={panel ? cporCaption(panel.totals.roomNights, rnSource, entityScope ? roomNightsCoverage(panel.sources) : null) : undefined} degraded={cporDegraded} status={cporStatus} />
      </CocoaKpiStrip>

      {breakdownNote ? (
        <CocoaCallout tone="warning" title={`${NO_BREAKDOWN_LABEL_ES} por departamento`}>
          {breakdownNote}
        </CocoaCallout>
      ) : null}
      {overlaps.length > 0 ? (
        <CocoaCallout tone="info" title="Diario y lote en el mismo mes">
          {monthsLabel(overlaps)}: el diario contable y un lote de nómina contabilizado coinciden; prevalece el diario y el lote solo aporta la plantilla y las ventas de referencia (nunca se suman las dos fuentes).
        </CocoaCallout>
      ) : null}
      {labels.length > 0 ? (
        <CocoaCallout tone="warning" title={`Datos incompletos (${plural(labels.length, "aviso", "avisos", { withCount: true })})`}>
          <ul className="cocoa-stack" data-gap="1">
            {labels.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </CocoaCallout>
      ) : null}

      <CocoaGrid aria-label="Departamentos y centros" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Coste por departamento" meta={`${scopeName} · ${windowLabel(window)}`}>
            {bars.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin coste de personal con fuente en la ventana." />
            ) : (
              <CocoaChart.Bars data={bars} height={180} valueFormat={(value) => formatMoney(value)} aria-label="Coste de personal por departamento USALI de la ventana" />
            )}
            <p className="cocoa-note">Cada barra es el coste laboral del departamento USALI; «{NO_BREAKDOWN_LABEL_ES}» agrupa el coste del diario sin centro de coste. El porcentaje de la ayuda es sobre el ingreso del departamento (habitaciones, A&B, otros operativos) o sobre las ventas del centro.</p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          {entityScope ? (
            <CocoaSection title="Centros por % s/ ventas" meta={plural(ranking.length, "centro", "centros", { withCount: true })} padding={ranking.length > 0 ? "none" : "md"}>
              {ranking.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin centros con coste en la ventana." />
              ) : (
                <CocoaTable columns={rankingColumns} rows={ranking} rowKey="key" caption="Centros de la sociedad ordenados por coste de personal sobre ventas" aria-label="Centros de la sociedad ordenados por coste de personal sobre ventas" density="compact" rowTone={(row) => (row.hasSales ? undefined : "warning")} />
              )}
            </CocoaSection>
          ) : (
            <CocoaSection title="Meses del centro" meta={windowLabel(window)} padding={centreMonths.length > 0 ? "none" : "md"}>
              {centreMonths.length === 0 ? (
                <CocoaState kind="empty" inline title="Sin meses con datos en la ventana." />
              ) : (
                <CocoaTable columns={monthColumns} rows={centreMonths} rowKey="key" caption="Coste de personal del centro por mes" aria-label="Coste de personal del centro por mes" density="compact" rowTone={(row) => (row.hasCost ? undefined : "warning")} />
              )}
            </CocoaSection>
          )}
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Centro × departamento" meta={`${windowLabel(window)} · ${plural(rows.length, "centro", "centros", { withCount: true })}`} padding={rows.length > 0 ? "none" : "md"}>
        {rows.length === 0 ? (
          <CocoaState kind="empty" inline title={EMPTY_TITLE} message={EMPTY_MESSAGE} />
        ) : (
          <CocoaTable columns={centreColumns} rows={rows} rowKey="key" caption="Coste de personal por centro y departamento USALI" aria-label="Coste de personal por centro y departamento USALI" density="compact" stickyFirstColumn footer={footer} rowTone={(row) => (row.hasCost ? undefined : "warning")} />
        )}
      </CocoaSection>

      {panel ? (
        <CocoaSection title="Fuentes" meta={`ventas: ${SALES_SOURCE_LABELS_ES.ledger} salvo «(ref.)»`}>
          <div className="cocoa-stack" data-gap="1">
            {sourceLines.map((line) => (
              <p key={line} className="cocoa-note">
                {line}
              </p>
            ))}
            {messages.length > 0 ? (
              <details>
                <summary className="cocoa-note">{plural(messages.length, "aviso del cálculo", "avisos del cálculo", { withCount: true })}</summary>
                <ul className="cocoa-stack" data-gap="1">
                  {messages.map((message) => (
                    <li key={message} className="cocoa-note">
                      {message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </CocoaSection>
      ) : null}
    </CocoaPage>
  );
}

export default DirectorLaborCostsScreen;
