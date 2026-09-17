// Spanish compliance help articles
//
// Knowledge base entries that operators see inside CocoaSearchableHelpModal.
// Each entry conforms to the CocoaHelpArticle shape declared in
// src/components/cocoa-guidance/CocoaSearchableHelpModal.tsx.
//
// Articles cover the Spanish regulatory stack that affects hotel operations:
// VeriFactu (AEAT real-time invoicing), SES Hospedajes (Ministerio del
// Interior traveler reporting), TicketBAI (Basque Country and Navarre foral
// jurisdictions), IGIC vs IVA (Canary Islands tax regime), GDPR PII
// encryption, and REAV (registry for travel agencies).

import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";

export const SPANISH_COMPLIANCE_ARTICLES: readonly CocoaHelpArticle[] = [
  {
    id: "es-compliance-verifactu",
    title: "Qué es VeriFactu y cómo funciona",
    category: "Cumplimiento",
    tags: [
      "verifactu",
      "aeat",
      "factura",
      "tiempo real",
      "antifraude",
      "regimen comun"
    ],
    bodyMd: `# Qué es VeriFactu y cómo funciona

**VeriFactu** es el sistema de **emisión de facturas verificables** establecido por la AEAT (Agencia Estatal de Administración Tributaria) en el marco de la Ley Antifraude (Ley 11/2021) y el Reglamento RD 1007/2023. Obliga a los sistemas informaticos de facturación (SIF) a generar registros inalterables y, opcionalmente, remitirlos en tiempo real a la Agencia Tributaria.

## A quien aplica

- Establecimientos hoteleros en **régimen comun** (no aplica en territorios forales, que usan TicketBAI).
- Empresas y autonomos que emiten facturas con software propio o de terceros.
- Excluidos: contribuyentes acogidos al **SII** (Suministro Inmediato de Información).

## Como funciona el flujo

1. El SIF genera la factura y calcula un **hash encadenado** con la factura anterior.
2. Se firma electrónicamente con certificado del emisor.
3. Si esta en **modo VeriFactu**, se envia automáticamente a la AEAT por servicio web.
4. La AEAT devuelve un **CSV** (código seguro de verificación) y un **QR** que debe imprimirse en la factura.
5. El cliente puede verificar la factura escaneando el QR en la sede electrónica.

## Plazos clave

- **Entrada en vigor** (tras el RDL 15/2025, que aplazo el calendario): **1 enero 2027** para sociedades y **1 julio 2027** para autonomos y demas obligados. Durante **2026 el uso es voluntario**.
- Los SIF deben estar **certificados** y su fabricante declarar conformidad mediante **declaración responsable** (RD 1007/2023) — obligación vigente para los fabricantes desde el **29 de julio de 2025**.

## Que hace ehotelOS

- Genera el hash encadenado y firma cada factura emitida desde Billing.
- Envia en tiempo real a la AEAT cuando el establecimiento esta en modo VeriFactu.
- Almacena CSV y QR en el documento de la factura.
- Mantiene el **registro de eventos** exigido por el reglamento (alta, modificación, anulación).
- Muestra en el panel de Compliance el estado de envio (verde=enviado, ambar=pendiente, rojo=error).

## Errores comunes

- **Certificado caducado**: revisa el document vault y renueva antes del T-30.
- **Factura rechazada por hash inconsistente**: indica una posible manipulacion; abre incidencia con soporte.
- **País foral**: si el establecimiento esta en Bizkaia, Gipuzkoa, Araba o Navarra, usa **TicketBAI**, no VeriFactu.`
  },
  {
    id: "es-compliance-ses-hospedajes",
    title: "SES.Hospedajes: el parte de viajeros, explicado",
    category: "Cumplimiento",
    tags: [
      "ses hospedajes",
      "parte viajeros",
      "ministerio interior",
      "registro huespedes",
      "rd 933/2021"
    ],
    bodyMd: `# SES.Hospedajes: el parte de viajeros, explicado

**SES.Hospedajes** es la plataforma del **Ministerio del Interior** (Secretaria de Estado de Seguridad) para que los establecimientos de hospedaje y empresas de alquiler de vehiculos comuniquen los datos de viajeros y contratos. Sustituye al antiguo libro-registro en papel y al envio por correo electrónico.

## Marco normativo

- **Real Decreto 933/2021** de 26 de octubre, que regula el registro documental e informativo.
- **Orden INT/1922/2003** original (libro-registro), derogada en la parte aplicable.
- Entrada en vigor plena: **2 octubre 2024** (tras varios aplazamientos).

## Datos que se comunican

Para cada viajero mayor de 14 anos:

- Nombre, apellidos, sexo, nacionalidad, fecha de nacimiento.
- Tipo y número de documento (DNI, NIE, pasaporte), fecha de expedicion.
- Dirección de residencia, teléfono, email.
- Parentesco con menores acompanantes.
- Datos del contrato: número, fecha de entrada y salida, número de habitación, importe, medio de pago, IBAN o últimos 4 digitos de la tarjeta.

## Plazos de envio

- Máximo **24 horas** desde el check-in.
- Conservacion en BBDD del establecimiento: **3 anos** desde el check-out.

## Como funciona el envio en ehotelOS

1. En el check-in, Front Desk captura los datos exigidos via scanner DNI/pasaporte o entrada manual.
2. Se valida formato (NIF, MRZ pasaporte) en tiempo real.
3. El **batch de envio** se ejecuta automáticamente cada hora hacia SES.Hospedajes via API REST.
4. El sistema almacena el **acuse de recibo** firmado por el Ministerio.
5. Errores de envio aparecen en Compliance > SES con el detalle del campo rechazado.

## Privacidad y derechos

- Datos cedidos al Ministerio del Interior con base jurídica en el RD 933/2021 (obligación legal, art. 6.1.c GDPR).
- El huésped debe ser informado en el momento del check-in mediante cláusula visible.
- La conservacion local cifrada es obligatoria; ver el artículo de **GDPR PII encrypted fields**.

## Sanciones

- Leves: hasta 600 EUR.
- Graves: 601 a 30.000 EUR (omision sistematica, datos incorrectos).
- Muy graves: 30.001 a 600.000 EUR (negativa expresa).`
  },
  {
    id: "es-compliance-ticketbai-foral",
    title: "TicketBAI en los territorios forales",
    category: "Cumplimiento",
    tags: [
      "ticketbai",
      "tbai",
      "bizkaia",
      "gipuzkoa",
      "araba",
      "navarra",
      "hacienda foral",
      "batuz"
    ],
    bodyMd: `# TicketBAI en los territorios forales

**TicketBAI** (TBAI) es la iniciativa de las **Haciendas Forales** del País Vasco y Navarra para combatir el fraude fiscal mediante facturación electrónica con firma y encadenamiento. Cada territorio tiene **su propia normativa, plataforma y plazo**, por lo que la integración debe configurarse por jurisdiccion.

## Comparativa por territorio

### Bizkaia (Diputacion Foral de Bizkaia)

- Sistema: **BATUZ** (engloba TicketBAI, LROE y modelo 240).
- Obligatorio desde: **1 enero 2024** (todos los contribuyentes IRPF/IS/IRNR con EP).
- Envio: cada factura emitida + **LROE** (Libro Registro de Operaciones Economicas) consolidado.
- Plataforma: **edBatuz** y **e-tax** de la Hacienda Foral.

### Gipuzkoa (Diputacion Foral de Gipuzkoa)

- Sistema: **TicketBAI Gipuzkoa**.
- Obligatorio desde: **1 enero 2022** (calendario por sector; hosteleria implantada).
- Envio: factura a factura en tiempo real o en lote diario.
- Plataforma: **Zergabidea** (sede electrónica).

### Araba (Diputacion Foral de Álava)

- Sistema: **TicketBAI Araba**.
- Obligatorio desde: **1 abril 2022** (escalonado por sector).
- Plataforma: sede electrónica de la Diputacion Foral de Álava.

### Navarra (Hacienda Foral de Navarra)

- Sistema: **TicketBAI Navarra**.
- Calendario: aplazado varias veces, **obligatorio desde 1 enero 2026** para hosteleria.
- Envio: similar a Gipuzkoa, con esquema XSD propio.
- Plataforma: **Hacienda Tributaria de Navarra**.

## Requisitos técnicos comunes

- Certificado digital del emisor (representante o dispositivo).
- Firma electrónica XAdES.
- **Encadenamiento por hash** con la factura anterior.
- Código TBAI y QR impresos en la factura.

## Que hace ehotelOS

- Detecta la **jurisdiccion** a partir del CIF y la dirección fiscal del establecimiento.
- Aplica el esquema XML y la plataforma de envio correspondientes.
- Para Bizkaia, además del envio TBAI, genera el **LROE** trimestral (modelos 140/240).
- En el panel de Compliance, los semaforos de TBAI se separan por territorio.

## Errores comunes por jurisdiccion

- **Bizkaia**: factura aceptada por TBAI pero no consolidada en LROE; revisa el cierre trimestral.
- **Gipuzkoa**: rechazo por encadenamiento cuando se anula una factura sin regenerar la cadena.
- **Araba**: certificado caducado en sede electrónica; renovar antes del T-15.
- **Navarra**: hasta enero 2026, en entorno de pruebas; no usar en producción.

## Importante

- **Nunca mezcles** VeriFactu con TBAI: son excluyentes por territorio.
- Un grupo hotelero con establecimientos en régimen comun y forales debe configurar **una identidad fiscal por jurisdiccion**.`
  },
  {
    id: "es-compliance-igic-iva-canarias",
    title: "IGIC e IVA en Canarias",
    category: "Cumplimiento",
    tags: [
      "igic",
      "iva",
      "canarias",
      "atc",
      "agencia tributaria canaria",
      "fiscalidad"
    ],
    bodyMd: `# IGIC e IVA en Canarias

El **IGIC** (Impuesto General Indirecto Canario) es el equivalente del IVA en el **Régimen Económico y Fiscal de Canarias** (REF). Las Islas Canarias estan **fuera del territorio IVA** de la UE; cualquier establecimiento hotelero en el archipielago aplica IGIC, no IVA.

## Diferencias principales

| Aspecto | IVA peninsular | IGIC Canarias |
|---|---|---|
| Tipo general | 21% | 7% |
| Tipo reducido | 10% | 3% |
| Tipo superreducido | 4% | 0% |
| Tipo zero | 0% | 0% |
| Tipo incrementado | --- | 9,5% y 15% |
| Administración | AEAT | ATC (Agencia Tributaria Canaria) |
| Modelos | 303, 390 | 420, 425 |

## Tipos aplicables en hospedaje

- **Alojamiento hotelero**: 7% IGIC (frente al 10% IVA peninsular).
- **Restauracion**: 7% IGIC.
- **Bebidas alcoholicas**: 7% o 9,5% según graduacion.
- **Servicios SPA y wellness**: 7% IGIC.
- **Tabaco**: 15% IGIC (incrementado).

## REF y otras ventajas fiscales

El Régimen Económico y Fiscal de Canarias incluye otros mecanismos a tener en cuenta:

- **AIEM** (Arbitrio sobre Importaciones y Entregas de Mercancias).
- **RIC** (Reserva para Inversiones en Canarias).
- **ZEC** (Zona Especial Canaria) con IS reducido al 4%.
- **DIC** (Deducción por Inversiones en Canarias).

## Que hace ehotelOS

- Detecta el **código postal** y la provincia del establecimiento (35 Las Palmas, 38 Santa Cruz de Tenerife) y conmuta automáticamente a IGIC.
- Aplica el tipo correcto por concepto (alojamiento, F&B, parking, etc.).
- Genera los **modelos 420** (autoliquidacion trimestral) y **425** (resumen anual) para la ATC.
- No envia a VeriFactu; el IGIC tiene su propio sistema de información.
- Permite configurar el régimen ZEC si el establecimiento esta inscrito.

## Errores comunes

- **Aplicar 10% en vez de 7%**: revisa la configuración del establecimiento; el panel debe mostrar bandera "IGIC".
- **Cliente peninsular que pide IVA**: explica que en Canarias se factura con IGIC; el cliente puede solicitar devolución via DUA si es viajero no residente UE.
- **Factura de proveedor peninsular**: si el proveedor factura con IVA por error, gestionar abono y refacturación con IGIC.

## Importante

- Canarias **no usa VeriFactu** ni TBAI; el flujo de cumplimiento es diferente.
- El **ITPAJD** (Impuesto sobre Transmisiones Patrimoniales y Actos Juridicos Documentados) también tiene tipos propios en el archipielago.`
  },
  {
    id: "es-compliance-gdpr-pii-encrypted",
    title: "Protección de datos: qué datos personales se protegen",
    category: "Cumplimiento",
    tags: [
      "gdpr",
      "rgpd",
      "lopdgdd",
      "pii",
      "cifrado",
      "encryption",
      "aepd",
      "datos personales"
    ],
    bodyMd: `# Protección de datos: qué datos personales se protegen

El **RGPD** (Reglamento UE 2016/679) y la **LOPDGDD** (Ley Orgánica 3/2018) exigen medidas técnicas y organizativas para proteger los datos personales de los huéspedes. En ehotelOS el acceso a esos datos depende del permiso de cada rol y cada consulta de un dato sensible queda en el registro de auditoría (Configuración › Sistema).

## Qué datos personales se tratan

Datos de identificación y contacto:

- Número de documento (DNI, NIE, pasaporte), nacionalidad y fecha de nacimiento (parte de viajeros).
- Dirección, teléfono y correo electrónico.
- IBAN o tarjeta, siempre tokenizados por el proveedor de pagos: ehotelOS no guarda el número completo.
- Notas privadas sobre el huésped y datos de menores (protección reforzada).

Solo con consentimiento expreso:

- Preferencias de marketing y comunicaciones comerciales.
- Datos biométricos, si se usa reconocimiento facial en el acceso (categoría especial).

## Quién puede verlos

- La ficha completa del huésped la ven recepción, dirección y cumplimiento (permiso «ver datos sensibles»).
- Pisos y mantenimiento ven el número de habitación y el nombre, nunca el documento.
- Las solicitudes de acceso, rectificación o supresión se atienden en Cumplimiento › Protección de datos.

## Bases juridicas aplicables

- **Contrato** (art. 6.1.b): datos necesarios para la reserva y estancia.
- **Obligación legal** (art. 6.1.c): comunicación a SES Hospedajes, facturación fiscal.
- **Interes legitimo** (art. 6.1.f): marketing transaccional, prevencion de fraude.
- **Consentimiento** (art. 6.1.a): marketing comercial, cookies no esenciales, biometria.

## Plazos de conservacion

| Categoría | Plazo |
|---|---|
| Datos de huésped (reserva) | 5 anos (prescripcion contractual) |
| Datos SES Hospedajes (local) | 3 anos desde checkout |
| Datos fiscales (facturas) | 6 anos (Código Comercio) y 4 anos (LGT) |
| Videovigilancia | 1 mes |
| Marketing | Hasta revocacion del consentimiento |

## Derechos ARSULIPO

Los huéspedes pueden ejercer:

- **A**cceso, **R**ectificacion, **S**upresion (derecho al olvido).
- **L**imitacion, **P**ortabilidad, **O**posición.

ehotelOS automatiza estos flujos desde Compliance > Solicitudes RGPD. El plazo de respuesta es de **1 mes** prorrogable a 3.

## Sanciones AEPD

- **Leves**: hasta 40.000 EUR.
- **Graves**: 40.001 a 300.000 EUR.
- **Muy graves**: hasta **20 millones EUR o 4% facturación global** (el mayor).

## Importante

- Nunca exportes campos PII a Excel sin cifrar; usa el modulo de **export con redaccion**.
- Las capturas de pantalla con datos reales **no se permiten** en tickets de soporte.
- Cualquier brecha de seguridad debe notificarse a la **AEPD en 72 horas** desde su conocimiento.`
  },
  {
    id: "es-compliance-reav",
    title: "Registro Especial de Agencias de Viajes (REAV)",
    category: "Cumplimiento",
    tags: [
      "reav",
      "agencia viajes",
      "ccaa",
      "turismo",
      "garantia financiera",
      "viaje combinado"
    ],
    bodyMd: `# Registro Especial Agencias Viajes (REAV)

El **REAV** (Registro Especial de Agencias de Viajes, denominacion variable por CCAA) es el registro autonómico al que deben inscribirse las empresas que comercializan **viajes combinados** o **servicios de viaje vinculados** según el **Real Decreto-ley 23/2018** que transpone la Directiva UE 2015/2302.

## A quien aplica

- Hoteles que **revenden paquetes** (alojamiento + transporte, alojamiento + actividades, etc.) bajo su marca.
- Receptivos y mayoristas.
- Plataformas que combinan dos o mas servicios de viaje.

**No aplica** a la venta unicamente de alojamiento propio.

## Denominacion por CCAA

Cada comunidad autonoma tiene **su propio registro y normativa**:

- Andalucia: **RTA** (Registro de Turismo de Andalucia), sección agencias.
- Cataluna: **RTC** (Registro de Turismo de Cataluna).
- Madrid: **REAVM** (Registro Especial de Agencias de Viajes de Madrid).
- Canarias: REAV con normativa propia (Decreto 90/2010).
- País Vasco, Galicia, etc.: registros equivalentes en sus respectivas direcciones de turismo.

## Requisitos para inscripcion

- **Código identificativo** (CICMA en Madrid, AN-xxxxx en Andalucia, GC-xxxx en Canarias, etc.).
- **Seguro de responsabilidad civil** (cuantia variable, tipicamente 300.000-900.000 EUR).
- **Garantía financiera** para insolvencia (aval, seguro o depósito).
- **Domicilio** y declaración responsable de actividad.

## Garantía financiera obligatoria

Para cubrir reembolsos y repatriaciones en caso de insolvencia:

- Modalidades: aval bancario, seguro de caucion, depósito en efectivo o fondo de garantía colectivo.
- Cuantia mínima: tipicamente entre 100.000 EUR y el 5% del volumen de negocio del ejercicio anterior, según CCAA.
- Renovacion anual con prueba documental.

## Que hace ehotelOS

- Detecta cuando una reserva contiene **dos o mas servicios** (alojamiento + traslado, alojamiento + experiencia) y la marca como **viaje combinado**.
- Aplica las cláusulas obligatorias del RD-ley 23/2018 (información precontractual, formulario de información normalizado).
- Almacena el **código REAV** y la documentación de la garantía financiera en el document vault.
- En Compliance > Turismo muestra el estado del registro y la fecha de renovacion del seguro y aval.
- Genera el **formulario de información normalizado** (Anexo I del RD-ley) en cada reserva combinada.

## Obligaciones precontractuales

Antes de contratar, el viajero debe recibir:

- Caracteristicas del viaje (destino, fechas, alojamiento, transporte).
- Precio total con impuestos y todos los recargos.
- Datos identificativos del organizador y, en su caso, minorista.
- Procedimiento para reclamar y formulario de desistimiento.
- Información sobre derecho a la transferencia del contrato.

## Sanciones tipicas

- Comercializar sin REAV: **infraccion grave** según la ley de turismo de cada CCAA.
- Multas que oscilan entre **3.000 EUR y 90.000 EUR** según gravedad y comunidad.
- Suspension temporal de actividad en casos reiterados.

## Importante

- El registro es **autonómico**: si operas en varias CCAA, comprueba si necesitas inscripcion en cada una o si vale la del domicilio social.
- La **transparencia de precios** (todo incluido visible desde el inicio) es de las obligaciones mas inspeccionadas.
- Si vendes solo alojamiento propio, **no estas obligado** al REAV; basta con la licencia de actividad turistica del hotel.`
  }
] as const;
