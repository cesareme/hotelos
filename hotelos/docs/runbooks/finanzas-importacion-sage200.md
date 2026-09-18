# Runbook · Importación contable desde Sage 200 (Tanda 7c · `sage200:import`)

Fuente: diseño [`docs/design/FINANZAS-IMPORTACION-SAGE200.md`](../design/FINANZAS-IMPORTACION-SAGE200.md)
(§1 resumen y alternativas descartadas, §2 qué exporta Sage 200 y por qué vía, §3 puntos de
entrada del motor contable, §4 modelo de importación —lotes, datos, formatos, mapa de cuentas,
mapa analítico, idempotencia—, §5 modo sombra contable y reconciliación, §6 saldos sin diario,
§7 API / CLI / front, §8 lotes, §9 demo y necesidades, §10 riesgos, huecos y **§10.4
correcciones tras el recon y el plan de lotes**). Rutas, permisos y límites:
[`docs/api-contracts.md`](../api-contracts.md) (bloque «Importación contable desde Sage 200
(Tanda 7c)»). Código: modelo en `packages/database/prisma/schema.prisma` (bloque «Importación
contable desde Sage 200», tablas `ledger_imports`, `ledger_import_entries`,
`ledger_import_balances`, `ledger_account_maps`, `ledger_analytics_maps`, `ledger_third_parties`,
`ledger_reconciliations`; migración `20260917110000_sage200_importacion`), contrato wire
`packages/shared/src/ledger-import-types.ts` (catálogos, límites, códigos de error y DTOs),
parsers y mapas `apps/api/src/modules/accounting/import/{sage200.parser, sage200.xml,
ledger-import.mapping, ledger-import.posting, ledger-import.canonical}.ts`, servicios
`apps/api/src/modules/accounting/import/{ledger-import.service, ledger-reconciliation.service}.ts`,
rutas y manifiesto `apps/api/src/modules/accounting/{ledger-import.routes,
ledger-import-route-permissions.partial}.ts`, esquemas `apps/api/src/schemas/ledger-import.schemas.ts`,
CLI `apps/api/src/scripts/import-sage200.ts` (script pnpm `sage200:import`), pestaña «Importar
desde Sage 200» en Finanzas › Contabilidad (`apps/admin-web/src/screens/accounting/
Sage200ImportScreen.tsx`, ruta `/finanzas/contabilidad/importar-sage200`). Este runbook
sustituye a §7.3 y §9 del diseño como documento operativo; la sección §19 de
[`finanzas-contabilidad.md`](finanzas-contabilidad.md) resume el modelo y enlaza aquí.

Estado 2026-09-17: runbook escrito en paralelo con L1 (parsers y mapas), L2 (servicios y
reconciliación), L3 (rutas, CLI y contratos API) y L4 (front), a partir del diseño, del contrato
wire de L0 y de las correcciones de §10.4. Los nombres de rutas, los flags del CLI y los códigos
de error son los que fija el plan de la Tanda 7c y los que el integrador (L6) cruza por `grep`
con el código: si un nombre difiere, manda el código y hay que corregir aquí. **Todos los datos
son ficticios**: empresa Sage `1` «CELUISMA DEMO S.A.» con NIF ficticio `A00000000`, terceros
`B00000042` / `B00000077`, delegaciones `AS FN LL LT MC OC PG RA`, organización de Faranda
`cmrhw9jy30002fyvb6tsdiugt` (BD local), cuentas Sage de 7 y 10 dígitos inventadas.

## 1 · Qué pedir a administración (diseño §9)

### 1.1 · Las siete necesidades

| # | Qué pedir | Para qué | Sin ello |
| --- | --- | --- | --- |
| 1 | **Exportaciones reales de ejemplo** de un mismo mes (§1.2): Diario, Sumas y saldos nivel 0, Plan de cuentas, Libro Registro de IVA del trimestre y, si es posible, el XML «Datos contables» | Fijar los sinónimos de cabecera del formato `sage_excel` y escribir el parser XML: Sage no documenta las columnas de sus Excel | El formato de contrato es el CSV IME de 60 columnas (§2.3) o el canónico (§2.4); la primera exportación real puede fallar en la preview con `LEDGER_IMPORT_INVALID` (cabecera obligatoria ausente) |
| 2 | **Versión y edición de Sage 200** (Ayuda › Acerca de; 15.xx ≡ 2020.xx), Standard / Advanced, on-premise u hosting | Saber si existen «Importación en Excel», Scheduler y acceso SQL | Solo la vía Excel / CSV manual (cadencia mensual) |
| 3 | **Analítica**: si la usan, qué dimensión identifica el hotel (Delegación, Canal, Departamento…), los códigos de cada hotel y de la oficina, y si numeran asientos por canal / delegación | Mapa analítico (§4.2) y clave de idempotencia (el canal entra en la clave solo si numeran por canal) | Política `block`: todo apunte 6/7 sin centro bloquea el lote |
| 4 | **Longitud de cuenta** de la empresa y convención de subcuentas (IVA por tipo, clientes / proveedores) | Reglas 2-6 del mapa de cuentas (§4.1) y la decisión sobre subcuentas por tercero | El mapeador propone; las cuentas sin regla quedan `block` hasta que alguien decida |
| 5 | **Acceso SQL de solo lectura** (login propio `db_datareader`, nunca `logic`) o un partner que produzca la vista CSV IME | Cadencia diaria y diario completo con IVA y factura en una sola pasada | Solo mensual, con los Excel de §1.2 |
| 6 | **Ejercicios a cargar**: cuáles con diario completo y cuáles solo con saldos (§3); fecha de corte del relevo | Plan de lotes y `fiscal_years` | — |
| 7 | **Decisiones abiertas** de `finanzas-contabilidad.md` §15 / §17.13: `pgc_variant` pymes vs general, régimen y periodicidad de IVA (`VatSettings`, hoy sin fila), SII, y qué hacer con las 25 facturas sandbox de RA y sus asientos | Comparativos y 303 correctos; regla de exclusión de nativos (§5) | El lote `vat_books` responde 409 `LEDGER_IMPORT_VAT_SETTINGS_MISSING` (§9) |

### 1.2 · Instrucción exacta por listado de Sage 200 (formato real confirmado 2026-09-18 con la primera exportación de Sage 200 2026.85.000)

| Listado | En Sage 200 | Opciones que hay que marcar | Lote ehotelOS |
| --- | --- | --- | --- |
| **Diario** de un mes | Contabilidad › Consultas y listados › Diario | Límites de fechas = el mes; «Totalizar por asiento»; **«Desglose analítico»** (canal, delegación, departamento, sección y proyecto por apunte); **«Enviar a Excel»** (no «formato libros», que omite columnas). Un fichero por mes | `journal` (`sage_excel`) |
| **Sumas y saldos nivel 0** del mismo mes | Contabilidad › Consultas y listados › Sumas y saldos | **«Nivel 0»** (cuentas detalladas); columnas «Debe / Haber / Saldo» (o «Debe / Haber / Deudor / Acreedor»); **«Comparativo periodo acumulado»** (apertura + periodo + acumulado por cuenta); «Solo cuentas con saldo» **desmarcado**; **«Hoja adicional canales/delegaciones»** marcada — es el hueco 7 del diseño §10.3: sin esa hoja no hay reconciliación por centro, solo el consolidado de sociedad | reconciliación (§6) y `balances` |
| **Plan de cuentas** | Contabilidad › Ficheros › Plan de cuentas (mantenimiento en lista) › **Gestor de Exportación a Excel** | Columnas Cuenta, Título / Descripción, **NIF / CIF**, País, longitud / nivel (columnas configurables: elegir estas) | `plan` |
| **Libro Registro de IVA** del trimestre | Contabilidad › IVA › Libro Registro de IVA | «Enviar a Excel» → **«Formato Libros AEAT»** (hojas `EXPEDIDAS_INGRESOS` y `RECIBIDAS_GASTOS`, cabeceras en las filas 7-8 como el `LSIJ.xlsx` de la AEAT) | `vat_books` |
| **Clientes y Proveedores** | Mantenimientos de Clientes y de Proveedores (en lista) › Gestor de Exportación a Excel | Código, **Código contable**, NIF / CIF, CIF europeo, Razón social, Sigla nación | `third_parties` |
| **Opcional: XML «Datos contables»** de un mes | Inicio › Importación / Exportación › Datos contables › Exportar formato XML | Bloques Plan de cuentas, Clientes / Proveedores, Movimientos, Movimientos analítica, Mov. Facturas / IVA; filtro por ejercicio y fechas; genera `Temporal.zip` | ninguno todavía: responde 400 `LEDGER_IMPORT_XML_UNSUPPORTED { blocks }` (§9); sirve para escribir el parser |

**Lo que llegó realmente (formato real confirmado 2026-09-18, Sage 200 2026.85.000, on-premise; sin
acceso SQL ni Scheduler):**

| Listado | Cómo lo exportó administración | Diferencia con la instrucción de arriba | Entra por |
| --- | --- | --- | --- |
| Diario | «Diario General» con «Enviar a Excel», un fichero por mes en 2025 y por mes o **quincena** en 2026 (los meses grandes superan el tope de 5 MiB del lector, §2.1) | La cabecera está en la fila 6 (filas 1-3 con NIF, ejercicio y empresa); `Cuenta` es el **título** y `Código cuenta` el código; trae un segundo par Debe / Haber de totales de página; la columna `Ejercicio` es la del ejercicio abierto al exportar, no la del asiento; sin analítica más allá de `Cód. delegación` / `Cód. departamento` (no usan canal, sección ni proyecto) | canónico `journal` / `fiscal_years` tras el preprocesado de §2.2 |
| Sumas y saldos | «Balance sumas y saldos» mensual (`AperturaP`, `DebeP`, `HaberP`, `SaldoP`) y anual (`…A`), a nivel de subcuenta | Los mensuales traen **solo el movimiento del mes** (sin acumulado) y **no hay hoja por delegaciones**: la comparación por centro se hace por SQL sobre las Σ 6/7 por delegación del propio diario | canónico `balances` (§6) |
| Plan de cuentas | Gestor de Exportación a Excel (`PlanCuentas…`, `PlanCuentasListado… completo`) y **rowset ADO XML** `PlanCuentasPGC…` | El gestor **no exporta el NIF** de los terceros aunque se pida la columna: el NIF se toma del rowset de Clientes / Proveedores por `CodigoCuenta` | canónico `plan` |
| Libro Registro de IVA | «Formato Libros AEAT», hoja `EXPEDIDAS` / `RECIBIDAS`; **emitidas por meses** (el libro anual daba error por tamaño) y recibidas por trimestres | Cabecera en dos filas (grupos / columnas), `Identificación` = NIF, `(Serie-Número)` = número en recibidas, importes vacíos en facturas a cero, fechas como texto | canónico `vat_books` |
| Clientes y Proveedores | **rowset ADO XML** `CliPro…` (no Excel) | Trae campos de empleado y datos personales: se filtra por cuenta (40x / 41x / 43x / 44x) y solo se exportan código, cuenta, NIF, país y razón social | canónico `third_parties` |
| Maestros de analítica | rowsets ADO XML `Delegaciones…` y `Departamentos…` | Las delegaciones no llevan nombre útil: la tabla delegación → hotel se deriva del diario (sexta cifra de la cuenta y títulos de subcuenta); los departamentos son los de nóminas (RR. HH.) | mapa analítico (§4.2) |
| XML «Datos contables» | no se pidió: los rowsets ADO cubren plan, terceros y maestros | — | — |

## 2 · Formatos aceptados y cabeceras (diseño §4.3)

### 2.1 · Detección y límites

`format` se toma del cuerpo o del flag `--format`; si falta, por este orden: extensión de
`fileName` (`.xlsx` → `sage_excel`; `.xml` / `.zip` → `sage_xml`; `.json` → `canonical_json`),
firma (`PK` = XLSX o ZIP, `<?xml`), cabecera (⊇ las 7 columnas obligatorias del IME →
`sage_ime_csv`; cabecera canónica → `canonical_csv`; si no, `sage_excel`). Sin coincidencia →
400 `LEDGER_IMPORT_FORMAT_UNKNOWN`. CSV: separador `;`, `,` o tabulador autodetectado, UTF-8 o
Windows-1252 con o sin BOM; decimales con coma o punto; fechas `YYYY-MM-DD` o `DD/MM/YYYY`. XLSX
leído sin dependencias (`lib/xlsx-lite.ts`, `readXlsxTable`); `sheetName` elige la hoja (por
defecto la primera no oculta).

Límites (`packages/shared/src/ledger-import-types.ts`): fichero ≤ **20 MiB**
(`LEDGER_IMPORT_MAX_BYTES` → 400 `LEDGER_IMPORT_TOO_LARGE { bytes, max }`), `contentBase64` ≤
**28 MiB** de caracteres (`LEDGER_IMPORT_MAX_BASE64_CHARS`; las rutas de carga fijan `bodyLimit`
30 MiB: por encima, 413 de Fastify), ≤ **250.000 filas** (`LEDGER_IMPORT_TOO_MANY_ROWS`), ≤
**20.000 asientos por lote** (`LEDGER_IMPORT_TOO_MANY_ENTRIES`: trocear por meses), ≤ **5.000
líneas por asiento** en los lotes `journal` / `fiscal_years` (formato real confirmado 2026-09-18:
las aperturas / cierres de Sage 200 traen miles de líneas; `LEDGER_IMPORT_MAX_LINES_PER_ENTRY_SAGE`
en `ledger-import.service.ts`; **500** sigue siendo el valor por defecto de la función pura
`buildJournalEntries` —`LEDGER_IMPORT_MAX_LINES_PER_ENTRY` de `packages/shared`—, que el servicio
sustituye con `ctx.maxLinesPerEntry`), transacción `maxWait` 15 s / `timeout` **600 s**
bajo `pg_advisory_xact_lock('ledger_import:<organizationId>')`. Ficheros mayores → CLI (§7).

Tope **efectivo** del lector, por debajo de los 20 MiB del lote: `parseXlsxTable` / `parseCsvTable`
(lector del importador de reservas, reutilizado por `sage_excel` y por el canónico) rechazan XLSX /
CSV de más de **5 MiB** (`RESERVATION_IMPORT_MAX_BYTES`, `RESERVATION_IMPORT_TOO_LARGE`) y `xlsx-lite`
limita cada parte descomprimida a **32 MiB** (`XLSX_LITE_MAX_PART_BYTES`): los diarios reales grandes
entran por **CSV canónico troceado por número de asiento** (nunca por fecha: un asiento entero va
siempre en la misma parte).

### 2.2 · `sage_excel` (Excel o CSV de un listado de Sage): cabeceras por sinónimo [S]

El lector busca por **cabecera plegada** (minúsculas, sin acentos ni espacios), nunca por
posición; cabecera desconocida → aviso en `warnings`, cabecera obligatoria ausente → 400
`LEDGER_IMPORT_INVALID { errors: [{ line, message }] }`. Sinónimos hoy reconocidos (toda la
tabla es [S] hasta la necesidad 1):

| Campo canónico | Sinónimos de cabecera Sage | Obligatorio en |
| --- | --- | --- |
| `asiento` | Asiento, Nº asiento, Número asiento | diario |
| `fecha` | Fecha, Fecha asiento, FechaAsiento | diario |
| `cuenta` | Cuenta, Código cuenta, CodigoCuenta, Subcuenta | diario, saldos, plan |
| `contrapartida` | Contrapartida | — |
| `concepto` | Concepto, Comentario, Descripción | — |
| `debe` / `haber` | Debe / Haber; **o** `Cargo/Abono` (D / H, también d / h) + `Importe` / ImporteAsiento | diario (una de las dos formas) |
| `documento` | Documento, DocumentoConta, Nº documento | — |
| `canal` · `delegacion` · `departamento` · `seccion` · `proyecto` | Canal / CodigoCanal · Delegación / IdDelegacion · Departamento / CodigoDepartamento · Sección / CodigoSeccion · Proyecto / CodigoProyecto | — (analítica) |
| `periodo` · `ejercicio` · `empresa` | Periodo / NumeroPeriodo · Ejercicio · Empresa / CodigoEmpresa | — (si faltan: periodo por la fecha, ejercicio por el año, empresa `1`) |
| `serie` · `factura` · `fecha_factura` · `nif` · `nombre` | Serie · Factura / Nº factura / SuFacturaNo · Fecha factura · NIF / CIF / CifDni · Nombre / Razón social | — (bloque factura, exclusión de nativos §5) |
| `base_iva` · `tipo_iva` · `cuota_iva` | Base / BaseIva · % IVA / PorIva / Tipo · Cuota / CuotaIva | — (regla 5 del mapa) |
| saldos: `titulo`, `apertura_debe` / `apertura_haber`, `debe`, `haber`, `saldo_deudor` / `saldo_acreedor` | Título / Descripción; Saldo apertura, Sumas anteriores (D / H); Debe; Haber; Saldo, Deudor, Acreedor | saldos y reconciliación |
| plan: `cuenta`, `titulo`, `nif`, `pais`, `longitud` | Cuenta / Código; Título / Descripción; NIF / CIF; País / Sigla nación; Longitud / Nivel | plan |
| terceros: `codigo`, `cuenta`, `nif`, `pais`, `nombre` | CodigoCliente / CodigoProveedor / Código; CodigoContable / Cuenta; CifDni / NIF; SiglaNacion / País; RazonSocial / Nombre | terceros |

**Formato real confirmado (2026-09-18, Sage 200 2026.85.000, «Enviar a Excel» de los listados):**

- **Diario general**: filas 1-3 con NIF / ejercicio / empresa, cabecera en la fila 6 (42 columnas):
  `Fecha` (texto `DD/MM/YYYY`), `Número de asiento`, `Tipo documento`, `Cód. diario`, `Documento`,
  `Fecha grabación`, `Comentario`, **`Cuenta` = título de la subcuenta y `Código cuenta` = código**
  (tomar siempre `Código cuenta`, nunca `Cuenta`), primer par `Debe` / `Haber` = importes del apunte y
  **segundo par `Debe` / `Haber` = totales de página** (ignorar), `Ejercicio` (el del listado, no el
  del asiento), `Número periodo` (0 apertura, 1-12, 98 regularización, 99 cierre), `Período`
  («Apertura», «Cierre Ejer.», «Cierre Conta»), `Cód. delegación`, `Cód. departamento`, `Serie
  factura`, `Número de factura` (0 sin factura), `Fecha asiento`. Hay importes negativos (Sage no
  cambia de lado) y apuntes a 0.
- **Sumas y saldos**: cabecera en la fila 6: `Cuenta`, `Descripción`, `AperturaP `, `DebeP `,
  `HaberP `, `SaldoP ` (**con espacio final**) y, en los anuales, `AperturaA`, `DebeA`, `HaberA`,
  `SaldoA`; 3 filas de totales con `Cuenta` = `*`; los mensuales llevan **solo los movimientos del
  periodo** (no acumulados) y Sage suma **con signo** (saldo deudor positivo, acreedor negativo).
- **Libros de IVA**: hoja `EXPEDIDAS` / `RECIBIDAS`, fila 1 grupos y fila 2 columnas;
  `Identificación` = NIF, `(Serie-Número)` = número, `Cuota IVA Soportado`, `Tipo Retención del
  IRPF`, `Importe Retenido del IRPF`; rectificativas como `F1` con importes negativos; fechas como
  texto `dd/mm/yyyy`.

Los sinónimos de la tabla anterior **no** cubren todavía `Número de asiento`, `Código cuenta` frente
a `Cuenta`-título, las columnas `…P ` ni `Identificación` / `(Serie-Número)`: los ficheros reales
entran por el **canónico** (§2.4) tras un preprocesado fuera del repo; ampliar los sinónimos es
opcional y cada sinónimo nuevo lleva su test con datos inventados.

**Preprocesado canónico de la carga real (2026-09-18, scripts fuera del repo en
`pilots/<empresa>/sage200-real/prep/tools/`; reglas confirmadas con los ficheros reales):**

- **Diario → `journal` / `fiscal_years`**: `ejercicio` = año de la `Fecha` (la columna `Ejercicio`
  del listado es la del ejercicio abierto al exportar: los meses de 2025 exportados en 2026 dicen
  2026 y el canónico los rechazaría como «fecha fuera del ejercicio»); `periodo` = `Número periodo`
  (`normalizeSagePeriod` acepta 0-12, 13-15 y los reales **98** = regularización / **99** = cierre,
  y los textos «Cierre Ejer.» / «Cierre Conta»); los apuntes a 0,00 en Debe y Haber **se descartan**
  antes (el canónico rechaza «apunte sin importe») y se cuentan; los importes negativos se dejan tal
  cual (el importador los pasa al lado contrario, ver §6); la apertura del ejercicio va SOLO en el lote
  `fiscal_years` (el diario de enero repite el asiento de apertura como periodo 0: se excluye) y se
  selecciona **por periodo 0**, nunca por número de asiento (en 2026 la apertura era el 69090); la
  regularización y el cierre se cargan **dentro del diario de diciembre** (periodos 98 / 99 al final
  de la última parte, para que el lote que cierra el ejercicio sea el último) y nunca además desde
  los ficheros «ASIENTO REGULARIZACION / CIERRE» sueltos; en 2026 Sage reutiliza números de asiento
  dentro del mismo periodo con fechas distintas: se renumeran `<asiento>-<MMDD>` (`--numbering
  delegacion` no los separa todos); partes ≤ 4,7 MB troceadas por asiento (tope de 5 MiB
  del lector); `nombre` solo en 40x/41x/43x/44x (título de la subcuenta, enmascarado) y vacío en el
  resto; comentarios y títulos enmascarados por diccionario de nombres de empleados (465/460/555 del
  plan + CliPro) y por bigrama de apellidos en las cuentas de personal.
- **Plan → `plan`**: cuentas de 10 cifras (`PPP AA H SSSS`, sexta cifra = hotel); NIF desde CliPro
  por `CodigoCuenta` (el plan de Sage no lo exporta); mapa explícito (regla 1) para todo lo que no es
  tercero (regla 4): `map` a la cuenta postable más larga que sea prefijo (4 cifras solo de una lista
  cerrada, si no 3) o `create` de la cuenta PGC de 3 cifras que falte (una fila sintética por prefijo
  con el nombre PGC y USALI explícito en 6/7); 472/477 por el **código de tipo** de las dos últimas
  cifras (01 = 4 %, 11 = 10 %, 12/13/17 = 21 %, 10/14 = ISP/AIB 21 %, 20 = importación; 2 %, 5 %,
  7,5 % y exentos → 472 / 477 genéricas, listadas).
- **Libros AEAT → `vat_books`** (el lector AEAT no reconoce `(Serie-Número)`, `Cuota IVA Soportado`
  ni `Identificación`): `numero` = `Número` (expedidas) o `(Serie-Número)` (recibidas; si falta,
  `REC-<Número Recepción>`), `nif` = `Identificación`, base / cuota / total vacíos → `0,00`, fecha
  de expedición inválida → `Fecha Operación`, abonos `F1` con base negativa → `rectificativa = si`.
- **Delegaciones / Departamentos (rowsets ADO) → mapa analítico**: sin nombres útiles en las delegaciones; la
  tabla delegación → hotel se deriva del diario (sexta cifra dominante de las líneas 6/7 y títulos de subcuenta) y
  se pasa en `mapping.json` (`analytics.entries`); departamento → centro de coste USALI solo en 64x.
- **CliPro → `third_parties`**: solo 400/401/410/411 (proveedor) y 430/431/435/436/440/441 (cliente),
  sin las filas de cuentas 465/460 (empleados) y sin los campos de persona; `(rol, código)` único
  (sufijo `~2`, `~3`… si Sage repite el código).
- **Sumas y saldos → `balances` para reconciliar**: ver §6 (negativos trasladados y saldo acumulado).

### 2.3 · `sage_ime_csv` (formato de importación de asientos de Sage, 60 columnas)

Es el contrato **estable** (una vista SQL sobre `Movimientos` + `MovimientosFacturas` +
`MovimientosIva` + analítica, o el fichero que produzca el partner). Se detecta cuando la
cabecera contiene al menos `CodigoEmpresa`, `Ejercicio`, `Asiento`, `CargoAbono`,
`CodigoCuenta`, `FechaAsiento` e `ImporteAsiento`. Las 60 columnas:

```
CodigoEmpresa; Ejercicio; Asiento; CargoAbono; CodigoCuenta; Contrapartida; FechaAsiento;
DocumentoConta; Comentario; ImporteAsiento; CodigoDiario; CodigoCanal; CodigoDepartamento;
CodigoSeccion; CodigoProyecto; IdDelegacion; FechaVencimiento; NumeroPeriodo; TipoCarteraIME;
TipoAnaliticaIME; TipoImportacionIME; BaseIva1..3; CodigoIva1..3; PorIva1..3; CuotaIva1..3;
PorRecargoEquivalencia1..3; RecargoEquivalencia1..3; CodigoTransaccion1..3; Serie; Factura;
SuFacturaNo; FechaFactura; ImporteFactura; TipoFactura; CifDni; Nombre; CodigoRetencion;
BaseRetencion; PorRetencion; ImporteRetencion; CodigoTerritorio; SiglaNacion; EjercicioFactura;
Exclusion347; Previsiones; MantenerAsiento
```

`CargoAbono` D / H (también d / h); `NumeroPeriodo 0` = apertura [S]; los tres bloques de IVA
(`BaseIvaN` / `PorIvaN` / `CuotaIvaN`) alimentan la regla 5 del mapa (472 / 477 por tipo) y el
lote `vat_books`; `Serie` + `Factura` (o `SuFacturaNo`) es la clave de exclusión de nativos (§5).

### 2.4 · Formatos canónicos (`canonical_csv` / `canonical_json`): plantillas y ejemplos

Plantillas descargables: `GET /accounting/ledger-imports/template?kind=<tipo>&format=csv` o
`sage200:import -- --template <tipo> --out <ruta.csv>` (BOM UTF-8, separador `;`, CRLF, una fila
de ejemplo ficticia). Cabeceras **literales** (diseño §4.3):

| Tipo | Cabecera canónica |
| --- | --- |
| `journal` (y `fiscal_years`: las filas de apertura, `periodo` 0) | `empresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber;concepto;documento;canal;delegacion;departamento;seccion;proyecto;serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura` |
| `balances` | `empresa;ejercicio;periodo;cuenta;titulo;delegacion;apertura_debe;apertura_haber;debe;haber;saldo_deudor;saldo_acreedor` |
| `plan` | `cuenta;titulo;nif;pais;longitud` |
| `third_parties` | `codigo;rol;cuenta;nif;pais;nombre` (`rol` = `cliente` / `proveedor`) |
| `vat_books` | mismas columnas del `journal` con el bloque factura (`serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura` E / R) o las hojas AEAT de §2.5 |
| analítica (maestros, opcional dentro del mapa analítico) | `dimension;codigo;nombre` |

Ejemplo de diario canónico (un asiento de gasto en RA con IVA soportado y proveedor ficticio):

```
empresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber;concepto;documento;canal;delegacion;departamento;seccion;proyecto;serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura
1;2026;1501;2026-09-03;9;6280001;250,00;;Electricidad septiembre;F-778;;RA;MANT;;;;;;;;;;;
1;2026;1501;2026-09-03;9;4720021;52,50;;IVA soportado 21 %;F-778;;RA;;;;;;;;;250,00;21;52,50;R
1;2026;1501;2026-09-03;9;4000000042;;302,50;SUMINISTROS DEMO SL;F-778;;RA;;;;;F-778;2026-09-03;B00000042;SUMINISTROS DEMO SL;;;;
```

Ejemplo de saldos canónicos (nivel 0, un mes, con delegación) y de plan / terceros:

```
empresa;ejercicio;periodo;cuenta;titulo;delegacion;apertura_debe;apertura_haber;debe;haber;saldo_deudor;saldo_acreedor
1;2026;9;6280001;Suministros electricidad;RA;0,00;0,00;250,00;0,00;250,00;0,00
1;2026;9;4720021;IVA soportado 21 %;;0,00;0,00;52,50;0,00;52,50;0,00
1;2026;9;4000000042;SUMINISTROS DEMO SL;;0,00;0,00;0,00;302,50;0,00;302,50

cuenta;titulo;nif;pais;longitud
6280001;Suministros electricidad;;ES;7
4000000042;SUMINISTROS DEMO SL;B00000042;ES;10

codigo;rol;cuenta;nif;pais;nombre
42;proveedor;4000000042;B00000042;ES;SUMINISTROS DEMO SL
77;cliente;4300000077;B00000077;ES;AGENCIA VIAJES DEMO SL
```

`canonical_json`: `{ "system": "sage200", "company": "1", "kind": "journal", "rows": [ { …misma
clave por columna… } ] }`.

### 2.5 · Libro Registro de IVA «Formato Libros AEAT»

Hojas `EXPEDIDAS_INGRESOS` y `RECIBIDAS_GASTOS` con las cabeceras del `LSIJ.xlsx` de la AEAT
(fila 7 los grupos, fila 8 las columnas: fecha de expedición / operación, serie, número, NIF y
nombre del destinatario / expedidor, clave de operación, base, tipo, cuota, recargo, total,
deducible…). El lector usa `readXlsxTable` y localiza la **cabecera por contenido** (la primera
fila que contiene `Serie` y `Número`), no por número de fila; importes `Decimal(12,2)`; fechas
`dd/mm/yyyy`. Cada fila produce una `VatBookEntry` `sourceType sage200` con `sourceId
<empresa>:<ejercicio factura>:<serie>:<factura>[:<NIF>][:R]` (en **recibidas** el número es el
del proveedor —dos proveedores numeran «1», «2»… a la vez— y la clave lleva su NIF; en emitidas
la serie + número propios ya son únicos), `period` recalculado con `periodCodeForDate` según la
periodicidad de `vat_settings` (nunca se toma del Excel) y `counterpartyNif` /
`counterpartyName` (alimentan el 347). **Modo sombra (§5.1):** una emitida cuya serie + número
es una factura de ehotelOS, o una recibida ya contabilizada en ehotelOS (NIF + número del
proveedor, `SupplierBill` posted / paid), no se importa (`nativeSkipped[]` en la preview, fila
`skipped_native` en el lote): su fila del libro ya la materializa el propio documento y el
303 / 347 / 390 no la cuenta dos veces. Dos lotes `vat_books` con alguna fila en común solapan
(409 `LEDGER_IMPORT_OVERLAP { overlaps }`; `replace` revierte entero el anterior) y el reverso
de un lote solo borra las filas que ningún otro lote vivo haya vuelto a escribir. Si el Excel real de Sage no replica el
diseño AEAT (hueco 6 del diseño §10.3), el libro entra por el bloque IVA del CSV IME (§2.3) o
por el canónico.

### 2.6 · Normalización y `contentHash`

Cabeceras plegadas, importes a 2 decimales, fechas ISO, filas ordenadas por `(ejercicio,
asiento, orden)`; `contentHash` = sha256 del JSON canónico de las filas normalizadas **antes**
del mapa de cuentas (§10.4 del diseño: así el hash no cambia al corregir el mapa y reimportar
el mismo fichero sigue siendo un duplicado). El mismo diario exportado a Excel y a CSV da el
mismo hash.

## 3 · Orden de carga

Cada paso es un lote (`kind`) con su preview; nunca se salta un paso porque el siguiente lo
exige (400 `LEDGER_IMPORT_ACCOUNT_UNMAPPED`, 400 `LEDGER_IMPORT_YEAR_CODE_INVALID`, 409
`FISCAL_YEAR_CLOSED`…). Un lote por fichero; los ficheros de diario, por meses.

| Paso | Lote | Fichero | Qué escribe | Qué exige |
| --- | --- | --- | --- | --- |
| 1 | `plan` | Plan de cuentas (Gestor de Exportación) o canónico de plan | `ledger_account_maps` (propuesta de las 7 reglas, §4.1) y las subcuentas `create` en `accounts` (por `prismaChartStore(tx).createAccounts`; nunca renombra ni borra; `nameDiffers` se avisa) | `chart_template = pgc_pymes_hotelero_v1` provisionado (`accounting:provision-chart`) |
| 2 | `fiscal_years` | Diario del periodo «Apertura» del ejercicio (asiento de apertura, `NumeroPeriodo 0`) o canónico de diario con `periodo` 0 | `fiscal_years { code: <ejercicio>, propertyId: null, 01/01 → 31/12 }`, 12 `fiscal_periods` mensuales `open` (por `tx.fiscalYear` / `tx.fiscalPeriod.create` replicando las validaciones de `createFiscalYear`), y el asiento `opening` (`sage200_journal`, `entryKind opening`, exento de centro) | plan; `code` = año natural `YYYY` (400 `LEDGER_IMPORT_YEAR_CODE_INVALID`); Faranda: hoy 0 `fiscal_years`, sus 112 asientos llevan `fiscal_year_code '2026'` |
| 3 | `journal` | Diario **por meses** (Excel con desglose analítico, CSV IME o canónico) | `journal_entries` / `journal_lines` (`sage200_journal`, un asiento por (asiento Sage, centro)), `cost_centers usali` por `(propertyId, code)`, `ledger_import_entries` | plan + `fiscal_years` + mapa analítico completo (§4.2); periodos abiertos en ehotelOS; el ejercicio **sin** lote `balances` vivo (409 `LEDGER_IMPORT_OVERLAP`, `replace` no lo levanta); si Sage numera por canal / delegación, `options.numberingDimension` (`canal` \| `delegacion`; CLI `--numbering`): el código entra en la clave y dos asientos nº N de delegaciones distintas no se funden |
| 4 | `vat_books` | Libro Registro de IVA del periodo de liquidación (AEAT) o bloque IVA del CSV IME | `vat_book_entries` (`sourceType sage200`; `rebuildVatBooks` las conserva; los documentos propios de ehotelOS se omiten, §2.5), `ledger_third_parties` (NIF / nombre) | fila `vat_settings` de la organización (409 `LEDGER_IMPORT_VAT_SETTINGS_MISSING` si no existe: §9); ningún otro lote `vat_books` vivo con las mismas facturas (409 `LEDGER_IMPORT_OVERLAP`, o `replace`) |
| 5 | `third_parties` | Clientes y Proveedores (Gestor de Exportación) o canónico | `ledger_third_parties`; `Supplier` solo con `options.createSuppliers` (§9) | — (en cualquier momento; alimenta la descripción de las líneas colapsadas y el 347) |
| 6 | `balances` | Sumas y saldos nivel 0 **por periodo** de los ejercicios **sin** diario (con «Comparativo periodo acumulado» y, si puede ser, la hoja por delegaciones) | `ledger_import_balances` + asiento `opening` del ejercicio + un asiento resumen `sage200_balance` por (ejercicio, periodo, centro) con Debe / Haber **brutos** por cuenta (un fichero entero por delegación con cada delegación cuadrada produce un asiento por centro sin reparto) + `regularization` / `closing` si el balance trae saldos de cierre (diseño §6) | plan + `fiscal_years` del ejercicio; **solo ejercicios sin diario**: si el ejercicio ya tiene asientos importados de diario o apertura (lote `journal` / `fiscal_years` vivo) o cualquier asiento `opening` vivo, 409 `LEDGER_IMPORT_OVERLAP { overlaps, fiscalYearCode }` y `replace` **no** lo levanta (revertir antes esos lotes) |
| 7 | reconciliación | Sumas y saldos nivel 0 del mismo rango que el último `journal` (con hoja por delegaciones para comparar por centro) | `ledger_reconciliations` (nunca toca el diario) | `journal` del rango contabilizado; se lanza sola si el lote lleva `options.reconcile` y el balance adjunto, o con `--reconcile --balance` |

Secuencia recomendada para CELUISMA (según la necesidad 6 de §1.1): `plan` → `fiscal_years`
2025 → `journal` 2025 mes a mes (incluidos los periodos de cierre de Sage: §5.4) → `vat_books`
2025 por trimestre → `third_parties` → reconciliación 2025 → `fiscal_years` 2026 (la apertura
que Sage generó al cerrar 2025) → `journal` 2026 enero-julio → `vat_books` 2026 → reconciliación
por mes → cierre de periodos en ehotelOS (§5.3). Los ejercicios anteriores a 2025 solo con
`balances` (paso 6).

## 4 · Mapa de cuentas y mapa analítico

### 4.1 · Mapa de cuentas Sage → PGC Pymes hotelero (diseño §4.4, `ledger-import.mapping.ts`)

Resolución por orden; la primera regla que aplica gana; todo resultado se persiste en
`ledger_account_maps` (única por `(organización, sistema, cuenta Sage)`) y la preview lo
enseña antes de contabilizar. `ACCOUNT_CODE_PATTERN` (`/^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/`) está
duplicado en `ledger-import.mapping.ts` con un test que lo pina contra `accounting.service.ts:250`
(el patrón del motor no es exportable y nunca se altera).

| # | Regla | Ejemplo | Acción |
| --- | --- | --- | --- |
| 1 | Fila explícita en el mapa (decidida por una persona) | `4770000 → 477.21` | la que diga |
| 2 | Código Sage sin ceros finales ≡ cuenta postable del plan | `6400000 → 640`, `5720000 → 572`, `4300000 → 4300` | `map` |
| 3 | Prefijo de 3 dígitos (o 4 si el plan tiene esa cuenta: `4300`, `4751`, `5721`) + serial sin ceros a la izquierda ≤ 999 → `prefijo.serial` existe en el plan | `4770021 → 477.21`, `4720010 → 472.10`, `7050001 → 705.1`, `6290001 → 629.1` | `map` |
| 4 | Prefijo de tercero `430`, `431`, `435`, `400`, `401`, `410`, `411` con serial > 0 | `4300000077 → 4300`, `4000000042 → 400`, `4100000007 → 410` | `collapse` (con `carryCounterparty` la línea lleva «Sage 4000000042 · B00000042 · SUMINISTROS DEMO SL») |
| 5 | Cuenta de IVA `472` / `477` sin serial pero apunte con bloque IVA (`PorIva`) | `4770000` + `PorIva 10 → 477.10` | `map_by_rate`: una fila por cuenta (`accountCode` = prefijo) y el destino `prefijo.<tipo>` se resuelve apunte a apunte; apunte sin bloque IVA → regla 7 |
| 6 | Regla 3 sin cuenta destino existente y prefijo válido en el plan | `6230002 → 623.2` (no existe) | `create`: subcuenta nueva con el título de Sage, `kind` heredado del prefijo y USALI **obligatorio** en grupos 6/7 (`usaliDepartment` / `usaliLine`; la preview propone el del prefijo) |
| 7 | Resto (serial > 999, longitud > 8 sin prefijo reconocible, cabeceras no postables) | `9990000001`, `4770000` sin bloque IVA | `block` → la preview lista `unmappedAccounts` con sugerencia y `canPost: false`; contabilizar responde 400 `LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts }` |

Editar el mapa: pestaña «Importar desde Sage 200» › paso «Cuentas» (solo con
`accounting.configure`) o `PUT /accounting/ledger-imports/account-map { entries }` (valida
cada `accountCode` con el patrón, existencia y postabilidad → 400
`LEDGER_IMPORT_ACCOUNT_CODE_INVALID { accountCode }`; acción desconocida o `accountCode` nulo
fuera de `block` → 400 `LEDGER_IMPORT_MAP_INVALID { errors }`; las filas `create` dan de alta la
subcuenta al guardar). Por CLI, `--mapping <ruta.json>` con `{ "accounts": [ … ], "analytics":
{ … } }` (mismo DTO que el cuerpo HTTP) se aplica sobre el mapa persistido. Cambiar una decisión
(p. ej. pasar de `collapse` a `create` para subcuentas por tercero, decisión 1 de §10) exige
reimportar el rango con `replace`: los asientos ya contabilizados se reversan por lote, nunca se
editan.

### 4.2 · Mapa analítico Sage → centros de trabajo y centros de coste (diseño §4.5)

`ledger_analytics_maps`: una fila por `(dimensión, código Sage)`; dimensiones `canal` ·
`delegacion` · `departamento` · `seccion` · `proyecto`. Configuración del lote
(`mappingJson.analytics`, `PUT /accounting/ledger-imports/analytics-map`):

- **`centreDimension`** (`delegacion` por defecto; César confirma cuál usan por hotel): código
  Sage → `propertyId` de la organización (AS FN LL LT MC OC PG RA). La preview sugiere por
  igualdad de `code` / `name` / `tradeName` plegados; lo que falte aparece en `unmappedAnalytics`
  y bloquea (400 `LEDGER_IMPORT_ANALYTICS_UNMAPPED { codes }`). Solo centros de la organización
  (`assertFinanceReadScopeMany`; sin `accounting.entity.read` ni ámbito de toda la sociedad → 404
  `ENTITY_SCOPE_REQUIRED`).
- **`costCentreDimension`** (`departamento` por defecto): código Sage → `costCentreCode` USALI
  (`ROOMS` · `FNB` · `POM` · `ADMIN_GENERAL` · `SALES_MARKETING` · `OTHER_OPERATED` · `IT`); al
  contabilizar se hace `upsert` de `cost_centers { propertyId, code, type: "usali" }` en la
  misma transacción; solo en líneas de grupos 6/7 (el lector USALI por centro de coste ya
  enruta `labor` y `other_expense`).
- **Política de apuntes 6/7 sin analítica** (`unassignedPolicy`, R4 `WORK_CENTER_REQUIRED`):
  `block` (defecto: `centreRequired[]` en la preview y 400 `LEDGER_IMPORT_CENTRE_REQUIRED {
  entries }`), `office` (van a OC, como las tres etiquetas de oficina del coste de personal) o
  `property:<propertyId>`. Nunca `manual` + `societyLevel`: mezclaría lo importado con lo manual.
- **Reparto por centro (R4).** Un asiento Sage cuyas líneas 6/7 llevan **un solo** centro → un
  `JournalEntry` con ese `propertyId`. Líneas 6/7 de **varios** centros → **un asiento ehotelOS
  por (asiento Sage, centro)** con las líneas 6/7 de ese centro y las líneas de balance (400 /
  410 / 4300 / 472 / 477 / 57x…) **repartidas** en proporción a Σ|6/7| del centro, céntimos
  residuales al centro de mayor peso, `taxBase` con la misma proporción, `sourceId` con sufijo
  `:<centro>`; cada parte cuadra por construcción y el consolidado de sociedad es exacto al
  céntimo. Asientos solo de balance (cobros, pagos, bancos) → `propertyId` del centro si todas
  sus líneas comparten analítica, si no `null` (nivel sociedad: R4 no aplica).
- `CodigoCanal` o `IdDelegacion` entra en la clave de idempotencia solo si Sage numera por canal
  / delegación (necesidad 3).

## 5 · Modo sombra contable (diseño §5)

### 5.1 · Regla: el lote de Sage excluye los documentos nativos de ehotelOS

Durante el modo sombra Sage 200 registra **todo** (también las facturas que ehotelOS emite con
VeriFactu, que Sage anota como «Emitida por otro software») y ehotelOS proyecta **sus**
documentos (facturas, rectificativas, anulaciones, cobros, tickets). Importar el diario de Sage
tal cual duplicaría exactamente esos asientos. Regla:

1. **Clave de exclusión.** Un asiento Sage queda `skipped_native` cuando su bloque de factura
   (`Serie` + `Factura`, `SuFacturaNo` o el número dentro de `DocumentoConta` / `Comentario`)
   coincide con una factura de la organización: `Invoice` no lleva `organizationId`, la unión es
   por `propertyId` de los centros de la organización y la comparación normaliza mayúsculas,
   guiones y ceros a la izquierda del serial sobre `seriesCode` + `invoiceNumber` (el número
   impreso completo, `FAC-2026-000001`). También cuando es el **cobro** de una de ellas (número
   en `DocumentoConta` / `Comentario`, o importe + fecha ± 3 días contra el asiento
   `payment/<paymentId>` del mismo importe: heurística, siempre visible en `nativeSkipped[]`;
   cada cobro propio **se consume una sola vez** —dos cobros de Sage de 100,00 no se excluyen
   por un único cobro propio de 100,00— y, a igualdad de importe y fecha, gana el asiento de
   Sage que cita la factura del cobro en su documento o concepto; **y solo si el centro coincide**
   cuando el cobro nativo tiene `propertyId` y todas las líneas con analítica del asiento Sage
   resuelven al mismo centro —`NativeEntryRef.propertyId`, `sameCentre`—; sin centro en uno de los
   dos lados se compara como antes. Formato real confirmado 2026-09-18: un cobro en caja de
   12,50 € de Los Tilos coincidía en importe y fecha con el cobro sandbox de una factura de Rías
   Altas y habría dejado julio sin cuadrar).
   Las claves nativas son desnudas (`sourceId` = `invoiceId` / `paymentId`): la preview enseña
   el asiento ehotelOS con el que coincide (`sourceType`, `sourceId`, `invoiceNumber`).
   **Libros de IVA:** la misma regla vale para el lote `vat_books` (§2.5): las emitidas propias
   (serie + número) y las recibidas ya contabilizadas en ehotelOS (NIF + número del proveedor)
   no entran como `sage200`; así `POST /fiscal/vat-books/rebuild`, que vuelve a derivar las filas
   nativas y conserva las `sage200`, nunca deja la misma factura dos veces en el libro.
2. **Los asientos propios de ehotelOS se conservan tal cual**: ningún flag nuevo, ningún lector
   cambia, el replay sigue siendo válido.
3. **Cobros sin factura ehotelOS identificable se importan**; si sobran, la reconciliación de
   `4300` / `57x` los delata como `native_only`.
4. **Faranda hoy**: 25 facturas de RA (sandbox, NIF emisores ficticios) con sus asientos, 48 de
   coste de personal 2026-01..08 y 2 de ingresos OPERA. Si Sage trae la nómina real de esos
   meses, el lote de coste de personal se reversa **entero** antes (`finanzas-contabilidad.md`
   §18.5) o el mapa bloquea 640 / 642 / 465 / 476 en ese rango; la preview avisa con
   `payrollCostImportsPosted[]` (nada se reversa solo).

### 5.2 · `native_only` y qué significa cada clasificación

En la reconciliación (§6) las cuentas con movimiento solo en ehotelOS en el rango
(`sourceType` nativo) se clasifican `native_only`: es lo **esperado** en `4300`, `705.x`,
`477.x` y `57x` mientras ehotelOS emita en RA, y en `28x` / `68x` por el segundo escritor del
diario (`payables/ledger-port.ts`, inmovilizado). Cualquier otra cuenta `native_only` es un
asiento manual o una proyección que Sage no tiene: revisar antes de cerrar el periodo.

### 5.3 · Cadencia mensual y cierre del periodo tras reconciliar

Al cerrar el mes en Sage, administración exporta el Diario del mes, el Sumas y saldos nivel 0
del mes (con la hoja por delegaciones) y, cada trimestre, el Libro de IVA del periodo. ehotelOS
importa (`journal` + `vat_books`), reconcilia (§6) y, si `ok`, **cierra el periodo** en
Contabilidad › Periodos (`POST /accounting/fiscal-periods/:id/close`): con el periodo cerrado,
ni la proyección propia ni el replay ni un segundo lote pueden volver a escribir en ese mes (409
`FISCAL_PERIOD_CLOSED`, rollback del lote entero). Cadencia diaria solo con login SQL de lectura
o con la exportación XML programada en un buzón (fuera de L0-L6). Trimestral: cuadre del 303 de
ehotelOS (libros importados + nativos) con el 303 presentado desde Sage antes de presentar;
diferencia → `vat_diff`. Relevo: dos cierres mensuales consecutivos `ok` sin ajustes y un
trimestre declarado con los libros de ehotelOS → Sage pasa a solo lectura, la última
importación es la apertura del ejercicio siguiente y la emisión se hace ya solo en ehotelOS.

### 5.4 · Cierre de ejercicio importado y regla «reabrir = revertir el lote»

Sage cierra el ejercicio con dos procesos: «Cierre de ejercicio» (grupos 6 y 7 contra 129) y
«Cierre contabilidad» (grupos 1 al 5), más la apertura del ejercicio siguiente. Se importan con
el lote `journal` de los periodos de cierre: la preview los detecta por el periodo Sage («Cierre
ejercicio» / «Cierre Contabilidad») o, sin columna de periodo, por cuenta 129 + fecha fin de
ejercicio, los lista en `closingDetected[]` con su `entryKind` (`regularization` / `closing`; la
apertura, `opening`, va en el lote `fiscal_years` del ejercicio siguiente) y el usuario confirma.
El periodo «Regul. y Ajustes» de Sage contiene asientos de ajuste **normales** fechados a fin de
ejercicio: conservan `entryKind normal`. **La heurística por estructura** (cuenta 129 + fecha fin de
ejercicio → `regularization`; sin 6/7, ≥ 2 grupos de balance y concepto con «cierre» / «apertura» a
fin / inicio de ejercicio → `closing` / `opening`) **se aplica también cuando el periodo viene
numérico (1-12)**, no solo sin columna de periodo: un asiento normal de un mes real (p. ej. «cierre
TPV» del 31/12 entre 430 y 572) puede aparecer en `closingDetected[]`. Por eso `closingDetected` se
revisa en **cada lote mensual** y nunca se contabiliza un mes con un asiento normal detectado como
regularización / cierre / apertura: marcaría el ejercicio cerrado antes del cierre real (formato
real confirmado 2026-09-18). Tras contabilizarlos, `markFiscalYearClosedFromImport({
fiscalYearId, closingEntryId, openingEntryId, netResult })` deja `fiscal_years.status = closed`
**sin** generar asientos propios (`closeFiscalYear` produciría regularización, cierre y apertura
duplicados). Ejercicios sin cierre importado siguen `open` con todos sus periodos `closed`.

**Reabrir un ejercicio cerrado por importación.** `reopenFiscalYear` **sí** alcanzaría esos
asientos (busca por `fiscalYearId` + `entryKind regularization | closing`, que el motor rellena
en `postJournalEntry`), y reversarlos con `year-reopen:*` dejaría el lote `posted` con asientos
reversados fuera de su control: por eso `POST /accounting/fiscal-years/:id/reopen` responde
**409 `FISCAL_YEAR_CLOSED_FROM_IMPORT { fiscalYearId, importId }`** cuando el cierre vino de un
lote. La regla es **reabrir = revertir el lote** (`POST /accounting/ledger-imports/:id/reverse
{ reason }` o `sage200:import -- --reverse <importId> --reason "…" --confirm <orgId>`): el
reverso reversa los asientos de regularización y cierre del lote y devuelve el ejercicio a `open`
(sin `year-reopen:*`). Como el reverso exige el periodo del asiento **original** abierto
(`assertOriginalPeriodOpen`, misma guarda que el lote de nómina), el orden es: reabrir el
periodo 12 en Contabilidad › Periodos → revertir el lote → corregir en Sage y reimportar el
cierre → volver a cerrar el periodo. Con el ejercicio cerrado, cualquier lote fechado dentro
responde 409 `FISCAL_YEAR_CLOSED` y hace rollback.

## 6 · Reconciliación (diseño §5.2, `ledger-reconciliation.service.ts`)

**Entrada:** Sumas y saldos nivel 0 de Sage del rango (Excel con «Comparativo periodo
acumulado» y, para comparar por centro, la «Hoja adicional canales/delegaciones»; o el canónico
de saldos) + `from` / `to` + `propertyId?` (sin él, consolidado de sociedad). Por HTTP
`POST /accounting/ledger-imports/reconciliation` con `{ from, to, propertyId?, format?,
contentBase64 | content, sheetName?, importId? }` (`accounting.journal.post`, medium; escribe solo
`ledger_reconciliations`), por CLI `--reconcile --balance <fichero> --from --to [--property]`, o
adjuntando el balance al lote `journal` (`options.reconcile`: se lanza **tras el commit** del
lote, porque `aggregateAccountBalances` lee con el `prisma` raíz y no vería la transacción
abierta). En el front, la vista «Reconciliación» de la pestaña: el centro se elige en el
**selector de ámbito único** de la cabecera (política `entity_default`: sin centro elegido,
consolidado de sociedad).

**Criterio de lectura** (se guarda en `summary.criterion`): cada cuenta Sage pasa por el mapa
(§4.1) y se agrupa por cuenta destino; ehotelOS se lee con `aggregateAccountBalances` con la
**misma regla que los estados**: `status ≠ draft`, sin parejas de reversión (`reversed_by_id IS
NULL AND reversal_of_id IS NULL`), **movimientos** del rango sin `regularization` / `closing` /
`opening`, y **saldo a `to`** (`balance_at`, que sí incluye la apertura y deja fuera el cierre
**y la regularización** fechados ese día: a 31/12 la 129 va sin el resultado del ejercicio,
como en el balance de Sage «hasta el periodo 12») para los grupos 1-5. Del lado Sage, Debe y
Haber se **suman** por cuenta destino y el saldo es el **acumulado de la última fila** de cada
(cuenta, delegación): un balance mensual comparado sobre un trimestre o un ejercicio no suma
tres ni doce saldos. Las cuentas de IVA por tipo (`map_by_rate` 472 / 477, regla 5) se
comparan **por prefijo**: `4770000` de Sage frente a Σ `477.xx` del diario (una `477.21` con
mapa propio no se pliega).

| Comparación | Sage | ehotelOS | Tolerancia | Clasificación |
| --- | --- | --- | --- | --- |
| Debe / Haber del periodo por cuenta | columnas Debe / Haber (nivel 0, agrupadas por destino) | Σ `debit` / Σ `credit` del rango | **0,00** en el consolidado y en cuentas solo importadas; **0,01 × nº de asientos repartidos por centro** en cuentas de balance **por centro** (el reparto de §4.2 deja céntimos residuales) | `amount_diff` |
| Saldo a `to`, grupos 1-5 | Saldo (Deudor / Acreedor) | `balance_at` | igual | `amount_diff` |
| Cuentas con movimiento solo en ehotelOS | — | `sourceType` nativo en el rango | — | `native_only` (§5.2) |
| Asientos Sage no importados | filas `unmapped` / `error` / `skipped_native` del lote (`importId`) | — | — | `missing_in_ledger` (con `sourceEntryNumber`) |
| IVA | Libro de IVA de Sage frente a `loadVatBookRows` y el cruce 472 / 477 del 303 | — | **0,01 por tipo impositivo** | `vat_diff` |

**Balance canónico de la carga real (formato real confirmado 2026-09-18).** Los «Balance sumas y
saldos» reales de Sage no se adjuntan tal cual: (1) Sage **suma con signo** y el importador pasa
cada apunte negativo al lado contrario, así que Σ `debit` / Σ `credit` de ehotelOS por cuenta =
Sage + Σ|negativos| de la cuenta en el mes (el saldo neto es idéntico); el preprocesado suma ese
mismo importe N a **las dos** columnas `debe` / `haber` del balance canónico (tomado de las mismas
filas del diario que se cargan) y así la comparación con tolerancia 0,00 sigue siendo estricta; (2) los mensuales de Sage traen **solo los movimientos del mes**
(`AperturaP = 0`, `SaldoP = DebeP − HaberP`) y la reconciliación compara el saldo **acumulado** a
`to`: el canónico lleva `saldo_deudor / saldo_acreedor` = apertura del ejercicio + Σ (DebeP − HaberP)
de los meses ≤ M, con una fila para toda cuenta con saldo acumulado aunque no se mueva en el mes
(`debe = haber = 0`); los anuales («SIN CIERRE» a 31/12 y «A 31072026») se usan con su `SaldoA`
para la reconciliación del ejercicio entero. Comprobación previa que hace el preprocesado: DebeP /
HaberP de cada cuenta del mensual = Σ con signo del diario del mes (0 diferencias en 19 meses).

**Por qué no cuadra con la pantalla «Sumas y saldos» de ehotelOS a fin de año.** `buildTrialBalance`
(Contabilidad › Sumas y saldos) suma **todos** los asientos `posted` de la ventana, incluidos
`regularization` / `closing` / `opening`, mientras que la reconciliación usa `movements` (que
los excluye) y `balance_at`. Con los periodos de cierre importados, la pantalla de sumas y saldos
de diciembre muestra las cuentas 6/7 a cero y la 129 con el resultado; la reconciliación compara
el balance de Sage **hasta el periodo 12** (excluye «Cierre ejercicio» / «Cierre Contabilidad»)
con los movimientos, así que las cifras coinciden con Sage y no con esa pantalla. Comparar la
pantalla con Sage solo tiene sentido en meses sin cierre.

**Resultado:** `LedgerReconciliation` (`status ok` si 0 diferencias fuera de tolerancia;
`differences` si hay alguna; `error` si el balance no se pudo leer), `rows[]` por cuenta
destino (`sourceDebit`, `sourceCredit`, `ledgerDebit`, `ledgerCredit`, `diffDebit`,
`diffCredit`, `sourceBalance`, `ledgerBalance`, `diffBalance`, `classification`, `tolerance`,
`ok`), `summary { nativeOnly, missingInLedger, amountDiff, vatDiff, tolerance, criterion }`,
`missingEntries[]`. Historial: `GET /accounting/ledger-imports/reconciliation?from=&to=&propertyId=&limit=`,
detalle `GET …/reconciliation/:id`, CSV `GET …/reconciliation/:id/csv` (404 opaco
`LEDGER_RECONCILIATION_NOT_FOUND`). Qué hacer con cada clasificación: `amount_diff` → abrir el
mayor de la cuenta (`GET /accounting/ledger/:accountCode`, el número Sage va en `reference`) y
buscar el asiento que falta o sobra; `missing_in_ledger` → completar el mapa y reimportar el
mes con `replace`; `native_only` → §5.2; `vat_diff` → comparar el libro importado con el 303
(`GET /fiscal/models/303?period=`) y el cruce 472 / 477.

## 7 · CLI `sage200:import` paso a paso (`apps/api/src/scripts/import-sage200.ts`)

Clon estructural de `import-payroll-cost.ts`: dry-run por defecto, `--apply --confirm <orgId>`
para escribir, salida 2 (uso) · 1 (fallo o `canPost: false`) · 0 (ok). Usuario de sistema
`usr_system_sage200_import` (`createdBy cli:import-sage200`) con `accounting.journal.post`,
`accounting.configure`, `accounting.read` y `accounting.entity.read`. `--apply` hidrata la cadena
de auditoría desde Postgres antes y vacía las colas (`flushAuditQueues`,
`flushAccountingProjection`) antes de desconectar: **ejecutar con los API parados y con backup**
(la cadena de auditoría en memoria del API en marcha se bifurca hasta su reinicio, deuda 12(c)).

```bash
cd /Users/cfernandez/anfitorio-demo/hotelos

corepack pnpm --filter @hotelos/api sage200:import -- \
  --type plan|fiscal_years|journal|vat_books|third_parties|balances --file <ruta> --organization <orgId> \
  [--entity <legalEntityId>] [--format sage_excel|sage_ime_csv|sage_xml|canonical_csv|canonical_json] [--sheet <hoja>] \
  [--mapping <ruta.json>] [--unassigned block|office] [--numbering canal|delegacion] [--dry-run | --apply --confirm <orgId>] [--replace] \
  [--allow-closed --reason "…"] [--notes "…"] [--reconcile --balance <fichero> [--from AAAA-MM-DD --to AAAA-MM-DD --property <código>]] [--json]
corepack pnpm --filter @hotelos/api sage200:import -- --reverse <importId> --reason "…" --confirm <orgId>
corepack pnpm --filter @hotelos/api sage200:import -- --template <type> --out <ruta.csv>
```

Paso a paso con la demo sintética (`<raíz git>/pilots/faranda-celuisma/sage200-demo/`,
git-ignored; `<orgId>` = `cmrhw9jy30002fyvb6tsdiugt`):

```bash
# 0. Plantillas canónicas (para preparar ficheros a mano o desde una consulta SQL)
corepack pnpm --filter @hotelos/api sage200:import -- --template journal --out /tmp/plantilla-diario.csv

# 1. Plan de cuentas: dry-run → tabla de cuentas Sage con acción propuesta (map / create / collapse / map_by_rate / block)
corepack pnpm --filter @hotelos/api sage200:import -- --type plan --file sage200-demo/plan-cuentas.xlsx --organization <orgId>
corepack pnpm --filter @hotelos/api sage200:import -- --type plan --file sage200-demo/plan-cuentas.xlsx --organization <orgId> --apply --confirm <orgId>

# 2. Ejercicio y apertura (crea fiscal_years 2025 + 12 periodos + asiento opening)
corepack pnpm --filter @hotelos/api sage200:import -- --type fiscal_years --file sage200-demo/apertura-2025.csv --organization <orgId> --apply --confirm <orgId>

# 3. Diario por meses (CSV IME): dry-run con --json para archivar la preview; luego apply con reconciliación del mismo mes
corepack pnpm --filter @hotelos/api sage200:import -- --type journal --file sage200-demo/diario-2026-09.csv --organization <orgId> --json > /tmp/preview-2026-09.json
corepack pnpm --filter @hotelos/api sage200:import -- --type journal --file sage200-demo/diario-2026-09.csv --organization <orgId> \
  --mapping sage200-demo/mapping.json --unassigned office \
  --reconcile --balance sage200-demo/sumas-y-saldos-2026-09.xlsx --from 2026-09-01 --to 2026-09-30 \
  --apply --confirm <orgId>

# 4. Libros de IVA del trimestre (exige la fila vat_settings: §9)
corepack pnpm --filter @hotelos/api sage200:import -- --type vat_books --file sage200-demo/libro-iva-2026-3T.xlsx --organization <orgId> --apply --confirm <orgId>

# 5. Terceros (Supplier solo si el mapping.json lleva "options": { "createSuppliers": true })
corepack pnpm --filter @hotelos/api sage200:import -- --type third_parties --file sage200-demo/terceros.xlsx --organization <orgId> --apply --confirm <orgId>

# 6. Saldos de un ejercicio sin diario (apertura + un asiento resumen por periodo y centro)
corepack pnpm --filter @hotelos/api sage200:import -- --type balances --file sage200-demo/sumas-y-saldos-2025.csv --organization <orgId> --apply --confirm <orgId>

# 7. Reconciliación suelta de un mes ya importado, por centro
corepack pnpm --filter @hotelos/api sage200:import -- --type journal --reconcile --balance sage200-demo/sumas-y-saldos-2026-09.xlsx \
  --from 2026-09-01 --to 2026-09-30 --property RA --organization <orgId> --json

# 8. Reverso de un lote (idempotente; exige el periodo del original abierto)
corepack pnpm --filter @hotelos/api sage200:import -- --reverse <importId> --reason "Mes reexportado desde Sage" --confirm <orgId>
```

Qué imprime el dry-run: cabecera (organización, sociedad vía `resolveLedgerScope`, fichero,
hash, formato detectado, ejercicio, rango), tabla por mes × centro (asientos, apuntes, Debe,
Haber), cuentas sin mapear con sugerencia, analítica sin mapear, asientos sin centro, nativos
excluidos, ya existentes, apertura / cierres detectados, duplicado y solapes, lotes de coste de
personal en el rango, avisos y `canPost`. Con `--json` sale el `LedgerImportPreview` íntegro
(mismo DTO que `POST /accounting/ledger-imports/preview`); con `--apply --json`, el
`LedgerImportCreateResult` (lote, entradas, `created`, `skipped`, `reconciliation`). Flags
delicados: `--replace` reversa **enteros** los lotes que dupliquen o solapen (nunca sobre Faranda
salvo para sustituir un mes completo); `--allow-closed --reason "…"` contabiliza en periodos
cerrados de ehotelOS (`ignoreClosedPeriod`, auditado con el motivo; por HTTP `allowClosed` →
400 `VALIDATION_ERROR`); `--notes "…"` (solo lotes; `lotNotes`) deja una nota libre en
`ledger_imports.notes` —p. ej. «carga real 2026-09-18» para reconocer los lotes de una carga—,
precedida del motivo de `--allow-closed` si lo hay; `--entity` solo si la organización tuviera
más de una sociedad.

**Las mismas operaciones por API** (15 rutas del partial `accounting (ledger-import)`; claves
efectivas y riesgo en `finanzas-contabilidad.md` §13; cuerpos `.strict()` en
`schemas/ledger-import.schemas.ts`; DTOs en `packages/shared/src/ledger-import-types.ts`):

| Operación | Ruta | Clave efectiva |
| --- | --- | --- |
| Previsualizar (nunca escribe) | `POST /accounting/ledger-imports/preview` | `accounting.journal.post` |
| Crear y contabilizar (`post: false` deja borrador) | `POST /accounting/ledger-imports` | `accounting.journal.post` |
| Contabilizar un borrador (`{ replace? }`) | `POST /accounting/ledger-imports/:id/post` | `accounting.journal.post` |
| Revertir (200 idempotente, `{ reason }`) | `POST /accounting/ledger-imports/:id/reverse` | `accounting.journal.post` + `ai.high_risk.confirm` |
| Historial y detalle de lotes | `GET /accounting/ledger-imports` · `GET /accounting/ledger-imports/:id` | `accounting.reports.read` |
| Plantilla canónica (`?kind=&format=csv`) | `GET /accounting/ledger-imports/template` | `accounting.reports.read` |
| Mapa de cuentas | `GET /accounting/ledger-imports/account-map` · `PUT /accounting/ledger-imports/account-map` | `accounting.reports.read` · `accounting.configure` |
| Mapa analítico | `GET /accounting/ledger-imports/analytics-map` · `PUT /accounting/ledger-imports/analytics-map` | `accounting.reports.read` · `accounting.configure` |
| Reconciliar (escribe solo `ledger_reconciliations`) | `POST /accounting/ledger-imports/reconciliation` | `accounting.journal.post` |
| Historial, detalle y CSV de reconciliaciones | `GET /accounting/ledger-imports/reconciliation` · `GET /accounting/ledger-imports/reconciliation/:id` · `GET /accounting/ledger-imports/reconciliation/:id/csv` | `accounting.reports.read` |

## 8 · SQL de verificación (solo lectura)

```sql
-- Sustituir <orgId> por cmrhw9jy30002fyvb6tsdiugt (Faranda). Todo solo lectura.
-- 0. Invariantes ANTES de la primera carga (BD local, 2026-09-17, tras la Tanda 7b):
--    112 asientos · 599 líneas · Σ debe 2456852.66 · 25 facturas · 33 envíos VeriFactu · 22 cost_centers ·
--    0 fiscal_years · 0 vat_book_entries · 0 suppliers · 0 vat_settings
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>';                                              -- 112
SELECT count(*), sum(jl.debit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>';                                                                                 -- 599 | 2456852.66
SELECT source_type, count(*) FROM journal_entries WHERE organization_id = '<orgId>' GROUP BY 1 ORDER BY 1;
--    invoice 22 · invoice_cancellation 8 · invoice_rectification 4 · payment 23 · payment_refund 4 ·
--    payroll_cost_import 48 · pms_shadow_revenue 2 · reversal 1
SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';        -- 25
SELECT count(*) FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id
JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';                                          -- 33
SELECT count(*) FROM cost_centers cc JOIN properties p ON p.id = cc.property_id WHERE p.organization_id = '<orgId>';   -- 22
SELECT count(*) FROM fiscal_years WHERE organization_id = '<orgId>';                                                  -- 0
SELECT count(*) FROM vat_book_entries WHERE organization_id = '<orgId>';                                              -- 0
SELECT count(*) FROM suppliers WHERE organization_id = '<orgId>';                                                     -- 0
SELECT count(*) FROM vat_settings WHERE organization_id = '<orgId>';                                                  -- 0

-- 1. Lotes: uno por fichero, status posted, contadores y totales cuadrados (total_debit = total_credit)
SELECT id, kind, format, status, source_company_code, fiscal_year_code, period_from, period_to, row_count, entry_count,
       skipped_count, warning_count, total_debit, total_credit, array_length(journal_entry_ids, 1) AS asientos,
       array_length(reversal_journal_entry_ids, 1) AS reversos, replaced_by_id, created_by, posted_at
FROM ledger_imports WHERE organization_id = '<orgId>' ORDER BY created_at;
SELECT import_id, status, count(*) FROM ledger_import_entries WHERE organization_id = '<orgId>' GROUP BY 1, 2 ORDER BY 1, 2;
--    posted = entry_count del lote; skipped_native = facturas / cobros propios excluidos; skipped_existing = reimportación

-- 2. Asientos importados: reference «Sage 200 · …», sourceType sage200_journal / sage200_balance, source_id únicos, cuadre
SELECT je.source_type, count(*) AS asientos, min(je.entry_number), max(je.entry_number),
       count(DISTINCT je.property_id) AS centros, count(DISTINCT je.fiscal_year_code) AS ejercicios,
       bool_and(je.reference LIKE 'Sage 200 ·%') AS referencia_sage,
       count(DISTINCT je.source_id) = count(*) AS source_id_unicos
FROM journal_entries je
WHERE je.organization_id = '<orgId>' AND je.source_type IN ('sage200_journal', 'sage200_balance') AND je.status = 'posted'
GROUP BY 1;
SELECT je.id, je.reference, s.debe, s.haber
FROM journal_entries je JOIN (SELECT journal_entry_id, sum(debit) AS debe, sum(credit) AS haber FROM journal_lines GROUP BY 1) s
  ON s.journal_entry_id = je.id
WHERE je.organization_id = '<orgId>' AND je.source_type LIKE 'sage200_%' AND s.debe <> s.haber;                       -- 0 filas
SELECT entry_kind, count(*) FROM journal_entries
WHERE organization_id = '<orgId>' AND source_type LIKE 'sage200_%' GROUP BY 1 ORDER BY 1;
--    normal · opening (uno por ejercicio) · regularization / closing (solo si se importó el cierre)

-- 3. R4: 0 líneas de grupos 6/7 sin centro de trabajo; y, si el mapa lleva centro de coste, 0 líneas 6/7 sin cost_center_id
SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>' AND je.source_type LIKE 'sage200_%' AND je.entry_kind = 'normal'
  AND (jl.account_code LIKE '6%' OR jl.account_code LIKE '7%') AND je.property_id IS NULL;                             -- 0
SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>' AND je.source_type = 'sage200_journal' AND je.entry_kind = 'normal'
  AND (jl.account_code LIKE '6%' OR jl.account_code LIKE '7%') AND jl.cost_center_id IS NULL;                         -- 0 con costCentreDimension

-- 4. Libros de IVA importados: sourceType sage200, un periodo por fila calculado (nunca del Excel), y cuadre por libro y tipo
SELECT book, rate, count(*), sum(base) AS base, sum(quota) AS cuota FROM vat_book_entries
WHERE organization_id = '<orgId>' AND source_type = 'sage200' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) FROM vat_book_entries WHERE organization_id = '<orgId>' AND source_type = 'sage200'
  AND period !~ '^[0-9]{4}-(Q[1-4]|[0-9]{2})$';                                                                      -- 0

-- 5. Ejercicios: code = año natural, propertyId null; closed solo con closing_entry_id (cierre importado)
SELECT code, property_id, status, start_date, end_date, closing_entry_id IS NOT NULL AS cierre_importado,
       opening_entry_id IS NOT NULL AS apertura
FROM fiscal_years WHERE organization_id = '<orgId>' ORDER BY code;
-- fiscal_periods NO tiene fiscal_year_id: el ejercicio se deduce de period_code (YYYY-MM)
SELECT left(period_code, 4) AS ejercicio, count(*) AS periodos, count(*) FILTER (WHERE status = 'closed') AS cerrados
FROM fiscal_periods WHERE organization_id = '<orgId>' AND property_id IS NULL GROUP BY 1 ORDER BY 1;                  -- 12 por ejercicio

-- 6. Mapa de cuentas y analítico, terceros
SELECT action, count(*) FROM ledger_account_maps WHERE organization_id = '<orgId>' AND system = 'sage200' GROUP BY 1;
SELECT count(*) FROM ledger_account_maps WHERE organization_id = '<orgId>' AND action = 'block';                       -- 0 si canPost
SELECT dimension, count(*), count(property_id) AS con_centro, count(cost_centre_code) AS con_centro_coste
FROM ledger_analytics_maps WHERE organization_id = '<orgId>' GROUP BY 1;
SELECT role, count(*), count(supplier_id) AS con_supplier FROM ledger_third_parties WHERE organization_id = '<orgId>' GROUP BY 1;

-- 7. Reconciliaciones: la última de cada rango en ok
SELECT id, import_id, period_from, period_to, property_id, status, accounts_compared, difference_count, created_at
FROM ledger_reconciliations WHERE organization_id = '<orgId>' ORDER BY created_at DESC;

-- 8. Invariantes DESPUÉS: los 112 asientos previos intactos (ninguno reversado por la importación), 25 facturas, 33 envíos
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>' AND source_type NOT LIKE 'sage200_%';        -- 112
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>' AND source_type NOT LIKE 'sage200_%'
  AND reversed_by_id IS NOT NULL AND entry_number <= 112;                                                             -- 1 (el reverso previo de la Tanda 7b)
```

Por API tras el reinicio de :3000: `GET /accounting/ledger-imports?kind=journal&status=posted`,
`GET /accounting/ledger-imports/:id` (entradas con número ehotelOS y número Sage),
`GET /accounting/reports/trial-balance?from=&to=` y `GET /accounting/annual-accounts/balance` /
`…/pyg` con `comparative` (los asientos resumen de `balances` alimentan la columna comparativa),
`GET /accounting/usali/pnl?from=&to=` por centro, `GET /fiscal/models/303?period=2026-Q3` con
los libros importados + nativos.

## 9 · Preguntas frecuentes

- **«409 `LEDGER_IMPORT_DUPLICATE`»: el fichero ya se importó.** Mismo `contentHash` en un lote
  no revertido de la organización (`{ importId, fileName, createdAt }`). Si el fichero es el
  mismo, no hay nada que hacer; si Sage lo reexportó corregido, el hash cambia y lo que salta es
  el solape.
- **«409 `LEDGER_IMPORT_OVERLAP { overlaps }`»: otros lotes cubren asientos de este fichero.**
  La clave de solape es `(empresa, ejercicio, periodo, asiento)`. `replace: true` (front:
  interruptor «Sustituir los lotes anteriores»; CLI `--replace`) reversa **enteros** los lotes
  afectados y crea el nuevo en la misma transacción: reimportar siempre el rango completo (si un
  lote cubría el trimestre y se reimporta un mes con `replace`, los otros dos meses desaparecen
  del diario). Reimportar un mes al que Sage añadió asientos **sin** `replace`: los ya
  importados quedan `skipped_existing` (`findJournalEntryBySource`) y solo entran los nuevos.
- **Cuentas sin mapear (`unmappedAccounts`, 400 `LEDGER_IMPORT_ACCOUNT_UNMAPPED`).** La preview
  propone una acción por cuenta (§4.1); decidir en el paso «Cuentas» (o
  `PUT /accounting/ledger-imports/account-map`) y volver a previsualizar. `block` es una
  decisión explícita, no un error: la
  cuenta no se contabiliza y sus asientos quedan `unmapped` y aparecen en la reconciliación
  como `missing_in_ledger`.
- **«409 `LEDGER_IMPORT_VAT_SETTINGS_MISSING`»: la organización no tiene fila `vat_settings`.**
  Decisión de César (§10): la periodicidad (trimestral / REDEME mensual) y el régimen fijan el
  `period` de cada fila del libro y el 303. **El importador nunca crea la fila** (a diferencia de
  `ensureVatSettings`, que la crearía con `quarterly` / `general`; el servicio detecta la
  ausencia con `vatSettings.findUnique`, no con `getVatSettings`, que devuelve defaults sin
  fila). Crearla: `PUT /fiscal/vat-settings` (Finanzas › Fiscal › Configuración de IVA) y repetir
  el lote. Faranda: 0 filas hoy.
- **Nómina real de Sage frente al lote de coste de personal 2026-01..08.** La preview avisa
  (`payrollCostImportsPosted[]`) y nada se reversa solo. O se reversa entero el lote de coste de
  personal (`finanzas-contabilidad.md` §18.5) antes de importar esos meses, o el mapa bloquea
  640 / 642 / 465 / 476 (`block`) mientras dure el solape. Decisión 4 de §10.
- **Fichero > 20 MiB (400 `LEDGER_IMPORT_TOO_LARGE`) o > 20.000 asientos
  (`LEDGER_IMPORT_TOO_MANY_ENTRIES`).** Por el navegador no: trocear por meses o usar el CLI
  (§7), que lee el fichero del disco y respeta los mismos topes por lote pero no el `bodyLimit`.
- **XML «Datos contables» (400 `LEDGER_IMPORT_XML_UNSUPPORTED { blocks }`).** Sage no publica
  ni XSD ni nombres de bloques; `sage200.xml.ts` lee el ZIP / XML con `parseXml` (límites
  explícitos de tamaño y profundidad), lista los bloques encontrados y no importa nada hasta
  tener una exportación real (necesidad 1). Mientras tanto, Excel o CSV.
- **Terceros: ¿crea proveedores?** Solo con `options.createSuppliers: true` (front: interruptor
  del paso «Fichero» para `third_parties`; CLI: en el `mapping.json`). `Supplier` no tiene índice
  único por `(organización, NIF)` y la comprobación de NIF duplicado es privada del servicio de
  proveedores: el lote busca con `findFirst` por NIF normalizado y crea o actualiza; sin la
  opción solo escribe `ledger_third_parties` (que ya basta para las descripciones de las líneas
  colapsadas y el 347).
- **¿Se puede conservar el número de asiento de Sage?** No: `entryNumber` lo asigna el motor por
  ejercicio (índice único); el número Sage va en `reference` («Sage 200 · asiento 2026/1501 ·
  periodo 9 · diario 0») y en `ledger_import_entries.sourceEntryNumber`, y se ve en el diario, en
  el mayor y en el detalle del asiento. Un ejercicio con asientos nativos previos queda
  intercalado (la preview avisa con `existingNativeEntries`).
- **«409 `FISCAL_YEAR_CLOSED_FROM_IMPORT`» al reabrir un ejercicio.** El cierre vino de un lote
  importado: reabrir = revertir ese lote (§5.4). El mismo 409 responde
  `POST /accounting/fiscal-years/:id/close` cuando el ejercicio sigue `open` pero ya tiene la
  regularización o el cierre de Sage importados (lote `journal` con los periodos «Cierre
  ejercicio» / «Cierre Contabilidad» anterior a «ejercicios»): cerrarlo con `closeFiscalYear`
  duplicaría la 129 y el cierre; importa «ejercicios» (el lote `fiscal_years` adopta esos
  asientos y marca el ejercicio cerrado) o revierte el lote.
- **Sage numera los asientos por canal o por delegación («Numeración canal/delegación»).** Sin
  decirlo, dos asientos nº N de delegaciones distintas del mismo periodo se funden en uno (aviso
  «Líneas con fechas distintas», reparto o centro perdido). Indica
  `options.numberingDimension: "canal" | "delegacion"` (CLI `--numbering`): el código entra en
  la clave `empresa:ejercicio:periodo:asiento:<código>` y en `ledger_import_entries.sourceChannel`.
- **Un borrador (`post: false`) responde 400 `LEDGER_IMPORT_TOO_MANY_ROWS { rows, max }`.** El
  borrador conserva las filas canónicas del fichero (NIF, nombres, importes) en
  `mappingJson.draftRows` hasta contabilizarlo (después se purgan): tope de 20.000 filas
  (`LEDGER_IMPORT_MAX_DRAFT_ROWS`); con más filas, contabiliza directamente o usa el CLI.
- **El detalle de un lote de 20.000 asientos.** `GET /accounting/ledger-imports/:id?offset=&limit=`
  pagina las entradas (500 por defecto, 2.000 como máximo; `entryOffset` y `entryTotal` en la
  respuesta): el lote entero es auditable desde la API aunque el front pinte la primera página.
- **La preview dice `canPost` y el lote muere en el motor con `ACCOUNT_NOT_FOUND`.** Ya no: la
  preview comprueba que cada cuenta destino del mapa (también `477.xx` de una `map_by_rate` y
  la subcuenta de un `create`) exista y admita apuntes; si no, la cuenta Sage queda en
  `unmappedAccounts` con la propuesta («guarda el mapa o importa el plan de cuentas antes»).
- **¿Y si la exportación real de Sage no se parece a lo que esperamos?** La preview responde 400
  `LEDGER_IMPORT_INVALID` con las cabeceras que faltan; añadir el sinónimo en `sage200.parser.ts`
  (con su fixture sintético) o convertir el listado al canónico (§2.4). Es el hueco 1 del diseño
  §10.3 y solo lo cierra la necesidad 1.

**Catálogo completo de códigos** (`LEDGER_IMPORT_ERROR_CODES`, siempre en `details.code`; el
front y el CLI muestran `LEDGER_IMPORT_ERROR_LABELS_ES`):

| HTTP | Código | Cuándo | Qué hacer |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | clave desconocida en el cuerpo, `content` y `contentBase64` a la vez o ninguno, `kind` fuera del catálogo, `allowClosed` por HTTP, `limit` fuera de rango, `reason` fuera de 3..500 | corregir la petición |
| 400 | `LEDGER_IMPORT_INVALID { errors[{ line, message }] }` | cabecera obligatoria ausente, importe no numérico, fecha ilegible | revisar las líneas indicadas o añadir el sinónimo (§2.2) |
| 400 | `LEDGER_IMPORT_FORMAT_UNKNOWN` | sin `format` y sin extensión, firma ni cabecera reconocibles | indicar `format` / `--format` |
| 400 | `LEDGER_IMPORT_XML_UNSUPPORTED { blocks }` | XML «Datos contables» (parser pendiente de una exportación real) | exportar a Excel / CSV |
| 400 | `LEDGER_IMPORT_KIND_MISMATCH` | el contenido no corresponde al tipo de lote (p. ej. un sumas y saldos enviado como `journal`) | elegir el tipo correcto |
| 400 | `LEDGER_IMPORT_EMPTY` | sin filas de datos | revisar la exportación (hoja vacía, hoja equivocada: `sheetName`) |
| 400 | `LEDGER_IMPORT_TOO_LARGE { bytes, max }` · `LEDGER_IMPORT_TOO_MANY_ROWS { rows, max }` · `LEDGER_IMPORT_TOO_MANY_ENTRIES { entries, max }` | > 20 MiB · > 250.000 filas (o > 20.000 filas en un borrador `post: false`) · > 20.000 asientos | trocear por meses; CLI (§7); contabilizar directamente en vez de guardar borrador |
| 400 | `LEDGER_IMPORT_COMPANY_MISMATCH { fileCompany, entity }` | empresa / NIF del fichero ≠ sociedad de la organización | comprobar la empresa exportada en Sage o `--entity` |
| 400 | `LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts }` · `LEDGER_IMPORT_ACCOUNT_CODE_INVALID { accountCode }` · `LEDGER_IMPORT_MAP_INVALID { errors }` | cuentas Sage sin mapear o bloqueadas · cuenta destino fuera del patrón, inexistente o no postable · mapa mal formado | paso «Cuentas» / `PUT …/account-map` (§4.1) |
| 400 | `LEDGER_IMPORT_ANALYTICS_UNMAPPED { codes }` · `LEDGER_IMPORT_CENTRE_REQUIRED { entries }` | códigos analíticos sin centro · asientos con líneas 6/7 sin centro y política `block` | paso «Analítica» / `PUT …/analytics-map`, o política `office` (§4.2) |
| 400 | `LEDGER_IMPORT_UNBALANCED { entries }` | asientos Sage con debe ≠ haber (exportación truncada o filtrada) | reexportar el mes completo desde Sage |
| 400 | `LEDGER_IMPORT_YEAR_CODE_INVALID { code }` | ejercicio ≠ año natural `YYYY` | ejercicio partido: fuera de alcance (§10) |
| 409 | `LEDGER_IMPORT_DUPLICATE { importId, fileName, createdAt }` · `LEDGER_IMPORT_OVERLAP { overlaps }` | mismo hash vivo · lotes que ya cubren asientos del fichero (journal / balances por clave Sage, vat_books por fila de libro) · `balances` sobre un ejercicio con diario o apertura importados, o `journal` sobre uno con saldos importados (`{ overlaps, fiscalYearCode }`, sin `replace`) | ver arriba; `replace` solo con el rango completo; el cruce saldos / diario exige revertir el lote anterior |
| 409 | `LEDGER_IMPORT_ENTRY_EXISTS { journalEntryId, sourceId }` | el motor encontró un asiento vivo con esa clave fuera del lote (defensivo) | revisar el asiento indicado en el diario |
| 409 | `LEDGER_IMPORT_ALREADY_POSTED` · `LEDGER_IMPORT_REVERSED` · `LEDGER_IMPORT_NOT_POSTED` | contabilizar un lote ya `posted` · contabilizar o revertir un lote `reversed` · revertir un lote que no está `posted` | nada que hacer (el estado del lote ya es el pedido) o crear un lote nuevo |
| 409 | `LEDGER_IMPORT_VAT_SETTINGS_MISSING` | sin fila `vat_settings` | ver arriba (decisión de César) |
| 409 | `FISCAL_YEAR_CLOSED_FROM_IMPORT { fiscalYearId, importId }` | reabrir un ejercicio cerrado por un lote importado; cerrar con `closeFiscalYear` un ejercicio que ya tiene regularización / cierre importados | revertir el lote (§5.4) o importar «ejercicios» |
| 404 | `LEDGER_IMPORT_NOT_FOUND` · `LEDGER_RECONCILIATION_NOT_FOUND` | opacos: lote / reconciliación inexistente o de otra organización | comprobar el id y el ámbito |
| 400 / 404 / 409 | del motor: `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_POSTABLE`, `WORK_CENTER_REQUIRED`, `PROPERTY_NOT_FOUND` (404 opaco), `FISCAL_PERIOD_CLOSED`, `FISCAL_YEAR_CLOSED`, `JOURNAL_UNBALANCED` | el lote valida antes, así que solo aparecen por carreras (periodo cerrado entre la preview y el apply) o mapas editados a mano | rollback del lote entero; repetir la preview |

## 10 · Límites y decisiones para César (diseño §10.1)

| # | Decisión | Por defecto en esta tanda | Efecto si cambia |
| --- | --- | --- | --- |
| 1 | Subcuentas por tercero (`430.x` / `400.x`) o colapso a `4300` / `400` / `410` | Colapso con el tercero en la descripción (`CUSTOMER_ACCOUNT_CODE` y `ACCOUNT_CODE_PATTERN` lo imponen hoy) | `create` en el mapa + reimportar con `replace`; el 347 no cambia (usa `counterpartyNif`) |
| 2 | Dimensión de centro y política de apuntes 6/7 sin analítica | `delegacion` y `block` | `office` manda a OC lo no imputado (como el coste de personal) |
| 3 | Reparto de líneas de balance por centro en asientos multi-hotel | Proporcional a Σ\|6/7\| | Alternativa: un solo asiento en el centro dominante (balance por centro más fiel al de Sage, PyG idéntico) |
| 4 | Nómina real de Sage frente al lote de coste de personal 2026-01..08 | La preview avisa; nada se reversa solo | Reversar el lote entero (§18.5) o bloquear 640 / 642 / 465 / 476 en el mapa para ese rango |
| 5 | Facturas de RA emitidas en ehotelOS durante la sombra | Se excluyen del lote de Sage (§5.1) | Si Sage debe mandar también en RA, cerrar los periodos en ehotelOS y no proyectar |
| 6 | Ejercicios antiguos: diario completo o solo saldos | Saldos (§3 paso 6) para lo anterior al primer ejercicio con diario | El diario completo antiguo cabe por tramos (XML / SQL), con más tiempo de carga |
| 7 | Fecha de relevo y criterio de «reconciliado» | Dos cierres mensuales `ok` + un trimestre declarado | — |
| 8 | Periodicidad y régimen de IVA (`vat_settings`, hoy sin fila) | El importador **no** decide: 409 hasta que exista la fila | Fija el `period` de los libros importados y el 303 |

**Resueltas por administración (nota del 2026-09-18, formato real confirmado):** Sage 200 **2026.85.000**
(necesidad 2 de §1.1); cuentas de **10 dígitos** con el **hotel en la sexta cifra** (`PPP AA H SSSS`; los
proveedores van ordenados alfabéticamente dentro de cada hotel con esa misma cifra: reglas 2-4 y 6 del mapa
de §4.1 sobre 10 cifras, necesidad 4); **no usan analítica**: las **delegaciones** separan gastos e ingresos
por hotel (decisión 2 → `centreDimension = delegacion` y política `office` para lo no imputado, necesidad 3);
los **departamentos** son los de RR. HH. para las nóminas (`costCentreDimension = departamento` solo en 64x);
el **347** se presenta desde Sage solo en la parte de proveedores (el 347 de ehotelOS se calcula con el NIF del
libro de recibidas, `counterpartyNif`); el **libro de emitidas** llega **mensual** (el anual daba error por
tamaño) y el plan de cuentas **no exporta el NIF** (se toma de Clientes / Proveedores). Decisión 4: el
informe de coste de personal lee `payroll_cost_lines` de lotes `posted` y no el diario, así que el lote de
nómina 2026 se reversa entero antes del diario real de 2026 y el mes sin diario de Sage se recarga solo;
límite conocido: al reversar, el informe deja de ver los meses reversados (no hay modo «sombra» en el lote
de nómina). Decisión 8: la fila `vat_settings` existe ya en la BD local (trimestral).

Límites conocidos que no cierra el código: columnas de los Excel de Sage y estructura del XML
sin documentar (hueco 1-2 del diseño §10.3: parser por sinónimos y `LEDGER_IMPORT_XML_UNSUPPORTED`
hasta la exportación real); reconciliación por centro solo con la «Hoja adicional
canales/delegaciones» (hueco 7); ejercicio partido (no natural) no soportado
(`LEDGER_IMPORT_YEAR_CODE_INVALID`); cadencia diaria solo con SQL o buzón XML (fuera de alcance);
el rollback de un lote no retira los eventos `JournalEntryPosted` que el motor encola por asiento
antes del commit (comportamiento heredado del lote de nómina; el evento de lote
`LEDGER_IMPORT_POSTED` se emite tras el commit); un `vat_books` en un periodo con filas
importadas convierte el libro en «libros» para ese periodo (`loadVatBookRows`), así que los
documentos propios del mismo periodo deben tener sus filas materializadas (los escritores ya lo
hacen).

## 11 · Recorrido de la demo del integrador (L6, 2026-09-17) y prerrequisitos que la demo dejó claros

Dataset sintético reproducible: `corepack pnpm --filter @hotelos/api exec node --env-file-if-exists=../../.env --import tsx src/scripts/generate-sage200-demo.ts --out <raíz git>/pilots/faranda-celuisma/sage200-demo --organization <orgId>` (semilla fija; 43 ficheros: plan, terceros, aperturas 2025/2026, diario 2025 por meses + cierre, diario 2026 ene-jul, libros de IVA por trimestre, sumas y saldos 2024 anual / 2025 y 2026 mensuales, variantes `.xlsx` e IME del mismo contenido). Salida íntegra del CLI en `<raíz git>/pilots/faranda-celuisma/SAGE200-DEMO-2026-09-17.md`; informe en `docs/audits/TANDA-7C-SAGE200-2026-09-17.md`.

**Antes del primer lote (dos escrituras que el importador nunca hace solo):**

1. `vat_settings` de la organización (decisión de César, §9): la demo la creó con `updateVatSettings({ periodicity: "quarterly", regime: "general" })`; sin fila, `vat_books` responde 409 `LEDGER_IMPORT_VAT_SETTINGS_MISSING`.
2. Mapa analítico persistido (`PUT /accounting/ledger-imports/analytics-map`): `centreDimension delegacion`, `costCentreDimension departamento`, `unassignedPolicy office`, 8 delegaciones → centros y 6 departamentos → centros de coste. Sin él, la previsualización sugiere los centros por igualdad de código (AS…RA) y los departamentos por sinónimo, pero la política de apuntes 6/7 sin analítica queda en `block` (o `--unassigned office` en cada lote).

**Antes de cargar el libro de IVA de un periodo con documentos propios:** materializa los libros nativos de ese rango (`POST /fiscal/vat-books/rebuild { from, to }` o `rebuildVatBooks`): con filas `sage200` en el periodo el 303 sale de los LIBROS y una factura propia sin fila materializada deja de contar. En la demo, las 25 facturas de Rías Altas (2026-07..09) tenían 0 filas hasta el rebuild (37 filas de emitidas creadas; las 2.918 filas `sage200` se conservaron).

**Orden ejecutado y resultado:** `plan` (3 subcuentas creadas: 622.1, 629.5, 705.5; el `.xlsx` da el mismo hash) → `fiscal_years` 2025 (apertura 232 apuntes, asiento 2025/1) → `journal` 2025-01…12 (2.543 asientos, nº 2 → 2544) → `journal` cierre 2025 (regularización 2545 y cierre 2546; ejercicio 2025 cerrado con 12 periodos) → `vat_books` 2025 Q1…Q4 (1.841 filas) → `third_parties` (26) → `balances` 2024 (11 asientos: apertura, 8 resúmenes por centro, regularización y cierre; 2024 cerrado) → reconciliación 2025 **ok** (56 cuentas, también por trimestre y por mes) → `fiscal_years` 2026 (asiento 2026/113 tras los 112 nativos) → `journal` 2026-01…07 (julio excluye la factura `FAC-2026-000001` por serie + número y su cobro por importe y fecha) → `vat_books` 2026 Q1, Q2 y Q3 parcial (la emitida nativa se omite) → reconciliación 2026 ene-jul **ok** (55 cuentas; también mes a mes) → reverso del lote de marzo (idempotente al repetirlo) y reimportación idéntica (claves `…#1`) → 303 2026-Q2 desde los libros (casilla 71 = 462.766,50 = liquidación del diario).

**Dos correcciones de código con test que salieron de la demo:** (1) el índice de documentos nativos solo tomaba los cobros ligados a una factura (`invoiceId`), y el cobro de un folio se proyecta ANTES de facturar: ahora usa el mismo filtro que la proyección (`captured | refunded`, sin reverso, con o sin factura) y añade las devoluciones completadas (`ledger-import.native.ts`, test `ledger-import-native.test.mts`); (2) la reconciliación de un mes suelto clasificaba «falta en ehotelOS» las cuentas 6/7 sin movimiento en el mes pero con neto acumulado del ejercicio (la prima de seguros trimestral en febrero): `mergeLedgerRows` las incluye con Debe / Haber 0,00 y su saldo (`ledger-reconciliation.service.ts`).

**Límites vistos en la demo (no son errores del lote):** la reconciliación **por centro** (`--property RA`) solo es concluyente en las cuentas 6/7 y en los Debe / Haber de 1-5: la apertura y las liquidaciones de IVA son asientos de sociedad y el reparto proporcional de las filas sin delegación del lote `balances` no sigue la delegación de Sage, así que los saldos 1-5 por centro difieren por construcción (44 cuentas comparadas, 16 diferencias en 2025 para RA, todas de grupos 1-5); el cotejo diario↔libros del 303 (`fuentes.diario`) suma 0 en los trimestres cuya liquidación de IVA de Sage se ha importado como asiento normal (`sage200_journal` no es `vat_settlement` y el cotejo no la excluye), aunque el 303 desde libros es correcto; y con la nómina de 2026 de AS LT MC OC PG RA ya devengada por el lote de coste de personal, los devengos de Sage de esos centros se dejaron fuera del diario importable (`diario/no-importar/`) y el balance de Sage los incluye con las mismas cifras (§10.1-4).
