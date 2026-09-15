import type { PersonaGuide } from "./types";

export const HOUSEKEEPER_GUIDE: PersonaGuide = {
  id: "pisos",
  roleTokens: ["pisos"],
  title: "Pisos: tu turno en Anfitorio",
  summary: "Tareas por planta, estado de cada habitación y averías que encuentras al limpiar.",
  dailyFlow: [
    "Al empezar el turno abre Operaciones › Pisos › Mi turno (en el móvil es tu pantalla de inicio): verás tus habitaciones ordenadas por prioridad.",
    "Limpia primero las salidas con llegada asignada, después el resto de salidas y por último las estancias en curso.",
    "Marca cada habitación como limpia al terminar; la gobernanta la inspecciona y queda lista para vender.",
    "Si encuentras una avería (grifo, aire, luz), abre un parte desde la propia habitación: pasa directamente a Mantenimiento.",
    "Consulta en Recepción › Reservas › Tablero de habitaciones qué llegadas están previstas para priorizar las habitaciones que faltan.",
    "Al cerrar el turno, revisa en Operaciones › Pisos que no queda ninguna habitación pendiente de inspección."
  ],
  tips: [
    "Filtra por planta para acortar los desplazamientos entre alas.",
    "Una estancia en curso solo necesita repaso (toallas, papelera, cama), no una limpieza de salida completa.",
    "Los objetos olvidados se registran con foto y ubicación para que recepción pueda devolverlos."
  ],
  relatedScreens: ["HousekeepingDashboard", "ReservationWorkspace", "MaintenanceDashboard"]
};

export default HOUSEKEEPER_GUIDE;
