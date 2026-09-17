/**
 * Importación masiva de reservas · Tanda 7 · L2 — integración (Postgres, en
 * proceso, sin HTTP). Una organización AISLADA `org_ri_<run>` con una propiedad,
 * tipos DBL (máx. 2, habitaciones 201-203) e IND (máx. 1, habitación 101), plan
 * BAR con `rate_days` para 3 noches, fila `business_dates` y una reserva previa
 * DBL, creada aquí y borrada en `after`, recorre el servicio con ficheros CSV
 * SINTÉTICOS (huéspedes ficticios @example.com):
 *   (1) preview de 9 filas: válida, tipo desconocido, llegada pasada, ocupación 3 en
 *       DBL, cancelada, tentativa, referencia repetida, habitación 101 en fila DBL
 *       (mismatch), 4.ª DBL en las mismas fechas (NO_AVAILABILITY; con
 *       permitirOverbooking, aviso) → estados y códigos, catálogo, businessDate, nada escrito;
 *   (2) commit sin omitirInvalidas → 400 RESERVATION_IMPORT_INVALID; con omitirInvalidas
 *       → lote `partial`, reservas con bookingSource import:<id>, códigos consecutivos,
 *       folio abierto, ReservationGuest principal, bookerEmail null, cancelada →
 *       cancelled, tentativa → confirmed con internalNotes, habitación por assignRoom,
 *       filas omitidas sin PII, auditoría RESERVATION_IMPORT_COMMITTED;
 *   (3) segundo fichero: mismo e-mail sin documento → mismo guestId (GUEST_REUSED) y
 *       referencia existente → DUPLICATE_REFERENCE;
 *   (4) mismo fichero otra vez → 409 RESERVATION_IMPORT_DUPLICATE; con force → lote nuevo;
 *   (5) histórico: salida pasada → checked_out, folio closed, Stay con habitación; sin
 *       historico → PAST_ARRIVAL;
 *   (6) allowOverbooking crea la reserva y RESERVATION_CREATED lleva afterJson.overbooking;
 *   (7) deshacer: activas → cancelled, con check-in previo → kept, histórica → kept,
 *       undoneCount / undoKeptCount, segunda llamada alreadyUndone;
 *   (8) contexto sin pms.reservation.modify → 403 al importar y al deshacer; listado y
 *       detalle; lote ajeno → 404.
 * Faranda y org_123 nunca se escriben. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/reservation-import.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Sin .env → valores de CI.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { prisma } = await import("@hotelos/database");
const importService = await import("../../apps/api/src/modules/pms/reservation-import.service.js");
const pms = await import("../../apps/api/src/modules/pms/pms.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

const RUN = Date.now().toString(36);
const ORG = `org_ri_${RUN}`;
const PROPERTY = `prop_ri_${RUN}`;
const USER = `usr_ri_${RUN}`;
const CORR = `corr_ri_${RUN}`;
const TIMEZONE = "Europe/Madrid";

const context = {
  organizationId: ORG,
  propertyId: PROPERTY,
  userId: USER,
  fullName: "Recepción RI",
  deviceId: "ri-test",
  permissions: ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify"]
} as unknown as UserContext;
const createOnly = { ...context, permissions: ["pms.reservation.read", "pms.reservation.create"] } as unknown as UserContext;
const checkinContext = { ...context, permissions: [...(context.permissions as string[]), "pms.checkin.execute"] } as unknown as UserContext;
const foreignContext = { ...context, organizationId: `org_ri_other_${RUN}` } as unknown as UserContext;

type Details = Record<string, unknown>;

async function expectStatus<T>(promise: Promise<T>, statusCode: number, code?: string): Promise<Details> {
  try {
    await promise;
  } catch (error) {
    const typed = error as { statusCode?: unknown; details?: unknown; message?: string };
    assert.equal(typed.statusCode, statusCode, `status de ${code ?? statusCode}: ${typed.message}`);
    const details = (typed.details ?? {}) as Details;
    if (code) assert.equal(details.code, code, `details.code (${typed.message})`);
    return details;
  }
  assert.fail(`se esperaba ${statusCode} ${code ?? ""}`);
}

/** Fecha ISO (UTC) de hoy + n días. */
function day(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offset * 86400000).toISOString().slice(0, 10);
}
const TODAY = day(0);

const HEADER = ["referencia_externa", "llegada", "salida", "tipo_habitacion", "tarifa", "habitacion", "habitaciones", "adultos", "ninos", "regimen", "canal", "estado", "nombre", "apellidos", "email", "telefono", "documento_tipo", "documento_numero", "importe_total", "moneda"] as const;
type Field = (typeof HEADER)[number];
type Row = Partial<Record<Field, string>>;

function csv(rows: readonly Row[]): string {
  const lines = rows.map((row) => HEADER.map((field) => row[field] ?? "").join(";"));
  return "﻿" + [HEADER.join(";"), ...lines].join("\r\n") + "\r\n";
}

const PII = ["@example.com", "Ferreiro", "Piñeiro", "Lema", "Souto", "Pardo", "Nowak", "Vidal", "Castro", "Mosquera", "11111111H", "22222222J"];

function assertNoPii(text: string | null | undefined, where: string): void {
  if (!text) return;
  for (const token of PII) assert.ok(!text.toLowerCase().includes(token.toLowerCase()), `${where} contiene «${token}»: ${text}`);
}

// Fichero A: 9 filas ficticias.
const ROWS_A: Row[] = [
  { referencia_externa: "IMP-RI-001", llegada: day(10), salida: day(12), tipo_habitacion: "DBL", tarifa: "BAR", habitacion: "201", habitaciones: "1", adultos: "2", ninos: "0", regimen: "BB", canal: "directo", estado: "confirmada", nombre: "Lucía", apellidos: "Ferreiro Castro", email: "lucia.ferreiro@example.com", telefono: "+34 600 111 001", documento_tipo: "DNI", documento_numero: "11111111H", importe_total: "250,00", moneda: "EUR" },
  { referencia_externa: "IMP-RI-002", llegada: day(30), salida: day(32), tipo_habitacion: "SUITE-X", tarifa: "BAR", adultos: "2", nombre: "Sara", apellidos: "Piñeiro Vila", email: "sara.pineiro@example.com", importe_total: "300,00" },
  { referencia_externa: "IMP-RI-003", llegada: day(-10), salida: day(-8), tipo_habitacion: "DBL", adultos: "2", nombre: "Pedro", apellidos: "Lema Souto", email: "pedro.lema@example.com", importe_total: "180,00" },
  { referencia_externa: "IMP-RI-004", llegada: day(30), salida: day(32), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "3", ninos: "0", nombre: "Ana", apellidos: "Souto Rey", email: "ana.souto@example.com", importe_total: "260,00" },
  { referencia_externa: "IMP-RI-005", llegada: day(15), salida: day(16), tipo_habitacion: "IND", tarifa: "BAR", adultos: "1", regimen: "RO", canal: "telefono", estado: "cancelada", nombre: "Xoán", apellidos: "Pardo Lois", email: "xoan.pardo@example.com" },
  { llegada: day(10), salida: day(12), tipo_habitacion: "DBL", adultos: "2", regimen: "BB", canal: "booking", estado: "tentativa", nombre: "Marek", apellidos: "Nowak", email: "marek.nowak@example.com", telefono: "+48 600 111 002", documento_tipo: "PAS", documento_numero: "AB1234567" },
  { referencia_externa: "IMP-RI-001", llegada: day(40), salida: day(41), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "1", nombre: "Carla", apellidos: "Vidal Mato", email: "carla.vidal@example.com", importe_total: "120,00" },
  { referencia_externa: "IMP-RI-008", llegada: day(40), salida: day(42), tipo_habitacion: "DBL", tarifa: "BAR", habitacion: "101", adultos: "2", nombre: "Iria", apellidos: "Castro Nuñez", email: "iria.castro@example.com", importe_total: "240,00" },
  { referencia_externa: "IMP-RI-009", llegada: day(10), salida: day(12), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "2", nombre: "Brais", apellidos: "Mosquera Pena", email: "brais.mosquera@example.com", importe_total: "250,00" }
];
const CSV_A = csv(ROWS_A);

// Fichero B: mismo e-mail sin documento (reutilización) + referencia ya existente.
const CSV_B = csv([
  { llegada: day(20), salida: day(21), tipo_habitacion: "IND", tarifa: "BAR", adultos: "1", nombre: "Lucía", apellidos: "Ferreiro Castro", email: "lucia.ferreiro@example.com", importe_total: "90,00" },
  { referencia_externa: "IMP-RI-001", llegada: day(20), salida: day(22), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "2", nombre: "Uxía", apellidos: "Mosquera Pena", email: "uxia.mosquera@example.com", importe_total: "250,00" }
]);

// Fichero H: una estancia pasada con habitación (histórico).
const CSV_H = csv([{ referencia_externa: "IMP-RI-H01", llegada: day(-10), salida: day(-8), tipo_habitacion: "DBL", tarifa: "BAR", habitacion: "202", adultos: "2", nombre: "Pedro", apellidos: "Lema Souto", email: "pedro.lema@example.com", documento_tipo: "DNI", documento_numero: "22222222J", importe_total: "180,00" }]);

// Fichero O: una DBL más en las fechas ya completas (overbooking explícito).
const CSV_O = csv([{ referencia_externa: "IMP-RI-O01", llegada: day(10), salida: day(12), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "2", nombre: "Brais", apellidos: "Mosquera Pena", email: "brais.mosquera@example.com", importe_total: "250,00" }]);

let dblId = "";
let indId = "";
let barId = "";
const roomIds = new Map<string, string>();

async function cleanup(): Promise<void> {
  await prisma.reservationImportRow.deleteMany({ where: { organizationId: ORG } });
  await prisma.reservationImport.deleteMany({ where: { organizationId: ORG } });
  const reservations = await prisma.reservation.findMany({ where: { propertyId: PROPERTY }, select: { id: true } });
  const ids = reservations.map((row) => row.id);
  if (ids.length) {
    await prisma.stay.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.folio.deleteMany({ where: { reservationId: { in: ids } } });
    await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: ids } } });
  }
  await prisma.reservation.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.guest.deleteMany({ where: { organizationId: ORG } });
  const rooms = await prisma.room.findMany({ where: { propertyId: PROPERTY }, select: { id: true } });
  if (rooms.length) await prisma.housekeepingTask.deleteMany({ where: { roomId: { in: rooms.map((room) => room.id) } } });
  await prisma.rateDay.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.ratePlan.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.room.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.roomType.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.businessDate.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "RI Hoteles Test", country: "ES" } });
  await prisma.property.create({ data: { id: PROPERTY, organizationId: ORG, kind: "hotel", code: "RI", name: "Hotel Importación Test", timezone: TIMEZONE, currency: "EUR" } });
  dblId = (await prisma.roomType.create({ data: { propertyId: PROPERTY, code: "DBL", name: "Doble", maxOccupancy: 2, baseCapacity: 2, active: true }, select: { id: true } })).id;
  indId = (await prisma.roomType.create({ data: { propertyId: PROPERTY, code: "IND", name: "Individual", maxOccupancy: 1, baseCapacity: 1, active: true }, select: { id: true } })).id;
  for (const [number, roomTypeId] of [["201", dblId], ["202", dblId], ["203", dblId], ["101", indId]] as const) {
    const room = await prisma.room.create({ data: { propertyId: PROPERTY, roomTypeId, number, sellable: true, maintenanceStatus: "ok" }, select: { id: true } });
    roomIds.set(number, room.id);
  }
  barId = (await prisma.ratePlan.create({ data: { propertyId: PROPERTY, code: "BAR", name: "Best Available Rate", ratePlanType: "bar", active: true }, select: { id: true } })).id;
  for (const offset of [10, 11, 12]) {
    for (const roomTypeId of [dblId, indId]) {
      await prisma.rateDay.create({ data: { propertyId: PROPERTY, ratePlanId: barId, roomTypeId, date: new Date(`${day(offset)}T00:00:00.000Z`), price: "100.00", currency: "EUR", source: "manual" } });
    }
  }
  await prisma.businessDate.create({ data: { propertyId: PROPERTY, currentDate: new Date(`${TODAY}T00:00:00.000Z`) } });
  // Reserva previa DBL en las fechas del fichero (bookedDb = 1); código fuera del patrón RES- para no desplazar la numeración.
  await prisma.reservation.create({
    data: { propertyId: PROPERTY, code: "PRE-00001", channel: "direct", status: "confirmed", arrivalDate: new Date(`${day(10)}T00:00:00.000Z`), departureDate: new Date(`${day(12)}T00:00:00.000Z`), roomTypeId: dblId, roomsCount: 1, adults: 2 }
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
});

describe("importación masiva de reservas · organización aislada (DBL 201-203, IND 101, BAR)", () => {
  let importA = "";
  let importH = "";
  let importO = "";
  let luciaGuestId = "";
  let row1ReservationId = "";
  let row6ReservationId = "";

  it("(1) preview: estados y códigos por fila, catálogo, businessDate, disponibilidad y nada escrito", async () => {
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, fileName: "reservas-a.csv" } });
    assert.equal(preview.propertyId, PROPERTY);
    assert.equal(preview.format, "csv");
    assert.equal(preview.fileName, "reservas-a.csv");
    assert.match(preview.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(preview.delimiter, ";");
    assert.equal(preview.businessDate, TODAY);
    assert.equal(preview.rowCount, 9);
    assert.deepEqual(preview.header, [...HEADER]);
    assert.deepEqual(preview.missingRequired, []);
    assert.deepEqual(preview.unmappedColumns, []);
    assert.equal(preview.mapping.referencia_externa, "referencia_externa");
    assert.equal(preview.mappingSource.llegada, "synonym");
    assert.deepEqual(preview.catalog.roomTypes.map((type) => [type.code, type.totalRooms, type.maxOccupancy]), [["DBL", 3, 2], ["IND", 1, 1]]);
    assert.deepEqual(preview.catalog.ratePlans.map((plan) => plan.code), ["BAR"]);
    assert.equal(preview.catalog.defaultRatePlanCode, "BAR");
    assert.equal(preview.catalog.currency, "EUR");

    const byRow = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    const codes = (n: number): string[] => byRow.get(n)!.issues.map((issue) => issue.code);
    assert.equal(byRow.get(1)?.status, "valid");
    assert.equal(byRow.get(2)?.status, "error");
    assert.ok(codes(2).includes("RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN"));
    assert.equal(byRow.get(3)?.status, "error");
    assert.ok(codes(3).includes("RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    assert.equal(byRow.get(4)?.status, "error");
    assert.ok(codes(4).includes("RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED"));
    assert.equal(byRow.get(5)?.status, "warning");
    assert.ok(codes(5).includes("RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT"));
    assert.ok(codes(5).includes("RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED"), "IND sin importe fuera de la parrilla → 0 con aviso");
    assert.equal(byRow.get(5)?.resolved?.totalAmount, "0.00");
    assert.equal(byRow.get(6)?.status, "warning");
    assert.ok(codes(6).includes("RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED"));
    assert.ok(codes(6).includes("RESERVATION_IMPORT_ROW_TOTAL_QUOTED"), "DBL sin importe en la parrilla → cotizado");
    assert.equal(byRow.get(6)?.resolved?.totalAmount, "200.00");
    assert.equal(byRow.get(6)?.resolved?.totalSource, "quoted");
    assert.equal(byRow.get(6)?.resolved?.ratePlanCode, "BAR", "tarifa vacía → BAR por defecto");
    assert.equal(byRow.get(7)?.status, "skipped");
    assert.ok(codes(7).includes("RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE"));
    assert.equal(byRow.get(8)?.status, "error");
    assert.ok(codes(8).includes("RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH"));
    assert.equal(byRow.get(9)?.status, "error");
    assert.ok(codes(9).includes("RESERVATION_IMPORT_ROW_NO_AVAILABILITY"));
    assert.deepEqual(byRow.get(9)?.availability, { totalRooms: 3, bookedDb: 1, bookedFile: 2, exceeds: true }, "reserva previa + filas 1 y 6");
    assert.deepEqual(byRow.get(1)?.availability, { totalRooms: 3, bookedDb: 1, bookedFile: 0, exceeds: false });
    assert.equal(byRow.get(1)?.normalized?.guest.email, "lucia.ferreiro@example.com", "la muestra lleva la fila normalizada");
    assert.equal(byRow.get(1)?.guestReuse, null);

    assert.deepEqual(preview.summary, { valid: 1, warning: 2, error: 5, skipped: 1, historical: 0, toCreate: 3 });
    assert.deepEqual(preview.duplicates.inFileRows, [7]);
    assert.deepEqual(preview.duplicates.byReferenceRows, []);
    assert.equal(preview.duplicates.ofImport, null);
    assert.deepEqual(preview.availability.overbookingRows, []);
    const dbl = preview.availability.byRoomType.find((type) => type.code === "DBL")!;
    assert.equal(dbl.totalRooms, 3);
    assert.equal(dbl.rowsRequested, 3);
    assert.equal(dbl.peakBookedDb, 1);
    assert.equal(dbl.peakBookedFile, 2);
    assert.equal(preview.totals.fromFile, "250.00", "solo la fila 1 (planificada) trae importe; la 9 queda en error");
    assert.equal(preview.totals.quoted, "200.00");
    assert.equal(preview.canImport, false);
    assert.ok(preview.blockers.some((blocker) => blocker.code === "RESERVATION_IMPORT_INVALID"));

    const lenient = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, omitirInvalidas: true } });
    assert.equal(lenient.canImport, true);
    assert.deepEqual(lenient.blockers, []);
    assert.equal(lenient.contentHash, preview.contentHash, "las opciones no cambian el hash");

    const overbooking = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, permitirOverbooking: true, sampleSize: 2 } });
    const row9 = overbooking.rows.find((row) => row.rowNumber === 9)!;
    assert.equal(row9.status, "warning");
    assert.ok(row9.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OVERBOOKING"));
    assert.deepEqual(overbooking.availability.overbookingRows, [9]);
    assert.equal(overbooking.summary.error, 4);
    assert.equal(overbooking.sampleSize, 2);
    assert.equal(overbooking.rows.find((row) => row.rowNumber === 5)?.normalized, undefined, "fuera de la muestra no viaja la fila normalizada");

    assert.equal(await prisma.reservationImport.count({ where: { organizationId: ORG } }), 0, "la preview nunca escribe");
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY } }), 1);
    assert.equal(await prisma.guest.count({ where: { organizationId: ORG } }), 0);
  });

  it("(2) commit sin omitirInvalidas → 400 RESERVATION_IMPORT_INVALID; con omitirInvalidas → lote partial con reservas por createReservation", async () => {
    const details = await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, fileName: "reservas-a.csv" }, correlationId: CORR }), 400, "RESERVATION_IMPORT_INVALID");
    assert.equal(details.errorCount, 5);
    assert.equal((details.rows as unknown[]).length, 5);
    assert.equal(await prisma.reservationImport.count({ where: { organizationId: ORG } }), 0);

    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, fileName: "reservas-a.csv", omitirInvalidas: true }, correlationId: CORR });
    importA = result.id;
    assert.equal(result.status, "partial");
    assert.equal(result.organizationId, ORG);
    assert.equal(result.propertyId, PROPERTY);
    assert.equal(result.format, "csv");
    assert.equal(result.fileName, "reservas-a.csv");
    assert.equal(result.rowCount, 9);
    assert.equal(result.createdCount, 3);
    assert.equal(result.skippedCount, 6);
    assert.equal(result.errorCount, 0);
    assert.ok(result.warningCount >= 2);
    assert.equal(result.createdBy, USER);
    assert.equal(result.currency, "EUR");
    assert.equal(result.totalAmount, "450.00", "250 (fila 1) + 0 (fila 5) + 200 cotizado (fila 6)");
    assert.equal(result.arrivalFrom, day(10));
    assert.equal(result.arrivalTo, day(15));
    assert.equal(result.options.omitirInvalidas, true);
    assert.equal(result.options.source, "http");
    assert.equal(result.options.encoding, "utf-8");
    assert.equal(result.options.delimiter, ";");
    assert.ok(typeof result.options.durationMs === "number");
    assert.equal(result.mapping.llegada, "llegada");
    assert.equal(result.rows.length, 9);

    const reservations = await prisma.reservation.findMany({ where: { propertyId: PROPERTY, bookingSource: `import:${importA}` }, orderBy: { code: "asc" } });
    assert.equal(reservations.length, 3);
    const numbers = reservations.map((row) => Number(row.code.slice(4)));
    assert.deepEqual(reservations.map((row) => row.code), ["RES-00001", "RES-00002", "RES-00003"]);
    assert.equal(numbers[1], numbers[0]! + 1);
    assert.equal(numbers[2], numbers[1]! + 1);
    assert.ok(reservations.every((row) => row.bookerEmail === null), "el importador nunca rellena bookerEmail");

    const rowsByNumber = new Map(result.rows.map((row) => [row.rowNumber, row]));
    const row1 = rowsByNumber.get(1)!;
    assert.equal(row1.outcome, "created");
    assert.equal(row1.reservationCode, "RES-00001");
    assert.equal(row1.externalReference, "IMP-RI-001");
    assert.equal(row1.roomTypeCode, "DBL");
    assert.equal(row1.ratePlanCode, "BAR");
    assert.equal(row1.arrivalDate, day(10));
    row1ReservationId = row1.reservationId!;
    const reservation1 = reservations.find((row) => row.id === row1ReservationId)!;
    assert.equal(reservation1.status, "confirmed");
    assert.equal(reservation1.assignedRoomId, roomIds.get("201"), "habitación asignada vía assignRoom");
    assert.equal(reservation1.bookerName, "Lucía Ferreiro Castro");
    assert.equal(reservation1.externalReference, "IMP-RI-001");
    assert.equal(reservation1.channel, "direct");
    assert.equal(reservation1.boardType, "BB");
    assert.equal(reservation1.totalAmount.toFixed(2), "250.00");
    assert.equal(reservation1.ratePlanId, barId);
    const folio1 = await prisma.folio.findFirst({ where: { reservationId: row1ReservationId } });
    assert.equal(folio1?.status, "open");
    const link1 = await prisma.reservationGuest.findFirst({ where: { reservationId: row1ReservationId, isPrimary: true } });
    assert.ok(link1);
    luciaGuestId = link1!.guestId;
    const lucia = await prisma.guest.findUnique({ where: { id: luciaGuestId } });
    assert.equal(lucia?.email, "lucia.ferreiro@example.com");
    assert.equal(lucia?.surname1, "Ferreiro");
    assert.equal(lucia?.surname2, "Castro");
    assert.equal(lucia?.documentNumber, "11111111H");
    assert.equal(folio1?.guestId, luciaGuestId);

    const row5 = rowsByNumber.get(5)!;
    assert.equal(row5.outcome, "created");
    const reservation5 = reservations.find((row) => row.id === row5.reservationId)!;
    assert.equal(reservation5.status, "cancelled", "fila cancelada → creada y cancelada con transitionReservation");
    assert.equal(reservation5.channel, "phone");
    assert.ok(row5.warnings.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT"));

    const row6 = rowsByNumber.get(6)!;
    assert.equal(row6.outcome, "created");
    row6ReservationId = row6.reservationId!;
    const reservation6 = reservations.find((row) => row.id === row6ReservationId)!;
    assert.equal(reservation6.status, "confirmed");
    assert.match(reservation6.internalNotes ?? "", /^Importada como tentativa: confirmar con el cliente \(lote /);
    assert.equal(reservation6.totalAmount.toFixed(2), "200.00", "cotizado con la parrilla BAR");
    assert.equal(reservation6.ratePlanId, barId);
    assert.equal(reservation6.channel, "booking_com");
    assert.equal(reservation6.sourceCode, "booking");
    assert.ok(row6.warnings.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED"));

    for (const n of [2, 3, 4, 8, 9]) {
      const row = rowsByNumber.get(n)!;
      assert.equal(row.outcome, "skipped", `fila ${n}`);
      assert.equal(row.errorCode, "RESERVATION_IMPORT_ROW_INVALID_SKIPPED");
      assert.equal(row.reservationId, null);
    }
    assert.match(rowsByNumber.get(9)!.errorMessage ?? "", /NO_AVAILABILITY/);
    assert.equal(rowsByNumber.get(7)!.outcome, "skipped");
    assert.equal(rowsByNumber.get(7)!.errorCode, "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE");
    for (const row of result.rows) {
      assertNoPii(row.errorMessage, `fila ${row.rowNumber} errorMessage`);
      for (const warning of row.warnings) assertNoPii(warning.message, `fila ${row.rowNumber} aviso ${warning.code}`);
    }
    const stored = await prisma.reservationImportRow.findMany({ where: { importId: importA } });
    assert.equal(stored.length, 9);
    for (const row of stored) {
      assertNoPii(row.errorMessage, `fila persistida ${row.rowNumber}`);
      assertNoPii(JSON.stringify(row.warningsJson), `avisos persistidos ${row.rowNumber}`);
    }
    assert.equal(await prisma.guest.count({ where: { organizationId: ORG } }), 3, "un huésped por reserva creada");

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "RESERVATION_IMPORT_COMMITTED", entityId: importA } });
    assert.ok(audit, "auditoría RESERVATION_IMPORT_COMMITTED");
    const after = audit!.afterJson as { status: string; createdCount: number; contentHash: string };
    assert.equal(after.status, "partial");
    assert.equal(after.createdCount, 3);
    assert.equal(after.contentHash, result.contentHash);
  });

  it("(3) segundo fichero: mismo e-mail sin documento → mismo huésped (GUEST_REUSED); referencia existente → DUPLICATE_REFERENCE", async () => {
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_B } });
    const first = preview.rows.find((row) => row.rowNumber === 1)!;
    assert.equal(first.status, "warning");
    assert.equal(first.guestReuse, "email");
    assert.ok(first.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_GUEST_REUSED"));
    const second = preview.rows.find((row) => row.rowNumber === 2)!;
    assert.equal(second.status, "skipped");
    const duplicate = second.issues.find((issue) => issue.code === "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE")!;
    assert.equal(duplicate.details?.reservationCode, "RES-00001");
    assert.deepEqual(preview.duplicates.byReferenceRows, [2]);
    assert.equal(preview.canImport, true);

    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_B, fileName: "reservas-b.csv" }, correlationId: CORR });
    assert.equal(result.status, "partial");
    assert.equal(result.createdCount, 1);
    assert.equal(result.skippedCount, 1);
    const created = result.rows.find((row) => row.rowNumber === 1)!;
    assert.equal(created.reservationCode, "RES-00004", "la numeración continúa");
    const link = await prisma.reservationGuest.findFirst({ where: { reservationId: created.reservationId!, isPrimary: true } });
    assert.equal(link?.guestId, luciaGuestId, "reutiliza la ficha hallada por e-mail");
    assert.equal(await prisma.guest.count({ where: { organizationId: ORG } }), 3, "ningún huésped nuevo");
    assert.equal(result.rows.find((row) => row.rowNumber === 2)?.errorCode, "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE");
  });

  it("(4) mismo fichero otra vez → 409 RESERVATION_IMPORT_DUPLICATE; con force → lote nuevo con duplicateOfImportId", async () => {
    const details = await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, omitirInvalidas: true }, correlationId: CORR }), 409, "RESERVATION_IMPORT_DUPLICATE");
    assert.equal(details.importId, importA);
    assert.equal(details.status, "partial");
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, omitirInvalidas: true } });
    assert.equal(preview.duplicates.ofImport?.importId, importA);
    assert.equal(preview.canImport, false);
    assert.ok(preview.blockers.some((blocker) => blocker.code === "RESERVATION_IMPORT_DUPLICATE"));

    const forced = await importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_A, omitirInvalidas: true, force: true }, correlationId: CORR, source: "cli", createdBy: "cli:test" });
    assert.notEqual(forced.id, importA);
    assert.equal(forced.options.duplicateOfImportId, importA);
    assert.equal(forced.options.force, true);
    assert.equal(forced.options.source, "cli");
    assert.equal(forced.createdBy, "cli:test");
    assert.equal(forced.status, "partial");
    assert.equal(forced.createdCount, 1, "solo la fila 5 (IND cancelada): la 1 ya existe por referencia y las DBL de esas fechas no caben");
    assert.equal(forced.rows.find((row) => row.rowNumber === 1)?.errorCode, "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE");
    assert.equal(forced.rows.find((row) => row.rowNumber === 6)?.errorCode, "RESERVATION_IMPORT_ROW_INVALID_SKIPPED");
    assert.match(forced.rows.find((row) => row.rowNumber === 6)?.errorMessage ?? "", /NO_AVAILABILITY/);
  });

  it("(5) histórico: sin historico → PAST_ARRIVAL; con historico → checked_out, folio closed y Stay con la habitación", async () => {
    const rejected = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_H } });
    assert.equal(rejected.rows[0]?.status, "error");
    assert.ok(rejected.rows[0]?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_PAST_ARRIVAL"));
    await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_H }, correlationId: CORR }), 400, "RESERVATION_IMPORT_INVALID");

    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_H, historico: true } });
    assert.equal(preview.rows[0]?.status, "warning");
    assert.ok(preview.rows[0]?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_HISTORICAL"));
    assert.equal(preview.rows[0]?.availability, undefined, "las históricas no entran en el planificador");
    assert.equal(preview.summary.historical, 1);
    assert.deepEqual(preview.availability.byRoomType, []);

    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_H, fileName: "historico.csv", historico: true }, correlationId: `${CORR}_h` });
    importH = result.id;
    assert.equal(result.status, "imported");
    assert.equal(result.createdCount, 1);
    assert.equal(result.options.historico, true);
    const reservationId = result.rows[0]!.reservationId!;
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    assert.equal(reservation?.status, "checked_out");
    assert.equal(reservation?.assignedRoomId, roomIds.get("202"));
    assert.equal(reservation?.bookingSource, `import:${importH}`);
    const folio = await prisma.folio.findFirst({ where: { reservationId } });
    assert.equal(folio?.status, "closed");
    const stay = await prisma.stay.findFirst({ where: { reservationId } });
    assert.ok(stay, "Stay de la estancia cerrada");
    assert.equal(stay!.roomId, roomIds.get("202"));
    assert.equal(stay!.status, "checked_out");
    const local = (value: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
    assert.equal(local(stay!.checkinAt!), `${day(-10)}, 15:00`);
    assert.equal(local(stay!.checkoutAt!), `${day(-8)}, 11:00`);
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "RESERVATION_CREATED", entityId: reservationId } });
    assert.equal((audit?.afterJson as { historical?: boolean } | null)?.historical, true);
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY, status: "checked_out" } }), 1);
  });

  it("(6) permitirOverbooking crea la reserva por encima del cupo y RESERVATION_CREATED lleva afterJson.overbooking", async () => {
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_O } });
    assert.equal(preview.rows[0]?.status, "error");
    assert.deepEqual(preview.rows[0]?.availability, { totalRooms: 3, bookedDb: 3, bookedFile: 0, exceeds: true });
    const correlationId = `${CORR}_over`;
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_O, permitirOverbooking: true }, correlationId });
    importO = result.id;
    assert.equal(result.status, "imported");
    assert.equal(result.createdCount, 1);
    assert.ok(result.rows[0]!.warnings.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OVERBOOKING"));
    const reservation = await prisma.reservation.findUnique({ where: { id: result.rows[0]!.reservationId! } });
    assert.equal(reservation?.status, "confirmed");
    await flushAuditQueues();
    const audits = await prisma.auditEvent.findMany({ where: { correlationId, action: "RESERVATION_CREATED" } });
    assert.equal(audits.length, 1);
    assert.deepEqual((audits[0]!.afterJson as { overbooking?: unknown }).overbooking, { totalRooms: 3, bookedRooms: 3, requested: 1 });
  });

  it("(7) deshacer: activas → cancelled, con check-in previo → kept, histórica → kept; idempotente", async () => {
    await pms.checkInReservation({ context: checkinContext, reservationId: row1ReservationId, roomId: roomIds.get("201")!, signatureObjectKey: "sig-test", allowEarlyCheckIn: true, overrideReason: "prueba de integración", correlationId: CORR });
    assert.equal((await prisma.reservation.findUnique({ where: { id: row1ReservationId } }))?.status, "checked_in");

    const undo = await importService.undoReservationImport({ context, propertyId: PROPERTY, importId: importA, reason: "prueba", correlationId: CORR });
    assert.equal(undo.alreadyUndone, false);
    assert.equal(undo.status, "undone");
    assert.equal(undo.undoneCount, 1);
    assert.equal(undo.undoKeptCount, 1);
    assert.equal(undo.undoReason, "prueba");
    assert.equal(undo.undoneBy, USER);
    assert.ok(undo.undoneAt);
    assert.deepEqual(undo.cancelledReservationIds, [row6ReservationId]);
    assert.equal((await prisma.reservation.findUnique({ where: { id: row6ReservationId } }))?.status, "cancelled");
    assert.equal((await prisma.reservation.findUnique({ where: { id: row1ReservationId } }))?.status, "checked_in", "la alojada se conserva");
    const detail = await importService.getReservationImport({ context, propertyId: PROPERTY, importId: importA });
    const outcomes = new Map(detail.rows.map((row) => [row.rowNumber, row.undoOutcome]));
    assert.equal(outcomes.get(1), "kept");
    assert.equal(outcomes.get(5), "skipped", "ya estaba cancelada");
    assert.equal(outcomes.get(6), "cancelled");
    assert.equal(outcomes.get(7), null, "fila sin reserva");

    const again = await importService.undoReservationImport({ context, propertyId: PROPERTY, importId: importA, correlationId: CORR });
    assert.equal(again.alreadyUndone, true);
    assert.deepEqual(again.cancelledReservationIds, []);
    assert.equal(again.undoneCount, 1);

    const historical = await importService.undoReservationImport({ context, propertyId: PROPERTY, importId: importH, correlationId: CORR });
    assert.equal(historical.status, "undone");
    assert.equal(historical.undoneCount, 0);
    assert.equal(historical.undoKeptCount, 1);
    assert.equal((await prisma.reservationImportRow.findFirst({ where: { importId: importH } }))?.undoOutcome, "kept");
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: ORG, action: "RESERVATION_IMPORT_UNDONE" } }), 2);
  });

  it("(8) sin pms.reservation.modify → 403 al importar y deshacer (la preview marca las filas que lo exigen); listado, detalle y 404 opaco", async () => {
    await expectStatus(importService.importReservations({ context: createOnly, propertyId: PROPERTY, body: { format: "csv", content: CSV_O, permitirOverbooking: true }, correlationId: CORR }), 403);
    await expectStatus(importService.undoReservationImport({ context: createOnly, propertyId: PROPERTY, importId: importO, correlationId: CORR }), 403);
    const csvPermissions = csv([
      { llegada: day(50), salida: day(51), tipo_habitacion: "DBL", tarifa: "BAR", habitacion: "203", adultos: "2", nombre: "Iria", apellidos: "Castro Nuñez", email: "iria.castro@example.com", importe_total: "120,00" },
      { llegada: day(50), salida: day(51), tipo_habitacion: "IND", tarifa: "BAR", adultos: "1", estado: "cancelada", nombre: "Carla", apellidos: "Vidal Mato", email: "carla.vidal@example.com", importe_total: "90,00" },
      { llegada: day(50), salida: day(51), tipo_habitacion: "DBL", tarifa: "BAR", adultos: "2", nombre: "Sara", apellidos: "Piñeiro Vila", email: "sara.pineiro@example.com", importe_total: "120,00" }
    ]);
    const preview = await importService.previewReservationImport({ context: createOnly, propertyId: PROPERTY, body: { format: "csv", content: csvPermissions } });
    for (const n of [1, 2]) {
      assert.ok(preview.rows.find((row) => row.rowNumber === n)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_PERMISSION"), `fila ${n} exige modify (habitación / cancelada)`);
      assert.equal(preview.rows.find((row) => row.rowNumber === n)?.status, "error");
    }
    assert.equal(preview.rows.find((row) => row.rowNumber === 3)?.status, "valid", "sin habitación ni cancelación basta con create");
    const withModify = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: { format: "csv", content: csvPermissions } });
    assert.ok(withModify.rows.every((row) => !row.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_PERMISSION")));
    await expectStatus(importService.listReservationImports({ context: { ...createOnly, permissions: ["pms.reservation.create"] } as unknown as UserContext, propertyId: PROPERTY }), 403);

    const list = await importService.listReservationImports({ context, propertyId: PROPERTY });
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((row) => row.id).slice(0, 2), [importO, importH], "más recientes primero");
    const undone = await importService.listReservationImports({ context, propertyId: PROPERTY, query: { status: "undone", limit: 1 } });
    assert.equal(undone.length, 1);
    assert.equal(undone[0]?.status, "undone");
    const detail = await importService.getReservationImport({ context, propertyId: PROPERTY, importId: importA });
    assert.equal(detail.rows.length, 9);
    assert.deepEqual(detail.rows.map((row) => row.rowNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await expectStatus(importService.getReservationImport({ context, propertyId: PROPERTY, importId: "imp_inexistente" }), 404, "RESERVATION_IMPORT_NOT_FOUND");
    await expectStatus(importService.getReservationImport({ context: foreignContext, propertyId: PROPERTY, importId: importA }), 404);
    await expectStatus(importService.undoReservationImport({ context, propertyId: PROPERTY, importId: "imp_inexistente", correlationId: CORR }), 404, "RESERVATION_IMPORT_NOT_FOUND");
  });
});
