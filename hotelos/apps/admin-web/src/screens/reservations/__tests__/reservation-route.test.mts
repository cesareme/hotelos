import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reservationIdFromPathname } from "../reservation-route.ts";

// browser-roles#1: real reservation ids are cuids («cmrmvf17w00ibfytlmd1jla6g»);
// the detail screen accepted only `res_…` and never called the API.
describe("Reservas › Detalle · id de la URL", () => {
  it("accepts any opaque id under /recepcion/reservas/:id (cuid, res_, codes)", () => {
    assert.equal(reservationIdFromPathname("/recepcion/reservas/cmrmvf17w00ibfytlmd1jla6g"), "cmrmvf17w00ibfytlmd1jla6g");
    assert.equal(reservationIdFromPathname("/recepcion/reservas/cmu1jfnpv00b9fywhkwbl45ep/"), "cmu1jfnpv00b9fywhkwbl45ep");
    assert.equal(reservationIdFromPathname("/recepcion/reservas/res_123"), "res_123");
    assert.equal(reservationIdFromPathname("/recepcion/reservas/RES-00016?tab=folio"), "RES-00016");
    assert.equal(reservationIdFromPathname("/recepcion/reservas/a%20b"), "a b");
  });

  it("never mistakes a sibling tab or item of the tree for an id", () => {
    for (const tab of ["lista", "cronograma", "tablero", "nueva"]) {
      assert.equal(reservationIdFromPathname(`/recepcion/reservas/${tab}`), "", tab);
    }
    assert.equal(reservationIdFromPathname("/recepcion/reservas"), "");
    assert.equal(reservationIdFromPathname("/recepcion/reservas/cmrmvf17w00ibfytlmd1jla6g/recorrido"), "");
    assert.equal(reservationIdFromPathname("/hoy"), "");
  });

  it("still reads the legacy standalone route", () => {
    assert.equal(reservationIdFromPathname("/backoffice/reservations/cmrmvf17w00ibfytlmd1jla6g"), "cmrmvf17w00ibfytlmd1jla6g");
  });
});
