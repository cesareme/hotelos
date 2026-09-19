import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dialogCopy, type DialogCopyContext } from "../timeline-dialog-copy.ts";
import type { AdminReservation } from "../../../services/pmsCommerceApi.ts";
import type { PendingChange } from "../../../screens/timeline/timeline-engine.ts";

// Tanda TL · lote TL-4: el copy de los diálogos es puro (solo lib/format, el
// diccionario de acciones y el motor) y se prueba en runtime con una reserva
// inventada; los tres componentes React se pinchan sobre la fuente (Cocoa 22
// estricto con CERO `style={`, sin red, sin Intl, sin `undoLabel`: el toast de
// deshacer lo etiqueta `undoEntryFor` del motor).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const res: AdminReservation = {
  id: "res-1",
  propertyId: "prop-ra",
  code: "RA-1001",
  channel: "booking_com",
  status: "confirmed",
  arrivalDate: "2026-09-21",
  departureDate: "2026-09-24",
  adults: 2,
  children: 1,
  roomTypeId: "type-dbl",
  assignedRoomId: "room-202",
  totalAmount: 390,
  currency: "EUR",
  primaryGuestId: "guest-1",
  bookerName: "Ana Pérez"
};

const ROOMS: Record<string, string> = { "room-202": "Hab. 202", "room-305": "Hab. 305" };
const ctx: DialogCopyContext = { roomLabel: (id) => (id && ROOMS[id]) || "Sin habitación", guest: "Ana Pérez" };
const WHO = "RA-1001 (Ana Pérez)";

const changes: Record<PendingChange["type"], PendingChange> = {
  move: { type: "move", res, newRoomId: "room-305", newArrival: null, newDeparture: null, warnings: [] },
  resize: { type: "resize", res, newArrivalDate: "2026-09-21", newDepartureDate: "2026-09-26", warnings: [] },
  checkin: { type: "checkin", res },
  checkout: { type: "checkout", res },
  cancel: { type: "cancel", res },
  noshow: { type: "noshow", res },
  assign: { type: "assign", res }
};

describe("dialogCopy · siete tipos", () => {
  it("move: habitación por roomLabel y, si hay fechas, «nuevas fechas … (n noches)»", () => {
    const roomOnly = dialogCopy(changes.move, ctx);
    assert.equal(roomOnly.title, "Mover reserva");
    assert.equal(roomOnly.body, `Mover ${WHO} a Hab. 305.`);
    assert.equal(roomOnly.verb, "Mover");
    assert.equal(roomOnly.done, "Reserva movida.");
    assert.equal(roomOnly.danger, false);

    const withDates = dialogCopy({ type: "move", res, newRoomId: "room-305", newRoomLabel: "Hab. 305", newArrival: "2026-09-22", newDeparture: "2026-09-25", warnings: [] }, ctx);
    assert.match(withDates.body, /^Mover RA-1001 \(Ana Pérez\) a Hab\. 305, nuevas fechas 22.*25.*sept.* \(3 noches\)\.$/);

    const datesOnly = dialogCopy({ type: "move", res, newRoomId: null, newArrival: "2026-09-22", newDeparture: "2026-09-23", warnings: [] }, ctx);
    assert.doesNotMatch(datesOnly.body, / a Hab\./);
    assert.match(datesOnly.body, /nuevas fechas .*\(1 noche\)\.$/);
  });

  it("resize: «Estancia de …: rango (n noches)», verbo Guardar", () => {
    const copy = dialogCopy(changes.resize, ctx);
    assert.equal(copy.title, "Cambiar fechas");
    assert.match(copy.body, /^Estancia de RA-1001 \(Ana Pérez\): 21.*26.*sept.* \(5 noches\)\.$/);
    assert.equal(copy.verb, "Guardar");
    assert.equal(copy.done, "Fechas actualizadas.");
    assert.equal(copy.danger, false);
    const oneNight = dialogCopy({ type: "resize", res, newArrivalDate: "2026-09-21", newDepartureDate: "2026-09-22", warnings: [] }, ctx);
    assert.match(oneNight.body, /\(1 noche\)\.$/);
  });

  it("checkin / checkout: nombran la habitación asignada (y no inventan una si falta)", () => {
    const checkin = dialogCopy(changes.checkin, ctx);
    assert.equal(checkin.title, "Hacer check-in");
    assert.equal(checkin.body, `Registrar la entrada de ${WHO} en Hab. 202.`);
    assert.equal(checkin.verb, "Check-in");
    assert.equal(checkin.done, "Check-in registrado.");
    assert.equal(checkin.danger, false);

    const checkout = dialogCopy(changes.checkout, ctx);
    assert.equal(checkout.title, "Hacer check-out");
    assert.equal(checkout.body, `Registrar la salida de ${WHO} en Hab. 202.`);
    assert.equal(checkout.verb, "Check-out");
    assert.equal(checkout.done, "Check-out registrado.");

    const unassigned = dialogCopy({ type: "checkin", res: { ...res, assignedRoomId: undefined } }, ctx);
    assert.equal(unassigned.body, `Registrar la entrada de ${WHO}.`);
  });

  it("cancel / noshow: destructivos, con política de cancelación y verbo específico", () => {
    const cancel = dialogCopy(changes.cancel, ctx);
    assert.equal(cancel.title, "Cancelar reserva");
    assert.equal(cancel.body, `Cancelar ${WHO}. Se aplicará la política de cancelación.`);
    assert.equal(cancel.verb, "Cancelar reserva");
    assert.equal(cancel.done, "Reserva cancelada.");
    assert.equal(cancel.danger, true);

    const noshow = dialogCopy(changes.noshow, ctx);
    assert.equal(noshow.title, "Marcar como no-show");
    assert.equal(noshow.body, `Marcar ${WHO} como no-show.`);
    assert.equal(noshow.verb, "Marcar no-show");
    assert.equal(noshow.done, "No-show registrado.");
    assert.equal(noshow.danger, true);
  });

  it("assign: verbo del diccionario (Asignar)", () => {
    const copy = dialogCopy(changes.assign, ctx);
    assert.equal(copy.title, "Asignar habitación");
    assert.equal(copy.body, `Asignar una habitación a ${WHO}.`);
    assert.equal(copy.verb, "Asignar");
    assert.equal(copy.done, "Habitación asignada.");
    assert.equal(copy.danger, false);
  });

  it("danger solo en cancel y noshow; done en español y terminado en punto; sin undoLabel", () => {
    for (const [type, change] of Object.entries(changes)) {
      const copy = dialogCopy(change, ctx);
      assert.equal(copy.danger, type === "cancel" || type === "noshow", `danger de ${type}`);
      assert.match(copy.done, /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ -]+\.$/, `done de ${type}: ${copy.done}`);
      assert.ok(copy.body.includes(WHO), `body de ${type} nombra código y huésped`);
      assert.ok(copy.title.length > 0 && copy.verb.length > 0, `título y verbo de ${type}`);
      assert.ok(!("undoLabel" in copy), "la etiqueta de deshacer la produce undoEntryFor");
      assert.deepEqual(Object.keys(copy).sort(), ["body", "danger", "done", "title", "verb"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Contrato de fuente (reglas 1-5, 9-11 de tests/cocoa-22-contract.test.mjs)
// ---------------------------------------------------------------------------

const inspector = source("../TimelineInspector.tsx");
const actionDialog = source("../TimelineActionDialog.tsx");
const createDialog = source("../TimelineCreateDialog.tsx");
const copyModule = source("../timeline-dialog-copy.ts");
const files: Array<[string, string]> = [
  ["TimelineInspector.tsx", inspector],
  ["TimelineActionDialog.tsx", actionDialog],
  ["TimelineCreateDialog.tsx", createDialog],
  ["timeline-dialog-copy.ts", copyModule]
];

function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/, `${name}: formats only through lib/format`);
}

describe("TL-4 · contrato de fuente", () => {
  it("los cuatro ficheros cumplen Cocoa 22 con CERO style={, sin red, sin Intl, sin undoLabel y sin importar servicios en runtime", () => {
    for (const [name, src] of files) {
      assertCocoaRules(name, src);
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name}: 0 style={`);
      assert.doesNotMatch(src, /undoLabel/, `${name}: sin undoLabel`);
      assert.doesNotMatch(src, /import\.meta/, `${name}: sin import.meta`);
      assert.doesNotMatch(src, /\.bo-|\bv2\//, `${name}: sin marcas antiguas`);
      for (const line of src.split("\n").filter((entry) => /from "\.\.\/\.\.\/services\//.test(entry))) {
        assert.match(line, /^import type\b/, `${name}: los servicios solo se importan como tipo: ${line}`);
      }
      assert.doesNotMatch(src, /from "\.\.\/\.\.\/services\/(?!pmsCommerceApi")/, `${name}: solo tipos de pmsCommerceApi`);
    }
    for (const [name, src] of files.slice(0, 3)) assert.match(src, /from "\.\.\/cocoa";/, `${name}: primitivas del índice Cocoa`);
    assert.doesNotMatch(copyModule, /from "react"|from "\.\.\/cocoa"/, "el copy es puro (sin React ni primitivas)");
    assert.match(copyModule, /from "\.\.\/\.\.\/lib\/format";/);
    assert.match(copyModule, /import \{ ACTIONS \} from "\.\.\/\.\.\/content\/actions";/);
  });

  it("TimelineInspector: panel acoplado NO modal en escritorio, hoja inferior en teléfono; folio honesto, huésped sin registrar, actividad etiquetada y reglas del API", () => {
    assert.match(inspector, /<CocoaDrawer/);
    assert.match(inspector, /side="right"/);
    assert.match(inspector, /size="lg"/);
    assert.match(inspector, /<CocoaKbd>Esc<\/CocoaKbd>/);
    // Corrección 1 (UXC-01 / TL-R1): sin scrim ni focus trap fuera del teléfono; la parrilla sigue viva.
    assert.match(inspector, /const narrow = useIsNarrow\(\);\s*if \(narrow\) return <TimelineInspectorSheet/);
    assert.match(inspector, /className="tl-panel" role="complementary" aria-labelledby=\{headingId\} tabIndex=\{-1\}/);
    assert.match(inspector, /focusToken\?: number;/);
    assert.match(inspector, /panelRef\.current\?\.focus\(\{ preventScroll: true \}\)/, "abierto con teclado, el panel toma el foco");
    assert.equal(count(inspector, /<InspectorBody \{\.\.\.props\} res=\{res\} \/>/g), 2, "la misma ficha en las dos envolturas");
    assert.match(inspector, /onOpenFolio\?\(\): void;/);
    assert.match(inspector, /folio && props\.onOpenFolio \? \[\{ label: FOLIO_LINK_LABEL, onClick: props\.onOpenFolio \}\] : \[\]/, "«Folio y facturación» abre EL folio, y solo si existe");
    assert.doesNotMatch(inspector, /BillingCenter/, "sin aterrizaje en la pantalla genérica de facturación");
    assert.doesNotMatch(inspector, /title=\{res\.channel\}/, "sin ids técnicos en tooltips");
    assert.match(inspector, /"Sin folio"/);
    assert.match(inspector, /Sin huésped registrado/);
    assert.match(inspector, /activityLabel\(/);
    assert.match(inspector, /className="tl-facts"/);
    assert.match(inspector, /res\.status === "confirmed"/, "check-in solo confirmed");
    assert.match(inspector, /checkout: res\.status === "checked_in"/, "check-out solo checked_in");
    assert.match(inspector, /Asigna una habitación antes del check-in/);
    assert.match(inspector, /new Set\(\["cancelled", "no_show", "checked_out"\]\)/, "asignar deshabilitado en cerradas");
    assert.match(inspector, /new Set\(\["checked_in", "checked_out", "cancelled", "no_show"\]\)/, "cancelar deshabilitado en casa o cerrada");
    assert.match(inspector, /new Set\(\["confirmed", "draft"\]\)/, "no-show solo confirmed/draft");
    assert.match(inspector, /"Cambiar habitación" : "Asignar habitación"/);
    for (const label of ["Recorrido del huésped", "Folio y facturación", "Limpieza", "Mantenimiento", "Mensajes", "Abrir reserva", "Huésped principal", "Actividad reciente", "Sin actividad"]) {
      assert.ok(inspector.includes(label), `inspector: «${label}»`);
    }
    assert.match(inspector, /<ul className="c22-section__list">/);
    assert.match(inspector, /tone="destructive"[^\n]*onAction\("cancel"\)/);
    assert.match(inspector, /tone="destructive"[^\n]*onAction\("noshow"\)/);
    assert.match(inspector, /<CocoaCallout tone="warning" role="status">/);
  });

  it("TimelineActionDialog: CocoaDialog destructivo cuando toca, confirmDisabled, saldo pendiente con switch, motivo obligatorio y previsualización L3-F1 por props", () => {
    assert.match(actionDialog, /<CocoaDialog/);
    assert.match(actionDialog, /"destructive"/);
    assert.match(actionDialog, /confirmDisabled=/);
    assert.match(actionDialog, /BALANCE_DUE/);
    assert.match(actionDialog, /acknowledgeBalance/);
    assert.match(actionDialog, /<CocoaSwitch checked=\{ack\} onChange=\{setAck\} label="Confirmar la salida con saldo pendiente" \/>/);
    assert.match(actionDialog, /id="tl-reason"/);
    assert.match(actionDialog, /id="tl-assign-room"/);
    assert.match(actionDialog, /pending\.warnings\.map\(/);
    assert.match(actionDialog, /roomBlocked\(/);
    assert.match(actionDialog, /roomChangeWarnings\(/);
    assert.match(actionDialog, /sortRoomsByNumber\(/);
    // L3-F1 integrado en la fusión TL: la previsualización llega por props (texto + tono + título, misma voz que la ficha de reserva) y se pinta bajo el motivo.
    assert.match(actionDialog, /export type TimelinePenaltyPreview = \{ text: string; tone: "info" \| "warning"; title: string \| null \};/);
    assert.match(actionDialog, /penaltyPreview\?: TimelinePenaltyPreview \| null;/);
    assert.match(actionDialog, /\{penaltyPreview \? \(\s*<CocoaCallout tone=\{penaltyPreview\.tone\} title=\{penaltyPreview\.title \?\? undefined\} role="status">\s*\{penaltyPreview\.text\}/);
    assert.doesNotMatch(actionDialog, /gancho L3-F1/);
    assert.match(actionDialog, /MIN_REASON_LENGTH = 3/);
    assert.match(actionDialog, /reason\.trim\(\)\.length < MIN_REASON_LENGTH/);
    assert.match(actionDialog, /cancelLabel=\{ACTIONS\.cancel\}/);
    assert.match(actionDialog, /Solo se admite dentro de ±1 día de la fecha de negocio \(o de hoy, si el cierre nocturno va por detrás\)/, "la nota dice la regla real del API (max(fecha de negocio, hoy))");
    assert.match(actionDialog, /placeholder="Elige una habitación"/);
    assert.match(actionDialog, /useEffect\(\(\) => \{\s*setRoomId\(pending\?\.res\.assignedRoomId \?\? ""\);\s*setReason\(""\);\s*setAck\(false\);\s*\}, \[pending\]\);/);
    assert.match(actionDialog, /title="Cambio"/);
    assert.equal(count(actionDialog, /role="alert"/g), 3, "saldo, conflicto y error genérico son alertas");
  });

  it("TimelineCreateDialog: «Crear reserva» con la selección descrita y la nota de formulario prellenado", () => {
    assert.match(createDialog, /confirmLabel="Crear reserva"/);
    assert.match(createDialog, /title="Nueva reserva"/);
    assert.match(createDialog, /size="sm"/);
    assert.match(createDialog, /Se abrirá el formulario con la habitación, el tipo y las fechas ya rellenos/);
    assert.match(createDialog, /dateRange\(selection\.arrivalDate, selection\.departureDate, \{ style: "dayMonth" \}\)/);
    assert.match(createDialog, /plural\(selection\.nights, "noche", "noches"\)/);
  });
});
