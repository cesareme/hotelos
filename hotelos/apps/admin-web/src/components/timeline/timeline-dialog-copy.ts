// Live Timeline · copy de los diálogos de confirmación (Tanda TL · lote TL-4).
//
// Módulo puro y node-seguro: recibe el `PendingChange` del motor (TL-1) y
// devuelve el título, el cuerpo, el verbo del botón, el mensaje de éxito del
// toast y si el diálogo es destructivo. Las fechas y los plurales salen de
// lib/format; los verbos genéricos, del diccionario de acciones. La etiqueta
// del toast de deshacer NO vive aquí: la produce `undoEntryFor` del motor.
// Unit-tested en __tests__/timeline-inspector.test.mts.

import { dateRange, plural } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { nightsOf, type PendingChange } from "../../screens/timeline/timeline-engine";

export type DialogCopy = {
  title: string;
  body: string;
  /** Etiqueta del botón de confirmar. */
  verb: string;
  /** Mensaje del toast cuando el API responde bien. */
  done: string;
  /** Diálogo destructivo (foco inicial en Cancelar, botón rojo). */
  danger: boolean;
};

export type DialogCopyContext = {
  /** «Hab. 202» para un id y el texto de «sin habitación» para null (lo resuelve la pantalla). */
  roomLabel(id: string | null): string;
  /** Nombre que acompaña al código (`guestLabel` del motor, ya resuelto). */
  guest: string;
};

const DAY_MONTH = { style: "dayMonth" } as const;

function nightsLabel(arrivalDate: string, departureDate: string): string {
  return plural(nightsOf({ arrivalDate, departureDate }), "noche", "noches");
}

/** « en Hab. 202» o cadena vacía si la reserva no tiene habitación. */
function inRoom(roomId: string | null | undefined, ctx: DialogCopyContext): string {
  return roomId ? ` en ${ctx.roomLabel(roomId)}` : "";
}

export function dialogCopy(p: PendingChange, ctx: DialogCopyContext): DialogCopy {
  const { res } = p;
  const who = `${res.code} (${ctx.guest})`;
  switch (p.type) {
    case "move": {
      const room = p.newRoomId ? ` a ${p.newRoomLabel ?? ctx.roomLabel(p.newRoomId)}` : "";
      const dates =
        p.newArrival && p.newDeparture
          ? `, nuevas fechas ${dateRange(p.newArrival, p.newDeparture, DAY_MONTH)} (${nightsLabel(p.newArrival, p.newDeparture)})`
          : "";
      return { title: "Mover reserva", body: `Mover ${who}${room}${dates}.`, verb: "Mover", done: "Reserva movida.", danger: false };
    }
    case "resize":
      return {
        title: "Cambiar fechas",
        body: `Estancia de ${who}: ${dateRange(p.newArrivalDate, p.newDepartureDate, DAY_MONTH)} (${nightsLabel(p.newArrivalDate, p.newDepartureDate)}).`,
        verb: ACTIONS.save,
        done: "Fechas actualizadas.",
        danger: false
      };
    case "checkin":
      return {
        title: "Hacer check-in",
        body: `Registrar la entrada de ${who}${inRoom(res.assignedRoomId, ctx)}.`,
        verb: "Check-in",
        done: "Check-in registrado.",
        danger: false
      };
    case "checkout":
      return {
        title: "Hacer check-out",
        body: `Registrar la salida de ${who}${inRoom(res.assignedRoomId, ctx)}.`,
        verb: "Check-out",
        done: "Check-out registrado.",
        danger: false
      };
    case "cancel":
      return {
        title: "Cancelar reserva",
        body: `Cancelar ${who}. Se aplicará la política de cancelación.`,
        verb: "Cancelar reserva",
        done: "Reserva cancelada.",
        danger: true
      };
    case "noshow":
      return {
        title: "Marcar como no-show",
        body: `Marcar ${who} como no-show.`,
        verb: "Marcar no-show",
        done: "No-show registrado.",
        danger: true
      };
    case "assign":
      return {
        title: "Asignar habitación",
        body: `Asignar una habitación a ${who}.`,
        verb: ACTIONS.assign,
        done: "Habitación asignada.",
        danger: false
      };
  }
}
