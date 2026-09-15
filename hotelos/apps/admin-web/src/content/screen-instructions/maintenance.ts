export const MAINT_INSTRUCTIONS = {
  whatIsThis: "Gestion de work orders de mantenimiento.",
  howToUse: [
    "Crear orden",
    "Asignar tecnico",
    "Bloquear room",
    "Resolver",
    "Cerrar",
  ],
  tips: [
    "Photo evidence",
    "Severity high blocks reservas",
  ],
  shortcuts: [{ keys: "⌘K", action: "Buscar reservas, huéspedes y pantallas" }, { keys: "Esc", action: "Cerrar el panel o diálogo abierto" }],
  relatedScreens: ["HK", "Safety"],
} as const;
