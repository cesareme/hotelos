export const RESERVATIONS_INSTRUCTIONS = {
  whatIsThis:
    'Lista completa de reservas con filtros, busqueda y vista calendario/lista/grid. Centraliza todas las reservas del hotel (confirmadas, pendientes, canceladas, no-show) permitiendo gestionarlas desde una unica pantalla con multiples modos de visualizacion.',
  howToUse: [
    '1. Selecciona el modo de vista en la barra superior: calendario para ver reservas por fechas, lista para ver detalles tabulares, o grid para una vista compacta tipo tarjetas.',
    '2. Usa la barra de busqueda para encontrar reservas por nombre del huesped, numero de confirmacion, email o telefono.',
    '3. Aplica filtros desde el panel lateral: estado de la reserva, canal de venta, tipo de habitacion, fechas de check-in/check-out o segmento de mercado.',
    '4. Haz clic en cualquier reserva para abrir el detalle completo, donde puedes editar fechas, cambiar habitacion, agregar cargos o gestionar el folio del huesped.',
    '5. Crea una nueva reserva con el botón «Nueva reserva», completando los datos del huesped y seleccionando habitacion y tarifa.',
  ],
  tips: [
    'Arrastra y suelta reservas directamente al rack de habitaciones para reasignar la unidad sin abrir el modal de edicion.',
        'Usa ⌘K para encontrar huéspedes o localizadores desde cualquier pantalla.',
    'En vista calendario, manten Shift al hacer clic para seleccionar un rango de fechas y crear walk-in.',
    'El color de cada reserva indica su estado: llega hoy, en casa, sale hoy, confirmada, borrador, no-show o cancelada (la leyenda del Live Timeline de Hoy es la referencia; las canceladas solo se ven con su filtro).',
  ],
  shortcuts: [{ keys: '⌘K', description: 'Buscar reservas, huéspedes y pantallas' }, { keys: 'Esc', description: 'Cerrar el panel o diálogo abierto' }],
  relatedScreens: [
    { name: 'Rack de habitaciones', path: '/rack' },
    { name: 'Check-in', path: '/front-desk/check-in' },
    { name: 'Check-out', path: '/front-desk/check-out' },
    { name: 'Huespedes', path: '/guests' },
    { name: 'Tarifas y disponibilidad', path: '/rates-availability' },
    { name: 'Reportes de reservas', path: '/reports/reservations' },
  ],
} as const;
