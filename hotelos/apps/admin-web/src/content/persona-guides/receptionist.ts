const RECEPTIONIST_GUIDE: {
  persona: string;
  welcomeMessage: string;
  dailyFlow: Array<{
    step: string;
    description: string;
    screenId: string;
    shortcut?: string;
  }>;
  quickWins: string[];
  commonPitfalls: string[];
  advancedTips: string[];
} = {
  persona: 'receptionist',
  welcomeMessage:
    'Bienvenido a tu cockpit de recepcion. Aqui gestionas el flujo diario de huespedes: llegadas, salidas, walk-ins y night audit. Tu objetivo es mantener cero filas en el lobby y cero errores en el folio. Cmd+1 te trae siempre de vuelta a Mi dia.',
  dailyFlow: [
    {
      step: 'Morning check-ins',
      description:
        'Al iniciar turno revisa la cola de check-ins programados del dia. Pre-asigna habitaciones limpias, valida documentos pendientes y prepara llaves antes de que llegue el primer huesped. Usa QuickCheckIn 90s para procesar cada llegada en menos de dos minutos.',
      screenId: 'FrontdeskCockpitScreen',
      shortcut: 'Cmd+1',
    },
    {
      step: 'Llegadas en 1h watch',
      description:
        'Filtra el cockpit por "llegadas en proxima hora" para anticipar el rush. Confirma con housekeeping que las habitaciones esten listas (verde en el rack), revisa peticiones especiales del huesped (cuna, piso alto, late check-in) y comunica con concierge si hay VIP o miembro de loyalty entrando.',
      screenId: 'ReservationsScreen',
      shortcut: 'Cmd+R',
    },
    {
      step: 'Walk-in handling',
      description:
        'Cuando llega un huesped sin reserva, abre el drawer de walk-in directamente desde el rack. Selecciona habitacion disponible, aplica tarifa BAR del dia (o rate code negociado), registra documento, captura pago y genera folio en una sola pantalla. Tiempo objetivo: menos de 3 minutos.',
      screenId: 'RoomRackScreen',
      shortcut: 'Cmd+W',
    },
    {
      step: 'Afternoon check-outs',
      description:
        'Despues de las 11:00 prioriza la cola de check-outs. Usa QuickCheckOut 60s para cerrar folios: revisa cargos pendientes (minibar, lavanderia, room service), aplica metodo de pago, emite factura/boleta segun pais y libera habitacion para housekeeping. Marca late check-out cuando aplique.',
      screenId: 'FrontdeskCockpitScreen',
      shortcut: 'Cmd+O',
    },
    {
      step: 'Night audit',
      description:
        'Al cierre de turno nocturno corre el night audit: confirma que todas las llegadas esten checked-in o marcadas como no-show, valida que folios del dia esten cuadrados, ejecuta roll-over de fecha de negocio y genera reportes de ocupacion y revenue para el manager de la manana siguiente.',
      screenId: 'NightAuditScreen',
      shortcut: 'Cmd+I',
    },
  ],
  quickWins: [
    'Pre-asigna habitaciones a las llegadas del dia primera hora de la manana: ahorra 30 segundos por check-in en hora pico.',
    'Aprende los 5 shortcuts criticos (Cmd+1, Cmd+R, Cmd+W, Cmd+I, Cmd+O) y reduciras tiempo de procesamiento en 40%.',
    'Usa Tab+Enter para ejecutar la accion activa sin tocar el mouse cuando tengas fila en el lobby.',
    'Activa filtro "VIP" en el cockpit para no perder de vista huespedes que requieren atencion especial.',
  ],
  commonPitfalls: [
    'Hacer check-in sin validar que housekeeping marco la habitacion como limpia: termina enviando al huesped a una habitacion sucia.',
    'Olvidar cerrar el folio al hacer check-out (queda en estado open): el cargo no se contabiliza en el revenue del dia.',
    'No registrar el documento del huesped al inicio: viola compliance local y bloquea facturacion en algunos paises.',
    'Procesar walk-in sin verificar disponibilidad real en el channel manager: puede generar overbooking si la habitacion esta vendida en OTAs.',
    'Saltarse el night audit "porque no hubo movimiento": rompe la continuidad contable y los reportes del dia siguiente.',
  ],
  advancedTips: [
    'Usa J/K para navegar entre acciones del cockpit sin levantar las manos del teclado, estilo terminal.',
    'Si tienes badge rojo en una accion, es SLA vencido: atiende esa primero aunque parezca menos urgente visualmente.',
    'Drag-and-drop una reserva al rack para reasignar habitacion sin abrir el modal completo, util cuando housekeeping reporta una habitacion fuera de servicio.',
    'En vista calendario manten Shift+click para seleccionar rango de fechas y crear walk-in multi-noche en un solo paso.',
    'Si un huesped pide extender estadia, abre su folio activo y agrega noches desde ahi en lugar de crear nueva reserva: mantiene historial unificado.',
    'Para grupos grandes (mas de 10 habitaciones) usa el modo "group check-in" desde Reservations en lugar de procesar uno por uno.',
  ],
};

export default RECEPTIONIST_GUIDE;
export { RECEPTIONIST_GUIDE };
