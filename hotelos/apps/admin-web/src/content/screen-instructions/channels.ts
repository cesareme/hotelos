export const CHANNELS_INSTRUCTIONS = {
  whatIsThis: "Gestor de canales OTA: estado de cada canal, paridad de precios y mapeos de productos.",
  howToUse: [
    "Conectar un canal (modo simulado o de pruebas; el modo real exige credenciales)",
    "Mapear los tipos de habitación y planes a los códigos del canal",
    "Vigilar la paridad de precios entre canales y venta directa",
    "Resolver las entregas rechazadas desde el log de entregas",
  ],
  tips: [
    "Cierre de venta rápido: edita la restricción STOP desde el editor de tarifas",
    "Los canales archivados conservan su historial y reviven al darlos de alta de nuevo",
  ],
  relatedScreens: ["Revenue", "Pricing"],
} as const;
