import type { PersonaGuide } from "./types";

export const COMPLIANCE_OFFICER_GUIDE: PersonaGuide = {
  id: "cumplimiento",
  roleTokens: ["finanzas"],
  title: "Cumplimiento y fiscal: nada pendiente con la Administración",
  summary: "VeriFactu, partes de viajeros, modelos de la AEAT y protección de datos, cada día en su bandeja.",
  dailyFlow: [
    "Empieza en Cumplimiento › Bandeja de cumplimiento: envíos rechazados, plazos a punto de vencer y certificados que caducan.",
    "Revisa en Cumplimiento › Envíos a autoridades el estado de cada envío (VeriFactu, TicketBAI, IGIC, SES.Hospedajes) y reintenta los que fallaron.",
    "Comprueba en Cumplimiento › Registro de viajeros que los partes del día están firmados y comunicados antes de 24 horas.",
    "Prepara los modelos del periodo en Cumplimiento › Modelos AEAT (303, 111, 115, 180, 390) y compáralos con Finanzas › Estados contables.",
    "Atiende las solicitudes de acceso o borrado de datos en Cumplimiento › Protección de datos dentro del plazo de un mes.",
    "Mantén al día los ajustes fiscales de la propiedad en Configuración › Contabilidad y fiscal."
  ],
  tips: [
    "En los territorios forales (Bizkaia, Gipuzkoa, Araba, Navarra) se aplica TicketBAI en lugar de VeriFactu: la pestaña está dentro de VeriFactu.",
    "Un envío marcado como «simulado» no ha llegado a la Administración: hace falta el certificado y el modo producción.",
    "Renueva el certificado digital con al menos un mes de margen: caducado, bloquea toda la facturación."
  ],
  relatedScreens: [
    "ComplianceInbox",
    "FiscalSubmissionsCenter",
    "GuestRegisterSettings",
    "Modelo303Screen",
    "GdprRequestsScreen",
    "AccountingSettings"
  ]
};

export default COMPLIANCE_OFFICER_GUIDE;
