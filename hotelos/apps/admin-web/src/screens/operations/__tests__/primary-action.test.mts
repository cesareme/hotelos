import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// U6 · acción primaria contextual (docs/design/UX-RECEPCION-FEEL.md §4 «Barra
// de comandos de reserva», §5.1 (1)): las seis combinaciones de estado, saldo y
// salida, y las plantillas de copy que la componen (§4 «Copy de acciones»).
const { CHECK_IN_WINDOW_DAYS, arrivesWithinCheckInWindow, departsToday, primaryActionFor, secondaryActionsFor } = await import("../primaryAction.ts");
const { FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS } = await import("../../../content/actions.ts");

const TODAY = "2026-09-19";
const eur = (amount: number) => `${amount.toFixed(2).replace(".", ",")} €`;

describe("primaryActionFor · las seis combinaciones", () => {
  it("1 · confirmada con habitación → «Hacer check-in»", () => {
    const action = primaryActionFor({ status: "confirmed", roomNumber: "204", balanceEur: 0 }, null, TODAY, eur);
    assert.deepEqual(action, { kind: "checkin", label: "Hacer check-in", amount: null });
  });
  it("2 · confirmada sin habitación con sugerencia → «Check-in en 118» y conserva el saldo para el cajón", () => {
    const action = primaryActionFor({ status: "confirmed", roomNumber: null, suggestedRoomNumber: "118", balanceEur: 120 }, null, TODAY, eur);
    assert.deepEqual(action, { kind: "checkin", label: "Check-in en 118", amount: 120 });
    // Sin sugerencia el drawer la calculará: etiqueta genérica.
    assert.equal(primaryActionFor({ status: "confirmed", roomNumber: null, balanceEur: 0 }, null, TODAY, eur).label, "Hacer check-in");
  });
  it("3 · en el hotel con saldo y sin salir hoy → «Cobrar 120,00 €»", () => {
    const action = primaryActionFor({ status: "checked_in", roomNumber: "310", departureDate: "2026-09-21", balanceEur: 120 }, null, TODAY, eur);
    assert.deepEqual(action, { kind: "pay", label: "Cobrar 120,00 €", amount: 120 });
  });
  it("4 · en el hotel, saldo 0 y sale hoy → «Hacer check-out»", () => {
    const action = primaryActionFor({ status: "checked_in", roomNumber: "205", departureDate: TODAY, balanceEur: 0 }, null, TODAY, eur);
    assert.deepEqual(action, { kind: "checkout", label: "Hacer check-out", amount: null });
  });
  it("5 · en el hotel, saldo 120 € y sale hoy → «Cobrar 120,00 € y cerrar» (el folio manda sobre la fila)", () => {
    const action = primaryActionFor({ status: "checked_in", roomNumber: "204", departureDate: TODAY, balanceEur: 0 }, { balanceDue: 120 }, TODAY, eur);
    assert.deepEqual(action, { kind: "checkout", label: "Cobrar 120,00 € y cerrar", amount: 120 });
    // Salida con retraso (salía ayer) sigue siendo check-out.
    assert.equal(primaryActionFor({ status: "checked_in", departureDate: "2026-09-18", balanceEur: 0 }, null, TODAY, eur).kind, "checkout");
  });
  it("6 · salida hecha sin factura → «Emitir factura»; con factura o sin saber → «Abrir ficha»; cerradas → «Abrir ficha»", () => {
    assert.deepEqual(primaryActionFor({ status: "checked_out" }, { balanceDue: 0, invoiced: false }, TODAY, eur), { kind: "invoice", label: "Emitir factura", amount: null });
    assert.equal(primaryActionFor({ status: "checked_out" }, { balanceDue: 0, invoiced: true }, TODAY, eur).kind, "open");
    assert.equal(primaryActionFor({ status: "checked_out" }, null, TODAY, eur).kind, "open");
    for (const status of ["cancelled", "no_show", "draft", "pending", ""]) {
      assert.equal(primaryActionFor({ status, balanceEur: 50 }, null, TODAY, eur).kind, "open", status);
    }
  });
  it("en el hotel sin saldo y sin salir hoy → «Abrir ficha»; el enum llega en mayúsculas o con espacios", () => {
    assert.equal(primaryActionFor({ status: " CHECKED_IN ", departureDate: "2026-09-25", balanceEur: 0 }, null, TODAY, eur).kind, "open");
    assert.equal(primaryActionFor({ status: "Confirmed", roomNumber: "101" }, null, TODAY, eur).kind, "checkin");
  });
});

describe("ventana de check-in (L-08): la primaria no promete un check-in que el API rechaza con 409", () => {
  it("llegada hoy, ayer o mañana (±1 día del API) → «Hacer check-in»; más lejos → cobrar el saldo o abrir la ficha", () => {
    assert.equal(CHECK_IN_WINDOW_DAYS, 1);
    assert.equal(arrivesWithinCheckInWindow(undefined, TODAY), true, "las filas de Mi día no traen fecha: siempre son de hoy");
    assert.equal(arrivesWithinCheckInWindow("2026-09-20", TODAY), true);
    assert.equal(arrivesWithinCheckInWindow("2026-09-21", TODAY), false);
    assert.equal(arrivesWithinCheckInWindow("2026-03-10T00:00:00.000Z", TODAY), true, "una llegada pasada sigue admitiendo el check-in (retraso)");
    assert.equal(primaryActionFor({ status: "confirmed", arrivalDate: TODAY, roomNumber: "204" }, null, TODAY, eur).kind, "checkin");
    assert.equal(primaryActionFor({ status: "confirmed", arrivalDate: "2026-09-20", roomNumber: "204" }, null, TODAY, eur).kind, "checkin");
    assert.deepEqual(primaryActionFor({ status: "confirmed", arrivalDate: "2026-09-29", roomNumber: "204", balanceEur: 0 }, null, TODAY, eur), { kind: "open", label: "Abrir ficha", amount: null });
    assert.deepEqual(primaryActionFor({ status: "confirmed", arrivalDate: "2026-09-29", roomNumber: null, balanceEur: 178 }, null, TODAY, eur), { kind: "pay", label: "Cobrar 178,00 €", amount: 178 });
  });
});

describe("departsToday y acciones secundarias", () => {
  it("sale hoy = la salida no es posterior a hoy (ISO con o sin hora)", () => {
    assert.equal(departsToday("2026-09-19", TODAY), true);
    assert.equal(departsToday("2026-09-19T00:00:00.000Z", TODAY), true);
    assert.equal(departsToday("2026-09-18", TODAY), true);
    assert.equal(departsToday("2026-09-20", TODAY), false);
    assert.equal(departsToday(null, TODAY), false);
  });
  it("el menú «⋯» solo lista lo que tiene sentido para el estado (P1)", () => {
    assert.deepEqual(secondaryActionsFor({ status: "confirmed", roomNumber: null }), ["view_folio", "assign_room", "mark_no_show", "open_full"]);
    assert.deepEqual(secondaryActionsFor({ status: "confirmed", roomNumber: "204" }), ["view_folio", "change_room", "mark_no_show", "open_full"]);
    assert.deepEqual(secondaryActionsFor({ status: "checked_in", roomNumber: "204" }), ["view_folio", "change_room", "open_full"]);
    assert.deepEqual(secondaryActionsFor({ status: "checked_out", roomNumber: "204" }), ["view_folio", "open_full"]);
  });
});

describe("plantillas de copy de recepción (content/actions.ts)", () => {
  it("los CTA con importe o recuento son plantillas, sin la palabra «preautorizar» (D8)", () => {
    assert.equal(FRONT_DESK_ACTIONS.collectAndCheckIn("120,00 €"), "Cobrar 120,00 € y hacer check-in");
    assert.equal(FRONT_DESK_ACTIONS.collectAndClose("120,00 €"), "Cobrar 120,00 € y cerrar");
    assert.equal(FRONT_DESK_ACTIONS.batchCheckOut(2), "Check-out de 2 con saldo 0");
    assert.equal(FRONT_DESK_ACTIONS.printCards(1), "Imprimir 1 ficha");
    assert.equal(FRONT_DESK_ACTIONS.printCards(3), "Imprimir 3 fichas");
    assert.equal(FRONT_DESK_ACTIONS.batchAssign(2), "Asignar habitación a 2");
    assert.equal(FRONT_DESK_ACTIONS.markNoShowWithPenalty("89,00 €"), "Marcar no-show (penalización 89,00 €)");
    assert.equal(FRONT_DESK_ACTIONS.markNoShowWithPenalty(null), "Marcar no-show (sin penalización)");
    assert.equal(FRONT_DESK_ACTIONS.keepReservation, "Mantener la reserva");
    assert.equal(FRONT_DESK_ACTIONS.createAndCheckIn, "Crear y hacer check-in");
    assert.equal(FRONT_DESK_TOASTS.invoiceIssued("F1-2026-000123"), "Factura F1-2026-000123 emitida");
    assert.equal(FRONT_DESK_TOASTS.checkInDoneSes("204", 2), "Check-in de la 204 hecho · parte enviado a SES (2)");
    assert.equal(FRONT_DESK_TOASTS.batchCheckOutSummary(2, 0), "2 check-outs hechos");
    assert.equal(FRONT_DESK_TOASTS.batchCheckOutSummary(1, 1), "1 check-out hecho · 1 sin hacer");
    const all = JSON.stringify([FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS]);
    assert.doesNotMatch(all, /preautoriz/i);
  });
  it("0 literales de acción nuevos en los ficheros de U6 de screens/ (los CTA salen de content/actions.ts)", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const sources = ["../FrontDeskDashboard.tsx", "../QuickCheckInDrawer.tsx", "../QuickCheckOutDrawer.tsx", "../WalkInDrawer.tsx"].map(read).join("\n");
    for (const literal of ["Hacer check-in<", "Hacer check-out<", ">Walk-in<", ">Crear y hacer check-in<", ">Solo crear reserva<", "y hacer check-in`", "y cerrar`", ">Emitir factura<", ">Ver folio<"]) {
      assert.equal(sources.includes(literal), false, `literal de acción fuera de content/actions.ts: ${literal}`);
    }
  });
});
