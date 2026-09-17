import type { PersonaGuide } from "./types";
import { BRAND } from "../../config/brand";

export const MAINTENANCE_GUIDE: PersonaGuide = {
  id: "mantenimiento",
  roleTokens: ["mantenimiento"],
  title: `Mantenimiento: tus averías en ${BRAND.name}`,
  summary: "Partes de avería por urgencia, activos del hotel y consumos de energía y agua.",
  dailyFlow: [
    "Abre Operaciones › Mantenimiento › Mis averías (en el móvil es tu pantalla de inicio): los partes abiertos ordenados por urgencia.",
    "Atiende primero las averías que afectan a una habitación ocupada o a una llegada de hoy (agua, electricidad, climatización).",
    "Si la habitación no se puede vender mientras la arreglas, bloquéala desde el parte para que recepción no la asigne.",
    "Cierra cada parte con lo que has hecho y las piezas usadas; al cerrarlo, Pisos recibe el aviso para repasar la habitación.",
    "Revisa en Operaciones › Activos las garantías que caducan y los proyectos de inversión abiertos.",
    "Una vez por semana mira Operaciones › Energía y agua para detectar consumos anómalos por zona."
  ],
  tips: [
    "Las averías críticas requieren confirmación del responsable antes de cerrarlas.",
    "Una foto de antes y después en cada parte evita discusiones y sirve de historial del activo.",
    "Los incidentes de seguridad (no averías) se registran en Operaciones › Seguridad e incidentes."
  ],
  relatedScreens: ["MaintenanceDashboard", "AssetsDashboard", "EnergyDashboard", "SafetyDashboard"]
};

export default MAINTENANCE_GUIDE;
