# Ficha · Entrada de huésped (check-in) · ehotelOS

**Perfil:** Recepción · Jefatura de recepción · Auditoría nocturna (plantillas «Recepción», «Jefatura de recepción», «Auditoría nocturna»); un check-in fuera de la ventana del hotel exige además el permiso de modificar reservas.

## Antes de empezar

- La reserva existe y su «Estado» es «Confirmada» («Llega hoy» en el Live Timeline). Si no existe, créala antes (ficha [03 · Nueva reserva](03-nueva-reserva.md)).
- Sabes si trae saldo (columna «Saldo» de Mi día) y cómo va a pagar: «Tarjeta (datáfono)», «Efectivo» o «Transferencia».
- Hay una habitación «Limpia» del tipo reservado. Si la asignada está «Sucia», el cajón te propone otra o te pide un motivo (paso 3).
- Tienes el documento del huésped: el parte de viajeros se crea al confirmar.

## Pasos

1. Abre **Menú › Hoy › Mi día** (`/hoy`, ⌥H), pestaña «Llegan hoy (n)», y localiza la fila («Buscar por nombre o habitación (⌥F)» filtra al momento). Tres caminos abren el mismo cajón de ehotelOS:
   - **Mi día:** el botón de la fila dice lo que hará: **«Hacer check-in»** si tiene habitación, o **«Check-in en 101»** si la celda dice «sin asignar → 101» (la primera limpia y libre del tipo, ya elegida en el cajón). También en la pestaña «Sin habitación (n)» y en el panel de detalle (tecla **C** con ⌥).
   - **Ficha de la reserva** («Abrir ficha», `/recepcion/reservas/<id>`): «Acciones de la reserva» › «Hacer check-in» (junto a «Asignar habitación» y «Más ▾»).
   - **Live Timeline** (`/hoy/live-timeline`, ⌥T): clic en la barra › panel «Acciones» › «Check-in». Solo con habitación: sin ella el botón está desactivado y antes hay que pulsar «Asignar habitación» (en Mi día el cajón asigna y aloja en un solo paso).
2. Se abre el cajón **«Check-in»** («Elena Sigma · UXDAY-A5» en la captura, un cronómetro y «Cerrar») con cuatro secciones:
   - **«1 · Huésped»:** nombre, documento («DNI UX000005 · ES») y la nota de la reserva.
   - **«2 · Habitación»:** la etiqueta de estado («Limpia»), «Hab. 111 · Planta 1 · Doble» y el desplegable «Cambiar habitación» con las limpias y libres.
   - **«3 · Pago»:** «128,00 € pendiente» (o «Saldado»), el desglose del saldo, el «Modo de cobro» («Cobrar saldo», seleccionado con saldo · «Cobrar depósito», desactivado sin política de depósito · «Sin cobro»), «Se cobrarán 128,00 € al confirmar.» y el «Método».
   - **«4 · Cumplimiento»:** «Se crean al confirmar» y «Al confirmar se encola el parte de viajeros (SES.HOSPEDAJES)…». Las dos líneas técnicas que siguen («Firma digital…», «Política de cancelación: FLEX24.») no requieren nada por tu parte.
3. Si la habitación está **«Sucia»**, «2 · Habitación» muestra «Sugerencia · La 101 está limpia, libre y es del mismo tipo.» con el botón **«Cambiar a la 101»** y el interruptor «Hacer check-in igualmente (la limpieza sigue siendo de pisos; el motivo queda auditado)». El botón del pie sigue desactivado hasta que cambies de habitación o actives el interruptor con un motivo. Lo normal es «Cambiar a la 101».
4. Pulsa el botón del pie: **«Cobrar 128,00 € y hacer check-in»** (o **«Hacer check-in»** con saldo 0). Intro confirma; «Cancelar» cierra sin cambios.

![Cajón «Check-in» de una llegada con saldo pendiente: habitación limpia, cobro del saldo y botón «Cobrar 128,00 € y hacer check-in»](../../img/recepcion/check-in-cobro.png)

## Resultado esperado

- La fila pasa a **«En el hotel»** al momento y la habitación queda «Ocupada».
- El cobro queda anotado en el folio (con tarjeta se registra como cobro: ehotelOS no habla con ningún datáfono).
- El parte de viajeros queda encolado (Menú › Cumplimiento › Registro de viajeros, ficha [12](12-parte-de-viajeros.md)); sin envío a SES configurado, el cajón se queda abierto con ese resultado: ciérralo con «Cerrar».
- No hay «Deshacer» del check-in.

> **Nota:** recorrida el 19/09/2026 en el «Hotel UXDAY (prueba)» (datos ficticios) hasta el botón de confirmar, sin pulsarlo; el resultado se toma de la [guía de recepción](../../70-recepcion.md), que lo verifica con las pruebas automáticas del check-in.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| Botón desactivado y «La habitación no está lista. Cambia de habitación o marca «Hacer check-in igualmente» con un motivo.» | La habitación está «Sucia»: pulsa «Cambiar a la 101», elige otra limpia o activa el interruptor y escribe el motivo. |
| «Indica el motivo del check-in fuera de ventana.» | Fuera de la ventana del hotel (día de negocio y siguiente) hace falta el permiso de modificar reservas y un motivo; si no lo tienes, que lo haga jefatura o dirección. |
| «Asigna una habitación primero.» (pie del cajón, botón desactivado) | El desplegable «Cambiar habitación» está en «Sin asignar»: elige una habitación limpia y libre («Check-in en 101» desde Mi día ya la trae elegida). |
| «Sin habitación válida para el check-in.» | No es del cajón: lo devuelve Reservas › Importar cuando una fila llega como alojada sin habitación válida; la reserva queda «Confirmada» y la alojas desde Mi día. |
| «Check-in» desactivado en el panel del Live Timeline | Sin habitación: pulsa «Asignar habitación» o hazlo desde Mi día con «Check-in en 101». |
| «Demasiadas peticiones. Reintenta en unos segundos.» | Espera unos segundos y repite, sin pulsar «Actualizar» en cadena. |

## Más detalle

- [70 · Recepción](../../70-recepcion.md) — «Mi día» y «Llegadas y check-in».
- [40 · Pisos y mantenimiento](../../40-pisos-mantenimiento.md) — estados de habitación y quién los cambia.
