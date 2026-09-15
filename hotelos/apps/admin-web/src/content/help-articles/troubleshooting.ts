// troubleshooting — "qué hago si…" articles for hotel staff (help center «?»).
//
// Written for the receptionist or the manager, not for an engineer: no
// browser consoles, request ids, on-call rotations or internal chat channels.
// Each article ends with when to contact Anfitorio support.
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";

export const TROUBLESHOOTING_CATEGORY = "Qué hago si…";

export const TROUBLESHOOTING_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "troubleshooting-error-guardar-reserva",
    title: "No puedo guardar una reserva",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["reservas", "error", "guardar", "disponibilidad", "sesión"],
    bodyMd: `# No puedo guardar una reserva

## Qué ves
- Al pulsar «Guardar» aparece un aviso rojo y la reserva no se crea.
- El botón se queda «Guardando…» y no termina.

## Causas habituales
1. **Falta un dato obligatorio** (fechas, tipo de habitación, tarifa o nombre del titular) o la salida es anterior a la entrada.
2. **La habitación ya no está libre**: otra reserva (por ejemplo, de una agencia en línea) la ha ocupado mientras rellenabas el formulario.
3. **La tarifa está cerrada** para esas fechas (venta cerrada o estancia mínima).
4. **La sesión ha caducado** mientras completabas el formulario.

## Qué hacer
1. Lee el aviso: indica el campo que falla. Corrígelo y vuelve a guardar.
2. Si la habitación ya no está libre, abre Recepción › Reservas › Tablero de habitaciones y elige otra del mismo tipo.
3. Si la tarifa está cerrada, comprueba en Revenue › Planes de tarifas sus restricciones o elige otro plan.
4. Si te ha caducado la sesión, vuelve a iniciar sesión y crea la reserva de nuevo.
5. Si el aviso persiste con los datos correctos, anota la hora y el texto del aviso y escribe a soporte.`
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
2. **El cargo se hizo en otro folio** de la misma reserva (por ejemplo, tras dividirlo).
3. **Está en marcha el Cierre del día**: mientras dura, los folios quedan bloqueados unos minutos.
4. **Tu rol no ve esa categoría de cargo.**

## Qué hacer
1. Pulsa «Actualizar» en el folio o vuelve a abrirlo desde Finanzas › Facturación y cobros.
2. Revisa los demás folios de la reserva en el detalle de Recepción › Reservas.
3. Si acaba de ejecutarse el Cierre del día, espera a que termine y vuelve a comprobarlo.
4. Si el movimiento sigue sin aparecer, pide a dirección que compruebe tu rol en Configuración › Usuarios y roles o escribe a soporte con el número de reserva.`
  },
  {
    id: "troubleshooting-canal-ota-desconectado",
    title: "Un canal de venta aparece desconectado",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["canales", "agencias en línea", "sincronización", "sobreventa", "booking"],
    bodyMd: `# Un canal de venta aparece desconectado

## Qué ves
- En Comercial › Canales de venta el canal está en rojo o «desconectado».
- Las reservas de la agencia no entran o las tarifas no se actualizan.

## Causas habituales
1. **La agencia ha revocado la conexión** desde su extranet o han cambiado las credenciales.
2. **Un tipo de habitación o un plan de tarifa ya no coincide** (se ha renombrado o eliminado en una de las dos plataformas).
3. **La agencia tiene una incidencia** en su servicio.

## Qué hacer
1. Abre el canal y pulsa «Probar conexión». Si falla por credenciales, vuelve a aceptar la conexión desde la extranet de la agencia.
2. Revisa la pestaña Correspondencias: cada tipo y cada plan deben tener su equivalente.
3. Mientras el canal esté caído, vigila la disponibilidad a mano para evitar sobreventas: cierra la venta del canal si hace falta.
4. Cuando vuelva a estar conectado, pulsa «Sincronizar ahora» y comprueba que entra una reserva de prueba.
5. Si sigue desconectado más de una hora sin causa visible, escribe a soporte con el nombre del canal.`
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
2. **Datos del emisor incompletos** en Configuración › Contabilidad y fiscal.
3. **Certificado digital caducado** o no cargado.
4. **Factura duplicada**: ya existía un registro con el mismo número de serie.

## Qué hacer
1. Abre el envío y lee el motivo del rechazo.
2. Si es un dato del cliente, corrígelo en su ficha (Recepción › Huéspedes) y pulsa «Reintentar».
3. Si es el emisor o el certificado, corrígelo en Configuración › Contabilidad y fiscal y reintenta.
4. Si la factura ya se entregó al cliente con datos erróneos, emite una rectificativa desde Finanzas › Facturación y cobros › Rectificativas; no modifiques la original.
5. Un envío marcado como «simulado» no ha llegado a la AEAT: hace falta el certificado y el modo producción.`
  },
  {
    id: "troubleshooting-habitacion-bloqueada-mantenimiento",
    title: "Una habitación está bloqueada por mantenimiento",
    category: TROUBLESHOOTING_CATEGORY,
    tags: ["habitaciones", "mantenimiento", "bloqueo", "pisos", "llegada"],
    bodyMd: `# Una habitación está bloqueada por mantenimiento

## Qué ves
- En el Tablero de habitaciones la habitación aparece «fuera de servicio» y no puedes asignarla.
- Una llegada de hoy la tenía asignada.

## Qué hacer
1. Abre el parte en Operaciones › Mantenimiento para ver qué pasa y cuándo se prevé resolver.
2. Si la llegada es hoy, reasigna otra habitación del mismo tipo desde el Tablero de habitaciones; si no hay, ofrece una mejora.
3. Cuando el técnico cierre el parte, Pisos recibe el aviso para repasar la habitación; una vez inspeccionada vuelve a la venta.
4. Si el bloqueo va a durar más de un día, ciérrala también en Comercial › Canales de venta para no venderla en las agencias.`
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
2. Conserva la que tenga la garantía de pago y cancela la otra desde su detalle; si es de una agencia, cancélala también en la extranet para que no genere comisión.
3. Si el huésped ya está alojado, deja la reserva del check-in y cancela la duplicada.
4. Comprueba que la penalización de cancelación (Revenue › Políticas de cancelación) no se ha aplicado a la duplicada; si se ha aplicado, anúlala desde el folio.`
  }
];

export default TROUBLESHOOTING_ARTICLES;
