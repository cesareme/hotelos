// Firma real del parte de viajeros (Tanda CHK · W2-B). Diseño §4a paso 5 y §7.3.
//
// `signGuest`: PNG del trazo (+ SVG opcional) y evidencias (puntos, duración,
// bbox, ip, userAgent, sesión, método) → validación de tamaño y de trazo mínimo
// → menor < 14 → 409 SIGNATURE_NOT_REQUIRED (los declara el adulto, art. 4.2)
// → parte inexistente o incompleto (validador con signatureRequired:false para
// comprobar el resto) → 409 GUEST_REGISTER_INCOMPLETE → almacén de firmas
// (signature-storage.ts, data-URI hasta T9) → fila `signatures` con SHA-256 y
// retentionUntil = salida + 3 años (calculateSpainGuestRegisterRetentionUntil,
// art. 5.3) → `markGuestRegisterSigned` con signatureObjectKey = id de la firma
// (identificador estable; sustituye los literales sig_drawer_checkin /
// sig_manual_checkin / sig_demo_guest) → PDF del parte de entrada
// (entry-form-pdf.ts) con su hash en la misma fila → CheckInGuest `signed`.
// Solo servicios: las rutas las añade W3-A. Dependencias inyectables:
// resetSignatureServiceForTests.

import { createHash } from "node:crypto";
import { z } from "zod";
import { calculateSpainGuestRegisterRetentionUntil, guestRegisterValidationInput, validateSpainGuestRegisterRecord } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { SIGNATURE_METHODS } from "@hotelos/shared";
import type { SignatureMethod } from "@hotelos/shared";
import type { GuestRegisterRecord, UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { parse } from "../../lib/validate.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { markGuestRegisterSigned } from "../compliance/compliance.service.js";
import { renderEntryFormPdf } from "./entry-form-pdf.js";
import type { EntryFormProperty } from "./entry-form-pdf.js";
import { getSignatureStorage, signatureMaxBytes } from "./signature-storage.js";
import type { SignatureStorage } from "./signature-storage.js";

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Trazo mínimo: menos puntos no es una firma (un toque accidental). */
export const SIGNATURE_MIN_POINTS = 8;
/** Edad (a la llegada) por debajo de la cual no se firma: los declara el adulto (RD 933/2021 art. 4.2). */
export const SIGNATURE_MIN_AGE = 14;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type StrokeMeta = { points: number; durationMs: number; bbox: Record<string, number> };

export type SignGuestInput = {
  /** Contexto de servicio (W2-A) o usuario de recepción; exige guest_register.sign. */
  context: UserContext;
  /** Viajero del check-in (su parte se toma de guestRegisterRecordId de la fila). */
  checkInGuestId?: string;
  /** Parte a firmar (obligatorio si no hay viajero de check-in, p. ej. drawer de recepción). */
  guestRegisterRecordId?: string;
  /** PNG del trazo en base64 (admite el prefijo data:image/png;base64,). */
  pngBase64: string;
  /** SVG del trazo (texto), opcional: se guarda junto al PNG y su clave va en strokeMetaJson. */
  svg?: string;
  strokeMeta: StrokeMeta;
  method: SignatureMethod;
  ip?: string;
  userAgent?: string;
  /** Sesión (CheckInSession o GuestPortalSession) desde la que se firma. */
  sessionId?: string;
  correlationId?: string;
};

export type SignGuestResult = {
  signatureId: string;
  guestRegisterRecordId: string;
  checkInGuestId: string | null;
  sha256: string;
  pdfSha256: string;
  signedAt: string;
  retentionUntil: string;
  method: SignatureMethod;
  guestRegisterStatus: GuestRegisterRecord["status"];
  checkInGuestStatus: string | null;
  /** true cuando el viajero ya había firmado y se devuelve la firma existente (corrector REV3-12: sin segunda fila ni segundo PDF). */
  idempotent: boolean;
};

/** Firma existente de un viajero/parte (la más reciente) para la respuesta idempotente. */
export type ExistingSignatureRow = {
  id: string;
  guestRegisterRecordId: string;
  checkInGuestId: string | null;
  sha256: string;
  pdfSha256: string | null;
  signedAt: Date;
  retentionUntil: Date;
  method: string;
};

export type GuestRegisterRow = Awaited<ReturnType<typeof prisma.guestRegisterRecord.findUniqueOrThrow>>;

export type SignatureCheckInGuestRow = {
  id: string;
  sessionId: string;
  propertyId: string;
  guestRegisterRecordId: string | null;
  status: string;
  isMinor: boolean;
  ageAtArrival: number | null;
  dateOfBirth: Date | null;
  session: { id: string; organizationId: string; propertyId: string; reservationId: string };
};

export type SignaturePropertyRow = EntryFormProperty & { id: string; organizationId: string };

export type SignatureDeps = {
  now: () => Date;
  createId: (prefix: string) => string;
  /** Límite del PNG/SVG en bytes (CHECKIN_SIGNATURE_MAX_BYTES vía checkin-config.ts). */
  signatureMaxBytes: () => number;
  storage: () => SignatureStorage;
  loadCheckInGuest: (id: string) => Promise<SignatureCheckInGuestRow | null>;
  loadGuestRegisterRow: (id: string) => Promise<GuestRegisterRow | null>;
  loadProperty: (id: string) => Promise<SignaturePropertyRow | null>;
  loadReservationDates: (reservationId: string) => Promise<{ arrivalDate: Date; departureDate: Date } | null>;
  /** Firma más reciente del viajero (o del parte, sin viajero) o null (idempotencia). */
  loadExistingSignature: (input: { checkInGuestId: string | null; guestRegisterRecordId: string }) => Promise<ExistingSignatureRow | null>;
  createSignature: (data: Prisma.SignatureUncheckedCreateInput) => Promise<{ id: string }>;
  updateSignature: (id: string, data: Prisma.SignatureUncheckedUpdateInput) => Promise<unknown>;
  markGuestRegisterSigned: typeof markGuestRegisterSigned;
  updateCheckInGuest: (id: string, data: Prisma.CheckInGuestUncheckedUpdateInput) => Promise<unknown>;
  recordAuditEvent: typeof recordAuditEvent;
};

function defaultDeps(): SignatureDeps {
  return {
    now: () => new Date(),
    createId,
    signatureMaxBytes: () => signatureMaxBytes(),
    storage: getSignatureStorage,
    loadCheckInGuest: (id) =>
      prisma.checkInGuest.findUnique({
        where: { id },
        select: {
          id: true,
          sessionId: true,
          propertyId: true,
          guestRegisterRecordId: true,
          status: true,
          isMinor: true,
          ageAtArrival: true,
          dateOfBirth: true,
          session: { select: { id: true, organizationId: true, propertyId: true, reservationId: true } }
        }
      }),
    loadGuestRegisterRow: (id) => prisma.guestRegisterRecord.findUnique({ where: { id } }),
    loadProperty: (id) =>
      prisma.property.findUnique({
        where: { id },
        select: { id: true, organizationId: true, name: true, tradeName: true, address: true, postalCode: true, municipality: true, province: true, country: true, sesEstablishmentCode: true }
      }),
    loadReservationDates: (reservationId) => prisma.reservation.findUnique({ where: { id: reservationId }, select: { arrivalDate: true, departureDate: true } }),
    loadExistingSignature: (input) =>
      prisma.signature.findFirst({
        where: input.checkInGuestId ? { checkInGuestId: input.checkInGuestId } : { guestRegisterRecordId: input.guestRegisterRecordId, checkInGuestId: null },
        orderBy: { signedAt: "desc" },
        select: { id: true, guestRegisterRecordId: true, checkInGuestId: true, sha256: true, pdfSha256: true, signedAt: true, retentionUntil: true, method: true }
      }),
    createSignature: (data) => prisma.signature.create({ data, select: { id: true } }),
    updateSignature: (id, data) => prisma.signature.update({ where: { id }, data, select: { id: true } }),
    markGuestRegisterSigned,
    updateCheckInGuest: (id, data) => prisma.checkInGuest.update({ where: { id }, data, select: { id: true } }),
    recordAuditEvent
  };
}

let overrides: Partial<SignatureDeps> | null = null;
function currentDeps(): SignatureDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}
/** Sustituye dependencias (tests sin Prisma). Sin argumento restaura las reales. */
export function resetSignatureServiceForTests(deps?: Partial<SignatureDeps>): void {
  overrides = deps ?? null;
}

// ---------------------------------------------------------------------------
// Validación de la entrada
// ---------------------------------------------------------------------------

const finiteNumber = z.number().finite();
const signInputSchema = z
  .object({
    checkInGuestId: z.string().trim().min(1).optional(),
    guestRegisterRecordId: z.string().trim().min(1).optional(),
    pngBase64: z.string().min(1, "pngBase64 obligatorio"),
    svg: z.string().min(1).optional(),
    strokeMeta: z
      .object({
        points: z.number().int().min(0),
        durationMs: finiteNumber.min(0),
        bbox: z.record(z.string(), finiteNumber)
      })
      .strict(),
    method: z.enum(SIGNATURE_METHODS),
    ip: z.string().trim().min(1).max(64).optional(),
    userAgent: z.string().trim().min(1).max(512).optional(),
    sessionId: z.string().trim().min(1).optional()
  })
  .strict()
  .refine((value) => Boolean(value.checkInGuestId || value.guestRegisterRecordId), { message: "Se necesita checkInGuestId o guestRegisterRecordId." });

/** base64 (con o sin prefijo data:image/png;base64,) → bytes PNG validados en tamaño y cabecera. */
export function decodeSignaturePng(pngBase64: string, maxBytes: number = signatureMaxBytes()): Buffer {
  const raw = pngBase64.trim();
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(raw);
  if (match && match[1]!.toLowerCase() !== "image/png") throw new BadRequestError(`La firma debe ser image/png (recibido ${match[1]}).`);
  const base64 = (match ? match[2]! : raw).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestError("pngBase64 no es base64 válido.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new BadRequestError("La firma está vacía.");
  if (bytes.length > maxBytes) throw new HttpError(413, `La firma supera el tamaño máximo (${bytes.length} > ${maxBytes} bytes).`, true, { code: "SIGNATURE_TOO_LARGE", maxBytes });
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new BadRequestError("La firma no es un PNG (cabecera inválida).");
  return bytes;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Años cumplidos en la fecha `at` (UTC). */
export function ageAt(dateOfBirth: Date, at: Date): number {
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday = at.getUTCMonth() < dateOfBirth.getUTCMonth() || (at.getUTCMonth() === dateOfBirth.getUTCMonth() && at.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function scopedTo(context: UserContext, organizationId: string): boolean {
  return context.isPlatformAdmin === true || organizationId === context.organizationId;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export async function signGuest(input: SignGuestInput): Promise<SignGuestResult> {
  const deps = currentDeps();
  requirePermissions(input.context, ["guest_register.sign"]);
  const { context, correlationId: givenCorrelationId, ...rest } = input;
  const body = parse(signInputSchema, rest, "body");
  const correlationId = givenCorrelationId ?? deps.createId("corr");
  const now = deps.now();

  // Trazo mínimo y bytes del PNG (tamaño ≤ CHECKIN_SIGNATURE_MAX_BYTES, cabecera PNG).
  if (body.strokeMeta.points < SIGNATURE_MIN_POINTS) throw new BadRequestError(`La firma es demasiado corta: se necesitan al menos ${SIGNATURE_MIN_POINTS} puntos (recibidos ${body.strokeMeta.points}).`);
  const maxBytes = deps.signatureMaxBytes();
  const png = decodeSignaturePng(body.pngBase64, maxBytes);
  const sha256 = sha256Hex(png);

  // Viajero del check-in (opcional) y parte: 404 opaco fuera de la organización.
  let guest: SignatureCheckInGuestRow | null = null;
  if (body.checkInGuestId) {
    guest = await deps.loadCheckInGuest(body.checkInGuestId);
    if (!guest || !scopedTo(context, guest.session.organizationId)) throw new NotFoundError("Viajero del check-in no encontrado.");
    if (body.guestRegisterRecordId && guest.guestRegisterRecordId && body.guestRegisterRecordId !== guest.guestRegisterRecordId) {
      throw new BadRequestError("guestRegisterRecordId no corresponde al viajero del check-in.");
    }
  }
  const recordId = body.guestRegisterRecordId ?? guest?.guestRegisterRecordId ?? null;
  if (!recordId) {
    throw new ConflictError("El viajero no tiene parte de viajeros: complete los datos antes de firmar.", { code: "GUEST_REGISTER_INCOMPLETE", missing: ["guestRegisterRecord"] });
  }
  const row = await deps.loadGuestRegisterRow(recordId);
  if (!row) throw new NotFoundError("Parte de viajeros no encontrado.");
  const property = await deps.loadProperty(row.propertyId);
  if (!property || !scopedTo(context, property.organizationId)) throw new NotFoundError("Parte de viajeros no encontrado.");
  if (guest && guest.session.propertyId !== row.propertyId) throw new BadRequestError("El parte pertenece a otra propiedad que el viajero del check-in.");

  // Menor < 14 a la llegada → sin firma (la declara el adulto).
  const reservation = guest?.session.reservationId ? await deps.loadReservationDates(guest.session.reservationId) : row.reservationId ? await deps.loadReservationDates(row.reservationId) : null;
  const arrival = row.checkinAt ?? reservation?.arrivalDate ?? now;
  const dateOfBirth = row.dateOfBirth ?? guest?.dateOfBirth ?? null;
  const ageAtArrival = guest?.ageAtArrival ?? (dateOfBirth ? ageAt(dateOfBirth, arrival) : null);
  const minor = guest?.isMinor === true || row.isMinor === true || (ageAtArrival !== null && ageAtArrival < SIGNATURE_MIN_AGE);
  if (minor) {
    throw new ConflictError(`Los menores de ${SIGNATURE_MIN_AGE} años no firman el parte: lo declara el adulto que los acompaña.`, { code: "SIGNATURE_NOT_REQUIRED", ageAtArrival, isMinor: true });
  }

  // Idempotencia (corrector REV3-12): un parte ya firmado con una fila `signatures` real devuelve
  // esa firma en vez de crear otra fila y otro PDF (la re-firma explícita pasa por recepción).
  const signedAlready = Boolean(row.signedAt) && (guest ? guest.status === "signed" || guest.status === "verified" : true);
  if (signedAlready) {
    const existing = await deps.loadExistingSignature({ checkInGuestId: guest?.id ?? null, guestRegisterRecordId: row.id });
    if (existing && existing.pdfSha256) {
      return {
        signatureId: existing.id,
        guestRegisterRecordId: existing.guestRegisterRecordId,
        checkInGuestId: existing.checkInGuestId,
        sha256: existing.sha256,
        pdfSha256: existing.pdfSha256,
        signedAt: existing.signedAt.toISOString(),
        retentionUntil: existing.retentionUntil.toISOString(),
        method: existing.method as SignatureMethod,
        guestRegisterStatus: row.status as GuestRegisterRecord["status"],
        checkInGuestStatus: guest?.status ?? null,
        idempotent: true
      };
    }
  }

  // El resto del parte debe estar completo (la firma es lo único que puede faltar).
  const validation = validateSpainGuestRegisterRecord({ ...guestRegisterValidationInput(row), signatureRequired: false });
  if (!validation.valid) {
    const blocking = validation.issues.filter((issue) => issue.severity === "blocking");
    throw new ConflictError("El parte de viajeros está incompleto: complete los datos antes de firmar.", {
      code: "GUEST_REGISTER_INCOMPLETE",
      missing: [...new Set(blocking.map((issue) => String(issue.field ?? issue.code)))],
      issues: blocking.map((issue) => issue.code)
    });
  }

  // Almacén (data-URI hasta T9): PNG obligatorio, SVG opcional.
  const storage = deps.storage();
  const scope = guest?.sessionId ?? row.id;
  const baseKey = `org/${safeSegment(property.organizationId)}/prop/${safeSegment(row.propertyId)}/checkin/${safeSegment(scope)}`;
  const subject = safeSegment(guest?.id ?? row.id);
  const { objectKey } = await storage.put(`${baseKey}/signature-${subject}.png`, png, "image/png");
  let svgObjectKey: string | null = null;
  let svgSha256: string | null = null;
  if (body.svg) {
    const svgBytes = Buffer.from(body.svg, "utf8");
    if (svgBytes.length > maxBytes) throw new HttpError(413, `El SVG de la firma supera el tamaño máximo (${svgBytes.length} > ${maxBytes} bytes).`, true, { code: "SIGNATURE_TOO_LARGE", maxBytes });
    svgObjectKey = (await storage.put(`${baseKey}/signature-${subject}.svg`, svgBytes, "image/svg+xml")).objectKey;
    svgSha256 = sha256Hex(svgBytes);
  }

  // Fila `signatures`: evidencias + retención 3 años desde la salida (art. 5.3).
  const signatureId = deps.createId("sgn");
  const signedAt = now;
  const retentionBase = row.checkoutAt ?? reservation?.departureDate ?? now;
  const retentionUntil = new Date(calculateSpainGuestRegisterRetentionUntil(retentionBase));
  const strokeMetaJson: Prisma.InputJsonValue = {
    points: body.strokeMeta.points,
    durationMs: body.strokeMeta.durationMs,
    bbox: body.strokeMeta.bbox,
    ...(svgObjectKey ? { svgObjectKey, svgSha256 } : {})
  };
  await deps.createSignature({
    id: signatureId,
    organizationId: property.organizationId,
    propertyId: row.propertyId,
    checkInGuestId: guest?.id ?? null,
    guestRegisterRecordId: row.id,
    objectKey,
    sha256,
    signedAt,
    ip: body.ip ?? null,
    userAgent: body.userAgent ?? null,
    sessionId: body.sessionId ?? guest?.sessionId ?? null,
    strokeMetaJson,
    method: body.method,
    retentionUntil
  });

  // Parte firmado con el identificador estable de la firma (nunca un literal sig_*).
  const record = await deps.markGuestRegisterSigned({ context, guestRegisterRecordId: row.id, signatureObjectKey: signatureId, correlationId });

  // PDF del parte de entrada con el hash de la firma (el escritor no incrusta imágenes).
  const pdf = renderEntryFormPdf({ record, property, signature: { id: signatureId, sha256, signedAt, method: body.method }, generatedAt: now }, png);
  const pdfSha256 = sha256Hex(pdf);
  const { objectKey: pdfObjectKey } = await storage.put(`${baseKey}/entry-form-${safeSegment(row.id)}.pdf`, pdf, "application/pdf");
  await deps.updateSignature(signatureId, { pdfObjectKey, pdfSha256 });

  let checkInGuestStatus: string | null = null;
  if (guest) {
    checkInGuestStatus = guest.status === "verified" ? "verified" : "signed";
    await deps.updateCheckInGuest(guest.id, { status: checkInGuestStatus });
  }

  deps.recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: row.propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action: "CHECKIN_GUEST_SIGNED",
    entityType: "signature",
    entityId: signatureId,
    afterJson: { guestRegisterRecordId: row.id, checkInGuestId: guest?.id ?? null, sha256, pdfSha256, method: body.method, points: body.strokeMeta.points, durationMs: body.strokeMeta.durationMs, retentionUntil: retentionUntil.toISOString() },
    ipAddress: body.ip,
    deviceId: context.deviceId,
    correlationId
  });

  return {
    signatureId,
    guestRegisterRecordId: row.id,
    checkInGuestId: guest?.id ?? null,
    sha256,
    pdfSha256,
    signedAt: signedAt.toISOString(),
    retentionUntil: retentionUntil.toISOString(),
    method: body.method,
    guestRegisterStatus: record.status,
    checkInGuestStatus,
    idempotent: false
  };
}
