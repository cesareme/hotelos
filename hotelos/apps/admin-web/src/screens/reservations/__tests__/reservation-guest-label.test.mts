import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guestFullName, pendingGuestIds, reservationGuestLabel, PENDING_GUEST_LABEL, guestNamesFromRows } from "../reservation-guest-label.ts";

// fix:3-A qa#7 — RES-00005 painted «cmrmvf0pr00ggfytlf41xybq8» in the Huésped
// column of /recepcion/reservas/lista and as the meta of «Resumen» in the
// detail: `bookerName ?? primaryGuestId ?? "Huésped pendiente"`.
const GUEST_ID = "cmrmvf0pr00ggfytlf41xybq8";

describe("Reservas · etiqueta del huésped", () => {
  it("prefers the booker name and never falls back to the internal id", () => {
    assert.equal(reservationGuestLabel({ bookerName: "Ana Souto", primaryGuestId: GUEST_ID }), "Ana Souto");
    assert.equal(reservationGuestLabel({ primaryGuestId: GUEST_ID }), PENDING_GUEST_LABEL);
    assert.equal(reservationGuestLabel({ bookerName: "   ", primaryGuestId: GUEST_ID }), PENDING_GUEST_LABEL);
    assert.equal(reservationGuestLabel({}), "Huésped pendiente");
    assert.doesNotMatch(reservationGuestLabel({ primaryGuestId: GUEST_ID }, null), /^c[a-z0-9]{24}$/);
  });

  it("paints the resolved primary guest when there is no booker name", () => {
    assert.equal(reservationGuestLabel({ primaryGuestId: GUEST_ID }, "María Vidal"), "María Vidal");
    assert.equal(reservationGuestLabel({ bookerName: "Ana Souto", primaryGuestId: GUEST_ID }, "María Vidal"), "Ana Souto");
    assert.equal(reservationGuestLabel({ primaryGuestId: GUEST_ID }, "  "), PENDING_GUEST_LABEL);
  });
});

describe("Reservas · nombre completo del huésped", () => {
  it("uses fullName when the API sends it and composes the parts otherwise", () => {
    assert.equal(guestFullName({ fullName: "María Vidal Pérez", firstName: "Otro" }), "María Vidal Pérez");
    assert.equal(guestFullName({ firstName: "María", surname1: "Vidal", surname2: "Pérez" }), "María Vidal Pérez");
    assert.equal(guestFullName({ firstName: "AUDIT-T0R", surname1: null, surname2: null }), "AUDIT-T0R");
  });
  it("returns null when nothing is known, so the caller can fall back", () => {
    assert.equal(guestFullName(null), null);
    assert.equal(guestFullName(undefined), null);
    assert.equal(guestFullName({ fullName: " ", firstName: "", surname1: null }), null);
  });
});

describe("Reservas · ids pendientes de resolver", () => {
  it("collects each primary guest id once, only for rows without booker name, skipping known ids", () => {
    const rows = [
      { bookerName: "Ana Souto", primaryGuestId: "g1" },
      { primaryGuestId: "g2" },
      { primaryGuestId: "g2" },
      { bookerName: "", primaryGuestId: "g3" },
      { primaryGuestId: "g4" },
      { primaryGuestId: "" },
      {}
    ];
    assert.deepEqual(pendingGuestIds(rows, new Set(["g4"])), ["g2", "g3"]);
    assert.deepEqual(pendingGuestIds([], new Set()), []);
  });
  it("L-15: una fila con primaryGuestName del API no se pide (0 GET /guests/:id) y siembra la caché de nombres", () => {
    const rows = [
      { primaryGuestId: "g1", primaryGuestName: "Ana Alfa" },
      { primaryGuestId: "g2" },
      { bookerName: "Empresa", primaryGuestId: "g3", primaryGuestName: "Beto Beta" },
      { primaryGuestId: "g1", primaryGuestName: "Otro nombre" }
    ];
    assert.deepEqual(pendingGuestIds(rows, new Set()), ["g2"]);
    assert.deepEqual(guestNamesFromRows(rows), { g1: "Ana Alfa", g3: "Beto Beta" });
    assert.equal(reservationGuestLabel({ primaryGuestId: "g1", primaryGuestName: "Ana Alfa" }), "Ana Alfa");
    assert.equal(reservationGuestLabel({ primaryGuestId: "g1", primaryGuestName: "Ana Alfa" }, "Resuelto"), "Resuelto", "el resuelto por caché manda");
  });
});
