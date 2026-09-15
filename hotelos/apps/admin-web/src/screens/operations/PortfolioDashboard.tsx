// Portfolio — Informes › Cartera de propiedades (/informes/cartera).
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CarteraTabs (the container
// paints eyebrow + H1). Two KPI strips (consolidated figures, then pending
// work), the sortable per-property CocoaTable (its own scroller, a row opens
// the property detail) and the critical alerts as CocoaCallouts.

import { useMemo, useState, type CSSProperties } from "react";
import { getActiveOrganizationId, loadSwitchableProperties } from "../../services/activeProperty";
import { urlForScreen } from "../../navigation/nav-tree";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { money, number, percent, plural, time } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { ExclamationCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
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

type PortfolioHealth = "ok" | "warn" | "error";
type PortfolioPropertyStatus = "open" | "closed" | "maintenance";

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

type PortfolioPropertyRow = {
  propertyId: string;
  name: string;
  city?: string;
  region?: string;
  status: PortfolioPropertyStatus;
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
  health: PortfolioHealth;
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

type SortKey =
  | "name"
  | "status"
  | "roomsCount"
  | "occupancyPct"
  | "adrEur"
  | "revparEur"
  | "revenueMtdEur"
  | "pendingFiscalSubmissions"
  | "pendingBalanceEur"
  | "health";

type SortDirection = "asc" | "desc";

const SORT_KEYS: readonly SortKey[] = ["name", "status", "roomsCount", "occupancyPct", "adrEur", "revparEur", "revenueMtdEur", "pendingFiscalSubmissions", "pendingBalanceEur", "health"];

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

function compareRows(a: PortfolioPropertyRow, b: PortfolioPropertyRow, key: SortKey, dir: SortDirection): number {
  const va: number | string = (() => {
    switch (key) {
      case "name":
        return a.name.toLowerCase();
      case "status":
        return a.status;
      case "health":
        return a.health;
      default:
        return a[key] as number;
    }
  })();
  const vb: number | string = (() => {
    switch (key) {
      case "name":
        return b.name.toLowerCase();
      case "status":
        return b.status;
      case "health":
        return b.health;
      default:
        return b[key] as number;
    }
  })();
  let cmp = 0;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb));
  return dir === "asc" ? cmp : -cmp;
}

// Secondary line under the property name (city · region): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

const PROPERTY_COLUMNS: CocoaTableColumn<PortfolioPropertyRow>[] = [
  {
    key: "name",
    label: "Propiedad",
    sortable: true,
    render: (row) => (
      <>
        <strong>{row.name}</strong>
        {row.city || row.region ? <span style={subStyle}>{[row.city, row.region].filter(Boolean).join(" · ")}</span> : null}
      </>
    )
  },
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

  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "revenueMtdEur", dir: "desc" });
  const [drillDownError, setDrillDownError] = useState<string | null>(null);

  function navigateToProperty(propertyId: string) {
    void openPropertyDetail(propertyId).then((problem) => setDrillDownError(problem));
  }

  // Controlled sort (the table never sorts by itself): toggling the same key
  // flips the direction; a new key starts text ascending, numbers descending.
  function onSort(next: CocoaTableSort) {
    const key = SORT_KEYS.find((candidate) => candidate === next.key);
    if (!key) return;
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      const dir: SortDirection = key === "name" || key === "status" || key === "health" ? "asc" : "desc";
      return { key, dir };
    });
  }

  const sortedProperties = useMemo(() => {
    const copy = properties.slice();
    copy.sort((a, b) => compareRows(a, b, sort.key, sort.dir));
    return copy;
  }, [properties, sort]);

  const noProperties = properties.length === 0 && !loading;
  const singleProperty = properties.length === 1;
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
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<PortfolioSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "cartera-refresh", label: "Actualizar la cartera de propiedades", run: refresh }]}
    >
      <CocoaKpiStrip stagger aria-label="Cifras consolidadas de la cartera">
        <CocoaKpi label="Propiedades" value={number(totals.propertiesCount)} deltaLabel="total en la organización" polarity="neutral" status="ok" />
        <CocoaKpi label="Activas" value={number(totals.activePropertiesCount)} deltaLabel="operando ahora" polarity="neutral" status="ok" />
        <CocoaKpi label="Habitaciones" value={number(totals.roomsCount)} deltaLabel="en todas las propiedades" polarity="neutral" status="ok" />
        <CocoaKpi label="Llegadas hoy" value={number(totals.arrivalsToday)} polarity="neutral" status="ok" />
        <CocoaKpi label="Salidas hoy" value={number(totals.departuresToday)} polarity="neutral" status="ok" />
        <CocoaKpi label="En casa" value={number(totals.inHouseNow)} deltaLabel="ocupadas actualmente" polarity="neutral" status="ok" />
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

      <CocoaSection
        title="Propiedades"
        meta={noProperties ? undefined : `${plural(properties.length, "propiedad", "propiedades")} · una fila abre el detalle`}
        padding={noProperties ? "md" : "none"}
        style={{ overflow: "clip" }}
      >
        {noProperties ? (
          <CocoaState
            kind="empty"
            title="Esta organización no tiene propiedades configuradas todavía"
            message="Da de alta una propiedad para empezar a consolidar KPIs aquí."
          />
        ) : (
          <CocoaTable
            columns={PROPERTY_COLUMNS}
            rows={sortedProperties}
            rowKey="propertyId"
            sortBy={{ key: sort.key, direction: sort.dir }}
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
    </CocoaPage>
  );
}
