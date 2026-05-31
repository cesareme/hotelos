export const COMPLIANCE_OFFICER_GUIDE = {
  persona: "Compliance Officer",
  dailyFlow: [
    "Revisar la matriz semaforo de controles (verde=OK, ambar=atencion, rojo=accion requerida) para detectar areas criticas al iniciar el dia.",
    "Consultar doc vault expirations: certificados digitales, licencias turisticas, autorizaciones autonomicas y libros registro proximos a vencer.",
    "Atender alerts criticos del feed por prioridad: errores VeriFactu/TBAI/SES, plazos vencidos, cambios normativos publicados.",
    "Ejecutar inspection prep: check-list de documentos exigibles por AEAT, Hacienda Foral, autoridad turistica y proteccion de datos.",
    "Auditar el audit trail diario: trazabilidad de envios automaticos, hashes de registros, sellos de tiempo y firmas electronicas.",
  ],
  tips: [
    "Usa los filtros por CCAA (Pais Vasco, Navarra, Canarias, regimen comun) para segmentar obligaciones segun jurisdiccion.",
    "En territorios forales aplica TBAI (TicketBAI) en lugar de VeriFactu: Bizkaia, Gipuzkoa, Araba y Navarra tienen plataformas y plazos propios.",
    "Para ESRS clasifica emisiones por scope: scope 1 (combustion directa: calderas, vehiculos), scope 2 (electricidad y climatizacion adquirida), scope 3 (cadena de valor: huespedes, proveedores, residuos).",
    "Configura recordatorios anticipados (T-30, T-7, T-1) sobre vencimientos del document vault para evitar incumplimientos.",
    "Export inspection folder genera un ZIP con la documentacion exigible para entregar a inspectores sin exposicion innecesaria.",
  ],
  relatedScreens: ["ComplianceScreen", "BillingScreen", "ConfigurationScreen"],
} as const;
