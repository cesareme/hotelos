// troubleshooting — "qué hago si…" articles for hotel staff (help center «?»).
//
// Written for the receptionist or the manager, not for an engineer: no
// browser consoles, request ids, on-call rotations or internal chat channels.
// Each article ends with when to contact ehotelOS support.
//
// Tanda DOC-2: los avisos citados son los reales de la aplicación («La salida debe
// ser posterior a la llegada.», «La llegada es anterior a hoy.», «No se pudo crear
// la reserva.», «Creando…»); la Nueva reserva rápida no tiene «Guardar»; vocabulario
// D5 («En el hotel», «Resuelta», «Inspeccionada»); rutas y botones verificados.
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";

export const TROUBLESHOOTING_CATEGORY = "Qué hago si…";

export const TROUBLESHOOTING_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "troubleshooting-error-guardar-reserva",
    title: "No puedo crear una reserva",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["reservas", "error", "crear", "disponibilidad", "sesión", "nueva reserva"],
    bodyMd: `# No puedo crear una reserva

## Qué ves
- «Crear reserva» está desactivado y, al pasar el ratón por el botón, la ayuda dice por qué: «La salida debe ser posterior a la llegada.», «La llegada es anterior a hoy.», «Elige un tipo de habitación.», «Sin tarifa publicada para esas noches: indica el importe total.» o «Indica nombre y apellido del huésped.».
- Al crear aparece un aviso rojo («No se pudo crear la reserva.» o el motivo del servidor, por ejemplo «La fecha de salida debe ser posterior a la fecha de llegada.») y la reserva no se crea.
- El botón se queda en «Creando…» y no termina.

## Causas habituales
1. **Falta un dato obligatorio** (fechas, tipo de habitación, nombre y apellido) o la salida no es posterior a la llegada.
2. **La llegada es anterior a hoy**: registrar una llegada pasada exige el permiso de modificar reservas y confirmarla expresamente; casi siempre es una fecha mal tecleada.
3. **No hay disponibilidad** para esas fechas y ocupación («Sin disponibilidad para esas fechas y ocupación.») o alguna noche no tiene tarifa publicada.
4. **La sesión ha caducado** mientras completabas el formulario.

## Qué hacer
1. Lee el aviso: indica el campo que falla. Corrígelo y vuelve a pulsar «Crear reserva» (o Intro).
2. Si es la fecha, revisa llegada y salida; el campo admite «hoy», «mañana» y «+7», y «+1 noche» ajusta la salida.
3. Si no hay disponibilidad, cambia el tipo de habitación o las fechas; comprueba el inventario en Hoy › Live Timeline o en Recepción › Reservas › Tablero de habitaciones.
4. Si falta la tarifa, escribe el «Precio total (€)» a mano o revisa en Revenue › Parrilla de tarifas que esas noches tienen precio y no están cerradas a la venta.
5. Si te ha caducado la sesión, vuelve a iniciar sesión y crea la reserva de nuevo.
6. Si el aviso persiste con los datos correctos, anota la hora y el texto del aviso y escribe a soporte.

Más detalle: preguntas frecuentes del manual, capítulo «Reservas y huéspedes» (docs/manual/faq.md).`
  },
  {
    id: "troubleshooting-folio-no-actualiza",
    title: "El folio no muestra un cargo o un cobro",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["folio", "cargos", "cobros", "facturación", "cierre del día"],
    bodyMd: `# El folio no muestra un cargo o un cobro

## Qué ves
- Has añadido un cargo (minibar, restaurante) o registrado un cobro y el saldo del folio no cambia.
- En el check-out aparece el importe antiguo.

## Causas habituales
1. **La pantalla no se ha refrescado** desde que se registró el movimiento.
2. **El cargo se hizo en otro folio** de la misma reserva (por ejemplo, tras dividirlo o por una regla de enrutamiento).
3. **Está en marcha el Cierre del día**: mientras dura, los folios quedan bloqueados unos minutos.
4. **Tu rol no ve esa categoría de cargo.**

## Qué hacer
1. Pulsa «Actualizar» o vuelve a abrir la reserva desde Finanzas › Facturación y cobros.
2. Revisa los demás folios de la reserva desde su ficha (pestaña «Folio») y las reglas de la pestaña «Enrutamiento de folios».
3. Si acaba de ejecutarse el Cierre del día, espera a que termine y vuelve a comprobarlo.
4. Si el movimiento sigue sin aparecer, pide a dirección que compruebe tu rol en Configuración › Usuarios y roles o escribe a soporte con el código de la reserva.

Más detalle: preguntas frecuentes del manual, capítulo «Reservas y huéspedes» (docs/manual/faq.md).`
  },
  {
    id: "troubleshooting-canal-ota-desconectado",
    title: "Un canal de venta aparece desconectado",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["canales", "agencias en línea", "sincronización", "sobreventa", "booking"],
    bodyMd: `# Un canal de venta aparece desconectado

## Qué ves
- En Comercial › Canales de venta el canal está en rojo o «desconectado».
- Las reservas de la agencia no entran o las tarifas no se actualizan; el registro de entregas muestra entregas rechazadas.

## Causas habituales
1. **La agencia ha revocado la conexión** desde su extranet o han cambiado las credenciales.
2. **Un tipo de habitación o un plan de tarifa ya no coincide** (se ha renombrado o eliminado en una de las dos plataformas).
3. **La agencia tiene una incidencia** en su servicio.

## Qué hacer
1. Abre el canal y pulsa «Probar conexión». Si falla por credenciales, vuelve a aceptar la conexión desde la extranet de la agencia.
2. Revisa la pestaña Correspondencias: cada tipo y cada plan deben tener su equivalente.
3. Mientras el canal esté caído, vigila la disponibilidad a mano para evitar sobreventas: marca «Cierre de venta» en el editor de tarifas si hace falta.
4. Cuando vuelva a estar conectado, pulsa «Sincronizar ahora», reintenta las entregas rechazadas con «Reintentar» y comprueba que entra una reserva de prueba.
5. Si sigue desconectado más de una hora sin causa visible, escribe a soporte con el nombre del canal.

Más detalle: preguntas frecuentes del manual, capítulo «Tarifas y canales» (docs/manual/faq.md).`
  },
  {
    id: "troubleshooting-verifactu-rechazado",
    title: "La AEAT ha rechazado una factura (VeriFactu)",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["verifactu", "aeat", "factura", "rechazo", "rectificativa", "certificado"],
    bodyMd: `# La AEAT ha rechazado una factura (VeriFactu)

## Qué ves
- En Cumplimiento › Envíos a autoridades la factura aparece como «rechazada» con un motivo.
- La misma alerta llega a Cumplimiento › Bandeja de cumplimiento.

## Causas habituales
1. **Datos fiscales del cliente incorrectos** (NIF que no valida, razón social vacía).
2. **Datos del emisor incompletos** en Configuración › Estructura societaria o en Configuración › Contabilidad y fiscal › Fiscal.
3. **Certificado digital caducado** o no cargado.
4. **Factura duplicada**: ya existía un registro con el mismo número de serie.

## Qué hacer
1. Abre el envío y lee el motivo del rechazo.
2. Si es un dato del cliente, corrígelo en su ficha (Recepción › Huéspedes) y pulsa «Reintentar».
3. Si es el emisor o el certificado, corrígelo en Configuración › Estructura societaria o en Configuración › Contabilidad y fiscal y reintenta.
4. Si la factura ya se entregó al cliente con datos erróneos, emite una rectificativa desde Finanzas › Facturación y cobros › Rectificativas; no modifiques la original.
5. Un envío marcado «Simulado · no enviado» no ha llegado a la AEAT (el aviso «Modo de pruebas» de la pantalla lo explica): hace falta el certificado y el modo producción.

Más detalle: preguntas frecuentes del manual, capítulo «Facturación, cobros y VeriFactu» (docs/manual/faq.md).`
  },
  {
    id: "troubleshooting-habitacion-bloqueada-mantenimiento",
    title: "Una habitación está bloqueada por mantenimiento",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["habitaciones", "mantenimiento", "bloqueo", "pisos", "llegada"],
    bodyMd: `# Una habitación está bloqueada por mantenimiento

## Qué ves
- En el Tablero de habitaciones o en el Live Timeline la habitación aparece «Bloqueada» o «Fuera de servicio» y no puedes asignarla.
- Una llegada de hoy la tenía asignada, y en la cola de Mi día sale «Incidencia en 108 · …» con «Abrir incidencia».

## Qué hacer
1. Abre la orden de trabajo («Abrir incidencia» desde la cola de Mi día o en Operaciones › Mantenimiento) para ver qué pasa y cuándo se prevé resolver.
2. Si la llegada es hoy, dale otra habitación del mismo tipo: «Cambiar habitación» en la ficha de la reserva o «Cambiar a la 101» en el cajón de check-in; si no hay, ofrece una mejora.
3. Cuando el técnico marque la avería como «Resuelta», la habitación se libera y Pisos la repasa; una vez «Limpia» o «Inspeccionada» vuelve a la venta.
4. Si el bloqueo va a durar más de un día, marca «Cierre de venta» para ese tipo en el editor de tarifas si no quieres venderlo en las agencias.

Más detalle: preguntas frecuentes del manual, capítulo «Pisos y mantenimiento» (docs/manual/faq.md).`
  },
  {
    id: "troubleshooting-reservas-duplicadas",
    title: "Tengo una reserva duplicada",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["reservas", "duplicada", "cancelar", "agencias en línea"],
    bodyMd: `# Tengo una reserva duplicada

## Qué ves
- El mismo huésped y las mismas fechas aparecen dos veces en Recepción › Reservas.

## Causas habituales
1. El huésped reservó por dos canales (por ejemplo, por teléfono y por una agencia).
2. Se creó a mano una reserva que ya había entrado por un canal.

## Qué hacer
1. Abre las dos reservas y compara el origen y la política de cancelación.
2. Conserva la que tenga el pago o la garantía y cancela la otra desde su ficha («Más ▾» › «Cancelar reserva…»); si es de una agencia, cancélala también en la extranet para que no genere comisión.
3. Si el huésped ya está en el hotel, deja la reserva del check-in y cancela la duplicada.
4. En el diálogo de cancelación, desactiva «Aplicar la penalización prevista» si no procede cobrarla: la penalización se carga al folio como línea no sujeta a IVA y solo se aplica si dejas el interruptor activado.

Más detalle: preguntas frecuentes del manual, capítulo «Reservas y huéspedes» (docs/manual/faq.md).`
  }
];

export default TROUBLESHOOTING_ARTICLES;
