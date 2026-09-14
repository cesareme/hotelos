# VeriFactu · Declaración responsable del sistema informático de facturación

Referencia de producto para Anfitorio (Tanda 3 · «cumplimiento sin atrezzo»).
Explica qué obliga el art. 13 del RD 1007/2023 al **productor** del software,
cómo se corresponde con el bloque `SistemaInformatico` que viaja en cada
registro de facturación (Orden HAC/1177/2024, anexo) y con las variables de
entorno que lo alimentan, y cuál es el procedimiento cuando cambia la versión.
No sustituye al asesoramiento jurídico del productor.

## 1. Quién declara y qué

El RD 1007/2023 (Reglamento de los sistemas informáticos de facturación, SIF)
impone dos obligaciones distintas a dos sujetos distintos:

| Sujeto | Obligación | Dónde vive en Anfitorio |
|---|---|---|
| **Obligado tributario** (el hotel que emite la factura) | Usar un SIF conforme y remitir los registros a AEAT (modalidad VERI*FACTU). Su NIF es `IDEmisorFactura` / `ObligadoEmision/NIF`. | `Organization.taxId` → snapshot `Invoice.issuerTaxId` (`issuer-identity.service.ts`) |
| **Productor / comercializador del SIF** (la empresa titular de Anfitorio) | Certificar mediante **declaración responsable** (art. 13) que el sistema cumple los requisitos del art. 8 (integridad, conservación, accesibilidad, legibilidad, trazabilidad e inalterabilidad de los registros) y hacerla visible a sus usuarios. Sus datos son el bloque `SistemaInformatico`. | `resolveVerifactuSoftware()` (`packages/compliance/src/spain/verifactu/software.ts`) alimentado por `VERIFACTU_*` |

Confusión que este documento corrige: `VERIFACTU_SOFTWARE_NIF` **no es el NIF
del hotel**; es el del productor. `VERIFACTU_INSTALL_NUMBER` **no lo asigna
AEAT**; lo asigna el productor a cada instalación/despliegue y lo mantiene en
su propio registro de instalaciones.

## 2. Contenido mínimo de la declaración (art. 13 RD 1007/2023)

La declaración es un documento del productor, firmado por su responsable,
emitido **por cada versión** del sistema. Debe contener, como mínimo:

1. **Identificación del sistema informático**: nombre, código identificador,
   versión y descripción de sus componentes y funcionalidades de facturación.
2. **Modalidad de uso**: si el sistema permite operar como sistema de emisión
   de facturas verificables (VERI*FACTU) y/o como sistema no VERI*FACTU, y si
   puede ser usado por varios obligados tributarios (multi-obligado).
3. **Identificación del productor**: nombre o razón social, NIF y dirección.
4. **Manifestación expresa** de que el sistema cumple los requisitos del
   art. 8 del RD 1007/2023 y de la Orden HAC/1177/2024 (registros de
   facturación con huella encadenada, registro de eventos cuando proceda,
   conservación, exportación e integridad).
5. **Fecha y lugar** de la declaración y **firma** del responsable.

Además debe estar **visible en el propio sistema** y a disposición de los
usuarios (los hoteles) de forma que quede constancia; Anfitorio la enlaza
desde el artículo de ayuda «Cumplimiento español» y desde la pantalla de
readiness fiscal (pendiente del lote readiness).

## 3. Correspondencia declaración ↔ XML ↔ variables de entorno

| Dato de la declaración | Elemento `SistemaInformatico` (Orden HAC/1177/2024) | Límite XSD | Variable / origen | Valor por defecto |
|---|---|---|---|---|
| Razón social del productor | `NombreRazon` | ≤ 120 | `VERIFACTU_SOFTWARE_NAME` | — (obligatorio) |
| NIF del productor | `NIF` | NIF válido | `VERIFACTU_SOFTWARE_NIF` (checksum validado) | — (obligatorio) |
| Nombre del sistema | `NombreSistemaInformatico` | ≤ 30 | `VERIFACTU_SYSTEM_NAME` | `Anfitorio` |
| Código identificador del sistema | `IdSistemaInformatico` | exactamente 2 | `VERIFACTU_SYSTEM_ID` | `01` |
| Versión declarada | `Version` | ≤ 50 | `VERIFACTU_SYSTEM_VERSION` → `APP_VERSION` | `0.1.0` |
| Identificador de la instalación (registro del productor) | `NumeroInstalacion` | ≤ 100 | `VERIFACTU_INSTALL_NUMBER` | — (obligatorio) |
| Solo VERI*FACTU (sin modalidad no verificable) | `TipoUsoPosibleSoloVerifactu` | S/N | fijo `S` (Anfitorio no opera sin remisión) | `S` |
| Multi-obligado (SaaS) | `TipoUsoPosibleMultiOT` | S/N | `VERIFACTU_MULTI_OT` | `S` |
| Esta instalación sirve a varios obligados | `IndicadorMultiplesOT` | S/N | `VERIFACTU_MULTI_OT` | `S` |

Reglas de `resolveVerifactuSoftware()`:

- Una cadena vacía cuenta como **no configurado** (el `.env` de la demo tenía
  `VERIFACTU_SOFTWARE_NIF=` y `??` no lo sustituía: 19 XML con `<NIF></NIF>`).
- Devuelve `{ ok, errors[], software }`. En `sandbox` se envían defaults
  etiquetados (`PRODUCTOR SIN CONFIGURAR`, `B00000000`, `DEV-001`) contra el
  stub; en `preproduction` / `production` **no se envía nada** mientras
  `errors.length > 0`: la fila queda `retrying` con `SOFTWARE_NOT_CONFIGURED`
  (backoff largo, sin consumir `VERIFACTU_MAX_ATTEMPTS`) y se reintenta cuando
  el operador completa el entorno.
- API y worker comparten el mismo resolver; cada fila de
  `verifactu_submissions` guarda en `software_json` el bloque exacto con el que
  se construyó el XML (auditoría reproducible) y en `mode` el modo de envío.
- TicketBAI reutiliza NIF, razón social, nombre y versión del mismo resolver
  (`resolveTbaiSoftware()` en `tbai-submission.service.ts`) y añade
  `TBAI_LICENSE_KEY` (≤ 20) y `TBAI_DEVICE_SERIAL` (≤ 30, por defecto el
  número de instalación).

## 4. Procedimiento de cambio de versión

`Version` forma parte de cada registro remitido, así que un cambio de versión
del sistema de facturación exige una nueva declaración responsable **antes**
de que la nueva versión emita registros.

1. Decidir el número de versión declarable (semver del producto, p. ej.
   `1.4.0`). No usar valores de build (`dev`, hashes de commit).
2. Emitir y firmar la nueva declaración responsable con esa versión (mismo
   `IdSistemaInformatico`; cambia solo `Version`). Archivar el PDF firmado en
   el repositorio documental del productor y publicarlo donde los usuarios
   puedan consultarlo.
3. Desplegar con `VERIFACTU_SYSTEM_VERSION=<versión>` (o `APP_VERSION`
   igualado a ella). Comprobar `GET /compliance/health` → `verifactu.software.ok`
   (lote readiness) y que un envío de prueba en `preproduction` lleva la
   versión nueva en `<sum1:Version>`.
4. A partir de ese momento todos los registros nuevos (altas, anulaciones y
   reintentos) llevan el bloque nuevo. Los registros ya remitidos conservan
   su `software_json` original: **no se reenvían**.
5. Si cambian razón social o NIF del productor (cesión del producto), además
   de la declaración hay que actualizar `VERIFACTU_SOFTWARE_NAME` /
   `VERIFACTU_SOFTWARE_NIF`; no requiere tocar la cadena de huellas (el bloque
   `SistemaInformatico` no entra en la huella).

Checklist rápida antes de `VERIFACTU_MODE=preproduction`:

- [ ] Declaración responsable firmada para la versión desplegada.
- [ ] `VERIFACTU_SOFTWARE_NAME`, `VERIFACTU_SOFTWARE_NIF`, `VERIFACTU_INSTALL_NUMBER` definidos y `resolveVerifactuSoftware().ok === true`.
- [ ] `VERIFACTU_CERT_P12` + `VERIFACTU_CERT_P12_PASSPHRASE` (certificado de representante/sello del **obligado** o del colaborador social, para mTLS).
- [ ] NIF del hotel válido en `Organization.taxId` (readiness fiscal en verde).

## 5. Estado técnico del envío real (honesto)

Lo que está implementado en `packages/compliance/src/spain/verifactu/submitter.ts`:

- Sobre SOAP 1.1 (`soapenv:Envelope/Body` con `sum:RegFactuSistemaFacturacion`)
  hacia `SistemaFacturacionWeb` de pre-producción/producción, `SOAPAction: ""`,
  mTLS con PKCS#12 o PEM, timeout de 30 s.
- El cuerpo remitido es el registro **sin firmar** (`transportXml`): en la
  modalidad VERI*FACTU el registro no lleva firma electrónica (art. 12
  RD 1007/2023); la firma XAdES que Anfitorio genera se conserva solo en
  `xml_payload` como pista de auditoría (`VERIFACTU_SIGN_PEM`).
- Parseo de la respuesta (`EstadoEnvio`, `CSV`, `EstadoRegistro`,
  `CodigoErrorRegistro`, `DescripcionErrorRegistro`, `Fault`) sin depender
  del prefijo de namespace; `Correcto` → aceptado, `AceptadoConErrores` /
  `ParcialmenteCorrecto` → aceptado con errores, `Incorrecto` → rechazado.
- Errores de transporte (`NETWORK_*`, HTTP 5xx/429) y de configuración
  (`CERT_NOT_CONFIGURED`, `SOFTWARE_NOT_CONFIGURED`) se reintentan; solo un
  código de AEAT o un HTTP 4xx deja la fila en `rejected`.

Pendiente de validar contra el entorno de pre-producción de AEAT (los XSD
oficiales `SuministroLR.xsd`, `SuministroInformacion.xsd` y
`RespuestaSuministro.xsd` no están en el repositorio):

- Nombres exactos de los elementos de respuesta y el prefijo (`tikR`).
- `FacturasRectificadas/IDFacturaRectificada` (tipo `IDFacturaARType`) y
  `IDFactura/*Anulada` en `RegistroAnulacion`.
- Ausencia de `ClaveRegimen` para `Impuesto=02` (IPSI) y valores de L8B para IGIC.
- Longitudes del bloque `SistemaInformatico` (tabla del punto 3).

Hasta entonces `VERIFACTU_MODE=sandbox` es el único modo con acuse; el modo
`preproduction` está preparado para el primer envío de prueba (el acuse real
alimentará el test de contrato).
