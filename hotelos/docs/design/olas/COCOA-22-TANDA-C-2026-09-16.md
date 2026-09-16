# Cocoa 22 · Tanda C (olas 8 · 10) — Informe de cierre · 16 de septiembre de 2026

**Para:** César. **Alcance:** tercera tanda de migración de pantallas al sistema
Cocoa 22 (spec `docs/design/COCOA-22.md`, plan `docs/design/COCOA-22-MIGRACION.md`)
sobre `3e01b61` (cierre de la Tanda 6b · Estructura societaria front): ola 8 ·
Cumplimiento (lotes 8-A, 8-B, 8-C) y ola 10 · Configuración (10-A, 10-B, 10-C, 10-D),
más la verificación adversarial con navegador (15 hallazgos confirmados: `qa#1`–`qa#18`
sin `qa#7`, `qa#12`, `qa#13`), siete lotes de corrección sin navegador (`fix:8-A`,
`fix:8-B`, `fix:8-C`, `fix:10-A`, `fix:10-B`, `fix:10-C`, `fix:primitives`), la
integración de los handoffs con valor exacto que quedaban abiertos y este cierre
(integrador sin navegador). **Sin commit**: todo está en el árbol de trabajo de
`hotelos/` (73 ficheros modificados · 2 retirados · 6 nuevos, este informe incluido).
Ningún dato de negocio de Faranda se ha escrito ni restaurado desde este cierre: las
puertas son estáticas (`tsc`, `node --test` sobre ficheros, scripts de inventario); los
servidores `:3000` y `:5173` no se han reiniciado.

Método de medida: `node scripts/cocoa-22-inventory.mjs` (puntos de deuda por pantalla;
fórmula en `docs/design/cocoa-22-inventory.json`), contrato
`tests/cocoa-22-contract.test.mjs` (reglas 1–15) y las puertas de §7.3 del plan.
«Antes» = inventario commiteado en `3e01b61`; «después» = inventario regenerado en este
cierre. Ningún lote de la tanda tuvo navegador salvo la verificación adversarial de QA:
la matriz visual §5 de las 43 pantallas y diálogos migrados (40 URL) y la medida en pantalla de las
correcciones quedan por hacer (§7).

## 1. Resumen en cifras

| Métrica | Antes (`3e01b61`) | Después (cierre Tanda C) | Δ |
|---|---|---|---|
| Pantallas inventariadas | 224 | 222 | −2 (`onboarding/CocoaOnboardingWizard.tsx` muerta y `tabs/configuracion/tab-helpers.tsx` re-export sin importadores, retiradas) |
| Líneas en `screens/` | 88.428 | 89.457 | +1.029 |
| **Puntos de deuda** | **1.912** | **313** | **−1.599 (−83,6 %)** |
| `.bo-card` · otras `.bo-*` | 307 · 909 | 26 · 52 | −281 · −857 |
| `<button>` crudos (CocoaButton) | 203 (836) | 12 (1.032) | −191 (+196) |
| `<table>` crudas (CocoaTable) | 40 (224) | 3 (280) | −37 (+56) |
| Inputs crudos (Cocoa) | 158 (892) | 4 (1.038) | −154 (+146) |
| `style={` | 1.832 | 801 | −1.031 |
| Colores literales (fallbacks) | 70 (38) | 2 (0) | −68 (−38) |
| `<h1>` crudos · emoji | 15 · 26 | 6 · 0 | −9 · −26 |
| Con cabecera Cocoa · `useTabHost` | 173 · 63 | 196 · 86 | +23 · +23 |
| Tamaños S · M · L · XL | 94 · 101 · 26 · 3 | 95 · 104 · 20 · 3 | seis L bajan a M/S al perder deuda |
| `NOT_MIGRATED` = `ALLOWLIST_CEILING` | 68 | **10** | −58 (56 pantallas y contenedores migrados + 2 retiradas) |
| Pendientes en §6 | 68 ficheros · 1.755 pts (olas 8 · 10 · 11) | **10 ficheros · 129 pts** (solo ola 11) | −58 · −1.626 |

Por ola: **ola 8 · Cumplimiento** 18 ficheros · 602 → **8** pts (categoría
`cumplimiento` 604 → 10 con las pantallas de Modelos AEAT ya migradas en la Tanda 6);
**ola 10 · Configuración** 40 ficheros · 1.023 → **19** pts (categoría `configuracion`
1.086 → 82: los 63 puntos restantes son de `onboarding/OnboardingInteractive.tsx` (60,
ola 11) y de `propertySetup/PropertySetupForms`, `structure/PropertiesTable` y
`structure/SeriesAndInstallationsTab` (1 punto cada una)). Las 58
entradas que salen de `NOT_MIGRATED` pasan de 1.625 a 27 puntos; los 313 totales son 129
de las 10 pendientes de la ola 11 + 184 residuales (1–11 `style={` por pantalla dentro de
su presupuesto) en las 212 migradas.

## 2. Pantallas migradas por ola (puntos antes → después)

Filas en el orden de §6 del plan en `3e01b61`. **Deuda** = recuentos del inventario
(`card` = `.bo-card`, `bo` = otras `.bo-*`, `btn`/`tbl`/`inp` = elementos crudos, `col` =
colores literales, `st` = `style={`, `emj` = emoji, `h1` = `<h1>` crudos). Las líneas
suben en casi todas: cada pantalla cambia clases legacy y `style={}` por primitivas
tipadas con estados vacío/error/carga, drawers y diálogos que antes no existían.

### Ola 8 · Cumplimiento — lote 8-A · Registro de viajeros, GDPR y centro de cumplimiento — 7 ficheros · 324 → 4 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `compliance/ComplianceCenterScreen.tsx` | dashboard | 937 → 1288 | **148 → 2** | card 21 · bo 93 · btn 18 · tbl 2 · inp 29 · st 103 · emj 3 → st 7 | `/cumplimiento/centro` |
| 2 | `compliance/GuestRegisterSettingsScreen.tsx` | dashboard | 582 → 538 | **66 → 0** | card 8 · bo 45 · btn 6 · tbl 1 · inp 18 · st 13 → st 1 | `/cumplimiento/registro-viajeros` |
| 3 | `compliance/SesHospedajesSettingsScreen.tsx` | dashboard | 609 → 837 | **61 → 1** | card 10 · bo 38 · btn 9 · tbl 1 · inp 8 · st 28 → st 5 | `/cumplimiento/registro-viajeros/ses-hospedajes` |
| 4 | `compliance/GdprRequestsScreen.tsx` | dashboard | 456 → 557 | **32 → 1** | card 7 · bo 21 · btn 6 · tbl 1 · inp 5 → st 5 | `/cumplimiento/proteccion-datos` |
| 5 | `compliance/GuestRegisterRetentionSettingsScreen.tsx` | formulario | 151 → 172 | **10 → 0** | card 3 · bo 11 · st 7 → 0 | `/cumplimiento/registro-viajeros/conservacion` |
| 6 | `compliance/AuthorityRoutingSettingsScreen.tsx` | formulario | 147 → 143 | **7 → 0** | card 3 · bo 5 · st 5 → st 1 | `/cumplimiento/registro-viajeros/autoridades` |
| 7 | `tabs/cumplimiento/RegistroViajerosTabs.tsx` | contenedor | 32 → 32 | **0 → 0** | 0 → 0 | — |

Primitivas que estrena: `CocoaTable truncate` (celda «Documento» con tope y tooltip,
qa#1), ficha de control en `CocoaDrawer lg` con documentos (`CocoaFileInput`), historial
SES con `CocoaDrawer` + `CocoaSegmentedControl` Resumen/XML/Respuesta y sondeo `pollWhile`
(sustituye a `components/SubmissionDetailPanel`, que se queda sin importadores).

### Ola 8 · Cumplimiento — lote 8-B · VeriFactu, TicketBAI, envíos y bandeja — 5 ficheros · 129 → 3 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `fiscal/FiscalDashboard.tsx` | dashboard | 315 → 359 | **68 → 0** | card 16 · bo 51 · btn 12 · tbl 1 · st 24 · h1 1 → st 1 | `/cumplimiento/verifactu` |
| 2 | `fiscal/TbaiForalScreen.tsx` | dashboard | 192 → 269 | **28 → 1** | card 6 · bo 9 · btn 3 · tbl 1 · st 22 · emj 2 → st 3 | `/cumplimiento/verifactu/ticketbai` |
| 3 | `fiscal/FiscalSubmissionsCenter.tsx` | dashboard (lista + drawer) | 295 → 596 | **21 → 1** | card 6 · bo 3 · btn 3 · tbl 1 · col 2 · st 27 → st 3 | `/cumplimiento/envios` |
| 4 | `fiscal/ComplianceInbox.tsx` | workspace | 275 → 396 | **12 → 1** | card 2 · bo 5 · btn 4 · st 13 → st 3 | `/cumplimiento/bandeja` |
| 5 | `tabs/cumplimiento/VerifactuTabs.tsx` | contenedor | 27 → 32 | **0 → 0** | 0 → 0 | — |

Los estados de envío (15 códigos del contrato) se pintan con `submissionStatusLabel()` de
`fiscal/fiscal-shared.ts` (qa#2). `FiscalDashboard` sigue en el puente `pageHead(embedded)`
porque `cumplimiento-tabs.test.mts` lo exige (§6, handoff 5); en este cierre recibe
`panelId="fiscal-dashboard-panel"` para cerrar qa#10.

### Ola 8 · Cumplimiento — lote 8-C · Impuestos y sostenibilidad — 6 ficheros · 149 → 1 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `admin/TouristTaxScreen.tsx` | dashboard | 444 → 542 | **62 → 0** | card 6 · bo 37 · btn 7 · tbl 1 · inp 13 · st 29 · emj 5 → st 1 | `/cumplimiento/impuestos/tasa-turistica` |
| 2 | `esrs/EsrsReportScreen.tsx` | dashboard | 249 → 338 | **36 → 0** | card 7 · bo 13 · btn 4 · tbl 1 · inp 2 · col 1 · st 19 · emj 7 → st 1 | `/cumplimiento/sostenibilidad/esrs` |
| 3 | `compliance/PropertyTaxesScreen.tsx` | lista | 615 → 680 | **30 → 0** | card 4 · bo 34 · inp 2 · st 28 → st 1 | `/cumplimiento/impuestos` |
| 4 | `operations/SustainabilityDashboard.tsx` | dashboard | 338 → 336 | **21 → 1** | card 6 · bo 9 · btn 1 · tbl 2 · col 3 · st 11 → st 3 | `/cumplimiento/sostenibilidad` |
| 5 | `tabs/cumplimiento/ImpuestosTabs.tsx` | contenedor | 26 → 26 | **0 → 0** | 0 → 0 | — |
| 6 | `tabs/cumplimiento/SostenibilidadTabs.tsx` | contenedor | 27 → 27 | **0 → 0** | 0 → 0 | — |

`PropertyTaxesScreen` y `SustainabilityDashboard` conservan `pageHead(embedded)` por los
tests de tabs (§6, handoff 5). Los pasos de `content/screen-instructions/taxes.ts` ya no
llevan «1. » (qa#9) y la tarjeta de instrucciones limpia el ordinal de cualquier contenido
(`stripStepOrdinal`).

### Ola 10 · Configuración — lote 10-A · Sistema, organizaciones, usuarios y desarrolladores — 11 ficheros · 286 → 8 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `AuditLogViewer.tsx` | lista con filtros | 347 → 390 | **51 → 1** | card 6 · bo 25 · btn 7 · tbl 1 · inp 6 · st 45 → st 3 | `/configuracion/sistema` |
| 2 | `UserRoleManager.tsx` | workspace | 634 → 707 | **49 → 1** | card 3 · bo 26 · btn 13 · tbl 1 · inp 7 · col 2 · st 36 → st 3 | `/configuracion/usuarios` |
| 3 | `developer/WebhooksAdminScreen.tsx` | lista | 316 → 444 | **47 → 1** | card 10 · bo 12 · btn 9 · tbl 2 · inp 2 · col 2 · st 34 → st 2 | `/configuracion/sistema/webhooks` |
| 4 | `developer/ApiReferenceScreen.tsx` | dashboard | 237 → 253 | **39 → 1** | card 3 · bo 15 · btn 1 · inp 3 · col 13 · st 23 · emj 1 · h1 1 → st 2 | `/configuracion/sistema/api` |
| 5 | `developer/DeveloperAppsScreen.tsx` | lista | 205 → 337 | **36 → 1** | card 8 · bo 11 · btn 4 · tbl 1 · inp 3 · col 1 · st 27 → st 2 | `/configuracion/sistema/aplicaciones` |
| 6 | `admin/TenantDetailScreen.tsx` | detalle | 903 → 719 | **21 → 1** | bo 5 · st 74 → st 5 | `/configuracion/sistema/organizaciones/:id` |
| 7 | `admin/NewTenantWizardDialog.tsx` | diálogo (asistente 5 pasos) | 619 → 618 | **19 → 1** | inp 1 · col 8 · st 41 → st 3 | — |
| 8 | `admin/TenantAdminConsoleScreen.tsx` | lista | 911 → 514 | **12 → 1** | btn 3 · st 34 → st 3 | `/configuracion/sistema/organizaciones` |
| 9 | `admin/InviteUserDialog.tsx` | diálogo | 419 → 190 | **8 → 0** | col 5 · st 19 → 0 | — |
| 10 | `admin/ResetPasswordConfirmDialog.tsx` | diálogo | 297 → 146 | **4 → 0** | st 14 → st 1 | — |
| 11 | `tabs/configuracion/SistemaTabs.tsx` | contenedor | 64 → 64 | **0 → 0** | 0 → 0 | — |

Cliente nuevo `services/tenant-admin-contracts.ts` (`normalizeTenantSummary`,
`platformTotals`) para que la consola lea `counts.properties/users/modulesEnabled` del API
(qa#5). `InviteUserDialog` y `ResetPasswordConfirmDialog` quedan migrados pero sin
importador (candidatos a retirada en la ola 11, §6).

### Ola 10 · Configuración — lote 10-B · Inteligencia artificial y comunicaciones — 8 ficheros · 388 → 8 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `aiOperations/AiGovernanceScreen.tsx` | dashboard (5 vistas) | 901 → 1135 | **121 → 3** | card 16 · bo 51 · btn 21 · tbl 7 · inp 15 · col 6 · st 59 · h1 1 → st 11 | `/configuracion/ia/gobernanza` |
| 2 | `aiOperations/AiPipelineStatusScreen.tsx` | dashboard | 589 → 525 | **61 → 1** | card 18 · bo 29 · btn 3 · tbl 3 · col 6 · st 39 · h1 1 → st 5 | `/configuracion/ia/actividad` |
| 3 | `notifications/NotificationsScreen.tsx` | dashboard (3 vistas) | 651 → 688 | **56 → 2** | card 8 · bo 12 · btn 8 · tbl 3 · inp 9 · st 45 · h1 1 → st 6 | `/configuracion/comunicaciones` |
| 4 | `aiOperations/PropertyAiScreen.tsx` | formulario | 496 → 455 | **54 → 1** | card 15 · bo 15 · btn 2 · tbl 1 · inp 5 · col 13 · st 42 · emj 5 · h1 1 → st 2 | `/configuracion/ia` |
| 5 | `aiOperations/EmailConnectorsScreen.tsx` | formulario | 245 → 489 | **51 → 1** | card 8 · bo 19 · btn 8 · tbl 1 · inp 7 · col 4 · st 24 · emj 1 → st 4 | `/configuracion/comunicaciones/correo-entrante` |
| 6 | `aiOperations/AiToolRegistryScreen.tsx` | dashboard | 545 → 501 | **45 → 0** | card 6 · bo 31 · btn 4 · tbl 1 · inp 6 · st 21 · h1 1 → st 1 | `/configuracion/ia/herramientas` |
| 7 | `tabs/configuracion/ComunicacionesTabs.tsx` | contenedor | 30 → 30 | **0 → 0** | 0 → 0 | — |
| 8 | `tabs/configuracion/InteligenciaArtificialTabs.tsx` | contenedor | 36 → 36 | **0 → 0** | 0 → 0 | — |

Módulo puro `aiOperations/ai-operations-labels.ts` (etiquetas en español de tipo,
gravedad, estado de llamada y readiness por `key` + `status`, qa#3 y qa#11); «Descartar
cambios» y «Desconectar» pasan por `CocoaDialog` (qa#18, qa#4); «Añadir buzón» se bloquea
con `CocoaCallout` cuando el servidor declara el proveedor sin configurar (qa#4).

### Ola 10 · Configuración — lote 10-C · Puesta en marcha, propiedad, categorías y módulos — 15 ficheros · 271 → 2 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `backoffice/SetupCenterScreen.tsx` | dashboard | 336 → 403 | **55 → 0** | card 11 · bo 44 · btn 8 · inp 1 · st 33 → 0 | `/configuracion/puesta-en-marcha` |
| 2 | `PropertyMapper.tsx` | workspace | 384 → 402 | **50 → 0** | card 7 · bo 44 · btn 6 · tbl 1 · inp 1 · st 23 → st 1 | `/configuracion/puesta-en-marcha/importar-documentos` |
| 3 | `ModuleHealthCenter.tsx` | dashboard | 282 → 344 | **40 → 1** | card 8 · bo 22 · btn 7 · tbl 2 · st 11 · h1 1 → st 2 | `/configuracion/modulos/salud` |
| 4 | `marketplace/MarketplaceCatalogScreen.tsx` | lista | 266 → 330 | **37 → 1** | card 7 · bo 7 · btn 9 · tbl 1 · inp 1 · col 1 · st 30 · emj 2 → st 3 | `/configuracion/modulos/integraciones` |
| 5 | `ModuleManager.tsx` | formulario | 323 → 320 | **24 → 0** | card 8 · bo 20 · btn 1 · inp 1 · col 1 · st 13 → 0 | `/configuracion/modulos` |
| 6 | `backoffice/categories/CategoryManagerScreen.tsx` | otro | 150 → 203 | **17 → 0** | card 4 · bo 11 · btn 2 · st 1 → st 1 | `/configuracion/propiedad/categorias` |
| 7 | `backoffice/categories/CategoryOptionForm.tsx` | formulario | 97 → 177 | **13 → 0** | bo 3 · btn 1 · inp 5 → 0 | `/configuracion/propiedad/categorias/:codigo/opciones/nueva` |
| 8 | `backoffice/categories/CategoryDetailScreen.tsx` | detalle | 107 → 169 | **12 → 0** | card 3 · bo 6 · btn 1 → st 1 | `/configuracion/propiedad/categorias/:codigo` |
| 9 | `GoLiveChecklist.tsx` | asistente | 188 → 229 | **8 → 0** | card 3 · bo 6 · st 8 → st 1 | `/configuracion/puesta-en-marcha/salida-en-vivo` |
| 10 | `onboarding/CocoaOnboardingWizard.tsx` | asistente | 763 → — | **15 → retirada** | st 41 · h1 1 → — | — (muerta, 0 importadores) |
| 11 | `tabs/configuracion/HabitacionesTabs.tsx` | contenedor | 30 → 30 | **0 → 0** | 0 → 0 | — |
| 12 | `tabs/configuracion/ModulosTabs.tsx` | contenedor | 35 → 35 | **0 → 0** | 0 → 0 | — |
| 13 | `tabs/configuracion/PropiedadTabs.tsx` | contenedor | 58 → 58 | **0 → 0** | 0 → 0 | — |
| 14 | `tabs/configuracion/PuestaEnMarchaTabs.tsx` | contenedor | 63 → 63 | **0 → 0** | 0 → 0 | — |
| 15 | `tabs/configuracion/tab-helpers.tsx` | contenedor (re-export) | 13 → — | **0 → retirada** | 0 → — | — (0 importadores) |

`lib/format.readinessMessage()` reescribe en español los mensajes del readiness del API
(variables de entorno, «sandbox», «stub», claves inglesas de dirección; qa#14) y
`GoLiveChecklist` cubre los 17 códigos actuales con etiqueta y pantalla de arreglo.
`PropertyMapper` conserva su `<input type="file" multiple hidden>` (exento por la regla 4;
el inventario ya no lo cuenta).

### Ola 10 · Configuración — lote 10-D · Contabilidad, facturación y pagos — 6 ficheros · 78 → 1 pts

| # | Fichero (`screens/`) | Arquetipo | Líneas antes → después | Puntos antes → después | Deuda antes → después | URL |
|---|---|---|---|---|---|---|
| 1 | `TaxComplianceSettings.tsx` | formulario | 710 → 713 | **34 → 0** | card 8 · bo 32 · inp 2 · st 33 → 0 | `/configuracion/contabilidad-fiscal/fiscal` |
| 2 | `BillingSettings.tsx` | formulario | 389 → 450 | **20 → 0** | card 6 · bo 20 · inp 1 · st 13 → st 1 | `/configuracion/facturacion-pagos` |
| 3 | `AccountingSettings.tsx` | formulario (solo lectura) | 209 → 215 | **14 → 1** | card 6 · bo 10 · st 12 → st 2 | `/configuracion/contabilidad-fiscal` |
| 4 | `PaymentSettings.tsx` | formulario | 154 → 186 | **10 → 0** | card 4 · bo 7 · st 8 → st 1 | `/configuracion/facturacion-pagos/pagos` |
| 5 | `tabs/configuracion/ContabilidadFiscalTabs.tsx` | contenedor | 30 → 30 | **0 → 0** | 0 → 0 | — |
| 6 | `tabs/configuracion/FacturacionPagosTabs.tsx` | contenedor | 27 → 27 | **0 → 0** | 0 → 0 | — |

Las cuatro pantallas dejaron el puente L1c (`CocoaPage` sobre `useTabHost()`, sin prop
`embedded`); `configuracion-tabs.test.mts` ya no las lista.

### Fuera de las olas (cambios de esta tanda en pantallas ya migradas)

`dev/StyleGuideScreen.tsx` 11 → 10 pts (2.527 → 2.537 líneas; primer consumidor de
`CocoaSegmentedControl id/aria-describedby`, `CocoaTable truncate` y de la nota «el cuerpo
de `CocoaPage` es el tabpanel»); `tabs/tab-helpers.tsx` 1 → 1 (164 → 165: `HostedHead`
reenvía `panelId`).

## 3. Contrato, inventario y scripts

- `tests/cocoa-22-contract.test.mjs`: `NOT_MIGRATED` 68 → **10** líneas (56 pantallas y
  contenedores migrados + 2 retiradas) y `ALLOWLIST_CEILING` 68 → **10** (= longitud,
  comprobado en este cierre tras la edición concurrente de los siete lotes; lo que queda
  es exactamente la ola 11: `ModuleSettingsPlaceholder`, `ScreenScaffold`,
  `dev/StyleGuideScreen`, `developer/CocoaShowcaseScreen`, `onboarding/OnboardingInteractive`,
  `onboarding/OnboardingScreens`, `preview/CocoaGalleryScreen`, `tabs/NavItemTabs`,
  `tabs/TabHost`, `tabs/tab-helpers`); `STYLE_BUDGET` 58 → **82** entradas (+24:
  `fiscal/ComplianceInbox` 40 · `AuditLogViewer` 15 · `UserRoleManager` 40 ·
  `developer/WebhooksAdminScreen` 15 · `developer/DeveloperAppsScreen` 15 ·
  `admin/TenantDetailScreen` 15 · `admin/NewTenantWizardDialog` 15 ·
  `admin/TenantAdminConsoleScreen` 15 · `admin/InviteUserDialog` 15 ·
  `admin/ResetPasswordConfirmDialog` 15 · `TaxComplianceSettings` 15 · `BillingSettings` 15 ·
  `AccountingSettings` 15 · `PaymentSettings` 15 · `compliance/PropertyTaxesScreen` 15 ·
  `aiOperations/PropertyAiScreen` 15 · `aiOperations/EmailConnectorsScreen` 15 ·
  `compliance/GuestRegisterRetentionSettingsScreen` 15 ·
  `compliance/AuthorityRoutingSettingsScreen` 15 · `PropertyMapper` 40 ·
  `marketplace/MarketplaceCatalogScreen` 15 · `ModuleManager` 15 ·
  `backoffice/categories/CategoryOptionForm` 15 · `backoffice/categories/CategoryDetailScreen`
  15); `GLOBAL_CEILING` 307/203/40/158/70/1832 → **26/12/3/4/2/801** (= totales
  regenerados, sin margen: cualquier `style={` nuevo rompe la regla 13); `HEADER_EXEMPT`
  y `COLOUR_EXEMPT` sin cambios. 18/18 reglas en verde.
- `docs/design/cocoa-22-inventory.json` regenerado en este cierre (222 · 89.457 · 313; el
  JSON intermedio de la integración de las olas decía 89.284 líneas y la regla 15 estaba
  en rojo por las +173 líneas de las correcciones y de esta integración) y
  `docs/design/COCOA-22-MIGRACION.md` §6 reescrito por `cocoa-22-waves.mjs --write` (10
  pendientes · 129 pts · 1 lote: olas 8 y 10 a 0 ficheros); §0 actualizado a mano en este
  cierre.
- `scripts/cocoa-22-inventory.mjs:98`: `rawInputs` deja de contar `<input type="file">` y
  `type="hidden"` (espejo de la regla 4 del contrato; `PropertyMapper` baja 1 punto sin
  tocar código); `scripts/cocoa-22-waves.mjs`: la entrada `OVERRIDE` de
  `tabs/configuracion/tab-helpers.tsx` y la `DEAD` de `CocoaOnboardingWizard.tsx` pasan a
  nota de retirada.
- `docs/design/COCOA-22.md` §8.2 regenerado por `cocoa-22-api.mjs --write` en `fix:primitives`
  (40 ficheros · 68 interfaces · 55 type aliases · 645 props · 163 funciones · 29
  constantes · 1.895 líneas; `--check` al día en este cierre): `CocoaPageHeaderProps.panelId`,
  `CocoaPageProps.panelId`, `CocoaSegmentedControlProps.id` / `"aria-describedby"`,
  `CocoaTableColumn.truncate` y `truncatedCellTitle()`.
- Tests: nuevos (untracked, 346 líneas en 3 ficheros · 25 casos):
  `lib/__tests__/readiness-message.test.mts` (7, qa#14),
  `screens/aiOperations/__tests__/ai-operations-labels.test.mts` (9, qa#3/qa#11),
  `services/__tests__/tenant-admin-contracts.test.mts` (9, qa#5); módulos puros junto a la
  pantalla: `screens/aiOperations/ai-operations-labels.ts` (104 líneas),
  `services/tenant-admin-contracts.ts` (86). Modificados:
  `components/cocoa/__tests__/CocoaPage.test.mts` (+43, «the body is the tabpanel», qa#10),
  `CocoaTable.test.mts` (+35, `truncate`, qa#1),
  `cocoa-guidance/__tests__/CocoaScreenInstructionsCard.test.mts` (+51, qa#9),
  `screens/fiscal/__tests__/fiscal-shared.test.mts` (`submissionStatusLabel`, qa#2),
  `layouts/__tests__/shell-cocoa22-contract.test.mts` (ya no lee el wizard retirado),
  `screens/tabs/configuracion/__tests__/configuracion-tabs.test.mts` (regex del puente
  admite `useTabHost() !== null || embedded`; las 4 pantallas de 10-D fuera de
  `EMBEDDED_SCREENS`), `tests/backoffice-contract.test.mjs:274` («Recalcular preparación»).

## 4. Primitivas, hojas y componentes compartidos (handoffs resueltos en la tanda)

- `components/cocoa/CocoaPage.tsx` (+32): con `tabs` y sin `panelId` el cuerpo
  `.c22-page__body` es el `role="tabpanel"` (id de `useId()`, `aria-label` = vista activa)
  y su id llega a `CocoaPageHeader`/`HostedHead` → `aria-controls` en la pestaña activa
  (qa#10, de sistema para todas las pantallas con vistas internas de cabecera).
  `CocoaPageHeader.tsx` y `tabs/tab-helpers.tsx` (`HostedHead`) reenvían `panelId`.
- `CocoaSegmentedControl.tsx`: props `id` y `aria-describedby` reenviadas al `tablist`
  (`CocoaField` puede envolverlo: `PropertyAiScreen` «Nivel de automatización»).
- `CocoaTable.tsx` (+37): `CocoaTableColumn.truncate?: number` (inline-block
  `.cocoa-truncate` con tope en px y `title` cuando la celda es texto; también en las
  tarjetas de teléfono) y `truncatedCellTitle()` exportado (qa#1).
- `CocoaSidebar.tsx`, `cocoa-guidance/CocoaScreenInstructionsCard.tsx`,
  `cocoa-guidance/CocoaEmptyStateGuide.tsx` y `styles/cocoa-22-legacy-bridge.css:385-394`
  (`button.primary` / `.bo-button.primary`): texto blanco sobre `--cocoa-accent-fill`
  (5,35:1) en vez de `--cocoa-accent` (4,36:1) (qa#8; deuda 6b(d) de `CocoaSidebar`
  cerrada). Quedan con `--cocoa-accent` solo superficies sin texto.
- `cocoa-guidance/CocoaScreenInstructionsCard.tsx`: `stripStepOrdinal()` (`/^\s*\d{1,2}[.)]\s+/`)
  aplicado a cada paso: los contenidos con «N. » (`allotments.ts`, `revenue.ts`,
  `frontdesk-cockpit.ts`, `reservations.ts`) dejan de verse dobles aunque no se hayan
  limpiado (qa#9).
- `lib/format.ts` (+131, `// Cocoa 22 · ola 10`): `readinessMessage()` puente de copy de
  los mensajes del readiness (qa#14); `services/authApi.ts` `formatExpiry` → `dateTime(iso,
  { style: "medium", empty: "—" })` (C18); `services/tenantAdminApi.ts` normaliza
  `counts.*` con `normalizeTenantSummary()` (qa#5); `screens/fiscal/fiscal-shared.ts`
  `SUBMISSION_STATUS_LABELS` / `submissionStatusLabel()` compartidos por Envíos y TicketBAI
  (qa#2); `content/screen-instructions/taxes.ts` sin ordinales (qa#9).
- Integración final (este cierre, handoffs con valor exacto de los lotes `fix:*`):
  `GoLiveChecklist.tsx:158,165` y `tests/backoffice-contract.test.mjs:274` «Recalcular
  readiness» → «Recalcular preparación» (último «readiness» visible de qa#14);
  `fiscal/FiscalDashboard.tsx:197` `panelId="fiscal-dashboard-panel"` y
  `ModuleHealthCenter.tsx:236-271` `panelId="module-health-checks"` + `div#module-health-checks[role=tabpanel]`
  alrededor de la tabla (cierran qa#10); qa#16 en las seis tablas que quedaban por handoff:
  `AuditLogViewer.tsx:102` («ID» `fit` + `showFrom: "desktop"` + 12 caracteres con `title`;
  el drawer conserva el id completo), `ModuleHealthCenter.tsx:144` («Acción recomendada»
  `laptop` → `desktop`), `admin/TenantAdminConsoleScreen.tsx:289` («Creada» `hideOnNarrow`
  → `showFrom: "desktop"`), `aiOperations/AiToolRegistryScreen.tsx:185` («Confirmación»
  idem), `esrs/EsrsReportScreen.tsx:86` («Origen» `laptop` → `desktop`),
  `compliance/PropertyTaxesScreen.tsx:182` («Base legal» idem); guía de estilo como primer
  consumidor de `truncate` (`TABLE_SAMPLE` y columna «Huésped» `truncate: 160`) y nota del
  tabpanel en `TABS_SAMPLE`. Ninguno añade `style={`: 313 puntos antes y después.

## 5. Hallazgos de QA y estado

15 hallazgos confirmados por la verificación adversarial con navegador (5 media · 10
baja). «Corregido» = cambio en código con test o contrato que lo pina; la medida en
pantalla de todos queda pendiente (§7).

| Id | Sev. | Lote | Hallazgo | Estado |
|---|---|---|---|---|
| qa#1 | media | 8-A | «Documento» `fit`+`nowrap` rompe el ancho de la tabla de partes (scroll a 1440 y 1024) | Corregido: `truncate: 160` (primitiva nueva) + «Reserva»/«Creado» `showFrom: "desktop"`; `CocoaTable.test.mts` |
| qa#2 | media | 8-B | Estado de envío en inglés crudo («accepted») en Envíos a autoridades | Corregido: `submissionStatusLabel()` (15 estados) en tabla, drawer y TicketBAI; `fiscal-shared.test.mts` |
| qa#3 | media | 10-B | «Preparación de la IA» pinta en inglés los textos del readiness del API | Corregido: mapa por `key` + `status` con los datos guardados; `ai-operations-labels.test.mts`. Causa raíz en el API (handoff §6) |
| qa#4 | media | 10-B | «Desconectar» destruye sin `CocoaDialog`; «Añadir buzón» crea la conexión Gmail sin autorización disponible | Corregido: diálogo destructivo con `busy`; botón deshabilitado + `CocoaCallout` cuando `providers[p].configured === false` (hoy Gmail, Microsoft e IMAP) |
| qa#5 | media | 10-A | Consola de organizaciones muestra Centros 0 · Usuarios 0 con `counts.*` en el API | Corregido en la capa de servicio (`normalizeTenantSummary`, `platformTotals`); `tenant-admin-contracts.test.mts` |
| qa#6 | baja | 8-A | Historial SES no cabe a 1024 (~300 px de scroll interno) | Corregido: «Tipo», «Intentos», «Enviado» `showFrom: "desktop"`; `errorStyle` con `overflowWrap: "anywhere"` |
| qa#8 | baja | primitives | Numerales de pasos 11 px blanco sobre `#0d8a5f` a 4,36:1 | Corregido de sistema: `--cocoa-accent-fill` (5,35:1) en guía de instrucciones, guía de vacío, `CocoaSidebar` y `button.primary` legacy |
| qa#9 | baja | 8-C | Pasos con «1. » delante del numeral de la tarjeta (numeración doble) | Corregido: `taxes.ts` sin ordinales + `stripStepOrdinal()` en la primitiva; `CocoaScreenInstructionsCard.test.mts` |
| qa#10 | baja | primitives | Vistas internas de cabecera sin `aria-controls` hacia su tabpanel | Corregido de sistema en `CocoaPage` (`CocoaPage.test.mts`); en este cierre `panelId` en `FiscalDashboard` (cabecera por `pageHead`) y en el filtro de `ModuleHealthCenter` |
| qa#11 | baja | 10-B | `CALL_STATUS_LABEL` sin «completed» (badge «COMPLETED» en inglés, tono warning) | Corregido: `callStatusLabel()`/tono en `ai-operations-labels.ts` |
| qa#14 | baja | 10-C | Lista de salida en vivo pinta mensajes del API con variables de entorno y «sandbox» | Corregido en el front (`readinessMessage()`, 17 códigos con etiqueta y arreglo; «Recalcular preparación» en este cierre); origen en el API por handoff (§6) |
| qa#15 | baja | 8-A | Enviar el parte vacío solo muestra un callout global; ningún `CocoaField` en error | Corregido: validación en una pasada, `CocoaField error` en los 8 obligatorios, `role="alert"` resumen, foco al primer `aria-invalid` |
| qa#16 | baja | 8-B | 7 tablas desbordan su wrap a 1024×768 | Corregido: `FiscalSubmissionsCenter` («Identificador» → `desktop`) en `fix:8-B`; las otras seis en este cierre (§4) con los valores medidos por `fix:8-B` |
| qa#17 | baja | 10-A | Descripciones de endpoints con mezcla de idiomas y jerga del catálogo del API | Mitigado en pantalla (oculta las 920 descripciones que solo repiten la ruta; conserva las 21 redactadas); causa raíz `api-reference.service.ts describe()` por handoff (§6) |
| qa#18 | baja | 10-B | «Descartar cambios» de la `CocoaActionBar` descarta sin confirmación | Corregido: `CocoaDialog tone="destructive"` «¿Descartar los cambios?» (Seguir editando · Descartar) |

Residuos conocidos de las correcciones: el registro `grr_e86d63b9` de Rías Altas devuelve
un token cifrado como número de documento (datos/API, §6); la fila «Gmail · desconectado»
que dejó la reproducción de qa#4 sigue en Rías Altas (tono neutral, sin acciones; borrarla
exige el API o SQL); `PENDING_STATUSES` de `FiscalSubmissionsCenter.tsx:82` no incluye
«sent» de SES (preexistente).

## 6. Handoffs pendientes

Ordenados por dueño; `fichero:línea` sobre el árbol de trabajo actual. Los resueltos en la
integración no aparecen (§4). Los primeros cinco son el guion de la **ola 11 · limpieza**
(plan §7.4).

**Ola 11 · limpieza (lote css + shell + dev)**

1. `apps/admin-web/src/styles.css` (2.843 líneas): borrar el bloque `@layer cocoa-legacy`
   (115 clases `.bo-*` en 269 reglas) y la declaración `@layer cocoa-legacy, cocoa-bridge;`
   de `:27`. Antes: las 3 pantallas de la ola 11 que aún usan `.bo-*`
   (`onboarding/OnboardingInteractive.tsx` 53 ocurrencias, `ModuleSettingsPlaceholder.tsx`
   13, `ScreenScaffold.tsx` 10) y el único `<select>` crudo del árbol
   (`OnboardingInteractive`, R14). El inventario cuenta 26 `.bo-card` + 52 otras `.bo-*`;
   las 9 pantallas migradas con una ocurrencia (`YearEndClose`, `ExchangeRates`,
   `BalanceSheet`, `SesHospedajesSettings`, `ComplianceCenter`, `RatePlans`,
   `CancellationPolicies`, `RevenueRules`, `RateShopperSettings`) son comentarios de cabecera
   («migrated from the legacy `.bo-*` screen»), no clases (regla 1 en verde).
2. `apps/admin-web/src/styles/cocoa-22-legacy-bridge.css` (617 líneas · 108 reglas):
   borrar el fichero y su `@import` en `styles.css:24` (comentarios `:13` y `:289`) cuando
   la regla 1 del contrato cubra el 100 % de `screens/**` (`NOT_MIGRATED = []`). El cambio
   de `button.primary` a `--cocoa-accent-fill` (qa#8) se pierde con la hoja: nada que
   trasladar.
3. `styles/cocoa-22-layout.css:289-310` (alias `.gm-grid`, comentario `:25`),
   `styles/mobile.css:141` (parrillas multicolumna legacy → una columna), `:207` (acciones
   pegadas legacy) y `:241` (tablists de `components/v2/SegmentedControl`): retirar con la
   hoja puente; `navigation/Sidebar.tsx:89` `SIDEBAR_CSS` a `styles/` (R11).
4. Componentes compartidos sin importador (borrar con `grep` = 0 delante):
   `components/SubmissionDetailPanel.tsx` (los dos importadores lo sustituyeron por drawers
   Cocoa en 8-A y 8-B; solo quedan menciones en comentarios de
   `fiscal/FiscalSubmissionsCenter.tsx` y `compliance/SesHospedajesSettingsScreen.tsx`),
   `components/SidePanel.tsx`, `components/ConfirmDialog.tsx`, `components/v2/**`,
   `components/NarrowViewportBanner.tsx`, `components/cocoa-extras/CocoaColorWell.tsx`
   (solo lo importa la muerta `developer/CocoaShowcaseScreen.tsx`), `screens/admin/index.ts`
   + `admin/InviteUserDialog.tsx` + `admin/ResetPasswordConfirmDialog.tsx` (barrel sin
   importador: `UserRoleManager` usa sus propios drawers, la consola no tiene reset de
   contraseña temporal), `components/cocoa-rate-grid/helpers.ts:956-969`
   `toastOffsetForBar` + `__tests__/final-fixes.test.mts:137-140` (R31),
   `packages/ui/src/components/timeline/**` + alias `@hotelos/ui/timeline` de
   `apps/admin-web/vite.config.ts:18,38` (R32). Con importadores todavía:
   `components/States.tsx` (`App.tsx:39` `LoadingBlock`, `tabs/NavItemTabs.tsx:25`
   `ErrorState`, `onboarding/OnboardingInteractive.tsx:18`, `components/TopBar.tsx:12`
   `Spinner`), `components/forms/FormComponents.tsx:298` `DataPreview`
   (`propertySetup/PropertySetupForms.tsx:18`, R2), `components/cocoa-empty-state/**`
   (`cocoa/index.ts:50` y `cocoa-director/DirectorForwardPaceChart.tsx:33`),
   alias deprecado `DirectorKpiTile` (`cocoa/CocoaKpi.tsx`, `cocoa-22.css`).
5. Puente L1c `embed()` / `pageHead(embedded)` (`tabs/TabHost.tsx:12-21` lo lista): 10
   loaders `embed(m.X)` en `tabs/configuracion/ComunicacionesTabs.tsx:17`,
   `PuestaEnMarchaTabs.tsx:25`, `SistemaTabs.tsx:52`, `ModulosTabs.tsx:22`,
   `InteligenciaArtificialTabs.tsx:20-23` (×4), `tabs/cumplimiento/VerifactuTabs.tsx:19` y
   `SostenibilidadTabs.tsx:15` → `({ default: m.X })`; 5 pantallas con `pageHead(embedded)`
   (`compliance/AuthorityRoutingSettingsScreen`, `GuestRegisterRetentionSettingsScreen`,
   `PropertyTaxesScreen`, `fiscal/FiscalDashboard`, `operations/SustainabilityDashboard`) →
   `<CocoaPage state skeleton error commands>` (cuerpo ya construido; `FiscalDashboard`
   además `shellNavigate` importado en vez de la prop `onNavigate`); 9 pantallas con
   `hosted = useTabHost() !== null || embedded` + wrapper `embedded={embedded}`
   (`admin/TenantAdminConsoleScreen`, `admin/TenantDetailScreen`, `aiOperations/AiGovernanceScreen`,
   `AiPipelineStatusScreen`, `AiToolRegistryScreen`, `PropertyAiScreen`,
   `developer/ApiReferenceScreen`, `notifications/NotificationsScreen`, más
   `backoffice/SetupCenterScreen.tsx:389-391`, `ModuleHealthCenter.tsx:337-339`,
   `ModuleManager.tsx:317-319`, `GoLiveChecklist.tsx:195-197`) → borrar la prop. Tests
   que lo fijan y hay que vaciar en el mismo cambio:
   `screens/tabs/cumplimiento/__tests__/cumplimiento-tabs.test.mts:20-29`
   (`EMBEDDED_SCREENS` con `AuthorityRoutingSettings`, `GuestRegisterRetentionSettings`,
   `FiscalDashboard`, `PropertyTaxesScreen`, `SustainabilityDashboard`; `EMBED_BRIDGE`),
   `screens/tabs/configuracion/__tests__/configuracion-tabs.test.mts:28-55`
   (`EMBEDDED_SCREENS` 12 entradas, `EMBED_BRIDGE`, regex `:229`),
   `screens/__tests__/screens-fixes-contract.test.mts:80` (`/pageHead\(embedded\)/` de
   `SustainabilityDashboard` → `/<CocoaPage\b/`). Después `tabs/tab-helpers.tsx` pierde
   `embed()`/`pageHead()` y `HostedHead` pasa a `components/` (exención de la regla 8 para
   `TabHost`/`tab-helpers`, R18).
6. Dev y muertas (los 10 de `NOT_MIGRATED`): `onboarding/OnboardingInteractive.tsx` (60
   pts · 677 líneas · asistente, solo `/desarrollo/migracion`), `ModuleSettingsPlaceholder.tsx`
   (16 · `makeModulePlaceholder`, 16 placeholders), `dev/StyleGuideScreen.tsx` (10 · ya en
   `CocoaPage`: `STYLE_BUDGET` 40 y salir de la allowlist), `ScreenScaffold.tsx` (9),
   `onboarding/OnboardingScreens.tsx` (5), `developer/CocoaShowcaseScreen.tsx` (16,
   **muerta**) y `preview/CocoaGalleryScreen.tsx` (12, **muerta**; ambas con exención en
   `tests/admin-web-spanish-copy-contract.test.mjs:36-37` a borrar), `tabs/tab-helpers.tsx`
   (1), `tabs/NavItemTabs.tsx` (0), `tabs/TabHost.tsx` (0). R24: la guía y `/desarrollo/*`
   exigen administrador de plataforma.

**Commit de la tanda (integrador humano)**

7. `git rm apps/admin-web/src/screens/onboarding/CocoaOnboardingWizard.tsx` y
   `git rm apps/admin-web/src/screens/tabs/configuracion/tab-helpers.tsx` (ambos figuran
   como `D`; copia en el scratchpad `c22c-removed/apps/admin-web/src/screens/...`); las
   dos entradas de `scripts/cocoa-22-waves.mjs:89,98` ya son notas de retirada.
8. `hotelos/pnpm-lock.yaml` (R25): sigue modificado desde antes de `efa8c8e` (añade
   `@fontsource-variable/inter`, `zod`, `@playwright/test` y `qrcode-terminal`, que los
   `package.json` ya declaran en `HEAD`); ningún lote de esta tanda lo tocó; César decide
   si va en el commit.

**API (fuera de las olas; causa raíz de tres hallazgos)**

9. `apps/api/src/modules/developer/api-reference.service.ts:153-158` `describe()` (qa#17):
   diccionario en español del último segmento (`settings` → «ajustes», `rooms` →
   «habitaciones», `reservations` → «reservas», `guests` → «huéspedes`, `invoices` →
   «facturas», `work-orders` → «órdenes de trabajo», `rate-plans` → «planes de tarifas»,
   sufijo `-settings` → «ajustes de …»; 526 segmentos, 916 de 941 descripciones son eco de
   la ruta), rama `PUT` («Sustituir …», 4 rutas) y `PUT: 0` en `byMethod` (`:64`, `:186`;
   la tira de KPI suma 937 ≠ 941); `:139,142,148` («HK departure task», «no-show»,
   «developer app») en español.
10. `apps/api/src/modules/backoffice/backoffice.service.ts:3320,3505,3515,3530,3637-3668`,
    `apps/api/src/modules/compliance/compliance-health.service.ts:69,72,95,97` y
    `packages/compliance/src/spain/verifactu/software.ts:129,135,166,171,190,199,201,213`
    (qa#14): mensajes de readiness sin variables de entorno, «sandbox», «stub», «flag»,
    claves inglesas ni códigos de región (valores exactos en el informe de `fix:10-C`);
    actualizar el pin `apps/api/src/modules/backoffice/__tests__/compliance-closure.test.mts:85-86`.
    Mientras tanto `lib/format.readinessMessage()` cubre las plantillas actuales y deja el
    crudo en `title`; `TaxComplianceSettings.tsx:471,479-491` (lote 10-D) aún pinta
    `verifactuHealth.notes` y `software.errors` sin pasar por él.
11. `apps/api/src/modules/ai-operations/property-ai.service.ts:253-331` (qa#3):
    `label`/`detail` del readiness en inglés (el front mapea por `key`); devolver `code`
    estable o texto en español. `apps/api/src/modules/integrations/email/email-reservation.service.ts:382,393`
    (qa#4): `createConnection` persiste `pending_auth` antes de autorizar y
    `disconnectConnection` no borra (el front ya no crea filas si el proveedor no está
    configurado). `apps/api/src/modules/compliance/compliance.service.ts:143`: el registro
    `grr_e86d63b9` (Rías Altas, DNI, `accepted`) devuelve un token `v1.…` de 79 caracteres
    como `documentNumber` (doble cifrado o clave distinta; decidir enmascarado «***678A»).
    `apps/api/src/modules/webhooks/webhooks.service.ts:233` `dispatchEvent` sin llamadores
    de dominio (el texto de `developer/WebhooksAdminScreen.tsx:247-251` lo dice).
    `screens/admin/TenantDetailScreen.tsx:85-98` `MODULE_CATALOG` no coincide con el
    manifiesto de `@hotelos/product` que usa `NewTenantWizardDialog.tsx:117-127`.

**Primitivas (`components/cocoa/**`)**

12. `CocoaSegmentedControl` usado como filtro (≈ 30 pantallas, `grep -rn '<CocoaSegmentedControl' screens | grep -v panelId`)
    emite `role=tablist` sin panel: decidir variante `role="radiogroup"` o pasar `panelId`
    del contenido filtrado (patrón de `ModuleHealthCenter` de este cierre). `AiGovernanceScreen`
    pasa 5 vistas a `tabs` (> 4 de §8.1): medir a 390 y, si no cabe, colapso a `CocoaSelect`.
13. `CocoaKpi` sin `hint` para la causa de `degraded` (SES «Datos del establecimiento»);
    `CocoaSwitch` mide 32 × 44 con puntero grueso (V6 pide 44 × 44); `CocoaFileInput` sin
    `multiple` ni zona de arrastre (`PropertyMapper` conserva su `<input type="file"
    multiple hidden>` y un `div` con `onDrop`); `CocoaCallout`/`CocoaSection`/`CocoaGrid`
    sin passthrough `data-*` (`ModuleManager`, `CategoryManager`/`CategoryDetail` envuelven
    en `div`); `CocoaTable` sin filas expandibles (`expandedKey`/`renderExpanded`);
    `CocoaSteps` (R1); `CocoaDialog` sobre `CocoaDrawer` con `Esc` sin medir (el editor de
    tipos de Impuestos se dejó en línea). R3–R9, R26–R28, R30 siguen abiertos.

**Docs, guía y copy**

14. `docs/design/COCOA-22.md` §4.1: filas «tabla de controles + ficha en `CocoaDrawer` con
    formulario y documentos» (`ComplianceCenterScreen`) e «historial + drawer con sondeo
    `pollWhile`» (`SesHospedajesSettingsScreen`); §3.2 nota «el cuerpo de `CocoaPage` es el
    tabpanel salvo `panelId` propio» (§8.2 ya lo dice). R19, R20, R23 (lint sin
    `eslint.config.js`) siguen abiertos.
15. `content/screen-instructions/allotments.ts:4-8`, `revenue.ts:4-7`,
    `frontdesk-cockpit.ts:9-12`, `reservations.ts:5-9` (además sin tildes): quitar los
    prefijos «N. » (hoy los oculta la primitiva); `cocoa-guidance/CocoaHelpButton.tsx:670-674`
    debe aplicar `stripStepOrdinal` si se monta.
16. Copy: `compliance/GdprRequestsScreen.tsx:64` «Acceso (DSAR)» → «Acceso a los datos»;
    `PaymentSettings.tsx:118-119` «PSP» → «proveedor de pago»; `AccountingSettings.tsx`
    «(habitaciones, restauración, mantenimiento…)» sustituye a «F&B» (restaurar si producto
    lo prefiere); `services/guestRegisterApi.ts:22-67` mensajes Zod en inglés que ahora
    aparecen en los `CocoaField error` de Partes de entrada («First name is required.»…);
    `TaxComplianceSettings` región fiscal con `placeholder` en vez de la opción real
    «Seleccionar…» (`value: ""`).

## 7. Lo no verificado

- **Verificación visual §5 de toda la tanda** (ningún lote tuvo navegador): las 43
  pantallas y diálogos de §2 (40 URL de Cumplimiento y Configuración más sus vistas internas), sus
  drawers y diálogos (ficha de control, historial SES, invitar/ver usuario, desactivar,
  nuevo cliente en 5 pasos, resumen de organización, eliminar suscripción, renovar secreto,
  editar política, resultados de evaluación, resolver incidencia, detalle de acción, nueva
  plantilla, detalle de herramienta, nueva tarifa, serie de facturación, desconectar buzón,
  descartar cambios, valor ESRS, confirmación de tipo) y las 15 correcciones, en
  1440/1024/390 claro y oscuro con las sondas §5.4/§5.5. Rutas `/configuracion/sistema/*` y
  `/desarrollo/*` exigen administrador de plataforma (`reception@example.com`, org_123),
  no la sesión de Carmen.
- Puntos concretos que los lotes piden mirar: `CocoaFormRow columns={3}` a 390 y 1024
  (Registro de viajeros, Auditoría, TaxCompliance); `CocoaGrid` anidada en tarjeta
  (`SetupCenter` «Todos los ajustes», R3/R4); rejilla 5/7 de `PropertyMapper` en 900–1199
  y su zona de arrastre con foco; control segmentado de 5 vistas (`AiGovernance`) y de 6
  (`ComplianceCenter`) a 390 con fade; `CocoaActionBar` de `PropertyAiScreen` a 390;
  `rowActionsVisible="always"` con puntero grueso (≥ 44 px); `<pre>` de XML dentro de la
  hoja inferior; foco inicial y `Esc` de cada drawer; qa#16 residual estimado en la
  pestaña TicketBAI de `/cumplimiento/envios` (huella mono de 16 caracteres, ≈ 60–70 px);
  `aria-controls` de la pestaña activa = id del `.c22-page__body[role=tabpanel]` (uno por
  página; `FiscalDashboard` y `ModuleHealthCenter` con sus ids propios).
- Las capturas de `fix:8-A` fallaron con la ventana del Browser pane minimizada: sus
  medidas son por DOM; qa#15 se verificó con `form.requestSubmit()`, no con un clic real.
- Estados no forzados: error de carga y vacío de cada sección revisados por código; la
  vista «Asistente IA» del centro de cumplimiento (LLM) no ejercida; guardados no
  probados contra el API (F7: no se escriben datos) — los formularios conservan las
  mismas llamadas (`updateComplianceItem/Profile`, `createComplianceDocument/Task`, `POST
  /gdpr/requests`, `patchSesSettings`, `createSpainGuestRegisterRecord`, `invite`,
  `reissue-invite`, `disable`, `PATCH` de ajustes fiscales/facturación/pagos, `POST
  …/readiness/recalculate`).
- `test:integration` no repetido (escribe en org_123/prop_123; sin cambios en el API en
  esta tanda).

## 8. Puertas §7.3 (conteos literales, cierre 2026-09-16)

| Puerta | Resultado |
|---|---|
| `node scripts/typecheck-all.mjs --parallel 3` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** (`apps/guest-web`, explícito) · 16,4 s |
| `corepack pnpm test` | **445 tests · 93 suites · 445 pass · 0 fail · 0 skipped** (tras regenerar el inventario: la regla 15 estaba en rojo solo por `lines` 89.284 → 89.457) |
| `corepack pnpm --filter @hotelos/api test` | **1.512 tests · 466 suites · 1.511 pass · 1 skipped · 0 fail** |
| Unitarios front (`node --import tsx --test …/__tests__/*.test.mts`) | **975 tests · 298 suites · 975 pass · 0 fail** (939 en `3e01b61`; +36 de la tanda) |
| `node scripts/check-discoverability.mjs` | OK · **222 pantallas alcanzables · 188/188 URLs · 0 enlaces rotos** · placeholders **16/20** |
| `node scripts/build-nav-tree.mjs --check` | al día (**67 ítems · 98 pestañas · 205 redirecciones**) |
| `node scripts/cocoa-22-inventory.mjs` | escrito · **222 pantallas · 89.457 líneas · 313 puntos** · `--summary`: bo-card 26 · bo-* 78 · `<button>` 12 (CocoaButton 1.032) · `<table>` 3 (CocoaTable 280) · inputs crudos 4 · `style={}` 801 · colores literales 2 (0 fallbacks) · cabecera Cocoa 196 · `useTabHost` 86 |
| `node scripts/cocoa-22-waves.mjs --write` / `--check` | §6 escrito · **10 pendientes · 129 puntos · 1 lote** · `--check`: §6 al día |
| `node docs/design/cocoa-22-api.mjs --check` | §8 al día · 40 ficheros · 68 interfaces · 55 type aliases · 645 props · 163 funciones · 29 constantes · 1.895 líneas |
| `node docs/design/cocoa-22-api.mjs --typecheck-examples` | 11 plantillas · **tsc 0 errores** en las plantillas y en admin-web |
| `bash .husky/pre-commit` | discoverability OK + `typecheck-all --parallel 2` **15 PASS · 0 FAIL · 1 SKIP** · 20,1 s · «Pre-commit checks passed» |
| Contrato `tests/cocoa-22-contract.test.mjs` | **18/18** (`ALLOWLIST_CEILING` 10 = `NOT_MIGRATED.length` 10; `GLOBAL_CEILING` 26 · 12 · 3 · 4 · 2 · 801 = totales regenerados) |
| `tests/admin-web-spanish-copy-contract.test.mjs` | **6/6** |

Las puertas se pasaron tres veces: al recibir el árbol (solo la regla 15 en rojo), tras
las ediciones de integración de §4 y una última vez tras regenerar inventario y §6.

## 9. Árbol de trabajo y siguiente paso

`git status` (raíz `~/anfitorio-demo`, todo bajo `hotelos/`): **73 modificados · 2
retirados (`D`: `onboarding/CocoaOnboardingWizard.tsx`, `tabs/configuracion/tab-helpers.tsx`;
copias en el scratchpad `c22c-removed/`) · 6 nuevos** (2 módulos puros + 3 tests + este
informe); +13.521 / −12.259 líneas en 74 ficheros sin contar el lockfile ni este informe
(untracked). Sin ficheros temporales, logs, sondas ni ficheros de trabajo en el repositorio
(los scripts de medida de los lotes vivieron en el scratchpad); los `.js` de
`packages/compliance/src/**` que aparecen como ignorados son salidas de compilación del
14/09 cubiertas por `.gitignore:19`, anteriores a la tanda. `hotelos/pnpm-lock.yaml` figura
modificado desde antes de `efa8c8e` (R25): no es de esta tanda y no se ha tocado; César
decide si va en el commit.

Siguiente paso (plan §7.3, fuera de este cierre): un commit por ola —o uno por tanda— con
mensaje `feat(cocoa-22/olas-8-10): …` que incluya pantallas, primitivas, hojas, helpers,
contrato, inventario, §0/§6 del plan, §8.2 de la spec y este informe (`git rm` de las dos
retiradas incluido); nunca `--no-verify`. Después arranca la **ola 11** (Compartido,
desarrollo y limpieza: 10 ficheros · 129 pts · 1 lote) con los handoffs 1–6 de §6 como
guion (`styles.css` sin `@layer cocoa-legacy`, hoja puente borrada, componentes compartidos
retirados, puente L1c cerrado, dev y muertas), los handoffs 9–11 como lote `api` y la
verificación visual §5 de las tandas A, B y C como lote con navegador.
