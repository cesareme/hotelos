// Previsión de plantilla — Finanzas › RRHH y nóminas › Previsión
// (/finanzas/nominas/prevision; Tanda RRHH · RRHH-9; diseño
// docs/design/RRHH-PLANTILLA-NOMINA.md §10 recortado por RRHH/recon-delta.md
// §3.10: sin cuadrante por empleado ni llamamientos).
//
// Cocoa 22, pestaña alojada en NominasTabs (RRHH-11): CocoaPage con cabecera
// centro + rango (14 / 28 días desde un CocoaDatePicker) → DegradedBanner →
// CocoaSplitView (sidebar = necesidad por día con origen y DegradedValue;
// content = drivers del día, tabla necesario vs planificado vs disponible vs
// máximo aprobado y CocoaChart.Bars de tres series) → «Resumen del periodo»
// por departamento → «Estándares de dotación» (CocoaTable editable; «Guardar»
// y «Restablecer valores del sector», gate hr.standards.manage) → «Plantilla
// máxima» (planes por temporada; «Nuevo borrador» con hr.standards.manage y
// «Aprobar» SOLO con hr.staffing.approve). «Generar previsión» exige
// workforce.schedule.manage. Datos: services/hrForecastApi.ts (rutas /hr/*);
// lógica pura en hr-forecast-helpers.ts. Sin estilos en línea: solo primitivas y
// las clases de layout de cocoa-base.css.

import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { centreOptionLabel, eligibleCentres, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { money, number, plural } from "../../lib/format";
import { toArray } from "../../utils/toArray";
import {
  approveStaffingPlan,
  createStaffingPlan,
  generateLaborForecast,
  hrForecastErrorMessage,
  laborForecastPath,
  laborForecastQuery,
  laborStandardsPath,
  putLaborStandards,
  resetLaborStandardDefaults,
  staffingPlansPath,
  type LaborForecastListResponse,
  type LaborForecastDayDto,
  type LaborStandardsResponse,
  type StaffingPlanDto,
  type StaffingPlansResponse
} from "../../services/hrForecastApi";
import {
  DEFAULT_FORECAST_RANGE_DAYS,
  FORECAST_RANGE_OPTIONS,
  FORECAST_SERIES,
  FORECAST_SERIES_LABELS_ES,
  FORECAST_SERIES_TONES,
  HR_FORECAST_DEPARTMENTS,
  HR_FORECAST_DEPARTMENT_LABELS_ES,
  LABOR_STANDARD_SOURCE_LABELS_ES,
  MONTH_OPTIONS,
  SEASON_OPTIONS,
  STAFFING_PLAN_STATUS_LABELS_ES,
  STAFFING_SEASON_LABELS_ES,
  approvedPlanFor,
  bandsLabel,
  coverageStatus,
  dayLabel,
  degradedCodes,
  degradedHint,
  degradedMessages,
  departmentLabel,
  forecastBars,
  forecastSourceLabel,
  forecastWindow,
  formatFte,
  formatFteUnit,
  formatHours,
  fteFromHours,
  groupForecastByDay,
  groupForecastByDepartment,
  newPlanDraft,
  parseForecastRangeDays,
  planApprovable,
  planDraftBody,
  planDraftErrors,
  planDraftWithSeason,
  planLinesSummary,
  planMonthsLabel,
  planStatusTone,
  requiredFteLabel,
  rowDegradedLabels,
  sortPlans,
  standardConceptLabel,
  standardDraftErrors,
  standardValueSuffix,
  standardsDirty,
  standardsPutBody,
  standardsToDraft,
  updateStandardDraft,
  windowLabel,
  type ForecastDayGroup,
  type ForecastDepartmentGroup,
  type PlanDraft,
  type StandardDraftRow
} from "./hr-forecast-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaChart,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSplitView,
  CocoaStat,
  CocoaState,
  CocoaTable,
  DegradedBanner,
  DegradedValue,
  type CocoaSelectOption,
  type CocoaTableColumn
} from "../../components/cocoa";

// Etiquetas del árbol (Finanzas › RRHH y nóminas › Previsión de plantilla), nunca retecleadas.
const HEADER = treeHeaderFor("HrForecastScreen", { eyebrow: "Finanzas · RRHH y nóminas", title: "Previsión de plantilla" });

const STANDARDS_NOTE = "Necesitas el permiso de estándares de dotación (hr.standards.manage) para editar los estándares y preparar borradores de plantilla máxima.";
const GENERATE_NOTE = "Necesitas el permiso de planificación de turnos (workforce.schedule.manage) para generar la previsión.";
const DAY_DEGRADED_LABEL = "HR_DAY_DEGRADED";

type DayRow = LaborForecastDayDto & { key: string };
type PeriodRow = ForecastDepartmentGroup & { key: string };
type PlanRow = StaffingPlanDto & { key: string };

/** Esqueleto espejo: filtros, split (4/8) y tres secciones de tabla. */
function ForecastSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton.Grid rows={[[4, 8], [12], [12]]} height={200} />
    </div>
  );
}

function SeriesLegend() {
  return (
    <div className="cocoa-cluster" role="list" aria-label="Series de la gráfica">
      {FORECAST_SERIES.map((series) => (
        <CocoaBadge key={series} tone={FORECAST_SERIES_TONES[series]} variant="tinted" size="small" role="listitem">
          {FORECAST_SERIES_LABELS_ES[series]}
        </CocoaBadge>
      ))}
    </div>
  );
}

export function HrForecastScreen() {
  const { showToast } = useToast();
  const gate = useNavGate();
  const canGenerate = canDo(gate, "workforce.schedule.manage");
  const canManageStandards = canDo(gate, "hr.standards.manage");
  const canApprove = canDo(gate, "hr.staffing.approve");

  // Centros de la sociedad (sin la oficina central); por defecto el centro activo del selector del shell.
  const finance = useFinanceScope(financeScopePolicy("HrForecastScreen"), { excludeOffice: true });
  const centres = useMemo(() => eligibleCentres(finance.structure, finance.active, { excludeOffice: true }), [finance.structure, finance.active]);
  const centreOptions = useMemo<CocoaSelectOption[]>(() => centres.map((centre) => ({ value: centre.id, label: centreOptionLabel(centre) })), [centres]);
  const [centreChoice, setCentreChoice] = useState<string>("");
  const centreId = centreChoice && centres.some((centre) => centre.id === centreChoice) ? centreChoice : finance.active.propertyId;
  const centreName = centres.find((centre) => centre.id === centreId)?.name ?? finance.active.propertyName;

  const today = todayIso();
  const [rangeDays, setRangeDays] = useState<string>(String(DEFAULT_FORECAST_RANGE_DAYS));
  const [from, setFrom] = useState<string>(today);
  const window = useMemo(() => forecastWindow(from, parseForecastRangeDays(rangeDays), today), [from, rangeDays, today]);
  const query = useMemo(() => laborForecastQuery(window), [window]);

  const forecastState = useApiData<LaborForecastListResponse>(laborForecastPath(centreId), { query });
  const standardsState = useApiData<LaborStandardsResponse>(laborStandardsPath(centreId));
  const plansState = useApiData<StaffingPlansResponse>(staffingPlansPath(centreId));

  const rows = useMemo(() => toArray<LaborForecastDayDto>(forecastState.data?.rows), [forecastState.data]);
  const dayGroups = useMemo(() => groupForecastByDay(rows), [rows]);
  const periodRows = useMemo<PeriodRow[]>(() => groupForecastByDepartment(rows).map((group) => ({ ...group, key: group.usaliDepartment })), [rows]);
  const degradedLabels = useMemo(() => degradedCodes(forecastState.data?.degraded), [forecastState.data]);
  const degradedNotes = useMemo(() => degradedMessages(forecastState.data?.degraded), [forecastState.data]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selectedGroup = useMemo<ForecastDayGroup | null>(() => dayGroups.find((group) => group.date === selectedDate) ?? dayGroups[0] ?? null, [dayGroups, selectedDate]);
  const dayRows = useMemo<DayRow[]>(() => (selectedGroup ? selectedGroup.rows.map((row) => ({ ...row, key: `${row.date}:${row.usaliDepartment}` })) : []), [selectedGroup]);
  const dayBarsData = useMemo(() => (selectedGroup ? forecastBars(selectedGroup.rows) : []), [selectedGroup]);
  const driversRow = selectedGroup?.rows[0] ?? null;

  // ── Generar previsión ──────────────────────────────────────────────────
  const [generating, setGenerating] = useState(false);
  async function generate() {
    if (!canGenerate || generating) return;
    setGenerating(true);
    try {
      const result = await generateLaborForecast(centreId, window);
      showToast(`Previsión generada: ${plural(result.written, "fila", "filas", { withCount: true })} · ${plural(result.degradedDays, "día incompleto", "días incompletos", { withCount: true })}.`, { variant: result.degradedDays > 0 ? "warning" : "success" });
      forecastState.refresh();
    } catch (error) {
      showToast(hrForecastErrorMessage(error, "No se pudo generar la previsión."), { variant: "error" });
    } finally {
      setGenerating(false);
    }
  }

  // ── Estándares: borrador editable ──────────────────────────────────────
  const loadedStandards = useMemo(() => standardsToDraft(toArray(standardsState.data?.standards)), [standardsState.data]);
  const [draft, setDraft] = useState<StandardDraftRow[]>([]);
  useEffect(() => {
    setDraft(loadedStandards);
  }, [loadedStandards]);
  const draftErrors = useMemo(() => standardDraftErrors(draft), [draft]);
  const draftDirty = useMemo(() => standardsDirty(draft, loadedStandards), [draft, loadedStandards]);
  const firstDraftError = Object.values(draftErrors)[0] ?? null;
  const [savingStandards, setSavingStandards] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function saveStandards() {
    if (!canManageStandards || savingStandards || !draftDirty || firstDraftError) return;
    setSavingStandards(true);
    try {
      const result = await putLaborStandards(centreId, standardsPutBody(draft));
      showToast(`Estándares guardados: ${plural(result.written, "estándar", "estándares", { withCount: true })} desde ${result.validFrom}.`, { variant: "success" });
      standardsState.refresh();
      forecastState.refresh();
    } catch (error) {
      showToast(hrForecastErrorMessage(error, "No se pudieron guardar los estándares."), { variant: "error" });
    } finally {
      setSavingStandards(false);
    }
  }

  async function resetStandards() {
    if (!canManageStandards || resetting) return;
    setResetting(true);
    try {
      const result = await resetLaborStandardDefaults(centreId);
      showToast(`Valores del sector restablecidos (${result.starBand ?? "?"} estrellas): ${plural(result.written, "estándar", "estándares", { withCount: true })}.`, { variant: "success" });
      setResetOpen(false);
      standardsState.refresh();
      forecastState.refresh();
    } catch (error) {
      showToast(hrForecastErrorMessage(error, "No se pudieron restablecer los estándares."), { variant: "error" });
    } finally {
      setResetting(false);
    }
  }

  // ── Plantilla máxima: borrador y aprobación ────────────────────────────
  const plans = useMemo<PlanRow[]>(() => sortPlans(toArray<StaffingPlanDto>(plansState.data?.plans)).map((plan) => ({ ...plan, key: plan.id })), [plansState.data]);
  const [approveTarget, setApproveTarget] = useState<StaffingPlanDto | null>(null);
  const [approving, setApproving] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState<PlanDraft>(() => newPlanDraft(Number(today.slice(0, 4))));
  const [planError, setPlanError] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const planErrors = useMemo(() => planDraftErrors(planDraft), [planDraft]);
  const planInvalid = Object.keys(planErrors).length > 0;

  function openPlanDrawer() {
    setPlanDraft(newPlanDraft(Number(today.slice(0, 4))));
    setPlanError(null);
    setPlanOpen(true);
  }

  function updatePlanLine(department: (typeof HR_FORECAST_DEPARTMENTS)[number], value: string) {
    setPlanDraft((current) => ({ ...current, lines: { ...current.lines, [department]: value } }));
  }

  async function savePlan() {
    if (!canManageStandards || savingPlan || planInvalid) return;
    setSavingPlan(true);
    setPlanError(null);
    try {
      const saved = await createStaffingPlan(centreId, planDraftBody(planDraft));
      showToast(`Borrador guardado: ${STAFFING_SEASON_LABELS_ES[saved.season]} ${saved.year} · ${formatFteUnit(saved.totalMaxFte)}.`, { variant: "success" });
      setPlanOpen(false);
      plansState.refresh();
    } catch (error) {
      setPlanError(hrForecastErrorMessage(error, "No se pudo guardar el borrador."));
    } finally {
      setSavingPlan(false);
    }
  }

  async function approvePlan() {
    if (!approveTarget || !canApprove || approving) return;
    setApproving(true);
    try {
      const approved = await approveStaffingPlan(centreId, approveTarget.id);
      showToast(`Plan aprobado: ${STAFFING_SEASON_LABELS_ES[approved.season]} ${approved.year}.`, { variant: "success" });
      setApproveTarget(null);
      plansState.refresh();
      forecastState.refresh();
    } catch (error) {
      showToast(hrForecastErrorMessage(error, "No se pudo aprobar el plan."), { variant: "error" });
    } finally {
      setApproving(false);
    }
  }

  // ── Columnas ───────────────────────────────────────────────────────────
  const dayColumns: CocoaTableColumn<DayRow>[] = [
    { key: "department", label: "Departamento", render: (row) => <strong>{departmentLabel(row.usaliDepartment)}</strong> },
    {
      key: "requiredFte",
      label: "Necesario",
      align: "right",
      render: (row) => (
        <DegradedValue label={DAY_DEGRADED_LABEL} degraded={rowDegradedLabels(row)}>
          {formatFteUnit(row.requiredFte)}
        </DegradedValue>
      )
    },
    { key: "requiredHours", label: "Horas", align: "right", hideOnNarrow: true, render: (row) => formatHours(row.requiredHours) },
    { key: "plannedHours", label: "Planificado", align: "right", render: (row) => (row.plannedHours === null ? "Sin cuadrante" : `${formatFteUnit(fteFromHours(row.plannedHours))} · ${formatHours(row.plannedHours)}`) },
    { key: "availableFte", label: "Disponible", align: "right", render: (row) => formatFteUnit(row.availableFte) },
    { key: "approvedFte", label: "Máximo aprobado", align: "right", hideOnNarrow: true, render: (row) => (row.approvedFte === null ? "Sin plan" : formatFteUnit(row.approvedFte)) },
    {
      key: "coverage",
      label: "Cobertura",
      render: (row) => {
        const status = coverageStatus(row);
        return (
          <CocoaBadge tone={status.tone} variant="tinted" size="small" title={row.degraded ? degradedHint(row.degradedReasons) : undefined}>
            {row.degraded ? "Incompleta" : status.label}
          </CocoaBadge>
        );
      }
    }
  ];

  const periodColumns: CocoaTableColumn<PeriodRow>[] = [
    { key: "label", label: "Departamento", render: (row) => <strong>{row.label}</strong> },
    { key: "days", label: "Días", align: "right", hideOnNarrow: true, render: (row) => (row.degradedDays > 0 ? `${number(row.days)} (${number(row.degradedDays)} incompletos)` : number(row.days)) },
    { key: "requiredFteAvg", label: "Necesario · media", align: "right", render: (row) => formatFteUnit(row.requiredFteAvg) },
    { key: "requiredHours", label: "Horas necesarias", align: "right", hideOnNarrow: true, render: (row) => formatHours(row.requiredHours) },
    { key: "plannedFteAvg", label: "Planificado · media", align: "right", render: (row) => formatFteUnit(row.plannedFteAvg) },
    { key: "availableFteAvg", label: "Disponible · media", align: "right", render: (row) => formatFteUnit(row.availableFteAvg) },
    { key: "approvedFteMax", label: "Máximo aprobado", align: "right", hideOnNarrow: true, render: (row) => (row.approvedFteMax === null ? "Sin plan" : formatFteUnit(row.approvedFteMax)) },
    { key: "estimatedCost", label: "Coste estimado", align: "right", hideOnNarrow: true, render: (row) => (row.estimatedCost === null ? "—" : money(row.estimatedCost)) }
  ];

  const standardColumns: CocoaTableColumn<StandardDraftRow>[] = [
    { key: "department", label: "Departamento", render: (row) => <strong>{HR_FORECAST_DEPARTMENT_LABELS_ES[row.usaliDepartment]}</strong> },
    { key: "concept", label: "Concepto", render: (row) => standardConceptLabel(row) },
    {
      key: "value",
      label: "Valor",
      align: "right",
      render: (row) => (
        <span className="cocoa-cluster">
          <CocoaInput size="small" value={row.value} onChange={(value) => setDraft((current) => updateStandardDraft(current, row.key, "value", value))} inputMode="decimal" disabled={!canManageStandards} error={Boolean(draftErrors[row.key])} aria-label={`Valor · ${standardConceptLabel(row)}`} />
          <span className="cocoa-caption">{standardValueSuffix(row.unit)}</span>
        </span>
      )
    },
    { key: "allowancePct", label: "Margen %", align: "right", hideOnNarrow: true, render: (row) => <CocoaInput size="small" value={row.allowancePct} onChange={(value) => setDraft((current) => updateStandardDraft(current, row.key, "allowancePct", value))} inputMode="decimal" disabled={!canManageStandards} aria-label={`Margen · ${standardConceptLabel(row)}`} /> },
    { key: "coverageFactor", label: "Cobertura", align: "right", hideOnNarrow: true, render: (row) => <CocoaInput size="small" value={row.coverageFactor} onChange={(value) => setDraft((current) => updateStandardDraft(current, row.key, "coverageFactor", value))} inputMode="decimal" disabled={!canManageStandards} aria-label={`Cobertura · ${standardConceptLabel(row)}`} /> },
    { key: "bands", label: "Tramos", hideOnNarrow: true, render: (row) => bandsLabel(row.bands) },
    { key: "source", label: "Origen", hideOnNarrow: true, render: (row) => <CocoaBadge tone={row.source === "sector_default" ? "neutral" : "info"} variant="outline" size="small">{LABOR_STANDARD_SOURCE_LABELS_ES[row.source]}</CocoaBadge> }
  ];

  const planColumns: CocoaTableColumn<PlanRow>[] = [
    { key: "year", label: "Año", render: (row) => <strong>{String(row.year)}</strong> },
    { key: "season", label: "Temporada", render: (row) => STAFFING_SEASON_LABELS_ES[row.season] },
    { key: "months", label: "Meses", hideOnNarrow: true, render: (row) => planMonthsLabel(row) },
    { key: "status", label: "Estado", render: (row) => <CocoaBadge tone={planStatusTone(row.status)} variant="tinted" size="small">{STAFFING_PLAN_STATUS_LABELS_ES[row.status]}</CocoaBadge> },
    { key: "totalMaxFte", label: "FTE máximo", align: "right", render: (row) => formatFteUnit(row.totalMaxFte) },
    { key: "lines", label: "Por departamento", hideOnNarrow: true, render: (row) => planLinesSummary(row) }
  ];

  // ── Estado de página ───────────────────────────────────────────────────
  const loading = forecastState.loading && !forecastState.data;
  const error = forecastState.error;
  const state = loading ? "loading" : error && !forecastState.data ? "error" : "ready";

  const sidebar = (
    <div className="cocoa-stack" data-gap="2" role="list" aria-label="Necesidad por día">
      {dayGroups.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin previsión en el rango." message="Genera la previsión para ver la necesidad por día." />
      ) : (
        dayGroups.map((group) => {
          const selected = selectedGroup?.date === group.date;
          const dayLabels = group.degraded ? [DAY_DEGRADED_LABEL, ...group.degradedReasons] : [];
          return (
            <div key={group.date} role="listitem">
              <CocoaButton variant={selected ? "bordered" : "plain"} tone={selected ? "accent" : "neutral"} size="small" fullWidth align="between" wrap aria-pressed={selected} onClick={() => setSelectedDate(group.date)} title={group.degraded ? degradedHint(group.degradedReasons) : `${plural(group.rows.length, "departamento", "departamentos", { withCount: true })}`}>
                <span className="cocoa-stack" data-gap="1">
                  <span>{dayLabel(group.date)}</span>
                  <span className="cocoa-caption">{group.sources.map(forecastSourceLabel).join(" · ") || "Sin origen"}</span>
                </span>
                <span className="cocoa-cluster">
                  <DegradedValue label={DAY_DEGRADED_LABEL} degraded={dayLabels}>
                    {formatFteUnit(group.requiredFte)}
                  </DegradedValue>
                  {group.degraded ? (
                    <CocoaBadge tone="warning" variant="tinted" size="small">
                      Incompleta
                    </CocoaBadge>
                  ) : null}
                </span>
              </CocoaButton>
            </div>
          );
        })
      )}
    </div>
  );

  const content = selectedGroup ? (
    <div className="cocoa-stack" data-gap="4">
      <CocoaSection title={dayLabel(selectedGroup.date)} meta={selectedGroup.sources.map(forecastSourceLabel).join(" · ") || "Sin origen"} headingLevel={3}>
        {selectedGroup.degraded ? (
          <CocoaCallout tone="warning" title="Previsión incompleta">
            {degradedHint(selectedGroup.degradedReasons)}
          </CocoaCallout>
        ) : null}
        <div className="cocoa-row" data-gap="4" aria-label="Drivers de ocupación del día">
          <CocoaStat label="Hab. ocupadas" value={<DegradedValue label={DAY_DEGRADED_LABEL} degraded={driversRow?.drivers.rooms === null ? [DAY_DEGRADED_LABEL] : []}>{number(driversRow?.drivers.rooms ?? null)}</DegradedValue>} />
          <CocoaStat label="Llegadas" value={<DegradedValue label={DAY_DEGRADED_LABEL} degraded={driversRow?.drivers.arrivals === null ? [DAY_DEGRADED_LABEL] : []}>{number(driversRow?.drivers.arrivals ?? null)}</DegradedValue>} />
          <CocoaStat label="Salidas" value={<DegradedValue label={DAY_DEGRADED_LABEL} degraded={driversRow?.drivers.departures === null ? [DAY_DEGRADED_LABEL] : []}>{number(driversRow?.drivers.departures ?? null)}</DegradedValue>} />
          <CocoaStat label="Huéspedes" value={<DegradedValue label={DAY_DEGRADED_LABEL} degraded={driversRow?.drivers.pax === null ? [DAY_DEGRADED_LABEL] : []}>{number(driversRow?.drivers.pax ?? null)}</DegradedValue>} />
          <CocoaStat label="Desayunos" value={<DegradedValue label={DAY_DEGRADED_LABEL} degraded={driversRow?.drivers.coversBreakfast === null ? [DAY_DEGRADED_LABEL] : []}>{number(driversRow?.drivers.coversBreakfast ?? null)}</DegradedValue>} />
          <CocoaStat label="Coste estimado" value={selectedGroup.estimatedCost === null ? "—" : money(selectedGroup.estimatedCost)} hint={selectedGroup.estimatedCost === null ? "Sin lote de coste contabilizado" : undefined} />
        </div>
      </CocoaSection>
      <CocoaSection title="Necesario, planificado, disponible y máximo aprobado" meta={requiredFteLabel(selectedGroup)} padding="none" headingLevel={3}>
        <CocoaTable columns={dayColumns} rows={dayRows} rowKey="key" caption={`Previsión por departamento del ${dayLabel(selectedGroup.date)}`} aria-label="Previsión por departamento del día" density="compact" />
      </CocoaSection>
      <CocoaSection title="Por departamento" meta={<SeriesLegend />} headingLevel={3}>
        {dayBarsData.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin cifras que representar." message="El día no tiene FTE necesario, planificado ni disponible." />
        ) : (
          <CocoaChart.Bars data={dayBarsData} height={180} valueFormat={(value) => formatFteUnit(value)} aria-label="FTE necesario, planificado y disponible por departamento del día" />
        )}
      </CocoaSection>
    </div>
  ) : (
    <CocoaState
      kind="empty"
      title="Sin previsión de plantilla"
      message={`No hay previsión generada para ${centreName} entre ${windowLabel(window)}. Genera la previsión a partir de la ocupación prevista y los estándares del centro.`}
      primaryAction={canGenerate ? { label: "Generar previsión", onClick: generate } : undefined}
    />
  );

  // RF-13: the approved plan of the season the selected window starts in, not the first approved of the list.
  const activePlan = approvedPlanFor(plans, window.from);

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Necesidad de personal por día y departamento a partir de la ocupación prevista y los estándares del centro, frente al cuadrante, la plantilla disponible y el máximo aprobado."
      actions={
        <>
          <CocoaSelect size="small" inline aria-label="Centro" value={centreId} onChange={setCentreChoice} options={centreOptions} disabled={finance.loading} />
          <CocoaSegmentedControl size="small" aria-label="Rango de días" value={rangeDays} onChange={setRangeDays} options={[...FORECAST_RANGE_OPTIONS]} />
          <CocoaDatePicker size="small" aria-label="Desde" value={from} onChange={setFrom} arithmetic today={today} />
          {forecastState.isValidating && forecastState.data ? (
            <CocoaBadge tone="info" size="small" aria-live="polite">
              {STATUS_LABELS.loading}
            </CocoaBadge>
          ) : null}
          <DegradedBanner degraded={degradedLabels} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={forecastState.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={generate} loading={generating} disabled={!canGenerate}>
            Generar previsión
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<ForecastSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: forecastState.refresh }}
      commands={[
        { id: "hr-forecast-generate", label: "Generar la previsión de plantilla", run: generate },
        { id: "hr-forecast-refresh", label: "Actualizar la previsión de plantilla", run: forecastState.refresh }
      ]}
    >
      {!canGenerate ? <p className="cocoa-note">{GENERATE_NOTE}</p> : null}
      {error && forecastState.data ? (
        <CocoaCallout tone="danger" role="alert" title={STATUS_LABELS.loadError}>
          {error}
        </CocoaCallout>
      ) : null}
      {degradedNotes.length > 0 ? (
        <CocoaCallout tone="warning" title={`${centreName} · ${windowLabel(window)}`}>
          {degradedNotes.join(" ")}
        </CocoaCallout>
      ) : null}

      <CocoaSplitView sidebar={sidebar} content={content} sidebarWidth={300} collapsibleSidebar />

      <CocoaSection title="Resumen del periodo" meta={`${windowLabel(window)} · ${plural(dayGroups.length, "día", "días", { withCount: true })}`} padding={periodRows.length > 0 ? "none" : "md"}>
        {periodRows.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin previsión en el rango." />
        ) : (
          <CocoaTable columns={periodColumns} rows={periodRows} rowKey="key" caption="Resumen del periodo por departamento" aria-label="Resumen del periodo por departamento" density="compact" />
        )}
      </CocoaSection>

      <CocoaSection
        title="Estándares de dotación"
        meta={standardsState.data ? `${plural(draft.length, "estándar", "estándares", { withCount: true })} · ${standardsState.data.starBand} estrellas · vigentes el ${standardsState.data.at}` : undefined}
        action={
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setResetOpen(true)} disabled={!canManageStandards || resetting}>
            Restablecer valores del sector
          </CocoaButton>
        }
        padding={draft.length > 0 ? "none" : "md"}
        footer={
          <div className="cocoa-row" data-justify="between">
            <span className="cocoa-note">{!canManageStandards ? STANDARDS_NOTE : firstDraftError ?? (draftDirty ? "Cambios sin guardar: se abre una versión nueva desde hoy y se conserva la anterior." : "Minutos por unidad, unidades por turno, FTE por 100 habitaciones o puestos por tramo; el margen y la cobertura absorben pausas, descansos y vacaciones.")}</span>
            <CocoaButton variant="filled" tone="accent" size="small" onClick={saveStandards} loading={savingStandards} disabled={!canManageStandards || !draftDirty || Boolean(firstDraftError)}>
              Guardar estándares
            </CocoaButton>
          </div>
        }
      >
        {standardsState.loading && !standardsState.data ? (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        ) : standardsState.error && !standardsState.data ? (
          <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={standardsState.error} onRetry={standardsState.refresh} />
        ) : draft.length === 0 ? (
          <CocoaState kind="empty" inline title="El centro no tiene estándares de dotación." message="Restablece los valores del sector según las estrellas del centro y ajústalos después." />
        ) : (
          <CocoaTable columns={standardColumns} rows={draft} rowKey="key" caption="Estándares de dotación del centro" aria-label="Estándares de dotación del centro" density="compact" />
        )}
      </CocoaSection>

      <CocoaSection
        title="Plantilla máxima"
        meta={activePlan ? `Aprobado: ${STAFFING_SEASON_LABELS_ES[activePlan.season]} ${activePlan.year} · ${formatFteUnit(activePlan.totalMaxFte)}` : "Sin plan aprobado"}
        action={
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={openPlanDrawer} disabled={!canManageStandards}>
            Nuevo borrador
          </CocoaButton>
        }
        padding={plans.length > 0 ? "none" : "md"}
      >
        {plansState.loading && !plansState.data ? (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        ) : plansState.error && !plansState.data ? (
          <CocoaState kind="error" inline title={STATUS_LABELS.loadError} message={plansState.error} onRetry={plansState.refresh} />
        ) : plans.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin planes de plantilla máxima." message="Prepara un borrador por temporada; dirección lo aprueba." />
        ) : (
          <CocoaTable
            columns={planColumns}
            rows={plans}
            rowKey="key"
            caption="Planes de plantilla máxima por temporada"
            aria-label="Planes de plantilla máxima por temporada"
            density="compact"
            rowActionsVisible="always"
            rowActions={(row) =>
              canApprove && planApprovable(row) ? (
                <CocoaButton variant="bordered" tone="accent" size="small" onClick={() => setApproveTarget(row)}>
                  {ACTIONS.approve}
                </CocoaButton>
              ) : null
            }
          />
        )}
      </CocoaSection>

      <CocoaDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Restablecer los valores del sector"
        description={`Se cierran los estándares vigentes de ${centreName} y se abren los valores del sector para su categoría desde hoy. La versión anterior se conserva.`}
        confirmLabel="Restablecer"
        onConfirm={resetStandards}
        busy={resetting}
      />

      <CocoaDialog
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        title={approveTarget ? `Aprobar el plan ${STAFFING_SEASON_LABELS_ES[approveTarget.season].toLowerCase()} ${approveTarget.year}` : "Aprobar el plan"}
        description={approveTarget ? `${formatFteUnit(approveTarget.totalMaxFte)} en total · ${planLinesSummary(approveTarget)}. Quien preparó el borrador no puede aprobarlo.` : undefined}
        confirmLabel={ACTIONS.approve}
        onConfirm={approvePlan}
        busy={approving}
      />

      <CocoaDrawer
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="Nuevo borrador de plantilla máxima"
        subtitle={centreName}
        side="right"
        size="md"
        footer={
          <div className="cocoa-row" data-justify="end">
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setPlanOpen(false)}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={savePlan} loading={savingPlan} disabled={!canManageStandards || planInvalid}>
              Guardar borrador
            </CocoaButton>
          </div>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {planError ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo guardar el borrador">
              {planError}
            </CocoaCallout>
          ) : null}
          <CocoaFormRow columns={2}>
            <CocoaField label="Año" required error={planErrors.year}>
              <CocoaInput value={planDraft.year} onChange={(value) => setPlanDraft((current) => ({ ...current, year: value }))} type="number" inputMode="numeric" min={2000} max={2100} />
            </CocoaField>
            <CocoaField label="Temporada" required error={planErrors.season}>
              <CocoaSelect value={planDraft.season} onChange={(value) => setPlanDraft((current) => planDraftWithSeason(current, value as PlanDraft["season"]))} options={[...SEASON_OPTIONS]} />
            </CocoaField>
            <CocoaField label="Desde el mes" required error={planErrors.months}>
              <CocoaSelect value={planDraft.fromMonth} onChange={(value) => setPlanDraft((current) => ({ ...current, fromMonth: value }))} options={[...MONTH_OPTIONS]} />
            </CocoaField>
            <CocoaField label="Hasta el mes" required>
              <CocoaSelect value={planDraft.toMonth} onChange={(value) => setPlanDraft((current) => ({ ...current, toMonth: value }))} options={[...MONTH_OPTIONS]} />
            </CocoaField>
          </CocoaFormRow>
          <p className="cocoa-note">{planErrors.lines ?? "Máximo de FTE por departamento (equivalentes a jornada completa). Deja en blanco los departamentos sin tope."}</p>
          <CocoaFormRow columns={2}>
            {HR_FORECAST_DEPARTMENTS.map((department) => (
              <CocoaField key={department} label={HR_FORECAST_DEPARTMENT_LABELS_ES[department]} hint="FTE">
                <CocoaInput value={planDraft.lines[department]} onChange={(value) => updatePlanLine(department, value)} inputMode="decimal" placeholder="Sin tope" />
              </CocoaField>
            ))}
          </CocoaFormRow>
          {!canManageStandards ? <p className="cocoa-note">{STANDARDS_NOTE}</p> : null}
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default HrForecastScreen;
