// Cierre del día · preflight — every text the operator reads in the checklist
// (titles, details, item hints), in Spanish and free of jargon: no raw enum
// values («confirmed», «draft», «pending»), no «in-house» / «HK» / «POS» /
// «ETA», and money in es-ES («764,75 €», never «€764.75»). Pure functions (no
// query of its own; `formatDayEs` is shared with the room-charge core) so
// __tests__/night-audit-preflight-texts.test.mts runs it under `node --test`;
// night-audit-preflight.service.ts is its only consumer.

import { formatDayEs } from "../pms/room-charge.service.js";

export { formatDayEs };

/** Amount in euros as the operator reads it: «764,75 €», «27.928,11 €». */
export function formatEur(amount: number): string {
  return `${amount.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** «1 reserva» / «3 reservas» — the count always leads (the checklist reads «N …»). */
export function countNoun(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Housekeeping status of a room → lowercase Spanish (same wording as the front desk). */
const HOUSEKEEPING_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  clean: "limpia",
  inspected: "inspeccionada",
  ready: "lista",
  dirty: "sucia",
  occupied: "ocupada",
  ooo: "fuera de servicio",
  out_of_order: "fuera de servicio",
  out_of_service: "fuera de servicio"
});

export function housekeepingStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase();
  return HOUSEKEEPING_STATUS_LABELS[key] ?? (key || "desconocido");
}

/** Arrival time of a reservation («Hora prevista 16:30» / «Sin hora prevista»). */
export function arrivalTimeHint(eta: string | null | undefined): string {
  const value = (eta ?? "").trim();
  return value ? `Hora prevista ${value}` : "Sin hora prevista";
}

/** «Llegada prevista 14/09/2026» from an ISO date (or a Date). */
export function expectedArrivalHint(date: Date | string): string {
  return `Llegada prevista ${formatDayEs(toIsoDay(date))}`;
}

/** «Salida prevista 17/09/2026» from an ISO date (or a Date). */
export function expectedDepartureHint(date: Date | string): string {
  return `Salida prevista ${formatDayEs(toIsoDay(date))}`;
}

function toIsoDay(date: Date | string): string {
  return typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

/**
 * Titles and details per check, in the order of the directive. `ok` is the
 * green text; `some(n, …)` the text when n items are affected.
 */
export const PREFLIGHT_TEXTS = Object.freeze({
  arrivals_pending: {
    title: "Llegadas pendientes",
    ok: "Todas las llegadas del día están resueltas: check-in hecho o no-show marcado.",
    some: (n: number) => `${countNoun(n, "reserva confirmada", "reservas confirmadas")} sin check-in.`
  },
  unresolved_no_shows: {
    title: "No-shows sin resolver",
    ok: "Sin no-shows pendientes de marcar.",
    some: (n: number) =>
      n === 1
        ? "1 reserva pasada sigue confirmada sin estancia. Decide check-in tardío o no-show antes del cierre."
        : `${n} reservas pasadas siguen confirmadas sin estancia. Decide check-in tardío o no-show antes del cierre.`
  },
  open_folios_with_balance: {
    title: "Folios abiertos con saldo",
    ok: "Sin folios con saldo pendiente.",
    some: (n: number, totalOwed: number) => `${countNoun(n, "folio", "folios")} con ${formatEur(totalOwed)} sin cobrar. Cobra o regulariza antes de cerrar.`,
    balance: (owed: number) => `Saldo ${formatEur(owed)}`
  },
  unposted_room_charges: {
    title: "Cargos de alojamiento pendientes",
    ok: "Todas las estancias alojadas tienen el cargo de la noche en su folio.",
    some: (n: number) =>
      n === 1
        ? "1 estancia sin el cargo de la noche. El cierre del día lo carga al ejecutarse."
        : `${n} estancias sin el cargo de la noche. El cierre del día los carga al ejecutarse.`
  },
  dirty_in_house_rooms: {
    title: "Habitaciones ocupadas marcadas sucias",
    ok: "Sin discrepancias entre ocupación y limpieza.",
    some: (n: number) =>
      n === 1
        ? "1 habitación ocupada marcada como sucia. Revisa antes de cerrar."
        : `${n} habitaciones ocupadas marcadas como sucias. Revisa antes de cerrar.`,
    room: (status: string | null | undefined) => `Limpieza: ${housekeepingStatusLabel(status)}`
  },
  departures_not_checked_out: {
    title: "Salidas sin check-out",
    ok: "Todas las salidas previstas se han cerrado.",
    some: (n: number) =>
      n === 1
        ? "1 reserva con salida pasada todavía alojada. Cierra el check-out o amplía la estancia."
        : `${n} reservas con salida pasada todavía alojadas. Cierra el check-out o amplía la estancia.`
  },
  unsynced_pos_charges: {
    title: "Cargos del TPV sin pasar a folio",
    ok: "Sin cargos del TPV pendientes de pasar a folio."
  },
  invoices_pending: {
    title: "Facturas pendientes",
    ok: "Sin facturas en borrador pendientes de emitir.",
    some: (n: number) =>
      n === 1
        ? "1 factura en borrador. Emítela antes del cierre para que entre en la producción del día."
        : `${n} facturas en borrador. Emítelas antes del cierre para que entren en la producción del día.`,
    failed: (reason: string) => `No se pudo comprobar las facturas pendientes: ${reason}`
  },
  payments_pending_capture: {
    title: "Preautorizaciones sin capturar",
    ok: "Sin preautorizaciones pendientes de captura.",
    some: (n: number) =>
      n === 1
        ? "1 pago pendiente de captura. Captúralo o cancélalo para no perder la garantía."
        : `${n} pagos pendientes de captura. Captúralos o cancélalos para no perder las garantías.`
  }
});

/** «No puedes cerrar todavía: 2 no-shows sin resolver, 13 folios abiertos con saldo.» */
export function blockingMessage(blockers: ReadonlyArray<{ count: number | null; title: string }>): string {
  return `No puedes cerrar todavía: ${blockers.map((b) => `${b.count ?? "—"} ${b.title.toLowerCase()}`).join(", ")}.`;
}
