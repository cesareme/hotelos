# Fichas rápidas · ehotelOS

Una ficha breve por tarea clave, para tener junto al puesto. Cada ficha te dice quién la usa, qué necesitas antes de empezar, los pasos con el menú y la dirección de cada pantalla, lo que debes ver al terminar y qué hacer si algo falla. No sustituyen a las guías del manual: cuando necesites el contexto completo, sigue el enlace de «Más detalle» de cada ficha.

Todas las fichas se han recorrido en la aplicación el 19/09/2026 sobre el hotel de demostración («Hotel Demo Madrid Centro», datos ficticios), en solo lectura: los pasos que escriben datos (cerrar el día, contabilizar un lote, emitir una factura, crear una invitación…) se describen tal como los muestra la pantalla y como los verificó la guía correspondiente; en el hotel de demostración no los ejecutes.

## Las fichas

| Ficha | Perfil (plantillas) | Guía de referencia |
|---|---|---|
| [01 · Entrada de huésped](01-entrada-de-huesped.md) **(provisional)** | Recepción · Jefatura de recepción · Auditoría nocturna | [70 · Recepción](../../70-recepcion.md) |
| [02 · Salida y cobro](02-salida-y-cobro.md) **(provisional)** | Recepción · Jefatura de recepción · Administración de hotel | [70 · Recepción](../../70-recepcion.md) · [20 · Administración](../../20-administracion.md) |
| [03 · Nueva reserva](03-nueva-reserva.md) **(provisional)** | Recepción · Jefatura de recepción · Comercial | [70 · Recepción](../../70-recepcion.md) |
| [04 · Cambio de habitación](04-cambio-de-habitacion.md) **(provisional)** | Recepción · Jefatura de recepción | [70 · Recepción](../../70-recepcion.md) |
| [05 · Cierre del día](05-cierre-del-dia.md) | Recepción · Auditoría nocturna · Dirección de hotel · Administración de hotel | [10 · Dirección](../../10-direccion.md) |
| [06 · Importar desde Sage 200](06-importar-sage.md) | Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [07 · Emitir una factura](07-emitir-factura.md) | Administración de hotel · Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [08 · Dar de alta un usuario](08-alta-de-usuario.md) | Administración de sistema · Dirección de hotel · Dirección general | [60 · Sistemas](../../60-sistemas.md) |
| [09 · Habitación limpia e inspeccionada](09-habitacion-limpia-e-inspeccionada.md) | Pisos · Gobernanta | [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) |
| [10 · Parte de mantenimiento](10-parte-de-mantenimiento.md) | Mantenimiento · Encargado de mantenimiento | [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) |
| [11 · Cambiar una tarifa en la parrilla](11-cambiar-tarifa-en-la-parrilla.md) | Revenue corporativo (Dirección de hotel, en lectura) | [50 · Comercial y revenue](../../50-comercial-revenue.md) |
| [12 · Parte de viajeros](12-parte-de-viajeros.md) | Recepción · Administración de hotel · Cumplimiento | [20 · Administración](../../20-administracion.md) |

El [plan de formación](../plan-de-formacion.md) enlaza en la columna «Materiales» de cada sesión el fichero de la ficha que le corresponde (05, 06, 07, 08, 09, 10, 11 y las provisionales 01-04). Las tareas «Asiento manual», «Exportar a gestoría», «Nómina del mes» y «Nuevo grupo» no tienen ficha propia: el plan remite a los capítulos 2.2 y 9.3 de [20 · Administración](../../20-administracion.md), al capítulo 3 de [30 · RRHH](../../30-rrhh.md) y al capítulo 6.1 de [50 · Comercial y revenue](../../50-comercial-revenue.md).

## Fichas provisionales

Las cuatro fichas de recepción (01 a 04) llevan bajo el título la marca `> **Provisional (UX-1):** se completa en DOC-2 tras la tanda UX-1 (que cambia estas pantallas hoy)`. La tanda UX-1 está rediseñando Mi día, el check-in, el check-out, el walk-in, el cobro y la nueva reserva rápida, así que esas fichas solo traen el objetivo, la pantalla desde la que se empieza y el resultado esperado, sin pasos detallados. Se completan en DOC-2. Hasta entonces, guíate por la ayuda dentro de la aplicación (botón «?» de la barra superior) y por las tarjetas de instrucciones de cada pantalla.

## Cómo usar una ficha

- Cada ficha es corta (entre 500 y 850 palabras, con una captura y una tabla «Si algo falla»): impresa en A4 a 11 puntos ocupa **dos páginas**, no una. Imprímela a doble cara o tenla abierta al lado del puesto.
- Los literales de la interfaz van entre «comillas latinas» y las pantallas como «Menú › Categoría › Entrada» seguidas de su dirección en `código` (por ejemplo `/hoy/cierre-del-dia`), igual que en el resto del [manual](../../README.md).
- En el hotel de demostración, la cuenta de demo es administradora: elige tu perfil en el selector «Ver como…» de la barra lateral (aparece «Viendo como <Rol> · solo menú»; se pierde al recargar la página). Con tu usuario real, el menú ya es el de tu plantilla.
- «Antes de empezar» lista lo que hace falta tener a mano; si falta algo, la ficha te dice a quién pedirlo.
- Los avisos siguen las convenciones del manual: `> **Nota:**` (conviene saberlo), `> **En construcción:**` (existe, pero hoy no funciona del todo o no se ha podido comprobar en la demo), `> **Módulo a activar:**` (depende de un módulo apagado) y `> **Provisional (UX-1):**` (pantalla en cambio).

## Ver también

- [Plan de formación](../plan-de-formacion.md) — itinerario por perfil, ejercicios sobre la demo, calendario y evaluación.
- [Índice del manual](../../README.md) — guías por perfil, primeros pasos y preguntas frecuentes.
- [Preguntas frecuentes](../../faq.md) — mensajes de error habituales y su solución.
