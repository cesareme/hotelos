// Cronología del huésped — Recepción › Huéspedes › Cronología (/recepcion/huespedes/:id/cronologia).
//
// Directriz Anfitorio (Nov 2026):
//   "Cada huésped debe tener una vista tipo timeline, no una ficha fragmentada.
//    Cualquier recepcionista debe entender al huésped en menos de 10 segundos."
//
// Cocoa 22 (ola 3 · lote 3-C): CocoaPage (hosted inside HuespedesTabs the
// container paints «Huéspedes»; standalone the page paints the guest's name)
// → «Perfil» CocoaSection (avatar, residence, identity, notes callout and the
// VIP / loyalty / balance / incidents badges) → CocoaKpiStrip with the six
// metrics → «Reservas vinculadas» CocoaTable → «Historial» CocoaSection with a
// CocoaSegmentedControl filter and the events in an ol.c22-section__list
// (CocoaBadge dot by importance, amount at the right). The guest id comes
// from the tab URL (useRouteParam) or the legacy `?guestId` query; without it
// the page offers a lookup by identifier. Same data: GET /guests/:id/timeline
// (polling 60 s).

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { useTabHost } from "../tabs/TabHost";
import { useRouteParam } from "../tabs/tab-helpers";
import { urlForScreen } from "../../navigation/nav-tree";
import { EMPTY, channelLabel, date, dateRange, dateTime, money, number, plural, relativeTime } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { reservationStatusLabel } from "../operations/frontdesk-labels";
import { BellIcon, InfoCircleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  toneInk,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type Profile = {
  id: string;
  firstName: string;
  surname1?: string;
  surname2?: string;
  fullName: string;
  email?: string;
  phone?: string;
  documentType?: string;
  documentNumber?: string;
  nationality?: string;
  dateOfBirth?: string;
  languagePreference?: string;
  vipCode?: string;
  loyaltyProgram?: string;
  loyaltyTier?: string;
  loyaltyNumber?: string;
  notes?: string;
  preferences?: unknown;
  marketingConsent?: boolean;
  residenceAddress?: string;
  residenceLocality?: string;
  residenceCountry?: string;
};

type Metrics = {
  totalStays: number;
  totalNights: number;
  totalSpendEur: number;
  avgAdrEur: number;
  firstStayDate?: string;
  lastStayDate?: string;
  cancellations: number;
  noShows: number;
  openIncidents: number;
  openBalanceEur: number;
};

type Reservation = {
  id: string;
  code: string;
  propertyId: string;
  propertyName?: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  channel: string;
  roomTypeName?: string;
  totalAmount: number;
  balanceDue: number;
  isPrimary: boolean;
};

type EventType =
  | "reservation_created"
  | "check_in"
  | "check_out"
  | "folio_charge"
  | "payment"
  | "incident_opened"
  | "incident_closed"
  | "special_request"
  | "note"
  | "no_show"
  | "cancellation";

type TLEvent = {
  id: string;
  type: EventType;
  timestamp: string;
  propertyId?: string;
  propertyName?: string;
  reservationId?: string;
  reservationCode?: string;
  title: string;
  subtitle?: string;
  amount?: number;
  amountCurrency?: string;
  importance: "info" | "highlight" | "alert";
};

type TimelineData = {
  profile: Profile;
  metrics: Metrics;
  reservations: Reservation[];
  events: TLEvent[];
};

// ============================================================== display

const TIMELINE_URL = urlForScreen("GuestTimelineScreen") ?? "/recepcion/huespedes/:id/cronologia";

const EVENT_LABEL: Record<EventType, string> = {
  reservation_created: "Reserva",
  check_in: "Check-in",
  check_out: "Check-out",
  folio_charge: "Cargo",
  payment: "Pago",
  incident_opened: "Incidencia",
  incident_closed: "Cierre de incidencia",
  special_request: "Petición",
  note: "Nota",
  no_show: "No-show",
  cancellation: "Cancelación"
};

const IMPORTANCE_TONE: Record<TLEvent["importance"], CocoaTone> = { info: "neutral", highlight: "accent", alert: "danger" };

const RESERVATION_TONE: Record<string, CocoaTone> = {
  draft: "neutral",
  confirmed: "info",
  checked_in: "success",
  checked_out: "neutral",
  cancelled: "danger",
  no_show: "danger"
};

type FilterTab = "all" | "reservations" | "payments" | "incidents" | "notes";

const FILTER_BY_TAB: Record<FilterTab, (e: TLEvent) => boolean> = {
  all: () => true,
  reservations: (e) => e.type === "reservation_created" || e.type === "check_in" || e.type === "check_out" || e.type === "no_show" || e.type === "cancellation",
  payments: (e) => e.type === "payment" || e.type === "folio_charge",
  incidents: (e) => e.type === "incident_opened" || e.type === "incident_closed",
  notes: (e) => e.type === "note" || e.type === "special_request"
};

const FILTER_OPTIONS: Array<{ value: FilterTab; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "reservations", label: "Reservas" },
  { value: "payments", label: "Pagos" },
  { value: "incidents", label: "Incidencias" },
  { value: "notes", label: "Notas" }
];

const RESERVATION_COLUMNS: CocoaTableColumn<Reservation>[] = [
  { key: "code", label: "Código", fit: true, render: (r) => <strong className="cocoa-mono">{r.code}</strong> },
  { key: "propertyName", label: "Propiedad", hideOnNarrow: true, render: (r) => r.propertyName ?? r.propertyId },
  { key: "stay", label: "Estancia", minWidth: 180, render: (r) => `${dateRange(r.arrivalDate, r.departureDate)} · ${plural(r.nights, "noche", "noches")}` },
  {
    key: "roomTypeName",
    label: "Habitación · canal",
    showFrom: "laptop",
    render: (r) => {
      // Channel as a name («Booking.com»); the wire code stays in `title` for support.
      const text = [r.roomTypeName, r.channel ? channelLabel(r.channel) : null].filter(Boolean).join(" · ");
      return text ? <span title={r.channel || undefined}>{text}</span> : EMPTY;
    }
  },
  { key: "totalAmount", label: "Total", align: "right", fit: true, render: (r) => money(r.totalAmount) },
  {
    key: "balanceDue",
    label: "Saldo",
    align: "right",
    fit: true,
    render: (r) =>
      r.balanceDue > 0 ? (
        <CocoaBadge tone="danger" variant="tinted" uppercase={false}>
          {money(r.balanceDue)}
        </CocoaBadge>
      ) : (
        EMPTY
      )
  },
  { key: "status", label: "Estado", fit: true, render: (r) => <CocoaBadge tone={RESERVATION_TONE[r.status] ?? "neutral"}>{reservationStatusLabel(r.status)}</CocoaBadge> }
];

// Avatar with the initials: accent wash, no gradient (§6 of the spec).
const avatarStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 48,
  height: 48,
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-accent-bg)",
  color: toneInk("accent"),
  fontSize: "var(--cocoa-fs-title-2)",
  fontWeight: "var(--cocoa-fw-bold)" as CSSProperties["fontWeight"]
};
const nameStyle: CSSProperties = { fontSize: "var(--cocoa-fs-title-2)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"] };
const growStyle: CSSProperties = { flex: "1 1 240px", minWidth: 0 };
const entryTextStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" };
const paymentAmountStyle: CSSProperties = { color: toneInk("success") };
const lookupRowStyle: CSSProperties = { maxWidth: 560 };

/** Legacy `?guestId` query of the standalone route (the tab URL carries the id itself). */
function legacyQueryGuestId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("guestId");
}

function identityLine(profile: Profile): string {
  return [profile.documentType, profile.documentNumber, profile.nationality, profile.email, profile.phone].filter(Boolean).join(" · ");
}

function TimelineSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={120} />
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton variant="card" height={260} />
    </div>
  );
}

// ============================================================== component

export function GuestTimelineScreen() {
  const hosted = useTabHost() !== null;
  // Guest id from the tab URL `/recepcion/huespedes/:id/cronologia` (Tanda 5),
  // else from the legacy `?guestId` query or the lookup below.
  const routeId = useRouteParam(TIMELINE_URL, "id");
  const [manualId, setManualId] = useState<string | null>(() => legacyQueryGuestId());
  const [draftId, setDraftId] = useState("");
  const guestId = routeId && routeId !== "new" ? routeId : manualId;

  const { data, loading, error, refresh } = useApiData<TimelineData>(guestId ? `/guests/${guestId}/timeline` : null, { pollIntervalMs: 60000 });
  const [tab, setTab] = useState<FilterTab>("all");

  const events = useMemo(() => (data?.events ?? []).filter(FILTER_BY_TAB[tab]), [data?.events, tab]);
  const profile = data?.profile;

  function loadManualId() {
    const val = draftId.trim();
    if (!val) return;
    setManualId(val);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("guestId", val);
      window.history.pushState({}, "", url);
    }
  }

  const pageState = !guestId ? "ready" : loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow="Recepción · Huéspedes"
      title={profile?.fullName ?? "Cronología del huésped"}
      subtitle={hosted ? undefined : profile ? identityLine(profile) || "Cronología de estancias, pagos, incidencias y notas." : "Cronología de estancias, pagos, incidencias y notas."}
      actions={
        <>
          {error && data ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={!guestId} loading={Boolean(guestId) && loading && Boolean(data)}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      skeleton={<TimelineSkeleton />}
      error={{ title: "No se pudo cargar la cronología", message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "guest-timeline-refresh", label: "Actualizar cronología", run: refresh }]}
    >
      {!guestId ? (
        <CocoaSection title="Cronología del huésped" aria-label="Buscar un huésped por identificador">
          <p>Abre la cronología desde la ficha de un huésped o indica su identificador.</p>
          <div className="cocoa-row" data-gap="2" data-align="end" style={lookupRowStyle}>
            <CocoaField label="Identificador del huésped" style={growStyle}>
              <CocoaInput
                value={draftId}
                onChange={setDraftId}
                placeholder="cmpo9uy6v011xfymh5t83j13n"
                autoComplete="off"
                onKeyDown={(event) => {
                  if (event.key === "Enter") loadManualId();
                }}
              />
            </CocoaField>
            <CocoaButton variant="filled" tone="accent" onClick={loadManualId} disabled={!draftId.trim()}>
              Cargar cronología
            </CocoaButton>
          </div>
        </CocoaSection>
      ) : null}

      {data && profile ? (
        <>
          <CocoaSection
            title={hosted ? profile.fullName : "Perfil"}
            aria-label="Perfil del huésped"
            meta={
              <span className="cocoa-cluster">
                {profile.vipCode ? (
                  <CocoaBadge tone="accent" variant="tinted" icon={<StarIcon aria-hidden="true" />}>
                    VIP {profile.vipCode}
                  </CocoaBadge>
                ) : null}
                {profile.loyaltyTier ? (
                  <CocoaBadge tone="info">
                    {profile.loyaltyTier}
                    {profile.loyaltyNumber ? ` · ${profile.loyaltyNumber}` : ""}
                  </CocoaBadge>
                ) : null}
                {data.metrics.openBalanceEur > 0 ? (
                  <CocoaBadge tone="warning" variant="tinted" uppercase={false}>
                    Saldo pendiente {money(data.metrics.openBalanceEur)}
                  </CocoaBadge>
                ) : null}
                {data.metrics.openIncidents > 0 ? (
                  <CocoaBadge tone="danger" variant="tinted" icon={<BellIcon aria-hidden="true" />}>
                    {plural(data.metrics.openIncidents, "incidencia abierta", "incidencias abiertas")}
                  </CocoaBadge>
                ) : null}
              </span>
            }
          >
            <div className="cocoa-row" data-gap="4" data-align="start">
              <span aria-hidden="true" style={avatarStyle}>
                {profile.firstName.slice(0, 1)}
                {profile.surname1?.slice(0, 1) ?? ""}
              </span>
              <div className="cocoa-stack" data-gap="1" style={growStyle}>
                <strong style={nameStyle}>{profile.fullName}</strong>
                <span className="cocoa-caption">
                  {[profile.languagePreference, profile.residenceLocality, profile.residenceCountry].filter(Boolean).join(" · ") || "Sin información de residencia"}
                </span>
                {identityLine(profile) ? <span className="cocoa-caption">{identityLine(profile)}</span> : null}
              </div>
            </div>
            {profile.notes ? (
              <CocoaCallout tone="neutral" title="Notas" icon={<InfoCircleIcon aria-hidden="true" />}>
                {profile.notes}
              </CocoaCallout>
            ) : null}
          </CocoaSection>

          <CocoaKpiStrip stagger aria-label="Métricas del huésped">
            <CocoaKpi
              label="Estancias completadas"
              value={number(data.metrics.totalStays)}
              caption={data.metrics.firstStayDate ? `Desde ${date(data.metrics.firstStayDate, "medium")}` : undefined}
              polarity="neutral"
            />
            <CocoaKpi label="Noches totales" value={number(data.metrics.totalNights)} polarity="neutral" />
            <CocoaKpi label="Gasto histórico" value={money(data.metrics.totalSpendEur)} caption="Valor de vida" polarity="neutral" />
            <CocoaKpi label="ADR medio" value={money(data.metrics.avgAdrEur)} polarity="neutral" />
            <CocoaKpi label="Cancelaciones" value={number(data.metrics.cancellations)} polarity="negative-good" status={data.metrics.cancellations > 0 ? "warning" : undefined} />
            <CocoaKpi label="No-shows" value={number(data.metrics.noShows)} polarity="negative-good" status={data.metrics.noShows > 0 ? "critical" : undefined} />
          </CocoaKpiStrip>

          {data.reservations.length > 0 ? (
            <CocoaSection title="Reservas vinculadas" meta={plural(data.reservations.length, "reserva", "reservas")} padding="none" style={{ overflow: "clip" }}>
              <CocoaTable columns={RESERVATION_COLUMNS} rows={data.reservations} rowKey="id" caption="Reservas vinculadas al huésped" aria-label="Reservas vinculadas" />
            </CocoaSection>
          ) : null}

          <CocoaSection title="Historial" meta={plural(events.length, "evento", "eventos")}>
            <div className="cocoa-row">
              <CocoaSegmentedControl value={tab} onChange={(v) => setTab(v as FilterTab)} options={FILTER_OPTIONS} size="small" aria-label="Filtrar el historial" />
            </div>
            {events.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin eventos para este filtro." />
            ) : (
              <ol className="c22-section__list" aria-label="Eventos del huésped">
                {events.map((event) => (
                  <li key={event.id}>
                    <span style={entryTextStyle}>
                      <span className="cocoa-cluster">
                        <CocoaBadge tone={IMPORTANCE_TONE[event.importance]} variant="dot" size="small">
                          {EVENT_LABEL[event.type] ?? event.type}
                        </CocoaBadge>
                        <strong>{event.title}</strong>
                      </span>
                      {event.subtitle ? <span className="cocoa-caption">{event.subtitle}</span> : null}
                      <span className="cocoa-caption">
                        {relativeTime(event.timestamp)} · {dateTime(event.timestamp, { style: "medium" })}
                        {event.propertyName ? ` · ${event.propertyName}` : ""}
                        {event.reservationCode ? ` · ${event.reservationCode}` : ""}
                      </span>
                    </span>
                    {event.amount !== undefined ? (
                      <strong style={event.type === "payment" ? paymentAmountStyle : undefined}>
                        {event.type === "payment" ? "+" : ""}
                        {money(event.amount, event.amountCurrency)}
                      </strong>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </CocoaSection>
        </>
      ) : null}
    </CocoaPage>
  );
}
