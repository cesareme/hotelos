// Portfolio — Informes › Cartera de propiedades (/informes/cartera).
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CarteraTabs (the container
// paints eyebrow + H1). Two KPI strips (consolidated figures, then pending
// work), the sortable per-property CocoaTable (its own scroller, a row opens
// the property detail) and the critical alerts as CocoaCallouts.
//
// Tanda UX-2 (lote D6 · F-D9): inner views «Tabla · Comparar» as CocoaPage
// `tabs` (pattern of OperationsDirectorScreen). «Comparar» is the same table
// with occupancy / ADR / RevPAR / revenue of the month plus a delta column per
// metric against the simple average of the portfolio (badge with a tone by
// sign; the average itself in the totals row) and starts by occupancy; with one
// hotel it says so instead of hiding. Pure helpers (average, delta, order) live
// in portfolio-compare.ts; ⌘K «Comparar hoteles» / «Ordenar por …».

import { useMemo, useState, type CSSProperties } from "react";
import { getActiveOrganizationId, loadSwitchableProperties } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { money, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { DIRECCION_CARTERA_INSTRUCTIONS } from "../../content/screen-instructions/direccion";
import { ExclamationCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  COMPARE_DEFAULT_SORT,
  TABLE_DEFAULT_SORT,
  canCompare,
  compareView,
  deltaLabel,
  deltaTone,
  nextSort,
  sortKeyOf,
  sortRows,
  type CompareMetric,
  type CompareRow,
  type PortfolioHealth,
  type PortfolioPropertyRow,
  type PortfolioPropertyStatus,
  type PortfolioSort,
  type SortKey
} from "./portfolio-compare";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTableSort,
  type CocoaTone
} from "../../components/cocoa";

const ORGANIZATION_ID = getActiveOrganizationId();
// Path registered for PropertyDetailScreen in routes/backoffice.routes.tsx.

type PortfolioTotals = {
  propertiesCount: number;
  activePropertiesCount: number;
  roomsCount: number;
  arrivalsToday: number;
  departuresToday: number;
  inHouseNow: number;
  occupancyPct: number;
  adrEur: number;
  revparEur: number;
  revenueMtdEur: number;
  pendingFiscalSubmissions: number;
  pendingBalanceEur: number;
  unattended: { reservations: number; messages: number; tasks: number };
};

type PortfolioAlert = {
  propertyId: string;
  severity: "critical" | "warning";
  title: string;
  description: string;
};

type PortfolioDashboardData = {
  organizationId: string;
  asOf: string;
  totals: PortfolioTotals;
  perProperty: PortfolioPropertyRow[];
  alerts: PortfolioAlert[];
};

// Inner views of the page (CocoaPage `tabs`): the table of today, or the comparison.
type PortfolioView = "tabla" | "comparar";

const PORTFOLIO_VIEWS: Array<{ value: PortfolioView; label: string }> = [
  { value: "tabla", label: "Tabla" },
  { value: "comparar", label: "Comparar" }
];

const HEALTH_LABEL: Record<PortfolioHealth, string> = {
  ok: "saludable",
  warn: "atención",
  error: "crítica"
};

const HEALTH_TONE: Record<PortfolioHealth, CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

const STATUS_LABEL: Record<PortfolioPropertyStatus, string> = {
  open: "abierta",
  closed: "cerrada",
  maintenance: "mantenimiento"
};

const STATUS_TONE: Record<PortfolioPropertyStatus, CocoaTone> = { open: "success", maintenance: "warning", closed: "info" };

function fmtPct(value: number | null | undefined): string {
  return percent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Drill-down to a property of the portfolio: the row must be one of the user's
// switchable properties (never a raw id from the table), then the detail
// sub-URL is opened in place. Resolves to a user-facing problem message when
// the drill-down cannot happen.
async function openPropertyDetail(propertyId: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  let list;
  try {
    list = await loadSwitchableProperties();
  } catch (err) {
    return err instanceof Error ? err.message : "No se pudieron cargar las propiedades.";
  }
  const row = list.find((property) => property.id === propertyId);
  if (!row) return "La propiedad seleccionada no está disponible para tu usuario.";
  // Detalle de la propiedad: /informes/cartera/:propiedad (sub-URL of the Cartera
  // container, Tanda 5). The id travels in the URL, so the active property and
  // the page do not change (PropertyDetailScreen reads `propertyId` from it).
  const url = urlForScreen("PropertyDetailScreen", { propiedad: row.id });
  if (!url) return "No se pudo abrir el detalle de la propiedad.";
  openTabPath(url);
  return null;
}

// Secondary line under the property name (city · region): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

const NAME_COLUMN: CocoaTableColumn<PortfolioPropertyRow> = {
  key: "name",
  label: "Propiedad",
  sortable: true,
  render: (row) => (
    <>
      <strong>{row.name}</strong>
      {row.city || row.region ? <span style={subStyle}>{[row.city, row.region].filter(Boolean).join(" · ")}</span> : null}
    </>
  )
};

const PROPERTY_COLUMNS: CocoaTableColumn<PortfolioPropertyRow>[] = [
  NAME_COLUMN,
  { key: "status", label: "Estado", sortable: true, render: (row) => <CocoaBadge tone={STATUS_TONE[row.status] ?? "info"}>{STATUS_LABEL[row.status] ?? row.status}</CocoaBadge> },
  { key: "roomsCount", label: "Habitaciones", sortable: true, align: "right", render: (row) => number(row.roomsCount), hideOnNarrow: true },
  { key: "occupancyPct", label: "Ocupación", sortable: true, align: "right", render: (row) => fmtPct(row.occupancyPct) },
  { key: "adrEur", label: "ADR", sortable: true, align: "right", render: (row) => money(row.adrEur), hideOnNarrow: true },
  { key: "revparEur", label: "RevPAR", sortable: true, align: "right", render: (row) => money(row.revparEur), hideOnNarrow: true },
  { key: "revenueMtdEur", label: "Ingresos del mes", sortable: true, align: "right", render: (row) => <strong>{money(row.revenueMtdEur)}</strong> },
  {
    key: "pendingFiscalSubmissions",
    label: "Fiscal pendiente",
    sortable: true,
    align: "right",
    render: (row) =>
      row.pendingFiscalSubmissions > 0 ? (
        <CocoaBadge tone={row.pendingFiscalSubmissions > 5 ? "danger" : "warning"} size="small">
          {number(row.pendingFiscalSubmissions)}
        </CocoaBadge>
      ) : (
        "0"
      ),
    hideOnNarrow: true
  },
  { key: "pendingBalanceEur", label: "Saldo pendiente", sortable: true, align: "right", render: (row) => money(row.pendingBalanceEur), hideOnNarrow: true },
  { key: "health", label: "Salud", sortable: true, render: (row) => <CocoaBadge tone={HEALTH_TONE[row.health] ?? "info"}>{HEALTH_LABEL[row.health] ?? row.health}</CocoaBadge> }
];

// «Comparar»: each metric column is followed by its delta against the simple
// average of the portfolio (portfolio-compare.ts). The delta column orders by
// its metric (sortKeyOf) and the badge takes its tone from the sign.
const COMPARE_METRIC_COLUMNS: ReadonlyArray<{ metric: CompareMetric; label: string; format: (value: number) => string }> = [
  { metric: "occupancyPct", label: "Ocupación", format: fmtPct },
  { metric: "adrEur", label: "ADR", format: (value) => money(value) },
  { metric: "revparEur", label: "RevPAR", format: (value) => money(value) },
  { metric: "revenueMtdEur", label: "Ingresos del mes", format: (value) => money(value) }
];

function metricColumn(metric: CompareMetric, label: string, format: (value: number) => string): CocoaTableColumn<CompareRow> {
  return { key: metric, label, sortable: true, align: "right", render: (row) => format(row[metric]) };
}

/**
 * Window of «Llegadas hoy · Salidas hoy · En el hotel» (P7, corrector UX2-REV-01): GET /dashboards/portfolio counts each
 * property on ITS business date (`perProperty[].businessDate`, same reader as Mi día › Dirección); the strip sums them.
 * Mi día › Dirección counts only the PENDING arrivals/departures of that date; here every one of the day (each labelled).
 */
const TODAY_WINDOW = "fecha de negocio de cada hotel";

function deltaColumn(metric: CompareMetric, label: string): CocoaTableColumn<CompareRow> {
  return {
    key: `delta:${metric}`,
    label: `${label} vs media`,
    sortable: true,
    align: "right",
    render: (row) => (
      <CocoaBadge tone={deltaTone(row.delta[metric])} size="small" uppercase={false}>
        {deltaLabel(metric, row.delta[metric])}
      </CocoaBadge>
    )
  };
}

const COMPARE_COLUMNS: CocoaTableColumn<CompareRow>[] = [
  NAME_COLUMN,
  ...COMPARE_METRIC_COLUMNS.flatMap(({ metric, label, format }) => [metricColumn(metric, label, format), deltaColumn(metric, label)])
];

const EMPTY_TOTALS: PortfolioTotals = {
  propertiesCount: 0,
  activePropertiesCount: 0,
  roomsCount: 0,
  arrivalsToday: 0,
  departuresToday: 0,
  inHouseNow: 0,
  occupancyPct: 0,
  adrEur: 0,
  revparEur: 0,
  revenueMtdEur: 0,
  pendingFiscalSubmissions: 0,
  pendingBalanceEur: 0,
  unattended: { reservations: 0, messages: 0, tasks: 0 }
};

// Skeleton espejo: two strips, the table card and the alerts card.
function PortfolioSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={10} />
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton variant="card" height={320} />
      <CocoaSkeleton variant="card" height={160} />
    </div>
  );
}

export function PortfolioDashboard() {
  // Hosted inside the Cartera de propiedades container (Tanda 5): CocoaPage reads the host and lets the container paint eyebrow + H1.
  const { data, loading, error, refresh } = useApiData<PortfolioDashboardData>(`/dashboards/portfolio?organizationId=${ORGANIZATION_ID}`, {
    pollIntervalMs: 60000
  });

  const totals = data?.totals ?? EMPTY_TOTALS;
  const properties = toArray<PortfolioPropertyRow>(data?.perProperty);
  const alerts = toArray<PortfolioAlert>(data?.alerts);

  const [view, setView] = useState<PortfolioView>("tabla");
  const [tableSort, setTableSort] = useState<PortfolioSort>(TABLE_DEFAULT_SORT);
  const [compareSort, setCompareSort] = useState<PortfolioSort>(COMPARE_DEFAULT_SORT);
  const [drillDownError, setDrillDownError] = useState<string | null>(null);
  const comparing = view === "comparar";

  function navigateToProperty(propertyId: string) {
    void openPropertyDetail(propertyId).then((problem) => setDrillDownError(problem));
  }

  // Controlled sort (the table never sorts by itself): each view keeps its own
  // order; toggling the same key flips the direction, a new key starts text
  // ascending and numbers descending; a delta column orders by its metric.
  function onSort(next: CocoaTableSort) {
    const key = sortKeyOf(next.key);
    if (!key) return;
    (comparing ? setCompareSort : setTableSort)((prev) => nextSort(prev, key));
  }

  // ⌘K «Ordenar por ocupación / ingresos»: the active view, best first.
  function sortByMetric(key: SortKey) {
    (comparing ? setCompareSort : setTableSort)({ key, dir: "desc" });
  }

  const sortedProperties = useMemo(() => sortRows(properties, tableSort), [properties, tableSort]);
  const comparison = useMemo(() => compareView(properties, compareSort), [properties, compareSort]);

  const noProperties = properties.length === 0 && !loading;
  const singleProperty = properties.length === 1;
  const comparable = canCompare(properties);
  const showTable = !noProperties && (!comparing || comparable);
  const propertiesMeta = noProperties
    ? undefined
    : comparing
      ? comparable
        ? `${plural(properties.length, "hotel", "hoteles")} · delta frente a la media simple de la cartera · una fila abre el detalle`
        : undefined
      : `${plural(properties.length, "propiedad", "propiedades")} · una fila abre el detalle`;
  const compareFooter = {
    name: "Media simple de la cartera",
    occupancyPct: fmtPct(comparison.average.occupancyPct),
    adrEur: money(comparison.average.adrEur),
    revparEur: money(comparison.average.revparEur),
    revenueMtdEur: money(comparison.average.revenueMtdEur)
  };
  const fiscalStatus = totals.pendingFiscalSubmissions > 5 ? "critical" : totals.pendingFiscalSubmissions > 0 ? "warning" : "ok";

  return (
    <CocoaPage
      eyebrow="Informes · Cartera de propiedades"
      title="Cartera de propiedades"
      subtitle={`Vista consolidada del grupo hotelero: KPIs agregados con media ponderada por habitaciones y detalle por propiedad, para cadenas con 3–50+ hoteles${data ? ` · datos a ${time(data.asOf)}` : ""}.`}
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          {drillDownError ? (
            <CocoaBadge tone="danger" role="alert">
              {drillDownError}
            </CocoaBadge>
          ) : null}
          {singleProperty ? <CocoaBadge tone="neutral">organización con una sola propiedad</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      tabs={PORTFOLIO_VIEWS}
      activeTab={view}
      onTabChange={(value) => setView(value === "comparar" ? "comparar" : "tabla")}
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<PortfolioSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "cartera-refresh", label: "Actualizar la cartera de propiedades", run: refresh },
        { id: "cartera-comparar", label: "Comparar hoteles", run: () => setView("comparar") },
        { id: "cartera-ordenar-ocupacion", label: "Ordenar por ocupación", run: () => sortByMetric("occupancyPct") },
        { id: "cartera-ordenar-ingresos", label: "Ordenar por ingresos", run: () => sortByMetric("revenueMtdEur") }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Cifras consolidadas de la cartera">
        <CocoaKpi label="Propiedades" value={number(totals.propertiesCount)} deltaLabel="total en la organización" polarity="neutral" status="ok" />
        <CocoaKpi label="Activas" value={number(totals.activePropertiesCount)} deltaLabel="operando ahora" polarity="neutral" status="ok" />
        <CocoaKpi label="Habitaciones" value={number(totals.roomsCount)} deltaLabel="en todas las propiedades" polarity="neutral" status="ok" />
        <CocoaKpi label="Llegadas hoy" value={number(totals.arrivalsToday)} caption={TODAY_WINDOW} polarity="neutral" status="ok" />
        <CocoaKpi label="Salidas hoy" value={number(totals.departuresToday)} caption={TODAY_WINDOW} polarity="neutral" status="ok" />
        <CocoaKpi label="En el hotel" value={number(totals.inHouseNow)} caption={TODAY_WINDOW} deltaLabel="ocupadas actualmente" polarity="neutral" status="ok" />
        <CocoaKpi label="Ocupación cartera" value={fmtPct(totals.occupancyPct)} deltaLabel="ponderada por habitaciones" status="ok" />
        <CocoaKpi label="ADR cartera" value={money(totals.adrEur)} deltaLabel="ponderado por habitaciones" status="ok" />
        <CocoaKpi label="RevPAR cartera" value={money(totals.revparEur)} deltaLabel="ponderado por habitaciones" status="ok" />
        <CocoaKpi label="Ingresos del mes" value={money(totals.revenueMtdEur)} deltaLabel="suma de todas las propiedades" status="ok" />
      </CocoaKpiStrip>

      <CocoaKpiStrip aria-label="Pendientes de la cartera">
        <CocoaKpi label="Envíos fiscales pendientes" value={number(totals.pendingFiscalSubmissions)} deltaLabel="VeriFactu · TBAI · IGIC · SES" polarity="negative-good" status={fiscalStatus} />
        <CocoaKpi label="Saldo pendiente (hoy)" value={money(totals.pendingBalanceEur)} deltaLabel="cuentas abiertas en todas las propiedades" polarity="negative-good" status={totals.pendingBalanceEur > 5000 ? "warning" : "ok"} />
        <CocoaKpi label="Reservas sin atender" value={number(totals.unattended.reservations)} deltaLabel="borrador o sin confirmar" polarity="negative-good" status={totals.unattended.reservations > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Mensajes sin atender" value={number(totals.unattended.messages)} deltaLabel="conversaciones abiertas" polarity="negative-good" status={totals.unattended.messages > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Tareas sin atender" value={number(totals.unattended.tasks)} deltaLabel="limpiezas pendientes" polarity="negative-good" status={totals.unattended.tasks > 0 ? "warning" : "ok"} />
      </CocoaKpiStrip>

      <CocoaSection title={comparing ? "Comparar hoteles" : "Propiedades"} meta={propertiesMeta} padding={showTable ? "none" : "md"} style={{ overflow: "clip" }}>
        {noProperties ? (
          <CocoaState
            kind="empty"
            title="Esta organización no tiene propiedades configuradas todavía"
            message="Da de alta una propiedad para empezar a consolidar KPIs aquí."
          />
        ) : comparing && !comparable ? (
          <CocoaState
            kind="empty"
            inline
            title="Solo hay un hotel: la comparación aparece con dos o más"
            message="La media de la cartera sería este mismo hotel y el delta no diría nada. La vista «Tabla» muestra sus cifras."
          />
        ) : comparing ? (
          <CocoaTable
            columns={COMPARE_COLUMNS}
            rows={comparison.rows}
            rowKey="propertyId"
            sortBy={{ key: compareSort.key, direction: compareSort.dir }}
            onSort={onSort}
            onSelect={(row) => navigateToProperty(row.propertyId)}
            footer={compareFooter}
            stickyFirstColumn
            maxHeight={520}
            caption="Comparativa de la cartera"
            aria-label="Comparativa de la cartera"
          />
        ) : (
          <CocoaTable
            columns={PROPERTY_COLUMNS}
            rows={sortedProperties}
            rowKey="propertyId"
            sortBy={{ key: tableSort.key, direction: tableSort.dir }}
            onSort={onSort}
            onSelect={(row) => navigateToProperty(row.propertyId)}
            stickyFirstColumn
            maxHeight={520}
            caption="Propiedades de la cartera"
            aria-label="Propiedades de la cartera"
          />
        )}
      </CocoaSection>

      <CocoaSection title="Alertas críticas" meta={`${number(alerts.length)} activas`}>
        {alerts.length === 0 ? (
          <CocoaState
            kind="empty"
            inline
            title="No hay alertas críticas."
            message="Toda la cartera opera dentro de umbrales. Si alguna propiedad cruza un límite verás aquí la alerta con su severidad y el enlace directo."
          />
        ) : (
          <div className="cocoa-stack" data-gap="2" role="list" aria-label="Alertas críticas">
            {alerts.map((alert, idx) => (
              <div key={`${alert.propertyId}-${idx}`} role="listitem">
                <CocoaCallout
                  tone={alert.severity === "critical" ? "danger" : "warning"}
                  title={alert.title}
                  icon={alert.severity === "critical" ? <XCircleIcon size={16} aria-hidden="true" /> : <ExclamationCircleIcon size={16} aria-hidden="true" />}
                  actions={
                    <>
                      <CocoaBadge tone={alert.severity === "critical" ? "danger" : "warning"} size="small">
                        {alert.severity === "critical" ? "crítica" : "aviso"}
                      </CocoaBadge>
                      <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateToProperty(alert.propertyId)}>
                        Abrir propiedad
                      </CocoaButton>
                    </>
                  }
                >
                  {alert.description}
                </CocoaCallout>
              </div>
            ))}
          </div>
        )}
      </CocoaSection>

      {/* Ayuda contextual honesta (UX-2 · D8): solo lo que existe en la cartera y su detalle; se descarta una vez. */}
      <CocoaScreenInstructionsCard {...DIRECCION_CARTERA_INSTRUCTIONS} dismissible persistKey="direccion-cartera" />
    </CocoaPage>
  );
}
