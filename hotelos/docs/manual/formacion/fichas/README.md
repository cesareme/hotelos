# Fichas rápidas · ehotelOS

Una ficha breve por tarea clave, para tener junto al puesto. Cada ficha te dice quién la usa, qué necesitas antes de empezar, los pasos con el menú y la dirección de cada pantalla, lo que debes ver al terminar y qué hacer si algo falla. No sustituyen a las guías del manual: cuando necesites el contexto completo, sigue el enlace de «Más detalle» de cada ficha.

Todas las fichas se han recorrido en la aplicación el 19/09/2026 en solo lectura: las de administración, RRHH, pisos, mantenimiento, revenue, sistemas y cumplimiento sobre el hotel de demostración («Hotel Demo Madrid Centro», datos ficticios), y las de recepción (01 a 04) tras la tanda UX-1 sobre el «Hotel UXDAY (prueba)», el hotel de prueba de esa tanda, con su plan del día armado (llegadas con y sin habitación, una habitación sucia, saldos pendientes y salidas). Los pasos que escriben datos (hacer un check-in o un check-out, crear una reserva, mover a un huésped, cerrar el día, contabilizar un lote, emitir una factura, crear una invitación…) se describen tal como los muestra la pantalla y como los verificó la guía correspondiente; en los hoteles de prueba no los ejecutes.

## Las fichas

| Ficha | Perfil (plantillas) | Guía de referencia |
|---|---|---|
| [01 · Entrada de huésped](01-entrada-de-huesped.md) | Recepción · Jefatura de recepción · Auditoría nocturna | [70 · Recepción](../../70-recepcion.md) |
| [02 · Salida y cobro](02-salida-y-cobro.md) | Recepción · Jefatura de recepción · Administración de hotel | [70 · Recepción](../../70-recepcion.md) · [20 · Administración](../../20-administracion.md) |
| [03 · Nueva reserva](03-nueva-reserva.md) | Recepción · Jefatura de recepción · Comercial | [70 · Recepción](../../70-recepcion.md) |
| [04 · Cambio de habitación](04-cambio-de-habitacion.md) | Recepción · Jefatura de recepción | [70 · Recepción](../../70-recepcion.md) |
| [05 · Cierre del día](05-cierre-del-dia.md) | Recepción · Auditoría nocturna · Dirección de hotel · Administración de hotel | [10 · Dirección](../../10-direccion.md) |
| [06 · Importar desde Sage 200](06-importar-sage.md) | Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [07 · Emitir una factura](07-emitir-factura.md) | Administración de hotel · Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [08 · Dar de alta un usuario](08-alta-de-usuario.md) | Administración de sistema · Dirección de hotel · Dirección general | [60 · Sistemas](../../60-sistemas.md) |
| [09 · Habitación limpia e inspeccionada](09-habitacion-limpia-e-inspeccionada.md) | Pisos · Gobernanta | [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) |
| [10 · Parte de mantenimiento](10-parte-de-mantenimiento.md) | Mantenimiento · Encargado de mantenimiento | [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) |
| [11 · Cambiar una tarifa en la parrilla](11-cambiar-tarifa-en-la-parrilla.md) | Revenue corporativo (Dirección de hotel, en lectura) | [50 · Comercial y revenue](../../50-comercial-revenue.md) |
| [12 · Parte de viajeros](12-parte-de-viajeros.md) | Recepción · Administración de hotel · Cumplimiento | [20 · Administración](../../20-administracion.md) |
| [13 · Asiento manual](13-asiento-manual.md) | Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [14 · Exportar a la gestoría](14-exportar-a-gestoria.md) | Contabilidad · Dirección financiera | [20 · Administración](../../20-administracion.md) |
| [15 · Nómina del mes](15-nomina-del-mes.md) | RRHH y nóminas | [30 · RRHH](../../30-rrhh.md) |
| [16 · Nuevo grupo](16-nuevo-grupo.md) | Comercial · Jefatura de recepción | [50 · Comercial y revenue](../../50-comercial-revenue.md) |

El [plan de formación](../plan-de-formacion.md) enlaza en la columna «Materiales» de cada sesión la ficha que le corresponde: cada tarea clave del plan tiene ya su ficha (01 a 16), incluidas las de recepción sobre el Hotel UXDAY (01 a 04) y las de asiento manual, exportación a la gestoría, nómina del mes y nuevo grupo (13 a 16).

## Cómo usar una ficha

- Cada ficha es corta (entre 500 y 850 palabras, con una captura y una tabla «Si algo falla»): impresa en A4 a 11 puntos ocupa **dos páginas**, no una. Imprímela a doble cara o tenla abierta al lado del puesto.
- Los literales de la interfaz van entre «comillas latinas» y las pantallas como «Menú › Categoría › Entrada» seguidas de su dirección en `código` (por ejemplo `/hoy/cierre-del-dia`), igual que en el resto del [manual](../../README.md).
- Los estados de reserva y de habitación son los de la aplicación: «Confirmada · Llega hoy · En el hotel · Sale hoy · Salida hecha · No-show · Cancelada» y «Limpia · Inspeccionada · Sucia · Ocupada · Bloqueada · Fuera de servicio».
- En los hoteles de prueba, la cuenta de captura es administradora: elige tu perfil en el selector «Ver como…» de la barra lateral (aparece «Viendo como <Rol> · solo menú»; se pierde al recargar la página). Con tu usuario real, el menú ya es el de tu plantilla.
- «Antes de empezar» lista lo que hace falta tener a mano; si falta algo, la ficha te dice a quién pedirlo.
- Los avisos siguen las convenciones del manual: `> **Nota:**` (conviene saberlo), `> **En construcción:**` (existe, pero hoy no funciona del todo o no se ha podido comprobar en la demo) y `> **Módulo a activar:**` (depende de un módulo apagado).

## Ver también

- [Plan de formación](../plan-de-formacion.md) — itinerario por perfil, ejercicios sobre los hoteles de prueba, calendario y evaluación.
- [Índice del manual](../../README.md) — guías por perfil, primeros pasos y preguntas frecuentes.
- [Preguntas frecuentes](../../faq.md) — mensajes de error habituales y su solución.
