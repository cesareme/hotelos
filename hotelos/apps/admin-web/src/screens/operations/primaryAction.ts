// Acción primaria contextual de una reserva (Tanda UX-1 · lote U6 ·
// docs/design/UX-RECEPCION-FEEL.md §1.1 P1, §4 «Barra de comandos de reserva»,
// §5.1 (1)). Módulo PURO (sin React, sin red): lo comparten las filas y el
// inspector de Mi día (U6), la cabecera de la ficha (U7) y el inspector de la
// lista (U8), y lo ejecuta `node --test` (__tests__/primary-action.test.mts).
//
// Derivación (§4): `confirmed` → Check-in (con la habitación sugerida si no
// tiene: «Check-in en 118») · `checked_in` que sale hoy → Check-out («Cobrar
// 120,00 € y cerrar» si debe algo) · `checked_in` con saldo y sin salir hoy →
// Cobrar · `checked_in` sin saldo → Abrir ficha · `checked_out` sin factura →
// Emitir factura · el resto (salida hecha con factura, no-show, cancelada,
// borrador) → Abrir ficha. Una sola acción `filled` por fila; lo demás va al
// menú «⋯» (P1).

import { FRONT_DESK_ACTIONS } from "../../content/actions";
import { money } from "../../lib/format";

export type PrimaryActionKind = "checkin" | "checkout" | "pay" | "invoice" | "open";

export type PrimaryActionReservation = {
  status: string;
  /** ISO (YYYY-MM-DD); ausente en filas que no la traen (En el hotel). */
  arrivalDate?: string | null;
  departureDate?: string | null;
  roomNumber?: string | null;
  /** Habitación limpia del tipo que el motor propone cuando no hay asignada (R14). */
  suggestedRoomNumber?: string | null;
  /** Saldo de la fila de Mi día (`balanceEur`); el folio, si llega, manda. */
  balanceEur?: number | null;
};

export type PrimaryActionFolio = {
  balanceDue: number;
  /** `true` si el folio ya tiene factura; `false` si no; ausente = desconocido (nunca se promete «Emitir factura» a ciegas). */
  invoiced?: boolean | null;
} | null;

export type PrimaryAction = {
  kind: PrimaryActionKind;
  label: string;
  /** Importe implicado (saldo), en la moneda de la reserva; null si no hay dinero de por medio. */
  amount: number | null;
};

const CENT = 0.005;

function normalizeStatus(status: string | null | undefined): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function balanceOf(reservation: PrimaryActionReservation, folio: PrimaryActionFolio): number {
  const value = folio ? folio.balanceDue : reservation.balanceEur;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Margen del API para el check-in (pms.service CHECK_IN_WINDOW_DAYS): llegada a ±1 día de la fecha de negocio. */
export const CHECK_IN_WINDOW_DAYS = 1;

/** Día ISO desplazado `days` (sin deriva horaria). */
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** La llegada admite check-in hoy: sin fecha (filas de Mi día, siempre de hoy) o llegada ≤ hoy + margen. */
export function arrivesWithinCheckInWindow(arrivalDate: string | null | undefined, today: string): boolean {
  if (!arrivalDate) return true;
  return arrivalDate.slice(0, 10) <= shiftIso(today, CHECK_IN_WINDOW_DAYS);
}

/** «Sale hoy» (o ya debía haber salido): la fecha de salida no es posterior a hoy. */
export function departsToday(departureDate: string | null | undefined, today: string): boolean {
  if (!departureDate) return false;
  return departureDate.slice(0, 10) <= today.slice(0, 10);
}

/**
 * Acción primaria de una reserva. `formatAmount` formatea el importe (por
 * defecto `money` de lib/format en la moneda por defecto; la pantalla pasa la
 * moneda de la reserva); aquí solo se compone la etiqueta.
 */
export function primaryActionFor(reservation: PrimaryActionReservation, folio: PrimaryActionFolio, today: string, formatAmount: (amount: number) => string = (amount) => money(amount)): PrimaryAction {
  const status = normalizeStatus(reservation.status);
  const balance = balanceOf(reservation, folio);
  const owes = balance > CENT;

  if (status === "confirmed") {
    // Corrector L-08: el check-in solo se ofrece dentro de la ventana del API
    // (llegada ≤ hoy + 1 día, CHECK_IN_WINDOW_DAYS); una llegada futura cobra
    // el saldo (depósito) o abre la ficha, nunca pinta un 409 de desarrollador.
    if (!arrivesWithinCheckInWindow(reservation.arrivalDate, today)) {
      return owes ? { kind: "pay", label: FRONT_DESK_ACTIONS.collect(formatAmount(balance)), amount: balance } : { kind: "open", label: FRONT_DESK_ACTIONS.openReservation, amount: null };
    }
    const suggested = !reservation.roomNumber && reservation.suggestedRoomNumber ? reservation.suggestedRoomNumber : null;
    return { kind: "checkin", label: suggested ? FRONT_DESK_ACTIONS.checkInTo(suggested) : FRONT_DESK_ACTIONS.checkIn, amount: owes ? balance : null };
  }

  if (status === "checked_in") {
    if (departsToday(reservation.departureDate, today)) {
      return owes
        ? { kind: "checkout", label: FRONT_DESK_ACTIONS.collectAndClose(formatAmount(balance)), amount: balance }
        : { kind: "checkout", label: FRONT_DESK_ACTIONS.checkOut, amount: null };
    }
    if (owes) return { kind: "pay", label: FRONT_DESK_ACTIONS.collect(formatAmount(balance)), amount: balance };
    return { kind: "open", label: FRONT_DESK_ACTIONS.openReservation, amount: null };
  }

  if (status === "checked_out" && folio && folio.invoiced === false) {
    return { kind: "invoice", label: FRONT_DESK_ACTIONS.issueInvoice, amount: null };
  }

  return { kind: "open", label: FRONT_DESK_ACTIONS.openReservation, amount: null };
}

/** Acciones secundarias del menú «⋯» que tienen sentido para el estado (P1: el resto no se pinta). */
export type SecondaryActionKind = "view_folio" | "assign_room" | "change_room" | "mark_no_show" | "open_full";

export function secondaryActionsFor(reservation: Pick<PrimaryActionReservation, "status" | "roomNumber">): SecondaryActionKind[] {
  const status = normalizeStatus(reservation.status);
  const out: SecondaryActionKind[] = ["view_folio"];
  if (status === "confirmed" || status === "checked_in") {
    out.push(reservation.roomNumber ? "change_room" : "assign_room");
  }
  if (status === "confirmed") out.push("mark_no_show");
  out.push("open_full");
  return out;
}
