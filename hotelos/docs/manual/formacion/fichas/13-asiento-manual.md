# Ficha · Asiento manual · ehotelOS

**Perfil:** Contabilidad · Dirección financiera (plantillas «Contabilidad» y «Dirección financiera»; menú «Finanzas»; en la demo, «Ver como…» = «Finanzas»). «Administración de hotel» no ve «Contabilidad».

## Antes de empezar

- Fecha contable, concepto y cuentas con sus importes: al menos dos líneas y el debe igual al haber.
- El centro de trabajo si alguna línea es de gasto o ingreso (grupos 6 y 7).
- El ejercicio y el periodo de esa fecha abiertos.
- Para anular hace falta el motivo: nada se borra, la anulación es otro asiento.

> **Nota:** en el hotel de demostración contabiliza solo el asiento del ejercicio A8 del plan (concepto `MANUAL-FORM-<iniciales>- asiento de formación`, 10 € entre «570» y «4300») y anúlalo después; no anules asientos de la siembra.

## Pasos

1. Abre **Menú › Finanzas › Contabilidad** (`/finanzas/contabilidad`), pestaña «Diario»: «Libro diario de la sociedad: cada asiento con su número, fecha contable, origen, centro de trabajo y estado. Nada se borra: una anulación es otro asiento.».
2. Pulsa «Nuevo asiento». Por la derecha se abre el cajón «Nuevo asiento manual» («Al menos dos líneas con importes positivos en el debe o en el haber; el asiento tiene que cuadrar.»).
3. Rellena «Fecha contable*» (viene con la de hoy; «Fija el ejercicio y el periodo del asiento.») y el «Centro de trabajo»: «Sociedad (sin centro)», «Hotel Demo Madrid Centro (AMC) · Hotel» o «Hotel Demo Tenerife Sur (ATS) · Hotel».
4. Escribe el «Concepto*» y, si quieres, el «Documento» («Número de factura, contrato o nota interna»).
5. En «Líneas» («2 líneas» · «Añadir línea») elige «Cuenta 1» y «Cuenta 2» en «Elegir cuenta…» («570 · Caja, euros», «4300 · Clientes (s)»…) y escribe el importe en «Debe» o en «Haber». «SUMA DEL DEBE», «SUMA DEL HABER» y «DIFERENCIA» se recalculan al momento.
6. Pulsa «Contabilizar…». Si falta algo, aparece el bloque «Antes de contabilizar» con los motivos y el botón se desactiva hasta corregirlos. Si todo está bien, se abre «¿Contabilizar el asiento?» («Operación de alto riesgo: el asiento queda numerado en el ejercicio con fecha … por … € y solo se puede deshacer con un asiento de anulación.») y el botón «Contabilizar».
7. Para anular, pulsa «Anular» en la fila del asiento (solo en las que están en «CONTABILIZADO»). Se abre «¿Anular el asiento 261 / 2026?»: «Se contabiliza un asiento de anulación que invierte cada línea; el original se conserva marcado como anulado…». Escribe el «Motivo*», decide la «Fecha de la anulación» («Con la fecha del original la anulación cae en su mismo periodo; con la de hoy, en el periodo actual.») y pulsa «Anular asiento».

![Diario de la demo: el asiento manual «259 / 2026» en «ANULADO» y su reverso «260 / 2026» con la etiqueta «ASIENTO DE ANULACIÓN»](../../img/administracion/diario.png)

## Resultado esperado

- El asiento aparece el primero en «Asientos del diario» con su número («259 / 2026» en la guía), origen «Asiento manual» y estado «CONTABILIZADO»; el filtro «Origen» = «Asiento manual» lo aísla y en «Mayor» sale en cada una de sus cuentas.
- Tras anular: aviso «Asiento 259 / 2026 anulado con el asiento 260 / 2026.», el original pasa a «ANULADO» y aparece «Anulación del asiento 2026/259: …» con la etiqueta «ASIENTO DE ANULACIÓN» y las líneas invertidas. Ninguno desaparece.

> **En construcción:** esta ficha llega hasta «Contabilizar…» y «Anular asiento» sin confirmar; el resultado está descrito según la pantalla y la guía de administración, que sí lo ejecutó en la demo (pareja 259/260).

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Antes de contabilizar» · «El asiento no cuadra: la suma del debe tiene que ser igual a la del haber.» | Revisa los importes hasta que «DIFERENCIA» marque «0,00 €»; «Contabilizar…» se reactiva solo. |
| «El concepto del asiento es obligatorio.» · «Elige la cuenta.» · «Indica el importe en el debe o en el haber.» | Completa el campo señalado; el bloque desaparece al corregirlo. |
| «Indica el hotel o la oficina central: los gastos, ingresos, retenciones y nóminas llevan siempre un centro de trabajo.» al confirmar | Una línea de los grupos 6 o 7 va con «Sociedad (sin centro)»: elige el hotel en «Centro de trabajo». |
| «El ejercicio de esa fecha está cerrado: reábrelo en Contabilidad › Cierre de ejercicio antes de asentar.» · «El periodo contable de esa fecha está cerrado: reábrelo o cambia la fecha del asiento.» | Cambia la «Fecha contable» o pide la reapertura a dirección financiera. |
| «Indica el motivo de la anulación.» · «Un asiento de anulación no se puede anular de nuevo.» | Escribe el «Motivo*»; un reverso no se anula: contabiliza el asiento correcto de nuevo. |
| La fila no tiene «Anular» | Ya está en «ANULADO» o es un «ASIENTO DE ANULACIÓN»: solo se anulan los contabilizados. |

## Más detalle

- [20 · Administración](../../20-administracion.md#22-registrar-un-asiento-manual) — capítulos 2.1 a 2.4 (diario, asiento manual, anulación y mayor).
- [Plan de formación](../plan-de-formacion.md) — sesión A-2 y ejercicio A8.
