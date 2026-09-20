// Vista de grupo del activo inmobiliario (Tanda ACT · lote ACT-F1, diseño
// docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8 «Grupo»).
//
// Cocoa 22: CocoaPage → CocoaKpi strip (centros, valor catastral, tasación,
// carga fiscal y alertas altas del grupo) → CocoaTable de los centros visibles
// (tenencia, valor catastral, tasación, carga fiscal, documentos vigentes %,
// inspecciones en plazo %, alertas) con la fila de totales calculada como la
// suma de las filas (`groupTotalsOf`) → CocoaChart.Bars de la carga fiscal por
// centro → calendario anual consolidado (CocoaGrid de 12 meses de
// GET /organizations/:id/real-estate/calendar) → alertas altas del grupo.
//
// Cada fila abre el detalle del centro en un CocoaDrawer
// (`RealEstateAssetSummary` sobre GET /properties/:id/real-estate con el id
// EXPLÍCITO) sin cambiar la propiedad activa; solo la acción «Operar en este
// centro» (confirmada en un CocoaDialog porque recarga la página) llama a
// `setActiveProperty` de services/activeProperty.ts. «Exportar CSV» descarga
// GET …/real-estate/export?format=csv (exportRealEstateCsv → Blob →
// saveDownload: URL.createObjectURL revocado), con `real_estate.read`.
//
// Lecturas y escrituras SOLO por services/realEstateApi.ts; permisos con
// `canDo(useNavGate(), …)`; sin estilos en línea (Cocoa 22).
// `RealEstateGroupScreen` (contenedor) pinta `RealEstateGroupView`
// (presentación con estado explícito) que los tests renderizan sin red.

import { useCallback, useState, type ReactNode } from "react";
import type { RealEstateAlert, RealEstateAssetDetail, RealEstateCalendarEvent, RealEstateGroupOverview, RealEstateGroupRow, RealEstateGroupTotals } from "@hotelos/shared";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaDialog,
  CocoaDrawer,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaScrollArea,
  CocoaSection,
  CocoaSelect,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaBarsDatum,
  type CocoaTableColumn
} from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { date, plural } from "../../lib/format";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getActiveProperty, setActiveProperty } from "../../services/activeProperty";
import { downloadFilename, financeErrorStatus } from "../../services/finance-contracts";
import { exportRealEstateCsv, getRealEstateAsset, getRealEstateGroupCalendar, getRealEstateGroupOverview } from "../../services/realEstateApi";
import type { RealEstateCalendarYear, RealEstateExportWhat } from "../../services/realEstateApi";
import { canDo, saveDownload, todayIso } from "../accounting/accounting-ui";
import { useTabHost } from "../tabs/TabHost";
import { EMPTY_ASSET_TITLE, RealEstateAssetSummary, assetViewState, useResource } from "./RealEstateAssetScreen";
import { alertEntityTypeLabel, alertKindLabel, alertSeverityTone, formatDay, formatMoney, formatPercent, realEstateErrorMessage, tenureKindLabel } from "./real-estate-helpers";

// ---------------------------------------------------------------------------
// Copy y permisos
// ---------------------------------------------------------------------------

export const READ_PERMISSION = "real_estate.read";
export const EXPORT_LABEL = "Exportar CSV";
export const EXPORT_CALENDAR_LABEL = "Exportar calendario";
export const OPERATE_LABEL = "Operar en este centro";
export const EMPTY_GROUP_TITLE = "Sin centros con activo inmobiliario";
export const EMPTY_GROUP_MESSAGE = "Cuando un centro de tu ámbito tenga ficha de activo inmobiliario aparecerá aquí con su tenencia, sus valores y sus alertas.";

// ---------------------------------------------------------------------------
// Puros: totales, gráfico, exportación y calendario
// ---------------------------------------------------------------------------

function cents(value: string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function moneyOfCents(total: number): string {
  return (total / 100).toFixed(2);
}

/** Totales de la vista de grupo = suma de las filas (los `null` suman 0), con la misma forma que `totals` del API. */
export function groupTotalsOf(rows: ReadonlyArray<RealEstateGroupRow>): RealEstateGroupTotals {
  return {
    properties: rows.length,
    cadastralValueTotal: moneyOfCents(rows.reduce((acc, row) => acc + cents(row.cadastralValueTotal), 0)),
    lastValuationValue: moneyOfCents(rows.reduce((acc, row) => acc + cents(row.lastValuationValue), 0)),
    annualTaxBurden: moneyOfCents(rows.reduce((acc, row) => acc + cents(row.annualTaxBurden), 0)),
    openAlertsHigh: rows.reduce((acc, row) => acc + row.openAlertsHigh, 0),
    openAlerts: rows.reduce((acc, row) => acc + row.openAlerts, 0)
  };
}

/** Barras de la carga fiscal anual por centro (solo los centros con importe). */
export function taxBurdenBars(rows: ReadonlyArray<RealEstateGroupRow>): CocoaBarsDatum[] {
  return rows
    .filter((row) => row.annualTaxBurden !== null && cents(row.annualTaxBurden) > 0)
    .map((row) => ({ label: row.propertyCode ?? row.propertyName, value: cents(row.annualTaxBurden) / 100, hint: `${row.propertyName}: ${formatMoney(row.annualTaxBurden)}` }));
}

/** Nombre del fichero que emite el API (`activo-inmobiliario-<what>-<año>.csv`), por si la cabecera no llega. */
export function exportFileNameFor(what: RealEstateExportWhat, year: number): string {
  return `activo-inmobiliario-${what}-${year}.csv`;
}

/** Descarga el CSV de la vista de grupo o del calendario: exportRealEstateCsv → Blob → saveDownload (URL.createObjectURL revocado). Devuelve el nombre del fichero. */
export async function downloadGroupCsv(what: RealEstateExportWhat, year: number, organizationId?: string): Promise<string> {
  const file = await exportRealEstateCsv(what, year, organizationId);
  const filename = downloadFilename(file.contentDisposition, exportFileNameFor(what, year));
  saveDownload({ blob: file.blob, filename, contentType: file.contentType });
  return filename;
}

/** «ene 2026» del mes `month` (1..12) del ejercicio. */
export function monthLabel(year: number, month: number): string {
  return date(`${year}-${String(month).padStart(2, "0")}-01`, "monthYear");
}

/** Ejercicios que ofrece el selector del calendario: el anterior, el actual y el siguiente. */
export function calendarYearOptions(current: number): number[] {
  return [current - 1, current, current + 1];
}

export type GroupViewState = "loading" | "forbidden" | "error" | "empty" | "ready";

export function groupViewState(input: { loading: boolean; error: unknown; overview: RealEstateGroupOverview | null }): GroupViewState {
  if (input.overview) return input.overview.rows.length === 0 ? "empty" : "ready";
  if (input.error !== null && input.error !== undefined) return financeErrorStatus(input.error) === 403 ? "forbidden" : "error";
  return input.loading ? "loading" : "empty";
}

// ---------------------------------------------------------------------------
// Tabla
// ---------------------------------------------------------------------------

function AlertsCell({ row }: { row: RealEstateGroupRow }) {
  if (row.openAlerts === 0) return <>0</>;
  return (
    <span className="cocoa-cluster">
      {row.openAlertsHigh > 0 ? (
        <CocoaBadge tone="danger" size="small" title={plural(row.openAlertsHigh, "alerta alta", "alertas altas")}>
          {row.openAlertsHigh} altas
        </CocoaBadge>
      ) : null}
      <strong>{row.openAlerts}</strong>
    </span>
  );
}

const COLUMNS: CocoaTableColumn<RealEstateGroupRow>[] = [
  { key: "propertyName", label: "Centro", render: (row) => <strong>{row.propertyCode ? `${row.propertyCode} · ${row.propertyName}` : row.propertyName}</strong> },
  {
    key: "tenureKind",
    label: "Tenencia",
    render: (row) =>
      row.tenureKind ? (
        tenureKindLabel(row.tenureKind)
      ) : (
        <CocoaBadge tone="neutral" size="small" title="El centro no tiene ficha de activo inmobiliario">
          Sin ficha
        </CocoaBadge>
      )
  },
  { key: "cadastralValueTotal", label: "Valor catastral", align: "right", render: (row) => formatMoney(row.cadastralValueTotal) },
  { key: "lastValuationValue", label: "Tasación", align: "right", hideOnNarrow: true, render: (row) => formatMoney(row.lastValuationValue) },
  { key: "annualTaxBurden", label: "Carga fiscal", align: "right", render: (row) => formatMoney(row.annualTaxBurden) },
  { key: "documentsValidPct", label: "Documentos vigentes", align: "right", hideOnNarrow: true, render: (row) => formatPercent(row.documentsValidPct) },
  { key: "inspectionsOnTimePct", label: "Inspecciones en plazo", align: "right", hideOnNarrow: true, render: (row) => formatPercent(row.inspectionsOnTimePct) },
  { key: "openAlerts", label: "Alertas", align: "right", render: (row) => <AlertsCell row={row} /> }
];

function footerOf(totals: RealEstateGroupTotals): Record<string, ReactNode> {
  return {
    propertyName: <strong>Total · {plural(totals.properties, "centro", "centros")}</strong>,
    cadastralValueTotal: <strong>{formatMoney(totals.cadastralValueTotal)}</strong>,
    lastValuationValue: <strong>{formatMoney(totals.lastValuationValue)}</strong>,
    annualTaxBurden: <strong>{formatMoney(totals.annualTaxBurden)}</strong>,
    openAlerts: <strong>{totals.openAlertsHigh > 0 ? `${totals.openAlerts} (${totals.openAlertsHigh} altas)` : totals.openAlerts}</strong>
  };
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

export type RealEstateGroupViewProps = {
  organizationId: string;
  overview: RealEstateGroupOverview | null;
  loading: boolean;
  error: unknown;
  calendar: RealEstateCalendarYear | null;
  calendarLoading: boolean;
  calendarError: unknown;
  year: number;
  today: string;
  canExport: boolean;
  selected: RealEstateGroupRow | null;
  selectedDetail: RealEstateAssetDetail | null;
  selectedLoading: boolean;
  selectedError: unknown;
  onYearChange: (year: number) => void;
  onSelect: (row: RealEstateGroupRow | null) => void;
  /** «Operar en este centro»: la única vía que cambia la propiedad activa. */
  onOperate: (row: RealEstateGroupRow) => void;
  onRefresh: () => void;
  onNotify: (message: string, variant: "success" | "error") => void;
};

function GroupKpiStrip({ totals }: { totals: RealEstateGroupTotals }) {
  return (
    <CocoaKpiStrip min={200} aria-label="Resumen del activo inmobiliario del grupo">
      <CocoaKpi label="Centros" value={totals.properties} caption="Con ficha o hotel del ámbito" />
      <CocoaKpi label="Valor catastral" value={formatMoney(totals.cadastralValueTotal)} caption="Suma de los centros" />
      <CocoaKpi label="Última tasación" value={formatMoney(totals.lastValuationValue)} caption="Suma de los centros" />
      <CocoaKpi label="Carga fiscal anual" value={formatMoney(totals.annualTaxBurden)} caption="IBI, IAE y tasas previstos" />
      <CocoaKpi label="Alertas altas" value={totals.openAlertsHigh} status={totals.openAlertsHigh > 0 ? "critical" : totals.openAlerts > 0 ? "warning" : "ok"} caption={plural(totals.openAlerts, "alerta abierta", "alertas abiertas")} />
    </CocoaKpiStrip>
  );
}

function GroupAlerts({ alerts, rows }: { alerts: ReadonlyArray<RealEstateAlert>; rows: ReadonlyArray<RealEstateGroupRow> }) {
  if (alerts.length === 0) return <CocoaState kind="empty" inline title="Sin alertas altas en el grupo." />;
  const nameOf = (propertyId: string) => rows.find((row) => row.propertyId === propertyId)?.propertyName ?? propertyId;
  return (
    <ul className="c22-section__list" aria-label="Alertas altas del grupo">
      {alerts.map((alert) => (
        <li key={`${alert.propertyId}:${alert.kind}:${alert.entityId}:${alert.dueAt}`}>
          <span className="cocoa-cluster">
            <CocoaBadge tone={alertSeverityTone(alert.severity)} size="small">
              {alertKindLabel(alert.kind)}
            </CocoaBadge>
            <span>
              {nameOf(alert.propertyId)} · {alert.message}
            </span>
          </span>
          <span className="cocoa-cluster">
            <CocoaBadge tone="neutral" variant="outline" size="small">
              {alertEntityTypeLabel(alert.entityType)}
            </CocoaBadge>
            <strong>{formatDay(alert.dueAt)}</strong>
          </span>
        </li>
      ))}
    </ul>
  );
}

function MonthCard({ year, month, events, propertyNames }: { year: number; month: number; events: ReadonlyArray<RealEstateCalendarEvent>; propertyNames: ReadonlyMap<string, string> }) {
  return (
    <CocoaSection title={monthLabel(year, month)} meta={events.length > 0 ? plural(events.length, "vencimiento", "vencimientos") : undefined} headingLevel={3} aria-label={`Vencimientos de ${monthLabel(year, month)}`}>
      {events.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin vencimientos." />
      ) : (
        <ul className="c22-section__list" aria-label={`Vencimientos de ${monthLabel(year, month)}`}>
          {events.map((event) => (
            <li key={`${event.propertyId}:${event.kind}:${event.entityId}:${event.dueAt}`}>
              <span>
                {formatDay(event.dueAt)} · {event.label}
              </span>
              <strong>{propertyNames.get(event.propertyId) ?? event.propertyId}</strong>
            </li>
          ))}
        </ul>
      )}
    </CocoaSection>
  );
}

function CalendarGrid({ calendar, loading, error, year }: { calendar: RealEstateCalendarYear | null; loading: boolean; error: unknown; year: number }) {
  if (error) return <CocoaState kind="error" inline title="No se pudo cargar el calendario del grupo" message={realEstateErrorMessage(error)} />;
  if (!calendar) return loading ? <CocoaState kind="loading" inline title={STATUS_LABELS.loading} /> : <CocoaState kind="empty" inline title="Sin calendario." />;
  const propertyNames = new Map(calendar.properties.map((property) => [property.propertyId, property.propertyCode ?? property.propertyName]));
  const months = calendar.months.length === 12 ? calendar.months : Array.from({ length: 12 }, (_, index) => calendar.months.find((month) => month.month === index + 1) ?? { month: index + 1, events: [] });
  return (
    <CocoaGrid columns={12} gap={3} align="start" aria-label={`Calendario anual ${year}`}>
      {months.map((month) => (
        <CocoaSpan key={month.month} cols={3} min={240}>
          <MonthCard year={calendar.year} month={month.month} events={month.events} propertyNames={propertyNames} />
        </CocoaSpan>
      ))}
    </CocoaGrid>
  );
}

/** Presentación de la vista de grupo: todo el estado llega por props (los tests la pintan con react-dom/server). */
export function RealEstateGroupView({
  organizationId,
  overview,
  loading,
  error,
  calendar,
  calendarLoading,
  calendarError,
  year,
  today,
  canExport,
  selected,
  selectedDetail,
  selectedLoading,
  selectedError,
  onYearChange,
  onSelect,
  onOperate,
  onRefresh,
  onNotify
}: RealEstateGroupViewProps) {
  const hosted = useTabHost() !== null;
  const state = groupViewState({ loading, error, overview });
  const [exporting, setExporting] = useState<RealEstateExportWhat | null>(null);
  const [askOperate, setAskOperate] = useState(false);

  async function exportCsv(what: RealEstateExportWhat) {
    if (exporting) return;
    setExporting(what);
    try {
      const filename = await downloadGroupCsv(what, year, organizationId);
      onNotify(`Descargado ${filename}.`, "success");
    } catch (err: unknown) {
      onNotify(realEstateErrorMessage(err, "No se pudo exportar el CSV. Inténtalo de nuevo."), "error");
    } finally {
      setExporting(null);
    }
  }

  const rows = overview?.rows ?? [];
  const totals = groupTotalsOf(rows);
  const bars = taxBurdenBars(rows);
  const currentYear = Number(today.slice(0, 4));
  const yearSelect = (
    <CocoaSelect value={String(year)} onChange={(value) => onYearChange(Number(value))} size="small" inline aria-label="Ejercicio del calendario" options={calendarYearOptions(currentYear).map((option) => ({ value: String(option), label: String(option) }))} />
  );

  let body: ReactNode;
  if (state === "loading") {
    body = <CocoaState kind="loading" title={STATUS_LABELS.loading} />;
  } else if (state === "forbidden") {
    body = <CocoaState kind="error" illustration="error" title={UI_STATES.forbidden.title} message={UI_STATES.forbidden.message} role="alert" />;
  } else if (state === "error") {
    body = <CocoaState kind="error" title="No se pudo cargar la vista de grupo" message={realEstateErrorMessage(error)} onRetry={onRefresh} />;
  } else if (state === "empty" || !overview) {
    body = <CocoaState kind="empty" illustration="box" title={EMPTY_GROUP_TITLE} message={EMPTY_GROUP_MESSAGE} />;
  } else {
    body = (
      <>
        <GroupKpiStrip totals={totals} />
        <CocoaSection title="Centros" meta={plural(rows.length, "centro visible", "centros visibles")} headingLevel={2} padding="none" aria-label="Centros del grupo">
          <CocoaScrollArea aria-label="Tabla de centros">
            <CocoaTable
              columns={COLUMNS}
              rows={rows}
              rowKey="propertyId"
              selectedKey={selected?.propertyId}
              onSelect={(row) => onSelect(row)}
              rowTitle={() => "Abrir el detalle del centro (no cambia el centro activo)"}
              rowTone={(row) => (row.openAlertsHigh > 0 ? "danger" : undefined)}
              footer={footerOf(totals)}
              caption="Centros del grupo con su activo inmobiliario"
              aria-label="Centros del grupo con su activo inmobiliario"
            />
          </CocoaScrollArea>
        </CocoaSection>
        <CocoaSection title="Carga fiscal anual por centro" meta={formatMoney(totals.annualTaxBurden)} headingLevel={2} aria-label="Carga fiscal anual por centro">
          {bars.length === 0 ? <CocoaState kind="empty" inline title="Ningún centro tiene tributos previstos para el ejercicio." /> : <CocoaChart.Bars data={bars} height={160} valueFormat={(value) => formatMoney(value)} aria-label="Carga fiscal anual por centro" />}
        </CocoaSection>
        <CocoaSection title="Calendario anual consolidado" meta={calendar ? plural(calendar.totalEvents, "vencimiento", "vencimientos") : undefined} headingLevel={2} aria-label="Calendario anual consolidado">
          <div className="cocoa-stack" data-gap="3">
            <CocoaToolbar
              variant="content"
              aria-label="Ejercicio del calendario"
              leftSlot={yearSelect}
              rightSlot={
                canExport ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void exportCsv("calendar")} loading={exporting === "calendar"} disabled={exporting !== null}>
                    {EXPORT_CALENDAR_LABEL}
                  </CocoaButton>
                ) : undefined
              }
            />
            <CalendarGrid calendar={calendar} loading={calendarLoading} error={calendarError} year={year} />
          </div>
        </CocoaSection>
        <CocoaSection title="Alertas altas del grupo" meta={plural(overview.alerts.length, "alerta", "alertas")} headingLevel={2} aria-label="Alertas altas del grupo">
          <GroupAlerts alerts={overview.alerts} rows={rows} />
        </CocoaSection>
      </>
    );
  }

  const detailState = assetViewState({ loading: selectedLoading, error: selectedError, detail: selectedDetail });
  let detailBody: ReactNode = null;
  if (selected) {
    if (detailState === "loading") detailBody = <CocoaState kind="loading" title={STATUS_LABELS.loading} />;
    else if (detailState === "forbidden") detailBody = <CocoaState kind="error" illustration="error" title={UI_STATES.forbidden.title} message={UI_STATES.forbidden.message} role="alert" />;
    else if (detailState === "error") detailBody = <CocoaState kind="error" title="No se pudo cargar el centro" message={realEstateErrorMessage(selectedError)} />;
    else if (detailState === "empty" || !selectedDetail) detailBody = <CocoaState kind="empty" illustration="box" title={EMPTY_ASSET_TITLE} message="Opera en este centro para crear su ficha desde la pestaña Ficha." />;
    else detailBody = <RealEstateAssetSummary detail={selectedDetail} legalEntityName={null} />;
  }

  return (
    <CocoaPage
      eyebrow="Finanzas · Activo inmobiliario"
      title="Grupo"
      subtitle={hosted ? undefined : "Los centros de tu ámbito con su tenencia, valores, carga fiscal, cumplimiento documental y alertas; el detalle se abre sin cambiar el centro activo."}
      actions={
        canExport && state === "ready" ? (
          <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={() => void exportCsv("overview")} loading={exporting === "overview"} disabled={exporting !== null}>
            {EXPORT_LABEL}
          </CocoaButton>
        ) : undefined
      }
      commands={[
        { id: "real-estate-group-refresh", label: "Actualizar la vista de grupo", run: onRefresh },
        ...(canExport ? [{ id: "real-estate-group-export", label: EXPORT_LABEL, run: () => void exportCsv("overview") }] : [])
      ]}
    >
      {body}

      <CocoaDrawer
        open={selected !== null}
        onClose={() => onSelect(null)}
        title={selected?.propertyName ?? "Centro"}
        subtitle={selected ? `${selected.propertyCode ? `${selected.propertyCode} · ` : ""}${selected.tenureKind ? tenureKindLabel(selected.tenureKind) : "Sin ficha de activo"}` : undefined}
        side="right"
        size="lg"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => onSelect(null)}>
              {ACTIONS.close}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => setAskOperate(true)} disabled={!selected}>
              {OPERATE_LABEL}
            </CocoaButton>
          </>
        }
      >
        {detailBody}
      </CocoaDrawer>

      <CocoaDialog
        open={askOperate && selected !== null}
        onClose={() => setAskOperate(false)}
        title={`¿Operar en ${selected?.propertyName ?? "este centro"}?`}
        description="Cambia el centro activo de toda la aplicación y recarga la página; el resto de pantallas pasarán a mostrar este centro."
        confirmLabel={OPERATE_LABEL}
        cancelLabel={ACTIONS.cancel}
        onConfirm={() => {
          if (!selected) return;
          setAskOperate(false);
          onOperate(selected);
        }}
      />
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Contenedor: organización activa, permisos, carga y toasts
// ---------------------------------------------------------------------------

export function RealEstateGroupScreen() {
  const active = getActiveProperty();
  const organizationId = active.organizationId;
  const gate = useNavGate();
  const canExport = canDo(gate, READ_PERMISSION);
  const { showToast } = useToast();
  const today = todayIso();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));

  const overview = useResource<RealEstateGroupOverview>(() => getRealEstateGroupOverview(organizationId), organizationId);
  const calendar = useResource<RealEstateCalendarYear>(() => getRealEstateGroupCalendar({ year }, organizationId), `${organizationId}|${year}`);

  const [selected, setSelected] = useState<RealEstateGroupRow | null>(null);
  const selectedId = selected?.propertyId ?? null;
  // Detalle con el id EXPLÍCITO del centro: nunca la propiedad activa.
  const detail = useResource<RealEstateAssetDetail | null>(() => (selectedId ? getRealEstateAsset(selectedId) : Promise.resolve(null)), selectedId ?? "");

  const refreshOverview = overview.refresh;
  const refreshCalendar = calendar.refresh;
  const onRefresh = useCallback(() => {
    refreshOverview();
    refreshCalendar();
  }, [refreshOverview, refreshCalendar]);
  const onNotify = useCallback((message: string, variant: "success" | "error") => showToast(message, { variant }), [showToast]);
  const onOperate = useCallback((row: RealEstateGroupRow) => setActiveProperty({ propertyId: row.propertyId, organizationId, propertyName: row.propertyName }), [organizationId]);

  return (
    <RealEstateGroupView
      organizationId={organizationId}
      overview={overview.data}
      loading={overview.loading}
      error={overview.error}
      calendar={calendar.data}
      calendarLoading={calendar.loading}
      calendarError={calendar.error}
      year={year}
      today={today}
      canExport={canExport}
      selected={selected}
      selectedDetail={selectedId ? detail.data : null}
      selectedLoading={selectedId ? detail.loading : false}
      selectedError={selectedId ? detail.error : null}
      onYearChange={setYear}
      onSelect={setSelected}
      onOperate={onOperate}
      onRefresh={onRefresh}
      onNotify={onNotify}
    />
  );
}

export default RealEstateGroupScreen;
