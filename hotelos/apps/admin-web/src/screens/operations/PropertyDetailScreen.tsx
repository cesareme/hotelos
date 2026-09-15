// Property detail — Informes › Cartera de propiedades › Detalle
// (/informes/cartera/:propiedad).
//
// Cocoa 22 (ola 9 · lote 9-A): dashboard hosted in CarteraTabs (the container
// paints eyebrow + H1; this page adds subtitle, actions, the KPI strip, the
// 4/4/4 grid of operations / guest experience / compliance lists and the
// recent-reservations table). The same function works standalone.
//
// `propertyId`: route param of the sub-URL /informes/cartera/:propiedad
// (Tanda 5); falls back to the active property. PortfolioDashboard repoints
// the active property before navigating here, reloading when the scope
// changes.

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { urlForScreen } from "../../navigation/nav-tree";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { date, money, number, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { StarIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type PropertyOverview = {
  property: {
    id: string;
    name: string;
    legalName?: string;
    address?: string;
    city?: string;
    region?: string;
    country: string;
    status: string;
    timezone: string;
    roomsCount: number;
    sesHospedajesEnabled: boolean;
    verifactuEnabled: boolean;
  };
  today: {
    arrivals: number;
    departures: number;
    inHouse: number;
    unassignedRooms: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
  };
  finance: {
    revenueMtdEur: number;
    pendingBalanceEur: number;
    pendingFiscalSubmissions: number;
  };
  operations: {
    housekeepingOpen: number;
    maintenanceOpen: number;
    safetyIncidentsOpen: number;
  };
  guestExperience: {
    openConversations: number;
    avgReviewRating: number;
    pendingReviews: number;
  };
  recentReservations: RecentReservation[];
};

type RecentReservation = {
  id: string;
  code: string;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  status: string;
  balanceEur: number;
};

const RESERVATION_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  confirmed: "Confirmada",
  checked_in: "En casa",
  checked_out: "Salida realizada",
  cancelled: "Cancelada",
  no_show: "No presentado"
};

const RESERVATION_STATUS_TONE: Record<string, CocoaTone> = {
  draft: "neutral",
  confirmed: "info",
  checked_in: "success",
  checked_out: "success",
  cancelled: "danger",
  no_show: "danger"
};

const PROPERTY_STATUS_LABELS: Record<string, string> = {
  open: "Abierta",
  maintenance: "En mantenimiento",
  closed: "Cerrada"
};

const PROPERTY_STATUS_TONE: Record<string, CocoaTone> = {
  open: "success",
  maintenance: "warning",
  closed: "neutral"
};

function fmtPct(value: number | null | undefined): string {
  return percent(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtRating(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  return number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function reservationStatusBadge(status: string) {
  return (
    <CocoaBadge tone={RESERVATION_STATUS_TONE[status] ?? "info"} size="small">
      {RESERVATION_STATUS_LABELS[status] ?? status}
    </CocoaBadge>
  );
}

function balanceBadge(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return (
      <CocoaBadge tone="success" size="small">
        saldado
      </CocoaBadge>
    );
  }
  if (value > 0) {
    return (
      <CocoaBadge tone="warning" size="small">
        pendiente
      </CocoaBadge>
    );
  }
  return (
    <CocoaBadge tone="info" size="small">
      a favor
    </CocoaBadge>
  );
}

function enabledBadge(enabled: boolean) {
  return <CocoaBadge tone={enabled ? "success" : "neutral"}>{enabled ? STATUS_LABELS.enabled : STATUS_LABELS.disabled}</CocoaBadge>;
}

function navToReservation(reservationId: string) {
  if (typeof window === "undefined") return;
  // /recepcion/reservas/:id (Detalle tab of the Reservas container, Tanda 5):
  // ReservationDetailWorkspaceScreen reads its target id from the last path segment.
  const url = urlForScreen("ReservationDetailWorkspace", { id: reservationId });
  if (url) openTabPath(url);
}

// Right-aligned cell with the amount and its badge side by side.
const balanceCellStyle: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--cocoa-space-2)" };

const RESERVATION_COLUMNS: CocoaTableColumn<RecentReservation>[] = [
  { key: "code", label: "Código", render: (row) => <strong>{row.code}</strong> },
  { key: "guestName", label: "Huésped" },
  { key: "arrivalDate", label: "Llegada", render: (row) => date(row.arrivalDate, "short") },
  { key: "departureDate", label: "Salida", render: (row) => date(row.departureDate, "short"), hideOnNarrow: true },
  { key: "status", label: "Estado", render: (row) => reservationStatusBadge(row.status) },
  {
    key: "balanceEur",
    label: "Saldo",
    align: "right",
    render: (row) => (
      <span style={balanceCellStyle}>
        {money(row.balanceEur)}
        {balanceBadge(row.balanceEur)}
      </span>
    )
  }
];

// Row of a section list: text on the left, a plain link-button on the right.
function LinkRow({ label, value, action, screen }: { label: string; value: ReactNode; action: string; screen: ScreenKey }) {
  return (
    <li>
      <span>
        {label} <strong>{value}</strong>
      </span>
      <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo(screen)}>
        {action}
      </CocoaButton>
    </li>
  );
}

// Skeleton espejo: strip of 8 tiles, three cards and the table.
function PropertyDetailSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={96} />
      <CocoaSkeleton.Strip count={8} />
      <CocoaSkeleton.Grid rows={[[4, 4, 4], [12]]} height={200} />
    </div>
  );
}

// `propertyId`: route param of the sub-URL /informes/cartera/:propiedad (Tanda 5); falls back to the active property.
export function PropertyDetailScreen({ propertyId: propertyIdProp }: { propertyId?: string } = {}) {
  // Hosted inside the Cartera de propiedades container (Tanda 5): CocoaPage reads the host and lets the container paint eyebrow + H1.
  // Read through the shared service (single owner of the storage key) at mount time.
  const propertyId = useMemo(() => propertyIdProp ?? getActivePropertyId(), [propertyIdProp]);

  const { data, loading, error, refresh } = useApiData<PropertyOverview>("/dashboards/property-overview", {
    pollIntervalMs: 60000,
    query: { propertyId }
  });

  const property = data?.property;
  const today = data?.today;
  const finance = data?.finance;
  const operations = data?.operations;
  const guestExperience = data?.guestExperience;
  const recentReservations = data?.recentReservations ?? [];

  const locationLine = [property?.city, property?.region, property?.country].filter(Boolean).join(" · ");
  const descriptionLine = property
    ? [
        property.legalName || null,
        locationLine || null,
        property.address || null,
        plural(property.roomsCount, "habitación", "habitaciones"),
        property.timezone
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const pendingFiscal = finance?.pendingFiscalSubmissions ?? 0;
  const pendingBalance = finance?.pendingBalanceEur ?? 0;

  return (
    <CocoaPage
      eyebrow={`Informes · ${property?.name ?? "Cartera de propiedades"}`}
      title={property?.name ?? "Detalle de la propiedad"}
      subtitle="Actividad de hoy, finanzas, operaciones y cumplimiento de la propiedad. Se actualiza cada minuto."
      actions={
        <>
          {loading && data ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("PortfolioDashboard")}>
            Volver a la cartera
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : !data ? "empty" : "ready"}
      skeleton={<PropertyDetailSkeleton />}
      empty={{ title: "Sin datos de la propiedad", message: "El resumen se rellena con la actividad de la propiedad a lo largo del día." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "cartera-propiedad-refresh", label: "Actualizar el detalle de la propiedad", run: refresh },
        { id: "cartera-propiedad-back", label: "Volver a la cartera de propiedades", run: () => navigateTo("PortfolioDashboard") }
      ]}
    >
      {property && today && finance && operations && guestExperience ? (
        <>
          <CocoaSection
            headingLevel={2}
            title={property.name}
            meta={<CocoaBadge tone={PROPERTY_STATUS_TONE[property.status] ?? "info"}>{PROPERTY_STATUS_LABELS[property.status] ?? property.status}</CocoaBadge>}
            aria-label={`Ficha de ${property.name}`}
          >
            <p>{descriptionLine}</p>
          </CocoaSection>

          <CocoaKpiStrip stagger aria-label="Indicadores de hoy">
            <CocoaKpi label="Llegadas hoy" value={number(today.arrivals)} polarity="neutral" status="ok" />
            <CocoaKpi label="Salidas hoy" value={number(today.departures)} polarity="neutral" status="ok" />
            <CocoaKpi label="En casa" value={number(today.inHouse)} deltaLabel="ocupadas ahora" polarity="neutral" status="ok" />
            <CocoaKpi label="Ocupación" value={fmtPct(today.occupancyPct)} deltaLabel="media del mes" polarity="neutral" status="ok" />
            <CocoaKpi label="ADR" value={money(today.adrEur)} status="ok" />
            <CocoaKpi label="RevPAR" value={money(today.revparEur)} status="ok" />
            <CocoaKpi label="Ingresos del mes" value={money(finance.revenueMtdEur)} status="ok" />
            <CocoaKpi label="Saldo pendiente" value={money(finance.pendingBalanceEur)} deltaLabel="cuentas abiertas hoy" polarity="negative-good" status={pendingBalance > 5000 ? "warning" : "ok"} />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Operaciones, experiencia del huésped y cumplimiento" align="start">
            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Operaciones" meta="pendientes">
                <ul className="c22-section__list">
                  <LinkRow label="Pisos: tareas abiertas" value={number(operations.housekeepingOpen)} action="Abrir pisos" screen="HousekeepingDashboard" />
                  <LinkRow label="Mantenimiento: averías abiertas" value={number(operations.maintenanceOpen)} action="Abrir mantenimiento" screen="MaintenanceDashboard" />
                  <LinkRow label="Incidentes de seguridad" value={number(operations.safetyIncidentsOpen)} action="Abrir seguridad" screen="SafetyDashboard" />
                </ul>
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Experiencia del huésped" meta="satisfacción">
                <ul className="c22-section__list">
                  <LinkRow label="Conversaciones abiertas" value={number(guestExperience.openConversations)} action="Abrir bandeja" screen="ConciergeInboxDashboard" />
                  <LinkRow
                    label="Valoración media"
                    value={
                      <>
                        {fmtRating(guestExperience.avgReviewRating)} <StarIcon size={12} aria-hidden="true" />
                      </>
                    }
                    action="Abrir reputación"
                    screen="ReputationDashboard"
                  />
                  <LinkRow label="Reseñas pendientes" value={number(guestExperience.pendingReviews)} action="Responder" screen="ReputationDashboard" />
                </ul>
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={4} min={240}>
              <CocoaSection title="Cumplimiento" meta="postura fiscal">
                <ul className="c22-section__list">
                  <li>
                    <span>
                      Envíos fiscales pendientes{" "}
                      {pendingFiscal > 0 ? (
                        <CocoaBadge tone={pendingFiscal > 5 ? "danger" : "warning"} size="small">
                          {number(pendingFiscal)}
                        </CocoaBadge>
                      ) : (
                        <strong>0</strong>
                      )}
                    </span>
                    <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("FiscalDashboard")}>
                      Abrir centro fiscal
                    </CocoaButton>
                  </li>
                  <li>
                    <span>SES Hospedajes</span>
                    {enabledBadge(property.sesHospedajesEnabled)}
                  </li>
                  <li>
                    <span>VeriFactu</span>
                    {enabledBadge(property.verifactuEnabled)}
                  </li>
                </ul>
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection
            title="Reservas recientes"
            meta={recentReservations.length > 0 ? `${plural(recentReservations.length, "reserva", "reservas")} · una fila abre el detalle` : undefined}
            padding={recentReservations.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {recentReservations.length === 0 ? (
              <CocoaState
                kind="empty"
                inline
                title="No hay reservas recientes"
                message="Las últimas reservas de esta propiedad aparecerán aquí; cada fila abre el detalle de la reserva."
              />
            ) : (
              <CocoaTable
                columns={RESERVATION_COLUMNS}
                rows={recentReservations}
                rowKey="id"
                onSelect={(row) => navToReservation(row.id)}
                caption="Reservas recientes"
                aria-label="Reservas recientes"
              />
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
