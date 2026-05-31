export interface HelpArticle {
  readonly id: string;
  readonly title: string;
  readonly category: 'getting-started';
  readonly tags: readonly string[];
  readonly bodyMd: string;
  readonly updatedAt: string;
}

export const GETTING_STARTED_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'primer-check-in',
    title: 'Como hacer mi primer check-in',
    category: 'getting-started',
    tags: ['check-in', 'front-desk', 'recepcion', 'reservas', 'huespedes'],
    bodyMd: `# Como hacer mi primer check-in

El check-in es el primer punto de contacto operativo con el huesped. En HotelOS esta optimizado para completarse en menos de 90 segundos por reserva estandar, manteniendo el cumplimiento del parte de viajeros y la captura del medio de pago.

## Paso a paso

1. **Abre el Front Desk Cockpit** desde el menu lateral o con el atajo Cmd+1. Veras el listado de llegadas previstas para hoy ordenadas por hora prevista de arrival, con indicador visual del estado de la habitacion (limpia, sucia, inspeccion).
2. **Localiza la reserva** del huesped que llega. Puedes buscar por nombre, apellido, codigo de confirmacion o numero de documento usando la barra superior (Cmd+F).
3. **Pulsa "Check-in"** sobre la fila de la reserva. Se abrira el panel lateral con tres pestanas: huesped, habitacion y medio de pago.
4. **Completa los datos del huesped principal** y de los acompanantes mayores de 14 anos: tipo de documento, numero, nacionalidad y fecha de nacimiento. Estos campos alimentan el parte de viajeros que se envia a SES Hospedajes.
5. **Confirma o reasigna la habitacion**. Si la unidad asignada no esta lista, el sistema te sugiere alternativas del mismo tipo de cama y categoria.
6. **Captura el medio de pago** (preautorizacion en tarjeta o efectivo) y entrega la llave o emite la digital.

## Buenas practicas

- Si llega antes de la hora oficial, ofrece early check-in solo si la habitacion esta inspeccionada.
- Verifica siempre el documento fisico contra el nombre de la reserva para evitar fraudes de identidad.
- Si el huesped es VIP o repeater, revisa la ficha de preferencias antes de entregar la llave para personalizar el saludo.
- Al cerrar el panel, confirma que el estado de la reserva ha pasado a "In-house" y la habitacion a "Ocupada".`,
    updatedAt: '2026-05-30',
  },
  {
    id: 'crear-reserva-nueva',
    title: 'Como crear una reserva nueva',
    category: 'getting-started',
    tags: ['reservas', 'booking', 'walk-in', 'front-desk', 'tarifas'],
    bodyMd: `# Como crear una reserva nueva

Crear una reserva manualmente es una tarea cotidiana cuando recibes una llamada directa, un email del huesped o un walk-in sin reserva previa. HotelOS te permite hacerlo desde cualquier pantalla con un atajo unico.

## Paso a paso

1. **Pulsa Cmd+N** desde cualquier pantalla o el boton "+ Nueva reserva" en el Front Desk Cockpit y en la pantalla de Reservas. Se abrira el wizard de creacion en panel lateral.
2. **Selecciona las fechas** de check-in y check-out usando el datepicker. El sistema mostrara automaticamente la disponibilidad por tipo de habitacion y la mejor tarifa disponible (BAR) en cada categoria.
3. **Escoge el tipo de habitacion** y el plan de tarifa (BAR, no reembolsable, paquete, corporativa). Veras el desglose noche a noche con impuestos incluidos.
4. **Anade huespedes y ocupacion**: numero de adultos, ninos y edades. Esto activa los suplementos correspondientes.
5. **Captura los datos del titular**: nombre completo, email, telefono y, si lo tienes, documento. El email es obligatorio para el envio de la confirmacion automatica.
6. **Selecciona la garantia**: tarjeta de credito (con preautorizacion opcional segun la politica de la tarifa), prepago bancario o credito a empresa si es corporativa.
7. **Revisa el resumen** con el total, politicas de cancelacion y extras incluidos. Pulsa "Confirmar reserva".

## Buenas practicas

- Si el huesped ya existe en la base, el sistema lo sugiere por email o telefono y rellena los datos. Aprovecha para reactivar la ficha del repeater.
- Aplica codigos promocionales antes de confirmar; despues de creada solo puedes ajustarlo via folio.
- Para walk-ins, marca el origen como "Direct walk-in" para que la analitica de canales lo refleje correctamente.
- Cuando el cliente pide opciones, usa la vista comparativa de tarifas para mostrarle hasta tres planes en paralelo.`,
    updatedAt: '2026-05-30',
  },
  {
    id: 'gestionar-grupo-grande',
    title: 'Como gestionar un grupo grande',
    category: 'getting-started',
    tags: ['grupos', 'reservas', 'allotments', 'bodas', 'eventos', 'rooming-list'],
    bodyMd: `# Como gestionar un grupo grande

Los grupos (a partir de 8 habitaciones o cualquier reserva de evento con bloque de habitaciones) requieren un flujo distinto al de reservas individuales: bloqueo, allotment, rooming list y facturacion centralizada.

## Paso a paso

1. **Crea el grupo** desde la pantalla de Grupos con el boton "+ Nuevo grupo". Introduce el nombre del grupo (boda Garcia-Lopez, congreso XYZ), el contacto principal (agencia o cliente final) y las fechas tope de release.
2. **Define el bloque de habitaciones**: cantidad por tipo, tarifa pactada y politicas de cancelacion negociadas. El sistema crea el allotment y descuenta inventario automaticamente.
3. **Configura la fecha de cut-off**: a partir de ese momento las habitaciones no nominadas vuelven al inventario general. Establece recordatorios automaticos al organizador 14, 7 y 3 dias antes.
4. **Recibe la rooming list** del organizador via importacion CSV/Excel o introduciendo los huespedes uno a uno. Cada linea genera una reserva individual ligada al grupo maestro.
5. **Define la modalidad de facturacion**: master folio (todo a la cuenta principal del grupo), routing parcial (alojamiento al master, extras al huesped) o individual (cada huesped paga lo suyo). Esto evita disputas al check-out.
6. **Activa el booking link privado** si el organizador prefiere que cada invitado reserve directamente con un codigo unico.

## Buenas practicas

- Antes de aceptar el grupo lanza el displacement analysis para comparar el ingreso del grupo con el ADR transient que desplazas.
- Manten un canal directo con HK y F&B desde la primera semana para coordinar set-up de habitaciones, welcome amenities y banquetes.
- Bloquea 24h antes del check-in las habitaciones especificas asignadas para que HK pueda priorizarlas en la operativa del dia.
- Revisa el master folio diariamente durante la estancia para detectar cargos mal routados antes del check-out.`,
    updatedAt: '2026-05-30',
  },
  {
    id: 'dividir-folio',
    title: 'Como dividir un folio',
    category: 'getting-started',
    tags: ['folio', 'facturacion', 'billing', 'check-out', 'split'],
    bodyMd: `# Como dividir un folio

Dividir un folio (split folio) es habitual cuando dos huespedes comparten habitacion y quieren pagar por separado, cuando una empresa cubre el alojamiento y el huesped los extras, o cuando el grupo separa banquete y rooms.

## Paso a paso

1. **Abre el folio del huesped** desde el detalle de la reserva o desde Billing > Folios activos. Veras la lista de cargos cronologica: alojamiento, impuestos, F&B, extras, depositos.
2. **Pulsa "Dividir folio"** en la barra superior. Se abrira el panel de split con tres opciones: por porcentaje, por concepto o seleccion manual de cargos.
3. **Elige el modo de division**:
   - *Por porcentaje*: indica el porcentaje que va al folio A y al folio B (ej. 50/50 entre dos huespedes).
   - *Por concepto*: routa automaticamente alojamiento e impuestos a un folio y F&B + extras a otro (tipico empresa vs huesped).
   - *Seleccion manual*: arrastra cada cargo individual al folio destino. Util para casos atipicos.
4. **Crea el segundo folio**: introduce los datos fiscales del nuevo pagador (empresa o particular), incluyendo NIF/CIF para la factura. Si es una empresa ya guardada, busca por razon social.
5. **Revisa el preview** de ambos folios con totales separados, IVA aplicado y politicas de cancelacion. Confirma con "Aplicar split".
6. **Cierra cada folio independientemente** en el check-out, cobrando por separado y emitiendo dos facturas distintas.

## Buenas practicas

- Avisa al huesped en el check-in si sabes que habra split; pedirle los datos fiscales con calma evita prisas en la salida.
- Verifica que ambos folios tengan asignados los impuestos correctos segun la tipologia de cliente (residente, no residente, empresa).
- Si el segundo pagador es una agencia con credito, comprueba que el limite de credito cubre el importe antes de routar.
- Documenta en notas internas el motivo del split para auditoria y reclamaciones futuras.`,
    updatedAt: '2026-05-30',
  },
  {
    id: 'conectar-booking-com',
    title: 'Como conectar Booking.com',
    category: 'getting-started',
    tags: ['booking', 'channels', 'ota', 'integraciones', 'channel-manager'],
    bodyMd: `# Como conectar Booking.com

Conectar Booking.com con HotelOS sincroniza disponibilidad, tarifas, restricciones y reservas en ambos sentidos. La conexion se hace via Booking Connectivity API y tarda en estar operativa entre 24 y 72 horas tras la solicitud.

## Paso a paso

1. **Ve a Integraciones > Canales > Booking.com** y pulsa "Conectar". Necesitaras a mano el Hotel ID de Booking (lo encuentras en tu extranet, esquina superior derecha).
2. **Introduce el Hotel ID** y el correo de contacto del responsable de canales. HotelOS enviara la solicitud de pairing a Booking Connectivity.
3. **Acepta el pairing desde la extranet de Booking**: ve a Cuenta > Conectividad > Proveedor > acepta a HotelOS como tu channel manager. Este paso lo debes hacer tu desde el extranet.
4. **Mapea las habitaciones**: cada room type de Booking debe corresponder a un tipo de habitacion de HotelOS. El sistema sugiere matches automaticos por nombre que debes validar.
5. **Mapea los planes de tarifa**: relaciona los rate plans de Booking (BAR, no reembolsable, desayuno incluido) con los de HotelOS. Confirma reglas de derivacion si aplicas un porcentaje al BAR.
6. **Activa la sincronizacion** de disponibilidad, tarifas, restricciones (MinLOS, MaxLOS, CTA, CTD) y reservas. La primera sincronizacion completa puede tardar hasta 2 horas.
7. **Verifica con una reserva de prueba** desde la extranet en modo test. Confirma que entra en HotelOS en menos de 60 segundos y se descuenta inventario.

## Buenas practicas

- Antes de activar, audita que tus tipos de habitacion en ambas plataformas estan alineados; mismatches generan overbookings.
- Define una estrategia de derivacion de tarifas centralizada en HotelOS y deja Booking como pure distribution channel.
- Activa las alertas de fallo de sincronizacion en el Channel Performance Dashboard para reaccionar en menos de 10 minutos.
- Manten la commission de Booking actualizada en tu setup para que el revenue dashboard muestre net ADR real.`,
    updatedAt: '2026-05-30',
  },
  {
    id: 'activar-verifactu',
    title: 'Como activar VeriFactu',
    category: 'getting-started',
    tags: ['verifactu', 'compliance', 'facturacion', 'aeat', 'fiscal', 'espana'],
    bodyMd: `# Como activar VeriFactu

VeriFactu es el sistema de facturacion verificable de la AEAT obligatorio en Espana desde 2026 para empresas no acogidas a SII. Activarlo en HotelOS implica configurar el certificado digital, los datos fiscales y las series de facturacion.

## Paso a paso

1. **Ve a Compliance > VeriFactu** desde el menu lateral. Veras el wizard de activacion con cuatro bloques: datos fiscales, certificado, series y entorno.
2. **Verifica los datos fiscales del hotel**: razon social, NIF, domicilio fiscal y epigrafe IAE. Estos datos viajan en cada factura firmada hacia la AEAT, asi que cualquier error invalida los envios.
3. **Sube el certificado digital** de representante de persona juridica en formato .p12 o .pfx con su clave. HotelOS lo almacena cifrado y solo lo usa para firmar los registros de facturacion.
4. **Configura las series de facturacion**: serie general, serie rectificativa y serie simplificada si emites tickets. Define el formato del numero y el contador inicial (debe coincidir con el ultimo numero emitido en tu sistema anterior).
5. **Selecciona el entorno**: empieza siempre en pruebas (preproduccion AEAT) para validar el flujo end-to-end con facturas de prueba durante 48-72 horas antes de pasar a produccion.
6. **Activa la generacion automatica** de hash encadenado y QR en factura. Cada factura emitida desde el folio se firma, se anade al registro de facturacion y se envia a la AEAT en tiempo real.
7. **Confirma el cambio a produccion** una vez validadas las pruebas. A partir de ese momento toda factura nueva es VeriFactu.

## Buenas practicas

- Renueva el certificado digital al menos 30 dias antes de su caducidad; un certificado expirado bloquea toda la facturacion.
- Revisa diariamente el panel de envios fallidos durante las primeras dos semanas; los rechazos suelen ser por datos fiscales del cliente mal capturados.
- Forma a recepcion en capturar correctamente NIF y razon social en el check-in para evitar facturas rechazadas.
- Mantienes los registros de facturacion 4 anos minimo por exigencia AEAT; HotelOS los archiva automaticamente.`,
    updatedAt: '2026-05-30',
  },
] as const;
