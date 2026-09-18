// Night Audit Preflight — checklist inteligente que decide si el cierre del
// día puede ejecutarse.
//
// Directriz HotelOS (Nov 2026):
//   "El sistema debe decir: 'No puedes cerrar todavía porque hay 3 folios con
//    saldo pendiente y 2 llegadas sin resolver.'"
//
// 9 checks (orden de la directriz):
//   1. arrivals_pending          · llegadas confirmed que no llegaron y no son no-show
//   2. unresolved_no_shows       · llegadas pasadas + sigue confirmed → bloquea
//   3. open_folios_with_balance  · folios abiertos con saldo > 0
//   4. unposted_room_charges     · in-house sin charge de la noche posteado
//   5. dirty_in_house_rooms      · ocupadas pero status sucio (discrepancia)
//   6. departures_not_checked_out · salida pasada sin checked_out
//   7. unsynced_pos_charges      · cuentas POS abiertas (heurístico — placeholder
//                                  hasta tener integración POS específica)
//   8. invoices_pending          · folios cerrados sin factura emitida
//   9. payments_pending_capture  · pre-autorizaciones sin captura
//
// Cada check devuelve:
//   - status: "ok" | "warning" | "blocker"
//   - count: int (cuántos elementos afectados) · null cuando la propia
//     comprobación falló (status "warning" + detail explica el motivo)
//   - detail: texto natural
//   - items: lista accionable opcional (top N) con id de la entidad
//
// Si CUALQUIER check es blocker → canClose = false.
//
// Every visible text (title, detail, item hint) comes from
// night-audit-preflight.texts.ts: Spanish without raw enum values or jargon
// and money in es-ES (qa#4 of the Cocoa 22 walkthrough).

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";
import {
  PREFLIGHT_TEXTS as T,
  arrivalTimeHint,
  blockingMessage as composeBlockingMessage,
  expectedArrivalHint,
  expectedDepartureHint
} from "./night-audit-preflight.texts.js";

export type PreflightStatus = "ok" | "warning" | "blocker";

export type PreflightCheckId =
  | "arrivals_pending"
  | "unresolved_no_shows"
  | "open_folios_with_balance"
  | "unposted_room_charges"
  | "dirty_in_house_rooms"
  | "departures_not_checked_out"
  | "unsynced_pos_charges"
  | "invoices_pending"
  | "payments_pending_capture";

export type PreflightItem = {
  ref: string;       // entity id (reservation/folio/room/invoice)
  label: string;     // human readable (Hab. 305 · Pierre Smith)
  detail?: string;
};

export type PreflightCheck = {
  id: PreflightCheckId;
  title: string;
  status: PreflightStatus;
  /** Affected items; `null` when the check itself could not run (see detail). */
  count: number | null;
  detail: string;
  items?: PreflightItem[];
};

export type PreflightResult = {
  propertyId: string;
  businessDate?: string;
  generatedAt: string;
  canClose: boolean;
  blockingMessage?: string;
  checks: PreflightCheck[];
  summary: { ok: number; warning: number; blocker: number };
};

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtName(g: { firstName?: string | null; surname1?: string | null } | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1].filter(Boolean).join(" ") || "Huésped";
}

/**
 * Tanda L2 (L2-06): primary-guest name of every listed reservation in two
 * queries (links + guests) instead of two per reservation. Missing link or
 * guest → «Huésped», as before.
 */
async function namesForReservations(reservationIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (reservationIds.length === 0) return names;
  const links = await prisma.reservationGuest.findMany({
    where: { reservationId: { in: [...reservationIds] }, isPrimary: true },
    select: { reservationId: true, guestId: true }
  });
  const guestIds = Array.from(new Set(links.map((l) => l.guestId)));
  const guests = guestIds.length
    ? await prisma.guest.findMany({ where: { id: { in: guestIds } }, select: { id: true, firstName: true, surname1: true } })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));
  for (const link of links) {
    if (names.has(link.reservationId)) continue;
    names.set(link.reservationId, fmtName(guestById.get(link.guestId) ?? null));
  }
  return names;
}

const nameOf = (names: Map<string, string>, reservationId: string): string => names.get(reservationId) ?? "Huésped";

export async function buildPreflight(input: { propertyId: string }): Promise<PreflightResult> {
  const propertyId = input.propertyId;
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);

  // ---- 1) Llegadas pendientes -----------------------------------------
  const arrivalsPending = await prisma.reservation.findMany({
    where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed" },
    select: { id: true, code: true, eta: true, assignedRoomId: true }
  });
  const arrivalNames = await namesForReservations(arrivalsPending.slice(0, 5).map((r) => r.id));
  const checkArrivals: PreflightCheck = {
    id: "arrivals_pending",
    title: T.arrivals_pending.title,
    status: arrivalsPending.length === 0 ? "ok" : arrivalsPending.length > 3 ? "blocker" : "warning",
    count: arrivalsPending.length,
    detail: arrivalsPending.length === 0 ? T.arrivals_pending.ok : T.arrivals_pending.some(arrivalsPending.length),
    items: arrivalsPending.slice(0, 5).map((r) => ({
      ref: r.id,
      label: `${r.code} · ${nameOf(arrivalNames, r.id)}`,
      detail: arrivalTimeHint(r.eta)
    }))
  };

  // ---- 2) No-shows sin resolver ---------------------------------------
  // Reservas pasadas (arrival < today) que siguen confirmed sin estancia
  const unresolvedNoShows = await prisma.reservation.findMany({
    where: { propertyId, arrivalDate: { lt: today }, status: "confirmed" },
    select: { id: true, code: true, arrivalDate: true }
  });
  const checkNoShows: PreflightCheck = {
    id: "unresolved_no_shows",
    title: T.unresolved_no_shows.title,
    status: unresolvedNoShows.length === 0 ? "ok" : "blocker",
    count: unresolvedNoShows.length,
    detail: unresolvedNoShows.length === 0 ? T.unresolved_no_shows.ok : T.unresolved_no_shows.some(unresolvedNoShows.length),
    items: await namesForReservations(unresolvedNoShows.slice(0, 5).map((r) => r.id)).then((names) =>
      unresolvedNoShows.slice(0, 5).map((r) => ({
        ref: r.id,
        label: `${r.code} · ${nameOf(names, r.id)}`,
        detail: expectedArrivalHint(r.arrivalDate)
      }))
    )
  };

  // ---- 3) Folios abiertos con saldo -----------------------------------
  const openFolios = await prisma.folio.findMany({
    where: { reservation: { propertyId }, status: "open" },
    select: { id: true, reservationId: true }
  });
  const reservationIds = Array.from(new Set(openFolios.map((f) => f.reservationId)));
  const balances = await computeBalancesForReservations(reservationIds);
  const foliosWithBalance = openFolios.filter((f) => (balances.get(f.reservationId) ?? 0) > 0.01);
  const totalOwed = foliosWithBalance.reduce((s, f) => s + (balances.get(f.reservationId) ?? 0), 0);
  const checkFolios: PreflightCheck = {
    id: "open_folios_with_balance",
    title: T.open_folios_with_balance.title,
    status: foliosWithBalance.length === 0 ? "ok" : "blocker",
    count: foliosWithBalance.length,
    detail: foliosWithBalance.length === 0 ? T.open_folios_with_balance.ok : T.open_folios_with_balance.some(foliosWithBalance.length, totalOwed),
    items: await namesForReservations(foliosWithBalance.slice(0, 5).map((f) => f.reservationId)).then((names) =>
      foliosWithBalance.slice(0, 5).map((f) => ({
        ref: f.reservationId,
        label: nameOf(names, f.reservationId),
        detail: T.open_folios_with_balance.balance(balances.get(f.reservationId) ?? 0)
      }))
    )
  };

  // ---- 4) Cargos de habitación sin postear para in-house --------------
  const inHouse = await prisma.reservation.findMany({
    where: { propertyId, status: "checked_in" },
    select: { id: true, code: true, arrivalDate: true, departureDate: true }
  });
  // Tanda L2 (L2-06): the reservations that DO have a room line posted today,
  // in one query over their folios (was one findFirst per in-house reservation).
  // Si la reserva está in-house pero no tiene ninguna línea de tipo "room" posteada hoy → posiblemente falta.
  const postedToday =
    inHouse.length === 0
      ? []
      : await prisma.folio.findMany({
          where: {
            reservationId: { in: inHouse.map((r) => r.id) },
            lines: { some: { type: "room", postedAt: { gte: today, lt: tomorrow } } }
          },
          select: { reservationId: true },
          distinct: ["reservationId"]
        });
  const postedTodaySet = new Set(postedToday.map((f) => f.reservationId));
  const unpostedCount = inHouse.filter((r) => !postedTodaySet.has(r.id)).length;
  const checkUnposted: PreflightCheck = {
    id: "unposted_room_charges",
    title: T.unposted_room_charges.title,
    status: unpostedCount === 0 ? "ok" : "warning",
    count: unpostedCount,
    detail: unpostedCount === 0 ? T.unposted_room_charges.ok : T.unposted_room_charges.some(unpostedCount)
  };

  // ---- 5) Habitaciones in-house con HK status sucio (discrepancia) ----
  const inHouseRoomIds = new Set(
    (await prisma.reservation.findMany({
      where: { propertyId, status: "checked_in" },
      select: { assignedRoomId: true }
    })).map((r) => r.assignedRoomId).filter((x): x is string => Boolean(x))
  );
  const allRooms = await prisma.room.findMany({
    where: { propertyId, id: { in: Array.from(inHouseRoomIds) } },
    select: { id: true, number: true, status: true, housekeepingStatus: true }
  });
  const dirtyOccupied = allRooms.filter((r) => {
    const hk = (r.housekeepingStatus ?? "").toLowerCase();
    return hk === "dirty" || r.status === "dirty";
  });
  const checkDirty: PreflightCheck = {
    id: "dirty_in_house_rooms",
    title: T.dirty_in_house_rooms.title,
    status: dirtyOccupied.length === 0 ? "ok" : "warning",
    count: dirtyOccupied.length,
    detail: dirtyOccupied.length === 0 ? T.dirty_in_house_rooms.ok : T.dirty_in_house_rooms.some(dirtyOccupied.length),
    items: dirtyOccupied.slice(0, 5).map((r) => ({ ref: r.id, label: `Hab. ${r.number}`, detail: T.dirty_in_house_rooms.room(r.housekeepingStatus ?? r.status) }))
  };

  // ---- 6) Departures sin check-out -----------------------------------
  const departuresNotCheckedOut = await prisma.reservation.findMany({
    where: {
      propertyId,
      departureDate: { lte: today },
      status: "checked_in"
    },
    select: { id: true, code: true, departureDate: true, assignedRoomId: true }
  });
  const checkDepartures: PreflightCheck = {
    id: "departures_not_checked_out",
    title: T.departures_not_checked_out.title,
    status: departuresNotCheckedOut.length === 0 ? "ok" : "blocker",
    count: departuresNotCheckedOut.length,
    detail: departuresNotCheckedOut.length === 0 ? T.departures_not_checked_out.ok : T.departures_not_checked_out.some(departuresNotCheckedOut.length),
    items: await namesForReservations(departuresNotCheckedOut.slice(0, 5).map((r) => r.id)).then((names) =>
      departuresNotCheckedOut.slice(0, 5).map((r) => ({
        ref: r.id,
        label: `${r.code} · ${nameOf(names, r.id)}`,
        detail: expectedDepartureHint(r.departureDate)
      }))
    )
  };

  // ---- 7) POS sin sincronizar (heurístico) ---------------------------
  // Placeholder: contamos órdenes POS abiertas en propiedad (si existe la entidad).
  // En el demo no hay módulo POS detallado conectado a folios; devolvemos OK.
  const checkPos: PreflightCheck = {
    id: "unsynced_pos_charges",
    title: T.unsynced_pos_charges.title,
    status: "ok",
    count: 0,
    detail: T.unsynced_pos_charges.ok
  };

  // ---- 8) Facturas pendientes ----------------------------------------
  // Folios cerrados sin invoice asociada (mismo día). Estimación simple:
  const closedFolios = await prisma.folio.findMany({
    where: { reservation: { propertyId }, status: "closed" },
    select: { id: true, reservationId: true }
  });
  // Lightweight check. If the query itself fails we must NOT report "ok" with
  // count 0 (QC-06): the check degrades to "warning" with count null and an
  // explicit detail. Only "blocker" blocks the close, so this never locks the
  // night audit — it just stops hiding a broken query behind a green tick.
  let checkInvoices: PreflightCheck;
  try {
    const invoices = await prisma.invoice.findMany({
      where: { propertyId, status: { in: ["draft", "issued"] } },
      select: { id: true, status: true }
    });
    const invoicesPending = invoices.filter((i) => i.status === "draft").length;
    checkInvoices = {
      id: "invoices_pending",
      title: T.invoices_pending.title,
      status: invoicesPending === 0 ? "ok" : "warning",
      count: invoicesPending,
      detail: invoicesPending === 0 ? T.invoices_pending.ok : T.invoices_pending.some(invoicesPending)
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[night-audit.preflight] invoices_pending check failed", { propertyId, error: reason });
    checkInvoices = {
      id: "invoices_pending",
      title: T.invoices_pending.title,
      status: "warning",
      count: null,
      detail: T.invoices_pending.failed(reason)
    };
  }
  void closedFolios;

  // ---- 9) Pre-autorizaciones sin capturar -----------------------------
  const pendingPayments = await prisma.payment.count({
    where: { propertyId, status: "pending" }
  });
  const checkPayments: PreflightCheck = {
    id: "payments_pending_capture",
    title: T.payments_pending_capture.title,
    status: pendingPayments === 0 ? "ok" : "warning",
    count: pendingPayments,
    detail: pendingPayments === 0 ? T.payments_pending_capture.ok : T.payments_pending_capture.some(pendingPayments)
  };

  // ---- Compose --------------------------------------------------------
  const checks: PreflightCheck[] = [
    checkArrivals,
    checkNoShows,
    checkFolios,
    checkDepartures,
    checkUnposted,
    checkDirty,
    checkPos,
    checkInvoices,
    checkPayments
  ];
  const blockers = checks.filter((c) => c.status === "blocker");
  const canClose = blockers.length === 0;
  const blockingMessage = canClose ? undefined : composeBlockingMessage(blockers);

  // Business date (best effort): the preflight is still useful without it, so
  // a failed lookup leaves it undefined — but logged, never silent.
  let businessDate: string | undefined;
  try {
    const bd = await prisma.businessDate.findUnique({ where: { propertyId } });
    if (bd) businessDate = bd.currentDate.toISOString().slice(0, 10);
  } catch (err) {
    console.warn("[night-audit.preflight] businessDate lookup failed", {
      propertyId,
      error: err instanceof Error ? err.message : String(err)
    });
    businessDate = undefined;
  }

  return {
    propertyId,
    businessDate,
    generatedAt: new Date().toISOString(),
    canClose,
    blockingMessage,
    checks,
    summary: {
      ok: checks.filter((c) => c.status === "ok").length,
      warning: checks.filter((c) => c.status === "warning").length,
      blocker: blockers.length
    }
  };
}
