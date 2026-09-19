// Reputación · Tanda T8 · lote T8-C — contexto de sistema del bot de reseñas
// (apps/api/src/modules/reputation/reputation-context.ts).
//
// Patrón de modules/pms-shadow/pms-shadow.rules.ts:199-209 (systemContext): el
// tick del job, la ingesta por correo y el CLI llaman a los servicios con un
// UserContext de sistema acotado a una organización y una propiedad, con las
// claves mínimas (reputation.read/respond + quality_cases.manage) y nunca
// isPlatformAdmin. Sin Prisma, sin variables de entorno, sin red.

import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";

/** Código del módulo de producto que activa el bot (module-manifest.ts:528-537). */
export const REPUTATION_MODULE_CODE = "reputation_quality" as const;

export const REPUTATION_SYSTEM_USER_ID = "system:reputation";
export const REPUTATION_SYSTEM_FULL_NAME = "Bot de reputación";
export const REPUTATION_SYSTEM_DEVICE_ID = "system:reputation";
export const REPUTATION_SYSTEM_PERMISSIONS: readonly PermissionKey[] = Object.freeze(["reputation.read", "reputation.respond", "quality_cases.manage"]);

/** Contexto con el que el job diario y la ingesta llaman a los servicios de reputación. */
export function reputationSystemContext(organizationId: string, propertyId: string): UserContext {
  return {
    organizationId,
    propertyId,
    userId: REPUTATION_SYSTEM_USER_ID,
    fullName: REPUTATION_SYSTEM_FULL_NAME,
    deviceId: REPUTATION_SYSTEM_DEVICE_ID,
    permissions: [...REPUTATION_SYSTEM_PERMISSIONS],
    isPlatformAdmin: false
  };
}

/** `true` si el actor es el bot (auditoría `actorType: "system"`). */
export function isReputationSystemActor(userId: string | null | undefined): boolean {
  return userId === REPUTATION_SYSTEM_USER_ID;
}
