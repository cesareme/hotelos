// Contexto de servicio del check-in automatizado (Tanda CHK · lote W2-A;
// diseño §4c «contexto de servicio», R17).
//
// Los servicios de dominio que el check-in encadena (checkInReservation,
// assignRoom, prepareGuestRegisterRecord / createSpainGuestRegisterRecord,
// markGuestRegisterIdentityVerified, issueWalletPass, createPaymentLink…)
// llaman a requirePermissions(context, …) (auth.service.ts:397 solo mira
// `context.permissions`) y hoy no existe ningún contexto de sistema: el
// scheduler SES usa demoStore.userContext y el pre-check-in antiguo escribe
// Prisma directamente para esquivarlo. Este fichero introduce el contexto
// sintético con permisos FIJOS y mínimos para un actor sin sesión de personal:
//
//   · `guest`  — el huésped desde el portal / móvil (userId `guest:<sessionId>`);
//   · `kiosk`  — un KioskDevice emparejado (userId `kiosk:<deviceId>`);
//   · `system` — un job del líder (userId `system:checkin:<job>`).
//
// Nombre distinto de systemContextForProperty (ses-submission.service.ts) a
// propósito: aquel es el contexto del envío SES; este el del check-in.
//
// Separación de funciones (T8a): CHECKIN_SERVICE_PERMISSIONS nunca contiene
// claves de dinero (descuentos, ajustes de folio, reembolsos), de override ni
// de confirmación de alto riesgo — FORBIDDEN_SERVICE_PERMISSIONS lo fija y el
// test __tests__/service-context.test.mts lo comprueba. El enlace de pago del
// portal usa paymentLinkServiceContext con SOLO payment.capture.
//
// Auditoría: ActorType (packages/shared) es "user" | "ai" | "system", sin
// "guest": los eventos del check-in se registran con actorType "system" y
// actorUserId = context.userId (el prefijo guest:/kiosk:/system:checkin:
// identifica al actor). Nunca demoStore.userContext.
//
// Alcance: organizationId se resuelve desde prisma.property (404 opaco si no
// existe); assignedPropertyIds = [propertyId] y orgScope=false para que
// grantPropertyAccess (lib/tenancy.ts) no amplíe el contexto a toda la
// organización. Sin `assignments`: el preHandler de server.ts no lo evalúa
// porque estos contextos no viajan en request.userContext.

import type { PermissionKey } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { NotFoundError } from "../../lib/http-error.js";

export type CheckInActor =
  | { kind: "guest"; sessionId: string }
  | { kind: "kiosk"; deviceId: string }
  | { kind: "system"; job: string };

/** Nombre visible del actor sintético en auditoría y en `updatedBy` de los partes. */
export const CHECKIN_SERVICE_FULL_NAME = "Check-in automatizado";
/** deviceId del contexto sintético (los eventos de auditoría lo llevan). */
export const CHECKIN_SERVICE_DEVICE_ID = "checkin";

/** Permisos fijos del check-in automatizado (mínimos para la cadena §4a/§4c). */
export const CHECKIN_SERVICE_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  "pms.reservation.read",
  "pms.reservation.modify",
  "pms.checkin.execute",
  "guests.read",
  "guests.manage",
  "guest_register.read",
  "guest_register.create",
  "guest_register.edit",
  "guest_register.sign",
  "guest_register.submit",
  "compliance.ses.submit",
  "ai.tool.execute"
] as PermissionKey[]);

/** Permisos del contexto del enlace de pago del portal: solo capturar. */
export const PAYMENT_LINK_SERVICE_PERMISSIONS: readonly PermissionKey[] = Object.freeze(["payment.capture"] as PermissionKey[]);

/**
 * Claves que NINGÚN contexto de servicio del check-in puede contener (SoD
 * T8a): dinero, override y confirmación de alto riesgo quedan siempre en manos
 * de una persona con sesión.
 */
export const FORBIDDEN_SERVICE_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  "pms.reservation.discount",
  "pms.reservation.override",
  "folio.adjust",
  "folio.adjust_approve",
  "payment.refund",
  "payments.refund_approve",
  "ai.high_risk.confirm"
] as PermissionKey[]);

/** userId sintético del actor: `guest:<sessionId>` · `kiosk:<deviceId>` · `system:checkin:<job>`. */
export function serviceUserId(actor: CheckInActor): string {
  switch (actor.kind) {
    case "guest":
      return `guest:${actor.sessionId}`;
    case "kiosk":
      return `kiosk:${actor.deviceId}`;
    case "system":
      return `system:checkin:${actor.job}`;
  }
}

/** Actor a partir de un userId sintético (auditoría, tests); null si no lleva prefijo conocido. */
export function actorFromUserId(userId: string): CheckInActor | null {
  if (userId.startsWith("guest:")) return { kind: "guest", sessionId: userId.slice("guest:".length) };
  if (userId.startsWith("kiosk:")) return { kind: "kiosk", deviceId: userId.slice("kiosk:".length) };
  if (userId.startsWith("system:checkin:")) return { kind: "system", job: userId.slice("system:checkin:".length) };
  return null;
}

/** Construcción PURA del contexto (sin BD): la usan checkInServiceContext y los tests. */
export function buildServiceContext(input: {
  organizationId: string;
  propertyId: string;
  actor: CheckInActor;
  permissions: readonly PermissionKey[];
}): UserContext {
  const forbidden = input.permissions.filter((key) => FORBIDDEN_SERVICE_PERMISSIONS.includes(key));
  if (forbidden.length > 0) {
    throw new Error(`Contexto de servicio del check-in con claves prohibidas: ${forbidden.join(", ")}`);
  }
  return {
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    userId: serviceUserId(input.actor),
    fullName: CHECKIN_SERVICE_FULL_NAME,
    deviceId: CHECKIN_SERVICE_DEVICE_ID,
    permissions: [...input.permissions],
    isPlatformAdmin: false,
    assignedPropertyIds: [input.propertyId],
    orgScope: false
  };
}

async function organizationOfProperty(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

/**
 * Contexto de servicio del check-in para `propertyId`: organizationId desde
 * prisma.property (404 opaco si no existe), userId con prefijo del actor,
 * permisos CHECKIN_SERVICE_PERMISSIONS.
 */
export async function checkInServiceContext(propertyId: string, actor: CheckInActor): Promise<UserContext> {
  const organizationId = await organizationOfProperty(propertyId);
  return buildServiceContext({ organizationId, propertyId, actor, permissions: CHECKIN_SERVICE_PERMISSIONS });
}

/**
 * Contexto del enlace de pago del portal del huésped (POST
 * /guest-portal/session/:token/pay y el paso 7 del pre-check-in): SOLO
 * payment.capture. `sessionId` identifica la sesión del huésped (nunca el
 * token en claro: acabaría en la auditoría).
 */
export async function paymentLinkServiceContext(propertyId: string, sessionId: string): Promise<UserContext> {
  const organizationId = await organizationOfProperty(propertyId);
  return buildServiceContext({
    organizationId,
    propertyId,
    actor: { kind: "guest", sessionId },
    permissions: PAYMENT_LINK_SERVICE_PERMISSIONS
  });
}
