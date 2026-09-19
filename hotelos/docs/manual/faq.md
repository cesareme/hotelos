# Preguntas frecuentes · ehotelOS

Dudas habituales y mensajes de error de ehotelOS con su causa y su solución, para todo el personal del hotel. Cada entrada cita el mensaje **tal como aparece en pantalla** (entre comillas latinas «»), explica por qué sale, qué hacer paso a paso y a qué guía ir para el detalle. Si tu mensaje no está aquí, busca en la tabla «Errores frecuentes» de la guía de tu perfil o en el Centro de ayuda («?» › «Qué hago si…») dentro de la aplicación.

Cómo se ha hecho: todos los mensajes se han comprobado en la versión de ehotelOS del 19 de septiembre de 2026, en la aplicación de demostración («Hotel Demo Madrid Centro», datos ficticios) o en el propio código de la aplicación cuando provocarlos habría bloqueado la cuenta o alterado datos (por ejemplo, el bloqueo por intentos de acceso fallidos); las entradas de este segundo grupo lo indican. Las pantallas de recepción que la tanda UX-1 está rediseñando llevan la marca **Provisional (UX-1)**: su respuesta se revisa en DOC-2.

Convenciones: las rutas se escriben «Menú › Categoría › Entrada» y, entre paréntesis, la dirección de la pantalla (`/hoy/live-timeline`); **⌘K** es la búsqueda global (Ctrl+K en Windows y Linux). El significado de los estados de reserva y de habitación está en [Primeros pasos](00-primeros-pasos.md#9-vocabulario-estados-de-una-reserva-y-de-una-habitación).

Índice: [Acceso y sesión](#acceso-y-sesión) · [Menú y permisos](#menú-y-permisos) · [Reservas y huéspedes](#reservas-y-huéspedes) · [Pisos y mantenimiento](#pisos-y-mantenimiento) · [Facturación, cobros y VeriFactu](#facturación-cobros-y-verifactu) · [Contabilidad e importaciones](#contabilidad-e-importaciones) · [Nóminas](#nóminas) · [Tarifas y canales](#tarifas-y-canales) · [Cumplimiento y partes de viajeros](#cumplimiento-y-partes-de-viajeros) · [Informes e IA](#informes-e-ia) · [Rendimiento y mensajes del sistema](#rendimiento-y-mensajes-del-sistema) · [Estado de la demo y qué no funciona todavía](#estado-de-la-demo-y-qué-no-funciona-todavía)

---

## Acceso y sesión

**P:** Al entrar me sale «No se pudo iniciar sesión · Email o contraseña incorrectos.». ¿Qué hago?

**R:** El correo o la contraseña no coinciden con los de tu cuenta. Los dos campos de la pantalla «Inicia sesión» (`/acceso`) son obligatorios y la contraseña distingue mayúsculas de minúsculas.
1. Revisa mayúsculas, espacios al principio o al final y que el correo sea el que te dieron al darte de alta.
2. Si no recuerdas la contraseña, haz clic en «¿Olvidaste tu contraseña?»: pasas a «Recuperar contraseña» (`/acceso/recuperar-contrasena`), escribes tu correo y pulsas «Enviar enlace de recuperación».
3. Si el enlace no llega (en la demostración no hay correo saliente configurado), pide a quien administra ehotelOS en tu hotel que te restablezca la contraseña.

Guía: [Primeros pasos › Errores frecuentes](00-primeros-pasos.md#errores-frecuentes) · [Sistemas › 1. Usuarios y roles](60-sistemas.md#1-usuarios-y-roles).

**P:** Me sale «Cuenta bloqueada temporalmente. Reintenta en N minutos.», «Cuenta bloqueada por múltiples intentos fallidos. Reintenta en 15 min.» o, en la propia pantalla de acceso, «Demasiadas peticiones. Reintenta en unos segundos.».

**R:** Son dos frenos distintos:
- **Cuenta bloqueada**: has fallado la contraseña varias veces seguidas y ehotelOS bloquea la cuenta unos minutos para protegerla. Mientras dura, ni siquiera la contraseña correcta entra, y cada intento nuevo cuenta. Espera el tiempo que indica el mensaje y entra con la contraseña correcta (o usa «¿Olvidaste tu contraseña?»). Si el bloqueo se repite sin que tú hayas fallado, avisa a administración de sistema: alguien puede estar probando con tu correo.
- **Demasiadas peticiones**: la pantalla de acceso admite como mucho 10 intentos por minuto desde la misma conexión (la comparte todo el hotel si salís a Internet por el mismo router). No es un bloqueo de la cuenta: espera un minuto sin pulsar «Iniciar sesión» y prueba una sola vez.

(Textos comprobados en el código: no se han provocado para no bloquear la cuenta de demostración). Guía: [Primeros pasos › Errores frecuentes](00-primeros-pasos.md#errores-frecuentes).

**P:** Estaba trabajando y de repente vuelve a salir «Inicia sesión». ¿Y cómo cierro yo la sesión al acabar el turno?

**R:** Tu sesión ha caducado (pasa sola al cabo de un tiempo, o si cerraste el navegador sin «Recordarme»). Lo que tuvieras a medias sin guardar se pierde: entra de nuevo (ehotelOS te devuelve a la misma dirección en la que estabas), comprueba que el hotel activo de arriba a la izquierda sigue siendo el tuyo y repite la operación pendiente. «Recordarme» solo deja el correo escrito la próxima vez; nunca guarda la contraseña.

Para cerrar la sesión en un ordenador compartido, haz clic en tu nombre arriba a la derecha («Menú de usuario») y después en «Cerrar sesión». Ahí mismo tienes el tema: el botón «Claro» de la barra superior o **⌘,** abren las preferencias de apariencia («Claro · Oscuro · Automático», «Reducir movimiento», «Alto contraste»), que se guardan en ese navegador, no en tu cuenta.

Guía: [Primeros pasos › 2. La pantalla](00-primeros-pasos.md#2-la-pantalla) y [10. Atajos de teclado](00-primeros-pasos.md#10-atajos-de-teclado).

**P:** Soy nueva o nuevo: nada más entrar me pide «Cambia tu contraseña temporal», o el enlace de invitación dice «Invitación no válida, caducada o ya utilizada.».

**R:** Dos situaciones del alta de una cuenta:
- **Contraseña temporal**: tu cuenta se creó con una contraseña provisional y ehotelOS exige una definitiva antes de seguir («Tu cuenta se creó con una contraseña temporal. Debes elegir una definitiva antes de seguir usando ehotelOS.»). Escribe la «Contraseña actual» y una nueva que cumpla la lista de requisitos («La nueva contraseña debe ser distinta de la actual.») y guarda: verás «Contraseña actualizada» y «Por seguridad hemos cerrado todas tus sesiones. Inicia sesión de nuevo con la contraseña nueva.». Si sale «Demasiados intentos. Espera un minuto antes de volver a probar.», espera ese minuto.
- **Invitación no válida**: el enlace ya se usó, caducó o se generó otro después. Pide a quien te invitó que abra «Menú › Configuración › Usuarios y roles» (`/configuracion/usuarios`) y pulse «Reenviar invitación» en tu fila; como el correo saliente puede no estar configurado, la pantalla le muestra el enlace nuevo para que te lo entregue («Copiar enlace»). Si al aceptar ves «Demasiados intentos. Espera un minuto y recarga la página.», espera y recarga.

(Textos comprobados en el código; en la demostración no hay cuentas con contraseña temporal ni invitaciones pendientes). Guía: [Sistemas › 1.1 Invitar a una persona](60-sistemas.md#11-invitar-a-una-persona-recorrido-hasta-el-botón-de-envío).

## Menú y permisos

**P:** Al abrir una pantalla veo «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla. Pide acceso a dirección.».

**R:** La dirección que has abierto (por un enlace, un favorito o escribiéndola) no está en el menú de tu plantilla de usuario. No es un fallo: cada plantilla ve solo sus pantallas.
1. Pulsa «Ir a mi página de inicio» y busca la tarea en tu menú o con ⌘K (solo ofrece lo que puedes abrir).
2. Comprueba en «Qué verás en tu menú» de la guía de tu perfil si esa pantalla es tuya. Si no lo es y la necesitas, pídelo a dirección: quien administra ehotelOS puede cambiar tu plantilla o darte otra asignación en «Usuarios y roles».
3. Si estás usando «Ver como…» (cuentas administradoras), esa pantalla no está en el menú del perfil simulado: pulsa «Salir» en el aviso verde para volver al tuyo.

Comprobado en la demostración simulando «RRHH y nóminas» en `/hoy`, «Pisos» en `/operaciones/pisos/ajustes` y «Recepción» en `/revenue/parrilla`. Guía: [Primeros pasos › 3. «Ver como…»](00-primeros-pasos.md#3-ver-como-simular-el-menú-de-otro-perfil) · [Sistemas › 1. Usuarios y roles](60-sistemas.md#1-usuarios-y-roles).

**P:** Veo «Módulo no activado · Esta función pertenece a un módulo que no está activo en la propiedad.».

**R:** La pantalla existe, pero depende de un módulo que tu hotel no tiene activado (en la demostración pasa con «Menú › Operaciones › Punto de venta», `/operaciones/tpv`, y con su «Cierre de caja»).
1. Si ves el botón «Activar módulo», tu perfil puede activarlo: te lleva a «Menú › Configuración › Módulos e integraciones» (`/configuracion/modulos`) con ese módulo preseleccionado.
2. Si no lo ves, el propio mensaje añade «Pide a dirección que lo active en Configuración › Módulos e integraciones.» (texto comprobado en el código: con la cuenta de demostración, que sí puede activar módulos, la pantalla muestra en su lugar los botones «Activar módulo» e «Ir a mi página de inicio»): pídeselo a dirección o a administración de sistema.
3. Tras activarlo, recarga la página para que la entrada aparezca en el menú; si sigue sin salir, en la pestaña «Salud» de Módulos e integraciones el filtro «Con incidencias» dice qué le falta.

Comprobado en la demostración. Guía: [Sistemas › 3. Módulos e integraciones](60-sistemas.md#3-módulos-e-integraciones).

**P:** En la guía sale una entrada de menú que yo no tengo, o un enlace me lleva a «Página no encontrada · Esta pantalla no existe o fue movida».

**R:** Cuatro causas posibles, por este orden:
1. **Tu plantilla no la incluye.** El pie del menú lateral («n categorías · n entradas») cambia según el perfil; las guías indican con qué plantilla se ve cada pantalla.
2. **El módulo está apagado en tu hotel** (ver la pregunta anterior). Además, si la barra lateral muestra «No se han podido leer los módulos activos: las entradas que dependen de un módulo no se muestran.», ha fallado la carga: recarga la página; si persiste, avisa a administración de sistema.
3. **La estás buscando mal.** El cuadro «Buscar en el menú» de la barra lateral solo filtra el menú (si no encuentra nada dice «Sin resultados · Ninguna entrada del menú coincide con «…».»); para reservas, huéspedes o facturas usa ⌘K, con dos letras como mínimo.
4. **La dirección ha cambiado o está mal escrita.** «Página no encontrada» ofrece «Volver al inicio» y «Buscar…» (abre ⌘K): llega a la pantalla desde el menú y actualiza el favorito con la dirección que muestra la guía.

Guía: [Primeros pasos › 2. La pantalla](00-primeros-pasos.md#2-la-pantalla) y [4. Buscar cualquier cosa con ⌘K](00-primeros-pasos.md#4-buscar-cualquier-cosa-con-k).

**P:** ¿Qué es el aviso verde «Viendo como <Rol> · solo menú», y por qué me ha desaparecido?

**R:** Es el selector «Ver como…» del menú lateral, disponible solo para cuentas administradoras: enseña el menú tal como lo ve otra plantilla (por ejemplo «Viendo como Pisos · solo menú») sin cambiar tus permisos. Desaparece al recargar la página (F5), al escribir una dirección en el navegador o al volver a entrar: vuelve a elegir el perfil en «Ver como…» y muévete por el menú o con ⌘K. Para dejar de simular, pulsa «Salir» en el aviso o elige «Mi menú». Con tu usuario real no lo verás: tu menú es directamente el de tu plantilla.

Guía: [Primeros pasos › 3. «Ver como…»](00-primeros-pasos.md#3-ver-como-simular-el-menú-de-otro-perfil).

**P:** He cambiado de hotel y «no aparecen» mis reservas, una reserva de ⌘K responde «Reserva no encontrada.», o solo veo «Sin rol en esta propiedad · Pide a dirección que te asigne un rol para ver el resto del menú.».

**R:** Todo lo que ves es del hotel activo, el del botón de arriba a la izquierda («Propiedad activa: … Cambiar propiedad»). Si trabajas en varios, comprueba el nombre antes de cada check-in, cobro o reserva; también puedes cambiar con ⌘K › «Cambiar de propiedad». Los resultados de ⌘K y «Reserva no encontrada.» se refieren siempre al hotel activo: cámbialo o busca en «Recepción › Reservas» con la pestaña «Todas» y el filtro «Canceladas». «Sin rol en esta propiedad» (o «Tu sesión no tiene ningún rol con menú en este hotel: pide a dirección o a administración de sistema que te asigne una plantilla.») significa que en ese hotel tu cuenta no tiene plantilla: vuelve al tuyo o pide la asignación desde «Usuarios y roles» › «Invitar con ámbito». En la demostración, «Hotel Demo Tenerife Sur» está vacío (sin habitaciones ni reservas): es normal no ver nada allí.

Guía: [Primeros pasos › 6. Cambiar de hotel](00-primeros-pasos.md#6-cambiar-de-hotel) · [Sistemas › 1. Usuarios y roles](60-sistemas.md#1-usuarios-y-roles).

## Reservas y huéspedes

> **Provisional (UX-1):** Mi día, el check-in rápido, el walk-in, el check-out rápido, el cobro y la nueva reserva rápida se están rediseñando. Las respuestas de este bloque describen los mensajes que existen hoy; los pasos exactos se revisan en DOC-2 junto con la [guía de recepción](70-recepcion.md).

**P:** Pulso «Consultar disponibilidad» o «Siguiente» en «Nueva reserva» y no puedo continuar (o al final sale «No se pudo crear la reserva.»). *Provisional (UX-1).*

**R:** Las causas habituales, en este orden:
1. **Fechas o datos incompletos.** «Fecha de llegada*», «Fecha de salida*» y «Tipo de habitación*» son obligatorios; si la salida no es posterior a la llegada, el sistema responde «La fecha de salida debe ser posterior a la fecha de llegada.». Corrige y repite.
2. **No hay precio para ese tipo y esas fechas.** Sin tarifa BAR guardada para cada día no hay precio: quien lleva revenue la carga en «Menú › Revenue › Parrilla de tarifas» ([Comercial y revenue › 1. Tarifas y parrilla](50-comercial-revenue.md#1-tarifas-y-parrilla)).
3. **La habitación que querías ya no está libre** (otra reserva la ocupó mientras rellenabas): elige otra del mismo tipo en «Recepción › Reservas › Tablero de habitaciones» o deja la asignación para más tarde.
4. **«No se pudo consultar la disponibilidad.»** con «Reintentar»: fallo momentáneo de red o del servidor; reintenta. Si tu sesión ha caducado, vuelve a entrar y crea la reserva de nuevo.

Guía: [Recepción › Nueva reserva rápida](70-recepcion.md#nueva-reserva-rápida) (se completa en DOC-2).

**P:** Al hacer el check-in sale «Indica el motivo del check-in fuera de ventana.» o «Sin habitación válida para el check-in.». *Provisional (UX-1).*

**R:** El primero aparece cuando el check-in se hace antes de la hora o del día previstos: ehotelOS lo permite, pero exige un motivo, que queda en el registro de auditoría. Escríbelo y confirma. El segundo significa que la reserva no tiene asignada una habitación en la que se pueda entrar (sucia, ocupada, bloqueada o fuera de servicio): asigna una habitación «Limpia» o «Inspeccionada» del mismo tipo desde el detalle de la reserva («Asignar habitación») o desde el Tablero de habitaciones y repite el check-in. (Textos comprobados en el código).

Guía: [Recepción › Check-in](70-recepcion.md#check-in-entrada-de-huésped) (se completa en DOC-2) · [Pisos y mantenimiento › Tarea 6](40-pisos-mantenimiento.md#tarea-6--consultar-el-tablero-de-habitaciones-de-recepción).

**P:** En el Live Timeline arrastro una reserva y al soltarla me dice «Una reserva en casa solo puede cambiar de habitación», «La habitación está ocupada actualmente» o «La habitación está bloqueada por mantenimiento o no es vendible».

**R:** Son las reglas de la parrilla, no errores: una reserva alojada no cambia de fechas arrastrando (su salida se cambia desde la ficha de la reserva) y no puedes soltar sobre una habitación ocupada, bloqueada o fuera de servicio. Elige otra fila o pulsa Esc para cancelar el arrastre. El Live Timeline tampoco recalcula el precio al mover fechas (te lo avisa en el diálogo): revisa la tarifa en la ficha.

Guía: [Recepción › Mover o redimensionar una estancia](70-recepcion.md#mover-o-redimensionar-una-estancia-arrastrar).

**P:** El Live Timeline dice «Sin reservas que coincidan», «Sin reservas en este periodo» o «Sin datos para mostrar», o las barras salen como «Huésped no visible», «Huésped pendiente» o «Sin huésped».

**R:** Los tres primeros, por orden: los filtros o la búsqueda no dejan pasar ninguna reserva (pulsa «Limpiar filtros»); no hay reservas en las fechas elegidas («Ir a hoy» o cambia el periodo); o la propiedad no tiene habitaciones cargadas ni reservas (en un hotel nuevo faltan las habitaciones: las da de alta dirección en «Configuración › Habitaciones y espacios», una pantalla que las plantillas de dirección sí ven y «Administración de sistema» no; ver [Dirección › 10](10-direccion.md#10-configurar-el-hotel-propiedad-habitaciones-facturación-y-ajustes)). Las canceladas solo se dibujan si activas su filtro, y una cancelada sin habitación no se dibuja nunca: búscala en la lista de reservas.

En las barras: «Huésped no visible» (y el aviso «Nombres de huésped no visibles») significa que tu plantilla no puede leer fichas de huésped, y «Tu perfil no puede leer reservas» que no incluye la lectura de reservas: pide acceso a dirección (no pasa con «Recepción»). «Huésped pendiente» es solo que los nombres se están cargando (espera o «Actualizar»). «Sin huésped» es una reserva sin huésped principal: ábrela y añádelo desde su ficha.

Guía: [Recepción › Errores frecuentes en el Live Timeline](70-recepcion.md#errores-frecuentes-en-el-live-timeline).

**P:** Tengo una reserva duplicada (mismo huésped, mismas fechas). *Provisional (UX-1).*

**R:** Suele venir de un huésped que reservó por dos vías (teléfono y agencia) o de una reserva creada a mano cuando ya había entrado por un canal.
1. Abre las dos desde «Menú › Recepción › Reservas» y compara el origen (columna de canal) y la política de cancelación.
2. Conserva la que tenga la garantía de pago y cancela la otra desde su detalle («Cancelar reserva», con motivo). Si la duplicada es de una agencia, cancélala también en su extranet para que no genere comisión.
3. Si el huésped ya está alojado, conserva la reserva con el check-in hecho.
4. Comprueba en el folio de la cancelada que no se ha aplicado penalización; si se aplicó por error, corrígela desde el folio (quien tenga permiso de ajuste).

Guía: [Recepción › Lista y detalle de reservas](70-recepcion.md#lista-y-detalle-de-reservas) (se completa en DOC-2).

**P:** Al importar reservas desde un fichero sale «El fichero supera el tamaño admitido (5 MB): pártelo o impórtalo por la herramienta de línea de comandos.», «El fichero supera las 5.000 filas: pártelo.», «No se ha podido leer el fichero: guárdalo como .xlsx normal o como CSV.» o «El fichero no tiene filas de datos o no hay ninguna reserva que crear.».

**R:** La importación por pantalla («Menú › Recepción › Reservas › Importar», `/recepcion/reservas/importar`) está pensada para ficheros pequeños: como mucho 5 MB y 5.000 filas. Parte el fichero por meses, guárdalo como `.xlsx` normal o como CSV y usa «Descargar plantilla CSV» o «Descargar plantilla XLSX» para copiar las cabeceras. Si todas las filas salen omitidas o con errores, el paso «3. Revisión» te dice qué columna falla en cada una. Las cargas grandes (migraciones) las hace administración de sistema por línea de comandos. (Textos comprobados en el código).

Guía: [Recepción › Importar reservas](70-recepcion.md#importar-reservas) (se completa en DOC-2).

**P:** He registrado un cargo o un cobro y el folio no cambia.

**R:** Casi siempre es la pantalla sin refrescar, o el movimiento se hizo en otro folio de la misma reserva (tras dividirlo). Pulsa «Actualizar» en el folio o vuelve a abrirlo desde «Finanzas › Facturación y cobros»; revisa los demás folios en la pestaña «Folio (n)» del detalle de la reserva. Si acaba de ejecutarse el cierre del día, espera a que termine. Si sigue sin aparecer, pide a dirección que compruebe tu plantilla en «Usuarios y roles» (hay categorías de cargo que no todas ven).

Guía: [Administración › 5.1 El centro de facturación](20-administracion.md#51-el-centro-de-facturación).

## Pisos y mantenimiento

**P:** Pulso «Nueva tarea», «Reportar», «+ Nueva orden» o «Nota» y no pasa nada.

**R:** Es un defecto conocido de la versión del 19 de septiembre de 2026, no un problema de permisos: el cajón lateral se abre pero queda oculto por una regla de estilo de la barra lateral compacta. Afecta a todos los formularios laterales de la aplicación (también a «Invitar con ámbito», «Nuevo asiento», «Nuevo grupo», «Nuevo contrato», «Nueva factura recibida», el «Rechazar» de Pendientes de la IA…); las ventanas centradas sí se ven y funcionan («Registrar pago» / «Cobrar», «Devolver», «Crear ejercicio», las confirmaciones). Comprobado hoy en «Menú › Operaciones › Pisos»: el panel «Nueva tarea» se crea sin tamaño en pantalla.
1. Pulsa Esc para cerrar el cajón invisible.
2. Haz desde el tablero lo que no pasa por un cajón: «Marcar limpia», «Empezar», «Completar», «Tomar», «Resuelta».
3. Para lo demás, avisa a administración de sistema (o al proveedor técnico) y, mientras tanto, coordina con el otro departamento de palabra.

Guía: [Pisos y mantenimiento › Qué no hace todavía](40-pisos-mantenimiento.md#qué-no-hace-todavía-pisos) · [Sistemas › Errores frecuentes](60-sistemas.md#errores-frecuentes).

**P:** He pulsado «Marcar limpia» y la habitación sigue sin poderse vender, o no aparece «Inspeccionar».

**R:** Dos situaciones distintas:
- Si la habitación está **ocupada**, «Marcar limpia» la deja «LIMPIA» y «OCUPADA»: solo se libera con la salida del huésped. Es lo esperado.
- Si está **sucia**, no se puede inspeccionar: el sistema responde «Solo se pueden inspeccionar habitaciones limpias.». Márcala limpia primero y después inspecciónala (gobernanta). En el tablero de Pisos solo cuentan como vendibles las «INSPECCIONADAS».
Si además ves «FUERA DE SERVICIO» o «Mantenimiento: blocked», hay un parte abierto: ver la pregunta siguiente. Y si la tarea de limpieza sigue «en curso» después de inspeccionar, ciérrala con «Completar» en el tablero (defecto conocido).

Guía: [Pisos y mantenimiento › Tarea 4 · La inspección](40-pisos-mantenimiento.md#tarea-4--la-inspección-quién-y-cuándo).

**P:** Quiero desbloquear una habitación y me dice «La habitación está bloqueada por una orden de trabajo: resuélvela para liberarla; el bloqueo no se quita a mano.».

**R:** El bloqueo lo puso un parte de mantenimiento y solo se levanta resolviendo ese parte. Abre «Menú › Operaciones › Mantenimiento» (`/operaciones/mantenimiento`), filtra «Bloquean habitación · n», abre la orden y, cuando el trabajo esté hecho, pulsa «Resuelta»: la habitación vuelve a «Sucia» para que Pisos la repase e inspeccione. Si una llegada de hoy tenía esa habitación, recepción le asigna otra del mismo tipo desde el Tablero de habitaciones (o una mejora si no hay); si el bloqueo va a durar días, comercial cierra su venta en «Canales de venta».

(Mensaje comprobado en el código; el flujo, en la guía). Guía: [Pisos y mantenimiento › Tarea 9](40-pisos-mantenimiento.md#tarea-9--crear-un-parte-tomarlo-anotar-bloquear-la-habitación-y-resolverlo).

**P:** Al pulsar un botón del tablero sale «La habitación ya está bloqueada por esta orden.», «La orden ya está resuelta.», «La tarea ya está finalizada.» o «La habitación ha cambiado de estado mientras se procesaba; recarga y vuelve a intentarlo.». Y una orden «urgente» sale como «ALTA» en «Mis averías».

**R:** Los cuatro mensajes significan que otra persona (o tú desde otra pestaña) ya hizo esa acción, o que el estado cambió entre que cargaste la pantalla y pulsaste: no se ha hecho nada dos veces. Pulsa «Actualizar» y comprueba el estado actual antes de repetir. Si en pantalla sale el genérico «No se pudo completar la acción.», actualiza y repite una vez; si persiste, la habitación puede estar bloqueada por mantenimiento.

Lo de «Mis averías» (`/operaciones/mantenimiento/mis-averias`) no es un error: usa su propia escala («Urgente / Alta / Normal / Baja»). Tampoco lo es que una orden resuelta siga en el filtro «Bloquean habitación · n» del tablero: ese filtro incluye las resueltas que bloquearon, mientras que el indicador «BLOQUEAN HABITACIÓN» de arriba solo cuenta las vivas; la habitación ya está liberada.

Guía: [Pisos y mantenimiento › Errores frecuentes (mantenimiento)](40-pisos-mantenimiento.md#errores-frecuentes-mantenimiento) · [Tarea 10 · Mis averías](40-pisos-mantenimiento.md#tarea-10--mis-averías-móvil-y-tablet).

**P:** Soy técnico y no puedo «Bloquear habitación» desde mi orden.

**R:** Bloquear una habitación por avería lo reserva ehotelOS al encargado de mantenimiento o a dirección; con la plantilla «Mantenimiento» (técnico) el servidor lo rechaza con un aviso de permiso (hoy en inglés: «Blocking a room requires manager or maintenance lead confirmation.»). Pide al encargado que la bloquee desde la ficha de la orden, o que te cambien la plantilla si esa es tu función. (Texto comprobado en el código).

Guía: [Pisos y mantenimiento › Errores frecuentes (mantenimiento)](40-pisos-mantenimiento.md#errores-frecuentes-mantenimiento) · [Sistemas › 1.2 Las plantillas que puedes invitar](60-sistemas.md#12-las-plantillas-que-puedes-invitar).

## Facturación, cobros y VeriFactu

**P:** En la pestaña «Folio» de Facturación y cobros sale «No se pudo cargar el folio · Folio no encontrado.» con «Reintentar».

**R:** La dirección de esa pestaña lleva el identificador del **folio**, no el de la reserva; con el de la reserva siempre falla (comprobado en la demostración). Entra por «Abrir folio» desde «Menú › Finanzas › Facturación y cobros» (`/finanzas/facturacion`), desde la pestaña «Folio (n)» del detalle de la reserva o desde «Folio y facturación» en el panel del Live Timeline. «Reintentar» solo sirve si el fallo fue de red.

Guía: [Administración › 5.2 Abrir el folio completo](20-administracion.md#52-abrir-el-folio-completo).

**P:** Al cobrar veo «Tarjeta en línea y enlace de pago no disponibles: pasarela no configurada.».

**R:** No hay proveedor de pagos en línea conectado a ehotelOS (en la demostración no lo hay). Registra el cobro con los métodos manuales de la ventana «Registrar pago» / «Cobrar»: efectivo, datáfono (tarjeta) o transferencia. El «Enlace de pago» y la «Tarjeta en línea» se activan cuando dirección financiera o dirección configuran la pasarela en «Configuración › Facturación y pagos», pestaña «Pagos» (una pantalla de las plantillas de finanzas y dirección; «Administración de sistema» no la ve ni tiene claves financieras), con los datos del proveedor de pagos que aporte el proveedor técnico. (Texto comprobado en el código y en la guía de administración).

Guía: [Administración › 6.1 Registrar un cobro en el folio](20-administracion.md#61-registrar-un-cobro-en-el-folio) · [10.4 Facturación y pagos](20-administracion.md#104-configuración--facturación-y-pagos-series-y-pasarela).

**P:** Al pulsar «Crear borrador» sale «El tipo impositivo implícito (17,85 %) no es un tipo de IVA válido (21 o 10 %). Indica las líneas con su tipo o categoría, o ajusta el total y los impuestos.».

**R:** El folio mezcla conceptos con distinto IVA (alojamiento al 10 %, parking o minibar al 21 %) y el borrador no puede repartirlos solo desde el total. Pulsa «Añadir línea» y da a cada concepto su «Categoría fiscal»; después vuelve a «Crear borrador». La cifra del mensaje cambia según el folio.

Guía: [Administración › 5.3 Crear el borrador de factura](20-administracion.md#53-crear-el-borrador-de-factura-sin-emitir).

**P:** No puedo emitir: «No se puede emitir la factura: impuestos sin configurar (…)» / «TAX_NOT_CONFIGURED», o al intentar arreglarlo «No tienes permiso para modificar la configuración fiscal (compliance.configure).».

**R:** Faltan tipos de IVA vigentes para alojamiento, restauración y servicios generales en «Menú › Cumplimiento › Impuestos» (`/cumplimiento/impuestos`, botón «Editar» por concepto). Solo pueden cambiarlos las plantillas con permiso fiscal (Cumplimiento, Dirección financiera); si ves el aviso de permiso, pídeselo a ellas. Hasta entonces la factura se queda en borrador. (Textos comprobados en el código).

Guía: [Administración › 4.4 Tipos de IVA por concepto y tasa turística](20-administracion.md#44-tipos-de-iva-por-concepto-y-tasa-turística).

**P:** ¿Puedo corregir una factura ya emitida? Al añadir un cargo sale «El folio está cerrado; no admite más cargos ni movimientos.», y al devolver un cobro «Este registro ya es una devolución; no se puede devolver una devolución.» o «El cobro ya ha sido devuelto por otro usuario.».

**R:** Una factura emitida no se edita: se anula o se rectifica (VeriFactu encadena cada factura con la anterior). El folio se cierra al hacer el check-out o al facturarlo: si el huésped debe algo más, ábrele un folio nuevo desde su reserva; si la factura está mal, ve a «Facturación y cobros › Rectificativas» y elige el tipo (hoy la modalidad «Ajuste de líneas por diferencias (I)» está bloqueada con aviso: usa la anulación completa o la sustitución). Para los cobros, «Devolver» solo admite cobros originales (no devoluciones) y cada cobro se devuelve una sola vez: si otra persona ya lo devolvió, «Actualizar» te lo mostrará. El importe a devolver debe ser positivo y nunca mayor que el cobro. (Textos comprobados en el código).

Guía: [Administración › 5.4 Emitir, descargar, enviar y anular](20-administracion.md#54-emitir-descargar-enviar-y-anular-describir) y [5.5 Rectificativas](20-administracion.md#55-rectificativas-describir-sin-ejecutar).

**P:** En «Envíos a autoridades» todo está en «Modo de pruebas» y las facturas salen «SIMULADO · NO ENVIADO». ¿Y los modelos de la AEAT se presentan solos?

**R:** El modo de pruebas es el estado normal hasta que el hotel active el modo producción. El aviso lo dice: «Los envíos marcados como «Simulado» no han salido del sistema: no se han remitido a la Administración. El envío real requiere configurar el modo producción y el certificado del establecimiento.». Las facturas sí se emiten con su huella y su código QR, pero nada llega a la AEAT ni al Ministerio del Interior; lo activa el proveedor técnico con el certificado del hotel y la declaración del software completa.

Los modelos (303, 390, 347, 111, 115, 180) tampoco se presentan solos en ningún modo: «Menú › Cumplimiento › Modelos AEAT» (`/cumplimiento/modelos-aeat`) los calcula desde los libros registro y te da el resumen por casilla («Descargar resumen», «Ocultar casillas a cero») para presentarlo **a mano** en la sede electrónica. Si los libros no cuadran con el diario («COTEJO CON EL DIARIO · No cuadra»), revisa los avisos de la pantalla; el botón «Reconstruir libros» de «Libros de IVA», cuando aparece, regenera los libros desde los documentos (en la demostración no se muestra hoy; pídelo al proveedor técnico si tu sociedad lo necesita).

Comprobado en la demostración (`/cumplimiento/envios`). Guía: [Administración › 5.7 VeriFactu y envíos a autoridades](20-administracion.md#57-verifactu-y-envíos-a-autoridades-plantilla-cumplimiento-contabilidad-o-dirección-financiera) · [4. Libros de IVA y modelos de la AEAT](20-administracion.md#4-libros-de-iva-y-modelos-de-la-aeat-plantilla-contabilidad-dirección-financiera-o-cumplimiento).

**P:** La AEAT ha rechazado una factura (VeriFactu). ¿Qué hago?

**R:** En «Menú › Cumplimiento › VeriFactu» (`/cumplimiento/verifactu`) el contador «RECHAZADAS» y «Ver envíos» te llevan al envío con el motivo; la misma alerta llega a «Bandeja de cumplimiento». Los motivos habituales son datos fiscales del cliente incorrectos (NIF que no valida, razón social vacía), datos del emisor incompletos, certificado caducado o factura duplicada.
1. Abre el envío («Ver detalle») y lee el motivo.
2. Si es un dato del cliente, corrígelo en su ficha («Recepción › Huéspedes») y pulsa «Reintentar» en el envío.
3. Si es del emisor o del certificado, corrígelo en «Configuración › Contabilidad y fiscal» (o pídelo a quien tenga el permiso) y reintenta.
4. Si la factura ya se entregó con datos erróneos, emite una rectificativa: nunca modifiques la original.
En modo de pruebas no hay rechazos reales: solo los verás con el modo producción activo.

Guía: [Administración › 5.7](20-administracion.md#57-verifactu-y-envíos-a-autoridades-plantilla-cumplimiento-contabilidad-o-dirección-financiera).

**P:** En «Cierre del día» sale «No puedes cerrar todavía: 1 folios abiertos con saldo.» (y en el Live Timeline «CIERRE NOCTURNO PENDIENTE · FECHA DE NEGOCIO …»).

**R:** El cierre pasa nueve comprobaciones y una de ellas bloquea: hay folios con saldo sin cobrar. La pantalla (`/hoy/cierre-del-dia`) te dice cuál con «BLOQUEA · n».
1. Pulsa «Ver 1 elemento» (o «Ver n elementos») y cobra o regulariza ese folio; «Abrir cola operativa» reúne todo lo pendiente de recepción.
2. Los avisos («ATENCIÓN · n», por ejemplo «1 factura en borrador. Emítela antes del cierre…» con «Ver facturas») no bloquean, pero conviene resolverlos.
3. Cuando el estado sea «Puedes cerrar el día», pulsa «Cerrar día» (dirección o auditoría nocturna). «Cerrar de todos modos» existe para emergencias: exige un motivo y queda auditado.
La etiqueta del Live Timeline no es un error: recuerda que falta ejecutar el cierre. En la demostración la fecha de negocio sigue en 14/09/2026 porque no se ha cerrado ningún día.

Comprobado en la demostración. Guía: [Dirección › 6. Cierre del día y Turno](10-direccion.md#6-cierre-del-día-y-turno) · [Administración › 6.2](20-administracion.md#62-cierre-del-día-describir-no-ejecutar).

## Contabilidad e importaciones

**P:** En Contabilidad › Ajustes sale «CHART_NOT_PROVISIONED».

**R:** La sociedad todavía no tiene plan de cuentas cargado (pasa en una sociedad recién creada). Sin él no hay diario ni asientos. Lo provisiona quien administra ehotelOS desde la estructura societaria; una vez cargado verás «Cuentas del PGC de Pymes con las subcuentas hoteleras» en «Plan de cuentas».

Guía: [Administración › 1. Plan contable y ejercicios](20-administracion.md#1-plan-contable-y-ejercicios-plantilla-contabilidad-o-dirección-financiera) · [Sistemas › 5.5 Estructura societaria](60-sistemas.md#55-estructura-societaria).

**P:** En «Cierre de ejercicio» leo «Sin ejercicio, los asientos se numeran por año natural y no se puede cerrar ni regularizar. Crea el primero con su código y sus fechas.».

**R:** No hay ningún ejercicio fiscal definido. Los asientos funcionan igual, pero no podrás regularizar ni cerrar el año. Pulsa «Crear ejercicio»: se abre la ventana «Nuevo ejercicio fiscal» con «Código*», «Inicio*» y «Fin*» y los botones «Cancelar» y «Crear» (es una ventana centrada, se ve y funciona; no le afecta el defecto de los cajones laterales). Rellena código y fechas de acuerdo con tu gestoría y pulsa «Crear». En la demostración no lo hagas: el ejercicio no se borra después.

Guía: [Administración › 1.5 Ejercicios fiscales](20-administracion.md#15-ejercicios-fiscales-describir-sin-cerrar).

**P:** En «Nuevo asiento» el botón «Contabilizar…» está apagado y el bloque «Antes de contabilizar» dice «El concepto del asiento es obligatorio.».

**R:** El asiento no se contabiliza hasta que cuadra (debe = haber) y no falta ningún dato: «Concepto*», fecha, al menos dos líneas con cuenta e importe. Rellena lo que marca el bloque y el botón se activa solo. Un asiento contabilizado no se edita: se anula con «Anular» (queda el asiento inverso).

Guía: [Administración › 2.2 Registrar un asiento manual](20-administracion.md#22-registrar-un-asiento-manual).

**P:** Al importar desde Sage 200: «El XML «Datos contables» de Sage 200 aún no se puede importar: exporta a Excel o CSV.», o el fichero es demasiado grande.

**R:** El asistente «Importar desde Sage 200» (`/finanzas/contabilidad/importar-sage200`) admite Excel, CSV y el formato canónico («Descargar plantilla canónica»), no el XML. Desde Sage 200 exporta con el «Gestor de Exportación a Excel». Por pantalla, cada lote tiene tope de 20 MB y 20.000 asientos: trocea por meses; las cargas mayores las hace administración de sistema por línea de comandos. Cada fichero es un lote: el mismo fichero no se importa dos veces, y revertir un lote deshace solo sus asientos.

Guía: [Administración › 3. Importar desde Sage 200](20-administracion.md#3-importar-desde-sage-200-plantilla-contabilidad-o-dirección-financiera).

**P:** Me salen mensajes con nombres técnicos: «reason es obligatorio: indica el motivo del reverso.» al revertir un lote, o «to debe ser igual o posterior a from.», «El parámetro to debe ser posterior a from.» y «Las fechas deben tener el formato AAAA-MM-DD.» en un filtro de fechas.

**R:** Vienen del servidor con el nombre técnico del campo. «reason» es el motivo: toda reversión (Sage 200, coste de personal, corte de OPERA) exige un motivo escrito, que se guarda con el asiento inverso y en el registro de auditoría; escríbelo en la ventana de confirmación y vuelve a pulsar «Revertir». «from» es el «Desde» y «to» el «Hasta»: el rango está al revés o una fecha está mal escrita; corrige (elige primero el «Desde») y vuelve a aplicar. (Textos comprobados en el código).

Guía: [Administración › 2.1 Consultar el diario](20-administracion.md#21-consultar-el-diario) · [RRHH › 4.3 Revertir un lote](30-rrhh.md#43-revertir-un-lote).

**P:** Otros mensajes de Contabilidad que puedo ver al asentar, anular o cerrar. ¿Qué significan?

**R:** Son avisos de validación del servidor (textos comprobados en el código de la aplicación; la pantalla los muestra bajo el formulario o en la ventana de confirmación). Corrige lo que indica cada uno y repite la acción:

| Mensaje | Causa | Qué hacer |
|---|---|---|
| «Un asiento necesita al menos dos líneas.» | Solo has rellenado una línea | Añade la contrapartida con «Añadir línea» |
| «Cada línea lleva importe en el debe o en el haber, no en ambos.» | Una línea tiene las dos columnas rellenas | Deja una de las dos a cero |
| «Las líneas del asiento no admiten importes negativos: anota el importe en la columna contraria.» | Has escrito un negativo | Pásalo a la otra columna en positivo |
| «La cuenta es una cabecera del plan: elige una subcuenta imputable.» | Has elegido un grupo o subgrupo (por ejemplo «430») | Elige la subcuenta con la etiqueta «IMPUTABLE» (por ejemplo «4300») |
| «La cuenta no existe en el plan contable de la organización.» / «El código de cuenta no es válido.» | Código mal escrito o no dado de alta | Búscala en «Plan de cuentas» o créala con «Nueva cuenta» |
| «Ya existe una cuenta con ese código.» | Al crear una cuenta repites el código | Cambia el código o edita la existente |
| «El periodo contable de esa fecha está cerrado: reábrelo o cambia la fecha del asiento.» / «El ejercicio de esa fecha está cerrado: reábrelo en Contabilidad › Cierre de ejercicio antes de asentar.» | La fecha contable cae en un periodo o ejercicio cerrado | Usa una fecha del periodo abierto o pide a dirección financiera la reapertura (genera reversos) |
| «Indica el motivo de la anulación.» | «Anular» sin motivo | Escribe el «Motivo*» |
| «Un asiento de anulación no se puede anular de nuevo.» / «El asiento ya está anulado.» | Intentas anular un reverso o repetir una anulación | Nada que hacer: consulta el diario |
| «Un borrador no se anula: se descarta.» | «Anular» sobre un borrador | Descártalo desde su fila |
| «Indica el hotel o la oficina central: los gastos, ingresos, retenciones y nóminas llevan siempre un centro de trabajo.» | Línea de los grupos 6 o 7 sin «Centro de trabajo» | Elige el hotel en «Centro de trabajo» |
| «Hay un cierre del día en curso: espera a que termine.» | Alguien está ejecutando «Cerrar día» | Espera un minuto y repite |
| «El folio ha cambiado desde que se preparó el borrador: revisa la factura antes de emitirla.» | Se añadió o cobró algo en el folio después de crear el borrador | Abre el borrador, revisa las líneas y vuelve a crearlo si hace falta |
| «La serie está cerrada y no vuelve a numerar: abre otra serie con distinto prefijo. Nunca se renumera.» | Emites en una serie cerrada | Abre otra serie en Configuración › Facturación y pagos |
| «Otro centro de la misma sociedad ya usa ese prefijo de serie este año: elige otro prefijo…» | Dos hoteles con el mismo prefijo | Cambia el prefijo de la serie (por ejemplo con el código del centro) |
| «Ese formato de exportación aún no está disponible: usa el CSV universal de asientos.» | Formato A3 en «Exportar a gestoría» | Elige «CSV universal de asientos» |

Guía: [Administración › 2. Diario y asientos](20-administracion.md#2-diario-y-asientos-plantilla-contabilidad-o-dirección-financiera) · [9.3 Exportar a la gestoría](20-administracion.md#93-exportar-a-la-gestoría).

**P:** Mensajes al registrar una factura recibida, un gasto o un elemento de inmovilizado: «Ya existe un proveedor con ese NIF.», «El total impreso no coincide con la suma de las líneas.», «No se puede amortizar un mes futuro.»…

**R:** Validaciones de «Proveedores y gastos» (textos comprobados en el código):

| Mensaje | Qué hacer |
|---|---|
| «El NIF o CIF del proveedor no es válido.» / «Ya existe un proveedor con ese NIF.» | Revisa el dígito de control; si el proveedor ya existe, elígelo del directorio en vez de crearlo |
| «El IBAN no es válido.» | Comprueba los dígitos del IBAN (módulo 97) |
| «Indica el proveedor o su nombre.» / «El NIF del proveedor es obligatorio para deducir el IVA.» / «Sin NIF del proveedor el IVA del gasto no es deducible.» | Elige un proveedor del directorio o escribe nombre y NIF; sin NIF la factura se guarda pero no deduce IVA ni se contabiliza |
| «Ya existe una factura de ese proveedor con el mismo número.» | Factura duplicada: búscala en «Facturas recibidas» antes de volver a registrarla |
| «La cuenta de gasto debe ser una subcuenta del grupo 6 (o 20x/21x para bienes de inversión).» | Cambia la «Cuenta*» de la línea |
| «Tipo de IVA no admitido: usa 21, 10, 4, 7, 3, 2 o 0.» / «La cuota de IVA de la línea no coincide con la base por el tipo.» | Corrige el tipo o la «Cuota impresa» de la línea |
| «El total impreso no coincide con la suma de las líneas.» | Revisa las bases, los tipos y la retención hasta que «Total impreso en la factura» cuadre |
| «La fecha de vencimiento no puede ser anterior a la de emisión.» / «La fecha de pago no puede ser anterior a la de emisión.» | Corrige las fechas |
| «El adjunto debe ser un PDF, JPEG o PNG.» / «El adjunto supera los 512 KiB.» | Cambia el formato o reduce el tamaño del fichero |
| «El estado actual del documento no admite esa acción.» | La factura ya está aprobada, contabilizada, pagada o anulada; pulsa «Actualizar» |
| «El elemento no tiene categoría, coeficiente o cuentas: complétalo antes de amortizar.» / «El coeficiente supera el máximo de las tablas…» | Completa la ficha del elemento en «Inmovilizado» con un coeficiente dentro de las tablas |
| «No se puede amortizar un mes futuro.» / «Faltan meses anteriores por contabilizar: las corridas van mes a mes, sin huecos.» / «Hay una corrida posterior contabilizada: revierte primero la más reciente.» | Contabiliza los meses en orden desde «Amortización mensual»; para corregir, revierte de la más reciente a la más antigua |

Guía: [Administración › 8.3 Proveedores, facturas recibidas y gastos](20-administracion.md#83-proveedores-facturas-recibidas-y-gastos-plantilla-administración-de-hotel-o-superior).

## Nóminas

**P:** «Nóminas» dice «Aún no hay contratos», al calcular el periodo sale todo a 0,00 €, o «Personal y turnos» me responde «Módulo no activado».

**R:** Sin contratos no hay nada que calcular: el periodo se calcula vacío. Da de alta cada contrato con «Nuevo contrato» (necesita una ficha de personal; si el identificador no existe verás «No se pudo guardar · Perfil de empleado no encontrado.»). En la versión actual el cajón «Nuevo contrato» queda oculto por el defecto de estilos y no hay pantalla de alta de fichas de personal: pide ambas cosas a administración de sistema. «Personal y turnos» depende del módulo de personal (activo en la demostración): si en tu hotel está apagado, lo activa administración de sistema en «Módulos e integraciones». Y si ves «Necesitas el permiso de gestión de nóminas…», tu usuario solo tiene lectura: pide la plantilla «RRHH y nóminas» completa. Con esa plantilla «Mi día» (`/hoy`) responde «Sin acceso»: tu página de inicio es «Nóminas».

Comprobado en la demostración («Contratos (0)»). Guía: [RRHH › 2. Contratos](30-rrhh.md#2-contratos-nuevo-contrato) · [6. Personal y turnos](30-rrhh.md#6-personal-y-turnos).

**P:** Al exportar o pagar sale «Calcula el periodo de nómina antes de exportarlo o pagarlo.», «El periodo debe tener el formato AAAA-MM.» o «No se pudo abrir el periodo · El periodo 2026-09 ya existe.».

**R:** Por orden: el periodo está abierto sin calcular (o su líquido es 0,00 €), así que en la fila del periodo pulsa «Calcular» (o «Recalcular» si ya se calculó) y confirma «Calcular y contabilizar» antes de pulsar «Exportar» y confirmar «Exportar y descargar»; el mes se escribe como `2026-10`; y el periodo ya estaba abierto: búscalo en la pestaña «Periodos». Si al pagar ves «El registro de nómina 2026-09 no está aprobado.», falta la aprobación de dirección (separación de funciones), que hoy no tiene botón en la pantalla.

Guía: [RRHH › 3. Periodos](30-rrhh.md#3-periodos-abrir-calcular-exportar-y-pagar).

**P:** Al importar el informe de coste de personal sale «Cabecera inválida: faltan las columnas «…»», «Este informe ya está importado» o «Hay centros y meses ya contabilizados».

**R:** La primera línea del CSV no es la esperada (copia la cabecera exacta de la guía, separador «;»); el mismo fichero ya se importó (un lote = un fichero, no se duplica); o algún centro × mes ya está contabilizado por otro lote. Si es una corrección, activa «Sustituir los lotes anteriores…» y reimporta el rango completo; si no, importa solo los meses nuevos. Los ficheros de más de 1 MB o en codificación latin1 solo entran por línea de comandos.

Otros mensajes de Nóminas que puedes ver (textos comprobados en el código): «Ya existe un periodo de nómina con ese código.» (el mes ya está en «Periodos»), «El periodo de nómina está cerrado.» / «El periodo de nómina ya está pagado.» (no admite recálculo: abre el mes siguiente), «El periodo de nómina no tiene importe neto que pagar.» (sin contratos o líquido 0,00 €), «Ese informe ya está importado con el mismo contenido: revierte el lote anterior o marca «Sustituir los lotes anteriores» para reemplazarlo.», «Algún centro y mes del informe ya está contabilizado por otro lote…», «Hay centros del informe sin equivalencia en el ERP: asigna cada etiqueta a un centro de trabajo antes de contabilizar.» y «Hay departamentos del informe sin equivalencia USALI…» (rellena las equivalencias en la previsualización), «El fichero pertenece a otra organización…» (informe de otra sociedad) y «La importación ya está contabilizada: no se contabiliza dos veces.».

Guía: [RRHH › 4. Importar el coste de personal](30-rrhh.md#4-importar-el-coste-de-personal-informe-agregado-de-rrhh).

## Tarifas y canales

**P:** La parrilla de tarifas tiene celdas vacías y recepción no consigue precio para esas fechas (o a mí la parrilla me responde «No tienes permiso para ver las tarifas de esta propiedad (revenue.read).»).

**R:** No hay tarifa BAR guardada para ese tipo de habitación y ese día; sin BAR por día no hay precio, ni para recepción ni para los canales. En «Menú › Revenue › Parrilla de tarifas» (`/revenue/parrilla`) elige el rango, pulsa «Edición masiva…», modo «Valor fijo», escribe el precio, indica el «Motivo del cambio» (obligatorio: sin él «Aplicar al borrador» sigue apagado), «Aplicar al borrador» y después «Guardar sin enviar a canales» o «Revisar y publicar». El estado «Sin cambios pendientes» de la barra indica que no queda nada por guardar. El aviso de permiso significa que tu plantilla no incluye la lectura de tarifas (la tienen «Revenue corporativo» y dirección; recepción ve «Planes de tarifas» y «Políticas de cancelación», pero no la parrilla): pide a dirección la plantilla adecuada si esa es tu función.

Guía: [Comercial y revenue › 1.2 Edición masiva con motivo](50-comercial-revenue.md#12-edición-masiva-con-motivo) · [Qué verás en tu menú](50-comercial-revenue.md#qué-verás-en-tu-menú).

**P:** Al guardar sale «Ninguna celda se aplicó: 1 conflicto … la celda cambió desde que se cargó» o «La parrilla de esta propiedad está siendo modificada por otra petición. Reintenta en unos segundos.»; al revertir desde «Historial», «La parrilla cambió después de este asiento: revierte primero los asientos posteriores o fuerza la reversión.».

**R:** Otra persona guardó esa misma celda después de que abrieras la parrilla (conflicto), o está guardando ahora mismo (ocupada). En el conflicto, la parrilla recarga el valor actual y conserva tu borrador: revísalo y vuelve a guardar. Si está ocupada, espera unos segundos y repite; no se ha perdido nada. En el historial, entradas posteriores tocaron alguna de esas celdas: o reviertes primero esas entradas (de la más reciente a la más antigua) o pulsas «Forzar reversión», que pisa los valores actuales de las celdas afectadas; hazlo solo si estás segura o seguro. Toda reversión queda como una entrada nueva del historial.

Guía: [Comercial y revenue › 1.5 Historial y reversión](50-comercial-revenue.md#15-historial-y-reversión) · [Errores frecuentes](50-comercial-revenue.md#errores-frecuentes).

**P:** En «Revisar y publicar» el botón dice «Publicar en 0 canales» y el canal muestra «0 celdas».

**R:** Ese producto (tipo de habitación × plan) no tiene correspondencia activa en ningún canal, así que no hay nada que enviar. Ve a «Menú › Comercial › Canales de venta › Correspondencias» (`/comercial/canales/correspondencias`), completa los códigos externos del tipo y del plan y marca «Activo»; después vuelve a publicar. Si solo querías guardar, usa «Guardar sin enviar a canales». En la demostración solo «Double · BAR» tiene correspondencia.

Guía: [Comercial y revenue › 5.1 Correspondencias](50-comercial-revenue.md#51-correspondencias).

**P:** Un canal aparece desconectado o su registro de entregas está lleno de filas con «Reintentar».

**R:** En «Canales de venta» (`/comercial/canales`) pulsa «Probar conexión» en el canal; si falla por credenciales, vuelve a autorizar la conexión desde la extranet de la agencia y pulsa «Sustituir» para guardar las nuevas. Revisa «Correspondencias» (cada tipo y cada plan con su equivalente) y reintenta las entregas rechazadas con «Reintentar» o «Drenar ahora». Mientras esté caído, vigila la disponibilidad a mano para evitar sobreventas. En la demostración los canales trabajan contra un simulador («modo simulado o de pruebas; el modo real exige credenciales»): las filas con «Reintentar» son parte de los datos de demo. Si sigue desconectado más de una hora sin causa visible, avisa al proveedor técnico.

Guía: [Comercial y revenue › 5. Canales de venta](50-comercial-revenue.md#5-canales-de-venta).

**P:** Al crear un grupo o un evento sale «roomingListDueDate must be on or before cutOffDate.» o «La fecha debe estar dentro de la estancia del grupo (…)», y «Nuevo cupo» está apagado.

**R:** En el grupo, la fecha de entrega de la rooming list debe ser igual o anterior a la fecha límite (cut-off): ajústala. El evento se asocia al grupo de la fila desde la que lo creas y su fecha debe caer entre la llegada y la salida de ese grupo. «Nuevo cupo» se activa cuando existe al menos un tour operador: créalo antes con «Nuevo TT.OO.» en la pestaña «Cupos». Estos formularios son cajones laterales, hoy ocultos por el defecto de estilos.

Guía: [Comercial y revenue › 6. Grupos, eventos y cupos](50-comercial-revenue.md#6-grupos-eventos-y-cupos).

**P:** En «Reputación y calidad» el índice sale «—» con «8 reseñas · insuficiente (mínimo 10)».

**R:** El índice de reputación a 30 días exige al menos 10 reseñas en la ventana; con menos, se muestra «—», pero la bandeja, las fuentes y los casos funcionan igual. Importa más reseñas con «Importar CSV» o conecta fuentes («Configurar fuentes»); en la demostración las fuentes externas no tienen credenciales y el análisis se hace por reglas.

Comprobado en la demostración. Guía: [Comercial y revenue › 7. Reputación y encuestas](50-comercial-revenue.md#7-reputación-y-encuestas).

## Cumplimiento y partes de viajeros

**P:** En «Registro de viajeros» los partes están en «DATOS INCOMPLETOS» (o el conector en «CONFIGURACIÓN PENDIENTE»).

**R:** Al parte le faltan datos obligatorios del viajero (documento, fecha de nacimiento, nacionalidad, teléfono o correo, firma del contrato…) o al conector le faltan los códigos de establecimiento y arrendador del Ministerio del Interior.
1. Abre «Menú › Cumplimiento › Registro de viajeros» (`/cumplimiento/registro-viajeros`), pestaña «Partes de entrada», y completa los campos marcados en el parte (o en la ficha del huésped).
2. Pulsa «Reintentar envío» en la fila.
3. Si el problema es el conector, pestaña «SES.Hospedajes» › «Conector SES.Hospedajes»: los códigos los aporta dirección y los configura administración de sistema.
En la demostración los 7 partes están incompletos a propósito y el envío va a un entorno de pruebas.

Comprobado en la demostración. Guía: [Administración › 7. Partes de viajeros](20-administracion.md#7-partes-de-viajeros-plantilla-administración-de-hotel-o-superior).

**P:** Cada vez que entro sale la franja «Falta 1 comprobación para poner la propiedad en marcha.».

**R:** La lista de «Salida en vivo» de la puesta en marcha tiene una comprobación bloqueante; en la demostración es el registro de viajeros (SES.Hospedajes) en modo de pruebas, así que la franja es permanente. «Ahora no» la oculta solo durante tu sesión; desaparece de verdad cuando dirección o administración de sistema resuelven la comprobación en «Menú › Configuración › Puesta en marcha» (`/configuracion/puesta-en-marcha`), pestaña «Salida en vivo», y aprueban la salida en vivo (permiso «property.go_live»). No afecta a tu trabajo diario.

Comprobado en la demostración (el texto dice «Faltan» aunque sea una sola comprobación). Guía: [Dirección › 9. Personas y puesta en marcha](10-direccion.md#9-personas-y-puesta-en-marcha-visión-de-dirección) · [Sistemas › 5.1 Puesta en marcha](60-sistemas.md#51-puesta-en-marcha).

**P:** Un huésped dice que el portal del huésped le responde «Sesión del portal del huésped no válida o caducada.».

**R:** El huésped entra en el portal con su correo y su reserva, recibe por correo un enlace de acceso y la sesión que abre ese enlace dura 24 horas: pasado ese tiempo, o si el enlace es antiguo, sale este aviso y debe pedir uno nuevo desde el propio portal. Si el correo saliente del hotel no está configurado (es el caso de la demostración), el enlace no llega: avisa a administración de sistema. El portal depende del módulo «Portal del huésped» («Ventas adicionales»); el check-in en línea está apagado en la demostración. (Texto comprobado en el código).

Guía: [Comercial y revenue › 8.2 Ventas adicionales, ofertas y portal del huésped](50-comercial-revenue.md#82-ventas-adicionales-ofertas-y-portal-del-huésped).

## Informes e IA

**P:** El «Asistente ehotelOS» lleva la etiqueta «SIN MODELO DE LENGUAJE» y «Dictar (IA)» o los borradores de mensajes responden de forma muy básica.

**R:** No hay proveedor de modelo de lenguaje configurado. En «Menú › Configuración › Inteligencia artificial» (`/configuracion/ia`) la comprobación «Proveedor de IA» lo dice: «Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.» (estado «REQUIERE ATENCIÓN», «5 de 6 comprobaciones correctas»). El asistente contesta con reglas sobre tus datos: algunas preguntas sugeridas funcionan («¿Cuál es la ocupación ahora mismo?» responde con la ocupación del día y cita la fuente consultada), pero otras no se enrutan a ninguna herramienta (en la demostración, «¿Cuántas llegadas tengo hoy?» devuelve «No he sabido enrutar tu pregunta a una herramienta concreta…» con la lista de lo que sí puede responder: es un defecto conocido). Los borradores son deterministas y el coste es 0,00 €. Lo configura el proveedor técnico; tu trabajo no cambia: la IA propone y una persona confirma.

Comprobado en la demostración. Guía: [Dirección › 5. Supervisar la IA](10-direccion.md#5-supervisar-la-ia-informe-ia-del-día-y-pendientes-de-la-ia) · [Sistemas › 5.4 Inteligencia artificial](60-sistemas.md#54-inteligencia-artificial).

**P:** «Reglas y recomendaciones» dice «No hay recomendaciones pendientes de aprobar.» aunque pulse «Generar recomendaciones».

**R:** El motor genera recomendaciones por reglas a partir de la ocupación, el pickup y la demanda; con pocos datos (como en la demostración) puede no proponer nada, y nunca aplica cambios sin tu aprobación. Comprueba que hay reglas activas («Añadir regla»), que la parrilla tiene BAR cargada en el rango y que hay reservas en él. Las recomendaciones también se ven en la capa «Recomendaciones» de la parrilla.

Guía: [Comercial y revenue › 3.1 Reglas y recomendaciones](50-comercial-revenue.md#31-reglas-y-recomendaciones) · [Dirección › 8. Revenue básico](10-direccion.md#8-revenue-básico).

**P:** Un informe sale con «No hemos podido cargar este informe. Inténtalo de nuevo.», un indicador aparece como «—», o «Generar exportación» del Centro de informes termina con «Exportación lista: undefined» y no descarga nada.

**R:** El dato no se ha podido calcular en ese momento y la pantalla lo marca como no disponible en lugar de inventar un cero: pulsa «Reintentar» o «Actualizar». Los informes de solo lectura («Rentabilidad por habitación», «Activos», «Energía y agua») se recalculan cada 5 minutos, así que un dato muy reciente puede tardar en aparecer; si el «—» persiste durante horas, avisa a administración de sistema. Lo de «Exportación lista: undefined» es un defecto conocido de esa pantalla: usa «Exportaciones de revenue» (`/informes/exportaciones-revenue`, plantilla Revenue), los botones «Exportar CSV / Excel» del informe «Histórico y previsión» o, para el diario y los estados contables, sus propios «Exportar CSV» y «Exportar a gestoría».

Guía: [Dirección › 7. Informes](10-direccion.md#7-informes) · [Comercial y revenue › 4. Exportaciones de revenue](50-comercial-revenue.md#4-exportaciones-de-revenue).

**P:** Los indicadores de «hoy» (ocupación, llegadas hechas, turno) salen a 0 o no cuadran con lo que veo en recepción.

**R:** Muchos indicadores se calculan sobre la **fecha de negocio**, que solo avanza con «Cierre del día». Si hay cierres pendientes (en la demostración la fecha de negocio es el 14/09/2026 y hoy es 19), los cargos de alojamiento de las noches posteriores no existen y los KPIs del día salen a 0 o descuadrados; «Llegadas hoy» y «Salidas hoy» del Live Timeline, en cambio, usan la fecha real. Ejecuta los cierres pendientes (dirección o auditoría nocturna) y los indicadores se ponen al día.

Guía: [Dirección › 6. Cierre del día y Turno](10-direccion.md#6-cierre-del-día-y-turno).

**P:** «Pendientes de aprobación» dice «Nada pendiente de aprobar» y «0 pendientes que puedes decidir», pero sé que hay una solicitud.

**R:** La pantalla (`/hoy/pendientes`) solo lista lo que **tú** puedes decidir con tus claves de aprobación y lo que has pedido tú: «Quien solicita nunca aprueba; por encima de T4 hacen falta dos firmas.». Cambia los filtros «Estado» (por ejemplo «Aprobada» o «Caducada») y «Tipo» para ver el histórico. Si la solicitud es tuya, la decide otra persona con nivel; si supera el umbral, necesita dos firmas. Las solicitudes de la IA van aparte, en «Pendientes de la IA».

Comprobado en la demostración. Guía: [Dirección › 4. Decidir lo que otros piden](10-direccion.md#4-decidir-lo-que-otros-piden-pendientes-de-aprobación).

## Rendimiento y mensajes del sistema

**P:** Sale «Error al cargar · Demasiadas peticiones. Reintenta en unos segundos.» (a veces solo «Demasiadas peticiones») con «Reintentar».

**R:** Has superado el límite de peticiones por minuto de tu usuario (600, compartido por todas tus pestañas y por quien use tu misma cuenta desde la misma conexión): suele pasar al abrir muchas pantallas seguidas, recargar en ráfaga o pulsar «Actualizar» sin parar en pantallas que ya se refrescan solas (Live Timeline, Bandeja de cumplimiento, Envíos). Espera medio minuto y pulsa «Reintentar» o «Actualizar»; cierra las pestañas que no uses. No se ha perdido ningún dato.

(Texto comprobado en el código del servidor y observado por las guías; no se ha provocado a propósito para no frenar la cuenta de demostración). Guía: [Primeros pasos › Errores frecuentes](00-primeros-pasos.md#errores-frecuentes).

**P:** Una pantalla muestra «Error al cargar · No hemos podido cargar los datos. Inténtalo de nuevo.» (o «No hemos podido cargar las reservas…», «…los módulos activos de la propiedad…»), o el Live Timeline pone «Datos desactualizados desde <hora>» con «Reintentar».

**R:** La pantalla no ha conseguido leer del servidor: red inestable, sesión caducada o el servidor ocupado; en el Live Timeline, la última actualización automática falló y ves los datos de la hora indicada. Pulsa «Reintentar»; si vuelve a fallar, recarga la página y comprueba que sigues dentro. Mientras dure, confirma cualquier cambio de habitación con el tablero de recepción antes de comunicarlo al huésped. Si falla en todas las pantallas, avisa a administración de sistema, que puede consultar el estado del servidor en `/health`.

Guía: [Recepción › Errores frecuentes en el Live Timeline](70-recepcion.md#errores-frecuentes-en-el-live-timeline) · [Sistemas › 6](60-sistemas.md#6-copias-de-seguridad-y-estado-del-sistema-health).

**P:** Al guardar sale «No se pudo guardar», «No se ha podido guardar · Revisa los datos e inténtalo de nuevo.», «No se pudo completar la acción.», «No se pudo completar la operación. Inténtalo de nuevo.» o el extraño «Campo no admitido en el cuerpo de la petición.» / «Parámetro de consulta no admitido.».

**R:** Los cuatro primeros son los avisos genéricos cuando el servidor rechaza la acción. Debajo o al lado suele venir el motivo concreto (busca en esta página el texto entre «»). Si no lo hay: comprueba los campos obligatorios (marcados con *), pulsa «Actualizar» para descartar que otra persona cambiara el registro, y repite una sola vez. «Campo no admitido» y «Parámetro no admitido» significan que la pantalla que tienes abierta y el servidor no hablan la misma versión (normalmente tu navegador conserva una versión antigua tras una actualización de ehotelOS): recarga con Ctrl+F5 (⌘+Mayús+R en Mac), y si sigue, cierra sesión y vuelve a entrar. Si persiste, anota la pantalla, la hora y el texto exacto y avisa a administración de sistema: todo intento queda en el registro de auditoría. (Textos de servidor comprobados en el código).

Guía: la tabla «Errores frecuentes» de la guía de tu perfil.

**P:** Aparece «Algo ha fallado en la interfaz · El error ya ha sido reportado al equipo. Puedes intentarlo de nuevo.».

**R:** Se ha roto la pantalla (no el servidor): tus datos guardados siguen ahí. Pulsa «Reintentar»; si vuelve a fallar, recarga la página. Hoy ocurre al pulsar «Comparar plantillas» en «Usuarios y roles»: usa la tabla de plantillas de la guía de Sistemas hasta que se corrija. Si te pasa en otra pantalla, anota cuál y qué habías pulsado, y avisa a administración de sistema.

Guía: [Sistemas › 1.5 Comparar plantillas](60-sistemas.md#15-comparar-plantillas).

**P:** En «Módulos e integraciones» hay un aviso amarillo: «Datos guardados en memoria · Los datos de Clientes y fidelización y Compras e inventario se guardan por ahora en memoria: se pierden al reiniciar el servidor…».

**R:** Esos dos módulos («Clientes y fidelización» y «Compras e inventario») todavía no guardan en la base de datos: lo que registres en ellos desaparece cuando el servidor se reinicia (actualizaciones, mantenimiento). No los uses para datos que necesites conservar hasta que la persistencia llegue en una entrega posterior; el resto de módulos (reservas, folios, facturas, contabilidad, nóminas) guardan de forma permanente.

Comprobado en la demostración (`/configuracion/modulos`). Guía: [Sistemas › 3.1 Módulos](60-sistemas.md#31-módulos).

**P:** ¿Dónde veo quién hizo un cambio (una cancelación, un cobro, un cambio de tarifa)?

**R:** En «Menú › Configuración › Sistema › Auditoría» (`/configuracion/sistema`, plantillas Administración de sistema, Auditoría interna y dirección): filtra por «Desde», «Hasta», «Acción» (por ejemplo «PAYMENT_CAPTURED», «RATE_GRID_UPDATED», «ROOM_STATE_CHANGED») y actor, abre el evento con «Ver» y, si lo necesitas, «Exportar CSV». Cada reserva tiene además su propia pestaña «Actividad», y cada cambio de tarifa su entrada en «Historial» de la parrilla. Los eventos de auditoría no se pueden borrar ni editar.

Comprobado en la demostración. Guía: [Sistemas › 4.1 Auditoría](60-sistemas.md#41-auditoría).

**P:** ¿Cómo sé si ehotelOS «está caído» o es mi ordenador?

**R:** Prueba primero desde otro navegador o dispositivo del hotel. Si nadie entra, administración de sistema abre la dirección `/health` del servidor de la aplicación (responde «healthy» con el estado de la base de datos, VeriFactu, SES.Hospedajes e IA) y la pestaña «Salud» de «Módulos e integraciones» (filtro «Con incidencias»). Si `/health` no responde, el problema es del servidor: contacta con el proveedor técnico. No hay copias de seguridad desde la aplicación: las hace el proveedor en el servidor.

Guía: [Sistemas › 6. Copias de seguridad y estado del sistema](60-sistemas.md#6-copias-de-seguridad-y-estado-del-sistema-health) · [3.2 Salud](60-sistemas.md#32-salud).

---

## Estado de la demo y qué no funciona todavía

Lo que verás en la aplicación de demostración (y, en parte, en cualquier hotel recién instalado) a 19 de septiembre de 2026:

- **IA sin proveedor.** No hay modelo de lenguaje configurado: el Asistente ehotelOS muestra «SIN MODELO DE LENGUAJE», «Dictar (IA)», los borradores de mensajes y respuestas a reseñas, el Informe IA del día, los Pendientes de la IA y las recomendaciones de revenue funcionan por reglas; el coste de IA es 0,00 €. «Aprobar» en Pendientes de la IA registra la confirmación pero no ejecuta la acción.
- **VeriFactu y SES.Hospedajes en modo de pruebas.** Las facturas se emiten con huella y QR, pero los envíos salen «SIMULADO · NO ENVIADO» y el registro de viajeros va a un simulador; la declaración del software VeriFactu está incompleta y el conector SES está en «CONFIGURACIÓN PENDIENTE». Por eso la franja «Falta 1 comprobación para poner la propiedad en marcha.» es permanente. TicketBAI e IGIC no aplican a un hotel peninsular.
- **Modelos de la AEAT solo para presentación manual.** Cálculo y resumen por casilla; sin presentación telemática ni fichero de diseño de registro.
- **Correo saliente sin configurar.** Confirmaciones, invitaciones, recuperación de contraseña, enlaces del portal del huésped y facturas por correo no salen: la pantalla te da el enlace para entregarlo a mano cuando existe. Correo entrante (Gmail, Microsoft 365, IMAP) también sin configurar: solo el conector manual.
- **Pasarela de pago ausente.** «Tarjeta en línea» y «Enlace de pago» no disponibles; los cobros se registran a mano (efectivo, datáfono, transferencia). Sin cuentas bancarias, extractos ni remesas SEPA en la demo; Tesorería «SOLO LIBRO CONTABLE».
- **Copias de seguridad.** No hay pantalla: las hace el proveedor técnico en el servidor. El estado del sistema se consulta en `/health`.
- **Módulos apagados en la demo.** «Punto de venta» (y con él «Cierre de caja»), el check-in en línea y el motor de reservas con IA responden «Módulo no activado»; se activan en «Configuración › Módulos e integraciones». Las integraciones certificadas de terceros no tienen catálogo, y OPERA solo funciona en modo sombra por ficheros (sin cortes cargados en la demo).
- **Datos en memoria.** «Clientes y fidelización» y «Compras e inventario» se pierden al reiniciar el servidor (aviso «Datos guardados en memoria» en Módulos e integraciones).
- **Fecha de negocio atrasada.** La demo está en el 14/09/2026 sin ningún cierre ejecutado; el cierre está bloqueado por «1 folios abiertos con saldo» y los indicadores de «hoy» salen a 0 o descuadrados hasta ejecutar los cierres pendientes.
- **Cajones laterales ocultos.** En esta versión los formularios laterales («Nueva tarea», «Nueva orden», «Nuevo asiento», «Invitar con ámbito», «Nuevo grupo», «Nuevo contrato», «Nueva cuenta bancaria», «Nueva factura recibida», el detalle del borrador de factura con «Emitir factura», el «Rechazar» de Pendientes de la IA…) se abren sin verse por una regla de estilo. Las ventanas centradas sí se ven y funcionan: «Registrar pago» / «Cobrar», «Devolver», «Crear ejercicio» y todas las confirmaciones. Defecto comunicado; hasta la corrección, las altas que pasan por un cajón no se pueden completar desde la pantalla.
- **Canales en modo de pruebas.** Booking.com, Expedia y Channex trabajan contra un simulador local sin credenciales reales; solo «Double · BAR» tiene correspondencia. Reputación con fuentes sin credenciales (solo importación CSV o fuente de demostración) y sin encuestas enviadas.
- **Otros defectos conocidos.** El interruptor «Exigir doble factor (2FA)» solo deja la marca «2FA: Activo» en la ficha: la aplicación no pide un segundo factor al entrar y la marca no es un control de acceso (decisión documentada en [Sistemas › 1.2](60-sistemas.md#12-las-plantillas-que-puedes-invitar), regla «Doble factor»); no hay asignación de tareas ni de técnico a una persona desde Pisos y Mantenimiento; algunos textos de Mi día, del Centro de informes y de las tarjetas de ayuda de Pisos y Mantenimiento siguen en inglés o con códigos internos. Corregidos el 19/09/2026 (ya no aplican): «Comparar plantillas», «Generar exportación» del Centro de informes, «Pausar» / «Eliminar» de Webhooks, la pregunta sugerida «¿Cuántas llegadas tengo hoy?» del Asistente y el alta de fichas de personal («Nueva ficha» en Finanzas › Nóminas, [RRHH › 2.1](30-rrhh.md#21-paso-previo-la-ficha-de-personal-nueva-ficha)).
- **Pantallas en cambio (UX-1).** Mi día, check-in rápido, walk-in, check-out rápido, cobro y nueva reserva rápida de recepción: la guía de recepción y las entradas marcadas «Provisional (UX-1)» de esta página se completan en DOC-2.

## Ver también

- [Índice del manual](README.md) · [Primeros pasos](00-primeros-pasos.md)
- Guías por perfil: [10 · Dirección](10-direccion.md) · [20 · Administración y contabilidad](20-administracion.md) · [30 · RRHH y nóminas](30-rrhh.md) · [40 · Pisos y mantenimiento](40-pisos-mantenimiento.md) · [50 · Comercial y revenue](50-comercial-revenue.md) · [60 · Sistemas](60-sistemas.md) · [70 · Recepción](70-recepcion.md)
- Formación: [Plan de formación](formacion/plan-de-formacion.md) · [Fichas rápidas](formacion/fichas/README.md)
