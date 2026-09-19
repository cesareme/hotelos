// Shift Manager Screen — vista del Jefe de Recepción («Turno», /hoy/turno).
//
// Directriz ehotelOS (Nov 2026):
//   "Jefe de recepción: turno, productividad, incidencias críticas, caja,
//    no-shows, upgrades, conflictos."
//
// Cocoa 22 pilot of the «Hoy» dashboards (docs/design/COCOA-22.md §4):
// CocoaPage → «Productividad del turno» and «Caja del día» sections with
// CocoaKpi strips → operational flags as CocoaCallout cards → the shift
// timeline as a section list with CocoaBadge dots (no emoji, §6).
// Data: GET /dashboards/shift-manager?propertyId= (30 s poll); `degraded[]`
// labels paint «—» through the Degraded* helpers (QC-06).
//
// Tanda UX-1 · lote U6 (docs/design/UX-RECEPCION-FEEL.md §5.12, F15): Turno
// gana dos acciones en cabecera — «Arqueo de caja» (TPV › Cierre de caja) y
// «Cerrar el día» (Hoy › Cierre del día, que recomprueba el preflight al
// pulsar «Cerrar día») — para enlazar el ritual «turno → caja → día» sin
// fusionar pantallas.

import type { CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { ACTIONS, FRONT_DESK_ACTIONS, STATUS_LABELS } from "../../content/actions";
import { money, plural, time } from "../../lib/format";
import { CheckCircleIcon, ExclamationCircleIcon, XCircleIcon } from "../../components/cocoa-icons/StatusIcons";
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
  DegradedBanner,
  DegradedNote,
  DegradedValue,
  isDegraded,
  toneInk,
  type CocoaTone
} from "../../components/cocoa";

type Kpis = {
  checkInsToday: number;
  checkOutsToday: number;
  pendingArrivals: number;
  pendingDepartures: number;
  noShowsToday: number;
  cancellationsToday: number;
  cashCapturedEur: number;
  cashRefundedEur: number;
  unpaidBalanceEur: number;
  unassignedArrivals: number;
  overbookingCount: number;
  emergencyIncidents: number;
  blockedRooms: number;
};

type ShiftEvent = {
  id: string;
  timestamp: string;
  type: string;
  title: string;
  detail?: string;
  amount?: number;
  importance: "info" | "highlight" | "alert";
};

type Flag = { id: string; status: "critical" | "warning" | "ok"; title: string; detail: string };

type Data = {
  generatedAt: string;
  propertyId: string;
  kpis: Kpis;
  events: ShiftEvent[];
  flags: Flag[];
  // QC-06: `safe()` labels whose query failed and fell back to 0/[]. Mirrors
  // `apps/api/src/modules/dashboards/shift-manager.service.ts`.
  degraded: string[];
};

// `safe()` labels in shift-manager.service.ts mapped to the UI slot they feed.
const DEGRADED_LABEL = {
  emergencyFlag: "alerts.emergencyIncidents",
  events: "events.workOrders"
} as const;

// Event type → short Spanish label of the timeline badge (replaces the emoji icons).
const EVENT_LABEL: Record<string, string> = {
  check_in: "Check-in",
  check_out: "Check-out",
  no_show: "No-show",
  cancellation: "Cancelación",
  incident: "Incidencia",
  payment: "Cobro",
  guest_request: "Petición"
};

const IMPORTANCE_TONE: Record<ShiftEvent["importance"], CocoaTone> = {
  alert: "danger",
  highlight: "ai",
  info: "neutral"
};

const FLAG_TONE: Record<Flag["status"], CocoaTone> = {
  critical: "danger",
  warning: "warning",
  ok: "success"
};

const MAX_EVENTS = 30;

function fmtEur(value: number): string {
  return money(value);
}

function fmtTime(iso: string): string {
  return time(iso);
}

/** Percentage of movements already done (0 when nothing is planned). */
function completionRatio(done: number, pending: number): number {
  const total = done + pending;
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

// Text styles the timeline repeats (layout comes from the stylesheet lists).
const detailStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)"
};

const growStyle: CSSProperties = { flex: "1 1 auto" };

/** Amounts: refunds (negative) in the danger ink, the rest in the label colour. */
function amountStyle(amount: number): CSSProperties {
  return { color: amount < 0 ? toneInk("danger") : "var(--cocoa-label)" };
}

function timeStyle(tone: CocoaTone): CSSProperties {
  return {
    fontSize: "var(--cocoa-fs-footnote)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    color: tone === "neutral" ? "var(--cocoa-label-secondary)" : toneInk(tone)
  };
}

function FlagIcon({ status }: { status: Flag["status"] }) {
  if (status === "critical") return <XCircleIcon size={16} />;
  if (status === "warning") return <ExclamationCircleIcon size={16} />;
  return <CheckCircleIcon size={16} />;
}

export function ShiftManagerScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { data, loading, error, refresh } = useApiData<Data>(`/dashboards/shift-manager?propertyId=${propertyId}`, { pollIntervalMs: 30000 });

  const k = data?.kpis;
  const events = toArray<ShiftEvent>(data?.events);
  const flags = toArray<Flag>(data?.flags);
  const degraded = toArray<string>(data?.degraded);
  const completedRatio = k ? completionRatio(k.checkInsToday, k.pendingArrivals) : 0;
  const checkOutRatio = k ? completionRatio(k.checkOutsToday, k.pendingDepartures) : 0;
  const cashNet = k ? k.cashCapturedEur - k.cashRefundedEur : 0;
  const state = loading && !data ? "loading" : error && !data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={`Hoy · ${propertyName}`}
      title="Turno"
      subtitle="Productividad del equipo de recepción, caja del día y bloqueos críticos."
      actions={
        <>
          <DegradedBanner degraded={degraded} />
          {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} aria-label={ACTIONS.refresh} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("CashClosureScreen")} title="Abrir el arqueo de caja del turno (TPV › Cierre de caja)">
            {FRONT_DESK_ACTIONS.cashClosure}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => navigateTo("NightAuditScreen")} title="Ir al cierre del día: las comprobaciones se releen al pulsar «Cerrar día»">
            {FRONT_DESK_ACTIONS.closeDay}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<ShiftSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[
        { id: "shift-refresh", label: "Actualizar el turno", run: refresh },
        { id: "shift-cash-closure", label: FRONT_DESK_ACTIONS.cashClosure, run: () => navigateTo("CashClosureScreen") },
        { id: "shift-close-day", label: FRONT_DESK_ACTIONS.closeDay, run: () => navigateTo("NightAuditScreen") }
      ]}
    >
      {k ? (
        <>
          <CocoaSection title="Productividad del turno" meta={plural(k.pendingArrivals + k.pendingDepartures, "movimiento pendiente", "movimientos pendientes")}>
            <CocoaKpiStrip min={200} aria-label="Productividad del turno">
              <CocoaKpi
                label="Check-ins hechos"
                value={k.checkInsToday}
                unit={`de ${k.checkInsToday + k.pendingArrivals}`}
                deltaLabel={`${completedRatio} % · ${plural(k.pendingArrivals, "pendiente", "pendientes")}`}
                polarity="neutral"
                status="ok"
              />
              <CocoaKpi
                label="Check-outs hechos"
                value={k.checkOutsToday}
                unit={`de ${k.checkOutsToday + k.pendingDepartures}`}
                deltaLabel={`${checkOutRatio} % · ${plural(k.pendingDepartures, "pendiente", "pendientes")}`}
                polarity="neutral"
                status="ok"
              />
              <CocoaKpi label="No-shows" value={k.noShowsToday} deltaLabel="hoy" polarity="neutral" status={k.noShowsToday > 0 ? "warning" : "ok"} />
              <CocoaKpi label="Cancelaciones" value={k.cancellationsToday} deltaLabel="hoy" polarity="neutral" status={k.cancellationsToday > 0 ? "warning" : "ok"} />
            </CocoaKpiStrip>
          </CocoaSection>

          <CocoaSection
            title="Caja del día"
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("FinancePositionDashboard")}>
                {ACTIONS.viewDetail}
              </CocoaButton>
            }
          >
            <CocoaKpiStrip min={200} aria-label="Caja del día">
              <CocoaKpi label="Cobrado hoy" value={fmtEur(k.cashCapturedEur)} status="ok" />
              <CocoaKpi label="Reembolsado" value={fmtEur(k.cashRefundedEur)} status={k.cashRefundedEur > 0 ? "warning" : "ok"} />
              <CocoaKpi label="Neto" value={fmtEur(cashNet)} status="ok" />
              <CocoaKpi label="Saldo abierto" value={fmtEur(k.unpaidBalanceEur)} status={k.unpaidBalanceEur > 0 ? "warning" : "ok"} />
            </CocoaKpiStrip>
          </CocoaSection>
        </>
      ) : null}

      {flags.length > 0 ? (
        <CocoaSection title="Estado operativo" meta={plural(flags.length, "comprobación", "comprobaciones")}>
          <CocoaKpiStrip min={240} aria-label="Estado operativo">
            {flags.map((f) => {
              // The "emergency" flag is computed from a safe()-wrapped counter:
              // when its query failed the API still says "ok · Sin emergencias",
              // so neutralise the tone and show "—" instead of a green tick.
              const flagDegraded = f.id === "emergency" && isDegraded(DEGRADED_LABEL.emergencyFlag, degraded);
              return (
                <CocoaCallout key={f.id} tone={flagDegraded ? "neutral" : FLAG_TONE[f.status]} title={f.title} icon={flagDegraded ? undefined : <FlagIcon status={f.status} />}>
                  {flagDegraded ? (
                    <DegradedValue label={DEGRADED_LABEL.emergencyFlag} degraded={degraded}>
                      {f.detail}
                    </DegradedValue>
                  ) : (
                    f.detail
                  )}
                </CocoaCallout>
              );
            })}
          </CocoaKpiStrip>
        </CocoaSection>
      ) : null}

      <CocoaSection
        title="Eventos del turno"
        meta={
          <>
            <DegradedValue label={DEGRADED_LABEL.events} degraded={degraded}>
              {events.length}
            </DegradedValue>{" "}
            eventos
          </>
        }
      >
        {events.length === 0 ? (
          <DegradedNote label={DEGRADED_LABEL.events} degraded={degraded}>
            <CocoaState kind="empty" inline title="Sin actividad registrada hoy." />
          </DegradedNote>
        ) : (
          <ol className="c22-section__list" aria-label="Eventos del turno">
            {events.slice(0, MAX_EVENTS).map((ev) => {
              const tone = IMPORTANCE_TONE[ev.importance] ?? "neutral";
              return (
                <li key={ev.id}>
                  <CocoaBadge tone={tone} variant="dot" size="small">
                    {EVENT_LABEL[ev.type] ?? ev.type}
                  </CocoaBadge>
                  <div className="cocoa-stack" data-gap="1" style={growStyle}>
                    <div className="cocoa-row" data-gap="2" data-align="baseline">
                      <strong>{ev.title}</strong>
                      {ev.amount !== undefined ? <strong style={amountStyle(ev.amount)}>{fmtEur(ev.amount)}</strong> : null}
                    </div>
                    {ev.detail ? <span style={detailStyle}>{ev.detail}</span> : null}
                  </div>
                  <time dateTime={ev.timestamp} style={timeStyle(tone)}>
                    {fmtTime(ev.timestamp)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

// Mirror skeleton: two KPI sections and the timeline card.
function ShiftSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="card" height={176} />
      <CocoaSkeleton variant="card" height={176} />
      <CocoaSkeleton variant="card" />
    </div>
  );
}

export default ShiftManagerScreen;
