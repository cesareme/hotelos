// Tarjeta de instrucciones de Comercial › Canales de venta (/comercial/canales; la
// consume ChannelAggregatorHub: whatIsThis como TÍTULO de la tarjeta, howToUse como
// pasos y tips unidos con « · » como consejo). Tanda DOC-2: sin anglicismos
// innecesarios y con los literales reales de la pantalla («Dar de alta», pestaña
// «Correspondencias», «Comprobar paridad», «Reintentar», «Editar tarifas en grid»,
// «Archivar»). La sección de entregas de la pantalla se titula todavía «Log de
// entregas»: aquí se llama registro de entregas.
export const CHANNELS_INSTRUCTIONS = {
  whatIsThis: "Canales de venta: estado de cada canal, paridad de precios y correspondencias de productos",
  howToUse: [
    "Da de alta un canal en modo simulado o de pruebas; el modo real exige las credenciales del proveedor",
    "Relaciona los tipos de habitación y los planes de tarifa con los códigos del canal en la pestaña «Correspondencias»",
    "Vigila las alertas de paridad entre los canales y la venta directa («Comprobar paridad»)",
    "Resuelve las entregas rechazadas desde el registro de entregas con «Reintentar»",
  ],
  tips: [
    "Cierre de venta rápido: marca «Cierre de venta» (STOP) en el editor de tarifas («Editar tarifas en grid»)",
    "Los canales archivados conservan su historial y reviven al darlos de alta de nuevo",
  ],
  relatedScreens: ["Revenue", "Tarifas"],
} as const;
