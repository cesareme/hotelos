export const REVENUE_INSTRUCTIONS = {
  whatIsThis: "Panel de revenue con las señales calculadas desde las reservas (noches reservadas, ritmo, captación y precisión de la previsión), las recomendaciones de precio pendientes y las herramientas del módulo.",
  howToUse: [
    "1. Revisa las señales en vivo: noches reservadas a 30 días, ritmo a 90 días frente al periodo de comparación y captación de los últimos 7 días.",
    "2. Comprueba la precisión de la previsión de ocupación: por debajo del 80 % conviene revisar el histórico importado.",
    "3. Abre Reglas y recomendaciones para aprobar o rechazar las recomendaciones de precio pendientes.",
    "4. Desde «Abrir una herramienta» accede a la parrilla de tarifas, el explorador de previsión, el calendario de demanda y el resto del módulo."
  ],
  tips: [
    "Las recomendaciones de tarifa base se generan a partir de la demanda y de los precios de la competencia; nada se aplica sin aprobación.",
    "El comparador de precios de la competencia se consulta desde Revenue › Competencia.",
    "Un ritmo negativo a 90 días significa que vas por detrás del periodo de comparación: revisa tarifas y restricciones de esas fechas."
  ],
  relatedScreens: [
    { label: "Reglas y recomendaciones", screenId: "RevenueRules" },
    { label: "Parrilla de tarifas", screenId: "RateGridEditorScreen" },
    { label: "Canales de venta", screenId: "ChannelAggregatorHub" }
  ]
};
