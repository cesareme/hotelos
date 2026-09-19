import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U7 · barra de comandos de la ficha (docs/design/UX-RECEPCION-FEEL.md §1.1 P1,
// §4 «Barra de comandos de reserva», §5.5 (1), F20): una sola primaria
// contextual derivada con `primaryActionFor` (U6), «Cobrar» una vez, la acción
// de habitación para confirmadas Y alojadas (F7) y los destructivos en «Más».
// Contrato de fuente: ≤ 1 `variant="filled"` en la región de acciones.
// El módulo llega a services/api-client → `import.meta.env` (Vite): mismo
// gancho que frontdesk-batch.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { CHARGE_UNDO_MS, canBlockRoom, commandBarFor, deferredCommit, folioWithLine, heldRoomIds, optimisticFolioLine, roomCandidatesFor, roomOptionLabel, sesOutcomeNote } = await import("../ReservationWorkspaceScreen.tsx");
/** Fuente sin comentarios: solo cuenta el código que se ejecuta. */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const SCREEN = stripComments(readFileSync(new URL("../ReservationWorkspaceScreen.tsx", import.meta.url), "utf8"));

const TODAY = "2026-09-19";
const eur = (amount: number) => `${amount.toFixed(2).replace(".", ",")} €`;
const openFolio = (balanceDue: number, refundable = false) => ({ balanceDue, open: true, refundable });

describe("commandBarFor · primaria contextual (P1)", () => {
  it("confirmada con habitación → «Hacer check-in» filled, «Cambiar habitación», «Cobrar X €» solo si debe", () => {
    const bar = commandBarFor({ status: "confirmed", arrivalDate: TODAY, departureDate: "2026-09-21", assignedRoomNumber: "111", hasPrimaryGuest: true, canBlockRoom: true }, openFolio(128), TODAY, eur);
    assert.equal(bar.primary?.kind, "checkin");
    assert.equal(bar.primary?.label, "Hacer check-in");
    assert.deepEqual(bar.pay, { label: "Cobrar 128,00 €", amount: 128 });
    assert.equal(bar.room, "change");
    assert.deepEqual(bar.more, ["cancel", "no_show", "block_room", "journey", "guest", "billing", "back"]);
  });
  it("confirmada sin habitación → «Asignar habitación»; sin saldo no hay «Cobrar» en la barra (va a «Más»)", () => {
    const bar = commandBarFor({ status: "confirmed", arrivalDate: TODAY, departureDate: "2026-09-21", assignedRoomNumber: null }, openFolio(0), TODAY, eur);
    assert.equal(bar.primary?.kind, "checkin");
    assert.equal(bar.pay, null);
    assert.equal(bar.room, "assign");
    assert.ok(bar.more.includes("pay"));
    assert.ok(!bar.more.includes("block_room"));
  });
  it("alojada que sale hoy con saldo → «Cobrar 120,00 € y cerrar» es la primaria y no se repite como bordered", () => {
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-17", departureDate: TODAY, assignedRoomNumber: "204" }, openFolio(120), TODAY, eur);
    assert.equal(bar.primary?.kind, "checkout");
    assert.equal(bar.primary?.label, "Cobrar 120,00 € y cerrar");
    assert.equal(bar.pay, null);
    assert.equal(bar.room, "change", "F7: un alojado también cambia de habitación desde la ficha");
    assert.ok(!bar.more.includes("cancel") && !bar.more.includes("no_show"));
  });
  it("alojada que sale hoy sin saldo → «Hacer check-out»", () => {
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-17", departureDate: TODAY, assignedRoomNumber: "205" }, openFolio(0), TODAY, eur);
    assert.equal(bar.primary?.label, "Hacer check-out");
    assert.equal(bar.pay, null);
  });
  it("alojada con saldo y sin salir hoy → «Cobrar 120,00 €» es la primaria (una sola vez)", () => {
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-18", departureDate: "2026-09-21", assignedRoomNumber: "310" }, openFolio(120), TODAY, eur);
    assert.equal(bar.primary?.kind, "pay");
    assert.equal(bar.pay, null);
    assert.equal(bar.room, "change");
  });
  it("alojada sin saldo y sin salir hoy → sin primaria (nada que hacer en el mostrador); habitación y «Más» siguen", () => {
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-18", departureDate: "2026-09-21", assignedRoomNumber: "310" }, openFolio(0, true), TODAY, eur);
    assert.equal(bar.primary, null);
    assert.equal(bar.room, "change");
    assert.ok(bar.more.includes("refund"));
  });
  it("salida hecha / cancelada / no-show → sin primaria ni habitación; folio cerrado no ofrece cobrar", () => {
    for (const status of ["checked_out", "cancelled", "no_show"]) {
      const bar = commandBarFor({ status, arrivalDate: "2026-09-17", departureDate: TODAY, assignedRoomNumber: "204" }, { balanceDue: 0, open: false, refundable: false }, TODAY, eur);
      assert.equal(bar.primary, null, status);
      assert.equal(bar.room, null, status);
      assert.equal(bar.pay, null, status);
      assert.ok(!bar.more.includes("pay") && !bar.more.includes("block_room"), status);
    }
  });
  it("sin folio cargado todavía no promete cobrar (P7) y la habitación bloqueada no vuelve a ofrecer «Bloquear»", () => {
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-18", departureDate: "2026-09-21", assignedRoomNumber: "310", assignedRoomSellable: false, canBlockRoom: true }, null, TODAY, eur);
    assert.equal(bar.primary, null);
    assert.equal(bar.pay, null);
    assert.ok(!bar.more.includes("block_room"));
  });
  it("«Bloquear la NNN» solo con housekeeping.task.manage (el API responde 403 sin él): recepción no lo ve (P7)", () => {
    assert.equal(canBlockRoom({ permissions: ["pms.reservation.read"] }), false);
    assert.equal(canBlockRoom({ permissions: ["housekeeping.task.manage"] }), true);
    assert.equal(canBlockRoom({}), true, "sesión sin lista de permisos (API de demo): decide el API");
    assert.equal(canBlockRoom(null), true);
    const bar = commandBarFor({ status: "checked_in", arrivalDate: "2026-09-18", departureDate: "2026-09-21", assignedRoomNumber: "310", canBlockRoom: false }, openFolio(0), TODAY, eur);
    assert.ok(!bar.more.includes("block_room"));
  });
});

describe("roomCandidatesFor · limpias, libres y sin otra reserva; mismo tipo primero", () => {
  const room = (id: string, number: string, roomTypeId: string, status: string, hk: string, sellable = true) => ({ id, number, roomTypeId, status, housekeepingStatus: hk, sellable });
  const rooms = [
    room("r310", "310", "sup", "occupied", "clean"),
    room("r301", "301", "sup", "clean", "clean"),
    room("r302", "302", "sup", "dirty", "dirty"),
    room("r303", "303", "sup", "occupied", "clean"),
    room("r304", "304", "sup", "clean", "inspected"),
    room("r305", "305", "sup", "clean", "clean"),
    room("r306", "306", "sup", "out_of_service", "clean", false),
    room("r101", "101", "dbl", "clean", "clean"),
    room("r102", "102", "dbl", "clean", "clean")
  ];
  it("excluye ocupadas, sucias, fuera de servicio y las asignadas a otra reserva activa (409 del API); otros tipos después; la asignada al final", () => {
    const held = heldRoomIds([{ id: "res_a4", assignedRoomId: "r305" }, { id: "res_t4", assignedRoomId: "r310" }, { id: "res_x", assignedRoomId: "r102" }], "res_t4");
    assert.deepEqual([...held].sort(), ["r102", "r305"]);
    const candidates = roomCandidatesFor(rooms, { roomTypeId: "sup", assignedRoomId: "r310" }, held);
    assert.deepEqual(candidates.map((r) => r.number), ["301", "304", "101", "310"]);
    assert.equal(roomOptionLabel(candidates[3], true), "310 · Asignada");
    assert.equal(roomOptionLabel(candidates[0], false), "301 · Limpia");
    assert.equal(roomOptionLabel(candidates[1], false), "304 · Inspeccionada");
    assert.equal(roomOptionLabel(candidates[2], false, "Doble"), "101 · Doble · Limpia");
  });
  it("sin habitación asignada no añade ninguna «actual»; sin `held` no excluye nada", () => {
    assert.deepEqual(roomCandidatesFor(rooms, { roomTypeId: "dbl", assignedRoomId: undefined }).map((r) => r.number), ["101", "102", "301", "304", "305"]);
  });
});

describe("cargo con deshacer · línea optimista y escritura diferida (F13, §4.2)", () => {
  it("la línea optimista recalcula cargos y saldo del folio", () => {
    const folio = { folio: { id: "f1", reservationId: "r1", status: "open", currency: "EUR" }, lines: [], payments: [], chargesTotal: 178, paymentsTotal: 100, balanceDue: 78 };
    const line = optimisticFolioLine({ type: "minibar", description: "Minibar", unitPrice: 12, taxCategory: "food_beverage", id: "tmp_1" });
    assert.equal(line.total, 12);
    const next = folioWithLine(folio, line);
    assert.equal(next.lines.length, 1);
    assert.equal(next.chargesTotal, 190);
    assert.equal(next.balanceDue, 90);
    assert.equal(folio.lines.length, 0, "no muta el folio anterior");
  });
  it("deferredCommit: deshacer cancela antes de enviar; el vaciado (salir de la ficha) envía al instante; la ventana es de 8 s", async () => {
    assert.equal(CHARGE_UNDO_MS, 8000);
    const undone = deferredCommit(10_000);
    undone.cancel();
    assert.equal(await undone.wait(), false);
    assert.equal(undone.settled(), true);
    const flushed = deferredCommit(10_000);
    flushed.flush();
    assert.equal(await flushed.wait(), true);
    flushed.cancel();
    assert.equal(await flushed.wait(), true, "una vez enviado no se deshace");
    const timed = deferredCommit(5);
    assert.equal(await timed.wait(), true);
  });
});

describe("sesOutcomeNote · el check-in desde la ficha nunca dice «enviado» en falso", () => {
  it("encolado → sin nota; el resto explica qué falta", () => {
    assert.equal(sesOutcomeNote({ kind: "queued", queued: 1 }), null);
    assert.match(sesOutcomeNote({ kind: "no_records" }) ?? "", /Sin registros/);
    assert.match(sesOutcomeNote({ kind: "disabled", message: "x", failed: [] }) ?? "", /desactivado/);
    assert.match(sesOutcomeNote({ kind: "error", message: "boom", code: null, failed: [] }) ?? "", /boom/);
  });
});

describe("Ficha · contrato de fuente (P1, F20, §5.5)", () => {
  const start = SCREEN.indexOf('data-cocoa="reservation-command-bar"');
  const end = SCREEN.indexOf("state={pageState}");
  const region = SCREEN.slice(start, end);

  it("la región de acciones tiene ≤ 1 variant=\"filled\" y hasta 2 bordered, con teclas de acceso", () => {
    assert.ok(start > 0 && end > start, "región de acciones localizada");
    assert.equal((region.match(/variant="filled"/g) ?? []).length, 1);
    assert.ok((region.match(/variant="bordered"/g) ?? []).length <= 2);
    assert.match(region, /accessKey="C"/);
    assert.match(region, /accessKey="P"/);
    assert.match(region, /accessKey="M"/);
    assert.match(region, /<CocoaStatusBadge entry=\{reservationStatus\(status\)\} \/>/);
    assert.match(region, /RESERVATION_ACTIONS\.more/);
  });
  it("deriva la primaria con primaryActionFor (U6) y ya no pinta Check-in y Check-out filled adyacentes ni «Cobrar» duplicado", () => {
    assert.match(SCREEN, /import \{ primaryActionFor, type PrimaryAction \} from "\.\.\/operations\/primaryAction"/);
    assert.doesNotMatch(SCREEN, />\s*Check-in\s*<\/CocoaButton>/);
    assert.doesNotMatch(SCREEN, />\s*Check-out\s*<\/CocoaButton>/);
    assert.equal((SCREEN.match(/>\s*Cobrar\s*<\/CocoaButton>/g) ?? []).length, 0);
    assert.doesNotMatch(SCREEN, /checkInReservation\(/, "el check-in va por el runner del cajón (U6)");
    assert.match(SCREEN, /runCheckin\(/);
    assert.match(SCREEN, /payment: null/);
  });
  it("cambio de habitación para confirmadas y alojadas: assign-room optimista con deshacer a la anterior", () => {
    assert.match(SCREEN, /\/assign-room`, \{ method: "POST", body: \{ roomId: room\.id \} \}/);
    assert.match(SCREEN, /\/assign-room`, \{ method: "POST", body: \{ roomId: previous\.id \} \}/);
    assert.match(SCREEN, /FRONT_DESK_TOASTS\.roomChanged\(previous\.number, room\.number\)/);
    assert.doesNotMatch(SCREEN, /canAssign = status === "confirmed"/);
  });
  it("cargo: <form> con importe vacío, deshacer con escritura diferida y toast con ACTIONS.undo; nota con deshacer", () => {
    assert.match(SCREEN, /useState\(""\)/);
    assert.doesNotMatch(SCREEN, /useState\("12"\)/);
    assert.match(SCREEN, /onSubmit=\{onChargeSubmit\}/);
    assert.match(SCREEN, /action: \{ label: ACTIONS\.undo, onAction: \(\) => pending\.cancel\(\) \}/);
    assert.match(SCREEN, /if \(!go\) throw new ChargeUndoneError\(\)/);
    assert.match(SCREEN, /body: \{ notes: previous \|\| null \}/);
  });
  it("cobro: «Cobrar y cerrar» hace el check-out tras cobrar; el evento hotelos-open-payment se reclama con el id", () => {
    assert.match(SCREEN, /closeAfter=\{Boolean\(payment\?\.closeAfter\)\}/);
    assert.match(SCREEN, /if \(meta\.closeAfter\) void doCheckOut\(\{ afterPayment: true \}\)/);
    assert.match(SCREEN, /window\.addEventListener\(OPEN_PAYMENT_EVENT, onOpenPayment\)/);
    assert.match(SCREEN, /if \(detail\.reservationId === reservationId\) \{\s*event\.preventDefault\(\);/);
  });
  it("documentos: factura a huésped / empresa por InvoiceFromReservationDialog; cancelar / no-show por LifecycleDialog con renuncia", () => {
    assert.match(SCREEN, /<InvoiceFromReservationDialog/);
    assert.match(SCREEN, /RESERVATION_ACTIONS\.invoiceToGuest/);
    assert.match(SCREEN, /RESERVATION_ACTIONS\.invoiceToCompany/);
    assert.match(SCREEN, /<LifecycleDialog/);
    assert.match(SCREEN, /allowWaiver/);
    assert.doesNotMatch(SCREEN, /previewCancellationCharge/);
    // Diálogos que quedan en la ficha: bloqueo de habitación (§4.2, inventario) + los componentes de cobro/factura/ciclo de vida.
    assert.equal((SCREEN.match(/<CocoaDialog\b/g) ?? []).length, 1);
  });
  it("copy: 0 style= nuevos y las etiquetas de acción vienen de content/actions.ts", () => {
    assert.equal((SCREEN.match(/style=\{/g) ?? []).length, 2, "los dos overflow:clip preexistentes");
    assert.match(SCREEN, /RESERVATION_ACTIONS, RESERVATION_NOTES, RESERVATION_TOASTS/);
  });
});
