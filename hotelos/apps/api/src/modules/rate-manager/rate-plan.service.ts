// Rate Plan CRUD (Fase 0). The RatePlan model already exists in Prisma and is
// read elsewhere, but there was no REST CRUD — the admin RatePlansScreen fell
// back to demo data with a "no implementado" banner. These endpoints back that
// screen with real, persisted data. Tenant-scoped via assertPropertyInOrg.
//
// Rate grid v2: `derivationJson` is validated (`{ mode, value, roundTo? }`),
// `ratePlanType: "derived"` and `parentRatePlanId` require each other, the
// parent must be an active plan of the same property that is not itself
// derived (no chains — nor may a plan that already HAS active children become
// derived: the engine materialises one level only), the rule must not yield
// 0 € on the parent's current minimum price, and GET returns the parsed
// `derivation`.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { RatePlanDerivation } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertPropertyInOrg } from "../pms/pms.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { derivationFloorIssue, derivationSchema, parseDerivation } from "./derivation.js";
import { parseOr400 } from "./rate-grid.schemas.js";

export const DERIVED_RATE_PLAN_TYPE = "derived";

type RatePlanInput = {
  code?: string;
  name?: string;
  ratePlanType?: string;
  parentRatePlanId?: string | null;
  derivationJson?: Prisma.InputJsonValue;
  /** Alias of derivationJson accepted from the v2 editor. */
  derivation?: RatePlanDerivation | null;
  cancellationPolicyId?: string | null;
  mealPlan?: string | null;
  active?: boolean;
};

type DerivationCheck = {
  propertyId: string;
  selfId?: string;
  ratePlanType: string;
  parentRatePlanId: string | null;
  derivationJson: unknown;
};

/**
 * Validate the derivation triple (type, parent, rule). Throws the repo's 400
 * with details; returns the normalised derivation to persist.
 */
async function validateDerivation(input: DerivationCheck): Promise<RatePlanDerivation> {
  const isDerivedType = input.ratePlanType === DERIVED_RATE_PLAN_TYPE;
  if (isDerivedType && !input.parentRatePlanId) {
    throw new BadRequestError('Un plan de tipo "derived" exige parentRatePlanId.');
  }
  if (!isDerivedType && input.parentRatePlanId) {
    throw new BadRequestError('Solo un plan de tipo "derived" puede tener parentRatePlanId.');
  }
  const raw = input.derivationJson;
  const isEmpty = raw === undefined || raw === null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0);
  const derivation = isEmpty ? { mode: "none" as const, value: 0 } : parseOr400(derivationSchema, raw, "derivationJson");
  if (!isDerivedType && derivation.mode !== "none") {
    throw new BadRequestError('derivationJson solo admite mode "none" en un plan sin padre.');
  }
  if (input.parentRatePlanId) {
    if (input.selfId && input.parentRatePlanId === input.selfId) throw new BadRequestError("Un plan no puede derivar de sí mismo.");
    const parent = await prisma.ratePlan.findFirst({
      where: { id: input.parentRatePlanId, propertyId: input.propertyId },
      select: { id: true, active: true, parentRatePlanId: true, code: true }
    });
    if (!parent) throw new BadRequestError("parentRatePlanId no pertenece a la propiedad.");
    if (!parent.active) throw new BadRequestError(`El plan padre ${parent.code} está inactivo.`);
    if (parent.parentRatePlanId) throw new BadRequestError(`El plan padre ${parent.code} ya es derivado: no se admiten cadenas de derivación.`);
    if (input.selfId) {
      // The other end of the «no chains» rule: a plan that already feeds
      // children cannot itself become derived (grandchildren would never be
      // re-materialised and the middle plan would turn read-only).
      const children = await prisma.ratePlan.findMany({
        where: { propertyId: input.propertyId, parentRatePlanId: input.selfId, active: true },
        select: { code: true }
      });
      if (children.length > 0) {
        const error = new BadRequestError(
          `El plan tiene planes derivados activos (${children.map((c) => c.code).join(", ")}): no puede convertirse en derivado (no se admiten cadenas de derivación).`
        );
        error.details = { code: "DERIVATION_CHAIN", children: children.map((c) => c.code) };
        throw error;
      }
    }
    // A rule that yields 0 € on the parent's lowest current price would
    // materialise (and publish) a fake 0: reject it here with the numbers.
    const floor = await prisma.rateDay.aggregate({
      where: { propertyId: input.propertyId, ratePlanId: parent.id, date: { gte: new Date(new Date().toISOString().slice(0, 10)) } },
      _min: { price: true }
    });
    const parentMinPrice = floor._min.price === null ? null : Number(floor._min.price);
    const issue = derivationFloorIssue(derivation, parentMinPrice);
    if (issue) {
      const error = new BadRequestError(`derivationJson no válido: ${issue}.`);
      error.details = { code: "DERIVATION_YIELDS_ZERO", parentMinPrice, derivation };
      throw error;
    }
  }
  return derivation;
}

function withDerivation<T extends { derivationJson: Prisma.JsonValue }>(plan: T): T & { derivation: RatePlanDerivation } {
  return { ...plan, derivation: parseDerivation(plan.derivationJson) };
}

export async function listRatePlans(input: { context: UserContext; propertyId: string }) {
  requirePermissions(input.context, ["revenue.read"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const items = await prisma.ratePlan.findMany({
    where: { propertyId: input.propertyId },
    orderBy: [{ active: "desc" }, { code: "asc" }]
  });
  return { items: items.map(withDerivation) };
}

export async function createRatePlan(input: { context: UserContext; propertyId: string; payload: RatePlanInput }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const { payload } = input;
  if (!payload.code || !payload.name || !payload.ratePlanType) {
    throw new BadRequestError("code, name y ratePlanType son obligatorios.");
  }
  // Unique on (propertyId, code) — surface a clean 400 instead of a Prisma P2002.
  const clash = await prisma.ratePlan.findFirst({
    where: { propertyId: input.propertyId, code: payload.code },
    select: { id: true }
  });
  if (clash) {
    throw new BadRequestError(`Ya existe un plan tarifario con el código "${payload.code}".`);
  }
  const derivation = await validateDerivation({
    propertyId: input.propertyId,
    ratePlanType: payload.ratePlanType,
    parentRatePlanId: payload.parentRatePlanId ?? null,
    derivationJson: payload.derivation ?? payload.derivationJson
  });
  const created = await prisma.ratePlan.create({
    data: {
      propertyId: input.propertyId,
      code: payload.code,
      name: payload.name,
      ratePlanType: payload.ratePlanType,
      parentRatePlanId: payload.parentRatePlanId ?? null,
      derivationJson: derivation as unknown as Prisma.InputJsonValue,
      cancellationPolicyId: payload.cancellationPolicyId ?? null,
      mealPlan: payload.mealPlan ?? null,
      active: payload.active ?? true
    }
  });
  return withDerivation(created);
}

export async function updateRatePlan(input: { context: UserContext; id: string; patch: RatePlanInput }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const existing = await prisma.ratePlan.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Rate plan no encontrado.");
  // Tenant guard: the plan's property must belong to the caller's org.
  await assertPropertyInOrg(existing.propertyId, input.context.organizationId);
  const { patch } = input;
  const touchesDerivation =
    patch.ratePlanType !== undefined || patch.parentRatePlanId !== undefined || patch.derivationJson !== undefined || patch.derivation !== undefined;
  const derivation = touchesDerivation
    ? await validateDerivation({
        propertyId: existing.propertyId,
        selfId: existing.id,
        ratePlanType: patch.ratePlanType ?? existing.ratePlanType,
        parentRatePlanId: patch.parentRatePlanId !== undefined ? patch.parentRatePlanId : existing.parentRatePlanId,
        derivationJson: patch.derivation !== undefined ? patch.derivation : patch.derivationJson !== undefined ? patch.derivationJson : existing.derivationJson
      })
    : null;
  const updated = await prisma.ratePlan.update({
    where: { id: input.id },
    data: {
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.ratePlanType !== undefined ? { ratePlanType: patch.ratePlanType } : {}),
      ...(patch.parentRatePlanId !== undefined ? { parentRatePlanId: patch.parentRatePlanId } : {}),
      ...(derivation ? { derivationJson: derivation as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.cancellationPolicyId !== undefined ? { cancellationPolicyId: patch.cancellationPolicyId } : {}),
      ...(patch.mealPlan !== undefined ? { mealPlan: patch.mealPlan } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {})
    }
  });
  return withDerivation(updated);
}

export async function deleteRatePlan(input: { context: UserContext; id: string }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const existing = await prisma.ratePlan.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Rate plan no encontrado.");
  await assertPropertyInOrg(existing.propertyId, input.context.organizationId);
  // Soft-delete: deactivate rather than hard-delete (RateDay/RestrictionDay reference it).
  await prisma.ratePlan.update({ where: { id: input.id }, data: { active: false } });
  return { ok: true, id: input.id };
}
