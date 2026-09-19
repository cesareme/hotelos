// Live Timeline · diálogo de confirmación de acciones (Tanda TL · lote TL-4).
//
// Un único CocoaDialog para los siete cambios del motor (move, resize,
// checkin, checkout, cancel, noshow, assign): el copy llega calculado
// (timeline-dialog-copy.ts) y el cuerpo cambia por tipo. Sin red: TL-5 ejecuta
// la llamada en `onConfirm` y devuelve por props `busy`, `error` y `conflict`
// (409 tipado del API: BALANCE_DUE en el check-out pide reconocer el saldo con
// un CocoaSwitch; el resto se pinta como alerta). Estado local: habitación
// elegida, motivo y reconocimiento del saldo, reiniciados cuando cambia
// `pending`. Sin estilos en línea: la rejilla Antes/Después es `.tl-facts` (TL-2).
// Tanda L3 · F1 (traspasado de LiveTimelineWorkspace en la fusión TL): la
// previsualización de la penalización de cancelación / no-show llega por props
// ya formateada (`penaltyPreview`: texto, tono y título con la misma voz que la
// ficha de reserva —aviso cuando la política cobra, plazo gratuito y política—)
// y se pinta bajo el motivo.

import { useEffect, useMemo, useState } from "react";
import type { AdminRoom, AdminRoomType } from "../../services/pmsCommerceApi";
import { ACTIONS } from "../../content/actions";
import { EMPTY, dateRange, money, plural } from "../../lib/format";
import { nightsOf, roomBlocked, roomChangeWarnings, sortRoomsByNumber, type PendingChange } from "../../screens/timeline/timeline-engine";
import { CocoaCallout, CocoaDialog, CocoaField, CocoaInput, CocoaSection, CocoaSelect, CocoaStat, CocoaSwitch } from "../cocoa";
import type { DialogCopy } from "./timeline-dialog-copy";

export type TimelineConflict = { code: string; message: string; balanceDue?: number | null };
export type TimelineConfirmInput = { roomId?: string; reason?: string; acknowledgeBalance?: boolean };
/** L3-F1: penalización prevista de cancelación / no-show, calculada por la pantalla (texto + tono + título de la política). */
export type TimelinePenaltyPreview = { text: string; tone: "info" | "warning"; title: string | null };

export interface TimelineActionDialogProps {
  pending: PendingChange | null;
  copy: DialogCopy | null;
  rooms: AdminRoom[];
  roomTypeById: ReadonlyMap<string, AdminRoomType>;
  roomLabel(id: string | null): string;
  busy: boolean;
  error: string | null;
  conflict: TimelineConflict | null;
  /** L3-F1: penalización prevista de cancelación / no-show (null = sin previsualización); tono y título como en la ficha de reserva. */
  penaltyPreview?: TimelinePenaltyPreview | null;
  onConfirm(input: TimelineConfirmInput): Promise<void>;
  onCancel(): void;
}

/** Motivo obligatorio en cancelación y no-show (alineado con L3-F1). */
export const MIN_REASON_LENGTH = 3;
const DAY_MONTH = { style: "dayMonth" } as const;

type StayChange = Extract<PendingChange, { type: "move" | "resize" }>;

function stayLine(arrivalDate: string, departureDate: string): string {
  return `${dateRange(arrivalDate, departureDate, DAY_MONTH)} (${plural(nightsOf({ arrivalDate, departureDate }), "noche", "noches")})`;
}

/** Antes/Después de un movimiento o cambio de fechas (puro). */
export function stayChangeFacts(pending: StayChange, roomLabel: (id: string | null) => string): { before: { stay: string; room: string }; after: { stay: string; room: string } } {
  const { res } = pending;
  const currentRoom = roomLabel(res.assignedRoomId ?? null);
  const before = { stay: stayLine(res.arrivalDate, res.departureDate), room: currentRoom };
  if (pending.type === "resize") {
    return { before, after: { stay: stayLine(pending.newArrivalDate, pending.newDepartureDate), room: currentRoom } };
  }
  return {
    before,
    after: {
      stay: stayLine(pending.newArrival ?? res.arrivalDate, pending.newDeparture ?? res.departureDate),
      room: pending.newRoomId ? pending.newRoomLabel ?? roomLabel(pending.newRoomId) : currentRoom
    }
  };
}

export function TimelineActionDialog(props: TimelineActionDialogProps) {
  const { pending, copy, rooms, roomTypeById, roomLabel, busy, error, conflict, penaltyPreview = null, onConfirm, onCancel } = props;
  const type = pending?.type ?? null;
  const res = pending?.res ?? null;

  const [roomId, setRoomId] = useState(res?.assignedRoomId ?? "");
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);

  useEffect(() => {
    setRoomId(pending?.res.assignedRoomId ?? "");
    setReason("");
    setAck(false);
  }, [pending]);

  const roomOptions = useMemo(
    () =>
      sortRoomsByNumber(rooms).map((room) => ({
        value: room.id,
        label: `Hab. ${room.number} · ${roomTypeById.get(room.roomTypeId)?.name ?? EMPTY}`,
        disabled: roomBlocked(room)
      })),
    [rooms, roomTypeById]
  );
  const selectedRoom = type === "assign" && roomId ? rooms.find((room) => room.id === roomId) : undefined;
  const assignWarnings = res && selectedRoom ? roomChangeWarnings(res, selectedRoom, roomTypeById) : [];

  const balanceConflict = type === "checkout" && conflict?.code === "BALANCE_DUE" ? conflict : null;
  const otherConflict = conflict && !balanceConflict ? conflict : null;

  const confirmDisabled =
    (type === "assign" && (!roomId || roomId === res?.assignedRoomId)) ||
    ((type === "cancel" || type === "noshow") && reason.trim().length < MIN_REASON_LENGTH) ||
    (balanceConflict !== null && !ack);

  return (
    <CocoaDialog
      open={pending !== null}
      onClose={onCancel}
      submitOnEnter
      title={copy?.title ?? ""}
      description={copy?.body}
      tone={copy?.danger ? "destructive" : "primary"}
      size={type === "move" || type === "resize" || type === "assign" ? "md" : "sm"}
      confirmLabel={copy?.verb}
      cancelLabel={ACTIONS.cancel}
      busy={busy}
      confirmDisabled={confirmDisabled}
      initialFocus={() => document.getElementById(type === "assign" ? "tl-assign-room" : "tl-reason")}
      onConfirm={() => onConfirm({ roomId: roomId || undefined, reason: reason.trim() || undefined, acknowledgeBalance: ack || undefined })}
    >
      {pending && res ? (
        <div className="cocoa-stack" data-gap="3">
          {pending.type === "move" || pending.type === "resize" ? <StayChangeBody pending={pending} roomLabel={roomLabel} /> : null}

          {pending.type === "assign" ? (
            <>
              <CocoaField label="Habitación" required htmlFor="tl-assign-room" help="Las habitaciones de otro tipo se avisan pero no se bloquean">
                <CocoaSelect id="tl-assign-room" value={roomId} onChange={setRoomId} options={roomOptions} placeholder="Elige una habitación" required />
              </CocoaField>
              {assignWarnings.map((warning) => (
                <CocoaCallout key={warning} tone="warning" role="status">
                  {warning}
                </CocoaCallout>
              ))}
            </>
          ) : null}

          {pending.type === "checkin" ? (
            <>
              <CocoaStat label="Habitación" value={roomLabel(res.assignedRoomId ?? null)} tabular={false} />
              <CocoaCallout tone="info" role="note">
                Solo se admite dentro de ±1 día de la fecha de negocio (o de hoy, si el cierre nocturno va por detrás)
              </CocoaCallout>
            </>
          ) : null}

          {pending.type === "checkout" && balanceConflict ? (
            <>
              <CocoaCallout tone="danger" role="alert">
                {typeof balanceConflict.balanceDue === "number" ? `Saldo pendiente ${money(balanceConflict.balanceDue, res.currency)}` : balanceConflict.message}
              </CocoaCallout>
              <CocoaSwitch checked={ack} onChange={setAck} label="Confirmar la salida con saldo pendiente" />
            </>
          ) : null}

          {pending.type === "cancel" || pending.type === "noshow" ? (
            <>
              <CocoaField label="Motivo" required htmlFor="tl-reason" help={`Al menos ${MIN_REASON_LENGTH} caracteres`}>
                <CocoaInput id="tl-reason" multiline rows={3} value={reason} onChange={setReason} maxLength={500} required />
              </CocoaField>
              {penaltyPreview ? (
                <CocoaCallout tone={penaltyPreview.tone} title={penaltyPreview.title ?? undefined} role="status">
                  {penaltyPreview.text}
                </CocoaCallout>
              ) : null}
            </>
          ) : null}

          {otherConflict ? (
            <CocoaCallout tone="danger" role="alert">
              {otherConflict.message}
            </CocoaCallout>
          ) : null}
          {error ? (
            <CocoaCallout tone="danger" role="alert">
              {error}
            </CocoaCallout>
          ) : null}
        </div>
      ) : null}
    </CocoaDialog>
  );
}

function StayChangeBody({ pending, roomLabel }: { pending: StayChange; roomLabel: (id: string | null) => string }) {
  const facts = stayChangeFacts(pending, roomLabel);
  return (
    <>
      <CocoaSection title="Cambio">
        <div className="tl-facts">
          <CocoaStat label="Antes" value={facts.before.stay} hint={facts.before.room} tabular={false} />
          <CocoaStat label="Después" value={facts.after.stay} hint={facts.after.room} tabular={false} />
        </div>
      </CocoaSection>
      {pending.warnings.map((warning) => (
        <CocoaCallout key={warning} tone="warning" role="note">
          {warning}
        </CocoaCallout>
      ))}
    </>
  );
}


export default TimelineActionDialog;
