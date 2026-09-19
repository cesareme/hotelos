# Guía de recepción · ehotelOS

Esta guía es para el personal de recepción de ehotelOS. Por ahora es un **esqueleto**: el único capítulo completo es el del [Live Timeline](#live-timeline), la primera entrada del menú y la pantalla más estable de recepción. El resto (Mi día, entrada y salida de huéspedes, walk-in, cobro, nueva reserva rápida, cambio de habitación…) tiene solo el título y una descripción breve, porque esas pantallas las está cambiando la tanda UX-1: se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy). Hasta entonces, para esas tareas guíate por la ayuda dentro de la aplicación (botón «?» de la barra superior) y por las tarjetas de instrucciones de cada pantalla.

Todo lo que se describe aquí se ha recorrido en la aplicación el 19 de septiembre de 2026 sobre el hotel de demostración; si algo no coincide con lo que ves, mira primero [Qué no hace todavía](#qué-no-hace-todavía).

## Para quién

Para quien trabaja con la plantilla de usuario **«Recepción»**, **«Auditoría nocturna»** o **«Jefatura de recepción»**. Las tres ven el mismo menú que se describe más abajo; lo que cambia entre ellas son los permisos concretos (qué acciones puede confirmar cada una), no las pantallas. Si tu usuario tiene otra plantilla, tu guía es otra: consulta el [índice del manual](README.md).

## Cómo están hechas las capturas

- Todas las capturas son del hotel de demostración «Hotel Demo Madrid Centro» (organización «Grupo Hotelero Demo»), con reservas y huéspedes **ficticios** (Marc Vidal Puig, Ana Ruiz Castro, Tomás Herrera Gil…). En tu hotel verás tus datos, tu nombre de hotel arriba a la izquierda y tu usuario arriba a la derecha.
- Se han tomado con la cuenta de demostración, que es administradora, eligiendo «Recepción» en el selector «Ver como…» de la barra lateral: por eso aparece el aviso «Viendo como Recepción · solo menú» con el botón «Salir». Ese selector solo cambia el menú, no los permisos, y se pierde al recargar la página (F5). Con la plantilla «Recepción» tu menú es directamente el que ves en las capturas, sin el aviso.
- Tema claro (botón «Claro» de la barra superior), ventana de 1280 × 800 píxeles, idioma español. La tarjeta de instrucciones del Live Timeline y el aviso de puesta en marcha («Faltan 1 comprobación para poner la propiedad en marcha.», así, con el verbo en plural: es un texto de la aplicación) están ocultos en las capturas; en tu hotel puedes cerrarlos con «Cerrar instrucciones» (×) y «Ahora no».
- La fecha de las capturas es el sábado 19 de septiembre de 2026. Los contadores («19 HABITACIONES», «15 RESERVAS VISIBLES»…) son los de ese día en la demo: no los tomes como referencia.
- Las capturas de la ficha rápida y del detalle se han hecho pasando el ratón y haciendo clic sobre la reserva RES-18399 (Marc Vidal Puig, habitación 201, ficticia). La lista de capturas de esta guía está en `img/recepcion/capturas.json`: el detalle (`live-timeline-detalle.png`) lleva sus pasos (`actions`) y se regenera con la receta; la ficha rápida (pasar el ratón) y la barra de filtros con «Cancelada» encendido se regeneran a mano siguiendo los pasos de cada tarea, porque la receta no reproduce todavía esos dos estados.

## Qué verás en tu menú

Con la plantilla «Recepción» el pie de la barra lateral dice **«9 categorías · 23 entradas»**. Las categorías se pliegan y despliegan con «▾» y el cuadro «Buscar en el menú» filtra las entradas por nombre. En la barra superior tienes el botón verde **«+ Nueva reserva»**, el buscador global «Buscar reservas, huéspedes…» (**⌘K**, Ctrl+K en Windows), el conmutador de tema («Claro»), las notificaciones (campana), la ayuda («?») y tu usuario.

| Categoría | Entradas (dirección) y pestañas |
|---|---|
| **Hoy** (7) | «Live Timeline» (`/hoy/live-timeline`) · «Mi día» (`/hoy`; solo la pestaña «Recepción») · «Asistente ehotelOS» (`/asistente`) · «Turno» (`/hoy/turno`) · «Cierre del día» (`/hoy/cierre-del-dia`) · «Pendientes de aprobación» (`/hoy/pendientes`) · «Pendientes de la IA» (`/hoy/pendientes-ia`) |
| **Recepción** (5) | «Reservas» (`/recepcion/reservas`, abre en «Lista»): pestañas «Lista · Tablero de habitaciones · Importar», y «Detalle · Recorrido» cuando tienes una reserva abierta · «Nueva reserva» (`/recepcion/reservas/nueva`): «Formulario · Dictar (IA)» · «Huéspedes» (`/recepcion/huespedes`): «Listado», y «Ficha · Cronología» cuando abres un huésped · «Mensajes de huéspedes» (`/recepcion/mensajes`) · «Grupos y eventos» (`/recepcion/grupos`): «Resumen · Calendario» (la pestaña «Cupos» es de comercial y dirección) |
| **Operaciones** (1) | «Seguridad e incidentes» (`/operaciones/seguridad`) |
| **Comercial** (2) | «Clientes y fidelización» (`/comercial/clientes`): «Clientes · Fidelización» · «Ventas adicionales» (`/comercial/ventas-adicionales`): solo la pestaña base (sin «Ofertas» ni «Portal del huésped») |
| **Revenue** (2) | «Planes de tarifas» (`/revenue/planes`) · «Políticas de cancelación» (`/revenue/politicas-cancelacion`) |
| **Finanzas** (1) | «Facturación y cobros» (`/finanzas/facturacion`): «Facturación y cobros · Rectificativas · Enrutamiento de folios», y «Folio» cuando abres un folio |
| **Cumplimiento** (3) | «Bandeja de cumplimiento» (`/cumplimiento/bandeja`) · «Envíos a autoridades» (`/cumplimiento/envios`): «VeriFactu · TicketBAI · IGIC · SES.HOSPEDAJES» · «Registro de viajeros» (`/cumplimiento/registro-viajeros`): «Partes de entrada · SES.Hospedajes» |
| **Informes** (1) | «Centro de informes» (`/informes`) |
| **Configuración** (1) | «Comunicaciones» (`/configuracion/comunicaciones`): solo «Plantillas y envíos» (con las subpestañas «Plantillas · Envíos · Estadísticas») |

> **Módulo a activar:** la entrada «Punto de venta» (TPV, cartas, cierre de caja) también pertenece al menú de recepción, pero solo aparece si la propiedad tiene activado el módulo de punto de venta. En la demo está apagado y por eso no la ves en las capturas.

> **Nota:** «Ver como…» solo existe para cuentas que pueden gestionar otros perfiles. Si tu cuenta es de recepción no lo verás: tu menú ya es este.

## Live Timeline

**Menú › Hoy › Live Timeline** (`/hoy/live-timeline`). Es la primera entrada del menú para todos los perfiles y la vista de conjunto de recepción: las reservas alojadas y las futuras, habitación por habitación, sobre un calendario. Cada **barra** es una estancia, cada **fila** una habitación (agrupadas por tipo) y la fila superior te dice cuántas habitaciones quedan **libres** cada día.

La pantalla se titula «Live Timeline» (con la etiqueta «HOY» encima) y su subtítulo resume lo que puedes hacer en ella:

> «Pasa el ratón por un bloque para ver su ficha rápida, haz clic para abrir el detalle con folio y actividad, y arrastra para mover o redimensionar la estancia. Las acciones críticas piden confirmación antes de ejecutarse.»

![Live Timeline con el menú de recepción: periodo, filtros, contadores y parrilla por habitación](img/recepcion/live-timeline.png)

### La pantalla, de arriba abajo

1. **Tarjeta de instrucciones.** La primera vez verás una tarjeta con el título «Live Timeline», una descripción («Reservas en casa y proyectadas por habitación en un calendario…»), cinco pasos numerados y un «Tip:» con el significado de los colores. Ciérrala con el botón × («Cerrar instrucciones»): ehotelOS recuerda que la has cerrado y no vuelve a mostrarla en ese navegador. En la captura ya está cerrada.
2. **Botón «Actualizar»** (arriba a la derecha): vuelve a cargar habitaciones y reservas sin cambiar el periodo ni los filtros.
3. **Periodo y escala.** «Anterior» · «Hoy» · «Siguiente», el rango que estás viendo (por ejemplo «18 sept – 1 oct 2026»), un selector de fecha («Ir a la fecha», el formato depende de tu navegador) para saltar a un día concreto y, a la derecha, la escala «Día · 7» / «Semana · 14» / «Mes · 30» (7, 14 o 30 días). Al abrir la pantalla estás en «Semana · 14» y el periodo empieza **el día anterior a hoy**, para que veas también las estancias que terminan hoy. Mientras carga un periodo aparece «Cargando periodo…».
4. **Buscador y filtros.** El cuadro «Código, huésped o habitación» y tres grupos de chips: «ESTADO», «CANAL» y «TIPO». Cada chip lleva su recuento en el periodo («En casa · 3», «Booking.com · 3», «Double · 9»); solo se listan los estados, canales y tipos que existen en el periodo. Cuando hay algo activo aparece «Limpiar filtros».
5. **Contadores.** «19 HABITACIONES · 15 RESERVAS VISIBLES · EN CASA: 3 · LLEGADAS HOY: 4 · SALIDAS HOY: 4» y, a la derecha, «Sin selección» o «Selección: RES-18399 · Marc Vidal Puig» cuando has seleccionado una barra. «EN CASA» cuenta las reservas alojadas del periodo; «LLEGADAS HOY» las que llegan hoy (confirmadas o ya alojadas); «SALIDAS HOY» las que salen hoy (alojadas o con la salida ya hecha).
6. **Aviso «CIERRE NOCTURNO PENDIENTE · FECHA DE NEGOCIO 14 SEPT».** Aparece cuando la fecha de negocio del hotel va por detrás del día real porque no se ha ejecutado el cierre del día. En ese caso «hoy» en esta pantalla (la columna resaltada, «LLEGADAS HOY», «SALIDAS HOY», los colores «Llega hoy» y «Sale hoy») es **el día real**, la misma regla que usa el check-in. Si pasas el ratón por el aviso lo dice: «El cierre nocturno no se ha ejecutado: «hoy» es el día local, como en el check-in».
7. **La parrilla.**
   - Cabecera con un día por columna (día de la semana y fecha); hoy va resaltado con «· hoy» y los fines de semana en fondo gris. La cabecera y la columna «Habitación» se quedan fijas al desplazarte.
   - Fila **«Libres»**: habitaciones libres cada día, sumando todos los tipos; la celda cambia de color cuando quedan pocas (un 20 % o menos de las vendibles) o ninguna.
   - Carril **«Sin asignar» · «RESERVAS SIN HABITACIÓN»**: las reservas del periodo que todavía no tienen habitación (en la captura, tres llegadas de hoy y varias futuras; la cuarta llegada de hoy ya está alojada en la 105). Desde aquí se asignan (ver [Abrir el detalle](#abrir-el-detalle-con-folio-y-actividad)).
   - Una fila de **grupo por tipo de habitación** («Double · 9 HABITACIONES») con las libres de ese tipo por día; el botón «⌄» / «›» pliega o despliega el grupo («Plegar Double» / «Desplegar Double»).
   - Una fila por **habitación**: «Hab. 103 · DOUBLE · 2 PAX · PLANTA 1». El punto de color delante del número es el estado de la habitación (pasa el ratón por él para leerlo): «Limpia», «Sucia», «Inspeccionada», «Ocupada» o «Bloqueada». Una habitación bloqueada por mantenimiento lleva además la etiqueta «BLOQUEADA» y su carril aparece rayado (la 108 en la demo): no se puede soltar una reserva encima.
   - Las **barras**: nombre del huésped y, debajo, «estado · noches · importe» («En casa · 2 noches · 288,00 €»). Empiezan y acaban a media celda, así dos estancias seguidas en la misma habitación no se pisan. Un «‹» delante del nombre indica que la estancia empezó antes del periodo visible (y «›» detrás, que termina después).
8. **Leyenda** al pie: «LLEGA HOY · EN CASA · SALE HOY · CONFIRMADA · BORRADOR · Salida · NO-SHOW · CANCELADA · BLOQUEADA · MANTENIMIENTO».

### Elegir el periodo

1. Elige la escala: «Día · 7» para ver la semana con más detalle, «Semana · 14» (por defecto) o «Mes · 30» para planificar.
2. Muévete con «Anterior» y «Siguiente» (avanzan o retroceden un periodo completo) o escribe una fecha en «Ir a la fecha».
3. Pulsa «Hoy» para volver al periodo que incluye hoy.

**Resultado esperado.** El rango de la cabecera cambia («18–24 sept 2026» en Día, «18 sept – 1 oct 2026» en Semana, «18 sept – 17 oct 2026» en Mes; «Siguiente» en Día lleva a «25 sept – 1 oct 2026») y los recuentos de los chips y de «RESERVAS VISIBLES» se recalculan para el nuevo periodo. La selección y los filtros se mantienen.

### Encontrar una reserva

1. Escribe en «Código, huésped o habitación» parte del nombre («ruiz», sin distinguir mayúsculas ni acentos), el código («RES-18400») o el número de habitación («201»); también encuentra por quien hizo la reserva o por la empresa. No hace falta pulsar Intro: la parrilla se filtra al momento y solo quedan las barras que coinciden («1 RESERVA VISIBLE»).
2. O usa los chips, que funcionan como **interruptores encendidos por defecto**: al abrir la pantalla todos los estados, canales y tipos del periodo están activos (salvo «Cancelada», que está apagado), y pulsar un chip **apaga** ese estado, canal o tipo y oculta sus reservas. Por ejemplo, al pulsar «En casa · 3» desaparecen las tres alojadas y «RESERVAS VISIBLES» pasa de 15 a 12; para quedarte **solo con las alojadas** tienes que apagar los demás chips de «ESTADO» («Confirmada · 9» y «Salida · 3») y dejar «En casa · 3» encendido. Dentro de un grupo, cada chip encendido suma sus reservas (dos canales encendidos = reservas de cualquiera de los dos) y entre grupos se cruzan: una reserva solo se dibuja si su estado, su canal y su tipo están los tres encendidos.
3. Pulsa «Limpiar filtros» (aparece en cuanto cambias algo) para volver al estado inicial: todo encendido y las canceladas ocultas.

![Barra de filtros del Live Timeline con el chip «Cancelada» activado y «Limpiar filtros»](img/recepcion/live-timeline-filtros.png)

**Resultado esperado.** «RESERVAS VISIBLES» baja según lo que apagues (o sube al encender «Cancelada»); las habitaciones sin coincidencias se quedan vacías. Si apagas todo, ves el aviso «Sin reservas que coincidan» («Ninguna reserva del periodo pasa los filtros o la búsqueda; las habitaciones se muestran vacías.») con el botón «Limpiar filtros». Comprobado en la demo: con «En casa» apagado, la barra de Marc Vidal Puig desaparece; con «Confirmada» y «Salida» apagados quedan las 3 alojadas.

> **Nota:** «Cancelada · 1» es el único chip **apagado** por defecto, porque las reservas **canceladas** no se dibujan hasta que lo enciendes. Al encenderlo, «RESERVAS VISIBLES» las suma (de 15 a 16 en la captura), pero una cancelada que **no tenía habitación asignada** sigue sin dibujarse: el carril «Sin asignar» solo muestra reservas vivas. Para verla, ve a Menú › Recepción › Reservas › «Canceladas».

### Consultar la ficha rápida

1. Pasa el ratón por una barra (o llega a ella con el teclado) sin hacer clic.

**Resultado esperado.** Se abre una tarjeta junto a la barra con las iniciales del huésped en el color de su estado, el nombre y el código de reserva, tres chips (estado, canal y habitación: «En casa» · «BOOKING.COM» · «HAB. 201»), y seis datos: «ENTRADA», «SALIDA», «NOCHES», «OCUPACIÓN» («1 ad.», «2 ad. · 1 niño»), «IMPORTE» y «SEGMENTO» («—» si no está informado). Abajo, «HAZ CLIC PARA VER EL DETALLE». La ficha rápida no consulta nada al servidor: es inmediata y desaparece al retirar el ratón.

![Ficha rápida al pasar el ratón por la reserva RES-18399 de Marc Vidal Puig](img/recepcion/live-timeline-ficha-rapida.png)

### Abrir el detalle con folio y actividad

1. Haz clic en una barra (o selecciónala y pulsa Intro).

**Resultado esperado.** La barra queda seleccionada (borde marcado, «Selección: RES-18399 · Marc Vidal Puig» arriba a la derecha) y a la derecha de la parrilla se abre un **panel acoplado** que no tapa el resto: la parrilla sigue viva y puedes cambiar de reserva con las flechas. El panel muestra:

- Cabecera: código («RES-18399»), «Marc Vidal Puig · Hab. 201» y el botón «Cerrar».
- Chips de estado, canal, habitación y noches («EN CASA» · «BOOKING.COM» · «HAB. 201» · «2 NOCHES»).
- **«Huéspedes»**: «HUÉSPED PRINCIPAL» y «OCUPACIÓN» («1 adulto»); si la reserva no tiene huésped, «Sin huésped registrado».
- **«Estancia y folio»**: «ESTADO», «ENTRADA», «SALIDA», «NOCHES», «TIPO», «HABITACIÓN» («Hab. 201» o «Sin asignar»), «CANAL», «IMPORTE TOTAL», «SALDO PENDIENTE», «COBROS» y «ACTIVIDAD ABIERTA». En la captura el saldo pendiente es «18,00 €» (minibar y parking cargados al folio, 24,50 €, menos un cobro parcial) y los cobros «6,50 €» (el cobro ficticio que registró la guía de administración); si la reserva aún no tiene folio, verás «Sin folio».
- **«Actividad reciente»**: los últimos eventos de limpieza, mantenimiento y mensajes de esa reserva, con «ABIERTA» o «Cerrada» («Limpieza · Stayover · ABIERTA» en la captura); «Sin actividad» si no hay ninguno.
- **«Ir a»**: «Recorrido del huésped», «Folio y facturación» (solo si el folio existe: abre ese folio en Finanzas › Facturación y cobros), «Limpieza», «Mantenimiento» y «Mensajes».
- **«Acciones»**: «Check-in», «Check-out», «Asignar habitación» (o «Cambiar habitación» si ya tiene), «Cancelar reserva» y «Marcar no-show». Solo se activan las que tienen sentido para el estado: para una reserva alojada, «Check-out» y «Cambiar habitación» (como en la captura); para una confirmada, «Check-in» (solo si ya tiene habitación; si no, el botón te dice «Asigna una habitación antes del check-in»), «Asignar habitación», «Cancelar reserva» y «Marcar no-show». Todas abren un diálogo de confirmación; cancelar y no-show exigen un «Motivo» de al menos 3 caracteres y te muestran la penalización prevista por la política de cancelación.
- Pie: «Esc» y el botón «Abrir reserva», que te lleva a la ficha completa (Menú › Recepción › Reservas › «Detalle»).

![Detalle de la reserva RES-18399 abierto en el panel acoplado, con folio y actividad](img/recepcion/live-timeline-detalle.png)

2. Cierra el panel con «Cerrar», con Esc o haciendo clic en otra barra (el panel cambia a esa reserva).

> **Provisional (UX-1):** el check-in, el check-out, el cobro y el cambio de habitación desde este panel siguen el mismo flujo que desde la ficha de reserva, que está cambiando la tanda UX-1: se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy). En esta guía no se ejecuta ninguna de esas acciones.

### Mover o redimensionar una estancia (arrastrar)

Lo que la pantalla permite hacer con el ratón:

- **Mover** una barra a otra habitación (arrastrándola hacia arriba o abajo) o a otras fechas (hacia los lados). Al soltar, se abre el diálogo **«Mover reserva»** con un bloque «Cambio» que compara «Antes» y «Después» (fechas, noches y habitación) y el botón «Mover»; «Cancelar» lo deja como estaba.
- **Cambiar la entrada o la salida** estirando los bordes de la barra (los asideros aparecen en los extremos). Al soltar, se abre el diálogo **«Cambiar fechas»** con el mismo bloque «Antes / Después» y el botón «Guardar».
- En ambos casos, si hay algo que revisar el diálogo lo avisa antes de confirmar: «El precio no se recalcula al cambiar las fechas: revísalo en la reserva» o «La habitación está bloqueada por mantenimiento».
- Lo que no se puede hacer, la pantalla lo rechaza al soltar con un mensaje y no abre ningún diálogo: «Una reserva en casa solo puede cambiar de habitación» (una alojada no cambia de fechas), «La reserva está cerrada» (salidas hechas, canceladas y no-show no se mueven), «La habitación está bloqueada por mantenimiento o no es vendible» y «La habitación está ocupada actualmente».
- Tras confirmar, aparece una barra verde con «Se puede deshacer el cambio en la reserva RES-… durante 8 s» y el botón «Deshacer». Si lo que has movido es una reserva **alojada**, deshacer es un traslado nuevo: «Volver a la habitación anterior es un nuevo traslado: la habitación intermedia queda sucia y con su tarea de limpieza».
- Para **cancelar un arrastre** antes de soltar, pulsa **Esc**: la barra vuelve a su sitio y no se abre ningún diálogo.

> **Nota:** en esta guía **no se ejecuta** ningún movimiento ni cambio de fechas sobre la demo; los textos de los diálogos son los de la aplicación. Se ha comprobado que Esc cancela el arrastre sin cambiar nada. Hasta que la reserva no la confirmas en el diálogo, no se guarda nada.

### Crear una reserva desde celdas vacías

1. En la fila de una habitación libre, haz clic en la celda del día de llegada y arrastra hasta la celda del día anterior a la salida (dos celdas = dos noches).
2. Al soltar se abre el diálogo **«Nueva reserva»** con el resumen («Hab. 103 · Double · 20–22 sept · 2 noches») y el aviso «Se abrirá el formulario con la habitación, el tipo y las fechas ya rellenos».
3. Pulsa «Crear reserva» para ir al formulario de Menú › Recepción › Nueva reserva con esos datos ya puestos, o «Cancelar» (o Esc) para no hacer nada.

**Resultado esperado.** El diálogo solo prepara el formulario: la reserva no existe hasta que la confirmas allí.

> **Provisional (UX-1):** el formulario de nueva reserva lo está cambiando la tanda UX-1: se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

### Atajos de teclado

Con el foco en una barra (llega con Tab: la barra activa es la única parada de tabulación de la parrilla):

| Teclas | Qué hacen |
|---|---|
| ← → ↑ ↓ | «Moverse entre reservas»: ← → entre barras de la misma fila, ↑ ↓ a la barra de la fila de arriba o de abajo. La selección y el contador «Selección: …» siguen al foco; las flechas nunca abren el detalle. |
| Intro (o Espacio) | «Abrir el detalle» de la barra seleccionada (el panel toma el foco para que Tab llegue a sus botones). |
| Esc | «Cerrar el detalle o cancelar el arrastre». Un segundo Esc quita la selección («Sin selección»). |

Estos tres atajos vienen del diseño de la pantalla y se han comprobado en la demo; la tarjeta de instrucciones no los lista (trae la descripción, cinco pasos y el «Tip» de los colores) y tampoco aparecen en la hoja «Atajos de teclado» (⌘/). La búsqueda global ⌘K y el resto de atajos generales están en [Primeros pasos](00-primeros-pasos.md).

### Colores y vocabulario de estados

El color de cada barra es su estado. La leyenda al pie de la parrilla y el «Tip» de la tarjeta lo resumen: «llega hoy, en casa, sale hoy, confirmada, borrador, no-show o cancelada (las canceladas solo se ven si activas su filtro)». Además del color, los borradores se dibujan con trazo discontinuo, las salidas hechas atenuadas y los no-show punteados y tachados. Recepción está adoptando un vocabulario común de estados en todas sus pantallas; hoy el Live Timeline todavía dice «En casa» y «Salida»:

| Vocabulario común | Hoy en el Live Timeline | Qué significa |
|---|---|---|
| Llega hoy | «Llega hoy» (verde) | Confirmada con llegada hoy y sin check-in todavía |
| En el hotel | «En casa» (verde oscuro) | Con check-in hecho; solo puede cambiar de habitación |
| Sale hoy | «Sale hoy» (ámbar) | Alojada con salida hoy y sin check-out todavía |
| Salida hecha | «Salida» (gris, atenuada) | Check-out hecho; no se mueve |
| No-show | «No-show» (ámbar, tachada) | No se presentó; no se mueve |
| Cancelada | «Cancelada» (rojo) | Solo se dibuja con el chip «Cancelada» activo; no se mueve |
| — | «Confirmada» (azul) | Reserva futura confirmada |
| — | «Borrador» (gris, discontinua) | Reserva sin confirmar |

La leyenda añade «BLOQUEADA · MANTENIMIENTO» para el carril rayado de una habitación bloqueada. Los estados de habitación del punto de color son «Limpia · Sucia · Inspeccionada · Ocupada · Bloqueada»; el vocabulario completo, con «Fuera de servicio», está en [Pisos y mantenimiento](40-pisos-mantenimiento.md).

### Alerta de sobreventa

Si algún día del periodo hay más reservas confirmadas o alojadas que habitaciones vendibles de un tipo, encima de la parrilla aparece un aviso rojo «n días con overbooking» con una línea por día y tipo («<día> · <tipo>: n reservas / n vendibles») y el botón «Ir al día», que coloca el periodo sobre esa fecha. Si además dos reservas se solapan en la misma habitación, el aviso lo cuenta («n solapes en la misma habitación»). En la demo no hay sobreventa, así que no aparece en las capturas; en la fila «Libres» y en las filas de grupo, un día en sobreventa se ve con número negativo y fondo rojo.

### Errores frecuentes en el Live Timeline

| Lo que ves | Qué pasa y qué hacer |
|---|---|
| «Sin reservas que coincidan» | Los filtros o la búsqueda no dejan pasar ninguna reserva del periodo. Pulsa «Limpiar filtros». |
| «Sin reservas en este periodo» («No hay reservas que toquen estas fechas…») | No hay reservas en esas fechas. Pulsa «Ir a hoy» o cambia el periodo. |
| «Sin datos para mostrar» | La propiedad no tiene habitaciones cargadas ni reservas en el periodo. Si es un hotel nuevo, faltan las habitaciones (las da de alta dirección en Configuración › Habitaciones y espacios; la plantilla «Administración de sistema» no ve esa pantalla). |
| «No se pudo cargar el Live Timeline» / «No se pudo actualizar el Live Timeline.» | Fallo de red o del servidor. Pulsa «Actualizar»; si persiste, avisa a quien administra ehotelOS. |
| «Datos desactualizados desde <hora>» con «Reintentar» | La última actualización falló y estás viendo datos anteriores. Pulsa «Reintentar». |
| «Demasiadas peticiones» | Has cargado o actualizado demasiadas veces seguidas (límite por usuario). Espera un minuto y vuelve a intentarlo. |
| «Tu perfil no puede leer reservas» («Pide acceso a dirección para ver el Live Timeline.») | Tu plantilla no incluye la lectura de reservas. No pasa con «Recepción»; si lo ves, tu usuario tiene otra plantilla. |
| «Nombres de huésped no visibles» y barras con «Huésped no visible» | Tu plantilla no puede leer fichas de huésped. Pide acceso a dirección. |
| Barras con «Huésped pendiente» | Los nombres se están cargando. Espera un momento; si no cambia, «Actualizar». |
| Barras con «Sin huésped» | La reserva no tiene huésped principal registrado. Ábrela y añade el huésped desde su ficha. |
| Al soltar una barra: «Una reserva en casa solo puede cambiar de habitación» | Una reserva alojada no cambia de fechas desde aquí; la salida se cambia desde su ficha. |
| Al soltar: «La habitación está ocupada actualmente» / «…bloqueada por mantenimiento o no es vendible» | Esa habitación no está disponible. Elige otra fila. |
| «CIERRE NOCTURNO PENDIENTE · FECHA DE NEGOCIO …» | No es un error: falta ejecutar el cierre del día. Ver [Turno y cierre del día](#turno-y-cierre-del-día). |

## Mi día

**Menú › Hoy › Mi día** (`/hoy`). Tu puesto de mando del día: el saludo con el resumen («Buenos días, <hotel>. Hoy tienes 4 llegadas · 4 salidas · 3 sin habitación.»), la cola de acciones («Todo · Urgente · Hoy · Próximo») y las listas «Llegadas», «Salidas», «En el hotel» y «Sin habitación», con los botones «Crear reserva», «Live Timeline», «Buscar (⌘K)», «Exportar CSV», «Hacer check-in», «Hacer check-out», «Ver folio» y «Abrir incidencia». Hoy la pestaña «Recepción» es la única de Mi día para tu plantilla.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Check-in (entrada de huésped)

Registrar la llegada de un huésped con reserva: comprobar la reserva, asignar habitación limpia, tomar la identidad para el parte de viajeros y, si procede, cobrar o preautorizar. Se hace desde Mi día, desde la ficha de la reserva o desde el panel del Live Timeline («Check-in»).

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Check-out y cobro

Cerrar la estancia: revisar el folio, cobrar el saldo pendiente («Registrar pago»), emitir la factura y marcar la salida. Se hace desde Mi día, desde la ficha de la reserva, desde el panel del Live Timeline («Check-out») o desde Finanzas › Facturación y cobros.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Walk-in

Alojar a un huésped que llega sin reserva. Hoy no hay un flujo específico de walk-in en ehotelOS: se hace creando la reserva (Menú › Recepción › Nueva reserva) y después su check-in; la tanda UX-1 está construyendo el flujo en un solo paso.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Nueva reserva rápida

**Menú › Recepción › Nueva reserva** (`/recepcion/reservas/nueva`), o el botón «+ Nueva reserva» de la barra superior. Formulario por pasos («1. Estancia · 2. Huéspedes · 3. Tarifa · 4. Origen · 5. Pagos · 6. Solicitudes») y la pestaña «Dictar (IA)», que convierte una petición dictada o pegada en un borrador que revisas antes de confirmar. Desde el Live Timeline llegas con los datos ya rellenos seleccionando celdas vacías.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Cambio de habitación

Trasladar a un huésped alojado a otra habitación: desde el panel del Live Timeline («Cambiar habitación»), arrastrando su barra a otra fila, o desde la ficha de la reserva. La habitación que deja queda sucia con su tarea de limpieza.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Lista y detalle de reservas

**Menú › Recepción › Reservas** (`/recepcion/reservas/lista`): la lista con pestañas de estado («Todas · Llegan hoy · En casa · Salen hoy · Futuras · Canceladas»), el «Tablero de habitaciones» y la ficha de cada reserva (`/recepcion/reservas/:id`) con «Resumen · Folio · Actividad · Huéspedes · Documentos» y sus acciones.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Importar reservas

**Menú › Recepción › Reservas › «Importar»** (`/recepcion/reservas/importar`): carga de un fichero CSV o XLSX en cuatro pasos («1. Fichero · 2. Columnas · 3. Revisión · 4. Resultado»), con plantillas descargables. Las cargas grandes (migraciones desde otro programa) las prepara el proveedor técnico con su procedimiento de importación.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Huéspedes y partes de viajeros

**Menú › Recepción › Huéspedes** (`/recepcion/huespedes`): listado, ficha y cronología de cada huésped. **Menú › Cumplimiento › Registro de viajeros** (`/cumplimiento/registro-viajeros`): los partes de entrada, su envío a SES.Hospedajes y su estado («ACEPTADOS», «DATOS INCOMPLETOS»…).

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Mensajes de huéspedes

**Menú › Recepción › Mensajes de huéspedes** (`/recepcion/mensajes`): bandeja de mensajes con borradores de respuesta y métricas de cobertura y tiempo de respuesta.

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Turno y cierre del día

**Menú › Hoy › Turno** (`/hoy/turno`): productividad del turno (check-ins y check-outs hechos, no-shows, cancelaciones). **Menú › Hoy › Cierre del día** (`/hoy/cierre-del-dia`): «Comprobaciones guiadas antes de cerrar: si algo bloquea, te dice qué arreglar y dónde.», la «Fecha de negocio actual» y el botón «Cerrar día», que avanza la fecha de negocio; si una comprobación bloquea («No puedes cerrar todavía: 1 folios abiertos con saldo.») lo dice y ofrece «Cerrar de todos modos». En la demo la fecha de negocio es el 14/09/2026 y hay varios cierres pendientes; por eso el Live Timeline muestra «CIERRE NOCTURNO PENDIENTE».

> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).

## Errores frecuentes

Los del Live Timeline están en su [propia tabla](#errores-frecuentes-en-el-live-timeline). Los de las demás pantallas de recepción se recogen en DOC-2; mientras tanto, los mensajes generales de la aplicación («Sin acceso», «Demasiadas peticiones», «No se pudo cargar…») están explicados en las [preguntas frecuentes](faq.md).

## Qué no hace todavía

- **Pantallas en cambio (UX-1).** Mi día, el check-in rápido, el walk-in, el check-out rápido, el cobro y la nueva reserva rápida se están rediseñando: no hay pasos detallados en esta guía y las tarjetas de ayuda de esas pantallas pueden no coincidir con lo que ves. Se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy).
- **IA sin modelo de lenguaje.** «Dictar (IA)» (etiqueta «ASISTIDO POR IA»), «Mensajes de huéspedes» y «Pendientes de la IA» funcionan hoy por reglas; el «Asistente ehotelOS» lo avisa con la etiqueta «SIN MODELO DE LENGUAJE». Los borradores son deterministas y siempre los confirma una persona.
- **SES.Hospedajes en modo de pruebas.** Los partes de viajeros van a un entorno de pruebas, no a la autoridad; en la demo hay partes en «DATOS INCOMPLETOS».
- **Fecha de negocio atrasada en la demo** (14/09/2026): «LLEGADAS HOY» y «SALIDAS HOY» se calculan con la fecha real, no con la de negocio, hasta que se ejecuten los cierres pendientes.
- **El Live Timeline no recalcula el precio** al mover una reserva de fechas (lo avisa en el diálogo): revisa la tarifa en la ficha de la reserva. Una reserva alojada no cambia de fechas desde la parrilla.
- **Una cancelada sin habitación no se dibuja** ni con el chip «Cancelada» activo; consúltala en la lista de reservas.
- **La pestaña «Folio»** de Facturación y cobros necesita el identificador del folio, no el de la reserva: entra desde «Folio y facturación» (panel del Live Timeline), desde «Abrir folio» o desde la ficha de la reserva.
- **Módulos y pestañas que no ves con «Recepción»:** «Punto de venta» (módulo a activar), «Cupos» de Grupos y eventos, «Ofertas» y «Portal del huésped» de Ventas adicionales, y la pestaña «Correo entrante» de Comunicaciones.
- **«Ver como…»** es solo para cuentas administradoras y no cambia permisos: sirve para ver el menú de un perfil, no para actuar como él.

## Ver también

- [Primeros pasos](00-primeros-pasos.md) — acceso, menú y «Ver como…», ⌘K, cambiar de hotel, ayuda in-app, vocabulario y atajos.
- [Pisos y mantenimiento](40-pisos-mantenimiento.md) — estados de habitación, tareas de limpieza y partes de mantenimiento que ves desde «Limpieza» y «Mantenimiento» en el panel del Live Timeline.
- [Administración y contabilidad](20-administracion.md) — folios, cobros, facturas y VeriFactu.
- [Comercial y revenue](50-comercial-revenue.md) — planes de tarifas, políticas de cancelación, grupos y cupos, canales.
- [Preguntas frecuentes](faq.md) — mensajes de error habituales y su solución.
- [Fichas rápidas](formacion/fichas/README.md) — una página por tarea (las de recepción, marcadas como provisionales).
