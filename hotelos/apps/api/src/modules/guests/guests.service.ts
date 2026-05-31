// Standalone Guest Profile module — list / search / read / create / update.
//
// Guests are ORGANIZATION-scoped (a profile is shared across the org's
// properties). PII columns (email, phone, mobilePhone, documentNumber, …) are
// transparently encrypted at rest by the Prisma client extension; reads here
// receive plaintext, and equality `where` on those fields is rewritten to the
// deterministic lookup-hash columns by the same extension.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { GuestIdentityFields } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

type GuestRow = NonNullable<Awaited<ReturnType<typeof prisma.guest.findUnique>>>;

function isoDate(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString().slice(0, 10) : undefined;
}
function dateOnly(iso?: string): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}
function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function mapGuest(row: GuestRow) {
  const fullName = [row.firstName, row.surname1, row.surname2].filter(Boolean).join(" ").trim();
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title ?? undefined,
    firstName: row.firstName,
    middleName: row.middleName ?? undefined,
    surname1: row.surname1 ?? undefined,
    surname2: row.surname2 ?? undefined,
    fullName,
    documentType: row.documentType ?? undefined,
    documentNumber: row.documentNumber ?? undefined,
    documentSupportNumber: row.documentSupportNumber ?? undefined,
    documentIssueCountry: row.documentIssueCountry ?? undefined,
    documentExpiryDate: isoDate(row.documentExpiryDate),
    nationality: row.nationality ?? undefined,
    sex: row.sex ?? undefined,
    languagePreference: row.languagePreference ?? undefined,
    dateOfBirth: isoDate(row.dateOfBirth),
    residenceAddress: row.residenceAddress ?? undefined,
    residenceLocality: row.residenceLocality ?? undefined,
    residenceProvince: row.residenceProvince ?? undefined,
    residencePostalCode: row.residencePostalCode ?? undefined,
    residenceCountry: row.residenceCountry ?? undefined,
    phone: row.phone ?? undefined,
    mobilePhone: row.mobilePhone ?? undefined,
    email: row.email ?? undefined,
    company: row.company ?? undefined,
    vipCode: row.vipCode ?? undefined,
    loyaltyProgram: row.loyaltyProgram ?? undefined,
    loyaltyNumber: row.loyaltyNumber ?? undefined,
    loyaltyTier: row.loyaltyTier ?? undefined,
    preferences: Array.isArray(row.preferencesJson) ? (row.preferencesJson as string[]) : [],
    emergencyContactName: row.emergencyContactName ?? undefined,
    emergencyContactPhone: row.emergencyContactPhone ?? undefined,
    marketingConsent: row.marketingConsent ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

export type GuestProfile = ReturnType<typeof mapGuest>;

const EMAIL_RE = /.+@.+\..+/;

/**
 * List/search guests in the caller's organization. Name search is a
 * case-insensitive `contains`; an email- or document-looking term additionally
 * runs an exact lookup-hash match (encrypted columns can't be `contains`-ed).
 */
export async function listGuests(input: {
  context: UserContext;
  search?: string;
  limit?: number;
}): Promise<GuestProfile[]> {
  requirePermissions(input.context, ["guests.read"]);
  const organizationId = input.context.organizationId;
  const take = Math.min(200, Math.max(1, input.limit ?? 100));
  const term = (input.search ?? "").trim();

  if (!term) {
    const rows = await prisma.guest.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take });
    return rows.map(mapGuest);
  }

  const byId = new Map<string, GuestRow>();
  const nameRows = await prisma.guest.findMany({
    where: {
      organizationId,
      OR: [
        { firstName: { contains: term, mode: "insensitive" } },
        { surname1: { contains: term, mode: "insensitive" } },
        { surname2: { contains: term, mode: "insensitive" } },
        { company: { contains: term, mode: "insensitive" } }
      ]
    },
    orderBy: { createdAt: "desc" },
    take
  });
  for (const r of nameRows) byId.set(r.id, r);

  // Exact match on encrypted columns via the extension's lookup-hash rewrite.
  if (EMAIL_RE.test(term)) {
    const emailRows = await prisma.guest.findMany({ where: { organizationId, email: term }, take });
    for (const r of emailRows) byId.set(r.id, r);
  }
  if (/^[A-Za-z0-9-]{5,}$/.test(term)) {
    const docRows = await prisma.guest.findMany({ where: { organizationId, documentNumber: term }, take });
    for (const r of docRows) byId.set(r.id, r);
  }

  return Array.from(byId.values()).slice(0, take).map(mapGuest);
}

async function loadGuestRow(id: string, organizationId: string): Promise<GuestRow> {
  const row = await prisma.guest.findUnique({ where: { id } });
  if (!row || row.organizationId !== organizationId) throw new NotFoundError("Guest not found.");
  return row;
}

/** A single guest profile plus their stay history (reservations across the org). */
export async function getGuest(input: { context: UserContext; id: string }) {
  requirePermissions(input.context, ["guests.read"]);
  const row = await loadGuestRow(input.id, input.context.organizationId);

  const links = await prisma.reservationGuest.findMany({ where: { guestId: row.id } });
  const reservationIds = links.map((l) => l.reservationId);
  const reservations = reservationIds.length
    ? await prisma.reservation.findMany({
        where: { id: { in: reservationIds } },
        orderBy: { arrivalDate: "desc" },
        take: 100
      })
    : [];
  const primaryByReservation = new Map(links.map((l) => [l.reservationId, l.isPrimary] as const));

  const stayHistory = reservations.map((r) => ({
    id: r.id,
    code: r.code,
    propertyId: r.propertyId,
    status: r.status,
    arrivalDate: isoDate(r.arrivalDate),
    departureDate: isoDate(r.departureDate),
    roomTypeId: r.roomTypeId ?? undefined,
    totalAmount: dec(r.totalAmount),
    currency: r.currency,
    isPrimary: primaryByReservation.get(r.id) ?? false
  }));

  const stays = stayHistory.length;
  const lifetimeValue = stayHistory.reduce((sum, s) => sum + s.totalAmount, 0);

  return { guest: mapGuest(row), stayHistory, stats: { stays, lifetimeValue } };
}

function buildGuestData(g: GuestIdentityFields): Prisma.GuestUncheckedCreateInput | Prisma.GuestUpdateInput {
  return {
    title: g.title ?? null,
    middleName: g.middleName ?? null,
    surname1: g.surname1 ?? null,
    surname2: g.surname2 ?? null,
    documentType: g.documentType ?? null,
    documentNumber: g.documentNumber ?? null,
    documentSupportNumber: g.documentSupportNumber ?? null,
    documentIssueCountry: g.documentIssueCountry ?? null,
    documentExpiryDate: g.documentExpiryDate ? dateOnly(g.documentExpiryDate) : null,
    nationality: g.nationality ?? null,
    sex: g.sex ?? null,
    languagePreference: g.languagePreference ?? null,
    dateOfBirth: g.dateOfBirth ? dateOnly(g.dateOfBirth) : null,
    residenceAddress: g.residenceAddress ?? null,
    residenceLocality: g.residenceLocality ?? null,
    residenceProvince: g.residenceProvince ?? null,
    residencePostalCode: g.residencePostalCode ?? null,
    residenceCountry: g.residenceCountry ?? null,
    phone: g.phone ?? null,
    mobilePhone: g.mobilePhone ?? null,
    email: g.email ?? null,
    company: g.company ?? null,
    vipCode: g.vipCode ?? null,
    loyaltyProgram: g.loyaltyProgram ?? null,
    loyaltyNumber: g.loyaltyNumber ?? null,
    loyaltyTier: g.loyaltyTier ?? null,
    preferencesJson: g.preferences && g.preferences.length ? (g.preferences as unknown as Prisma.InputJsonValue) : undefined,
    emergencyContactName: g.emergencyContactName ?? null,
    emergencyContactPhone: g.emergencyContactPhone ?? null,
    marketingConsent: g.marketingConsent ?? null,
    notes: g.notes ?? null
  };
}

export async function createGuest(input: {
  context: UserContext;
  guest: GuestIdentityFields;
  correlationId: string;
}): Promise<GuestProfile> {
  requirePermissions(input.context, ["guests.manage"]);
  if (!input.guest.firstName || !input.guest.firstName.trim()) {
    throw new BadRequestError("Guest first name is required.");
  }
  const data = buildGuestData(input.guest) as Prisma.GuestUncheckedCreateInput;
  const created = await prisma.guest.create({
    data: { ...data, organizationId: input.context.organizationId, firstName: input.guest.firstName.trim() }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_CREATED",
    entityType: "guest",
    entityId: created.id,
    afterJson: { fullName: [created.firstName, created.surname1].filter(Boolean).join(" ") },
    correlationId: input.correlationId
  });
  return mapGuest(created);
}

export async function updateGuest(input: {
  context: UserContext;
  id: string;
  guest: GuestIdentityFields;
  correlationId: string;
}): Promise<GuestProfile> {
  requirePermissions(input.context, ["guests.manage"]);
  await loadGuestRow(input.id, input.context.organizationId); // org-scope guard
  const data = buildGuestData(input.guest);
  if (input.guest.firstName !== undefined) {
    if (!input.guest.firstName.trim()) throw new BadRequestError("Guest first name cannot be empty.");
    (data as Prisma.GuestUpdateInput).firstName = input.guest.firstName.trim();
  }
  const updated = await prisma.guest.update({ where: { id: input.id }, data });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_UPDATED",
    entityType: "guest",
    entityId: updated.id,
    correlationId: input.correlationId
  });
  return mapGuest(updated);
}
