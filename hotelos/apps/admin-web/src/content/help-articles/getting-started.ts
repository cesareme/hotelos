// getting-started — first-week articles for the help center («?»).
//
// Every path names a category and an item of the Tanda 5 navigation tree
// (Hoy · Recepción · Operaciones · Comercial · Revenue · Finanzas ·
// Cumplimiento · Informes · Configuración). Only real shortcuts are mentioned
// (see ./keyboard-shortcuts.ts).
//
// Tanda DOC-2: «Cómo hacer mi primer check-in» y «Cómo crear una reserva nueva»
// describen el cajón «Check-in» de Mi día (secciones 1 · Huésped · 2 · Habitación ·
// 3 · Pago · 4 · Cumplimiento) y la Nueva reserva rápida tal y como están en la
// aplicación (vocabulario D5: «En el hotel», «Salida hecha»…); el resto de artículos
// usa los literales reales de sus pantallas («Dar de alta», «Dividir folio», series
// en Configuración › Facturación y pagos). Sin promesas de flujos que no existen.
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { BRAND } from "../../config/brand";

export const GETTING_STARTED_CATEGORY = "Primeros pasos";

export const GETTING_STARTED_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "primer-check-in",
    title: "Cómo hacer mi primer check-in",
    category: GETTING_STARTED_CATEGORY,
    tags: ["check-in", "recepción", "llegadas", "reservas", "huéspedes", "documento", "cobro"],
    bodyMd: `# Cómo hacer mi primer check-in

El check-in es el primer contacto con el huésped. En ${BRAND.name} se hace desde la fila de la llegada en Hoy › Mi día: un cajón «Check-in» con cuatro secciones (huésped, habitación, pago y cumplimiento) y un único botón que dice lo que va a hacer.

## Paso a paso

1. **Abre Hoy › Mi día** (⌥H). La tabla «Llegadas de hoy» muestra cada llegada con su habitación y el estado de limpieza (Limpia, Sucia, Inspeccionada), su estado (Confirmada o En el hotel) y su saldo («0,00 € saldado» o «128,00 € pendiente»).
2. **Localiza la reserva.** Escribe el nombre o la habitación en «Buscar por nombre o habitación» (⌥F) o búscala con ⌘K por nombre, código o habitación.
3. **Pulsa la acción de la fila.** «Hacer check-in» si ya tiene habitación; «Check-in en 101» si la llegada está «sin asignar»: la aplicación preselecciona la primera habitación limpia y libre del tipo. Se abre el cajón «Check-in» con el nombre y el código de la reserva.
4. **1 · Huésped.** Comprueba el nombre y el documento de la reserva contra el documento físico.
5. **2 · Habitación.** Verás la habitación con su estado. Para cambiarla, elige otra en «Cambiar habitación» (solo salen las limpias y libres). Si la habitación está «Sucia», el cajón sugiere otra del mismo tipo con «Cambiar a la 101»; si aun así quieres alojar al huésped, activa «Hacer check-in igualmente» y escribe el motivo, que queda auditado.
6. **3 · Pago.** Con saldo pendiente el «Modo de cobro» viene en «Cobrar saldo» y el botón dice «Cobrar 128,00 € y hacer check-in»; elige el «Método» (Tarjeta (datáfono), Efectivo o Transferencia). «Cobrar depósito» solo se activa si la tarifa tiene política de depósito; «Sin cobro» deja el saldo pendiente en el folio. Con la reserva saldada el modo es «Sin cobro» y el botón dice «Hacer check-in».
7. **4 · Cumplimiento.** No hay nada que rellenar: al confirmar se crea un parte de viajeros por cada huésped vinculado a la reserva y se encola su envío a SES.Hospedajes. Los datos de los acompañantes se completan después en Cumplimiento › Registro de viajeros.
8. **Confirma** con el botón o con Intro. La fila pasa a «En el hotel» con su habitación y el aviso te dice qué ha pasado (cobro, habitación y parte).

## Buenas prácticas

- Verifica el documento físico contra el nombre de la reserva antes de confirmar.
- Si el huésped ya ha estado antes, la sección 1 lo marca como «Recurrente»; su ficha está en Recepción › Huéspedes.
- Con una fila abierta al lado (Intro o clic en la fila), mantén ⌥ para ver la letra de cada acción: C hace el check-in y O abre la ficha completa.

Más detalle: manual de uso, 70 · Recepción, capítulo «Llegadas y check-in» (docs/manual/70-recepcion.md).`
  },
  {
    id: "crear-reserva-nueva",
    title: "Cómo crear una reserva nueva",
    category: GETTING_STARTED_CATEGORY,
    tags: ["reservas", "nueva reserva", "sin reserva", "recepción", "tarifas", "walk-in"],
    bodyMd: `# Cómo crear una reserva nueva

Una llamada, un correo o un cliente en el mostrador: la reserva se crea en Recepción › Nueva reserva (⌥N). El modo «Rápida» viene seleccionado por defecto y cabe en una pantalla; el modo «Completa» conserva los seis pasos para grupos, acompañantes, identidad, pagos y solicitudes.

## Paso a paso (modo Rápida)

1. **Abre Recepción › Nueva reserva** (⌥N, o el botón «Nueva reserva» de la barra superior y de Mi día). También puedes dictarla en la pestaña «Dictar (IA)» y revisar el borrador antes de crearla.
2. **Estancia.** Escribe la llegada y la salida (admiten «+7», «hoy» o «mañana»; «+1 noche» y «−1 noche» ajustan la salida), los adultos y el tipo de habitación: cada tipo muestra su precio por noche y las habitaciones libres según la tarifa publicada.
3. **Huésped.** Nombre y apellido son lo único obligatorio; teléfono y correo son opcionales. Si el huésped ya tiene ficha, la pantalla lo sugiere y «Usar sus datos» rellena contacto y documento.
4. **Origen y tarifa.** Elige el origen (Directo, Teléfono, Correo electrónico, Walk-in, Booking.com, Expedia…) y el plan de tarifas. El total sale de la tarifa publicada; escribe un «Precio total» solo si es un importe manual.
5. **Empresa** (opcional). Con razón social y NIF, la factura irá a la empresa y el NIF queda recordado para emitirla desde la ficha.
6. **Crea la reserva.** «Crear reserva» (o Intro en cualquier campo) la crea y abre su ficha; «Crear y cobrar depósito» abre el cobro; «Crear y hacer check-in» solo se activa con llegada hoy y aloja al huésped en la primera habitación limpia y libre del tipo. Los tres botones están desactivados hasta que hay nombre y apellido.

## Modo Completa

La pestaña «Completa» tiene los seis pasos (1. Estancia · 2. Huéspedes · 3. Tarifa · 4. Origen · 5. Pagos · 6. Solicitudes) con «Consultar disponibilidad» y, en el último paso, «Confirmar y crear reserva». Lo tecleado se conserva al cambiar de modo.

## Buenas prácticas

- Marca el origen real de la reserva para que Informes › Rendimiento de canales lo refleje.
- Una llegada sin reserva que ya está en el mostrador se hace más rápido con «Walk-in» (⌥W) desde Mi día: crea la reserva y hace el check-in en el mismo paso.
- La reserva creada aparece al instante en Recepción › Reservas › Lista y en Hoy › Live Timeline.

Más detalle: manual de uso, 70 · Recepción, capítulo «Nueva reserva» y capítulo «Walk-in» (docs/manual/70-recepcion.md).`
  },
  {
    id: "gestionar-grupo-grande",
    title: "Cómo gestionar un grupo",
    category: GETTING_STARTED_CATEGORY,
    tags: ["grupos", "eventos", "cupos", "bodas", "lista de habitaciones", "folio maestro"],
    bodyMd: `# Cómo gestionar un grupo

A partir de ocho habitaciones (o cualquier evento con bloqueo) el flujo cambia: bloqueo de habitaciones, cupo, lista de huéspedes y facturación centralizada. Todo vive en Recepción › Grupos y eventos.

## Paso a paso

1. **Crea el grupo** con «Nuevo grupo»: nombre, contacto del organizador, llegada y salida, modelo de tarifa y fecha límite de liberación.
2. **Define el bloqueo** con la acción «Bloquear habitaciones» de la lista: reparte las habitaciones por tipo y noche y pulsa «Guardar bloqueo». El cupo descuenta inventario automáticamente (pestaña Cupos).
3. **Fija la fecha límite**: a partir de ese día las habitaciones no nominadas vuelven a la venta general; la liberación corre automáticamente cada día.
4. **Importa la lista de huéspedes** del organizador con «Importar rooming list» (un fichero CSV) o añádelos uno a uno; cada línea crea una reserva ligada al grupo.
5. **Decide cómo se factura**: todo al folio maestro, alojamiento al maestro y extras a cada huésped, o cada huésped paga lo suyo.
6. **Sigue el evento** en la pestaña Calendario y revisa el folio maestro cada día durante la estancia.

## Buenas prácticas

- Antes de aceptar el grupo, calcula el desplazamiento en Revenue › Reunión de revenue: ingreso del grupo frente a la venta individual que desplaza.
- Avisa a Pisos y a Restauración desde la primera semana para preparar habitaciones y servicios.

Más detalle: manual de uso, 50 · Comercial y revenue, capítulo «Parte 2 · Comercial» (docs/manual/50-comercial-revenue.md).`
  },
  {
    id: "dividir-folio",
    title: "Cómo dividir un folio",
    category: GETTING_STARTED_CATEGORY,
    tags: ["folio", "facturación", "cobros", "check-out", "dividir"],
    bodyMd: `# Cómo dividir un folio

Dos huéspedes que pagan por separado, una empresa que cubre el alojamiento y el huésped los extras, o un grupo que separa banquete y habitaciones: el folio se divide desde Finanzas › Facturación y cobros.

## Paso a paso

1. **Abre el folio** desde el detalle de la reserva o desde Finanzas › Facturación y cobros: busca la reserva y pulsa «Abrir folio».
2. **Pulsa «Dividir folio».** Se crea un folio secundario en la misma reserva: dale una etiqueta («Empresa», «Agencia» o el nombre del acompañante).
3. **Reparte los cargos**: mueve al folio nuevo los que correspondan con «Mover cargo a otro folio» o define una regla en la pestaña «Enrutamiento de folios» para que los cargos futuros vayan solos al folio correcto.
4. **Revisa los dos folios** con sus totales e impuestos; los datos fiscales del segundo pagador (NIF o CIF, razón social) van en su factura.
5. **Cierra cada folio por separado** en el check-out: dos cobros y dos facturas.

## Buenas prácticas

- Pide los datos fiscales en el check-in si sabes que habrá división: evita prisas en la salida.
- Comprueba que cada folio lleva el tipo impositivo correcto (residente, empresa).
- Anota el motivo de la división en las notas internas para auditoría.

Más detalle: manual de uso, 20 · Administración y contabilidad, capítulo «5. Facturación y VeriFactu» (docs/manual/20-administracion.md).`
  },
  {
    id: "conectar-canal-venta",
    title: "Cómo conectar un canal de venta (Booking.com, Expedia…)",
    category: GETTING_STARTED_CATEGORY,
    tags: ["canales", "booking", "expedia", "agencias en línea", "correspondencias", "sincronización"],
    bodyMd: `# Cómo conectar un canal de venta

Conectar una agencia en línea sincroniza disponibilidad, tarifas, restricciones y reservas en ambos sentidos. Se hace desde Comercial › Canales de venta.

## Paso a paso

1. **Abre Comercial › Canales de venta** y da de alta el canal en «Dar de alta un canal»: empieza en modo simulado o de pruebas; el modo real exige las credenciales del proveedor y el identificador del hotel en la agencia.
2. **Acepta la conexión desde la extranet de la agencia** (apartado de conectividad): este paso lo haces tú en su web. «Probar conexión» comprueba que responde.
3. **Relaciona las habitaciones** en la pestaña Correspondencias: cada tipo de la agencia debe corresponder a un tipo de ${BRAND.name}.
4. **Relaciona los planes de tarifa** (pública, no reembolsable, con desayuno) y confirma las reglas de derivación.
5. **Publica tarifas y disponibilidad** desde el editor de tarifas («Editar tarifas en grid»): cada publicación se encola como entregas por canal y el registro de entregas muestra si se han aceptado o rechazado.
6. **Haz una reserva de prueba** desde la agencia y comprueba que entra en Recepción › Reservas y descuenta inventario.

## Buenas prácticas

- Alinea los tipos de habitación en las dos plataformas antes de activar: las diferencias generan sobreventas.
- Mantén actualizada la comisión del canal en Finanzas › Comisiones para que los informes muestren el ingreso neto real.

Más detalle: manual de uso, 50 · Comercial y revenue, capítulo «Parte 2 · Comercial» (docs/manual/50-comercial-revenue.md).`
  },
  {
    id: "activar-verifactu",
    title: "Cómo activar VeriFactu",
    category: GETTING_STARTED_CATEGORY,
    tags: ["verifactu", "cumplimiento", "facturación", "aeat", "fiscal", "certificado"],
    bodyMd: `# Cómo activar VeriFactu

VeriFactu es el sistema de facturación verificable de la AEAT. Activarlo en ${BRAND.name} implica configurar los datos fiscales, el certificado digital y las series de facturación.

## Paso a paso

1. **Abre Cumplimiento › VeriFactu.** Verás el estado del conector, el entorno (pruebas o producción) y el estado de los certificados por autoridad.
2. **Comprueba los datos fiscales de la sociedad** en Configuración › Estructura societaria (razón social, NIF y domicilio fiscal) y la región fiscal y el conector en Configuración › Contabilidad y fiscal › Fiscal. Viajan en cada factura, así que un error invalida los envíos.
3. **Configura el certificado digital** de representante: el estado («configurado» o «sin configurar») se ve en Configuración › Facturación y pagos y en la tarjeta «VeriFactu (AEAT)» de la pestaña Fiscal. Se usa solo para firmar los registros.
4. **Configura las series** en Configuración › Facturación y pagos («Nueva serie de facturación»): general, rectificativa y simplificada si emites tiques. El contador inicial debe seguir al último número de tu sistema anterior.
5. **Empieza en el entorno de pruebas** de la AEAT y valida el flujo con facturas de prueba durante dos o tres días.
6. **Pasa a producción.** Desde ese momento cada factura se firma, se encadena y se envía en tiempo real; su estado se ve en Cumplimiento › Envíos a autoridades.

## Buenas prácticas

- Renueva el certificado al menos 30 días antes de su caducidad; caducado, bloquea toda la facturación.
- Revisa Cumplimiento › Bandeja de cumplimiento a diario las primeras semanas: los rechazos suelen deberse a datos fiscales del cliente mal capturados en el check-in.

Más detalle: manual de uso, 20 · Administración y contabilidad, capítulo «5. Facturación y VeriFactu» (docs/manual/20-administracion.md).`
  }
];

export default GETTING_STARTED_ARTICLES;
