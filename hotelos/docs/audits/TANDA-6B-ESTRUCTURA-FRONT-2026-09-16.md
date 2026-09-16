# Tanda 6b · Estructura societaria (front) · Cierre — 16 de septiembre de 2026

**Para:** César. **Encargo (literal):** «distinguir grupo hotelero u hotel
individual» — Faranda = CELUISMA S.A., oficina central + hoteles bajo un solo
NIF — llevado a la pantalla. El backend quedó commiteado en `b47d98a`
(`docs/audits/TANDA-6B-ESTRUCTURA-BACKEND-2026-09-16.md`); este documento
cierra la **mitad front**: qué ve ya Carmen en Anfitorio, cómo se dan de alta
la oficina central y los cinco hoteles cuando aportes los datos (L8, con los
comandos), qué encontró la verificación con navegador y en qué estado queda
cada hallazgo, y qué falta.

**Método:** tres lotes de construcción en paralelo (L6 «Configuración ›
Estructura societaria» · L7 «Ámbito único en Finanzas y Cumplimiento» · L9
tests de integración y contratos, con L8 «Migración Faranda → CELUISMA» en su
propio carril), una integración intermedia, una verificación adversarial con
navegador (12 hallazgos confirmados: `qa#1`, `#2`, `#4`, `#5`, `#6`, `#7`,
`#9`, `#10`, `#11`, `#12`, `#14`, `#15`), tres lotes de corrección
(`fix:L6`, `fix:L7`, `fix:primitives`) y este cierre (integrador **sin
navegador**). Todo sobre la demo local (Postgres local; API :3000 reiniciado
con el backend de la tanda; Vite :5173 con recarga en caliente). **Ninguna
escritura en los datos de Faranda** (solo lecturas con la sesión de Carmen y
consultas SQL de solo lectura): las pruebas que escriben usaron `org_123` con
la cuenta admin y restauraron lo restaurable, o crearon y borraron su propia
organización (§5). **Sin commit**: todo está en el árbol de trabajo de
`hotelos/`.

Operativa: `docs/runbooks/finanzas-contabilidad.md` §17.12 (qué consume el
front y qué fijan los tests) y §17.13 (migración L8 paso a paso); diseño
`docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md` §5.3 (UX) y §6 (lotes y
criterios de cierre); gramática visual `docs/design/COCOA-22.md`.

## 1. Resumen en cifras

| Métrica | Valor |
|---|---|
| Pantallas nuevas (una entrada de menú, cinco pestañas) | `/configuracion/estructura-societaria` + `/centros` · `/series-verifactu` · `/iva-ejercicio` · `/reparto`; Configuración pasa de 10 a **11 ítems** (máximo 12) |
| Pantallas de Finanzas y Cumplimiento con el selector «Ámbito» | **26** (Contabilidad 5 · Estados contables 7 · Tesorería y bancos 3 · Proveedores, gastos, inmovilizado, nóminas y comisiones 6 · Facturación y TPV 2 · Modelos AEAT, libros y liquidación 3) |
| Ficheros nuevos del front | 20 (`screens/structure/**` 9 ficheros · 3.411 líneas; `services/structureApi.ts` 293; `services/financeScope.ts` 694; `components/finance/FinanceScopeSelector.tsx` 99; contenedor `EstructuraSocietariaTabs.tsx` 33; 7 ficheros de tests unitarios) |
| Ficheros modificados del front | 58 (26 pantallas de dinero, 5 primitivas Cocoa, 3 hojas de estilo, shell, contenedores, navegación, tests) |
| Tests nuevos de la tanda (front + integración + contratos) | unitarios front +247 (692 → 939) · integración +43 (`structure-e2e` 29 · `structure-l6-l7-contract` 14) · contratos +14 (`legal-structure-contract`) · unitarios api +16 (`structure-read-scope`) |
| Deuda Cocoa 22 | 224 pantallas · 88.428 líneas · **1.912 puntos** (sin cambio: las 8 pantallas nuevas nacen a 0 puntos; `inlineStyles` 1.833 → 1.832) |
| Códigos de error del API con texto en pantalla | +33 en `FINANCE_ERROR_MESSAGES` (todos los de la estructura: `SERIES_PREFIX_CLASH`, `WORK_CENTER_REQUIRED`, `ENTITY_SCOPE_REQUIRED`, `HIGH_RISK_CONFIRMATION_REQUIRED`, `VERIFACTU_EXCLUDED_BY_SII`…) |
| Hallazgos de la QA con navegador | 12 confirmados (2 media · 10 baja) → **12 corregidos** (§4) |
| Faranda | idéntica antes y después de todas las suites (25 facturas · 61 asientos / 150 líneas / Σ 2.595,00 · 33 envíos · 2 centros · 4 series · 1 instalación; sociedad `FAR` `updated_at` 2026-09-16 07:25:05 sin cambios) |

Cifras del working tree (sin commit, antes de este informe): 72 ficheros
modificados (+2.460 / −634 líneas) y 31 nuevos (11.388 líneas: 20 del front,
6 specs y el CLI de L8 con sus tests, 4 suites de L9); `pnpm-lock.yaml` figura
modificado por otra sesión anterior (dependencias ya declaradas; `install
--frozen-lockfile --offline` al día) y ningún lote de esta tanda lo tocó.

## 2. Qué ve ya Carmen (recorrido por pantalla, con URL)

Carmen es Owner de Faranda: la estructura le responde `mode: multi_center`
(dos hoteles bajo una sociedad) y `scope: entity` (Finanzas de toda la
sociedad). Los datos que ve hoy son los del backfill de la tanda anterior:
sociedad `FAR` «Faranda Hotels & Resorts» con el NIF **ficticio** B99999997
(el real entra solo con tu consentimiento en L8), centros `RA` (Hotel Faranda
Rías Altas by Ascend Collection, Perillo · Oleiros) y `LT` (Faranda Los Tilos,
Ascend Hotel Collection, Teo).

### 2.1 Configuración › Estructura societaria (nuevo; roles Dirección y Administración; Finanzas en lectura)

| Pestaña · URL | Qué ve y qué puede hacer |
|---|---|
| **Datos fiscales** · `/configuracion/estructura-societaria` | Tarjeta «Sociedad» (razón social, NIF con etiqueta «válido», forma jurídica, plantilla PGC Pymes, IVA trimestral, régimen general, cadena VeriFactu «por centro», «2 hoteles · 0 oficinas · 0 otros»). Formulario de identidad (razón social, NIF con comprobación de la letra de control mientras escribe, código, forma jurídica, CNAE, CCC), domicilio fiscal, domicilio social (interruptor «difiere del fiscal») y Registro Mercantil. Cambiar el NIF o la razón social abre un diálogo de confirmación de alto riesgo con la base legal; el guardado avisa si alguna serie queda bloqueada con el NIF anterior. Es **la única pantalla** que edita el NIF: el perfil de cada hotel ya no lo muestra editable |
| **Centros** · `…/centros` | Tres indicadores (centros, hoteles abiertos, colisiones de serie: hoy **0**), tablas «Hoteles» y «Centros no alojativos» (código · centro · tipo · municipio · series · VeriFactu · estado). Clic en un centro abre su ficha: «Factura como Faranda Hotels & Resorts · B99999997 — Editar en Datos fiscales», tipo, código, nombre comercial y censo (catastro, superficie, IAE, CCC, centro laboral; hotel: plazas, categoría, meses de apertura, registro turístico, SES); series e instalación en solo lectura; no existe «Mover a otra sociedad». Botón **«Añadir centro»**: asistente en cuatro pasos (tipo y nombre → ubicación fiscal → facturación con las series propuestas y la comprobación en vivo «Libre» / «Ya usado por …» → resumen) que crea el centro y ofrece «Configurar habitaciones» o «Abrir Finanzas en este centro». Una oficina salta el paso de facturación (no emite) |
| **Series y VeriFactu** · `…/series-verifactu` | Series de toda la sociedad en una tabla (RA: `FAC-2026-` siguiente 23 y `REC-2026-` 4; LT: `FAC-LT-2026-` y `REC-LT-2026-` 1) con la etiqueta «colisión» cuando dos centros comparten prefijo (hoy ninguna); acciones «Cerrar serie» / «Reabrir» con confirmación (nunca se renumera). Instalaciones VeriFactu por centro: `DEV-001` en Rías Altas (número inmutable con botón «Copiar»), envíos y última factura. La política de cadena se muestra como texto («Cadena por centro · fijada por Anfitorio»), no como control |
| **IVA y ejercicio** · `…/iva-ejercicio` | Régimen de la sociedad: periodicidad efectiva (trimestral), «Gran empresa» y «Sociedad acogida al SII» como interruptores con ayuda debajo (cambiarlos exige confirmación de alto riesgo y se bloquea si hay registros VeriFactu reales sin respuesta), plantilla PGC, mes de inicio del ejercicio; propuesta de régimen al cierre (`GET /fiscal/regime`, umbral 6.010.121,04 €); ajustes de IVA de la sociedad. En SII: 303 mensual forzado, 347 y 390 «no se presenta», VeriFactu «no aplica» |
| **Reparto** · `…/reparto` | Clave de reparto informativo de la oficina central entre hoteles (ninguna · ingresos · habitaciones · plantilla · porcentajes con tabla que suma 100). Solo afecta a la fila «Reparto corporativo (informativo · no contabilizado)» de USALI y PyG por centro: cero asientos |

Un usuario con rol en un solo hotel (sin «Finanzas de toda la sociedad») ve la
misma entrada **redactada**: aviso «Ves solo tus centros», sin NIF ni series ni
instalaciones, y nunca un «NIF pendiente» falso.

### 2.2 Finanzas y Cumplimiento con el ámbito único (L7)

Todas las pantallas de dinero llevan en la fila de acciones el mismo selector
**«Ámbito»**: «Sociedad · Faranda Hotels & Resorts (todo)», «Centro · Hotel
Faranda Rías Altas (RA)», «Centro · Faranda Los Tilos (LT)» (y «Centro ·
Oficina central (OC)» cuando exista). El ámbito es independiente del hotel
activo del menú superior (cambiar de hotel no cambia el ámbito) y se
recuerda; la cabecera del contenedor dice «Finanzas · Faranda Hotels &
Resorts» o «Finanzas · Hotel Faranda Rías Altas» según lo elegido. Las
palabras «Propiedad» / «Toda la organización» desaparecen de Finanzas.

| Familia (URL) | Ámbito | Qué añade |
|---|---|---|
| Modelos AEAT, libros de IVA, liquidación (`/cumplimiento/modelos-aeat/**`) | **forzado a Sociedad** (el declarante es el NIF) | Badge «Declarante: Faranda Hotels & Resorts · B99999997»; aviso de régimen (SII / gran empresa) cuando aplique; «Desglose por centro» como vista parcial marcada «no liquidable»; motivo «no se presenta» en 347 / 390 bajo el SII; sección Declarante con enlace a Estructura societaria › Datos fiscales; selectores de trimestre / mes / ejercicio en línea (qa#6) |
| Diario, mayor, balance de sumas y saldos, PyG, USALI, posición de tesorería, nóminas (`/finanzas/contabilidad/**`, `/finanzas/estados-contables/**`, `/finanzas/tesoreria/**`) | Sociedad por defecto, filtrable por centro | Columna / detalle «Centro de trabajo»; etiquetas «Oficina central», «Sociedad (sin centro)», «Total sociedad»; USALI con vista «Por centro», roll-up y fila de reparto informativo; PyG por centro; asiento manual «de sociedad» (`societyLevel`); nóminas con bloque empleador (NIF · razón social · CCC) |
| Plan de cuentas, ajustes contables, cierre de ejercicio, exportación a gestoría, balance, flujos, cuentas anuales, proveedores | **forzado a Sociedad** | Cuentas anuales con `entityLabel` y bloqueo «no depositable» (gran empresa o PGC general con plantilla Pymes); memoria con la lista de establecimientos |
| Facturación y cobros, cierre de caja, conciliación, extractos, comisiones, facturas recibidas, gastos, inmovilizado | Centro por defecto (la oficina central nunca aparece: no emite ni tiene caja) | Detalle de factura con «Establecimiento: <nombre comercial> (<código>) · <dirección>» y «VeriFactu no aplica (SII)» cuando corresponda; con una oficina activa en el menú, estas pantallas esperan a conocer la estructura y caen al primer hotel sin pedir datos a la oficina (qa#11) |

### 2.3 Menú superior, perfil del hotel y consola

- El **selector de hotel** del shell agrupa «Hoteles» y «Centros no alojativos»
  bajo la sociedad; con una oficina activa aparece el banner «Oficina central:
  sin operación hotelera» con el acceso directo a Finanzas.
- El **perfil del establecimiento** (`/configuracion/establecimiento`) muestra
  «Nombre comercial (en factura)» y el código; el NIF y la razón social solo
  se leen y enlazan a Estructura societaria (el API responde 409
  `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY` si algo intenta cambiarlos).
- La **consola de plataforma** (`/configuracion/sistema/organizaciones`) da de
  alta una organización con su sociedad (razón social, NIF, código, forma
  jurídica) y el primer centro codificado; la ficha del tenant muestra la
  sociedad y fija la política de cadena VeriFactu con confirmación.

### 2.4 Hotel individual (contrato de producto, diseño §5.6)

Con un solo hotel (`mode: single_hotel`) no hay selector de ámbito, ni columna
«Centro», ni la palabra «Oficina» en ningún sitio: la misma entrada de
Configuración muestra la tarjeta «Tu sociedad» y la fila «Este hotel», la
serie sigue siendo `FAC-2026-` y los informes dan las mismas cifras que antes.
No existe en la BD local (org_123 y Faranda tienen dos hoteles cada una): está
cubierto por los unitarios de `financeScope` y por el bloque A de la e2e
(`structure-e2e.test.mts`: organización creada con `createTenant`).

## 3. Cómo se dan de alta la oficina central y los cinco hoteles (L8)

Nada de esto se ejecuta sin tus datos: el CLI `migrate-faranda-celuisma.ts`
está construido, probado en seco contra la BD local (**873 escrituras · 0
errores · 0 colisiones**; plan literal en
`/Users/cfernandez/anfitorio-demo/pilots/faranda-celuisma/PLAN-DRY-RUN-2026-09-16.md`,
fuera del repo porque lleva el CIF real) y se niega a aplicar mientras falte
el domicilio fiscal. Detalle en el runbook §17.13.

### 3.1 Lo que falta por tu parte (informe backend §8, resumido)

| # | Dato | Por qué lo necesita el script |
|---|---|---|
| 1 | **Domicilio fiscal** de CELUISMA S.A. (Gijón · Avenida de Portugal 7; Madrid · General Ampudia 8; o Madrid · Paseo de la Florida 5) y domicilio social si difiere; Registro Mercantil, CNAE, CCC principal | Sin `--fiscal-address` el apply termina con salida 2: las fuentes públicas no coinciden |
| 2 | **Consentimiento** para usar A33615980 en la demo local | Ya autorizado para la demo local; nunca se remite a la AEAT |
| 3 | **Lista definitiva de hoteles** (hoy: Pathos Gijón `PG`, Marsol Candás `MC`, Alisas Santander `AS`, Florida Norte `FN`, Las Lomas `LL`) con dirección, categoría, habitaciones, registro turístico, SES, CCC provincial, catastro e IAE | Specs `apps/api/src/scripts/specs/faranda-*.json` (los campos que faltan van a `null` hasta que lleguen) |
| 4 | **Sede de la oficina central** (Madrid o Gijón), superficie y CCC | `--office-city`; nóminas, gastos y bancos de la sede cuelgan de ella |
| 5-6 | Cifras 2024-2025 (activo, cifra de negocios, plantilla), régimen de IVA (trimestral / mensual / SII), inicio del ejercicio | Deciden PGC general vs Pymes, gran empresa / SII y el ejercicio 2026: el script **no** los toca (paso 7 sin escrituras) |
| 7-9 | Otra sociedad del grupo; clave de reparto de la oficina; decisión del asesor sobre la cadena VeriFactu (por centro / por sociedad) | Fase grupo, pestaña «Reparto», política de cadena desde la consola |
| 10-11 | Números de instalación reales del registro del productor; confirmación para cerrar `FAC-2026-` / `REC-2026-` de Rías Altas y abrir `FAC-RA-2026-`, `REC-RA-2026-`, `FS-RA-2026-` | Paso 6 (series) y, antes de preproducción, retirada de `DEV-*` |
| 12-14 | Personas y roles por centro; ventana para el VPS (backup, API parado); decisiones sobre org_123 (serie de `prop_canary`, factura duplicada) | Paso 10 y precondición de los índices únicos aplazados |

### 3.2 Pasos y comandos (desde `hotelos/`, solo `corepack pnpm`)

```bash
# 1. Plan en seco (por defecto): 11 pasos, conteos, colisiones y decisiones abiertas. No escribe.
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --json > plan.json
#    Con tus respuestas: --fiscal-address gijon|madrid|florida [--registered-office …] [--office-city madrid|gijon|florida]
#    [--skip-hotels PG,MC] [--sandbox-installations]

# 2. Tú confirmas el plan (direcciones, régimen, cadena, personas) sobre PLAN-DRY-RUN-2026-09-16.md.

# 3. Apply (integrador humano, con backup y API :3000/:3400 parados; cada paso es su propia transacción
#    y deja un evento FARANDA_CELUISMA_MIGRATION_STEP con correlación corr_faranda_celuisma_l8):
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --apply --confirm cmrhw9jy30002fyvb6tsdiugt --fiscal-address gijon

# 4. Reiniciar UNA instancia del API y repetir el paso 1 con los mismos flags: debe planificar 0 escrituras.

# 5. Comprobaciones: GET /organizations/me/structure → mode multi_center · counts.properties 8 (7 hoteles + 1 oficina);
#    GET /legal-entities/:id/series → clashCount 0; GET /fiscal/models/303?year=2026&period=Q3 → declarante CELUISMA S.A.
#    con las MISMAS cifras (27 = 71 = 74,94); emitir una factura de prueba en RA (sandbox) → FAC-RA-2026-000001.

# 6. Deshacer (solo lectura: lista qué escribió el apply y cómo revertir cada paso):
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --print-rollback
```

Qué hace cada paso: 2 sociedad `FAR` → `CEL` «CELUISMA S.A.» A33615980, `sa`,
CNAE 5510 (NIF y razón social = alto riesgo con `confirmHighRisk`; domicilios
solo con los flags) · 3 censo de RA y LT (categoría, plazas, registro turístico)
· 4 oficina central `OC` (8 filas, sin habitaciones ni series) · 5 cinco
hoteles (857 filas: 720 habitaciones y 15 series `FAC/REC/FS-<COD>-2026-`, uno
por transacción) · 6 series de Rías Altas (cerrar las sandbox y abrir las
`-RA-`; **ninguna factura se renumera**) · 7 IVA y ejercicio sin escrituras · 8
instalaciones VeriFactu: 0 por defecto (se abren al activar VeriFactu en cada
hotel; RA conserva `DEV-001`) · 9-11 comprobaciones. Idempotente (una segunda
pasada planifica 0) y reversible (§17.13).

**Qué verá Carmen después:** en Centros, 7 hoteles y la oficina central con sus
códigos y series; en Series y VeriFactu, 20 series activas y 0 colisiones; en
Datos fiscales, CELUISMA S.A. · A33615980; en el selector «Ámbito», los ocho
centros bajo la sociedad; en Modelos AEAT, el declarante CELUISMA S.A. con las
mismas cifras de hoy.

**Alternativa sin CLI (un centro suelto):** Configuración › Estructura
societaria › Centros › «Añadir centro». El asistente comprueba en vivo las
series propuestas contra las de toda la sociedad y crea el centro con el mismo
servicio que usa el CLI. Un hotel creado así nace con VeriFactu activado y sin
fila de instalación: en sandbox emite con el número del entorno; antes de
preproducción hay que abrir su instalación real (deuda §17.10).

## 4. Hallazgos de la QA con navegador y estado (12 confirmados · 12 corregidos)

| Id | Sev. | Lote | Hallazgo | Corrección (fichero) |
|---|---|---|---|---|
| qa#1 | media | fix:L7 | USALI a 1440: el control segmentado de vistas se recortaba («Mapeo de cuentas» cortado) | `screens/tabs/tab-helpers.tsx` (`HostedHead`): la columna izquierda toma el ancho de sus vistas y las acciones bajan de línea a la derecha; `CocoaSegmentedControl.tsx` con `box-sizing: border-box` |
| qa#2 | media | fix:L6 | IVA y ejercicio a 390: «Gran empresa» se partía a mitad de palabra | Primitiva `CocoaField` en línea: rejilla `minmax(0, 1fr) auto` con la ayuda debajo de la etiqueta (`styles/cocoa-22.css`); corrige los ~20 usos de `inline` + ayuda del producto sin tocar sus pantallas; test en `CocoaSection.test.mts` |
| qa#4 | baja | fix:L6 | Concordancia: «Oficina «Oficina de prueba» creado» | `propertyCreatedTitle` (`structure-ui.ts:123`): «Oficina … creada» · «Hotel … creado» · «Centro … creado»; test |
| qa#5 | baja | fix:L6 | Frases legales largas en `cocoa-caption` (10 px, mayúsculas) | Utilidad nueva `.cocoa-note` (`styles/cocoa-base.css:124`: 12 px, sin mayúsculas); pies de sección como texto plano en Datos fiscales, Series y VeriFactu; `cocoa-caption` queda para etiquetas cortas |
| qa#6 | baja | fix:L7 | Modelos AEAT a 1440: los selectores Trimestre / Ejercicio / Desglose ocupaban el 100 % apilados | Prop `inline` de `CocoaSelect` (ancho de la opción más larga) en los 4 selectores de `FiscalModelReport.tsx`, 3 de `VatSettlementScreen.tsx` y 3 de `VatBooksScreen.tsx`; documentado en `COCOA-22.md` §8 |
| qa#7 | baja | fix:primitives | Botón relleno de acento: blanco sobre #0d8a5f = 4,36:1 (< 4,5 AA) en tema claro | Token `--cocoa-accent-fill` (#0b7a54 en claro = 5,35:1; el acento oscuro se mantiene) en los tres bloques de `cocoa-tokens.css`; `CocoaButton.tsx` lo usa como fondo del relleno; test de contraste en `CocoaControls.test.mts` |
| qa#9 | baja | fix:L6 | Ficha del centro: Escape cerraba con cambios sin guardar | Esc, el fondo y «Cancelar» abren «¿Descartar los cambios?» mientras el formulario tiene cambios (`PropertyDrawer.tsx`) |
| qa#10 | baja | fix:L6 | Asistente «Añadir centro»: el foco inicial caía en «Cerrar» | `initialFocus` al campo «Nombre del hotel/centro» (`AddPropertyDrawer.tsx:611`); en la ficha, al selector «Tipo» (o «Cerrar» en solo lectura) |
| qa#11 | baja | fix:L7 | Facturación y Cierre de caja con una oficina activa pedían datos al centro no operativo antes de caer al hotel | Los efectos de carga esperan a `useFinanceScope().loading === false` (`BillingCenterScreen.tsx:377`, `CashClosureScreen.tsx:207-222`); regla documentada en `financeScope.ts` |
| qa#12 | baja | fix:L7 | La cabecera alojada seguía diciendo «Finanzas» sin «· <sociedad>» | `useHostedEyebrow` en `TabHost.tsx` (lo llaman `CocoaPage` y `HostedHead`); `NavItemTabs.tsx` pinta «Finanzas · <sociedad o centro>» / «Cumplimiento · …» solo cuando prolonga su categoría |
| qa#14 | baja | fix:primitives | La sonda §5.4 daba falsos positivos de contraste con fondos `color(srgb … / a)` (callouts) | La sonda compone las capas translúcidas sobre el primer fondo opaco y entiende `color(srgb)` (`COCOA-22-MIGRACION.md` §5.4); cierra el pendiente 22 de la Tanda B |
| qa#15 | baja | fix:L6 | «Copiar» número de instalación: al fallar el portapapeles solo había un aviso de error | Alternativa `execCommand("copy")` y, si también falla, el número queda seleccionado con el aviso «cópialo con Ctrl+C o ⌘C» (`SeriesAndInstallationsTab.tsx:57-75`, `156-172`) |

Las 12 correcciones se verificaron con typecheck, contratos y unitarios (y las
de maquetación con un arnés en Chromium sin sesión); **la comprobación visual
en la app real con sesión queda pendiente** (§6): los lotes de corrección no
tenían navegador con sesión.

## 5. Puertas (2026-09-16, working tree completo, tras este cierre)

| Puerta | Resultado |
|---|---|
| `node scripts/typecheck-all.mjs --parallel 3` | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 14,0 s; `tsc --noEmit` de admin-web y de api: 0 errores |
| `node scripts/check-discoverability.mjs` | 224 screens · 188/188 URLs (67 ítems · 98 pestañas · 21 dev · 2 públicas) · 0 broken links · 31 en whitelist · placeholders 16/20 |
| `node scripts/build-nav-tree.mjs --check` | al día (67 ítems · 98 pestañas · 205 redirecciones; Configuración 11 ≤ 12) |
| `corepack pnpm test` (contratos, sin BD) | **445 tests · 445 pass · 0 fail** (93 suites) — antes de regenerar el inventario Cocoa: 444/445 (regla 15) |
| unitarios front (`apps/admin-web/src/**/__tests__/*.test.mts`) | **939 · 939 pass · 0 fail** (287 suites) |
| `corepack pnpm --filter @hotelos/api test` | **1.512 · 1.511 pass · 0 fail · 1 skipped** (preexistente; 466 suites) |
| `test:integration` (23 suites in-process sobre Postgres local) | 1.ª pasada: 337 · 331 pass · **1 fail** · 5 skipped — `structure-l6-l7-contract` «rollup totalUndistributed» leyó USALI de org_123 mientras suites hermanas contabilizaban asientos en org_123 (carrera de lectura, no defecto del código: la suite sola 14/14). 2.ª pasada completa: **337 · 332 pass · 0 fail · 5 skipped** (los 5 preexistentes: H2 sin folio abierto y los 4 de sesión limitada sin `INTEGRATION_RECEPTION_EMAIL`); `structure-e2e` 29/29 en ambas |
| Faranda y org_123 (SQL de solo lectura antes y después de las dos pasadas) | idénticos: 25 facturas · 61 asientos / 150 líneas / Σ 2.595,00 · 33 envíos · 2 centros · 4 series activas · 1 instalación; org_123 2 centros · 8 facturas · 1 factura recibida; 2 organizaciones en la BD (0 residuales) |
| Cocoa 22 (`tests/cocoa-22-contract.test.mjs`) | 18/18; inventario regenerado 224 pantallas · 88.428 líneas · 1.912 puntos; `NOT_MIGRATED` 68 = techo; techos 307 · 203 · 40 · 158 · 70 · 1.832; §6 del plan al día (68 pendientes · 24.545 líneas · 1.755 puntos · 8 lotes) |
| `node docs/design/cocoa-22-api.mjs --check` · `--typecheck-examples` | §8 al día (40 ficheros · 68 interfaces · 55 alias · 641 props · 162 funciones · 29 constantes) · 11 plantillas · 0 errores |
| `node scripts/env-census.mjs` · `validate-env.mjs .env --role app` | 137 leídas · 137 documentadas · en sincronía · contrato OK (14 avisos de valores de ejemplo) |
| `db:migrate:status` · `db:drift:check` · `check-migrations-vs-schema.mjs` | 8 migraciones aplicadas, «Database schema is up to date!» · «No difference detected.» · 266 tablas / 30 enums |
| `bash scripts/check-fresh-install.sh` | OK: 8 migraciones → 266 tablas, 1 organización, 79 permisos, sin drift, 4 funciones / 4 triggers (4 s) |
| `corepack pnpm install --frozen-lockfile --offline` | «Lockfile is up to date» · «Already up to date» |
| `rbac:sync -- --dry-run` | catálogo 223 claves · +0 · **0 roles por completar** (en local, el Owner de Faranda ya tiene `accounting.entity.read` y `organization.structure.manage`, Dirección y Contabilidad +1, Local Super Admin +2: el arranque del API con el backend de la tanda completó las plantillas; en el VPS ocurrirá al reiniciar el API tras el deploy) |
| `bash .husky/pre-commit` | discoverability + typecheck-all OK (20,6 s) |

Los servidores :3000 (backend de la tanda) y :5173 (Vite) siguen vivos; no se
reiniciaron en este cierre.

## 6. Pendientes (ordenados por lo que desbloquean)

1. **Verificación visual con sesión** (Carmen en :5173; 1440 y 390; claro y
   oscuro) de las cinco pestañas de Estructura societaria y de las 26 pantallas
   con «Ámbito», y de las 12 correcciones de §4: sonda §5.4 con `lowContrast`
   vacío (relleno del acento 5,35:1), «Gran empresa» en una línea a 390,
   selectores en línea en Modelos AEAT, cabecera «Finanzas · Faranda Hotels &
   Resorts», foco inicial del asistente, diálogo de descarte de la ficha,
   «Copiar» con portapapeles denegado. Y como usuario de un solo centro (rol
   real): estructura redactada, sin opción «Sociedad».
2. **L8 (Faranda → CELUISMA)**: bloqueado por los datos de §3.1; el CLI y los
   specs están listos y probados en seco. Antes de `VERIFACTU_MODE=preproduction`:
   retirar `DEV-*` y abrir las instalaciones reales (`SELECT count(*) FROM
   verifactu_installations WHERE active AND numero_instalacion LIKE 'DEV-%'`
   = 0).
3. **API**: (a) `GET /organizations/me/structure` no devuelve las columnas
   censales del centro, así que la ficha las arranca vacías y solo envía las
   rellenadas (añadir `establishment` a `StructureProperty` o exponer `GET
   /properties/:id/establishment`); (b) no existe ruta para archivar un centro
   (el de prueba de org_123 se retiró por SQL); (c) `/banking/*`, facturas
   recibidas, gastos, inmovilizado y comisiones no admiten `scope=entity`
   (por eso esas pantallas van «centro por defecto» y no «sociedad por
   defecto» como pedía el diseño; `bank_accounts.property_id DROP NOT NULL`
   sigue aplazado); (d) tipos compartidos sin los campos aditivos que el front
   lee con tipos locales: `PayrollExportResult.employer`, `TreasuryPosition
   { scope, entityLabel, legalEntityId, banks[].propertyId }`,
   `InvoiceIssuer { legalEntityId, fiscalAddress?, establishment,
   verifactuExclusion }`; (e) `financialStatementsApi` sin
   `compareUsaliProperties({ includeCorporate, allocation })` ni
   `getPnlByProperty` (USALI y PyG llaman a `apiRequest` directamente); (f) la
   activación de VeriFactu en un centro nuevo no abre su instalación (deuda
   §17.10, confirmada por la e2e).
4. **Front**: banner de shell «Estás viendo Finanzas de toda la sociedad»
   cuando ámbito y hotel activo difieren (`useFinanceScope().divergesFromActive`
   ya lo expone; no montado); el mismo patrón latente de qa#11 en
   `BankReconciliationScreen.tsx`, `BankingSpainScreen.tsx` y
   `CommissionsScreen.tsx` (esperar a `finance.loading`); adoptar
   `--cocoa-accent-fill` en el ítem seleccionado de `CocoaSidebar.tsx` y en el
   avatar de `BackOfficeLayout.tsx` (siguen a 4,36:1) y listarlo en la guía de
   estilo; botón relleno destructivo a 3,55:1 (patrón `--cocoa-danger-fill`);
   11 `cocoa-caption` de otras pantallas candidatos a `.cocoa-note`; `copyText`
   de `services/authApi.ts` sin la alternativa `execCommand`.
5. **Tests**: `structure-l6-l7-contract` lee org_123 sin BD en reposo y puede
   fallar por carrera con las suites que contabilizan en org_123 (visto una
   vez de dos pasadas); endurecer como la probe C9 (saltar con diagnóstico si
   los asientos de org_123 cambian entre las dos lecturas) o darle su propia
   organización; los `.mts` de tests no los cubre `tsc --noEmit` del API.
6. **Datos y despliegue**: `rbac:sync` en el VPS (lo hace el arranque del API
   tras el deploy; escribe `role_permissions` de Faranda); DDL aplazado
   (`SET NOT NULL`, índices únicos de prefijo y número por sociedad tras limpiar
   org_123); `pnpm-lock.yaml` modificado por otra sesión en el working tree.
7. **Documentación**: en este cierre se alineó la convención de series
   rectificativas (`REC-<COD>-2026-`, no `R-`) y los nombres de los specs
   (`faranda-florida-norte.json`, `faranda-las-lomas.json`) en el diseño §5.5 /
   §6 y en el informe backend §8; `docs/runbooks/estructura-societaria.md`
   (previsto en el diseño) no existe: todo vive en §17 del runbook de Finanzas.

## 7. Lo que hizo el integrador final (esta pasada)

Sin navegador, sin escrituras de negocio, sin dependencias nuevas, sin commit:

- Puertas completas repetidas (§5), incluida `test:integration` dos veces, con
  Faranda y org_123 comparados por SQL antes y después.
- Inventario Cocoa 22 regenerado (`node scripts/cocoa-22-inventory.mjs`:
  88.224 → 88.428 líneas por los lotes de corrección, 1.912 puntos sin cambio)
  y §6 del plan (`node scripts/cocoa-22-waves.mjs --write`): el único test
  rojo de `corepack pnpm test` (regla 15) pasa a verde.
- Runbook §17.11 (bloque «Cierre del front») con los conteos finales; diseño
  §5.5 / §6 e informe backend §8 alineados con los ficheros reales de L8; este
  informe; `CLAUDE.md` (estado verificado y deuda 15).
- Comprobado que los cierres de la integración intermedia siguen en su sitio:
  `EstructuraSocietariaTabs` en el barrel y `lazyTab`, `SYSTEM_ACTOR_LABELS`
  con los dos actores de sistema, `STRUCTURE_ROUTE` =
  `/configuracion/estructura-societaria`, `treasuryApi.scope()` con
  `scope: "entity"`, `SwitchableProperty` con `kind` / `code` /
  `legalEntityId` / `legalEntityName`, `accounting-ui.ts` sin los helpers de
  ámbito anteriores a L7, runbook de navegación con 38 contenedores.
