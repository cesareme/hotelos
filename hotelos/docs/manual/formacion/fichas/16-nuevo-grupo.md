# Ficha · Nuevo grupo · ehotelOS

**Perfil:** Comercial · Jefatura de recepción (plantillas «Comercial» y «Recepción» / «Jefatura de recepción»; también dirección). Recepción ve las pestañas «Resumen» y «Calendario»; «Cupos» solo la ven comercial y dirección.

## Antes de empezar

- Los datos del acuerdo: nombre y tipo del grupo, llegada y salida, fecha límite (cut-off) y entrega de la rooming list (igual o anterior a la fecha límite), contacto y empresa.
- Lo pactado: tarifa, penalización por no ocupación, método de facturación y de pago, régimen de comidas.
- Un código propio si no quieres el que propone ehotelOS (formato «AAAA-MM-XXX»); en la demo, `MANUAL-FORM-<iniciales>-G1`.

> **Nota:** el grupo nace sin habitaciones; bloquearlas es un paso posterior («Acciones › Bloquear habitaciones» en «Próximos grupos»), y esa tabla solo lista grupos que ya tienen bloqueo.

## Pasos

1. Abre **Menú › Recepción › Grupos y eventos** (`/recepcion/grupos`), pestaña «Resumen». Botones «Actualizar», «Importar rooming list», «Nuevo evento» y «Nuevo grupo»; indicadores «RESERVAS DE GRUPO ACTIVAS», «HABITACIONES BLOQUEADAS», «PICKUP» y «PRÓXIMOS EVENTOS».
2. Pulsa «Nuevo grupo». Por la derecha se abre el cajón «Nuevo grupo» («Da de alta un bloque de grupo. Los valores por defecto se adaptan al tipo de grupo (boda, MICE, deportivo, corporativo, mayorista…).»).
3. **Identificación:** «Código*» viene propuesto (por ejemplo «2026-09-Q8B»); «Nombre del grupo*»; «Tipo de grupo*» («Corporativo (empresa, convención interna)», «MICE (reuniones, incentivos, congresos)», «Boda»…); «Estado inicial*» («Consulta inicial» por defecto, «Provisional (pre-bloqueo)» o «Confirmado»); «Código de mercado», «Código de origen» y «Asignado a (identificador de usuario)» opcionales (este último, «Responsable comercial del grupo.», pide un identificador técnico de usuario, no un nombre).
4. **Fechas y liberación:** «Llegada*» y «Salida*» (vienen a un mes vista, tres noches), «Fecha límite (cut-off)» y «Entrega de la rooming list»; debajo, «Liberación: fecha límite el 4 oct 2026 (T-15 días antes de la llegada).». Ojo: por defecto la entrega viene cinco días **después** de la fecha límite; adelántala a la fecha límite o antes, o el servidor rechaza el alta.
5. **Contacto** («Nombre de contacto*», «Cargo», «Correo electrónico», «Teléfono») y **Empresa** («Razón social», «NIF», «Dirección», «Sector»).
6. **Tarifa contratada:** «Modelo de tarifa*» («Tarifa neta» o «Tarifa comisionable»; con neta, «Comisión» queda apagada), «Tarifa por habitación y noche» opcional («Si la dejas vacía se factura según el plan de tarifas público.») y «Moneda». **Penalización por no ocupación (attrition):** «Tipo*», «Umbral (%)*» 80 («Pickup mínimo sin penalización.») y «Penalización (%)*» 100.
7. **Facturación y pago:** «Método de facturación*» («Folio maestro (todo a un folio común)», «Separado…», «Individual…») y «Método de pago*» («Crédito (cuenta corporativa)» por defecto, tarjeta de garantía, prepago, depósito o transferencia). **Restauración y eventos (F&B):** «Régimen de comidas» e interruptores «Desayuno incluido en la tarifa» (activado), «Cóctel de bienvenida» y «Cena de gala incluida». **España · Específicos:** «Aplicar REAV (Régimen Especial de Agencias de Viajes)» y «Llegada confidencial». **Notas internas:** «Observaciones».
8. Pulsa «Crear grupo» (o «Cancelar»).
9. Abre la ficha: en «Calendario» (`/recepcion/grupos/calendario`) pulsa la barra del grupo. Se abre el cajón «<código> · <nombre>» con el estado, «Cambiar estado» («Mantener como consulta», «Pasar a provisional», «Confirmar el grupo», «Cancelar grupo»), «Crear folio maestro», las pestañas «Resumen · Pickup y bloqueo · Eventos» y «Editar».

![Grupos y eventos › Resumen en la demo: indicadores y «Pickup de grupos» con el grupo ficticio «MANUAL-COM-G1 · MANUAL-COM- Convención Consultora Norte» (confirmado, 9–11 nov, 0 habitaciones bloqueadas)](../../img/comercial/grupos.png)

## Resultado esperado

- Aviso «Grupo «<nombre>» creado.»; «RESERVAS DE GRUPO ACTIVAS» sube en uno.
- En «Pickup de grupos» aparece la tarjeta del grupo con «Bloqueadas 0 · Vendidas 0 · Disponibles 0 · Pickup 0 %» y el aviso «Pickup 0 % por debajo del umbral 80 %» hasta que bloquees y vendas habitaciones.
- En «Calendario» hay una barra entre la llegada y la salida con la fecha límite marcada por una línea discontinua; la ficha muestra las cuatro fechas en «Fechas e hitos».

> **En construcción:** en esta ficha no se ha pulsado «Crear grupo» (escribe); el aviso y los indicadores están descritos según la pantalla y la guía comercial, que sí creó el grupo de la demo.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «roomingListDueDate must be on or before cutOffDate.» (en inglés; el cajón sigue abierto) | La entrega de la rooming list es posterior a la fecha límite: ponla en esa fecha o antes y vuelve a pulsar «Crear grupo». |
| «El código es obligatorio.» · «El nombre del grupo es obligatorio.» · «El nombre de contacto es obligatorio.» | Rellena los campos con asterisco de «Identificación» y «Contacto». |
| «Las fechas de llegada y salida son obligatorias.» · «La salida debe ser posterior a la llegada.» | Corrige «Llegada*» y «Salida*» (al menos una noche). |
| El grupo no sale en «Próximos grupos» | Esa tabla solo lista grupos con habitaciones bloqueadas: míralo en «Pickup de grupos» o en «Calendario». |
| No ves la pestaña «Cupos» | Tu plantilla es «Recepción»: los cupos de tour operadores son de comercial y dirección. |

## Más detalle

- [50 · Comercial y revenue](../../50-comercial-revenue.md#6-grupos-eventos-y-cupos) — capítulo 6 (grupos, calendario, bloqueos, eventos, rooming list y cupos).
- [Plan de formación](../plan-de-formacion.md) — sesión C-1 y ejercicio C1.
