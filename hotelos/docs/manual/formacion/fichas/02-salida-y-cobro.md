# Ficha · Salida y cobro (check-out) · ehotelOS

**Perfil:** Recepción · Jefatura de recepción (plantillas «Recepción», «Jefatura de recepción»); el borrador de factura lo emite «Administración de hotel».

## Antes de empezar

- El huésped está «En el hotel» y sale hoy (pestaña «Salen hoy (n)» de Mi día; «Sale hoy» en el Live Timeline). Si ya debería haber salido, la cola de Mi día avisa «Late checkout sin resolver · Hab. 204» con «Hacer check-out».
- Sabes cómo paga: «Tarjeta (datáfono)», «Efectivo» o «Transferencia» (sin datáfono conectado ni pasarela: ehotelOS anota el cobro).
- Si quiere factura a nombre de una empresa, tienes su razón social y su NIF. Por defecto la factura queda como «Borrador para Facturación».

## Pasos

1. Abre **Menú › Hoy › Mi día** (`/hoy`, ⌥H), pestaña **«Salen hoy (4 · 13 hechas)»**. El botón de cada fila dice lo que hará: **«Cobrar 120,00 € y cerrar»** con saldo (Lucía Kappa, habitación 204, en la captura), **«Hacer check-out»** con «0,00 € saldado», «Abrir ficha» si ya pone «Salida hecha». Púlsalo. El mismo cajón se abre con «Check-out» en el panel del Live Timeline y en el panel de detalle de la lista; la ficha de una reserva alojada no tiene check-out.
2. Se abre el cajón **«Check-out»** («Lucía Kappa · Hab. 204», un cronómetro y «Cerrar») con «Hab. 204 · planta 2», la etiqueta «En el hotel» y tres secciones:
   - **«1 · Folio»:** la tabla «Líneas del folio» («Alojamiento DBL · 2 noches 178,00 €», «Minibar 42,00 €») y los «Totales del folio» («Total cargos 220,00 €», «Pagos previos 100,00 €», «Saldo 120,00 €»). Bajo cada concepto va su código interno («room · 2x»): texto de la aplicación.
   - **«2 · Cobro»:** «Saldo abierto», «Importe a cobrar: 120,00 €», el «Método» y el interruptor **«Sin cobro ahora (el huésped saldrá con saldo pendiente)»** (siempre visible; actívalo solo si dirección admite salidas con saldo).
   - **«3 · Salida y factura»:** «La habitación pasará a sucia. Housekeeping recibe la tarea de limpieza de salida.»; el selector «Factura»: **«Borrador para Facturación»** (por defecto: «Queda como borrador con los cargos del folio; Facturación la emite.»), **«Emitir ahora con número»** (irreversible; entra en la cadena VeriFactu del hotel) o **«Sin factura»**; y «Factura a»: **«Huésped»** (factura simplificada a su nombre) o **«Empresa»**, que despliega «Razón social» y «NIF».
3. Pulsa **«Cobrar 120,00 € y cerrar»** (o **«Hacer check-out»**). Intro también confirma; «Cancelar» cierra sin cambios.
4. **Varias salidas a la vez** (solo con saldo 0): en «Salen hoy» marca «Seleccionar fila n» en las filas con «0,00 € saldado». En la barra «Acciones sobre la selección» pulsa **«Check-out de 2 con saldo 0»** y confirma en el diálogo del mismo nombre: «Se cerrarán 2 estancias con saldo 0 que salen hoy (la 206, la 207). Las habitaciones pasarán a sucia y el check-out no se puede deshacer.».

![Cajón «Check-out» de la habitación 204: folio, cobro de 120,00 € y factura en borrador](../../img/recepcion/check-out-cobro.png)

## Resultado esperado

- El cobro queda registrado, el folio se cierra y la fila pasa a **«Salida hecha»** (también en la lista y en el Live Timeline).
- La habitación pasa a **«Sucia»** con su tarea de limpieza de salida en Menú › Operaciones › Pisos (ficha [09](09-habitacion-limpia-e-inspeccionada.md)).
- Con «Emitir ahora con número» el aviso muestra el número de factura; con el borrador, la factura espera en Menú › Finanzas › Facturación y cobros (ficha [07](07-emitir-factura.md)).
- El check-out, individual o en lote, no se puede deshacer.

> **Nota:** recorrida el 19/09/2026 en el «Hotel UXDAY (prueba)» (datos ficticios) hasta el botón de confirmar, sin pulsarlo; el resultado se toma de la [guía de recepción](../../70-recepcion.md), que lo verifica con las pruebas automáticas del check-out.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Saldo pendiente detectado» con «Cobrar <importe> y cerrar» · «Salir con saldo pendiente» · «Cancelar» | El servidor ha encontrado saldo que el cajón no tenía: cobra, o deja salir con saldo si tu hotel lo permite. |
| «El folio tiene n cargos por X € sin facturar: emite la factura … antes de cerrarlo.» | El folio no se cierra con cargos sin facturar y «Sin factura»: elige «Borrador para Facturación» o «Emitir ahora con número». |
| La barra de selección no ofrece «Check-out de n con saldo 0» | Alguna fila marcada tiene saldo o no sale hoy: hazla fila a fila con «Cobrar … y cerrar». |
| La ficha de la reserva no tiene «Check-out» | Es así: la salida se hace desde Mi día, la lista o el Live Timeline. |
| «Autorizar con PIN de supervisor» | Devolver un cobro o anular una factura por encima de tu tramo exige el PIN de un supervisor. |
| «Demasiadas peticiones. Reintenta en unos segundos.» | Espera unos segundos y repite. |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — «Salidas y check-out» (con cobro y factura, en lote) y «Mi día».
- [20 · Administración](../../20-administracion.md) — capítulos 5 (facturación y VeriFactu) y 6.1 (cobros en el folio).
