# Ficha · Nómina del mes · ehotelOS

**Perfil:** RRHH y nóminas (plantilla «RRHH y nóminas»; en la demo, «Ver como…» = «RRHH y nóminas»). «Contabilidad» y «Dirección financiera» ven la misma pantalla desde su menú «Finanzas».

## Antes de empezar

- Los contratos del mes dados de alta y activos (pestaña «Contratos»): sin contratos el periodo se calcula a 0,00 €.
- El formato que espera la gestoría laboral: «A3 Nóminas (compatible)», «Sage (compatible)» o «CSV universal».
- El ciclo: **Abrir periodo → Calcular y contabilizar → Recibos → Exportar → Pagar**. El cálculo es simplificado: la nómina oficial la sigue haciendo la gestoría.

> **Nota:** en el hotel de demostración el periodo «2026-09» ya está calculado y exportado a 0,00 € (se calculó cuando no había contratos). Recorre las ventanas sin confirmarlas.

## Pasos

1. Abre **Menú › Finanzas › Nóminas** (`/finanzas/nominas`): «Contratos, periodos mensuales y exportación a la gestoría…». Botones «Actualizar», «Abrir periodo» y «Nuevo contrato»; pestañas «Contratos (n) · Periodos (n) · Recibos · Coste de personal».
2. Revisa «Contratos» («Empleado · Modalidad · Bruto mensual · Pagas · IRPF · Vigencia · Estado», con «Desactivar» por fila). En la demo hay hoy un contrato de prueba (1800,00 €, 14 pagas); en «Empleado» sale un identificador técnico («cmu8…») en vez de un nombre: es un texto de la aplicación.
3. Pulsa «Abrir periodo». Por la derecha se abre el cajón «Abrir periodo de nómina» («Un periodo por mes natural; se calcula con los contratos activos en ese mes.») con «Mes (AAAA-MM)» relleno con el mes en curso («2026-09»). Pulsa «Abrir periodo».
4. En «Periodos», localiza la fila de «Periodos de nómina» («Periodo · Estado · Bruto · IRPF · Seguridad Social · Neto · Acciones»): «2026-09 · 1–30 sept 2026», estado «ABIERTO» y las acciones «Calcular · Exportar · Pagar · Recibos» («Exportar» y «Pagar» esperan al cálculo).
5. Pulsa «Calcular»: ventana «Calcular el periodo 2026-09» («Genera un recibo por cada contrato activo y contabiliza el devengo (640/642 contra 465, 4751 y 476).») con «Calcular y contabilizar». En un periodo ya calculado el botón es «Recalcular» («Anula los asientos anteriores del periodo con asientos de anulación, regenera los recibos y vuelve a contabilizar. Nada se borra.»).
6. Pulsa «Recibos»: la pestaña pasa a «Recibos · 2026-09», con «Cambiar de periodo» y la tabla «Empleado · Días · Bruto · IRPF · SS trabajador · SS empresa · Neto · Estado». En la demo lees «Aún no hay recibos».
7. Pulsa «Exportar»: ventana «Exportar 2026-09 a la gestoría» («La exportación queda auditada y marca el periodo como exportado. Los formatos A3 y Sage son compatibles, no el diseño de registro oficial: valídalos con la gestoría.»), «Formato» y «Exportar y descargar».
8. Pulsa «Pagar»: ventana «Pagar las nóminas de 2026-09» («Asiento D 465 Remuneraciones pendientes de pago / H 572 por el neto del periodo, 0,00 €. Solo se deshace con un asiento de anulación.») con «Fecha de pago», «Cuenta de tesorería» («572 Bancos por defecto; una subcuenta 572x o 570 Caja.»), «Referencia» y «Registrar el pago».

![Nóminas en la demo, pestañas «Contratos (1) · Periodos (1) · Recibos · Coste de personal» y «CONTRATOS ACTIVOS 1»: el periodo 2026-09 en «EXPORTADO» a 0,00 €; las acciones de la fila («Recalcular · Exportar · Pagar · Recibos») quedan a la derecha, fuera del recorte](../../img/rrhh/nominas.png)

## Resultado esperado

- Avisos «Periodo 2026-09 abierto», «Periodo 2026-09 calculado y contabilizado», «Exportación de 2026-09 descargada» (con la etiqueta «VALIDAR CON LA GESTORÍA» y el fichero, por ejemplo `nominas-2026-09-a3.txt`) y «Nóminas de 2026-09 pagadas y contabilizadas».
- La fila avanza «ABIERTO → CALCULADO → EXPORTADO → Pagado»; los recibos pasan a «Pagado» y «Recalcular» se apaga. En «Contabilidad › Diario» aparecen los asientos con origen «Nómina» y «Pago de nómina».

> **En construcción:** el pago exige la aprobación del registro mensual por dirección, que existe en el servidor pero no tiene botón en Nóminas ni solicitud en «Pendientes de aprobación»: RRHH prepara y exporta; el pago real lo hace la gestoría fuera de ehotelOS. En la demo, «Recalcular» generaría un recibo del contrato de prueba: no se ha ejecutado.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «El periodo debe tener el formato AAAA-MM.» | Escribe año y mes con guion, por ejemplo `2026-10`. |
| «No se pudo abrir el periodo» · «Ya existe un periodo de nómina con ese código.» | Ya estaba abierto: búscalo en «Periodos». |
| «Calcula el periodo de nómina antes de exportarlo o pagarlo.» | El periodo está abierto sin calcular: pulsa «Calcular». |
| «El periodo de nómina no tiene importe neto que pagar.» | Neto 0,00 € (sin contratos o sin recibos): no hay nada que pagar; en la demo es lo esperado. |
| «El registro de nómina 2026-09 no está aprobado.» | Pago sin aprobación de dirección (separación de funciones): pídela; hoy no hay botón. |

## Más detalle

- [30 · RRHH y nóminas](../../30-rrhh.md#3-periodos-abrir-calcular-exportar-y-pagar) — capítulos 1 a 3 y «Qué no hace todavía».
- [Plan de formación](../plan-de-formacion.md) — sesión R-1 y ejercicios R1 y R2.
