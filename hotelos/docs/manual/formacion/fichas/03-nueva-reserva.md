# Ficha · Nueva reserva · ehotelOS

**Perfil:** Recepción · Jefatura de recepción (plantillas «Recepción», «Jefatura de recepción»); «Comercial» también tiene «Nueva reserva» en su menú.

## Antes de empezar

- Fechas de llegada y salida, número de adultos y tipo de habitación.
- Nombre y apellido del huésped: es lo único obligatorio. Teléfono y correo son opcionales; si factura una empresa, su razón social y su NIF.
- Hay tarifa publicada para esas noches; si no, ehotelOS te pedirá el «Precio total (€)».

## Pasos

1. Abre **Menú › Recepción › Nueva reserva** (`/recepcion/reservas/nueva`) con **⌥N**, con el botón verde «+ Nueva reserva» de la barra superior o desde Mi día. Tiene las pestañas «Formulario» y «Dictar (IA)» (un borrador por reglas, sin modelo de lenguaje) y, dentro del formulario, las vistas **«Rápida»** (por defecto) y **«Completa»**.
2. En la vista **«Rápida»**, rellena el formulario «Nueva reserva rápida» de arriba abajo:
   - **«Estancia»:** «Llegada» y «Salida» (admiten «+7», «hoy» o «mañana» escritos en el campo), «Adultos», «Tipo de habitación» («Doble · 89,00 €/noche · 10 libres»…) y los botones «−1 noche» / «+1 noche».
   - **«Huésped»:** «Nombre» y «Apellido»; «Teléfono» y «Correo electrónico» opcionales.
   - **«Origen y tarifa»:** «Origen de la reserva» («Directo (web / correo)», «Teléfono», «Booking.com», «Corporativo»…), «Plan de tarifas» («Sin plan tarifario (tarifa BAR del hotel)» o el plan) y «Precio total (€)» opcional; debajo, el precio en vivo («Cotizado: 89,00 €»).
   - **«Empresa»:** «Razón social» y «NIF» opcionales; al escribir la razón social aparece la insignia **«Factura a empresa»** y el NIF se recuerda para la factura.
3. En la barra **«Crear la reserva»** («Total 89,00 € · 1 noche · tarifa publicada») pulsa **«Crear reserva»** (o Intro en cualquier campo), **«Crear y cobrar depósito»** (crea y abre el cobro) o **«Crear y hacer check-in»** (solo con llegada hoy: aloja en la primera limpia y libre del tipo). Están desactivados hasta que haya nombre y apellido; con ⌥ mantenido: **D** depósito · **I** check-in · **C** crear.
4. Para grupos, acompañantes, identidad (SES), pagos o solicitudes pulsa **«Completa»**: seis pasos («1. Estancia · 2. Huéspedes · 3. Tarifa · 4. Origen · 5. Pagos · 6. Solicitudes») con la barra «Paso 1 de 6 · 0,00 € · 1 noche». El paso «Estancia» añade «Noches», «Habitación asignada» (opcional), «Número de habitaciones», «Niños», «Bebés» y horas previstas; abajo, «Consultar disponibilidad» y «Siguiente»; en el paso 6, «Confirmar y crear reserva». Lo tecleado se conserva al cambiar de vista.
5. **Walk-in** (llega sin reserva y se aloja ya): en Mi día pulsa «Walk-in» o **⌥W**. El cajón «Walk-in» («Hoy → mañana · 1 noche») trae «Estancia» (llegada hoy, salida mañana, «+1 noche», «Adultos»), «Tipo y habitación» («Tipo» con precio y libres; «Habitación», con la primera limpia preseleccionada), «Huésped» («Nombre», «Apellido», «Documento» opcional) y «Cobro» («Cobrar 89,00 €» o «Sin cobro»). Escribe nombre y apellido y pulsa **«Crear y hacer check-in»** o **«Solo crear reserva»**. Fuera de Mi día, ⌥W abre esta pantalla.

![Nueva reserva en vista «Rápida»: estancia, huésped y la barra «Crear la reserva»](../../img/recepcion/nueva-reserva-rapida.png)

## Resultado esperado

- La reserva se crea con el precio de la tarifa y se abre su ficha. Aparece «Confirmada» en Menú › Recepción › Reservas («Llegan hoy» o «Futuras»), en Mi día si llega hoy y en el Live Timeline (en el carril «Sin asignar» si no tiene habitación).
- Con «Crear y hacer check-in» la reserva nace «En el hotel»; con «Crear y cobrar depósito» se abre el cobro.
- Un walk-in se crea con origen «Walk-in», queda alojado en la habitación elegida y el cobro se registra como anticipo: su folio nace sin el cargo de alojamiento, que asienta el cierre del día.

> **Nota:** recorrida el 19/09/2026 en el «Hotel UXDAY (prueba)» (datos ficticios) hasta los botones de crear, sin pulsarlos; el resultado se toma de la [guía de recepción](../../70-recepcion.md), que lo verifica con las pruebas automáticas de la nueva reserva y del walk-in.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Sin disponibilidad para esas fechas y ocupación.» | No quedan habitaciones libres del tipo: cambia las fechas o el tipo. |
| «Sin tarifa publicada para esas noches: indica el importe total.» o «Precio de relleno: alguna noche no tiene tarifa publicada…» | Escribe el «Precio total (€)» acordado, o pide a revenue que publique la tarifa (ficha [11](11-cambiar-tarifa-en-la-parrilla.md)). |
| «La llegada es anterior a hoy.» | Corrige la fecha: registrar una llegada pasada exige el permiso de modificar reservas. |
| ⌥W no abre el cajón «Walk-in» | Estás fuera de Mi día (ahí ⌥W abre Nueva reserva): ve a Menú › Hoy › Mi día y repite. |
| El borrador de «Dictar (IA)» viene incompleto | Funciona por reglas, sin modelo de lenguaje: completa lo que falte en el formulario antes de confirmar. |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — «Nueva reserva» (rápida y completa) y «Walk-in».
- [50 · Comercial y revenue](../../50-comercial-revenue.md) — de dónde sale el precio: planes de tarifas y parrilla.
