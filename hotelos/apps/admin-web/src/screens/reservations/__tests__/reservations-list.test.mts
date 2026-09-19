import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// U8 · Lista, huéspedes y mensajes (docs/design/UX-RECEPCION-FEEL.md §5.7-5.9,
// F10, F11, F25, F26, F34, D11, R13): el filtro por habitación es puro y va en
// cliente (nunca como `q`), la tabla no se vacía al teclear ni al cambiar de
// pestaña (0 `setLoading(true)` y `keepDataWhileLoading`), las preferencias de
// columnas se guardan bajo `reservas.lista`, los contadores se difieren y
// huéspedes / mensajes siguen los mismos patrones. Mismo gancho que
// frontdesk-batch.test.mts para `import.meta.env` de api-client.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const list = await import("../ReservationsListScreen.tsx");
const guests = await import("../../guests/GuestsListScreen.tsx");
const concierge = await import("../../operations/ConciergeInboxDashboard.tsx");
const { applyColumnPrefs, columnPrefsStorageKey, readColumnPrefs, writeColumnPrefs } = await import("../../../components/cocoa/CocoaTable.tsx");

const SRC = new URL("../../", import.meta.url);
/** Fuente sin comentarios: solo cuenta el código renderizado. */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(new URL(rel, SRC), "utf8"));

const TODAY = "2026-09-19";

describe("lista · filtro por habitación (F10, R13: en cliente, nunca como q)", () => {
  it("reconoce un número de habitación y no un nombre ni un código", () => {
    for (const term of ["204", " 204 ", "12", "101B", "1"]) assert.equal(list.isRoomQuery(term), true, term);
    for (const term of ["García", "UXDAY-T3", "RES-00034", "", "12345", "20 4", "a204"]) assert.equal(list.isRoomQuery(term), false, term);
  });

  it("filtra la página cargada por número igual, por prefijo y por código", () => {
    const rows = [
      { code: "UXDAY-T3", roomNumber: "204" },
      { code: "UXDAY-D2", roomNumber: "205" },
      { code: "UXDAY-T1", roomNumber: null },
      { code: "RES-2041", roomNumber: "310" }
    ];
    assert.deepEqual(list.filterRowsByRoom(rows, "204").map((r) => r.code), ["UXDAY-T3", "RES-2041"]);
    assert.deepEqual(list.filterRowsByRoom(rows, "20").map((r) => r.code), ["UXDAY-T3", "UXDAY-D2", "RES-2041"]);
    assert.deepEqual(list.filterRowsByRoom(rows, "310").map((r) => r.code), ["RES-2041"]);
    assert.deepEqual(list.filterRowsByRoom(rows, "999"), []);
    assert.equal(list.filterRowsByRoom(rows, "  ").length, rows.length, "sin término, todas las filas");
  });

  it("una habitación no viaja como q; un nombre sí; la ventana de salidas y el cursor se conservan", () => {
    const room = list.reservationListQuery({ tab: "in_house", today: TODAY, term: "204" });
    assert.equal(room.q, undefined);
    assert.deepEqual(room.status, ["checked_in"]);
    assert.equal(room.limit, list.PAGE_SIZE);
    const name = list.reservationListQuery({ tab: "today_arrivals", today: TODAY, term: "García", cursor: "abc" });
    assert.equal(name.q, "García");
    assert.equal(name.cursor, "abc");
    assert.equal(name.arrivalFrom, TODAY);
    assert.equal(list.reservationListQuery({ tab: "today_departures", today: TODAY, term: "" }).limit, list.DEPARTURES_WINDOW_LIMIT);
  });

  it("serializa la query como pmsCommerceApi (arrays → csv, envelope → 1, vacíos fuera)", () => {
    const serialized = list.serializeListQuery({ status: ["confirmed", "checked_in"], q: undefined, limit: 100, arrivalFrom: TODAY, arrivalTo: TODAY, sort: "arrival_asc" });
    assert.deepEqual(serialized, { status: "confirmed,checked_in", limit: 100, arrivalFrom: TODAY, arrivalTo: TODAY, sort: "arrival_asc", envelope: "1" });
    assert.equal("q" in serialized, false);
  });

  it("resuelve el número de habitación por id del catálogo", () => {
    assert.deepEqual(list.roomNumbersById([{ id: "room_204", number: "204" }]), { room_204: "204" });
    assert.deepEqual(list.roomNumbersById(null), {});
  });
});

describe("lista · contadores diferidos (F34)", () => {
  it("solo sondea los KPI que faltan y nunca la pestaña activa (que sale del sobre de paginación)", () => {
    assert.deepEqual(list.tabsToProbe("today_arrivals", {}), ["in_house", "today_departures", "future"]);
    assert.deepEqual(list.tabsToProbe("in_house", { future: 3 }), ["today_arrivals", "today_departures"]);
    assert.deepEqual(list.tabsToProbe("all", { today_arrivals: 6, in_house: 51, today_departures: 5, future: 9 }), []);
    assert.equal(list.KPI_TABS.includes("all"), false, "«Todas» y «Canceladas» se cuentan al visitarlas");
    assert.equal(list.KPI_TABS.includes("cancelled"), false);
    assert.equal(list.COUNTS_TTL_MS, 30_000);
  });

  it("en la fuente el único lote de sondeos se dispara diferido tras la primera página y no hay limit: 1 al montar", () => {
    const source = read("reservations/ReservationsListScreen.tsx");
    assert.match(source, /window\.setTimeout\(\(\) => \{\s*probed\.current = true;\s*void loadCounts\(tab\);\s*\}, 0\)/);
    assert.match(source, /tabsToProbe\(current, readCountsCache\(countsScope\)\)/);
    assert.match(source, /const count = tab === "today_departures" \? [\s\S]*?: page\.data\.total;/, "la pestaña activa se cuenta con `total` del sobre");
    assert.equal((source.match(/limit: 1\b/g) ?? []).length, 1, "un solo sitio pide limit=1 (el lote diferido)");
    assert.doesNotMatch(source, /useEffect\(\(\) => \{\s*void loadCounts\(\);/);
  });
});

describe("lista · la tabla no se vacía (F11) y lleva inspector, lote y columnas (F25, F26, D11)", () => {
  const source = read("reservations/ReservationsListScreen.tsx");

  it("0 setLoading(true) y 0 rows={[]}: la página vive en useApiData y la tabla mantiene las filas bajo el velo", () => {
    assert.equal((source.match(/setLoading\(true\)/g) ?? []).length, 0);
    assert.equal((source.match(/rows=\{\[\]\}/g) ?? []).length, 0);
    assert.match(source, /useApiData<Page<AdminReservation>>\(LIST_PATH, \{ query: serializedQuery, staleTime: LIST_STALE_MS \}\)/);
    assert.match(source, /loading=\{page\.loading\}\s+keepDataWhileLoading/);
    assert.match(source, /const stale = page\.loading && page\.data !== null;/);
    assert.match(source, /const base = stale \? reservations : reservations\.filter/, "las filas de la clave anterior no se refinan con la pestaña nueva");
  });

  it("busca por nombre, código o habitación y ⌥F enfoca el buscador", () => {
    assert.match(source, /placeholder="Buscar por nombre, código o habitación…"/);
    assert.match(source, /window\.addEventListener\(FOCUS_SEARCH_EVENT, onFocusSearch\)/);
    assert.match(source, /document\.getElementById\(SEARCH_INPUT_ID\)/);
  });

  it("inspector no modal con la barra de comandos de U6 (primaryActionFor), folio abreviado y «Abrir ficha completa»; ↑↓ lo mueven", () => {
    assert.match(source, /<CocoaInspectorLayout open=\{Boolean\(inspectorRow\)\}>/);
    assert.match(source, /<CocoaInspector\s+open\s+title=\{title\}/);
    assert.match(source, /primaryActionFor\(/);
    assert.match(source, /aria-label="Folio abreviado"/);
    assert.match(source, /\{FRONT_DESK_ACTIONS\.openFullReservation\}/);
    assert.match(source, /event\.key !== "ArrowDown" && event\.key !== "ArrowUp"/);
    assert.match(source, /setInspectorId\(\(current\) => \(current === row\.id \? null : row\.id\)\)/);
  });

  it("selección múltiple con barra de lote: fichas, asignar y check-out solo de las que no deben nada", () => {
    assert.match(source, /selectable="multiple"/);
    assert.match(source, /batchBar=\{batchBar\}/);
    assert.match(source, /FRONT_DESK_ACTIONS\.printCards\(selection\.count\)/);
    assert.match(source, /FRONT_DESK_ACTIONS\.batchAssign\(assignPlan\.length\)/);
    assert.match(source, /FRONT_DESK_ACTIONS\.batchCheckOut\(checkOutCandidates\.length\)/);
    assert.match(source, /balances\[row\.id\] !== undefined && balances\[row\.id\] <= CENT && row\.departureDate\.slice\(0, 10\) <= today/, "los saldos se comprueban por folio y solo salen en lote las que salen hoy (UX1-REV-01)");
    assert.match(source, /runBatch\(items, run/);
  });

  it("columnas configurables bajo reservas.lista y densidad operativa por dispositivo (U10, D10), nunca fija", () => {
    assert.equal(list.COLUMNS_PREFS_KEY, "reservas.lista");
    assert.match(source, /columnsPrefsKey=\{COLUMNS_PREFS_KEY\}/);
    assert.doesNotMatch(source, /density="(compact|comfortable)"/);
    assert.match(source, /<CocoaPage\n[\s\S]*?density="operational"/);
  });

  it("las preferencias de columnas se leen y escriben bajo hotelos-table-columns:reservas.lista", () => {
    const keys = ["code", "guestName", "roomNumber", "arrivalDate", "departureDate", "roomTypeLabel", "sourceCode", "totalAmount", "status"];
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    assert.equal(columnPrefsStorageKey(list.COLUMNS_PREFS_KEY), "hotelos-table-columns:reservas.lista");
    assert.equal(readColumnPrefs(storage, list.COLUMNS_PREFS_KEY, keys), null);
    writeColumnPrefs(storage, list.COLUMNS_PREFS_KEY, { order: keys, hidden: ["sourceCode"] });
    const prefs = readColumnPrefs(storage, list.COLUMNS_PREFS_KEY, keys);
    assert.deepEqual(prefs?.hidden, ["sourceCode"]);
    const visible = applyColumnPrefs(keys.map((key) => ({ key, label: key })), prefs).map((column) => column.key);
    assert.deepEqual(visible, keys.filter((key) => key !== "sourceCode"));
  });

  it("UX1-REV-12: los saldos de la selección se sondean de 6 en 6 y un folio que falla queda marcado (NaN), nunca «Comprobando…» para siempre", async () => {
    assert.equal(list.BALANCE_PROBE_CONCURRENCY, 6);
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const out = await list.probeBalances(ids, async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (id === "r3") throw new Error("500");
      if (id === "r7") return undefined;
      return Number(id.slice(1));
    });
    assert.equal(peak <= 6, true, `pico ${peak}`);
    assert.equal(out.r0, 0);
    assert.equal(out.r19, 19);
    assert.ok(Number.isNaN(out.r3) && Number.isNaN(out.r7));
    assert.match(source, /balancesFailed > 0 \? `Saldo sin comprobar en \$\{balancesFailed\}/);
  });
  it("el huésped sigue resolviéndose con la caché de nombres compartida (qa#7) y una petición por id", () => {
    assert.match(source, /const GUEST_NAME_CACHE: Record<string, string> = \{\};/);
    assert.match(source, /pendingGuestIds\(reservations, requestedGuestIds\)/);
    assert.match(source, /Object\.assign\(GUEST_NAME_CACHE, resolved\)/);
  });
});

describe("huéspedes · lista con keepData, habitación de la estancia actual e inspector (§5.8)", () => {
  const source = read("guests/GuestsListScreen.tsx");

  it("titulares de la habitación buscada: solo estancias en el hotel, número igual o prefijo, sin duplicados", () => {
    const rooms = [{ id: "r204", number: "204" }, { id: "r205", number: "205" }, { id: "r310", number: "310" }];
    const reservations = [
      { status: "checked_in", assignedRoomId: "r204", primaryGuestId: "g1" },
      { status: "checked_in", assignedRoomId: "r205", primaryGuestId: "g2" },
      { status: "confirmed", assignedRoomId: "r204", primaryGuestId: "g3" },
      { status: "checked_in", assignedRoomId: "r204", primaryGuestId: "g1" },
      { status: "checked_in", assignedRoomId: undefined, primaryGuestId: "g4" }
    ];
    assert.deepEqual(guests.guestIdsInRoom(reservations, rooms, "204"), ["g1"]);
    assert.deepEqual(guests.guestIdsInRoom(reservations, rooms, "20"), ["g1", "g2"]);
    assert.deepEqual(guests.guestIdsInRoom(reservations, rooms, "310"), []);
    assert.deepEqual(guests.guestIdsInRoom(reservations, rooms, ""), []);
  });

  it("«Nueva reserva para este huésped» prefija el modo rápido por ?guestId= y la estancia de hoy es la que está en el hotel", () => {
    assert.equal(guests.newReservationUrlForGuest("guest_1", "/recepcion/reservas/nueva"), "/recepcion/reservas/nueva?guestId=guest_1");
    assert.equal(guests.newReservationUrlForGuest("a b", "/x"), "/x?guestId=a%20b");
    assert.deepEqual(guests.currentStayOf([{ id: "s1", status: "checked_out" }, { id: "s2", status: "checked_in" }]), { id: "s2", status: "checked_in" });
    assert.equal(guests.currentStayOf([{ id: "s1", status: "confirmed" }]), null);
    assert.equal(guests.NEW_RESERVATION_FOR_GUEST, "Nueva reserva para este huésped");
    assert.equal(guests.OPEN_TODAY_STAY, "Abrir la estancia de hoy");
  });

  it("en la fuente: 0 setLoading(true), keepDataWhileLoading, inspector, ⌥F y búsqueda por habitación", () => {
    assert.equal((source.match(/setLoading\(true\)/g) ?? []).length, 0);
    assert.equal((source.match(/rows=\{\[\]\}/g) ?? []).length, 0);
    assert.match(source, /loading=\{loading\}\s+keepDataWhileLoading/);
    assert.match(source, /<CocoaInspectorLayout open=\{Boolean\(inspectorGuest\)\}>/);
    assert.match(source, /window\.addEventListener\(FOCUS_SEARCH_EVENT, onFocusSearch\)/);
    assert.match(source, /guestIdsInRoom\(inHouse\.data\?\.items \?\? \[\], roomsState\.data \?\? \[\], term\)/);
    assert.match(source, /placeholder="Nombre, empresa, email, documento o habitación…"/);
    assert.equal((source.match(/style=\{/g) ?? []).length, 1, "un solo style= (el overflow: clip heredado); los subtítulos van con .cocoa-note");
  });
});

describe("ficha del huésped · barra de comandos y keepData (§5.8, sin cambios de estructura)", () => {
  const source = read("guests/GuestProfileScreen.tsx");
  it("primaria «Abrir la estancia de hoy» si está en el hotel, si no «Nueva reserva para este huésped» (?guestId=)", () => {
    assert.match(source, /const currentStay = stays\.find\(\(stay\) => stay\.status === "checked_in"\) \?\? null;/);
    assert.match(source, /currentStay \? \{ label: OPEN_TODAY_STAY, run: \(\) => openReservation\(currentStay\.id\) \} : \{ label: NEW_RESERVATION_FOR_GUEST, run: openNewReservation \}/);
    assert.match(source, /\?guestId=\$\{encodeURIComponent\(guestId\)\}/);
  });
  it("el esqueleto solo sale la primera vez y las estancias se mantienen bajo el velo", () => {
    assert.match(source, /state=\{loading && !detail \? "loading" : error && !detail \? "error" : "ready"\}/);
    assert.match(source, /loading=\{loading\}\s+keepDataWhileLoading/);
    assert.match(source, /<CocoaStatusBadge entry=\{reservationStatus\(s\.status\)\} \/>/);
  });
});

describe("mensajes · sondeo pausado, bandeja que no se vacía y badge de estado (§5.9)", () => {
  const source = read("operations/ConciergeInboxDashboard.tsx");
  it("el filtro de la bandeja es puro y el estado desconocido nunca llega crudo", () => {
    const rows = [
      { id: "conv_1", guestId: "g1", channel: "whatsapp", status: "open" },
      { id: "conv_2", guestId: undefined, channel: "email", status: "handoff" },
      { id: "conv_3", guestId: "g3", channel: "sms", status: "closed" }
    ];
    assert.deepEqual(concierge.filterConversations(rows, "whats").map((r) => r.id), ["conv_1"]);
    assert.deepEqual(concierge.filterConversations(rows, "persona").map((r) => r.id), ["conv_2"]);
    assert.deepEqual(concierge.filterConversations(rows, "g3").map((r) => r.id), ["conv_3"]);
    assert.equal(concierge.filterConversations(rows, "").length, 3);
    assert.equal(concierge.conversationStatus("handoff").label, "Pasada a persona");
    assert.equal(concierge.conversationStatus("weird").label, "Desconocido");
    assert.equal(concierge.conversationStatus("OPEN ").tone, "success");
  });
  it("en la fuente: staleTime explícito junto al sondeo, keepDataWhileLoading en la bandeja y CocoaStatusBadge", () => {
    assert.match(source, /pollIntervalMs: POLL_MS,\s*staleTime: STALE_MS/);
    assert.match(source, /rows=\{shownRecent\} rowKey="id" loading=\{revalidating\} keepDataWhileLoading/);
    assert.match(source, /<CocoaStatusBadge entry=\{conversationStatus\(r\.status\)\} \/>/);
    assert.doesNotMatch(source, /CocoaBadge tone=\{s\.tone\}/);
  });
});
