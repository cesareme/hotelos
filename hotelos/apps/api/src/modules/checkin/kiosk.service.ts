// Kioscos de check-in (Tanda CHK · lote W2-A; diseño §6 KioskDevice, §7.2
// GET/POST/PATCH /properties/:propertyId/kiosks · POST …/kiosks/:id/pair y §7.1
// POST /guest-portal/check-in/kiosk/claim).
//
// Emparejamiento sin hardware ni proveedor (decisión del brief): la recepción
// da de alta el dispositivo y pide un código de 8 dígitos (startPairing) que
// se muestra UNA vez y del que solo se guarda el hash sha256 con caducidad
// KIOSK_PAIRING_TTL_MS; la tablet lo teclea (claimPairing) y recibe un
// deviceToken opaco (randomBytes(32).hex) del que también se guarda solo el
// hash. Un código se reclama una sola vez: el updateMany condicionado al hash
// pendiente garantiza que dos claims simultáneos no obtengan dos tokens.
// authenticateKiosk(token) → device (status ≠ disabled) o null; heartbeat
// actualiza lastSeenAt/online.
//
// Las funciones puras (código, hash, caducidad, veredicto y transición del
// claim) están exportadas para __tests__/kiosk.test.mts (sin BD).

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { KioskDeviceCapabilities, KioskDeviceDto, KioskDeviceStatus } from "@hotelos/shared";
import { KIOSK_DEVICE_STATUSES } from "@hotelos/shared";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { readCheckInConfig } from "./checkin-config.js";
import type { KioskCreateInput, KioskPatchInput } from "./checkin.schemas.js";

type KioskRow = Prisma.KioskDeviceGetPayload<Record<string, never>>;

export const PAIRING_CODE_LENGTH = 8;
export const KIOSK_NOT_FOUND = "Kiosco no encontrado.";
export const KIOSK_PAIRING_INVALID_MESSAGE = "Código de emparejamiento no válido o caducado.";

// ── Funciones puras ──────────────────────────────────────────────────────────

/** Código de emparejamiento de 8 dígitos (ceros a la izquierda incluidos). */
export function generatePairingCode(randomInteger: (exclusiveMax: number) => number = (max) => randomInt(0, max)): string {
  return String(randomInteger(10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, "0");
}

export function normalizePairingCode(code: string): string {
  return code.replace(/\D/g, "");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code), "utf8").digest("hex");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function pairingExpiresAt(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

export function isPairingExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  return !expiresAt || expiresAt.getTime() <= now.getTime();
}

export type PairingState = { pairingCodeHash: string | null; pairingExpiresAt: Date | null; status: string };
export type PairingClaimVerdict = { ok: true } | { ok: false; reason: "disabled" | "no_pending_code" | "expired" | "mismatch" };

/** Veredicto de un claim sobre el estado de un dispositivo (comparación en tiempo constante). */
export function evaluatePairingClaim(input: { device: PairingState; code: string; now: Date }): PairingClaimVerdict {
  if (input.device.status === "disabled") return { ok: false, reason: "disabled" };
  if (!input.device.pairingCodeHash) return { ok: false, reason: "no_pending_code" };
  if (isPairingExpired(input.device.pairingExpiresAt, input.now)) return { ok: false, reason: "expired" };
  const expected = Buffer.from(input.device.pairingCodeHash, "hex");
  const actual = Buffer.from(hashPairingCode(input.code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

export type PairingClaimTransition = {
  deviceTokenHash: string;
  pairedAt: Date;
  lastSeenAt: Date;
  pairingCodeHash: null;
  pairingExpiresAt: null;
  status: "online";
};

/** Transición de estado tras un claim correcto: el código se consume y solo queda el hash del token. */
export function applyPairingClaim(now: Date, deviceToken: string): PairingClaimTransition {
  return {
    deviceTokenHash: hashDeviceToken(deviceToken),
    pairedAt: now,
    lastSeenAt: now,
    pairingCodeHash: null,
    pairingExpiresAt: null,
    status: "online"
  };
}

export function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

// ── DTO ──────────────────────────────────────────────────────────────────────

function capabilitiesOf(value: unknown): KioskDeviceCapabilities {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    mrzReader: source.mrzReader === true,
    cardEncoder: source.cardEncoder === true,
    paymentTerminal: source.paymentTerminal === true,
    printer: source.printer === true
  };
}

function configOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** DTO sin secretos: ni pairingCodeHash ni deviceTokenHash. */
export function toKioskDto(row: KioskRow): KioskDeviceDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    status: (KIOSK_DEVICE_STATUSES as readonly string[]).includes(row.status) ? (row.status as KioskDeviceStatus) : "unpaired",
    paired: Boolean(row.deviceTokenHash),
    pairedAt: row.pairedAt ? row.pairedAt.toISOString() : null,
    pairingExpiresAt: row.pairingExpiresAt ? row.pairingExpiresAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    capabilities: capabilitiesOf(row.capabilitiesJson),
    lockProvider: row.lockProvider ?? null,
    config: configOf(row.configJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ── Servicio ─────────────────────────────────────────────────────────────────

async function requireDevice(propertyId: string, deviceId: string): Promise<KioskRow> {
  const row = await prisma.kioskDevice.findFirst({ where: { id: deviceId, propertyId } });
  if (!row) throw new NotFoundError(KIOSK_NOT_FOUND);
  return row;
}

export async function listDevices(propertyId: string): Promise<KioskDeviceDto[]> {
  const rows = await prisma.kioskDevice.findMany({ where: { propertyId }, orderBy: [{ createdAt: "asc" }] });
  return rows.map(toKioskDto);
}

export async function createDevice(input: { context: UserContext; propertyId: string; input: KioskCreateInput; correlationId: string }): Promise<KioskDeviceDto> {
  requirePermissions(input.context, ["kiosk.configure"]);
  const row = await prisma.kioskDevice.create({
    data: {
      propertyId: input.propertyId,
      name: input.input.name,
      status: "unpaired",
      capabilitiesJson: capabilitiesOf(input.input.capabilities ?? {}) as unknown as Prisma.InputJsonValue,
      lockProvider: input.input.lockProvider ?? null,
      configJson: (input.input.config ?? {}) as Prisma.InputJsonValue
    }
  });
  const dto = toKioskDto(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "KioskDeviceCreated",
    entityType: "kiosk_device",
    entityId: row.id,
    afterJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return dto;
}

export async function patchDevice(input: {
  context: UserContext;
  propertyId: string;
  deviceId: string;
  patch: KioskPatchInput;
  correlationId: string;
}): Promise<KioskDeviceDto> {
  requirePermissions(input.context, ["kiosk.configure"]);
  const before = await requireDevice(input.propertyId, input.deviceId);
  const data: Prisma.KioskDeviceUncheckedUpdateInput = {};
  if (input.patch.name !== undefined) data.name = input.patch.name;
  if (input.patch.capabilities !== undefined) {
    data.capabilitiesJson = { ...capabilitiesOf(before.capabilitiesJson), ...input.patch.capabilities } as unknown as Prisma.InputJsonValue;
  }
  if (input.patch.lockProvider !== undefined) data.lockProvider = input.patch.lockProvider;
  if (input.patch.config !== undefined) data.configJson = { ...configOf(before.configJson), ...input.patch.config } as Prisma.InputJsonValue;
  if (input.patch.status !== undefined) {
    // disabled apaga el token; offline lo readmite (o vuelve a unpaired si nunca se emparejó).
    data.status = input.patch.status === "disabled" ? "disabled" : before.deviceTokenHash ? "offline" : "unpaired";
  }
  const row = await prisma.kioskDevice.update({ where: { id: before.id }, data });
  const dto = toKioskDto(row);
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "KioskDeviceUpdated",
    entityType: "kiosk_device",
    entityId: row.id,
    beforeJson: toKioskDto(before),
    afterJson: dto,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return dto;
}

/** Emite el código de emparejamiento (en claro UNA vez); guarda solo su hash y la caducidad. */
export async function startPairing(input: {
  context: UserContext;
  propertyId: string;
  deviceId: string;
  correlationId: string;
  now?: Date;
  ttlMs?: number;
}): Promise<{ device: KioskDeviceDto; code: string; expiresAt: string }> {
  requirePermissions(input.context, ["kiosk.configure"]);
  const before = await requireDevice(input.propertyId, input.deviceId);
  if (before.status === "disabled") throw new ConflictError("El kiosco está desactivado: actívalo antes de emparejarlo.");
  const now = input.now ?? new Date();
  const expiresAt = pairingExpiresAt(now, input.ttlMs ?? readCheckInConfig().kioskPairingTtlMs);
  const code = generatePairingCode();
  const row = await prisma.kioskDevice.update({
    where: { id: before.id },
    data: { pairingCodeHash: hashPairingCode(code), pairingExpiresAt: expiresAt }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "KioskPairingStarted",
    entityType: "kiosk_device",
    entityId: row.id,
    // Nunca el código: solo la caducidad.
    afterJson: { expiresAt: expiresAt.toISOString() },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { device: toKioskDto(row), code, expiresAt: expiresAt.toISOString() };
}

/**
 * La tablet reclama el código: un solo claim por código (updateMany condicionado
 * al hash pendiente). Cualquier fallo → 409 KIOSK_PAIRING_INVALID sin distinguir
 * código desconocido, caducado o ya consumido (sin oráculo).
 */
export async function claimPairing(
  code: string,
  now: Date = new Date(),
  options: { /** Corrector SEC-7: gate (módulo de la propiedad) sobre el dispositivo resuelto ANTES de consumir el código. */ gate?: (device: { id: string; propertyId: string }) => Promise<void> } = {}
): Promise<{ deviceToken: string; device: KioskDeviceDto; capabilities: KioskDeviceCapabilities }> {
  const invalid = () => new ConflictError(KIOSK_PAIRING_INVALID_MESSAGE, { code: "KIOSK_PAIRING_INVALID" });
  const normalized = normalizePairingCode(code);
  if (normalized.length !== PAIRING_CODE_LENGTH) throw invalid();
  const hash = hashPairingCode(normalized);
  const candidate = await prisma.kioskDevice.findFirst({ where: { pairingCodeHash: hash } });
  if (!candidate) throw invalid();
  const verdict = evaluatePairingClaim({ device: candidate, code: normalized, now });
  if (!verdict.ok) throw invalid();
  if (options.gate) await options.gate({ id: candidate.id, propertyId: candidate.propertyId });
  const deviceToken = generateDeviceToken();
  const claimed = await prisma.kioskDevice.updateMany({
    where: { id: candidate.id, pairingCodeHash: hash },
    data: applyPairingClaim(now, deviceToken)
  });
  if (claimed.count !== 1) throw invalid();
  const row = await prisma.kioskDevice.findUniqueOrThrow({ where: { id: candidate.id } });
  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
  recordAuditEvent({
    organizationId: property?.organizationId ?? row.propertyId,
    propertyId: row.propertyId,
    actorUserId: `kiosk:${row.id}`,
    actorType: "system",
    action: "KioskPaired",
    entityType: "kiosk_device",
    entityId: row.id,
    afterJson: { status: row.status, pairedAt: row.pairedAt?.toISOString() ?? null },
    deviceId: "checkin"
  });
  const dto = toKioskDto(row);
  return { deviceToken, device: dto, capabilities: dto.capabilities };
}

/** Dispositivo autenticado por su token opaco, o null (desconocido o desactivado). */
export async function authenticateKiosk(token: string | null | undefined): Promise<KioskDeviceDto | null> {
  if (!token || typeof token !== "string" || token.trim() === "") return null;
  const row = await prisma.kioskDevice.findFirst({ where: { deviceTokenHash: hashDeviceToken(token), status: { not: "disabled" } } });
  return row ? toKioskDto(row) : null;
}

export async function heartbeat(deviceId: string, now: Date = new Date()): Promise<KioskDeviceDto | null> {
  const row = await prisma.kioskDevice.findFirst({ where: { id: deviceId, status: { not: "disabled" }, deviceTokenHash: { not: null } } });
  if (!row) return null;
  const updated = await prisma.kioskDevice.update({ where: { id: row.id }, data: { lastSeenAt: now, status: "online" } });
  return toKioskDto(updated);
}
