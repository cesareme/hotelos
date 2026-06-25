// Guest Timeline Screen — vista única cronológica del huésped.
//
// Directriz Anfitorio (Nov 2026):
//   "Cada huésped debe tener una vista tipo timeline, no una ficha fragmentada.
//    Cualquier recepcionista debe entender al huésped en menos de 10 segundos."
//
// Layout:
//   [Header] nombre + identidad + chips loyalty/VIP/alergias + saldo abierto
//   [Métricas] estancias · noches · gasto · ADR · cancelaciones · no-shows
//   [Tabs filtro] todos / reservas / pagos / incidencias / notas
//   [Timeline vertical] eventos con tipo, importancia y monto

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";

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

const EVENT_ICON: Record<EventType, string> = {
  reservation_created: "📋",
  check_in: "🔑",
  check_out: "👋",
  folio_charge: "🧾",
  payment: "💳",
  incident_opened: "🛎",
  incident_closed: "✅",
  special_request: "💬",
  note: "📝",
  no_show: "⛔",
  cancellation: "❌"
};

const EVENT_LABEL: Record<EventType, string> = {
  reservation_created: "Reserva",
  check_in: "Check-in",
  check_out: "Check-out",
  folio_charge: "Cargo",
  payment: "Pago",
  incident_opened: "Incidencia",
  incident_closed: "Cierre incidencia",
  special_request: "Petición",
  note: "Nota",
  no_show: "No-show",
  cancellation: "Cancelación"
};

type FilterTab = "all" | "reservations" | "payments" | "incidents" | "notes";

const FILTER_BY_TAB: Record<FilterTab, (e: TLEvent) => boolean> = {
  all: () => true,
  reservations: (e) => e.type === "reservation_created" || e.type === "check_in" || e.type === "check_out" || e.type === "no_show" || e.type === "cancellation",
  payments: (e) => e.type === "payment" || e.type === "folio_charge",
  incidents: (e) => e.type === "incident_opened" || e.type === "incident_closed",
  notes: (e) => e.type === "note" || e.type === "special_request"
};

function fmtEur(value: number | undefined | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0,00 €";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function fmtNumber(value: number): string {
  return new Intl.NumberFormat("es-ES").format(value);
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtRelTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Hoy";
  if (days === 1) return "Ayer";
  if (days < 7) return `Hace ${days} días`;
  if (days < 30) return `Hace ${Math.floor(days / 7)} sem.`;
  if (days < 365) return `Hace ${Math.floor(days / 30)} meses`;
  return `Hace ${Math.floor(days / 365)} años`;
}

// ============================================================== component

function getGuestIdFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("guestId");
}

export function GuestTimelineScreen() {
  const [guestId, setGuestId] = useState<string | null>(() => getGuestIdFromQuery());
  const { data, loading, error, refresh } = useApiData<TimelineData>(
    guestId ? `/guests/${guestId}/timeline` : null,
    { pollIntervalMs: 60000 }
  );
  const [tab, setTab] = useState<FilterTab>("all");

  const events = useMemo(() => (data?.events ?? []).filter(FILTER_BY_TAB[tab]), [data?.events, tab]);

  if (!guestId) {
    return (
      <div style={{ padding: 32 }}>
        <h1>Timeline del huésped</h1>
        <p className="bo-muted">
          Para ver el timeline, necesitas un guestId. Abre desde un perfil de huésped o pega un id manualmente:
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 16, maxWidth: 480 }}>
          <input
            type="text"
            placeholder="cmpo9uy6v011xfymh5t83j13n"
            style={{ flex: 1, padding: 8, border: "1px solid var(--border)", borderRadius: 6 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const val = (e.target as HTMLInputElement).value.trim();
                if (val) {
                  setGuestId(val);
                  if (typeof window !== "undefined") {
                    const url = new URL(window.location.href);
                    url.searchParams.set("guestId", val);
                    window.history.pushState({}, "", url);
                  }
                }
              }
            }}
          />
          <button type="button" onClick={() => {
            const input = document.querySelector<HTMLInputElement>('input[type="text"]');
            if (input?.value.trim()) {
              setGuestId(input.value.trim());
            }
          }}>Cargar</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">CRM · Timeline</div>
          <h1 className="bo-page-title">{data?.profile.fullName ?? "Cargando…"}</h1>
          {data?.profile ? (
            <p className="bo-page-subtitle">
              {[data.profile.documentType, data.profile.documentNumber, data.profile.nationality, data.profile.email, data.profile.phone]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="bo-page-head-actions">
          {loading ? <span className="bo-status info">cargando</span> : null}
          {error ? <span className="bo-status error">{error}</span> : null}
          <button type="button" className="ghost" onClick={refresh}>↻</button>
        </div>
      </div>

      {data?.profile ? <ProfileBanner profile={data.profile} metrics={data.metrics} /> : null}
      {data?.metrics ? <MetricsRow metrics={data.metrics} /> : null}
      {data?.reservations.length ? <ReservationsRow reservations={data.reservations} /> : null}

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Historial</h3>
          <span className="bo-muted" style={{ fontSize: 12 }}>{events.length} eventos</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {(Object.keys(FILTER_BY_TAB) as FilterTab[]).map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? "primary" : "ghost"}
              onClick={() => setTab(t)}
              style={{ textTransform: "capitalize" }}
            >
              {t === "all" ? "Todos" : t === "reservations" ? "Reservas" : t === "payments" ? "Pagos" : t === "incidents" ? "Incidencias" : "Notas"}
            </button>
          ))}
        </div>
        {events.length === 0 ? (
          <p className="bo-muted">Sin eventos para este filtro.</p>
        ) : (
          <ol style={{ listStyle: "none", padding: 0, margin: 0, position: "relative" }}>
            {events.map((event, idx) => (
              <TimelineEntry key={event.id} event={event} isLast={idx === events.length - 1} />
            ))}
          </ol>
        )}
      </article>
    </>
  );
}

// ============================================================== sub-components

function ProfileBanner({ profile, metrics }: { profile: Profile; metrics: Metrics }) {
  return (
    <article
      className="bo-card"
      style={{
        background: "linear-gradient(135deg, var(--surface) 0%, var(--surface-elevated, rgba(110, 60, 200, 0.06)) 100%)",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap"
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: profile.vipCode ? "linear-gradient(135deg, #ffd700 0%, #ffa500 100%)" : "linear-gradient(135deg, #6f3ad2 0%, #2663c4 100%)",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          fontWeight: 700
        }}
      >
        {profile.firstName.slice(0, 1)}{profile.surname1?.slice(0, 1) ?? ""}
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong style={{ fontSize: 18 }}>{profile.fullName}</strong>
        <div className="bo-muted" style={{ fontSize: 13, marginTop: 2 }}>
          {[profile.languagePreference, profile.residenceLocality, profile.residenceCountry].filter(Boolean).join(" · ") || "Sin información de residencia"}
        </div>
        {profile.notes ? (
          <div
            style={{
              marginTop: 6,
              padding: "6px 8px",
              background: "var(--surface-elevated, rgba(0,0,0,0.04))",
              borderRadius: 6,
              fontSize: 13,
              borderLeft: "3px solid var(--accent, #6f3ad2)"
            }}
          >
            📝 {profile.notes}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
        {profile.vipCode ? <span className="bo-status accent">⭐ VIP {profile.vipCode}</span> : null}
        {profile.loyaltyTier ? <span className="bo-status info">🎖 {profile.loyaltyTier}{profile.loyaltyNumber ? ` · ${profile.loyaltyNumber}` : ""}</span> : null}
        {metrics.openBalanceEur > 0 ? <span className="bo-status warn">€ {fmtEur(metrics.openBalanceEur)} pendiente</span> : null}
        {metrics.openIncidents > 0 ? <span className="bo-status error">🛎 {metrics.openIncidents} incidencia(s) abiertas</span> : null}
      </div>
    </article>
  );
}

function MetricsRow({ metrics }: { metrics: Metrics }) {
  return (
    <div className="rev-kpi-grid">
      <Kpi label="Estancias completadas" value={fmtNumber(metrics.totalStays)} sublabel={metrics.firstStayDate ? `Desde ${fmtDate(metrics.firstStayDate)}` : undefined} />
      <Kpi label="Noches totales" value={fmtNumber(metrics.totalNights)} />
      <Kpi label="Gasto histórico" value={fmtEur(metrics.totalSpendEur)} sublabel="LTV" tone="ok" />
      <Kpi label="ADR medio" value={fmtEur(metrics.avgAdrEur)} />
      <Kpi label="Cancelaciones" value={fmtNumber(metrics.cancellations)} tone={metrics.cancellations > 0 ? "warn" : "ok"} />
      <Kpi label="No-shows" value={fmtNumber(metrics.noShows)} tone={metrics.noShows > 0 ? "error" : "ok"} />
    </div>
  );
}

function Kpi({ label, value, sublabel, tone }: { label: string; value: string; sublabel?: string; tone?: "ok" | "warn" | "error" }) {
  const klass = tone === "warn" ? "rev-kpi-warn" : tone === "error" ? "rev-kpi-error" : "rev-kpi-ok";
  return (
    <article className={`rev-kpi ${klass}`}>
      <div className="rev-kpi-head">
        <span className="rev-kpi-label">{label}</span>
      </div>
      <div className="rev-kpi-value">{value}</div>
      {sublabel ? <div className="bo-muted" style={{ fontSize: 11, marginTop: 2 }}>{sublabel}</div> : null}
    </article>
  );
}

function ReservationsRow({ reservations }: { reservations: Reservation[] }) {
  return (
    <article className="bo-card" style={{ background: "var(--surface)" }}>
      <div className="bo-card-head">
        <h3 style={{ color: "var(--ink)" }}>Reservas vinculadas</h3>
        <span className="bo-chip">{reservations.length}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
        {reservations.map((r) => (
          <div
            key={r.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 4
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong style={{ fontSize: 14 }}>{r.code}</strong>
              <span className="bo-chip" style={{ fontSize: 10 }}>{r.status}</span>
            </div>
            <div className="bo-muted" style={{ fontSize: 12 }}>{r.propertyName ?? r.propertyId}</div>
            <div style={{ fontSize: 12 }}>
              {fmtDate(r.arrivalDate)} → {fmtDate(r.departureDate)} · {r.nights} noches
            </div>
            <div style={{ fontSize: 12 }}>{r.roomTypeName} · {r.channel}</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 4 }}>
              <span>Total {fmtEur(r.totalAmount)}</span>
              {r.balanceDue > 0 ? <span style={{ color: "var(--danger, #d23b3b)" }}>Saldo {fmtEur(r.balanceDue)}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function TimelineEntry({ event, isLast }: { event: TLEvent; isLast: boolean }) {
  const icon = EVENT_ICON[event.type] ?? "•";
  const importanceColor =
    event.importance === "alert" ? "var(--danger, #d23b3b)" :
    event.importance === "highlight" ? "var(--accent, #6f3ad2)" :
    "var(--muted, #888)";

  return (
    <li style={{ position: "relative", paddingLeft: 32, paddingBottom: isLast ? 0 : 16 }}>
      {/* Vertical line */}
      {!isLast ? (
        <span
          style={{
            position: "absolute",
            left: 11,
            top: 22,
            bottom: -4,
            width: 2,
            background: "var(--border)"
          }}
        />
      ) : null}
      {/* Dot */}
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "var(--surface)",
          border: `2px solid ${importanceColor}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12
        }}
      >
        {icon}
      </span>
      {/* Content */}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>{event.title}</strong>
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--surface-elevated, rgba(0,0,0,0.05))",
              color: "var(--muted, #888)"
            }}
          >
            {EVENT_LABEL[event.type]}
          </span>
          {event.amount !== undefined ? (
            <span style={{ fontWeight: 600, color: event.type === "payment" ? "var(--ok, #1f8a4c)" : "var(--ink)" }}>
              {event.type === "payment" ? "+" : ""}{fmtEur(event.amount)}
            </span>
          ) : null}
        </div>
        {event.subtitle ? (
          <span className="bo-muted" style={{ fontSize: 12 }}>{event.subtitle}</span>
        ) : null}
        <span className="bo-muted" style={{ fontSize: 11 }}>
          {fmtRelTime(event.timestamp)} · {new Date(event.timestamp).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" })}
          {event.propertyName ? ` · ${event.propertyName}` : ""}
          {event.reservationCode ? ` · ${event.reservationCode}` : ""}
        </span>
      </div>
    </li>
  );
}
