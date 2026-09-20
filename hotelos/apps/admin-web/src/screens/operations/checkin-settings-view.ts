// Check-in automatizado · ajustes (Tanda CHK · W4-B, diseño §8 fila «Ajustes»
// y §1.8 métricas). Lógica pura de CheckInAutomationSettingsScreen.tsx:
// normalización del formulario de `PropertyCheckInPolicy` (getPolicy /
// putPolicy), validación (pesos del motor dentro de rango, días 0-30, importe
// del depósito), cálculo de las métricas de §1.8 sobre las llegadas y el
// formulario de alta de kioscos. Sin React ni DOM; sin dependencia en tiempo
// de ejecución de @hotelos/shared (solo tipos: el paquete no tiene dist en el
// worktree y este módulo se ejecuta bajo node --test). Testado en
// __tests__/checkin-settings-view.test.mts.

import type { AutoAssignLevel, CheckInChannel, DepositPolicy, IdentityVerificationMethod, PropertyCheckInPolicyDto } from "@hotelos/shared";

// ---------------------------------------------------------------- vocabularios (espejo de checkin-types.ts y del motor)

export const DEPOSIT_POLICY_OPTIONS: ReadonlyArray<{ value: DepositPolicy; label: string; help: string }> = [
  { value: "none", label: "Sin pago previo", help: "Todo se cobra en recepción." },
  { value: "balance", label: "Saldo de la reserva", help: "El huésped paga el saldo pendiente del folio antes de llegar." },
  { value: "first_night", label: "Primera noche", help: "Se cobra o garantiza la primera noche." },
  { value: "fixed", label: "Importe fijo", help: "Depósito fijo por reserva (importe abajo)." }
];

export const AUTO_ASSIGN_LEVEL_OPTIONS: ReadonlyArray<{ value: AutoAssignLevel; label: string; help: string }> = [
  { value: "suggest", label: "Solo sugerir", help: "El motor propone; recepción asigna a mano." },
  { value: "suggest_and_confirm", label: "Sugerir y confirmar", help: "Recepción confirma la propuesta en un clic (recomendado)." },
  { value: "preassign", label: "Preasignar", help: "El lote de la tarde asigna sin esperar confirmación." }
];

export const VERIFICATION_METHOD_OPTIONS: ReadonlyArray<{ value: IdentityVerificationMethod; label: string }> = [
  { value: "visual_reception", label: "Cotejo visual en recepción" },
  { value: "mrz_checksum", label: "Dígitos de control de la MRZ" },
  { value: "otp_email", label: "Código por correo" },
  { value: "otp_phone", label: "Código por SMS" },
  { value: "payment_match", label: "Coincidencia con el medio de pago" },
  { value: "midni_qr", label: "QR de MiDNI" },
  { value: "reader_hardware", label: "Lector de documentos" }
];

export const WELCOME_CHANNEL_OPTIONS: ReadonlyArray<{ value: CheckInChannel; label: string }> = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Correo" },
  { value: "sms", label: "SMS" }
];

/**
 * Reglas del motor de asignación (room-assignment.engine.ts, rulesVersion
 * chk-rules-1) con su peso por defecto. `kind: "bonus"` suma (0..100) y
 * `kind: "penalty"` resta (−100..0): el formulario valida cada peso dentro
 * del rango de su regla, así el operador no puede convertir una penalización
 * en bonificación por error. La API admite −100..100 en todas.
 */
export type AssignmentWeightRule = { key: string; label: string; help: string; kind: "bonus" | "penalty"; defaultValue: number };

export const ASSIGNMENT_WEIGHT_RULES: readonly AssignmentWeightRule[] = [
  { key: "hk_inspected", label: "Inspeccionada", help: "Habitación limpia e inspeccionada por pisos.", kind: "bonus", defaultValue: 30 },
  { key: "hk_clean", label: "Limpia", help: "Limpia sin inspección.", kind: "bonus", defaultValue: 20 },
  { key: "preference", label: "Preferencia cumplida", help: "Por cada preferencia declarada que cumple la habitación.", kind: "bonus", defaultValue: 15 },
  { key: "preference_cap", label: "Tope de preferencias", help: "Máximo acumulado por preferencias.", kind: "bonus", defaultValue: 45 },
  { key: "vip", label: "VIP", help: "Mejor vista o planta disponible para un cliente VIP.", kind: "bonus", defaultValue: 25 },
  { key: "returning", label: "Recurrente", help: "La habitación de su última estancia.", kind: "bonus", defaultValue: 20 },
  { key: "group", label: "Grupo", help: "Junto al resto del grupo (misma planta).", kind: "bonus", defaultValue: 15 },
  { key: "rotation", label: "Rotación", help: "Reparte el uso entre habitaciones.", kind: "bonus", defaultValue: 5 },
  { key: "special_request", label: "Petición especial", help: "Texto libre de la reserva que la habitación satisface.", kind: "bonus", defaultValue: 0 },
  { key: "inventory_protection", label: "Protección de inventario", help: "Penaliza gastar un tipo con poca disponibilidad.", kind: "penalty", defaultValue: -20 },
  { key: "free_upgrade", label: "Mejora sin coste", help: "Penaliza dar un tipo superior gratis.", kind: "penalty", defaultValue: -10 }
];

export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 100;
export const DAYS_MIN = 0;
export const DAYS_MAX = 30;

// ---------------------------------------------------------------- formulario de la política

/** Formulario controlado: los números que se editan en un input viajan como texto (controles Cocoa, string-controlled). */
export type PolicyForm = {
  selfCheckInEnabled: boolean;
  inviteDaysBefore: number;
  reminderDaysBefore: number;
  allowedVerificationMethods: IdentityVerificationMethod[];
  requireVisualCheckAtKiosk: boolean;
  requireInspectedRoom: boolean;
  depositPolicy: DepositPolicy;
  /** «120.00»; vacío = sin importe. */
  depositAmount: string;
  allowWalkIn: boolean;
  allowUpgradeSuggestion: boolean;
  autoAssignLevel: AutoAssignLevel;
  /** Peso por regla como texto; vacío = peso por defecto del motor (no se envía). */
  weights: Record<string, string>;
  welcomeChannelOrder: CheckInChannel[];
  guestConsentText: string;
  aiDisclosureText: string;
};

/** Valores por defecto del modelo (POLICY_DEFAULTS de checkin-policy.service.ts). */
export const POLICY_FORM_DEFAULTS: Readonly<PolicyForm> = Object.freeze({
  selfCheckInEnabled: false,
  inviteDaysBefore: 3,
  reminderDaysBefore: 1,
  allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"] as IdentityVerificationMethod[],
  requireVisualCheckAtKiosk: true,
  requireInspectedRoom: false,
  depositPolicy: "balance" as DepositPolicy,
  depositAmount: "",
  allowWalkIn: false,
  allowUpgradeSuggestion: true,
  autoAssignLevel: "suggest_and_confirm" as AutoAssignLevel,
  weights: {},
  welcomeChannelOrder: ["whatsapp", "email", "sms"] as CheckInChannel[],
  guestConsentText: "",
  aiDisclosureText: ""
});

function clampInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** DTO del API (o null antes de cargar) → formulario; los pesos ausentes quedan vacíos (= por defecto). */
export function toPolicyForm(dto: PropertyCheckInPolicyDto | null | undefined): PolicyForm {
  if (!dto) return { ...POLICY_FORM_DEFAULTS, allowedVerificationMethods: [...POLICY_FORM_DEFAULTS.allowedVerificationMethods], welcomeChannelOrder: [...POLICY_FORM_DEFAULTS.welcomeChannelOrder], weights: {} };
  const weights: Record<string, string> = {};
  for (const [key, value] of Object.entries(dto.assignmentWeights ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) weights[key] = String(value);
  }
  return {
    selfCheckInEnabled: Boolean(dto.selfCheckInEnabled),
    inviteDaysBefore: clampInt(dto.inviteDaysBefore, POLICY_FORM_DEFAULTS.inviteDaysBefore),
    reminderDaysBefore: clampInt(dto.reminderDaysBefore, POLICY_FORM_DEFAULTS.reminderDaysBefore),
    allowedVerificationMethods: Array.isArray(dto.allowedVerificationMethods) ? [...dto.allowedVerificationMethods] : [...POLICY_FORM_DEFAULTS.allowedVerificationMethods],
    requireVisualCheckAtKiosk: Boolean(dto.requireVisualCheckAtKiosk),
    requireInspectedRoom: Boolean(dto.requireInspectedRoom),
    depositPolicy: dto.depositPolicy ?? POLICY_FORM_DEFAULTS.depositPolicy,
    depositAmount: dto.depositAmount ?? "",
    allowWalkIn: Boolean(dto.allowWalkIn),
    allowUpgradeSuggestion: Boolean(dto.allowUpgradeSuggestion),
    autoAssignLevel: dto.autoAssignLevel ?? POLICY_FORM_DEFAULTS.autoAssignLevel,
    weights,
    welcomeChannelOrder: Array.isArray(dto.welcomeChannelOrder) ? [...dto.welcomeChannelOrder] : [...POLICY_FORM_DEFAULTS.welcomeChannelOrder],
    guestConsentText: dto.guestConsentText ?? "",
    aiDisclosureText: dto.aiDisclosureText ?? ""
  };
}

export type PolicyFormErrors = Partial<Record<keyof PolicyForm | `weights.${string}`, string>>;

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

/** Rango admitido de un peso según su regla (bonus 0..100, penalty −100..0). */
export function weightRange(key: string): { min: number; max: number } {
  const rule = ASSIGNMENT_WEIGHT_RULES.find((entry) => entry.key === key);
  return rule?.kind === "penalty" ? { min: -WEIGHT_MAX, max: WEIGHT_MIN } : { min: WEIGHT_MIN, max: WEIGHT_MAX };
}

/** Un peso escrito («30», «-20», «») → número entero o null si está vacío; undefined si no es un número. */
export function parseWeight(raw: string): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  if (!/^-?\d{1,3}$/.test(text)) return undefined;
  return Number(text);
}

/** Errores por campo; vacío = válido. */
export function validatePolicyForm(form: PolicyForm): PolicyFormErrors {
  const errors: PolicyFormErrors = {};
  if (!Number.isInteger(form.inviteDaysBefore) || form.inviteDaysBefore < DAYS_MIN || form.inviteDaysBefore > DAYS_MAX) errors.inviteDaysBefore = `Entre ${DAYS_MIN} y ${DAYS_MAX} días.`;
  if (!Number.isInteger(form.reminderDaysBefore) || form.reminderDaysBefore < DAYS_MIN || form.reminderDaysBefore > DAYS_MAX) errors.reminderDaysBefore = `Entre ${DAYS_MIN} y ${DAYS_MAX} días.`;
  else if (!errors.inviteDaysBefore && form.reminderDaysBefore > form.inviteDaysBefore) errors.reminderDaysBefore = "El recordatorio va después de la invitación (menos días antes de la llegada).";
  if (form.selfCheckInEnabled && form.allowedVerificationMethods.length === 0) errors.allowedVerificationMethods = "Con el self check-in activo hace falta al menos un método de verificación.";
  if (form.depositPolicy === "fixed") {
    if (!form.depositAmount.trim()) errors.depositAmount = "Indica el importe del depósito fijo.";
    else if (!AMOUNT_RE.test(form.depositAmount.trim())) errors.depositAmount = "Importe con hasta dos decimales, por ejemplo 120.00.";
  } else if (form.depositAmount.trim() && !AMOUNT_RE.test(form.depositAmount.trim())) {
    errors.depositAmount = "Importe con hasta dos decimales, por ejemplo 120.00.";
  }
  if (form.welcomeChannelOrder.length === 0) errors.welcomeChannelOrder = "Elige al menos un canal de bienvenida.";
  for (const [key, raw] of Object.entries(form.weights)) {
    const value = parseWeight(raw);
    if (value === null) continue;
    const range = weightRange(key);
    if (value === undefined || value < range.min || value > range.max) errors[`weights.${key}`] = `Entre ${range.min} y ${range.max}.`;
  }
  return errors;
}

/** Cuerpo del PUT /properties/:id/check-in/policy (PolicyPutSchema, strict): solo pesos con valor; textos vacíos → null. */
export function toPolicyPatch(form: PolicyForm): Record<string, unknown> {
  const assignmentWeights: Record<string, number> = {};
  for (const [key, raw] of Object.entries(form.weights)) {
    const value = parseWeight(raw);
    if (typeof value === "number") assignmentWeights[key] = value;
  }
  return {
    selfCheckInEnabled: form.selfCheckInEnabled,
    inviteDaysBefore: form.inviteDaysBefore,
    reminderDaysBefore: form.reminderDaysBefore,
    allowedVerificationMethods: [...form.allowedVerificationMethods],
    requireVisualCheckAtKiosk: form.requireVisualCheckAtKiosk,
    requireInspectedRoom: form.requireInspectedRoom,
    depositPolicy: form.depositPolicy,
    depositAmount: form.depositAmount.trim() ? form.depositAmount.trim() : null,
    allowWalkIn: form.allowWalkIn,
    allowUpgradeSuggestion: form.allowUpgradeSuggestion,
    autoAssignLevel: form.autoAssignLevel,
    assignmentWeights,
    welcomeChannelOrder: [...form.welcomeChannelOrder],
    guestConsentText: form.guestConsentText.trim() ? form.guestConsentText.trim() : null,
    aiDisclosureText: form.aiDisclosureText.trim() ? form.aiDisclosureText.trim() : null
  };
}

/** Alterna un valor en una lista conservando el orden de inserción (métodos, canales). */
export function toggleInList<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

// ---------------------------------------------------------------- métricas §1.8 sobre GET /properties/:id/check-in/arrivals

/** Lo que las métricas necesitan de cada llegada (`ArrivalDto` de checkin-session.service.ts). */
export type ArrivalMetricInput = {
  status: string;
  preCheckIn: { status: string } | null;
  assignedRoomId: string | null;
  /** `key.signed` (corrector REV3-13): solo un pase firmado por Apple (o con cerradura real) es una llave sin recepción; el QR de demo no. */
  key: { signed?: boolean } | unknown | null;
};

export type ArrivalMetrics = {
  arrivals: number;
  invited: number;
  preCheckInCompleted: number;
  assigned: number;
  /** Llaves móviles emitidas (firmadas o QR de demo). */
  keysIssued: number;
  /** Llaves que de verdad evitan el mostrador (pase firmado); las de demo (sin certificado) no cuentan. */
  keysSigned: number;
  /** Porcentajes 0..100 o null sin llegadas (nunca se divide por cero). */
  invitedPct: number | null;
  preCheckInPct: number | null;
  assignedPct: number | null;
  /** % de llegadas con llave SIN recepción (firmada); con el adaptador `none` es 0 por construcción (runbook §14). */
  keysPct: number | null;
};

/** Corrector CHK (REV3-09): `handed_off` (derivada a recepción) no es un pre-check-in hecho. */
const COMPLETED = new Set(["ready_for_arrival", "arrived", "checked_in"]);

function pct(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

function isSignedKey(key: unknown): boolean {
  return Boolean(key && typeof key === "object" && (key as { signed?: unknown }).signed === true);
}

/** Métricas de §1.8 que el módulo puede medir hoy: % pre-check-in completado, % invitadas, % con habitación asignada y % llaves sin recepción. */
export function computeArrivalMetrics(items: readonly ArrivalMetricInput[]): ArrivalMetrics {
  const arrivals = items.length;
  let invited = 0;
  let preCheckInCompleted = 0;
  let assigned = 0;
  let keysIssued = 0;
  let keysSigned = 0;
  for (const item of items) {
    if (item.preCheckIn) invited += 1;
    if (item.preCheckIn && COMPLETED.has(item.preCheckIn.status)) preCheckInCompleted += 1;
    if (item.assignedRoomId) assigned += 1;
    if (item.key) keysIssued += 1;
    if (isSignedKey(item.key)) keysSigned += 1;
  }
  return {
    arrivals,
    invited,
    preCheckInCompleted,
    assigned,
    keysIssued,
    keysSigned,
    invitedPct: pct(invited, arrivals),
    preCheckInPct: pct(preCheckInCompleted, arrivals),
    assignedPct: pct(assigned, arrivals),
    keysPct: pct(keysSigned, arrivals)
  };
}

/** Día ISO local desplazado N días (0 = hoy, 1 = mañana, −1 = ayer). */
export function isoDayOffset(base: Date, offsetDays: number): string {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** Los últimos N días ISO terminando hoy (orden ascendente). */
export function lastDays(base: Date, count: number): string[] {
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) days.push(isoDayOffset(base, -offset));
  return days;
}

// ---------------------------------------------------------------- kioscos

export type KioskForm = { name: string; mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean };

export const KIOSK_FORM_DEFAULTS: Readonly<KioskForm> = Object.freeze({ name: "", mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false });

export function validateKioskForm(form: KioskForm): Partial<Record<keyof KioskForm, string>> {
  const name = form.name.trim();
  if (!name) return { name: "Ponle un nombre al kiosco (por ejemplo «Tablet mostrador»)." };
  if (name.length > 80) return { name: "Máximo 80 caracteres." };
  return {};
}

/** Cuerpo del POST /properties/:id/kiosks (KioskCreateSchema, strict). */
export function toKioskCreateBody(form: KioskForm): { name: string; capabilities: { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean } } {
  return { name: form.name.trim(), capabilities: { mrzReader: form.mrzReader, cardEncoder: form.cardEncoder, paymentTerminal: form.paymentTerminal, printer: form.printer } };
}

export const KIOSK_STATUS_LABELS: Readonly<Record<string, string>> = { unpaired: "Sin emparejar", online: "En línea", offline: "Sin conexión", disabled: "Desactivado" };

export function kioskStatusLabel(status: string | null | undefined): string {
  return (status && KIOSK_STATUS_LABELS[status]) || "Desconocido";
}

/** Capacidades activas de un kiosco en una frase («lector MRZ · impresora») o «sin periféricos». */
export function kioskCapabilitiesLabel(capabilities: { mrzReader?: boolean; cardEncoder?: boolean; paymentTerminal?: boolean; printer?: boolean } | null | undefined): string {
  const parts: string[] = [];
  if (capabilities?.mrzReader) parts.push("lector MRZ");
  if (capabilities?.cardEncoder) parts.push("codificador de tarjetas");
  if (capabilities?.paymentTerminal) parts.push("TPV");
  if (capabilities?.printer) parts.push("impresora");
  return parts.length > 0 ? parts.join(" · ") : "sin periféricos";
}

// ---------------------------------------------------------------- permisos (useNavGate().grantedPermissions)

export const CHECKIN_POLICY_MANAGE_PERMISSION = "guest_self_service.manage";
export const KIOSK_CONFIGURE_PERMISSION = "kiosk.configure";

function holds(grantedPermissions: readonly string[] | null | undefined, key: string): boolean {
  return Array.isArray(grantedPermissions) && grantedPermissions.includes(key);
}

/** La sesión puede escribir la política (PUT /properties/:id/check-in/policy); sin ella el formulario es de solo lectura. */
export function canManageCheckInPolicy(grantedPermissions: readonly string[] | null | undefined, isPlatformAdmin = false): boolean {
  return isPlatformAdmin || holds(grantedPermissions, CHECKIN_POLICY_MANAGE_PERMISSION);
}

/** La sesión puede listar, dar de alta y emparejar kioscos (kiosk.configure). */
export function canConfigureKiosks(grantedPermissions: readonly string[] | null | undefined, isPlatformAdmin = false): boolean {
  return isPlatformAdmin || holds(grantedPermissions, KIOSK_CONFIGURE_PERMISSION);
}

/** «—» sin llegadas; «62,5 %» con ellas. */
export function metricPctLabel(value: number | null, format: (value: number) => string): string {
  return value === null ? "—" : format(value);
}
