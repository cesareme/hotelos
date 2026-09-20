import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PISOS_ACTIONS, PISOS_TOASTS } from "../../../content/pisos-actions.ts";
import { RESERVATION_ACTIONS } from "../../../content/actions.ts";

// Tanda UX-3 · P1 (docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md §4.5, §5 · F1,
// F3, F8): cajón de la casilla del tablero de habitaciones. «Bloquear
// habitación» abre el diálogo nominal («Bloquear la 305» / «Mantenerla en
// venta», destructivo); «Desbloquear» es directo con «Habitación 305
// desbloqueada.» y «Deshacer» (vuelve a bloquear); limpieza optimista con
// toast con número y deshacer; busy por casilla. Contrato de fuente sobre
// RoomRackScreen.tsx (la recepción — tiles, filtros, check-in/out — no cambia).

const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const source = stripComments(readFileSync(new URL("../RoomRackScreen.tsx", import.meta.url), "utf8"));
const between = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `bloque «${from}» … «${to}» presente`);
  return source.slice(start, end);
};
const blockRoom = between("async function blockRoom(", "async function unblockRoom(");
const unblockRoom = between("async function unblockRoom(", "async function deferHkWrite(");
const deferHkWrite = between("async function deferHkWrite(", "async function markDirty(");
const markDirty = between("async function markDirty(", "function handleHkStatus(");
const dialog = between("<CocoaDialog", "/>");
const detail = between("function RoomDetail(", "\n}\n");

describe("copia nominal del bloqueo (misma que la ficha de reserva)", () => {
  it("«Bloquear la 305» / «Mantenerla en venta» salen de RESERVATION_ACTIONS a través de PISOS_ACTIONS", () => {
    assert.equal(PISOS_ACTIONS.blockRoomConfirm("305"), "Bloquear la 305");
    assert.equal(PISOS_ACTIONS.blockRoomConfirm, RESERVATION_ACTIONS.blockRoomConfirm);
    assert.equal(PISOS_ACTIONS.keepRoomOnSale, "Mantenerla en venta");
    assert.equal(PISOS_TOASTS.roomBlocked("305"), "Habitación 305 bloqueada.");
    assert.equal(PISOS_TOASTS.roomUnblocked("305"), "Habitación 305 desbloqueada.");
  });
});

describe("«Bloquear habitación» abre un CocoaDialog nominal y destructivo (F8)", () => {
  it("el botón del cajón no escribe: solo abre el diálogo con la casilla", () => {
    assert.match(source, /const \[blockPrompt, setBlockPrompt\] = useState<Tile \| null>\(null\);/);
    assert.match(source, /onBlock=\{\(tile\) => setBlockPrompt\(tile\)\}/);
    assert.match(detail, /onClick=\{\(\) => onBlock\(tile\)\}>\s*\{PISOS_ACTIONS\.blockRoom\}/);
  });

  it("el diálogo es destructivo, con título y confirmación «Bloquear la NNN» y cancelación «Mantenerla en venta»", () => {
    assert.match(source, /\bCocoaDialog,/, "CocoaDialog importado de components/cocoa");
    assert.match(dialog, /tone="destructive"/);
    assert.match(dialog, /title=\{blockPrompt \? PISOS_ACTIONS\.blockRoomConfirm\(blockPrompt\.roomNumber\)/);
    assert.match(dialog, /confirmLabel=\{blockPrompt \? PISOS_ACTIONS\.blockRoomConfirm\(blockPrompt\.roomNumber\)/);
    assert.match(dialog, /cancelLabel=\{PISOS_ACTIONS\.keepRoomOnSale\}/);
    assert.match(dialog, /onConfirm=\{\(\) => \{\s*if \(blockPrompt\) void blockRoom\(blockPrompt\);/);
  });

  it("solo la confirmación envía sellable:false, optimista sobre el rack y con aviso con número", () => {
    assert.match(blockRoom, /setBlockPrompt\(null\);/);
    assert.match(blockRoom, /\(prev\) => rackWithTile\(prev, roomId, \(t\) => tileWithSellable\(t, false\)\)/);
    assert.match(blockRoom, /request<void>\(`\/rooms\/\$\{roomId\}\/sellable`, \{ method: "POST", body: \{ sellable: false \} \}\)/);
    assert.match(blockRoom, /showToast\(PISOS_TOASTS\.roomBlocked\(roomNumber\), \{ variant: "success" \}\)/);
    assert.doesNotMatch(blockRoom, /undo:/, "bloquear no ofrece deshacer: lo protege el diálogo (§5)");
  });
});

describe("«Desbloquear habitación» es directo con «Deshacer» que vuelve a bloquear (§5)", () => {
  it("POST sellable:true optimista y `undo` con el aviso con número y el POST inverso sellable:false", () => {
    assert.match(detail, /onClick=\{\(\) => onUnblock\(tile\)\}>\s*\{PISOS_ACTIONS\.unblockRoom\}/);
    assert.match(source, /onUnblock=\{\(tile\) => void unblockRoom\(tile\)\}/);
    assert.match(unblockRoom, /\(prev\) => rackWithTile\(prev, roomId, \(t\) => tileWithSellable\(t, true\)\)/);
    assert.match(unblockRoom, /body: \{ sellable: true \}/);
    assert.match(unblockRoom, /undo: \{\s*label: PISOS_TOASTS\.roomUnblocked\(roomNumber\),\s*onUndo: async \(\) => \{/);
    assert.match(unblockRoom, /tileWithSellable\(t, false\)/);
    assert.match(unblockRoom, /body: \{ sellable: false \}/);
    assert.match(unblockRoom, /showToast\(PISOS_TOASTS\.roomBlocked\(roomNumber\), \{ variant: "info" \}\)/);
  });
});

describe("limpieza desde el cajón: optimista, con número y con deshacer (§4.5)", () => {
  it("«Marcar limpia» / «Inspeccionada» difieren el POST 8 s y deshacer no envía nada", () => {
    assert.match(source, /import \{ deferredCommit, undoDeferred, type DeferredFlushReason \} from "\.\/deferred-commit";/);
    assert.match(deferHkWrite, /const pending = deferredCommit\(HK_UNDO_MS\);/);
    assert.match(deferHkWrite, /label: PISOS_ACTIONS\.undo/);
    // REV-01: el toast no se pausa (la ventana tampoco) y un «Deshacer» tardío avisa «Habitación NNN ya enviada» en vez de callar.
    assert.match(deferHkWrite, /duration: HK_UNDO_MS,\s*pauseOnHover: false,/);
    assert.match(deferHkWrite, /if \(!undoDeferred\(pending, \(\) => showToast\(PISOS_TOASTS\.undoExpired\(roomNumber\), \{ variant: "warning" \}\)\)\) return;/);
    assert.doesNotMatch(deferHkWrite, /if \(pending\.settled\(\)\) return;/);
    assert.match(deferHkWrite, /const go = await pending\.wait\(\);\s*if \(!go\) return;/);
    assert.match(deferHkWrite, /keepalive: pending\.reason\(\) === "pagehide"/);
    assert.match(deferHkWrite, /PISOS_TOASTS\.roomClean\(roomNumber\) : PISOS_TOASTS\.roomInspected\(roomNumber\)/);
    assert.match(source, /window\.addEventListener\("pagehide", onPageHide\);/);
  });

  it("«Marcar sucia» es directa con deshacer por POST inverso (clean o inspected, la limpieza anterior)", () => {
    assert.match(markDirty, /body: \{ status: "dirty" \}/);
    assert.match(markDirty, /undo: \{\s*label: PISOS_TOASTS\.roomDirty\(roomNumber\)/);
    assert.match(markDirty, /body: \{ status: previous \}/);
    assert.match(source, /function handleHkStatus\(tile: Tile, status: HkWrite\) \{\s*if \(status === "dirty"\) void markDirty\(tile\);\s*else void deferHkWrite\(tile, status\);/);
  });

  it("ningún aviso sin número: fuera «Habitación bloqueada», «Habitación desbloqueada» y «Habitación marcada como …»", () => {
    assert.doesNotMatch(source, /"Habitación desbloqueada"/);
    assert.doesNotMatch(source, /"Habitación bloqueada"/);
    assert.doesNotMatch(source, /Habitación marcada como/);
    assert.doesNotMatch(source, /async function postAction\(/, "las escrituras pasan por el request vigilado de mutate");
  });
});

describe("busy POR casilla (F1) y recepción intacta", () => {
  it("el estado ocupado es un Set por habitación y el cajón lo lee por su casilla", () => {
    assert.doesNotMatch(source, /useState\(false\)/);
    assert.match(source, /const \[busyRooms, setBusyRooms\] = useState<ReadonlySet<string>>/);
    assert.match(source, /busy=\{busyRooms\.has\(selectedTile\.roomId\)\}/);
    assert.match(dialog, /busy=\{blockPrompt \? busyRooms\.has\(blockPrompt\.roomId\) : false\}/);
  });

  it("«Actualizar» con escrituras pendientes las envía antes (la revalidación llega al terminar)", () => {
    assert.match(source, /const refreshRack = useCallback\(\(\) => \{\s*if \(pendingByRoom\.current\.size > 0\) \{\s*flushPending\("manual"\);\s*return;\s*\}\s*refresh\(\);/);
    assert.match(source, /onClick=\{refreshRack\}/);
  });

  it("tiles, filtros y check-in/out siguen igual (solo cambia el cajón)", () => {
    assert.match(source, /<div className="c22-tile-grid">/);
    assert.match(source, /aria-label="Filtrar por estado"/);
    assert.match(source, /<QuickCheckInDrawer/);
    assert.match(source, /<QuickCheckOutDrawer/);
    assert.match(detail, /Hacer check-out/);
    assert.match(detail, /Hacer check-in del próximo huésped/);
  });
});
