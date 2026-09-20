// Documentos · avisos in-app a la oficina (Tanda T9 · corrector RV-10; diseño
// §6.3 «Notificaciones»): al enviar un documento a la oficina se avisa a quien
// puede revisarlo en ese centro (documents.review), agrupado por hora y por
// persona; el job diario avisa a documents.admin de los documentos con el SLA
// vencido (una vez al día por persona). Siempre se ENLAZA (número de registro),
// nunca se adjunta el fichero ni el texto extraído.
//
// Destinatarios: usuarios activos de la organización con una asignación viva
// (user_role_assignments: organización, sociedad del centro, centro o grupo que
// lo contiene) o un rol heredado (user_property_roles) cuyo rol lleva la clave.
// Mismas fuentes que lib/rbac-scope.ts loadUserScope, resueltas al revés (clave →
// roles → personas) para no cargar el ámbito de cada usuario.
//
// Tabla `notifications` (type system, status unread), como el resto de avisos
// del módulo (actions.service.ts: devolución al centro, tarea asignada).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import type { PermissionKey } from "@hotelos/shared";

type Db = typeof prisma | Prisma.TransactionClient;

/** Envíos a la oficina: un aviso por persona y hora como máximo (§6.3 «agrupado»). */
export const OFFICE_NOTIFICATION_GROUP_MS = 3_600_000;
/** SLA vencido: un aviso por persona y día (job diario). */
export const SLA_NOTIFICATION_GROUP_MS = 86_400_000;
export const OFFICE_SENT_TITLE_PREFIX = "Documentos pendientes en la oficina";
export const SLA_BREACH_TITLE_PREFIX = "SLA de la oficina incumplido";
/** Registros que se citan en el cuerpo del aviso diario (el resto se cuenta). */
export const SLA_NOTIFICATION_MAX_REGISTRY_NUMBERS = 10;

const KIND_LABELS: Record<string, string> = {
  invoice: "factura",
  delivery_note: "albarán",
  receipt: "tique",
  letter: "carta",
  administrative_notice: "notificación administrativa",
  contract: "contrato",
  e_invoice_status: "estado de e-factura",
  other: "otro documento",
  unknown: "documento sin clasificar"
};

export function documentKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export type FindUsersWithPermissionInput = {
  organizationId: string;
  /** Centro que debe cubrir la asignación; null = solo asignaciones de organización / sociedad (avisos de la organización). */
  propertyId: string | null;
  key: PermissionKey;
  now?: Date;
};

/** Ids (ordenados) de los usuarios activos cuyas asignaciones vivas con la clave cubren el centro (o la organización). */
export async function findUsersWithPermission(db: Db, input: FindUsersWithPermissionInput): Promise<string[]> {
  const now = input.now ?? new Date();
  const permission = await db.permission.findUnique({ where: { key: input.key }, select: { id: true } });
  if (!permission) return [];
  const links = await db.rolePermission.findMany({ where: { permissionId: permission.id }, select: { roleId: true } });
  if (links.length === 0) return [];
  const roles = await db.role.findMany({ where: { id: { in: links.map((link) => link.roleId) }, organizationId: input.organizationId }, select: { id: true } });
  const roleIds = roles.map((role) => role.id);
  if (roleIds.length === 0) return [];

  let scope: Prisma.UserRoleAssignmentWhereInput;
  if (input.propertyId) {
    const [property, groups] = await Promise.all([
      db.property.findUnique({ where: { id: input.propertyId }, select: { legalEntityId: true } }),
      db.propertyGroupMember.findMany({ where: { propertyId: input.propertyId }, select: { propertyGroupId: true } })
    ]);
    scope = {
      OR: [
        { scopeType: "organization" },
        ...(property?.legalEntityId ? [{ scopeType: "legal_entity" as const, legalEntityId: property.legalEntityId }] : []),
        { scopeType: "property", propertyId: input.propertyId },
        ...(groups.length > 0 ? [{ scopeType: "property_group" as const, propertyGroupId: { in: groups.map((group) => group.propertyGroupId) } }] : [])
      ]
    };
  } else {
    scope = { scopeType: { in: ["organization", "legal_entity"] } };
  }
  const [assignments, legacy] = await Promise.all([
    db.userRoleAssignment.findMany({
      where: { AND: [{ organizationId: input.organizationId, roleId: { in: roleIds }, revokedAt: null, validFrom: { lte: now } }, { OR: [{ validTo: null }, { validTo: { gt: now } }] }, scope] },
      select: { userId: true }
    }),
    input.propertyId ? db.userPropertyRole.findMany({ where: { roleId: { in: roleIds }, propertyId: input.propertyId }, select: { userId: true } }) : Promise.resolve([] as Array<{ userId: string }>)
  ]);
  const candidates = [...new Set([...assignments, ...legacy].map((row) => row.userId))];
  if (candidates.length === 0) return [];
  const users = await db.user.findMany({ where: { id: { in: candidates }, organizationId: input.organizationId, status: "active" }, select: { id: true } });
  return users.map((user) => user.id).sort();
}

async function hasRecentNotification(db: Db, input: { organizationId: string; userId: string; titlePrefix: string; since: Date }): Promise<boolean> {
  const existing = await db.notification.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId, type: "system", title: { startsWith: input.titlePrefix }, createdAt: { gte: input.since } },
    select: { id: true }
  });
  return existing !== null;
}

export type NotifyOfficeDocumentSentInput = {
  row: { id: string; organizationId: string; propertyId: string; registryNumber: string; kind: string };
  at: Date;
  /** Quien envía no se avisa a sí mismo. */
  excludeUserId?: string | null;
};

export type NotifyOfficeResult = { notified: string[]; grouped: string[] };

/**
 * Envío a la oficina (manual o automático): aviso a cada revisor del centro salvo
 * que ya tenga uno de la última hora (agrupado). Nunca lanza: un fallo del aviso
 * no deshace el envío (se registra y se devuelve vacío).
 */
export async function notifyOfficeDocumentSent(db: Db, input: NotifyOfficeDocumentSentInput): Promise<NotifyOfficeResult> {
  const result: NotifyOfficeResult = { notified: [], grouped: [] };
  const { row, at } = input;
  const reviewers = (await findUsersWithPermission(db, { organizationId: row.organizationId, propertyId: row.propertyId, key: "documents.review", now: at })).filter((userId) => userId !== input.excludeUserId);
  if (reviewers.length === 0) return result;
  const property = await db.property.findUnique({ where: { id: row.propertyId }, select: { name: true, code: true } });
  const centre = property?.code ?? property?.name ?? row.propertyId;
  const since = new Date(at.getTime() - OFFICE_NOTIFICATION_GROUP_MS);
  for (const userId of reviewers) {
    if (await hasRecentNotification(db, { organizationId: row.organizationId, userId, titlePrefix: OFFICE_SENT_TITLE_PREFIX, since })) {
      result.grouped.push(userId);
      continue;
    }
    await db.notification.create({
      data: {
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        userId,
        type: "system",
        title: `${OFFICE_SENT_TITLE_PREFIX} · ${centre}`,
        body: `El centro ${property?.name ?? centre} ha enviado ${row.registryNumber} (${documentKindLabel(row.kind)}) a la oficina. Revísalo en Finanzas › Proveedores › Documentos; los envíos de la próxima hora no generan otro aviso.`,
        status: "unread"
      }
    });
    result.notified.push(userId);
  }
  return result;
}

export type SlaBreachedDocument = { id: string; organizationId: string; propertyId: string; registryNumber: string; sentAt: Date | null };

export type NotifySlaBreachesInput = {
  organizationId: string;
  breached: SlaBreachedDocument[];
  slaBusinessDays: number;
  at: Date;
};

/** Aviso diario a documents.admin de la organización con los registros vencidos (uno por persona y día). */
export async function notifySlaBreaches(db: Db, input: NotifySlaBreachesInput): Promise<NotifyOfficeResult> {
  const result: NotifyOfficeResult = { notified: [], grouped: [] };
  if (input.breached.length === 0) return result;
  const admins = await findUsersWithPermission(db, { organizationId: input.organizationId, propertyId: null, key: "documents.admin", now: input.at });
  if (admins.length === 0) return result;
  const since = new Date(input.at.getTime() - SLA_NOTIFICATION_GROUP_MS);
  const cited = input.breached.slice(0, SLA_NOTIFICATION_MAX_REGISTRY_NUMBERS).map((row) => row.registryNumber);
  const rest = input.breached.length - cited.length;
  const body = `${input.breached.length} documento${input.breached.length === 1 ? "" : "s"} enviado${input.breached.length === 1 ? "" : "s"} a la oficina hace más de ${input.slaBusinessDays} día${input.slaBusinessDays === 1 ? "" : "s"} laborable${input.slaBusinessDays === 1 ? "" : "s"} sin decisión: ${cited.join(", ")}${rest > 0 ? ` y ${rest} más` : ""}. Revísalos en Finanzas › Proveedores › Documentos (filtro «vencidos»).`;
  for (const userId of admins) {
    if (await hasRecentNotification(db, { organizationId: input.organizationId, userId, titlePrefix: SLA_BREACH_TITLE_PREFIX, since })) {
      result.grouped.push(userId);
      continue;
    }
    await db.notification.create({
      data: {
        organizationId: input.organizationId,
        propertyId: input.breached[0]!.propertyId,
        userId,
        type: "system",
        title: `${SLA_BREACH_TITLE_PREFIX} · ${input.breached.length} documento${input.breached.length === 1 ? "" : "s"}`,
        body,
        status: "unread"
      }
    });
    result.notified.push(userId);
  }
  return result;
}
