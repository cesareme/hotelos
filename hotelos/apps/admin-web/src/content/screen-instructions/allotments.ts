export const ALLOTMENTS_INSTRUCTIONS = {
  whatIsThis: "Cupos contratados con turoperadores y bancos de camas: bloques de habitaciones reservados para un operador con condiciones propias de liberación, comisión y seguimiento de la captación.",
  howToUse: [
    "1. Pulsa «Nuevo cupo» para crear un bloque con el operador, el tipo de habitación, las fechas y el número de habitaciones o noches.",
    "2. Define los días de liberación antes de la entrada: vencido el plazo, el inventario vuelve a la disponibilidad general.",
    "3. Sigue la captación en tiempo real (habitaciones vendidas frente al cupo total); se marca en rojo si baja del 50 % cerca de la liberación.",
    "4. Configura la comisión de cada contrato y se aplicará automáticamente en cada reserva.",
    "5. «Liberar vencidos» devuelve de una vez todos los cupos caducados que no se han consumido."
  ],
  tips: [
    "Cupo flexible: no garantizado; se libera solo si no hay captación.",
    "Cupo garantizado: el hotel asume el riesgo aunque no se venda.",
    "Venta libre: sin límite hasta que se cierre la venta.",
    "Negocia la comisión según la temporada (alta 12-15 %, baja 18-22 %).",
    "Revisa la captación cada semana para detectar cupos infrautilizados."
  ],
  shortcuts: [
    { keys: "⌘K", description: "Buscar reservas, huéspedes y pantallas" },
    { keys: "Esc", description: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: [
    { label: "Reservas", screenId: "ReservationWorkspace" },
    { label: "Parrilla de tarifas", screenId: "RateGridEditorScreen" },
    { label: "Canales de venta", screenId: "ChannelAggregatorHub" },
    { label: "Contratos B2B", screenId: "B2BContractsScreen" }
  ]
};
