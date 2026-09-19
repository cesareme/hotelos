# Ficha · Cambio de habitación · ehotelOS

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy)

**Perfil:** Recepción · Jefatura de recepción (plantillas «Recepción», «Jefatura de recepción»).

## Objetivo

Trasladar a un huésped alojado (o cambiar la habitación de una reserva confirmada que todavía no ha llegado) a otra habitación vendible, dejando la anterior en manos de pisos.

## Antes de empezar

- La reserva está «En el hotel» (o «CONFIRMADA» con habitación asignada) y sabes su código o el nombre del huésped.
- Hay otra habitación del mismo tipo (o del tipo acordado con el cliente) en estado «Limpia» o «Inspeccionada». El selector muestra el estado de limpieza de cada habitación («101 · clean», «106 · inspected», «432 · dirty») y hoy lista también las sucias aunque su ayuda diga «Solo habitaciones vendibles…»: elige una «clean» o «inspected».
- Si el traslado cambia el precio (otro tipo), lo has acordado con el huésped: el traslado no recalcula la tarifa.

## Pantalla de partida

- **Menú › Recepción › Reservas** (`/recepcion/reservas/lista`), pestaña «En casa (n)» › reserva › «Detalle» (`/recepcion/reservas/:id`): en «Resumen» ves «Habitación asignada» y, debajo, el selector «Habitación» con la lista «101 · clean», «106 · inspected»… («Solo habitaciones vendibles, además de la asignada.»). Elige la nueva y pulsa «Asignar habitación».
- **Menú › Hoy › Live Timeline** (`/hoy/live-timeline`): haz clic en la barra de la reserva y en «Acciones» pulsa «Cambiar habitación»; o **arrastra la barra** a la fila de otra habitación: al soltar se abre el diálogo «Mover reserva» con el bloque «Cambio» («Antes» / «Después») y el botón «Mover» («Cancelar» lo deja como estaba; Esc cancela el arrastre antes de soltar).

![Live Timeline: una fila por habitación, las barras de cada estancia y el carril «Sin asignar»](../../img/recepcion/live-timeline.png)

## Resultado esperado

- El detalle muestra la nueva «Habitación asignada» y en el Live Timeline la barra aparece en la fila nueva («Selección: RES-… · <huésped>»).
- Si el huésped estaba alojado, la habitación anterior pasa a «Sucia» con su tarea de limpieza en el tablero de pisos; la nueva pasa a «Ocupada».
- Tras un traslado desde el Live Timeline aparece «Se puede deshacer el cambio en la reserva RES-… durante 8 s» con «Deshacer»; deshacer un traslado de un alojado es un traslado nuevo («la habitación intermedia queda sucia y con su tarea de limpieza»).

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «La habitación está ocupada actualmente» al soltar la barra | Esa habitación tiene otro huésped: elige otra fila. |
| «La habitación está bloqueada por mantenimiento o no es vendible» | Hay una orden de trabajo que la bloquea o está sucia: pide a mantenimiento o a pisos que la liberen (fichas [09](09-habitacion-limpia-e-inspeccionada.md) y [10](10-parte-de-mantenimiento.md)). |
| «Una reserva en casa solo puede cambiar de habitación» | Has arrastrado la barra hacia otras fechas: un huésped alojado no cambia de fechas desde la parrilla; la salida se cambia desde su ficha. |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — capítulos «Mover o redimensionar una estancia (arrastrar)» y «Cambio de habitación» (se completa en DOC-2).
