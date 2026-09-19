# Ficha · Parte de viajeros · ehotelOS

**Perfil:** Recepción · Administración de hotel · Cumplimiento (plantillas «Recepción», «Jefatura de recepción», «Administración de hotel», «Cumplimiento»). La misma pantalla está en el menú de los cuatro perfiles; el conector SES.Hospedajes lo configuran Cumplimiento o dirección.

## Antes de empezar

- El parte de cada huésped se crea **solo** con el check-in (ficha [01 · Entrada de huésped](01-entrada-de-huesped.md)); esta ficha sirve para revisarlo, reintentarlo o crear uno a mano.
- Para un parte manual: el identificador de la reserva (el que aparece en la dirección del detalle, `/recepcion/reservas/<id>`; la columna «RESERVA» de la tabla muestra el código «RES-…», que no sirve en el formulario), los datos del documento de identidad, la residencia y un contacto del viajero.
- SES.Hospedajes en la demo está en **modo de pruebas** y el conector en «CONFIGURACIÓN PENDIENTE»: nada llega al Ministerio del Interior.

## Pasos

1. Abre **Menú › Cumplimiento › Registro de viajeros** (`/cumplimiento/registro-viajeros`), pestaña «Partes de entrada». Subtítulo: «Partes de entrada de viajeros (RD 933/2021), envío a SES.Hospedajes y a las autoridades, y conservación de los datos.».
2. Lee los indicadores «n PARTES», «ACEPTADOS», «DATOS INCOMPLETOS», «EN COLA» y «RECHAZADOS O FALLIDOS», y los botones «Conector SES.Hospedajes», «Bandeja de cumplimiento» y «Actualizar».
3. Busca al huésped en la tabla «Partes de viajeros» (columnas «HUÉSPED · DOCUMENTO · ESTADO · RESERVA · CREADO · CONSERVAR HASTA»). Los partes creados en el check-in ya están aquí.
4. Si un parte está en «DATOS INCOMPLETOS» o en «RECHAZADOS O FALLIDOS», completa lo que falte (datos del viajero en su ficha o los códigos del conector) y pulsa «Reintentar envío» en su fila.
5. Para crear un parte a mano, rellena «Crear parte de entrada» («Datos del viajero, residencia, contacto y contrato. Los campos marcados son obligatorios para SES.Hospedajes; el parte se crea y su envío se encola en la misma acción.»): «Identificador de la reserva*», «Nombre*», «Primer apellido*», «Segundo apellido», «Tipo de documento*» («DNI», «Pasaporte», «TIE»), «Número de documento*», «Número de soporte (DNI/TIE)», «Nacionalidad*» (código de dos letras), «Fecha de nacimiento*», «Dirección de residencia*», «Localidad*», «País*», «Teléfono móvil», «Correo electrónico», «Número de viajeros*», «Referencia del contrato*», «Entrada» y «Salida».
6. Pulsa «Crear y encolar el envío» («Limpiar» vacía el formulario).
7. Comprueba el envío en la pestaña «SES.Hospedajes» (`/cumplimiento/registro-viajeros/ses-hospedajes`): estado del conector, indicadores «CÓDIGOS DE ESTABLECIMIENTO Y ARRENDADOR», «DATOS DEL ESTABLECIMIENTO», «WEB SERVICE» y «RECHAZADOS O FALLIDOS», y el «Historial de partes enviados» (filtros «Todos los estados · En cola · Reintentando · Aceptados · Rechazados · Fallidos»; por fila «Ver XML» y «Reintentar»). También en **Menú › Cumplimiento › Envíos a autoridades** (`/cumplimiento/envios`), pestaña «SES.HOSPEDAJES».

![Registro de viajeros del hotel de demostración: partes en «DATOS INCOMPLETOS» y el formulario «Crear parte de entrada»](../../img/administracion/registro-viajeros.png)

## Resultado esperado

- El parte aparece en «Partes de viajeros» con su «CONSERVAR HASTA» (tres años desde la salida) y su envío pasa por «EN COLA» hasta «ACEPTADOS».
- En «Envíos a autoridades › SES.HOSPEDAJES» la fila queda «ACEPTADO» (en la demo, con «Modo de pruebas»: simulado, no enviado).
- En la demo los 7 partes están en «DATOS INCOMPLETOS» porque faltan los códigos de establecimiento y arrendador del MIR; es lo esperado hasta configurar el conector.

> **En construcción:** SES.Hospedajes está en modo de pruebas y el conector de la demo en «CONFIGURACIÓN PENDIENTE» («CÓDIGOS DE ESTABLECIMIENTO Y ARRENDADOR · Faltan», «WEB SERVICE · Bloqueado»). El paso 6 no se ha ejecutado en la demo: el resultado está descrito según la pantalla y la guía de administración (capítulo 7.1).

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «DATOS INCOMPLETOS» en todos los partes y «CONFIGURACIÓN PENDIENTE» en el conector | Faltan «Código de establecimiento*» y «Código de arrendador*» en la pestaña «SES.Hospedajes» (los rellena Cumplimiento con «Guardar configuración»); después «Reintentar envío». |
| «FALLIDO (MÁX. INTENTOS)» con «SES_DISCARDED» en el historial | Son envíos descartados a propósito (residuos de pruebas antiguas): no los reintentes. |
| No sabes qué poner en «Identificador de la reserva*» | Es el identificador interno de la reserva (el de la dirección `/recepcion/reservas/<id>`), no el código «RES-…» que muestra la columna «RESERVA» de la tabla; la ayuda bajo el campo lo recuerda. |

## Más detalle

- [20 · Administración](../../20-administracion.md) — capítulo 7 «Partes de viajeros» (crear y encolar, conector SES.Hospedajes, bandeja de cumplimiento).
- [70 · Recepción](../../70-recepcion.md) — «Huéspedes y partes de viajeros» (se completa en DOC-2).
