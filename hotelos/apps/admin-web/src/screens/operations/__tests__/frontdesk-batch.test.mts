import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U6 · lote de Mi día (docs/design/UX-RECEPCION-FEEL.md §5.1 (3), §5.4 (6),
// §6.1 «Lote de N check-outs», F25): candidatas del lote, plan de asignación
// sin repetir habitación, ejecución EN SERIE con progreso y «Cancelar el
// resto», etiqueta de progreso con porcentaje pasados 10 s y las fichas
// imprimibles. Mismo gancho que frontdesk-actions.test.mts para `import.meta.env`.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { batchAssignPlan, batchCheckOutCandidates, batchCheckOutSummaryText, batchProgressLabel, registrationCardsHtml, runBatch } = await import("../FrontDeskDashboard.tsx");
const { FRONT_DESK_ACTIONS, FRONT_DESK_TOASTS } = await import("../../../content/actions.ts");

type Row = { tab: "departures"; reservationId: string; guestName: string; status: string; roomId?: string; roomNumber?: string; roomTypeId?: string; roomTypeName?: string; arrivalDate?: string; departureDate?: string; balanceEur: number; vip: boolean; specialRequests?: string };
const TODAY = "2026-09-19";
const row = (id: string, status: string, balance: number, roomNumber?: string, roomTypeId = "dbl", departureDate = TODAY): Row => ({ tab: "departures", reservationId: id, guestName: `Huésped ${id}`, status, roomNumber, roomId: roomNumber ? `r${roomNumber}` : undefined, roomTypeId, roomTypeName: "Doble", departureDate, balanceEur: balance, vip: false });
const ROWS = [row("d2", "checked_in", 0, "205"), row("d3", "checked_in", 0, "206"), row("t3", "checked_in", 120, "204"), row("x1", "checked_out", 0, "207"), row("h1", "checked_in", 0, "310", "sup", "2026-09-22"), row("late", "checked_in", 0, "311", "sup", "2026-09-18")];
const ROOMS = [
  { id: "r101", number: "101", roomTypeId: "dbl", status: "occupied", housekeepingStatus: "clean", sellable: true },
  { id: "r102", number: "102", roomTypeId: "dbl", status: "clean", housekeepingStatus: "clean", sellable: true },
  { id: "r103", number: "103", roomTypeId: "dbl", status: "clean", housekeepingStatus: "clean", sellable: true },
  { id: "r301", number: "301", roomTypeId: "sup", status: "clean", housekeepingStatus: "dirty", sellable: true }
];

describe("lote · candidatas", () => {
  it("«Check-out de N con saldo 0»: solo las seleccionadas en el hotel, sin saldo y que salen hoy o ya debían haber salido (UX1-REV-01)", () => {
    const picked = batchCheckOutCandidates(ROWS as never, ["d2", "d3", "t3", "x1", "h1", "late"], TODAY);
    assert.deepEqual(picked.map((r) => r.reservationId), ["d2", "d3", "late"], "h1 sale el 22: ⌘A sobre «En el hotel» no la cierra");
    assert.equal(FRONT_DESK_ACTIONS.batchCheckOut(picked.length), "Check-out de 3 con saldo 0");
    assert.deepEqual(batchCheckOutCandidates(ROWS as never, ["t3"], TODAY), []);
    assert.deepEqual(batchCheckOutCandidates(ROWS as never, ["h1"], TODAY), []);
    assert.match(batchCheckOutSummaryText(picked), /^Se cerrarán 3 estancias con saldo 0 que salen hoy \(la 205, la 206, la 311\)\./);
    assert.match(batchCheckOutSummaryText(picked.slice(0, 1)), /^Se cerrarán la estancia/);
    assert.equal(FRONT_DESK_ACTIONS.reviewSelection, "Revisar la selección");
  });
  it("N > 1 pasa por el diálogo nominal (CocoaDialog destructive) antes de ejecutar; una sola cierra directa", () => {
    const source = readFileSync(new URL("../FrontDeskDashboard.tsx", import.meta.url), "utf8");
    assert.match(source, /if \(candidates\.length === 1\) \{\s*void runBatchCheckOut\(selection, candidates\);/);
    assert.match(source, /setBatchCheckOutPrompt\(\{ selection, candidates \}\)/);
    assert.match(source, /<CocoaDialog\s+open=\{batchCheckOutPrompt !== null\}[\s\S]*?tone="destructive"[\s\S]*?cancelLabel=\{FRONT_DESK_ACTIONS\.reviewSelection\}/);
    const list = readFileSync(new URL("../../reservations/ReservationsListScreen.tsx", import.meta.url), "utf8");
    assert.match(list, /row\.departureDate\.slice\(0, 10\) <= today/, "la lista también limita el lote a las que salen hoy");
    assert.match(list, /<CocoaDialog\s+open=\{batchCheckOutPrompt !== null\}[\s\S]*?tone="destructive"/);
  });
  it("«Asignar habitación a N»: solo confirmadas sin habitación, una limpia y libre por reserva, sin repetir", () => {
    const arrivals = [row("a1", "confirmed", 0), row("a2", "confirmed", 0), row("a3", "confirmed", 0), row("s1", "confirmed", 0, undefined, "sup"), row("h1", "confirmed", 0, "110")];
    const plan = batchAssignPlan(arrivals as never, ["a1", "a2", "a3", "s1", "h1"], ROOMS as never);
    assert.deepEqual(plan.map((entry) => `${entry.row.reservationId}→${entry.room.number}`), ["a1→102", "a2→103"], "la 101 está ocupada, la 301 sucia; a3 se queda sin candidata y h1 ya tiene habitación");
    assert.equal(FRONT_DESK_ACTIONS.batchAssign(plan.length), "Asignar habitación a 2");
  });
});

describe("lote · ejecución en serie", () => {
  it("una tras otra, con progreso por elemento y resumen de fallos", async () => {
    const order: string[] = [];
    const progress: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const outcome = await runBatch(
      ["a", "b", "c"],
      async (item) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        order.push(item);
        if (item === "b") throw new Error("409 BALANCE_DUE");
      },
      { onProgress: (done, total) => progress.push(`${done}/${total}`) }
    );
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(maxRunning, 1, "en serie, nunca en paralelo");
    assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
    assert.equal(outcome.done, 2);
    assert.deepEqual(outcome.failed.map((entry) => `${entry.item}:${entry.message}`), ["b:409 BALANCE_DUE"]);
    assert.equal(outcome.cancelled, false);
    assert.equal(FRONT_DESK_TOASTS.batchCheckOutSummary(outcome.done, outcome.failed.length), "2 check-outs hechos · 1 sin hacer");
  });
  it("«Cancelar el resto» detiene el lote antes del siguiente elemento", async () => {
    let cancelled = false;
    const outcome = await runBatch(
      ["a", "b", "c"],
      async (item) => {
        if (item === "a") cancelled = true;
      },
      { isCancelled: () => cancelled }
    );
    assert.equal(outcome.done, 1);
    assert.equal(outcome.cancelled, true);
    assert.equal(FRONT_DESK_TOASTS.batchCancelled(outcome.done, 3), "Lote cancelado: 1 de 3");
  });
  it("la etiqueta de progreso añade el porcentaje pasados 10 s (NN/g)", () => {
    assert.equal(batchProgressLabel(3, 5, 4_000), "3 de 5");
    assert.equal(batchProgressLabel(3, 5, 12_000), "3 de 5 · 60 %");
    assert.equal(batchProgressLabel(0, 0, 12_000), "0 de 0");
  });
});

describe("lote · fichas imprimibles", () => {
  it("una sección por reserva con huésped, reserva, habitación y fechas; sin estilos en línea ni colores literales", () => {
    const html = registrationCardsHtml([row("d2", "checked_in", 0, "205"), { ...row("a1", "confirmed", 0), arrivalDate: "2026-09-19", departureDate: "2026-09-21", specialRequests: "<cuna>" }] as never, "Hotel UXDAY (prueba)");
    assert.equal((html.match(/<section class="card">/g) ?? []).length, 2);
    assert.match(html, /Hotel UXDAY \(prueba\) · Ficha de registro/);
    assert.match(html, /205/);
    assert.match(html, /Sin asignar/);
    assert.match(html, /&lt;cuna&gt;/, "escapa el HTML de los datos");
    assert.equal(html.includes("style="), false);
    assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
    assert.match(html, /page-break-after:always/);
  });
});
