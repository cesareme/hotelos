// Check-in automatizado (Tanda CHK · lote W2-A) — configuración del módulo.
//
// Única puerta de lectura de las 9 variables CHECKIN_* / KIOSK_* del contrato
// (env.partial.ts, spread en lib/env.ts). Ningún otro fichero del módulo lee
// `process.env` directamente: los servicios reciben `CheckInConfig` (o llaman a
// readCheckInConfig() con el entorno por defecto) para que los tests puedan
// inyectar valores sin tocar el entorno del proceso.
//
// Valores por defecto = `default` del contrato (docs/design/CHECKIN-AUTOMATIZADO-IA.md
// §7.3 y §9). Un valor ilegible (no numérico, fuera de rango, hora inválida)
// cae al defecto: validateEnv (lib/env.ts) ya lo ha señalado al arrancar y aquí
// no se vuelve a lanzar.

export type CheckInConfig = {
  /** true desactiva el job de invitaciones (solo actúa en el líder RUN_SCHEDULERS). */
  invitationDisabled: boolean;
  /** Periodo del job de invitaciones/recordatorios (ms). */
  invitationIntervalMs: number;
  /** Hora local (Europe/Madrid, HH:MM) del lote diario de asignación de habitaciones. */
  assignmentRunAt: string;
  /** Vida del OTP de verificación (ms). */
  otpTtlMs: number;
  /** Intentos de OTP antes de 429. */
  otpMaxAttempts: number;
  /** Vida del código de emparejamiento de un kiosco (ms). */
  kioskPairingTtlMs: number;
  /** Bytes máximos de la imagen de un documento (decodificada). */
  documentMaxBytes: number;
  /** Bytes máximos del PNG/SVG de una firma (decodificada). */
  signatureMaxBytes: number;
  /** Días tras los que se vacían fieldsJson/confidenceJson de document_captures. */
  capturePurgeDays: number;
};

export const CHECKIN_CONFIG_DEFAULTS: Readonly<CheckInConfig> = Object.freeze({
  invitationDisabled: false,
  invitationIntervalMs: 3_600_000,
  assignmentRunAt: "18:00",
  otpTtlMs: 600_000,
  otpMaxAttempts: 5,
  kioskPairingTtlMs: 600_000,
  documentMaxBytes: 6_291_456,
  signatureMaxBytes: 524_288,
  capturePurgeDays: 30
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function intOr(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

/** Lee la configuración del módulo del entorno dado (por defecto process.env). */
export function readCheckInConfig(env: NodeJS.ProcessEnv = process.env): CheckInConfig {
  const runAt = env.CHECKIN_ASSIGNMENT_RUN_AT?.trim();
  return {
    invitationDisabled: boolOr(env.CHECKIN_INVITATION_DISABLED, CHECKIN_CONFIG_DEFAULTS.invitationDisabled),
    invitationIntervalMs: intOr(env.CHECKIN_INVITATION_INTERVAL_MS, CHECKIN_CONFIG_DEFAULTS.invitationIntervalMs, 60_000, 86_400_000),
    assignmentRunAt: runAt && HHMM.test(runAt) ? runAt : CHECKIN_CONFIG_DEFAULTS.assignmentRunAt,
    otpTtlMs: intOr(env.CHECKIN_OTP_TTL_MS, CHECKIN_CONFIG_DEFAULTS.otpTtlMs, 60_000, 3_600_000),
    otpMaxAttempts: intOr(env.CHECKIN_OTP_MAX_ATTEMPTS, CHECKIN_CONFIG_DEFAULTS.otpMaxAttempts, 1, 20),
    kioskPairingTtlMs: intOr(env.KIOSK_PAIRING_TTL_MS, CHECKIN_CONFIG_DEFAULTS.kioskPairingTtlMs, 60_000, 3_600_000),
    documentMaxBytes: intOr(env.CHECKIN_DOCUMENT_MAX_BYTES, CHECKIN_CONFIG_DEFAULTS.documentMaxBytes, 65_536, 16_777_216),
    signatureMaxBytes: intOr(env.CHECKIN_SIGNATURE_MAX_BYTES, CHECKIN_CONFIG_DEFAULTS.signatureMaxBytes, 16_384, 4_194_304),
    capturePurgeDays: intOr(env.CHECKIN_CAPTURE_PURGE_DAYS, CHECKIN_CONFIG_DEFAULTS.capturePurgeDays, 1, 365)
  };
}
