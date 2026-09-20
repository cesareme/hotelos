// Tarjeta de instrucciones de Operaciones › Mantenimiento › «Mis averías»
// (/operaciones/mantenimiento/mis-averias; la consume MaintenanceMobileScreen:
// whatIsThis como descripción, howToUse como pasos y tips[0] como consejo; el título
// «Mis averías» vive en la pantalla). Tanda DOC-2: copy en español y solo lo que
// existe. Tanda UX-3 · P3 (diseño §4.4, F12): chips «Mías · Todas», «Tomar» asigna
// el parte a quien lo toma (FIX-1 · F9; el texto anterior «no la asigna a nadie» era
// falso) y ofrece «Deshacer»; «Resuelta» deja 8 segundos para deshacer antes de
// enviarse. «Nueva orden de trabajo», «Asignar a» / «Asignarme» y «Bloquear
// habitación» viven en la pestaña «Tablero». Los atajos salen del registro, nunca
// escritos a mano.
import { shortcutKeys } from "../shortcuts-registry";

export const MAINT_INSTRUCTIONS = {
  whatIsThis:
    "Órdenes de trabajo de mantenimiento en una cola priorizada para el técnico: cada tarjeta muestra la habitación y la planta, la prioridad (urgente, alta, normal, baja), el estado (Abierta · Asignada · En curso · Esperando proveedor · Resuelta · Cerrada), el tiempo que lleva abierta y si bloquea la habitación.",
  howToUse: [
    "Elige «Mías» (solo los partes asignados a ti; es el filtro inicial si tienes alguno) o «Todas» (la cola completa) y, si quieres, acota por prioridad (Todo · Urgente · Alta · Normal · Baja). Una avería es urgente si es una emergencia o bloquea una habitación con huésped dentro; es alta si bloquea la habitación, está marcada urgente o su plazo ha vencido («SLA vencido»); las preventivas son de prioridad baja.",
    "Pulsa «Tomar» para hacerte cargo: la avería pasa a «En curso» y queda asignada a ti (la tarjeta muestra «Asignada a» con tu nombre). El aviso ofrece «Deshacer» durante 8 segundos: la avería vuelve a «Abierta» y sin asignar.",
    "Con «Nota» añades a la descripción lo que has visto o lo que has hecho, con la fecha y la hora.",
    "Pulsa «Resuelta» al terminar: la tarjeta sale de la cola al instante y el aviso ofrece «Deshacer» durante 8 segundos. Pasado ese tiempo (o al salir de la pantalla) la avería queda resuelta y ya no se puede reabrir; si bloqueaba la habitación, se libera en el mismo paso.",
    "Las órdenes nuevas («Nueva orden de trabajo», con prioridad y la opción de bloquear la habitación), «Asignar a» / «Asignarme» y «Bloquear habitación» (con confirmación «Bloquear la 305» / «Mantenerla en venta») se hacen desde la pestaña «Tablero»; Pisos también crea órdenes con «Reportar» desde Mi turno."
  ],
  tips: [
    "La tarjeta indica si la avería tiene fotos adjuntas («1 foto», «3 fotos») y si bloquea la habitación: una habitación bloqueada por avería queda fuera de servicio hasta que la marcas resuelta. Con ⌘Z (Ctrl+Z) deshaces el último aviso que aún ofrezca «Deshacer»."
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), action: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("global.escape"), action: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: ["Pisos", "Seguridad"],
} as const;
