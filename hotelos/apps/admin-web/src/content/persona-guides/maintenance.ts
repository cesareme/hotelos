export const MAINTENANCE_GUIDE = {
  persona: "Maintenance",
  dailyFlow: [
    "Ver work orders abiertos ordenados por severity (critical > high > medium > low).",
    "Asignar cada orden al tecnico disponible segun skill y location.",
    "Ejecutar el trabajo en sitio siguiendo el procedimiento estandar.",
    "Cerrar la orden con evidence: fotos antes/despues, partes usadas y notas tecnicas.",
  ],
  tips: [
    "Bloquear room en PMS si la incidencia afecta al huesped (agua, electricidad, A/C).",
    "Integration con HK: notificar limpieza tras reparacion para volver a poner habitacion en venta.",
    "Severity critical exige confirmacion al supervisor antes de cerrar.",
    "Adjunta siempre evidence fotografica para auditoria y SLA.",
  ],
  relatedScreens: ["MaintenanceScreen", "HousekeepingScreen", "FrontDeskCockpit"],
} as const;
