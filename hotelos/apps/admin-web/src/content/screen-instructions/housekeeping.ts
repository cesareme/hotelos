// Tarjeta de instrucciones de Operaciones › Pisos › «Mi turno»
// (/operaciones/pisos/mi-turno; la consume HousekeepingMobileScreen: whatIsThis como
// descripción, howToUse como pasos y tips[0] como consejo; el título «Housekeeping»
// vive en la pantalla). Tanda DOC-2: copy en español con el vocabulario D5 y solo lo
// que existe en la pantalla (chips de sección y de prioridad, tarjeta «Siguiente»,
// botones «Iniciar» · «Limpia» · «Inspeccionada» · «Reportar», «Deshacer» 8 s);
// los atajos salen del registro, nunca a mano. Tanda UX-3 · P2: sección recordada,
// «Siguiente» y «Limpia» cierra la tarea (D1). Tanda UX-3 · P4: «Reportar» con
// motivo rápido (chips), hasta 3 fotos con la cámara trasera y detalle opcional.
import { shortcutKeys } from "../shortcuts-registry";

export const HK_INSTRUCTIONS = {
  whatIsThis:
    "Mi turno: las habitaciones que tocan hoy en tu sección, ordenadas por prioridad (urgente, alta, normal, baja), con la tarjeta «Siguiente» arriba y, en cada una, la planta, el tipo, el estado de limpieza (Limpia · Inspeccionada · Sucia) y el motivo (salida sucia, llegada inminente, estancia, tarea pendiente o incidencia abierta).",
  howToUse: [
    "Elige tu sección con los botones de arriba («Todas» o una sección del hotel): la pantalla la recuerda en este dispositivo y al volver la verás marcada como «Mi sección». Debajo puedes filtrar por prioridad (Todo · Urgente · Alta · Normal · Baja).",
    "La tarjeta «Siguiente» es la primera habitación que te toca; el resto sigue en el mismo orden. Cada tarjeta muestra la habitación, la planta, el tipo, el estado de limpieza y, si lo hay, el huésped en el hotel y su petición especial.",
    "Pulsa «Iniciar» al entrar en una habitación sucia: la tarea pasa a «En limpieza».",
    "Al terminar pulsa «Limpia»: la habitación cambia al instante, su tarea se cierra y durante 8 segundos puedes pulsar «Deshacer» en el aviso; después la habitación desaparece de la lista. En una habitación ya limpia, «Inspeccionada» la marca como revisada, también con «Deshacer».",
    "Con «Reportar» avisas a mantenimiento sin teclear: toca el motivo («Fuga de agua», «Bombilla», «Aire acondicionado», «TV/Wi-Fi», «Cerradura» u «Otro»), añade hasta 3 fotos con «Foto» (en la tablet abre la cámara trasera; se reducen antes de enviarse) y, si quieres, un detalle. «Enviar a mantenimiento» (o Intro) crea la orden de trabajo «Hab. 203: Fuga de agua» y el aviso dice cuántas fotos lleva; la tarjeta suma «1 incidencia»."
  ],
  tips: [
    "El orden es el de la prioridad: primero las habitaciones sucias con llegada en menos de dos horas, después las salidas de hoy («Salida sucia · cliente ya marchó»), luego las estancias y las llegadas del día y, por último, las tareas pendientes e incidencias; a igual prioridad, por número de habitación. Con el dedo, esta ayuda queda plegada bajo la lista y las fotos del parte las ve mantenimiento en Mis averías («1 foto»)."
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), description: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("global.escape"), description: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: [
    { label: "Mantenimiento", screenId: "MaintenanceDashboard" },
    { label: "Mi día › Operaciones", screenId: "OperationsDirectorScreen" }
  ]
};
