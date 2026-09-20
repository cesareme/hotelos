// Tanda UX-2 · lote D1 · seed de dirección: segundo hotel de org_uxday, director y pendientes.
//
// Añade al tenant aislado de UX-1 (org_uxday, prisma/seed-ux-day.ts) lo que la
// persona «dirección» necesita para las 6 tareas medidas de
// docs/design/UX-DIRECCION-FEEL.md (revisar el día y riesgos, aprobar pendientes,
// leer PyG/ocupación por hotel, comparar hoteles, exportar un informe, cerrar el día):
//
//   · hotel prop_uxday_b «Hotel UXDAY B (prueba)» (código UXDB, 20 Dobles 101-120 de
//     un tipo propio rt_uxdb_dbl, tarifa BAR rp_uxdb_bar, política FLEX24) con
//     fecha de negocio = AYER (el día que dirección tiene pendiente de cerrar);
//   · día relativo a HOY (Europe/Madrid), reservas UXDB-*: 12 alojadas (llegaron
//     ayer, salen hoy+2; habitaciones 101-112), 2 salidas hoy (llegaron anteayer;
//     113-114) y 3 llegadas hoy (confirmadas, 115-117); 118-120 libres y limpias;
//   · cierre del día de ANTEAYER completado ayer (night_audit_runs, startedBy
//     usr_uxday_recepcion, stepResultsJson = { steps, report } con la forma de
//     NightAuditRunWire de packages/shared/src/pos-types.ts): las 2 salidas tienen
//     esa noche cargada y cobrada; el cierre de ayer queda para dirección;
//   · 3 approval_requests pending en prop_uxday_b solicitadas por recepción
//     (refund 60 €, folio_adjust 25 €, purchase_order 900 €; reasonCode seed-ux2;
//     caducan en 7 días) y 3 ai_human_review_items pending (guest_message_reply,
//     rate_change, review_response);
//   · revenue_daily_snapshots de nivel superior (sin dimensiones) de los últimos
//     SNAPSHOT_DAYS días (ids rds_uxdb_<fecha>, data_source seed-ux-direccion): las
//     dos últimas noches salen del plan de reservas (anteayer 2 habitaciones, ayer 14),
//     las anteriores son un histórico sintético determinista (sin reservas: ya
//     cerradas fuera del seed) con la BAR de 89 €, para que Cartera y detalle
//     comparen ocupación/ADR (corrector UX2-REV-04, diseño §4 D1);
//   · usuario usr_uxday_director director@uxday.test (plantilla «manager» ·
//     Dirección de hotel) con asignación property en prop_uxday y prop_uxday_b;
//     direccion@uxday.test (general_manager) también asignada a prop_uxday_b.
//
// Requiere el tenant de UX-1 ya sembrado (org_uxday, le_uxday, prop_uxday,
// usr_uxday_recepcion, usr_uxday_direccion): `db:seed:ux-day` primero; si falta
// algo, el seed se detiene sin escribir. Huéspedes FICTICIOS (nombres genéricos +
// apellidos griegos), nunca personas reales.
//
// Idempotente: todo por id fijo (`*_uxdb_*`) con upsert; lo existente se reutiliza.
// Nunca toca prop_uxday, el demo base ni Faranda: TODOS los deleteMany del fichero pasan
// por deleteScoped y llevan SIEMPRE `propertyId: PROPERTY_ID` (= prop_uxday_b).
//
//   --reset   rearma el día: borra SOLO filas de prop_uxday_b (reservas UXDB-* y las
//             creadas por las tareas —sin factura con verifactu_hash— con folios,
//             líneas, pagos, huéspedes de reserva y estancias por cascada; facturas
//             sin hash; partes/envíos/tasas; tareas y órdenes; cierres del día del
//             hotel; los snapshots diarios del hotel; las solicitudes de aprobación
//             con reasonCode seed-ux2 y los ítems de revisión IA del seed), repone
//             las habitaciones a limpias y la fecha de negocio a ayer. Las reservas con factura VeriFactu se
//             conservan cerradas (mismo criterio que seed-ux-day).
//   --dry-run solo imprime el plan y sale 0 sin escribir.
//
// Ejecuta el seed SIEMPRE con el API parado (la cadena de auditoría vive en
// memoria del proceso del API):
//   cd packages/database && node --env-file=../../.env --import tsx prisma/seed-ux-direccion.ts [--reset]
//   corepack pnpm --filter @hotelos/database db:seed:ux-direccion -- --reset
//
// Guardado por assertDemoTarget (org_uxday / prop_uxday_b en lib/demo-guard.ts).
// Autónomo: no importa seed.ts, seed-operations.ts ni seed-ux-day.ts (este último
// ejecuta main() al importarse); los ids compartidos se repiten aquí como constantes.
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import type { NightAuditReportWire, NightAuditStepWire } from "../../shared/src/pos-types.js";
import { provisionDefaultTemplateRoles, syncPermissionCatalog } from "../../../apps/api/src/lib/rbac-catalog.js";
import { ensurePropertySettings } from "../../../apps/api/src/lib/tenant-hydration.js";

// ---------------------------------------------------------------------------
// Identificadores fijos (solo de prueba)
// ---------------------------------------------------------------------------

export const ORG_ID = "org_uxday";
export const LEGAL_ENTITY_ID = "le_uxday";
/** Hotel de UX-1 (seed-ux-day.ts): solo se LEE (precondición) y se asigna al director; nunca se escribe en él. */
export const BASE_PROPERTY_ID = "prop_uxday";
export const PROPERTY_ID = "prop_uxday_b";
export const PROPERTY_CODE = "UXDB";
export const PROPERTY_NAME = "Hotel UXDAY B (prueba)";
export const EMAIL_DOMAIN = "uxday.test";
export const TIME_ZONE = "Europe/Madrid";
/** Misma contraseña de demo que los usuarios de seed-ux-day (solo demo local; nunca real). `SEED_UXDAY_PASSWORD` la sustituye. */
export const DEMO_PASSWORD = process.env.SEED_UXDAY_PASSWORD?.trim() || "uxday-demo";
/** Lo que el seed IMPRIME sobre la contraseña (corrector UX2-REV-07): nunca el valor, que acabaría en logs. */
export const DEMO_PASSWORD_LABEL = process.env.SEED_UXDAY_PASSWORD?.trim() ? "la de SEED_UXDAY_PASSWORD" : "la de demo por defecto";
/** Días de histórico de revenue_daily_snapshots del hotel B (ayer y anteayer desde el plan; el resto sintético). */
export const SNAPSHOT_DAYS = 20;
export const RESERVATION_PREFIX = "UXDB-";
/** Fecha fija de puesta en marcha del hotel de prueba (antes de cualquier día de prueba). */
export const GO_LIVE_AT = new Date("2026-09-01T00:00:00.000Z");

export const DIRECTOR = { id: "usr_uxday_director", local: "director", fullName: "Director UXDAY", templateKey: "manager" } as const;
/** direccion@uxday.test (general_manager, seed-ux-day): se le añade la asignación en prop_uxday_b. */
export const DIRECCION_USER_ID = "usr_uxday_direccion";
/** recepcion@uxday.test (seed-ux-day): ejecutó el cierre de anteayer y solicitó las aprobaciones. */
export const RECEPCION_USER_ID = "usr_uxday_recepcion";

export const ROOM_TYPE = { id: "rt_uxdb_dbl", code: "DBL", name: "Doble", price: 89, maxOccupancy: 2, numbers: range(101, 120) } as const;
export const RATE_PLAN_ID = "rp_uxdb_bar";
export const CANCELLATION_POLICY_ID = "cp_uxdb_flex24";
/** Ventana de tarifas publicadas: hoy−7 … hoy+60. */
export const RATE_DAYS_BEFORE = 7;
export const RATE_DAYS_AFTER = 60;

export const NIGHT_AUDIT_RUN_ID = "nar_uxdb_anteayer";
export const APPROVAL_REASON_CODE = "seed-ux2";
export const APPROVAL_TTL_DAYS = 7;
export const APPROVALS = [
  { id: "apr_uxdb_refund", kind: "refund", entityType: "payment", entityId: "pay_uxdb_s01", amount: 60, reasonText: "Devolución parcial de la salida UXDB-S01: cargo de minibar duplicado." },
  { id: "apr_uxdb_folio_adjust", kind: "folio_adjust", entityType: "folio", entityId: "folio_uxdb_h01", amount: 25, reasonText: "Ajuste del folio de UXDB-H01: minibar cargado por error." },
  { id: "apr_uxdb_purchase_order", kind: "purchase_order", entityType: "purchase_order", entityId: "po_uxdb_lenceria", amount: 900, reasonText: "Pedido de lencería (reposición de temporada) por encima del tramo de recepción." }
] as const;
export const REVIEW_ITEMS = [
  {
    id: "ahr_uxdb_guest_reply",
    reviewType: "guest_message_reply",
    relatedEntityType: "reservation",
    relatedEntityId: "res_uxdb_h02",
    payload: {
      source: "seed-ux-direccion",
      summary: "Respuesta propuesta por la IA al huésped de UXDB-H02, que pide salida tardía.",
      channel: "email",
      guestMessage: "¿Podríamos salir a las 14:00 el día de la salida?",
      proposedReply: "Con gusto: hemos anotado la salida a las 14:00 sin coste adicional. Un saludo del equipo del Hotel UXDAY B.",
      riskLevel: "medium",
      confidence: 0.82
    }
  },
  {
    id: "ahr_uxdb_rate_change",
    reviewType: "rate_change",
    relatedEntityType: "rate_plan",
    relatedEntityId: RATE_PLAN_ID,
    payload: {
      source: "seed-ux-direccion",
      summary: "Propuesta de la IA de revenue: subir la BAR de Doble de 89 € a 99 € el fin de semana (ocupación prevista 92 %).",
      ratePlanCode: "BAR",
      roomTypeCode: "DBL",
      currentPrice: "89.00",
      proposedPrice: "99.00",
      riskLevel: "high",
      confidence: 0.74
    }
  },
  {
    id: "ahr_uxdb_review_reply",
    reviewType: "review_response",
    relatedEntityType: "guest_review",
    relatedEntityId: "grv_uxdb_ruido_planta1",
    payload: {
      source: "seed-ux-direccion",
      summary: "Respuesta propuesta por la IA a una reseña de 3 estrellas (ruido en el pasillo de la planta 1).",
      draftReply: "Gracias por su valoración. Lamentamos las molestias por el ruido: ya hemos revisado los cierres de las puertas de la planta 1. Esperamos recibirle de nuevo.",
      riskLevel: "low",
      confidence: 0.9
    }
  }
] as const;
export const REVIEW_ITEM_IDS: readonly string[] = REVIEW_ITEMS.map((item) => item.id);

// Nombres genéricos + apellidos griegos de varias sílabas: ninguna combinación corresponde a una persona real.
const FIRST_NAMES = ["Ana", "Luis", "Marta", "Pablo", "Elena", "Jorge", "Lucía", "Diego", "Sara", "Iván", "Nuria", "Raúl", "Clara", "Mario", "Irene", "Óscar", "Paula"];
const GREEK_SURNAMES = ["Alfa", "Beta", "Gamma", "Delta", "Épsilon", "Theta", "Lambda", "Ómicron", "Sigma", "Ípsilon", "Omega"];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

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

function nightsBetween(arrival: string, departure: string): number {
  return Math.round((dateOnly(departure).getTime() - dateOnly(arrival).getTime()) / 86_400_000);
}

function money(value: number): string {
  return value.toFixed(2);
}

function formatDayEs(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Plan del día de dirección — relativo a `today`
// ---------------------------------------------------------------------------

export type DayReservation = {
  key: string;
  code: string;
  status: "confirmed" | "checked_in";
  room: number;
  arrivalOffset: number;
  departureOffset: number;
  channel: string;
  /** Noches ya cargadas al folio por cierres anteriores (la de ayer la carga el cierre pendiente). */
  postedNights: number;
  /** Cobrado (captured) hasta ahora. */
  paid: number;
  /** Cargos extra además del alojamiento (concepto → importe bruto). */
  extras?: Array<{ type: string; description: string; amount: number }>;
  specialRequests?: string;
};

export function buildDayPlan(): DayReservation[] {
  const plan: DayReservation[] = [];
  // 12 alojadas: llegaron ayer, salen hoy+2 (101-112). UXDB-H01 lleva un minibar de 25 € (objeto del folio_adjust).
  for (let i = 1; i <= 12; i += 1) {
    plan.push({
      key: `h${pad2(i)}`,
      code: `${RESERVATION_PREFIX}H${pad2(i)}`,
      status: "checked_in",
      room: 100 + i,
      arrivalOffset: -1,
      departureOffset: 2,
      channel: i % 4 === 0 ? "ota" : "direct",
      postedNights: 0,
      paid: 0,
      extras: i === 1 ? [{ type: "minibar", description: "Minibar", amount: 25 }] : undefined
    });
  }
  // 2 salidas hoy: llegaron anteayer (113-114); la noche de anteayer ya cargada por el cierre de ayer y cobrada.
  plan.push({ key: "s01", code: `${RESERVATION_PREFIX}S01`, status: "checked_in", room: 113, arrivalOffset: -2, departureOffset: 0, channel: "direct", postedNights: 1, paid: ROOM_TYPE.price });
  plan.push({ key: "s02", code: `${RESERVATION_PREFIX}S02`, status: "checked_in", room: 114, arrivalOffset: -2, departureOffset: 0, channel: "ota", postedNights: 1, paid: ROOM_TYPE.price });
  // 3 llegadas hoy (115-117), confirmadas con habitación limpia asignada.
  plan.push({ key: "l01", code: `${RESERVATION_PREFIX}L01`, status: "confirmed", room: 115, arrivalOffset: 0, departureOffset: 1, channel: "direct", postedNights: 0, paid: 0, specialRequests: "UXDB-L01 · llegada tardía" });
  plan.push({ key: "l02", code: `${RESERVATION_PREFIX}L02`, status: "confirmed", room: 116, arrivalOffset: 0, departureOffset: 2, channel: "phone", postedNights: 0, paid: 0 });
  plan.push({ key: "l03", code: `${RESERVATION_PREFIX}L03`, status: "confirmed", room: 117, arrivalOffset: 0, departureOffset: 2, channel: "ota", postedNights: 0, paid: 0 });
  return plan;
}

export type DaySnapshot = {
  date: string;
  /** Habitaciones ocupadas esa noche (de las 20). */
  rooms: number;
  arrivals: number;
  departures: number;
  /** true cuando la cifra sale del plan de reservas (las dos últimas noches). */
  fromPlan: boolean;
};

/**
 * Snapshots diarios del hotel B para los últimos SNAPSHOT_DAYS días (offsets −N…−1):
 * las noches cubiertas por el plan (anteayer y ayer) cuentan las reservas que
 * duermen esa noche (arrivalOffset ≤ d < departureOffset); las anteriores llevan
 * un histórico sintético determinista de 8-13 habitaciones (40-65 %). Todo con
 * la BAR de 89 € (ADR = precio del tipo; RevPAR = ingresos / 20).
 */
export function buildSnapshotPlan(today: string, plan: DayReservation[]): DaySnapshot[] {
  const out: DaySnapshot[] = [];
  for (let offset = -SNAPSHOT_DAYS; offset <= -1; offset += 1) {
    const sleeping = plan.filter((r) => r.arrivalOffset <= offset && offset < r.departureOffset);
    const fromPlan = offset >= -2;
    const rooms = fromPlan ? sleeping.length : 8 + ((SNAPSHOT_DAYS + offset) % 6);
    out.push({
      date: isoPlus(today, offset),
      rooms,
      arrivals: fromPlan ? plan.filter((r) => r.arrivalOffset === offset).length : 0,
      departures: fromPlan ? plan.filter((r) => r.departureOffset === offset).length : 0,
      fromPlan
    });
  }
  return out;
}

/** Huésped ficticio determinista por índice. */
export function guestNameFor(index: number): { firstName: string; surname1: string } {
  return { firstName: FIRST_NAMES[index % FIRST_NAMES.length], surname1: GREEK_SURNAMES[(index * 5) % GREEK_SURNAMES.length] };
}

/** Cierre de anteayer (completado ayer): steps + report con la forma de NightAuditRunWire. */
export function buildNightAuditResults(dayBeforeYesterday: string, yesterday: string, plan: DayReservation[]): { steps: NightAuditStepWire[]; report: NightAuditReportWire } {
  const audited = plan.filter((r) => r.postedNights > 0);
  const posted = audited.length;
  const totalPosted = money(posted * ROOM_TYPE.price);
  const paid = audited.reduce((sum, r) => sum + r.paid, 0);
  const steps: NightAuditStepWire[] = [
    { step: "validate_open_folios", status: "ok", detail: `${posted} folios abiertos validados.`, metrics: { folios: posted } },
    { step: "snapshot_room_status", status: "ok", detail: "Estado de habitaciones guardado.", metrics: { rooms: ROOM_TYPE.numbers.length, occupied: posted } },
    { step: "post_room_charges", status: "ok", detail: `${posted} cargos de alojamiento (${totalPosted} €).`, metrics: { posted, alreadyPosted: 0, withoutRate: 0, withoutFolio: 0 } },
    { step: "process_no_shows", status: "ok", detail: "Sin no-shows.", metrics: { processed: 0 } },
    { step: "close_settled_folios", status: "ok", detail: "Sin folios liquidados pendientes de cerrar.", metrics: { closed: 0, pendingInvoice: 0, withBalance: 0 } },
    { step: "revenue_snapshot", status: "ok", detail: `${posted} líneas de ingreso.`, metrics: { lines: posted } },
    { step: "payments_summary", status: "ok", detail: `${posted} cobros (${money(paid)} €).`, metrics: { count: posted } },
    { step: "cash_closures", status: "skipped", detail: "Sin puntos de venta con caja abierta." },
    { step: "advance_business_date", status: "ok", detail: `Fecha de negocio ${formatDayEs(dayBeforeYesterday)} → ${formatDayEs(yesterday)}.` }
  ];
  const report: NightAuditReportWire = {
    businessDate: dayBeforeYesterday,
    nextBusinessDate: yesterday,
    timeZone: TIME_ZONE,
    inHouseReservations: posted,
    roomCharges: {
      posted,
      alreadyPosted: 0,
      withoutRate: 0,
      withoutFolio: 0,
      totalPosted,
      items: audited.map((r) => ({ reservationId: `res_uxdb_${r.key}`, reservationCode: r.code, folioId: `folio_uxdb_${r.key}`, outcome: "posted" as const, amount: money(ROOM_TYPE.price), priceSource: "rate_plan" as const }))
    },
    noShows: { processed: 0, totalCharged: "0.00" },
    settledFolios: { closed: 0, pendingInvoice: 0, withBalance: 0, totalWithBalance: "0.00" },
    revenue: { total: totalPosted, lines: posted, byType: { room: totalPosted } },
    payments: { total: money(paid), count: audited.filter((r) => r.paid > 0).length, byMethod: { card: money(paid) } },
    cashClosures: [],
    warnings: []
  };
  return { steps, report };
}

// ---------------------------------------------------------------------------
// Borrado acotado (único deleteMany del fichero)
// ---------------------------------------------------------------------------

type ScopedModel =
  | "reservation"
  | "guestRegisterRecord"
  | "sesHospedajesSubmission"
  | "touristTaxApplication"
  | "paymentIntent"
  | "housekeepingTask"
  | "workOrder"
  | "invoice"
  | "nightAuditRun"
  | "revenueDailySnapshot"
  | "approvalRequest"
  | "aiHumanReviewItem";

/** Borra filas del modelo SOLO dentro de prop_uxday_b (`propertyId: PROPERTY_ID` siempre). */
async function deleteScoped(model: ScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, propertyId: PROPERTY_ID };
  const delegate = prisma[model] as unknown as { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
  const result = await delegate.deleteMany({ where });
  return result.count;
}

// ---------------------------------------------------------------------------
// Precondición: el tenant de UX-1 existe (solo lectura)
// ---------------------------------------------------------------------------

async function assertBaseTenant(): Promise<void> {
  const missing: string[] = [];
  if (!(await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true } }))) missing.push(ORG_ID);
  if (!(await prisma.legalEntity.findUnique({ where: { id: LEGAL_ENTITY_ID }, select: { id: true } }))) missing.push(LEGAL_ENTITY_ID);
  if (!(await prisma.property.findUnique({ where: { id: BASE_PROPERTY_ID }, select: { id: true } }))) missing.push(BASE_PROPERTY_ID);
  for (const userId of [RECEPCION_USER_ID, DIRECCION_USER_ID]) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    if (!user || user.organizationId !== ORG_ID) missing.push(userId);
  }
  if (missing.length > 0) {
    throw new Error(`Falta el tenant de UX-1 (${missing.join(", ")}): ejecuta antes \`corepack pnpm --filter @hotelos/database db:seed:ux-day\`. Nada escrito.`);
  }
}

// ---------------------------------------------------------------------------
// Hotel B, director y asignaciones (idempotente)
// ---------------------------------------------------------------------------

async function ensureProperty(today: string, reset: boolean): Promise<void> {
  const yesterday = isoPlus(today, -1);
  await prisma.property.upsert({
    where: { id: PROPERTY_ID },
    update: {},
    create: {
      id: PROPERTY_ID,
      organizationId: ORG_ID,
      legalEntityId: LEGAL_ENTITY_ID,
      code: PROPERTY_CODE,
      kind: "hotel",
      name: PROPERTY_NAME,
      legalName: "UXDAY Pruebas SL",
      tradeName: PROPERTY_NAME,
      address: "Rúa da Proba 2",
      municipality: "A Coruña",
      province: "A Coruña",
      postalCode: "15001",
      ineMunicipalityCode: "15030",
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      fiscalTerritory: "common",
      timezone: TIME_ZONE,
      currency: "EUR",
      status: "open",
      goLiveAt: GO_LIVE_AT,
      sesHospedajesEnabled: false,
      verifactuEnabled: false,
      starRating: 3,
      bedCapacity: 40
    }
  });
  await prisma.propertyComplianceSetting.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { sesHospedajesEnabled: false, verifactuEnabled: false },
    create: {
      propertyId: PROPERTY_ID,
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      sesHospedajesEnabled: false,
      verifactuEnabled: false,
      ticketbaiEnabled: false,
      siiEnabled: false,
      b2bEinvoiceEnabled: false,
      configurationJson: {}
    }
  });
  // Fecha de negocio = ayer (el cierre pendiente de dirección). Sin --reset no se
  // rebobina: si dirección ya cerró ayer en una sesión, el seed «ensure» lo respeta.
  await prisma.businessDate.upsert({
    where: { propertyId: PROPERTY_ID },
    update: reset ? { currentDate: dateOnly(yesterday), closedAt: null, closedBy: null } : {},
    create: { propertyId: PROPERTY_ID, currentDate: dateOnly(yesterday) }
  });

  // Ajustes e impuestos de la propiedad (el plan contable de org_uxday ya lo provisionó seed-ux-day).
  await ensurePropertySettings(PROPERTY_ID);

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

  await prisma.roomType.upsert({
    where: { id: ROOM_TYPE.id },
    update: {},
    create: { id: ROOM_TYPE.id, propertyId: PROPERTY_ID, code: ROOM_TYPE.code, name: ROOM_TYPE.name, maxOccupancy: ROOM_TYPE.maxOccupancy, baseCapacity: 2, active: true, sellable: true }
  });
  for (const number of ROOM_TYPE.numbers) {
    await prisma.room.upsert({
      where: { id: `room_uxdb_${number}` },
      update: {},
      create: {
        id: `room_uxdb_${number}`,
        propertyId: PROPERTY_ID,
        roomTypeId: ROOM_TYPE.id,
        number: String(number),
        floor: String(Math.floor(number / 100)),
        status: "clean",
        housekeepingStatus: "clean",
        maintenanceStatus: "ok",
        sellable: true,
        active: true,
        sortOrder: number
      }
    });
  }
  await prisma.ratePlan.upsert({
    where: { id: RATE_PLAN_ID },
    update: {},
    create: { id: RATE_PLAN_ID, propertyId: PROPERTY_ID, code: "BAR", name: "Tarifa base", ratePlanType: "public", cancellationPolicyId: CANCELLATION_POLICY_ID, active: true }
  });
  const rateRows = [];
  for (let offset = -RATE_DAYS_BEFORE; offset <= RATE_DAYS_AFTER; offset += 1) {
    rateRows.push({ propertyId: PROPERTY_ID, ratePlanId: RATE_PLAN_ID, roomTypeId: ROOM_TYPE.id, date: dateOnly(isoPlus(today, offset)), price: money(ROOM_TYPE.price), currency: "EUR", source: "seed-ux-direccion" });
  }
  await prisma.rateDay.createMany({ data: rateRows, skipDuplicates: true });
}

async function ensureAssignment(userId: string, roleId: string, propertyId: string): Promise<boolean> {
  const existing = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId, scopeType: "property", propertyId, revokedAt: null }, select: { id: true } });
  if (existing) return false;
  await prisma.userRoleAssignment.create({
    data: { userId, roleId, scopeType: "property", propertyId, organizationId: ORG_ID, reason: "seed ux-direccion (tenant de prueba)" }
  });
  return true;
}

async function ensureUsers(): Promise<{ assignmentsCreated: number }> {
  // Catálogo de permisos + roles de plantilla de la organización (idempotentes; ya existen tras seed-ux-day).
  await syncPermissionCatalog();
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  const managerRoleId = roles[DIRECTOR.templateKey];
  if (!managerRoleId) throw new Error(`Sin rol de plantilla «${DIRECTOR.templateKey}» en ${ORG_ID}.`);

  const email = `${DIRECTOR.local}@${EMAIL_DOMAIN}`;
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
  if (existing && existing.organizationId !== ORG_ID) {
    throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
  }
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      id: DIRECTOR.id,
      organizationId: ORG_ID,
      email,
      fullName: DIRECTOR.fullName,
      status: "active",
      passwordHash: hashPassword(DEMO_PASSWORD),
      mustChangePassword: false,
      passwordChangedAt: new Date()
    }
  });
  const directorId = existing?.id ?? DIRECTOR.id;

  let assignmentsCreated = 0;
  // Director (plantilla manager · Dirección de hotel) en los dos hoteles de la organización.
  for (const propertyId of [BASE_PROPERTY_ID, PROPERTY_ID]) {
    if (await ensureAssignment(directorId, managerRoleId, propertyId)) assignmentsCreated += 1;
  }
  // direccion@uxday.test conserva su rol (general_manager en prop_uxday) y lo extiende al hotel B.
  const direccionBase = await prisma.userRoleAssignment.findFirst({ where: { userId: DIRECCION_USER_ID, scopeType: "property", propertyId: BASE_PROPERTY_ID, revokedAt: null }, select: { roleId: true } });
  const direccionRoleId = direccionBase?.roleId ?? roles.general_manager;
  if (!direccionRoleId) throw new Error(`Sin rol de plantilla «general_manager» en ${ORG_ID}.`);
  if (await ensureAssignment(DIRECCION_USER_ID, direccionRoleId, PROPERTY_ID)) assignmentsCreated += 1;
  return { assignmentsCreated };
}

// ---------------------------------------------------------------------------
// Día de dirección
// ---------------------------------------------------------------------------

async function resetDay(today: string): Promise<void> {
  const yesterday = isoPlus(today, -1);
  // Reservas con factura con hash VeriFactu: se conservan (cadena fiscal) pero cerradas para no retener habitación.
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
  counts.invoice = await deleteScoped("invoice", { verifactuHash: null });
  // Todas las reservas del hotel B (UXDB-* del seed y las creadas por las tareas), salvo las protegidas;
  // folios, líneas, pagos, huéspedes de reserva y estancias caen por cascada. Los huéspedes ficticios
  // (sin propertyId, id fijo guest_uxdb_*) se conservan y seedDay los reutiliza.
  counts.reservation = await deleteScoped("reservation", { id: { notIn: [...protectedReservationIds] } });
  // Cierres del día del hotel B (el de anteayer del seed y los que dirección haya ejecutado).
  counts.nightAuditRun = await deleteScoped("nightAuditRun");
  // Snapshots diarios del hotel B (los del seed y los que dejara un cierre real del hotel de prueba).
  counts.revenueDailySnapshot = await deleteScoped("revenueDailySnapshot");
  // Solo las solicitudes de este seed (reasonCode seed-ux2) y sus ítems de revisión IA (ids fijos).
  counts.approvalRequest = await deleteScoped("approvalRequest", { reasonCode: APPROVAL_REASON_CODE });
  counts.aiHumanReviewItem = await deleteScoped("aiHumanReviewItem", { id: { in: [...REVIEW_ITEM_IDS] } });
  const rooms = await prisma.room.updateMany({ where: { propertyId: PROPERTY_ID }, data: { status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok" } });
  counts.roomsRestored = rooms.count;
  log(
    `[seed-ux-direccion] reset: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" · ")} · fecha de negocio → ${yesterday}` +
      `${protectedReservationIds.size ? ` · conservadas ${protectedReservationIds.size} con factura VeriFactu (cerradas)` : ""}`
  );
}

async function seedDay(today: string, plan: DayReservation[]): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  for (const [index, item] of plan.entries()) {
    const reservationId = `res_uxdb_${item.key}`;
    const guestId = `guest_uxdb_${item.key}`;
    const folioId = `folio_uxdb_${item.key}`;
    const name = guestNameFor(index);
    const arrival = isoPlus(today, item.arrivalOffset);
    const departure = isoPlus(today, item.departureOffset);
    const nights = nightsBetween(arrival, departure);
    const extrasTotal = (item.extras ?? []).reduce((sum, e) => sum + e.amount, 0);
    const total = nights * ROOM_TYPE.price + extrasTotal;
    const roomId = `room_uxdb_${item.room}`;

    const already = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true } });
    if (already) {
      existing += 1;
      continue;
    }
    created += 1;

    await prisma.guest.upsert({
      where: { id: guestId },
      update: {},
      create: {
        id: guestId,
        organizationId: ORG_ID,
        firstName: name.firstName,
        surname1: name.surname1,
        nationality: "ES",
        documentType: "DNI",
        documentNumber: `UXB${String(index + 1).padStart(5, "0")}`
      }
    });
    await prisma.reservation.create({
      data: {
        id: reservationId,
        propertyId: PROPERTY_ID,
        code: item.code,
        channel: item.channel,
        status: item.status,
        arrivalDate: dateOnly(arrival),
        departureDate: dateOnly(departure),
        adults: 2,
        children: 0,
        roomsCount: 1,
        roomTypeId: ROOM_TYPE.id,
        assignedRoomId: roomId,
        ratePlanId: RATE_PLAN_ID,
        boardType: "RO",
        totalAmount: money(total),
        priceSource: "rate_plan",
        currency: "EUR",
        cancellationPolicyId: CANCELLATION_POLICY_ID,
        cancellationPolicyCode: "FLEX24",
        vipFlag: false,
        billingInstruction: "guest_pays_checkout",
        specialRequests: item.specialRequests ?? null,
        bookingSource: item.channel
      }
    });
    await prisma.reservationGuest.create({ data: { id: `rg_uxdb_${item.key}`, reservationId, guestId, isPrimary: true } });
    await prisma.folio.create({ data: { id: folioId, reservationId, guestId, status: "open", currency: "EUR", label: "guest", isPrimary: true } });
    for (let n = 0; n < item.postedNights; n += 1) {
      const night = isoPlus(arrival, n);
      await prisma.folioLine.create({
        data: {
          id: `fl_uxdb_${item.key}_n${n + 1}`,
          folioId,
          type: "room",
          description: `Alojamiento ${ROOM_TYPE.code} · noche del ${formatDayEs(night)}`,
          quantity: 1,
          unitPrice: money(ROOM_TYPE.price),
          taxCode: "ES_IVA_10",
          taxCategory: "accommodation",
          total: money(ROOM_TYPE.price),
          postedBy: "seed-ux-direccion"
        }
      });
    }
    for (const [n, extra] of (item.extras ?? []).entries()) {
      await prisma.folioLine.create({
        data: {
          id: `fl_uxdb_${item.key}_x${n + 1}`,
          folioId,
          type: extra.type,
          description: extra.description,
          quantity: 1,
          unitPrice: money(extra.amount),
          taxCode: "ES_IVA_10",
          taxCategory: "food_beverage",
          total: money(extra.amount),
          postedBy: "seed-ux-direccion"
        }
      });
    }
    if (item.paid > 0) {
      await prisma.payment.create({
        data: {
          id: `pay_uxdb_${item.key}`,
          propertyId: PROPERTY_ID,
          folioId,
          amount: money(item.paid),
          currency: "EUR",
          method: "card",
          methodCode: "card_terminal",
          status: "captured",
          clientRequestId: `seed-ux-direccion-${item.key}`
        }
      });
    }
    if (item.status === "checked_in") {
      await prisma.stay.create({ data: { id: `stay_uxdb_${item.key}`, reservationId, roomId, checkinAt: new Date(`${arrival}T14:00:00.000Z`), status: "in_house" } });
      await prisma.room.update({ where: { id: roomId }, data: { status: "occupied", housekeepingStatus: "clean" } });
    }
  }
  return { created, existing };
}

async function seedNightAudit(today: string, plan: DayReservation[]): Promise<boolean> {
  const dayBeforeYesterday = isoPlus(today, -2);
  const yesterday = isoPlus(today, -1);
  const already = await prisma.nightAuditRun.findUnique({ where: { id: NIGHT_AUDIT_RUN_ID }, select: { id: true } });
  if (already) return false;
  const { steps, report } = buildNightAuditResults(dayBeforeYesterday, yesterday, plan);
  await prisma.nightAuditRun.create({
    data: {
      id: NIGHT_AUDIT_RUN_ID,
      propertyId: PROPERTY_ID,
      businessDate: dateOnly(dayBeforeYesterday),
      status: "completed",
      startedAt: new Date(`${yesterday}T05:58:00.000Z`),
      completedAt: new Date(`${yesterday}T06:00:00.000Z`),
      startedBy: RECEPCION_USER_ID,
      stepResultsJson: { steps, report } as unknown as Prisma.InputJsonValue,
      correlationId: "seed-ux-direccion"
    }
  });
  return true;
}

/** revenue_daily_snapshots de nivel superior (sin dimensiones) del hotel B, idempotentes por id rds_uxdb_<fecha>. */
async function seedSnapshots(today: string, plan: DayReservation[]): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;
  const roomsTotal = ROOM_TYPE.numbers.length;
  for (const day of buildSnapshotPlan(today, plan)) {
    const id = `rds_uxdb_${day.date}`;
    const already = await prisma.revenueDailySnapshot.findUnique({ where: { id }, select: { id: true } });
    if (already) {
      existing += 1;
      continue;
    }
    created += 1;
    const roomRevenue = day.rooms * ROOM_TYPE.price;
    await prisma.revenueDailySnapshot.create({
      data: {
        id,
        propertyId: PROPERTY_ID,
        snapshotDate: dateOnly(day.date),
        totalOcc: day.rooms,
        arrivalRooms: day.arrivals,
        departureRooms: day.departures,
        roomRevenue: money(roomRevenue),
        totalRevenue: money(roomRevenue),
        netRoomRevenue: money(roomRevenue),
        adr: day.rooms > 0 ? money(ROOM_TYPE.price) : null,
        revpar: money(roomRevenue / roomsTotal),
        occupancyPercent: money((day.rooms / roomsTotal) * 100),
        dataSource: "seed-ux-direccion"
      }
    });
  }
  return { created, existing };
}

async function seedPending(): Promise<{ approvals: number; reviewItems: number }> {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_DAYS * 86_400_000);
  let approvals = 0;
  for (const item of APPROVALS) {
    const already = await prisma.approvalRequest.findUnique({ where: { id: item.id }, select: { id: true } });
    if (already) continue;
    approvals += 1;
    await prisma.approvalRequest.create({
      data: {
        id: item.id,
        organizationId: ORG_ID,
        propertyId: PROPERTY_ID,
        kind: item.kind,
        entityType: item.entityType,
        entityId: item.entityId,
        amount: money(item.amount),
        currency: "EUR",
        reasonCode: APPROVAL_REASON_CODE,
        reasonText: item.reasonText,
        payloadJson: { source: "seed-ux-direccion", propertyCode: PROPERTY_CODE },
        requestedByUserId: RECEPCION_USER_ID,
        status: "pending",
        expiresAt
      }
    });
  }
  let reviewItems = 0;
  for (const item of REVIEW_ITEMS) {
    const already = await prisma.aiHumanReviewItem.findUnique({ where: { id: item.id }, select: { id: true } });
    if (already) continue;
    reviewItems += 1;
    await prisma.aiHumanReviewItem.create({
      data: {
        id: item.id,
        organizationId: ORG_ID,
        propertyId: PROPERTY_ID,
        reviewType: item.reviewType,
        relatedEntityType: item.relatedEntityType,
        relatedEntityId: item.relatedEntityId,
        payloadJson: item.payload,
        status: "pending"
      }
    });
  }
  return { approvals, reviewItems };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const dryRun = args.includes("--dry-run");
  // Como seed-ux-day (corrector R9): usuario con contraseña conocida; nunca contra producción.
  if (process.env.NODE_ENV === "production" && process.env.SEED_UXDAY_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-ux-direccion] NODE_ENV=production: el tenant de prueba UXDAY (usuarios con contraseña conocida) no se siembra en producción. Exporta SEED_UXDAY_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const today = todayIn(TIME_ZONE);
  const yesterday = isoPlus(today, -1);
  const plan = buildDayPlan();
  const arrivals = plan.filter((r) => r.arrivalOffset === 0).length;
  const departures = plan.filter((r) => r.departureOffset === 0).length;
  const inHouse = plan.filter((r) => r.status === "checked_in" && r.departureOffset > 0).length;
  const roomsTotal = ROOM_TYPE.numbers.length;

  const planned: PlannedWrite[] = [
    { table: "properties / property_compliance_settings / business_dates", op: "upsert", where: `id = ${PROPERTY_ID} · fecha de negocio ${yesterday}`, count: 3 },
    { table: "users + user_role_assignments", op: "upsert", where: `${DIRECTOR.local}@${EMAIL_DOMAIN} (manager en ${BASE_PROPERTY_ID} y ${PROPERTY_ID}) · ${DIRECCION_USER_ID} en ${PROPERTY_ID}`, count: 1 + 3 },
    { table: "room_types / rooms / rate_plans / rate_days", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: 1 + roomsTotal + 1 + (RATE_DAYS_BEFORE + RATE_DAYS_AFTER + 1) },
    { table: "reservations (+ guests, folios, folio_lines, payments, stays)", op: "create", where: `property_id = ${PROPERTY_ID} AND code LIKE '${RESERVATION_PREFIX}%'`, count: plan.length },
    { table: "night_audit_runs", op: "create", where: `property_id = ${PROPERTY_ID} AND business_date = ${isoPlus(today, -2)} (completado ${yesterday})`, count: 1 },
    { table: "revenue_daily_snapshots", op: "create", where: `property_id = ${PROPERTY_ID} AND snapshot_date BETWEEN ${isoPlus(today, -SNAPSHOT_DAYS)} AND ${yesterday} (id rds_uxdb_<fecha>)`, count: SNAPSHOT_DAYS },
    { table: "approval_requests", op: "create", where: `property_id = ${PROPERTY_ID} AND reason_code = '${APPROVAL_REASON_CODE}'`, count: APPROVALS.length },
    { table: "ai_human_review_items", op: "create", where: `property_id = ${PROPERTY_ID} AND id IN (${REVIEW_ITEM_IDS.join(", ")})`, count: REVIEW_ITEMS.length }
  ];
  if (reset) {
    planned.unshift(
      { table: "reservations conservadas con factura verifactu_hash (+ stays)", op: "update", where: `property_id = ${PROPERTY_ID} → checked_in → checked_out · confirmed → cancelled` },
      { table: "reservations del hotel B (cascada: folios, líneas, pagos, huéspedes de reserva, estancias)", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND sin factura con verifactu_hash` },
      { table: "guest_register_records / ses_hospedajes_submissions / tourist_tax_applications / payment_intents / housekeeping_tasks / work_orders / invoices (verifactu_hash IS NULL) / night_audit_runs / revenue_daily_snapshots", op: "deleteMany", where: `property_id = ${PROPERTY_ID}` },
      { table: "approval_requests", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND reason_code = '${APPROVAL_REASON_CODE}'` },
      { table: "ai_human_review_items", op: "deleteMany", where: `property_id = ${PROPERTY_ID} AND id IN (${REVIEW_ITEM_IDS.join(", ")})` },
      { table: "rooms", op: "update", where: `property_id = ${PROPERTY_ID} → clean / ok`, count: roomsTotal }
    );
  }

  log(`[seed-ux-direccion] hoy (${TIME_ZONE}) = ${today} · fecha de negocio de ${PROPERTY_ID} = ${yesterday} · ${arrivals} llegadas · ${departures} salidas · ${inHouse} alojados · ${roomsTotal} habitaciones${reset ? " · --reset" : ""}${dryRun ? " · --dry-run" : ""}`);
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-ux-direccion] dry-run: nada escrito.");
    return;
  }

  assertDemoTarget({ orgId: ORG_ID, propertyId: PROPERTY_ID, action: `seed-ux-direccion (${reset ? "reset" : "ensure"})`, planned });

  await assertBaseTenant();
  await ensureProperty(today, reset);
  const users = await ensureUsers();
  if (reset) await resetDay(today);
  const day = await seedDay(today, plan);
  const runCreated = await seedNightAudit(today, plan);
  const snapshots = await seedSnapshots(today, plan);
  const pending = await seedPending();

  log(
    `[seed-ux-direccion] listo · ${PROPERTY_NAME} (${PROPERTY_ID}) · reservas nuevas=${day.created} existentes=${day.existing} · ` +
      `cierre de anteayer ${runCreated ? "creado" : "existente"} · snapshots nuevos=${snapshots.created} existentes=${snapshots.existing} · ` +
      `aprobaciones nuevas=${pending.approvals}/${APPROVALS.length} · ítems IA nuevos=${pending.reviewItems}/${REVIEW_ITEMS.length} · ` +
      `asignaciones nuevas=${users.assignmentsCreated} · usuario ${DIRECTOR.local}@${EMAIL_DOMAIN} (contraseña: ${DEMO_PASSWORD_LABEL})`
  );
  if ((day.existing > 0 || pending.approvals < APPROVALS.length) && !reset) {
    log("[seed-ux-direccion] el día ya existía: usa --reset para rearmarlo (pendientes de nuevo en pending, fecha de negocio de ayer, salidas sin check-out).");
  }
}

main()
  .catch((error) => {
    console.error("[seed-ux-direccion] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
