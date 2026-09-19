# Ficha · Cambiar una tarifa en la parrilla · ehotelOS

**Perfil:** Revenue corporativo (plantilla «Revenue corporativo»). «Dirección de hotel» ve la parrilla en lectura; «Comercial» no la ve.

## Antes de empezar

- Qué cambias y por qué: fechas, tipos de habitación, plan («BAR» en la demo) y el motivo (obligatorio: «Evento», «Compset», «Pickup lento», «Corrección», «Temporada» o «Estrategia»).
- Si vas a publicar en canales, que cada producto (tipo × plan) tenga correspondencia activa en «Comercial › Canales de venta › Correspondencias»; sin ella el canal recibe «0 celdas».
- En la demo trabaja solo con «Individual», «Doble superior» y «Junior suite»: la fila «Double · BAR» la usan las pruebas automáticas y no debe cambiar.

## Pasos

1. Abre **Menú › Revenue › Parrilla de tarifas** (`/revenue/parrilla`). La cabecera dice el hotel y el rango («Hotel Demo Madrid Centro · 19 sep – 2 oct · 14 noches»). Ajusta el «RANGO» («7 d · 14 d · 30 d · 90 d · Trimestre», «‹ ›», «Desde» / «Hasta», «Hoy») y deja la vista en «Tarifas».
2. **Una celda:** haz clic en la celda (por ejemplo «Individual · BAR» del 20 de septiembre, «95 €»), pulsa F2 o Intro, escribe el precio nuevo («99») o una expresión («+10 %», «−5») y confirma con Intro. La celda queda marcada y la barra inferior dice «1 cambio sin guardar · 1 tipo · 1 plan». Esc cancela la edición.
3. **Muchas celdas:** pulsa «Edición masiva…». En la hoja «Edición masiva» define el ámbito: «Fechas» («Desde → Hasta», «+ Añadir otro rango»), «Días de la semana» («L M X J V S D»; sin marcar, «Todos los días»), «Tipos de habitación» y «Planes de tarifa» («BAR»).
4. En la pestaña «Precio» elige el modo («Valor fijo», «Subir/bajar %», «Subir/bajar €», «Copiar de otra fecha», «Precio mínimo (suelo)», «Precio máximo (techo)») y escribe el valor; «Restricciones» y «Disponibilidad» cambian otras cosas.
5. Elige el «Motivo del cambio» (obligatorio) y, si quieres, el «Detalle (opcional)». Mira la «Vista previa del impacto» y pulsa «Aplicar al borrador»: aviso «Edición masiva añadida al borrador (n celdas previstas).» y la barra inferior suma los cambios.
6. Revisa el borrador en la parrilla (celdas con marca naranja). «Deshacer» retira el último cambio, «Rehacer» lo devuelve y «Descartar» vacía el borrador. Nada se ha guardado todavía.
7. Para que el hotel venda ya el precio nuevo sin tocar los canales, pulsa «Guardar sin enviar a canales»: en el cuadro «Motivo del cambio» elige una etiqueta o escribe en «Motivo*» y pulsa «Continuar». Aviso «Guardado en ehotelOS sin enviar a canales: n celdas…».
8. Para guardar **y** publicar, pulsa «Revisar y publicar»: cuadro «Motivo del cambio antes de publicar» → «Continuar» → cajón «Revisar y publicar» con el resumen, la lista de cambios por tipo y la sección «Canales» (una casilla por canal con las celdas que recibiría). Marca los canales y pulsa «Publicar en n canales».
9. Comprueba en la pestaña «Historial» (`/revenue/parrilla/historial`): tu entrada con el motivo, tu usuario y la hora, el estado «guardado sin enviar a canales» o «publicado», «Ver cambios» con el detalle celda a celda y «Revertir» si hay que deshacerlo.

![Hoja «Edición masiva»: rango de fechas, tipo «Doble superior», modo «Subir/bajar %» y motivo «Evento»](../../img/revenue/edicion-masiva.png)

## Resultado esperado

- La parrilla muestra el precio nuevo en las celdas cambiadas y la barra inferior vuelve a «Sin cambios pendientes»; la reserva nueva de ese tipo y esas noches ya toma el precio nuevo.
- El «Historial» tiene la entrada con tu motivo; si publicaste, «Comercial › Canales de venta › Log de entregas» muestra una entrega por canal y noche («en cola → enviando → confirmada»). En la demo los canales están en modo de pruebas y las confirma un simulador.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Aplicar al borrador» apagado («Escribe el motivo para poder aplicar» / «Define un cambio para ver el impacto») | Falta el modo de precio con su valor o el «Motivo del cambio»: rellena los dos. |
| «Publicar en 0 canales» apagado y «Booking.com · 0 celdas · modo de pruebas» en el cajón | El producto no tiene correspondencia activa en ningún canal (en la demo solo «Double · BAR» la tiene): completa «Correspondencias» o usa «Guardar sin enviar a canales». |
| «Ninguna celda se aplicó: 1 conflicto … la celda cambió desde que se cargó» / celdas vacías o «sin tarifa» | Alguien guardó esa celda después de que abrieras la parrilla: la parrilla recarga el valor y conserva tu borrador, revísalo y guarda de nuevo. Sin BAR guardada ese día no hay precio: cárgala con «Edición masiva… › Valor fijo». |

## Más detalle

- [50 · Comercial y revenue](../../50-comercial-revenue.md) — parte 1, tarea 1 «Tarifas y parrilla» (1.1 a 1.6: celda, edición masiva, guardar, publicar, historial y estado de envío) y tarea 5.1 «Correspondencias».
