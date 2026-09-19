export const LIVE_TIMELINE_INSTRUCTIONS = {
  whatIsThis:
    "Reservas en casa y proyectadas por habitación en un calendario: cada barra es una estancia, cada fila una habitación agrupada por tipo, y la fila superior indica las habitaciones libres por día.",
  howToUse: [
    "Cambia la escala (día, semana o mes) y muévete con Anterior, Hoy y Siguiente o eligiendo una fecha.",
    "Pasa el ratón por una barra para ver la ficha rápida y haz clic para abrir el detalle con folio, actividad y acciones.",
    "Arrastra una barra a otra habitación o a otras fechas y estira sus bordes para cambiar la entrada o la salida; cada cambio pide confirmación y se puede deshacer.",
    "Selecciona varias celdas vacías de una habitación para crear una reserva con esas fechas.",
    "Filtra por estado, canal o tipo de habitación y busca por código, huésped o número de habitación."
  ],
  tips: [
    "El color indica el estado: llega hoy, en casa, sale hoy, confirmada, borrador, no-show o cancelada (las canceladas solo se ven si activas su filtro).",
    "La alerta roja lista los días con más reservas que habitaciones vendibles de un tipo."
  ],
  shortcuts: [
    { keys: "←→↑↓", description: "Moverse entre reservas" },
    { keys: "Intro", description: "Abrir el detalle" },
    { keys: "Esc", description: "Cerrar el detalle o cancelar el arrastre" }
  ],
  relatedScreens: [
    { name: "Reservas", path: "/recepcion/reservas/lista" },
    { name: "Tablero de habitaciones", path: "/recepcion/reservas/tablero" },
    { name: "Mi día", path: "/hoy" }
  ]
} as const;
