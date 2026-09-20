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
//
// Tanda DOC-2: ortografía completa (tildes) en títulos y cuerpo, sin anglicismos
// innecesarios y con los nombres reales de las pantallas (Cumplimiento › Envíos a
// autoridades, › Registro de viajeros, › Centro de cumplimiento, › Protección de
// datos; Finanzas › Facturación y cobros). El fondo normativo no cambia.

import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { BRAND } from "../../config/brand";

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
      "régimen común"
    ],
    bodyMd: `# Qué es VeriFactu y cómo funciona

**VeriFactu** es el sistema de **emisión de facturas verificables** establecido por la AEAT (Agencia Estatal de Administración Tributaria) en el marco de la Ley Antifraude (Ley 11/2021) y el Reglamento RD 1007/2023. Obliga a los sistemas informáticos de facturación (SIF) a generar registros inalterables y, opcionalmente, remitirlos en tiempo real a la Agencia Tributaria.

## A quién aplica

- Establecimientos hoteleros en **régimen común** (no aplica en territorios forales, que usan TicketBAI).
- Empresas y autónomos que emiten facturas con programas propios o de terceros.
- Excluidos: contribuyentes acogidos al **SII** (Suministro Inmediato de Información).

## Cómo funciona el flujo

1. El SIF genera la factura y calcula una **huella encadenada** con la factura anterior.
2. Se firma electrónicamente con el certificado del emisor.
3. Si está en **modo VeriFactu**, se envía automáticamente a la AEAT por servicio web.
4. La AEAT devuelve un **CSV** (código seguro de verificación) y un **QR** que debe imprimirse en la factura.
5. El cliente puede verificar la factura escaneando el QR en la sede electrónica.

## Plazos clave

- **Entrada en vigor** (tras el RDL 15/2025, que aplazó el calendario): **1 de enero de 2027** para sociedades y **1 de julio de 2027** para autónomos y demás obligados. Durante **2026 el uso es voluntario**.
- Los SIF deben estar **certificados** y su fabricante declarar la conformidad mediante **declaración responsable** (RD 1007/2023), obligación vigente para los fabricantes desde el **29 de julio de 2025**.

## Qué hace ${BRAND.name}

- Genera la huella encadenada y firma cada factura emitida desde Finanzas › Facturación y cobros.
- Envía en tiempo real a la AEAT cuando el establecimiento está en modo VeriFactu.
- Almacena el CSV y el QR en el documento de la factura.
- Mantiene el **registro de eventos** exigido por el reglamento (alta, modificación, anulación).
- Muestra en Cumplimiento › Envíos a autoridades el estado de cada envío (enviado, pendiente o con error) y avisa en Cumplimiento › Bandeja de cumplimiento.

## Errores comunes

- **Certificado caducado**: revisa el estado del conector en Configuración › Contabilidad y fiscal › Fiscal y renueva el certificado antes del T-30.
- **Factura rechazada por huella inconsistente**: indica una posible manipulación; abre una incidencia con soporte.
- **Territorio foral**: si el establecimiento está en Bizkaia, Gipuzkoa, Araba o Navarra, usa **TicketBAI**, no VeriFactu.`
  },
  {
    id: "es-compliance-ses-hospedajes",
    title: "SES.Hospedajes: el parte de viajeros, explicado",
    category: "Cumplimiento",
    tags: [
      "ses hospedajes",
      "parte viajeros",
      "ministerio interior",
      "registro huéspedes",
      "rd 933/2021"
    ],
    bodyMd: `# SES.Hospedajes: el parte de viajeros, explicado

**SES.Hospedajes** es la plataforma del **Ministerio del Interior** (Secretaría de Estado de Seguridad) para que los establecimientos de hospedaje y las empresas de alquiler de vehículos comuniquen los datos de viajeros y contratos. Sustituye al antiguo libro-registro en papel y al envío por correo electrónico.

## Marco normativo

- **Real Decreto 933/2021** de 26 de octubre, que regula el registro documental e informativo.
- **Orden INT/1922/2003** original (libro-registro), derogada en la parte aplicable.
- Entrada en vigor plena: **2 de octubre de 2024** (tras varios aplazamientos).

## Datos que se comunican

Para cada viajero mayor de 14 años:

- Nombre, apellidos, sexo, nacionalidad, fecha de nacimiento.
- Tipo y número de documento (DNI, NIE, pasaporte), fecha de expedición.
- Dirección de residencia, teléfono, correo electrónico.
- Parentesco con los menores acompañantes.
- Datos del contrato: número, fecha de entrada y salida, número de habitación, importe, medio de pago, IBAN o últimos 4 dígitos de la tarjeta.

## Plazos de envío

- Máximo **24 horas** desde el check-in.
- Conservación en la base de datos del establecimiento: **3 años** desde el check-out.

## Cómo funciona el envío en ${BRAND.name}

1. Al confirmar el check-in se crea un parte de viajeros por cada huésped vinculado a la reserva y se encola su envío; los datos que falten (documento, dirección, acompañantes) se completan en Cumplimiento › Registro de viajeros.
2. El formato se valida antes de enviar (NIF, número de soporte, fechas).
3. El envío llega a SES.Hospedajes por su servicio web y el sistema guarda el **acuse de recibo** del Ministerio.
4. Cumplimiento › Registro de viajeros resume el estado de los partes (aceptados, con datos incompletos, en cola, rechazados o fallidos) y muestra el campo rechazado de cada error.

## Privacidad y derechos

- Datos cedidos al Ministerio del Interior con base jurídica en el RD 933/2021 (obligación legal, art. 6.1.c del RGPD).
- El huésped debe ser informado en el momento del check-in mediante una cláusula visible.
- La conservación local cifrada es obligatoria; ver el artículo **Protección de datos: qué datos personales se protegen**.

## Sanciones

- Leves: hasta 600 EUR.
- Graves: de 601 a 30.000 EUR (omisión sistemática, datos incorrectos).
- Muy graves: de 30.001 a 600.000 EUR (negativa expresa).`
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

**TicketBAI** (TBAI) es la iniciativa de las **Haciendas Forales** del País Vasco y Navarra para combatir el fraude fiscal mediante facturación electrónica con firma y encadenamiento. Cada territorio tiene **su propia normativa, plataforma y plazo**, por lo que la integración debe configurarse por jurisdicción.

## Comparativa por territorio

### Bizkaia (Diputación Foral de Bizkaia)

- Sistema: **BATUZ** (engloba TicketBAI, LROE y modelo 240).
- Obligatorio desde: **1 de enero de 2024** (todos los contribuyentes de IRPF, IS e IRNR con establecimiento permanente).
- Envío: cada factura emitida más el **LROE** (Libro Registro de Operaciones Económicas) consolidado.
- Plataforma: **edBatuz** y **e-tax** de la Hacienda Foral.

### Gipuzkoa (Diputación Foral de Gipuzkoa)

- Sistema: **TicketBAI Gipuzkoa**.
- Obligatorio desde: **1 de enero de 2022** (calendario por sector; hostelería implantada).
- Envío: factura a factura en tiempo real o en lote diario.
- Plataforma: **Zergabidea** (sede electrónica).

### Araba (Diputación Foral de Álava)

- Sistema: **TicketBAI Araba**.
- Obligatorio desde: **1 de abril de 2022** (escalonado por sector).
- Plataforma: sede electrónica de la Diputación Foral de Álava.

### Navarra (Hacienda Foral de Navarra)

- Sistema: **TicketBAI Navarra**.
- Calendario: aplazado varias veces, **obligatorio desde el 1 de enero de 2026** para hostelería.
- Envío: similar a Gipuzkoa, con esquema XSD propio.
- Plataforma: **Hacienda Tributaria de Navarra**.

## Requisitos técnicos comunes

- Certificado digital del emisor (representante o dispositivo).
- Firma electrónica XAdES.
- **Encadenamiento por huella** con la factura anterior.
- Código TBAI y QR impresos en la factura.

## Qué hace ${BRAND.name}

- Determina la **jurisdicción** a partir del territorio foral configurado en Configuración › Contabilidad y fiscal › Fiscal («Territorio foral (ruta de envío)»).
- Aplica el esquema XML y la plataforma de envío correspondientes.
- Para Bizkaia, además del envío TBAI, genera el **LROE** trimestral (modelos 140/240).
- En Cumplimiento › VeriFactu › TicketBAI (forales) el estado de los envíos se muestra por territorio.

## Errores comunes por jurisdicción

- **Bizkaia**: factura aceptada por TBAI pero no consolidada en el LROE; revisa el cierre trimestral.
- **Gipuzkoa**: rechazo por encadenamiento cuando se anula una factura sin regenerar la cadena.
- **Araba**: certificado caducado en la sede electrónica; renovar antes del T-15.
- **Navarra**: hasta enero de 2026, en entorno de pruebas; no usar en producción.

## Importante

- **Nunca mezcles** VeriFactu con TBAI: son excluyentes por territorio.
- Un grupo hotelero con establecimientos en régimen común y forales debe configurar **una identidad fiscal por jurisdicción**.`
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

El **IGIC** (Impuesto General Indirecto Canario) es el equivalente del IVA en el **Régimen Económico y Fiscal de Canarias** (REF). Las Islas Canarias están **fuera del territorio del IVA** de la UE; cualquier establecimiento hotelero en el archipiélago aplica IGIC, no IVA.

## Diferencias principales

| Aspecto | IVA peninsular | IGIC Canarias |
|---|---|---|
| Tipo general | 21 % | 7 % |
| Tipo reducido | 10 % | 3 % |
| Tipo superreducido | 4 % | 0 % |
| Tipo cero | 0 % | 0 % |
| Tipo incrementado | --- | 9,5 % y 15 % |
| Administración | AEAT | ATC (Agencia Tributaria Canaria) |
| Modelos | 303, 390 | 420, 425 |

## Tipos aplicables en hospedaje

- **Alojamiento hotelero**: 7 % de IGIC (frente al 10 % de IVA peninsular).
- **Restauración**: 7 % de IGIC.
- **Bebidas alcohólicas**: 7 % o 9,5 % según graduación.
- **Servicios de spa y bienestar**: 7 % de IGIC.
- **Tabaco**: 15 % de IGIC (incrementado).

## REF y otras ventajas fiscales

El Régimen Económico y Fiscal de Canarias incluye otros mecanismos a tener en cuenta:

- **AIEM** (Arbitrio sobre Importaciones y Entregas de Mercancías).
- **RIC** (Reserva para Inversiones en Canarias).
- **ZEC** (Zona Especial Canaria) con IS reducido al 4 %.
- **DIC** (Deducción por Inversiones en Canarias).

## Qué hace ${BRAND.name}

- Con la región fiscal «Canarias (IGIC)» en Configuración › Contabilidad y fiscal › Fiscal (o derivada de la provincia del establecimiento: 35 Las Palmas, 38 Santa Cruz de Tenerife) aplica IGIC en lugar de IVA.
- Aplica el tipo correcto por concepto (alojamiento, restauración, aparcamiento, etc.), visible en Cumplimiento › Impuestos.
- Genera los **modelos 420** (autoliquidación trimestral) y **425** (resumen anual) para la ATC.
- No envía a VeriFactu; el IGIC tiene su propio sistema de información.
- Permite configurar el régimen ZEC si el establecimiento está inscrito.

## Errores comunes

- **Aplicar el 10 % en vez del 7 %**: revisa la región fiscal del establecimiento; el perfil fiscal de Cumplimiento › Impuestos debe indicar «Canarias (IGIC)».
- **Cliente peninsular que pide IVA**: explica que en Canarias se factura con IGIC; el cliente puede solicitar la devolución mediante DUA si es viajero no residente en la UE.
- **Factura de proveedor peninsular**: si el proveedor factura con IVA por error, gestiona el abono y la refacturación con IGIC.

## Importante

- Canarias **no usa VeriFactu** ni TBAI; el flujo de cumplimiento es diferente.
- El **ITPAJD** (Impuesto sobre Transmisiones Patrimoniales y Actos Jurídicos Documentados) también tiene tipos propios en el archipiélago.`
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

El **RGPD** (Reglamento UE 2016/679) y la **LOPDGDD** (Ley Orgánica 3/2018) exigen medidas técnicas y organizativas para proteger los datos personales de los huéspedes. En ${BRAND.name} el acceso a esos datos depende del permiso de cada rol y cada consulta de un dato sensible queda en el registro de auditoría (Configuración › Sistema).

## Qué datos personales se tratan

Datos de identificación y contacto:

- Número de documento (DNI, NIE, pasaporte), nacionalidad y fecha de nacimiento (parte de viajeros).
- Dirección, teléfono y correo electrónico.
- IBAN o tarjeta, siempre tokenizados por el proveedor de pagos: ${BRAND.name} no guarda el número completo.
- Notas privadas sobre el huésped y datos de menores (protección reforzada).

Solo con consentimiento expreso:

- Preferencias de marketing y comunicaciones comerciales.
- Datos biométricos, si se usa reconocimiento facial en el acceso (categoría especial).

## Quién puede verlos

- La ficha completa del huésped la ven recepción, dirección y cumplimiento (con el permiso de acceso a datos sensibles; ver Cumplimiento › Registro de viajeros › Conservación).
- Pisos y mantenimiento ven el número de habitación y el nombre, nunca el documento.
- Las solicitudes de acceso, rectificación o supresión se atienden en Cumplimiento › Protección de datos.

## Bases jurídicas aplicables

- **Contrato** (art. 6.1.b): datos necesarios para la reserva y la estancia.
- **Obligación legal** (art. 6.1.c): comunicación a SES Hospedajes, facturación fiscal.
- **Interés legítimo** (art. 6.1.f): marketing transaccional, prevención del fraude.
- **Consentimiento** (art. 6.1.a): marketing comercial, cookies no esenciales, biometría.

## Plazos de conservación

| Categoría | Plazo |
|---|---|
| Datos de huésped (reserva) | 5 años (prescripción contractual) |
| Datos SES Hospedajes (local) | 3 años desde el check-out |
| Datos fiscales (facturas) | 6 años (Código de Comercio) y 4 años (LGT) |
| Videovigilancia | 1 mes |
| Marketing | Hasta la revocación del consentimiento |

## Derechos ARSULIPO

Los huéspedes pueden ejercer:

- **A**cceso, **R**ectificación, **S**upresión (derecho al olvido).
- **L**imitación, **P**ortabilidad, **O**posición.

${BRAND.name} gestiona estas solicitudes desde Cumplimiento › Protección de datos. El plazo de respuesta es de **1 mes**, prorrogable a 3.

## Sanciones de la AEPD

- **Leves**: hasta 40.000 EUR.
- **Graves**: de 40.001 a 300.000 EUR.
- **Muy graves**: hasta **20 millones de EUR o el 4 % de la facturación global** (la mayor).

## Importante

- Nunca exportes datos personales a hojas de cálculo sin cifrar ni los envíes por correo sin necesidad.
- Las capturas de pantalla con datos reales **no se permiten** en las consultas a soporte.
- Cualquier brecha de seguridad debe notificarse a la **AEPD en 72 horas** desde que se conoce.`
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
      "garantía financiera",
      "viaje combinado"
    ],
    bodyMd: `# Registro Especial de Agencias de Viajes (REAV)

El **REAV** (Registro Especial de Agencias de Viajes, denominación variable según la comunidad autónoma) es el registro autonómico al que deben inscribirse las empresas que comercializan **viajes combinados** o **servicios de viaje vinculados** según el **Real Decreto-ley 23/2018**, que transpone la Directiva UE 2015/2302.

## A quién aplica

- Hoteles que **revenden paquetes** (alojamiento + transporte, alojamiento + actividades, etc.) bajo su marca.
- Receptivos y mayoristas.
- Plataformas que combinan dos o más servicios de viaje.

**No aplica** a la venta únicamente de alojamiento propio.

## Denominación por comunidad autónoma

Cada comunidad autónoma tiene **su propio registro y normativa**:

- Andalucía: **RTA** (Registro de Turismo de Andalucía), sección agencias.
- Cataluña: **RTC** (Registro de Turismo de Cataluña).
- Madrid: **REAVM** (Registro Especial de Agencias de Viajes de Madrid).
- Canarias: REAV con normativa propia (Decreto 90/2010).
- País Vasco, Galicia, etc.: registros equivalentes en sus respectivas direcciones de turismo.

## Requisitos para la inscripción

- **Código identificativo** (CICMA en Madrid, AN-xxxxx en Andalucía, GC-xxxx en Canarias, etc.).
- **Seguro de responsabilidad civil** (cuantía variable, típicamente de 300.000 a 900.000 EUR).
- **Garantía financiera** para insolvencia (aval, seguro o depósito).
- **Domicilio** y declaración responsable de actividad.

## Garantía financiera obligatoria

Para cubrir reembolsos y repatriaciones en caso de insolvencia:

- Modalidades: aval bancario, seguro de caución, depósito en efectivo o fondo de garantía colectivo.
- Cuantía mínima: típicamente entre 100.000 EUR y el 5 % del volumen de negocio del ejercicio anterior, según la comunidad autónoma.
- Renovación anual con prueba documental.

## Qué hace ${BRAND.name}

- Detecta cuando una reserva contiene **dos o más servicios** (alojamiento + traslado, alojamiento + experiencia) y la marca como **viaje combinado**.
- Aplica las cláusulas obligatorias del RD-ley 23/2018 (información precontractual, formulario de información normalizado).
- Guarda el **código REAV** y la documentación de la garantía financiera en Cumplimiento › Centro de cumplimiento › Documentos.
- En el Centro de cumplimiento, la matriz de obligaciones recoge el estado del registro y la fecha de renovación del seguro y del aval.
- Genera el **formulario de información normalizado** (Anexo I del RD-ley) en cada reserva combinada.

## Obligaciones precontractuales

Antes de contratar, el viajero debe recibir:

- Características del viaje (destino, fechas, alojamiento, transporte).
- Precio total con impuestos y todos los recargos.
- Datos identificativos del organizador y, en su caso, del minorista.
- Procedimiento para reclamar y formulario de desistimiento.
- Información sobre el derecho a la transferencia del contrato.

## Sanciones típicas

- Comercializar sin REAV: **infracción grave** según la ley de turismo de cada comunidad autónoma.
- Multas que oscilan entre **3.000 EUR y 90.000 EUR** según la gravedad y la comunidad.
- Suspensión temporal de la actividad en casos reiterados.

## Importante

- El registro es **autonómico**: si operas en varias comunidades, comprueba si necesitas la inscripción en cada una o si vale la del domicilio social.
- La **transparencia de precios** (todo incluido y visible desde el inicio) es una de las obligaciones más inspeccionadas.
- Si vendes solo alojamiento propio, **no estás obligado** al REAV; basta con la licencia de actividad turística del hotel.`
  }
] as const;
