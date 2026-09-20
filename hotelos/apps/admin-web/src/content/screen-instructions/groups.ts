// Instructions card of Recepción › Grupos y eventos › Calendario
// (/recepcion/grupos/calendario; consumed by GroupsCalendarScreen). Business
// Spanish only: no component names and no internal jargon (fix:guidance
// qa#13). «Rooming list» is kept because it is the term the front desk and the
// group actions use («Importar rooming list»); it is introduced once next to
// its Spanish meaning. Steps carry no numbering: the card renders an ordered
// list and prefixes the tip with «Tip:» itself. Tanda DOC-2: literales
// verificados en la pantalla («Nuevo grupo», «Bloquear habitaciones», «Guardar
// bloqueo», «Crear evento», «Nuevo evento», «Importar rooming list»; la fecha
// límite se propone a 15 días y la entrega de la rooming list a 20; la
// liberación automática corre a diario) y atajos tomados del registro.
import { shortcutKeys } from "../shortcuts-registry";

export const GROUPS_INSTRUCTIONS = {
  whatIsThis:
    'Grupos de empresas, agencias y eventos que contratan varias habitaciones bajo un mismo acuerdo: bloqueo de habitaciones, fecha límite, lista de huéspedes (rooming list) y eventos asociados.',
  howToUse: [
    'Crea el grupo con el botón «Nuevo grupo»: contacto, llegada y salida, modelo de tarifa y fecha límite.',
    'Bloquea las habitaciones desde la lista de Recepción › Grupos y eventos con la acción «Bloquear habitaciones»: reparte las habitaciones por tipo y noche y pulsa «Guardar bloqueo».',
    'Añade los eventos del grupo (reuniones, cenas, salones) con «Crear evento» o «Nuevo evento».',
    'Cuando el cliente envíe la lista de huéspedes, cárgala con «Importar rooming list» (un fichero CSV); vuelve a importarla si cambia.',
    'Vigila la fecha límite de cada grupo: en el calendario la marca la línea discontinua y, pasada esa fecha, los grupos provisionales o confirmados se liberan automáticamente cada día.',
  ],
  tips: [
    'Pulsa una barra del calendario para abrir la ficha del grupo; el color de la barra indica el estado del bloqueo y la línea discontinua, la fecha límite.',
    'El formulario propone fechas por defecto para la fecha límite y para la entrega de la rooming list; ajústalas a lo que fije el contrato del grupo.',
  ],
  shortcuts: [
    { keys: shortcutKeys('global.palette'), description: 'Buscar reservas, huéspedes y pantallas' },
    { keys: shortcutKeys('global.escape'), description: 'Cerrar el panel o diálogo abierto' },
  ],
  relatedScreens: [
    { label: 'Grupos y eventos', screenId: 'GroupsEventsDashboard' },
    { label: 'Cupos', screenId: 'AllotmentsScreen' },
    { label: 'Reservas', screenId: 'ReservationsListScreen' },
  ],
} as const;
