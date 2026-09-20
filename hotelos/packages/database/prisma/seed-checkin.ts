// Tanda CHK · lotes W1-D + W5-B · tenant de prueba del check-in automatizado
// (docs/design/CHECKIN-AUTOMATIZADO-IA.md §10.1; reglas: tenants aislados por
// producto, nunca Faranda).
//
// Crea y rearma un tenant AISLADO para toda verificación con escritura de la
// tanda: organización `org_chk`, sociedad `le_chk`, hotel `prop_chk` («Hotel CHK
// (prueba)»), tres usuarios `*@chk.test` con roles de plantilla (recepción,
// jefatura de recepción, dirección de hotel), SES activado con número de
// registro de sandbox, IA activada, los módulos del producto activados en la
// propiedad, 36 habitaciones en 4 plantas (DBL/SUP/STE) con vistas, rasgos,
// camas y accesibilidad variados, tarifa BAR y diez reservas `CHK-*` relativas a
// HOY (Europe/Madrid):
//
//   · CHK-01 titular + 1 acompañante, llega hoy (2 reservation_guests), con
//     saldo pendiente y ETA 16:30;
//   · CHK-02 titular + menor de 9 años (parentesco «hijo»), llega mañana;
//   · CHK-03 / CHK-04 / CHK-05 grupo `CHK-G1`, llegan hoy (el titular de CHK-03
//     no tiene documento en el perfil: es la reserva del walkthrough y lo lee en
//     el asistente con la MRZ impresa por el seed);
//   · CHK-06 VIP (vipFlag + vipCode VIP) con acompañante, llega hoy, con saldo
//     pendiente;
//   · CHK-07 recurrente: estancia previa `checked_out` en la 204 (CHK-07P) y
//     nueva llegada mañana sin habitación;
//   · CHK-08 con `accessibilityNeeds` (silla de ruedas), llega hoy;
//   · CHK-09 llega en 2 días, huésped sin documento ni teléfono (invitación);
//   · CHK-10 alojado (`checked_in`) en la 305 con `Stay in_house`.
//
// Lote W5-B (estados de §10.1 sobre las 9 tablas de la migración W1-A), todo a
// través de los servicios del módulo con el contexto de servicio (R17) para que
// las filas sean coherentes con lo que produce el producto:
//
//   · PropertyCheckInPolicy de prop_chk: selfCheckInEnabled, depositPolicy
//     balance, métodos visual_reception + mrz_checksum + otp_email, textos de
//     consentimiento y de aviso de IA marcados «(texto provisional)» y
//     requireVisualCheckAtKiosk false (kiosco de demo sin lector: la MRZ con
//     checksums válidos entrega la llave; decisión de demo, no del diseño);
//   · KioskDevice `chk_kiosk_01` emparejado y `online` (startPairing + claimPairing:
//     solo hashes en la fila) con capabilities { mrzReader:false, cardEncoder:false };
//   · RoomBlock deep_clean de la 401 mañana y RoomConnection 201-202 connecting;
//   · MRZ sintéticas VÁLIDAS (buildMrz, W1-B; dígitos de control del propio
//     parser) por adulto con documento: en la BD SOLO quedan el número y el
//     soporte del documento (Guest.documentNumber / documentSupportNumber); las
//     líneas se recalculan con mrzFixtureFor(perfil) y salen por consola como
//     fixture del walkthrough (nunca se guardan);
//   · sesiones: 2 `invited` (CHK-09, CHK-03) · 2 `in_progress` (CHK-01 con el
//     documento del titular capturado por MRZ y firma pendiente; CHK-02 con
//     menor y adulto) · 3 `ready_for_arrival` con AssignmentSuggestion
//     `suggested` (CHK-04/05 grupo con preferencias, CHK-06 VIP con empate →
//     confidence 0) y firma del parte por el portal · 1 `checked_in` (CHK-10,
//     llave QR en guest_portal_actions) · 1 `handed_off` identity_review
//     (CHK-08: MRZ a nombre de otra persona ficticia → identity_mismatch).
//
// Huéspedes FICTICIOS: nombres genéricos y apellidos griegos («Alfa», «Beta»…),
// documentos con números sintéticos, correos `*@chk.test` y móviles E.164
// `+34600000xxx`; nunca personas reales (contrato
// tests/seed-checkin-contract.test.mjs).
//
// Idempotente: todo se escribe por id fijo (`chk_*`) con upsert; si existe, se
// reutiliza (las sesiones se crean solo si la reserva no tiene ninguna y está
// en el estado que el escenario espera). Nunca toca nada fuera de org_chk /
// prop_chk y nunca borra nada de otro tenant: el único `deleteMany` genérico
// (deleteScoped) lleva SIEMPRE `propertyId: PROPERTY_ID` y el de huéspedes
// huérfanos `organizationId: ORG_ID`.
//
//   --reset   rearma el día: borra SOLO las reservas `CHK-*` de prop_chk sin
//             factura con verifactu_hash (con folios/líneas/pagos/huéspedes de
//             reserva/estancias por cascada), sus satélites de prop_chk (partes,
//             envíos SES, sesiones y acciones del portal, sesiones de check-in
//             con sus viajeros, capturas, firmas, sugerencias, bloqueos de
//             habitación, entregas de notificaciones, lotes del job de
//             asignación, kioscos ajenos al seed, tareas, órdenes de trabajo,
//             intentos de pago, facturas sin hash) y repone el estado de las
//             habitaciones; las reservas con factura con hash VeriFactu se
//             CONSERVAN cerradas (cadena fiscal) y el kiosco chk_kiosk_01
//             conserva su emparejamiento. Imprime el plan antes.
//   --dry-run solo imprime el plan y sale 0 sin escribir.
//
// Ejecuta el seed SIEMPRE con el API parado (la cadena de auditoría vive en
// memoria del proceso del API; el seed la hidrata desde Postgres y la vacía al
// terminar):
//   cd packages/database && node --env-file=../../.env --import tsx prisma/seed-checkin.ts [--reset]
//   corepack pnpm --filter @hotelos/database db:seed:checkin -- --reset
//
// Guardado por assertDemoTarget (Tanda 4 · DATA-05): org_chk / prop_chk están en
// la allowlist demo (lib/demo-guard.ts). Es autónomo: NO importa de seed.ts ni
// de seed-operations.ts ni de seed-ux-day.ts. Los helpers del API (catálogo de
// permisos, plan contable, ajustes e impuestos de la propiedad, servicios del
// check-in) se importan por ruta relativa como en tests/integration/helpers/l2-tenant.mts.
import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import { applyRoleTemplate, provisionDefaultTemplateRoles, syncPermissionCatalog } from "../../../apps/api/src/lib/rbac-catalog.js";
import { provisionOrganizationChart } from "../../../apps/api/src/modules/accounting/chart-of-accounts.service.js";
import { ensurePropertySettings } from "../../../apps/api/src/lib/tenant-hydration.js";
import { buildMrz, type MrzSex } from "../../compliance/src/spain/mrz.js";
import type { PermissionKey } from "../../shared/src/index.js";
import type { UserContext } from "../../../apps/api/src/lib/demo-store.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres, recordAuditEvent } from "../../../apps/api/src/modules/audit/audit.service.js";
import { CHECKIN_SERVICE_PERMISSIONS, buildServiceContext, checkInServiceContext } from "../../../apps/api/src/modules/checkin/service-context.js";
import { getPolicy, upsertPolicy } from "../../../apps/api/src/modules/checkin/checkin-policy.service.js";
import { claimPairing, heartbeat, startPairing } from "../../../apps/api/src/modules/checkin/kiosk.service.js";
import { completePreArrival, ensureSession, inviteReservation, updateSession } from "../../../apps/api/src/modules/checkin/checkin-session.service.js";
import { captureDocument } from "../../../apps/api/src/modules/checkin/identity-capture.service.js";
import { signGuest } from "../../../apps/api/src/modules/checkin/signature.service.js";
import { createRoomBlock, createRoomConnection, suggestForReservation } from "../../../apps/api/src/modules/pms/room-assignment.service.js";
import { issueWalletPass } from "../../../apps/api/src/modules/mobile-keys/wallet-pass.service.js";

// ---------------------------------------------------------------------------
// Identificadores fijos del tenant (solo de prueba)
// ---------------------------------------------------------------------------

export const ORG_ID = "org_chk";
export const LEGAL_ENTITY_ID = "le_chk";
export const PROPERTY_ID = "prop_chk";
export const PROPERTY_CODE = "CHK";
export const PROPERTY_NAME = "Hotel CHK (prueba)";
export const EMAIL_DOMAIN = "chk.test";
/** Contraseña común de los tres usuarios de prueba (solo demo local; nunca real). `SEED_CHK_PASSWORD` la sustituye. */
export const DEMO_PASSWORD = process.env.SEED_CHK_PASSWORD?.trim() || "chk-demo";
export const RESERVATION_PREFIX = "CHK-";
/** Grupo de las reservas CHK-03/04/05. */
export const GROUP_CODE = "CHK-G1";
/** Número de registro SES.HOSPEDAJES de SANDBOX (no es un registro real). */
export const SES_REGISTRY_NUMBER = "CHK0000001";
/** Fecha fija de puesta en marcha del hotel de prueba (antes de cualquier día de prueba). */
export const GO_LIVE_AT = new Date("2026-09-01T00:00:00.000Z");

export const USERS = [
  { id: "usr_chk_recepcion", local: "recepcion", fullName: "Recepción CHK", templateKey: "receptionist" },
  { id: "usr_chk_jefe_recepcion", local: "jefe.recepcion", fullName: "Jefatura de recepción CHK", templateKey: "front_office_manager" },
  { id: "usr_chk_direccion", local: "direccion", fullName: "Dirección CHK", templateKey: "manager" }
] as const;

/** Módulos del producto activados en prop_chk (misma tabla property_modules que enableModules de tests/integration/helpers/l2-tenant.mts). */
export const ENABLED_MODULES = ["pms_core", "spain_guest_register_compliance", "guest_self_service", "checkin_online", "ai_concierge", "payment_vault"] as const;

// ---------------------------------------------------------------------------
// Lote W5-B · política, kiosco, bloqueos y escenarios de sesión (§10.1)
// ---------------------------------------------------------------------------

/** Kiosco de recepción del hotel de prueba (id fijo; se empareja con los servicios reales). */
export const KIOSK_ID = "chk_kiosk_01";
export const KIOSK_NAME = "Kiosco recepción CHK";
/** Habitación con bloqueo deep_clean MAÑANA (RoomBlock) y pareja comunicada (RoomConnection). */
export const BLOCKED_ROOM = 401;
export const CONNECTED_ROOMS: readonly [number, number] = [201, 202];
/** Marca de los textos legales de la política: los definitivos los aporta César (diseño §10.2 · 8). */
export const PROVISIONAL_TEXT_MARK = "(texto provisional)";
export const GUEST_CONSENT_TEXT = `Tratamos tus datos para el registro de viajeros exigido por el RD 933/2021 y para gestionar tu estancia; puedes ejercer tus derechos en recepción. ${PROVISIONAL_TEXT_MARK}`;
export const AI_DISCLOSURE_TEXT = `Parte de la lectura de tu documento y de las respuestas del asistente las genera un sistema de inteligencia artificial supervisado por el personal del hotel. ${PROVISIONAL_TEXT_MARK}`;
/** Métodos de verificación admitidos en prop_chk (los mismos que POLICY_DEFAULTS, fijados explícitamente). */
export const POLICY_VERIFICATION_METHODS = ["visual_reception", "mrz_checksum", "otp_email"] as const;
/** Sesión que se rearma con --reset: solo se crea si la reserva no tiene ninguna y está en el estado esperado. */
export type SessionScenario = "invited" | "in_progress" | "ready_for_arrival" | "checked_in" | "handed_off";
export type CheckInScenario = {
  scenario: SessionScenario;
  /** Preferencias declaradas en el asistente (vocabulario PREFERENCE_VOCABULARY). */
  preferences?: readonly string[];
  /** ETA declarada en el asistente (HH:MM). */
  eta?: string;
};
/** Escenarios de §10.1 por clave de reserva del plan. */
export const CHECKIN_SCENARIOS: Readonly<Record<string, CheckInScenario>> = Object.freeze({
  "09": { scenario: "invited" },
  "03": { scenario: "invited" },
  "01": { scenario: "in_progress", eta: "16:30" },
  "02": { scenario: "in_progress" },
  // Preferencias que singularizan una candidata (confianza > 0): DBL 209 (tranquila + cama grande), SUP 303 (mar + cuna).
  "04": { scenario: "ready_for_arrival", preferences: ["quiet", "bed_king"], eta: "15:00" },
  "05": { scenario: "ready_for_arrival", preferences: ["view_sea", "crib"], eta: "15:00" },
  "06": { scenario: "ready_for_arrival", eta: "18:00" },
  "10": { scenario: "checked_in" },
  "08": { scenario: "handed_off" }
});
/** Persona ficticia cuyo documento NO coincide con ningún viajero de CHK-08 (identity_mismatch → revisión). */
export const MISMATCH_IDENTITY = { firstName: "Persona", surname1: "Prueba", documentNumber: "CHK999999", supportNumber: "SOP999999" } as const;
/** PNG mínimo válido (cabecera + relleno) para signGuest: nunca un trazo real. */
export const SIGNATURE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
export const SIGNATURE_STROKE = { points: 40, durationMs: 1500, bbox: { x: 10, y: 10, width: 280, height: 110 } } as const;

export const ROOM_TYPES = [
  { id: "rt_chk_dbl", code: "DBL", name: "Doble", price: 95, maxOccupancy: 2, displayOrder: 1, numbers: [...range(101, 109), ...range(201, 209)] },
  { id: "rt_chk_sup", code: "SUP", name: "Superior", price: 135, maxOccupancy: 3, displayOrder: 2, numbers: range(301, 309) },
  { id: "rt_chk_ste", code: "STE", name: "Suite", price: 210, maxOccupancy: 4, displayOrder: 3, numbers: range(401, 409) }
] as const;

/** Habitaciones accesibles (accessibilityJson {accessible:true}). */
export const ACCESSIBLE_ROOMS: readonly number[] = [101, 102];
/** Única habitación fuera de servicio (status out_of_order · maintenanceStatus blocked · no vendible). */
export const OUT_OF_ORDER_ROOM = 109;

export const RATE_PLAN_ID = "rp_chk_bar";
export const CANCELLATION_POLICY_ID = "cp_chk_flex24";
/** Ventana de tarifas publicadas: hoy−7 … hoy+60 (plan BAR de 60 días). */
export const RATE_DAYS_BEFORE = 7;
export const RATE_DAYS_AFTER = 60;

// Nombres genéricos + apellidos griegos: ninguna combinación corresponde a una persona real.
const FIRST_NAMES = ["Ana", "Luis", "Marta", "Pablo", "Elena", "Jorge", "Lucía", "Diego", "Sara", "Iván", "Nuria", "Raúl", "Clara", "Mario"];
// Solo letras griegas de varias sílabas (las cortas —Mu, Xi, Pi…— coinciden con apellidos reales).
const GREEK_SURNAMES = ["Alfa", "Beta", "Gamma", "Delta", "Épsilon", "Theta", "Kappa", "Lambda", "Sigma", "Omega", "Ómicron", "Ípsilon"];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** CIF con letra de control válida (mismo algoritmo que tests/integration/helpers/l2-tenant.mts cifFor). */
export function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}

/** NIF de la sociedad de prueba (número fijo → siempre el mismo CIF; distinto del de UXDAY). */
export const LEGAL_ENTITY_TAX_ID = cifFor("B", 2026_0920);

/** Hoy (YYYY-MM-DD) en la zona horaria del hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Fecha de nacimiento de alguien que tiene exactamente `years` años (y medio) hoy — relativa, nunca literal. */
export function bornYearsAgo(years: number, now = new Date()): Date {
  const date = new Date(now.getTime());
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCMonth(date.getUTCMonth() - 6);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function nightsBetween(arrival: string, departure: string): number {
  return Math.round((dateOnly(departure).getTime() - dateOnly(arrival).getTime()) / 86_400_000);
}

function money(value: number): string {
  return value.toFixed(2);
}

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Inventario: estado y rasgos deterministas por número de habitación
// ---------------------------------------------------------------------------

type RoomTypeCode = (typeof ROOM_TYPES)[number]["code"];

export type RoomSpec = {
  number: number;
  floor: string;
  viewType: "sea" | "city";
  featuresJson: { quiet: boolean; near_elevator: boolean; far_elevator: boolean; crib: boolean };
  bedConfigurationJson: { type: "twin" | "king" };
  accessibilityJson: { accessible: true } | Record<string, never>;
  housekeepingStatus: "clean" | "inspected" | "dirty";
  maintenanceStatus: "ok" | "blocked";
  status: "clean" | "inspected" | "dirty" | "out_of_order";
  sellable: boolean;
};

/** Rasgos y estado inicial de una habitación (deterministas: la misma entrada da siempre la misma salida). */
export function roomSpecFor(number: number): RoomSpec {
  const position = number % 100; // 1…9 dentro de la planta
  const floor = String(Math.floor(number / 100));
  const nearElevator = position === 1 || position === 2;
  const farElevator = position === 8 || position === 9;
  const outOfOrder = number === OUT_OF_ORDER_ROOM;
  const housekeepingStatus: RoomSpec["housekeepingStatus"] = position % 4 === 0 ? "dirty" : position % 3 === 0 ? "inspected" : "clean";
  return {
    number,
    floor,
    viewType: number % 2 === 1 ? "sea" : "city",
    featuresJson: { quiet: farElevator || Number(floor) >= 3, near_elevator: nearElevator, far_elevator: farElevator, crib: position === 3 || position === 6 },
    bedConfigurationJson: { type: number % 2 === 0 ? "twin" : "king" },
    accessibilityJson: ACCESSIBLE_ROOMS.includes(number) ? { accessible: true } : {},
    housekeepingStatus,
    maintenanceStatus: outOfOrder ? "blocked" : "ok",
    // Tanda L5: `status` refleja la limpieza cuando la habitación está libre; `blocked` va con out_of_order y no vendible.
    status: outOfOrder ? "out_of_order" : housekeepingStatus,
    sellable: !outOfOrder
  };
}

// ---------------------------------------------------------------------------
// Plan de reservas (§10.1) — relativo a `today`
// ---------------------------------------------------------------------------

export type PlanGuest = {
  /** Sufijo del id (`chk_guest_<suffix>`). */
  suffix: string;
  firstName: string;
  surname1: string;
  isPrimary: boolean;
  relationshipType?: string;
  /** Edad en años (relativa a hoy); menor si < 14. */
  age: number;
  /** Sin documento ni teléfono (para la invitación / captura). */
  incomplete?: boolean;
  /** Perfil completo salvo el documento: lo lee en el asistente con la MRZ impresa (walkthrough del runbook). */
  noDocument?: boolean;
  vip?: boolean;
};

export type PlanReservation = {
  key: string;
  code: string;
  status: "confirmed" | "checked_in" | "checked_out";
  roomType: RoomTypeCode;
  room: number | null;
  arrivalOffset: number;
  departureOffset: number;
  adults: number;
  children: number;
  channel: string;
  /** Cobrado (captured) hasta ahora; el resto queda como saldo pendiente. */
  paid: number | "full";
  guests: PlanGuest[];
  eta?: string;
  vip?: boolean;
  groupCode?: string;
  accessibilityNeeds?: string;
  specialRequests?: string;
  /** Estancia (Stay): in_house (alojado) o checked_out (histórica). */
  stay?: "in_house" | "checked_out";
};

function priceOf(type: RoomTypeCode): number {
  return ROOM_TYPES.find((t) => t.code === type)!.price;
}

/** Huésped ficticio determinista por índice. */
export function guestNameFor(index: number): { firstName: string; surname1: string } {
  return { firstName: FIRST_NAMES[index % FIRST_NAMES.length]!, surname1: GREEK_SURNAMES[(index * 5 + 1) % GREEK_SURNAMES.length]! };
}

function adult(suffix: string, index: number, extra: Partial<PlanGuest> = {}): PlanGuest {
  const name = guestNameFor(index);
  return { suffix, firstName: name.firstName, surname1: name.surname1, isPrimary: true, age: 30 + (index % 7) * 3, ...extra };
}

export function buildPlan(): PlanReservation[] {
  const titular02 = adult("02", 1);
  return [
    { key: "01", code: "CHK-01", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 2, adults: 2, children: 0, channel: "direct", paid: 0, eta: "16:30", specialRequests: "CHK-01 · titular con acompañante, llega hoy", guests: [adult("01", 0), adult("01b", 10, { isPrimary: false })] },
    { key: "02", code: "CHK-02", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 1, departureOffset: 3, adults: 1, children: 1, channel: "ota", paid: "full", specialRequests: "CHK-02 · titular con menor de 9 años", guests: [titular02, { suffix: "02b", firstName: "Leo", surname1: titular02.surname1, isPrimary: false, relationshipType: "hijo", age: 9 }] },
    // Grupo CHK-G1 y VIP llegan HOY: sus sesiones ready_for_arrival / handed_off deben asomar en la cola de Mi día (W3-D solo mira las llegadas del día).
    // CHK-03 es la reserva del walkthrough: su titular no tiene documento en el perfil y lo lee en el asistente con la MRZ impresa por el seed.
    { key: "03", code: "CHK-03", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 2, adults: 1, children: 0, channel: "corporate", paid: "full", groupCode: GROUP_CODE, guests: [adult("03", 2, { noDocument: true })] },
    { key: "04", code: "CHK-04", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 2, adults: 1, children: 0, channel: "corporate", paid: "full", groupCode: GROUP_CODE, guests: [adult("04", 3)] },
    { key: "05", code: "CHK-05", status: "confirmed", roomType: "SUP", room: null, arrivalOffset: 0, departureOffset: 2, adults: 1, children: 0, channel: "corporate", paid: "full", groupCode: GROUP_CODE, guests: [adult("05", 4)] },
    { key: "06", code: "CHK-06", status: "confirmed", roomType: "STE", room: null, arrivalOffset: 0, departureOffset: 2, adults: 2, children: 0, channel: "phone", paid: 100, vip: true, specialRequests: "CHK-06 · VIP, detalle de bienvenida", guests: [adult("06", 5, { vip: true }), adult("06b", 11, { isPrimary: false })] },
    // Recurrente: estancia previa cerrada en la 204 (hace un mes) y nueva llegada mañana sin habitación.
    { key: "07p", code: "CHK-07P", status: "checked_out", roomType: "DBL", room: 204, arrivalOffset: -30, departureOffset: -28, adults: 1, children: 0, channel: "direct", paid: "full", stay: "checked_out", guests: [adult("07", 6)] },
    { key: "07", code: "CHK-07", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 1, departureOffset: 3, adults: 1, children: 0, channel: "direct", paid: "full", specialRequests: "CHK-07 · recurrente (estancia previa en la 204)", guests: [adult("07", 6)] },
    { key: "08", code: "CHK-08", status: "confirmed", roomType: "DBL", room: null, arrivalOffset: 0, departureOffset: 2, adults: 1, children: 0, channel: "direct", paid: "full", accessibilityNeeds: "silla de ruedas", guests: [adult("08", 7)] },
    { key: "09", code: "CHK-09", status: "confirmed", roomType: "SUP", room: null, arrivalOffset: 2, departureOffset: 4, adults: 1, children: 0, channel: "ota", paid: "full", specialRequests: "CHK-09 · sin documento ni teléfono (invitación)", guests: [adult("09", 8, { incomplete: true })] },
    { key: "10", code: "CHK-10", status: "checked_in", roomType: "SUP", room: 305, arrivalOffset: -1, departureOffset: 2, adults: 1, children: 0, channel: "direct", paid: "full", stay: "in_house", guests: [adult("10", 9)] }
  ];
}

// ---------------------------------------------------------------------------
// Borrado acotado (único deleteMany genérico del fichero)
// ---------------------------------------------------------------------------

type ScopedModel =
  | "reservation"
  | "guestRegisterRecord"
  | "sesHospedajesSubmission"
  | "touristTaxApplication"
  | "paymentIntent"
  | "housekeepingTask"
  | "workOrder"
  | "guestPortalSession"
  | "guestPortalAction"
  | "invoice"
  // Lote W5-B: las 9 tablas de la migración W1-A no cuelgan de reservations por FK
  // (solo checkin_guests → checkin_sessions en cascada), así que el reset las
  // borra explícitamente por property_id; kiosco, política y conexiones son
  // fijos y se conservan.
  | "checkInSession"
  | "documentCapture"
  | "signature"
  | "assignmentSuggestion"
  | "roomBlock"
  | "notificationDelivery"
  | "workerJobRun"
  | "kioskDevice";

/** Borra filas del modelo SOLO dentro de prop_chk (`propertyId: PROPERTY_ID` siempre). */
async function deleteScoped(model: ScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, propertyId: PROPERTY_ID };
  const delegate = prisma[model] as unknown as { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
  const result = await delegate.deleteMany({ where });
  return result.count;
}

// ---------------------------------------------------------------------------
// Tenant (idempotente)
// ---------------------------------------------------------------------------

async function ensureTenant(today: string): Promise<void> {
  const clash = await prisma.legalEntity.findFirst({ where: { taxId: LEGAL_ENTITY_TAX_ID, NOT: { id: LEGAL_ENTITY_ID } }, select: { id: true, organizationId: true } });
  if (clash) {
    throw new Error(`El NIF ${LEGAL_ENTITY_TAX_ID} ya pertenece a la sociedad ${clash.id} (organización ${clash.organizationId}); no se puede crear ${LEGAL_ENTITY_ID}.`);
  }

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: "CHK (pruebas de check-in automatizado)", legalName: "CHK Pruebas SL", taxId: LEGAL_ENTITY_TAX_ID, country: "ES" }
  });
  await prisma.legalEntity.upsert({
    where: { id: LEGAL_ENTITY_ID },
    update: {},
    create: {
      id: LEGAL_ENTITY_ID,
      organizationId: ORG_ID,
      code: "CHK",
      legalName: "CHK Pruebas SL",
      taxId: LEGAL_ENTITY_TAX_ID,
      legalForm: "sl",
      fiscalAddress: "Rúa do Check-in 2",
      fiscalPostalCode: "15001",
      fiscalMunicipality: "A Coruña",
      fiscalProvince: "A Coruña",
      isDefault: true
    }
  });
  // Establecimiento SES completo (dirección, INE, código postal) para que los
  // partes puedan encolarse en sandbox; SES activado en las dos tablas (el
  // interruptor es el OR de properties y property_compliance_settings, CS-01).
  await prisma.property.upsert({
    where: { id: PROPERTY_ID },
    update: { sesHospedajesEnabled: true },
    create: {
      id: PROPERTY_ID,
      organizationId: ORG_ID,
      legalEntityId: LEGAL_ENTITY_ID,
      code: PROPERTY_CODE,
      kind: "hotel",
      name: PROPERTY_NAME,
      legalName: "CHK Pruebas SL",
      tradeName: PROPERTY_NAME,
      address: "Rúa do Check-in 2",
      municipality: "A Coruña",
      province: "A Coruña",
      postalCode: "15001",
      ineMunicipalityCode: "15030",
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      fiscalTerritory: "common",
      timezone: "Europe/Madrid",
      currency: "EUR",
      status: "open",
      goLiveAt: GO_LIVE_AT,
      sesHospedajesEnabled: true,
      verifactuEnabled: false,
      starRating: 4,
      bedCapacity: 90
    }
  });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { sesHospedajesEnabled: true, sesRegistryNumber: SES_REGISTRY_NUMBER, verifactuEnabled: false },
    create: {
      propertyId: PROPERTY_ID,
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      sesHospedajesEnabled: true,
      // Número de registro de sandbox: no es un registro real.
      sesRegistryNumber: SES_REGISTRY_NUMBER,
      verifactuEnabled: false,
      ticketbaiEnabled: false,
      siiEnabled: false,
      b2bEinvoiceEnabled: false,
      configurationJson: {}
    }
  });
  await prisma.businessDate.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { currentDate: dateOnly(today), closedAt: null, closedBy: null },
    create: { propertyId: PROPERTY_ID, currentDate: dateOnly(today) }
  });

  // Catálogo de permisos + roles de plantilla (22 de organización).
  await syncPermissionCatalog();
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  for (const spec of USERS) {
    const roleId = roles[spec.templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${ORG_ID}.`);
    // Reaplica la plantilla por si el catálogo ha cambiado desde la última pasada.
    await applyRoleTemplate(roleId, spec.templateKey);
  }

  for (const spec of USERS) {
    const email = `${spec.local}@${EMAIL_DOMAIN}`;
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== ORG_ID) {
      throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
    }
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        id: spec.id,
        organizationId: ORG_ID,
        email,
        fullName: spec.fullName,
        status: "active",
        passwordHash: hashPassword(DEMO_PASSWORD),
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });
    const roleId = roles[spec.templateKey]!;
    const userId = existing?.id ?? spec.id;
    const assignment = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, revokedAt: null }, select: { id: true } });
    if (!assignment) {
      await prisma.userRoleAssignment.create({
        data: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID, reason: "seed checkin (tenant de prueba)" }
      });
    }
  }

  // Plan contable (necesario para facturar), ajustes/impuestos de la propiedad e IA activada.
  await provisionOrganizationChart(ORG_ID);
  await ensurePropertySettings(PROPERTY_ID);
  await prisma.propertyAiSetting.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { aiEnabled: true },
    create: { propertyId: PROPERTY_ID, aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", voiceLocales: ["es-ES", "en-GB"], configurationJson: {} }
  });

  // Módulos del producto activados en la propiedad (filas property_modules `enabled`).
  const modules = await prisma.module.findMany({ where: { code: { in: [...ENABLED_MODULES] } }, select: { id: true, code: true } });
  const missing = ENABLED_MODULES.filter((code) => !modules.some((module) => module.code === code));
  if (missing.length > 0) throw new Error(`Módulos sin fila en modules: ${missing.join(", ")} (arranca el API una vez para persistir el catálogo).`);
  const now = new Date();
  for (const module of modules) {
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: PROPERTY_ID, moduleId: module.id } },
      update: { status: "enabled", enabledAt: now, disabledAt: null },
      create: { propertyId: PROPERTY_ID, moduleId: module.id, status: "enabled", enabledAt: now }
    });
  }

  // Política de cancelación por defecto (24 h · primera noche).
  await prisma.cancellationPolicy.upsert({
    where: { id: CANCELLATION_POLICY_ID },
    update: { isDefault: true, active: true },
    create: {
      id: CANCELLATION_POLICY_ID,
      propertyId: PROPERTY_ID,
      code: "FLEX24",
      name: "Flexible 24 h",
      description: "Cancelación gratuita hasta 24 h antes de la llegada; después, la primera noche.",
      freeCancelHours: 24,
      penaltyType: "first_night",
      noShowPenaltyType: "first_night",
      active: true,
      isDefault: true
    }
  });

  // Tipos, habitaciones, plan BAR y tarifas publicadas.
  for (const type of ROOM_TYPES) {
    await prisma.roomType.upsert({
      where: { id: type.id },
      update: { displayOrder: type.displayOrder, maxOccupancy: type.maxOccupancy },
      create: { id: type.id, propertyId: PROPERTY_ID, code: type.code, name: type.name, maxOccupancy: type.maxOccupancy, baseCapacity: 2, displayOrder: type.displayOrder, active: true, sellable: true }
    });
    for (const number of type.numbers) {
      const spec = roomSpecFor(number);
      await prisma.room.upsert({
        where: { id: `chk_room_${number}` },
        update: {},
        create: {
          id: `chk_room_${number}`,
          propertyId: PROPERTY_ID,
          roomTypeId: type.id,
          number: String(number),
          floor: spec.floor,
          maxOccupancy: type.maxOccupancy,
          viewType: spec.viewType,
          featuresJson: spec.featuresJson,
          bedConfigurationJson: spec.bedConfigurationJson,
          accessibilityJson: spec.accessibilityJson,
          status: spec.status,
          housekeepingStatus: spec.housekeepingStatus,
          maintenanceStatus: spec.maintenanceStatus,
          sellable: spec.sellable,
          active: true,
          sortOrder: number
        }
      });
    }
  }
  await prisma.ratePlan.upsert({
    where: { id: RATE_PLAN_ID },
    update: {},
    create: { id: RATE_PLAN_ID, propertyId: PROPERTY_ID, code: "BAR", name: "Tarifa base", ratePlanType: "public", cancellationPolicyId: CANCELLATION_POLICY_ID, active: true }
  });
  const rateRows = [];
  for (let offset = -RATE_DAYS_BEFORE; offset <= RATE_DAYS_AFTER; offset += 1) {
    for (const type of ROOM_TYPES) {
      rateRows.push({ propertyId: PROPERTY_ID, ratePlanId: RATE_PLAN_ID, roomTypeId: type.id, date: dateOnly(isoPlus(today, offset)), price: money(type.price), currency: "EUR", source: "seed-checkin" });
    }
  }
  await prisma.rateDay.createMany({ data: rateRows, skipDuplicates: true });
}

// ---------------------------------------------------------------------------
// Reset del día (solo filas CHK-* y satélites de prop_chk)
// ---------------------------------------------------------------------------

async function resetDay(): Promise<void> {
  // Reservas con factura con hash VeriFactu: se conservan (cadena fiscal) pero se cierran.
  const protectedInvoices = await prisma.invoice.findMany({ where: { propertyId: PROPERTY_ID, verifactuHash: { not: null } }, select: { reservationId: true, folioId: true } });
  const protectedReservationIds = new Set<string>();
  for (const inv of protectedInvoices) {
    if (inv.reservationId) protectedReservationIds.add(inv.reservationId);
    if (inv.folioId) {
      const folio = await prisma.folio.findUnique({ where: { id: inv.folioId }, select: { reservationId: true } });
      if (folio) protectedReservationIds.add(folio.reservationId);
    }
  }
  const protectedIds = [...protectedReservationIds];
  const counts: Record<string, number> = {};
  if (protectedIds.length > 0) {
    const closed = await prisma.reservation.updateMany({ where: { propertyId: PROPERTY_ID, id: { in: protectedIds }, status: "checked_in" }, data: { status: "checked_out" } });
    const cancelled = await prisma.reservation.updateMany({ where: { propertyId: PROPERTY_ID, id: { in: protectedIds }, status: "confirmed" }, data: { status: "cancelled" } });
    await prisma.stay.updateMany({ where: { reservationId: { in: protectedIds }, checkoutAt: null }, data: { checkoutAt: new Date(), status: "checked_out" } });
    counts.protectedClosed = closed.count + cancelled.count;
  }
  counts.guestRegisterRecord = await deleteScoped("guestRegisterRecord");
  counts.sesHospedajesSubmission = await deleteScoped("sesHospedajesSubmission");
  counts.touristTaxApplication = await deleteScoped("touristTaxApplication");
  counts.paymentIntent = await deleteScoped("paymentIntent");
  counts.housekeepingTask = await deleteScoped("housekeepingTask");
  counts.workOrder = await deleteScoped("workOrder");
  counts.guestPortalSession = await deleteScoped("guestPortalSession");
  counts.guestPortalAction = await deleteScoped("guestPortalAction");
  counts.invoice = await deleteScoped("invoice", { verifactuHash: null });
  // Lote W5-B: capa del check-in automatizado (sesiones → viajeros en cascada;
  // capturas, firmas y sugerencias por property_id), bloqueos fechados relativos
  // a hoy, entregas simuladas (invitación / bienvenida) y la marca diaria del
  // lote de asignación de las 18:00 (W3-C) para que el día se rearme entero.
  counts.checkInSession = await deleteScoped("checkInSession");
  counts.documentCapture = await deleteScoped("documentCapture");
  counts.signature = await deleteScoped("signature");
  counts.assignmentSuggestion = await deleteScoped("assignmentSuggestion");
  counts.roomBlock = await deleteScoped("roomBlock");
  counts.notificationDelivery = await deleteScoped("notificationDelivery");
  counts.workerJobRun = await deleteScoped("workerJobRun", { jobName: "checkin.assignment" });
  // Kioscos de prueba de otros lotes (ids cuid): solo queda el del seed, que conserva su emparejamiento.
  counts.kioskDevice = await deleteScoped("kioskDevice", { id: { not: KIOSK_ID } });
  // SOLO las reservas CHK-* del hotel de prueba (cascada: folios, líneas, pagos,
  // huéspedes de reserva, estancias); nunca las que tengan factura con verifactu_hash.
  counts.reservation = await deleteScoped("reservation", { code: { startsWith: RESERVATION_PREFIX }, id: { notIn: protectedIds } });
  // Huéspedes ficticios de org_chk que ya no enlaza ninguna reserva (los del seed se
  // reutilizan por id fijo y vuelven a enlazarse). Único borrado sin propertyId, acotado a org_chk.
  const orphanGuests = await prisma.guest.deleteMany({ where: { organizationId: ORG_ID, reservationGuests: { none: {} } } });
  counts.orphanGuests = orphanGuests.count;
  // Repone el estado inicial de cada habitación (limpieza mixta y la 109 fuera de servicio).
  let roomsRestored = 0;
  for (const type of ROOM_TYPES) {
    for (const number of type.numbers) {
      const spec = roomSpecFor(number);
      const updated = await prisma.room.updateMany({
        where: { id: `chk_room_${number}`, propertyId: PROPERTY_ID },
        data: { status: spec.status, housekeepingStatus: spec.housekeepingStatus, maintenanceStatus: spec.maintenanceStatus, sellable: spec.sellable }
      });
      roomsRestored += updated.count;
    }
  }
  counts.roomsRestored = roomsRestored;
  log(`[seed-checkin] reset: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")}${protectedReservationIds.size ? ` · conservadas ${protectedReservationIds.size} con factura VeriFactu (cerradas)` : ""}`);
}

// ---------------------------------------------------------------------------
// Reservas
// ---------------------------------------------------------------------------

/** Número y soporte sintéticos del documento (DNI) de un adulto del seed; la MRZ los lleva tal cual (mrzFixtureFor). */
export function syntheticDocumentFor(sequence: number): { documentNumber: string; documentSupportNumber: string } {
  const digits = String(sequence).padStart(6, "0");
  return { documentNumber: `CHK${digits}`, documentSupportNumber: `SOP${digits}` };
}

async function upsertGuest(guest: PlanGuest, sequence: number): Promise<string> {
  const id = `chk_guest_${guest.suffix}`;
  const minor = guest.age < 14;
  const phone = `+34600000${String(sequence).padStart(3, "0")}`;
  const withDocument = !minor && !guest.incomplete && !guest.noDocument;
  const document = syntheticDocumentFor(sequence);
  // Documento sintético deterministas (número + soporte, sin MRZ en la BD): en
  // `update` también, para que una fila anterior a W5-B reciba el soporte.
  const documentFields = {
    documentType: withDocument ? "DNI" : null,
    documentNumber: withDocument ? document.documentNumber : null,
    documentSupportNumber: withDocument ? document.documentSupportNumber : null,
    documentIssueCountry: withDocument ? "ES" : null,
    documentExpiryDate: withDocument ? bornYearsAgo(-5) : null
  };
  await prisma.guest.upsert({
    where: { id },
    update: documentFields,
    create: {
      id,
      organizationId: ORG_ID,
      firstName: guest.firstName,
      surname1: guest.surname1,
      sex: sequence % 2 === 0 ? "F" : "M",
      dateOfBirth: bornYearsAgo(guest.age),
      nationality: "ES",
      languagePreference: "es",
      ...documentFields,
      email: minor ? null : `huesped.${guest.suffix}@${EMAIL_DOMAIN}`,
      mobilePhone: minor || guest.incomplete ? null : phone,
      residenceAddress: guest.incomplete ? null : `Rúa da Proba ${sequence}`,
      residenceLocality: guest.incomplete ? null : "A Coruña",
      residenceProvince: guest.incomplete ? null : "A Coruña",
      residencePostalCode: guest.incomplete ? null : "15001",
      residenceCountry: guest.incomplete ? null : "ES",
      vipCode: guest.vip ? "VIP" : null
    }
  });
  return id;
}

async function seedDay(today: string, plan: PlanReservation[]): Promise<{ created: number; existing: number }> {
  const typeById = new Map(ROOM_TYPES.map((t) => [t.code, t.id] as const));
  let created = 0;
  let existing = 0;
  let guestSequence = 0;
  for (const item of plan) {
    const reservationId = `chk_res_${item.key}`;
    const folioId = `chk_folio_${item.key}`;
    const arrival = isoPlus(today, item.arrivalOffset);
    const departure = isoPlus(today, item.departureOffset);
    const nights = nightsBetween(arrival, departure);
    const price = priceOf(item.roomType);
    const total = nights * price;
    const paid = item.paid === "full" ? total : item.paid;
    const roomId = item.room !== null ? `chk_room_${item.room}` : null;
    const primary = item.guests.find((g) => g.isPrimary) ?? item.guests[0]!;

    // Los huéspedes se escriben siempre (id fijo) para que el reset los reenlace.
    const guestIds = new Map<string, string>();
    for (const guest of item.guests) {
      guestSequence += 1;
      if (!guestIds.has(guest.suffix)) guestIds.set(guest.suffix, await upsertGuest(guest, guestSequence));
    }

    const already = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true } });
    if (already) {
      existing += 1;
      continue;
    }
    created += 1;

    await prisma.reservation.create({
      data: {
        id: reservationId,
        propertyId: PROPERTY_ID,
        code: item.code,
        channel: item.channel,
        status: item.status,
        arrivalDate: dateOnly(arrival),
        departureDate: dateOnly(departure),
        adults: item.adults,
        children: item.children,
        roomsCount: 1,
        eta: item.eta ?? null,
        roomTypeId: typeById.get(item.roomType),
        assignedRoomId: roomId,
        ratePlanId: RATE_PLAN_ID,
        boardType: "RO",
        totalAmount: money(total),
        priceSource: "rate_plan",
        currency: "EUR",
        cancellationPolicyId: CANCELLATION_POLICY_ID,
        cancellationPolicyCode: "FLEX24",
        vipFlag: Boolean(item.vip),
        groupCode: item.groupCode ?? null,
        accessibilityNeeds: item.accessibilityNeeds ?? null,
        bookerName: `${primary.firstName} ${primary.surname1}`,
        bookerEmail: primary.age < 14 ? null : `huesped.${primary.suffix}@${EMAIL_DOMAIN}`,
        specialRequests: item.specialRequests ?? null,
        bookingSource: item.channel
      }
    });
    for (const guest of item.guests) {
      await prisma.reservationGuest.create({
        data: { id: `chk_rg_${item.key}_${guest.suffix}`, reservationId, guestId: guestIds.get(guest.suffix)!, isPrimary: guest.isPrimary, relationshipType: guest.relationshipType ?? null }
      });
    }
    await prisma.folio.create({ data: { id: folioId, reservationId, guestId: guestIds.get(primary.suffix)!, status: item.status === "checked_out" ? "closed" : "open", currency: "EUR", label: "guest", isPrimary: true } });
    await prisma.folioLine.create({
      data: {
        id: `chk_fl_${item.key}_room`,
        folioId,
        type: "room",
        description: `Alojamiento ${item.roomType} · ${nights} ${nights === 1 ? "noche" : "noches"}`,
        quantity: nights,
        unitPrice: money(price),
        taxCode: "ES_IVA_10",
        taxCategory: "accommodation",
        total: money(total),
        postedBy: "seed-checkin"
      }
    });
    if (paid > 0) {
      await prisma.payment.create({
        data: {
          id: `chk_pay_${item.key}`,
          propertyId: PROPERTY_ID,
          folioId,
          amount: money(paid),
          currency: "EUR",
          method: "card",
          methodCode: "card_terminal",
          status: "captured",
          clientRequestId: `seed-checkin-${item.key}`
        }
      });
    }
    if (item.stay && roomId) {
      await prisma.stay.create({
        data: {
          id: `chk_stay_${item.key}`,
          reservationId,
          roomId,
          checkinAt: new Date(`${arrival}T14:00:00.000Z`),
          checkoutAt: item.stay === "checked_out" ? new Date(`${departure}T11:00:00.000Z`) : null,
          status: item.stay
        }
      });
      if (item.stay === "in_house") {
        await prisma.room.update({ where: { id: roomId }, data: { status: "occupied", housekeepingStatus: "clean" } });
      }
    }
  }
  return { created, existing };
}

// ---------------------------------------------------------------------------
// Lote W5-B · MRZ sintéticas (fixture, nunca en la BD)
// ---------------------------------------------------------------------------

/** Campos del perfil Guest que necesita la MRZ (todos deterministas en el seed). */
export type MrzProfile = {
  firstName: string;
  surname1: string | null;
  surname2?: string | null;
  sex: string | null;
  dateOfBirth: Date | string | null;
  nationality: string | null;
  documentNumber: string | null;
  documentSupportNumber: string | null;
  documentExpiryDate: Date | string | null;
};

/**
 * Sexo del perfil → código de buildMrz (H hombre · M mujer · O otro). Los perfiles
 * del seed llevan la convención F/M (upsertGuest); H se admite como SES.
 */
export function mrzSexOf(sex: string | null | undefined): MrzSex {
  const value = (sex ?? "").trim().toUpperCase();
  if (value === "F") return "M";
  if (value === "M" || value === "H") return "H";
  return "O";
}

/** ISO-2 → alpha-3 ICAO para emisor y nacionalidad (el seed solo usa ES; un alpha-3 pasa tal cual). */
export function alpha3Of(code: string | null | undefined): string {
  const value = (code ?? "").trim().toUpperCase();
  if (value.length === 3) return value;
  if (value === "ES" || value === "") return "ESP";
  throw new Error(`[seed-checkin] nacionalidad sin alpha-3 conocido: ${value}`);
}

function isoDayOf(value: Date | string | null | undefined, label: string): string {
  if (!value) throw new Error(`[seed-checkin] falta ${label} para la MRZ`);
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

/**
 * Líneas TD1 (DNI español: soporte en 6-14, número en el opcional) de un perfil
 * del seed. Los dígitos de control los calcula buildMrz (W1-B), así que parseMrz
 * las da por válidas. `overrides` sirve para la MRZ «a nombre de otra persona»
 * del escenario identity_review. Fixture del walkthrough: NUNCA se persiste.
 */
export function mrzFixtureFor(profile: MrzProfile, overrides: Partial<{ firstName: string; surname1: string; documentNumber: string; supportNumber: string }> = {}): string[] {
  const documentNumber = overrides.documentNumber ?? profile.documentNumber;
  const supportNumber = overrides.supportNumber ?? profile.documentSupportNumber;
  if (!documentNumber || !supportNumber) throw new Error("[seed-checkin] el perfil no tiene documento: sin MRZ");
  return buildMrz({
    format: "TD1",
    documentType: "DNI",
    issuingCountry: "ESP",
    documentNumber,
    supportNumber,
    surname: overrides.surname1 ?? profile.surname1 ?? "",
    givenNames: overrides.firstName ?? profile.firstName,
    dateOfBirth: isoDayOf(profile.dateOfBirth, "la fecha de nacimiento"),
    sex: mrzSexOf(profile.sex),
    expiryDate: isoDayOf(profile.documentExpiryDate, "la caducidad del documento"),
    nationality: alpha3Of(profile.nationality)
  });
}

// ---------------------------------------------------------------------------
// Lote W5-B · política, kiosco, bloqueo y habitaciones comunicadas
// ---------------------------------------------------------------------------

type SeedContexts = {
  /** Contexto de servicio del check-in (CHECKIN_SERVICE_PERMISSIONS, actor system:checkin:seed). */
  checkin: UserContext;
  /** El mismo actor con las dos claves de configuración que el contexto de servicio no lleva (política y kiosco). */
  admin: UserContext;
};

const SEED_ACTOR = { kind: "system", job: "seed" } as const;

function corr(label: string): string {
  return `corr_seed_chk_${label}_${Date.now().toString(36)}`;
}

async function seedContexts(): Promise<SeedContexts> {
  const checkin = await checkInServiceContext(PROPERTY_ID, SEED_ACTOR);
  const admin = buildServiceContext({
    organizationId: checkin.organizationId,
    propertyId: PROPERTY_ID,
    actor: SEED_ACTOR,
    permissions: [...CHECKIN_SERVICE_PERMISSIONS, "guest_self_service.manage", "kiosk.configure"] as PermissionKey[]
  });
  return { checkin, admin };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** PropertyCheckInPolicy de prop_chk por el servicio (auditoría CheckInPolicyUpdated) solo cuando algo difiere. */
async function ensurePolicy(contexts: SeedContexts): Promise<"created" | "updated" | "unchanged"> {
  const row = await prisma.propertyCheckInPolicy.findUnique({ where: { propertyId: PROPERTY_ID }, select: { id: true } });
  const current = await getPolicy(PROPERTY_ID);
  const unchanged =
    row !== null &&
    current.selfCheckInEnabled === true &&
    current.depositPolicy === "balance" &&
    sameSet(current.allowedVerificationMethods, POLICY_VERIFICATION_METHODS) &&
    current.requireVisualCheckAtKiosk === false &&
    current.guestConsentText === GUEST_CONSENT_TEXT &&
    current.aiDisclosureText === AI_DISCLOSURE_TEXT;
  if (unchanged) return "unchanged";
  await upsertPolicy({
    context: contexts.admin,
    propertyId: PROPERTY_ID,
    patch: {
      selfCheckInEnabled: true,
      depositPolicy: "balance",
      allowedVerificationMethods: [...POLICY_VERIFICATION_METHODS],
      // Kiosco de demo sin lector MRZ ni cotejo de recepción: la MRZ con checksums válidos basta para
      // entregar la llave en el kiosco (walkthrough §10.1). Un hotel que exija cotejo visual deja el
      // valor por defecto (true) y el kiosco deriva a recepción (IDENTITY_NOT_VERIFIED kiosk_visual_check).
      requireVisualCheckAtKiosk: false,
      guestConsentText: GUEST_CONSENT_TEXT,
      aiDisclosureText: AI_DISCLOSURE_TEXT
    },
    correlationId: corr("policy")
  });
  return row ? "updated" : "created";
}

export type KioskOutcome = { status: string; paired: "now" | "already"; deviceToken: string | null };

/**
 * KioskDevice `chk_kiosk_01` (fila por id fijo) emparejado con los servicios
 * reales: startPairing emite el código de 8 dígitos y claimPairing lo consume
 * dejando SOLO hashes en la fila y el dispositivo `online`. El deviceToken se
 * devuelve una sola vez (la tablet del walkthrough lo guarda en su localStorage);
 * un kiosco ya emparejado solo recibe el heartbeat.
 */
async function ensureKiosk(contexts: SeedContexts): Promise<KioskOutcome> {
  const capabilitiesJson = { mrzReader: false, cardEncoder: false, paymentTerminal: false, printer: false };
  const configJson = { language: "es", idleTimeoutMs: 90_000, upsell: false };
  const row = await prisma.kioskDevice.upsert({
    where: { id: KIOSK_ID },
    update: { name: KIOSK_NAME, capabilitiesJson, configJson },
    create: { id: KIOSK_ID, propertyId: PROPERTY_ID, name: KIOSK_NAME, status: "unpaired", capabilitiesJson, configJson }
  });
  if (row.status === "disabled") {
    await prisma.kioskDevice.update({ where: { id: KIOSK_ID }, data: { status: row.deviceTokenHash ? "offline" : "unpaired" } });
  }
  if (!row.deviceTokenHash) {
    const pairing = await startPairing({ context: contexts.admin, propertyId: PROPERTY_ID, deviceId: KIOSK_ID, correlationId: corr("kiosk_pair") });
    const claimed = await claimPairing(pairing.code);
    return { status: claimed.device.status, paired: "now", deviceToken: claimed.deviceToken };
  }
  const seen = await heartbeat(KIOSK_ID);
  return { status: seen?.status ?? row.status, paired: "already", deviceToken: null };
}

/** RoomBlock deep_clean de la 401 MAÑANA por el servicio (auditoría ROOM_BLOCK_CREATED); si ya hay un bloqueo que solapa, se conserva. */
async function ensureRoomBlock(contexts: SeedContexts, today: string): Promise<"created" | "existing"> {
  const tomorrow = isoPlus(today, 1);
  const roomId = `chk_room_${BLOCKED_ROOM}`;
  const overlapping = await prisma.roomBlock.findFirst({
    where: { propertyId: PROPERTY_ID, roomId, fromDate: { lte: dateOnly(tomorrow) }, toDate: { gte: dateOnly(tomorrow) } },
    select: { id: true }
  });
  if (overlapping) return "existing";
  await createRoomBlock({
    context: contexts.checkin,
    propertyId: PROPERTY_ID,
    roomId,
    fromDate: tomorrow,
    toDate: tomorrow,
    reason: "deep_clean",
    note: "Limpieza a fondo programada (tenant de prueba CHK)",
    correlationId: corr("room_block")
  });
  return "created";
}

/** RoomConnection 201-202 `connecting` por el servicio (auditoría ROOM_CONNECTION_CREATED); par único en cualquier orden. */
async function ensureRoomConnection(contexts: SeedContexts): Promise<"created" | "existing"> {
  const [roomAId, roomBId] = [`chk_room_${CONNECTED_ROOMS[0]}`, `chk_room_${CONNECTED_ROOMS[1]}`].sort();
  const existing = await prisma.roomConnection.findFirst({ where: { OR: [{ roomAId, roomBId }, { roomAId: roomBId, roomBId: roomAId }] }, select: { id: true } });
  if (existing) return "existing";
  await createRoomConnection({ context: contexts.checkin, propertyId: PROPERTY_ID, roomAId: roomAId!, roomBId: roomBId!, kind: "connecting", correlationId: corr("room_connection") });
  return "created";
}

// ---------------------------------------------------------------------------
// Lote W5-B · escenarios de sesión (§10.1) por los servicios del módulo
// ---------------------------------------------------------------------------

export type ScenarioOutcome = {
  key: string;
  code: string;
  scenario: SessionScenario;
  result: "created" | "existing" | "skipped";
  status: string | null;
  reason?: string;
  sessionId?: string;
  /** Enlace del asistente (token en claro: solo demo local; el API lo devuelve al personal fuera de producción). */
  checkInUrl?: string;
  suggestion?: { id: string; topRoomNumber: string | null; confidence: number; candidates: number };
  keySerial?: string;
};

type SessionGuestRef = { id: string; isPrimary: boolean; guestId: string | null; ordinal: number };

function auditSeed(context: UserContext, input: { action: string; entityId: string; afterJson: unknown; correlationId: string }): void {
  recordAuditEvent({
    organizationId: context.organizationId,
    propertyId: context.propertyId,
    actorUserId: context.userId,
    actorType: "system",
    action: input.action,
    entityType: "checkin_session",
    entityId: input.entityId,
    afterJson: input.afterJson,
    deviceId: context.deviceId,
    correlationId: input.correlationId
  });
}

async function profileOf(guestId: string): Promise<MrzProfile> {
  const profile = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { firstName: true, surname1: true, surname2: true, sex: true, dateOfBirth: true, nationality: true, documentNumber: true, documentSupportNumber: true, documentExpiryDate: true }
  });
  if (!profile) throw new Error(`[seed-checkin] perfil ${guestId} no encontrado`);
  return profile;
}

/** Captura por MRZ (fuente mrz_reader, sin imagen) del viajero; exige checksums válidos salvo cuando se espera discrepancia. */
async function captureByMrz(contexts: SeedContexts, guest: SessionGuestRef, lines: string[], label: string, expectMismatch = false) {
  const result = await captureDocument({ context: contexts.checkin, propertyId: PROPERTY_ID, checkInGuestId: guest.id, hints: { mrzLines: lines }, correlationId: corr(`capture_${label}`) });
  const checksOk = result.checks.document && result.checks.birth && result.checks.expiry && result.checks.composite;
  if (!checksOk) throw new Error(`[seed-checkin] MRZ sintética inválida para ${label}: ${JSON.stringify(result.checks)}`);
  if (!result.persisted) throw new Error(`[seed-checkin] la captura de ${label} no se persistió`);
  const mismatch = result.needsReview.includes("identity_mismatch");
  if (mismatch !== expectMismatch) throw new Error(`[seed-checkin] discrepancia de identidad ${expectMismatch ? "esperada" : "inesperada"} en ${label}: ${result.warnings.join(" | ")}`);
  return result;
}

/** Viajeros adultos con perfil y documento (los que pueden capturar y firmar). */
function adultsWithDocument(guests: readonly SessionGuestRef[], plan: PlanReservation): SessionGuestRef[] {
  return guests.filter((guest) => {
    if (!guest.guestId) return false;
    const spec = plan.guests.find((g) => `chk_guest_${g.suffix}` === guest.guestId);
    return Boolean(spec && spec.age >= 14 && !spec.incomplete && !spec.noDocument);
  });
}

async function seedScenario(contexts: SeedContexts, item: PlanReservation, spec: CheckInScenario): Promise<ScenarioOutcome> {
  const reservationId = `chk_res_${item.key}`;
  const base = { key: item.key, code: item.code, scenario: spec.scenario };
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true, status: true, arrivalDate: true } });
  if (!reservation) return { ...base, result: "skipped", status: null, reason: "reserva no sembrada" };
  const existing = await prisma.checkInSession.findUnique({ where: { reservationId }, select: { id: true, status: true } });
  if (existing) return { ...base, result: "existing", status: existing.status, sessionId: existing.id };
  const expected = spec.scenario === "checked_in" ? "checked_in" : "confirmed";
  if (reservation.status !== expected) return { ...base, result: "skipped", status: null, reason: `reserva ${reservation.status} (se esperaba ${expected}; usa --reset)` };

  // CHK-10: alojada desde ayer por el check-in clásico; la sesión refleja ese estado y emite la llave QR.
  if (spec.scenario === "checked_in") {
    const correlationId = corr(`checked_in_${item.key}`);
    const { session } = await ensureSession({ reservationId, channel: "reception", actor: SEED_ACTOR, correlationId });
    const checkedInAt = new Date(`${reservation.arrivalDate.toISOString().slice(0, 10)}T14:00:00.000Z`);
    const primary = session.guests.find((guest) => guest.isPrimary) ?? session.guests[0];
    if (primary) {
      await prisma.checkInGuest.update({
        where: { id: primary.id },
        data: { status: "verified", identityVerificationMethod: "visual_reception", identityVerifiedAt: checkedInAt, identityVerifiedBy: USERS[0].id }
      });
    }
    await prisma.checkInSession.update({
      where: { id: session.id },
      data: { status: "checked_in", invitedAt: checkedInAt, arrivedAt: checkedInAt, checkedInAt, consentJson: { gdprAt: checkedInAt.toISOString(), aiDisclosureAt: checkedInAt.toISOString(), marketing: false } }
    });
    const pass = await issueWalletPass({ context: contexts.checkin, reservationId });
    auditSeed(contexts.checkin, {
      action: "CheckInSessionSeeded",
      entityId: session.id,
      afterJson: { reservationId, status: "checked_in", channel: "reception", identityMethod: "visual_reception", keySerial: pass.serialNumber, seed: "seed-checkin W5-B" },
      correlationId
    });
    return { ...base, result: "created", status: "checked_in", sessionId: session.id, keySerial: pass.serialNumber };
  }

  // Resto: invitación real por email (entrega SIMULADA sin proveedor) → token del asistente.
  const invitation = await inviteReservation({ reservationId, channel: "email", context: contexts.checkin, correlationId: corr(`invite_${item.key}`) });
  const sessionId = invitation.session.id;
  const token = invitation.token;
  if (!token) throw new Error(`[seed-checkin] ${item.code}: la invitación no devolvió el token del asistente (¿entrega real en producción? exporta GUEST_PORTAL_RETURN_TOKEN=true)`);
  const guests: SessionGuestRef[] = invitation.session.guests.map((guest) => ({ id: guest.id, isPrimary: guest.isPrimary, guestId: guest.guestId, ordinal: guest.ordinal }));
  const adults = adultsWithDocument(guests, item);
  const primary = adults.find((guest) => guest.isPrimary) ?? adults[0];
  const outcome: ScenarioOutcome = { ...base, result: "created", status: "invited", sessionId, checkInUrl: invitation.checkInUrl };
  if (spec.scenario === "invited") return outcome;

  // El huésped abre el asistente: consentimientos, ETA y preferencias → in_progress.
  await updateSession({
    token,
    consent: { gdpr: true, aiDisclosure: true },
    ...(spec.eta ? { eta: spec.eta } : {}),
    ...(spec.preferences ? { preferences: [...spec.preferences] } : {}),
    correlationId: corr(`update_${item.key}`)
  });
  outcome.status = "in_progress";

  if (spec.scenario === "handed_off") {
    // Documento a nombre de otra persona ficticia: la captura se persiste con identity_mismatch
    // (W2-B: no se vincula al viajero) y la sesión pasa a recepción como identity_review (§4d).
    if (!primary?.guestId) throw new Error(`[seed-checkin] ${item.code}: sin titular con documento`);
    const lines = mrzFixtureFor(await profileOf(primary.guestId), MISMATCH_IDENTITY);
    await captureByMrz(contexts, primary, lines, `${item.key}_mismatch`, true);
    const correlationId = corr(`handoff_${item.key}`);
    const handoffReason = "Documento a nombre de otra persona: cotejo en recepción";
    await prisma.checkInSession.update({ where: { id: sessionId }, data: { status: "handed_off", handoffKind: "identity_review", handoffReason } });
    auditSeed(contexts.checkin, { action: "CheckInHandedOff", entityId: sessionId, afterJson: { reservationId, handoffKind: "identity_review", reason: handoffReason, checkInGuestId: primary.id, seed: "seed-checkin W5-B" }, correlationId });
    outcome.status = "handed_off";
    return outcome;
  }

  // Documento del titular (y de los acompañantes adultos con perfil) por MRZ sintética.
  for (const guest of adults) {
    const lines = mrzFixtureFor(await profileOf(guest.guestId!));
    await captureByMrz(contexts, guest, lines, `${item.key}_${guest.ordinal}`);
  }
  if (spec.scenario === "in_progress") return outcome;

  // ready_for_arrival: cierre del pre-check-in (partes por viajero), firma del parte por el portal y sugerencia de habitación.
  const view = await completePreArrival({ token, correlationId: corr(`complete_${item.key}`) });
  if (view.status !== "ready_for_arrival") throw new Error(`[seed-checkin] ${item.code}: completePreArrival dejó la sesión en ${view.status}`);
  for (const guest of adults) {
    await signGuest({
      context: contexts.checkin,
      checkInGuestId: guest.id,
      pngBase64: SIGNATURE_PNG.toString("base64"),
      strokeMeta: { points: SIGNATURE_STROKE.points, durationMs: SIGNATURE_STROKE.durationMs, bbox: { ...SIGNATURE_STROKE.bbox } },
      method: "touch_portal",
      sessionId,
      correlationId: corr(`sign_${item.key}_${guest.ordinal}`)
    });
  }
  const suggestion = await suggestForReservation({ context: contexts.checkin, reservationId, sessionId, persist: true });
  outcome.status = "ready_for_arrival";
  outcome.suggestion = { id: suggestion.id, topRoomNumber: suggestion.candidates[0]?.number ?? null, confidence: Number(suggestion.confidence), candidates: suggestion.candidates.length };
  return outcome;
}

async function seedCheckInScenarios(contexts: SeedContexts, plan: PlanReservation[]): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const item of plan) {
    const spec = CHECKIN_SCENARIOS[item.key];
    if (!spec) continue;
    outcomes.push(await seedScenario(contexts, item, spec));
  }
  return outcomes;
}

/**
 * MRZ sintética de cada adulto del plan (fixture para el walkthrough; se recalcula,
 * nunca se guarda). Un titular `noDocument` (CHK-03) no tiene número en el perfil:
 * su MRZ lleva el documento sintético de su secuencia (la misma que asigna
 * seedDay) y una caducidad relativa, y es la que se teclea en el asistente.
 */
async function mrzFixtures(plan: PlanReservation[]): Promise<Array<{ code: string; guestId: string; lines: string[]; inProfile: boolean }>> {
  const out: Array<{ code: string; guestId: string; lines: string[]; inProfile: boolean }> = [];
  const seen = new Set<string>();
  let guestSequence = 0;
  for (const item of plan) {
    for (const guest of item.guests) {
      guestSequence += 1;
      const guestId = `chk_guest_${guest.suffix}`;
      if (seen.has(guestId) || guest.age < 14 || guest.incomplete) continue;
      seen.add(guestId);
      const profile = await prisma.guest.findUnique({
        where: { id: guestId },
        select: { firstName: true, surname1: true, surname2: true, sex: true, dateOfBirth: true, nationality: true, documentNumber: true, documentSupportNumber: true, documentExpiryDate: true }
      });
      if (!profile) continue;
      if (profile.documentNumber && profile.documentSupportNumber) {
        out.push({ code: item.code, guestId, lines: mrzFixtureFor(profile), inProfile: true });
      } else if (guest.noDocument) {
        const synthetic = syntheticDocumentFor(guestSequence);
        out.push({ code: item.code, guestId, lines: mrzFixtureFor({ ...profile, documentExpiryDate: profile.documentExpiryDate ?? bornYearsAgo(-5) }, { documentNumber: synthetic.documentNumber, supportNumber: synthetic.documentSupportNumber }), inProfile: false });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const dryRun = args.includes("--dry-run");
  // El seed crea usuarios con contraseña conocida y activa SES/IA: nunca contra
  // una base de producción (la allowlist de demo-guard permite org_chk en cualquier BD).
  if (process.env.NODE_ENV === "production" && process.env.SEED_CHK_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-checkin] NODE_ENV=production: el tenant de prueba CHK (usuarios con contraseña conocida) no se siembra en producción. Exporta SEED_CHK_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const today = todayIn("Europe/Madrid");
  const plan = buildPlan();
  const arrivals = plan.filter((r) => r.arrivalOffset === 0).length;
  const inHouse = plan.filter((r) => r.status === "checked_in").length;
  const roomsTotal = ROOM_TYPES.reduce((sum, t) => sum + t.numbers.length, 0);
  const guestsTotal = new Set(plan.flatMap((r) => r.guests.map((g) => g.suffix))).size;

  const planned: PlannedWrite[] = [
    { table: "organizations / legal_entities / properties / business_dates / property_compliance_settings / property_ai_settings", op: "upsert", where: `id = ${ORG_ID} / ${LEGAL_ENTITY_ID} / ${PROPERTY_ID}`, count: 6 },
    { table: "users + user_role_assignments", op: "upsert", where: `*@${EMAIL_DOMAIN}`, count: USERS.length },
    { table: "property_modules", op: "upsert", where: `property_id = ${PROPERTY_ID} AND code IN (${ENABLED_MODULES.join(", ")})`, count: ENABLED_MODULES.length },
    { table: "room_types / rooms / rate_plans / rate_days", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: ROOM_TYPES.length + roomsTotal + 1 + ROOM_TYPES.length * (RATE_DAYS_BEFORE + RATE_DAYS_AFTER + 1) },
    { table: "guests", op: "upsert", where: `organization_id = ${ORG_ID} AND id LIKE 'chk_guest_%'`, count: guestsTotal },
    { table: "reservations (+ reservation_guests, folios, folio_lines, payments, stays)", op: "create", where: `property_id = ${PROPERTY_ID} AND code LIKE '${RESERVATION_PREFIX}%'`, count: plan.length },
    { table: `property_checkin_policies / kiosk_devices (+ emparejamiento) / room_blocks (${BLOCKED_ROOM} mañana) / room_connections (${CONNECTED_ROOMS.join("-")})`, op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: 4 },
    {
      table: "checkin_sessions (+ checkin_guests, document_captures, signatures, guest_register_records, assignment_suggestions, guest_portal_sessions, notification_deliveries SIMULADO, guest_portal_actions mobile_key) por los servicios del check-in",
      op: "create",
      where: `property_id = ${PROPERTY_ID} AND reservation_id IN (${Object.keys(CHECKIN_SCENARIOS).map((key) => `chk_res_${key}`).join(", ")}) sin sesión previa`,
      count: Object.keys(CHECKIN_SCENARIOS).length
    }
  ];
  if (reset) {
    planned.unshift(
      { table: "reservations conservadas con factura verifactu_hash (+ stays)", op: "update", where: `property_id = ${PROPERTY_ID} → checked_in → checked_out · confirmed → cancelled` },
      { table: "reservations CHK-* (cascada: folios, líneas, pagos, huéspedes de reserva, estancias)", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND code LIKE '${RESERVATION_PREFIX}%' AND sin factura con verifactu_hash` },
      { table: "guests huérfanos (sin reserva enlazada)", op: "deleteMany", where: `organization_id = ${ORG_ID} AND sin reservation_guests` },
      { table: "guest_register_records / ses_hospedajes_submissions / tourist_tax_applications / payment_intents / housekeeping_tasks / work_orders / guest_portal_sessions / guest_portal_actions / invoices (verifactu_hash IS NULL)", op: "deleteMany", where: `property_id = ${PROPERTY_ID}` },
      { table: `checkin_sessions (cascada checkin_guests) / document_captures / signatures / assignment_suggestions / room_blocks / notification_deliveries / worker_job_runs (checkin.assignment) / kiosk_devices (id ≠ ${KIOSK_ID})`, op: "deleteMany", where: `property_id = ${PROPERTY_ID}` },
      { table: "rooms", op: "update", where: `property_id = ${PROPERTY_ID} → estado inicial (limpieza mixta · ${OUT_OF_ORDER_ROOM} out_of_order)`, count: roomsTotal }
    );
  }

  log(`[seed-checkin] hoy (Europe/Madrid) = ${today} · ${plan.length} reservas (${arrivals} llegan hoy · ${inHouse} alojada) · ${guestsTotal} huéspedes · ${roomsTotal} habitaciones · ${Object.keys(CHECKIN_SCENARIOS).length} sesiones de check-in${reset ? " · --reset" : ""}${dryRun ? " · --dry-run" : ""}`);
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-checkin] dry-run: nada escrito.");
    return;
  }

  assertDemoTarget({ orgId: ORG_ID, propertyId: PROPERTY_ID, action: `seed-checkin (${reset ? "reset" : "ensure"})`, planned });

  // La cadena de auditoría vive en memoria: se hidrata desde Postgres para no abrir un génesis nuevo (deuda 12(c)).
  await hydrateAuditChainFromPostgres();

  await ensureTenant(today);
  if (reset) await resetDay();
  const result = await seedDay(today, plan);

  // Lote W5-B: política, kiosco, bloqueo y comunicadas; después las sesiones por los servicios.
  const contexts = await seedContexts();
  const policy = await ensurePolicy(contexts);
  const kiosk = await ensureKiosk(contexts);
  const block = await ensureRoomBlock(contexts, today);
  const connection = await ensureRoomConnection(contexts);
  const outcomes = await seedCheckInScenarios(contexts, plan);
  const fixtures = await mrzFixtures(plan);
  await flushAuditQueues();

  log(
    `[seed-checkin] listo · ${PROPERTY_NAME} (${PROPERTY_ID}) · reservas nuevas=${result.created} existentes=${result.existing} · ` +
      `usuarios ${USERS.map((u) => `${u.local}@${EMAIL_DOMAIN}`).join(", ")} (contraseña ${DEMO_PASSWORD}) · ` +
      `sociedad ${LEGAL_ENTITY_TAX_ID} · SES sandbox ${SES_REGISTRY_NUMBER}`
  );
  log(`[seed-checkin] política ${policy} · kiosco ${KIOSK_ID} ${kiosk.status} (${kiosk.paired === "now" ? "emparejado ahora" : "ya emparejado"}) · bloqueo ${BLOCKED_ROOM} mañana ${block} · comunicadas ${CONNECTED_ROOMS.join("-")} ${connection}`);
  if (kiosk.deviceToken) log(`[seed-checkin] token del kiosco (una sola vez; la tablet lo guarda en localStorage): ${kiosk.deviceToken}`);
  const counts = { created: 0, existing: 0, skipped: 0 };
  for (const outcome of outcomes) {
    counts[outcome.result] += 1;
    const extra = [
      outcome.suggestion ? `sugerencia ${outcome.suggestion.topRoomNumber ?? "—"} (${outcome.suggestion.candidates} candidatas · confianza ${outcome.suggestion.confidence})` : null,
      outcome.keySerial ? `llave ${outcome.keySerial}` : null,
      outcome.reason ?? null
    ].filter(Boolean);
    log(`  ${outcome.code.padEnd(7)} ${outcome.scenario.padEnd(17)} ${outcome.result.padEnd(8)} ${outcome.status ?? "—"}${extra.length ? ` · ${extra.join(" · ")}` : ""}`);
    if (outcome.checkInUrl) log(`          asistente: ${outcome.checkInUrl}`);
  }
  log(`[seed-checkin] sesiones creadas=${counts.created} existentes=${counts.existing} omitidas=${counts.skipped}`);
  log(`[seed-checkin] MRZ sintéticas (fixture del walkthrough; en la BD solo el número y el soporte):`);
  for (const fixture of fixtures) log(`  ${fixture.code.padEnd(7)} ${fixture.guestId.padEnd(16)} ${fixture.lines.join(" · ")}${fixture.inProfile ? "" : " (sin documento en el perfil: se teclea en el asistente)"}`);
  if ((result.existing > 0 || counts.existing > 0) && !reset) {
    log("[seed-checkin] el día ya existía: usa --reset para rearmarlo (llegadas sin check-in, saldos pendientes, habitaciones en su estado inicial, sesiones de check-in nuevas).");
  }
}

main()
  .catch((error) => {
    console.error("[seed-checkin] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
