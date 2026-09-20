import { prisma } from "@hotelos/database";
import { demoStore, type UserContext, type WorkOrderMediaRecord, type WorkOrderRecord } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { isPlatformAdmin, requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ConflictError, ForbiddenError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
// Tanda UX-3 (M1): normalización del MIME declarado (misma regla que documents/magic-bytes.ts).
import { normalizeMimeType } from "../documents/magic-bytes.js";
// Tanda L5 (lote A): bloqueo / liberación de habitación por la transición unificada
// (block_maintenance / release_maintenance), idempotente y auditada.
import { applyRoomTransition, type RoomStateSnapshot } from "../housekeeping/room-state.service.js";

// Maintenance work orders now PERSIST TO PRISMA (work_orders / work_order_media /
// rooms) so the Prisma-backed maintenance dashboard reflects them. Previously
// these wrote only to the in-memory demo store. We keep a best-effort demo-store
// mirror for room status so legacy demo readers stay consistent.

type PrismaWorkOrder = {
  id: string;
  propertyId: string;
  roomId: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  blocksRoom: boolean;
  createdBy: string | null;
  assignedTo: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

function mapOrder(row: PrismaWorkOrder): WorkOrderRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    priority: row.priority as WorkOrderRecord["priority"],
    status: row.status as WorkOrderRecord["status"],
    blocksRoom: row.blocksRoom,
    createdBy: row.createdBy ?? undefined,
    assignedTo: row.assignedTo ?? undefined,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : undefined
  };
}

function mirrorOrder(order: WorkOrderRecord): void {
  const idx = demoStore.workOrders.findIndex((o) => o.id === order.id);
  if (idx >= 0) demoStore.workOrders[idx] = order;
  else demoStore.workOrders.push(order);
}

function mirrorRoomStatus(roomId: string, patch: Record<string, unknown>): void {
  const room = demoStore.rooms.find((r) => r.id === roomId);
  if (room) Object.assign(room, patch);
}

/** Espejo del demo store con el estado resultante de una transición. */
function mirrorRoomState(roomId: string, state: RoomStateSnapshot): void {
  mirrorRoomStatus(roomId, {
    status: state.status,
    housekeepingStatus: state.housekeepingStatus,
    maintenanceStatus: state.maintenanceStatus,
    sellable: state.sellable
  });
}

// ---------------------------------------------------------------------------
// HK-04 guards
// ---------------------------------------------------------------------------

// Enum guards (HK-04c). `WorkOrder.status` is a Prisma enum, so an out-of-range
// value used to surface as a PrismaClientValidationError (500). `priority` and
// `WorkOrderMedia.mediaType` are plain String columns; we validate them against
// the domain literals anyway so garbage never gets persisted.
const WO_STATUSES: readonly WorkOrderRecord["status"][] = ["open", "assigned", "in_progress", "waiting_vendor", "resolved", "closed"];
const WO_PRIORITIES: readonly WorkOrderRecord["priority"][] = ["emergency", "urgent", "normal", "preventive"];
const WO_MEDIA_TYPES: readonly WorkOrderMediaRecord["mediaType"][] = ["photo", "video"];
// Terminal states (HK-04b): a resolved/closed order is not transitioned again.
const WO_TERMINAL_STATUSES: readonly string[] = ["resolved", "closed"];

function assertEnumValue(prefix: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new BadRequestError(`${prefix}: ${String(value)}. Valores admitidos: ${allowed.join(", ")}.`);
  }
}

// Input-shape guards. Handlers cast `request.body` without a schema, so any
// field forwarded raw to Prisma (free text, flags) used to surface a
// PrismaClientValidationError (500) when the client sent the wrong type.
// `null` is accepted wherever the column is nullable (it clears the value).
function assertRequiredString(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${label} es obligatorio.`);
  }
}

function assertOptionalString(label: string, value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new BadRequestError(`${label} debe ser texto.`);
  }
}

function assertBoolean(label: string, value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new BadRequestError(`${label} debe ser verdadero o falso.`);
}

// Tenancy guard (HK-04a). Work orders carry no Prisma relation to Property, so
// we resolve the row by id and then confirm its property belongs to the caller's
// organization. "Missing" and "foreign" collapse into the same 404 — resolved
// BEFORE any business rule — so a caller from another tenant can neither confirm
// existence nor learn the state of orders it doesn't own.
// Exception: a platform admin (admin.tenants.manage granted through REAL DB
// roles, never the demo union) may act across organizations, mirroring the
// global `:propertyId` hook in server.ts. A missing row is still a 404 for
// everyone.

// `context.isPlatformAdmin` is trusted when the auth layer has stamped it; when
// absent we fall back to the DB-backed check. Only reached for foreign
// resources, so regular in-org callers never pay the extra lookup.
async function callerIsPlatformAdmin(context: UserContext): Promise<boolean> {
  if (context.isPlatformAdmin !== undefined) return context.isPlatformAdmin === true;
  return isPlatformAdmin(context);
}

async function canAccessProperty(propertyId: string, context: UserContext): Promise<boolean> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) return false;
  if (property.organizationId === context.organizationId) return true;
  return callerIsPlatformAdmin(context);
}

async function findWorkOrderInOrg(workOrderId: string, context: UserContext) {
  const order = await prisma.workOrder.findUnique({ where: { id: workOrderId } });
  if (!order || !(await canAccessProperty(order.propertyId, context))) {
    throw new NotFoundError("Orden de trabajo no encontrada.");
  }
  return order;
}

// Tanda UX-3 · corrector REV-05 (diseño §4.6 «404 opaco entre propiedades»): las
// fotos del parte se leen SOLO desde la propiedad activa de la petición
// (`x-property-id` → context.propertyId, validada contra el ámbito del usuario
// por el hook global de server.ts). Una organización real tiene varias
// propiedades y `maintenance.read` en A no da acceso a las fotos de B: mismo
// 404 que «no existe». El platform admin conserva el paso entre organizaciones.
async function canReadWorkOrderMedia(order: { propertyId: string }, context: UserContext): Promise<boolean> {
  if (!(await canAccessProperty(order.propertyId, context))) return false;
  if (order.propertyId === context.propertyId) return true;
  return callerIsPlatformAdmin(context);
}

// ---------------------------------------------------------------------------
// Tanda UX-3 · M1: fotos del parte (diseño §4.6, decisiones D2/D3, riesgo R4)
// ---------------------------------------------------------------------------
// Sin S3 ni servicio externo (regla 7): la foto viaja como JSON base64 y se
// guarda EN LA FILA de work_order_media (columnas aditivas de la migración
// 20260920170000_ux3_parte_fotos, almacén «inline» como documents). Límites:
// ≤ 3 fotos por parte, ≤ 1,5 MiB decodificada cada una (≤ 4,5 MiB por parte),
// jpeg | png | webp comprobados por magic bytes (nunca se confía en el MIME
// declarado: un HTML/SVG disfrazado de imagen no llega a la base de datos).
// Las guardas solo miran el cuerpo (HK-04c): corren ANTES de cualquier lectura
// y no filtran nada de las filas. Errores 400 con details.code para el front.

export const WORK_ORDER_PHOTO_MAX_COUNT = 3;
/** 1,5 MiB decodificados por foto. */
export const WORK_ORDER_PHOTO_MAX_BYTES = 1_572_864;
export const WORK_ORDER_PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type WorkOrderPhotoMime = (typeof WORK_ORDER_PHOTO_MIME_TYPES)[number];
/** bodyLimit de las rutas que reciben fotos: 3 × 1,5 MiB en base64 (4/3) = 6 MiB exactos + 64 KiB para la envoltura JSON (título, descripción, mimeType…); sin el margen, tres fotos al tope responderían 413. */
export const WORK_ORDER_PHOTOS_BODY_LIMIT = 6 * 1024 * 1024 + 64 * 1024;
/** Prefijo de objectKey de los medios guardados en la fila (sin objeto externo). */
export const WORK_ORDER_MEDIA_INLINE_PREFIX = "inline://work-order-media/";

export type WorkOrderPhotoErrorCode =
  | "WORK_ORDER_PHOTOS_INVALID"
  | "WORK_ORDER_PHOTOS_TOO_MANY"
  | "WORK_ORDER_PHOTO_BASE64_INVALID"
  | "WORK_ORDER_PHOTO_EMPTY"
  | "WORK_ORDER_PHOTO_TOO_LARGE"
  | "WORK_ORDER_PHOTO_MIME_NOT_ALLOWED"
  | "WORK_ORDER_PHOTO_CONTENT_MISMATCH";

function photoError(code: WorkOrderPhotoErrorCode, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, message, true, { code, ...extra });
}

function bytesStartWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false;
  return true;
}

/** Firma → MIME canónico de las tres familias admitidas; null para cualquier otro contenido. */
export function sniffWorkOrderPhotoMime(bytes: Uint8Array): WorkOrderPhotoMime | null {
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF <size:4> WEBP
  if (bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesStartWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export type WorkOrderPhotoInput = { bytes: Buffer; mimeType: WorkOrderPhotoMime; sizeBytes: number };

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
/** Longitud base64 máxima que puede codificar WORK_ORDER_PHOTO_MAX_BYTES (se comprueba ANTES de decodificar: sin reservar memoria para un cuerpo desmesurado). */
const WORK_ORDER_PHOTO_MAX_BASE64_LENGTH = Math.ceil(WORK_ORDER_PHOTO_MAX_BYTES / 3) * 4;

/**
 * Valida UNA foto `{ contentBase64, mimeType }`: MIME declarado en la lista,
 * base64 bien formado (se tolera el prefijo `data:…;base64,`), tamaño
 * decodificado 1 … 1,5 MiB y magic bytes coherentes con el MIME declarado.
 * `position` (1-based) solo etiqueta el error cuando viene de una lista.
 */
export function parseWorkOrderPhoto(raw: unknown, position = 1): WorkOrderPhotoInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw photoError("WORK_ORDER_PHOTOS_INVALID", `La foto ${position} debe ser un objeto { contentBase64, mimeType }.`, { position });
  }
  const { contentBase64, mimeType } = raw as { contentBase64?: unknown; mimeType?: unknown };
  if (typeof contentBase64 !== "string" || typeof mimeType !== "string") {
    throw photoError("WORK_ORDER_PHOTOS_INVALID", `La foto ${position} necesita contentBase64 y mimeType como texto.`, { position });
  }
  const declared = normalizeMimeType(mimeType);
  if (!(WORK_ORDER_PHOTO_MIME_TYPES as readonly string[]).includes(declared)) {
    throw photoError("WORK_ORDER_PHOTO_MIME_NOT_ALLOWED", `Tipo de foto no admitido: ${declared || "(vacío)"}. Admitidos: JPEG, PNG y WebP.`, {
      position,
      mimeType: declared,
      allowed: WORK_ORDER_PHOTO_MIME_TYPES
    });
  }
  let payload = contentBase64.trim();
  if (payload.startsWith("data:")) {
    const comma = payload.indexOf(",");
    payload = comma >= 0 ? payload.slice(comma + 1) : "";
  }
  payload = payload.replace(/\s+/g, "");
  if (payload.length === 0) throw photoError("WORK_ORDER_PHOTO_EMPTY", `La foto ${position} está vacía.`, { position });
  if (payload.length > WORK_ORDER_PHOTO_MAX_BASE64_LENGTH + 4) {
    throw photoError("WORK_ORDER_PHOTO_TOO_LARGE", `La foto ${position} supera 1,5 MiB.`, { position, maxBytes: WORK_ORDER_PHOTO_MAX_BYTES });
  }
  if (!BASE64_PATTERN.test(payload)) {
    throw photoError("WORK_ORDER_PHOTO_BASE64_INVALID", `La foto ${position} no es base64 válido.`, { position });
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) throw photoError("WORK_ORDER_PHOTO_EMPTY", `La foto ${position} está vacía.`, { position });
  if (bytes.length > WORK_ORDER_PHOTO_MAX_BYTES) {
    throw photoError("WORK_ORDER_PHOTO_TOO_LARGE", `La foto ${position} supera 1,5 MiB.`, { position, sizeBytes: bytes.length, maxBytes: WORK_ORDER_PHOTO_MAX_BYTES });
  }
  const sniffed = sniffWorkOrderPhotoMime(bytes);
  if (sniffed !== declared) {
    throw photoError("WORK_ORDER_PHOTO_CONTENT_MISMATCH", `El contenido de la foto ${position} no corresponde al tipo declarado (${declared}).`, {
      position,
      mimeType: declared,
      sniffed
    });
  }
  return { bytes, mimeType: declared as WorkOrderPhotoMime, sizeBytes: bytes.length };
}

/** Lista `photos?: [{ contentBase64, mimeType }]` del POST /work-orders: ausente → []; > 3 → 400. */
export function parseWorkOrderPhotos(raw: unknown): WorkOrderPhotoInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw photoError("WORK_ORDER_PHOTOS_INVALID", "El campo photos debe ser una lista de { contentBase64, mimeType }.");
  }
  if (raw.length > WORK_ORDER_PHOTO_MAX_COUNT) {
    throw photoError("WORK_ORDER_PHOTOS_TOO_MANY", `Como máximo ${WORK_ORDER_PHOTO_MAX_COUNT} fotos por parte.`, {
      count: raw.length,
      maxPhotos: WORK_ORDER_PHOTO_MAX_COUNT
    });
  }
  return raw.map((item, index) => parseWorkOrderPhoto(item, index + 1));
}

/** Metadatos de un medio del parte (nunca los bytes): respuesta de GET /work-orders/:id/media y de las altas. */
export type WorkOrderMediaMeta = {
  id: string;
  workOrderId: string;
  objectKey: string;
  mediaType: WorkOrderMediaRecord["mediaType"];
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  createdBy: string | null;
  /** true cuando los bytes viven en la fila (GET /work-orders/media/:mediaId los sirve); false en las filas legacy con solo objectKey. */
  inline: boolean;
};

type WorkOrderMediaMetaRow = {
  id: string;
  workOrderId: string;
  objectKey: string;
  mediaType: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
  createdBy: string | null;
};

function mapMediaMeta(row: WorkOrderMediaMetaRow): WorkOrderMediaMeta {
  return {
    id: row.id,
    workOrderId: row.workOrderId,
    objectKey: row.objectKey,
    mediaType: row.mediaType as WorkOrderMediaRecord["mediaType"],
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    inline: row.objectKey.startsWith(WORK_ORDER_MEDIA_INLINE_PREFIX)
  };
}

/** Fila completa de work_order_media para una foto en línea (id propio: la objectKey lo referencia). */
export type WorkOrderInlineMediaRow = WorkOrderMediaMetaRow & { contentBase64: string };

export function buildInlineMediaRows(workOrderId: string, photos: WorkOrderPhotoInput[], createdBy: string | null, now = new Date()): WorkOrderInlineMediaRow[] {
  return photos.map((photo) => {
    const id = createId("wom");
    return {
      id,
      workOrderId,
      objectKey: `${WORK_ORDER_MEDIA_INLINE_PREFIX}${id}`,
      mediaType: "photo",
      contentBase64: photo.bytes.toString("base64"),
      mimeType: photo.mimeType,
      sizeBytes: photo.sizeBytes,
      createdAt: now,
      createdBy
    };
  });
}

type WorkOrderCreateData = {
  propertyId: string;
  roomId: string | null;
  title: string;
  description: string | null;
  priority: WorkOrderRecord["priority"];
  status: "open";
  blocksRoom: boolean;
  createdBy: string;
};

/** Cliente mínimo de escritura: `prisma`, un `Prisma.TransactionClient` o un doble en los unitarios. */
export type WorkOrderWriteClient = {
  workOrder: { create(args: { data: WorkOrderCreateData }): Promise<PrismaWorkOrder> };
  workOrderMedia: { createMany(args: { data: WorkOrderInlineMediaRow[] }): Promise<{ count: number }> };
};

/**
 * Parte + fotos en UNA unidad de escritura: createWorkOrder lo ejecuta dentro
 * de `prisma.$transaction` cuando hay fotos, de modo que un fallo al insertar
 * los medios deshace el parte (nunca queda un parte «con 2 de 3 fotos»).
 */
export async function persistWorkOrderWithPhotos(
  tx: WorkOrderWriteClient,
  input: { data: WorkOrderCreateData; photos: WorkOrderPhotoInput[]; createdBy: string }
): Promise<{ order: PrismaWorkOrder; media: WorkOrderMediaMeta[] }> {
  const order = await tx.workOrder.create({ data: input.data });
  if (input.photos.length === 0) return { order, media: [] };
  const rows = buildInlineMediaRows(order.id, input.photos, input.createdBy);
  const inserted = await tx.workOrderMedia.createMany({ data: rows });
  if (inserted.count !== rows.length) {
    throw new Error(`work_order_media: se esperaban ${rows.length} filas y se insertaron ${inserted.count}.`);
  }
  return { order, media: rows.map(mapMediaMeta) };
}

export async function listWorkOrders(
  propertyId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<WorkOrderRecord[]> {
  // Hot-fix: cap response size so a property with thousands of historic work
  // orders cannot blow up the response payload / API memory. Default 100,
  // hard ceiling 500, with optional offset for paging through history.
  const take = Math.min(500, Math.max(1, options.limit ?? 100));
  const skip = Math.max(0, options.offset ?? 0);
  const rows = await prisma.workOrder.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take,
    skip
  });
  return rows.map(mapOrder);
}

export async function createWorkOrder(input: {
  context: UserContext;
  roomNumber?: string;
  title: string;
  description?: string;
  priority: WorkOrderRecord["priority"];
  blocksRoom: boolean;
  /** Tanda UX-3 (M1): `photos?: [{ contentBase64, mimeType }]` sin validar (≤ 3, ≤ 1,5 MiB, jpeg|png|webp). */
  photos?: unknown;
  // `media` es opcional en el TIPO porque ai-operations/tools/operations.tools.ts:15 reutiliza este
  // tipo de retorno para bloquear y resolver (que devuelven WorkOrderRecord); en runtime siempre viaja.
  correlationId: string;
}): Promise<WorkOrderRecord & { media?: WorkOrderMediaMeta[] }> {
  // Tanda 8a (RBAC · L2, design §4.6): any employee opens a parte with
  // maintenance.workorder.create; updating, blocking and resolving keep
  // maintenance.workorder.manage.
  requirePermissions(input.context, ["maintenance.workorder.create"]);
  // Body-only guards run first (HK-04c): they leak nothing about the rows and
  // keep Prisma from throwing a 500 on a malformed request.
  assertRequiredString("El título", input.title);
  assertOptionalString("El número de habitación", input.roomNumber);
  assertOptionalString("La descripción", input.description);
  assertBoolean("El campo blocksRoom", input.blocksRoom);
  assertEnumValue("Prioridad no válida", input.priority, WO_PRIORITIES);
  // Fotos (UX-3 M1, D3): la camarera las adjunta AL CREAR con `create`; después
  // solo `manage` (attachWorkOrderMedia). Se validan antes de tocar la BD.
  const photos = parseWorkOrderPhotos(input.photos);

  const room = input.roomNumber
    ? await prisma.room.findFirst({
        where: { propertyId: input.context.propertyId, number: input.roomNumber },
        select: { id: true, number: true }
      })
    : null;

  if (input.blocksRoom && !input.context.permissions.includes("ai.high_risk.confirm")) {
    throw new ForbiddenError("Blocking a room requires manager or maintenance lead confirmation.");
  }

  const write = {
    data: {
      propertyId: input.context.propertyId,
      roomId: room?.id ?? null,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      status: "open" as const,
      blocksRoom: input.blocksRoom,
      createdBy: input.context.userId
    },
    photos,
    createdBy: input.context.userId
  };
  // Con fotos, parte y medios en una transacción (§4.6); sin fotos, la escritura
  // simple de siempre (ai-operations, offline y el POST clásico no cambian).
  const { order: created, media } = photos.length
    ? await prisma.$transaction((tx) => persistWorkOrderWithPhotos(tx, write))
    : await persistWorkOrderWithPhotos(prisma, write);
  const order = mapOrder(created);
  mirrorOrder(order);
  for (const item of media) {
    demoStore.workOrderMedia.push({ id: item.id, workOrderId: item.workOrderId, objectKey: item.objectKey, mediaType: item.mediaType });
  }

  if (input.blocksRoom && room) {
    const blocked = await applyRoomTransition({
      roomId: room.id,
      event: "block_maintenance",
      context: input.context,
      correlationId: input.correlationId,
      reason: `Parte ${order.id}: ${input.title}`
    });
    mirrorRoomState(room.id, blocked.state);
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_CREATED",
    entityType: "work_order",
    entityId: order.id,
    afterJson: { ...order, mediaCount: media.length },
    correlationId: input.correlationId
  });
  // Un evento por foto con sus METADATOS (nunca los bytes en la auditoría).
  for (const item of media) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "WORK_ORDER_MEDIA_ATTACHED",
      entityType: "work_order_media",
      entityId: item.id,
      afterJson: item,
      correlationId: input.correlationId
    });
  }

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "work_order",
    entityId: order.id,
    eventType: input.blocksRoom ? "RoomBlocked" : "WorkOrderCreated",
    payload: { roomId: room?.id, roomNumber: room?.number, priority: order.priority, mediaCount: media.length },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { ...order, media };
}

export async function updateWorkOrder(input: {
  context: UserContext;
  workOrderId: string;
  patch: Partial<Pick<WorkOrderRecord, "title" | "description" | "priority" | "status" | "assignedTo">>;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);
  // Enum guards (HK-04c) run first: they only look at the request body, so they
  // leak nothing about the order, and they keep Prisma from throwing a 500.
  if (input.patch.status !== undefined) assertEnumValue("Estado no válido", input.patch.status, WO_STATUSES);
  if (input.patch.priority !== undefined) assertEnumValue("Prioridad no válida", input.patch.priority, WO_PRIORITIES);
  // `title` is NOT NULL in Prisma, so a present title must be a non-empty
  // string; `description` / `assignedTo` are nullable and accept null to clear.
  if (input.patch.title !== undefined) assertRequiredString("El título", input.patch.title);
  assertOptionalString("La descripción", input.patch.description);
  assertOptionalString("El campo assignedTo", input.patch.assignedTo);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  const before = mapOrder(existing);

  // Transition guard (HK-04b): once resolved/closed the order is terminal. There
  // is no explicit reopen flow, so a status change out of a terminal state is
  // rejected; the only forward move allowed is resolved → closed.
  if (input.patch.status !== undefined && WO_TERMINAL_STATUSES.includes(existing.status)) {
    const closingResolved = existing.status === "resolved" && input.patch.status === "closed";
    if (!closingResolved) throw new ConflictError("La orden ya está resuelta.");
  }
  // A PATCH that moves the order into a terminal state stamps resolvedAt, the
  // same way resolveWorkOrder does, so dashboards see a consistent record.
  const stampResolvedAt =
    input.patch.status !== undefined && WO_TERMINAL_STATUSES.includes(input.patch.status) && !existing.resolvedAt;

  const updated = await prisma.workOrder.update({
    where: { id: input.workOrderId },
    data: {
      ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
      ...(input.patch.description !== undefined ? { description: input.patch.description ?? null } : {}),
      ...(input.patch.priority !== undefined ? { priority: input.patch.priority } : {}),
      ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
      ...(stampResolvedAt ? { resolvedAt: new Date() } : {}),
      ...(input.patch.assignedTo !== undefined ? { assignedTo: input.patch.assignedTo ?? null } : {})
    }
  });
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_UPDATED",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: order,
    correlationId: input.correlationId
  });

  return order;
}

export async function attachWorkOrderMedia(input: {
  context: UserContext;
  workOrderId: string;
  /** Forma clásica: referencia a un objeto externo (offline, clientes existentes). */
  objectKey?: string;
  /** Tanda UX-3 (M1, D3): foto en línea `{ contentBase64, mimeType }`; excluye objectKey. */
  contentBase64?: unknown;
  mimeType?: unknown;
  mediaType: WorkOrderMediaRecord["mediaType"];
  correlationId: string;
}): Promise<WorkOrderMediaMeta> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);
  assertEnumValue("Tipo de archivo no válido", input.mediaType, WO_MEDIA_TYPES);
  // Guardas de cuerpo (HK-04c) antes de cualquier lectura.
  const inline = input.contentBase64 !== undefined ? parseWorkOrderPhoto({ contentBase64: input.contentBase64, mimeType: input.mimeType }) : null;
  if (inline && input.mediaType !== "photo") {
    throw new BadRequestError("Una foto en línea solo admite mediaType photo.");
  }
  if (!inline) assertRequiredString("La clave del archivo (objectKey)", input.objectKey);

  // Tenancy (HK-04a): scoped lookup before writing the media row.
  const order = await findWorkOrderInOrg(input.workOrderId, input.context);

  let row: WorkOrderMediaMetaRow;
  if (inline) {
    // R4: como máximo 3 fotos en línea por parte (≤ 4,5 MiB por fila de parte). Recuento e inserción en UNA transacción
    // con el parte bloqueado (SELECT … FOR UPDATE): dos POST concurrentes ya no dejan una cuarta fila (corrector REV-L03).
    const [data] = buildInlineMediaRows(order.id, [inline], input.context.userId);
    row = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM work_orders WHERE id = ${order.id} FOR UPDATE`;
      const inlineCount = await tx.workOrderMedia.count({
        where: { workOrderId: order.id, objectKey: { startsWith: WORK_ORDER_MEDIA_INLINE_PREFIX } }
      });
      if (inlineCount >= WORK_ORDER_PHOTO_MAX_COUNT) {
        throw photoError("WORK_ORDER_PHOTOS_TOO_MANY", `Como máximo ${WORK_ORDER_PHOTO_MAX_COUNT} fotos por parte.`, {
          count: inlineCount,
          maxPhotos: WORK_ORDER_PHOTO_MAX_COUNT
        });
      }
      return tx.workOrderMedia.create({ data: data!, select: MEDIA_META_SELECT });
    });
  } else {
    row = await prisma.workOrderMedia.create({
      data: { workOrderId: order.id, objectKey: input.objectKey as string, mediaType: input.mediaType, createdBy: input.context.userId },
      select: MEDIA_META_SELECT
    });
  }
  const media = mapMediaMeta(row);
  demoStore.workOrderMedia.push({ id: media.id, workOrderId: media.workOrderId, objectKey: media.objectKey, mediaType: media.mediaType });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_MEDIA_ATTACHED",
    entityType: "work_order_media",
    entityId: media.id,
    afterJson: media,
    correlationId: input.correlationId
  });

  return media;
}

/** Columnas de metadatos (nunca content_base64: una lista de 3 fotos no debe mover 4,5 MiB). */
const MEDIA_META_SELECT = {
  id: true,
  workOrderId: true,
  objectKey: true,
  mediaType: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  createdBy: true
} as const;

/** GET /work-orders/:id/media (maintenance.read): metadatos de los medios del parte, 404 opaco fuera de la propiedad activa (REV-05). */
export async function listWorkOrderMedia(input: { context: UserContext; workOrderId: string }): Promise<WorkOrderMediaMeta[]> {
  requirePermissions(input.context, ["maintenance.read"]);
  const order = await prisma.workOrder.findUnique({ where: { id: input.workOrderId }, select: { id: true, propertyId: true } });
  if (!order || !(await canReadWorkOrderMedia(order, input.context))) throw new NotFoundError("Orden de trabajo no encontrada.");
  const rows = await prisma.workOrderMedia.findMany({
    where: { workOrderId: order.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: MEDIA_META_SELECT
  });
  return rows.map(mapMediaMeta);
}

const MEDIA_NOT_FOUND = "Archivo del parte no encontrado.";

export type WorkOrderMediaContent = { id: string; workOrderId: string; mimeType: string; sizeBytes: number; bytes: Buffer };

/**
 * GET /work-orders/media/:mediaId (maintenance.read): bytes de una foto en
 * línea. «No existe», «de otra organización», «de otra propiedad» (REV-05) y
 * «parte inaccesible» responden el MISMO 404 (opaco); una fila legacy con solo
 * objectKey responde 404 con details.code WORK_ORDER_MEDIA_NOT_INLINE (no hay
 * objeto que servir sin S3). Los bytes (hasta ~2 MiB en base64) se leen SOLO
 * después de resolver la tenencia: una sonda con ids ajenos cuesta metadatos,
 * no la fila entera (corrector REV-L02).
 */
export async function getWorkOrderMediaContent(input: { context: UserContext; mediaId: string }): Promise<WorkOrderMediaContent> {
  requirePermissions(input.context, ["maintenance.read"]);
  if (typeof input.mediaId !== "string" || input.mediaId.length === 0) throw new BadRequestError("Identificador inválido.");
  const media = await prisma.workOrderMedia.findUnique({ where: { id: input.mediaId }, select: { id: true, workOrderId: true, mimeType: true, objectKey: true } });
  if (!media) throw new NotFoundError(MEDIA_NOT_FOUND);
  const order = await prisma.workOrder.findUnique({ where: { id: media.workOrderId }, select: { propertyId: true } });
  if (!order || !(await canReadWorkOrderMedia(order, input.context))) throw new NotFoundError(MEDIA_NOT_FOUND);
  if (!media.objectKey.startsWith(WORK_ORDER_MEDIA_INLINE_PREFIX) || !media.mimeType) {
    throw new HttpError(404, "El archivo no está almacenado en línea.", true, { code: "WORK_ORDER_MEDIA_NOT_INLINE" });
  }
  const content = await prisma.workOrderMedia.findUnique({ where: { id: media.id }, select: { contentBase64: true } });
  if (!content?.contentBase64) {
    throw new HttpError(404, "El archivo no está almacenado en línea.", true, { code: "WORK_ORDER_MEDIA_NOT_INLINE" });
  }
  const bytes = Buffer.from(content.contentBase64, "base64");
  return { id: media.id, workOrderId: media.workOrderId, mimeType: media.mimeType, sizeBytes: bytes.length, bytes };
}

export async function blockRoomForMaintenance(input: {
  context: UserContext;
  workOrderId: string;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage", "ai.high_risk.confirm"]);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  if (!existing.roomId) {
    throw new BadRequestError("La orden de trabajo no está vinculada a ninguna habitación.");
  }
  // Idempotency guard: a second block-room on an order that already blocks its
  // room used to return 200 and emit a duplicate RoomBlocked domain event.
  if (existing.blocksRoom) {
    throw new ConflictError("La habitación ya está bloqueada por esta orden.");
  }
  const room = await prisma.room.findUnique({ where: { id: existing.roomId } });
  if (!room) throw new NotFoundError("Habitación no encontrada.");

  const before = mapOrder(existing);
  const updated = await prisma.workOrder.update({ where: { id: existing.id }, data: { blocksRoom: true } });
  const blocked = await applyRoomTransition({
    roomId: room.id,
    event: "block_maintenance",
    context: input.context,
    correlationId: input.correlationId,
    reason: `Parte ${existing.id}: bloqueo de habitación`
  });
  mirrorRoomState(room.id, blocked.state);
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_BLOCKED_FOR_MAINTENANCE",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: { order, roomId: room.id },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    entityType: "room",
    entityId: room.id,
    eventType: "RoomBlocked",
    payload: { workOrderId: order.id, roomNumber: room.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return order;
}

export async function resolveWorkOrder(input: {
  context: UserContext;
  workOrderId: string;
  resolutionNote?: string;
  releaseRoom?: boolean;
  correlationId: string;
}): Promise<WorkOrderRecord> {
  requirePermissions(input.context, ["maintenance.workorder.manage"]);

  // Tenancy (HK-04a) before any business rule.
  const existing = await findWorkOrderInOrg(input.workOrderId, input.context);
  // Transition guard (HK-04b): resolving an already resolved/closed order used to
  // return 200, re-stamp resolvedAt and emit a duplicate WorkOrderResolved event.
  if (WO_TERMINAL_STATUSES.includes(existing.status)) {
    throw new ConflictError("La orden ya está resuelta.");
  }
  const room = existing.roomId ? await prisma.room.findUnique({ where: { id: existing.roomId } }) : null;
  const before = mapOrder(existing);

  const updated = await prisma.workOrder.update({
    where: { id: existing.id },
    data: { status: "resolved", resolvedAt: new Date() }
  });

  if (input.releaseRoom && room) {
    // release_maintenance: mnt ok, vendible, SUCIA (tras la intervención se limpia);
    // ocupada si hay alguien alojado, libre/sucia si no.
    const released = await applyRoomTransition({
      roomId: room.id,
      event: "release_maintenance",
      context: input.context,
      correlationId: input.correlationId,
      reason: `Parte ${existing.id} resuelto: habitación liberada`
    });
    mirrorRoomState(room.id, released.state);
  }
  const order = mapOrder(updated);
  mirrorOrder(order);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "WORK_ORDER_RESOLVED",
    entityType: "work_order",
    entityId: order.id,
    beforeJson: before,
    afterJson: { order, resolutionNote: input.resolutionNote },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: order.propertyId,
    entityType: "work_order",
    entityId: order.id,
    eventType: "WorkOrderResolved",
    payload: { roomId: order.roomId, releaseRoom: input.releaseRoom ?? false },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return order;
}
