export const FRONTDESK_COCKPIT_INSTRUCTIONS = {
  title: 'Front Desk Cockpit',
  description:
    'El cockpit del recepcionista. Lista priorizada de tareas del dia (check-ins pendientes, llegadas en 1h, check-outs, walkins, OOO, etc).',
  steps: [
    '1. Revisa la cola de acciones en la parte central. Cada tarjeta es una accion concreta.',
    '2. Click en una accion abre el drawer correspondiente (QuickCheckIn 90s, QuickCheckOut 60s, walk-in, etc).',
    '3. Filtra por tipo arriba si quieres ver solo check-ins o solo check-outs.',
    '4. Usa Cmd+1 para volver aqui en cualquier momento.'
  ],
  tip: 'Las acciones cambian dinamicamente segun la hora del dia. Si una accion muestra badge rojo, es urgente.'
};
