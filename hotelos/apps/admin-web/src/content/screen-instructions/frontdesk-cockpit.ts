// Tarjeta de instrucciones de «Mi día» (/hoy). Copy en español, sin jerga
// interna ni nombres de componentes (fix:2-A qa#11); «walk-in» se conserva
// porque es el término que usa la recepción.
export const FRONTDESK_COCKPIT_INSTRUCTIONS = {
  title: 'Mi día en recepción',
  description:
    'Lista priorizada de lo que toca hoy: check-ins pendientes, llegadas en la próxima hora, salidas, walk-ins y habitaciones fuera de servicio.',
  steps: [
    '1. Revisa la cola de acciones en la parte central. Cada tarjeta es una acción concreta.',
    '2. Al pulsar una acción se abre su panel: check-in guiado en 90 segundos, check-out en 60, alta de walk-in…',
    '3. Filtra por tipo en la parte superior si solo quieres ver entradas o salidas.',
    '4. Vuelve aquí cuando quieras desde Hoy › Mi día.'
  ],
  tip: 'Las acciones cambian a lo largo del día según la hora. Si una acción lleva la etiqueta roja, es urgente.'
};
