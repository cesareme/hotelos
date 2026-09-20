// Política de check-in por propiedad (Tanda CHK · lote W2-A; diseño §6
// PropertyCheckInPolicy y §7.2 GET/PUT /properties/:propertyId/check-in/policy).
//
//   · getPolicy(propertyId): la fila property_checkin_policies o, si no existe,
//     los valores por defecto del modelo (POLICY_DEFAULTS = los @default de
//     schema.prisma) con updatedAt vacío — nunca crea la fila al leer.
//   · upsertPolicy: requirePermissions(guest_self_service.manage) además del
//     manifiesto (defensa en profundidad para llamadas desde otros servicios),
//     patch parcial validado por PolicyPutSchema, auditoría CheckInPolicyUpdated
//     con before/after (sin PII: la política no lleva datos de huéspedes).

import type {
  AutoAssignLevel,
  CheckInChannel,
  DepositPolicy,
  IdentityVerificationMethod,
  MoneyString,
  PropertyCheckInPolicyDto
} from "@hotelos/shared";
import { AUTO_ASSIGN_LEVELS, CHECKIN_CHANNELS, DEPOSIT_POLICIES, IDENTITY_VERIFICATION_METHODS } from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import type { PolicyPutInput } from "./checkin.schemas.js";

type PolicyRow = Prisma.PropertyCheckInPolicyGetPayload<Record<string, never>>;

export type PolicyValues = Omit<PropertyCheckInPolicyDto, "propertyId" | "updatedAt">;

/** Valores por defecto = @default de PropertyCheckInPolicy en schema.prisma. */
export const POLICY_DEFAULTS: Readonly<PolicyValues> = Object.freeze({
  selfCheckInEnabled: false,
  inviteDaysBefore: 3,
  reminderDaysBefore: 1,
  allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"] as IdentityVerificationMethod[],
  requireVisualCheckAtKiosk: true,
  requireInspectedRoom: false,
  depositPolicy: "balance",
  depositAmount: null,
  allowPayAtReception: false,
  allowWalkIn: false,
  allowUpgradeSuggestion: true,
  autoAssignLevel: "suggest_and_confirm",
  assignmentWeights: {},
  welcomeChannelOrder: ["whatsapp", "email", "sms"] as CheckInChannel[],
  guestConsentText: null,
  aiDisclosureText: null
});

function stringArray<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.filter((item): item is T => typeof item === "string" && (allowed as readonly string[]).includes(item));
  return out.length > 0 ? out : [...fallback];
}

function weights(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
}

export function toPolicyDto(row: PolicyRow | null, propertyId: string): PropertyCheckInPolicyDto {
  if (!row) return { propertyId, ...POLICY_DEFAULTS, allowedVerificationMethods: [...POLICY_DEFAULTS.allowedVerificationMethods], welcomeChannelOrder: [...POLICY_DEFAULTS.welcomeChannelOrder], assignmentWeights: {}, updatedAt: "" };
  return {
    propertyId: row.propertyId,
    selfCheckInEnabled: row.selfCheckInEnabled,
    inviteDaysBefore: row.inviteDaysBefore,
    reminderDaysBefore: row.reminderDaysBefore,
    allowedVerificationMethods: stringArray(row.allowedVerificationMethodsJson, IDENTITY_VERIFICATION_METHODS, [...POLICY_DEFAULTS.allowedVerificationMethods]),
    requireVisualCheckAtKiosk: row.requireVisualCheckAtKiosk,
    requireInspectedRoom: row.requireInspectedRoom,
    depositPolicy: (DEPOSIT_POLICIES as readonly string[]).includes(row.depositPolicy) ? (row.depositPolicy as DepositPolicy) : POLICY_DEFAULTS.depositPolicy,
    depositAmount: row.depositAmount ? (row.depositAmount.toFixed(2) as MoneyString) : null,
    allowPayAtReception: row.allowPayAtReception,
    allowWalkIn: row.allowWalkIn,
    allowUpgradeSuggestion: row.allowUpgradeSuggestion,
    autoAssignLevel: (AUTO_ASSIGN_LEVELS as readonly string[]).includes(row.autoAssignLevel) ? (row.autoAssignLevel as AutoAssignLevel) : POLICY_DEFAULTS.autoAssignLevel,
    assignmentWeights: weights(row.assignmentWeightsJson),
    welcomeChannelOrder: stringArray(row.welcomeChannelOrderJson, CHECKIN_CHANNELS, [...POLICY_DEFAULTS.welcomeChannelOrder]),
    guestConsentText: row.guestConsentText ?? null,
    aiDisclosureText: row.aiDisclosureText ?? null,
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function getPolicy(propertyId: string): Promise<PropertyCheckInPolicyDto> {
  const row = await prisma.propertyCheckInPolicy.findUnique({ where: { propertyId } });
  return toPolicyDto(row, propertyId);
}

function columnsFromPatch(patch: PolicyPutInput): Prisma.PropertyCheckInPolicyUncheckedUpdateInput {
  const data: Prisma.PropertyCheckInPolicyUncheckedUpdateInput = {};
  if (patch.selfCheckInEnabled !== undefined) data.selfCheckInEnabled = patch.selfCheckInEnabled;
  if (patch.inviteDaysBefore !== undefined) data.inviteDaysBefore = patch.inviteDaysBefore;
  if (patch.reminderDaysBefore !== undefined) data.reminderDaysBefore = patch.reminderDaysBefore;
  if (patch.allowedVerificationMethods !== undefined) data.allowedVerificationMethodsJson = [...new Set(patch.allowedVerificationMethods)];
  if (patch.requireVisualCheckAtKiosk !== undefined) data.requireVisualCheckAtKiosk = patch.requireVisualCheckAtKiosk;
  if (patch.requireInspectedRoom !== undefined) data.requireInspectedRoom = patch.requireInspectedRoom;
  if (patch.depositPolicy !== undefined) data.depositPolicy = patch.depositPolicy;
  if (patch.depositAmount !== undefined) data.depositAmount = patch.depositAmount === null ? null : patch.depositAmount;
  if (patch.allowPayAtReception !== undefined) data.allowPayAtReception = patch.allowPayAtReception;
  if (patch.allowWalkIn !== undefined) data.allowWalkIn = patch.allowWalkIn;
  if (patch.allowUpgradeSuggestion !== undefined) data.allowUpgradeSuggestion = patch.allowUpgradeSuggestion;
  if (patch.autoAssignLevel !== undefined) data.autoAssignLevel = patch.autoAssignLevel;
  if (patch.assignmentWeights !== undefined) data.assignmentWeightsJson = patch.assignmentWeights;
  if (patch.welcomeChannelOrder !== undefined) data.welcomeChannelOrderJson = [...new Set(patch.welcomeChannelOrder)];
  if (patch.guestConsentText !== undefined) data.guestConsentText = patch.guestConsentText;
  if (patch.aiDisclosureText !== undefined) data.aiDisclosureText = patch.aiDisclosureText;
  return data;
}

export async function upsertPolicy(input: {
  context: UserContext;
  propertyId: string;
  patch: PolicyPutInput;
  correlationId: string;
}): Promise<PropertyCheckInPolicyDto> {
  requirePermissions(input.context, ["guest_self_service.manage"]);
  const before = await prisma.propertyCheckInPolicy.findUnique({ where: { propertyId: input.propertyId } });
  const data = columnsFromPatch(input.patch);
  const row = await prisma.propertyCheckInPolicy.upsert({
    where: { propertyId: input.propertyId },
    create: { ...(data as Prisma.PropertyCheckInPolicyUncheckedCreateInput), propertyId: input.propertyId },
    update: data
  });
  const after = toPolicyDto(row, input.propertyId);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CheckInPolicyUpdated",
    entityType: "property_checkin_policy",
    entityId: row.id,
    beforeJson: before ? toPolicyDto(before, input.propertyId) : null,
    afterJson: after,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return after;
}
