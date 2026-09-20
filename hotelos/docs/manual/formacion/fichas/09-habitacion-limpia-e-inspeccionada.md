# Ficha · Habitación limpia e inspeccionada · ehotelOS

**Perfil:** Pisos · Gobernanta (plantillas «Pisos», «Gobernanta»). Las dos pueden marcar limpia e inspeccionar; que inspeccione solo la gobernanta es una norma de tu hotel.

## Antes de empezar

- La habitación está «SUCIA» en el tablero (toda salida la deja sucia y crea la tarea «Salida (limpieza)»).
- Sabes si está «OCUPADA»: marcarla limpia no la libera; solo la salida del huésped lo hace.
- Si vas a trabajar desde el móvil o la tablet, usa la pestaña «Mi turno»; desde el ordenador, el «Tablero».
- Cada aviso verde ofrece «Deshacer» durante 8 segundos (también con ⌘Z / Ctrl+Z): hasta entonces no se envía nada al servidor.

## Pasos

1. Abre **Menú › Operaciones › Pisos** (`/operaciones/pisos`), pestaña «Tablero». Arriba, los indicadores «SUCIAS», «LIMPIAS», «INSPECCIONADAS» (vendibles), «FUERA DE SERVICIO» y «TAREAS ABIERTAS»; debajo, los filtros «Todas · n», «Sucias · n», «Limpias · n», «Inspeccionadas · n», «Ocupadas · n», «Fuera de servicio · n» y «Con tareas · n».
2. Pulsa «Sucias · n» y localiza la tarjeta de la habitación (número, planta, etiqueta «SUCIA» y sus tareas abiertas).
3. Si la tarjeta tiene una tarea («Salida (limpieza) · alta · pendiente»), pulsa «Empezar» al comenzar (pasa a «en curso»; aviso «Tarea empezada.») y «Completar» al terminar (desaparece de la tarjeta; aviso «Tarea completada.»).
4. Pulsa «Marcar limpia». La etiqueta pasa a «LIMPIA» al instante, «SUCIAS» baja y «LIMPIAS» sube; el aviso «Habitación 305 limpia.» ofrece «Deshacer» 8 segundos.
5. La gobernanta revisa la habitación y pulsa «Inspeccionar» en la misma tarjeta. Aviso «Habitación 206 inspeccionada.» (con «Deshacer»); etiqueta «INSPECCIONADA» y la tarjeta ya no ofrece ni «Marcar limpia» ni «Inspeccionar».
6. Desde el móvil, en **Menú › Operaciones › Pisos › «Mi turno»** (`/operaciones/pisos/mi-turno`), elige tu sección (la pantalla la recuerda como «Mi sección») y usa los botones grandes de la tarjeta «Siguiente» o de la lista: «Iniciar» (aviso «Hab. 203 → En limpieza», etiqueta «EN LIMPIEZA»), «Limpia» («Hab. 203 → Limpia · tarea cerrada» con «Deshacer»: cierra también la tarea de limpieza y la habitación sale de tu lista a los 8 segundos) e «Inspeccionada» («Hab. 203 → Inspeccionada», con «Deshacer»). «Reportar» abre el parte de avería para mantenimiento: motivo con un toque y hasta 3 fotos con la cámara (ficha [10](10-parte-de-mantenimiento.md)).
7. Comprueba el resultado en **Menú › Recepción › Reservas › «Tablero de habitaciones»** (`/recepcion/reservas/tablero`): la habitación aparece como «Lista».

![Tablero de pisos con los cinco indicadores, los filtros y una tarjeta por habitación](../../img/pisos/tablero.png)

## Resultado esperado

- La tarjeta pasa de «SUCIA» a «LIMPIA» y a «INSPECCIONADA»; «INSPECCIONADAS (vendibles)» sube en uno y «TAREAS ABIERTAS» baja al completar la tarea (o al pulsar «Limpia» en Mi turno).
- Recepción ve la habitación «Lista» en el Tablero de habitaciones y en el selector «Habitación» del detalle de la reserva («106 · inspected»).
- Una habitación ocupada queda «LIMPIA» + «OCUPADA»: sigue con su huésped hasta el check-out.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| No aparece «Inspeccionar» (o «Inspeccionada» en Mi turno) | La habitación sigue sucia: márcala limpia primero. ehotelOS no deja inspeccionar una habitación sucia. |
| La habitación sigue en Mi turno con «Tarea pendiente · …» aunque está inspeccionada | Has inspeccionado sin pulsar «Limpia» (solo «Limpia» cierra la tarea): pulsa «Limpia» en la tarjeta o «Completar» en la tarjeta del tablero. |
| He marcado la habitación equivocada | Pulsa «Deshacer» en el aviso antes de 8 segundos: «Habitación 305: sin cambios.». Después, desde el cajón de la casilla del Tablero de habitaciones, «Marcar sucia». |
| Aviso rojo «No se pudo completar la acción.» | Pulsa «Actualizar» y repite: otra persona ha cambiado la habitación antes que tú, o está bloqueada por mantenimiento (ficha [10](10-parte-de-mantenimiento.md)). |

> **Nota:** el botón «Nueva tarea» de la tarjeta abre el cajón con «Tipo de tarea», «Prioridad» y «Asignar a» (opcional: nombre o correo de la camarera; Intro crea la tarea). Aviso «Tarea creada para la habitación 304.».

## Más detalle

- [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) — parte 1: vocabulario de estados, tareas 1 (tablero), 2 (nueva tarea), 3 (Mi turno), 4 (la inspección: quién y cuándo), 5 (reportar con foto) y 6 (Tablero de habitaciones de recepción).
