import type { PersonaGuide } from "./types";

export const REVENUE_GUIDE: PersonaGuide = {
  id: "revenue",
  roleTokens: ["revenue"],
  title: "Revenue: precios, previsión y canales",
  summary: "Panel, parrilla, reglas, previsión y competencia; todo en la categoría Revenue.",
  dailyFlow: [
    "Empieza en Revenue › Panel de revenue: ocupación, ADR, RevPAR y pickup de las últimas 24 horas.",
    "Revisa Revenue › Reglas y recomendaciones y decide qué recomendaciones de precio aplicas.",
    "Ajusta las tarifas en Revenue › Parrilla de tarifas y publícalas; el historial guarda cada cambio.",
    "Compara con Revenue › Competencia antes de mover el precio público (BAR).",
    "Consulta Revenue › Histórico y previsión para ver la previsión frente al año anterior y exportar el informe.",
    "Comprueba en Comercial › Canales de venta que las tarifas y la disponibilidad están sincronizadas con los canales dados de alta (en modo de pruebas van al simulador local hasta activar un canal real).",
    "Prepara los jueves Revenue › Reunión de revenue con pace, pickup y presupuesto."
  ],
  tips: [
    "Los eventos y festivos que alimentan la previsión se mantienen en Revenue › Calendario de demanda.",
    "Las políticas de cancelación se definen en Revenue › Políticas de cancelación y se aplican al cancelar o en el cierre del día.",
    "Las exportaciones de revenue están en Informes › Centro de informes › Exportaciones de revenue."
  ],
  relatedScreens: [
    "RevenueHomeDashboard",
    "RevenueRules",
    "RateGridEditorScreen",
    "RateShopperSettings",
    "RevenueHistoryForecastDashboard",
    "ChannelAggregatorHub",
    "RevenueMeeting"
  ]
};

export default REVENUE_GUIDE;
