import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MANT_ACTIONS, MANT_TOASTS, PISOS_ACTIONS, PISOS_TOASTS, photoCount, workOrderRef } from "../pisos-actions.ts";
import { ACTIONS, RESERVATION_ACTIONS } from "../actions.ts";

// Tanda UX-3 · D0: la copia exacta que fija docs/design/UX-PISOS-MANTENIMIENTO-FEEL.md
// §4 (botones, chips, tarjeta «Siguiente», toasts con número, diálogo nominal).
// Los números y nombres de los casos son ficticios.

const source = readFileSync(new URL("../pisos-actions.ts", import.meta.url), "utf8");
const allToasts = [
  ...Object.values(PISOS_TOASTS).map((fn) => (fn as (a: string, b?: never) => string)("305")),
  PISOS_TOASTS.taskCreatedAssigned("305", "Camarera UXDAY"),
  PISOS_TOASTS.incidentReported("305", 2),
  ...Object.values(MANT_TOASTS).map((fn) => (fn as (a: string, b?: never) => string)("a1c3n")),
  MANT_TOASTS.assigned("a1c3n", "Técnico UXDAY"),
  MANT_TOASTS.statusChanged("a1c3n", "Esperando proveedor"),
  MANT_TOASTS.resolvedRoomReleased("a1c3n", "305")
];

describe("pisos-actions · botones y chips (§4, copia exacta)", () => {
  it("tablero de pisos: «Marcar limpia» · «Inspeccionar» · «Nueva tarea» · «Asignar a»", () => {
    assert.equal(PISOS_ACTIONS.markClean, "Marcar limpia");
    assert.equal(PISOS_ACTIONS.inspect, "Inspeccionar");
    assert.equal(PISOS_ACTIONS.newTask, "Nueva tarea");
    assert.equal(PISOS_ACTIONS.createTask, "Crear tarea");
    assert.equal(PISOS_ACTIONS.assignTo, "Asignar a");
    assert.equal(PISOS_ACTIONS.assignMe, "Asignarme");
    assert.equal(PISOS_ACTIONS.start, "Empezar");
    assert.equal(PISOS_ACTIONS.complete, "Completar");
  });

  it("Mi turno: «Iniciar» · «Limpia» · «Inspeccionada» · «Reportar» · «Foto» · tarjeta «Siguiente»", () => {
    assert.equal(PISOS_ACTIONS.startCleaning, "Iniciar");
    assert.equal(PISOS_ACTIONS.clean, "Limpia");
    assert.equal(PISOS_ACTIONS.inspected, "Inspeccionada");
    assert.equal(PISOS_ACTIONS.report, "Reportar");
    assert.equal(PISOS_ACTIONS.photo, "Foto");
    assert.equal(PISOS_ACTIONS.sendToMaintenance, "Enviar a mantenimiento");
    assert.equal(PISOS_ACTIONS.next, "Siguiente");
    assert.equal(PISOS_ACTIONS.next, ACTIONS.next, "hereda «Siguiente» del diccionario general");
  });

  it("chips: «Mi sección» / «Todas» en Mi turno y «Mías» / «Todas» en Mis averías", () => {
    assert.equal(PISOS_ACTIONS.mySection, "Mi sección");
    assert.equal(PISOS_ACTIONS.allSections, "Todas");
    assert.equal(MANT_ACTIONS.mine, "Mías");
    assert.equal(MANT_ACTIONS.all, "Todas");
  });

  it("Mis averías y tablero de mantenimiento: «Tomar» · «Resuelta» · «Nota» · «Asignarme» · «Resolver»", () => {
    assert.equal(MANT_ACTIONS.take, "Tomar");
    assert.equal(MANT_ACTIONS.resolved, "Resuelta");
    assert.equal(MANT_ACTIONS.note, "Nota");
    assert.equal(MANT_ACTIONS.assignMe, "Asignarme");
    assert.equal(MANT_ACTIONS.assignTo, "Asignar a");
    assert.equal(MANT_ACTIONS.resolve, "Resolver");
    assert.equal(MANT_ACTIONS.newWorkOrder, "Nueva orden de trabajo");
    assert.equal(MANT_ACTIONS.photos(1), "1 foto");
    assert.equal(MANT_ACTIONS.photos(3), "3 fotos");
  });

  it("«Deshacer» viene del diccionario general (toast 8 s, P4)", () => {
    assert.equal(PISOS_ACTIONS.undo, "Deshacer");
    assert.equal(MANT_ACTIONS.undo, ACTIONS.undo);
  });
});

describe("pisos-actions · diálogo nominal de bloqueo (RESERVATION_ACTIONS reutilizado)", () => {
  it("«Bloquear la NNN» / «Mantenerla en venta» son las mismas funciones que en la ficha de reserva", () => {
    assert.equal(PISOS_ACTIONS.blockRoomConfirm, RESERVATION_ACTIONS.blockRoomConfirm);
    assert.equal(MANT_ACTIONS.blockRoomConfirm, RESERVATION_ACTIONS.blockRoomConfirm);
    assert.equal(PISOS_ACTIONS.blockRoomConfirm("305"), "Bloquear la 305");
    assert.equal(PISOS_ACTIONS.keepRoomOnSale, "Mantenerla en venta");
    assert.equal(MANT_ACTIONS.keepRoomOnSale, RESERVATION_ACTIONS.keepRoomOnSale);
    assert.equal(PISOS_ACTIONS.blockRoom, "Bloquear habitación");
    assert.equal(PISOS_ACTIONS.unblockRoom, "Desbloquear habitación");
    assert.equal(MANT_ACTIONS.blockRoom, "Bloquear habitación");
  });

  it("nunca «¿Seguro?» ni «Confirmar» como botón del diálogo", () => {
    for (const value of [...Object.values(PISOS_ACTIONS), ...Object.values(MANT_ACTIONS)]) {
      const text = typeof value === "function" ? value("305") : value;
      assert.doesNotMatch(String(text), /seguro|Confirmar$/i);
    }
  });
});

describe("pisos-actions · toasts con número (P7)", () => {
  it("pisos: la habitación va en el aviso", () => {
    assert.equal(PISOS_TOASTS.roomClean("305"), "Habitación 305 limpia.");
    assert.equal(PISOS_TOASTS.roomInspected("206"), "Habitación 206 inspeccionada.");
    assert.equal(PISOS_TOASTS.roomDirty("206"), "Habitación 206 sucia.");
    assert.equal(PISOS_TOASTS.cleaningStarted("203"), "Hab. 203 → En limpieza");
    assert.equal(PISOS_TOASTS.hkClean("203"), "Hab. 203 → Limpia");
    assert.equal(PISOS_TOASTS.hkCleanTaskClosed("203"), "Hab. 203 → Limpia · tarea cerrada");
    assert.equal(PISOS_TOASTS.hkInspected("203"), "Hab. 203 → Inspeccionada");
    assert.equal(PISOS_TOASTS.taskCreated("305"), "Tarea creada para la habitación 305.");
    assert.equal(PISOS_TOASTS.taskCreatedAssigned("305", "Camarera UXDAY"), "Tarea creada para la habitación 305 · asignada a Camarera UXDAY");
    assert.equal(PISOS_TOASTS.roomBlocked("305"), "Habitación 305 bloqueada.");
    assert.equal(PISOS_TOASTS.roomUnblocked("305"), "Habitación 305 desbloqueada.");
    assert.equal(PISOS_TOASTS.undone("305"), "Habitación 305: sin cambios.");
    // UX-3-REV-01: «Deshacer» tras agotarse la ventana avisa en vez de callar.
    assert.equal(PISOS_TOASTS.undoExpired("305"), "Habitación 305 ya enviada: no se puede deshacer.");
  });

  it("«Reportar» con foto cuenta las fotos y concuerda", () => {
    assert.equal(PISOS_TOASTS.incidentReported("305"), "Avería de la 305 enviada a mantenimiento.");
    assert.equal(PISOS_TOASTS.incidentReported("305", 0), "Avería de la 305 enviada a mantenimiento.");
    assert.equal(PISOS_TOASTS.incidentReported("305", 1), "Avería de la 305 enviada a mantenimiento · 1 foto");
    assert.equal(PISOS_TOASTS.incidentReported("305", 3), "Avería de la 305 enviada a mantenimiento · 3 fotos");
    assert.equal(photoCount(0), "sin fotos");
  });

  it("mantenimiento: la referencia del parte va en el aviso y «Tomar» dice a quién se asigna", () => {
    assert.equal(workOrderRef("cmu80n0gt014gfygbc8ar1c3n"), "ar1c3n");
    assert.equal(MANT_TOASTS.taken("ar1c3n"), "Parte ar1c3n → En curso · asignado a ti");
    assert.equal(MANT_TOASTS.assigned("ar1c3n", "Técnico UXDAY"), "Parte ar1c3n → asignado a Técnico UXDAY");
    assert.equal(MANT_TOASTS.statusChanged("ar1c3n", "Esperando proveedor"), "Parte ar1c3n → Esperando proveedor");
    assert.equal(MANT_TOASTS.resolved("ar1c3n"), "Parte ar1c3n resuelto.");
    assert.equal(MANT_TOASTS.resolvedRoomReleased("ar1c3n", "305"), "Parte ar1c3n resuelto · habitación 305 liberada.");
    assert.equal(MANT_TOASTS.created("ar1c3n"), "Parte ar1c3n creado.");
    assert.equal(MANT_TOASTS.noteAdded("ar1c3n"), "Nota añadida al parte ar1c3n.");
    assert.equal(MANT_TOASTS.roomBlocked("305"), "Habitación 305 bloqueada.");
    assert.equal(MANT_TOASTS.roomUnblocked("305"), "Habitación 305 desbloqueada.");
    assert.equal(MANT_TOASTS.undone("ar1c3n"), "Parte ar1c3n: sin cambios.");
    assert.equal(MANT_TOASTS.undoExpired("ar1c3n"), "Parte ar1c3n ya enviado: no se puede deshacer.");
  });

  it("todo aviso lleva el número o la referencia; ninguno es un infinitivo, un enum crudo ni un anglicismo", () => {
    for (const text of allToasts) {
      assert.match(text, /305|a1c3n/, `«${text}» lleva número o referencia`);
      assert.doesNotMatch(text, /Tarea (empezar|completar)\./, `«${text}» no repite el defecto F9`);
      assert.doesNotMatch(text, /\b(in_progress|resolved|open|clean|dirty|inspected|blocked|ooo)\b/, `«${text}» no pinta enums`);
      assert.doesNotMatch(text, /\b(ok|done|undo|room|task)\b/i, `«${text}» sin anglicismos`);
      assert.match(text, /^[A-ZÁÉÍÓÚÑ]/, `«${text}» empieza en mayúscula`);
    }
  });

  it("los avisos de bloqueo son idénticos en pisos y mantenimiento (misma acción, mismo texto)", () => {
    assert.equal(PISOS_TOASTS.roomBlocked("112"), MANT_TOASTS.roomBlocked("112"));
    assert.equal(PISOS_TOASTS.roomUnblocked("112"), MANT_TOASTS.roomUnblocked("112"));
  });
});

describe("pisos-actions.ts · contrato de fuente", () => {
  it("hereda del diccionario general en vez de reescribir «Deshacer», «Siguiente» o el diálogo de bloqueo", () => {
    assert.match(source, /import \{ ACTIONS, RESERVATION_ACTIONS, newLabel \} from "\.\/actions";/);
    assert.doesNotMatch(source, /"Deshacer"/);
    assert.doesNotMatch(source, /"Siguiente"/);
    assert.doesNotMatch(source, /Bloquear la \$\{/);
    assert.doesNotMatch(source, /"Mantenerla en venta"/);
  });

  it("no contiene nombres de personas ni promesas de roadmap", () => {
    assert.doesNotMatch(source, /Próximamente|sandbox|stub|TODO/);
    assert.doesNotMatch(source, /@faranda|pisos\.tilos|gobernanta\.tilos|mantenimiento\.rias/);
  });
});
