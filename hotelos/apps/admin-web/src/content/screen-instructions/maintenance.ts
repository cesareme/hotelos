// Tarjeta de instrucciones de Operaciones › Mantenimiento › «Mis averías»
// (/operaciones/mantenimiento/mis-averias; la consume MaintenanceMobileScreen:
// whatIsThis como descripción, howToUse como pasos y tips[0] como consejo; el título
// «Mis averías» vive en la pantalla). Tanda DOC-2: copy en español y solo lo que
// existe (filtro por prioridad, botones «Tomar» · «Resuelta» · «Nota»; «Nueva orden
// de trabajo» y «Bloquear habitación» viven en la pestaña «Tablero»). Los atajos
// salen del registro, nunca escritos a mano.
import { shortcutKeys } from "../shortcuts-registry";

export const MAINT_INSTRUCTIONS = {
  whatIsThis:
    "Órdenes de trabajo de mantenimiento en una cola priorizada para el técnico: cada tarjeta muestra la habitación y la planta, la prioridad (urgente, alta, normal, baja), el estado (Abierta · Asignada · En curso · Esperando proveedor · Resuelta · Cerrada), el tiempo que lleva abierta y si bloquea la habitación.",
  howToUse: [
    "Filtra por prioridad (Todo · Urgente · Alta · Normal · Baja). Una avería es urgente si es una emergencia o bloquea una habitación con huésped dentro; es alta si bloquea la habitación, está marcada urgente o su plazo ha vencido («SLA vencido»); las preventivas son de prioridad baja.",
    "Pulsa «Tomar» para hacerte cargo: la avería pasa a «En curso» (la aplicación no la asigna a nadie: «Asignada a» solo aparece si la orden ya traía un responsable).",
    "Con «Nota» añades a la descripción lo que has visto o lo que has hecho, con la fecha y la hora.",
    "Pulsa «Resuelta» al terminar; si la avería bloqueaba la habitación, se libera en el mismo paso.",
    "Las órdenes nuevas («Nueva orden de trabajo», con prioridad y la opción de bloquear la habitación) y «Bloquear habitación» sobre una avería abierta se hacen desde la pestaña «Tablero»; Pisos también crea órdenes con «Reportar» desde Mi turno."
  ],
  tips: [
    "La tarjeta indica si la avería tiene fotos adjuntas («1 foto», «3 fotos») y si bloquea la habitación: una habitación bloqueada por avería queda fuera de servicio hasta que la marcas resuelta."
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), action: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("global.escape"), action: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: ["Pisos", "Seguridad"],
} as const;
