// Rate Plan CRUD (Fase 0). The RatePlan model already exists in Prisma and is
// read elsewhere, but there was no REST CRUD — the admin RatePlansScreen fell
// back to demo data with a "no implementado" banner. These endpoints back that
// screen with real, persisted data. Tenant-scoped via assertPropertyInOrg.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertPropertyInOrg } from "../pms/pms.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

type RatePlanInput = {
  code?: string;
  name?: string;
  ratePlanType?: string;
  parentRatePlanId?: string | null;
  derivationJson?: Prisma.InputJsonValue;
  cancellationPolicyId?: string | null;
  mealPlan?: string | null;
  active?: boolean;
};

export async function listRatePlans(input: { context: UserContext; propertyId: string }) {
  requirePermissions(input.context, ["revenue.read"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  const items = await prisma.ratePlan.findMany({
    where: { propertyId: input.propertyId },
    orderBy: [{ active: "desc" }, { code: "asc" }]
  });
  return { items };
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
  return prisma.ratePlan.create({
    data: {
      propertyId: input.propertyId,
      code: payload.code,
      name: payload.name,
      ratePlanType: payload.ratePlanType,
      parentRatePlanId: payload.parentRatePlanId ?? null,
      derivationJson: payload.derivationJson ?? {},
      cancellationPolicyId: payload.cancellationPolicyId ?? null,
      mealPlan: payload.mealPlan ?? null,
      active: payload.active ?? true
    }
  });
}

export async function updateRatePlan(input: { context: UserContext; id: string; patch: RatePlanInput }) {
  requirePermissions(input.context, ["revenue.manage_rates"]);
  const existing = await prisma.ratePlan.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Rate plan no encontrado.");
  // Tenant guard: the plan's property must belong to the caller's org.
  await assertPropertyInOrg(existing.propertyId, input.context.organizationId);
  const { patch } = input;
  return prisma.ratePlan.update({
    where: { id: input.id },
    data: {
      ...(patch.code !== undefined ? { code: patch.code } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.ratePlanType !== undefined ? { ratePlanType: patch.ratePlanType } : {}),
      ...(patch.parentRatePlanId !== undefined ? { parentRatePlanId: patch.parentRatePlanId } : {}),
      ...(patch.derivationJson !== undefined ? { derivationJson: patch.derivationJson } : {}),
      ...(patch.cancellationPolicyId !== undefined ? { cancellationPolicyId: patch.cancellationPolicyId } : {}),
      ...(patch.mealPlan !== undefined ? { mealPlan: patch.mealPlan } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {})
    }
  });
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
