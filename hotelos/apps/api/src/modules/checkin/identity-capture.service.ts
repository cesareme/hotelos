// Captura de identidad del check-in automatizado (Tanda CHK · W2-B).
// Diseño: docs/design/CHECKIN-AUTOMATIZADO-IA.md §1.3 (principio de identidad),
// §2.3 (política de PII), §4a pasos 3-5 y §7.3 (privacidad).
//
// Tubería de `captureDocument`:
//   (i)   `data:` URL validada (parseDataUrl de ai-core) y tamaño ≤ CHECKIN_DOCUMENT_MAX_BYTES;
//   (ii)  con clave (`isLlmConfigured`) → visión por el tool runner (runAiTool,
//         `extractGuestIdentityFieldsTemporary` persistido como `identity_capture`)
//         con esquema propio CHK_IDENTITY_SCHEMA; la fila de telemetría solo lleva
//         las claves leídas y su confianza, nunca valores ni la imagen;
//   (iii) `parseMrz` (W1-B) sobre las líneas transcritas por la visión o sobre
//         `hints.mrzLines` (lector hardware / entrada manual): si los dígitos de
//         control cuadran, la MRZ manda con confianza 1,0 (`mrz_ai` / `mrz_reader`);
//         los campos visuales entran si su confianza ≥ 0,85 y si no van a
//         `needsReview[]`; sin MRZ válida ni visión → `manual` con todo en revisión;
//   (iv)  `DocumentCapture` (fieldsJson SOLO no PII, confianzas, checks, telemetría,
//         imageStored:false, imageDiscardedAt, purgeAt = ahora + CHECKIN_CAPTURE_PURGE_DAYS)
//         y, con `checkInGuestId`, actualización del `CheckInGuest` (PII cifrada por
//         la extensión de Prisma) a `document_captured`;
//   (v)   `recordIdentityDiscardEvent` (compliance.service) + auditoría
//         ID_IMAGE_DISCARDED con la forma de check-in.command.ts:99-111;
//   (vi)  documento caducado → aviso sin bloquear; nombre distinto del titular y de
//         los acompañantes de la reserva → aviso + `identity_mismatch` en revisión y
//         el CheckInGuest NO se actualiza (§4d «no se vincula»); nunca 409 en la
//         captura: la vinculación la decide el llamador.
//
// La imagen vive en la petición y muere con ella: no se guarda en BD, almacén,
// logs ni telemetría (SHA-256 y bytes como mucho, vía DocumentTelemetry).
// Solo servicios: las rutas las añade el lote W3-A. Dependencias inyectables
// (tests sin Prisma ni modelo): resetIdentityCaptureForTests.

import { base64ByteLength, labelFor, parseDataUrl } from "@hotelos/ai-core";
import type { AiErrorCode, AiTelemetry, JsonSchema } from "@hotelos/ai-core";
import type { ToolRunResult } from "@hotelos/ai-core/runner";
import { parseMrz } from "@hotelos/compliance";
import type { MrzParseResult } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { DOCUMENT_CAPTURE_NON_PII_FIELDS } from "@hotelos/shared";
import type { DocumentCaptureFields, DocumentCaptureSource, MrzChecks } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError, TooManyRequestsError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { isLlmConfigured, llmExtractJsonFromDocument } from "../../lib/llm.js";
import { runAiTool } from "../ai-operations/tool-runner.service.js";
import { aiContextFor, apiToolContextFromRunner } from "../ai-operations/tools/context.js";
import type { NotConfiguredOutput } from "../ai-operations/tools/context.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordIdentityDiscardEvent } from "../compliance/compliance.service.js";
import { readCheckInConfig } from "./checkin-config.js";
import type { CheckInConfig } from "./checkin-config.js";

// ---------------------------------------------------------------------------
// Constantes y configuración
// ---------------------------------------------------------------------------

export const IDENTITY_TOOL_NAME = "extractGuestIdentityFieldsTemporary" as const;
/** Nombre con el que se persiste la llamada en ai_tool_calls (distinto del escaneo del drawer, scan_id_document). */
export const IDENTITY_RECORD_AS = "identity_capture" as const;
/** Política `require_confirmation_above_confidence`: los campos visuales por debajo van a revisión. */
export const VISION_CONFIDENCE_THRESHOLD = 0.85;
export const EXPIRED_DOCUMENT_WARNING = "documento caducado";
export const IDENTITY_MISMATCH_WARNING = "el nombre del documento no coincide con el titular ni con los acompañantes de la reserva";

/** Límites del módulo (CHECKIN_DOCUMENT_MAX_BYTES · CHECKIN_CAPTURE_PURGE_DAYS) leídos por checkin-config.ts (W2-A), nunca de process.env aquí. */
export type IdentityCaptureLimits = Pick<CheckInConfig, "documentMaxBytes" | "capturePurgeDays">;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Campos del documento más la dirección que la visión puede leer del anverso (dirección solo en CheckInGuest, cifrada). */
export type IdentityFields = DocumentCaptureFields & {
  /** PII */
  residenceFullAddress?: string;
  residenceLocality?: string;
  residenceCountry?: string;
};
export type IdentityFieldKey = keyof IdentityFields;
/** Claves de revisión: un campo, la banda MRZ completa o la discrepancia con la reserva. */
export type IdentityReviewKey = IdentityFieldKey | "mrz" | "identity_mismatch";

export type VisionExtraction = {
  mrzLines: string[] | null;
  fields: IdentityFields;
  confidence: Partial<Record<IdentityFieldKey, number>>;
};

export type VisionUsage = { model: string; tokensInput: number; tokensOutput: number; costEur: number | null };

export type MergedIdentity = {
  fields: IdentityFields;
  confidence: Partial<Record<IdentityFieldKey, number>>;
  checks: MrzChecks;
  source: DocumentCaptureSource;
  mrzFormat: "TD1" | "TD3" | null;
  needsReview: IdentityReviewKey[];
  warnings: string[];
};

/** Resultado de la captura: DocumentCaptureResult (@hotelos/shared) ampliado con dirección, avisos y el id de la fila. */
export type IdentityCaptureResult = MergedIdentity & {
  captureId: string;
  /** false cuando no había `checkInGuestId` (document_captures exige el viajero): el resultado solo vive en memoria. */
  persisted: boolean;
  vision: VisionUsage | null;
  processingMs: number;
};

export type CaptureDocumentInput = {
  /** Contexto de servicio (W2-A) o usuario de recepción; exige guest_register.create. */
  context: UserContext;
  propertyId: string;
  checkInGuestId?: string;
  /** `data:image/...;base64,…`; opcional cuando llega la MRZ de un lector o a mano. */
  imageDataUrl?: string;
  hints?: {
    documentType?: string;
    /** Líneas de la MRZ (lector hardware del kiosco o entrada manual) → fuente mrz_reader. */
    mrzLines?: string[] | string;
  };
  correlationId?: string;
};

export type CheckInGuestRow = {
  id: string;
  sessionId: string;
  propertyId: string;
  guestId: string | null;
  guestRegisterRecordId: string | null;
  status: string;
  firstName: string | null;
  surname1: string | null;
  surname2: string | null;
  session: { id: string; organizationId: string; propertyId: string; reservationId: string };
};

export type ReservationGuestName = { firstName: string; surname1: string | null; surname2: string | null };

export type IdentityCaptureDeps = {
  now: () => Date;
  createId: (prefix: string) => string;
  /** Límites vigentes (por defecto readCheckInConfig() del entorno del proceso). */
  limits: () => IdentityCaptureLimits;
  isLlmConfigured: () => boolean;
  runAiTool: typeof runAiTool;
  extractJson: typeof llmExtractJsonFromDocument;
  loadProperty: (propertyId: string) => Promise<{ id: string; organizationId: string } | null>;
  loadCheckInGuest: (id: string) => Promise<CheckInGuestRow | null>;
  loadReservationGuestNames: (reservationId: string) => Promise<ReservationGuestName[]>;
  createDocumentCapture: (data: Prisma.DocumentCaptureUncheckedCreateInput) => Promise<{ id: string }>;
  updateCheckInGuest: (id: string, data: Prisma.CheckInGuestUncheckedUpdateInput) => Promise<unknown>;
  purgeCaptures: (args: PurgeUpdateArgs) => Promise<{ count: number }>;
  recordIdentityDiscardEvent: typeof recordIdentityDiscardEvent;
  recordAuditEvent: typeof recordAuditEvent;
};

export type PurgeUpdateArgs = { where: Prisma.DocumentCaptureWhereInput; data: Prisma.DocumentCaptureUncheckedUpdateInput };

// ---------------------------------------------------------------------------
// Dependencias por defecto (Prisma, runner, ai-core) e inyección para tests
// ---------------------------------------------------------------------------

function defaultDeps(): IdentityCaptureDeps {
  return {
    now: () => new Date(),
    createId,
    limits: () => readCheckInConfig(),
    isLlmConfigured,
    runAiTool,
    extractJson: llmExtractJsonFromDocument,
    loadProperty: (propertyId) => prisma.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true } }),
    loadCheckInGuest: (id) =>
      prisma.checkInGuest.findUnique({
        where: { id },
        select: {
          id: true,
          sessionId: true,
          propertyId: true,
          guestId: true,
          guestRegisterRecordId: true,
          status: true,
          firstName: true,
          surname1: true,
          surname2: true,
          session: { select: { id: true, organizationId: true, propertyId: true, reservationId: true } }
        }
      }),
    loadReservationGuestNames: async (reservationId) => {
      const links = await prisma.reservationGuest.findMany({ where: { reservationId }, select: { guest: { select: { firstName: true, surname1: true, surname2: true } } } });
      return links.map((link) => link.guest);
    },
    createDocumentCapture: (data) => prisma.documentCapture.create({ data, select: { id: true } }),
    updateCheckInGuest: (id, data) => prisma.checkInGuest.update({ where: { id }, data, select: { id: true } }),
    purgeCaptures: (args) => prisma.documentCapture.updateMany(args),
    recordIdentityDiscardEvent,
    recordAuditEvent
  };
}

let overrides: Partial<IdentityCaptureDeps> | null = null;
function currentDeps(): IdentityCaptureDeps {
  return overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}
/** Sustituye dependencias (tests sin Prisma ni modelo). Sin argumento restaura las reales. */
export function resetIdentityCaptureForTests(deps?: Partial<IdentityCaptureDeps>): void {
  overrides = deps ?? null;
}

// ---------------------------------------------------------------------------
// Esquema e instrucción de la visión (propios del módulo; ai-core no se toca)
// ---------------------------------------------------------------------------

const NULLABLE_STRING: JsonSchema = { type: ["string", "null"] };
const CONFIDENCE_KEYS = ["mrzLines", "documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "dateOfBirth", "expiryDate", "nationality", "sex", "address"] as const;

/** Salida estructurada de la transcripción: MRZ + campos visuales + confianza 0..1 por campo. */
export const CHK_IDENTITY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mrzLines", "documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "dateOfBirth", "expiryDate", "nationality", "sex", "address", "confidence"],
  properties: {
    mrzLines: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], description: "Líneas de la zona de lectura mecánica tal cual, con los '<'; null si no se ve." },
    documentType: { type: "string", enum: ["DNI", "NIE", "TIE", "PASSPORT", "OTHER"] },
    documentNumber: NULLABLE_STRING,
    documentSupportNumber: { ...NULLABLE_STRING, description: "Número de soporte (DNI/TIE), p. ej. AAA123456; null si no consta." },
    firstName: NULLABLE_STRING,
    surname1: NULLABLE_STRING,
    surname2: NULLABLE_STRING,
    dateOfBirth: { ...NULLABLE_STRING, description: "YYYY-MM-DD" },
    expiryDate: { ...NULLABLE_STRING, description: "YYYY-MM-DD" },
    nationality: { ...NULLABLE_STRING, description: "Código ISO 3166-1 alfa-3 (ESP, FRA…)" },
    sex: { anyOf: [{ type: "string", enum: ["M", "F", "X"] }, { type: "null" }], description: "Tal como figura en el documento (ICAO M/F/X)." },
    address: {
      anyOf: [
        { type: "object", additionalProperties: false, properties: { street: NULLABLE_STRING, locality: NULLABLE_STRING, postalCode: NULLABLE_STRING, country: NULLABLE_STRING } },
        { type: "null" }
      ],
      description: "Domicilio impreso en el documento (reverso del DNI); null si no consta."
    },
    confidence: {
      type: "object",
      additionalProperties: true,
      properties: Object.fromEntries(CONFIDENCE_KEYS.map((key) => [key, { type: "number", minimum: 0, maximum: 1 }])),
      description: "Confianza 0..1 por campo transcrito."
    }
  }
};

export const CHK_IDENTITY_INSTRUCTION =
  "Transcribe el documento de identidad de la imagen (DNI, NIE/TIE o pasaporte). Copia las líneas de la zona de lectura mecánica (MRZ) exactamente, carácter a carácter y con los '<'. " +
  "Transcribe también los campos impresos en la zona visual sin corregirlos ni inferirlos: si un campo no se lee, devuelve null y confianza baja. " +
  "No identifiques a la persona ni describas su fotografía; devuelve solo el JSON del esquema.";

// ---------------------------------------------------------------------------
// Normalización de la visión y fusión MRZ ↔ visión (puras)
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
function upper(value: unknown): string | undefined {
  const t = text(value);
  return t ? t.toUpperCase() : undefined;
}
function isoDay(value: unknown): string | undefined {
  const t = text(value);
  if (!t || !DAY_RE.test(t)) return undefined;
  return Number.isNaN(new Date(`${t}T00:00:00.000Z`).getTime()) ? undefined : t;
}
function unit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}
/** ICAO M/F/X (o H/M/O ya en vocabulario SES) → H hombre · M mujer · O otro/no consta. */
function sesSex(value: unknown): string | undefined {
  const t = upper(value);
  if (!t) return undefined;
  if (t === "M" || t === "MALE" || t === "H" || t === "HOMBRE" || t === "V") return "H";
  if (t === "F" || t === "FEMALE" || t === "MUJER") return "M";
  if (t === "X" || t === "O" || t === "OTRO") return "O";
  return undefined;
}
const DOCUMENT_TYPES = new Set(["DNI", "NIE", "TIE", "PASSPORT", "OTHER"]);

/** Salida JSON del modelo → VisionExtraction (valores saneados; confianza por campo acotada a 0..1). */
export function normalizeVisionOutput(data: Record<string, unknown>): VisionExtraction {
  const conf = (data.confidence && typeof data.confidence === "object" ? (data.confidence as Record<string, unknown>) : {}) as Record<string, unknown>;
  const c = (key: string): number | undefined => unit(conf[key]);
  const fields: IdentityFields = {};
  const confidence: Partial<Record<IdentityFieldKey, number>> = {};
  const set = (key: IdentityFieldKey, value: string | undefined, confKey: string): void => {
    if (value === undefined) return;
    assign(fields, key, value);
    confidence[key] = c(confKey) ?? 0;
  };
  const documentType = upper(data.documentType);
  set("documentType", documentType && DOCUMENT_TYPES.has(documentType) ? documentType : undefined, "documentType");
  set("documentNumber", upper(data.documentNumber)?.replace(/[\s-]/g, ""), "documentNumber");
  set("documentSupportNumber", upper(data.documentSupportNumber)?.replace(/[\s-]/g, ""), "documentSupportNumber");
  set("firstName", upper(data.firstName), "firstName");
  set("surname1", upper(data.surname1), "surname1");
  set("surname2", upper(data.surname2), "surname2");
  set("dateOfBirth", isoDay(data.dateOfBirth), "dateOfBirth");
  set("documentExpiryDate", isoDay(data.expiryDate), "expiryDate");
  set("nationality", upper(data.nationality), "nationality");
  set("sex", sesSex(data.sex), "sex");
  const address = data.address && typeof data.address === "object" ? (data.address as Record<string, unknown>) : null;
  if (address) {
    const street = text(address.street);
    const postalCode = text(address.postalCode);
    set("residenceFullAddress", street ? [street, postalCode].filter(Boolean).join(", ") : undefined, "address");
    set("residenceLocality", text(address.locality), "address");
    set("residenceCountry", upper(address.country), "address");
  }
  const mrzLines = Array.isArray(data.mrzLines) ? data.mrzLines.filter((line): line is string => typeof line === "string" && line.trim().length > 0) : [];
  return { mrzLines: mrzLines.length > 0 ? mrzLines : null, fields, confidence };
}

/** Campos que aporta una MRZ válida (confianza 1,0). */
const MRZ_FIELD_KEYS = ["documentType", "mrzFormat", "issuingCountry", "nationality", "sex", "dateOfBirth", "documentExpiryDate", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2"] as const satisfies readonly IdentityFieldKey[];
/** Campos que el parte necesita y que, sin MRZ ni visión, quedan todos en revisión. */
const REVIEW_WHEN_MANUAL = ["documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "sex", "nationality", "dateOfBirth", "documentExpiryDate", "residenceFullAddress", "residenceLocality", "residenceCountry"] as const satisfies readonly IdentityFieldKey[];
/** Con visión pero sin MRZ válida, estos campos van a revisión si no se leyeron con confianza. */
const CORE_KEYS = ["documentType", "documentNumber", "firstName", "surname1", "sex", "nationality", "dateOfBirth", "documentExpiryDate"] as const satisfies readonly IdentityFieldKey[];
const VISION_KEYS = ["documentType", "issuingCountry", "nationality", "sex", "dateOfBirth", "documentExpiryDate", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "residenceFullAddress", "residenceLocality", "residenceCountry"] as const satisfies readonly IdentityFieldKey[];

function mrzFieldValue(mrz: MrzParseResult, key: (typeof MRZ_FIELD_KEYS)[number]): string | undefined {
  const f = mrz.fields;
  if (!f) return undefined;
  switch (key) {
    case "documentType":
      return f.documentType;
    case "mrzFormat":
      return mrz.format === "TD1" || mrz.format === "TD3" ? mrz.format : undefined;
    case "issuingCountry":
      return text(f.issuingCountry);
    case "nationality":
      return text(f.nationality);
    case "sex":
      return f.sex;
    case "dateOfBirth":
      return isoDay(f.dateOfBirth);
    case "documentExpiryDate":
      return isoDay(f.expiryDate);
    case "documentNumber":
      return text(f.documentNumber);
    case "documentSupportNumber":
      return text(f.documentSupportNumber);
    case "firstName":
      return text(f.firstName);
    case "surname1":
      return text(f.surname1);
    case "surname2":
      return text(f.surname2);
  }
}

/** Escritura por clave sobre IdentityFields (mrzFormat es una unión literal; los valores vienen validados). */
function assign(fields: IdentityFields, key: IdentityFieldKey, value: string): void {
  (fields as Record<string, string>)[key] = value;
}

function checksOf(mrz: MrzParseResult | null): MrzChecks {
  if (!mrz || !mrz.format) return { document: null, birth: null, expiry: null, composite: null };
  return { document: mrz.checks.document, birth: mrz.checks.birth, expiry: mrz.checks.expiry, composite: mrz.checks.composite };
}

/**
 * Fusión pura: la MRZ válida manda (confianza 1,0); la visión aporta lo que la
 * MRZ no trae si su confianza ≥ `threshold`, y si no el campo va a `needsReview`
 * (se conserva su confianza, nunca su valor). Sin MRZ válida ni visión → `manual`
 * con todos los campos del parte en revisión.
 */
export function mergeIdentityFields(
  mrz: MrzParseResult | null,
  vision: VisionExtraction | null,
  threshold: number = VISION_CONFIDENCE_THRESHOLD,
  options: { mrzSource?: "mrz_reader" | "mrz_ai" } = {}
): MergedIdentity {
  const fields: IdentityFields = {};
  const confidence: Partial<Record<IdentityFieldKey, number>> = {};
  const needsReview = new Set<IdentityReviewKey>();
  const warnings: string[] = [];
  const mrzValid = Boolean(mrz?.valid && mrz.fields);

  if (mrz && mrzValid) {
    for (const key of MRZ_FIELD_KEYS) {
      const value = mrzFieldValue(mrz, key);
      if (value === undefined) continue;
      assign(fields, key, value);
      confidence[key] = 1;
    }
    if (mrz.format === "TD2") warnings.push("MRZ en formato TD2 (documento de identidad no español): formato no registrado en la captura");
  } else if (mrz && mrz.format) {
    warnings.push(`MRZ con dígitos de control incorrectos (${mrz.errors.join("; ") || "sin detalle"}): los datos de la banda no se han utilizado`);
    needsReview.add("mrz");
  }

  if (vision) {
    for (const key of VISION_KEYS) {
      if (fields[key] !== undefined) continue; // la MRZ manda
      const value = vision.fields[key];
      if (value === undefined || value === "") continue;
      const c = vision.confidence[key] ?? 0;
      if (c >= threshold) {
        assign(fields, key, value);
        confidence[key] = c;
      } else {
        confidence[key] = c;
        needsReview.add(key);
      }
    }
  }

  if (!mrzValid && !vision) {
    for (const key of REVIEW_WHEN_MANUAL) needsReview.add(key);
  } else if (!mrzValid) {
    for (const key of CORE_KEYS) if (fields[key] === undefined) needsReview.add(key);
  }
  if ((fields.documentType === "DNI" || fields.documentType === "TIE") && fields.documentSupportNumber === undefined) {
    needsReview.add("documentSupportNumber");
  }

  const source: DocumentCaptureSource = mrzValid ? (options.mrzSource ?? "mrz_ai") : vision ? "ai_vision" : "manual";
  const mrzFormat = mrzValid && (mrz!.format === "TD1" || mrz!.format === "TD3") ? mrz!.format : null;
  return { fields, confidence, checks: checksOf(mrz), source, mrzFormat, needsReview: [...needsReview], warnings };
}

// ---------------------------------------------------------------------------
// Comparación de nombres (sin acentos, mayúsculas, solo letras)
// ---------------------------------------------------------------------------

function normalizeName(value: string | null | undefined): string[] {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * true cuando el nombre capturado coincide con alguno de los viajeros: primer
 * nombre igual y los apellidos del viajero encabezan los apellidos capturados
 * (la MRZ trae ambos apellidos aunque la reserva solo registre el primero).
 */
export function identityNameMatches(captured: { firstName?: string; surname1?: string; surname2?: string }, candidates: ReservationGuestName[]): boolean {
  const givenTokens = normalizeName(captured.firstName);
  const surnameTokens = [...normalizeName(captured.surname1), ...normalizeName(captured.surname2)];
  if (givenTokens.length === 0 || surnameTokens.length === 0) return true; // sin nombre no hay discrepancia que declarar
  const comparable = candidates
    .map((candidate) => ({ given: normalizeName(candidate.firstName), surnames: [...normalizeName(candidate.surname1), ...normalizeName(candidate.surname2)] }))
    .filter((candidate) => candidate.given.length > 0 && candidate.surnames.length > 0);
  if (comparable.length === 0) return true; // la reserva no tiene ningún nombre con el que comparar
  return comparable.some((candidate) => {
    if (candidate.given[0] !== givenTokens[0]) return false;
    const prefix = candidate.surnames.slice(0, Math.min(candidate.surnames.length, surnameTokens.length));
    return prefix.every((token, index) => surnameTokens[index] === token);
  });
}

// ---------------------------------------------------------------------------
// Persistencia (sin PII en document_captures) y purga
// ---------------------------------------------------------------------------

/** Solo las claves DOCUMENT_CAPTURE_NON_PII_FIELDS de @hotelos/shared pueden ir a fields_json. */
export function nonPiiFields(fields: IdentityFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DOCUMENT_CAPTURE_NON_PII_FIELDS) {
    const value = fields[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** updateMany que vacía fieldsJson/confidenceJson de las capturas con purgeAt vencido (idempotente). */
export function purgeUpdateArgs(now: Date): PurgeUpdateArgs {
  return {
    where: { purgeAt: { lte: now }, OR: [{ NOT: { fieldsJson: { equals: {} } } }, { NOT: { confidenceJson: { equals: {} } } }] },
    data: { fieldsJson: {}, confidenceJson: {} }
  };
}

/** Purga (§7.3): tras purgeAt quedan checks, fuente, telemetría y needsReview (métrica), nunca campos ni confianzas. */
export async function purgeExpiredCaptures(now: Date = currentDeps().now()): Promise<{ purged: number }> {
  const result = await currentDeps().purgeCaptures(purgeUpdateArgs(now));
  return { purged: result.count };
}

function toDate(day: string | undefined): Date | null {
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
}

/** Columnas de CheckInGuest a partir de los campos fusionados (solo los que no están en revisión). */
function checkInGuestPatch(merged: MergedIdentity, currentStatus: string): Prisma.CheckInGuestUncheckedUpdateInput {
  const review = new Set<IdentityReviewKey>(merged.needsReview);
  const ok = <K extends IdentityFieldKey>(key: K): IdentityFields[K] | undefined => (review.has(key) ? undefined : merged.fields[key]);
  const data: Prisma.CheckInGuestUncheckedUpdateInput = {};
  const firstName = ok("firstName");
  const surname1 = ok("surname1");
  const surname2 = ok("surname2");
  const sex = ok("sex");
  const nationality = ok("nationality");
  const dateOfBirth = ok("dateOfBirth");
  const documentType = ok("documentType");
  const documentExpiryDate = ok("documentExpiryDate");
  const documentNumber = ok("documentNumber");
  const documentSupportNumber = ok("documentSupportNumber");
  const residenceFullAddress = ok("residenceFullAddress");
  const residenceLocality = ok("residenceLocality");
  const residenceCountry = ok("residenceCountry");
  if (firstName !== undefined) data.firstName = firstName;
  if (surname1 !== undefined) data.surname1 = surname1;
  if (surname2 !== undefined) data.surname2 = surname2;
  if (sex !== undefined) data.sex = sex;
  if (nationality !== undefined) data.nationality = nationality;
  if (dateOfBirth !== undefined) data.dateOfBirth = toDate(dateOfBirth);
  if (documentType !== undefined) data.documentType = documentType;
  if (documentExpiryDate !== undefined) data.documentExpiryDate = toDate(documentExpiryDate);
  if (documentNumber !== undefined) data.documentNumber = documentNumber;
  if (documentSupportNumber !== undefined) data.documentSupportNumber = documentSupportNumber;
  if (residenceFullAddress !== undefined) data.residenceFullAddress = residenceFullAddress;
  if (residenceLocality !== undefined) data.residenceLocality = residenceLocality;
  if (residenceCountry !== undefined) data.residenceCountry = residenceCountry;
  // Dígitos de control válidos = método mrz_checksum (no equivale a verificar a la persona: identityVerifiedAt sigue en null).
  if (merged.source === "mrz_ai" || merged.source === "mrz_reader") data.identityVerificationMethod = "mrz_checksum";
  // Nunca se retrocede un viajero ya completo, firmado o verificado.
  if (currentStatus === "pending" || currentStatus === "document_captured") data.status = "document_captured";
  return data;
}

// ---------------------------------------------------------------------------
// Visión por el tool runner
// ---------------------------------------------------------------------------

type VisionRun = { vision: VisionExtraction | null; usage: VisionUsage | null; warnings: string[] };

function isBudgetDenial(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "AI_BUDGET_EXCEEDED";
}

async function runVision(deps: IdentityCaptureDeps, context: UserContext, image: { mediaType: string; base64: string; bytes: number }, correlationId: string): Promise<VisionRun> {
  let usage: VisionUsage | null = null;
  let result: ToolRunResult<VisionExtraction | NotConfiguredOutput>;
  try {
    result = await deps.runAiTool<{ hasImage: true; mediaType: string; bytes: number }, VisionExtraction | NotConfiguredOutput>({
      context,
      toolName: IDENTITY_TOOL_NAME,
      recordAs: IDENTITY_RECORD_AS,
      // inputJson de la fila: solo la existencia, el tipo y el tamaño de la imagen (§7.3), nunca el data: URL.
      input: { hasImage: true, mediaType: image.mediaType, bytes: image.bytes },
      correlationId,
      source: "image",
      execute: async (_value, ctx) => {
        const aiCtx = aiContextFor(apiToolContextFromRunner(ctx, context), IDENTITY_TOOL_NAME, "extract");
        const extracted = await deps.extractJson({ pages: [{ mediaType: image.mediaType, base64: image.base64 }], schema: CHK_IDENTITY_SCHEMA, instruction: CHK_IDENTITY_INSTRUCTION, maxTokens: 900 }, aiCtx);
        if (!extracted.configured) {
          return { configured: false, reason: extracted.reason, message: extracted.message ?? labelFor(extracted.reason as AiErrorCode), ...(extracted.telemetry ? { telemetry: extracted.telemetry } : {}) };
        }
        const vision = normalizeVisionOutput(extracted.data);
        usage = { model: extracted.model, tokensInput: extracted.tokensInput, tokensOutput: extracted.tokensOutput, costEur: extracted.costEur ?? null };
        const telemetry: AiTelemetry = {
          model: extracted.model,
          tokensInput: extracted.tokensInput,
          tokensOutput: extracted.tokensOutput,
          cacheReadTokens: extracted.cacheReadTokens ?? 0,
          costUsd: extracted.costUsd ?? null,
          costEur: extracted.costEur ?? null,
          latencyMs: extracted.latencyMs ?? 0
        };
        // outputJson de la fila: claves leídas y confianzas; nunca valores del documento ni la imagen.
        const record = {
          fieldsRead: Object.keys(vision.fields),
          confidence: { ...vision.confidence },
          mrzLines: vision.mrzLines?.length ?? 0,
          ...(extracted.document ? { document: { pages: extracted.document.pages, bytes: extracted.document.bytes, sha256: extracted.document.sha256 } } : {})
        };
        return { output: vision, telemetry, record };
      }
    });
  } catch (error) {
    // Presupuesto agotado (403) y límite de peticiones (429) son denegaciones del runner: se sigue por reglas.
    if (isBudgetDenial(error) || error instanceof TooManyRequestsError) return { vision: null, usage: null, warnings: [`visión no disponible: ${error.message}`] };
    throw error;
  }
  if (result.status === "executed") {
    if (result.configured) return { vision: result.output as VisionExtraction, usage, warnings: [] };
    const reason = (result.output as NotConfiguredOutput | undefined)?.reason ?? "not_configured";
    return { vision: null, usage: null, warnings: [`visión no disponible: ${labelFor(reason as AiErrorCode)}`] };
  }
  if (result.status === "awaiting_confirmation") return { vision: null, usage: null, warnings: ["visión pendiente de aprobación humana; datos por MRZ o entrada manual"] };
  return { vision: null, usage: null, warnings: [`visión denegada: ${result.message}`] };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

function unreadable(message: string): BadRequestError {
  const error = new BadRequestError(message);
  (error as { details?: unknown }).details = { code: "DOCUMENT_UNREADABLE" };
  return error;
}

function scopedTo(context: UserContext, organizationId: string): boolean {
  return context.isPlatformAdmin === true || organizationId === context.organizationId;
}

/**
 * Captura de un documento de identidad (portal, kiosco o drawer). Devuelve los
 * campos fusionados con su origen y confianza; persiste DocumentCapture (sin PII
 * ni imagen) y actualiza el CheckInGuest cuando se indica.
 */
export async function captureDocument(input: CaptureDocumentInput): Promise<IdentityCaptureResult> {
  const deps = currentDeps();
  requirePermissions(input.context, ["guest_register.create"]);
  const startedAt = Date.now();
  const now = deps.now();
  const correlationId = input.correlationId ?? deps.createId("corr");
  const propertyId = input.propertyId.trim();
  if (!propertyId) throw new BadRequestError("propertyId obligatorio.");

  const property = await deps.loadProperty(propertyId);
  if (!property || !scopedTo(input.context, property.organizationId)) throw new NotFoundError("Propiedad no encontrada.");
  const limits = deps.limits();

  // (i) imagen: data: URL válida, image/*, tamaño acotado. Vive solo en esta petición.
  let image: { mediaType: string; base64: string; bytes: number } | null = null;
  if (input.imageDataUrl !== undefined) {
    const parsed = parseDataUrl(input.imageDataUrl);
    if (!parsed) throw unreadable("La imagen debe ser una URL de datos base64 (data:image/<tipo>;base64,…).");
    const mediaType = parsed.mediaType.trim().toLowerCase();
    if (!mediaType.startsWith("image/")) throw unreadable(`Tipo de imagen no admitido: ${mediaType}. Se espera image/jpeg, image/png o image/webp.`);
    const bytes = base64ByteLength(parsed.base64);
    const max = limits.documentMaxBytes;
    if (bytes > max) throw new HttpError(413, `La imagen supera el tamaño máximo (${bytes} > ${max} bytes).`, true, { code: "DOCUMENT_UNREADABLE", maxBytes: max });
    if (bytes === 0) throw unreadable("La imagen está vacía.");
    image = { mediaType, base64: parsed.base64, bytes };
  }
  const hintLines = input.hints?.mrzLines;
  const readerLines = typeof hintLines === "string" ? (hintLines.trim() ? hintLines : null) : hintLines && hintLines.length > 0 ? hintLines : null;
  if (!image && !readerLines) throw unreadable("Se necesita la imagen del documento o las líneas de la MRZ.");

  // CheckInGuest (opcional) con su sesión: 404 opaco fuera de la organización o de la propiedad.
  let guest: CheckInGuestRow | null = null;
  if (input.checkInGuestId) {
    guest = await deps.loadCheckInGuest(input.checkInGuestId);
    if (!guest || !scopedTo(input.context, guest.session.organizationId) || guest.session.propertyId !== propertyId) throw new NotFoundError("Viajero del check-in no encontrado.");
  }

  // (ii) visión por el runner solo con clave utilizable (sin clave: reglas, sin fila skipped).
  const runnerContext: UserContext = { ...input.context, propertyId };
  const warnings: string[] = [];
  let vision: VisionExtraction | null = null;
  let usage: VisionUsage | null = null;
  if (image) {
    if (deps.isLlmConfigured()) {
      const run = await runVision(deps, runnerContext, image, correlationId);
      vision = run.vision;
      usage = run.usage;
      warnings.push(...run.warnings);
    } else {
      warnings.push("sin proveedor de IA: lectura por MRZ (lector o manual) y reglas");
    }
  }

  // (iii) MRZ determinista: líneas del lector/manual (mrz_reader) o transcritas por la visión (mrz_ai).
  const mrzLines = readerLines ?? vision?.mrzLines ?? null;
  const mrz = mrzLines ? parseMrz(mrzLines, { today: now }) : null;
  const merged = mergeIdentityFields(mrz, vision, VISION_CONFIDENCE_THRESHOLD, { mrzSource: readerLines ? "mrz_reader" : "mrz_ai" });
  warnings.push(...merged.warnings);
  const needsReview = new Set<IdentityReviewKey>(merged.needsReview);
  if (input.hints?.documentType && merged.fields.documentType === undefined) {
    const hinted = input.hints.documentType.trim().toUpperCase();
    if (DOCUMENT_TYPES.has(hinted)) {
      merged.fields.documentType = hinted;
      merged.confidence.documentType = 0;
      needsReview.add("documentType");
    }
  }

  // (vi) caducidad (aviso, no bloquea) y discrepancia con los viajeros de la reserva (aviso + revisión, no 409).
  const today = now.toISOString().slice(0, 10);
  if (merged.fields.documentExpiryDate && merged.fields.documentExpiryDate < today) warnings.push(EXPIRED_DOCUMENT_WARNING);
  if (guest && merged.fields.firstName && merged.fields.surname1) {
    const candidates: ReservationGuestName[] = await deps.loadReservationGuestNames(guest.session.reservationId);
    if (guest.firstName && guest.surname1) candidates.push({ firstName: guest.firstName, surname1: guest.surname1, surname2: guest.surname2 });
    if (!identityNameMatches(merged.fields, candidates)) {
      warnings.push(IDENTITY_MISMATCH_WARNING);
      needsReview.add("identity_mismatch");
    }
  }
  merged.needsReview = [...needsReview];
  merged.warnings = warnings;

  // (iv) persistencia: document_captures sin PII ni imagen; CheckInGuest con la PII cifrada por la extensión.
  const processingMs = Date.now() - startedAt;
  const purgeAt = new Date(now.getTime() + limits.capturePurgeDays * 86_400_000);
  let captureId = deps.createId("dcap");
  let persisted = false;
  if (guest) {
    const created = await deps.createDocumentCapture({
      id: captureId,
      checkInGuestId: guest.id,
      propertyId,
      source: merged.source,
      mrzFormat: merged.mrzFormat,
      checksJson: merged.checks as unknown as Prisma.InputJsonValue,
      fieldsJson: nonPiiFields(merged.fields),
      confidenceJson: { ...merged.confidence } as Prisma.InputJsonValue,
      needsReviewJson: [...merged.needsReview],
      model: usage?.model ?? null,
      tokensInput: usage?.tokensInput ?? null,
      tokensOutput: usage?.tokensOutput ?? null,
      costEur: usage?.costEur ?? null,
      imageStored: false,
      imageDiscardedAt: now,
      processingMs,
      purgeAt
    });
    captureId = created.id;
    persisted = true;
    // Discrepancia con la reserva (§4d «No se vincula»): la captura queda registrada (métrica y revisión)
    // pero los datos del documento NO se escriben en el viajero hasta que recepción resuelva la revisión.
    if (!needsReview.has("identity_mismatch")) await deps.updateCheckInGuest(guest.id, checkInGuestPatch(merged, guest.status));
  }

  // (v) evento de descarte + auditoría ID_IMAGE_DISCARDED (solo cuando hubo imagen que descartar).
  if (image) {
    await deps.recordIdentityDiscardEvent({
      context: input.context,
      propertyId,
      ...(guest ? { reservationId: guest.session.reservationId } : {}),
      ...(guest?.guestId ? { guestId: guest.guestId } : {}),
      fieldsExtractedJson: { fieldsRead: Object.keys(merged.fields), source: merged.source, mrzFormat: merged.mrzFormat, needsReview: [...merged.needsReview], captureId },
      confidenceJson: { ...merged.confidence },
      correlationId
    });
    deps.recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "ID_IMAGE_DISCARDED",
      entityType: "guest_identity_scan",
      entityId: captureId,
      afterJson: { imageStored: false, imageDiscarded: true, extractedFields: Object.keys(merged.fields), source: merged.source, mediaType: image.mediaType, bytes: image.bytes, checkInGuestId: guest?.id ?? null },
      deviceId: input.context.deviceId,
      correlationId
    });
  }

  return { ...merged, captureId, persisted, vision: usage, processingMs };
}
