// Esquemas zod del módulo de check-in automatizado (Tanda CHK · lote W2-A).
// Todo cuerpo y consulta de checkin.routes.ts pasa por parseOr400 con uno de
// estos esquemas `.strict()` → 400 VALIDATION_ERROR (rate-grid.schemas.ts).
// Vocabularios: packages/shared/src/checkin-types.ts (una sola fuente).

import { z } from "zod";
import {
  AUTO_ASSIGN_LEVELS,
  CHECKIN_CHANNELS,
  DEPOSIT_POLICIES,
  IDENTITY_VERIFICATION_METHODS
} from "@hotelos/shared";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY = /^[A-Za-z]{2,3}$/;
const PHONE = /^\+?[0-9][0-9 .-]{5,24}$/;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const isoDay = z.string().trim().regex(ISO_DAY, "fecha YYYY-MM-DD");

/** Canales por los que se puede invitar (kiosk/reception/manual no envían nada). */
export const INVITATION_CHANNELS = ["email", "whatsapp", "sms"] as const satisfies readonly (typeof CHECKIN_CHANNELS)[number][];

export const SessionCreateSchema = z
  .object({
    reservationId: text(80),
    channel: z.enum(INVITATION_CHANNELS)
  })
  .strict();
export type SessionCreateInput = z.infer<typeof SessionCreateSchema>;

export const ResendSchema = z.object({ channel: z.enum(INVITATION_CHANNELS).optional() }).strict();

export const ArrivalsQuerySchema = z.object({ date: isoDay.optional() }).strict();

/** `["quiet","floor_high"]` o `{ codes, freeText }`: los códigos fuera de PREFERENCE_VOCABULARY se descartan en el servicio. */
export const PreferencesSchema = z.union([
  z.array(z.string().trim().max(40)).max(24),
  z
    .object({
      codes: z.array(z.string().trim().max(40)).max(24).optional(),
      freeText: z.string().trim().max(500).optional()
    })
    .strict()
]);

export const ConsentSchema = z
  .object({
    gdpr: z.boolean().optional(),
    aiDisclosure: z.boolean().optional(),
    marketing: z.boolean().optional(),
    whatsappOptIn: z.boolean().optional()
  })
  .strict();
export type ConsentInput = z.infer<typeof ConsentSchema>;

export const SessionPatchSchema = z
  .object({
    /** HH:MM (o datetime-local); null borra la ETA. */
    eta: z.string().trim().max(40).nullable().optional(),
    preferences: PreferencesSchema.optional(),
    consent: ConsentSchema.optional()
  })
  .strict();
export type SessionPatchInput = z.infer<typeof SessionPatchSchema>;

/** Alta/edición de un viajero: todos los campos opcionales (el cierre valida la completitud). */
export const GuestInputSchema = z
  .object({
    firstName: optionalText(80),
    surname1: optionalText(80),
    surname2: optionalText(80),
    /** Código SES: H (hombre) · M (mujer) · O (otro); se admite F/M de perfiles antiguos. */
    sex: z.string().trim().min(1).max(10).nullable().optional(),
    nationality: z.string().trim().regex(COUNTRY, "código de país ISO/ICAO").nullable().optional(),
    dateOfBirth: isoDay.nullable().optional(),
    documentType: optionalText(20),
    documentNumber: optionalText(30),
    documentSupportNumber: optionalText(30),
    documentExpiryDate: isoDay.nullable().optional(),
    email: z.string().trim().email().max(160).nullable().optional(),
    phoneMobile: z.string().trim().regex(PHONE, "teléfono con prefijo internacional").nullable().optional(),
    residenceFullAddress: optionalText(200),
    residenceLocality: optionalText(100),
    residenceCountry: z.string().trim().regex(COUNTRY, "código de país ISO/ICAO").nullable().optional(),
    kinship: optionalText(40),
    guardianTitle: optionalText(80),
    /** Adulto de la MISMA sesión que aporta los datos de un menor de 14 años. */
    providedByCheckInGuestId: optionalText(80)
  })
  .strict();
export type GuestInput = z.infer<typeof GuestInputSchema>;

export const MrzSchema = z
  .object({
    /** Líneas de la MRZ (2 o 3) o el texto completo con saltos de línea. */
    lines: z.union([z.string().trim().min(10).max(200), z.array(z.string().trim().max(44)).min(2).max(3)])
  })
  .strict();

export const KioskClaimSchema = z
  .object({
    code: z
      .string()
      .trim()
      .max(20)
      .transform((value) => value.replace(/\D/g, ""))
      .refine((value) => value.length === 8, "código de 8 dígitos")
  })
  .strict();

const weightsSchema = z.record(z.string().max(60), z.number().finite().min(-100).max(100));

export const PolicyPutSchema = z
  .object({
    selfCheckInEnabled: z.boolean().optional(),
    inviteDaysBefore: z.number().int().min(0).max(30).optional(),
    reminderDaysBefore: z.number().int().min(0).max(30).optional(),
    allowedVerificationMethods: z.array(z.enum(IDENTITY_VERIFICATION_METHODS)).max(IDENTITY_VERIFICATION_METHODS.length).optional(),
    requireVisualCheckAtKiosk: z.boolean().optional(),
    requireInspectedRoom: z.boolean().optional(),
    depositPolicy: z.enum(DEPOSIT_POLICIES).optional(),
    /** Importe con 2 decimales; null lo borra. */
    depositAmount: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "importe 0.00").nullable().optional(),
    /** Sin PSP: `at_reception` satisface depositPolicy para el huésped/kiosco solo si es true (corrector REV3-02). */
    allowPayAtReception: z.boolean().optional(),
    allowWalkIn: z.boolean().optional(),
    allowUpgradeSuggestion: z.boolean().optional(),
    autoAssignLevel: z.enum(AUTO_ASSIGN_LEVELS).optional(),
    assignmentWeights: weightsSchema.optional(),
    welcomeChannelOrder: z.array(z.enum(CHECKIN_CHANNELS)).max(CHECKIN_CHANNELS.length).optional(),
    guestConsentText: z.string().trim().max(4000).nullable().optional(),
    aiDisclosureText: z.string().trim().max(4000).nullable().optional(),
    /** Tanda L7 (L7-04): invitación automática a la encuesta post-estancia (paso del tick del check-in). */
    postStaySurveyEnabled: z.boolean().optional(),
    /** Horas desde las 00:00 (hora local) del día de salida; tope 72 h para que la ventana de 3 días del paso nunca quede vacía. */
    postStaySurveyDelayHours: z.number().int().min(0).max(72).optional()
  })
  .strict();
export type PolicyPutInput = z.infer<typeof PolicyPutSchema>;

const capabilitiesSchema = z
  .object({
    mrzReader: z.boolean().optional(),
    cardEncoder: z.boolean().optional(),
    paymentTerminal: z.boolean().optional(),
    printer: z.boolean().optional()
  })
  .strict();

export const KioskCreateSchema = z
  .object({
    name: text(80),
    capabilities: capabilitiesSchema.optional(),
    lockProvider: optionalText(40),
    config: z.record(z.string().max(60), z.unknown()).optional()
  })
  .strict();
export type KioskCreateInput = z.infer<typeof KioskCreateSchema>;

export const KioskPatchSchema = z
  .object({
    name: text(80).optional(),
    capabilities: capabilitiesSchema.optional(),
    lockProvider: optionalText(40),
    config: z.record(z.string().max(60), z.unknown()).optional(),
    /** disabled apaga el kiosco (su token deja de autenticar); offline lo vuelve a admitir. */
    status: z.enum(["disabled", "offline"]).optional()
  })
  .strict();
export type KioskPatchInput = z.infer<typeof KioskPatchSchema>;

// ── Lote W3-A · captura, firma, pago, OTP, llegada y check-in completo ────────

/** Líneas de la MRZ del lector/manual (2-3 líneas o texto con saltos). */
const mrzLinesSchema = z.union([z.string().trim().min(10).max(200), z.array(z.string().trim().max(44)).min(2).max(3)]);

/** Imagen `data:image/<tipo>;base64,…` (el tamaño lo acota captureDocument con CHECKIN_DOCUMENT_MAX_BYTES; la ruta lleva bodyLimit 8 MB). */
const imageDataUrlSchema = z.string().trim().min(24).max(12_000_000).regex(/^data:image\/[a-z0-9.+-]+;base64,/i, "URL de datos de imagen base64");

/** POST /guest-portal/check-in/guests/:id/document · POST /reservations/:id/check-in/scan (con checkInGuestId opcional). */
export const DocumentCaptureSchema = z
  .object({
    imageDataUrl: imageDataUrlSchema.optional(),
    documentType: z.string().trim().max(20).optional(),
    mrzLines: mrzLinesSchema.optional(),
    /** Solo recepción (scan): viajero de la sesión al que se vincula la captura. */
    checkInGuestId: text(80).optional()
  })
  .strict()
  .refine((value) => value.imageDataUrl !== undefined || value.mrzLines !== undefined, { message: "Se necesita imageDataUrl o mrzLines." });
export type DocumentCaptureInput = z.infer<typeof DocumentCaptureSchema>;

const strokeMetaSchema = z
  .object({
    points: z.number().int().min(0),
    durationMs: z.number().finite().min(0),
    bbox: z.record(z.string().max(20), z.number().finite())
  })
  .strict();

/** POST /guest-portal/check-in/guests/:id/signature (el método lo fija la ruta: touch_portal | touch_kiosk). */
export const GuestSignatureSchema = z
  .object({
    pngBase64: z.string().min(1).max(6_000_000),
    svg: z.string().min(1).max(6_000_000).optional(),
    strokeMeta: strokeMetaSchema
  })
  .strict();
export type GuestSignatureInput = z.infer<typeof GuestSignatureSchema>;

/** POST /reservations/:id/check-in/signature (recepción: touch_reception; viajero o parte). */
export const StaffSignatureSchema = GuestSignatureSchema.extend({
  checkInGuestId: text(80).optional(),
  guestRegisterRecordId: text(80).optional()
}).strict();
export type StaffSignatureInput = z.infer<typeof StaffSignatureSchema>;

/** URL de retorno del PSP: SOLO http(s) (corrector REV-L7-08: `z.url()` admitía `javascript:` / `data:`). */
const HTTP_URL_PATTERN = /^https?:\/\//i;

/** POST /guest-portal/check-in/payment-link */
export const PaymentLinkSchema = z
  .object({
    returnUrl: z.string().trim().url().regex(HTTP_URL_PATTERN, "URL http(s)").max(500).optional(),
    clientRequestId: z.string().trim().min(1).max(120).optional()
  })
  .strict();
export type PaymentLinkInput = z.infer<typeof PaymentLinkSchema>;

export const OTP_CHANNELS = ["email", "phone"] as const;
/** POST /guest-portal/check-in/otp/request */
export const OtpRequestSchema = z.object({ channel: z.enum(OTP_CHANNELS) }).strict();
/** POST /guest-portal/check-in/otp/verify */
export const OtpVerifySchema = z
  .object({
    code: z
      .string()
      .trim()
      .max(20)
      .transform((value) => value.replace(/\D/g, ""))
      .refine((value) => value.length === 6, "código de 6 dígitos")
  })
  .strict();

const verificationSchema = z
  .object({
    method: z.enum(IDENTITY_VERIFICATION_METHODS).optional()
  })
  .strict();

/** POST /guest-portal/check-in/arrive */
export const ArriveSchema = z.object({ verification: verificationSchema.optional() }).strict();
export type ArriveInput = z.infer<typeof ArriveSchema>;

/** POST /reservations/:id/check-in/verify-identity */
export const VerifyIdentitySchema = z
  .object({
    checkInGuestId: text(80),
    method: z.enum(IDENTITY_VERIFICATION_METHODS).default("visual_reception")
  })
  .strict();
export type VerifyIdentityInput = z.infer<typeof VerifyIdentitySchema>;

/** POST /reservations/:id/check-in/complete (misma forma que CheckInSchema de server.ts: fuera de ventana exige motivo). */
export const CompleteCheckInSchema = z
  .object({
    roomId: text(80).optional(),
    allowEarlyCheckIn: z.boolean().optional(),
    overrideReason: z.string().trim().min(3).max(500).optional(),
    verification: verificationSchema.optional(),
    /** Corrector REV3-03: solo comprueba las precondiciones (sesión, ventana, identidad, firmas) sin asignar, cobrar ni alojar. */
    dryRun: z.boolean().optional()
  })
  .strict()
  .refine((value) => !value.allowEarlyCheckIn || Boolean(value.overrideReason), { message: "allowEarlyCheckIn exige overrideReason.", path: ["overrideReason"] });
export type CompleteCheckInBody = z.infer<typeof CompleteCheckInSchema>;

/** POST /reservations/:id/check-in/resolve-handoff (corrector REV3-04): recepción resuelve la derivación y reabre la sesión. */
export const ResolveHandoffSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
export type ResolveHandoffInput = z.infer<typeof ResolveHandoffSchema>;

/** POST /guest-portal/check-in/handoff (corrector L7-REV-05): «Firmar en recepción» desde el kiosco o el móvil. */
export const GUEST_HANDOFF_REQUEST_KINDS = ["signature"] as const;
export const GuestHandoffSchema = z.object({ kind: z.enum(GUEST_HANDOFF_REQUEST_KINDS) }).strict();
export type GuestHandoffInput = z.infer<typeof GuestHandoffSchema>;
