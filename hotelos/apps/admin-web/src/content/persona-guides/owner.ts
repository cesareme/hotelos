import type { PersonaGuide } from "./types";

export const OWNER_GUIDE: PersonaGuide = {
  id: "propietario",
  roleTokens: ["direccion"],
  title: "Propietario: resultados sin operar el día a día",
  summary: "Cartera, rentabilidad, tesorería y cumplimiento, comparados con el presupuesto y con el año anterior.",
  dailyFlow: [
    "Tu inicio es Hoy › Mi día › Propietario: ingresos, margen y ocupación del mes frente al presupuesto y al año pasado.",
    "Si tienes varios hoteles, Informes › Cartera de propiedades los compara entre sí y permite entrar en cada uno.",
    "Mira Informes › Rentabilidad por habitación para saber qué tipos de habitación y qué canales dejan más margen.",
    "Revisa Finanzas › Tesorería: lo que te deben, lo que debes y la posición de caja.",
    "Comprueba en Cumplimiento › Centro de cumplimiento que las obligaciones legales (VeriFactu, partes de viajeros, protección de datos) están al día.",
    "Lee Hoy › Informe IA del día para saber qué ha hecho la IA y cuánto ha costado."
  ],
  tips: [
    "Si te encuentras revisando check-ins o sobreventas, escala a dirección en lugar de intervenir: tu panel es de resultados, no de operación.",
    "Un RevPAR por debajo de la competencia (Revenue › Competencia) es una señal para revisar precios y mezcla de canales.",
    "Cuadra la tesorería real con el resultado del mes antes de decidir reparto o reinversión."
  ],
  relatedScreens: [
    "FrontDeskDashboard",
    "PortfolioDashboard",
    "RoomProfitabilityDashboard",
    "FinancePositionDashboard",
    "ComplianceCenter",
    "AiOwnerSummaryScreen"
  ]
};

export default OWNER_GUIDE;
