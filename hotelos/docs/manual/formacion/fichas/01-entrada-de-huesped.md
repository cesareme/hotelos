# Ficha · Entrada de huésped (check-in) · ehotelOS

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy)

**Perfil:** Recepción · Jefatura de recepción · Auditoría nocturna (plantillas «Recepción», «Jefatura de recepción», «Auditoría nocturna»).

## Objetivo

Registrar la llegada de un huésped que tiene reserva: comprobar la reserva, asignarle una habitación limpia o inspeccionada, tomar sus datos de identidad para el parte de viajeros y dejar la estancia como «En el hotel» con su folio abierto.

## Antes de empezar

- La reserva existe y está confirmada (estado «CONFIRMADA» en la lista; «Llega hoy» en el Live Timeline). Si no existe, créala primero (ficha [03 · Nueva reserva](03-nueva-reserva.md)).
- Hay una habitación del tipo reservado en estado «Limpia» o «Inspeccionada». El selector «Habitación» del detalle muestra cada habitación con su estado de limpieza («101 · clean», «106 · inspected», «432 · dirty»): hoy lista también las sucias aunque su texto de ayuda diga «Solo habitaciones vendibles…», así que elige una «clean» o «inspected». Si todas están sucias, avisa a pisos (ficha [09](09-habitacion-limpia-e-inspeccionada.md)).
- Tienes a mano el documento de identidad del huésped: el parte de viajeros se crea con el check-in.

## Pantalla de partida

Tres caminos llevan al mismo sitio; elige el que tengas más a mano:

- **Menú › Hoy › Mi día** (`/hoy`): en la lista «Llegadas (n)» cada fila lleva «Hacer check-in» y «Ver folio»; las llegadas sin habitación aparecen además arriba como acción «URGENTE · SIN HABITACIÓN» con la propuesta «La 101 está limpia y es del mismo tipo. ¿Asignar?» y los botones «Asignar 101» y «Ver room rack».
- **Menú › Recepción › Reservas** (`/recepcion/reservas/lista`): la lista abre en la pestaña «Llegan hoy (n)». Haz clic en la reserva para abrir su «Detalle» (`/recepcion/reservas/:id`): pestañas «Resumen · Folio (n) · Actividad · Huéspedes (n) · Documentos», el selector «Habitación» («Solo habitaciones vendibles, además de la asignada.») con los botones «Asignar habitación», «Check-in», «Check-out», «Cancelar reserva» y «Marcar no-show», y el bloque «Importes» con «Cobrar» y «Devolver».
- **Menú › Hoy › Live Timeline** (`/hoy/live-timeline`): haz clic en la barra de la reserva (o en el carril «Sin asignar») y usa «Asignar habitación» y «Check-in» del panel «Acciones».

![Panel de detalle del Live Timeline con las acciones «Check-in», «Asignar habitación», «Cancelar reserva» y «Marcar no-show»](../../img/recepcion/live-timeline-detalle.png)

## Resultado esperado

- La reserva pasa a «ALOJADA» en la lista («En casa» en el Live Timeline, «En el hotel» en Mi día) y deja de contar en «Sin habitación».
- La habitación asignada aparece como «Ocupada» en el tablero de pisos y en el Tablero de habitaciones.
- El folio de la reserva queda abierto («folio abierto» en «Importes») y el parte de entrada aparece en «Menú › Cumplimiento › Registro de viajeros» (ficha [12 · Parte de viajeros](12-parte-de-viajeros.md)).

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Check-in» apagado con el aviso «Asigna una habitación antes del check-in» | Elige una habitación en el selector «Habitación» y pulsa «Asignar habitación»; después «Check-in». |
| La habitación que quieres no está en el selector | No es vendible (sucia, bloqueada o fuera de servicio). Pide a pisos que la marque limpia o a mantenimiento que resuelva la orden. |
| «Demasiadas peticiones. Reintenta en unos segundos.» | Límite de peticiones por minuto: espera unos segundos y pulsa «Reintentar». |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — capítulos «Live Timeline» (estable) y «Check-in (entrada de huésped)» (se completa en DOC-2).
- [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) — estados de habitación y quién los cambia.
