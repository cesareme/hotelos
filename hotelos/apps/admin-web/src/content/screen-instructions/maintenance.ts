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
  shortcuts: [
    { keys: "Cmd+M", action: "Abrir maintenance" },
  ],
  relatedScreens: ["HK", "Safety"],
} as const;
