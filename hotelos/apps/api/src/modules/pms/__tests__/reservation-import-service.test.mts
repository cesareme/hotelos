// Unit tests · Tanda 7 · L2 — helpers puros del servicio de importación:
// `deriveImportStatus`, `sanitizeRowError` (sin PII, sin texto de Prisma) y
// `buildCreateReservationInput` (bookingSource, bookerName, NUNCA bookerEmail,
// tentativa, primaryGuestId frente a primaryGuest, histórico con habitación).
// Sin base de datos; huéspedes FICTICIOS. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-service.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedReservationRow } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../../lib/http-error.js";
import { buildCreateReservationInput, deriveImportStatus, importBadRequest, importConflict, importNotFound, sanitizeRowError } from "../reservation-import.service.js";

const context = {
  organizationId: "org_test",
  propertyId: "prop_test",
  userId: "usr_test",
  fullName: "Recepción Test",
  deviceId: "dev-test",
  permissions: ["pms.reservation.create", "pms.reservation.modify"]
} as unknown as UserContext;

function normalizedRow(extra: Partial<NormalizedReservationRow> = {}): NormalizedReservationRow {
  return {
    externalReference: "IMP-001",
    arrivalDate: "2026-10-12",
    departureDate: "2026-10-15",
    nights: 3,
    roomTypeId: "rt_dbl",
    roomTypeCode: "DBL",
    ratePlanId: "rp_bar",
    ratePlanCode: "BAR",
    roomsCount: 1,
    adults: 2,
    children: 0,
    infants: 0,
    boardType: "BB",
    channel: "booking_com",
    sourceCode: "booking",
    marketSegment: "ota",
    estado: "confirmada",
    historical: false,
    guest: {
      firstName: "Lucía",
      surname1: "Ferreiro",
      surname2: "Castro",
      email: "lucia.ferreiro@example.com",
      phone: "+34600111001",
      nationality: "ESP",
      documentType: "DNI",
      documentNumber: "11111111H"
    },
    companyName: "Empresa Ficticia SL",
    travelAgentName: "Agencia Ficticia",
    groupCode: "GRP-1",
    totalAmount: "312.00",
    totalSource: "file",
    currency: "EUR",
    depositAmount: "50.00",
    paymentMethod: "credit_card",
    estimatedArrivalTime: "16:30",
    specialRequests: "Cama de matrimonio",
    notes: "Nota interna del fichero",
    vipFlag: true,
    ...extra
  };
}

describe("deriveImportStatus", () => {
  it("imported / partial / failed según los contadores", () => {
    assert.equal(deriveImportStatus({ createdCount: 3, skippedCount: 0, errorCount: 0 }), "imported");
    assert.equal(deriveImportStatus({ createdCount: 3, skippedCount: 2, errorCount: 0 }), "partial");
    assert.equal(deriveImportStatus({ createdCount: 3, skippedCount: 0, errorCount: 1 }), "partial");
    assert.equal(deriveImportStatus({ createdCount: 0, skippedCount: 0, errorCount: 0 }), "failed");
    assert.equal(deriveImportStatus({ createdCount: 0, skippedCount: 5, errorCount: 2 }), "failed");
  });
});

describe("errores tipados de lote", () => {
  it("importBadRequest / importConflict / importNotFound llevan details.code y el status correcto", () => {
    const bad = importBadRequest("RESERVATION_IMPORT_INVALID", "x", { errorCount: 2 });
    assert.ok(bad instanceof BadRequestError);
    assert.deepEqual(bad.details, { errorCount: 2, code: "RESERVATION_IMPORT_INVALID" });
    const conflict = importConflict("RESERVATION_IMPORT_DUPLICATE", "y", { importId: "imp_1", code: "OTRO" });
    assert.ok(conflict instanceof ConflictError);
    assert.equal((conflict.details as { code: string }).code, "RESERVATION_IMPORT_DUPLICATE", "el código tipado gana sobre extra.code");
    const missing = importNotFound("RESERVATION_IMPORT_NOT_FOUND", "z");
    assert.ok(missing instanceof NotFoundError);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.details, { code: "RESERVATION_IMPORT_NOT_FOUND" });
  });
});

describe("sanitizeRowError", () => {
  const cells = ["IMP-001", "2026-10-12", "Lucía", "Ferreiro Castro", "lucia.ferreiro@example.com", "11111111H"];

  it("409 de disponibilidad de createReservation → NO_AVAILABILITY con el mensaje del servicio", () => {
    const error = new ConflictError("No hay disponibilidad para el tipo de habitación seleccionado en esas fechas (3 habitaciones, 3 ya reservadas, 1 solicitadas).");
    const out = sanitizeRowError(error, cells);
    assert.equal(out.code, "RESERVATION_IMPORT_ROW_NO_AVAILABILITY");
    assert.match(out.message, /3 habitaciones, 3 ya reservadas, 1 solicitadas/);
  });

  it("RESERVATION_CODE_CONFLICT (409 tipado de withReservationCodeRetry) → CODE_CONFLICT", () => {
    const error = new ConflictError("No se pudo asignar un código de reserva único tras varios intentos. Vuelve a intentarlo.", { code: "RESERVATION_CODE_CONFLICT", attempts: 3 });
    const out = sanitizeRowError(error, cells);
    assert.equal(out.code, "RESERVATION_IMPORT_ROW_CODE_CONFLICT");
    assert.match(out.message, /código de reserva/);
  });

  it("otro HttpError (400 del PMS) → CREATE_FAILED con el mensaje del servicio", () => {
    const out = sanitizeRowError(new BadRequestError("primaryGuest.surname1 (apellido) es obligatorio."), cells);
    assert.equal(out.code, "RESERVATION_IMPORT_ROW_CREATE_FAILED");
    assert.match(out.message, /el PMS rechazó la reserva: primaryGuest\.surname1/);
  });

  it("P2002 de Prisma → describePrismaError (mensaje en español, sin texto de invocación)", () => {
    const prismaError = Object.assign(new Error("Invalid `prisma.reservation.create()` invocation in /Users/x/pms.service.ts:720"), { code: "P2002", meta: { target: ["property_id", "code"] } });
    const out = sanitizeRowError(prismaError, cells);
    assert.equal(out.code, "RESERVATION_IMPORT_ROW_CREATE_FAILED");
    assert.match(out.message, /Ya existe un registro con el mismo valor único/);
    assert.doesNotMatch(out.message, /invocation|pms\.service/);
  });

  it("Error genérico → mensaje neutro sin el texto original", () => {
    const out = sanitizeRowError(new Error("connect ECONNREFUSED 127.0.0.1:5432 while saving lucia.ferreiro@example.com"), cells);
    assert.equal(out.code, "RESERVATION_IMPORT_ROW_CREATE_FAILED");
    assert.equal(out.message, "Error interno al crear la reserva.");
    assert.equal(sanitizeRowError("cadena suelta").message, "Error interno al crear la reserva.");
    assert.equal(sanitizeRowError(null).code, "RESERVATION_IMPORT_ROW_CREATE_FAILED");
  });

  it("GDPR: un mensaje de servicio que cite un valor de la fila lo pierde y se recorta a 500 caracteres", () => {
    const error = new ConflictError(`La habitación ya está asignada a Ferreiro Castro (lucia.ferreiro@example.com, documento 11111111H). ${"x".repeat(600)}`);
    const out = sanitizeRowError(error, cells);
    assert.doesNotMatch(out.message, /Ferreiro|example\.com|11111111H/);
    assert.match(out.message, /\[valor omitido\]/);
    assert.ok(out.message.length <= 500, `mensaje de ${out.message.length} caracteres`);
  });
});

describe("buildCreateReservationInput", () => {
  it("fila confirmada con huésped nuevo: bookingSource import:<id>, bookerName, primaryGuest completo y NUNCA bookerEmail", () => {
    const input = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow(), correlationId: "corr_1" });
    assert.equal(input.context, context);
    assert.equal(input.propertyId, "prop_test");
    assert.equal(input.bookingSource, "import:imp_1");
    assert.equal(input.bookerName, "Lucía Ferreiro Castro");
    assert.equal("bookerEmail" in input, false, "el importador nunca rellena bookerEmail (evita la plantilla reservation_confirmed)");
    assert.equal(input.bookerEmail, undefined);
    assert.equal(input.primaryGuestId, undefined);
    assert.deepEqual(input.primaryGuest, {
      firstName: "Lucía",
      surname1: "Ferreiro",
      surname2: "Castro",
      email: "lucia.ferreiro@example.com",
      phone: "+34600111001",
      nationality: "ESP",
      documentType: "DNI",
      documentNumber: "11111111H",
      company: "Empresa Ficticia SL"
    });
    assert.equal(input.roomTypeId, "rt_dbl");
    assert.equal(input.ratePlanId, "rp_bar");
    assert.equal(input.arrivalDate, "2026-10-12");
    assert.equal(input.departureDate, "2026-10-15");
    assert.deepEqual([input.adults, input.children, input.infants, input.roomsCount], [2, 0, 0, 1]);
    assert.equal(input.channel, "booking_com");
    assert.equal(input.sourceCode, "booking");
    assert.equal(input.boardType, "BB");
    assert.equal(input.marketSegment, "ota");
    assert.equal(input.externalReference, "IMP-001");
    assert.equal(input.companyName, "Empresa Ficticia SL");
    assert.equal(input.travelAgentName, "Agencia Ficticia");
    assert.equal(input.groupCode, "GRP-1");
    assert.equal(input.totalAmount, 312);
    assert.equal(input.currency, "EUR");
    assert.equal(input.depositAmount, 50);
    assert.equal(input.paymentMethod, "credit_card");
    assert.equal(input.estimatedArrivalTime, "16:30");
    assert.equal(input.eta, "16:30");
    assert.equal(input.specialRequests, "Cama de matrimonio");
    assert.equal(input.notes, "Nota interna del fichero");
    assert.equal(input.vipFlag, true);
    assert.equal(input.internalNotes, undefined);
    assert.equal(input.allowOverbooking, undefined);
    assert.equal(input.historical, undefined);
    assert.equal(input.assignedRoomId, undefined, "la habitación de una fila no histórica se asigna con assignRoom, no en el alta");
    assert.equal(input.correlationId, "corr_1");
  });

  it("huésped existente → primaryGuestId y sin primaryGuest (la ficha no se toca)", () => {
    const input = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow(), guestId: "guest_9", correlationId: "corr_1" });
    assert.equal(input.primaryGuestId, "guest_9");
    assert.equal(input.primaryGuest, undefined);
    assert.equal("bookerEmail" in input, false);
  });

  it("tentativa → internalNotes «Importada como tentativa: confirmar con el cliente (lote …)»", () => {
    const input = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_7", row: normalizedRow({ estado: "tentativa" }), correlationId: "corr_1" });
    assert.equal(input.internalNotes, "Importada como tentativa: confirmar con el cliente (lote imp_7)");
    const cancelled = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_7", row: normalizedRow({ estado: "cancelada" }), correlationId: "corr_1" });
    assert.equal(cancelled.internalNotes, undefined, "la cancelada se transiciona después; no lleva nota");
  });

  it("histórica con habitación → historical: true y assignedRoomId; sin habitación → solo historical", () => {
    const withRoom = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow({ historical: true, roomId: "room_201", roomNumber: "201", arrivalDate: "2026-01-10", departureDate: "2026-01-12", nights: 2 }), correlationId: "corr_1" });
    assert.equal(withRoom.historical, true);
    assert.equal(withRoom.assignedRoomId, "room_201");
    const withoutRoom = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow({ historical: true }), correlationId: "corr_1" });
    assert.equal(withoutRoom.historical, true);
    assert.equal(withoutRoom.assignedRoomId, undefined);
    const current = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow({ roomId: "room_201", roomNumber: "201" }), correlationId: "corr_1" });
    assert.equal(current.historical, undefined);
    assert.equal(current.assignedRoomId, undefined);
  });

  it("allowOverbooking solo cuando la fila excede el cupo con la opción activada; sin tarifa ni opcionales → claves ausentes", () => {
    const over = buildCreateReservationInput({ context, propertyId: "prop_test", importId: "imp_1", row: normalizedRow(), allowOverbooking: true, correlationId: "corr_1" });
    assert.equal(over.allowOverbooking, true);
    const minimal = buildCreateReservationInput({
      context,
      propertyId: "prop_test",
      importId: "imp_1",
      row: normalizedRow({
        ratePlanId: undefined,
        ratePlanCode: undefined,
        boardType: undefined,
        sourceCode: undefined,
        marketSegment: undefined,
        externalReference: undefined,
        companyName: undefined,
        travelAgentName: undefined,
        groupCode: undefined,
        depositAmount: undefined,
        paymentMethod: undefined,
        estimatedArrivalTime: undefined,
        specialRequests: undefined,
        notes: undefined,
        totalAmount: "0.00",
        totalSource: "none",
        guest: { firstName: "Marek", surname1: "Nowak" }
      }),
      allowOverbooking: false,
      correlationId: "corr_1"
    });
    assert.equal(minimal.allowOverbooking, undefined);
    assert.equal(minimal.bookerName, "Marek Nowak");
    assert.equal(minimal.totalAmount, 0);
    assert.deepEqual(minimal.primaryGuest, { firstName: "Marek", surname1: "Nowak" });
    for (const key of ["ratePlanId", "boardType", "sourceCode", "marketSegment", "externalReference", "companyName", "travelAgentName", "groupCode", "depositAmount", "paymentMethod", "estimatedArrivalTime", "eta", "specialRequests", "notes", "bookerEmail"]) {
      assert.equal(key in minimal, false, `${key} ausente`);
    }
  });
});
