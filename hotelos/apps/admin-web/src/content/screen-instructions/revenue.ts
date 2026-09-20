// Tarjeta de instrucciones de Revenue › Panel de revenue (/revenue; la consume
// RevenueHomeDashboard: whatIsThis como descripción, howToUse como pasos y tips[0]
// como consejo). Tanda DOC-2: literales verificados en la pantalla («Señales en
// vivo»: Reservado a 30 días · Ritmo a 90 días vs. hace 7 días · Captación 7 días ·
// Precisión de la previsión; «Recomendaciones de precio»; «Abrir una herramienta»).
export const REVENUE_INSTRUCTIONS = {
  whatIsThis: "Panel de revenue con las señales calculadas desde las reservas (noches reservadas, ritmo, captación y precisión de la previsión), las recomendaciones de precio pendientes y las herramientas del módulo.",
  howToUse: [
    "Revisa las señales en vivo: noches reservadas a 30 días, ritmo a 90 días frente a hace 7 días y captación de los últimos 7 días.",
    "Comprueba la precisión de la previsión de ocupación: por debajo del 80 % conviene revisar el histórico importado.",
    "Abre Reglas y recomendaciones («Abrir reglas y recomendaciones») para aprobar o rechazar las recomendaciones de precio pendientes.",
    "Desde «Abrir una herramienta» accede a la parrilla de tarifas, el historial, el explorador de previsión, el calendario de demanda y el resto del módulo."
  ],
  tips: [
    "Las recomendaciones de tarifa base se generan a partir de la demanda y de los precios de la competencia; nada se aplica sin aprobación.",
    "El comparador de precios de la competencia se consulta desde Revenue › Competencia.",
    "Un ritmo negativo a 90 días significa que vas por detrás de hace una semana: revisa tarifas y restricciones de esas fechas."
  ],
  relatedScreens: [
    { label: "Reglas y recomendaciones", screenId: "RevenueRules" },
    { label: "Parrilla de tarifas", screenId: "RateGridEditorScreen" },
    { label: "Canales de venta", screenId: "ChannelAggregatorHub" }
  ]
};
