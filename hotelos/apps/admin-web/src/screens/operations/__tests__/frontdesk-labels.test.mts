import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUSEKEEPING_STATUS_LABELS, RESERVATION_STATUS_LABELS, housekeepingStatusLabel, reservationStatusLabel, roomOptionLabel } from "../frontdesk-labels.ts";
import { RESERVATION_STATUS, statusLabels } from "../../../content/status-dictionary.ts";

// fix:2-A qa#7 — the room select of the check-in drawer read «Hab. 119 ·
// planta  · limpia» (floor "" on 120/120 rooms of Rías Altas) and «planta
// Planta 1» on Los Tilos, where the API already names the floor.
describe("Recepción · etiqueta de habitación", () => {
  it("omits the floor segment when the API sends none", () => {
    assert.equal(roomOptionLabel({ number: "119", floor: "" }, "limpia"), "Hab. 119 · limpia");
    assert.equal(roomOptionLabel({ number: "119" }, "limpia"), "Hab. 119 · limpia");
    assert.equal(roomOptionLabel({ number: "119", floor: "   " }, "limpia"), "Hab. 119 · limpia");
  });
  it("prefixes a bare floor and keeps one that already says «Planta»", () => {
    assert.equal(roomOptionLabel({ number: "204", floor: "2" }, "limpia"), "Hab. 204 · planta 2 · limpia");
    assert.equal(roomOptionLabel({ number: "204", floor: "Planta 1" }, "limpia"), "Hab. 204 · Planta 1 · limpia");
    assert.equal(roomOptionLabel({ number: "204", floor: "planta baja" }, "sucia"), "Hab. 204 · planta baja · sucia");
  });
});

// fix:2-A qa#8 — «Reserva en estado "checked_out"» painted the raw enum.
// Tanda UX-1 · U2 (D5): the labels are the dictionary's («En el hotel»,
// «Salida hecha») and an unknown value reads «Desconocido», never the enum.
describe("Recepción · estados en español", () => {
  it("translates reservation statuses and never paints the raw enum", () => {
    assert.equal(reservationStatusLabel("checked_out"), "Salida hecha");
    assert.equal(reservationStatusLabel("CHECKED_IN"), "En el hotel");
    assert.equal(reservationStatusLabel("confirmed"), "Confirmada");
    assert.equal(reservationStatusLabel("no_show"), "No-show");
    assert.equal(reservationStatusLabel("weird_state"), "Desconocido");
    assert.equal(reservationStatusLabel(undefined), "Desconocido");
    assert.equal(reservationStatusLabel(""), "Desconocido");
    assert.deepEqual(RESERVATION_STATUS_LABELS, statusLabels(RESERVATION_STATUS), "re-exported from the dictionary, not copied");
  });
  it("translates housekeeping statuses for the inline room label", () => {
    assert.equal(housekeepingStatusLabel("dirty"), "sucia");
    assert.equal(housekeepingStatusLabel("Inspected"), "inspeccionada");
    assert.equal(housekeepingStatusLabel("out_of_order"), "fuera de servicio");
    assert.equal(housekeepingStatusLabel("blocked"), "bloqueada");
    assert.equal(housekeepingStatusLabel("weird"), "desconocido");
    assert.equal(housekeepingStatusLabel(null), "desconocido");
    assert.equal(HOUSEKEEPING_STATUS_LABELS.clean, "limpia");
  });
});
