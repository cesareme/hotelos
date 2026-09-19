import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Tanda UX-1 · lote U5 (docs/design/UX-RECEPCION-FEEL.md §4 «Paleta ⌘K
// ampliada», F16, §7.1 2.1.1): la lógica pura de ordenación y filtro de la
// paleta ⌘K vive exportada en components/CommandPalette.tsx. Ese módulo llega
// (services/searchApi → services/api-client) a `import.meta.env`: mismo gancho
// que hooks/__tests__/useApiData.test.mts.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const palette = await import("../CommandPalette.tsx");
const PALETTE_SOURCE = readFileSync(new URL("../CommandPalette.tsx", import.meta.url), "utf8");

const noop = () => undefined;
const TODAY = "2026-09-19";

type Hit = { kind: string; id: string; title: string; subtitle?: string; badge?: string; screen: string };
const reservation = (id: string, badge: string, arrival: string, departure: string): Hit => ({
  kind: "reservation",
  id,
  title: `UXDAY-${id}`,
  subtitle: `Huésped de prueba · ${arrival} → ${departure} · direct`,
  badge,
  screen: "ReservationDetailWorkspace"
});
const room = (id: string, number: string): Hit => ({ kind: "room", id, title: `Habitación ${number}`, badge: "clean", screen: "RoomInventoryManager" });
const guest = (id: string): Hit => ({ kind: "guest", id, title: "Huésped de prueba", screen: "GuestDetail" });

describe("CommandPalette · comandos de la página (F16)", () => {
  const commands = [
    { id: "front-desk-refresh", label: "Actualizar recepción", run: noop },
    { id: "front-desk-new-reservation", label: "Crear reserva", run: noop, shortcut: "⌥N" },
    { id: "front-desk-timeline", label: "Abrir Live Timeline", run: noop }
  ];

  it("lista todos con la consulta vacía, bajo «Esta pantalla», con su atajo", () => {
    const items = palette.pageCommandItems(commands, "");
    assert.deepEqual(items.map((item) => item.label), ["Actualizar recepción", "Crear reserva", "Abrir Live Timeline"]);
    assert.ok(items.every((item) => item.source === "page" && item.group === palette.PAGE_GROUP));
    assert.equal(items[1].shortcut, "⌥N");
    assert.equal(items[1].id, "page:front-desk-new-reservation");
    assert.equal(items[0].run, commands[0].run);
  });

  it("filtra sin acentos ni mayúsculas", () => {
    assert.deepEqual(palette.pageCommandItems(commands, "RECEPCION").map((item) => item.label), ["Actualizar recepción"]);
    assert.deepEqual(palette.pageCommandItems(commands, "live").map((item) => item.label), ["Abrir Live Timeline"]);
    assert.deepEqual(palette.pageCommandItems(commands, "zeta"), []);
  });
});

describe("CommandPalette · habitación por número y acciones sobre reservas de hoy", () => {
  it("detecta una consulta de número de habitación y sube las habitaciones", () => {
    assert.equal(palette.isRoomNumberQuery("204"), true);
    assert.equal(palette.isRoomNumberQuery(" 12 "), true);
    assert.equal(palette.isRoomNumberQuery("101A"), true);
    assert.equal(palette.isRoomNumberQuery("Zeta"), false);
    assert.equal(palette.isRoomNumberQuery("RES-204"), false);
    assert.equal(palette.isRoomNumberQuery("20455"), false);
    const hits = [reservation("t3", "checked_in", "2026-09-17", TODAY), room("r204", "204"), guest("g1")];
    assert.deepEqual(palette.rankLiveHits(hits, "204").map((hit) => hit.id), ["r204", "t3", "g1"]);
    assert.deepEqual(palette.rankLiveHits(hits, "zeta").map((hit) => hit.id), ["t3", "r204", "g1"], "otras consultas conservan el orden del API");
  });

  it("L-05 / R4: el badge de reserva y habitación pasa por el diccionario (nunca el enum crudo) y el subtítulo lleva fechas y canal legibles", () => {
    const hit = palette.hitPresentation({ kind: "reservation", badge: "checked_in", subtitle: "Clara Zeta · 2026-09-18 → 2026-09-20 · direct" });
    assert.equal(hit.badge, "En el hotel");
    assert.equal(hit.badgeTone, "success");
    assert.match(hit.subtitle ?? "", /^Clara Zeta · .*sep.* → .*sep.* · Directo$/);
    assert.doesNotMatch(hit.subtitle ?? "", /2026-09-18|direct$/);
    assert.deepEqual(palette.hitPresentation({ kind: "room", badge: "DIRTY", subtitle: "Planta 2" }), { badge: "Sucia", badgeTone: "warning", subtitle: "Planta 2" });
    assert.equal(palette.hitPresentation({ kind: "room", badge: "occupied" }).badge, "Ocupada");
    assert.equal(palette.hitPresentation({ kind: "guest", badge: "VIP" }).badge, "VIP", "otros tipos conservan su badge");
    const items = palette.liveHitItems([reservation("t6", "checked_in", "2026-09-18", "2026-09-20")], "zeta", TODAY);
    assert.equal(items[0].badge, "En el hotel");
    assert.equal(items[0].hit?.badge, "checked_in", "la acción «Cobrar» sigue leyendo el enum del hit");
    assert.equal(items[1]?.label, "Cobrar");
    assert.match(PALETTE_SOURCE, /useLayoutEffect\(\(\) => \{\s*if \(!props\.open\) return;\s*const input = inputRef\.current;/, "L-10: el buscador toma el foco antes de pintar, sin setTimeout");
    assert.doesNotMatch(PALETTE_SOURCE, /setTimeout\(\(\) => \{\s*const input = inputRef/);
  });

  it("lee las fechas del subtítulo de /search", () => {
    assert.deepEqual(palette.reservationDatesOf(reservation("t1", "confirmed", TODAY, "2026-09-21")), { arrival: TODAY, departure: "2026-09-21" });
    assert.equal(palette.reservationDatesOf({ subtitle: "sin fechas" }), null);
    assert.equal(palette.reservationDatesOf({}), null);
  });

  it("ofrece «Check-in» a la llegada confirmada de hoy y «Cobrar» al alojado; nada a otros días ni a otras entidades", () => {
    assert.deepEqual(palette.hitActionsFor(reservation("t1", "confirmed", TODAY, "2026-09-21"), TODAY), [
      { id: "checkin", label: "Check-in", event: palette.OPEN_CHECKIN_EVENT }
    ]);
    assert.deepEqual(palette.hitActionsFor(reservation("t3", "checked_in", "2026-09-17", TODAY), TODAY), [
      { id: "payment", label: "Cobrar", event: palette.OPEN_PAYMENT_EVENT }
    ]);
    assert.deepEqual(palette.hitActionsFor(reservation("t9", "confirmed", "2026-09-20", "2026-09-22"), TODAY), [], "llega mañana");
    assert.deepEqual(palette.hitActionsFor(reservation("t8", "checked_out", "2026-09-17", TODAY), TODAY), []);
    assert.deepEqual(palette.hitActionsFor(reservation("t7", "cancelled", TODAY, "2026-09-21"), TODAY), []);
    assert.deepEqual(palette.hitActionsFor(room("r204", "204"), TODAY), []);
    assert.deepEqual(palette.hitActionsFor(guest("g1"), TODAY), []);
    assert.equal(palette.OPEN_CHECKIN_EVENT, "hotelos-open-checkin");
    assert.equal(palette.OPEN_PAYMENT_EVENT, "hotelos-open-payment");
  });

  it("coloca cada acción justo debajo de su reserva, en el mismo grupo", () => {
    const items = palette.liveHitItems([reservation("t1", "confirmed", TODAY, "2026-09-21"), guest("g1")], "prueba", TODAY);
    assert.deepEqual(items.map((item) => [item.source, item.label]), [
      ["entity", "UXDAY-t1"],
      ["hit-action", "Check-in"],
      ["entity", "Huésped de prueba"]
    ]);
    assert.equal(items[1].group, items[0].group);
    assert.equal(items[1].event, palette.OPEN_CHECKIN_EVENT);
    assert.equal(items[1].hit, items[0].hit);
    assert.equal(items[1].id, "hit:reservation:t1:checkin");
  });

  it("el evento de acción es cancelable y lleva reservationId, código y hit", () => {
    const hit = reservation("t3", "checked_in", "2026-09-17", TODAY);
    const event = palette.hitActionEvent(palette.OPEN_PAYMENT_EVENT, hit as never);
    assert.equal(event.type, "hotelos-open-payment");
    assert.equal(event.cancelable, true);
    assert.deepEqual(event.detail, { reservationId: "t3", code: "UXDAY-t3", hit });
    assert.equal(event.defaultPrevented, false);
    event.preventDefault();
    assert.equal(event.defaultPrevented, true, "un consumidor reclama la acción con preventDefault()");
  });
});

describe("CommandPalette · orden final y accesibilidad", () => {
  const item = (source: string, label: string, group = "G"): never => ({ source, id: `${source}:${label}`, label, screen: "", group }) as never;

  it("comandos de la página primero, luego resultados, recientes solo sin consulta, pantallas y acciones", () => {
    const input = {
      pageItems: [item("page", "Crear reserva")],
      liveItems: [item("entity", "UXDAY-t1")],
      recentItems: [item("recent", "Mi día")],
      screenItems: [item("screen", "Reservas")],
      actionItems: [item("action", "Ver avisos")]
    };
    assert.deepEqual(palette.buildPaletteItems({ ...input, query: "" }).map((it) => it.label), ["Crear reserva", "UXDAY-t1", "Mi día", "Reservas", "Ver avisos"]);
    assert.deepEqual(palette.buildPaletteItems({ ...input, query: "re" }).map((it) => it.label), ["Crear reserva", "UXDAY-t1", "Reservas", "Ver avisos"]);
  });

  it("filtra pantallas por etiqueta o categoría y respeta el tope", () => {
    const screens = [item("screen", "Mi día", "Hoy"), item("screen", "Reservas · Lista", "Recepción"), item("screen", "Huéspedes", "Recepción")];
    assert.deepEqual(palette.filterScreenItems(screens, "recepcion").map((it) => it.label), ["Reservas · Lista", "Huéspedes"]);
    assert.deepEqual(palette.filterScreenItems(screens, "MI DIA").map((it) => it.label), ["Mi día"]);
    assert.equal(palette.filterScreenItems(screens, "", 2).length, 2);
  });

  it("deriva ids de opción válidos para aria-activedescendant", () => {
    assert.equal(palette.optionDomId(":r1:", "hit:reservation:res_uxday_t6:checkin"), ":r1:-hit_reservation_res_uxday_t6_checkin");
    assert.equal(palette.optionDomId("list", "page:front-desk-refresh"), "list-page_front-desk-refresh");
    assert.equal(palette.todayIso(new Date(2026, 8, 19, 23, 30)), "2026-09-19");
  });

  it("la fuente cablea aria-activedescendant sobre el buscador (searchbox) y se suscribe al registro de comandos", () => {
    assert.match(PALETTE_SOURCE, /aria-activedescendant=\{activeDomId\}/);
    assert.match(PALETTE_SOURCE, /type="search"/);
    assert.doesNotMatch(PALETTE_SOURCE, /role="combobox"/, "el buscador sigue siendo un searchbox (e2e measure T6 lo localiza así)");
    assert.match(PALETTE_SOURCE, /subscribePageCommands\(/);
    assert.match(PALETTE_SOURCE, /<CocoaKbd>\{item\.shortcut\}<\/CocoaKbd>/);
    assert.doesNotMatch(PALETTE_SOURCE, /style=\{/, "0 style= nuevos (contrato Cocoa 22)");
  });
});
