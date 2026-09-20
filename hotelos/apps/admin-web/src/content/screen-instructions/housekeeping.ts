// Tarjeta de instrucciones de Operaciones › Pisos › «Mi turno»
// (/operaciones/pisos/mi-turno; la consume HousekeepingMobileScreen: whatIsThis como
// descripción, howToUse como pasos y tips[0] como consejo; el título «Housekeeping»
// vive en la pantalla). Tanda DOC-2: copy en español con el vocabulario D5 y solo lo
// que existe en la pantalla (filtro por prioridad, botones «Iniciar» · «Limpia» ·
// «Inspeccionada» · «Reportar»); los atajos salen del registro, nunca a mano.
import { shortcutKeys } from "../shortcuts-registry";

export const HK_INSTRUCTIONS = {
  whatIsThis:
    "Mi turno: la lista de habitaciones que tocan hoy, ordenada por prioridad (urgente, alta, normal, baja), con la planta, el tipo, el estado de limpieza (Limpia · Inspeccionada · Sucia) y el motivo (salida sucia, llegada inminente, estancia, tarea pendiente o incidencia abierta).",
  howToUse: [
    "Filtra por prioridad con los botones de arriba (Todo · Urgente · Alta · Normal · Baja); cada tarjeta muestra la habitación, la planta, el tipo, el estado de limpieza y, si lo hay, el huésped en el hotel y su petición especial.",
    "Pulsa «Iniciar» al entrar en una habitación sucia: la tarea pasa a «En limpieza».",
    "Al terminar pulsa «Limpia»; en una habitación ya limpia o en limpieza, «Inspeccionada» la marca como revisada. Una habitación limpia sin tarea ni incidencia desaparece de la lista.",
    "Con «Reportar» describes una avería o un desperfecto: se crea una orden de trabajo para mantenimiento sin salir de la pantalla."
  ],
  tips: [
    "El orden es el de la prioridad: primero las habitaciones sucias con llegada en menos de dos horas, después las salidas de hoy («Salida sucia · cliente ya marchó»), luego las estancias y las llegadas del día y, por último, las tareas pendientes e incidencias; a igual prioridad, por número de habitación."
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
