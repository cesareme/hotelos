// Panel RRHH — Finanzas › RRHH y nóminas › Panel (/finanzas/nominas/panel;
// Tanda RRHH · RRHH-9; diseño docs/design/RRHH-PLANTILLA-NOMINA.md §10 «Panel:
// la foto», recortado por RRHH/recon-delta.md §3.10).
//
// Cocoa 22, pestaña alojada en NominasTabs (RRHH-11): CocoaKpiStrip (plantilla
// activa · FTE disponible vs máximo aprobado · FTE necesario · coste del mes y
// % s/ ventas · alertas · vencimientos) con `degraded` por KPI a partir de
// `degraded[]` de GET /hr/kpis; CocoaChart.Bars necesidad vs planificado de los
// próximos 14 días (por departamento con CocoaSelect); tabla de alertas
// (GET /hr/alerts) y «Vencimientos 30 días» (alertas de contrato; el nombre se
// resuelve por el listado sin PII solo con hr.employee.read). El «Ámbito»
// (FinanceScopeSelector, política entity_default) decide sociedad o centro en
// los KPIs; alertas y previsión son siempre de un centro (el del ámbito o el
// activo). Sin estilos en línea; datos por services/hrForecastApi.ts; lógica
// pura en hr-forecast-helpers.ts.

import { useMemo, useState } from "react";
import type { EmployeeSummaryDto } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { date, money, number, plural } from "../../lib/format";
import { toArray } from "../../utils/toArray";
import { hrKpisQuery, laborForecastPath, laborForecastQuery, type HrAlertDto, type HrAlertsResponse, type HrKpisDto, type LaborForecastDayDto, type LaborForecastListResponse } from "../../services/hrForecastApi";
import {
  DEFAULT_FORECAST_RANGE_DAYS,
  FORECAST_DEPARTMENT_ALL,
  FORECAST_SERIES_LABELS_ES,
  FORECAST_SERIES_TONES,
  HR_ALERT_SEVERITY_LABELS_ES,
  HR_KPI_DEGRADED_CODES,
  alertKindLabel,
  alertTone,
  contractExpiringAlerts,
  costPerEmployeeCaption,
  dayBars,
  degradedCodes,
  departmentLabel,
  employeeNameFor,
  filterForecastDepartment,
  forecastDepartmentOptions,
  forecastWindow,
  formatFte,
  formatFteUnit,
  fteKpiStatus,
  fteVsMaxCaption,
  groupForecastByDay,
  kpisDegradedLabels,
  laborCostCaption,
  monthCodeOf,
  monthOptions,
  sortAlerts,
  windowLabel
} from "./hr-forecast-helpers";
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
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  DegradedBanner,
  DegradedValue,
  isDegraded,
  type CocoaTableColumn
} from "../../components/cocoa";

// Etiquetas del árbol (Finanzas › RRHH y nóminas › Panel RRHH), nunca retecleadas.
const HEADER = treeHeaderFor("HrOverviewScreen", { eyebrow: "Finanzas · RRHH y nóminas", title: "Panel RRHH" });

const EMPLOYEE_NAMES_NOTE = "Los nombres de las personas exigen el permiso de lectura del expediente (hr.employee.read); sin él se muestra solo la alerta.";

type AlertRow = HrAlertDto & { key: string };

/** Esqueleto espejo: tira de 6 KPI y rejilla 6/6 + 12. */
function OverviewSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={220} />
    </div>
  );
}

function ChartLegend() {
  return (
    <div className="cocoa-cluster" role="list" aria-label="Series de la gráfica">
      {(["required", "planned"] as const).map((series) => (
        <CocoaBadge key={series} tone={FORECAST_SERIES_TONES[series]} variant="tinted" size="small" role="listitem">
          {FORECAST_SERIES_LABELS_ES[series]}
        </CocoaBadge>
      ))}
    </div>
  );
}

export function HrOverviewScreen() {
  const gate = useNavGate();
  const canReadEmployees = canDo(gate, "hr.employee.read");
  const finance = useFinanceScope(financeScopePolicy("HrOverviewScreen"), { excludeOffice: true });

  const today = todayIso();
  const [period, setPeriod] = useState<string>(monthCodeOf(today));
  const periodOptions = useMemo(() => monthOptions(monthCodeOf(today), 12), [today]);

  // KPIs: sociedad (sin propertyId = centros en ámbito) o un centro, según el «Ámbito».
  const kpisQuery = useMemo(() => hrKpisQuery({ propertyId: finance.propertyId ?? null, period }), [finance.propertyId, period]);
  const kpisState = useApiData<HrKpisDto>("/hr/kpis", { query: kpisQuery });
  const kpis = kpisState.data;
  const kpiLabels = useMemo(() => kpisDegradedLabels(kpis), [kpis]);

  // Alertas y previsión son de UN centro: el del ámbito, o el activo con la sociedad seleccionada.
  const centreId = finance.propertyId ?? finance.active.propertyId;
  const centreName = finance.centre?.name ?? finance.active.propertyName;
  const window = useMemo(() => forecastWindow(today, DEFAULT_FORECAST_RANGE_DAYS, today), [today]);
  const forecastQuery = useMemo(() => laborForecastQuery(window), [window]);
  const forecastState = useApiData<LaborForecastListResponse>(laborForecastPath(centreId), { query: forecastQuery });
  const alertsState = useApiData<HrAlertsResponse>("/hr/alerts", { query: { propertyId: centreId } });
  const employeesState = useApiData<EmployeeSummaryDto[]>(canReadEmployees ? "/hr/employees" : null, { query: { propertyId: centreId } });

  const rows = useMemo(() => toArray<LaborForecastDayDto>(forecastState.data?.rows), [forecastState.data]);
  const departmentOptions = useMemo(() => forecastDepartmentOptions(rows), [rows]);
  const [department, setDepartment] = useState<string>(FORECAST_DEPARTMENT_ALL);
  const chartDepartment = departmentOptions.some((option) => option.value === department) ? department : FORECAST_DEPARTMENT_ALL;
  const dayGroups = useMemo(() => groupForecastByDay(filterForecastDepartment(rows, chartDepartment)), [rows, chartDepartment]);
  const requiredBars = useMemo(() => dayBars(dayGroups, "required"), [dayGroups]);
  const plannedBars = useMemo(() => dayBars(dayGroups, "planned"), [dayGroups]);
  const forecastLabels = useMemo(() => degradedCodes(forecastState.data?.degraded), [forecastState.data]);

  const alerts = useMemo<AlertRow[]>(() => sortAlerts(toArray<HrAlertDto>(alertsState.data?.alerts)).map((alert, index) => ({ ...alert, key: `${alert.kind}:${alert.usaliDepartment ?? "all"}:${alert.date ?? "-"}:${alert.employeeId ?? index}` })), [alertsState.data]);
  const expiring = useMemo<AlertRow[]>(() => contractExpiringAlerts(alerts).map((alert, index) => ({ ...alert, key: `${alert.employeeId ?? index}:${alert.date ?? "-"}` })), [alerts]);
  const alertLabels = useMemo(() => degradedCodes(alertsState.data?.degraded), [alertsState.data]);
  const employees = useMemo(() => toArray<EmployeeSummaryDto>(employeesState.data), [employeesState.data]);

  const degradedAll = useMemo(() => Array.from(new Set([...kpiLabels, ...forecastLabels, ...alertLabels])), [kpiLabels, forecastLabels, alertLabels]);

  const alertColumns: CocoaTableColumn<AlertRow>[] = [
    {
      key: "severity",
      label: "Gravedad",
      render: (row) => (
        <CocoaBadge tone={alertTone(row.severity)} variant="tinted" size="small">
          {HR_ALERT_SEVERITY_LABELS_ES[row.severity] ?? row.severity}
        </CocoaBadge>
      )
    },
    { key: "kind", label: "Alerta", render: (row) => <strong>{alertKindLabel(row.kind)}</strong> },
    { key: "department", label: "Departamento", hideOnNarrow: true, render: (row) => (row.usaliDepartment ? departmentLabel(row.usaliDepartment) : "—") },
    { key: "date", label: "Día", render: (row) => (row.date ? date(row.date, "weekdayShort") : "—") },
    { key: "message", label: "Detalle", render: (row) => row.message },
    { key: "value", label: "Valor · umbral", align: "right", hideOnNarrow: true, render: (row) => (row.value === null && row.threshold === null ? "—" : `${row.value ?? "—"} · ${row.threshold ?? "—"}`) }
  ];

  const expiringColumns: CocoaTableColumn<AlertRow>[] = [
    { key: "employee", label: "Persona", render: (row) => <strong>{canReadEmployees ? employeeNameFor(employees, row.employeeId) : "—"}</strong> },
    { key: "date", label: "Vence", render: (row) => (row.date ? date(row.date, "medium") : "—") },
    { key: "department", label: "Departamento", hideOnNarrow: true, render: (row) => (row.usaliDepartment ? departmentLabel(row.usaliDepartment) : "—") },
    { key: "message", label: "Detalle", render: (row) => row.message }
  ];

  function refreshAll() {
    kpisState.refresh();
    forecastState.refresh();
    alertsState.refresh();
    if (canReadEmployees) employeesState.refresh();
  }

  const loading = kpisState.loading && !kpis;
  const error = kpisState.error;
  const state = loading ? "loading" : error && !kpis ? "error" : "ready";
  const availableDegraded = !kpis || kpis.availableFte === null || isDegraded(HR_KPI_DEGRADED_CODES.availableFte, kpiLabels);
  const requiredDegraded = !kpis || kpis.requiredFte === null || isDegraded(HR_KPI_DEGRADED_CODES.requiredFte, kpiLabels);
  const costDegraded = !kpis || kpis.monthLaborCost === null || isDegraded(HR_KPI_DEGRADED_CODES.monthLaborCost, kpiLabels);

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={HEADER.title}
      subtitle="La foto de la plantilla: personas y FTE disponibles frente al máximo aprobado y a la necesidad prevista, coste del mes sobre ventas, alertas y vencimientos."
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          <CocoaSelect size="small" inline aria-label="Mes" value={period} onChange={setPeriod} options={periodOptions} />
          {kpisState.isValidating && kpis ? (
            <CocoaBadge tone="info" size="small" aria-live="polite">
              {STATUS_LABELS.loading}
            </CocoaBadge>
          ) : null}
          <DegradedBanner degraded={degradedAll} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<OverviewSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refreshAll }}
      commands={[{ id: "hr-overview-refresh", label: "Actualizar el panel RRHH", run: refreshAll }]}
    >
      {error && kpis ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.loadError}>
          {error}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label="Indicadores de plantilla">
        <CocoaKpi label="Plantilla activa" value={kpis ? number(kpis.activeHeadcount) : "—"} unit="personas" caption={kpis ? `${formatFteUnit(kpis.activeFte)} · ${plural(kpis.fixedDiscontinuousHeadcount, "fijo discontinuo", "fijos discontinuos", { withCount: true })}` : undefined} degraded={!kpis} status="ok" />
        <CocoaKpi label="FTE disponible" value={kpis ? formatFte(kpis.availableFte) : "—"} unit="FTE" caption={kpis ? fteVsMaxCaption(kpis.availableFte, kpis.approvedMaxFte) : undefined} status={kpis ? fteKpiStatus(kpis.availableFte, kpis.approvedMaxFte) : "warning"} degraded={availableDegraded} />
        <CocoaKpi label="FTE necesario" value={kpis ? formatFte(kpis.requiredFte) : "—"} unit="FTE" caption="media diaria del mes previsto" degraded={requiredDegraded} status="ok" />
        <CocoaKpi label="Coste del mes" value={kpis && kpis.monthLaborCost !== null ? money(kpis.monthLaborCost) : "—"} caption={kpis ? laborCostCaption(kpis.laborCostPctOfSales, kpis.salesSource, kpis.monthLaborCostSource) : undefined} degraded={costDegraded} status="ok" />
        <CocoaKpi label="Coste por empleado" value={kpis && kpis.costPerEmployee !== null ? money(kpis.costPerEmployee) : "—"} caption={kpis ? costPerEmployeeCaption(kpis.costPerEmployee) : undefined} degraded={!kpis || kpis.costPerEmployee === null} status="ok" />
        <CocoaKpi label="Alertas abiertas" value={kpis ? number(kpis.alertsCount) : "—"} caption={kpis ? `${plural(kpis.contractsEndingIn30Days, "contrato vence", "contratos vencen", { withCount: true })} en 30 días` : undefined} degraded={!kpis} status={kpis && kpis.alertsCount > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <CocoaGrid aria-label="Previsión y alertas" align="start">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Necesidad frente a planificado · 14 días"
            meta={<ChartLegend />}
            action={<CocoaSelect size="small" inline aria-label="Departamento" value={chartDepartment} onChange={setDepartment} options={departmentOptions} disabled={departmentOptions.length <= 1} />}
          >
            <p className="cocoa-note">
              {centreName} · {windowLabel(window)}
              {finance.propertyId === undefined && finance.visible ? " · la previsión y las alertas son del centro activo" : ""}
            </p>
            {forecastState.loading && !forecastState.data ? (
              <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
            ) : forecastState.error && !forecastState.data ? (
              <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={forecastState.error} onRetry={forecastState.refresh} />
            ) : requiredBars.length === 0 && plannedBars.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin previsión generada para los próximos 14 días." message="Genera la previsión en la pestaña Previsión de plantilla." />
            ) : (
              <DegradedValue label="HR_FORECAST_MISSING" degraded={dayGroups.length === 0 ? forecastLabels : []}>
                <div className="cocoa-stack" data-gap="3">
                  <span className="cocoa-caption">{FORECAST_SERIES_LABELS_ES.required}</span>
                  {requiredBars.length === 0 ? (
                    <CocoaState kind="empty" inline title="Sin FTE necesario: la previsión de la ventana está incompleta." />
                  ) : (
                    <CocoaChart.Bars data={requiredBars} height={140} valueFormat={(value) => formatFte(value)} aria-label="FTE necesario por día de los próximos 14 días" />
                  )}
                  <span className="cocoa-caption">{FORECAST_SERIES_LABELS_ES.planned}</span>
                  {plannedBars.length === 0 ? (
                    <CocoaState kind="empty" inline title="Sin cuadrante planificado en la ventana." />
                  ) : (
                    <CocoaChart.Bars data={plannedBars} height={140} valueFormat={(value) => formatFte(value)} aria-label="FTE planificado por día de los próximos 14 días" />
                  )}
                </div>
              </DegradedValue>
            )}
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Vencimientos 30 días" meta={plural(expiring.length, "contrato", "contratos")} padding={expiring.length > 0 ? "none" : "md"} footer={!canReadEmployees && expiring.length > 0 ? <span className="cocoa-note">{EMPLOYEE_NAMES_NOTE}</span> : undefined}>
            {alertsState.loading && !alertsState.data ? (
              <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
            ) : expiring.length === 0 ? (
              <CocoaState kind="empty" inline title="Ningún contrato vence en los próximos 30 días." />
            ) : (
              <CocoaTable columns={expiringColumns} rows={expiring} rowKey="key" caption="Contratos que vencen en 30 días" aria-label="Contratos que vencen en 30 días" density="compact" />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaSection title="Alertas" meta={`${centreName} · ${plural(alerts.length, "alerta", "alertas", { withCount: true })}`} padding={alerts.length > 0 ? "none" : "md"}>
        {alertsState.loading && !alertsState.data ? (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        ) : alertsState.error && !alertsState.data ? (
          <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={alertsState.error} onRetry={alertsState.refresh} />
        ) : alerts.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin alertas de plantilla." message="Exceso o falta de personal, máximo aprobado superado, previsión incompleta, contratos que vencen y umbral de plantilla aparecen aquí." />
        ) : (
          <CocoaTable columns={alertColumns} rows={alerts} rowKey="key" caption="Alertas de plantilla del centro" aria-label="Alertas de plantilla del centro" density="compact" rowTone={(row) => (row.severity === "critical" ? "danger" : undefined)} />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

export default HrOverviewScreen;
