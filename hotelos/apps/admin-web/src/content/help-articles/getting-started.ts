// getting-started — first-week articles for the help center («?»).
//
// Every path names a category and an item of the Tanda 5 navigation tree
// (Hoy · Recepción · Operaciones · Comercial · Revenue · Finanzas ·
// Cumplimiento · Informes · Configuración). Only real shortcuts are mentioned
// (see ./keyboard-shortcuts.ts).
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";

export const GETTING_STARTED_CATEGORY = "Primeros pasos";

export const GETTING_STARTED_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "primer-check-in",
    title: "Cómo hacer mi primer check-in",
    category: GETTING_STARTED_CATEGORY,
    tags: ["check-in", "recepción", "llegadas", "reservas", "huéspedes", "documento"],
    bodyMd: `# Cómo hacer mi primer check-in

El check-in es el primer contacto con el huésped. En Anfitorio se completa desde la tarjeta de llegada de «Mi día», con el documento de identidad y la garantía de pago en el mismo panel.

## Paso a paso

1. **Abre Hoy › Mi día.** Verás las llegadas previstas para hoy con el estado de su habitación (limpia, sucia, en inspección).
2. **Localiza la reserva.** Si no la ves, búscala con ⌘K por nombre, localizador o número de habitación.
3. **Comprueba la habitación.** Una llegada «sin asignar» no puede hacer check-in: asígnala desde Recepción › Reservas › Tablero de habitaciones.
4. **Pulsa «Hacer check-in».** Se abre el panel con tres pasos: huésped, habitación y medio de pago.
5. **Completa los datos del huésped principal** y de los acompañantes mayores de 14 años: tipo y número de documento, nacionalidad y fecha de nacimiento. Son los datos del parte de viajeros que se comunica a SES.Hospedajes.
6. **Registra la garantía de pago** (tarjeta o efectivo) y entrega la llave.

## Buenas prácticas

- Verifica el documento físico contra el nombre de la reserva.
- Si el huésped ya ha estado antes, revisa su ficha en Recepción › Huéspedes para personalizar el saludo.
- Al cerrar el panel, la reserva pasa a «Alojado» y la habitación a «Ocupada».`
  },
  {
    id: "crear-reserva-nueva",
    title: "Cómo crear una reserva nueva",
    category: GETTING_STARTED_CATEGORY,
    tags: ["reservas", "nueva reserva", "sin reserva", "recepción", "tarifas"],
    bodyMd: `# Cómo crear una reserva nueva

Una llamada, un correo o un cliente sin reserva: la alta manual se hace desde Recepción › Nueva reserva.

## Paso a paso

1. **Abre Recepción › Nueva reserva.** También puedes dictarla en la pestaña «Dictar (IA)» y revisar el borrador antes de guardarla.
2. **Elige las fechas** de entrada y salida y el número de huéspedes. Verás la disponibilidad por tipo de habitación y la tarifa aplicable.
3. **Selecciona el tipo de habitación y el plan de tarifa** (pública, no reembolsable, con desayuno…). El desglose se muestra noche a noche.
4. **Introduce los datos del titular**: nombre, correo y teléfono; el documento puede completarse en el check-in.
5. **Elige la garantía** (tarjeta, transferencia o crédito de empresa).
6. **Revisa el resumen** con el total y la política de cancelación y pulsa «Guardar». La reserva aparece al instante en Recepción › Reservas › Cronograma.

## Buenas prácticas

- Si el huésped ya existe, Anfitorio lo sugiere por correo o teléfono y rellena la ficha.
- Marca el origen (teléfono, correo, sin reserva) para que Informes › Rendimiento de canales lo refleje.`
  },
  {
    id: "gestionar-grupo-grande",
    title: "Cómo gestionar un grupo",
    category: GETTING_STARTED_CATEGORY,
    tags: ["grupos", "eventos", "cupos", "bodas", "lista de habitaciones", "folio maestro"],
    bodyMd: `# Cómo gestionar un grupo

A partir de ocho habitaciones (o cualquier evento con bloqueo) el flujo cambia: bloqueo de habitaciones, cupo, lista de huéspedes y facturación centralizada. Todo vive en Recepción › Grupos y eventos.

## Paso a paso

1. **Crea el grupo** con «Nuevo grupo»: nombre, contacto del organizador y fecha límite de liberación.
2. **Define el bloqueo**: habitaciones por tipo, tarifa pactada y política de cancelación negociada. El cupo descuenta inventario automáticamente (pestaña Cupos).
3. **Fija la fecha de corte**: a partir de ese día las habitaciones no nominadas vuelven a la venta general.
4. **Importa la lista de huéspedes** del organizador (CSV) o añádelos uno a uno; cada línea crea una reserva ligada al grupo.
5. **Decide cómo se factura**: todo al folio maestro, alojamiento al maestro y extras a cada huésped, o cada huésped paga lo suyo.
6. **Sigue el evento** en la pestaña Calendario y revisa el folio maestro cada día durante la estancia.

## Buenas prácticas

- Antes de aceptar el grupo, calcula el desplazamiento en Revenue › Reunión de revenue: ingreso del grupo frente a la venta individual que desplaza.
- Avisa a Pisos y a Restauración desde la primera semana para preparar habitaciones y servicios.`
  },
  {
    id: "dividir-folio",
    title: "Cómo dividir un folio",
    category: GETTING_STARTED_CATEGORY,
    tags: ["folio", "facturación", "cobros", "check-out", "dividir"],
    bodyMd: `# Cómo dividir un folio

Dos huéspedes que pagan por separado, una empresa que cubre el alojamiento y el huésped los extras, o un grupo que separa banquete y habitaciones: el folio se divide desde Finanzas › Facturación y cobros.

## Paso a paso

1. **Abre el folio** desde el detalle de la reserva o desde Finanzas › Facturación y cobros › Folio.
2. **Pulsa «Dividir folio».** Elige el modo: por porcentaje, por concepto (alojamiento a un folio, extras a otro) o seleccionando cargo a cargo.
3. **Crea el segundo pagador** con sus datos fiscales (NIF o CIF); si es una empresa conocida, búscala por razón social.
4. **Revisa los dos folios** con sus totales e impuestos y confirma.
5. **Cierra cada folio por separado** en el check-out: dos cobros y dos facturas.

## Buenas prácticas

- Pide los datos fiscales en el check-in si sabes que habrá división: evita prisas en la salida.
- Comprueba que cada folio lleva el tipo impositivo correcto (residente, empresa).
- Anota el motivo de la división en las notas internas para auditoría.`
  },
  {
    id: "conectar-canal-venta",
    title: "Cómo conectar un canal de venta (Booking.com, Expedia…)",
    category: GETTING_STARTED_CATEGORY,
    tags: ["canales", "booking", "expedia", "agencias en línea", "correspondencias", "sincronización"],
    bodyMd: `# Cómo conectar un canal de venta

Conectar una agencia en línea sincroniza disponibilidad, tarifas, restricciones y reservas en ambos sentidos. Se hace desde Comercial › Canales de venta.

## Paso a paso

1. **Abre Comercial › Canales de venta** y pulsa «Conectar» en el canal. Necesitarás el identificador del hotel en la agencia.
2. **Acepta la conexión desde la extranet de la agencia** (apartado de conectividad): este paso lo haces tú en su web.
3. **Relaciona las habitaciones** en la pestaña Correspondencias: cada tipo de la agencia debe corresponder a un tipo de Anfitorio.
4. **Relaciona los planes de tarifa** (pública, no reembolsable, con desayuno) y confirma las reglas de derivación.
5. **Activa la sincronización** de disponibilidad, tarifas y reservas. La primera sincronización completa puede tardar hasta dos horas.
6. **Haz una reserva de prueba** desde la agencia y comprueba que entra en Recepción › Reservas y descuenta inventario.

## Buenas prácticas

- Alinea los tipos de habitación en las dos plataformas antes de activar: las diferencias generan sobreventas.
- Mantén actualizada la comisión del canal en Finanzas › Comisiones para que los informes muestren el ingreso neto real.`
  },
  {
    id: "activar-verifactu",
    title: "Cómo activar VeriFactu",
    category: GETTING_STARTED_CATEGORY,
    tags: ["verifactu", "cumplimiento", "facturación", "aeat", "fiscal", "certificado"],
    bodyMd: `# Cómo activar VeriFactu

VeriFactu es el sistema de facturación verificable de la AEAT. Activarlo en Anfitorio implica configurar los datos fiscales, el certificado digital y las series de facturación.

## Paso a paso

1. **Abre Cumplimiento › VeriFactu.** Verás el estado actual y los cuatro bloques: datos fiscales, certificado, series y entorno.
2. **Comprueba los datos fiscales del hotel** en Configuración › Contabilidad y fiscal: razón social, NIF, domicilio fiscal. Viajan en cada factura, así que un error invalida los envíos.
3. **Sube el certificado digital** de representante (.p12 o .pfx) con su clave. Se guarda cifrado y solo se usa para firmar los registros.
4. **Configura las series**: general, rectificativa y simplificada si emites tiques. El contador inicial debe seguir al último número de tu sistema anterior.
5. **Empieza en el entorno de pruebas** de la AEAT y valida el flujo con facturas de prueba durante dos o tres días.
6. **Pasa a producción.** Desde ese momento cada factura se firma, se encadena y se envía en tiempo real; su estado se ve en Cumplimiento › Envíos a autoridades.

## Buenas prácticas

- Renueva el certificado al menos 30 días antes de su caducidad; caducado, bloquea toda la facturación.
- Revisa Cumplimiento › Bandeja de cumplimiento a diario las primeras semanas: los rechazos suelen deberse a datos fiscales del cliente mal capturados en el check-in.`
  }
];

export default GETTING_STARTED_ARTICLES;
