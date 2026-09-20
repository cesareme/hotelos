# Ficha · Cierre del día · ehotelOS

**Perfil:** quien ejecuta el cierre es recepción o auditoría nocturna (plantillas «Recepción», «Auditoría nocturna», «Jefatura de recepción»); dirección («Dirección de hotel») lo revisa y decide las reaperturas; «Administración de hotel» ve la misma pantalla.

## Antes de empezar

- Todas las llegadas del día están resueltas (check-in hecho o no-show marcado) y todas las salidas tienen check-out.
- Los folios de las estancias que salen hoy están cobrados o regularizados (ficha [02 · Salida y cobro](02-salida-y-cobro.md)).
- Sabes qué «Fecha de negocio actual» va a cerrar: el cierre avanza esa fecha un día, carga la noche de alojamiento a las estancias en curso y marca como no-show las llegadas sin resolver.

> **Nota:** en el hotel de demostración **nadie cierra el día**: la fecha de negocio está en 14/09/2026 a propósito. Esta ficha describe el cierre sin ejecutarlo.

## Pasos

1. Abre **Menú › Hoy › Cierre del día** (`/hoy/cierre-del-dia`). Bajo el título lees «Comprobaciones guiadas antes de cerrar: si algo bloquea, te dice qué arreglar y dónde. Fecha de negocio actual: 14/09/2026.». Pulsa «Actualizar» si llevas un rato en la pantalla.
2. Lee el aviso de estado: «Puedes cerrar el día» (todo en verde) o «No puedes cerrar todavía» con la causa («No puedes cerrar todavía: 1 folios abiertos con saldo.»). Debajo, los contadores «COMPROBACIONES CORRECTAS», «AVISOS» y «BLOQUEOS».
3. Repasa las nueve «Comprobaciones previas al cierre»: «Llegadas pendientes», «No-shows sin resolver», «Folios abiertos con saldo», «Salidas sin check-out», «Cargos de alojamiento pendientes», «Habitaciones ocupadas marcadas sucias», «Cargos del TPV sin pasar a folio», «Facturas pendientes» y «Preautorizaciones sin capturar». Cada una lleva su etiqueta «CORRECTO · n», «ATENCIÓN · n» o «BLOQUEA · n» y una frase con lo que hay que hacer.
4. En una comprobación que **bloquea**, pulsa «Ver n elemento» para desplegar la lista afectada y «Abrir cola operativa» para ir a Mi día › «Recepción» y resolverla (cobrar el folio, hacer el check-out, marcar el no-show…).
5. Las comprobaciones en «ATENCIÓN» no impiden cerrar, pero conviene resolverlas: «Facturas pendientes · 1 factura en borrador. Emítela antes del cierre para que entre en la producción del día.» lleva a «Ver facturas» (ficha [07 · Emitir una factura](07-emitir-factura.md)).
6. Vuelve a «Cierre del día» y pulsa «Actualizar». Cuando todas las comprobaciones pasan, el aviso cambia a «Puedes cerrar el día» y el botón a «Cerrar día».
7. Pulsa «Cerrar día». Si alguna comprobación sigue bloqueando, solo verás «Cerrar de todos modos»: exige un motivo, queda auditado y es una decisión de dirección o de jefatura, no de la persona de mostrador.
8. Comprueba el «Historial de cierres»: aparece el cierre con su fecha; en la demo dice «Todavía no se ha ejecutado ningún cierre del día en esta propiedad.».

![«Cierre del día» en la demo: «No puedes cerrar todavía» por «Folios abiertos con saldo» y el resto de comprobaciones en «CORRECTO · 0»](../../img/direccion/cierre-del-dia.png)

## Resultado esperado

- «Fecha de negocio actual» avanza un día y el «Historial de cierres» gana una fila.
- El Live Timeline deja de mostrar «CIERRE NOCTURNO PENDIENTE · FECHA DE NEGOCIO …» y los cargos de alojamiento de la noche aparecen en los folios de las estancias en curso.
- Si el cierre se hizo con «Cerrar de todos modos», dirección lo ve en «Hoy › Pendientes de aprobación» (tipo «Reapertura del día») y en «Configuración › Sistema › Auditoría».

> **En construcción:** el resultado de «Cerrar día» no se ha comprobado en el hotel de demostración (nadie ejecuta el cierre en la demo); está descrito según la pantalla y la guía de dirección. Se completa cuando se recorra en un hotel real.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «No puedes cerrar todavía: n folios abiertos con saldo.» | «Ver n elemento» te dice qué reserva es y por cuánto; cóbralo o regularízalo en «Finanzas › Facturación y cobros» y vuelve a «Actualizar». Un folio de una reserva cancelada o no presentada con saldo se avisa pero «no bloquea el cierre». |
| «Llegadas pendientes» o «Salidas sin check-out» en «BLOQUEA» | Haz el check-in o marca el no-show de cada llegada; haz el check-out de cada salida. «Abrir cola operativa» te lleva a la lista. |
| Los indicadores de «hoy» (Mi día, Turno) salen a 0 en tu hotel | Falta ejecutar cierres: las cifras «de hoy» se calculan sobre la fecha real y los cargos de alojamiento sobre la fecha de negocio, que solo avanza con el cierre. |

## Más detalle

- [10 · Dirección](../../10-direccion.md) — tarea 6 «Cierre del día y Turno» (quién cierra, quién revisa, reapertura).
- [20 · Administración](../../20-administracion.md) — capítulo 6.2 «Cierre del día (describir, no ejecutar)».
- [70 · Recepción](../../70-recepcion.md) — «Turno y cierre del día» (Turno: productividad, caja del día y estado operativo; Cierre del día: comprobaciones previas al cierre y «Cerrar día»).
