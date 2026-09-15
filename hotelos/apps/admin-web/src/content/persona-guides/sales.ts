import type { PersonaGuide } from "./types";

export const SALES_GUIDE: PersonaGuide = {
  id: "comercial",
  roleTokens: ["comercial"],
  title: "Comercial: clientes, grupos y canales",
  summary: "Clientes y fidelización, reputación, ventas a empresas, grupos y canales de venta.",
  dailyFlow: [
    "Empieza en Hoy › Mi día › Dirección para ver la ocupación y el pickup del día.",
    "Trabaja las oportunidades con empresas y agencias en Comercial › Ventas a empresas.",
    "Gestiona los bloqueos de habitaciones y los cupos en Recepción › Grupos y eventos (pestañas Calendario y Cupos).",
    "Revisa las reseñas y encuestas en Comercial › Reputación y calidad y responde a las que lo necesitan.",
    "Segmenta clientes y lanza campañas desde Comercial › Clientes y fidelización.",
    "Comprueba en Comercial › Canales de venta el estado de la conexión con cada agencia en línea.",
    "Mide qué canal deja más margen en Informes › Rendimiento de canales."
  ],
  tips: [
    "Antes de aceptar un grupo, usa la calculadora de desplazamiento de Revenue › Reunión de revenue.",
    "Las mejoras de habitación y los extras se configuran en Comercial › Ventas adicionales.",
    "Las comisiones de cada canal se revisan en Finanzas › Comisiones."
  ],
  relatedScreens: [
    "SalesPipelineDashboard",
    "GroupsEventsDashboard",
    "ReputationDashboard",
    "CrmDashboard",
    "ChannelAggregatorHub",
    "ChannelPerformanceDashboard"
  ]
};

export default SALES_GUIDE;
