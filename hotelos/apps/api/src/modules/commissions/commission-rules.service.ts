import { prisma, type Prisma } from "@hotelos/database";
import { BadRequestError } from "../../lib/http-error.js";
import { dec, round2 } from "../treasury/money.js";

export const DEFAULT_COMMISSION_EXPENSE_CODE = "629.1";
const APPLIES_TO = new Set(["gross_revenue", "net_revenue", "total"]);

/** "15", 15, "15,5" → "15.50"; refuses anything outside 0–100. */
export function parseRatePct(value: number | string): string {
  const rate = round2(dec(value));
  if (rate.lte(0) || rate.gt(100)) throw new BadRequestError("ratePct debe estar entre 0 y 100.");
  return rate.toFixed(2);
}

// CommissionRule service.
//
// A `CommissionRule` represents a property's contractually-agreed commission
// percentage for an OTA / distribution channel. Two attribution keys are
// supported:
//
//   - `channelId`   — exact FK to a `Channel` row (preferred when the channel
//                     has been onboarded into the channel manager).
//   - `channelCode` — looser provider/source code (e.g. "booking", "expedia")
//                     used when the incoming attribution only carries a code
//                     string (this is what `Reservation.channel` stores today).
//
// Resolution prefers an exact `channelId` match, then falls back to
// `channelCode`. Within those, only `active=true` rules within their
// effective-date window are considered.

export type CommissionRuleRecord = {
  id: string;
  propertyId: string;
  channelId: string | null;
  channelCode: string | null;
  ratePct: string;
  appliesTo: string;
  ledgerAccountCode: string;
  active: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
};

function toRecord(row: {
  id: string;
  propertyId: string;
  channelId: string | null;
  channelCode: string | null;
  ratePct: Prisma.Decimal;
  appliesTo: string;
  ledgerAccountCode: string;
  active: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdAt: Date;
}): CommissionRuleRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    channelId: row.channelId,
    channelCode: row.channelCode,
    ratePct: row.ratePct.toString(),
    appliesTo: row.appliesTo,
    ledgerAccountCode: row.ledgerAccountCode,
    active: row.active,
    effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : null,
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    createdAt: row.createdAt.toISOString()
  };
}

export async function listRules(propertyId: string): Promise<CommissionRuleRecord[]> {
  const rows = await prisma.commissionRule.findMany({
    where: { propertyId },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }]
  });
  return rows.map(toRecord);
}

export type CreateRuleInput = {
  propertyId: string;
  channelId?: string | null;
  channelCode?: string | null;
  ratePct: number | string;
  appliesTo?: "gross_revenue" | "net_revenue" | "total";
  ledgerAccountCode?: string;
  effectiveFrom?: string | Date | null;
  effectiveTo?: string | Date | null;
};

/**
 * Upsert a commission rule by (propertyId, channelId|channelCode) when
 * active=true. If an active rule already exists for that attribution key it is
 * deactivated and a new one is created (preserves history; ratePct can drift
 * over the lifetime of a property).
 */
export async function createRule(input: CreateRuleInput): Promise<CommissionRuleRecord> {
  if (!input.channelId && !input.channelCode) {
    throw new Error("Either channelId or channelCode must be provided.");
  }
  const ratePct = parseRatePct(input.ratePct);
  if (input.appliesTo && !APPLIES_TO.has(input.appliesTo)) {
    throw new BadRequestError("appliesTo debe ser gross_revenue, net_revenue o total.");
  }

  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;

  return prisma.$transaction(async (tx) => {
    // Deactivate any currently-active rule for the same attribution key.
    const existing = await tx.commissionRule.findMany({
      where: {
        propertyId: input.propertyId,
        active: true,
        OR: [
          input.channelId ? { channelId: input.channelId } : { id: "__never__" },
          input.channelCode ? { channelCode: input.channelCode, channelId: null } : { id: "__never__" }
        ]
      }
    });
    if (existing.length > 0) {
      await tx.commissionRule.updateMany({
        where: { id: { in: existing.map((r) => r.id) } },
        data: { active: false, effectiveTo: effectiveFrom ?? new Date() }
      });
    }

    const created = await tx.commissionRule.create({
      data: {
        propertyId: input.propertyId,
        channelId: input.channelId ?? null,
        channelCode: input.channelCode ?? null,
        ratePct,
        appliesTo: input.appliesTo ?? "net_revenue",
        // Canonical PGC subaccount (629.1 Comisiones de canales); "6230" was the seed's legacy default.
        ledgerAccountCode: input.ledgerAccountCode?.trim() || DEFAULT_COMMISSION_EXPENSE_CODE,
        active: true,
        effectiveFrom,
        effectiveTo
      }
    });
    return toRecord(created);
  });
}

export async function deactivateRule(id: string): Promise<CommissionRuleRecord> {
  const updated = await prisma.commissionRule.update({
    where: { id },
    data: { active: false, effectiveTo: new Date() }
  });
  return toRecord(updated);
}

export type ResolveRuleInput = {
  propertyId: string;
  channelId?: string | null;
  channelCode?: string | null;
  asOf?: Date | string;
};

/**
 * Find the applicable commission rule for a given attribution. Returns null
 * when no active rule matches. Resolution rules:
 *   1. Prefer an exact `channelId` match.
 *   2. Fall back to `channelCode` match (channelId null).
 *   3. `active=true` AND (effectiveFrom <= asOf OR null) AND (effectiveTo >=
 *      asOf OR null).
 */
export async function resolveRule(input: ResolveRuleInput): Promise<CommissionRuleRecord | null> {
  const asOf = input.asOf ? new Date(input.asOf) : new Date();
  const dateGuard = {
    OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: asOf } }],
    AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }] }]
  };

  if (input.channelId) {
    const byId = await prisma.commissionRule.findFirst({
      where: {
        propertyId: input.propertyId,
        active: true,
        channelId: input.channelId,
        ...dateGuard
      },
      orderBy: { createdAt: "desc" }
    });
    if (byId) return toRecord(byId);
  }
  if (input.channelCode) {
    const byCode = await prisma.commissionRule.findFirst({
      where: {
        propertyId: input.propertyId,
        active: true,
        channelCode: input.channelCode,
        ...dateGuard
      },
      orderBy: { createdAt: "desc" }
    });
    if (byCode) return toRecord(byCode);
  }
  // Fallback (lote tesoreria-banca): the channel manager's own contractual
  // percentage (Channel.commissionPercent) acts as an implicit rule so an
  // onboarded OTA accrues even before anyone writes a CommissionRule. The
  // record is synthetic (id "channel:<id>") and never persisted.
  const channel = await prisma.channel.findFirst({
    where: {
      propertyId: input.propertyId,
      commissionPercent: { not: null },
      ...(input.channelId ? { id: input.channelId } : { providerCode: input.channelCode ?? "__none__" })
    },
    select: { id: true, providerCode: true, commissionPercent: true, createdAt: true }
  });
  if (channel && channel.commissionPercent && round2(dec(channel.commissionPercent)).gt(0)) {
    return {
      id: `channel:${channel.id}`,
      propertyId: input.propertyId,
      channelId: channel.id,
      channelCode: channel.providerCode,
      ratePct: round2(dec(channel.commissionPercent)).toFixed(2),
      appliesTo: "net_revenue",
      ledgerAccountCode: DEFAULT_COMMISSION_EXPENSE_CODE,
      active: true,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: channel.createdAt.toISOString()
    };
  }
  return null;
}
