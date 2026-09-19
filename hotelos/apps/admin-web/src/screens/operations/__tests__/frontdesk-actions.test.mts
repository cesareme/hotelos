import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U0a · F2/F3 (docs/design/UX-RECEPCION-FEEL.md §3.1 y §9). Las funciones puras
// viven en FrontDeskDashboard.tsx; ese módulo llega (services/activeProperty →
// services/api-client) a `import.meta.env.VITE_API_URL`, que define Vite y no
// `node --test`. El gancho síncrono sustituye solo ese módulo por su fuente sin
// tipos precedida de `import.meta.env ??= {}`; el resto del grafo sigue en el
// cargador tsx del comando de la puerta (un `register()` asíncrono en caliente
// vacía los espacios de nombres de los .ts que sirve tsx: no vale).
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const { canCheckInRow, checkInTooltipFor, reservationDetailUrl } = await import("../FrontDeskDashboard.tsx");
const { FRONT_DESK_TOASTS } = await import("../../../content/actions.ts");
const DASHBOARD_SOURCE = readFileSync(new URL("../FrontDeskDashboard.tsx", import.meta.url), "utf8");
const count = (needle: string): number => DASHBOARD_SOURCE.split(needle).length - 1;

describe("Mi día · F2 · «Hacer check-in» sin habitación", () => {
  it("se habilita para una confirmada sin habitación (el drawer asigna) y con habitación", () => {
    assert.equal(canCheckInRow({ status: "confirmed" }), true);
    assert.equal(canCheckInRow({ status: "confirmed", roomNumber: "204" }), true);
  });
  it("se deshabilita para alojadas, salidas, cerradas y no confirmadas", () => {
    for (const status of ["checked_in", "checked_out", "cancelled", "no_show", "pending"]) {
      assert.equal(canCheckInRow({ status }), false, status);
    }
  });
  it("el tooltip es coherente con el estado del botón", () => {
    assert.equal(checkInTooltipFor({ status: "confirmed" }), "Sin habitación: el check-in te propondrá una limpia");
    assert.equal(checkInTooltipFor({ status: "confirmed", roomNumber: "204" }), "Check-in disponible");
    assert.equal(checkInTooltipFor({ status: "checked_in", roomNumber: "204" }), "Ya hizo el check-in");
    assert.equal(checkInTooltipFor({ status: "checked_out" }), "Ya hizo el check-out");
    assert.equal(checkInTooltipFor({ status: "cancelled" }), "Reserva cerrada");
    assert.equal(checkInTooltipFor({ status: "no_show" }), "Reserva cerrada");
    assert.equal(checkInTooltipFor({ status: "pending" }), "La reserva no está confirmada");
    assert.doesNotMatch(DASHBOARD_SOURCE, /Asigna una habitación antes de hacer el check-in/);
  });
});

describe("Mi día · F3 · «Ver folio» y «Asignar habitación» conservan la reserva", () => {
  it("la URL de la ficha lleva el id de la reserva", () => {
    const url = reservationDetailUrl("res_u0a_42");
    assert.ok(url, "el árbol de navegación conoce ReservationDetailWorkspace");
    assert.ok(url.startsWith("/recepcion/reservas/"), url);
    assert.ok(url.includes("res_u0a_42"), url);
  });
  it("ninguna acción navega a ReservationDetailWorkspace sin id (lectura de fuente)", () => {
    assert.equal(count('navigateTo("ReservationDetailWorkspace")'), 0);
    // U6: «Ver folio» / «Abrir ficha completa» del menú «⋯», la acción primaria «Abrir ficha» y el inspector, siempre con el id.
    assert.ok(count("openReservationDetail(row.reservationId)") >= 3, String(count("openReservationDetail(row.reservationId)")));
    assert.match(DASHBOARD_SOURCE, /if \(url\) openTabPath\(url\);/);
  });
});

// U6 · Mi día (docs/design/UX-RECEPCION-FEEL.md §5.1): filas normalizadas,
// buscador por nombre o habitación, sugerencia del motor (nunca una ocupada,
// F24) y reconciliación optimista de las tablas tras check-in / check-out /
// no-show / asignación (F23: sin `refresh()` completo).
const { applyCheckInToDashboard, applyCheckOutToDashboard, applyNoShowToDashboard, applyRoomToDashboard, filterFrontDeskRows, suggestedRoomFor, toFrontDeskRows } = await import("../FrontDeskDashboard.tsx");

const ROOMS = [
  { id: "r110", number: "110", roomTypeId: "dbl", status: "dirty", housekeepingStatus: "dirty", sellable: true },
  { id: "r101", number: "101", roomTypeId: "dbl", status: "occupied", housekeepingStatus: "clean", sellable: true },
  { id: "r118", number: "118", roomTypeId: "dbl", status: "clean", housekeepingStatus: "clean", sellable: true },
  { id: "r102", number: "102", roomTypeId: "dbl", status: "clean", housekeepingStatus: "inspected", sellable: true },
  { id: "r301", number: "301", roomTypeId: "sup", status: "clean", housekeepingStatus: "clean", sellable: true }
];

const DATA = {
  kpis: { arrivalsToday: 2, departuresToday: 1, inHouseNow: 5, unassignedRooms: 1, overdueDepartures: 0, pendingBalanceEur: 120 },
  arrivals: [
    { reservationId: "res_t1", guestName: "Apellido, Nombre", arrivalDate: "2026-09-19", nights: 2, roomTypeId: "dbl", roomTypeName: "Doble", status: "confirmed", balanceEur: 0, specialRequests: "UXDAY-T1 · llega sin habitación", vip: false, assignedRoomId: null },
    { reservationId: "res_a4", guestName: "Otro, Nombre", arrivalDate: "2026-09-19", nights: 2, roomId: "r305", assignedRoomId: "r305", roomNumber: "305", roomTypeId: "sup", roomTypeName: "Superior", status: "confirmed", balanceEur: 120, vip: true }
  ],
  departures: [{ reservationId: "res_t3", guestName: "Sale, Hoy", departureDate: "2026-09-19", roomId: "r204", assignedRoomId: "r204", roomNumber: "204", balanceEur: 120, status: "checked_in", vip: false }],
  inHouse: [{ reservationId: "res_t3", guestName: "Sale, Hoy", roomId: "r204", assignedRoomId: "r204", roomNumber: "204", departureDate: "2026-09-19", nightsRemaining: 0, balanceEur: 120, status: "checked_in", vip: false }],
  unassigned: [{ reservationId: "res_t1", guestName: "Apellido, Nombre", arrivalDate: "2026-09-19", roomTypeId: "dbl", roomTypeName: "Doble", assignedRoomId: null, vip: false }]
};

describe("Mi día · U6 · filas, buscador y sugerencia", () => {
  it("normaliza las cuatro tablas (ids, VIP, habitación sugerida solo sin asignar)", () => {
    const rows = toFrontDeskRows(DATA, "arrivals");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].roomNumber, undefined);
    assert.equal(rows[1].vip, true);
    assert.equal(rows[1].roomId, "r305");
    assert.equal(toFrontDeskRows(DATA, "unassigned")[0].status, "confirmed");
    assert.equal(toFrontDeskRows(null, "inhouse").length, 0);
    assert.equal(suggestedRoomFor(rows[0], ROOMS)?.number, "102", "la primera limpia (inspeccionada cuenta) y libre por número; nunca la 101 ocupada ni la 110 sucia");
    assert.equal(suggestedRoomFor(rows[1], ROOMS), null, "con habitación no se sugiere otra");
  });
  it("busca por nombre (sin acentos), habitación, código en las peticiones e id; «con saldo» filtra las que deben", () => {
    const rows = toFrontDeskRows(DATA, "arrivals");
    assert.equal(filterFrontDeskRows(rows, "apellido").length, 1);
    assert.equal(filterFrontDeskRows(rows, "305").length, 1);
    assert.equal(filterFrontDeskRows(rows, "uxday-t1").length, 1);
    assert.equal(filterFrontDeskRows(rows, "").length, 2);
    assert.equal(filterFrontDeskRows(rows, "", true).length, 1);
    assert.equal(filterFrontDeskRows(rows, "zzz").length, 0);
  });
});

describe("Mi día · deshacer el cambio de habitación (UX1-REV-04)", () => {
  it("el label del undo es el mensaje real («Cambio de la 101 a la 104»), nunca invertido", () => {
    const block = DASHBOARD_SOURCE.slice(DASHBOARD_SOURCE.indexOf("const assignRoom = useCallback("), DASHBOARD_SOURCE.indexOf("const handleSecondary"));
    assert.match(block, /const message = previous \? FRONT_DESK_TOASTS\.roomChanged\(previous\.number, room\.number\)/);
    assert.match(block, /undo: previous\s*\?\s*\{\s*label: message,/);
    assert.doesNotMatch(block, /roomChanged\(room\.number, previous\.number\)/);
    assert.equal(FRONT_DESK_TOASTS.roomChanged("101", "104"), "Cambio de la 101 a la 104");
  });
});

describe("Mi día · check-in optimista (L-17, §4.1)", () => {
  it("la fila pasa a «En el hotel» al pulsar el CTA (onSubmitted) y vuelve si el runner falla (onFailed → revalidar)", () => {
    assert.match(DASHBOARD_SOURCE, /onSubmitted=\{optimisticCheckIn\}/);
    assert.match(DASHBOARD_SOURCE, /onFailed=\{rollbackCheckIn\}/);
    assert.match(DASHBOARD_SOURCE, /const optimisticCheckIn = useCallback\([\s\S]*?applyCheckInToDashboard\(prev, info\.reservationId, \{ roomId: info\.roomId, roomNumber: info\.roomNumber \}\)/);
    const drawer = readFileSync(new URL("../QuickCheckInDrawer.tsx", import.meta.url), "utf8");
    assert.match(drawer, /onSubmitted\?\.\(\{ reservationId: reservation\.id, roomId: selectedRoomId, roomNumber: selectedRoom\?\.number \?\? null \}\);\s*try \{\s*const result = await runCheckin\(/, "se dispara ANTES del runner");
    assert.match(drawer, /onFailed\?\.\(reservation\.id\);/);
  });
  it("Mi día: KPI con el mismo literal que las pestañas, «Salen hoy» separa pendientes de hechas, y la tabla va antes que la cola (L-16, L-12)", () => {
    assert.match(DASHBOARD_SOURCE, /<CocoaKpi label="Llegan hoy"/);
    assert.match(DASHBOARD_SOURCE, /<CocoaKpi label="Salen hoy" value=\{fmtNumber\(departuresPending\)\}/);
    assert.doesNotMatch(DASHBOARD_SOURCE, /label="Llegadas hoy"|label="Salidas hoy"/);
    const kpiAt = DASHBOARD_SOURCE.indexOf('<CocoaKpiStrip stagger aria-label="Indicadores de hoy">');
    const tableAt = DASHBOARD_SOURCE.indexOf('<CocoaSection title="Movimientos de hoy">');
    const queueAt = DASHBOARD_SOURCE.indexOf("<FrontDeskActionQueue onWalkIn=");
    const helpAt = DASHBOARD_SOURCE.indexOf("<CocoaScreenInstructionsCard {...FRONTDESK_COCKPIT_INSTRUCTIONS}");
    assert.ok(kpiAt > 0 && kpiAt < tableAt && tableAt < queueAt && queueAt < helpAt, "orden: KPI → tabla → cola → ayuda");
    assert.match(DASHBOARD_SOURCE, />anticipo</, "saldo negativo = anticipo, no «a favor» (L-18)");
  });
});

describe("Mi día · U6 · reconciliación optimista (F23)", () => {
  it("check-in: la llegada pasa a «En el hotel» con su habitación, sale de «Sin habitación» y los KPI cuadran", () => {
    const next = applyCheckInToDashboard(DATA as never, "res_t1", { roomId: "r118", roomNumber: "118" });
    assert.equal(next.arrivals[0].status, "checked_in");
    assert.equal(next.arrivals[0].roomNumber, "118");
    assert.equal(next.unassigned.length, 0);
    assert.equal(next.kpis.inHouseNow, 6);
    assert.equal(next.kpis.unassignedRooms, 0);
    assert.equal(DATA.arrivals[0].status, "confirmed", "no muta el original");
  });
  it("check-out: la salida pasa a «Salida hecha» sin saldo y sale de «En el hotel»", () => {
    const next = applyCheckOutToDashboard(DATA as never, "res_t3");
    assert.equal(next.departures[0].status, "checked_out");
    assert.equal(next.departures[0].balanceEur, 0);
    assert.equal(next.inHouse.length, 0);
    assert.equal(next.kpis.inHouseNow, 4);
  });
  it("no-show: la llegada pasa a no-show y deja de contar", () => {
    const next = applyNoShowToDashboard(DATA as never, "res_t1");
    assert.equal(next.arrivals[0].status, "no_show");
    assert.equal(next.unassigned.length, 0);
    assert.equal(next.kpis.arrivalsToday, 1);
    assert.equal(next.kpis.unassignedRooms, 0);
  });
  it("asignar / cambiar habitación: todas las tablas ven la nueva habitación", () => {
    const next = applyRoomToDashboard(DATA as never, "res_t1", { id: "r118", number: "118" });
    assert.equal(next.arrivals[0].roomNumber, "118");
    assert.equal(next.arrivals[0].roomId, "r118");
    assert.equal(next.unassigned.length, 0);
    assert.equal(next.kpis.unassignedRooms, 0);
    const moved = applyRoomToDashboard(DATA as never, "res_t3", { id: "r205", number: "205" });
    assert.equal(moved.departures[0].roomNumber, "205");
    assert.equal(moved.inHouse[0].roomNumber, "205");
  });
  it("Mi día no recarga todo tras una acción: 0 `refresh()` en los cajones y `invalidateApi` de los dashboards", () => {
    assert.equal(count("onCompleted={({ elapsedSeconds }) => {"), 0);
    assert.ok(count('invalidateApi("/dashboards/front-desk")') >= 3);
    assert.match(DASHBOARD_SOURCE, /pollIntervalMs: 30000, staleTime: DASHBOARD_STALE_MS/);
    assert.match(DASHBOARD_SOURCE, /prefetchApi\(`\/reservations\/\$\{reservationId\}`/);
    assert.match(DASHBOARD_SOURCE, /if \(coarse \|\| lastPrefetched\.current === reservationId\) return;/, "prefetch solo con puntero fino");
    assert.equal(count("style={{"), 0, "0 style= inline nuevos");
  });
});
