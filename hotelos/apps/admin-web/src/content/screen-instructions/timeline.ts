export const LIVE_TIMELINE_INSTRUCTIONS = {
  whatIsThis:
    "Reservas en el hotel y proyectadas por habitación en un calendario: cada barra es una estancia, cada fila una habitación agrupada por tipo, y la fila superior indica las habitaciones libres por día.",
  howToUse: [
    "Cambia la escala (día, semana o mes) y muévete con Anterior, Hoy y Siguiente o eligiendo una fecha.",
    "Pasa el ratón por una barra para ver la ficha rápida y haz clic para abrir el detalle con folio, actividad y acciones.",
    "Arrastra una barra a otra habitación o a otras fechas y estira sus bordes para cambiar la entrada o la salida (en tablet, mantén pulsada la barra un instante antes de arrastrar): el cambio se aplica al momento y se puede deshacer durante 8 segundos; solo el check-in, el check-out, cancelar y el no-show piden confirmación.",
    "Selecciona varias celdas vacías de una habitación para crear una reserva con esas fechas.",
    "Filtra por estado, canal o tipo de habitación y busca por código, huésped o número de habitación."
  ],
  tips: [
    "El color indica el estado: llega hoy, en el hotel, sale hoy, confirmada, borrador, no-show o cancelada (las canceladas solo se ven si activas su filtro); son los mismos colores que en Mi día y en el tablero.",
    "La alerta roja lista los días con más reservas que habitaciones vendibles de un tipo."
  ],
  shortcuts: [
    { keys: "←→↑↓", description: "Moverse entre reservas" },
    { keys: "Intro", description: "Abrir el detalle" },
    { keys: "Esc", description: "Cerrar el detalle o cancelar el arrastre" },
    { keys: "⌥←→", description: "Mover la reserva seleccionada un día" },
    { keys: "⌥⇧←→", description: "Adelantar o retrasar la salida un día" },
    { keys: "⌥↑↓", description: "Cambiar la reserva seleccionada a la habitación de arriba o de abajo" },
    { keys: "⌘Z", description: "Deshacer el último cambio" }
  ],
  relatedScreens: [
    { name: "Reservas", path: "/recepcion/reservas/lista" },
    { name: "Tablero de habitaciones", path: "/recepcion/reservas/tablero" },
    { name: "Mi día", path: "/hoy" }
  ]
} as const;
