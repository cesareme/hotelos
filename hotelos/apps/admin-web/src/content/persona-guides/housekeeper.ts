import type { PersonaGuide } from "./types";

export const HOUSEKEEPER_GUIDE: PersonaGuide = {
  persona: "Housekeeper",
  dailyFlow: [
    "Ver tareas asignadas por planta al inicio del turno y revisar prioridades por hora de salida.",
    "Completar habitaciones en orden (departures primero, stayovers despues) marcando estado limpia / inspeccionada.",
    "Reportar issues encontradas durante la limpieza creando work order con evidence fotografica.",
    "Sync con inspector / gobernanta al cierre para validar habitaciones inspeccionadas y liberar a venta.",
  ],
  tips: [
    "Photo evidence: adjunta antes/despues en cada habitacion para auditoria de calidad y reclamaciones.",
    "Lost-and-found: registra objetos olvidados con foto, ubicacion y fecha; queda asociado al guest folio.",
    "Room blocked auto-cleanup: si la habitacion estaba bloqueada por mantenimiento y se resuelve, el sistema crea tarea HK automatica.",
    "Filtra por planta para acotar el listado y reducir desplazamientos entre alas.",
    "Stayovers requieren limpieza ligera (toallas, papelera, cama) — no full turnover.",
  ],
  relatedScreens: ["HousekeepingScreen", "MaintenanceScreen", "FrontDeskCockpit"],
};
