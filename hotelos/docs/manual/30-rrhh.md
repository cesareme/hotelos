# Guía de RRHH y nóminas · ehotelOS

Esta guía te acompaña por lo que hace en ehotelOS la persona de recursos humanos: preparar la nómina mensual (contratos, periodos que aprueba dirección, recibos, exportación a la gestoría e incidencias del mes), llevar los expedientes de la plantilla, saber cuánta gente hace falta cada día según la ocupación prevista, leer la foto de RRHH del centro, cargar el coste de personal por centro y mes, leer el informe de coste por departamento y llevar los turnos y fichajes del hotel. Cada paso se ha recorrido en la aplicación de demostración antes de escribirlo (los apartados 8 a 10, en el hotel de pruebas de RRHH); cuando algo no funciona todavía, se dice.

## Para quién

Para quien tiene la plantilla **«RRHH y nóminas»** (en la lista de plantillas de Usuarios y roles aparece con ese nombre; su ámbito es la sociedad, no un solo hotel). Con ella puedes:

- Ver y gestionar nóminas: contratos, periodos, recibos, exportación a la gestoría e importación del coste de personal (permisos de lectura y gestión de nóminas y de exportación).
- Ver el coste de personal y la plantilla, crear turnos y registrar fichajes de otras personas.
- Llevar los expedientes de la plantilla (alta, datos personales cifrados, contrato con convenio y jornada, baja), los convenios y sus reglas, los estándares de dotación del centro y los borradores de plantilla máxima; generar la previsión de plantilla y descargar las incidencias del mes para la gestoría.
- Consultar el Live Timeline de recepción **en solo lectura** (reservas y huéspedes).
- Ver la bandeja de aprobaciones para las solicitudes de tipo «Nómina».
- Abrir **Configuración › Usuarios y roles** (`/configuracion/usuarios`) escribiendo la URL, **en solo lectura** (permiso «users.read», añadido a la plantilla el 20/09/2026 para que el selector «Persona» de «Nueva ficha» liste a las personas del centro): no aparece en tu menú y desde ahí no puedes invitar, editar ni asignar plantillas.

Lo que **no** incluye la plantilla: aprobar el registro mensual de nómina ni la plantilla máxima (esas claves las tienen las plantillas de dirección: el registro, Dirección de hotel, Dirección de operaciones y Dirección general; la plantilla máxima, Dirección general), fichar tú misma en Personal y turnos (gestionas el reloj, no lo usas), la contabilidad y los estados contables, los modelos de la AEAT y la configuración de la sociedad (NIF, centros, códigos de cuenta de cotización). Cuando en esta guía te remitimos a esas pantallas, pídeselo a administración o a dirección (ver [20-administracion.md](20-administracion.md) y [10-direccion.md](10-direccion.md)).

## Cómo están hechas las capturas

- Entorno de demostración: hotel **Hotel Demo Madrid Centro**, sociedad **Grupo Hotelero Demo SL**, tema claro, ventana de 1280 × 800. Todos los nombres, importes y ficheros son ficticios (prefijo `MANUAL-RRHH`).
- Sesión del usuario de demostración con «Ver como…» = **«RRHH y nóminas»** en la barra lateral. Verás el aviso «Viendo como RRHH y nóminas · solo menú»: cambia el menú, no los permisos, y se pierde al recargar la página (F5). Un usuario real con la plantilla ve el mismo menú sin ese aviso.
- Las cuatro capturas de esta guía están en `img/rrhh/` y su lote en `img/rrhh/capturas.json`. Dos de ellas son estados tras un clic (cajón abierto y previsualización cargada): el lote los describe con la clave `actions` (clics, campos rellenos y el fichero de ejemplo embebido), que la receta general `tools/capturas.mjs` ejecuta sin pulsar «Guardar contrato» ni «Contabilizar» (ver el índice del manual).
- Los apartados 8, 9 y 10 (Plantilla, Previsión de plantilla y Panel RRHH) se recorrieron el 20/09/2026 en el hotel de pruebas de RRHH (sociedad **HR Pruebas SL**, hotel **Hotel HR (prueba)**, usuarios `*@hr.test` con expedientes ficticios) y no llevan captura: el texto cita los literales de la aplicación. Las cuatro capturas de la guía son anteriores a las pestañas de RRHH: donde ponía «Nóminas» ahora pone «RRHH y nóminas» y aparece la tira de pestañas.

## Qué verás en tu menú

Tu menú tiene **3 categorías · 4 entradas** (así lo dice el pie de la barra lateral):

| Categoría | Entradas | Para qué |
|---|---|---|
| **Hoy** | Live Timeline · Pendientes de aprobación | Ver la ocupación del hotel (solo lectura) y las solicitudes de aprobación |
| **Operaciones** | Personal y turnos | Plantilla, turnos y fichajes (necesita el módulo «Personal y turnos» activo en el hotel: en la demo lo está) |
| **Finanzas** | RRHH y nóminas | Pestañas **Nóminas · Plantilla · Previsión de plantilla · Panel RRHH**: contratos, periodos, recibos, exportación a la gestoría, coste de personal e incidencias; expedientes; necesidad de personal por día; la foto de RRHH |

- Al entrar aterrizas directamente en **RRHH y nóminas**, pestaña «Nóminas» (`/finanzas/nominas`); las otras tres pestañas viven en `/finanzas/nominas/plantilla`, `/finanzas/nominas/prevision` y `/finanzas/nominas/panel`.
- No tienes «Mi día»: si abres `/hoy` verás «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla. Pide acceso a dirección.» con el botón «Ir a mi página de inicio». Lo mismo ocurre con Estados contables y con el resto de pantallas de Finanzas y Cumplimiento.
- Excepción: `/configuracion/usuarios` (Usuarios y roles) sí se abre por URL, en solo lectura, aunque no esté en tu menú (ver «Para quién»).
- No ves el botón «+ Nueva reserva» de la barra superior.
- El buscador «Buscar en el menú» de la barra lateral y la búsqueda global (⌘K) funcionan igual que para el resto de perfiles (ver [00-primeros-pasos.md](00-primeros-pasos.md)).

---

## 1. Nóminas: la pantalla

**Menú › Finanzas › RRHH y nóminas › pestaña «Nóminas»** · `/finanzas/nominas`

![Nóminas con la pestaña «Periodos» activa](img/rrhh/nominas.png)
*Nóminas con la pestaña «Periodos (1)» activa: el periodo 2026-09 de demostración ya exportado y, arriba, los cuatro indicadores.*

Qué hay en la pantalla:

1. Cabecera «FINANZAS · GRUPO HOTELERO DEMO SL», título **«RRHH y nóminas»** y la tira de pestañas **«Nóminas · Plantilla · Previsión de plantilla · Panel RRHH»** (en la captura, anterior a esta versión, el título era «Nóminas» y no había tira). Debajo, el texto de la pestaña Nóminas: «Contratos, periodos mensuales y exportación a la gestoría. El cálculo bruto → IRPF → Seguridad Social → neto usa los porcentajes del régimen general y se contabiliza (640/642 contra 465/4751/476); el pago asienta 465 contra tesorería.»
2. Selector de **ámbito** a la derecha: «Sociedad · Grupo Hotelero Demo SL (todo)», «Centro · Hotel Demo Madrid Centro (AMC)» o «Centro · Hotel Demo Tenerife Sur (ATS)». La sociedad es el empleador (un solo NIF): con «(todo)» ves los contratos de todos los centros; con un centro, solo los suyos. El ámbito elegido se recuerda entre pantallas de Finanzas.
3. Botones «Actualizar», «Abrir periodo», «Incidencias del mes» (apartado 3.6), «Nueva ficha» y «Nuevo contrato».
4. Vistas **«Contratos (n) · Periodos (n) · Recibos · Coste de personal»** (el selector propio de la pestaña Nóminas, debajo de la tira de pestañas de RRHH y nóminas).
5. Indicadores (en las tres primeras pestañas): **PERIODOS ABIERTOS** («pendientes de calcular»), **ÚLTIMO CALCULADO** (código del periodo y su bruto), **BRUTO DEL MES** («periodo AAAA-MM» del mes en curso) y **CONTRATOS ACTIVOS** («n contratos en total»).

**Resultado esperado:** con la demo recién abierta verás «Contratos (0)», «Aún no hay contratos · Da de alta el contrato de cada empleado para incluirlo en los periodos de nómina.» y, en Periodos, el periodo `2026-09` creado para esta guía.

**Si algo falla:**
- «No se pudieron cargar las nóminas» → pulsa «Reintentar» o «Actualizar»; si persiste, avisa a sistemas (el servidor no responde).
- «Sin acceso» → tu usuario no tiene la plantilla «RRHH y nóminas» en este hotel: pide a sistemas que te la asigne en Configuración › Usuarios y roles.

> **Nota:** los porcentajes del cálculo son los tipos de cotización de 2026 (Orden PJC/297/2026), fijos sobre el bruto: Seguridad Social del trabajador **6,50 %** y de la empresa **32,15 %** en indefinidos y fijos discontinuos (en los temporales, 6,55 % y 33,35 %); el IRPF, si no lo fijas en el contrato, sale de una tabla orientativa por tramos del bruto anual (bruto mensual × 12): hasta 12.000 € → 0 %, hasta 20.000 € → 8 %, hasta 35.000 € → 15 %, hasta 60.000 € → 22 %, por encima → 30 %. No se aplican las bases mínimas y máximas de cotización ni las tablas reales del IRPF: la nómina oficial la sigue haciendo la gestoría (ver «Qué no hace todavía» y el aviso «Modo externo» del apartado 3).

---

## 2. Contratos: «Nueva ficha» y «Nuevo contrato»

**Menú › Finanzas › RRHH y nóminas › Nóminas › vista «Contratos»** · `/finanzas/nominas`

Un contrato dice cuánto cobra cada empleado al mes; al calcular un periodo, ehotelOS genera un recibo por cada contrato activo. Cada contrato cuelga de una **ficha de personal** (la persona y su centro de trabajo), así que el alta tiene dos pasos: primero la ficha, después el contrato.

### 2.1 Paso previo: la ficha de personal («Nueva ficha»)

La ficha vincula a una persona **con acceso a ehotelOS** (ver la ficha de formación «Dar de alta un usuario») con el centro de trabajo. Sin ficha no hay contrato: el cajón «Nuevo contrato» solo ofrece las fichas ya creadas.

1. Pulsa **«Nueva ficha»** (arriba a la derecha, junto a «Nuevo contrato»; también en el bloque vacío «Aún no hay contratos» cuando no existe ninguna ficha). Se abre el cajón «Nueva ficha de personal» («La ficha vincula a una persona con acceso a la aplicación con su centro de trabajo; el contrato se da de alta después sobre la ficha.»).
2. Bloque **«Persona y centro»**:
   - **«Centro de trabajo»** (solo aparece cuando el «Ámbito» de la pantalla es toda la sociedad; con un centro elegido en el ámbito, la ficha es de ese centro).
   - **«Persona»** (obligatorio): lista «nombre · correo» de las personas con acceso en ese centro. Si la persona no aparece, primero hay que invitarla en Configuración › Usuarios y roles (tú puedes consultar esa pantalla por URL, en solo lectura; invitar es de sistemas o dirección).
   - **«Código de empleado»** (opcional, hasta 32 caracteres): el código de tu convenio o de la gestoría; es lo que verás en las tablas en vez del identificador interno.
   - **«Departamento»** (opcional): los departamentos del centro. Si tu plantilla no tiene el permiso de configuración del centro, el selector queda vacío y la ficha se crea sin departamento.
   - **«Modalidad»**: Indefinido · Temporal · Fijo discontinuo · Prácticas · Otro.
   - **«Coste hora (€)»** (opcional): coste para la empresa por hora trabajada, con dos decimales como máximo.
3. Pulsa **«Crear ficha»** («Cancelar» cierra sin guardar).

**Resultado esperado:** aviso «Ficha creada.»; el cajón se cierra y «Nuevo contrato» se abre ya con esa ficha seleccionada. En **Menú › Configuración › Sistema › Auditoría** queda el evento «STAFF_PROFILE_CREATED» con tu usuario como actor (sin nombre ni correo de la persona: solo identificadores y el código de empleado).

**Si algo falla:**
- «Elige la persona de la ficha.» / el botón «Crear ficha» sigue gris → falta la persona, o el código supera 32 caracteres, o el coste hora no es un importe válido («El coste hora debe ser un importe mayor o igual que 0 con dos decimales como máximo.»).
- «No se pudo crear la ficha · Ya existe una ficha de personal activa para esta persona en la propiedad.» → esa persona ya tiene ficha en ese centro: úsala en «Nuevo contrato» (una persona puede tener una ficha por centro).
- «No hay personas con acceso en este centro: invítalas en Configuración › Usuarios y roles.» → la persona todavía no es usuario de ehotelOS en ese centro.
- «El departamento no pertenece a la propiedad de la ficha.» → has cambiado de centro con un departamento del centro anterior seleccionado: vuelve a elegir el departamento.

### 2.2 El contrato («Nuevo contrato»)

1. En la pestaña «Contratos» pulsa **«Nuevo contrato»** (arriba a la derecha o en el bloque vacío). Se abre el cajón «Nuevo contrato» con el aviso: «El empleado debe tener una ficha de personal en el centro («Nueva ficha»); el contrato entra en el siguiente periodo que se calcule.»
2. Bloque **«Empleado y modalidad»**:
   - **«Ficha de personal»** (obligatorio): selector con las fichas del ámbito, rotuladas con el código de empleado (o el nombre de la persona si la ficha no tiene código); si acabas de crear una, viene seleccionada. Sin fichas el selector está desactivado con la nota «Aún no hay fichas en este ámbito: créala con «Nueva ficha».».
   - **«Modalidad de contrato»** (obligatorio): Indefinido · Temporal · Fijo discontinuo · Prácticas · Formación · Sustitución.
   - **«Inicio»** (obligatorio; por defecto, hoy) y **«Fin»** (opcional; no puede ser anterior al inicio).
3. Bloque **«Retribución»**:
   - **«Bruto mensual (€)»** (obligatorio): importe mayor o igual que 0, con dos decimales.
   - **«Periodicidad»**: Mensual · Quincenal · Semanal.
   - **«Pagas anuales»** (opcional): «Entre 12 y 16; vacío: las del convenio del centro (12 más sus pagas extra; 14 sin convenio).»
   - **«IRPF (%)»** (opcional): «Vacío: se calcula automáticamente.» (tabla orientativa del apartado 1).
   - **«Grupo de cotización»** (opcional): texto libre, por ejemplo «Grupo 5 · Oficiales administrativos».
4. Pulsa **«Guardar contrato»** («Cancelar» cierra sin guardar).

![Cajón «Nuevo contrato» relleno con datos ficticios](img/rrhh/nuevo-contrato.png)
*El cajón «Nuevo contrato» con datos ficticios, 1.650 € de bruto mensual y grupo de cotización de ejemplo, justo antes de «Guardar contrato» (captura anterior a esta versión: el campo del empleado es ahora el selector «Ficha de personal»).*

**Resultado esperado:** aviso «Contrato guardado»; el contrato aparece en la tabla con las columnas EMPLEADO (código de empleado de la ficha —o el nombre de la persona si la ficha no tiene código— y grupo de cotización), MODALIDAD, BRUTO MENSUAL, PAGAS, IRPF («automático» si lo dejaste vacío), VIGENCIA («desde <fecha>» o el rango) y ESTADO (Activo). El indicador CONTRATOS ACTIVOS sube en uno. Comprobado en la demostración el 19/09/2026: ficha `MANUAL-F10-001` (temporal, departamento Reception, 12,50 €/hora) y su contrato indefinido de 1.800 € con 14 pagas.

**Dar de baja un contrato:** en su fila pulsa **«Desactivar»** y confirma en «¿Desactivar el contrato de …?» («El contrato dejará de entrar en los próximos periodos de nómina. Los recibos ya calculados no cambian.»). Además de sacar al empleado de las próximas nóminas, la baja retira los accesos a ehotelOS del usuario vinculado a esa ficha.

**Si algo falla:**
- El botón «Guardar contrato» sigue gris → falta la ficha, el bruto o el inicio, o hay un error debajo de un campo: «Elige la ficha de personal.», «Indica el bruto mensual.», «El bruto debe ser un importe mayor o igual que 0.», «La fecha de fin no puede ser anterior a la de inicio.», «El IRPF debe estar entre 0 y 100.», «Entre 12 y 16 pagas anuales.».
- El selector «Ficha de personal» está desactivado con «Aún no hay fichas en este ámbito: créala con «Nueva ficha».» → vuelve al apartado 2.1.
- «No se pudo guardar · Perfil de empleado no encontrado.» → la ficha se borró o pertenece a un centro fuera de tu ámbito: pulsa «Actualizar» y vuelve a elegirla.

> **Nota:** las **pagas extras** se guardan en «Pagas anuales» pero todavía no se prorratean en el recibo mensual: el recibo lleva el bruto mensual completo (o la parte proporcional a los días del contrato dentro del mes).

---

## 3. Periodos: abrir, calcular, exportar y pagar

**Menú › Finanzas › RRHH y nóminas › Nóminas › vista «Periodos»** · `/finanzas/nominas`

Un periodo es un mes natural. El ciclo es: **Abrir periodo → Calcular y contabilizar → Aprobar (dirección) → Recibos → Exportar a la gestoría → Pagar**.

Encima de la lista, un aviso azul dice en qué modo trabaja el periodo: **«Modo externo: la gestoría calcula; el ERP importa el agregado»** (el de todos los periodos nuevos: «Los recibos que calcula ehotelOS son una preparación: el registro oficial lo emite la gestoría y el coste real entra por «Coste de personal» (importación del agregado por centro y mes). Aprobar y exportar siguen siendo el circuito de control.») o **«Modo calculado: preparación interna, validar con la gestoría»**; el aviso añade cuántos periodos calculados esperan la aprobación de dirección. En la tabla, junto al periodo va la etiqueta «Externo» o «Calculado», y junto al estado, «Aprobado» cuando dirección ya lo aprobó.

### 3.1 Abrir el periodo del mes

1. Pulsa **«Abrir periodo»** (arriba a la derecha o en el bloque vacío «Aún no hay periodos · Abre el periodo del mes en curso para calcular los recibos de los contratos activos.»).
2. En el cajón «Abrir periodo de nómina» («Un periodo por mes natural; se calcula con los contratos activos en ese mes.») revisa **«Mes (AAAA-MM)»**: viene relleno con el mes en curso (`2026-09` en la demo).
3. Pulsa **«Abrir periodo»**.

**Resultado esperado:** aviso «Periodo 2026-09 abierto» y una fila nueva en «Periodos de nómina»: PERIODO `2026-09` («1–30 sept 2026»), ESTADO **ABIERTO**, BRUTO · IRPF · SEGURIDAD SOCIAL · NETO a 0,00 € y las acciones **«Calcular · Exportar · Pagar · Recibos»** (dirección ve además «Aprobar»; Exportar y Pagar están desactivadas hasta calcular: «Calcula el periodo antes de exportarlo»; y, además, hasta que dirección apruebe el periodo: «Dirección debe aprobar el periodo antes de exportarlo a la gestoría» / «… antes de pagarlo»). El indicador PERIODOS ABIERTOS pasa a 1.

**Si algo falla:**
- «El periodo debe tener el formato AAAA-MM.» → escribe año y mes con guion, por ejemplo `2026-10`.
- «No se pudo abrir el periodo · El periodo 2026-09 ya existe.» → ya estaba abierto: búscalo en la tabla.

### 3.2 Calcular y contabilizar

1. En la fila del periodo pulsa **«Calcular»**.
2. Confirma en el diálogo «Calcular el periodo 2026-09»: «Genera un recibo por cada contrato activo y contabiliza el devengo (640/642 contra 465, 4751 y 476).» con el botón **«Calcular y contabilizar»**.

**Resultado esperado:** aviso «Periodo 2026-09 calculado y contabilizado»; el estado pasa a **CALCULADO**, las columnas muestran los totales y «Calcular» pasa a ser **«Recalcular»** («Exportar» y «Pagar» se activan cuando dirección aprueba; una vez aprobado, «Recalcular» se desactiva: «El periodo ya está aprobado por dirección: no se recalcula»). El indicador ÚLTIMO CALCULADO muestra el periodo.

Qué contabiliza, por cada recibo y con fecha del último día del mes: **D 640** Sueldos y salarios (bruto), **D 642** Seguridad Social a cargo de la empresa (32,15 %), **H 4751** retención de IRPF, **H 476** Seguridad Social acreedora (trabajador + empresa) y **H 465** líquido a pagar. Ejemplo con un bruto de 1.800,00 € e IRPF del 15 % (contrato indefinido): SS trabajador 117,00 · SS empresa 578,70 · IRPF 270,00 → neto 1.413,00 (asiento D 640 1.800,00 / D 642 578,70 / H 476 695,70 / H 4751 270,00 / H 465 1.413,00). La retención queda registrada para el modelo 111 (rendimientos del trabajo), que consulta contabilidad en Cumplimiento › Modelos AEAT.

- **«Recalcular»** (periodo ya calculado): «Anula los asientos anteriores del periodo con asientos de anulación, regenera los recibos y vuelve a contabilizar. Nada se borra.» Úsalo si has añadido o desactivado contratos después de calcular. No se puede recalcular un periodo ya pagado («El periodo … ya está pagado: revierte el pago antes de recalcular.») ni cerrado.

> **Nota:** en la demo el periodo `2026-09` se calculó **sin contratos**: quedó CALCULADO con 0 recibos, 0,00 € en todas las columnas y sin asientos. Es el estado que ves en la captura del apartado 1.

### 3.2.1 Aprobar el registro (solo dirección)

1. Con el periodo en estado CALCULADO, quien tiene una plantilla de dirección ve en su fila la acción **«Aprobar»** (entre «Recalcular» y «Exportar»; también con ⌘K «Aprobar el periodo»). Con la plantilla «RRHH y nóminas» no la ves: pídeselo a dirección.
2. Dirección confirma en «Aprobar el registro de nómina 2026-09»: «Dirección da por bueno el registro calculado (neto …, … bruto): a partir de aquí se puede exportar a la gestoría y registrar el pago. Quien calculó el periodo no puede aprobarlo; la aprobación queda auditada.», con una **«Nota»** opcional («Se guarda en la auditoría de la aprobación (hasta 1.000 caracteres).»).

**Resultado esperado:** aviso «Periodo 2026-09 aprobado: ya se puede exportar y pagar», estado **APROBADO** (la etiqueta «Aprobado» se conserva cuando después se exporta) y «Pagar» habilitado. Quien calculó el periodo no puede aprobarlo (separación de funciones): el servidor lo rechaza. Comprobado en el hotel de pruebas de RRHH el 20/09/2026: el periodo 2026-09 pasó de calculado a aprobado y exportado.

### 3.3 Ver los recibos

1. Pulsa **«Recibos»** en la fila del periodo (o haz clic en la fila). La pestaña pasa a llamarse «Recibos · 2026-09» y muestra el estado del periodo.
2. La tabla lleva EMPLEADO · DÍAS · BRUTO · IRPF · SS TRABAJADOR · SS EMPRESA · NETO · ESTADO (Borrador · Emitido · Pagado), con los totales del periodo al pie. **«Cambiar de periodo»** vuelve a la lista.

**Si algo falla:** «Elige un periodo · Abre un periodo desde la pestaña «Periodos» para ver sus recibos.» (no has seleccionado ninguno) o «Aún no hay recibos · Calcula el periodo para generar un recibo por cada contrato activo.» (periodo sin calcular o sin contratos).

### 3.4 Exportar a la gestoría

1. En la fila del periodo pulsa **«Exportar»**.
2. En el diálogo «Exportar 2026-09 a la gestoría» («La exportación queda auditada y marca el periodo como exportado. Los formatos A3 y Sage son compatibles, no el diseño de registro oficial: valídalos con la gestoría.») elige el **«Formato»**: «A3 Nóminas (compatible)», «Sage (compatible)» o «CSV universal».
3. Pulsa **«Exportar y descargar»**.

**Resultado esperado:** el navegador descarga el fichero y aparece el aviso «Exportación A3 de 2026-09 descargada» con la etiqueta **«VALIDAR CON LA GESTORÍA»**, el resumen «nominas-2026-09-a3.txt · n recibos · empleador Grupo Hotelero Demo SL · NIF B12345674 · sin CCC» y los botones «Descargar» (vuelve a descargar) y «Ocultar». El estado del periodo pasa a **EXPORTADO**. Qué fichero sale:

| Formato | Fichero | Contenido |
|---|---|---|
| A3 Nóminas (compatible) | `nominas-2026-09-a3.txt` | Una línea por recibo separada por `\|`, con el NIF de la sociedad en la primera columna |
| Sage (compatible) | `nominas-2026-09-sage.csv` | Cabecera `Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net` y una fila por recibo |
| CSV universal | `nominas-2026-09.csv` | Cabecera `periodo;empleado;codigo_empleado;nif_empleado;dias;bruto;irpf_pct;irpf;ss_trabajador;ss_empresa;neto;nif_empresa;ccc`, separador «;», decimales con coma, UTF-8 |

Avisos que verás bajo el resumen y qué significan:
- «Formato compatible, no el diseño de registro oficial: validar con la gestoría.» → la gestoría debe comprobar que su programa lo importa.
- «Sin código de cuenta de cotización (CCC) en el centro ni en la sociedad: la gestoría lo completa.» → el CCC se rellena en Configuración › Estructura societaria (centros y sociedad), que gestiona administración o sistemas; mientras falte, la columna va vacía.
- «El NIF del empleado no se almacena en ehotelOS: la columna lleva el código de empleado.» → ehotelOS no guarda el DNI del empleado; la gestoría cruza por el código.

**Si algo falla:** «Exportar» desactivado con «Calcula el periodo antes de exportarlo» → calcula primero; con «Dirección debe aprobar el periodo antes de exportarlo a la gestoría» → pide la aprobación (apartado 3.2.1). Si el centro ya tiene el coste de ese mes importado desde la gestoría (apartado 4), «Calcular» responde «ya tiene un lote de coste de personal contabilizado …: nómina en modo externo, no se calcula»: ese mes es de la gestoría. Un periodo sin recibos exporta un fichero vacío (en la demo, `nominas-2026-09-a3.txt` con 0 recibos).

### 3.5 Pagar las nóminas

1. En la fila del periodo pulsa **«Pagar»**.
2. En el diálogo «Pagar las nóminas de 2026-09» lee el resumen: «Asiento D 465 Remuneraciones pendientes de pago / H 572 por el neto del periodo, <importe>. Solo se deshace con un asiento de anulación.»
3. Rellena **«Fecha de pago»** (hoy por defecto), **«Cuenta de tesorería»** («572 Bancos por defecto; una subcuenta 572x o 570 Caja.») y, si quieres, **«Referencia»** («Remesa o transferencia»).
4. Pulsa **«Registrar el pago»**.

**Resultado esperado:** aviso «Nóminas de 2026-09 pagadas y contabilizadas», etiqueta **Pagado** junto al estado, recibos en estado «Pagado» y «Recalcular»/«Pagar» desactivados («Pagado el <fecha>»).

**Si algo falla:**
- «Calcula el periodo de nómina antes de exportarlo o pagarlo.» → el periodo no está calculado **o no tiene líquido a pagar** (es lo que devuelve la demo, con 0,00 € de neto).
- Con la plantilla «RRHH y nóminas» el pago exige que **dirección haya aprobado el registro del mes** y que quien paga no sea quien aprobó (separación de funciones): sin aprobación el servidor lo rechaza («El registro de nómina 2026-09 no está aprobado.»).

> **Nota:** la aprobación tiene botón en la pantalla para dirección (apartado 3.2.1); la bandeja **Pendientes de aprobación** (`/hoy/pendientes`) no recibe una solicitud automática de tipo «Nómina». El circuito es: RRHH calcula y exporta → dirección aprueba en Nóminas → tesorería registra el pago (o la gestoría lo hace fuera de ehotelOS, en modo externo).

### 3.6 Incidencias del mes para la gestoría

1. Pulsa **«Incidencias del mes»** (arriba a la derecha; también con ⌘K «Descargar las incidencias del mes»). Solo lo ve quien tiene la clave de exportación de nóminas (tu plantilla).
2. En el diálogo «Incidencias del mes para la gestoría» («Altas, bajas, cambios de contrato y ausencias aprobadas del mes, identificadas por número de empleado (nunca por NIF), en CSV para la gestoría.») indica **«Mes (AAAA-MM)»** y el **«Centro de trabajo»**: con un centro elegido en el «Ámbito» va fijo («El centro del «Ámbito».»); con toda la sociedad, el desplegable ofrece «Toda la sociedad» o un centro («Toda la sociedad» necesita la clave de lectura de sociedad; si no, elige un centro).
3. Pulsa **«Descargar CSV»**.

**Resultado esperado:** el navegador descarga un CSV (separador «;», UTF-8) con la cabecera `centro;numero_empleado;empleado;tipo;codigo;desde;hasta;dias;horas;detalle` y una fila por incidencia: alta (código = modalidad del contrato), baja (código = causa), cambio de contrato (inicio de un contrato nuevo, o fin de contrato sin baja del expediente) y ausencia aprobada (tipo y días dentro del mes); aparece el aviso «Incidencias de AAAA-MM descargadas: n filas» y, si procede, un recuadro con los avisos (por ejemplo, ausencias de fichas sin expediente, que no caben en el fichero). No lleva horas extra: todavía no hay registro de jornada.

**Si algo falla:** «El mes debe tener el formato AAAA-MM.» → escribe, por ejemplo, `2026-09`. «Sin ámbito de toda la sociedad: elige un centro de trabajo o pide la clave de lectura de sociedad.» → tu plantilla no lee toda la sociedad: elige un centro en el diálogo.

---

## 4. Importar el coste de personal (informe agregado de RRHH)

**Menú › Finanzas › RRHH y nóminas › Nóminas › vista «Coste de personal»** · `/finanzas/nominas`

Cuando la nómina la hace la gestoría, el coste real de personal entra en ehotelOS como **informe agregado por centro, mes, grupo y departamento**, nunca por persona. Cada fichero es un lote; al contabilizarlo, ehotelOS asienta un apunte por centro y mes (640 y 642 por departamento USALI contra 465 y 476) y alimenta el informe del apartado 5.

### 4.1 Prepara el CSV

Cabecera obligatoria (separador «;», decimales con coma o punto, mes como `AAAA-MM` o `MM/AAAA`, guardado como UTF-8):

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados
```

Columnas opcionales al final: `ventas_sin_iva`, `hab_disponibles` y `usali` (código del departamento USALI cuando el nombre no se reconoce solo). Ejemplo mínimo válido, el mismo que se importó en la demo (`MANUAL-RRHH-coste-personal-2026-08.csv`):

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados
Hotel Demo Madrid Centro;2026-08;operaciones;Recepción;6.000,00;1.800,00;7.800,00;3
Hotel Demo Madrid Centro;2026-08;operaciones;Pisos;5.200,00;1.560,00;6.760,00;4
Hotel Demo Madrid Centro;2026-08;operaciones;Cocina;4.400,00;1.320,00;5.720,00;2
Hotel Demo Madrid Centro;2026-08;mantenimiento_obra;Mantenimiento;2.100,00;630,00;2.730,00;1
Hotel Demo Madrid Centro;2026-08;estructura;Administración;3.000,00;900,00;3.900,00;1
```

Reglas de cada columna:
- **centro**: el nombre o el código del centro tal como está en ehotelOS («Hotel Demo Madrid Centro» o «AMC»). Si no coincide, el cajón te pedirá el mapeo (paso 4.2).
- **mes**: un mes natural; un lote puede traer varios meses y varios centros (una fila de asiento por cada combinación).
- **grupo**: `operaciones`, `extras`, `estructura`, `mantenimiento_obra` o `familia`.
- **departamento**: etiqueta libre. ehotelOS reconoce por nombre Recepción y Pisos (→ Habitaciones), Cocina, Restaurante y Cafetería (→ Alimentos y bebidas), Mantenimiento (→ Mantenimiento y operación de la propiedad), Dirección y Administración (→ Administración y general) y Comercial (→ Ventas y marketing); cualquier otra etiqueta se mapea a mano o con la columna `usali`.
- **salario_bruto**, **coste_ss** (Seguridad Social a cargo de la empresa) y **coste_total** (= bruto + SS; si no cuadra, aviso con el número de línea). **empleados**: personas del mes en esa fila.

### 4.2 Importa y contabiliza

1. En la pestaña «Coste de personal» pulsa **«Importar informe»**. Se abre el cajón «Importar informe de coste de personal» («Informe agregado de RRHH por centro, mes, grupo y departamento: nunca nombres ni datos por persona. Se contabiliza un asiento por centro y mes (640 y 642 por departamento USALI contra 465 y 476).»).
2. Bloque **«1 · Fichero o texto»** («CSV con separador «;» (decimales con coma o punto) o el JSON del informe agregado. Cabecera obligatoria.»): pulsa **«Elegir fichero»** (CSV o JSON de hasta 1 MB) **o pega el contenido** en «…o pega aquí el CSV / JSON». Debajo tienes el recordatorio del formato. «Quitar fichero» descarta el fichero elegido.
3. Pulsa **«Previsualizar»**. Aparece «PREVISUALIZACIÓN SIN ESCRIBIR NADA: AGO 2026» (o el rango de meses).
4. Si ehotelOS no reconoce algún centro o departamento, aparece el bloque **«2 · Mapeo»**: elige el centro («Elige un centro de trabajo») o el departamento USALI («Elige un departamento USALI») de cada etiqueta; cada cambio vuelve a previsualizar.
5. Revisa el bloque **«Vista previa»** («Lo que se contabilizará: una fila por centro y mes = un asiento.»): las etiquetas «n FILAS · n CENTRO × MES · n ERRORES · n AVISOS» y el total por grupo; los importes **SALARIO BRUTO**, **SEGURIDAD SOCIAL EMPRESA**, **COSTE A CONTABILIZAR** y **EMPLEADOS MEDIOS**; y la tabla «Asientos previstos por centro y mes» (CENTRO · MES · FILAS · BRUTO · SS EMPRESA · COSTE · EMPLEADOS · EMPLEADOS DEL INFORME · DEPARTAMENTOS).
6. Pulsa **«Contabilizar»** (solo se activa cuando no hay errores, todo está mapeado y no hay conflicto con otro lote).

![Cajón «Importar informe de coste de personal» con la vista previa](img/rrhh/importar-coste.png)
*El CSV de ejemplo cargado y previsualizado: 5 filas, 1 centro × mes, 0 errores, 26.910,00 € a contabilizar. Nada se escribe hasta pulsar «Contabilizar».*

**Resultado esperado:** aviso verde «1 asiento contabilizado (nº 258, ejercicio 2026)» con «Lote MANUAL-RRHH-coste-personal-2026-08.csv · ago 2026 · coste 26.910,00 €» y la lista de asientos («2026/258 · AMC · ago 2026 · 26.910,00 €»); el botón del pie pasa a «Cerrar». Al cerrar, la pestaña ya muestra el coste en los indicadores y en la tabla, y el lote aparece en **«Importaciones»** (FECHA · FICHERO · PERIODO · FILAS · COSTE · ESTADO Contabilizado · ASIENTOS) con la acción «Revertir». El asiento de la demo (2026/258, fecha 31/08/2026) lleva D 640 por departamento (Habitaciones 11.200,00 · Alimentos y bebidas 4.400,00 · Mantenimiento 2.100,00 · Administración y general 3.000,00), D 642 por departamento (3.360,00 · 1.320,00 · 630,00 · 900,00), H 465 20.700,00 y H 476 6.210,00.

**Si algo falla:**
- «No se pudo previsualizar» con «Cabecera inválida: faltan las columnas «…». Cabecera esperada: centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados[;ventas_sin_iva;hab_disponibles;usali].» → corrige la primera línea del fichero. «El fichero está vacío: falta la cabecera …» → el fichero no tiene contenido.
- «Filas que no se pueden contabilizar» con «Línea n: …» → mes no válido, importe no numérico o negativo, empleados negativos.
- «El texto supera el millón de caracteres: carga el informe con la herramienta de línea de comandos.» → pide a sistemas que lo cargue por línea de comandos.
- Aviso naranja **«Este informe ya está importado»** → el mismo contenido ya es un lote vivo («Un lote = un fichero (mismo contenido, mismo lote: no se importa dos veces).»). **«Hay centros y meses ya contabilizados»** → otro lote ya cubre alguna celda centro × mes. En ambos casos «Contabilizar» queda desactivado salvo que actives **«Sustituir los lotes anteriores (reverso + lote nuevo)»**, que revierte ENTEROS los lotes afectados y contabiliza el nuevo en la misma operación: reimporta siempre el rango completo. **«Hay nóminas reales contabilizadas en esos meses»** → ya hay un periodo de nómina calculado en ese centro y mes; comprueba que el coste no se devengue dos veces.
- «Necesitas el permiso de gestión de nóminas para previsualizar y contabilizar una importación…» → tu usuario solo tiene lectura; el informe se puede consultar igualmente.

### 4.3 Revertir un lote

1. En «Importaciones», en la fila del lote Contabilizado, pulsa **«Revertir»**.
2. El diálogo «Revertir la importación <fichero>» explica: «Se contabiliza un asiento de reverso por cada uno de los n asientos del lote (<meses>, <importe>). Los originales se conservan marcados como anulados; ningún otro asiento del diario cambia.»
3. Escribe el **«Motivo»** (obligatorio: «Obligatorio: va a la descripción de cada asiento de reverso.», por ejemplo «Informe corregido por RRHH») y, si hace falta, la **«Fecha de la anulación»** («Vacía: cada reverso lleva la fecha de su asiento (mismo mes). Con la de hoy, todos caen en el periodo actual. Si un mes del lote está cerrado, reábrelo en Contabilidad › Periodos antes de revertir: el reverso no puede fecharse fuera del mes cerrado.»).
4. Pulsa **«Revertir la importación»**.

**Resultado esperado:** aviso «Importación revertida: n asientos anulados»; el lote pasa a estado Revertido («revertido el <fecha>») y su coste desaparece del informe. El pie de «Importaciones» lo resume: «Revertir anula los asientos del lote y solo esos; el resto del diario no se toca.»

> **Nota:** en la demo el diálogo se abrió y se canceló para conservar el lote de las capturas; el texto de arriba es el literal del diálogo. Reabrir un mes cerrado es tarea de contabilidad (Contabilidad › Periodos no está en tu menú).

---

## 5. Informe de coste por departamento y centro

**Menú › Finanzas › RRHH y nóminas › Nóminas › vista «Coste de personal»** · `/finanzas/nominas`

Es la misma pestaña del apartado 4, leída como informe. Lo que puedes ajustar:

1. **Ámbito** (arriba a la derecha): «Sociedad · … (todo)» para ver todos los centros y la fila «Sociedad» de totales, o un centro concreto.
2. Selectores **«Desde»** y **«Hasta»** (meses; por defecto el año en curso, «ene 2026 – sept 2026» en la demo) y **«Grupo»**: «Todos los grupos · Operaciones · Extras · Estructura · Mantenimiento y obra · Familia».
3. «Actualizar» recarga el informe; «Importar informe» abre el cajón del apartado 4.

Qué muestra:

- Indicadores: **COSTE DE PERSONAL** (con «bruto … · Seguridad Social …» y el rango), **COSTE POR EMPLEADO** («acumulado del rango por empleado medio»), **PERSONAL S/ VENTAS** («s/ ventas del libro» o «s/ ventas de referencia del informe») y **EMPLEADOS MEDIOS** («suma de las filas importadas» o «según el informe de RRHH»).
- Tabla **«Coste de personal por centro y mes»**: por cada centro, las filas Empleados · Coste · Coste por empleado · % s/ ventas, una columna por mes y el TOTAL; el botón **«Departamentos»** bajo el nombre del centro despliega el desglose por departamento USALI («Ocultar departamentos» lo pliega). La cabecera dice cuántos centros y lotes contabilizados incluye y cuándo se generó. El pie explica cada indicador: «Empleados: referencia del informe cuando existe; si no, la suma de las filas importadas (sobrecuenta a quien figura en dos grupos). Coste por empleado en «Total»: acumulado del rango entre los empleados medios. % s/ ventas: ventas netas del libro (grupo 70) cuando cubren el mes; «(ref.)» = ventas sin IVA declaradas en el informe.»
- Gráficos **«Coste de personal por mes»** y **«Ventas netas por mes (libro o referencia)»** («Libro mayor (grupo 70 del centro y mes) cuando tiene ventas; si no, las ventas sin IVA del informe de RRHH.»).
- Lista **«Importaciones»** con los lotes y su estado.

**Resultado esperado en la demo:** COSTE DE PERSONAL 26.910,00 € (bruto 20.700,00 € · Seguridad Social 6.210,00 €), COSTE POR EMPLEADO 2.446,36 € («26.910,00 € entre 11 empleados medios»), la columna AGO 2026 rellena para Hotel Demo Madrid Centro (AMC) y «1 lote contabilizado».

> **Nota:** el porcentaje **PERSONAL S/ VENTAS** de la demo sale disparado (miles por ciento) porque el hotel de demostración apenas tiene ventas en el libro (519,98 € en septiembre) y ningún lote con `ventas_sin_iva`. En un hotel real compara el coste con las ventas netas contabilizadas del mismo centro y mes; si tu informe trae la columna `ventas_sin_iva`, el indicador la usa como referencia y lo marca «(ref.)».

> **Nota:** el informe **USALI «Por centro»** y los **Estados contables** completos (cuenta de explotación por departamento con ingresos y otros gastos) no están en tu menú: los describe [20-administracion.md](20-administracion.md) para la plantilla de contabilidad. Tu vista se limita al coste de personal.

---

## 6. Personal y turnos

**Menú › Operaciones › Personal y turnos** · `/operaciones/personal`

![Personal y turnos con un turno y un fichaje ficticios](img/rrhh/personal-turnos.png)
*Personal y turnos tras crear el turno «Pisos · 20 sept · 08:00–16:00» y fichar la entrada de «MANUAL-RRHH Camarera de pisos 1».*

La pantalla («Plantilla, fichajes y turnos en vivo. Ficha entradas/salidas, crea turnos y aprueba ausencias.») tiene los indicadores **PLANTILLA** (total), **ACTIVOS HOY** (en turno), **HORAS (MES)**, **AUSENCIAS PENDIENTES** («al día» o «por aprobar») y **TURNOS HOY**, y cuatro bloques: «Fichaje», «Próximos turnos», «Ausencias pendientes» y «Plantilla por departamento». Se actualiza sola cada 30 segundos; «Actualizar» fuerza la recarga.

### 6.1 Crear un turno

1. Pulsa **«Nuevo turno»** (arriba a la derecha o en el bloque «Próximos turnos»).
2. En el cajón «Nuevo turno» («Elige la ficha de personal, el puesto y el horario. El turno se crea aunque incumpla una regla del convenio: la pantalla avisa.») rellena **«Ficha de personal»** (obligatorio: desplegable con las fichas del centro, rotuladas por código de empleado o nombre), **«Puesto»** (opcional, por ejemplo «Pisos»), **«Inicio»** y **«Fin»** (fecha y hora, obligatorios).
3. Pulsa **«Crear turno»**.

**Resultado esperado:** aviso «Turno creado.» y una fila en «Próximos turnos» con EMPLEADO · PUESTO · FECHA · HORARIO («Pisos · 20 sept · 08:00–16:00» en la demo). Si el turno incumple una regla del convenio o del Estatuto (descanso de 12 h entre jornadas, tope de horas al día, descanso semanal, horas extra del año) se crea igualmente y aparece el aviso naranja «Turno con n avisos: …».

> **Nota:** el turno se enlaza a la ficha de personal (ya no hay texto libre ni «Unassigned»): la lista muestra el código de empleado o el nombre de la ficha. El indicador TURNOS HOY solo cuenta turnos de hoy. La captura es anterior al selector de fichas.

### 6.2 Fichar entrada y salida

1. En el bloque «Fichaje» elige la **«Ficha de personal»** (desplegable con las fichas del centro; si no hay ninguna, el selector está desactivado con «No hay fichas de personal en este centro: créalas en Finanzas › Nóminas («Nueva ficha») antes de fichar o crear turnos.»). Quien solo puede fichar (camareras de pisos, mantenimiento, sala) ve únicamente su propia ficha, ya preseleccionada, y ficha con la hora del servidor; gobernanta, jefaturas y RRHH (gestión del reloj) fichan por cualquier persona del centro.
2. Pulsa **«Fichar entrada»** o **«Fichar salida»**.

**Resultado esperado:** aviso «Entrada registrada para <nombre>.» (o «Salida registrada para …») y una línea nueva en «Fichajes recientes» con la etiqueta «entrada» o «salida», el nombre y la hora.

**Si algo falla:**
- «Elige una ficha de personal: los turnos y fichajes ya no admiten nombres libres.» → no has elegido ninguna ficha en el desplegable.
- Con la plantilla «RRHH y nóminas» el servidor rechaza el fichaje (tu plantilla gestiona el reloj, no lo usa): ficha cada persona con su propio usuario, o su responsable de departamento. Una camarera de pisos sin la clave de lectura de nóminas ve el selector desactivado con el error de carga de las fichas (limitación registrada; la resuelve sistemas ampliando su plantilla).

### 6.3 Aprobar ausencias

Las solicitudes de vacaciones, baja médica, personales, sin sueldo u otras aparecen en «Ausencias pendientes» con EMPLEADO · TIPO · PERIODO y el botón **«Aprobar»** en cada fila.

**Resultado esperado:** aviso «Ausencia de <nombre> aprobada.» y la fila desaparece de pendientes. Quien pidió la ausencia no puede aprobarla: el servidor responde «Quien solicita no puede aprobar su propia solicitud: otra persona debe decidirla.». En la demo de las capturas no había ninguna («No hay ausencias pendientes · Cuando algún empleado solicite una baja o ausencia aparecerá aquí para revisar y aprobar.»); en el hotel de pruebas de RRHH hay una pendiente (baja médica: el tipo solo lo ven quienes leen expedientes; el resto ve «ausente»).

**Si algo falla:**
- La pantalla muestra «Módulo no activado» → el módulo «Personal y turnos» no está activo en este hotel; pídeselo a sistemas (Configuración › Módulos e integraciones).
- «Crear turno» sigue gris → falta el empleado, el inicio o el fin.
- Los indicadores siguen a 0 aunque fiches → PLANTILLA, ACTIVOS HOY y HORAS (MES) se calculan sobre las fichas de personal, que en la demo de las capturas no existían (ver apartado 2).

> **En construcción:** no hay formulario para **solicitar** una ausencia desde esta pantalla (las solicitudes entran por integración), ni planificación semanal ni cuadrante publicado con bloqueo: el bloque vacío lo sugiere («…o programa la planificación semanal»), pero hoy solo existe «Nuevo turno» uno a uno y las reglas del convenio avisan, no bloquean. Sin fichas de personal, «Plantilla por departamento» queda vacío («Sin plantilla asignada por departamento.»).

---

## 7. Live Timeline (solo lectura) y Pendientes de aprobación

### 7.1 Live Timeline

**Menú › Hoy › Live Timeline** · `/hoy/live-timeline`

La tienes para ver de un vistazo la ocupación (por ejemplo, para dimensionar turnos): reservas por habitación y día, con la navegación «Anterior · Hoy · Siguiente», la escala «Día · 7 / Semana · 14 / Mes · 30», los filtros ESTADO · CANAL · TIPO, el buscador por código, huésped o habitación y los contadores («n HABITACIONES · n RESERVAS VISIBLES · EN CASA · LLEGADAS HOY · SALIDAS HOY»). La primera vez verás la tarjeta de instrucciones de la pantalla; puedes cerrarla.

Tu plantilla solo concede **lectura** de reservas y huéspedes: mover o redimensionar una estancia, hacer check-in o cobrar son tareas de recepción y el servidor las rechaza para tu perfil. El detalle de la pantalla está en [70-recepcion.md](70-recepcion.md) y en [00-primeros-pasos.md](00-primeros-pasos.md).

### 7.2 Pendientes de aprobación

**Menú › Hoy › Pendientes de aprobación** · `/hoy/pendientes`

Bandeja de «Solicitudes de reembolso, ajuste, descuento, tarifa, factura de proveedor, pedido, nómina, CAPEX, anulación y reapertura del día. Quien solicita nunca aprueba; por encima de T4 hacen falta dos firmas.» Arriba ves «n pendientes que puedes decidir»; en «Filtros» eliges **«Estado»** (Todos los estados · Pendiente · Aprobada · Rechazada · Caducada) y **«Tipo»** (Todos los tipos · Reembolso · Ajuste de folio · Descuento en reserva · Cambio de tarifa · Factura de proveedor · Pedido de compra · Nómina · CAPEX · Anulación de factura · Reapertura del día). Quien tiene la clave de un tipo decide sus solicitudes desde la ficha de cada una (en la demo no hay solicitudes: la bandeja se ha recorrido vacía).

Para RRHH: puedes **pedir** aprobaciones de tipo «Nómina» (tu plantilla tiene la clave de solicitud) y ver las que hayas pedido; **decidirlas** corresponde a dirección (clave «payroll.approve»). Cuando no hay nada verás «Nada pendiente de aprobar · Aquí aparecen las solicitudes que puedes decidir con tus claves de aprobación y las que has pedido tú. Cambia los filtros para ver el histórico.»

> **En construcción:** hoy ninguna pantalla de Nóminas genera una solicitud de tipo «Nómina» (la aprobación del registro se hace en la propia pantalla de Nóminas, apartado 3.2.1), así que para RRHH esta bandeja está vacía salvo que otro proceso la use.

---

## 8. Plantilla: los expedientes

**Menú › Finanzas › RRHH y nóminas › pestaña «Plantilla»** · `/finanzas/nominas/plantilla`

El **expediente** es la persona ante la sociedad (NIF, afiliación, IBAN, contrato, baja); la **ficha de personal** del apartado 2.1 es esa persona en un centro (turnos, fichajes y contratos cuelgan de la ficha). Un expediente puede existir sin usuario de ehotelOS; una ficha exige usuario. La pestaña se comprobó el 20/09/2026 en el hotel de pruebas de RRHH («23 expedientes · 2 con contrato que vence en 30 días»).

Qué hay en la pantalla:

1. Selector de **ámbito** (sociedad o centro) y botones «Actualizar» y **«Nuevo expediente»** (solo con el permiso de gestión de expedientes; sin él ves la nota «Necesitas el permiso de gestión de expedientes (hr.employee.manage) para dar de alta, editar o dar de baja.»).
2. Bloque **«Expedientes»** con el recuento, el selector **«Activos · Excedencias · Bajas · Fijos discontinuos»** y el buscador «Buscar por nombre o número de empleado» (nunca por NIF: un NIF, NIE o IBAN tecleado responde «search no admite NIF, NIE ni IBAN»).
3. Tabla NOMBRE · Nº · CENTRO · PUESTO · DEPARTAMENTO (Habitaciones · Alimentos y bebidas · Otros departamentos operativos · Administración y dirección · Sistemas · Comercial y marketing · Mantenimiento) · CONTRATO / JORNADA («Indefinido · 40 h», «Fijo discontinuo · 40 h», «Sin contrato») · ESTADO (Activo · Baja · Excedencia) · VENCIMIENTO («Indefinido», la fecha de fin con etiqueta de aviso si vence en 30 días, «—» sin contrato, o la fecha de baja). La tabla **nunca** muestra NIF, NAF, correo, teléfono ni IBAN. Sin el permiso de lectura de expedientes ves «Sin acceso a la plantilla · Necesitas el permiso de lectura de expedientes (hr.employee.read) para ver la plantilla.».

### 8.1 Dar de alta un expediente

1. Pulsa **«Nuevo expediente»** (o ⌘K «Nuevo expediente»). Se abre el cajón con las vistas **«Datos · Contrato · Baja»**.
2. En «Datos», bloque **«Identidad»**: «Nombre» y «Apellidos» (obligatorios), **«NIF / NIE»** (obligatorio, «Con la letra de control; se guarda cifrado y nunca aparece en el listado.»), «Número de empleado» («Vacío: el sistema asigna el siguiente número de la sociedad.», por ejemplo `0025`), «Fecha de alta» (obligatoria) y «Sexo» (opcional, «Solo para el registro retributivo (RD 902/2020).»). Bloque **«Puesto y centro»**: «Centro de trabajo principal» («El contrato lleva su propio centro (la ficha).»), «Departamento USALI», «Puesto» y «Situación» (Activo · Excedencia; «La baja definitiva se registra en la vista «Baja».»). Bloque **«Datos de contacto y bancarios»** («Se guardan cifrados; solo se muestran en la ficha con «Mostrar» y cada consulta queda auditada.»): correo, teléfono, «Número de afiliación (NAF)» (12 dígitos) e IBAN, todos opcionales.
3. Pulsa **«Crear expediente»**.

**Resultado esperado:** aviso «Expediente <número> creado.» y la fila nueva en la tabla; en la auditoría queda el alta sin datos personales.

**Si algo falla:** «El NIF/NIE no es válido (letra de control incorrecta).» · «Ya existe un expediente con ese NIF en la sociedad.» · «Ya existe un expediente con ese número de empleado en la sociedad.» · aviso «Sin sociedad empleadora» en el cajón → el centro no tiene sociedad: pídeselo a administración (Estructura societaria).

### 8.2 Ver y corregir los datos cifrados

Al abrir un expediente, el bloque **«Datos personales cifrados»** («NIF, NAF, correo, teléfono e IBAN no viajan con la ficha: se piden con «Mostrar» y cada consulta queda registrada en la auditoría (HR_PII_READ).») está vacío: pulsa **«Mostrar»** para pedirlos (una consulta auditada; NIF, NAF e IBAN solo con el permiso de gestión, correo y teléfono con el de lectura). Para cambiarlos activa **«Corregir datos cifrados (vacío = sin cambio)»**, rellena solo lo que cambia y pulsa **«Guardar cambios»** («No hay cambios que guardar.» si no tocaste nada; «Expediente actualizado.» si sí). Un expediente dado de baja no se edita («El expediente está dado de baja.»).

### 8.3 Contrato desde el expediente

En la vista «Contrato»: bloque **«Contratos del expediente»** («Vigentes y cerrados; el vigente es el que aparece en el listado.») y, si la persona tiene ficha de personal en algún centro, el bloque **«Nuevo contrato»** («El convenio elegido rellena las pagas y la jornada a tiempo completo; puedes ajustarlas.»): «Ficha de personal», «Convenio» («Vacío: el convenio asignado al centro de la ficha.»), «Modalidad de contrato», «Bruto mensual (€)», «Inicio», «Fin», «Pagas anuales» («Entre 12 y 16; el convenio suma sus pagas extra a las 12 mensuales.»), «Jornada semanal (h)» («Hasta 60 h; 40 h a tiempo completo.»), «Porcentaje de jornada» («100 = jornada completa.»), «Grupo de cotización» y **«Fijo discontinuo»** («Se marca solo con la modalidad «Fijo discontinuo».»). Pulsa **«Guardar contrato»** → «Contrato creado.». Si el departamento supera la plantilla máxima aprobada, la aplicación avisa («El departamento supera la plantilla máxima aprobada.») pero no bloquea.

Sin ficha de personal el cajón muestra **«Sin ficha de personal en ningún centro»**: «El contrato se registra sobre una ficha de centro (persona con acceso a la aplicación): créala en Nóminas › Contratos con «Nueva ficha» y vuelve aquí.» (apartado 2.1).

### 8.4 Dar de baja

En la vista «Baja»: aviso **«La baja no se deshace»**, **«Fecha de baja»** (obligatoria, no anterior al alta) y **«Causa»** (Fin de contrato · Baja voluntaria · No superación del periodo de prueba · Despido objetivo · Despido disciplinario · Mutuo acuerdo · Jubilación · Otra causa). Pulsa **«Dar de baja»** y confirma en «Dar de baja a <nombre>» («Con fecha …. Se cierran los contratos vigentes, se desactivan las fichas y se revocan los accesos. No se puede deshacer.»).

**Resultado esperado:** aviso «Baja registrada: n contratos cerrados, n accesos revocados.»; el expediente pasa al segmento «Bajas» con la fecha en VENCIMIENTO y la persona pierde el acceso a ehotelOS. La baja aparece en las incidencias del mes (apartado 3.6).

---

## 9. Previsión de plantilla

**Menú › Finanzas › RRHH y nóminas › pestaña «Previsión de plantilla»** · `/finanzas/nominas/prevision`

«Necesidad de personal por día y departamento a partir de la ocupación prevista y los estándares del centro, frente al cuadrante, la plantilla disponible y el máximo aprobado.»

Cabecera: selector **«Centro»** (los hoteles de la sociedad, sin la oficina central), **«14 días · 28 días»**, fecha **«Desde»** (hoy por defecto), el aviso «n indicadores no disponibles» cuando falta algún dato, «Actualizar» y **«Generar previsión»** (necesita el permiso de planificación de turnos: tu plantilla lo tiene; dirección general, no).

### 9.1 Leer la previsión

- A la izquierda, un día por fila: fecha, origen de la ocupación («Reservas en cartera» · «Previsión del PMS» · «Ocupación real» · «Sin origen»), los FTE necesarios y la etiqueta **«Incompleta»** cuando faltan datos.
- A la derecha, el día elegido: los drivers **HAB. OCUPADAS · LLEGADAS · SALIDAS · HUÉSPEDES · DESAYUNOS · COSTE ESTIMADO** («—» y «Sin lote de coste contabilizado» sin importe); la tabla **«Necesario, planificado, disponible y máximo aprobado»** por departamento (NECESARIO · HORAS · PLANIFICADO «n FTE · n h» o «Sin cuadrante» · DISPONIBLE · MÁXIMO APROBADO o «Sin plan» · COBERTURA) y la gráfica «Por departamento» (Necesario · Planificado · Disponible). Debajo, **«Resumen del periodo»** por departamento (días, necesario y planificado medios, horas necesarias, disponible medio, máximo aprobado, coste estimado).
- Cómo se calcula: pisos por salidas, estancias y llegadas (minutos por habitación); recepción por tramos de habitaciones ocupadas (puestos de mañana, tarde y noche); alimentos y bebidas por cubiertos; mantenimiento por FTE cada 100 habitaciones; administración fija; todo con la jornada anual del convenio del centro. Un día sin reservas en cartera ni previsión del PMS queda «Incompleta» con «—»: ehotelOS **nunca inventa un FTE**. En el hotel de pruebas, sin previsión del PMS enlazada, todos los días salen «Incompleta» (aviso «Previsión incompleta: sin llegadas, sin salidas, sin habitaciones ocupadas…») aunque el cuadrante, la plantilla disponible y el máximo aprobado sí se pintan.

### 9.2 Generar la previsión

Pulsa **«Generar previsión»** (o ⌘K «Generar la previsión de plantilla»): aviso «Previsión generada: n filas · n días incompletos.» (naranja si hay días incompletos). Rehace la ventana elegida (hasta 92 días); la previsión es una foto: los departamentos sin estándar desaparecen.

### 9.3 Estándares de dotación

Sección con el recuento («n estándares · 4 estrellas · vigentes el <fecha>») y la tabla DEPARTAMENTO · CONCEPTO · VALOR (con su unidad) · MARGEN % · COBERTURA · TRAMOS · ORIGEN («Valor del sector» · «Medido en el centro» · «Convenio»). Con el permiso de estándares (tu plantilla) editas los valores y pulsas **«Guardar estándares»** (pie: «Cambios sin guardar: se abre una versión nueva desde hoy y se conserva la anterior.») → «Estándares guardados: n estándares desde <fecha>.». **«Restablecer valores del sector»** abre el diálogo «Restablecer los valores del sector» («Se cierran los estándares vigentes de <centro> y se abren los valores del sector para su categoría desde hoy. La versión anterior se conserva.») → «Valores del sector restablecidos (4 estrellas): 9 estándares.» (según las estrellas del centro: 2, 3 o 4). Pie: «Minutos por unidad, unidades por turno, FTE por 100 habitaciones o puestos por tramo; el margen y la cobertura absorben pausas, descansos y vacaciones.» Sin el permiso: «Necesitas el permiso de estándares de dotación (hr.standards.manage) para editar los estándares y preparar borradores de plantilla máxima.»

### 9.4 Plantilla máxima

Sección con «Aprobado: Temporada alta 2026 · n FTE» (o «Sin plan aprobado») y la tabla AÑO · TEMPORADA (Temporada alta · Temporada media · Temporada baja) · MESES · ESTADO (Borrador · Aprobado) · FTE MÁXIMO · POR DEPARTAMENTO.

1. **«Nuevo borrador»** (con el permiso de estándares) abre el cajón «Nuevo borrador de plantilla máxima»: «Año», «Temporada», «Desde el mes», «Hasta el mes» y un tope de FTE por departamento («Máximo de FTE por departamento (equivalentes a jornada completa). Deja en blanco los departamentos sin tope.»). Pulsa **«Guardar borrador»** → «Borrador guardado: Temporada … · n FTE.». Un borrador se puede reescribir; un plan aprobado, no («El plan de plantilla ya está aprobado.»).
2. **«Aprobar»** solo lo ve dirección general (permiso de aprobación de plantilla) y confirma en «Aprobar el plan …» («… Quien preparó el borrador no puede aprobarlo.») → «Plan aprobado: ….». Si quien preparó el borrador intenta aprobarlo: «Quien preparó el plan no puede aprobarlo: pídeselo a dirección.»

El máximo aprobado alimenta la columna MÁXIMO APROBADO, el indicador FTE DISPONIBLE del Panel RRHH y la alerta «Supera la plantilla máxima»; al dar de alta un contrato por encima del máximo, la aplicación avisa pero no bloquea.

**Si algo falla:** «No se pudo generar la previsión.» · «No se pudieron guardar los estándares.» con «El estándar de dotación no es válido.» (valor ≤ 0, margen fuera de 0-100 o cobertura fuera de 0,5-3) · «Necesitas el permiso de planificación de turnos (workforce.schedule.manage) para generar la previsión.» → pídeselo a sistemas.

---

## 10. Panel RRHH

**Menú › Finanzas › RRHH y nóminas › pestaña «Panel RRHH»** · `/finanzas/nominas/panel`

«La foto de la plantilla: personas y FTE disponibles frente al máximo aprobado y a la necesidad prevista, coste del mes sobre ventas, alertas y vencimientos.»

Cabecera: **ámbito** (sociedad o centro: los indicadores siguen el ámbito; las alertas y la previsión son siempre de un centro, el del ámbito o el activo, y la pantalla lo dice), selector de **mes** (los últimos doce), el aviso «n indicador(es) no disponible(s)» y «Actualizar» (⌘K «Actualizar el panel RRHH»).

Indicadores: **PLANTILLA ACTIVA** (personas; debajo «n FTE · n fijos discontinuos»), **FTE DISPONIBLE** («de n FTE máximo»: contratos activos por su porcentaje de jornada menos las ausencias aprobadas del día), **FTE NECESARIO** («media diaria del mes previsto»), **COSTE DEL MES** (con el porcentaje sobre ventas; solo con lectura de nóminas y un lote de coste contabilizado; si no, «—» y «No disponible»), **COSTE POR EMPLEADO** y **ALERTAS ABIERTAS** («n contratos vencen en 30 días»). Un «—» con «No disponible» es un dato que falta, nunca un cero.

Bloques:

- **«Necesidad frente a planificado · 14 días»**: dos gráficas (Necesario y Planificado) con el selector de departamento; sin previsión: «Sin previsión generada para los próximos 14 días. Genera la previsión en la pestaña Previsión de plantilla.».
- **«Vencimientos 30 días»**: PERSONA · VENCE · DEPARTAMENTO · DETALLE («Contrato que vence el <fecha> (30 días).»); el nombre exige el permiso de lectura de expedientes, si no aparece «—» y la nota «Los nombres de las personas exigen el permiso de lectura del expediente (hr.employee.read); sin él se muestra solo la alerta.».
- **«Alertas»**: GRAVEDAD · ALERTA · DEPARTAMENTO · DÍA · DETALLE · VALOR · UMBRAL, con las alertas «Exceso de personal», «Falta de personal» («Planificado por debajo del 85 % de lo necesario»), «Supera la plantilla máxima», «Previsión incompleta», «Contrato que vence», «Regla incumplida» y «Umbral de plantilla» (50 personas: plan de igualdad y registro retributivo). Sin alertas: «Sin alertas de plantilla.».

**Resultado esperado en el hotel de pruebas (20/09/2026):** PLANTILLA ACTIVA 12 personas (11,63 FTE · 2 fijos discontinuos), FTE DISPONIBLE 11,63 de 27 FTE máximo, FTE NECESARIO 1,67, COSTE DEL MES «—» (sin lote de coste contabilizado), ALERTAS ABIERTAS 23 y 2 contratos que vencen en 30 días.

---

## Errores frecuentes

| Mensaje | Qué significa | Qué hacer |
|---|---|---|
| «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla. Pide acceso a dirección.» | Has abierto una URL fuera de tu menú (`/hoy`, Estados contables, Modelos AEAT…) | Vuelve a tu inicio (Nóminas); si necesitas esa pantalla, pídelo a dirección |
| «No se pudo guardar · Perfil de empleado no encontrado.» | La ficha elegida ya no existe o es de un centro fuera de tu ámbito | Pulsa «Actualizar» y vuelve a elegirla; si no existe, créala con «Nueva ficha» (apartado 2.1) |
| «Elige una ficha de personal: los turnos y fichajes ya no admiten nombres libres.» | Turno o fichaje sin ficha elegida | Elige la ficha en el desplegable; si no hay ninguna, créala con «Nueva ficha» |
| «Quien solicita no puede aprobar su propia solicitud: otra persona debe decidirla.» | Intentas aprobar una ausencia que pediste tú | Que la decida otra persona con la clave de planificación |
| «Quien preparó el plan no puede aprobarlo: pídeselo a dirección.» | Aprobar tu propio borrador de plantilla máxima | Dirección general lo aprueba (apartado 9.4) |
| «El NIF/NIE no es válido (letra de control incorrecta).» / «Ya existe un expediente con ese NIF en la sociedad.» | NIF mal escrito o expediente duplicado | Revisa la letra; busca el expediente existente por nombre o número (apartado 8) |
| «Sin acceso a la plantilla» | Tu usuario no tiene la clave de lectura de expedientes | Pide a sistemas la plantilla «RRHH y nóminas» o una de dirección |
| «Sin ámbito de toda la sociedad: elige un centro de trabajo o pide la clave de lectura de sociedad.» | Incidencias del mes de «Toda la sociedad» sin la clave de sociedad | Elige un centro en el diálogo (apartado 3.6) |
| «El periodo debe tener el formato AAAA-MM.» | Mes mal escrito | Escribe, por ejemplo, `2026-10` |
| «No se pudo abrir el periodo · El periodo 2026-09 ya existe.» | Ya estaba abierto | Búscalo en «Periodos» |
| «Calcula el periodo de nómina antes de exportarlo o pagarlo.» | El periodo está abierto sin calcular, o no tiene líquido a pagar (0,00 €) | Calcula; si el neto es 0, no hay nada que pagar |
| «El registro de nómina 2026-09 no está aprobado.» / «Dirección debe aprobar el periodo de nómina antes de pagarlo.» | Pago sin aprobación de dirección (separación de funciones) | Pide a dirección que apruebe el periodo en Nóminas (ver 3.2.1) |
| «Cabecera inválida: faltan las columnas «…»» | La primera línea del CSV no es la esperada | Copia la cabecera del apartado 4.1 |
| «Este informe ya está importado» / «Hay centros y meses ya contabilizados» | Mismo fichero o mismas celdas centro × mes que un lote vivo | Si es una corrección, activa «Sustituir los lotes anteriores…» y reimporta el rango completo |
| «Necesitas el permiso de gestión de nóminas…» | Tu usuario solo tiene lectura de nóminas | Pide a sistemas la plantilla «RRHH y nóminas» completa |
| «Módulo no activado» en Personal y turnos | El módulo «Personal y turnos» está apagado en el hotel | Sistemas lo activa en Configuración › Módulos e integraciones |
| «Demasiadas peticiones» | Has pulsado «Actualizar» muchas veces seguidas (límite por minuto) | Espera medio minuto |

## Qué no hace todavía

- **Fichas de personal y expedientes:** la ficha (apartado 2.1) sigue exigiendo una persona con acceso a ehotelOS; un expediente sin usuario no puede recibir contrato desde Plantilla (créale antes la ficha con «Nueva ficha»). Sin ficha no hay contrato, y sin contratos el periodo se calcula vacío; los indicadores de Personal y turnos (PLANTILLA, ACTIVOS HOY, HORAS) también dependen de ellas.
- **Aprobación del registro de nómina:** la hace dirección desde la pantalla de Nóminas (apartado 3.2.1); no genera una solicitud en Pendientes de aprobación. El pago exige esa aprobación.
- **Cálculo simplificado (modo externo):** tipos de cotización fijos de 2026 (6,50 % / 32,15 %; temporales 6,55 % / 33,35 %) sin bases mínimas ni máximas, IRPF orientativo por tramos, pagas extras del convenio sin prorratear en el recibo. Los formatos A3 y Sage son «compatibles», no el diseño de registro oficial: valídalos con la gestoría.
- **Sin integración con la gestoría laboral ni con la TGSS:** solo los ficheros de «Exportar y descargar» y de «Incidencias del mes» (sin horas extra: no hay registro de jornada); no hay comunicación de altas y bajas a la TGSS, llamamientos de fijos discontinuos ni modelo 190. El modelo 111 se calcula en Cumplimiento › Modelos AEAT (contabilidad), sin presentación telemática.
- **Personal y turnos:** no hay solicitud de ausencias desde la pantalla, planificación semanal ni cuadrante publicado con bloqueo; las reglas del convenio avisan al crear un turno, no bloquean; con la plantilla «RRHH y nóminas» no puedes fichar (gestionas el reloj, no lo usas) y una camarera de pisos sin lectura de nóminas ve el selector de fichas desactivado.
- **Previsión de plantilla:** sin previsión del PMS ni reservas en cartera el día queda «Incompleta» (nunca un FTE inventado); no hay calendario laboral, saldos de vacaciones, cuadrante por persona ni documentos por persona (contratos firmados, PRL).
- **Informe por departamento** limitado al coste de personal; USALI «Por centro» y Estados contables solo para contabilidad y dirección.
- **Coste de personal:** ficheros de más de 1 MB o en latin1 solo por línea de comandos (sistemas).

## Ver también

- [00-primeros-pasos.md](00-primeros-pasos.md) — acceso, menú lateral y «Ver como», búsqueda ⌘K, Live Timeline, vocabulario de estados.
- [20-administracion.md](20-administracion.md) — contabilidad: diario, USALI por centro, Estados contables, Modelos AEAT (111, 303), Estructura societaria (CCC de centros y sociedad).
- [10-direccion.md](10-direccion.md) — aprobaciones y claves de dirección.
- [faq.md](faq.md) — preguntas frecuentes y mensajes de error de toda la aplicación.
- [formacion/plan-de-formacion.md](formacion/plan-de-formacion.md) — sesión de RRHH y nóminas con ejercicios sobre la demo.
