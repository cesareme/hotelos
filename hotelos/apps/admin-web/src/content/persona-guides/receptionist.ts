import type { PersonaGuide } from "./types";

export const RECEPTIONIST_GUIDE: PersonaGuide = {
  id: "recepcion",
  roleTokens: ["recepcion"],
  title: "Recepción: tu día en Anfitorio",
  summary: "Llegadas, salidas, cobros y partes de viajeros sin salir de «Mi día».",
  dailyFlow: [
    "Empieza en Hoy › Mi día: llegadas y salidas de hoy, huéspedes alojados y la cola de acciones del turno.",
    "Antes de la primera llegada, mira en Recepción › Reservas › Tablero de habitaciones qué habitaciones están limpias y cuáles siguen sin asignar.",
    "Haz cada check-in desde la tarjeta de llegada de Mi día: documento de identidad, habitación y garantía de pago en el mismo panel.",
    "Si llama un cliente, crea la reserva en Recepción › Nueva reserva (o díctala en la pestaña «Dictar (IA)» y revisa el borrador).",
    "Responde a los huéspedes desde Recepción › Mensajes de huéspedes: la IA propone un borrador y tú decides si lo envías.",
    "Por la tarde cierra las salidas: revisa el folio, cobra el saldo pendiente y entrega la factura desde Finanzas › Facturación y cobros.",
    "Firma y envía los partes de viajeros en Cumplimiento › Bandeja de cumplimiento antes de que pasen 24 horas de la entrada.",
    "En el turno de noche ejecuta Hoy › Cierre del día: comprueba llegadas sin registrar, folios abiertos y cambia la fecha de negocio."
  ],
  tips: [
    "Busca cualquier reserva, huésped o factura con ⌘K: por nombre, localizador o número de habitación.",
    "Una reserva sin habitación asignada no puede hacer check-in: asígnala primero desde el Tablero de habitaciones.",
    "El documento de identidad es obligatorio en España: rellénalo en el check-in y no tendrás partes rechazados después.",
    "Si el correo saliente no está configurado, la confirmación o la invitación te muestran el enlace para que lo entregues tú."
  ],
  relatedScreens: [
    "FrontDeskDashboard",
    "ReservationWorkspace",
    "ReservationCreate",
    "GuestsList",
    "ConciergeInboxDashboard",
    "ComplianceInbox",
    "NightAuditScreen"
  ]
};

export default RECEPTIONIST_GUIDE;
