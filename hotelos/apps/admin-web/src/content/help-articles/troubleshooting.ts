import type { CocoaHelpArticle } from '../../components/cocoa-guidance/CocoaSearchableHelpModal';

export const TROUBLESHOOTING_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: 'troubleshooting-error-guardar-reserva',
    title: 'Error al guardar reserva',
    category: 'Troubleshooting',
    tags: ['reservas', 'error', 'guardado', 'validacion'],
    bodyMd: `# Error al guardar reserva

## Sintomas
- Al pulsar "Guardar" en el formulario de reserva aparece un toast rojo con el mensaje "No se pudo guardar la reserva".
- El boton de guardar queda en estado loading indefinido y nunca cierra el modal.
- En consola del navegador aparece un 422 (Unprocessable Entity) o 500 (Internal Server Error) en la peticion POST /api/reservations.
- La reserva no aparece en el listado tras refrescar.

## Causa probable
1. **Validacion de campos**: faltan datos obligatorios (huesped, fechas, habitacion, tarifa) o estan en formato invalido.
2. **Conflicto de disponibilidad**: la habitacion seleccionada ya fue vendida por otro canal (race condition con OTA) entre la apertura del modal y el submit.
3. **Tarifa cerrada**: el rate code aplicado tiene stop-sell o min-stay activo para esas fechas.
4. **Sesion caducada**: el token de autenticacion expiro mientras el usuario completaba el formulario.
5. **Error de red**: el backend no respondio dentro del timeout (15s) o hay un fallo de conectividad.

## Solucion paso a paso
1. Abre la consola del navegador (Cmd+Opt+I) y revisa la pestana Network para ver el codigo de error exacto de la peticion fallida.
2. Si es **422**: lee el cuerpo de la respuesta para identificar el campo invalido. Corrige el dato (ej. fecha de check-out anterior a check-in) y reintenta.
3. Si es **409 (Conflict)**: la habitacion ya no esta disponible. Cierra el modal, refresca el rack (Cmd+R) y selecciona otra habitacion del mismo tipo.
4. Si es **401 (Unauthorized)**: tu sesion caduco. Cierra sesion, vuelve a entrar y reabre la reserva desde el inicio.
5. Si es **500**: copia el request-id que aparece en la respuesta y reporta al equipo de plataforma via canal #soporte-hotelos.
6. Como workaround inmediato, intenta crear la reserva desde el rack haciendo Shift+click en la celda de la habitacion para el rango de fechas deseado.
7. Si el problema persiste mas de 5 minutos, escala al on-call de guardia (PagerDuty: rotation reservations-prod).
`,
  },
  {
    id: 'troubleshooting-folio-no-actualiza',
    title: 'Folio no se actualiza',
    category: 'Troubleshooting',
    tags: ['folio', 'cargos', 'cache', 'sync'],
    bodyMd: `# Folio no se actualiza

## Sintomas
- Despues de agregar un cargo (minibar, lavanderia, room service) el folio sigue mostrando el total anterior.
- La columna "Balance" del huesped no refleja los pagos aplicados aunque el comprobante se imprimio.
- Al hacer check-out aparece el monto antiguo en lugar del actualizado.
- El badge de "cargos pendientes" no decrementa tras conciliar.

## Causa probable
1. **Cache del cliente**: el frontend mantiene una version stale del folio en memoria y no refetched tras el cambio.
2. **Realtime desconectado**: el canal WebSocket /folios/:id se cayo y los eventos folio.updated no llegan.
3. **Transaccion abierta**: el cargo se registro en una transaccion que aun no commitio en la base de datos.
4. **Race con night audit**: si el rollover de fecha de negocio esta corriendo, los folios se bloquean temporalmente.
5. **Permisos**: el usuario no tiene el rol necesario para ver cargos de cierta categoria (ej. extras corporativos).

## Solucion paso a paso
1. Refresca la vista del folio con Cmd+R o el boton circular en la esquina superior derecha del panel.
2. Verifica el indicador de conexion realtime en la status bar inferior: debe estar verde. Si esta amarillo o rojo, recarga la pagina (F5).
3. Abre DevTools > Application > Local Storage y elimina la clave "folio-cache-{folioId}" si existe.
4. Confirma que el cargo aparece en el endpoint directo: GET /api/folios/:id/charges. Si no esta ahi, el problema esta en backend (no en cache).
5. Si estas en ventana de night audit (02:00-04:00 hora local), espera a que termine: los folios se desbloquean automaticamente al concluir.
6. Verifica con tu manager que tu rol incluye el scope "folios:read:all" para ver todas las categorias de cargo.
7. Si nada de lo anterior funciona, cierra el folio sin hacer check-out y reabrelo desde el listado de huespedes in-house.
8. Reporta el folioId al soporte si despues de estos pasos el balance sigue incorrecto.
`,
  },
  {
    id: 'troubleshooting-canal-ota-desconectado',
    title: 'Canal OTA desconectado',
    category: 'Troubleshooting',
    tags: ['ota', 'channel-manager', 'booking', 'expedia', 'sync'],
    bodyMd: `# Canal OTA desconectado

## Sintomas
- En la pantalla de Channels el canal (Booking.com, Expedia, Airbnb, etc.) aparece con badge rojo y estado "Disconnected".
- Las reservas nuevas del canal dejan de llegar al PMS.
- Los cambios de tarifa o disponibilidad no se reflejan en el extranet del OTA.
- El log de sincronizacion muestra errores 401 (credenciales), 403 (permisos) o 503 (servicio caido).

## Causa probable
1. **Credenciales caducadas**: el token OAuth o las credenciales API expiraron y requieren renovacion.
2. **Cambio de password en el OTA**: el partner cambio su clave en el extranet sin actualizar HotelOS.
3. **Rate limit excedido**: se hicieron demasiadas llamadas en poco tiempo y el OTA bloqueo temporalmente la cuenta.
4. **Mantenimiento del OTA**: el partner esta en ventana de mantenimiento programado.
5. **IP no whitelisted**: el OTA exige whitelisting y la IP de salida del channel manager cambio.
6. **Hotel deshabilitado**: en el extranet del OTA el hotel quedo en estado "inactivo" o "pendiente de revision".

## Solucion paso a paso
1. Ve a Channels > [Nombre del canal] > Diagnostico y pulsa "Test connection". El resultado indicara el tipo exacto de fallo.
2. Si es **401**: pulsa "Reconectar" y completa el flujo OAuth con las credenciales actualizadas del partner. Para canales con API key estatica, edita la credencial en Settings > Integrations.
3. Si es **403**: revisa en el extranet del OTA que el rol del usuario API tenga permisos de "channel manager" y todos los scopes requeridos.
4. Si es **429 (rate limit)**: espera 30 minutos. El backoff exponencial reanudara la sincronizacion automaticamente.
5. Si es **503**: revisa la pagina de status del OTA (status.booking.com, status.expedia.com, etc.). Si confirma incidente, espera resolucion.
6. Si tras reconectar el canal vuelve a desconectarse en menos de 1 hora, ejecuta "Resync full" desde el menu de tres puntos: forzara una sincronizacion completa de inventario y tarifas.
7. Mientras el canal este caido, **bloquea manualmente disponibilidad en el extranet del OTA** para evitar overbookings.
8. Documenta el incidente en el log de canales (boton "Add note") indicando hora de deteccion y resolucion.
`,
  },
  {
    id: 'troubleshooting-verifactu-rechazado',
    title: 'VeriFactu rechazado motivo X',
    category: 'Troubleshooting',
    tags: ['verifactu', 'compliance', 'aeat', 'facturacion', 'espana'],
    bodyMd: `# VeriFactu rechazado motivo X

## Sintomas
- Tras emitir una factura, la AEAT devuelve estado "Rechazado" con un codigo de motivo (ej. 1101, 3001, 4102).
- El badge de la factura en el listado pasa a rojo con icono de alerta.
- El folio del huesped queda con estado "Pendiente de regularizacion fiscal".
- El reporte de Compliance muestra el contador de rechazos incrementado.

## Causa probable
Los codigos mas comunes y sus causas:
1. **Motivo 1101 - NIF invalido**: el documento del huesped no pasa el algoritmo de validacion de la AEAT.
2. **Motivo 1102 - NIF no existe**: el NIF tiene formato valido pero no esta registrado en censo de la AEAT.
3. **Motivo 3001 - Importe incoherente**: la suma de bases imponibles + cuotas IVA no cuadra con el total declarado.
4. **Motivo 3002 - Tipo de IVA invalido**: se aplico un tipo (4%, 10%, 21%) que no corresponde al servicio facturado.
5. **Motivo 4101 - Numero de serie duplicado**: el correlativo ya fue usado en una factura previa.
6. **Motivo 4102 - Fecha fuera de rango**: la fecha de operacion es anterior al alta del establecimiento en VeriFactu.
7. **Motivo 5001 - Firma electronica invalida**: el certificado digital del hotel caduco o esta revocado.

## Solucion paso a paso
1. Abre la factura rechazada y revisa el panel "Detalle VeriFactu" para ver el codigo de motivo exacto y el mensaje de la AEAT.
2. **Si es 1101 o 1102**: contacta al huesped, solicita NIF correcto o pasaporte, edita el huesped en su ficha y reenvia la factura desde "Acciones > Reintentar envio".
3. **Si es 3001**: verifica las lineas de la factura. Probablemente hay un cargo con redondeo erroneo. Anula la factura (genera rectificativa) y emite nueva.
4. **Si es 3002**: revisa el catalogo de servicios > tipo de IVA asignado. Para alojamiento es 10%, para spa/restaurante 10%, para parking 21%. Corrige y reintenta.
5. **Si es 4101**: el sistema asigno un correlativo ya usado. Ve a Settings > Facturacion > Series y pulsa "Reparar correlativos" para resincronizar.
6. **Si es 4102**: revisa que la fecha de la factura no sea anterior a la fecha de alta del hotel en VeriFactu (campo en Settings > Compliance > VeriFactu).
7. **Si es 5001**: renueva el certificado digital. Settings > Compliance > Certificados > "Subir nuevo certificado". Tras la renovacion, reintenta todas las facturas pendientes con el boton bulk "Reintentar rechazadas".
8. Si el motivo no esta en esta lista, copia el codigo completo y consulta el catalogo oficial de la AEAT (https://sede.agenciatributaria.gob.es) o escala a Compliance.
9. Toda factura rechazada debe regularizarse en plazo maximo de 4 dias naturales para evitar sanciones.
`,
  },
  {
    id: 'troubleshooting-habitacion-bloqueada-mantenimiento',
    title: 'Habitacion bloqueada por mantenimiento',
    category: 'Troubleshooting',
    tags: ['mantenimiento', 'habitaciones', 'ooo', 'rack', 'disponibilidad'],
    bodyMd: `# Habitacion bloqueada por mantenimiento

## Sintomas
- Una habitacion aparece con icono de llave inglesa o badge gris en el rack y no puede asignarse a check-ins.
- Al intentar mover una reserva a esa habitacion, el sistema muestra "Habitacion fuera de servicio".
- En el inventario disponible la habitacion no cuenta para tipos ni totales.
- El reporte de ocupacion la excluye automaticamente.
- Aunque el equipo de mantenimiento dice haberla liberado, sigue bloqueada en el sistema.

## Causa probable
1. **Ticket de mantenimiento abierto**: existe un work-order activo sobre esa habitacion que no fue cerrado al terminar.
2. **Bloqueo manual sin fecha de fin**: alguien marco la habitacion como OOO (Out Of Order) sin definir cuando se libera.
3. **OOS vs OOO confundidos**: la habitacion esta en Out Of Service (jugado de inventario, ej. construccion) en lugar de Out Of Order (temporal).
4. **Inspeccion housekeeping pendiente**: aunque el ticket esta cerrado, housekeeping debe inspeccionar y aprobar la entrega.
5. **Auto-bloqueo por SLA**: el sistema bloqueo automaticamente la habitacion porque excedio el SLA de limpieza sin marcarse como ready.

## Solucion paso a paso
1. Abre la habitacion desde el rack y revisa el panel "Estado actual". Identifica si esta en OOO o OOS y cual es la razon registrada.
2. Si dice **"Work-order #XXX abierto"**: ve a Maintenance > Work Orders > #XXX y verifica el estado. Si el trabajo esta completado, marca el ticket como "Resolved" y luego "Closed".
3. Al cerrar el ticket, el sistema solicita confirmacion: "Liberar habitacion?". Pulsa Si y la habitacion volvera a Available o a Dirty (si requiere limpieza).
4. Si dice **"Bloqueo manual sin fecha"**: edita el bloqueo en Inventory > Room Status > [habitacion] y agrega fecha de fin igual o anterior a hoy.
5. Si es **OOS de larga duracion** (renovacion, daño estructural): NO la liberes desde el front, requiere aprobacion del manager y actualizacion del inventario fiscal.
6. Si esta esperando **inspeccion housekeeping**: ve a Housekeeping > Rooms y desde la lista pulsa "Inspect" sobre esa habitacion (requiere rol supervisor).
7. Si fue **auto-bloqueada por SLA vencido**: revisa el log de eventos. Si el motivo ya no aplica, puedes hacer override desde el panel "Forzar disponibilidad" (requiere autorizacion de manager).
8. Para evitar futuras incidencias: configura recordatorios en Maintenance > SLA Policies para que los tickets nunca queden abiertos mas de 24h sin actualizacion.
9. Si la habitacion sigue bloqueada tras estos pasos, escala al manager de operaciones: puede haber un bloqueo a nivel de tipo de habitacion completo.
`,
  },
  {
    id: 'troubleshooting-reservas-duplicadas',
    title: 'Reservas duplicadas',
    category: 'Troubleshooting',
    tags: ['reservas', 'duplicados', 'ota', 'overbooking', 'merge'],
    bodyMd: `# Reservas duplicadas

## Sintomas
- El mismo huesped aparece con dos o mas reservas para las mismas fechas y misma habitacion (o tipo de habitacion).
- En la cola de llegadas se ven entradas duplicadas con codigos de confirmacion distintos.
- El reporte de ocupacion muestra mas reservas que habitaciones realmente vendidas.
- El huesped reclama haber recibido dos emails de confirmacion.
- En el folio aparecen cargos duplicados de city tax o resort fee.

## Causa probable
1. **Doble submit en el formulario**: el usuario hizo doble clic en "Guardar" y el sistema creo dos reservas antes de que el debounce actuara.
2. **OTA enviando duplicado**: el channel manager recibio dos veces el mismo mensaje (timeout en el ack y el OTA reintento).
3. **Huesped reservo en dos canales**: el mismo huesped reservo en Booking.com y directo en la web, sin que el sistema lo detectara como duplicado.
4. **Re-importacion masiva**: tras un fallo de sincronizacion alguien re-importo un batch de reservas que ya existian.
5. **Falta de deduplicacion por email + fechas**: la politica de deduplicacion esta deshabilitada o configurada con criterios demasiado estrictos.

## Solucion paso a paso
1. Ve a Reservations y aplica el filtro "Posibles duplicados" en el panel lateral. Lista las reservas con misma fecha + huesped + tipo de habitacion.
2. Selecciona el par sospechoso y abre la vista comparativa con el boton "Comparar lado a lado".
3. Identifica cual es la reserva valida segun estos criterios prioritarios: (a) la que tiene depesito/prepago aplicado, (b) la mas antigua (created_at menor), (c) la que vino del canal directo si compite con OTA.
4. Para fusionar usa la accion **"Merge reservations"**: el sistema mueve el folio, cargos y comentarios a la reserva ganadora y cancela la perdedora con motivo "Duplicada".
5. Si la duplicada tiene pago capturado, **NO la canceles** sin antes generar refund o transferir el pago a la reserva ganadora. El asistente de merge te guiara.
6. Notifica al huesped por email (template "Confirmacion unificada") explicando que se mantuvo una sola reserva con codigo X.
7. Si el duplicado vino de un OTA, registra el incidente en el panel del canal (Channels > [canal] > Issues) para que el partner revise por que reenvio el mensaje.
8. Como prevencion: activa la regla de deduplicacion en Settings > Reservations > Dedup Rules con criterio "email + check-in date + room type" en modo "Auto-merge si match exacto, alertar si match parcial".
9. Si el duplicado causo overbooking real (mas reservas que habitaciones), aplica protocolo de walk: ofrece upgrade gratuito o reubicacion en hotel partner segun SOP de la propiedad.
10. Revisa semanalmente el reporte "Duplicate detection log" en Reports > Operations para detectar patrones (canal, tipo de habitacion, dia de semana) y ajustar reglas.
`,
  },
];
