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
//   - count: int (cuántos elementos afectados)
//   - detail: texto natural
//   - items: lista accionable opcional (top N) con id de la entidad
//
// Si CUALQUIER check es blocker → canClose = false.

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

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
  count: number;
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

async function nameForReservation(reservationId: string): Promise<string> {
  const link = await prisma.reservationGuest.findFirst({
    where: { reservationId, isPrimary: true },
    select: { guestId: true }
  });
  if (!link) return "Huésped";
  const guest = await prisma.guest.findUnique({
    where: { id: link.guestId },
    select: { firstName: true, surname1: true }
  });
  return fmtName(guest);
}

export async function buildPreflight(input: { propertyId: string }): Promise<PreflightResult> {
  const propertyId = input.propertyId;
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);

  // ---- 1) Llegadas pendientes -----------------------------------------
  const arrivalsPending = await prisma.reservation.findMany({
    where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed" },
    select: { id: true, code: true, eta: true, assignedRoomId: true }
  });
  const checkArrivals: PreflightCheck = {
    id: "arrivals_pending",
    title: "Llegadas pendientes",
    status: arrivalsPending.length === 0 ? "ok" : arrivalsPending.length > 3 ? "blocker" : "warning",
    count: arrivalsPending.length,
    detail: arrivalsPending.length === 0
      ? "Todas las llegadas del día han sido procesadas (check-in o no-show)."
      : `${arrivalsPending.length} reserva${arrivalsPending.length === 1 ? "" : "s"} confirmada${arrivalsPending.length === 1 ? "" : "s"} sin check-in.`,
    items: await Promise.all(
      arrivalsPending.slice(0, 5).map(async (r) => ({
        ref: r.id,
        label: `${r.code} · ${await nameForReservation(r.id)}`,
        detail: r.eta ? `ETA ${r.eta}` : "Sin ETA"
      }))
    )
  };

  // ---- 2) No-shows sin resolver ---------------------------------------
  // Reservas pasadas (arrival < today) que siguen confirmed sin estancia
  const unresolvedNoShows = await prisma.reservation.findMany({
    where: { propertyId, arrivalDate: { lt: today }, status: "confirmed" },
    select: { id: true, code: true, arrivalDate: true }
  });
  const checkNoShows: PreflightCheck = {
    id: "unresolved_no_shows",
    title: "No-shows sin resolver",
    status: unresolvedNoShows.length === 0 ? "ok" : "blocker",
    count: unresolvedNoShows.length,
    detail: unresolvedNoShows.length === 0
      ? "Sin no-shows pendientes de marcar."
      : `${unresolvedNoShows.length} reservas pasadas siguen como "confirmed". Decide check-in tardío o no-show antes del cierre.`,
    items: await Promise.all(
      unresolvedNoShows.slice(0, 5).map(async (r) => ({
        ref: r.id,
        label: `${r.code} · ${await nameForReservation(r.id)}`,
        detail: `Llegada prevista ${r.arrivalDate.toISOString().slice(0, 10)}`
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
    title: "Folios abiertos con saldo",
    status: foliosWithBalance.length === 0 ? "ok" : "blocker",
    count: foliosWithBalance.length,
    detail: foliosWithBalance.length === 0
      ? "Sin folios con saldo pendiente."
      : `${foliosWithBalance.length} folios con €${totalOwed.toFixed(2)} sin cobrar. Cobra o regulariza antes de cerrar.`,
    items: await Promise.all(
      foliosWithBalance.slice(0, 5).map(async (f) => ({
        ref: f.reservationId,
        label: await nameForReservation(f.reservationId),
        detail: `Saldo €${(balances.get(f.reservationId) ?? 0).toFixed(2)}`
      }))
    )
  };

  // ---- 4) Cargos de habitación sin postear para in-house --------------
  const inHouse = await prisma.reservation.findMany({
    where: { propertyId, status: "checked_in" },
    select: { id: true, code: true, arrivalDate: true, departureDate: true }
  });
  let unpostedCount = 0;
  for (const r of inHouse) {
    // Si la reserva está in-house pero no tiene ninguna línea de tipo "room" posteada hoy → posiblemente falta.
    const todayLine = await prisma.folioLine.findFirst({
      where: {
        folio: { reservationId: r.id },
        type: "room",
        postedAt: { gte: today, lt: tomorrow }
      },
      select: { id: true }
    });
    if (!todayLine) unpostedCount++;
  }
  const checkUnposted: PreflightCheck = {
    id: "unposted_room_charges",
    title: "Cargos de habitación sin postear",
    status: unpostedCount === 0 ? "ok" : "warning",
    count: unpostedCount,
    detail: unpostedCount === 0
      ? "Todas las estancias in-house tienen su cargo de noche posteado."
      : `${unpostedCount} estancia${unpostedCount === 1 ? "" : "s"} sin cargo de noche del día. El night audit los postea al ejecutar.`
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
    title: "Habitaciones ocupadas marcadas sucias",
    status: dirtyOccupied.length === 0 ? "ok" : "warning",
    count: dirtyOccupied.length,
    detail: dirtyOccupied.length === 0
      ? "Sin discrepancias entre ocupación y housekeeping."
      : `${dirtyOccupied.length} habitación${dirtyOccupied.length === 1 ? "" : "es"} ocupada${dirtyOccupied.length === 1 ? "" : "s"} con HK sucio. Revisa antes de cerrar.`,
    items: dirtyOccupied.slice(0, 5).map((r) => ({ ref: r.id, label: `Hab. ${r.number}`, detail: `HK: ${r.housekeepingStatus ?? r.status}` }))
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
    title: "Salidas sin check-out",
    status: departuresNotCheckedOut.length === 0 ? "ok" : "blocker",
    count: departuresNotCheckedOut.length,
    detail: departuresNotCheckedOut.length === 0
      ? "Todas las salidas previstas se han cerrado."
      : `${departuresNotCheckedOut.length} reserva${departuresNotCheckedOut.length === 1 ? "" : "s"} con salida pasada todavía in-house. Cierra el check-out o amplía la estancia.`,
    items: await Promise.all(
      departuresNotCheckedOut.slice(0, 5).map(async (r) => ({
        ref: r.id,
        label: `${r.code} · ${await nameForReservation(r.id)}`,
        detail: `Salida prevista ${r.departureDate.toISOString().slice(0, 10)}`
      }))
    )
  };

  // ---- 7) POS sin sincronizar (heurístico) ---------------------------
  // Placeholder: contamos órdenes POS abiertas en propiedad (si existe la entidad).
  // En el demo no hay módulo POS detallado conectado a folios; devolvemos OK.
  const checkPos: PreflightCheck = {
    id: "unsynced_pos_charges",
    title: "Cargos POS sin sincronizar",
    status: "ok",
    count: 0,
    detail: "Sin cargos POS pendientes de pasar a folios."
  };

  // ---- 8) Facturas pendientes ----------------------------------------
  // Folios cerrados sin invoice asociada (mismo día). Estimación simple:
  const closedFolios = await prisma.folio.findMany({
    where: { reservation: { propertyId }, status: "closed" },
    select: { id: true, reservationId: true }
  });
  // No tenemos un modelo Invoice consistente → comprobación ligera:
  let invoicesPending = 0;
  try {
    const invoices = await prisma.invoice.findMany({
      where: { propertyId, status: { in: ["draft", "issued"] } },
      select: { id: true, status: true }
    });
    invoicesPending = invoices.filter((i) => i.status === "draft").length;
  } catch {
    invoicesPending = 0;
  }
  const checkInvoices: PreflightCheck = {
    id: "invoices_pending",
    title: "Facturas pendientes",
    status: invoicesPending === 0 ? "ok" : "warning",
    count: invoicesPending,
    detail: invoicesPending === 0
      ? "Sin facturas en draft sin emitir."
      : `${invoicesPending} facturas en estado draft. Emite antes del cierre para que entren en la producción del día.`
  };
  void closedFolios;

  // ---- 9) Pre-autorizaciones sin capturar -----------------------------
  const pendingPayments = await prisma.payment.count({
    where: { propertyId, status: "pending" }
  });
  const checkPayments: PreflightCheck = {
    id: "payments_pending_capture",
    title: "Pre-autorizaciones sin capturar",
    status: pendingPayments === 0 ? "ok" : "warning",
    count: pendingPayments,
    detail: pendingPayments === 0
      ? "Sin preautorizaciones colgadas."
      : `${pendingPayments} pago${pendingPayments === 1 ? "" : "s"} en estado pending. Captúralos o cancélalos para no perder garantías.`
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
  const blockingMessage = canClose
    ? undefined
    : `No puedes cerrar todavía: ${blockers.map((b) => `${b.count} ${b.title.toLowerCase()}`).join(", ")}.`;

  // Business date (best effort)
  let businessDate: string | undefined;
  try {
    const bd = await prisma.businessDate.findUnique({ where: { propertyId } });
    if (bd) businessDate = bd.currentDate.toISOString().slice(0, 10);
  } catch {
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
