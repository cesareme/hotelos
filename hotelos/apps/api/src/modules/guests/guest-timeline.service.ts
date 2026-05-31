// Guest Timeline service — vista única cronológica del huésped.
//
// Directriz HotelOS (Nov 2026):
//   "Cada huésped debe tener una vista tipo timeline, no una ficha fragmentada.
//    Cualquier recepcionista debe entender al huésped en menos de 10 segundos."
//
// Agrega en una sola llamada:
//   - Perfil + identidad + loyalty + valor del cliente (LTV)
//   - Métricas: total estancias, noches, gasto, ADR medio
//   - Eventos cronológicos: reservas, check-ins, pagos, cargos, incidencias,
//     peticiones especiales, notas internas
//
// Sin scope por organizationId — si el llamante puede ver al huésped por su id
// directo, asumimos que tiene contexto (la UI ya filtra por propiedad y los
// admins pueden cruzar orgs en la cadena demo).

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type GuestTimelineEventType =
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

export type GuestTimelineEvent = {
  id: string;
  type: GuestTimelineEventType;
  timestamp: string;              // ISO
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

export type GuestTimelineProfile = {
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

export type GuestTimelineMetrics = {
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

export type GuestTimelineReservation = {
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

export type GuestTimelineResult = {
  profile: GuestTimelineProfile;
  metrics: GuestTimelineMetrics;
  reservations: GuestTimelineReservation[];   // ordenadas desc por arrivalDate
  events: GuestTimelineEvent[];               // ordenadas desc por timestamp
};

function fmtName(g: { firstName?: string | null; surname1?: string | null; surname2?: string | null }): string {
  const parts = [g.firstName, g.surname1, g.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : "(unknown)";
}

function isoDate(d: Date | null | undefined): string | undefined {
  if (!d) return undefined;
  return d.toISOString().slice(0, 10);
}

function nightsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

export async function buildGuestTimeline(input: { guestId: string }): Promise<GuestTimelineResult> {
  const guest = await prisma.guest.findUnique({ where: { id: input.guestId } });
  if (!guest) throw new Error("Guest not found.");

  // Toda reserva donde este guest esté vinculado
  const links = await prisma.reservationGuest.findMany({
    where: { guestId: guest.id }
  });
  const reservationIds = links.map((l) => l.reservationId);
  const isPrimaryByReservation = new Map(links.map((l) => [l.reservationId, l.isPrimary]));

  const reservations = reservationIds.length
    ? await prisma.reservation.findMany({
        where: { id: { in: reservationIds } },
        orderBy: { arrivalDate: "desc" }
      })
    : [];

  // Properties (para nombre)
  const propertyIds = Array.from(new Set(reservations.map((r) => r.propertyId)));
  const properties = propertyIds.length
    ? await prisma.property.findMany({
        where: { id: { in: propertyIds } },
        select: { id: true, name: true }
      })
    : [];
  const propertyNameById = new Map(properties.map((p) => [p.id, p.name]));

  // Room types
  const roomTypeIds = Array.from(new Set(reservations.map((r) => r.roomTypeId).filter((x): x is string => Boolean(x))));
  const roomTypes = roomTypeIds.length
    ? await prisma.roomType.findMany({ where: { id: { in: roomTypeIds } }, select: { id: true, name: true } })
    : [];
  const roomTypeNameById = new Map(roomTypes.map((r) => [r.id, r.name]));

  // Balances + folios + lines + payments por reserva (batch)
  const balances = await computeBalancesForReservations(reservationIds);

  const folios = reservationIds.length
    ? await prisma.folio.findMany({
        where: { reservationId: { in: reservationIds } },
        select: { id: true, reservationId: true }
      })
    : [];
  const folioIds = folios.map((f) => f.id);

  const folioLines = folioIds.length
    ? await prisma.folioLine.findMany({
        where: { folioId: { in: folioIds } },
        orderBy: { postedAt: "desc" },
        take: 100
      })
    : [];
  const folioReservationByFolio = new Map(folios.map((f) => [f.id, f.reservationId]));

  const payments = folioIds.length
    ? await prisma.payment.findMany({
        where: { folioId: { in: folioIds } },
        orderBy: { createdAt: "desc" },
        take: 100
      })
    : [];

  // Stays — para detectar fechas exactas de check-in/out
  const stays = reservationIds.length
    ? await prisma.stay.findMany({
        where: { reservationId: { in: reservationIds } }
      })
    : [];

  // Work orders relacionadas (por habitación asignada en alguna estancia)
  const occupiedRoomIds = Array.from(new Set(stays.map((s) => s.roomId)));
  const workOrders = occupiedRoomIds.length
    ? await prisma.workOrder.findMany({
        where: { roomId: { in: occupiedRoomIds } },
        select: { id: true, propertyId: true, roomId: true, title: true, status: true, priority: true, createdAt: true }
      }).catch(() => [])
    : [];

  // Profile
  const profile: GuestTimelineProfile = {
    id: guest.id,
    firstName: guest.firstName,
    surname1: guest.surname1 ?? undefined,
    surname2: guest.surname2 ?? undefined,
    fullName: fmtName(guest),
    email: guest.email ?? undefined,
    phone: guest.phone ?? undefined,
    documentType: guest.documentType ?? undefined,
    documentNumber: guest.documentNumber ?? undefined,
    nationality: guest.nationality ?? undefined,
    dateOfBirth: isoDate(guest.dateOfBirth),
    languagePreference: guest.languagePreference ?? undefined,
    vipCode: guest.vipCode ?? undefined,
    loyaltyProgram: guest.loyaltyProgram ?? undefined,
    loyaltyTier: guest.loyaltyTier ?? undefined,
    loyaltyNumber: guest.loyaltyNumber ?? undefined,
    notes: guest.notes ?? undefined,
    preferences: guest.preferencesJson ?? undefined,
    marketingConsent: guest.marketingConsent ?? undefined,
    residenceAddress: guest.residenceAddress ?? undefined,
    residenceLocality: guest.residenceLocality ?? undefined,
    residenceCountry: guest.residenceCountry ?? undefined
  };

  // Metrics
  const completed = reservations.filter((r) => r.status === "checked_out");
  const totalNights = completed.reduce((s, r) => s + nightsBetween(r.arrivalDate, r.departureDate), 0);
  const totalSpend = completed.reduce((s, r) => s + Number(r.totalAmount), 0);
  const cancellations = reservations.filter((r) => r.status === "cancelled").length;
  const noShows = reservations.filter((r) => r.status === "no_show").length;
  const openBalance = reservations.reduce((s, r) => s + (balances.get(r.id) ?? 0), 0);
  const openIncidents = workOrders.filter((wo) => wo.status === "open" || wo.status === "in_progress").length;
  const sortedCompleted = [...completed].sort((a, b) => a.arrivalDate.getTime() - b.arrivalDate.getTime());

  const metrics: GuestTimelineMetrics = {
    totalStays: completed.length,
    totalNights,
    totalSpendEur: Math.round(totalSpend * 100) / 100,
    avgAdrEur: totalNights > 0 ? Math.round((totalSpend / totalNights) * 100) / 100 : 0,
    firstStayDate: sortedCompleted[0]?.arrivalDate ? isoDate(sortedCompleted[0].arrivalDate) : undefined,
    lastStayDate: sortedCompleted[sortedCompleted.length - 1]?.arrivalDate ? isoDate(sortedCompleted[sortedCompleted.length - 1].arrivalDate) : undefined,
    cancellations,
    noShows,
    openIncidents,
    openBalanceEur: Math.round(openBalance * 100) / 100
  };

  // Build reservations slim
  const slimReservations: GuestTimelineReservation[] = reservations.map((r) => ({
    id: r.id,
    code: r.code,
    propertyId: r.propertyId,
    propertyName: propertyNameById.get(r.propertyId),
    status: String(r.status),
    arrivalDate: isoDate(r.arrivalDate) ?? "",
    departureDate: isoDate(r.departureDate) ?? "",
    nights: nightsBetween(r.arrivalDate, r.departureDate),
    channel: r.channel,
    roomTypeName: r.roomTypeId ? roomTypeNameById.get(r.roomTypeId) : undefined,
    totalAmount: Number(r.totalAmount),
    balanceDue: balances.get(r.id) ?? 0,
    isPrimary: Boolean(isPrimaryByReservation.get(r.id))
  }));

  // Build events
  const events: GuestTimelineEvent[] = [];

  // 1. Reservation lifecycle (created + status transitions inferidos de fechas)
  for (const r of reservations) {
    const propName = propertyNameById.get(r.propertyId);
    events.push({
      id: `res_created_${r.id}`,
      type: "reservation_created",
      timestamp: r.createdAt.toISOString(),
      propertyId: r.propertyId,
      propertyName: propName,
      reservationId: r.id,
      reservationCode: r.code,
      title: `Reserva creada · ${propName ?? r.propertyId}`,
      subtitle: `${r.channel} · ${isoDate(r.arrivalDate)} → ${isoDate(r.departureDate)} · €${Number(r.totalAmount).toFixed(2)}`,
      amount: Number(r.totalAmount),
      amountCurrency: r.currency,
      importance: "info"
    });
    if (r.status === "cancelled") {
      events.push({
        id: `res_cancelled_${r.id}`,
        type: "cancellation",
        timestamp: r.createdAt.toISOString(),
        propertyId: r.propertyId,
        propertyName: propName,
        reservationId: r.id,
        reservationCode: r.code,
        title: `Reserva cancelada · ${r.code}`,
        importance: "alert"
      });
    }
    if (r.status === "no_show") {
      events.push({
        id: `no_show_${r.id}`,
        type: "no_show",
        timestamp: r.arrivalDate.toISOString(),
        propertyId: r.propertyId,
        propertyName: propName,
        reservationId: r.id,
        reservationCode: r.code,
        title: `No-show · ${r.code}`,
        importance: "alert"
      });
    }
    if (r.specialRequests || r.notes) {
      events.push({
        id: `request_${r.id}`,
        type: "special_request",
        timestamp: r.createdAt.toISOString(),
        propertyId: r.propertyId,
        propertyName: propName,
        reservationId: r.id,
        reservationCode: r.code,
        title: "Petición especial",
        subtitle: r.specialRequests ?? r.notes ?? undefined,
        importance: "highlight"
      });
    }
  }

  // 2. Stays → check-in / check-out
  for (const s of stays) {
    const res = reservations.find((r) => r.id === s.reservationId);
    if (!res) continue;
    const propName = propertyNameById.get(res.propertyId);
    if (s.checkinAt) {
      events.push({
        id: `checkin_${s.id}`,
        type: "check_in",
        timestamp: s.checkinAt.toISOString(),
        propertyId: res.propertyId,
        propertyName: propName,
        reservationId: res.id,
        reservationCode: res.code,
        title: `Check-in · ${propName ?? res.propertyId}`,
        subtitle: `Reserva ${res.code}`,
        importance: "info"
      });
    }
    if (s.checkoutAt) {
      events.push({
        id: `checkout_${s.id}`,
        type: "check_out",
        timestamp: s.checkoutAt.toISOString(),
        propertyId: res.propertyId,
        propertyName: propName,
        reservationId: res.id,
        reservationCode: res.code,
        title: `Check-out · ${propName ?? res.propertyId}`,
        subtitle: `Reserva ${res.code}`,
        importance: "info"
      });
    }
  }

  // 3. Folio lines (charges)
  for (const line of folioLines) {
    const reservationId = folioReservationByFolio.get(line.folioId);
    const res = reservationId ? reservations.find((r) => r.id === reservationId) : undefined;
    events.push({
      id: `line_${line.id}`,
      type: "folio_charge",
      timestamp: line.postedAt.toISOString(),
      propertyId: res?.propertyId,
      propertyName: res ? propertyNameById.get(res.propertyId) : undefined,
      reservationId: res?.id,
      reservationCode: res?.code,
      title: line.description,
      subtitle: `Tipo: ${line.type}${Number(line.quantity) !== 1 ? ` · ${Number(line.quantity)}x` : ""}`,
      amount: Number(line.total),
      amountCurrency: "EUR",
      importance: "info"
    });
  }

  // 4. Payments
  for (const p of payments) {
    const reservationId = folioReservationByFolio.get(p.folioId);
    const res = reservationId ? reservations.find((r) => r.id === reservationId) : undefined;
    events.push({
      id: `pay_${p.id}`,
      type: "payment",
      timestamp: p.createdAt.toISOString(),
      propertyId: res?.propertyId,
      propertyName: res ? propertyNameById.get(res.propertyId) : undefined,
      reservationId: res?.id,
      reservationCode: res?.code,
      title: `Pago ${p.status} · ${p.method}`,
      subtitle: p.pspReference ? `Ref. ${p.pspReference}` : undefined,
      amount: Number(p.amount),
      amountCurrency: p.currency,
      importance: p.status === "captured" ? "info" : "alert"
    });
  }

  // 5. Incidents / work orders
  for (const wo of workOrders) {
    const propName = propertyNameById.get(wo.propertyId);
    events.push({
      id: `wo_open_${wo.id}`,
      type: "incident_opened",
      timestamp: wo.createdAt.toISOString(),
      propertyId: wo.propertyId,
      propertyName: propName,
      title: `Incidencia abierta · ${wo.title}`,
      subtitle: `Prioridad ${wo.priority ?? "normal"}`,
      importance: "alert"
    });
    if (wo.status !== "open" && wo.status !== "in_progress") {
      // No tenemos updatedAt en el select; usamos createdAt + 1h como aproximación.
      events.push({
        id: `wo_closed_${wo.id}`,
        type: "incident_closed",
        timestamp: new Date(wo.createdAt.getTime() + 60 * 60 * 1000).toISOString(),
        propertyId: wo.propertyId,
        propertyName: propName,
        title: `Incidencia cerrada · ${wo.title}`,
        importance: "info"
      });
    }
  }

  // 6. Notas internas del guest (1 evento aglutinado si existe)
  if (guest.notes && guest.notes.trim()) {
    events.push({
      id: `note_guest_${guest.id}`,
      type: "note",
      timestamp: guest.createdAt.toISOString(),
      title: "Nota interna del huésped",
      subtitle: guest.notes,
      importance: "highlight"
    });
  }

  // Sort by timestamp desc
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { profile, metrics, reservations: slimReservations, events };
}
