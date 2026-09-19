// Live Timeline · inspector (Tanda TL · lote TL-4).
//
// Ficha de la reserva seleccionada: chips de estado, huéspedes, hechos (folio
// y actividad incluidos), actividad reciente, accesos directos y acciones.
// Dos envolturas según el viewport (useIsNarrow): en escritorio y tableta es
// un PANEL ACOPLADO NO MODAL (`tl-panel`, role="complementary", sin scrim ni
// focus trap: la parrilla sigue viva y las flechas siguen moviendo la
// selección, como el panel lateral de Mews / FNS); en teléfonos, una hoja
// inferior (CocoaDrawer). `focusToken` sube cuando el detalle se abre con
// teclado: el panel toma el foco (tabIndex −1) para que Tab llegue a sus
// acciones; con ratón el foco se queda en la barra. Sin red: la reserva, el
// folio, la actividad y el nombre del huésped llegan por props desde
// LiveTimeline.tsx (TL-5), igual que los callbacks. Sin estilos en línea: la
// rejilla de hechos es `.tl-facts` y el panel `.tl-panel*`
// (styles/cocoa-22-timeline.css), el resto utilidades de cocoa-base.css. Las
// reglas de habilitación de las acciones son las del API (pms.service.ts:
// check-in solo confirmed, cancelar 409 en casa o cerrada).

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { AdminReservation, AdminRoom, AdminRoomType, FolioBalance, GuestActivity } from "../../services/pmsCommerceApi";
import { A11Y_LABELS, ACTIONS } from "../../content/actions";
import { EMPTY, channelLabel, date, money, plural } from "../../lib/format";
import { BAR_KIND_LABEL, BAR_KIND_TONE, RES_STATUS_LABEL, activityLabel, nightsOf, type BarKind } from "../../screens/timeline/timeline-engine";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDrawer, CocoaKbd, CocoaSection, CocoaStat, CocoaState, useIsNarrow } from "../cocoa";

export type TimelineNavigateTarget = "HousekeepingDashboard" | "MaintenanceDashboard" | "ConciergeInboxDashboard";
export type TimelineInspectorAction = "checkin" | "checkout" | "cancel" | "noshow" | "assign";

export interface TimelineInspectorProps {
  res: AdminReservation | null;
  /** Nombre del bloque (`guestLabel` del motor). */
  label: string;
  room?: AdminRoom;
  roomType?: AdminRoomType;
  kind: BarKind | null;
  folio: FolioBalance | null;
  /** 404 del folio: la reserva aún no tiene folio (no es un error). */
  folioMissing: boolean;
  activity: GuestActivity | null;
  /** Nombre resuelto del huésped principal, si TL-5 lo conoce. */
  guestName?: string | null;
  loading: boolean;
  /** Fallo del folio o de la actividad: se muestra en línea, nunca como hechos en blanco. */
  error: string | null;
  /** Sube cada vez que el detalle se abre con teclado (el panel acoplado toma el foco). */
  focusToken?: number;
  onClose(): void;
  onOpenReservation(): void;
  onOpenJourney(): void;
  /** Folio de la reserva (FolioDetail): solo se ofrece cuando el folio existe. */
  onOpenFolio?(): void;
  onNavigate(screen: TimelineNavigateTarget): void;
  onAction(type: TimelineInspectorAction): void;
}

const ACTIVITY_LIMIT = 6;
export const CHECKIN_NEEDS_ROOM = "Asigna una habitación antes del check-in";
export const OPEN_RESERVATION_LABEL = "Abrir reserva";
export const FOLIO_LINK_LABEL = "Folio y facturación";
export const NO_ROOM_SUBTITLE = "Sin habitación";

const NO_ASSIGN_STATUSES = new Set(["cancelled", "no_show", "checked_out"]);
const NO_CANCEL_STATUSES = new Set(["checked_in", "checked_out", "cancelled", "no_show"]);
const NO_SHOW_STATUSES = new Set(["confirmed", "draft"]);

export type InspectorActionState = {
  checkin: boolean;
  /** Tooltip del check-in deshabilitado cuando solo falta la habitación. */
  checkinTitle?: string;
  checkout: boolean;
  assign: boolean;
  assignLabel: "Asignar habitación" | "Cambiar habitación";
  cancel: boolean;
  noshow: boolean;
};

/** Reglas de habilitación (puras): espejo de pms.service.ts. */
export function inspectorActionState(res: Pick<AdminReservation, "status" | "assignedRoomId">): InspectorActionState {
  const hasRoom = Boolean(res.assignedRoomId);
  const confirmed = res.status === "confirmed";
  return {
    checkin: confirmed && hasRoom,
    checkinTitle: confirmed && !hasRoom ? CHECKIN_NEEDS_ROOM : undefined,
    checkout: res.status === "checked_in",
    assign: !NO_ASSIGN_STATUSES.has(res.status),
    assignLabel: hasRoom ? "Cambiar habitación" : "Asignar habitación",
    cancel: !NO_CANCEL_STATUSES.has(res.status),
    noshow: NO_SHOW_STATUSES.has(res.status)
  };
}

/** «Ana Pérez · Hab. 202» (puro). */
export function inspectorSubtitle(label: string, room?: Pick<AdminRoom, "number">): string {
  return `${label} · ${room ? `Hab. ${room.number}` : NO_ROOM_SUBTITLE}`;
}

export function TimelineInspector(props: TimelineInspectorProps) {
  const narrow = useIsNarrow();
  if (narrow) return <TimelineInspectorSheet {...props} />;
  return <TimelineInspectorPanel {...props} />;
}

/** Teléfono: hoja inferior modal (la parrilla no cabe a la vez). */
function TimelineInspectorSheet(props: TimelineInspectorProps) {
  const { res, label, room, onClose, onOpenReservation } = props;
  return (
    <CocoaDrawer
      open={res !== null}
      onClose={onClose}
      title={res?.code ?? "Reserva"}
      subtitle={inspectorSubtitle(label, room)}
      side="right"
      size="lg"
      footer={
        <>
          <CocoaButton variant="plain" tone="neutral" onClick={onClose}>
            {ACTIONS.close}
          </CocoaButton>
          <CocoaKbd>Esc</CocoaKbd>
          <CocoaButton variant="filled" tone="accent" onClick={onOpenReservation}>
            {OPEN_RESERVATION_LABEL}
          </CocoaButton>
        </>
      }
    >
      {res ? <InspectorBody {...props} res={res} /> : null}
    </CocoaDrawer>
  );
}

/** Escritorio y tableta: panel acoplado a la derecha de la parrilla, sin scrim. */
function TimelineInspectorPanel(props: TimelineInspectorProps) {
  const { res, label, room, focusToken, onClose, onOpenReservation } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  // Solo cuando el token sube (apertura con teclado); `res` se lee entonces a
  // propósito y no es dependencia: cambiar de reserva con el ratón no roba el foco.
  useEffect(() => {
    if (!focusToken || !res) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  if (!res) return null;

  return (
    <div ref={panelRef} className="tl-panel" role="complementary" aria-labelledby={headingId} tabIndex={-1} data-cocoa="timeline-panel">
      <div className="tl-panel__head">
        <div className="tl-panel__heading">
          <h3 id={headingId} className="tl-panel__title">
            {res.code}
          </h3>
          <p className="tl-panel__subtitle">{inspectorSubtitle(label, room)}</p>
        </div>
        <CocoaButton variant="plain" tone="neutral" size="small" aria-label={A11Y_LABELS.close} onClick={onClose}>
          {ACTIONS.close}
        </CocoaButton>
      </div>
      <InspectorBody {...props} res={res} />
      <div className="tl-panel__foot">
        <CocoaKbd>Esc</CocoaKbd>
        <CocoaButton variant="filled" tone="accent" onClick={onOpenReservation}>
          {OPEN_RESERVATION_LABEL}
        </CocoaButton>
      </div>
    </div>
  );
}

type InspectorBodyProps = Omit<TimelineInspectorProps, "res"> & { res: AdminReservation };

function InspectorBody(props: InspectorBodyProps) {
  const { res, room, roomType, kind, folio, folioMissing, activity, loading, error } = props;
  const pendingValue = loading ? "…" : EMPTY;
  const balance = folio ? money(folio.balanceDue, folio.folio.currency) : folioMissing ? "Sin folio" : pendingValue;
  const payments = folio ? money(folio.paymentsTotal, folio.folio.currency) : folioMissing ? "Sin folio" : pendingValue;
  const occupancy = `${plural(res.adults, "adulto", "adultos")}${res.children > 0 ? ` · ${plural(res.children, "niño", "niños")}` : ""}`;
  const roomLabel = room ? `Hab. ${room.number}` : "Sin asignar";

  const facts: Array<{ label: string; value: ReactNode; tabular?: boolean }> = [
    { label: "Estado", value: RES_STATUS_LABEL[res.status] ?? res.status, tabular: false },
    { label: "Entrada", value: date(res.arrivalDate, "weekdayShort"), tabular: false },
    { label: "Salida", value: date(res.departureDate, "weekdayShort"), tabular: false },
    { label: "Noches", value: nightsOf(res) },
    { label: "Tipo", value: roomType?.name ?? EMPTY, tabular: false },
    { label: "Habitación", value: roomLabel, tabular: false },
    { label: "Canal", value: channelLabel(res.channel), tabular: false },
    { label: "Importe total", value: money(res.totalAmount, res.currency) },
    { label: "Saldo pendiente", value: balance },
    { label: "Cobros", value: payments },
    { label: "Actividad abierta", value: activity?.counts.openTotal ?? pendingValue }
  ];

  // «Folio y facturación» abre EL folio de esta reserva (FolioDetail), no la
  // pantalla genérica: solo cuando el folio existe y la pantalla lo cablea.
  const links: Array<{ label: string; onClick: () => void }> = [
    { label: "Recorrido del huésped", onClick: props.onOpenJourney },
    ...(folio && props.onOpenFolio ? [{ label: FOLIO_LINK_LABEL, onClick: props.onOpenFolio }] : []),
    { label: "Limpieza", onClick: () => props.onNavigate("HousekeepingDashboard") },
    { label: "Mantenimiento", onClick: () => props.onNavigate("MaintenanceDashboard") },
    { label: "Mensajes", onClick: () => props.onNavigate("ConciergeInboxDashboard") }
  ];

  const actions = inspectorActionState(res);
  const items = activity?.items.slice(0, ACTIVITY_LIMIT) ?? [];

  return (
    <div className="cocoa-stack" data-gap="4">
      {error ? (
        <CocoaCallout tone="warning" role="status">
          {error}
        </CocoaCallout>
      ) : null}

      <span className="cocoa-cluster">
        {kind ? <CocoaBadge tone={BAR_KIND_TONE[kind]}>{BAR_KIND_LABEL[kind]}</CocoaBadge> : null}
        {res.channel ? <CocoaBadge tone="neutral">{channelLabel(res.channel)}</CocoaBadge> : null}
        <CocoaBadge tone="neutral">{room ? `Hab. ${room.number}` : NO_ROOM_SUBTITLE}</CocoaBadge>
        <CocoaBadge tone="neutral">{plural(nightsOf(res), "noche", "noches")}</CocoaBadge>
      </span>

      <CocoaSection title="Huéspedes">
        <div className="cocoa-stack" data-gap="2">
          <div className="tl-facts">
            <CocoaStat label="Huésped principal" value={props.guestName ?? props.label} tabular={false} />
            <CocoaStat label="Ocupación" value={occupancy} tabular={false} />
          </div>
          {res.primaryGuestId ? null : <CocoaBadge tone="neutral">Sin huésped registrado</CocoaBadge>}
        </div>
      </CocoaSection>

      <CocoaSection title="Estancia y folio">
        <div className="tl-facts">
          {facts.map((fact) => (
            <CocoaStat key={fact.label} label={fact.label} value={fact.value} tabular={fact.tabular} />
          ))}
        </div>
      </CocoaSection>

      <CocoaSection title="Actividad reciente" meta={activity ? plural(activity.items.length, "evento", "eventos") : undefined}>
        {items.length > 0 ? (
          <ul className="c22-section__list">
            {items.map((item) => (
              <li key={item.id}>
                <span>
                  {activityLabel(item.kind, item.department)} · {item.title}
                </span>
                <CocoaBadge tone={item.open ? "warning" : "success"} size="small">
                  {item.open ? "Abierta" : "Cerrada"}
                </CocoaBadge>
              </li>
            ))}
          </ul>
        ) : loading && !activity ? (
          <CocoaState kind="loading" inline message="Cargando actividad…" />
        ) : (
          <CocoaState kind="empty" inline message="Sin actividad" />
        )}
      </CocoaSection>

      <CocoaSection title="Ir a">
        <div className="cocoa-row" data-gap="2">
          {links.map((link) => (
            <CocoaButton key={link.label} variant="plain" tone="accent" size="small" onClick={link.onClick}>
              {link.label}
            </CocoaButton>
          ))}
        </div>
      </CocoaSection>

      <CocoaSection title="Acciones">
        <div className="cocoa-row" data-gap="2">
          <CocoaButton variant="tinted" tone="accent" size="small" disabled={!actions.checkin} title={actions.checkinTitle} onClick={() => props.onAction("checkin")}>
            Check-in
          </CocoaButton>
          <CocoaButton variant="tinted" tone="accent" size="small" disabled={!actions.checkout} onClick={() => props.onAction("checkout")}>
            Check-out
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={!actions.assign} onClick={() => props.onAction("assign")}>
            {actions.assignLabel}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={!actions.cancel} onClick={() => props.onAction("cancel")}>
            Cancelar reserva
          </CocoaButton>
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={!actions.noshow} onClick={() => props.onAction("noshow")}>
            Marcar no-show
          </CocoaButton>
        </div>
      </CocoaSection>
    </div>
  );
}

export default TimelineInspector;
