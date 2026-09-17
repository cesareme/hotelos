# VeriFactu · Declaración responsable del sistema informático de facturación

Referencia de producto para ehotelOS (Tanda 3 · «cumplimiento sin atrezzo»;
Tanda 6b · estructura societaria, 2026-09-16). Explica qué obliga el art. 13
del RD 1007/2023 al **productor** del software, cómo se corresponde con el
bloque `SistemaInformatico` que viaja en cada registro de facturación (Orden
HAC/1177/2024, anexo) y con las variables de entorno y la tabla de
instalaciones que lo alimentan, cómo se organiza la facturación de un grupo
hotelero (una sociedad, varios centros) dentro de un SaaS multi-obligado, y
cuál es el procedimiento cuando cambia la versión. No sustituye al
asesoramiento jurídico del productor.

## 1. Quién declara y qué

El RD 1007/2023 (Reglamento de los sistemas informáticos de facturación, SIF)
impone dos obligaciones distintas a dos sujetos distintos:

| Sujeto | Obligación | Dónde vive en ehotelOS |
|---|---|---|
| **Obligado tributario** (la **sociedad** que explota el hotel o los hoteles) | Usar un SIF conforme y remitir los registros a AEAT (modalidad VERI*FACTU). Su NIF es `IDEmisorFactura` / `ObligadoEmision/NIF`; su razón social, `ObligadoEmision/NombreRazon` y `NombreRazonEmisor`. | `LegalEntity.taxId` / `legalName` → `resolveLegalIdentity()` (`apps/api/src/lib/finance-scope.ts`, lector único) → `resolveIssuerIdentity()` (`issuer-identity.service.ts`) → snapshot `Invoice.issuerTaxId` / `issuerLegalName` (inmutable por trigger). El hotel (`Property`) es el **establecimiento** de la factura (art. 6.1.e RD 1619/2012): código, nombre comercial y dirección en el PDF; **nunca** aporta NIF ni razón social. |
| **Productor / comercializador del SIF** (la empresa titular de ehotelOS) | Certificar mediante **declaración responsable** (art. 13) que el sistema cumple los requisitos del art. 8 (integridad, conservación, accesibilidad, legibilidad, trazabilidad e inalterabilidad de los registros) y hacerla visible a sus usuarios. Sus datos son el bloque `SistemaInformatico`. | `resolveVerifactuSoftware(env, { installation })` (`packages/compliance/src/spain/verifactu/software.ts`) alimentado por `VERIFACTU_*` y por la instalación declarada del centro (`verifactu_installations`). |

Confusiones que este documento corrige: `VERIFACTU_SOFTWARE_NIF` **no es el
NIF del hotel**; es el del productor. `NumeroInstalacion` **no lo asigna
AEAT**; lo asigna el productor a cada instalación y lo mantiene en su propio
registro de instalaciones — que desde la Tanda 6b es la tabla
`verifactu_installations` (una fila por facturación, número inmutable), no una
variable de entorno global. Y el obligado es la **sociedad**, no el hotel: en
la demo de Faranda, Rías Altas enviaba como `NombreRazon` su nombre comercial
(«Hotel Faranda Rías Altas by Ascend Collection»), que no es la razón social de
ningún NIF; desde L3 el registro lleva la razón social de la sociedad.

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
6. **Arquitectura de instalaciones** (§6 de este documento): cómo el
   productor numera las instalaciones de un SaaS que sirve a varios obligados
   y, dentro de un mismo obligado, a varios centros de facturación.

Además debe estar **visible en el propio sistema** y a disposición de los
usuarios (los hoteles) de forma que quede constancia; ehotelOS la enlaza
desde el artículo de ayuda «Cumplimiento español» y desde la pantalla de
readiness fiscal (pendiente del lote readiness).

## 3. Correspondencia declaración ↔ XML ↔ variables de entorno / instalación

| Dato de la declaración | Elemento `SistemaInformatico` (Orden HAC/1177/2024) | Límite XSD | Variable / origen | Valor por defecto |
|---|---|---|---|---|
| Razón social del productor | `NombreRazon` | ≤ 120 | `VERIFACTU_SOFTWARE_NAME` | — (obligatorio) |
| NIF del productor | `NIF` | NIF válido | `VERIFACTU_SOFTWARE_NIF` (checksum validado) | — (obligatorio) |
| Nombre del sistema | `NombreSistemaInformatico` | ≤ 30 | `VERIFACTU_SYSTEM_NAME` | `ehotelOS` (valor declarado: ver §4, punto 7) |
| Código identificador del sistema | `IdSistemaInformatico` | exactamente 2 | `VERIFACTU_SYSTEM_ID` | `01` |
| Versión declarada | `Version` | ≤ 50 | `VERIFACTU_SYSTEM_VERSION` → `APP_VERSION` | `1.0.0` |
| Identificador de la instalación (registro del productor) | `NumeroInstalacion` | ≤ 100 | **`verifactu_installations.numero_instalacion`** de la instalación del centro (o de la sociedad, según la política de cadena). `VERIFACTU_INSTALL_NUMBER` es solo el **fallback en `sandbox`** para un centro sin instalación declarada y el valor que `server.ts` comprueba al arrancar fuera de sandbox. | — (obligatorio: instalación declarada en modos reales) |
| Solo VERI*FACTU (sin modalidad no verificable) | `TipoUsoPosibleSoloVerifactu` | S/N | fijo `S` (ehotelOS no opera sin remisión) | `S` |
| Multi-obligado (SaaS) | `TipoUsoPosibleMultiOT` | S/N | `VERIFACTU_MULTI_OT` | `S` |
| Esta instalación sirve a varios obligados | `IndicadorMultiplesOT` | S/N | `VERIFACTU_MULTI_OT` | `S` |

Reglas de `resolveVerifactuSoftware(env, options)`:

- Una cadena vacía cuenta como **no configurado** (el `.env` de la demo tenía
  `VERIFACTU_SOFTWARE_NIF=` y `??` no lo sustituía: 19 XML con `<NIF></NIF>`).
- Devuelve `{ ok, errors[], software, installationSource }`.
  `installationSource` dice de dónde salió el número: `installation`
  (fila declarada), `env` (`VERIFACTU_INSTALL_NUMBER`) o `default` (relleno
  `DEV-001`, solo sandbox).
- `options.installation`: la instalación declarada del registro. Cuando se
  pasa, su `numeroInstalacion` es el que viaja y el entorno **no se consulta**
  para el número. Con `options.requireInstallation: true` (modos
  `preproduction` / `production`) la ausencia de instalación es un error del
  bloque (`INSTALLATION_NOT_DECLARED`): la fila de `verifactu_submissions`
  queda `retrying` con ese `errorCode` y el backoff de configuración, sin
  consumir `VERIFACTU_MAX_ATTEMPTS`, hasta que el operador dé de alta la
  instalación en Configuración › Estructura societaria › Series y VeriFactu.
  **Nunca** se envía a AEAT un número tomado del entorno en modo real.
- En `sandbox` se envían defaults etiquetados (`PRODUCTOR SIN CONFIGURAR`,
  `B00000000`, `DEV-001` o el `VERIFACTU_INSTALL_NUMBER`) contra el stub; en
  `preproduction` / `production` **no se envía nada** mientras
  `errors.length > 0` (`SOFTWARE_NOT_CONFIGURED` para el bloque del productor,
  `INSTALLATION_NOT_DECLARED` para la instalación).
- API y worker comparten el mismo resolver; cada fila de
  `verifactu_submissions` guarda en `software_json` el bloque exacto con el que
  se construyó el XML (auditoría reproducible), en `mode` el modo de envío y en
  `installation_id` la instalación de la cadena.
- TicketBAI reutiliza NIF, razón social, nombre y versión del mismo resolver
  (`resolveTbaiSoftware(env, { installation })` en `tbai-submission.service.ts`)
  y añade `TBAI_LICENSE_KEY` (≤ 20) y `NumSerieDispositivo` (≤ 30) = número de
  la instalación declarada con `route = tbai`, o `TBAI_DEVICE_SERIAL` /
  `VERIFACTU_INSTALL_NUMBER` como fallback (error en `TBAI_MODE=production`).

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
6. Un cambio de versión **no** cambia ni reinicia ninguna instalación: el
   `NumeroInstalacion` es un identificador de la instalación, no de la versión.
7. **Cambio de `NombreSistemaInformatico` por rebrand (2026-09).** El valor
   por defecto en código pasó de la marca anterior a `ehotelOS`
   (`VERIFACTU_SOFTWARE_DEFAULTS.nombreSistema` en
   `packages/compliance/src/spain/verifactu/software.ts` y el contrato de
   entorno `VERIFACTU_SYSTEM_NAME` en `apps/api/src/lib/env.ts`). El nombre
   del sistema es un dato **declarado** ante la AEAT, no un texto de marca:
   la marca visible (`BRAND.name`) y el SIF se gobiernan por separado a
   propósito, y este punto fija la secuencia para que el cambio de nombre
   entre en vigor solo con una declaración firmada.
   1. *Inmutabilidad.* Los registros ya remitidos conservan su `xml_payload`
      y su `software_json` exactamente como se enviaron (los escribe el
      envío en `apps/api/src/modules/invoicing/verifactu-submission.service.ts`
      y la vista de auditoría de la fila los reproduce): **nunca** se hace
      backfill de un nombre nuevo sobre filas remitidas. El bloque
      `SistemaInformatico` no entra en la huella (`hash.ts`: solo
      `IDEmisorFactura`, `NumSerieFactura`, `FechaExpedicionFactura`,
      `TipoFactura`, `CuotaTotal`, `ImporteTotal`, huella anterior y
      `FechaHoraHusoGenRegistro`) ni en `RegistroAnterior` (`xml.ts`,
      `renderEncadenamiento`): el encadenamiento no se rompe por cambiar el
      nombre.
   2. *Cola pendiente.* Las filas `pending` / `retrying` se reconstruyen en
      cada intento con el bloque vigente (`resolveSoftwareForSend` en
      `verifactu-submission.service.ts`), así que un despliegue con el nombre
      nuevo las remitiría ya con `ehotelOS`. Antes del cambio: drenar la
      cola (ninguna fila en `pending` / `retrying`) o asumir por escrito el
      punto 4 de esta lista para esas filas.
   3. *Versionado y declaración.* Mantener `VERIFACTU_SYSTEM_ID=01` y los
      `NumeroInstalacion` de `verifactu_installations` (un cambio de nombre
      no es un cambio de instalación). Fijar `VERIFACTU_SYSTEM_VERSION` a un
      semver declarable (`1.0.0`, el valor por defecto desde 2026-09; el
      fallback `APP_VERSION` vale `dev` en un despliegue sin versión y no es
      declarable). Firmar la NUEVA declaración responsable con
      `NombreSistemaInformatico = ehotelOS` **antes** del primer registro
      que lo lleve; después comprobar `GET /compliance/health` →
      `verifactu.software.ok` y un envío en `preproduction` con
      `<sum1:NombreSistemaInformatico>ehotelOS</sum1:NombreSistemaInformatico>`
      (`xml.ts`, `renderSistemaInformatico`).
   4. *TicketBAI.* `resolveTbaiSoftware` (`tbai-submission.service.ts`) copia
      `nombreSistema` en `<Software><Nombre>` (`tbai/tbai.ts`): misma
      secuencia ante la diputación foral, y no cambiar el nombre en
      `TBAI_MODE=production` sin confirmar con la diputación que
      `TBAI_LICENSE_KEY` no está ligada al nombre anterior.
   5. *Operación hasta la firma.* En producción se fijan en
      `/etc/anfitorio/api.env` (añadir las líneas si faltan) el nombre y la
      versión que constan en la declaración responsable vigente, los mismos
      que llevan `software_json` y `xml_payload` de los registros ya
      remitidos, de modo que los valores por defecto nuevos del código
      (`ehotelOS` / `1.0.0`, `software.ts` y `env.ts`) no entren en vigor por
      accidente al desplegar:

      ```
      VERIFACTU_SYSTEM_NAME=Anfitorio
      VERIFACTU_SYSTEM_VERSION=0.1.0
      ```

      `Version` se declara por cada versión (§4) y su valor por defecto en
      código pasó de `0.1.0` a `1.0.0` en el mismo despliegue que el nombre:
      sin el segundo pin, cualquier instalación sin `VERIFACTU_SYSTEM_VERSION`
      (ni `APP_VERSION`) emitiría `<sum1:Version>1.0.0</sum1:Version>` sin
      declaración firmada. El paso a paso del VPS está en
      `deploy/README-INSTALL.md` §9 (paso 4). Los dos pines se retiran
      juntos tras la firma de la nueva declaración (`ehotelOS` / `1.0.0`),
      con la cola drenada (punto 2), y se comprueba después con
      `GET /compliance/health` → `verifactu.software`.

Checklist rápida antes de `VERIFACTU_MODE=preproduction`:

- [ ] Declaración responsable firmada para la versión desplegada, con la
      arquitectura de instalaciones de §6.
- [ ] `VERIFACTU_SOFTWARE_NAME`, `VERIFACTU_SOFTWARE_NIF` definidos y
      `resolveVerifactuSoftware().ok === true` (comprobación de arranque de
      `server.ts`; `VERIFACTU_INSTALL_NUMBER` sigue siendo obligatorio fuera
      de sandbox como valor de despliegue, aunque el registro nunca lo use
      cuando existe instalación).
- [ ] Una fila **activa** en `verifactu_installations` por cada centro que
      factura (política `per_center`) o una por sociedad (`per_entity`), con
      el número que consta en el registro de instalaciones del productor.
- [ ] `VERIFACTU_CERT_P12` + `VERIFACTU_CERT_P12_PASSPHRASE` (certificado de
      representante/sello del **obligado** o del colaborador social, para mTLS).
- [ ] NIF válido de la **sociedad** en `LegalEntity.taxId` (readiness fiscal
      en verde; 409 `ISSUER_TAX_ID_MISSING` en caso contrario).
- [ ] Decisión escrita del asesor fiscal sobre la política de cadena (§6.2),
      fijada desde la consola de plataforma **antes** de la primera emisión real.

## 5. Estado técnico del envío real (honesto)

Lo que está implementado en `packages/compliance/src/spain/verifactu/submitter.ts`:

- Sobre SOAP 1.1 (`soapenv:Envelope/Body` con `sum:RegFactuSistemaFacturacion`)
  hacia `SistemaFacturacionWeb` de pre-producción/producción, `SOAPAction: ""`,
  mTLS con PKCS#12 o PEM, timeout de 30 s.
- El cuerpo remitido es el registro **sin firmar** (`transportXml`): en la
  modalidad VERI*FACTU el registro no lleva firma electrónica (art. 12
  RD 1007/2023); la firma XAdES que ehotelOS genera se conserva solo en
  `xml_payload` como pista de auditoría (`VERIFACTU_SIGN_PEM`).
- Parseo de la respuesta (`EstadoEnvio`, `CSV`, `EstadoRegistro`,
  `CodigoErrorRegistro`, `DescripcionErrorRegistro`, `Fault`) sin depender
  del prefijo de namespace; `Correcto` → aceptado, `AceptadoConErrores` /
  `ParcialmenteCorrecto` → aceptado con errores, `Incorrecto` → rechazado.
- Errores de transporte (`NETWORK_*`, HTTP 5xx/429) y de configuración
  (`CERT_NOT_CONFIGURED`, `SOFTWARE_NOT_CONFIGURED`, `INSTALLATION_NOT_DECLARED`)
  se reintentan; solo un código de AEAT o un HTTP 4xx deja la fila en `rejected`.

Pendiente de validar contra el entorno de pre-producción de AEAT (los XSD
oficiales `SuministroLR.xsd`, `SuministroInformacion.xsd` y
`RespuestaSuministro.xsd` no están en el repositorio):

- Nombres exactos de los elementos de respuesta y el prefijo (`tikR`).
- `FacturasRectificadas/IDFacturaRectificada` (tipo `IDFacturaARType`) y
  `IDFactura/*Anulada` en `RegistroAnulacion`.
- Ausencia de `ClaveRegimen` para `Impuesto=02` (IPSI) y valores de L8B para IGIC.
- Longitudes del bloque `SistemaInformatico` (tabla del punto 3).
- La lectura de la AEAT sobre varias instalaciones de un mismo obligado
  servidas por un SaaS centralizado (§6.4): ninguna cadena de producción
  existe todavía.

## 6. Arquitectura SaaS multi-facturación (Tanda 6b · estructura societaria)

ehotelOS es un SIF **multi-obligado** (`TipoUsoPosibleMultiOT = S`,
`IndicadorMultiplesOT = S`): una sola instalación de software sirve a varias
sociedades (tenants) y, dentro de una sociedad, a varios centros de
facturación (hoteles). El modelo es Grupo (`Organization`) → **Sociedad**
(`LegalEntity` = NIF, el obligado) → **Centro de trabajo** (`Property`: el
establecimiento). Diseño: `docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md`
§5.1, §5.2 R2/R3/R7; contrato de datos: `docs/runbooks/finanzas-contabilidad.md` §17.

### 6.1 Qué es una «facturación» y cómo se numera

Cada **facturación** del obligado es una fila de `verifactu_installations`:
`legalEntityId` (la sociedad), `propertyId` (el centro, o `null` si la
instalación es de toda la sociedad), `numeroInstalacion` (≤ 100, asignado por
el productor, **inmutable por trigger** `verifactu_installations_numero_inmutable`
y **nunca reutilizado**: FAQ desarrolladores AEAT §4, «no puede repetirse
nunca»), `route` (`verifactu` · `tbai` · `igic`), `active` y `retiredAt`.
El par (`IdSistemaInformatico`; `NumeroInstalacion`) identifica la
instalación ante la AEAT (Orden HAC/1177/2024 art. 7.c); el NIF del obligado
va aparte (`IDEmisorFactura`).

### 6.2 Política de cadena de la sociedad (`LegalEntity.verifactuChainScope`)

| Política | Cardinalidad | Lectura de la FAQ AEAT | Cuándo |
|---|---|---|---|
| `per_center` (defecto) | **una instalación por centro** que factura: cada hotel es un «centro de facturación independiente» con su propia cadena de huellas | FAQ desarrolladores §4 (varios centros de facturación de un mismo obligado = varias instalaciones) | Comportamiento actual de la demo (Rías Altas `DEV-001`, Los Tilos al activar) |
| `per_entity` | **una instalación por sociedad**: los registros de todos sus hoteles forman una única cadena | Lectura estricta de «ERP centralizado» (un SIF, un obligado, una cadena) | Solo si el asesor fiscal de la sociedad lo decide por escrito |

La política se fija **desde la consola de plataforma** por sociedad
(`POST /admin/legal-entities/:id/verifactu-scope`, L2; `accounting.configure` +
confirmación de alto riesgo) y solo mientras no hay registros enviados (409
`CHAIN_ALREADY_STARTED`). Consta en la declaración responsable del productor
(este §6) y **no se expone** como control general al hotelero.
**Cambiar de ámbito nunca re-encadena**: la instalación anterior se retira
(`active = false`, `retiredAt`) y se abre otra con número nuevo; sus registros
siguen enlazados a la instalación retirada y la nueva empieza con
`PrimerRegistro = S`.

### 6.3 Qué hace el código con la instalación (L3)

- **Ámbito de cadena** (`resolveVerifactuChainScope`,
  `apps/api/src/modules/invoicing/issuer-identity.service.ts`): propiedad →
  política de su sociedad → instalación activa (del centro con `per_center`,
  de la sociedad con `per_entity`) → clave del `pg_advisory_xact_lock`
  (`installation:<id>`; `entity:<id>` para una sociedad `per_entity` sin
  instalación; el `propertyId` histórico para un centro sin instalación) y
  filtro de registros de la cadena (los enlazados a la instalación más los del
  centro anteriores a cualquier instalación; los de una instalación retirada
  quedan fuera).
- **Emisión / rectificación / anulación** (`invoice.service.ts`,
  `verifactu-submission.service.ts`): bajo ese lock, `RegistroAnterior` es el
  último registro (alta o anulación) **de esa instalación**; el registro se
  vincula a la sociedad y a la instalación (`Invoice.legalEntityId`,
  `Invoice.installationId`, `VerifactuSubmission.installationId`); los
  registros del centro anteriores a la instalación se enlazan a ella al primer
  uso (relleno `NULL → valor`, idempotente). La cadena **no se reinicia** por
  año ni por serie.
- **Bloque `SistemaInformatico`**: `NumeroInstalacion` = número de la
  instalación de la cadena; el entorno solo en sandbox sin instalación (§3).
  `ObligadoEmision/NombreRazon` y `NombreRazonEmisor` = razón social de la
  sociedad; `IDEmisorFactura` = su NIF (snapshot de la factura, inmutable).
- **Series** (RD 1619/2012 6.1.a): cada centro tiene sus series; el prefijo por
  defecto es `<serie>-<año>-` cuando la sociedad tiene un solo centro que
  factura y `<serie>-<código de centro>-<año>-` cuando tiene varios
  (`FAC-RA-2026-`, `FAC-LT-2026-`), de modo que el par NIF + serie + número es
  único por obligado. Abrir una serie cuyo prefijo ya usa otro centro activo de
  la misma sociedad responde 409 `SERIES_PREFIX_CLASH`; emitir un número que ya
  existe bajo el mismo NIF, 409 `INVOICE_NUMBER_DUPLICATE`. Una serie emitida
  **nunca se renumera**: se cierra y se abre otra.
- **Concurrencia entre centros del mismo NIF** (corrección t6b#1): el lock de
  cadena es por instalación / centro, así que la apertura de una serie toma
  además `pg_advisory_xact_lock(hashtext('series-open:<sociedad>:<año>'))`
  (`lockSeriesOpening`, exportado para `patchBillingSettings`) y la
  comprobación del número bajo el NIF toma
  `pg_advisory_xact_lock(hashtext('invoice-number:<sociedad>:<número>'))`
  antes de leer a las hermanas: dos centros que compartan un prefijo heredado
  (`org_123`: `FAC-2026-` en dos propiedades) no pueden emitir el mismo número
  a la vez — el segundo ve la fila confirmada del primero y recibe 409. Un
  centro **sin código** en una sociedad con varios centros que facturan no abre
  serie alguna (409 `WORK_CENTER_CODE_REQUIRED`: nunca cae al prefijo plano
  `FAC-<año>-`), y una serie **cerrada** (`active = false`) no vuelve a numerar
  (409 `SERIES_CLOSED`). Los índices únicos `(legal_entity_id, upper(prefix),
  year)` y `(legal_entity_id, invoice_number)` siguen aplazados a L8 (cabecera
  de la migración `20260916101000`): estos locks son la red hasta entonces.
- **Un emisor por serie** (RD 1619/2012 6.1.a; corrección t6b#11): la regla se
  aplica sobre el **prefijo impreso** (`FAC-RA-2026-`), no sobre
  `<serie>-…-<año>-`, de modo que la serie que se abre con otro prefijo tras un
  cambio de NIF no queda bloqueada por las facturas de la serie antigua. El 409
  `ISSUER_TAX_ID_SERIES_MISMATCH` explica los dos caminos reales: NIF anterior
  erróneo → rectificativas (art. 15) y revisión en «Configuración › Estructura
  societaria › Datos fiscales»; cambio real de emisor → cerrar la serie y abrir
  la del nuevo emisor con otro prefijo en «… › Series y VeriFactu».
  `findSeriesBlockedByTaxIdChange` lista las series que quedarán bloqueadas
  para que el PATCH del NIF (L2) lo avise en su propio 200.
- **Sociedad acogida al SII** (RD 1007/2023 art. 3.3; RIVA 62.6; diseño R7/R8;
  corrección t6b#2): `LegalEntity.siiEnabled` la deja **fuera del RRSIF**. Sus
  facturas (completas, simplificadas y rectificativas) se expiden **sin
  huella, sin `RegistroAnterior`, sin QR tributario ni leyenda VERI*FACTU y sin
  instalación**; el aviso tipado `VERIFACTU_EXCLUDED_BY_SII: …` queda en
  `Invoice.warningsJson`, la exclusión se congela en el snapshot del documento
  (`verifactuExclusion`) y el PDF imprime el motivo en lugar del bloque QR. No
  se encola ni se envía ningún registro; un registro con huella anterior al
  cambio de régimen se retira como `abandoned` con `errorCode
  VERIFACTU_EXCLUDED_BY_SII` (envío en vivo, barrido y reconciliación) y su
  reintento manual responde 409 con ese código, en todos los modos. La
  anulación de un documento sin registro no genera `RegistroAnulacion`. El
  envío de los libros al SII **no está construido** y se declara en la interfaz.

### 6.4 Lo que se declara y lo que queda pendiente del asesor

El productor declara que: (a) cada centro de facturación de un obligado es una
instalación declarada, inmutable y nunca reutilizada; (b) la instalación sirve
a varios obligados (`IndicadorMultiplesOT = S`) y a varios centros del mismo
obligado, cada uno con su cadena, o a la sociedad completa con una sola
cadena, según la política fijada por el obligado; (c) el número de instalación
nunca procede de una variable de entorno en modos reales. Queda pendiente de
la AEAT (pre-producción) y del asesor fiscal de cada sociedad la lectura
definitiva de «varias instalaciones de un mismo obligado en un SaaS
centralizado»; hasta esa decisión escrita ninguna cadena de producción se
abre (plazos RD 1007/2023 / RDL 15/2025: 1-1-2027 y 1-7-2027).
