// Sales / Groups / Events — REAL Prisma persistence.
//
// Replaces the demo-store advanced-record writes so that writes land in the same
// canonical tables (SalesAccount, SalesOpportunity, GroupBooking, GroupRoomBlock,
// Event, EventSpace) that the sales-pipeline and groups-events dashboards read.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError } from "../../lib/http-error.js";

type Payload = Record<string, unknown>;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function date(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const d = new Date(v.length <= 10 ? `${v}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
function json(v: unknown): Prisma.InputJsonValue {
  return (v && typeof v === "object" ? v : {}) as Prisma.InputJsonValue;
}

function audit(context: UserContext, action: string, entityType: string, entityId: string, after: unknown, correlationId: string, propertyId?: string) {
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: propertyId ?? context.propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action,
    entityType,
    entityId,
    afterJson: after as Prisma.InputJsonValue,
    correlationId
  });
}

// ---- Sales accounts -------------------------------------------------------
export function listSalesAccounts(organizationId: string) {
  return prisma.salesAccount.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function createSalesAccount(input: { context: UserContext; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["sales.pipeline.manage"]);
  const name = str(input.payload.name);
  if (!name) throw new BadRequestError("name is required.");
  const row = await prisma.salesAccount.create({
    data: {
      organizationId: input.context.organizationId,
      accountType: str(input.payload.accountType, "corporate"),
      name,
      taxId: optStr(input.payload.taxId),
      contactJson: json(input.payload.contact),
      billingJson: json(input.payload.billing),
      status: str(input.payload.status, "active")
    }
  });
  audit(input.context, "SALES_ACCOUNT_CREATED", "sales_account", row.id, row, input.correlationId);
  return row;
}

// ---- Sales opportunities --------------------------------------------------
export function listSalesOpportunities(propertyId: string) {
  return prisma.salesOpportunity.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function createSalesOpportunity(input: { context: UserContext; propertyId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["sales.pipeline.manage"]);
  const name = str(input.payload.name);
  if (!name) throw new BadRequestError("name is required.");
  const row = await prisma.salesOpportunity.create({
    data: {
      propertyId: input.propertyId,
      accountId: optStr(input.payload.accountId),
      name,
      opportunityType: str(input.payload.opportunityType, "group"),
      stage: str(input.payload.stage, "prospect"),
      estimatedValue: num(input.payload.estimatedValue),
      expectedValue: num(input.payload.expectedValue),
      probability: num(input.payload.probability),
      expectedCloseDate: date(input.payload.expectedCloseDate),
      ownerUserId: optStr(input.payload.ownerUserId) ?? input.context.userId
    }
  });
  audit(input.context, "SALES_OPPORTUNITY_CREATED", "sales_opportunity", row.id, row, input.correlationId, input.propertyId);
  return row;
}

export async function updateSalesOpportunity(input: { context: UserContext; id: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["sales.pipeline.manage"]);
  const data: Prisma.SalesOpportunityUpdateInput = {};
  if (input.payload.stage !== undefined) data.stage = str(input.payload.stage);
  if (input.payload.name !== undefined) data.name = str(input.payload.name);
  if (input.payload.estimatedValue !== undefined) data.estimatedValue = num(input.payload.estimatedValue);
  if (input.payload.expectedValue !== undefined) data.expectedValue = num(input.payload.expectedValue);
  if (input.payload.probability !== undefined) data.probability = num(input.payload.probability);
  if (input.payload.expectedCloseDate !== undefined) data.expectedCloseDate = date(input.payload.expectedCloseDate);
  const row = await prisma.salesOpportunity.update({ where: { id: input.id }, data });
  audit(input.context, "SALES_OPPORTUNITY_UPDATED", "sales_opportunity", row.id, row, input.correlationId, row.propertyId);
  return row;
}

// ---- Group bookings -------------------------------------------------------
export function listGroupBookings(propertyId: string) {
  return prisma.groupBooking.findMany({ where: { propertyId }, orderBy: { arrivalDate: "asc" }, take: 200 });
}

export async function getGroupBooking(id: string) {
  const row = await prisma.groupBooking.findUnique({ where: { id } });
  if (!row) throw new BadRequestError("Group booking not found.");
  const roomBlocks = await prisma.groupRoomBlock.findMany({ where: { groupBookingId: id }, orderBy: { date: "asc" } });
  return { ...row, roomBlocks };
}

export async function createGroupBooking(input: { context: UserContext; propertyId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["groups.manage"]);
  const name = str(input.payload.name);
  const arrivalDate = date(input.payload.arrivalDate);
  const departureDate = date(input.payload.departureDate);
  if (!name) throw new BadRequestError("name is required.");
  if (!arrivalDate || !departureDate) throw new BadRequestError("arrivalDate and departureDate are required.");
  if (departureDate <= arrivalDate) throw new BadRequestError("departureDate must be after arrivalDate.");

  const code = optStr(input.payload.code);
  if (code) {
    const existing = await prisma.groupBooking.findFirst({ where: { propertyId: input.propertyId, code } });
    if (existing) throw new BadRequestError(`Group booking code "${code}" already exists for this property.`);
  }

  const rateType = str(input.payload.rateType, "net");
  const commissionPct = num(input.payload.commissionPct);
  if (rateType === "commissionable") {
    if (commissionPct === undefined || commissionPct < 0 || commissionPct > 100) {
      throw new BadRequestError("commissionPct must be between 0 and 100 when rateType is commissionable.");
    }
  }

  const cutOffDate = date(input.payload.cutOffDate);
  if (cutOffDate && cutOffDate >= arrivalDate) {
    throw new BadRequestError("cutOffDate must be before arrivalDate.");
  }

  const roomingListDueDate = date(input.payload.roomingListDueDate);
  if (roomingListDueDate && cutOffDate && roomingListDueDate > cutOffDate) {
    throw new BadRequestError("roomingListDueDate must be on or before cutOffDate.");
  }

  const row = await prisma.groupBooking.create({
    data: {
      propertyId: input.propertyId,
      accountId: optStr(input.payload.accountId),
      opportunityId: optStr(input.payload.opportunityId),
      name,
      status: str(input.payload.status, "draft"),
      arrivalDate,
      departureDate,
      releaseDate: date(input.payload.releaseDate),
      billingRulesJson: json(input.payload.billingRules),
      code,
      groupType: str(input.payload.groupType, "corporate"),
      marketCode: optStr(input.payload.marketCode),
      sourceCode: optStr(input.payload.sourceCode),
      assignedToUserId: optStr(input.payload.assignedToUserId),
      contactPersonName: optStr(input.payload.contactPersonName),
      contactEmail: optStr(input.payload.contactEmail),
      contactPhone: optStr(input.payload.contactPhone),
      contactRole: optStr(input.payload.contactRole),
      companyName: optStr(input.payload.companyName),
      companyTaxId: optStr(input.payload.companyTaxId),
      companyAddress: optStr(input.payload.companyAddress),
      industry: optStr(input.payload.industry),
      contractedRate: num(input.payload.contractedRate),
      currency: str(input.payload.currency, "EUR"),
      rateType,
      commissionPct,
      cutOffDate,
      roomingListDueDate,
      attritionType: str(input.payload.attritionType, "cumulative"),
      attritionThresholdPct: num(input.payload.attritionThresholdPct) ?? 80,
      attritionPenaltyPct: num(input.payload.attritionPenaltyPct) ?? 100,
      billingMethod: str(input.payload.billingMethod, "master_folio"),
      paymentMethod: str(input.payload.paymentMethod, "cc_guarantee"),
      depositPct: num(input.payload.depositPct),
      breakfastIncluded: input.payload.breakfastIncluded === true,
      mealPlan: str(input.payload.mealPlan, "none"),
      welcomeCocktail: input.payload.welcomeCocktail === true,
      galaDinner: input.payload.galaDinner === true,
      regimenEspecialAaee: input.payload.regimenEspecialAaee === true,
      confidentialArrival: input.payload.confidentialArrival === true,
      notes: optStr(input.payload.notes)
    }
  });
  audit(input.context, "GROUP_BOOKING_CREATED", "group_booking", row.id, row, input.correlationId, input.propertyId);
  return row;
}

export async function updateGroupBooking(input: { context: UserContext; id: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["groups.manage"]);
  const data: Prisma.GroupBookingUpdateInput = {};
  const p = input.payload;

  // Core/identity
  if (p.name !== undefined) data.name = str(p.name);
  if (p.groupType !== undefined) data.groupType = str(p.groupType);
  if (p.status !== undefined) data.status = str(p.status);
  if (p.marketCode !== undefined) data.marketCode = optStr(p.marketCode);
  if (p.sourceCode !== undefined) data.sourceCode = optStr(p.sourceCode);

  // Dates
  if (p.arrivalDate !== undefined) data.arrivalDate = date(p.arrivalDate);
  if (p.departureDate !== undefined) data.departureDate = date(p.departureDate);
  if (p.releaseDate !== undefined) data.releaseDate = date(p.releaseDate);

  // Ownership
  if (p.assignedToUserId !== undefined) data.assignedToUserId = optStr(p.assignedToUserId);

  // Contact
  if (p.contactPersonName !== undefined) data.contactPersonName = optStr(p.contactPersonName);
  if (p.contactEmail !== undefined) data.contactEmail = optStr(p.contactEmail);
  if (p.contactPhone !== undefined) data.contactPhone = optStr(p.contactPhone);
  if (p.contactRole !== undefined) data.contactRole = optStr(p.contactRole);

  // Company
  if (p.companyName !== undefined) data.companyName = optStr(p.companyName);
  if (p.companyTaxId !== undefined) data.companyTaxId = optStr(p.companyTaxId);
  if (p.companyAddress !== undefined) data.companyAddress = optStr(p.companyAddress);
  if (p.industry !== undefined) data.industry = optStr(p.industry);

  // Rate
  if (p.contractedRate !== undefined) data.contractedRate = num(p.contractedRate);
  if (p.currency !== undefined) data.currency = str(p.currency, "EUR");
  if (p.rateType !== undefined) data.rateType = str(p.rateType, "net");
  if (p.commissionPct !== undefined) data.commissionPct = num(p.commissionPct);

  // Pickup / attrition
  if (p.cutOffDate !== undefined) data.cutOffDate = date(p.cutOffDate);
  if (p.roomingListDueDate !== undefined) data.roomingListDueDate = date(p.roomingListDueDate);
  if (p.attritionType !== undefined) data.attritionType = str(p.attritionType, "cumulative");
  if (p.attritionThresholdPct !== undefined) data.attritionThresholdPct = num(p.attritionThresholdPct);
  if (p.attritionPenaltyPct !== undefined) data.attritionPenaltyPct = num(p.attritionPenaltyPct);

  // Billing / payment
  if (p.billingMethod !== undefined) data.billingMethod = str(p.billingMethod, "master_folio");
  if (p.paymentMethod !== undefined) data.paymentMethod = str(p.paymentMethod, "cc_guarantee");
  if (p.depositPct !== undefined) data.depositPct = num(p.depositPct);

  // F&B / extras
  if (p.breakfastIncluded !== undefined) data.breakfastIncluded = p.breakfastIncluded === true;
  if (p.mealPlan !== undefined) data.mealPlan = str(p.mealPlan, "none");
  if (p.welcomeCocktail !== undefined) data.welcomeCocktail = p.welcomeCocktail === true;
  if (p.galaDinner !== undefined) data.galaDinner = p.galaDinner === true;
  if (p.regimenEspecialAaee !== undefined) data.regimenEspecialAaee = p.regimenEspecialAaee === true;
  if (p.confidentialArrival !== undefined) data.confidentialArrival = p.confidentialArrival === true;
  if (p.notes !== undefined) data.notes = optStr(p.notes);

  // Cross-field validations — fetch current row when partial updates need
  // the persisted value to compare against (e.g. only arrivalDate is sent
  // but cutOffDate stays the same).
  const needsExisting =
    data.arrivalDate !== undefined ||
    data.departureDate !== undefined ||
    data.cutOffDate !== undefined ||
    (data.rateType !== undefined || data.commissionPct !== undefined);
  const existing = needsExisting
    ? await prisma.groupBooking.findUnique({ where: { id: input.id } })
    : null;
  if (needsExisting && !existing) throw new BadRequestError("Group booking not found.");

  const effectiveRateType = (data.rateType as string | undefined) ?? existing?.rateType;
  const effectiveCommission = data.commissionPct !== undefined
    ? (data.commissionPct as number | null | undefined)
    : existing?.commissionPct !== undefined && existing?.commissionPct !== null
      ? Number(existing.commissionPct)
      : undefined;
  if (effectiveRateType === "commissionable") {
    if (effectiveCommission === undefined || effectiveCommission === null || effectiveCommission < 0 || effectiveCommission > 100) {
      throw new BadRequestError("commissionPct must be between 0 and 100 when rateType is commissionable.");
    }
  }

  const effectiveArrival = (data.arrivalDate as Date | undefined) ?? (existing ? new Date(existing.arrivalDate) : undefined);
  const effectiveDeparture = (data.departureDate as Date | undefined) ?? (existing ? new Date(existing.departureDate) : undefined);
  if (effectiveArrival && effectiveDeparture && effectiveDeparture <= effectiveArrival) {
    throw new BadRequestError("departureDate must be after arrivalDate.");
  }

  const effectiveCutOff = data.cutOffDate !== undefined
    ? (data.cutOffDate as Date | null | undefined)
    : existing?.cutOffDate
      ? new Date(existing.cutOffDate)
      : undefined;
  if (effectiveCutOff && effectiveArrival && effectiveCutOff >= effectiveArrival) {
    throw new BadRequestError("cutOffDate must be before arrivalDate.");
  }

  const row = await prisma.groupBooking.update({ where: { id: input.id }, data });
  audit(input.context, "GROUP_BOOKING_UPDATED", "group_booking", row.id, row, input.correlationId, row.propertyId);
  return row;
}

export async function createGroupRoomBlock(input: { context: UserContext; groupId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["groups.block_inventory"]);
  const roomTypeId = str(input.payload.roomTypeId);
  const blockDate = date(input.payload.date);
  const blockedCount = num(input.payload.blockedCount);
  if (!roomTypeId || !blockDate || blockedCount === undefined) {
    throw new BadRequestError("roomTypeId, date and blockedCount are required.");
  }
  const row = await prisma.groupRoomBlock.create({
    data: {
      groupBookingId: input.groupId,
      roomTypeId,
      date: blockDate,
      blockedCount,
      pickedUpCount: num(input.payload.pickedUpCount) ?? 0,
      rate: num(input.payload.rate)
    }
  });
  audit(input.context, "GROUP_ROOM_BLOCK_CREATED", "group_room_block", row.id, row, input.correlationId);
  return row;
}

// ---- Group room blocks (bulk) --------------------------------------------
// The grid UI sends an array of (roomTypeId, date, blockedCount, rate?) tuples
// representing one cell each. We upsert by (groupBookingId, roomTypeId, date)
// so the same call works for both "create" (empty cell) and "update" (existing
// allocation). Validations ensure the date is inside the contracted window and
// the blocked count is positive — anything ≤0 is treated as a delete elsewhere.
export async function bulkCreateGroupRoomBlocks(input: { context: UserContext; groupId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["groups.manage"]);
  const group = await getGroupBooking(input.groupId);
  const blocks = Array.isArray((input.payload as { blocks?: unknown }).blocks)
    ? ((input.payload as { blocks: unknown[] }).blocks)
    : [];
  if (blocks.length === 0) throw new BadRequestError("blocks array is required and must not be empty.");

  const arrival = new Date(group.arrivalDate);
  const departure = new Date(group.departureDate);

  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Payload;
      const roomTypeId = str(b.roomTypeId);
      const blockDate = date(b.date);
      const blockedCount = num(b.blockedCount);
      const rate = num(b.rate);
      if (!roomTypeId) throw new BadRequestError(`blocks[${i}].roomTypeId is required.`);
      if (!blockDate) throw new BadRequestError(`blocks[${i}].date is required (YYYY-MM-DD).`);
      if (blockedCount === undefined || blockedCount <= 0) {
        throw new BadRequestError(`blocks[${i}].blockedCount must be > 0.`);
      }
      if (blockDate < arrival || blockDate >= departure) {
        throw new BadRequestError(`blocks[${i}].date must be between arrivalDate and departureDate of the group.`);
      }
      const existing = await tx.groupRoomBlock.findFirst({
        where: { groupBookingId: input.groupId, roomTypeId, date: blockDate }
      });
      if (existing) {
        await tx.groupRoomBlock.update({
          where: { id: existing.id },
          data: { blockedCount, rate: rate ?? existing.rate }
        });
        updated += 1;
      } else {
        await tx.groupRoomBlock.create({
          data: {
            groupBookingId: input.groupId,
            roomTypeId,
            date: blockDate,
            blockedCount,
            pickedUpCount: 0,
            rate
          }
        });
        created += 1;
      }
    }
  });
  const result = { created, updated, total: blocks.length };
  audit(input.context, "GROUP_ROOM_BLOCK_BULK_UPSERT", "group_booking", input.groupId, result, input.correlationId);
  return result;
}

// ---- Group events ---------------------------------------------------------
// Convenience wrapper that ties an Event to a group with the group's propertyId
// so the frontend doesn't have to re-send it. Validates the event window falls
// within the group's stay (with a ±1 day tolerance so a pre-arrival cocktail or
// post-departure brunch is accepted).
export async function createGroupEvent(input: { context: UserContext; groupId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["events.manage"]);
  const group = await getGroupBooking(input.groupId);
  const name = str(input.payload.name);
  const startAt = date(input.payload.startAt);
  const endAt = date(input.payload.endAt);
  if (!name) throw new BadRequestError("name is required.");
  if (!startAt || !endAt) throw new BadRequestError("startAt and endAt are required.");
  if (endAt <= startAt) throw new BadRequestError("endAt must be after startAt.");

  const DAY_MS = 24 * 60 * 60 * 1000;
  const arrival = new Date(group.arrivalDate);
  const departure = new Date(group.departureDate);
  const windowStart = new Date(arrival.getTime() - DAY_MS);
  const windowEnd = new Date(departure.getTime() + DAY_MS);
  if (startAt < windowStart || endAt > windowEnd) {
    throw new BadRequestError("Event window must be within the group stay (±1 day tolerance).");
  }

  const setup: Record<string, unknown> = {};
  const setupStyle = optStr(input.payload.setupStyle);
  if (setupStyle) setup.style = setupStyle;
  const expectedAttendees = num(input.payload.expectedAttendees);
  if (expectedAttendees !== undefined) setup.expectedAttendees = expectedAttendees;
  const notes = optStr(input.payload.notes);
  if (notes) setup.notes = notes;

  const row = await prisma.event.create({
    data: {
      propertyId: group.propertyId,
      groupBookingId: group.id,
      eventSpaceId: optStr(input.payload.eventSpaceId),
      name,
      eventType: optStr(input.payload.eventType),
      startAt,
      endAt,
      status: str(input.payload.status, "draft"),
      setupJson: setup as Prisma.InputJsonValue,
      cateringJson: json(input.payload.catering)
    }
  });
  audit(input.context, "EVENT_CREATED", "event", row.id, row, input.correlationId, group.propertyId);
  return row;
}

export async function listPropertyEventSpaces(propertyId: string) {
  return prisma.eventSpace.findMany({
    where: { propertyId, active: true },
    orderBy: { name: "asc" }
  });
}

// ---- Rooming list import --------------------------------------------------
// Imports a CSV / spreadsheet rooming list one row at a time. Each row maps to
// (1) a Guest (de-duped by email or by full name within the same org); (2) a
// Reservation linked to the group via the group's code; (3) a pickedUp tick on
// each GroupRoomBlock cell the night covers. Rows that fail validation are
// reported in the errors array — the rest still import so partial imports are
// possible.
export async function importRoomingList(input: { context: UserContext; groupId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["groups.manage"]);
  const group = await getGroupBooking(input.groupId);
  const property = await prisma.property.findUnique({ where: { id: group.propertyId } });
  if (!property) throw new BadRequestError("Property for this group not found.");

  const entries = Array.isArray((input.payload as { entries?: unknown }).entries)
    ? ((input.payload as { entries: unknown[] }).entries)
    : [];
  if (entries.length === 0) throw new BadRequestError("entries array is required and must not be empty.");

  const errors: Array<{ row: number; message: string }> = [];
  let imported = 0;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Payload;
    try {
      const firstName = str(e.firstName);
      const lastName = str(e.lastName);
      const email = optStr(e.email);
      const phone = optStr(e.phone);
      const arrivalDate = date(e.arrivalDate);
      const departureDate = date(e.departureDate);
      const roomTypeId = str(e.roomTypeId);
      if (!firstName || !lastName) throw new BadRequestError("firstName and lastName are required.");
      if (!arrivalDate || !departureDate) throw new BadRequestError("arrivalDate and departureDate are required.");
      if (departureDate <= arrivalDate) throw new BadRequestError("departureDate must be after arrivalDate.");
      if (!roomTypeId) throw new BadRequestError("roomTypeId is required.");

      let guest = null;
      if (email) {
        guest = await prisma.guest.findFirst({
          where: { organizationId: property.organizationId, email }
        });
      }
      if (!guest) {
        guest = await prisma.guest.findFirst({
          where: {
            organizationId: property.organizationId,
            firstName,
            surname1: lastName
          }
        });
      }
      if (!guest) {
        guest = await prisma.guest.create({
          data: {
            organizationId: property.organizationId,
            firstName,
            surname1: lastName,
            email,
            phone
          }
        });
      }

      const code = `${group.code ?? group.id.slice(0, 6)}-${String(i + 1).padStart(3, "0")}`;
      const reservation = await prisma.reservation.create({
        data: {
          propertyId: group.propertyId,
          code,
          channel: "group",
          status: "confirmed",
          arrivalDate,
          departureDate,
          adults: 1,
          children: 0,
          roomsCount: 1,
          roomTypeId,
          groupCode: group.code ?? group.id,
          companyName: group.companyName,
          specialRequests: optStr(e.specialRequests),
          notes: [optStr(e.sharing) ? `sharing: ${optStr(e.sharing)}` : null, optStr(e.dietary) ? `dietary: ${optStr(e.dietary)}` : null]
            .filter((v): v is string => Boolean(v))
            .join("; ") || null
        }
      });
      await prisma.reservationGuest.create({
        data: { reservationId: reservation.id, guestId: guest.id, isPrimary: true }
      });

      // Bump pickedUpCount on every night the rooming entry covers — that is
      // how the grid UI's "picked up vs blocked" indicator stays in sync.
      const cursor = new Date(arrivalDate);
      while (cursor < departureDate) {
        const block = await prisma.groupRoomBlock.findFirst({
          where: { groupBookingId: group.id, roomTypeId, date: cursor }
        });
        if (block) {
          await prisma.groupRoomBlock.update({
            where: { id: block.id },
            data: { pickedUpCount: block.pickedUpCount + 1 }
          });
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      imported += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ row: i + 1, message });
    }
  }

  const summary = { imported, errors };
  audit(input.context, "ROOMING_LIST_IMPORTED", "group_booking", input.groupId, summary, input.correlationId, group.propertyId);
  return summary;
}

// getGroupsPickupSummary: dashboard data for the GroupsScreen — aggregates the
// pickup vs. blocked vs. remaining for the next N days, grouped by group booking.
// Highlights groups below their attrition threshold and computes daysToCutOff so
// the UI can show "Groups requiring action" before cut-off date arrives. Mirrors
// the allotment getPickupSummary pattern used for B2B contracted blocks.
export type GroupPickupSummaryDay = {
  date: string;
  blocked: number;
  pickedUp: number;
  remaining: number;
};
export type GroupPickupSummary = {
  groupBookingId: string;
  code: string;
  name: string;
  groupType: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  cutOffDate: string | null;
  totalBlocked: number;
  totalPickedUp: number;
  totalRemaining: number;
  pickupPct: number;
  attritionThresholdPct: number;
  daysToCutOff: number | null;
  daysToArrival: number;
  belowAttritionThreshold: boolean;
  days: GroupPickupSummaryDay[];
};

const MS_DAY = 86_400_000;
function asUtcDate(v: string | Date): Date {
  const d = new Date(v);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function daysBetweenUtc(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

export async function getGroupsPickupSummary(input: {
  propertyId: string;
  windowDays?: number;
}): Promise<{ generatedAt: string; window: { from: string; to: string }; groups: GroupPickupSummary[] }> {
  const today = asUtcDate(new Date().toISOString());
  const windowDays = Math.min(Math.max(input.windowDays ?? 90, 1), 365);
  const to = new Date(today.getTime() + windowDays * MS_DAY);

  const groups = await prisma.groupBooking.findMany({
    where: {
      propertyId: input.propertyId,
      status: { in: ["tentative", "definite", "in_house"] },
      arrivalDate: { gte: today, lte: to }
    },
    orderBy: { arrivalDate: "asc" }
  });

  const result: GroupPickupSummary[] = [];
  for (const g of groups) {
    const blocks = await prisma.groupRoomBlock.findMany({
      where: { groupBookingId: g.id },
      orderBy: { date: "asc" }
    });

    // Aggregate per night across all room types contracted for the group.
    const byDate = new Map<string, { blocked: number; pickedUp: number }>();
    for (const b of blocks) {
      const key = b.date.toISOString().slice(0, 10);
      const acc = byDate.get(key) ?? { blocked: 0, pickedUp: 0 };
      acc.blocked += b.blockedCount;
      acc.pickedUp += b.pickedUpCount;
      byDate.set(key, acc);
    }
    const days: GroupPickupSummaryDay[] = Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({
        date,
        blocked: v.blocked,
        pickedUp: v.pickedUp,
        remaining: Math.max(0, v.blocked - v.pickedUp)
      }));

    const totalBlocked = days.reduce((s, d) => s + d.blocked, 0);
    const totalPickedUp = days.reduce((s, d) => s + d.pickedUp, 0);
    const totalRemaining = days.reduce((s, d) => s + d.remaining, 0);
    const pickupPct = totalBlocked > 0 ? Math.round((totalPickedUp * 100) / totalBlocked) : 0;

    const arrival = asUtcDate(g.arrivalDate);
    const daysToArrival = daysBetweenUtc(today, arrival);
    const cutOffDate = g.cutOffDate ? asUtcDate(g.cutOffDate) : null;
    const daysToCutOff = cutOffDate ? daysBetweenUtc(today, cutOffDate) : null;
    const attritionThresholdPct = Number(g.attritionThresholdPct);
    const belowAttritionThreshold = pickupPct < attritionThresholdPct;

    result.push({
      groupBookingId: g.id,
      code: g.code ?? "",
      name: g.name,
      groupType: g.groupType,
      status: g.status,
      arrivalDate: g.arrivalDate.toISOString().slice(0, 10),
      departureDate: g.departureDate.toISOString().slice(0, 10),
      cutOffDate: cutOffDate ? cutOffDate.toISOString().slice(0, 10) : null,
      totalBlocked,
      totalPickedUp,
      totalRemaining,
      pickupPct,
      attritionThresholdPct,
      daysToCutOff,
      daysToArrival,
      belowAttritionThreshold,
      days
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { from: today.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    groups: result
  };
}

// releaseExpiredGroupBlocks: daily cut-off enforcement — for every group still
// in tentative/definite whose cutOffDate has passed, flip status to "released"
// and emit a GROUP_BLOCK_RELEASED audit event with the count of un-picked rooms
// returned to general availability. Idempotent: terminal statuses are filtered
// out and only groups with a past cutOffDate are processed.
export async function releaseExpiredGroupBlocks(propertyId: string): Promise<{ released: number; totalRoomsReleased: number }> {
  const today = asUtcDate(new Date().toISOString());
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  const organizationId = property?.organizationId;

  const groups = await prisma.groupBooking.findMany({
    where: {
      propertyId,
      status: { in: ["tentative", "definite"] },
      cutOffDate: { lte: today, not: null }
    }
  });

  let released = 0;
  let totalRoomsReleased = 0;
  for (const g of groups) {
    const blocks = await prisma.groupRoomBlock.findMany({ where: { groupBookingId: g.id } });
    const roomsReleased = blocks.reduce((s, b) => s + Math.max(0, b.blockedCount - b.pickedUpCount), 0);
    await prisma.groupBooking.update({
      where: { id: g.id },
      data: { status: "released", releaseDate: new Date() }
    });
    released += 1;
    totalRoomsReleased += roomsReleased;
    if (organizationId) {
      recordAuditEvent({
        organizationId,
        propertyId,
        actorType: "system",
        action: "GROUP_BLOCK_RELEASED",
        entityType: "group_booking",
        entityId: g.id,
        afterJson: { roomsReleased, cutOffDate: g.cutOffDate, previousStatus: g.status } as Prisma.InputJsonValue
      });
    }
  }
  return { released, totalRoomsReleased };
}

// createGroupMasterFolio: create (or return existing) master folio for a group.
// Idempotent — if the GroupBooking already has masterFolioId set, returns the
// existing one and reports alreadyExisted=true.
//
// LIMITATION: the canonical Folio model in schema.prisma is tightly tied to a
// Reservation (folios.reservationId NOT NULL, ON DELETE CASCADE) and does not
// expose propertyId / accountId / name fields. A "master group folio" that
// aggregates charges across all the group's reservations does not fit the
// current Folio shape (which is per-reservation). Until the data model gains a
// proper PropertyFolio / AccountFolio (or the Folio model is generalized), this
// function generates a synthetic master-folio identifier and persists it on
// GroupBooking.masterFolioId so downstream callers can route charges by it.
// The identifier is `folio_<groupId>` so it stays stable across retries — that
// keeps the call idempotent even if the GroupBooking row hasn't been refreshed
// yet by the caller.
export async function createGroupMasterFolio(input: { context: UserContext; groupId: string; correlationId: string }) {
  requirePermissions(input.context, ["groups.manage"]);
  const group = await prisma.groupBooking.findUnique({ where: { id: input.groupId } });
  if (!group) throw new BadRequestError("Group booking not found.");

  if (group.masterFolioId) {
    return { folioId: group.masterFolioId, masterFolioId: group.masterFolioId, alreadyExisted: true };
  }

  // Synthetic id — deterministic on groupId so retries don't drift. See note
  // above re: schema limitations.
  const folioId = `folio_${group.id}`;
  await prisma.groupBooking.update({ where: { id: group.id }, data: { masterFolioId: folioId } });

  audit(
    input.context,
    "GROUP_MASTER_FOLIO_CREATED",
    "group_booking",
    group.id,
    { folioId, groupBookingId: group.id, name: `Master · ${group.name}`, status: "open" },
    input.correlationId,
    group.propertyId
  );
  return { folioId, masterFolioId: folioId, alreadyExisted: false };
}

export async function releaseGroupUnsold(input: { context: UserContext; groupId: string; correlationId: string }) {
  requirePermissions(input.context, ["groups.block_inventory"]);
  // Shrink each block to what was actually picked up; flag the group as released.
  const blocks = await prisma.groupRoomBlock.findMany({ where: { groupBookingId: input.groupId } });
  let releasedRooms = 0;
  await prisma.$transaction(async (tx) => {
    for (const b of blocks) {
      const released = Math.max(0, b.blockedCount - b.pickedUpCount);
      releasedRooms += released;
      if (released > 0) await tx.groupRoomBlock.update({ where: { id: b.id }, data: { blockedCount: b.pickedUpCount } });
    }
    await tx.groupBooking.update({ where: { id: input.groupId }, data: { releaseDate: new Date() } });
  });
  audit(input.context, "GROUP_ROOM_BLOCK_RELEASED", "group_booking", input.groupId, { releasedRooms }, input.correlationId);
  return { groupId: input.groupId, releasedRooms };
}

// ---- Events ---------------------------------------------------------------
export async function createEventSpace(input: { context: UserContext; propertyId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["events.manage_spaces"]);
  const name = str(input.payload.name);
  if (!name) throw new BadRequestError("name is required.");
  const row = await prisma.eventSpace.create({
    data: {
      propertyId: input.propertyId,
      name,
      spaceId: optStr(input.payload.spaceId),
      capacityJson: json(input.payload.capacity),
      active: input.payload.active === undefined ? true : Boolean(input.payload.active)
    }
  });
  audit(input.context, "EVENT_SPACE_CREATED", "event_space", row.id, row, input.correlationId, input.propertyId);
  return row;
}

export async function createEvent(input: { context: UserContext; propertyId: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["events.manage"]);
  const name = str(input.payload.name);
  const startAt = date(input.payload.startAt);
  const endAt = date(input.payload.endAt);
  if (!name) throw new BadRequestError("name is required.");
  if (!startAt || !endAt) throw new BadRequestError("startAt and endAt are required.");
  if (endAt <= startAt) throw new BadRequestError("endAt must be after startAt.");
  const row = await prisma.event.create({
    data: {
      propertyId: input.propertyId,
      groupBookingId: optStr(input.payload.groupBookingId),
      eventSpaceId: optStr(input.payload.eventSpaceId),
      name,
      eventType: optStr(input.payload.eventType),
      startAt,
      endAt,
      status: str(input.payload.status, "draft"),
      setupJson: json(input.payload.setup),
      cateringJson: json(input.payload.catering)
    }
  });
  audit(input.context, "EVENT_CREATED", "event", row.id, row, input.correlationId, input.propertyId);
  return row;
}

export async function updateEvent(input: { context: UserContext; id: string; payload: Payload; correlationId: string }) {
  requirePermissions(input.context, ["events.manage"]);
  const data: Prisma.EventUpdateInput = {};
  if (input.payload.name !== undefined) data.name = str(input.payload.name);
  if (input.payload.status !== undefined) data.status = str(input.payload.status);
  if (input.payload.eventType !== undefined) data.eventType = optStr(input.payload.eventType);
  if (input.payload.startAt !== undefined) data.startAt = date(input.payload.startAt);
  if (input.payload.endAt !== undefined) data.endAt = date(input.payload.endAt);
  const row = await prisma.event.update({ where: { id: input.id }, data });
  audit(input.context, "EVENT_UPDATED", "event", row.id, row, input.correlationId, row.propertyId);
  return row;
}
