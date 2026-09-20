/**
 * OPERA Cloud · modo sombra · Tanda 7b · L1 — integración del modo `sync` del
 * importador de reservas (Postgres, en proceso, sin HTTP). Organización AISLADA
 * `org_ps_<run>` con una propiedad (código RIAS en OPERA), tipos DBL (201-203) e
 * IND (101), plan BAR, fila `business_dates` y un `PmsShadowProfile` con el
 * diccionario `roomTypes { DLX → DBL }`; todo creado aquí y borrado en `after`.
 * Ficheros SINTÉTICOS con las columnas literales de Oracle (huéspedes ficticios):
 *   (1) corte arrivals (Responsys, business date D): nueva Reserved, nueva Checked In
 *       con ROOM_NUMBER válido, nueva Checked In sin habitación, Waitlist → created 3 +
 *       skipped 1, 3 PmsShadowLink, checked_in con Stay in_house, aviso
 *       OPERA_CHECKIN_WITHOUT_ROOM, importe estimado RATE × noches, bookerEmail null,
 *       NAME_ON_CARD jamás persistido, 0 filas de correo / notificación;
 *   (2) mismo fichero con business date D+1 → todo unchanged (no `failed`), missingStreak
 *       0; el mismo fichero el MISMO día → 409 RESERVATION_IMPORT_DUPLICATE; sin la fila
 *       waitlist → `imported`;
 *   (3) corte con fechas cambiadas + una Cancelled + una ausente → updated 1 (auditoría
 *       RESERVATION_SHADOW_UPDATED sin PII), transitioned 1 (cancelada en OPERA),
 *       result.sync.missing 1 (missingStreak 1), fila updated sin reservationId y con
 *       reservationCode y diff SYNC_DIFF;
 *   (4) corte departures (departure_all SIN cabecera + headerOverride del perfil): Checked
 *       Out sobre la alojada → checked_out, folio cerrado, Stay cerrada;
 *   (5) deshacer del corte 3: no cancela lo creado en el corte 1 ni revierte la actualización;
 *   (6) reserva creada a mano con la misma referencia → OPERA_CONFLICT_LOCAL_RESERVATION;
 *   (7) 403 sin pms.checkin.execute; 400 sync sin feed; 400 HEADER_MISMATCH; 400 feed sin perfil.
 * Faranda y org_123 nunca se escriben. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/pms-shadow-sync.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "./helpers/local-day.mts";
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
const { OPERA_CLOUD_PROFILE, OPERA_CLOUD_RESPONSYS_HEADER, RESERVATION_IMPORT_SYNC_DIFF_CODE, RESERVATION_IMPORT_SYNC_TOTAL_COLUMN } = await import("@hotelos/shared");
const importService = await import("../../apps/api/src/modules/pms/reservation-import.service.js");
const pms = await import("../../apps/api/src/modules/pms/pms.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushNotificationHooks } = await import("../../apps/api/src/modules/notifications/event-hooks.service.js");

const RUN = Date.now().toString(36);
const ORG = `org_ps_${RUN}`;
const PROPERTY = `prop_ps_${RUN}`;
const USER = `usr_ps_${RUN}`;
const CORR = `corr_ps_${RUN}`;
const TIMEZONE = "Europe/Madrid";

const context = {
  organizationId: ORG,
  propertyId: PROPERTY,
  userId: USER,
  fullName: "Recepción PS",
  deviceId: "ps-test",
  permissions: ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify", "pms.checkin.execute", "pms.checkout.execute"]
} as unknown as UserContext;
const noCheckin = { ...context, permissions: ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify"] } as unknown as UserContext;

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

/** Hoy + n días en la ZONA DEL HOTEL: el servidor ancla el corte al día local de la propiedad (`localDateTime`, pms-shadow.service), no a UTC (flake 00:00-02:00 CEST · CIERRE-1 C4a). */
function day(offset: number): string {
  return localDay(offset, TIMEZONE);
}
/** Máscara `YYYYMMDD` del export Responsys. */
const ymd = (offset: number): string => day(offset).replace(/-/g, "");
/** `DD/MM/YYYY` del informe departure_all. */
const dmy = (offset: number): string => day(offset).split("-").reverse().join("/");
const TODAY = day(0);

type RespColumn = (typeof OPERA_CLOUD_RESPONSYS_HEADER)[number];
type RespRow = Partial<Record<RespColumn, string>>;

/** Export RESPONSYS_RESV_AUTO sintético: las 33 columnas literales, separador «,». */
function responsys(rows: readonly RespRow[], header: readonly string[] = OPERA_CLOUD_RESPONSYS_HEADER): string {
  return [header.join(","), ...rows.map((row) => OPERA_CLOUD_RESPONSYS_HEADER.map((column) => row[column] ?? "").join(","))].join("\r\n") + "\r\n";
}

const PII = ["Ferreiro", "Lucía", "Lucia", "Nowak", "Marek", "Piñeiro", "Sara", "Lema", "Pedro", "Castro", "Iria", "LUCIA FERREIRO"];

function assertNoPii(text: string | null | undefined, where: string): void {
  if (!text) return;
  for (const token of PII) assert.ok(!text.toLowerCase().includes(token.toLowerCase()), `${where} contiene «${token}»: ${text}`);
}

// Fila A: nueva Reserved (llegada D+5), tipo DLX → DBL por el diccionario del PmsShadowProfile, RATE 120 × 2 noches.
const ROW_A: RespRow = { RESERVATION_ID: "RIAS-1001", GUEST_LAST_NAME: "Ferreiro Castro", GUEST_FIRST_NAME: "Lucía", BOOKING_SOURCE: "BDC", PROPERTY_NAME: "Hotel Rías Test", ARRIVAL_DATE: ymd(5), DEPARTURE_DATE: ymd(7), NUM_NIGHTS: "2", NUM_ADULTS: "2", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DLX", RATE: "120.00", PAYMENT_TYPE: "VI", NAME_ON_CARD: "LUCIA FERREIRO", RATE_CODE: "BAR", RESERVATION_STATUS: "Reserved" };
// Fila B: nueva Checked In con habitación 201 (llegada D+1, dentro de la ventana ±1 del check-in).
const ROW_B: RespRow = { RESERVATION_ID: "RIAS-1002", GUEST_LAST_NAME: "Nowak", GUEST_FIRST_NAME: "Marek", BOOKING_SOURCE: "WEB", ARRIVAL_DATE: ymd(1), DEPARTURE_DATE: ymd(3), NUM_NIGHTS: "2", NUM_ADULTS: "1", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DBL", ROOM_NUMBER: "201", RATE: "100.00", PAYMENT_TYPE: "CA", RATE_CODE: "BAR", RESERVATION_STATUS: "Checked In" };
// Fila C: nueva Checked In SIN habitación → permanece confirmada con aviso.
const ROW_C: RespRow = { RESERVATION_ID: "RIAS-1003", GUEST_LAST_NAME: "Piñeiro Vila", GUEST_FIRST_NAME: "Sara", BOOKING_SOURCE: "BDC", ARRIVAL_DATE: ymd(1), DEPARTURE_DATE: ymd(2), NUM_NIGHTS: "1", NUM_ADULTS: "2", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DBL", RATE: "110.00", PAYMENT_TYPE: "VI", RATE_CODE: "BAR", RESERVATION_STATUS: "Checked In" };
// Fila D: Waitlist → omitida.
const ROW_D: RespRow = { RESERVATION_ID: "RIAS-1004", GUEST_LAST_NAME: "Lema Souto", GUEST_FIRST_NAME: "Pedro", BOOKING_SOURCE: "WEB", ARRIVAL_DATE: ymd(10), DEPARTURE_DATE: ymd(12), NUM_NIGHTS: "2", NUM_ADULTS: "1", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "IND", RATE: "80.00", RATE_CODE: "BAR", RESERVATION_STATUS: "Waitlist" };

const CSV_CUT1 = responsys([ROW_A, ROW_B, ROW_C, ROW_D]);
const CSV_CUT2B = responsys([ROW_A, ROW_B, ROW_C]);
// Corte 3: A se mueve un día (D+6 → D+8), C cancelada en OPERA, B ausente, D sigue en waitlist.
const CSV_CUT3 = responsys([{ ...ROW_A, ARRIVAL_DATE: ymd(6), DEPARTURE_DATE: ymd(8) }, { ...ROW_C, RESERVATION_STATUS: "Cancelled" }, ROW_D]);
// Corte 4: departure_all SIN fila de cabecera (Delimited Data), 19 columnas, «;».
const DEPARTURES_LINES = [
  ["201", "Marek Nowak", "", "", "", "", dmy(1), dmy(3), "1", "0", "1", "2", "DBL", "", "BAR", "Checked Out", "11:00", "CA", "0.00"],
  ["202", "Sara Piñeiro", "", "", "", "", dmy(1), dmy(3), "2", "0", "1", "2", "DBL", "", "BAR", "Checked Out", "10:30", "VI", "0.00"]
];
const CSV_CUT4 = DEPARTURES_LINES.map((cells) => cells.join(";")).join("\r\n") + "\r\n";

function syncBody(content: string, businessDate: string, extra: Record<string, unknown> = {}) {
  return { format: "csv" as const, fileName: "RESPONSYS_RESV_AUTO.csv", content, mode: "sync" as const, profile: "opera_cloud" as const, feed: "arrivals" as const, businessDate, ...extra };
}

let dblId = "";
let indId = "";
let barId = "";
const roomIds = new Map<string, string>();

async function cleanup(): Promise<void> {
  await prisma.pmsShadowLink.deleteMany({ where: { propertyId: PROPERTY } });
  await prisma.pmsShadowProfile.deleteMany({ where: { propertyId: PROPERTY } });
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
  await prisma.notificationDelivery.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "PS Hoteles Test", country: "ES" } });
  await prisma.property.create({ data: { id: PROPERTY, organizationId: ORG, kind: "hotel", code: "PS", name: "Hotel Rías Test", timezone: TIMEZONE, currency: "EUR" } });
  dblId = (await prisma.roomType.create({ data: { propertyId: PROPERTY, code: "DBL", name: "Doble", maxOccupancy: 2, baseCapacity: 2, active: true }, select: { id: true } })).id;
  indId = (await prisma.roomType.create({ data: { propertyId: PROPERTY, code: "IND", name: "Individual", maxOccupancy: 1, baseCapacity: 1, active: true }, select: { id: true } })).id;
  for (const [number, roomTypeId] of [["201", dblId], ["202", dblId], ["203", dblId], ["101", indId]] as const) {
    const room = await prisma.room.create({ data: { propertyId: PROPERTY, roomTypeId, number, sellable: true, maintenanceStatus: "ok" }, select: { id: true } });
    roomIds.set(number, room.id);
  }
  barId = (await prisma.ratePlan.create({ data: { propertyId: PROPERTY, code: "BAR", name: "Best Available Rate", ratePlanType: "bar", active: true }, select: { id: true } })).id;
  for (const offset of [1, 2, 3, 5, 6, 7]) {
    for (const roomTypeId of [dblId, indId]) {
      await prisma.rateDay.create({ data: { propertyId: PROPERTY, ratePlanId: barId, roomTypeId, date: new Date(`${day(offset)}T00:00:00.000Z`), price: "100.00", currency: "EUR", source: "manual" } });
    }
  }
  await prisma.businessDate.create({ data: { propertyId: PROPERTY, currentDate: new Date(`${TODAY}T00:00:00.000Z`) } });
  // Perfil de modo sombra OPCIONAL en L1: aquí solo aporta el diccionario de room types (DLX → DBL).
  await prisma.pmsShadowProfile.create({
    data: { organizationId: ORG, propertyId: PROPERTY, system: "opera_cloud", operaHotelCode: "RIAS", status: "active", mappingJson: { roomTypes: { DLX: "DBL" }, pseudoRoomTypes: ["PM"] } }
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushNotificationHooks();
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
});

describe("modo sombra OPERA · sync del importador · organización aislada (DBL 201-203, IND 101, BAR, perfil RIAS)", () => {
  let import1 = "";
  let import3 = "";
  let reservationA = { id: "", code: "" };
  let reservationB = { id: "", code: "" };
  let reservationC = { id: "", code: "" };

  it("preview sync: perfil aplicado (33 columnas + importe estimado), acciones create, waitlist omitida, nada escrito", async () => {
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, TODAY) });
    assert.equal(preview.header.length, 34, "33 columnas literales + la sintética de importe estimado");
    assert.equal(preview.header.at(-1), RESERVATION_IMPORT_SYNC_TOTAL_COLUMN);
    assert.equal(preview.mapping.RESERVATION_ID, "referencia_externa");
    assert.equal(preview.mapping.RATE, null);
    assert.equal(preview.mapping[RESERVATION_IMPORT_SYNC_TOTAL_COLUMN], "importe_total");
    assert.equal(preview.mapping.NAME_ON_CARD, null);
    assert.deepEqual(preview.missingRequired, []);
    assert.equal(preview.rowCount, 4);
    assert.deepEqual(preview.summary, { valid: 0, warning: 3, error: 0, skipped: 1, historical: 0, toCreate: 3, toUpdate: 0, unchanged: 0, toTransition: 0 });
    const byRow = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    assert.equal(byRow.get(1)?.resolved?.sync?.action, "create");
    assert.equal(byRow.get(1)?.resolved?.sync?.targetStatus, "confirmed");
    assert.equal(byRow.get(1)?.resolved?.sync?.totalEstimated, true);
    assert.equal(byRow.get(1)?.resolved?.roomTypeCode, "DBL", "DLX → DBL por el diccionario del PmsShadowProfile");
    assert.equal(byRow.get(1)?.resolved?.totalAmount, "240.00", "RATE 120 × 2 noches × 1 habitación");
    assert.equal(byRow.get(1)?.resolved?.totalSource, "file");
    assert.equal(byRow.get(1)?.normalized?.channel, "booking_com", "BDC → booking_com por el perfil");
    assert.equal(byRow.get(1)?.normalized?.paymentMethod, "credit_card", "VI → credit_card");
    assert.equal(byRow.get(1)?.normalized?.rateFirstNight, "120.00");
    assert.ok(byRow.get(1)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED"));
    assert.equal(byRow.get(2)?.resolved?.sync?.targetStatus, "checked_in");
    assert.equal(byRow.get(2)?.resolved?.roomNumber, "201");
    assert.equal(byRow.get(2)?.normalized?.inHouse, undefined, "llegada mañana: no está en curso todavía");
    assert.equal(byRow.get(3)?.status, "warning");
    assert.ok(byRow.get(3)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM"));
    assert.equal(byRow.get(4)?.status, "skipped");
    assert.ok(byRow.get(4)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED"));
    assert.equal(preview.canImport, true);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.options.mode, "sync");
    assert.equal(preview.options.feed, "arrivals");
    assert.equal(preview.options.businessDate, TODAY);
    assert.equal(preview.options.horizonDays, 30);
    assert.ok(!preview.warnings.some((warning) => /sin mapear se ignoran/.test(warning)), "las columnas ignoradas por el perfil no generan aviso");
    for (const row of preview.rows) for (const issue of row.issues) assertNoPii(issue.message, `fila ${row.rowNumber}`);
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY } }), 0);
    assert.equal(await prisma.pmsShadowLink.count({ where: { propertyId: PROPERTY } }), 0);
  });

  it("(1) corte arrivals D → created 3 + skipped 1, 3 enlaces, check-in con Stay, aviso sin habitación, bookerEmail null, 0 correos", async () => {
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, TODAY), correlationId: `${CORR}-1`, source: "http", shadowRunId: "run_ps_1" });
    import1 = result.id;
    assert.equal(result.status, "partial", "3 creadas + 1 omitida (waitlist)");
    assert.equal(result.createdCount, 3);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.errorCount, 0);
    assert.equal(result.options.mode, "sync");
    assert.equal(result.options.profile, "opera_cloud");
    assert.equal(result.options.feed, "arrivals");
    assert.equal(result.options.businessDate, TODAY);
    assert.equal(result.options.shadowRunId, "run_ps_1");
    assert.deepEqual(result.options.sync, { updated: 0, unchanged: 0, transitioned: 0 });
    assert.ok(result.sync, "bloque sync del resultado");
    assert.deepEqual(result.sync?.counts, { created: 3, updated: 0, unchanged: 0, transitioned: 0, skipped: 1, error: 0 });
    assert.deepEqual(result.sync?.missing, []);
    assert.deepEqual(result.sync?.conflicts, []);
    assert.equal(result.sync?.feed, "arrivals");
    assert.equal(result.sync?.businessDate, TODAY);

    const rows = new Map(result.rows.map((row) => [row.rowNumber, row]));
    assert.equal(rows.get(1)?.outcome, "created");
    assert.equal(rows.get(1)?.externalReference, "RIAS-1001");
    assert.equal(rows.get(1)?.roomTypeCode, "DBL");
    assert.equal(rows.get(2)?.outcome, "created");
    assert.equal(rows.get(3)?.outcome, "created");
    assert.ok(rows.get(3)?.warnings.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM"));
    assert.equal(rows.get(4)?.outcome, "skipped");
    assert.equal(rows.get(4)?.errorCode, "RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED");
    assert.equal(rows.get(4)?.reservationId, null);
    reservationA = { id: rows.get(1)!.reservationId!, code: rows.get(1)!.reservationCode! };
    reservationB = { id: rows.get(2)!.reservationId!, code: rows.get(2)!.reservationCode! };
    reservationC = { id: rows.get(3)!.reservationId!, code: rows.get(3)!.reservationCode! };
    assert.deepEqual(result.sync?.checkInWithoutRoom, [{ confirmationNo: "RIAS-1003", reservationCode: reservationC.code }]);
    for (const row of result.rows) {
      assertNoPii(row.errorMessage, `fila ${row.rowNumber}`);
      for (const issue of row.warnings) assertNoPii(issue.message, `fila ${row.rowNumber}`);
    }

    const a = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA.id } });
    assert.equal(a.status, "confirmed");
    assert.equal(a.bookingSource, `import:${import1}`, "bookingSource sigue siendo import:<importId>");
    assert.equal(a.externalReference, "RIAS-1001");
    assert.equal(a.roomTypeId, dblId);
    assert.equal(a.ratePlanId, barId);
    assert.equal(Number(a.totalAmount), 240);
    assert.equal(a.channel, "booking_com");
    assert.equal(a.paymentMethod, "credit_card");
    assert.equal(a.bookerEmail, null);
    assert.ok(!JSON.stringify(a).includes("LUCIA FERREIRO"), "NAME_ON_CARD nunca se persiste");
    const b = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationB.id } });
    assert.equal(b.status, "checked_in");
    assert.equal(b.assignedRoomId, roomIds.get("201"));
    assert.equal(b.bookerEmail, null);
    const stay = await prisma.stay.findFirst({ where: { reservationId: reservationB.id } });
    assert.equal(stay?.status, "in_house");
    assert.equal(stay?.roomId, roomIds.get("201"));
    const room201 = await prisma.room.findUniqueOrThrow({ where: { id: roomIds.get("201")! } });
    assert.equal(room201.status, "occupied");
    const c = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationC.id } });
    assert.equal(c.status, "confirmed", "sin habitación válida permanece confirmada");
    assert.equal(c.assignedRoomId, null);

    const links = await prisma.pmsShadowLink.findMany({ where: { propertyId: PROPERTY }, orderBy: { confirmationNo: "asc" } });
    assert.equal(links.length, 3);
    assert.deepEqual(links.map((link) => [link.confirmationNo, link.lastStatus, link.missingStreak, link.firstImportId, link.lastImportId]), [
      ["RIAS-1001", "confirmed", 0, import1, import1],
      ["RIAS-1002", "checked_in", 0, import1, import1],
      ["RIAS-1003", "confirmed", 0, import1, import1]
    ]);
    assert.equal(links[0]?.reservationId, reservationA.id);
    assert.equal(links[0]?.lastBusinessDate.toISOString().slice(0, 10), TODAY);
    assert.match(links[0]?.rowHash ?? "", /^[0-9a-f]{64}$/);
    assert.equal(links[0]?.organizationId, ORG);

    await flushAuditQueues();
    await flushNotificationHooks();
    assert.equal(await prisma.notificationDelivery.count({ where: { organizationId: ORG } }), 0, "cero correos al huésped");
    assert.equal(await prisma.notification.count({ where: { propertyId: PROPERTY } }), 0);
    assert.equal(await prisma.inboundEmail.count({ where: { propertyId: PROPERTY } }), 0);
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "RESERVATION_IMPORT_COMMITTED", entityId: import1 } });
    assert.ok(audit, "auditoría del lote");
    const after = audit.afterJson as Record<string, unknown>;
    assert.equal(after.mode, "sync");
    assert.equal(after.feed, "arrivals");
    assert.equal(after.businessDate, TODAY);
    assert.deepEqual(after.sync, { created: 3, updated: 0, unchanged: 0, transitioned: 0, skipped: 1, error: 0, missing: 0, conflicts: 0 });
    assertNoPii(JSON.stringify(audit.afterJson), "afterJson del lote");
    const checkIn = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "GUEST_CHECKED_IN", entityId: reservationB.id } });
    assert.ok(checkIn, "check-in auditado por checkInReservation");
    const checkInWindow = ((checkIn.afterJson as Record<string, unknown>).checkInWindow ?? {}) as Record<string, unknown>;
    assert.match(String(checkInWindow.overrideReason), /Check-in registrado en OPERA \(corte /);
  });

  it("(2) mismo fichero con business date D+1 → todo unchanged, missingStreak 0; mismo fichero el mismo día → 409; sin waitlist → imported", async () => {
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, day(1)), correlationId: `${CORR}-2`, source: "job" });
    assert.notEqual(result.status, "failed");
    assert.equal(result.status, "partial", "3 sin cambios + la waitlist omitida");
    assert.equal(result.createdCount, 0);
    assert.deepEqual(result.sync?.counts, { created: 0, updated: 0, unchanged: 3, transitioned: 0, skipped: 1, error: 0 });
    assert.deepEqual(result.options.sync, { updated: 0, unchanged: 3, transitioned: 0 });
    assert.equal(result.options.source, "job");
    assert.deepEqual(result.sync?.missing, []);
    const rows = new Map(result.rows.map((row) => [row.rowNumber, row]));
    assert.equal(rows.get(1)?.outcome, "unchanged");
    assert.equal(rows.get(1)?.reservationId, null, "solo la fila que crea lleva reservationId (único)");
    assert.equal(rows.get(1)?.reservationCode, reservationA.code);
    assert.equal(rows.get(2)?.reservationCode, reservationB.code);
    assert.equal(result.contentHash.length, 64);
    const links = await prisma.pmsShadowLink.findMany({ where: { propertyId: PROPERTY } });
    assert.ok(links.every((link) => link.missingStreak === 0));
    assert.ok(links.every((link) => link.lastBusinessDate.toISOString().slice(0, 10) === day(1)));
    assert.ok(links.every((link) => link.lastImportId === import1), "unchanged solo toca lastSeenAt / lastBusinessDate / missingStreak");
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY } }), 3, "nada creado");

    // Idempotencia por corte: el MISMO fichero con el MISMO business date es el mismo lote.
    const details = await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, day(1)), correlationId: `${CORR}-2b`, source: "job" }), 409, "RESERVATION_IMPORT_DUPLICATE");
    assert.equal(details.importId, result.id);
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, day(1)) });
    assert.equal(preview.duplicates.ofImport?.importId, result.id);
    assert.equal(preview.canImport, false);

    const clean = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT2B, day(1)), correlationId: `${CORR}-2c`, source: "job" });
    assert.equal(clean.status, "imported", "un corte en el que todo está unchanged no es failed");
    assert.deepEqual(clean.sync?.counts, { created: 0, updated: 0, unchanged: 3, transitioned: 0, skipped: 0, error: 0 });
  });

  it("(3) fechas cambiadas + Cancelled + ausente → updated 1 (auditoría sin PII), transitioned 1, missing 1", async () => {
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT3, day(1)), correlationId: `${CORR}-3`, source: "http" });
    import3 = result.id;
    assert.equal(result.status, "partial");
    assert.deepEqual(result.sync?.counts, { created: 0, updated: 1, unchanged: 0, transitioned: 1, skipped: 1, error: 0 });
    assert.deepEqual(result.sync?.missing, [{ confirmationNo: "RIAS-1002", reservationCode: reservationB.code, arrivalDate: day(1), missingStreak: 1 }]);
    const rows = new Map(result.rows.map((row) => [row.rowNumber, row]));
    const rowA = rows.get(1)!;
    assert.equal(rowA.outcome, "updated");
    assert.equal(rowA.reservationId, null);
    assert.equal(rowA.reservationCode, reservationA.code);
    assert.equal(rowA.arrivalDate, day(6));
    const diff = rowA.warnings.find((issue) => (issue.code as string) === RESERVATION_IMPORT_SYNC_DIFF_CODE) as (typeof rowA.warnings)[number] & { fields?: string[] };
    assert.ok(diff, "entrada SYNC_DIFF en warningsJson");
    assert.deepEqual(diff.fields, ["arrivalDate", "departureDate"]);
    assert.ok(!diff.message.includes(day(6)), "el diff no lleva valores");
    const rowC = rows.get(2)!;
    assert.equal(rowC.outcome, "transitioned");
    assert.equal(rowC.reservationId, null);
    assert.equal(rowC.reservationCode, reservationC.code);
    assert.equal(rows.get(3)?.outcome, "skipped");

    const a = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA.id } });
    assert.equal(a.arrivalDate.toISOString().slice(0, 10), day(6));
    assert.equal(a.departureDate.toISOString().slice(0, 10), day(8));
    assert.equal(a.status, "confirmed");
    assert.equal(a.bookerEmail, null);
    const c = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationC.id } });
    assert.equal(c.status, "cancelled");
    const links = new Map((await prisma.pmsShadowLink.findMany({ where: { propertyId: PROPERTY } })).map((link) => [link.confirmationNo, link]));
    assert.equal(links.get("RIAS-1001")?.lastImportId, import3);
    assert.equal(links.get("RIAS-1001")?.lastStatus, "confirmed");
    assert.equal(links.get("RIAS-1002")?.missingStreak, 1, "ausente del corte: alerta, no cancelación");
    const b = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationB.id } });
    assert.equal(b.status, "checked_in", "la ausente sigue alojada");
    assert.equal(links.get("RIAS-1003")?.lastStatus, "cancelled");
    assert.equal(links.get("RIAS-1003")?.missingStreak, 0);

    await flushAuditQueues();
    await flushNotificationHooks();
    const shadow = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "RESERVATION_SHADOW_UPDATED", entityId: reservationA.id } });
    assert.ok(shadow, "RESERVATION_SHADOW_UPDATED");
    assert.deepEqual(shadow.beforeJson, { arrivalDate: day(5), departureDate: day(7) });
    const after = shadow.afterJson as Record<string, unknown>;
    assert.equal(after.arrivalDate, day(6));
    assert.equal(after.departureDate, day(8));
    assert.deepEqual(after.changedFields, ["arrivalDate", "departureDate"]);
    assert.deepEqual(after.ignoredFields, []);
    assert.equal(after.confirmationNo, "RIAS-1001");
    assert.match(String(after.reason), /Sincronizada desde OPERA \(corte /);
    assertNoPii(JSON.stringify(shadow), "RESERVATION_SHADOW_UPDATED");
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: ORG, action: "RESERVATION_UPDATED", entityId: reservationA.id } }), 0, "no pasa por patchReservation");
    const cancelled = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "RESERVATION_CANCELLED", entityId: reservationC.id } });
    assert.equal((cancelled?.afterJson as Record<string, unknown>).reason, `Cancelada en OPERA · ${day(1)}`);
    assert.equal(await prisma.notificationDelivery.count({ where: { organizationId: ORG } }), 0, "seguimos a 0 correos");
  });

  it("(4) departures sin cabecera + headerOverride del perfil: Checked Out sobre la alojada → checked_out, folio cerrado, Stay cerrada", async () => {
    const body = { format: "csv" as const, fileName: "departure_all.csv", content: CSV_CUT4, mode: "sync" as const, profile: "opera_cloud" as const, feed: "departures" as const, businessDate: day(3), headerOverride: [...OPERA_CLOUD_PROFILE.feeds.departures!.headerless!], omitirInvalidas: true };
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body });
    assert.equal(preview.rowCount, 2, "la primera línea del fichero es una fila de datos");
    assert.equal(preview.header.length, 20, "19 columnas del perfil + __referencia_externa");
    assert.equal(preview.mapping["Room No."], "habitacion");
    assert.equal(preview.mapping.Name, "nombre");
    assert.equal(preview.splitName, true);
    const rows = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    assert.equal(rows.get(1)?.resolved?.externalReference, "RIAS-1002", "casada por (201, llegada, salida) con el enlace vivo");
    assert.equal(rows.get(1)?.resolved?.sync?.action, "transition");
    assert.equal(rows.get(1)?.resolved?.sync?.targetStatus, "checked_out");
    assert.equal(rows.get(1)?.resolved?.sync?.currentStatus, "checked_in");
    assert.equal(rows.get(1)?.resolved?.sync?.reservationCode, reservationB.code);
    assert.equal(rows.get(2)?.status, "error", "la 202 no tiene enlace → sin referencia");
    assert.ok(rows.get(2)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE"));
    assert.deepEqual(preview.summary, { valid: 0, warning: 1, error: 1, skipped: 0, historical: 0, toCreate: 0, toUpdate: 1, unchanged: 0, toTransition: 1 });
    assert.ok(!preview.warnings.some((warning) => /cabecera repite/.test(warning)));

    const result = await importService.importReservations({ context, propertyId: PROPERTY, body, correlationId: `${CORR}-4`, source: "email" });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.sync?.counts, { created: 0, updated: 0, unchanged: 0, transitioned: 1, skipped: 1, error: 0 });
    assert.equal(result.sync?.feed, "departures");
    const row1 = result.rows.find((row) => row.rowNumber === 1)!;
    assert.equal(row1.outcome, "transitioned");
    assert.equal(row1.reservationId, null);
    assert.equal(row1.reservationCode, reservationB.code);
    assert.equal(result.rows.find((row) => row.rowNumber === 2)?.errorCode, "RESERVATION_IMPORT_ROW_INVALID_SKIPPED");

    const b = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationB.id } });
    assert.equal(b.status, "checked_out");
    const folio = await prisma.folio.findFirst({ where: { reservationId: reservationB.id } });
    assert.equal(folio?.status, "closed");
    const stay = await prisma.stay.findFirst({ where: { reservationId: reservationB.id } });
    assert.equal(stay?.status, "checked_out");
    assert.ok(stay?.checkoutAt, "Stay cerrada");
    const room201 = await prisma.room.findUniqueOrThrow({ where: { id: roomIds.get("201")! } });
    assert.equal(room201.status, "dirty");
    const link = await prisma.pmsShadowLink.findUniqueOrThrow({ where: { reservationId: reservationB.id } });
    assert.equal(link.lastStatus, "checked_out");
    assert.equal(link.missingStreak, 0, "reaparecer pone la racha a 0");
    await flushAuditQueues();
    assert.ok(await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "GUEST_CHECKED_OUT", entityId: reservationB.id } }));
    assert.ok(await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "FOLIO_CLOSED", entityId: folio!.id } }), "cierre del folio principal como la ruta de check-out");
  });

  it("(5) deshacer el corte 3 no cancela lo creado en el corte 1 ni revierte la actualización (OPERA manda)", async () => {
    const undo = await importService.undoReservationImport({ context, propertyId: PROPERTY, importId: import3, reason: "prueba", correlationId: `${CORR}-5` });
    assert.equal(undo.alreadyUndone, false);
    assert.deepEqual(undo.cancelledReservationIds, [], "el corte 3 no creó ninguna reserva");
    assert.equal(undo.status, "undone");
    const a = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA.id } });
    assert.equal(a.status, "confirmed");
    assert.equal(a.arrivalDate.toISOString().slice(0, 10), day(6), "la actualización no se revierte");
    const c = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationC.id } });
    assert.equal(c.status, "cancelled");
    assert.equal(await prisma.pmsShadowLink.count({ where: { propertyId: PROPERTY } }), 3, "los enlaces se conservan");
  });

  it("(6) reserva creada a mano con la misma referencia → OPERA_CONFLICT_LOCAL_RESERVATION y no se toca", async () => {
    const manual = await pms.createReservation({
      context,
      propertyId: PROPERTY,
      roomTypeId: dblId,
      arrivalDate: day(20),
      departureDate: day(21),
      adults: 1,
      externalReference: "RIAS-2001",
      primaryGuest: { firstName: "Iria", surname1: "Castro" },
      correlationId: `${CORR}-6a`
    });
    const rowE: RespRow = { RESERVATION_ID: "RIAS-2001", GUEST_LAST_NAME: "Castro", GUEST_FIRST_NAME: "Iria", ARRIVAL_DATE: ymd(20), DEPARTURE_DATE: ymd(21), NUM_NIGHTS: "1", NUM_ADULTS: "1", NUM_ROOMS: "1", ROOM_TYPE: "DBL", RATE: "90.00", RATE_CODE: "BAR", RESERVATION_STATUS: "Reserved" };
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(responsys([{ ...ROW_A, ARRIVAL_DATE: ymd(6), DEPARTURE_DATE: ymd(8) }, rowE]), day(2)), correlationId: `${CORR}-6b`, source: "api_key" });
    assert.deepEqual(result.sync?.counts, { created: 0, updated: 0, unchanged: 1, transitioned: 0, skipped: 1, error: 0 });
    assert.deepEqual(result.sync?.conflicts, [{ rowNumber: 2, confirmationNo: "RIAS-2001", reservationCode: manual.code }]);
    const row = result.rows.find((entry) => entry.rowNumber === 2)!;
    assert.equal(row.outcome, "skipped");
    assert.equal(row.errorCode, "RESERVATION_IMPORT_ROW_OPERA_CONFLICT_LOCAL_RESERVATION");
    assert.match(row.errorMessage ?? "", new RegExp(manual.code));
    assertNoPii(row.errorMessage, "fila en conflicto");
    const untouched = await prisma.reservation.findUniqueOrThrow({ where: { id: manual.id } });
    assert.equal(untouched.status, "confirmed");
    assert.equal(untouched.arrivalDate.toISOString().slice(0, 10), day(20));
    assert.equal(await prisma.pmsShadowLink.count({ where: { reservationId: manual.id } }), 0, "nunca se enlaza una reserva local");
  });

  it("(7) guardas: 403 sin pms.checkin.execute; 400 sync sin feed; 400 HEADER_MISMATCH; 400 feed sin perfil; preview con blocker", async () => {
    await expectStatus(importService.importReservations({ context: noCheckin, propertyId: PROPERTY, body: syncBody(CSV_CUT1, day(2)), correlationId: `${CORR}-7a` }), 403);
    await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: { format: "csv", content: CSV_CUT1, mode: "sync", profile: "opera_cloud" }, correlationId: `${CORR}-7b` }), 400, "RESERVATION_IMPORT_SYNC_REQUIRES_FEED");
    await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, "2026-13-40"), correlationId: `${CORR}-7c` }), 400, "RESERVATION_IMPORT_SYNC_REQUIRES_FEED");
    const renamed = responsys([ROW_A], OPERA_CLOUD_RESPONSYS_HEADER.map((column) => (column === "RESERVATION_ID" ? "RESV_ID" : column)));
    const mismatch = await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(renamed, day(2)), correlationId: `${CORR}-7d` }), 400, "RESERVATION_IMPORT_HEADER_MISMATCH");
    assert.equal((mismatch.expected as string[]).length, 33);
    // SEC-02: solo conteos y columnas del perfil ausentes; nunca las celdas recibidas (con «Delimited Data» sin cabecera serían datos del huésped).
    assert.equal(mismatch.receivedCount, 33);
    assert.equal(mismatch.unknownCount, 1);
    assert.deepEqual(mismatch.missingProfileColumns, ["RESERVATION_ID"]);
    assert.equal(mismatch.received, undefined);
    assert.equal(mismatch.unknownColumns, undefined);
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: syncBody(renamed, day(2)) });
    assert.equal(preview.canImport, false);
    assert.equal(preview.blockers[0]?.code, "RESERVATION_IMPORT_HEADER_MISMATCH");
    await expectStatus(importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(CSV_CUT1, day(2), { feed: "inhouse" }), correlationId: `${CORR}-7e` }), 400, "RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED");
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY } }), 4, "ninguna guarda escribió");
  });

  it("(8) corrector 7b · SC-01 una fila PRESENTE pero inválida no es ausente · SC-03 rate code sin mapear → BAR + aviso + alerta, room type sin mapear → error + alerta", async () => {
    // RIAS-1001 (enlazada, llegada D+6 en ventana) viene en el corte con un room type sin mapear (fila en error) y
    // RIAS-1006 es nueva con un rate code sin entrada en el perfil ni en RatePlan.code.
    const rowF: RespRow = { RESERVATION_ID: "RIAS-1006", GUEST_LAST_NAME: "Otero Blanco", GUEST_FIRST_NAME: "Xoán", BOOKING_SOURCE: "WEB", ARRIVAL_DATE: ymd(15), DEPARTURE_DATE: ymd(16), NUM_NIGHTS: "1", NUM_ADULTS: "1", NUM_CHILDREN: "0", NUM_ROOMS: "1", ROOM_TYPE: "DBL", RATE: "95.00", PAYMENT_TYPE: "CA", RATE_CODE: "CORP", RESERVATION_STATUS: "Reserved" };
    const csv = responsys([{ ...ROW_A, ARRIVAL_DATE: ymd(6), DEPARTURE_DATE: ymd(8), ROOM_TYPE: "XYZ" }, rowF]);
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: syncBody(csv, day(3)) });
    const rows = new Map(preview.rows.map((row) => [row.rowNumber, row]));
    assert.equal(rows.get(1)?.status, "error", "room type sin mapear → error");
    assert.ok(rows.get(1)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN" && issue.details?.roomTypeCode === "XYZ"));
    assert.equal(rows.get(2)?.status, "warning", "rate code sin mapear → tarifa por defecto + aviso, no error");
    assert.ok(rows.get(2)?.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_RATE_CODE_UNMAPPED" && issue.details?.rateCode === "CORP" && issue.details?.ratePlanCode === "BAR"));
    assert.equal(rows.get(2)?.resolved?.ratePlanCode, "BAR");
    assert.equal(rows.get(2)?.resolved?.sync?.action, "create");

    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(csv, day(3), { omitirInvalidas: true }), correlationId: `${CORR}-8` });
    assert.deepEqual(result.sync?.counts, { created: 1, updated: 0, unchanged: 0, transitioned: 0, skipped: 1, error: 0 });
    assert.deepEqual(result.sync?.missing, [], "SC-01: RIAS-1001 está en el corte (inválida) → no es ausente");
    assert.deepEqual(result.sync?.unmappedRateCodes, ["CORP"]);
    assert.deepEqual(result.sync?.unmappedRoomTypes, ["XYZ"]);
    const linkA = await prisma.pmsShadowLink.findFirstOrThrow({ where: { propertyId: PROPERTY, confirmationNo: "RIAS-1001" } });
    assert.equal(linkA.missingStreak, 0, "SC-01: missingStreak no sube por una fila presente pero inválida");
    // `Reservation` no tiene relación `ratePlan` en el schema: se resuelve por `ratePlanId`.
    const created = await prisma.reservation.findFirstOrThrow({ where: { propertyId: PROPERTY, externalReference: "RIAS-1006" }, select: { ratePlanId: true } });
    const createdRatePlan = created.ratePlanId ? await prisma.ratePlan.findUnique({ where: { id: created.ratePlanId }, select: { code: true } }) : null;
    assert.equal(createdRatePlan?.code, "BAR");
    assert.equal(result.rows.find((row) => row.rowNumber === 1)?.errorCode, "RESERVATION_IMPORT_ROW_INVALID_SKIPPED");
    const { buildAlertsFromSyncResult } = await import("../../apps/api/src/modules/pms-shadow/pms-shadow.rules.js");
    const alerts = buildAlertsFromSyncResult(result.sync, { id: null, feed: "arrivals", businessDate: day(3) });
    assert.deepEqual(alerts.map((alert) => alert.code).sort(), ["OPERA_RATE_CODE_UNMAPPED", "OPERA_ROOM_TYPE_UNMAPPED"]);
    for (const alert of alerts) assertNoPii(alert.message, alert.code);
  });

  it("(9) integrador 7b · pseudo room del perfil (PM) → fila OMITIDA con OPERA_PSEUDO_ROOM, sin ROOM_TYPE_UNKNOWN ni OPERA_ROOM_TYPE_UNMAPPED", async () => {
    const rowPm: RespRow = { RESERVATION_ID: "RIAS-1007", GUEST_LAST_NAME: "House Use", GUEST_FIRST_NAME: "Mantenimiento", ARRIVAL_DATE: ymd(15), DEPARTURE_DATE: ymd(16), NUM_NIGHTS: "1", NUM_ADULTS: "1", NUM_ROOMS: "1", ROOM_TYPE: "PM", RATE: "0.00", RATE_CODE: "BAR", RESERVATION_STATUS: "Reserved" };
    const csv = responsys([{ ...ROW_A, ARRIVAL_DATE: ymd(6), DEPARTURE_DATE: ymd(8) }, rowPm]);
    const preview = await importService.previewReservationImport({ context, propertyId: PROPERTY, body: syncBody(csv, day(4)) });
    const pm = preview.rows.find((row) => row.rowNumber === 2)!;
    assert.equal(pm.status, "skipped", "omitida por diseño, no error");
    assert.ok(pm.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM"));
    assert.ok(!pm.issues.some((issue) => issue.code === "RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN"), "la celda PM no es un tipo desconocido: es una pseudo room");
    const result = await importService.importReservations({ context, propertyId: PROPERTY, body: syncBody(csv, day(4), { omitirInvalidas: true }), correlationId: `${CORR}-9` });
    assert.deepEqual(result.sync?.counts, { created: 0, updated: 0, unchanged: 1, transitioned: 0, skipped: 1, error: 0 });
    assert.equal(result.sync?.unmappedRoomTypes, undefined, "PM no cuenta como room type sin mapear");
    assert.equal(result.rows.find((row) => row.rowNumber === 2)?.errorCode, "RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM");
    assert.equal(await prisma.reservation.count({ where: { propertyId: PROPERTY, externalReference: "RIAS-1007" } }), 0, "nada creado para la pseudo room");
  });
});
