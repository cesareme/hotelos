# Ficha · Cambio de habitación · ehotelOS

**Perfil:** Recepción · Jefatura de recepción (plantillas «Recepción», «Jefatura de recepción»).

## Antes de empezar

- La reserva está «En el hotel» (o «Confirmada» con habitación asignada) y sabes su código, el nombre del huésped o su habitación actual.
- Hay otra habitación «Limpia» y libre, preferiblemente del mismo tipo: ehotelOS solo ofrece las limpias, libres y sin otra reserva, y pone primero las del mismo tipo.
- Si el traslado cambia de tipo, has acordado el precio con el huésped: el cambio de habitación no recalcula la tarifa.

## Pasos

1. Abre la ficha de la reserva: en **Menú › Recepción › Reservas** (`/recepcion/reservas/lista`, ⌥R) elige la vista «En el hotel (n)», escribe el nombre, el código o el número de habitación en «Buscar reservas por nombre, código o habitación» y pulsa «Abrir ficha» (`/recepcion/reservas/<id>`). Desde Mi día llegas a la misma ficha con «⋯» («Más acciones de <nombre>») › «Cambiar habitación».
2. En el grupo **«Acciones de la reserva»** (con la etiqueta de estado «En el hotel») pulsa **«Cambiar habitación»** (con ⌥ mantenido, la tecla **C**).
3. Bajo el botón se abre el panel **«Cambiar habitación»**: el desplegable «Habitación» con las candidatas («311 · Limpia» ya seleccionada, «312 · Limpia» y después las de otro tipo, «101 · Doble · Limpia»…; la actual aparece como «310 · Asignada»), el texto «Limpias, libres y sin otra reserva: primero las del mismo tipo. Intro confirma.» y los botones **«Mover a la 311»** y «Cancelar».
4. Elige la habitación y pulsa **«Mover a la …»** (o Intro).
5. **Desde el Live Timeline** (`/hoy/live-timeline`, ⌥T) tienes tres formas más: haz clic en la barra y, en el panel, «Acciones» › «Cambiar habitación» (en una reserva sin habitación el botón es «Asignar habitación»); **arrastra la barra** hacia arriba o abajo hasta la fila de la habitación nueva y suelta; o, con la barra enfocada, pulsa **⌥↑ / ⌥↓**. Ninguna pide confirmación: el cambio se aplica al soltar (o al pulsar) con el mismo aviso «Deshacer». Esc cancela un arrastre antes de soltar.

![Panel «Cambiar habitación» bajo la barra de acciones de la ficha, con «Mover a la 311»](../../img/recepcion/cambiar-habitacion.png)

## Resultado esperado

- El traslado se aplica al momento: en «Resumen» de la ficha, «Habitación asignada» muestra la nueva habitación, y en el Live Timeline la barra aparece en su fila.
- Aparece un aviso con **«Deshacer»** durante 8 segundos (también **⌘Z** mientras dura) y el foco vuelve a «Cambiar habitación». Deshacer un traslado de un huésped alojado es un traslado nuevo: la habitación intermedia queda sucia con su tarea de limpieza.
- Si el huésped estaba alojado, la habitación anterior pasa a **«Sucia»** con su tarea de limpieza en pisos y la nueva a **«Ocupada»**. En una reserva confirmada solo cambia la asignación.
- La **primera** asignación hecha desde la cola de Mi día no tiene «Deshacer»: no hay habitación anterior a la que volver.

> **Nota:** recorrida el 19/09/2026 en el «Hotel UXDAY (prueba)» (datos ficticios) hasta el botón «Mover a la 311», sin pulsarlo y sin arrastrar ninguna barra; el resultado se toma de la [guía de recepción](../../70-recepcion.md), que lo verifica con las pruebas automáticas de la ficha y del Live Timeline.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| La habitación que quieres no está en el desplegable | No está limpia, está ocupada, bloqueada o tiene otra reserva: pide a pisos que la marque limpia o a mantenimiento que la libere (fichas [09](09-habitacion-limpia-e-inspeccionada.md) y [10](10-parte-de-mantenimiento.md)), o elige otra. |
| Se te pasó el aviso «Deshacer» | Vuelve a «Cambiar habitación» y muévelo a la anterior: es un traslado nuevo y la intermedia queda sucia. |
| Al soltar la barra: «La habitación está ocupada actualmente» / «La habitación está bloqueada por mantenimiento o no es vendible» / «La reserva está cerrada» | Esa fila no está disponible o esa reserva ya no se mueve (salida hecha, cancelada, no-show). Elige otra fila o déjala como está. |
| Al soltar la barra: «Una reserva en casa solo puede cambiar de habitación» | Texto antiguo de la aplicación («en casa» significa «en el hotel»): has arrastrado hacia otras fechas y un huésped alojado solo cambia de habitación, no de fechas. |
| Fechas bloqueadas en la ficha: «Con el huésped alojado el API solo admite el cambio de habitación (REC-03).» | No es un error: con el huésped alojado hoy solo se cambia de habitación, ni desde la ficha ni desde el Live Timeline se cambia la salida. |
| Asignaste desde la cola de Mi día y no hay «Deshacer» | Es la primera asignación: si te equivocaste, abre la ficha y usa «Cambiar habitación». |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — «Ficha de reserva» (cambiar de habitación con «Deshacer») y «Live Timeline» (mover una estancia, atajos de teclado).
- [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) — qué pasa con la habitación anterior: tarea de limpieza y estados.
