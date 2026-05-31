export const MANAGER_GUIDE = {
  persona: "Manager",
  dailyFlow: [
    "Revisar el Operations Director board: salud cross-departamento (Front Desk, HK, Mantenimiento, Personal, Seguridad, F&B) y atender alertas criticas primero.",
    "Abrir el revenue dashboard: KPIs ADR / RevPAR / Occupancy del dia, pickup ultimas 24h y pace vs forecast por segmento.",
    "Validar el compliance status: envios SII / TicketBAI / VeriFactu del dia, partes de viajeros pendientes y rechazos abiertos.",
    "Revisar la pricing BAR recommendation del motor IA: leer confianza + justificacion y publicar a canales o ajustar manualmente segun estrategia.",
    "Bloquear tiempo para las decisiones semanales: revenue meeting, group displacement, compliance weekly, operations review y pricing strategy.",
  ],
  tips: [
    "Exporta el meeting pack desde el revenue meeting (RevenueMeetingPack) para llevar pickup, pace, forecast y comp-set listos a la reunion con propiedad sin volver a montarlo.",
    "Antes de aceptar un grupo lanza el displacement analysis: compara ingreso del grupo (rooms + F&B + extras) con el ADR perdido del transient que desplazas; si el delta es negativo, di no.",
    "El Operations Director board se refresca con polling cada 30s — coordinas, no operas; si te encuentras ejecutando tareas departamentales falta cobertura en ese departamento.",
    "La BAR recommendation es propuesta del motor IA: revisa siempre confianza y comp-set antes de publicar a canales.",
    "Si el compliance status muestra rechazos SII / TBAI / VeriFactu, no esperes al cierre del dia — drilldown inmediato para evitar que se acumulen.",
    "Las decisiones semanales (BAR de las proximas 2-4 semanas, plantilla, guardrails de pricing) son tu palanca real de margen; protege ese bloque en el calendario.",
  ],
  relatedScreens: [
    "OperationsDirectorScreen",
    "RevenueHomeDashboard",
    "ComplianceScreen",
    "RevenueMeetingPack",
    "RevenueAutomationRulesScreen",
    "ChannelPerformanceDashboard",
  ],
} as const;
