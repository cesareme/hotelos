import type { PersonaGuide } from "./types";

export const MANAGER_GUIDE: PersonaGuide = {
  id: "direccion",
  roleTokens: ["direccion", "admin"],
  title: "Dirección: el hotel de un vistazo",
  summary: "El panel de las nueve, el informe de la IA, las decisiones de precio y la puesta en marcha.",
  dailyFlow: [
    "Empieza en Hoy › Mi día › Dirección: ocupación, ADR, RevPAR, pickup y las alertas de cada departamento.",
    "Lee Hoy › Informe IA del día: qué ha hecho la inteligencia artificial, qué ha propuesto y qué espera tu decisión.",
    "Aprueba o rechaza lo que la IA no ejecuta sola en Hoy › Pendientes de la IA.",
    "Revisa Revenue › Reglas y recomendaciones y publica en Revenue › Parrilla de tarifas las tarifas de las próximas semanas.",
    "Comprueba en Cumplimiento › Bandeja de cumplimiento que no hay envíos rechazados a la AEAT ni partes de viajeros pendientes.",
    "Una vez por semana prepara Revenue › Reunión de revenue: pace, pickup, competencia y presupuesto en una sola pantalla.",
    "Cuando incorpores a alguien, invítalo desde Configuración › Usuarios y roles con el rol que le corresponde."
  ],
  tips: [
    "El rol de cada persona decide qué ve en el menú: un recepcionista no ve Finanzas ni Configuración.",
    "Si una entrada del menú aparece atenuada, su módulo está desactivado: actívalo en Configuración › Módulos e integraciones.",
    "Antes de aceptar un grupo, usa la calculadora de desplazamiento de la reunión de revenue para comparar con la venta individual.",
    "El aviso de «configuración pendiente» de la barra superior desaparece solo cuando la propiedad supera todas las comprobaciones de puesta en marcha."
  ],
  relatedScreens: [
    "FrontDeskDashboard",
    "AiOwnerSummaryScreen",
    "AiHumanReviewQueueScreen",
    "RevenueRules",
    "ComplianceInbox",
    "RevenueMeeting",
    "UserRoleManager",
    "ModuleManager"
  ]
};

export default MANAGER_GUIDE;
