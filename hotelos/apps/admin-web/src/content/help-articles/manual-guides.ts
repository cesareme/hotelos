// manual-guides — un artículo del centro de ayuda («?») por cada guía del manual de uso
// (docs/manual/README.md, tabla «Qué guía es la tuya»), en la categoría «Manual de uso».
//
// Misma fuente de verdad que el manual: cada artículo resume a quién va la guía, sus
// capítulos (los H2 reales del .md), las tareas clave con los literales de botón que hay
// en la aplicación, lo que la guía declara como «Qué no hace todavía» y dónde está el
// fichero. Los enlaces relativos del manual NO resuelven dentro de la aplicación, así que
// cada guía se cita por su nombre exacto y su ruta en texto (docs/manual/70-recepcion.md)
// y por capítulo («capítulo «Llegadas y check-in»»), nunca con un enlace.
//
// Contrato: tests/ayuda-in-app-contract.test.mjs («artículos del manual») exige un
// artículo `manual-<slug>` por fila de la tabla del README, que el título contenga el
// de la guía, que el cuerpo cite la ruta del fichero, que cada «capítulo «…»» y cada
// elemento de «Qué cubre» sea un H2 del .md, y que no haya enlaces relativos.
// Vocabulario D5, marca por BRAND.name, atajos solo del registro (⌥H/⌥R/⌥N/⌥T/⌥B/⌥F/⌥W,
// ⌥1-3, ⌘K, ⌘/, Intro, Esc).
import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { BRAND } from "../../config/brand";

export const MANUAL_GUIDES_CATEGORY = "Manual de uso";

export const MANUAL_GUIDE_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "manual-primeros-pasos",
    title: "Manual de uso · 00 · Primeros pasos",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "primeros pasos", "acceso", "menú", "ver como", "⌘K", "estados", "atajos", "todas las plantillas"],
    bodyMd: `# Manual de uso · 00 · Primeros pasos

**Para quién:** todo el personal, antes de abrir la guía de su puesto (todas las plantillas de usuario).

## Qué cubre
- «1. Entrar en ${BRAND.name}»
- «2. La pantalla»
- «3. «Ver como…»: simular el menú de otro perfil»
- «4. Buscar cualquier cosa con ⌘K»
- «5. Live Timeline: la primera entrada del menú»
- «6. Cambiar de hotel»
- «7. Ayuda dentro de la aplicación»
- «8. Notificaciones»
- «9. Vocabulario: estados de una reserva y de una habitación»
- «10. Atajos de teclado»

## Tareas clave
1. Entrar con «Correo electrónico» y «Contraseña» y pulsar «Iniciar sesión»; «Recordarme» guarda el correo, nunca la contraseña.
2. Reconocer la barra superior: el nombre del hotel (abre «Cambiar propiedad»), «+ Nueva reserva», el buscador «Buscar reservas, huéspedes…» (⌘K), el tema «Claro», la campana «Avisos», el «Centro de ayuda» y tu «Menú de usuario» con «Cerrar sesión».
3. Buscar con ⌘K (Ctrl+K en Windows y Linux): dos letras o más; ↑ ↓ para moverte, Intro para abrir, Esc para cerrar. Sin texto, la paleta lista los comandos de la pantalla en «Esta pantalla».
4. Leer los estados: reserva «Llega hoy · En el hotel · Sale hoy · Salida hecha · No-show · Cancelada»; habitación «Limpia · Inspeccionada · Sucia · Ocupada · Bloqueada · Fuera de servicio».
5. Pulsar ⌘/ para ver la hoja «Atajos de teclado»; ⌥H, ⌥R, ⌥N, ⌥T y ⌥B llevan a Mi día, Reservas, Nueva reserva, Live Timeline y Tablero de habitaciones.

## Qué no hace todavía
- La IA responde por reglas, sin modelo de lenguaje: «Asistente ${BRAND.name}», «Dictar (IA)» y «Pendientes de la IA».
- Una tarjeta de instrucciones cerrada no se vuelve a mostrar desde la pantalla.
- El recorrido de bienvenida es el mismo para todos los perfiles.

## Dónde está
Guía «00 · Primeros pasos», fichero docs/manual/00-primeros-pasos.md; el diccionario de estados está en el capítulo «9. Vocabulario: estados de una reserva y de una habitación».`
  },
  {
    id: "manual-direccion",
    title: "Manual de uso · 10 · Dirección",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "dirección", "direccion", "propiedad", "mi día", "kpis", "aprobaciones", "cierre del día", "turno", "informes", "revenue"],
    bodyMd: `# Manual de uso · 10 · Dirección

**Para quién:** plantillas «Dirección de hotel», «Dirección de operaciones», «Dirección general» y «Propiedad» (con apartado propio).

## Qué cubre
- «Qué verás en tu menú»
- «Tareas»: diez tareas, de Mi día de dirección a la configuración del hotel (foto de operaciones, panel del propietario, Pendientes de aprobación, Informe IA del día y Pendientes de la IA, Cierre del día y Turno, Informes, Revenue básico, Personas y puesta en marcha)
- «Errores frecuentes»
- «Qué no hace todavía»

## Tareas clave
1. Leer el día en Hoy › Mi día, pestaña «Dirección»: «OCUPACIÓN», «ADR», «REVPAR», «GOPPAR», el gráfico «Pace próximos 30 días» y las tarjetas por departamento, que abren su tablero al hacer clic.
2. Pasar a la pestaña «Operaciones» y a «Alertas (n)»: el bloque «Atender ahora» lista cada aviso con su departamento y la acción sugerida.
3. Decidir en Hoy › Pendientes de aprobación con los filtros «Estado» y «Tipo»; en Hoy › Pendientes de la IA cada fila tiene «Asignar», «Aprobar», «Rechazar» (pide motivo) y «Escalar».
4. Revisar Hoy › Cierre del día: «COMPROBACIONES CORRECTAS», «AVISOS» y «BLOQUEOS»; «Ver n elementos» y «Abrir cola operativa» llevan a lo que bloquea; «Cerrar de todos modos» solo con permiso. En Hoy › Turno, «CHECK-INS HECHOS», «CHECK-OUTS HECHOS» y «Caja del día».
5. En Revenue › Parrilla de tarifas, editar una celda con Intro y terminar con «Guardar sin enviar a canales» o «Revisar y publicar».

## Qué no hace todavía
- IA sin proveedor: «Aprobar» en Pendientes de la IA registra la decisión, pero no ejecuta la acción propuesta.
- «Descartar» en anomalías, «Comparar plantillas» y «Generar exportación» del Centro de informes no funcionan hoy.
- «Exigir doble factor (2FA)» solo marca la ficha: no se pide un segundo factor al entrar.
- Punto de venta apagado en el hotel de demostración («Módulo no activado»).

## Dónde está
Guía «10 · Dirección», fichero docs/manual/10-direccion.md, capítulo «Tareas».`
  },
  {
    id: "manual-administracion",
    title: "Manual de uso · 20 · Administración y contabilidad",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "administración", "administracion", "contabilidad", "finanzas", "cumplimiento", "sage 200", "iva", "verifactu", "facturación", "cobros", "partes de viajeros", "gestoría"],
    bodyMd: `# Manual de uso · 20 · Administración y contabilidad

**Para quién:** «Administración de hotel», «Contabilidad», «Dirección financiera», «Cumplimiento» y «Gestión del activo».

## Qué cubre
- «1. Plan contable y ejercicios (plantilla Contabilidad o Dirección financiera)»
- «2. Diario y asientos (plantilla Contabilidad o Dirección financiera)»
- «3. Importar desde Sage 200 (plantilla Contabilidad o Dirección financiera)»
- «4. Libros de IVA y modelos de la AEAT (plantilla Contabilidad, Dirección financiera o Cumplimiento)»
- «5. Facturación y VeriFactu»
- «6. Cobros y cierres de caja»
- «7. Partes de viajeros (plantilla Administración de hotel o superior)»
- «8. Cartera, tesorería y proveedores»
- «9. Estados contables y exportaciones (plantilla Contabilidad o Dirección financiera)»
- «10. Otras pantallas del menú de finanzas y administración»

## Tareas clave
1. Finanzas › Contabilidad, «Diario»: «Nuevo asiento», líneas que cuadren, «Contabilizar…»; «Anular» crea el asiento inverso.
2. Sage 200: «Tipo de lote», «Elegir fichero de Sage 200», pasos Cuentas, Analítica y Revisión, «Contabilizar n asientos».
3. Finanzas › Facturación y cobros: «Registrar pago» (en el folio, «Cobrar»), «Borrador de factura» › «Crear borrador», «Emitir factura» en «Ver detalle»; «Nueva rectificativa».
4. Cumplimiento › Modelos AEAT: «Descargar resumen» (303); libros de IVA, «Descargar CSV».
5. Partes de viajeros: «Crear y encolar el envío»; conector SES.Hospedajes con «Probar conexión».
6. Gestoría: «Exportar a gestoría», «Formato», fechas y «Generar y descargar».

## Qué no hace todavía
- VeriFactu y SES.Hospedajes en modo de pruebas; modelos de la AEAT solo para presentación manual.
- Sin pasarela de pago («Tarjeta en línea», «Enlace de pago») ni cuentas bancarias.
- Sage 200: el XML no se admite; los ficheros grandes van por línea de comandos.

## Dónde está
Guía «20 · Administración y contabilidad», fichero docs/manual/20-administracion.md, capítulo «5. Facturación y VeriFactu».`
  },
  {
    id: "manual-rrhh",
    title: "Manual de uso · 30 · RRHH y nóminas",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "rrhh", "nóminas", "nominas", "contratos", "periodos", "coste de personal", "personal y turnos", "gestoría"],
    bodyMd: `# Manual de uso · 30 · RRHH y nóminas

**Para quién:** plantilla «RRHH y nóminas».

## Qué cubre
- «1. Nóminas: la pantalla»
- «2. Contratos: «Nuevo contrato»»
- «3. Periodos: abrir, calcular, exportar y pagar»
- «4. Importar el coste de personal (informe agregado de RRHH)»
- «5. Informe de coste por departamento y centro»
- «6. Personal y turnos»
- «7. Live Timeline (solo lectura) y Pendientes de aprobación»

## Tareas clave
1. Abrir Finanzas › Nóminas: el selector de ámbito (sociedad o centro), los botones «Actualizar», «Abrir periodo» y «Nuevo contrato», y las pestañas «Contratos (n) · Periodos (n) · Recibos · Coste de personal».
2. Contrato: «Nuevo contrato», bloques «Empleado y modalidad» y «Retribución», «Guardar contrato».
3. Mes: «Abrir periodo» con el «Mes (AAAA-MM)»; en la fila del periodo «Calcular» y confirmar «Calcular y contabilizar»; «Recibos» muestra la tabla con bruto, IRPF, Seguridad Social y neto.
4. Gestoría y pago: «Exportar» › «Exportar y descargar»; «Pagar» › «Registrar el pago» con «Fecha de pago» y «Cuenta de tesorería».
5. Coste de personal: «Importar informe», «Elegir fichero», «Previsualizar», mapear centros y departamentos, «Contabilizar»; un lote se deshace con «Revertir» › «Revertir la importación» (motivo obligatorio).
6. Personal y turnos: «Nuevo turno» › «Crear turno», «Fichar entrada» y «Fichar salida».

## Qué no hace todavía
- No hay alta de fichas de personal: sin ficha no hay contrato («Perfil de empleado no encontrado.») y el periodo se calcula vacío.
- Cálculo simplificado (porcentajes fijos, IRPF orientativo); los formatos A3 y Sage son compatibles, no el diseño oficial: valídalos con la gestoría.
- Sin integración con la gestoría laboral ni con la TGSS; el empleado del turno es texto libre.

## Dónde está
Guía «30 · RRHH y nóminas», fichero docs/manual/30-rrhh.md; el mes completo está en el capítulo «3. Periodos: abrir, calcular, exportar y pagar».`
  },
  {
    id: "manual-pisos-mantenimiento",
    title: "Manual de uso · 40 · Pisos y mantenimiento",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "pisos", "gobernanta", "mantenimiento", "limpieza", "habitaciones", "tareas", "inspección", "órdenes de trabajo", "averías", "activos"],
    bodyMd: `# Manual de uso · 40 · Pisos y mantenimiento

**Para quién:** plantillas «Pisos», «Gobernanta», «Mantenimiento» y «Encargado de mantenimiento».

## Qué cubre
- «Parte 1 · Pisos»: tareas 1 a 7 (tablero de pisos, nueva tarea, Mi turno, inspección, reportar una avería, Tablero de habitaciones, foto de operaciones)
- «Parte 2 · Mantenimiento»: tareas 8 a 11 (tablero de mantenimiento, crear y resolver un parte, Mis averías, activos y energía)

## Tareas clave
1. Leer Operaciones › Pisos: «SUCIAS», «LIMPIAS», «INSPECCIONADAS», «FUERA DE SERVICIO» y «TAREAS ABIERTAS»; cada tarjeta de habitación lleva sus tareas y sus botones.
2. Crear una tarea: «Nueva tarea» en la tarjeta, «Tipo de tarea» y «Prioridad», «Crear tarea».
3. Marcar el trabajo hecho: «Limpia» en Mi turno o «Marcar limpia» en el tablero; la gobernanta pulsa «Inspeccionada» o «Inspeccionar» y la habitación cuenta como vendible.
4. Avisar de una avería desde la habitación: «Reportar», campo «Incidencia», «Enviar a mantenimiento».
5. Parte de mantenimiento en Operaciones › Mantenimiento: «+ Nueva orden», «Título», «Habitación», «Prioridad», «Crear orden»; en la ficha, el desplegable «Estado», «Bloquear habitación» y el paso a «Resuelta».
6. En el móvil, Mis averías: filtros por prioridad y la lista se refresca sola cada 20 segundos.

## Qué no hace todavía
- Sin asignación de personas: «Asignada a» queda «Sin asignar» en pisos y en mantenimiento.
- «Limpia» e «Inspeccionada» no cierran la tarea de limpieza: hay que pulsar «Completar» en el tablero.
- Sin fotos ni adjuntos desde la pantalla; el cierre formal de una orden no existe (solo «Resuelta»).
- Marcar sucia, bloquear y desbloquear a mano solo existen en el cajón de una casilla del Tablero de habitaciones.

## Dónde está
Guía «40 · Pisos y mantenimiento», fichero docs/manual/40-pisos-mantenimiento.md: capítulo «Parte 1 · Pisos» y capítulo «Parte 2 · Mantenimiento».`
  },
  {
    id: "manual-comercial-revenue",
    title: "Manual de uso · 50 · Comercial y revenue",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "comercial", "revenue", "tarifas", "parrilla", "canales", "grupos", "cupos", "reputación", "ventas", "planes de tarifas"],
    bodyMd: `# Manual de uso · 50 · Comercial y revenue

**Para quién:** plantillas «Comercial» y «Revenue corporativo».

## Qué cubre
- «Parte 1 · Revenue»: tarifas y parrilla, planes de tarifas y políticas de cancelación, reglas, previsión y análisis, exportaciones de revenue
- «Parte 2 · Comercial»: canales de venta, grupos, eventos y cupos, reputación y encuestas, ventas

## Tareas clave
1. Cambiar un precio en Revenue › Parrilla de tarifas: clic en la celda, Intro, el precio o «+10 %», Intro; después «Guardar sin enviar a canales» o «Revisar y publicar» › «Publicar en n canales». «Edición masiva…» aplica un cambio a un rango con «Aplicar al borrador».
2. Reglas de precio: «Nueva regla» con «Nombre», ocupación mínima y máxima y «Ajuste (%)», «Añadir regla»; «Generar recomendaciones» propone tarifas que se aceptan o rechazan.
3. Exportaciones de revenue: «Descargar CSV», «Descargar Excel» o «PDF (imprimir)».
4. Canales: «Guardar correspondencias» por producto y «Reintentar» las entregas rechazadas.
5. Grupos y cupos: «Nuevo grupo» › «Crear grupo»; «Nuevo TT.OO.» › «Crear tour operador»; «Nuevo cupo» › «Crear cupo».
6. Reputación: «Importar CSV» con el «Portal de origen» y «Importar».

## Qué no hace todavía
- Canales en modo de pruebas contra un simulador local, sin credenciales reales.
- Un solo plan (BAR) sin restricciones en el hotel de demostración.
- Recomendaciones, previsión y respuestas a reseñas por reglas, sin proveedor de IA; competencia y calendario de demanda a mano.
- Reputación sin credenciales de portales y sin encuestas; la bandeja no lista las reseñas.
- «Clientes y fidelización» se guarda en memoria y se pierde al reiniciar el servidor.

## Dónde está
Guía «50 · Comercial y revenue», fichero docs/manual/50-comercial-revenue.md: capítulo «Parte 1 · Revenue» y capítulo «Parte 2 · Comercial».`
  },
  {
    id: "manual-sistemas",
    title: "Manual de uso · 60 · Sistemas",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "sistemas", "administración de sistema", "usuarios y roles", "plantillas", "invitar", "comunicaciones", "módulos", "integraciones", "auditoría", "webhooks", "puesta en marcha"],
    bodyMd: `# Manual de uso · 60 · Sistemas

**Para quién:** plantillas «Administración de sistema» y «Auditoría interna» (apartado 4.5).

## Qué cubre
- «1. Usuarios y roles»
- «2. Comunicaciones»
- «3. Módulos e integraciones»
- «4. Seguridad y auditoría (Sistema)»
- «5. Solo administrador de plataforma o dirección»
- «6. Copias de seguridad y estado del sistema (\`/health\`)»

## Tareas clave
1. Invitar a una persona en Configuración › Usuarios y roles: «Invitar con ámbito», secciones «Persona» y «Rol y ámbito», «Crear invitación». Si el cajón avisa «Nivel superior al tuyo» o «Separación de funciones», no deja enviar.
2. Comunicaciones: en «Plantillas y envíos» revisar «FALLIDAS» y reintentar desde «Envíos»; en «Correo entrante», «Procesar correo» convierte un correo pegado en un borrador de reserva.
3. Módulos: el interruptor de cada tarjeta pasa a «Activado» o «Desactivado» y la entrada de menú aparece o desaparece para todo el hotel.
4. Auditoría: filtrar por «Acción», «Desde» y «Hasta», abrir «Ver» y entregar con «Exportar CSV».
5. Webhooks: «Nueva suscripción», «URL de destino», eventos, «Crear suscripción» y «Enviar evento de prueba».
6. Puesta en marcha: «Recalcular preparación» en «Salida en vivo» y la «Lista de comprobación».

## Qué no hace todavía
- Correo saliente sin proveedor: confirmaciones, invitaciones y enlaces se entregan a mano (la pantalla te da el enlace).
- Copias de seguridad desde la aplicación: no existen; las hace el proveedor en el servidor.
- «Pausar» y «Eliminar» de Webhooks fallan; «Comparar plantillas» rompe la interfaz.
- OPERA solo por ficheros y sin cortes cargados; correo entrante (Gmail, Microsoft 365, IMAP) sin configurar.

## Dónde está
Guía «60 · Sistemas», fichero docs/manual/60-sistemas.md; las altas están en el capítulo «1. Usuarios y roles».`
  },
  {
    id: "manual-recepcion",
    title: "Manual de uso · 70 · Recepción",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "recepción", "recepcion", "auditoría nocturna", "jefatura de recepción", "mi día", "check-in", "check-out", "walk-in", "nueva reserva", "cambiar habitación", "cancelar", "no-show", "live timeline", "turno", "cierre del día"],
    bodyMd: `# Manual de uso · 70 · Recepción

**Para quién:** «Recepción», «Auditoría nocturna» y «Jefatura de recepción».

## Qué cubre
- «Mi día»
- «Llegadas y check-in»
- «Salidas y check-out»
- «Walk-in»
- «Nueva reserva»
- «Ficha de reserva»
- «Lista de reservas»
- «Huéspedes y partes de viajeros»
- «Mensajes de huéspedes»
- «Turno y cierre del día»
- «Live Timeline»
- «Atajos de teclado»

## Tareas clave
1. **Mi día** (⌥H): una acción por fila: «Hacer check-in», «Check-in en 101», «Cobrar 120,00 € y cerrar», «Abrir ficha»; «⋯»: «Ver folio», «Cambiar habitación» (o «Asignar habitación»), «Marcar no-show…».
2. **Check-in**: huésped, habitación, «3 · Pago» («Cobrar saldo» o «Sin cobro») y cumplimiento; confirma con «Cobrar 128,00 € y hacer check-in» o «Hacer check-in». «Sucia»: «Cambiar a la 101» o «Hacer check-in igualmente» con motivo.
3. **Check-out**: «Cobrar 120,00 € y cerrar» y factura («Borrador para Facturación» · «Emitir ahora con número» · «Sin factura»); lote: «Check-out de 2 con saldo 0».
4. **Walk-in** (⌥W): «Solo crear reserva» o «Crear y hacer check-in». **Nueva reserva** (⌥N): «Crear reserva», «Crear y cobrar depósito» o «Crear y hacer check-in».
5. **Ficha**: «Cambiar habitación» › «Mover a la 311», con «Deshacer» 8 s; «Más ▾» › «Cancelar reserva…» o «Marcar no-show…» piden motivo y muestran la penalización.
6. **Live Timeline** (⌥T): ficha rápida al pasar el ratón, panel («Ir a», «Acciones») al clic y arrastre con «Deshacer».

## Qué no hace todavía
- Sin «Deshacer» del check-in ni de la primera asignación desde la cola.
- El walk-in nace sin cargo de alojamiento (lo asienta el cierre del día); su cobro es un anticipo.
- Con el huésped en el hotel solo cambia la habitación, no las fechas.
- La factura del check-out queda en borrador salvo «Emitir ahora con número».
- SES.Hospedajes en modo de pruebas; la IA («Dictar (IA)») va por reglas.

## Dónde está
Guía «70 · Recepción», fichero docs/manual/70-recepcion.md, capítulo «Llegadas y check-in».`
  },
  {
    id: "manual-faq",
    title: "Manual de uso · Preguntas frecuentes",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "faq", "preguntas frecuentes", "errores", "mensajes", "avisos", "solución", "todas las plantillas"],
    bodyMd: `# Manual de uso · Preguntas frecuentes

**Para quién:** todo el personal (todas las plantillas): dudas habituales y mensajes de error con su causa y su solución.

## Qué cubre
- «Acceso y sesión»
- «Menú y permisos»
- «Reservas y huéspedes»
- «Pisos y mantenimiento»
- «Facturación, cobros y VeriFactu»
- «Contabilidad e importaciones»
- «Nóminas»
- «Tarifas y canales»
- «Cumplimiento y partes de viajeros»
- «Informes e IA»
- «Rendimiento y mensajes del sistema»

## Cómo usarlas
1. Busca el mensaje **tal como aparece en pantalla**: cada entrada lo cita entre comillas latinas, explica por qué sale y qué hacer paso a paso.
2. Cada respuesta termina con la guía y el capítulo donde está el detalle.
3. Ejemplos que resuelve: «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla.», «Demasiadas peticiones. Reintenta en unos segundos.», «Módulo no activado», «No puedes cerrar todavía: …», «La habitación no está lista. Cambia de habitación o marca «Hacer check-in igualmente» con un motivo.», «Indica el motivo del check-in fuera de ventana.», «Sin disponibilidad para esas fechas y ocupación.».
4. Un bloque final resume lo que no funciona todavía en el hotel de demostración (IA por reglas, VeriFactu y SES.Hospedajes en modo de pruebas, correo sin configurar, módulos apagados).

## Dónde está
Fichero docs/manual/faq.md; para recepción, empieza por el capítulo «Reservas y huéspedes».`
  },
  {
    id: "manual-plan-de-formacion",
    title: "Manual de uso · Plan de formación",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "formación", "formacion", "plan de formación", "formador", "referente", "sesiones", "ejercicios", "evaluación", "despliegue"],
    bodyMd: `# Manual de uso · Plan de formación

**Para quién:** el formador y el referente de cada hotel: quién organiza e imparte la formación de ${BRAND.name} en un grupo de hoteles.

## Qué cubre
- «Objetivo y principios»
- «Cómo usar este plan»
- «Itinerarios por perfil»: dirección, administración y contabilidad, RRHH y nóminas, pisos, mantenimiento, comercial, revenue, sistemas y recepción
- «Calendario tipo para 8 hoteles»
- «Roles»
- «Materiales»

## Cómo se usa
1. Sesiones de 45 a 60 minutos y grupos de 6 a 8 personas, en parejas por puesto: una maneja y la otra lee la guía y comprueba.
2. Cada itinerario tiene una tabla de sesiones, ejercicios sobre el hotel de demostración marcados «(lee)» o «(escribe)», una checklist de competencias, una prueba práctica de 10 minutos y un refuerzo a las dos semanas.
3. Todo ejercicio termina en un dato que se comprueba en una pantalla concreta; si el resultado no aparece, el ejercicio no está hecho.
4. Todo lo que el alumnado crea lleva el prefijo MANUAL-FORM- seguido de sus iniciales, para localizarlo y limpiarlo después.
5. El itinerario de recepción (sesiones RC-1 a RC-6) se practica en un hotel de pruebas con un día completo de llegadas y salidas.
6. El calendario tipo despliega ocho hoteles en una ola piloto de dos y tres olas más, con las sesiones centrales (administración, RRHH, revenue, sistemas) impartidas una sola vez.

## Qué no hace todavía
- Los ejercicios no prometen nada que el hotel de demostración no haga: IA por reglas, VeriFactu y SES.Hospedajes en modo de pruebas, fecha de negocio atrasada y sin alta de fichas de personal.

## Dónde está
Fichero docs/manual/formacion/plan-de-formacion.md, capítulo «Itinerarios por perfil».`
  },
  {
    id: "manual-fichas",
    title: "Manual de uso · Fichas rápidas",
    category: MANUAL_GUIDES_CATEGORY,
    tags: ["manual", "fichas", "fichas rápidas", "una página", "check-in", "check-out", "nueva reserva", "cambio de habitación", "cierre del día", "factura", "sage", "usuario", "todas las plantillas"],
    bodyMd: `# Manual de uso · Fichas rápidas

**Para quién:** todo el personal: una ficha breve por tarea clave, para tener junto al puesto (impresa ocupa dos páginas).

## Qué cubre
- «Las fichas»: la tabla con las dieciséis fichas, su perfil y su guía de referencia
- «Cómo usar una ficha»

## Las dieciséis fichas
1. Entrada de huésped (check-in) · 2. Salida y cobro (check-out) · 3. Nueva reserva · 4. Cambio de habitación (recepción).
2. Cierre del día (recepción, auditoría nocturna, dirección y administración).
3. Importar desde Sage 200 · Emitir una factura · Asiento manual · Exportar a la gestoría (administración y contabilidad).
4. Dar de alta un usuario (sistemas y dirección).
5. Habitación limpia e inspeccionada (pisos) · Parte de mantenimiento (mantenimiento).
6. Cambiar una tarifa en la parrilla (revenue) · Nuevo grupo (comercial).
7. Parte de viajeros (recepción, administración y cumplimiento) · Nómina del mes (RRHH).

## Cómo usar una ficha
- Cada ficha dice quién la usa, qué necesitas antes de empezar («Antes de empezar»), los pasos con el menú y la dirección de cada pantalla, lo que debes ver al terminar y una tabla «Si algo falla».
- Los literales de la interfaz van entre comillas latinas y las pantallas como «Menú › Categoría › Entrada».
- Cuando necesites el contexto completo, sigue la sección «Más detalle» de la ficha, que remite a la guía del manual.

## Dónde está
Índice en docs/manual/formacion/fichas/README.md (capítulo «Las fichas»); cada ficha es un fichero de esa carpeta, del 01 al 16.`
  }
];

export default MANUAL_GUIDE_ARTICLES;
