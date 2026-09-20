// Copia exacta de pisos y mantenimiento (Tanda UX-3 · D0 · docs/design/
// UX-PISOS-MANTENIMIENTO-FEEL.md §4). Botones, chips y avisos (toasts) de las
// cinco pantallas de pisos/mantenimiento salen de aquí para que la misma acción
// se lea igual en el tablero, en Mi turno, en Mis averías y en el tablero de
// habitaciones, y para que los avisos lleven SIEMPRE el número (P7: «Habitación
// 305 limpia.», nunca «Habitación bloqueada.» sin decir cuál). Las plantillas
// reciben el número de habitación (`n`, tal como lo pinta el API) o la
// referencia corta del parte (`t`, ver `workOrderRef`). Los verbos comunes
// («Deshacer», «Siguiente», «Asignar», «Completar») se heredan del diccionario
// general y el diálogo nominal de bloqueo reutiliza el de la ficha de reserva
// (RESERVATION_ACTIONS.blockRoomConfirm / keepRoomOnSale) para que «Bloquear la
// 305» / «Mantenerla en venta» sea el mismo texto en toda la aplicación.
//
// Reglas: español, sin enums del API, sin nombres de personas en las plantillas
// (el nombre asignado llega como argumento y solo se pinta en la UI), sin
// infinitivos como aviso («Tarea empezar.» fue el defecto F9 de FIX-1).
import { ACTIONS, RESERVATION_ACTIONS, newLabel } from "./actions";

/** Referencia corta de un parte para avisos y tarjetas: los 6 últimos caracteres del id (como pinta hoy Mis averías). */
export function workOrderRef(id: string): string {
  return id.slice(-6);
}

/** «1 foto» / «3 fotos» (concordancia; 0 → «sin fotos»). */
export function photoCount(count: number): string {
  if (count <= 0) return "sin fotos";
  return count === 1 ? "1 foto" : `${count} fotos`;
}

// ---------------------------------------------------------------------------
// Pisos: tablero (/operaciones/pisos), Mi turno (…/mi-turno) y tablero de
// habitaciones (/recepcion/reservas/tablero, cajón de la casilla).
// ---------------------------------------------------------------------------

export const PISOS_ACTIONS = {
  // Tablero de pisos (tarjeta de habitación).
  markClean: "Marcar limpia",
  markDirty: "Marcar sucia",
  inspect: "Inspeccionar",
  newTask: newLabel("f", "tarea"),
  createTask: "Crear tarea",
  assignTo: "Asignar a",
  assignMe: "Asignarme",
  start: "Empezar",
  complete: ACTIONS.complete,
  // Mi turno (tarjeta de habitación y tarjeta «Siguiente»).
  startCleaning: "Iniciar",
  clean: "Limpia",
  inspected: "Inspeccionada",
  report: "Reportar",
  photo: "Foto",
  sendToMaintenance: "Enviar a mantenimiento",
  next: ACTIONS.next,
  // Chips de Mi turno: sección recordada y filtro.
  allSections: "Todas",
  mySection: "Mi sección",
  // Tablero de habitaciones (cajón de la casilla) y diálogo nominal de bloqueo.
  blockRoom: "Bloquear habitación",
  unblockRoom: "Desbloquear habitación",
  blockRoomConfirm: RESERVATION_ACTIONS.blockRoomConfirm,
  keepRoomOnSale: RESERVATION_ACTIONS.keepRoomOnSale,
  undo: ACTIONS.undo
} as const;

export const PISOS_TOASTS = {
  // Estado de la habitación (tablero de pisos y tablero de habitaciones).
  roomClean: (n: string) => `Habitación ${n} limpia.`,
  roomInspected: (n: string) => `Habitación ${n} inspeccionada.`,
  roomDirty: (n: string) => `Habitación ${n} sucia.`,
  // Mi turno (forma corta «Hab. NNN → Estado», manual 40 · tarea 3).
  cleaningStarted: (n: string) => `Hab. ${n} → En limpieza`,
  hkClean: (n: string) => `Hab. ${n} → Limpia`,
  hkCleanTaskClosed: (n: string) => `Hab. ${n} → Limpia · tarea cerrada`,
  hkInspected: (n: string) => `Hab. ${n} → Inspeccionada`,
  // Tareas (el «Empezar»/«Completar» de la fila sigue en housekeeping-task-actions.ts).
  taskCreated: (n: string) => `Tarea creada para la habitación ${n}.`,
  taskCreatedAssigned: (n: string, who: string) => `Tarea creada para la habitación ${n} · asignada a ${who}`,
  // «Reportar» con foto (P4).
  incidentReported: (n: string, photos = 0) =>
    photos > 0 ? `Avería de la ${n} enviada a mantenimiento · ${photoCount(photos)}` : `Avería de la ${n} enviada a mantenimiento.`,
  // Bloqueo desde el tablero de habitaciones (con número, F8).
  roomBlocked: (n: string) => `Habitación ${n} bloqueada.`,
  roomUnblocked: (n: string) => `Habitación ${n} desbloqueada.`,
  // Tras «Deshacer»: la habitación sigue como estaba.
  undone: (n: string) => `Habitación ${n}: sin cambios.`,
  // «Deshacer» pulsado cuando la escritura diferida ya viajó (ventana agotada, vaciada o pagehide): se dice, no se calla (UX-3-REV-01).
  undoExpired: (n: string) => `Habitación ${n} ya enviada: no se puede deshacer.`
} as const;

// ---------------------------------------------------------------------------
// Mantenimiento: tablero (/operaciones/mantenimiento) y Mis averías (…/mis-averias).
// ---------------------------------------------------------------------------

export const MANT_ACTIONS = {
  // Mis averías (tarjeta de parte).
  take: "Tomar",
  resolved: "Resuelta",
  note: "Nota",
  photos: (count: number) => photoCount(count),
  // Chips de Mis averías.
  mine: "Mías",
  all: "Todas",
  // Tablero (ficha del parte).
  assignMe: "Asignarme",
  assignTo: "Asignar a",
  resolve: "Resolver",
  newWorkOrder: newLabel("f", "orden de trabajo"),
  blockRoom: "Bloquear habitación",
  blockRoomConfirm: RESERVATION_ACTIONS.blockRoomConfirm,
  keepRoomOnSale: RESERVATION_ACTIONS.keepRoomOnSale,
  undo: ACTIONS.undo
} as const;

export const MANT_TOASTS = {
  // «Tomar» asigna el parte a quien lo toma (FIX-1 · F9).
  taken: (t: string) => `Parte ${t} → En curso · asignado a ti`,
  assigned: (t: string, who: string) => `Parte ${t} → asignado a ${who}`,
  statusChanged: (t: string, statusLabel: string) => `Parte ${t} → ${statusLabel}`,
  resolved: (t: string) => `Parte ${t} resuelto.`,
  resolvedRoomReleased: (t: string, n: string) => `Parte ${t} resuelto · habitación ${n} liberada.`,
  created: (t: string) => `Parte ${t} creado.`,
  noteAdded: (t: string) => `Nota añadida al parte ${t}.`,
  // Bloqueo desde el tablero de mantenimiento (con número, F8).
  roomBlocked: (n: string) => `Habitación ${n} bloqueada.`,
  roomUnblocked: (n: string) => `Habitación ${n} desbloqueada.`,
  // Tras «Deshacer»: el parte sigue como estaba.
  undone: (t: string) => `Parte ${t}: sin cambios.`,
  // «Deshacer» pulsado cuando la resolución ya viajó (ventana agotada, vaciada o pagehide): se dice, no se calla (UX-3-REV-01).
  undoExpired: (t: string) => `Parte ${t} ya enviado: no se puede deshacer.`
} as const;
