// Global cross-entity search service.
//
// One endpoint, many indices: runs read-only queries in parallel against the
// most-searched entities — reservations, guests, rooms, folios, invoices,
// rate plans, properties — and returns a unified, ranked list of hits that
// the frontend can deep-link to.
//
// Designed for the top-bar command palette (cmd+K). Property-scoped where
// applicable; org-scoped for entities that aren't property-bound (guests).
// Uses Prisma `contains` with `mode: "insensitive"` for free-text, and the
// existing PII lookup-hash extension for exact email / phone / document
// lookups (no plaintext is stored on those columns).

import { prisma } from "@hotelos/database";

const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;
const CUID_RE = /^c[a-z0-9]{20,}$/;
const PHONE_RE = /^[+\d][\d\s().-]{4,}$/;
const DOC_RE = /^[A-Za-z0-9-]{5,}$/;

export type SearchHit = {
  kind:
    | "reservation"
    | "guest"
    | "room"
    | "folio"
    | "invoice"
    | "property"
    | "rate_plan";
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  // Frontend uses { screen, params } to push history state + dispatch nav.
  screen: string;
  params?: Record<string, string>;
  score?: number;
};

type SearchInput = {
  organizationId: string;
  propertyId: string | null;
  query: string;
  types?: SearchHit["kind"][];
  limit?: number;
};

function trimText(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function guestDisplayName(g: {
  firstName: string;
  surname1: string | null;
  surname2: string | null;
  company: string | null;
}): string {
  const parts = [g.firstName, g.surname1, g.surname2].filter(Boolean);
  return parts.join(" ").trim() || g.company || "—";
}

export async function globalSearch(input: SearchInput): Promise<{ items: SearchHit[]; counts: Record<string, number>; took_ms: number }> {
  const t0 = Date.now();
  const q = (input.query ?? "").trim();
  if (!q || q.length < 1) {
    return { items: [], counts: {}, took_ms: 0 };
  }
  const types = input.types && input.types.length ? new Set(input.types) : null;
  const wants = (k: SearchHit["kind"]) => !types || types.has(k);
  const perKind = Math.min(15, Math.max(3, input.limit ?? 8));

  // Run all queries in parallel; each catches its own error so one failure
  // (e.g. missing index) doesn't take down the others.
  const safe = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

  const [
    reservations,
    reservationsByGuest,
    guests,
    rooms,
    folios,
    invoices,
    properties,
    ratePlans
  ] = await Promise.all([
    wants("reservation") && input.propertyId
      ? safe(
          prisma.reservation.findMany({
            where: {
              propertyId: input.propertyId,
              OR: [
                { code: { contains: q, mode: "insensitive" } },
                { bookerName: { contains: q, mode: "insensitive" } },
                { bookerEmail: { contains: q, mode: "insensitive" } },
                { externalReference: { contains: q, mode: "insensitive" } },
                { companyName: { contains: q, mode: "insensitive" } },
                { travelAgentName: { contains: q, mode: "insensitive" } },
                { groupCode: { contains: q, mode: "insensitive" } }
              ]
            },
            select: {
              id: true, code: true, status: true, arrivalDate: true, departureDate: true,
              bookerName: true, companyName: true, channel: true
            },
            orderBy: { arrivalDate: "desc" },
            take: perKind
          }),
          [] as Array<{ id: string; code: string; status: string; arrivalDate: Date; departureDate: Date; bookerName: string | null; companyName: string | null; channel: string }>
        )
      : Promise.resolve([]),

    // Reservations whose linked guests match the query. Ahora con join tipado
    // gracias a la @relation Reservation ↔ ReservationGuest ↔ Guest (P1-4).
    wants("reservation") && input.propertyId
      ? safe(
          (async () => {
            const rows = await prisma.reservation.findMany({
              where: {
                propertyId: input.propertyId!,
                reservationGuests: {
                  some: {
                    guest: {
                      OR: [
                        { firstName: { contains: q, mode: "insensitive" } },
                        { surname1: { contains: q, mode: "insensitive" } },
                        { surname2: { contains: q, mode: "insensitive" } }
                      ]
                    }
                  }
                }
              },
              select: {
                id: true, code: true, status: true, arrivalDate: true, departureDate: true,
                bookerName: true, companyName: true, channel: true,
                reservationGuests: {
                  take: 1,
                  select: { guest: { select: { firstName: true, surname1: true } } }
                }
              },
              orderBy: { arrivalDate: "desc" },
              take: perKind
            });
            return rows.map((r) => {
              const g = r.reservationGuests[0]?.guest;
              const preview = g ? `${g.firstName} ${g.surname1 ?? ""}`.trim() : undefined;
              const { reservationGuests: _drop, ...rest } = r;
              return { ...rest, guestPreview: preview };
            });
          })(),
          [] as Array<{ id: string; code: string; status: string; arrivalDate: Date; departureDate: Date; bookerName: string | null; companyName: string | null; channel: string; guestPreview?: string }>
        )
      : Promise.resolve([]),

    wants("guest")
      ? safe(
          (async () => {
            const orFilters: object[] = [
              { firstName: { contains: q, mode: "insensitive" } },
              { surname1: { contains: q, mode: "insensitive" } },
              { surname2: { contains: q, mode: "insensitive" } },
              { company: { contains: q, mode: "insensitive" } }
            ];
            // Exact lookups via the PII lookup-hash extension.
            if (EMAIL_RE.test(q)) orFilters.push({ email: q });
            if (PHONE_RE.test(q)) orFilters.push({ phone: q.replace(/\s+/g, "") });
            if (DOC_RE.test(q)) orFilters.push({ documentNumber: q });
            return prisma.guest.findMany({
              where: { organizationId: input.organizationId, OR: orFilters },
              select: { id: true, firstName: true, surname1: true, surname2: true, company: true, nationality: true, documentNumber: true, vipCode: true },
              orderBy: { createdAt: "desc" },
              take: perKind
            });
          })(),
          [] as Array<{ id: string; firstName: string; surname1: string | null; surname2: string | null; company: string | null; nationality: string | null; documentNumber: string | null; vipCode: string | null }>
        )
      : Promise.resolve([]),

    wants("room") && input.propertyId
      ? safe(
          prisma.room.findMany({
            where: {
              propertyId: input.propertyId,
              active: true,
              OR: [
                { number: { contains: q, mode: "insensitive" } },
                { roomCode: { contains: q, mode: "insensitive" } },
                { displayName: { contains: q, mode: "insensitive" } },
                { floor: { contains: q, mode: "insensitive" } }
              ]
            },
            select: { id: true, number: true, roomCode: true, displayName: true, floor: true, status: true, roomTypeId: true },
            orderBy: { number: "asc" },
            take: perKind
          }),
          [] as Array<{ id: string; number: string; roomCode: string | null; displayName: string | null; floor: string | null; status: string; roomTypeId: string }>
        )
      : Promise.resolve([]),

    // Folios: only meaningful when q looks like a cuid prefix.
    wants("folio") && CUID_RE.test(q)
      ? safe(
          prisma.folio.findMany({
            where: { id: { startsWith: q } },
            select: { id: true, reservationId: true, label: true, isPrimary: true, currency: true, status: true },
            take: perKind
          }),
          [] as Array<{ id: string; reservationId: string; label: string; isPrimary: boolean; currency: string; status: string }>
        )
      : Promise.resolve([]),

    wants("invoice") && input.propertyId
      ? safe(
          prisma.invoice.findMany({
            where: {
              propertyId: input.propertyId,
              OR: [
                { invoiceNumber: { contains: q, mode: "insensitive" } },
                { customerTaxId: { contains: q, mode: "insensitive" } }
              ]
            },
            select: { id: true, invoiceNumber: true, status: true, total: true, currencyCode: true, customerTaxId: true, customerType: true, issuedAt: true },
            orderBy: { issuedAt: "desc" },
            take: perKind
          }),
          [] as Array<{ id: string; invoiceNumber: string | null; status: string; total: unknown; currencyCode: string; customerTaxId: string | null; customerType: string; issuedAt: Date | null }>
        )
      : Promise.resolve([]),

    wants("property")
      ? safe(
          prisma.property.findMany({
            where: {
              organizationId: input.organizationId,
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { legalName: { contains: q, mode: "insensitive" } },
                { municipality: { contains: q, mode: "insensitive" } }
              ]
            },
            select: { id: true, name: true, legalName: true, municipality: true, province: true },
            take: perKind
          }),
          [] as Array<{ id: string; name: string; legalName: string | null; municipality: string | null; province: string | null }>
        )
      : Promise.resolve([]),

    wants("rate_plan") && input.propertyId
      ? safe(
          prisma.ratePlan.findMany({
            where: {
              propertyId: input.propertyId,
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { code: { contains: q, mode: "insensitive" } }
              ]
            },
            select: { id: true, name: true, code: true, mealPlan: true, ratePlanType: true },
            take: perKind
          }),
          [] as Array<{ id: string; name: string; code: string; mealPlan: string | null; ratePlanType: string }>
        )
      : Promise.resolve([])
  ]);

  // Merge reservations + reservationsByGuest, de-dupe by id.
  const resById = new Map<string, (typeof reservations)[number] & { guestPreview?: string }>();
  for (const r of reservations) resById.set(r.id, r);
  for (const r of reservationsByGuest) {
    if (!resById.has(r.id)) resById.set(r.id, r);
  }

  const items: SearchHit[] = [];

  for (const r of resById.values()) {
    const arrival = r.arrivalDate.toISOString().slice(0, 10);
    const departure = r.departureDate.toISOString().slice(0, 10);
    const subtitleBits = [
      r.bookerName ?? r.companyName ?? (r as { guestPreview?: string }).guestPreview ?? "—",
      `${arrival} → ${departure}`,
      r.channel
    ].filter(Boolean);
    items.push({
      kind: "reservation",
      id: r.id,
      title: r.code,
      subtitle: trimText(subtitleBits.join(" · "), 90),
      badge: r.status,
      screen: "ReservationDetailWorkspace",
      params: { reservationId: r.id }
    });
  }

  for (const g of guests) {
    const name = guestDisplayName(g);
    const subtitleBits = [g.company, g.nationality, g.documentNumber].filter(Boolean) as string[];
    items.push({
      kind: "guest",
      id: g.id,
      title: name,
      subtitle: trimText(subtitleBits.join(" · "), 90) || undefined,
      badge: g.vipCode ?? undefined,
      screen: "GuestDetail",
      params: { guestId: g.id }
    });
  }

  for (const r of rooms) {
    items.push({
      kind: "room",
      id: r.id,
      title: `Habitación ${r.number}${r.displayName ? ` · ${r.displayName}` : ""}`,
      subtitle: [r.floor ? `Planta ${r.floor}` : null, r.roomCode].filter(Boolean).join(" · ") || undefined,
      badge: r.status,
      screen: "RoomInventoryManager",
      params: { roomId: r.id }
    });
  }

  for (const f of folios) {
    items.push({
      kind: "folio",
      id: f.id,
      title: `Folio ${f.label}${f.isPrimary ? " (principal)" : ""}`,
      subtitle: `Reserva ${f.reservationId.slice(0, 10)}… · ${f.currency}`,
      badge: f.status,
      screen: "FolioRouting",
      params: { folioId: f.id, reservationId: f.reservationId }
    });
  }

  for (const i of invoices) {
    items.push({
      kind: "invoice",
      id: i.id,
      title: i.invoiceNumber ? `Factura ${i.invoiceNumber}` : `Borrador ${i.id.slice(0, 8)}`,
      subtitle: [i.customerTaxId ?? i.customerType, `${i.currencyCode} ${String(i.total)}`].filter(Boolean).join(" · "),
      badge: i.status,
      screen: "BillingCenter",
      params: { invoiceId: i.id }
    });
  }

  for (const p of properties) {
    items.push({
      kind: "property",
      id: p.id,
      title: p.name,
      subtitle: [p.legalName, p.municipality, p.province].filter(Boolean).join(" · ") || undefined,
      screen: "PropertyDetail",
      params: { propertyId: p.id }
    });
  }

  for (const r of ratePlans) {
    items.push({
      kind: "rate_plan",
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.mealPlan, r.ratePlanType].filter(Boolean).join(" · ") || undefined,
      screen: "RatePlanManager",
      params: { ratePlanId: r.id }
    });
  }

  const counts: Record<string, number> = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;

  return { items, counts, took_ms: Date.now() - t0 };
}
