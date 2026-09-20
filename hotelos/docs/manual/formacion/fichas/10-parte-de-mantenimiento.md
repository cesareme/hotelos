# Ficha · Parte de mantenimiento (orden de trabajo) · ehotelOS

**Perfil:** Mantenimiento · Encargado de mantenimiento (plantillas «Mantenimiento», «Encargado de mantenimiento»). Bloquear una habitación es del encargado o de dirección, no del técnico. Pisos crea partes con foto desde «Mi turno» (paso 0).

## Antes de empezar

- Qué pasa, en qué habitación (el número tal como existe en el hotel) y con qué prioridad: «emergencia», «urgente», «normal» o «preventivo».
- Si la avería impide vender la habitación, la decisión de bloquearla (fuera de servicio) hasta resolverla.
- Los partes que pisos reporta desde «Mi turno» ya llegan solos al tablero como «Hab. 203: Fuga de agua» con prioridad normal y hasta 3 fotos.
- «Tomar», «Resuelta» y «Resolver» ofrecen «Deshacer» durante 8 segundos (también con ⌘Z / Ctrl+Z).

## Pasos

0. **Desde pisos (camarera, tablet del carro).** En **Menú › Operaciones › Pisos › «Mi turno»**, botón «Reportar» de la tarjeta: toca el motivo («Fuga de agua», «Bombilla», «Aire acondicionado», «TV/Wi-Fi», «Cerradura» u «Otro»), pulsa «Foto» (abre la cámara trasera; hasta 3 fotos, con «Quitar») y «Enviar a mantenimiento». Aviso «Avería de la 203 enviada a mantenimiento · 1 foto». Tres toques y ninguna letra; el «Detalle» es opcional.
1. Abre **Menú › Operaciones › Mantenimiento** (`/operaciones/mantenimiento`), pestaña «Tablero». Indicadores «EMERGENCIAS», «ABIERTAS», «EN CURSO», «ESPERANDO PROVEEDOR» y «BLOQUEAN HABITACIÓN»; filtros «Activas · n», «Todas · n», «Abiertas · n», «En curso · n», «Esperando proveedor · n», «Bloquean habitación · n» y «Resueltas · n».
2. Para un parte nuevo desde el tablero, pulsa «Nueva orden de trabajo» (arriba a la derecha). En el cajón «Nueva orden de trabajo» («Se crea abierta; asígnala o bloquea la habitación desde su ficha.») rellena «Título*» (ejemplo del campo: «Fuga en el baño»), «Habitación» (opcional, «Ej.: 108»), «Prioridad» («emergencia», «urgente», «normal», «preventivo»), «Descripción» y, si procede, el interruptor «Bloquea la habitación (fuera de servicio)». Pulsa «Crear orden»: aviso «Parte a1c3n6 creado.» (las seis letras son el final del identificador) y la orden entra en la lista como «ABIERTA».
3. En la lista «Órdenes», pulsa la orden para abrir su ficha a la derecha: «Estado», «Prioridad», «Habitación» («Hab. 301»), «Bloquea habitación» («No» / «Sí (fuera de servicio)»), «Asignada a» (nombre o «Sin asignar»), «Creada» y «Descripción».
4. Para tomarla, pulsa «Asignarme» (aviso «Parte a1c3n6 → asignado a <tu nombre>») o escribe un nombre en «Asignar a» e Intro, y elige «En curso» en el desplegable «Estado» («El cambio se guarda al elegirlo.»; aviso «Parte a1c3n6 → En curso»). Desde el móvil, en la pestaña «Mis averías» (`/operaciones/mantenimiento/mis-averias`), el botón «Tomar» hace las dos cosas: aviso «Parte a1c3n6 → En curso · asignado a ti» con «Deshacer». El chip «Mías · n» muestra solo tus partes.
5. Si la habitación no se puede vender mientras la arreglas, pulsa «Bloquear habitación» al pie de la ficha y confirma en el diálogo «Bloquear la 301» con el botón «Bloquear la 301» («Mantenerla en venta» cancela). Aviso «Habitación 301 bloqueada.»; la ficha pasa a «Bloquea habitación: Sí (fuera de servicio)», la fila muestra «BLOQUEA» y «BLOQUEAN HABITACIÓN» sube en uno. Pisos ve la habitación «FUERA DE SERVICIO · BLOQUEADA · NO VENDIBLE» y recepción no puede asignarla.
6. Mira las fotos y anota lo que has hecho: en «Mis averías», el botón «1 foto» / «n fotos» de la tarjeta abre la galería «Fotos del parte a1c3n6» («Cerrar» para volver); el botón «Nota» abre el cajón «Añadir nota» → «Guardar nota» (aviso «Nota añadida al parte a1c3n6.»; la nota se añade a la descripción con fecha y hora). En el tablero no hay campo de notas ni galería.
7. Pulsa «Resolver» en la ficha (o «Resuelta» en «Mis averías»). La orden sale de «Activas» al instante y el aviso «Parte a1c3n6 resuelto · habitación 301 liberada.» (o «Parte a1c3n6 resuelto.») ofrece «Deshacer» 8 segundos; después queda en «Resueltas · n» y no se puede reabrir. Si bloqueaba la habitación, ehotelOS la libera y la deja «SUCIA» para que pisos la repase e inspeccione antes de venderla (ficha [09](09-habitacion-limpia-e-inspeccionada.md)).

![Tablero de mantenimiento con una orden seleccionada y su ficha a la derecha](../../img/mantenimiento/tablero-mantenimiento.png)

## Resultado esperado

- La orden recorre «ABIERTA» → «EN CURSO» → «Resuelta» y los indicadores cambian a la vez («ABIERTAS» baja, «EN CURSO» sube, «Resueltas · n» la recoge al final); «Asignada a» lleva el nombre de quien la tomó.
- Mientras bloquea, la habitación está «Fuera de servicio» en el Tablero de habitaciones de recepción y en el tablero de pisos; al resolver, vuelve a «SUCIA» sin «NO VENDIBLE».
- Dirección ve la orden en Mi día › «Operaciones» («Órdenes de trabajo (n)») y recepción como acción «INCIDENCIA» en Mi día.

> **Nota:** las fotos solo se adjuntan al crear el parte desde «Reportar» (pisos); desde el tablero y «Mis averías» se ven pero no se añaden. Los cajones «Nueva orden de trabajo» (paso 2) y «Añadir nota» (paso 6) se han abierto en la demo sin crear nada; el resto está comprobado en la guía 40 con órdenes ficticias de la 305 y de la 118.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| Error de permiso al bloquear («requiere: ai.high_risk.confirm» o «Blocking a room requires manager or maintenance lead confirmation.») | Tu plantilla es «Mantenimiento» (técnico): pide al encargado o a dirección que bloquee la habitación o que cambie tu plantilla. El botón «Bloquear habitación» no se muestra sin ese permiso. |
| «La orden de trabajo no está vinculada a ninguna habitación.» / la ficha dice «Habitación: —» | Creaste la orden sin número de habitación o con uno que no existe: no se puede bloquear nada. Resuélvela y crea otra con el número correcto. |
| «La orden ya está resuelta.» / «La habitación ya está bloqueada por esta orden.» | Otra persona se adelantó: pulsa «Actualizar». |
| He resuelto (o tomado) el parte equivocado | «Deshacer» en el aviso antes de 8 segundos: «Parte a1c3n6: sin cambios.». Una resolución ya enviada no se reabre: crea un parte nuevo. |
| «No se pudieron cargar las fotos» | Comprueba la conexión y vuelve a abrir la galería; una foto guardada fuera de línea (partes antiguos) se indica en su lugar en vez de mostrarse. |

## Más detalle

- [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) — parte 1, tarea 5 (reportar con motivo y foto) y parte 2: vocabulario de estados y prioridades, tarea 8 (tablero), tarea 9 (crear, tomar, anotar, bloquear y resolver) y tarea 10 (Mis averías y la galería).
