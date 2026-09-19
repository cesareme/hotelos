# Ficha · Nueva reserva · ehotelOS

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy)

**Perfil:** Recepción · Jefatura de recepción (plantillas «Recepción», «Jefatura de recepción»); «Comercial» también tiene «Nueva reserva» en su menú.

## Objetivo

Crear una reserva nueva (teléfono, correo, mostrador o walk-in) con sus fechas, ocupación, tipo de habitación, huésped, tarifa y origen, y confirmarla para que aparezca en la lista, en Mi día y en el Live Timeline.

## Antes de empezar

- Fechas de llegada y salida, número de personas y tipo de habitación que pide el cliente.
- Nombre del huésped (y empresa o agencia si pagan ellas) y un contacto.
- El tipo tiene tarifa BAR cargada para esas noches: sin precio en la parrilla, ehotelOS no puede poner precio a la reserva (lo carga revenue, ficha [11](11-cambiar-tarifa-en-la-parrilla.md)).

## Pantalla de partida

- Botón verde **«+ Nueva reserva»** de la barra superior, o **Menú › Recepción › Nueva reserva** (`/recepcion/reservas/nueva`). Subtítulo: «Rellena el formulario o dicta la petición y revisa el borrador antes de confirmar.». Pestañas «Formulario» y «Dictar (IA)».
- El formulario va por pasos: «1. Estancia · 2. Huéspedes · 3. Tarifa · 4. Origen · 5. Pagos · 6. Solicitudes». En «Estancia» («Fechas, ocupación, tipo de habitación y asignación opcional») rellenas «Fecha de llegada*», «Fecha de salida*» («Noches» se calcula sola), «Tipo de habitación*», «Habitación asignada» (opcional: «Sin asignar (se asigna en el check-in)»), «Número de habitaciones», «Adultos», «Niños», «Bebés», «Hora prevista de llegada» y «Hora prevista de salida»; pulsas «Consultar disponibilidad» y «Siguiente». El pie muestra «Paso 1 de 6 · 0,00 € · 1 noche» y va sumando el importe según avanzas.
- Desde el **Live Timeline** (`/hoy/live-timeline`) puedes seleccionar celdas vacías de una habitación libre: el diálogo «Nueva reserva» te lleva al formulario con la habitación, el tipo y las fechas ya rellenos.
- «Dictar (IA)» (`/recepcion/reservas/nueva/dictar`) convierte una petición dictada o pegada en un borrador que revisas antes de confirmar.

## Resultado esperado

- La reserva recibe un código «RES-…» y aparece en «Menú › Recepción › Reservas» (pestaña «Futuras» o «Llegan hoy») con estado «CONFIRMADA», en Mi día (si llega hoy) y en el Live Timeline (barra «Confirmada» o en el carril «Sin asignar» si no le has dado habitación).
- El precio sale de la tarifa BAR del día para ese tipo; el total aparece en la columna «TOTAL» de la lista y en «Importes» del detalle.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| El importe se queda en «0,00 €» o el paso «Tarifa» no ofrece precio | No hay BAR cargada para esas noches y ese tipo. Pide a revenue que la cargue en «Revenue › Parrilla de tarifas». |
| No encuentras la habitación que quieres en «Habitación asignada» | Déjala en «Sin asignar (se asigna en el check-in)»: la habitación se elige en la entrada (ficha [01](01-entrada-de-huesped.md)); comprueba antes en el Live Timeline la fila «Libres» de esas fechas. |
| «Dictar (IA)» (etiqueta «ASISTIDO POR IA») devuelve un borrador incompleto | Sin proveedor de IA el borrador se rellena por reglas: completa los campos que falten en el formulario antes de confirmar. |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — capítulos «Nueva reserva rápida» y «Crear una reserva desde celdas vacías» del Live Timeline.
- [50 · Comercial y revenue](../../50-comercial-revenue.md) — de dónde sale el precio (vocabulario de la parrilla).
