import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function canAssignRoom({ rooms, reservations, propertyId, reservationId, roomNumber, arrivalDate, departureDate }) {
  const room = rooms.find((candidate) => candidate.propertyId === propertyId && candidate.number === roomNumber);
  if (!room) {
    return { allowed: false, warnings: ["Room does not exist for this property."], maintenanceBlock: true };
  }

  const warnings = [];
  const maintenanceBlock = room.maintenanceStatus === "blocked" || !room.sellable;

  if (maintenanceBlock) {
    warnings.push("Room is blocked for maintenance or not sellable.");
  }

  if (room.status === "occupied") {
    warnings.push("Room is currently occupied.");
  }

  const conflict = reservations.find(
    (reservation) =>
      reservation.propertyId === propertyId &&
      reservation.id !== reservationId &&
      reservation.assignedRoomId === room.id &&
      ["confirmed", "checked_in"].includes(reservation.status) &&
      rangesOverlap(arrivalDate, departureDate, reservation.arrivalDate, reservation.departureDate)
  );

  if (conflict) {
    warnings.push(`Room is already consumed by ${conflict.code}.`);
  }

  return { allowed: warnings.length === 0, warnings, maintenanceBlock };
}

function closeFolio({ lines, payments }) {
  const charges = lines.reduce((sum, line) => sum + line.total, 0);
  const captured = payments.filter((payment) => payment.status === "captured").reduce((sum, payment) => sum + payment.amount, 0);
  const balance = Math.round((charges - captured) * 100) / 100;
  if (balance !== 0) {
    throw new Error(`Folio cannot be closed with balance due ${balance}.`);
  }
  return { status: "closed" };
}

describe("PMS lifecycle invariants", () => {
  it("allows a clean inspected sellable room with no overlap", () => {
    const result = canAssignRoom({
      rooms: [{ id: "room_432", propertyId: "prop_123", number: "432", status: "inspected", maintenanceStatus: "ok", sellable: true }],
      reservations: [],
      propertyId: "prop_123",
      reservationId: "res_1",
      roomNumber: "432",
      arrivalDate: "2026-05-14",
      departureDate: "2026-05-16"
    });

    assert.equal(result.allowed, true);
  });

  it("blocks a maintenance-blocked room from assignment", () => {
    const result = canAssignRoom({
      rooms: [{ id: "room_108", propertyId: "prop_123", number: "108", status: "out_of_order", maintenanceStatus: "blocked", sellable: false }],
      reservations: [],
      propertyId: "prop_123",
      reservationId: "res_1",
      roomNumber: "108",
      arrivalDate: "2026-05-14",
      departureDate: "2026-05-16"
    });

    assert.equal(result.allowed, false);
    assert.match(result.warnings.join(" "), /blocked/);
  });

  it("blocks overlapping reservations from consuming the same room", () => {
    const result = canAssignRoom({
      rooms: [{ id: "room_432", propertyId: "prop_123", number: "432", status: "inspected", maintenanceStatus: "ok", sellable: true }],
      reservations: [
        {
          id: "res_existing",
          propertyId: "prop_123",
          code: "RES-EXISTING",
          status: "confirmed",
          assignedRoomId: "room_432",
          arrivalDate: "2026-05-15",
          departureDate: "2026-05-17"
        }
      ],
      propertyId: "prop_123",
      reservationId: "res_new",
      roomNumber: "432",
      arrivalDate: "2026-05-14",
      departureDate: "2026-05-16"
    });

    assert.equal(result.allowed, false);
    assert.match(result.warnings.join(" "), /already consumed/);
  });

  it("closes only zero-balance folios", () => {
    assert.deepEqual(
      closeFolio({
        lines: [{ total: 272 }],
        payments: [{ amount: 272, status: "captured" }]
      }),
      { status: "closed" }
    );

    assert.throws(
      () =>
        closeFolio({
          lines: [{ total: 272 }],
          payments: [{ amount: 100, status: "captured" }]
        }),
      /balance due/
    );
  });

  it("exposes the required PMS and folio route contracts", () => {
    const server = readFileSync(new URL("../apps/api/src/server.ts", import.meta.url), "utf8");
    for (const route of [
      "/properties/:propertyId/rooms",
      "/properties/:propertyId/reservations",
      "/reservations/:id",
      "/reservations/:id/assign-room",
      "/reservations/:id/check-in",
      "/reservations/:id/check-out",
      "/reservations/:id/cancel",
      "/reservations/:id/no-show",
      "/reservations/:id/folio",
      "/folios/:id/lines",
      "/folios/:id/payments",
      "/payments/:id/refund",
      "/folios/:id/close"
    ]) {
      assert.match(server, new RegExp(route.replace(/[/:]/g, "\\$&")));
    }
  });
});

