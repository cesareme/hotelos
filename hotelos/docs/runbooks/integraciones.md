# Runbook · Integraciones honestas de ehotelOS (Tanda L8)

Fuente: brief de la Tanda L8 («que cada integración diga la verdad sobre su estado y sea operable sin sorpresas»),
recon del carril (`scratchpad/L8/recon-delta.md`, 2026-09-20) y los runbooks de cada módulo:
[`opera-modo-sombra.md`](opera-modo-sombra.md) §14-15, [`rate-grid-v2.md`](rate-grid-v2.md) §6,
[`finanzas-importacion-sage200.md`](finanzas-importacion-sage200.md) §10, [`checkin-automatizado.md`](checkin-automatizado.md)
§1 y §13, [`reputacion-reviews.md`](reputacion-reviews.md) §3, [`documentos-digitalizacion.md`](documentos-digitalizacion.md)
§2 y §11, [`ai-core.md`](ai-core.md) §1 y [`../channel-manager-connectivity.md`](../channel-manager-connectivity.md) §4.
Código de lectura de estado (ningún lector nuevo de `process.env`; censo `tests/env-contract.test.mjs`):
`readChannelEnv` (`modules/channel-manager/env.partial.ts:85`), `aiConfigSummary` / `describeAiHealthCheck`
(`lib/ai-config.ts:70-95`), `emailProvidersStatus` (`modules/integrations/email/email-reservation.service.ts:145`),
`emailStatus` (`modules/notifications/providers/email.provider.ts:42`), `isWhatsappConfigured` (`whatsapp.provider.ts:14`),
`isSmsConfigured` (`sms.provider.ts:8`), `unsignedWebhookMode` (`routes/webhooks-whatsapp.routes.ts:113`), `pspStatusFor`
(`modules/payments/psp/index.ts:71`), `getComplianceHealth` (`modules/compliance/compliance-health.service.ts:304`),
`resolveVerifactuSoftware` (`packages/compliance/src/spain/verifactu/software.ts:187`), `describeDocumentStorageHealth`
(`modules/documents/documents.config.ts:182`), `getOverview` del modo sombra (`modules/pms-shadow/pms-shadow.service.ts:725`),
`listReviewSources` (`modules/reputation/review-sources.service.ts:173`), `listLedgerImports`
(`modules/accounting/import/ledger-import.service.ts:2303`). Rutas del contrato: `docs/api-contracts.md` («Estado de las integraciones (Tanda L8 · L8-05)», «Integration
Marketplace» con el hub honesto y `/health` en «Plataforma»).

**Todos los datos de este documento son de configuración o agregados**: nunca se cita aquí un huésped, un usuario ni una
credencial. Las cifras «hoy» son las de la BD del carril `hotelos_l8` (copia de la demo local) el 2026-09-20.

Estado 2026-09-20 (v2 · lote L8-09, cierre de la tanda; la v1 la escribió L8-04 a las 12:33 con el cableado aún pendiente):
todo lo que describe este runbook está en el árbol del worktree `~/anfitorio-demo-wt-l8/hotelos` (rama `tanda-l8`, base
`a069906`, BD `hotelos_l8`, `migrate status` 24/24 y `db:drift:check` 0: la tanda no necesitó migración). Por lote: contrato
compartido `packages/shared/src/integrations-status-types.ts` y servicio `integrations-status.service.ts` (L8-01); hub heredado
honesto y `checks.redis` / `dependencies.redis` veraces (L8-01/L8-02); KPI «Enviadas» solo reales + `simulated` en
Comunicaciones (L8-03); este runbook (L8-04); ruta `GET /integrations/status` y clave superior `integrations` de `/health`
cableadas en `server.ts` (L8-05); panel `IntegrationsStatusPanel` en la pestaña Integraciones (L8-06); Pagos, Exportar a
gestoría, `GoLiveChecklist`, guía de revenue, referencia del API y manual §3.3 honestos (L8-07). Verificado en runtime el
2026-09-20 a las 13:33 con una instancia propia del carril en `:3949` (`:3935` lo sirve una instancia hermana del mismo
worktree, PID 86954, arrancada a las 13:18 y no tocada): §1 «Línea base», §2.1, §2.2 y §2.4. Los tests de L8-08 entraron en el árbol a las 13:27, mientras se
cerraba este lote: `tests/integrations-honesty-contract.test.mjs` (21 casos, fuente sin BD; exige una fila por `IntegrationKey`
en §1 de este runbook), `tests/integration/integraciones-estado.test.mts` (10 casos, Postgres) y
`apps/admin-web/e2e/integrations-status.spec.ts`; §6 los cita con su nombre real y su resultado.

## 0 · Vocabulario de modos (`none | sandbox | real`, contrato `integrations-status-types.ts`)

| Campo | Valores y significado (fijos por el contrato) | Regla que fija el servicio y el test de honestidad |
| --- | --- | --- |
| `mode` | `none` = no hay integración operativa (sin credenciales, sin perfil, sin filas, o el componente no aplica / nadie lo consume) · `sandbox` = simulador local, registro «SIMULADO» o entorno de pruebas del proveedor: ningún resultado tiene efecto real ni se presenta como tal · `real` = los datos son reales y cruzan de verdad, **por HTTP o por ficheros reales cargados** (informes OPERA, lotes Sage 200, CSV de reseñas) | Un modo `sandbox` nunca dice «enviado»; un modo `none` nunca simula un resultado real. Etiquetas de pantalla `INTEGRATION_MODE_LABELS_ES`: «Sin integración» · «Pruebas (sin efecto real)» · «Real». |
| `transport` | `http` (API del proveedor) · `files` (ficheros reales cargados o generados) · `manual` (una persona lo hace a mano) · `none` (nada cruza) | Etiquetas «API (red)» · «Ficheros» · «Manual» · «Ninguno». |
| `configured` | Hay configuración o filas para la integración, sea cual sea el modo | Redis puede estar `configured:true` y en `none` (variable presente, sin consumidor). |
| `readyForReal` | `true` **solo** si `mode === "real"` y `missingForReal` está vacío | `none` ⇒ `readyForReal:false`. |
| `missingForReal[]` | Frases en español: la credencial, el contrato o la decisión que falta para operar en real sin reservas | Sin URLs, buckets, endpoints ni nombres de variables secretas (también en el bloque público de `/health`); se habla de «credenciales», «tope de modo», «certificado». |
| `lastActivityAt` / `lastError` | Última actividad real o simulada (ISO 8601) y último error registrado (≤ 240 caracteres) | `none` ⇒ `lastActivityAt:null`. Nunca contadores inventados: los números salen de filas reales. |
| `screen` | Ruta del admin-web donde se opera la integración (`INTEGRATION_SCREENS`); `null` para Sentry y Redis | Rutas ya existentes en `pilots/tanda5-nav-tree.csv`: L8 no añade rutas de front. |

Cómo se mapea el vocabulario propio de cada familia (el servicio lo aplica; ninguna palabra se renombra en su módulo):

- Canales `stub | sandbox | real` (`CHANNEL_MAX_MODE` y `Channel.mode`, `channelsStatus`): modo efectivo por canal = mínimo entre
  el tope y el pedido; la integración es `real` si **algún** canal activo queda en `real`, `sandbox` si todos van al simulador,
  `none` sin canales o sin ninguno activo.
- Cumplimiento `sandbox | preproduction | production` (`complianceStatus`): `sandbox` → `sandbox` («Modo de pruebas local… las
  respuestas son simuladas»); `preproduction` → **`real`** con transporte `http` («los envíos llegan al entorno de pruebas oficial…
  sin efectos fiscales ni legales», `missingForReal` incluye «Decisión: pasar a producción»); `production` → `real`. `enabled:false`
  (TBAI sin territorio foral) → `none`.
- Notificaciones salientes (`whatsappStatus`, `smsStatus`, `emailOutStatus`): con credenciales → `real`; sin credenciales **fuera de
  producción** → `sandbox` (las entregas se registran «SIMULADO» y no salen); sin credenciales **en producción** → `none` (se
  registran como fallidas, no se simulan).
- Correo entrante (`emailInStatus`): `real` con credenciales OAuth de Google o Microsoft (aunque aún no haya buzón autorizado:
  entonces `missingForReal` = «Autorizar al menos un buzón»); `none` sin ellas (transporte `manual` si existe el buzón manual).
- Reseñas (`gbpStatus`): `real`/`http` con fuente `google` en modo `api` operativa; `real`/`files` con fuente `csv` o `email`
  operativa (la API de Google sigue en `missingForReal`); `sandbox` solo con fuente `demo`; `none` sin fuentes operativas.
- PSP (`pspStatus`): `none` sin proveedor; `sandbox` con Stripe `sk_test_` o Redsys `test`; `real` con `sk_live_` / `live`.
- Almacén (`storageStatus`): `unconfigured` → `none`; `inline` y `disk` → **`sandbox`** («funciona, pero nada se guarda en S3»);
  `s3` → `real` «configurado, no comprobado» con `missingForReal` = «Comprobación de acceso al bucket (no existe…)».
- IA (`aiStatus`): `real` solo con `configured:true`; `none` con `provider none` o declarado pero no operativo (motivo
  `falta la clave` / `proveedor no soportado` / `modelo no permitido`). Sentry: `real` con DSN, `none` sin él. Redis: `real`
  solo con `consumerCount > 0` (hoy 0 siempre) → `none` aunque `REDIS_URL` exista.
- OPERA (`operaStatus`): `real`/`files` con perfil `active` (aunque el último informe haya fallado: entonces `lastError`); `none`
  sin perfil activo. Sage 200 (`sage200Status`): `real`/`files` con ≥ 1 lote; `none` sin lotes. Exportación a gestoría
  (`gestoriaExportStatus`): siempre `real`/`manual` («Formatos A3 y Sage 200 no implementados»).

## 1 · Tabla de estados (una fila por `IntegrationKey` de `INTEGRATION_KEYS`)

Columnas: modo hoy en el carril (el que calcula `integrations-status.service.ts` con la BD `hotelos_l8`, contrastado con las
consultas de §5 y las sondas de §2.4) · cómo se decide el modo (función pura + lector existente) · variables y tablas ·
pantalla (`screen` del contrato + pantalla operativa del árbol de navegación `pilots/tanda5-nav-tree.csv` con sus roles) ·
qué falta para `real` (la lista `missingForReal` del servicio, ampliada con lo que solo se sabe fuera del código) · quién lo
aporta.

**Línea base real del carril** (2026-09-20; `scratchpad/L8/health-base.json` capturado a las 12:05 antes de la tanda y las
consultas de §5 al cierre): `/health` `status healthy`; `dependencies { postgres ok, redis ok → unconfigured desde L8-01,
objectStorage inline }`; `checks.redis` «configured» sin ningún consumidor; `checks.sentry` «disabled»; `checks.verifactu`
`mode=sandbox` con `software.ok:false` y 3 errores (razón social del productor, NIF del productor, número de instalación);
`checks.sesHospedajes` `mode=sandbox`; `checks.ai` `provider=none … reason=not_configured`; `env ok (7 avisos)`. BD
`hotelos_l8`: 7 canales, todos `sandbox` (6 activos + 1 inactivo, repartidos en dos propiedades), 1 perfil OPERA `opera_cloud`
`active` con 9 runs, 50 lotes Sage 200 `posted`, 0 `payment_provider_connections`, 0 `email_connections`, 1 fuente de reseñas
`csv` `connected`, 222 entregas de correo `sent` «SIMULADO» + 1 real, 66 acuses VeriFactu del stub, SES 9 acuses del stub + 149
fallidas, hub heredado 1 conexión ficticia. Lo que devuelve `GET /integrations/status` con ese estado (verificado 2026-09-20 en
`:3949`, `degraded: []`): `prop_123` (contexto demo) → **2 `real`** (`gestoria_export` manual, `gbp` files con requisitos
pendientes) · **7 `sandbox`** (`channels` «3 de 3 canales activos, todos en simulador local», `whatsapp`, `email_out`, `sms`,
`ses`, `verifactu`, `storage`) · **9 `none`** (`opera`, `sage200`, `psp`, `email_in`, `tbai`, `igic`, `ai`, `sentry`, `redis`);
`prop_uxday` (tenant de prueba `org_uxday`) → 1 · 6 · 11 en la tanda y **1 · 5 · 12 tras el corrector L8 (REV-01)**: `channels` y `gbp` `none`
(sin canales ni fuentes) y `ses` `none` («Desactivado para este establecimiento y sin envíos en los últimos 180 días»: interruptor
apagado en `properties` y `property_compliance_settings`); `verifactu` sigue `sandbox` «activo solo por uso» (24 facturas emitidas con
el interruptor apagado) con «Activar VeriFactu para el establecimiento» al frente de `missingForReal`. Son los
tres contadores que pinta el panel (§2.3).

\2 | Modo hoy (carril L8, 2026-09-20) | Cómo se decide el modo | Variables / tablas | Pantalla | Qué falta para `real` | Quién lo aporta |
| --- | --- | --- | --- | --- | --- | --- |
| `opera` · OPERA Cloud (modo sombra) | **`real` · `files`** en Rías Altas: 1 perfil `opera_cloud` `active`; runs `api_key` 5 done · 2 partial · 1 failed, `cli` 1 done; 1 `DeveloperApp` con scope `pms.shadow.ingest`; 0 buzones `pms_shadow`. En `prop_uxday`: `none` («Sin perfil de modo sombra…», overview `profile:null` verificado 2026-09-20). Sin conexión OHIP: el modo sombra es ingesta de informes por diseño | `operaStatus`: `none` sin perfil `active`; `real` con perfil activo (informes reales) — `lastError` si el último run es `failed`/`partial`; `missingForReal` añade la clave de ingest o el buzón si no hay ninguno y «Primer informe recibido» si no hay runs. Lector de datos: `pms_shadow_profiles`, último `pms_shadow_runs`, `developer_apps` (scope), `email_connections` (`purpose pms_shadow`); pantalla vía `getOverview` (`pms-shadow.service.ts:725`) | `PMS_SHADOW_JOB_DISABLED` (`modules/pms-shadow/env.partial.ts:18`), `PMS_SHADOW_JOB_INTERVAL_MS` (:24), `PMS_SHADOW_INGEST_URL` (:34) y `PMS_SHADOW_API_KEY` (:41, agente `pms-shadow:pull`, severidad warn); tablas `pms_shadow_profiles`, `pms_shadow_runs`, `pms_shadow_links`, `developer_apps`, `email_connections` | `screen` `/configuracion/modulos/modo-sombra` = Configuración › Módulos e integraciones › **Modo sombra OPERA** (direccion, admin, auditoria; `integrations.read`) + Recepción › Reservas › Importar `/recepcion/reservas/importar` | Corte diario automático: agente de carpeta o Report Scheduler hacia el buzón `pms_shadow` (dominio remitente), muestras reales de los informes 3-7 y del XML de ingresos (§14 del runbook OPERA), criterio contable por transaction code, decisión `RESV_NAME_ID` vs `CONFIRMATION_NO` (§15). OHIP (fase 2): Enterprise ID, Chain Code, Region, Hotel IDs, dueño del app key | **César** (hotel codes, hora del night audit, listados `cf_*`, muestras, SFTP/allowlist, OHIP); gestoría (criterio contable); producto (`adoptLocal`) |
| `sage200` · Sage 200 (importación contable) | **`real` · `files`** en Faranda: `ledger_imports` `sage200` 50 `posted` («No existe conexión directa con Sage 200: la carga es por ficheros»). En `org_uxday`: `none` («Sin lotes importados…») | `sage200Status`: `none` con 0 lotes de la organización; `real` con ≥ 1 lote (`missingForReal` = «Contabilizar al menos un lote» si ninguno está `posted`). Datos: `count` y último `ledger_imports` por organización; pantalla vía `listLedgerImports` (`ledger-import.service.ts:2303`) | Sin variables; tablas `ledger_imports`, `ledger_import_rows`, `vat_settings`, mapa analítico persistido | `screen` `/finanzas/contabilidad/importar-sage200` = Finanzas › Contabilidad › **Importar desde Sage 200** (finanzas, direccion, admin, auditoria) | Nada para el modo (ya es real por ficheros). Cadencia diaria solo con SQL o buzón XML (fuera de alcance); decisiones 1-8 de §10 del runbook Sage para los lotes siguientes | **César** + gestoría (decisiones §10) |
| `gestoria_export` · Exportación a gestoría | **`real` · `manual`** siempre: `csv_universal`, `vat_books_csv`, `contaplus_diario` («compatible ContaPlus / Sage 50», `validateWithAdvisor`); `a3` → 409 `EXPORT_FORMAT_NOT_IMPLEMENTED`; **no existe formato Sage 200** (`gestoria-export.service.ts:1-27`). `gestoria_exports` sin filas en el carril (`lastActivityAt:null`) | `gestoriaExportStatus`: modo fijo `real`/`manual`, `missingForReal` vacío; el mensaje avisa «Formatos A3 y Sage 200 no implementados» | Sin variables; tabla `gestoria_exports` (contenido inline, 413 `EXPORT_TOO_LARGE`) | `screen` `/finanzas/contabilidad/exportar-gestoria` = Finanzas › Contabilidad › **Exportar a gestoría** (finanzas, direccion, admin, auditoria) | Para un formato Sage 200: especificación del fichero de importación de Sage 200 validada por la gestoría (decisión D-04) | **César** + gestoría; producto (formato nuevo) |
| `channels` · Canales de venta (OTAs) | **`sandbox` · `http`** en prop_123 / Los Tilos: `CHANNEL_MAX_MODE` sin definir → tope `sandbox`; 7 canales todos `mode = sandbox` en dos propiedades: `prop_123` 3 activos (`booking_com`, `channex`, `expedia`) → «3 de 3 canales activos, todos en simulador local… nada sale a Internet» (verificado 2026-09-20 en `GET /integrations/status`); la 2.ª propiedad real 4 (los mismos 3 activos + `airbnb` inactivo). En `prop_uxday`: `none` (`channels: []`, verificado 2026-09-20) | `channelsStatus`: modo efectivo por canal = mín(tope, pedido) (`readChannelEnv().maxMode`, `env.partial.ts:85-100`; `modeCheck` `readiness.core.ts:103`, `SANDBOX_MEANING` :28); `real` si algún canal activo queda en real; `sandbox` si todos van al simulador; `none` sin canales o sin activos. `missingForReal`: «Subir el tope de modo…», «Al menos un canal activo en modo real con credenciales», «Contrato o certificación con el agregador (Channex) o con cada OTA» | `CHANNEL_MAX_MODE` (`modules/channel-manager/env.partial.ts:36`, enum `stub \| sandbox \| real`, defecto `sandbox`), `CHANNEX_BASE_URL` (:45), `CHANNEL_DRAIN_INTERVAL_MS` (:54), `CHANNEL_DRAIN_DISABLED` (:62), `CHANNEL_DRAIN_BATCH_LIMIT` (:68), `CHANNEL_DELIVERY_RETENTION_DAYS` (:76); tablas `channels` (`mode`, `status`, `credentials_encrypted`, `last_sync_at`), `channel_deliveries`, `channel_sync_jobs` | `screen` `/comercial/canales` = Comercial › **Canales de venta** (revenue, comercial, direccion, admin, auditoria); Revenue › Parrilla `/revenue/parrilla` (panel de sincronización) | Vía a producción = Channex: cuenta staging + API key, ids de propiedad y productos, extranet ids de Booking/Expedia de Rías Altas y Los Tilos; Booking directo (altas pausadas) y Expedia EQC (contrato/PCI) sin cuenta; `CHANNEL_MAX_MODE=real` **solo** en producción (§4 de channel-manager-connectivity) | **César** (cuenta Channex, ids, decisión de proveedor, certificación §7) |
| `psp` · Pasarela de pago (PSP) | **`none`**: sin `STRIPE_SECRET_KEY` ni `REDSYS_MERCHANT_CODE`; `payment_provider_connections` 0 → «Ningún PSP configurado: sin cobros con tarjeta en línea ni enlaces de pago» (la ruta `psp-status` exige `payment.capture`, que las plantillas de `org_uxday` no tienen: 403 verificado 2026-09-20; el modo se leyó por código) | `pspStatus` sobre `pspStatusFor` (`psp/index.ts:71`; `selectPspProvider` :49-62: `PAYMENTS_PSP_PROVIDER` → conexión `connected` → primer adaptador con credenciales): `none` sin proveedor; `sandbox` con `mode test` («ninguna tarjeta real y ningún cobro con efecto»); `real` con `live` (aviso si falta el secreto del webhook). El registro sandbox en memoria (`sandboxPspRegistry` :31-36) solo se activa por `setPspRegistry` (:40, tests/demo), nunca por variable | `PAYMENTS_PSP_PROVIDER` (`modules/payments/env.partial.ts:23`), `PAYMENTS_PUBLIC_BASE_URL` (:29), `STRIPE_SECRET_KEY` (:36, patrón `sk_(test\|live)_`), `STRIPE_WEBHOOK_SECRET` (:43, obligatoria con la clave), `REDSYS_MERCHANT_CODE` (:51), `REDSYS_TERMINAL` (:57), `REDSYS_SECRET_KEY` (:63), `REDSYS_MODE` (:70); tabla `payment_provider_connections` | `screen` `/configuracion/facturacion-pagos/pagos` = Configuración › Facturación y pagos › **Pagos** (finanzas, direccion, admin, auditoria). Desde L8-07 la pantalla lee la fila `psp` de `GET /integrations/status` (`fetchIntegrationsStatus`) y muestra el hub heredado como «Conexiones de demostración (catálogo heredado)» (auditoría A1 cerrada); el readiness `payment_provider_connected` usa `pspStatusFor` (L8-01) | Cuenta Stripe (`sk_live_` + `whsec_`) **o** comercio Redsys (FUC, terminal, clave), origen público HTTPS, decisión enlace de pago vs preautorización (check-in §13 N4·D3), política de reembolsos | **César** (cuenta y contrato con el PSP, decisión N4) |
| `whatsapp` · WhatsApp | **`sandbox` · `none`** (carril, `NODE_ENV≠production`): sin `WHATSAPP_PHONE_ID`/`WHATSAPP_PROVIDER_TOKEN` → «los envíos se registran como SIMULADO y no salen del sistema; webhook de entrada rechazado hasta configurar el secreto» (`unsignedWebhookMode` → `refused` sin `WHATSAPP_APP_SECRET`). En producción sería `none` (fallidos, no simulados) | `whatsappStatus`: `real` con salida configurada (`isWhatsappConfigured`, `whatsapp.provider.ts:14-18`; `missingForReal` = secreto del webhook si no está `signed`); sin salida: `sandbox` fuera de producción, `none` en producción. `lastActivityAt` = última entrega real o simulada de `notification_deliveries` (`channel whatsapp`) | `WHATSAPP_PHONE_ID` (`lib/env.ts:409`), `WHATSAPP_PROVIDER_TOKEN` (:414; `WHATSAPP_TOKEN` :421 obsoleta), `WHATSAPP_APP_SECRET` (`modules/checkin/env.partial.ts:94`), `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED` (:100, *dangerous*), `WHATSAPP_VERIFY_TOKEN` (:107); tabla `notification_deliveries` | `screen` `/configuracion/comunicaciones` = Configuración › Comunicaciones › **Plantillas y envíos** (direccion, recepcion, admin, sistemas, auditoria); operación en Hoy › **Check-in automatizado** `/hoy/check-in-automatizado` | Cuenta WhatsApp Business (Tech Provider o BSP), número por hotel, plantillas *utility* aprobadas, opt-in, presupuesto post-01/10/2026 (check-in §13 N3·D6); el dispatcher aún no pasa `template` (límite §13) | **César** (cuenta, número, plantillas, opt-in); producto (`template` en el dispatcher) |
| `email_out` · Correo saliente | **`sandbox` · `none`** (carril): `emailStatus()` → `{ configured:false, provider:null, mode:"simulated" }` (verificado 2026-09-20 en `GET /notifications/email-status`) → «los envíos se registran como SIMULADO y no salen del sistema»; `notification_deliveries` email `sent` 222 «SIMULADO…» + 1 real histórica (`lastActivityAt` = última simulada). En producción sería `none` (`disabled`, fila `failed`) | `emailOutStatus` sobre `emailStatus(env)` (`email.provider.ts:42-47`): `real` con los tres `EMAIL_*`; `simulated` → `sandbox`; `disabled` → `none`. Las filas simuladas llevan `SIMULATED_ERROR_MESSAGE` (`dispatcher.service.ts`, L8-03) y `TemplateStat.simulated` las cuenta aparte | `EMAIL_PROVIDER` (`lib/env.ts:369`, enum `postmark \| sendgrid`), `EMAIL_PROVIDER_KEY` (:376, secreto, obligatoria con el proveedor), `EMAIL_FROM` (:383, remitente verificado); tabla `notification_deliveries` | `screen` `/configuracion/comunicaciones` (KPI «Enviadas» solo reales; «N simuladas (sin proveedor)», L8-03) | Cuenta en Postmark o SendGrid con dominio remitente verificado (SPF/DKIM) y la clave; decidir remitente por hotel o único (check-in §13 N2) | **César** (cuenta, dominio, clave) |
| `sms` · SMS | **`sandbox` · `none`** (carril): `isSmsConfigured()` false → «los envíos se registran como SIMULADO…»; sin entregas `sms` en la BD (`lastActivityAt:null`). En producción sería `none` | `smsStatus` sobre `isSmsConfigured()` (`sms.provider.ts:8-13`): `real` con SID + token + `TWILIO_FROM`; no hay sandbox de Twilio contemplado | `TWILIO_ACCOUNT_SID` (`lib/env.ts:390`), `TWILIO_AUTH_TOKEN` (:395, obligatoria con el SID), `TWILIO_FROM` (:402, E.164); tabla `notification_deliveries` (`channel sms`) | `screen` `/configuracion/comunicaciones` | Cuenta Twilio, número E.164 propio, decisión de si el SMS se usa (OTP del check-in, alertas) | **César** |
| `email_in` · Correo entrante (OAuth) | **`none` · `none`**: `emailProvidersStatus()` → gmail `false`, microsoft `false`, imap `false` («Requiere la dependencia 'imapflow' (no instalada)»), manual `true` (verificado 2026-09-20 en `GET /integrations/email/providers`) → «Sin credenciales OAuth de Google ni Microsoft: solo queda el buzón manual»; `email_connections` 0 | `emailInStatus` sobre `oauthConfig(provider)` (`email-reservation.service.ts:129-144`) + `email_connections` de la propiedad: `real` con `GMAIL_CLIENT_ID`+`SECRET` o `MS_CLIENT_ID`+`SECRET` (buzón `connected` tras el callback `GET /integrations/email/oauth/callback`, `server.ts:2878`; sin buzón, `missingForReal` = «Autorizar al menos un buzón»); `none` sin credenciales (transporte `manual` si hay buzón manual) | `GMAIL_CLIENT_ID` (`lib/env.ts:427`), `GMAIL_CLIENT_SECRET` (:432), `GMAIL_REDIRECT_URI` (:439), `MS_CLIENT_ID` (:444), `MS_CLIENT_SECRET` (:449), `MS_TENANT` (:456); tabla `email_connections` (`provider`, `status`, `config_json.purpose`, `last_sync_at`, `last_error`) | `screen` `/configuracion/comunicaciones/correo-entrante` = Configuración › Comunicaciones › **Correo entrante** (direccion, admin, sistemas) | Cliente OAuth de Google Workspace o Microsoft 365 del hotel (id + secreto + URI de retorno), un buzón por propósito y centro (`docs-<centro>@…`, documentos §11 nº 2), autorización por el dueño del buzón; IMAP exige añadir `imapflow` (dependencia nueva: fuera del carril) | **César** (proyecto OAuth, buzones, autorización); producto (IMAP si se decide) |
| `gbp` · Google Business Profile | **`real` · `files`** en la propiedad con la fuente `csv` `connected` (1 fila: «Reseñas cargadas por CSV (1 fuente conectada); la API de Google Business Profile no está autorizada»); `none` en `prop_uxday` (0 fuentes; además el módulo `reputation_quality` no está activado: 403 verificado 2026-09-20) | `gbpStatus` sobre `review_sources` de la propiedad: `real`/`http` con fuente `google` `mode api` operativa (`connected`/`degraded`); `real`/`files` con `csv`/`email` operativa; `sandbox` con `demo`; `none` sin fuentes operativas (o «Fuente de Google dada de alta pero no operativa (estado …)»). Colector `google-business-profile.ts:41-46`: `unavailable` sin `GOOGLE_BUSINESS_CLIENT_ID`, `pending` sin autorización/ubicación. **No existe ruta de autorización** (`reputation/env.partial.ts:56-62`, T8-L5) | `GOOGLE_BUSINESS_CLIENT_ID` (`modules/reputation/env.partial.ts:43`, warn), `GOOGLE_BUSINESS_CLIENT_SECRET` (:49, secreto), `GOOGLE_BUSINESS_REDIRECT_URI` (:56, HTTPS en producción), `REPUTATION_SYNC_DISABLED` (:23), `_INTERVAL_MS` (:29), `_RUN_AT_BOOT` (:37); tablas `review_sources`, `review_source_runs` | `screen` `/comercial/reputacion` = Comercial › **Reseñas** (comercial, direccion, admin, auditoria; módulo `reputation_quality`) | `missingForReal` del servicio: «Ruta de autorización OAuth de Google en el producto (no existe todavía: decisión)», «Credenciales OAuth de Google Business», «Identificador de ubicación de Google de cada hotel»; activar el módulo por propiedad; Booking/Expedia solo vía partner (informe T8 §9 nº 2-4) | **César** (proyecto Google, ubicaciones, decisión Booking/Expedia, activar el módulo); producto (T8-L5) |
| `ses` · SES.Hospedajes | **`sandbox` · `none`**: `SES_HOSPEDAJES_MODE` sin definir → `sandbox` («Modo de pruebas local: ninguna comunicación de viajeros se envía al Ministerio del Interior; las respuestas son simuladas»), `cert.configured:false` «Falta la ruta del certificado.», `readyForReal:false` (verificado 2026-09-20 en `GET /compliance/health`); `ses_hospedajes_submissions` `accepted` 9 (acuses del stub) · `failed` 149 (`lastError` = último fallo) | `complianceStatus("ses")` sobre `getSesHospedajesHealth` (`compliance-health.service.ts:116-138`; `pickMode` :61-64): `sandbox` → `sandbox`; `preproduction` → `real` (entorno oficial de pruebas); `production` → `real`. `missingForReal` = motivo del certificado + «Decisión: cambiar el modo a producción (certificado y alta en SES.Hospedajes)». Además, por propiedad: interruptor (`sesHospedajesEnabledFor`) y establecimiento (`resolveSesEstablishment`, 409 `SES_ESTABLISHMENT_INCOMPLETE`). **Corrector L8 (REV-01)**: el DTO por propiedad aplica el interruptor (`properties` ∪ `property_compliance_settings`) o el uso (envíos en 180 días, `complianceGates`): apagado y sin uso → `none` «Desactivado para este establecimiento y sin envíos en los últimos 180 días…» con «Activar SES.Hospedajes para el establecimiento (ajustes de cumplimiento de la propiedad)» al frente de `missingForReal`, sea cual sea el modo del proceso; activo solo por uso → modo del proceso + «Activo solo por uso (n envíos en los últimos 180 días): el interruptor del establecimiento está apagado.» | `SES_HOSPEDAJES_MODE` (`lib/env.ts:595`), `SES_HOSPEDAJES_CERT_PATH` (:603), `SES_HOSPEDAJES_CERT_PASSPHRASE` (:610), `SES_HOSPEDAJES_CLIENT_ID` (:617), `SES_HOSPEDAJES_CLIENT_SECRET` (:624); tablas `ses_hospedajes_submissions`, `guest_register_records`, `property_compliance_settings` | `screen` `/cumplimiento/envios` = Cumplimiento › **Envíos a autoridades** (finanzas, recepcion, direccion, admin, auditoria; marca «Simulado · no enviado» por `endpoint stub://`); operación en Cumplimiento › Registro de viajeros › **SES.Hospedajes** `/cumplimiento/registro-viajeros/ses-hospedajes` (todavía sin el criterio `stub://`: auditoría B1) | Alta por establecimiento (`sesRegistryNumber`, usuario del WS), certificado XAdES del titular (FNMT) y contraseña, `preproduction` antes de `production`, documentación técnica oficial para contrastar `xml.ts` (check-in §13 N5), bloque de establecimiento completo (RA sigue `blocked`) | **César** (alta, certificado, datos censales); asesor (firma en tablet, §13 N8) |
| `verifactu` · VeriFactu | **`sandbox` · `none`**: `VERIFACTU_MODE` sin definir → `sandbox` («ningún registro de facturación se envía a la AEAT; las respuestas son simuladas»); `cert.configured:false`; `software.ok:false` con 3 errores (razón social del productor, NIF del productor, número de instalación) que pasan a `missingForReal` (verificado 2026-09-20 en `/health` `checks.verifactu` y `GET /compliance/health`); `verifactu_submissions` `accepted` 66 (47 `mode sandbox` + 19 sin modo, todas del stub) | `complianceStatus("verifactu")` sobre `getVerifactuHealth` (`compliance-health.service.ts:83-110`): `readyForReal` del módulo = modo ≠ sandbox **y** certificado **y** `resolveVerifactuSoftware(process.env).ok`; fuera de sandbox un bloque inválido impide el arranque. Sociedad en SII → excluida (`VERIFACTU_EXCLUDED_BY_SII`); instalación por centro (`verifactu_installations`, `INSTALLATION_NOT_DECLARED`). **Corrector L8 (REV-01)**: por propiedad, interruptor `verifactuEnabled` o facturas emitidas (`issued | cancelled | rectified`): apagado y sin facturas → `none` «Desactivado para este establecimiento y sin facturas emitidas…» + «Activar VeriFactu para el establecimiento (ajustes de cumplimiento de la propiedad)»; activo solo por uso → modo del proceso + «Activo solo por uso (n facturas emitidas)…» (`prop_uxday` hoy) | `VERIFACTU_MODE` (`lib/env.ts:469`), `VERIFACTU_SOFTWARE_NAME` (:477), `VERIFACTU_SOFTWARE_NIF` (:485), `VERIFACTU_SYSTEM_NAME` (:492), `VERIFACTU_SYSTEM_ID` (:500), `VERIFACTU_SYSTEM_VERSION` (:509), `VERIFACTU_INSTALL_NUMBER` (:515), `VERIFACTU_MULTI_OT` (:523), `VERIFACTU_SIGN_PEM` (:544) / `VERIFACTU_SIGN_PEM_PASSPHRASE` (:549) o `VERIFACTU_CERT_PATH` (:555) / `VERIFACTU_CERT_PASSPHRASE` (:560), `VERIFACTU_MAX_ATTEMPTS` (:566), `VERIFACTU_SCHEDULER_DISABLED` (:713) / `_INTERVAL_MS` (:715); tablas `verifactu_submissions`, `verifactu_installations`, `invoices` | `screen` `/cumplimiento/verifactu` = Cumplimiento › **VeriFactu** (finanzas, direccion, admin, auditoria); Configuración › **Facturación** `/configuracion/facturacion-pagos` (conector y certificado); Cumplimiento › Envíos `/cumplimiento/envios` | Declaración responsable del productor (nombre, NIF del productor, id y versión del sistema — en producción hoy los de la declaración vigente, CLAUDE.md «Marca y despliegue»), número de instalación por despliegue, certificado del obligado tributario, `preproduction` antes de `production`, política de cadena por sociedad | **César** (declaración responsable, certificado, instalación); asesor fiscal (cadena, SII) |
| `tbai` · TicketBAI | **`none`**: `enabled:false` → «No aplica: ninguna propiedad declara territorio foral (Bizkaia, Gipuzkoa, Araba o Navarra)» (verificado 2026-09-20) | `complianceStatus("tbai")` sobre `getTbaiHealth(foralPropertyIds)` (:144-168): `enabled` solo con `Property.fiscalTerritory` foral; `readyForReal` del módulo = enabled **y** `TBAI_MODE=production` **y** certificado. No existe `preproduction` (`lib/env.ts:641`). **Corrector L8 (REV-01/REV-03)**: por propiedad, `none` «No aplica: el establecimiento no declara territorio foral (Bizkaia, Gipuzkoa, Araba o Navarra)» salvo territorio foral en la ficha del centro (`complianceGates`); en `/health` habla del proceso (`getTbaiHealth(null)` vía `describeComplianceEnvironment()`, sin BD): modo del entorno + «Aplica solo a los establecimientos con territorio foral; el modo efectivo se lee por propiedad.» | `TBAI_MODE` (`lib/env.ts:641`, `sandbox \| production`), `TBAI_CERT_PATH` (:649), `TBAI_CERT_PASSPHRASE` (:657), `TBAI_LICENSE_KEY` (:664), `TBAI_DEVICE_SERIAL` (:672); tabla `tbai_submissions` | `screen` `/cumplimiento/verifactu` (pestaña TicketBAI `/cumplimiento/verifactu/ticketbai`) | Solo si un hotel tributa en territorio foral: territorio en la ficha del centro, licencia y serie del dispositivo, certificado | **César** (solo si aplica) |
| `igic` · IGIC (Canarias) | **`none` por diseño**: «No es una integración propia: Canarias declara por VeriFactu con Impuesto=03; el estado real es el de VeriFactu» (`igicStatus`; `getIgicHealth` :170-187 `enabled:false`) | Siempre `none`, `missingForReal` vacío | `IGIC_MODE` (`lib/env.ts:680`), `IGIC_CERT_PATH` (:688), `IGIC_CERT_PASSPHRASE` (:695) — declaradas sin conector | `screen` `/cumplimiento/verifactu` | Nada: retirar las variables o documentarlas como sin uso | Producto (decisión de retirar `IGIC_*`) |
| `storage` · Almacén de documentos (S3) | **`sandbox` · `none`**: `DOCUMENT_STORAGE_KIND` sin definir → `inline` («Almacén local en la base de datos (inline): funciona, pero nada se guarda en S3»); `/health` `dependencies.objectStorage = inline` (verificado 2026-09-20) | `storageStatus` sobre `describeDocumentStorageHealth()` (`documents.config.ts:182-193`): `unconfigured` → `none`; `inline`/`disk` → `sandbox` (`missingForReal` = «Credenciales y bucket de S3», «Decisión: almacén externo en lugar del local»); `s3` → `real` «configurado, no comprobado: el adaptador solo firma las peticiones» (`s3-storage.ts` sin sonda; recon nº 7) | `DOCUMENT_STORAGE_KIND` (`modules/documents/env.partial.ts:39`, obligatoria en producción, `inline` prohibido allí), `DOCUMENT_STORAGE_DIR` (:49), `DOCUMENT_S3_ENDPOINT` (:60), `DOCUMENT_S3_REGION` (:69), `DOCUMENT_S3_BUCKET` (:76), `DOCUMENT_S3_ACCESS_KEY_ID` (:84), `DOCUMENT_S3_SECRET_ACCESS_KEY` (:90), `DOCUMENT_ENCRYPT_AT_REST` (:113); `HOTELOS_FIELD_KEY` → `ENCRYPTION_KEY` para `disk` | `screen` `/operaciones/digitalizar` = Operaciones › **Digitalizar** (recepcion, administracion, direccion, fnb, pisos, mantenimiento, admin); archivo en Finanzas › Proveedores › **Archivo** `/finanzas/proveedores/archivo` | `disk` en el VPS (volumen del compose + backup) sigue siendo `sandbox` para este contrato; `real` exige S3 compatible en la UE (región europea, art. 22 RD 1619/2012), bucket privado, credenciales, y una sonda de acceso al bucket (no existe: producto) | **César** (proveedor, región, bucket, credenciales; documentos §11 nº 5); producto (sonda) |
| `ai` · Proveedor de IA | **`none`**: `AI_PROVIDER` sin definir → «Sin proveedor de IA: las funciones de IA responden «no configurado» y no inventan resultados»; `/health` `checks.ai` «provider=none … reason=not_configured» (verificado 2026-09-20). Todo va por reglas: asistente `deterministic`, MRZ por reglas, captura por imagen → `DOCUMENT_UNREADABLE`, borradores de reseñas `source: rules` | `aiStatus` sobre `aiConfigSummary()` (`lib/ai-config.ts:86-95`; `getAiConfig` una vez por proceso): `real` solo con `configured:true` (`AI_PROVIDER=anthropic` + clave sin marcador + `AI_USD_EUR_RATE`); `none` con `provider none` o no operativo (`falta la clave` / `proveedor no soportado` / `modelo no permitido`; `budget_unavailable` sin tipo de cambio). Sin `sandbox`: o hay modelo o hay reglas | `AI_PROVIDER` (`lib/env.ts:723`), `AI_PROVIDER_API_KEY` (:730), `AI_MODEL` (:737), `AI_MODEL_CLASSIFY` (:738), `AI_MODEL_INSIGHTS` (:739), `AI_REQUEST_TIMEOUT_MS` (:740), `AI_DOCUMENT_TIMEOUT_MS` (:741), `AI_MONTHLY_BUDGET_EUR_DEFAULT` (:742), `AI_RATE_LIMIT_PER_MINUTE` (:749), `AI_USD_EUR_RATE` (:750), `AI_INFERENCE_GEO` (:758); tablas `ai_tool_calls`, `property_ai_settings` | `screen` `/configuracion/ia` = Configuración › IA › **Ajustes** (direccion, admin, auditoria); readiness `GET /ai-operations/property/readiness` (check `provider`) | Clave de organización con DPA + ZDR, residencia (API directa vs Bedrock UE), presupuesto por hotel, `AI_USD_EUR_RATE`, proveedor de visión (check-in §13 N1·D1·D8; documentos §11 nº 1); después reiniciar el API y `POST /ai-operations/tools/sync` | **César** (clave, DPA, residencia, presupuesto) |
| `sentry` · Sentry | **`none`**: `SENTRY_DSN` vacío → «Sentry desactivado: los errores solo quedan en el log del proceso»; `/health` `checks.sentry` «disabled» (verificado 2026-09-20) | `sentryStatus({ configured })`, parámetro que pasa `server.ts` desde `initSentry` (`server.ts:1053-1075`: DSN ≠ vacío y ≠ `change-me`, `sendDefaultPii:false`). `real` con DSN; no hay comprobación de entrega | `SENTRY_DSN` (`lib/env.ts:806`, secreto), `VITE_SENTRY_DSN` (:812, admin-web) | `screen: null` (solo `/health`) | DSN del proyecto de Sentry (cuenta y contrato); región y retención | **César** |
| `redis` · Redis | **`none`** con `configured:true`: `REDIS_URL` está en el `.env` del carril pero ningún componente lo usa → «Dirección de Redis configurada, pero ningún componente del API la usa: hoy no aporta nada»; `/health` ya dice `checks.redis` «configured (sin consumidor en este build)» y `dependencies.redis` `unconfigured` (L8-01 en el árbol, verificado 2026-09-20 en `:3935`; antes «configured»/«ok», recon nº 4) | `redisStatus({ configured, consumerCount })`: `real` solo con `consumerCount > 0` (hoy `server.ts` pasa 0: no hay cliente, `lib/env.ts:207` «Reservada»; `deploy/README-INSTALL.md` l.65). `missingForReal` = «Decisión: un consumidor real (colas, caché o límites) que use Redis» | `REDIS_URL` (`lib/env.ts:207`, patrón `redis(s)://`); sin tablas | `screen: null` | Decidir si Redis entra (cola/limitador compartido multi-réplica) o se retira del contrato | Producto (decisión); **César** solo si se decide un Redis gestionado |

Notas de la tabla:

- El **hub heredado** (`IntegrationConnection` / marketplace) no es una `IntegrationKey`: sus proveedores son ficticios
  («Demo OTA Adapter / Demo Payment Gateway / Demo Guest Messaging», desde L8-01 con `demo:true` y `mode:"sandbox"` en
  `lib/demo-store.ts`), la prueba de conexión responde siempre `simulated` con evento `IntegrationTestSimulated` (antes `ok` +
  `IntegrationSyncStarted`, recon nº 5), el `PATCH` de estado se persiste (`updateIntegrationConnectionStatus`) y el readiness
  ya no lo cuenta como pasarela. En el carril: `integration_connections` `ip_mock_payments` `connected` 1 (fixture de `prop_123`),
  `marketplace_listings` 0, `app_installations` 0; `GET /properties/prop_uxday/integrations` → `[]` (verificado 2026-09-20). Las
  6 rutas y `credentialsSecretRef` siguen por contrato (`tests/modular-suite-contract.test.mjs:126-137`). La pestaña
  Integraciones muestra el panel de estado (L8-06) encima de ese catálogo vacío (§2.3).
- Claves con vocabulario de proveedor se muestran con su palabra original junto al modo canónico: «`sandbox` (simulador local)»,
  «`real` (preproducción, sin efectos)», «`sandbox` (SIMULADO, sin proveedor)».
- `verifactu_submissions` y `ses_hospedajes_submissions` guardan `endpoint`; con `stub://…` el acuse `accepted` es del simulador
  y toda pantalla debe pintarlo como «Simulado · no enviado» (`FiscalSubmissionsCenter.tsx:83-84` ya lo hace; la pantalla de
  SES.Hospedajes todavía no — auditoría B1).
- Faranda en la BD del carril: los 66 acuses VeriFactu y los 9 de SES son del stub (`sandbox`); las 149 comunicaciones SES
  `failed` son las bloqueadas por el registro turístico incompleto de Rías Altas y las «sustituidas» del programador (L5
  CS-02). Ninguna cifra de esta tabla implica un envío real a la AEAT o al MIR.

## 2 · Cómo leer `GET /health` (`integrations`) y la pestaña Integraciones

### 2.1 `GET /health` hoy (captura del 2026-09-20 13:33 en `:3949`, instancia propia del carril con el árbol final, `RUN_SCHEDULERS=false`)

`/health` es **pública** (sin token): nunca lleva URLs, buckets, endpoints, nombres de variables secretas ni valores; solo
modos, contadores y mensajes cortos (`tests/integration/documents-health.test.mts:77-87`; `tests/cors-contract.test.mjs:161-172`
fija líneas literales del bloque `checks` en `server.ts` — no se reestructura `checks`, se añade una clave superior).

| Clave | Valor hoy | Cómo leerlo |
| --- | --- | --- |
| `status` / `ok` | `healthy` / `true` | `degraded` solo si algún `checks.*.ok` es `false` (BD caída, env inválido fuera de producción, fallos de persistencia de auditoría, VeriFactu fuera de sandbox sin bloque `SistemaInformatico`). Ninguna integración `none` o `sandbox` degrada el estado: no es un fallo, es el modo. |
| `dependencies.postgres` | `ok` | `SELECT 1` con latencia en `checks.database.latencyMs`. |
| `dependencies.redis` | `unconfigured` | Desde L8-01 (verificado 2026-09-20 en `:3935`): siempre `unconfigured` mientras no exista consumidor; antes decía `ok` con solo `REDIS_URL` presente (recon nº 4). |
| `dependencies.objectStorage` | `inline` | Tipo de almacén que sirve el API: `unconfigured \| inline \| disk \| s3`. `s3` = configurado (firma construible), **no** «alcanzable» (recon nº 7). |
| `checks.redis` | `configured (sin consumidor en este build)` | Solo significa «`REDIS_URL` presente»: nunca alcanzable ni en uso (L8-01; antes «configured»). |
| `checks.sentry` | `disabled` | `configured` con DSN; no comprueba entrega. |
| `checks.verifactu` | `mode=sandbox` + `software { ok:false, errors[3] }` | `ok:false` **solo** fuera de sandbox con bloque inválido (el API ni arranca). En sandbox la lista de errores es la lista de lo que César debe aportar (§4 D-09). |
| `checks.sesHospedajes` | `mode=sandbox` | Solo el modo; certificado y establecimiento en `GET /compliance/health` (con sesión, `billing.compliance.view`). |
| `checks.ai` | `provider=none model=… usdEurRate=unset reason=not_configured` | `reason` ∈ `not_configured \| budget_unavailable \| model_forbidden`; nunca la clave. |
| `checks.schedulers` / `reputationSync` / `checkinJobs` / `pmsShadow` (vía schedulers) | `disabled on this instance (RUN_SCHEDULERS=false)` | Solo el líder ejecuta jobs; una instancia de carril nunca es líder. |
| `checks.env` | `ok (7 avisos)` | Solo recuentos del contrato de entorno; el texto de los avisos se ve con `node scripts/validate-env.mjs .env --role app`. |
| `checks.audit` | `ok (0 fallos de persistencia desde el arranque)` | Cadena de auditoría; runbook `auditoria-eventos.md`. |
| `integrations` | presente (L8-05; verificado 2026-09-20 en `:3949`): 14 claves en el orden `gestoria_export`, `channels`, `whatsapp`, `email_out`, `sms`, `email_in`, `ses`, `verifactu`, `tbai`, `igic`, `storage`, `ai`, `sentry`, `redis`; hoy 1 `real` (`gestoria_export`) · 7 `sandbox` (`channels` por el tope, `whatsapp`, `email_out`, `sms`, `ses`, `verifactu`, `storage`) · 6 `none` (`email_in`, `tbai`, `igic`, `ai`, `sentry`, `redis`); frase más larga 198 caracteres (contrato ≤ 260) | Clave superior junto a `schedulers`, nunca dentro de `checks`: un modo no degrada `status`. Solo modo + frase, sin BD (§2.2); el modo efectivo por propiedad lo da `GET /integrations/status`. |

### 2.2 Bloque `integrations` de `/health` y `GET /integrations/status` (cableado por L8-05; verificado 2026-09-20)

Contrato: `packages/shared/src/integrations-status-types.ts` (`IntegrationHealthEntry`, `IntegrationsHealthBlock`,
`IntegrationStatusDto`, `IntegrationsStatusResponse`). Servicio: `apps/api/src/modules/integrations/integrations-status.service.ts`
(`describeIntegrationsHealth`, `collectIntegrationsStatus`). Cableado en `server.ts` (clave superior `integrations` junto a
`schedulers`, nunca dentro de `checks`; ruta `GET /integrations/status?propertyId=` con `integrations.read`, riskLevel low;
Sentry y Redis llegan como parámetros desde `server.ts`, `platformIntegrationsConfigured`) — **en el árbol desde L8-05**
(verificado 2026-09-20 en `:3949`: `"integrations" in body === true` con 14 claves y `GET /integrations/status` → 200).

`/health.integrations` (público, sin BD — desde el corrector L8 · REV-03 también VeriFactu / SES / TBAI: `describeComplianceEnvironment()`
de `compliance-health.service.ts` lee solo entorno y certificado, sin Prisma ni organización; antes `getComplianceHealth()` sin
`organizationId` recorría las propiedades de todos los tenants en cada petición): `Partial<Record<IntegrationKey, { mode, message }>>`
con las 14 claves que no dependen de la propiedad (`INTEGRATION_HEALTH_KEYS` = todas menos `opera`, `sage200`, `psp`, `gbp`). Ejemplo
con la configuración del carril (tras el corrector):

```jsonc
"integrations": {
  "gestoria_export": { "mode": "real",    "message": "Exportación manual de datos reales: CSV universal, libros de IVA y diario compatible ContaPlus / Sage 50 (…). Formatos A3 y Sage 200 no implementados." },
  "channels":        { "mode": "sandbox", "message": "Tope de modo de canales en simulador local: ningún canal sale a Internet." },
  "whatsapp":        { "mode": "sandbox", "message": "Sin credenciales de WhatsApp: los envíos se registran como SIMULADO y no salen del sistema; webhook de entrada rechazado hasta configurar el secreto." },
  "email_out":       { "mode": "sandbox", "message": "Sin proveedor de correo saliente: los envíos se registran como SIMULADO y no salen del sistema." },
  "sms":             { "mode": "sandbox", "message": "Sin credenciales de SMS: los envíos se registran como SIMULADO y no salen del sistema." },
  "email_in":        { "mode": "none",    "message": "Sin credenciales OAuth de Google ni Microsoft: solo el buzón manual." },
  "ses":             { "mode": "sandbox", "message": "Modo de pruebas local: ninguna comunicación de viajeros se envía al Ministerio del Interior; las respuestas son simuladas." },
  "verifactu":       { "mode": "sandbox", "message": "Modo de pruebas local: ningún registro de facturación se envía a la AEAT; las respuestas son simuladas." },
  "tbai":            { "mode": "sandbox", "message": "Modo de pruebas local: ningún fichero TicketBAI se envía a las haciendas forales; las respuestas son simuladas. Aplica solo a los establecimientos con territorio foral; el modo efectivo se lee por propiedad." },
  "igic":            { "mode": "none",    "message": "No es una integración propia: Canarias declara por VeriFactu con Impuesto=03; el estado real es el de VeriFactu." },
  "storage":         { "mode": "sandbox", "message": "Almacén local en la base de datos (inline): funciona, pero nada se guarda en S3." },
  "ai":              { "mode": "none",    "message": "Sin proveedor de IA: las funciones de IA responden «no configurado» y no inventan resultados." },
  "sentry":          { "mode": "none",    "message": "Sentry desactivado: los errores solo quedan en el log del proceso." },
  "redis":           { "mode": "none",    "message": "Dirección de Redis configurada, pero ningún componente del API la usa: hoy no aporta nada (…)." }
}
```

`GET /integrations/status?propertyId=<id>` (con sesión) → `{ generatedAt, propertyId, integrations: IntegrationStatusDto[18],
degraded: string[] }`; cada DTO: `key`, `label` (`INTEGRATION_LABELS_ES`), `mode`, `transport`, `configured`, `readyForReal`,
`message`, `missingForReal[]`, `lastActivityAt`, `lastError`, `screen`. `degraded` lista las consultas que fallaron y se
degradaron a «sin datos» (`createDegradedCollector("integrations.status")`), nunca a un éxito.

Reglas de lectura (las fijan el servicio, su test `__tests__/integrations-status.test.mts` (`assertInvariants`, 44 casos) y el
contrato raíz `tests/integrations-honesty-contract.test.mjs` de L8-08):

1. `mode` con el vocabulario de §0; `configured` puede ser `true` en `none` (Redis) y `false` en `sandbox` (correo simulado).
2. `readyForReal` ≡ `mode === "real"` **y** `missingForReal` vacío: un `real` con pendientes (S3 sin sonda, preproducción,
   OAuth sin buzón) se lee como «real con requisitos pendientes», nunca como listo.
3. `message` y `missingForReal` son frases cortas en español sin URLs, rutas, buckets ni nombres de variables secretas (el
   bloque de `/health` es público); hablan de «credenciales», «tope de modo», «certificado».
4. `lastActivityAt` sale de la última fila real o simulada (runs OPERA, lotes Sage, `last_sync_at` de canales/buzones,
   `notification_deliveries` reales y «SIMULADO», `verifactu_submissions`/`ses_hospedajes_submissions` por `updated_at`) y es
   `null` en `none`; `lastError` es el último fallo registrado (≤ 240 caracteres).
5. El bloque no degrada `status` de `/health`: `none` o `sandbox` es un modo, no un fallo. Solo `checks.*` degradan.
6. Canales y correo entrante en `/health` hablan del **tope** y de las **credenciales de la aplicación** (sin BD); el modo
   efectivo por propiedad (canales activos, buzones autorizados) lo da `GET /integrations/status`.
7. Permiso `integrations.read`: manager, operations_director, accountant, controller, compliance, general_manager, auditor,
   \18. Códigos de `GET /integrations/status` (verificados 2026-09-20 en `:3949`): `200` con `integrations.read` (`direccion@` de
   `org_uxday` sobre `prop_uxday`; sin `propertyId` usa la propiedad activa del contexto); `403` sin la clave (`recepcion@`);
   `404` opaco «Propiedad no encontrada.» para una propiedad de otra organización o sin asignación viva (`grantPropertyAccess`;
   `direccion@uxday` sobre `prop_123`); `400` «propertyId debe ser un identificador de propiedad no vacío.» con `propertyId=`
   vacío. Con `HOTELOS_ALLOW_DEMO_AUTH=true` (carril y demo) un GET sin token responde `200` con el contexto demo
   (`org_123`/`prop_123`): comportamiento común a todo GET `low` del build, no de esta ruta.
9. `degraded[]` nombra la consulta que falló (etiquetas de `createDegradedCollector("integrations.status")`): `pmsShadowProfile`,
   `pmsShadowRun`, `developerApps`, `emailConnections`, `ledgerImports`, `ledgerImportsPosted`, `ledgerImportLast`, `channels`,
   `reviewSources`, `verifactu:last`, `verifactu:failed`, `ses:last`, `ses:failed`, `psp`, `compliance` y
   `deliveries:<whatsapp|email|sms>:<real|simulated|failed>`. Cada una cae a «sin datos» (`none`, `null`, `0` o `[]`), nunca a un
   éxito: con Postgres saturado (97/100 conexiones durante la ola 2) el panel mostró «8 consultas sin datos» y `psp`/`channels`
   en `none`; con la BD libre (30/100 al cierre) `degraded: []`. Mientras la lista no esté vacía, los contadores no son
   definitivos.

### 2.3 La pestaña Integraciones (`/configuracion/modulos/integraciones`)

- **Dónde**: Configuración › Módulos e integraciones › pestaña «Integraciones» (ítem `ModuleManager`, loader `MarketplaceCatalog`
  en `apps/admin-web/src/screens/tabs/configuracion/ModulosTabs.tsx:24`; orden de pestañas Módulos · Salud · Integraciones ·
  Modo sombra OPERA fijado por `sidebar-menu.test.mts:199`). Roles del CSV (fila 85): direccion, admin, sistemas, auditoria.
  Sin rutas nuevas de front (la fila 85 ya prevé «hub de integraciones con estado leído del API»).
- **Panel de estado** (L8-06: `apps/admin-web/src/screens/integrations/IntegrationsStatusPanel.tsx`, helpers puros
  `integrations-status-helpers.ts`, cliente `services/integrationsApi.ts`): se monta ARRIBA de `MarketplaceCatalogScreen`
  (subtítulo «Estado real de cada integración; debajo, el catálogo de aplicaciones de terceros, hoy vacío.»; entrada
  `IntegrationsStatusPanel` en `.discoverability-whitelist.json` porque no tiene URL propia) y lee
  `GET /integrations/status?propertyId=<activa>` al abrir y al pulsar «Actualizar estado». Cabecera: «Estado leído el <fecha,
  hora> · 18 integraciones» y tres `CocoaKpi` que cuentan filas recibidas, nunca inventadas: **Reales** («los datos cruzan de
  verdad»), **En pruebas** («ningún resultado tiene efecto real»), **Sin integración** («nada cruza al sistema externo»). Con
  `prop_123` hoy: 2 · 7 · 9 (§1 «Línea base»).
- **Tabla** por área (`AREA_OF`): PMS y contabilidad (`opera`, `sage200`, `gestoria_export`) · Ventas, cobros y reputación
  (`channels`, `psp`, `gbp`) · Comunicaciones (`whatsapp`, `email_out`, `sms`, `email_in`) · Cumplimiento (`ses`, `verifactu`,
  `tbai`, `igic`) · Plataforma (`storage`, `ai`, `sentry`, `redis`); dentro de cada área, el orden de `INTEGRATION_KEYS`.
  Columnas: **Integración** (etiqueta + transporte «Ficheros» / «API (red)» / «Manual» / «Ninguno»), **Modo** (`CocoaBadge`:
  `none` neutro «Sin integración», `sandbox` warning «Pruebas (sin efecto real)», `real` success «Real»; bajo el badge «con
  requisitos pendientes» cuando `real` y `readyForReal:false`, p. ej. `gbp` por CSV), **Estado** (`message` del API tal cual),
  **Qué falta para real** (`missingForReal` unido por « · »; «Nada pendiente: opera en real» solo con `readyForReal:true`),
  **Última actividad** (`lastActivityAt` en hora local o «Sin actividad»), **Último error** (`lastError` con badge «Error»; la
  fila entera en tono danger, hoy solo `ses` en `prop_123`). El verde solo aparece en `real`.
- **«Configurar»** abre la pantalla `screen` del DTO: cambio de pestaña dentro del mismo contenedor cuando es una pestaña del
  ítem anfitrión (`opera` → Modo sombra OPERA) y, si no, por la clave de pantalla del árbol; `sentry` y `redis` (`screen:null`)
  no muestran el botón. `whatsapp` / `email_out` / `sms` comparten `/configuracion/comunicaciones` y `verifactu` / `tbai` /
  `igic` comparten `/cumplimiento/verifactu`.
- **Degradación y errores**: si `degraded[]` no está vacío, aviso «n consultas sin datos» («Estas lecturas fallaron y se muestran
  como «sin datos», nunca como un éxito») con las etiquetas de §2.2 regla 9; si la ruta responde 404 (instancia con código
  anterior a L8-05) el panel dice «Esta instancia del API no expone todavía el estado de las integraciones.»; sin propiedad
  activa no consulta. En móvil se ocultan «Qué falta para real» y «Última actividad» (`hideOnNarrow`) y «Último error» solo se
  ve desde portátil (`showFrom`): el mensaje de estado siempre es visible.
- **Cómo leerlo** (manual `docs/manual/60-sistemas.md` §3.3, L8-07): una fila que no está en «Real» no saca nada a Internet ni a
  la Administración aunque otras pantallas muestren envíos (van marcados «simulado» y cuentan aparte de los reales); «Qué falta
  para real» es la lista de tareas hacia el proveedor técnico o hacia quien contrata (§3 y §4); OPERA y Sage 200 aparecen
  «Real · Ficheros» en cuanto hay un informe o lote de verdad (no hay conexión directa y el panel no la simula); las conexiones
  «(demostración)» del catálogo heredado, visibles también en Pagos, no cuentan.
- **Qué no cambia**: el hub heredado (`/properties/:id/integrations`, rutas del marketplace) sigue existiendo por contrato,
  con proveedores marcados «(demostración)» y pruebas `simulated` (L8-01); el panel no lo lee como fuente de verdad.

### 2.4 Sondas de verificación (sin secretos)

```bash
# instancia propia del carril (nunca :3000)
curl -s http://127.0.0.1:3935/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"], d["dependencies"], {k: v.get("message") for k, v in d["checks"].items()}, sorted(d.get("integrations", {}).keys()))'
# con sesión (token en variable de entorno, nunca en el historial)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/notifications/email-status        # { configured, provider, from, mode }
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/integrations/email/providers     # gmail / microsoft / imap / manual
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/compliance/health                # verifactu · ses_hospedajes · tbai · igic (billing.compliance.view)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3935/channel-manager/channels?propertyId=<id>"   # mode y status por canal
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/properties/<id>/pms-shadow/overview           # profile, lastRunAt, feeds
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/properties/<id>/payments/psp-status           # payment.capture
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3935/reputation/properties/<id>/sources            # reputation.read + módulo activo
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3935/integrations/status?propertyId=<id>"     # L8-05: 200 con integrations.read
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_RECEPCION" "http://127.0.0.1:3935/integrations/status?propertyId=<id>"  # 403
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3935/integrations/status?propertyId=<ajena>"  # 404 «Propiedad no encontrada.»
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3935/integrations/status?propertyId="         # 400 propertyId vacío
```

Resultado del 2026-09-20 con `org_uxday` (`sistemas@` y `direccion@`): email-status `mode simulated`; providers todos
`false` salvo `manual`; compliance/health `overall sandbox_only`, VeriFactu y SES `readyForReal:false`, TBAI `enabled:false`,
IGIC `enabled:false`; canales `[]` (prop_uxday no tiene canales; los 7 sandbox son de prop_123/Los Tilos); overview OPERA
`profile:null`; hub heredado `[]`; psp-status 403 (`payment.capture` no está en las plantillas de `org_uxday`); reseñas 403
(módulo `reputation_quality` no activado); `/integrations/status` 404 (servicio en el árbol, ruta sin cablear). Segunda pasada con el árbol L8-01 (instancia reiniciada): `checks.redis` «configured (sin consumidor en este build)», `dependencies.redis` `unconfigured`, `integrations` sigue ausente. Tercera pasada (L8-09, 2026-09-20 13:33, instancia propia `:3949` con el árbol final, PID matado al terminar): `/health` con `integrations` de 14 claves (1 real · 7 sandbox · 6 none) y el resto igual que en la primera; `GET /integrations/status` → `200` `direccion@` sobre `prop_uxday` (1 real · 6 sandbox · 11 none, `degraded: []`), `200` sin `propertyId` (propiedad del contexto), `403` `recepcion@`, `404` `direccion@` sobre `prop_123`, `400` con `propertyId=` vacío; sin token (auth de demo del carril) `200` sobre `prop_123` (2 · 7 · 9). Ningún dato de huésped en ninguna respuesta.

## 3 · Activación por integración (variables exactas del contrato y líneas)

Regla común: cada variable nueva o cambiada pasa por `node scripts/validate-env.mjs .env --role app` y, si se añade al
contrato, por `node scripts/env-census.mjs --write`; después **reinicio del API** (la configuración de IA, del almacén y de
los adaptadores se resuelve una vez por proceso) y comprobación en `/health` + la pantalla de §1. En producción
`assertEnv` aborta el arranque si falta una obligatoria. Ningún valor real se escribe en el repo, en tests ni en este
runbook.

### 3.1 OPERA Cloud · modo sombra (`opera`)

1. Perfil por hotel: `PATCH /properties/:id/pms-shadow/profile` con `operaHotelCode` real (hoy `RIAS` es ficticio),
   `mappingJson` (incluye `pseudoRoomTypes = ["PM","PI","HOUSE"]`, §15 del runbook OPERA) y `trxMappingJson`.
2. Ingesta por clave: `DeveloperApp` con scope `pms.shadow.ingest` (Configuración › Sistema › Aplicaciones
   `/configuracion/sistema/aplicaciones`, admin/sistemas) y el agente `pms-shadow:pull` en el VPS con
   `PMS_SHADOW_INGEST_URL` (`modules/pms-shadow/env.partial.ts:34`) y `PMS_SHADOW_API_KEY` (:41, patrón `cli_<id>.<secreto>`,
   fichero 600, nunca argv).
3. Ingesta por correo: buzón `EmailConnection` purpose `pms_shadow` con `fromDomain` del Report Scheduler (§3.7 para el OAuth).
4. Job del líder: `PMS_SHADOW_JOB_DISABLED=false` (:18), `PMS_SHADOW_JOB_INTERVAL_MS` (:24, 15 min) en la instancia con
   `RUN_SCHEDULERS=true`.
5. Verificar: `GET /properties/:id/pms-shadow/overview` (`lastRunAt`, `feeds[]`, alertas `OPERA_FEED_LATE`) y la pestaña Modo
   sombra OPERA. Sin OHIP no hay más «real» que este: el modo sombra es por diseño ingesta de informes.

### 3.2 Sage 200 y exportación a gestoría (`sage200`, `gestoria_export`)

1. Antes del primer lote (runbook Sage §11): `vat_settings` de la organización y el mapa analítico
   (`PUT /accounting/ledger-imports/analytics-map`).
2. Importar con `import-sage200.ts` o la pantalla `/finanzas/contabilidad/importar-sage200`; cada lote queda en
   `ledger_imports` (`status posted`, `content_hash` idempotente).
3. Exportación: `GestoriaExportScreen` genera `csv_universal` / `vat_books_csv` / `contaplus_diario` («validar con el
   asesor»); **no** existe formato Sage 200 y `a3` responde 409. Activar una exportación Sage 200 = decisión + formato nuevo
   (§4 D-04), no una variable.
4. La importación contable es por **sociedad** (organización): `ledger_imports` no lleva `propertyId`, así que todas las
   propiedades de la sociedad muestran el mismo estado `sage200` y la misma última actividad; la frase del DTO lo dice («… en la
   sociedad (la importación contable es por sociedad, común a todos sus centros)», corrector L8 · REV-05).

### 3.3 Channel manager (`channels`)

1. Tope de instancia: `CHANNEL_MAX_MODE` (`modules/channel-manager/env.partial.ts:36`): `sandbox` en todos los entornos
   hasta la certificación; `real` **solo** en producción y a mano.
2. Base de Channex: `CHANNEX_BASE_URL` (:45): `https://staging.channex.io` para certificar, `https://app.channex.io` en
   producción. La API key va por canal, cifrada (`POST /channel-manager/channels` con `credentials`, write-only).
3. Por canal: `mode` (`stub | sandbox | real`), mapeos de habitaciones y tarifas (`/channel-manager/channels/:id/room-mappings`,
   `rate-mappings`, `mapping-coverage`), `status active`. `PATCH` a `real` por encima del tope se acepta, se audita
   (`CHANNEL_MODE_CHANGED`) y queda capado hasta subir la variable (§4 de channel-manager-connectivity).
4. Drenaje: `CHANNEL_DRAIN_INTERVAL_MS` (:54), `CHANNEL_DRAIN_DISABLED` (:62), `CHANNEL_DRAIN_BATCH_LIMIT` (:68),
   `CHANNEL_DELIVERY_RETENTION_DAYS` (:76) en el líder.
5. Verificar: `GET /channel-manager/channels?propertyId=` (`mode`, `requestedMode`, `status`), panel de sincronización de
   la parrilla (`confirmed` en sandbox = confirmado por el simulador), procedimiento de certificación Channex §7.

### 3.4 PSP (`psp`)

1. Stripe: `STRIPE_SECRET_KEY` (`modules/payments/env.partial.ts:36`; `sk_test_` = `sandbox`, `sk_live_` = `real`) y
   `STRIPE_WEBHOOK_SECRET` (:43, obligatoria con la clave: sin él ningún cobro pasa a `captured`).
2. Redsys: `REDSYS_MERCHANT_CODE` (:51, FUC 9 dígitos), `REDSYS_TERMINAL` (:57, `001`), `REDSYS_SECRET_KEY` (:63),
   `REDSYS_MODE` (:70, `test` = `sandbox`, `live` = `real`).
3. Común: `PAYMENTS_PUBLIC_BASE_URL` (:29, origen público HTTPS para retorno y webhooks `/payments/webhooks/:provider`),
   opcional `PAYMENTS_PSP_PROVIDER` (:23) para forzar uno; o una fila `payment_provider_connections` `connected` por propiedad.
4. Verificar: `GET /properties/:id/payments/psp-status` → `{ configured, provider, mode, webhookSecretConfigured, message }`;
   `PaymentDialog` deja de responder 409 `PSP_NOT_CONFIGURED`. La pantalla Pagos lee la fila `psp` de `GET /integrations/status` y muestra el hub heredado
   como «Conexiones de demostración (catálogo heredado)» (L8-07; auditoría A1/A2 cerradas).

### 3.5 WhatsApp (`whatsapp`)

1. Salida: `WHATSAPP_PHONE_ID` (`lib/env.ts:409`) + `WHATSAPP_PROVIDER_TOKEN` (:414). Sin ellos las entregas quedan
   `simulated` (`notification_deliveries.error_message` «SIMULADO…»).
2. Entrada: `WHATSAPP_APP_SECRET` (`modules/checkin/env.partial.ts:94`, firma `X-Hub-Signature-256`) y `WHATSAPP_VERIFY_TOKEN`
   (:107, verificación de la suscripción en Meta). `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED` (:100) **solo** demo/staging.
3. Plantillas *utility* aprobadas por Meta para `checkin_invitation` / `checkin_reminder` / `checkin_welcome` (fuera de la
   ventana de 24 h); el dispatcher todavía no pasa `template` (límite §13 del runbook de check-in).
4. Verificar: `unsignedWebhookMode` → `signed`; `POST /webhooks/whatsapp` deja de responder 503; una entrega con `sent` sin
   «SIMULADO».

### 3.6 Correo saliente y SMS (`email_out`, `sms`)

1. `EMAIL_PROVIDER` (`lib/env.ts:369`, `postmark | sendgrid`), `EMAIL_PROVIDER_KEY` (:376), `EMAIL_FROM` (:383, remitente
   verificado en el proveedor). Los tres van juntos.
2. SMS: `TWILIO_ACCOUNT_SID` (:390), `TWILIO_AUTH_TOKEN` (:395), `TWILIO_FROM` (:402).
3. Verificar: `GET /notifications/email-status` → `mode: "real"`; en Plantillas y envíos la KPI «Enviadas» cuenta solo
   entregas reales y `simulated` va aparte (L8-03); `POST /invoices/:id/send-email` deja de responder `simulated: true`.

### 3.7 Correo entrante OAuth (`email_in`)

1. Google: `GMAIL_CLIENT_ID` (`lib/env.ts:427`), `GMAIL_CLIENT_SECRET` (:432), `GMAIL_REDIRECT_URI` (:439; por defecto
   `API_PUBLIC_URL` + `/integrations/email/oauth/callback`). Microsoft: `MS_CLIENT_ID` (:444), `MS_CLIENT_SECRET` (:449),
   `MS_TENANT` (:456, `common` por defecto).
2. En Correo entrante `/configuracion/comunicaciones/correo-entrante`: crear la conexión (`pending_auth`), abrir la URL de
   autorización (`getAuthorizeUrl`), completar el consentimiento con el dueño del buzón; el callback la deja `connected`.
   Un buzón por propósito: reservas, `pms_shadow`, `documents`.
3. Verificar: `GET /integrations/email/providers` → `configured:true`; `email_connections.status = connected`,
   `last_sync_at` avanza con el poll de 5 min del líder; `last_error` vacío.

### 3.8 Google Business Profile (`gbp`)

1. `GOOGLE_BUSINESS_CLIENT_ID` (`modules/reputation/env.partial.ts:43`), `GOOGLE_BUSINESS_CLIENT_SECRET` (:49),
   `GOOGLE_BUSINESS_REDIRECT_URI` (:56, HTTPS en producción).
2. Activar el módulo `reputation_quality` en la propiedad; crear la fuente `google` con `external_location_id`
   (`accounts/{a}/locations/{l}`).
3. Autorizar con OAuth `business.manage` del propietario del perfil — **ruta pendiente (T8-L5)**: hasta entonces la fuente
   queda `pending`/`unavailable` con el motivo literal de §3 del runbook T8.
4. Verificar: `GET /reputation/properties/:id/sources` → `status connected`, `lastSuccessAt`; `REPUTATION_SYNC_*` en el líder.

### 3.9 SES.Hospedajes (`ses`)

1. Por hotel: registro turístico, NIF, razón social, dirección, municipio (código INE), provincia
   (`resolveSesEstablishment`; la pantalla SES lista lo que falta) e interruptor `sesHospedajesEnabled` en
   `properties`/`property_compliance_settings`. Con el interruptor apagado y sin envíos en 180 días la fila `ses` de la pestaña
   Integraciones es `none` «Desactivado para este establecimiento…» aunque el proceso esté en producción (corrector L8 · REV-01);
   `/health` habla del proceso y no mira el interruptor.
2. `SES_HOSPEDAJES_MODE=preproduction` (`lib/env.ts:595`) con `SES_HOSPEDAJES_CERT_PATH` (:603) y
   `SES_HOSPEDAJES_CERT_PASSPHRASE` (:610); si el MIR exige acceso básico, `SES_HOSPEDAJES_CLIENT_ID` (:617) y
   `SES_HOSPEDAJES_CLIENT_SECRET` (:624). Después `production`.
3. Verificar: `GET /compliance/health` → `ses_hospedajes.readyForReal:true`, `cert.certPathExists:true`; un parte nuevo con
   `endpoint` ≠ `stub://…`; Cumplimiento › Envíos sin «Simulado · no enviado» en las filas nuevas. El programador del líder
   reclasifica las 15 filas aparcadas de RA en el primer tick (L5).

### 3.10 VeriFactu, TicketBAI e IGIC (`verifactu`, `tbai`, `igic`)

1. Declaración del sistema informático (obligatoria fuera de sandbox, el API no arranca sin ella): `VERIFACTU_SOFTWARE_NAME`
   (`lib/env.ts:477`), `VERIFACTU_SOFTWARE_NIF` (:485, NIF del productor, no del hotel), `VERIFACTU_SYSTEM_NAME` (:492),
   `VERIFACTU_SYSTEM_ID` (:500), `VERIFACTU_SYSTEM_VERSION` (:509), `VERIFACTU_INSTALL_NUMBER` (:515),
   `VERIFACTU_MULTI_OT` (:523). En producción `VERIFACTU_SYSTEM_NAME`/`_VERSION` son los de la declaración responsable
   vigente (CLAUDE.md «Marca y despliegue», D4).
2. Firma: `VERIFACTU_SIGN_PEM` (:544) + `VERIFACTU_SIGN_PEM_PASSPHRASE` (:549) **o** `VERIFACTU_CERT_PATH` (:555) +
   `VERIFACTU_CERT_PASSPHRASE` (:560); `VERIFACTU_MAX_ATTEMPTS` (:566).
3. Estructura: instalación por centro en `verifactu_installations` (sin ella, `INSTALLATION_NOT_DECLARED` en modos reales);
   sociedad en SII → excluida con motivo; serie activa por sociedad.
4. `VERIFACTU_MODE=preproduction` (:469) y, tras validar, `production`; `VERIFACTU_SCHEDULER_DISABLED=false` (:713) en el
   líder. Por propiedad, la fila `verifactu` exige además el interruptor `verifactuEnabled` o facturas emitidas (si no, `none`
   «Desactivado para este establecimiento y sin facturas emitidas»); `tbai` exige territorio foral en la ficha del centro
   (corrector L8 · REV-01).
5. TBAI solo con territorio foral en la ficha del centro: `TBAI_MODE` (:641, sin preproducción), `TBAI_CERT_PATH` (:649),
   `TBAI_CERT_PASSPHRASE` (:657), `TBAI_LICENSE_KEY` (:664), `TBAI_DEVICE_SERIAL` (:672). IGIC no tiene conector:
   `IGIC_MODE` (:680), `IGIC_CERT_PATH` (:688), `IGIC_CERT_PASSPHRASE` (:695) no activan nada.
6. Verificar: `/health` `checks.verifactu.software.ok:true`; `GET /compliance/health` `overall production_ready`;
   Cumplimiento › Envíos con `endpoint` real y acuse con CSV.

### 3.11 Almacén de documentos (`storage`)

1. VPS: `DOCUMENT_STORAGE_KIND=disk` (`modules/documents/env.partial.ts:39`) + `DOCUMENT_STORAGE_DIR` (:49, volumen del
   compose incluido en el backup) + clave de campos válida (`DOCUMENT_ENCRYPT_AT_REST=true`, :113). Para el contrato de estado
   `disk` sigue siendo `sandbox` («funciona, pero nada se guarda en S3»): el modo `real` de esta clave es S3.
2. S3 compatible: `DOCUMENT_STORAGE_KIND=s3`, `DOCUMENT_S3_ENDPOINT` (:60, HTTPS, región europea), `DOCUMENT_S3_REGION`
   (:69), `DOCUMENT_S3_BUCKET` (:76, privado), `DOCUMENT_S3_ACCESS_KEY_ID` (:84), `DOCUMENT_S3_SECRET_ACCESS_KEY` (:90).
3. Verificar: `/health` `dependencies.objectStorage` = `disk` o `s3` (nunca `unconfigured`); una subida y una descarga
   reales en Archivo. Con `s3` el valor solo dice «configurado»: hasta que exista una sonda HEAD en el arranque no se debe
   leer como «alcanzable».

### 3.12 IA (`ai`)

1. `AI_PROVIDER=anthropic` (`lib/env.ts:723`), `AI_PROVIDER_API_KEY` (:730), `AI_USD_EUR_RATE` (:750, punto decimal;
   sin él `budget_unavailable`), opcionales `AI_MODEL` (:737, nunca `claude-fable-*`), `AI_MODEL_CLASSIFY`,
   `AI_MODEL_INSIGHTS`, timeouts, `AI_MONTHLY_BUDGET_EUR_DEFAULT`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_INFERENCE_GEO` (:758).
2. Reiniciar el API; `POST /ai-operations/tools/sync`; presupuesto por propiedad en `configurationJson.monthlyBudgetEur`.
3. Verificar: `/health` `checks.ai` sin `reason`; `GET /ai-operations/property/readiness` check `provider` `ok`; humo con
   clave del runbook `ai-core.md` §4 (documentado, no ejecutado).

### 3.13 Sentry (`sentry`)

`SENTRY_DSN` (`lib/env.ts:806`) para API y worker, `VITE_SENTRY_DSN` (:812) horneado en el build del admin-web. Verificar:
arranque con `[sentry]` sin «disabled» y `/health` `checks.sentry` `configured`. No hay comprobación de entrega: un DSN
erróneo no se detecta hasta el primer evento.

### 3.14 Redis (`redis`)

No hay nada que activar: `REDIS_URL` (`lib/env.ts:207`) es una variable reservada sin consumidor. Decisión pendiente (§4 D-16).

### 3.15 Hub heredado y marketplace (sin `IntegrationKey`)

No hay nada que activar: los proveedores del hub son ficticios (desde L8-01 con `demo:true`, `mode:"sandbox"` y nombre
«(demostración)»; la prueba de conexión responde `simulated` y persiste `IntegrationTestSimulated`; el `PATCH` de estado se
persiste y se audita) y el catálogo está vacío. Lo operable son las aplicaciones de
desarrollador (`/configuracion/sistema/aplicaciones`, claves con scopes) y los webhooks (`/configuracion/sistema/webhooks`,
entregas reales por el worker `webhooks.deliver`), que no son «integraciones» de esta tabla.

## 4 · Lo que solo César puede aportar (`decisionsForOwner`)

Lista única para el bloque `decisionsForOwner` del informe `docs/audits/TANDA-L8-INTEGRACIONES-2026-09-20.md`. Cada entrada:
qué, para qué integración, qué bloquea, dónde está el detalle. Producto no puede sustituir ninguna con un valor por defecto.
Las frases `missingForReal` de `integrations-status.service.ts` son la proyección por propiedad de esta lista (sin nombres de
variables ni URLs); esta tabla añade lo que solo se sabe fuera del código (muestras, contratos, decisiones).

| # | Decisión / dato | Integración | Bloquea | Detalle |
| --- | --- | --- | --- | --- |
| D-01 | Hotel Code real de cada hotel, hora del night audit, listados `cf_*`, muestras reales de los informes 3-7 y del XML de ingresos, dirección del programador y allowlist SFTP; para OHIP: Enterprise ID, Chain Code, Region, Environment, Hotel IDs y dueño del app key | `opera` | Corte diario automático; ingresos por transaction code (`pms_shadow_revenue` vacío); fase 2 OHIP | `opera-modo-sombra.md` §14 puntos 1-7 |
| D-02 | Criterio contable por transaction code (tasa turística, paquetes, paid-outs, anticipos, city ledger) validado con la gestoría; decisión `RESV_NAME_ID` vs `CONFIRMATION_NO`; adopción de reservas locales (`adoptLocal`) | `opera` | Conciliación de ingresos y de reservas ya existentes | `opera-modo-sombra.md` §14 punto 5 y §15 |
| D-03 | Decisiones 1-8 de la importación Sage 200 (subcuentas, dimensión de centro, reparto multi-hotel, nómina real vs lote, facturas RA en sombra, ejercicios antiguos, fecha de relevo, periodicidad de IVA) — varias ya resueltas por administración el 2026-09-18 | `sage200` | Lotes posteriores y criterio de «reconciliado» | `finanzas-importacion-sage200.md` §10 |
| D-04 | Si se quiere exportación en formato Sage 200 (hoy solo CSV universal / compatible ContaPlus): especificación del fichero de importación de Sage 200 y validación de la gestoría | `gestoria_export` | Exportación «Sage 200» (hoy `none`) | `gestoria-export.service.ts:1-27`; runbook Sage §10 |
| D-05 | Cuenta Channex staging + API key, ids de propiedad/productos en Channex, extranet ids de Booking y Expedia de Rías Altas y Los Tilos; decisión de proveedor de conectividad y momento de `CHANNEL_MAX_MODE=real` en producción | `channels` | Cualquier entrega real a una OTA | `channel-manager-connectivity.md` §3, §4 y §7; `rate-grid-v2.md` §6 |
| D-06 | Cuenta Stripe (`sk_live_` + `whsec_`) o comercio Redsys (FUC, terminal, clave), dominio público HTTPS para retornos y webhooks; enlace de pago vs preautorización; política de reembolsos | `psp` | Cobros con tarjeta en línea, enlaces de pago, `authorized` en el check-in | `checkin-automatizado.md` §13 N4·D3; `payments/env.partial.ts` |
| D-07 | Cuenta WhatsApp Business (Tech Provider o BSP), número por hotel, plantillas *utility* aprobadas, opt-in, presupuesto post-01/10/2026, `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN` | `whatsapp` | Canal WhatsApp de entrada y salida | `checkin-automatizado.md` §13 N3·D6 |
| D-08 | Proveedor de correo transaccional (Postmark/SendGrid), dominio remitente verificado, remitente por hotel o único; cuenta Twilio si se usa SMS | `email_out`, `sms` | Invitación, recordatorio, OTP, bienvenida y facturas por correo reales | `checkin-automatizado.md` §13 N2; `lib/env.ts:369-404` |
| D-09 | Declaración responsable VeriFactu del productor (razón social, NIF, id y versión del sistema, número de instalación por despliegue), certificado del obligado tributario por sociedad, política de cadena; paso previo por preproducción | `verifactu` (+ `tbai` si aplica) | Todo envío real a la AEAT; hoy `/health` lista los 3 errores | `docs/compliance/verifactu-declaracion-responsable.md`; CLAUDE.md «Marca y despliegue» D4 |
| D-10 | Alta en SES.Hospedajes por establecimiento (registro turístico, usuario del WS), certificado XAdES y contraseña, datos censales completos (RA), consulta escrita al MIR sobre la firma en tablet, documentación técnica oficial | `ses` | Partes reales al MIR (hoy 9 acuses del stub y 149 fallidos) | `checkin-automatizado.md` §13 N5 y N8; L5 CS-01/02 |
| D-11 | Cliente OAuth de Google Workspace o Microsoft 365, un buzón por propósito y centro (`docs-<centro>@…`), quién autoriza cada buzón; si se quiere IMAP, autorizar la dependencia `imapflow` | `email_in` | Reservas por correo, ingesta OPERA por correo, buzón de documentos | `documentos-digitalizacion.md` §11 nº 2; `email-reservation.service.ts:129-151` |
| D-12 | Proyecto Google Cloud con OAuth `business.manage`, ubicación por hotel, activación del módulo `reputation_quality` por propiedad; qué hacer con Booking/Expedia (solo partner) | `gbp` | Reseñas de Google por API (hoy CSV) | `reputacion-reviews.md` §3; informe T8 §9 nº 2-4 |
| D-13 | Almacén: `disk` en el VPS (volumen + backup) o S3 compatible en la UE (proveedor, región, bucket, credenciales); política de retención firmada y RAT | `storage` | Documentos fuera de la demo (`inline` prohibido en producción) | `documentos-digitalizacion.md` §2 y §11 nº 5-6 |
| D-14 | Clave de IA de la organización con DPA + ZDR, residencia (API directa vs Bedrock UE), presupuesto por hotel, `AI_USD_EUR_RATE`, proveedor de visión (Claude vs Azure vs solo MRZ), 50 facturas reales anonimizadas para medir | `ai` | Visión sobre documentos, bot y copiloto con modelo, borradores de reseñas con modelo | `checkin-automatizado.md` §13 N1·D1·D8; `documentos-digitalizacion.md` §11 nº 1 y 8; `ai-core.md` §1 |
| D-15 | Proyecto Sentry (o compatible) con sus dos DSN, región y retención | `sentry` | Captura de errores 5xx fuera del log | `lib/env.ts:806-812` |
| D-16 | Si Redis entra en la arquitectura (cola/limitador compartido en multi-réplica) o se retira del contrato | `redis` | Nada operativo hoy; solo honestidad de `/health` | `lib/env.ts:207`; `deploy/README-INSTALL.md` l.65 |
| D-17 | Si el marketplace de aplicaciones de terceros sigue en el roadmap (proceso de certificación) o se retira de la pestaña Integraciones en favor del panel de estado | hub heredado (sin clave) | Retirar (o no) el catálogo vacío de la pestaña: el panel de estado ya vive encima (L8-06) y el manual §3.3 lo describe (L8-07); también `packages/integrations/src/registry/integration-provider-manifest.ts` (consumido por `apps/mobile`) y `docs/manual/10-direccion.md` / `20-administracion.md`, que aún citan «Demo Payment Gateway · CONECTADO» | `docs/manual/60-sistemas.md` §3.3; recon nº 5-6 |
| D-18 | Legal transversal: EIPD y RAT, texto de consentimiento y aviso de IA por hotel, revisión del PDF del parte por el asesor | `ses`, `ai`, `whatsapp`, `email_out` | Producción de cualquier canal con datos de huéspedes | `checkin-automatizado.md` §13 N8 |

## 5 · Verificación SQL solo lectura

Consultas agregadas sobre la BD del carril (`psql "$DATABASE_URL" -Atc`): nunca `SELECT *` sobre huéspedes, usuarios ni
credenciales; nunca escritura. Resultados del 2026-09-20 en `hotelos_l8` (copia de la demo local con los datos de
Faranda): son las cifras de §1.

```sql
-- OPERA · modo sombra: perfil y runs por origen/estado
SELECT system, status, count(*) FROM pms_shadow_profiles GROUP BY 1, 2 ORDER BY 1, 2;            -- opera_cloud|active|1
SELECT source, status, count(*) FROM pms_shadow_runs GROUP BY 1, 2 ORDER BY 1, 2;                 -- api_key done 5 · partial 2 · failed 1 · cli done 1
SELECT count(*) FROM developer_apps WHERE 'pms.shadow.ingest' = ANY(scopes) AND status = 'active'; -- 1
SELECT provider, status, count(*) FROM email_connections GROUP BY 1, 2 ORDER BY 1, 2;             -- (0 filas)

-- Sage 200: lotes importados
SELECT system, status, count(*) FROM ledger_imports GROUP BY 1, 2 ORDER BY 1, 2;                  -- sage200|posted|50

-- Canales: modo y estado
SELECT provider_code, mode, status, count(*) FROM channels GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;      -- airbnb sandbox inactive 1 · booking_com sandbox active 2 · channex sandbox active 2 · expedia sandbox active 2 (prop_123: 3 activos; 2.ª propiedad real: 3 activos + airbnb inactivo)

-- PSP
SELECT count(*) FROM payment_provider_connections;                                                  -- 0

-- Correo saliente / WhatsApp / SMS: entregas simuladas frente a reales
SELECT channel, status, (error_message LIKE 'SIMULADO%') AS simulado, count(*)
  FROM notification_deliveries GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;                                 -- email sent simulado=t 222 · email sent simulado=f 1

-- Reseñas: fuentes
SELECT provider, status, count(*) FROM review_sources GROUP BY 1, 2 ORDER BY 1, 2;                 -- csv|connected|1

-- Cumplimiento: acuses por modo (endpoint stub:// = simulado)
SELECT mode, status, count(*) FROM verifactu_submissions GROUP BY 1, 2 ORDER BY 1, 2;             -- sandbox accepted 47 · (null) accepted 19  → 66, todas del stub
SELECT status, count(*) FROM ses_hospedajes_submissions GROUP BY 1 ORDER BY 1;                    -- accepted 9 · failed 149
SELECT count(*) FILTER (WHERE endpoint LIKE 'stub://%') AS simuladas, count(*) AS total
  FROM verifactu_submissions WHERE status = 'accepted';                                            -- comprobación: simuladas = total mientras el modo sea sandbox

-- Hub heredado y marketplace
SELECT provider_id, status, count(*) FROM integration_connections GROUP BY 1, 2 ORDER BY 1, 2;     -- ip_mock_payments|connected|1
SELECT event_type, status, count(*) FROM integration_events GROUP BY 1, 2 ORDER BY 1, 2;           -- IntegrationTestSimulated|simulated|1 (L8-02) · ConnectionTested|accepted|1 (histórica, anterior a L8-02)
SELECT (SELECT count(*) FROM marketplace_listings) AS listings, (SELECT count(*) FROM app_installations) AS installs; -- 0|0
```

Nota sobre el recon: la fila «SES.Hospedajes / VeriFactu» del recon-delta resume «verifactu_submissions accepted 66 /
failed 149; ses accepted 9» — las 149 `failed` son de `ses_hospedajes_submissions`, no de VeriFactu (VeriFactu no tiene
filas `failed` en el carril). Las consultas anteriores lo separan.

Lectura de las cifras: ninguna integración de la tabla tiene actividad **real** en el carril salvo la importación de
ficheros de OPERA y de Sage 200 y una entrega de correo histórica; todo acuse `accepted` de VeriFactu/SES es del stub y
todo `sent` de correo salvo uno es «SIMULADO». Es exactamente lo que `/health.integrations` y la pestaña Integraciones
deben decir.

## 6 · Puertas y comandos exactos

Todo desde `<worktree>/hotelos`; nunca contra `:3000` / `:5173`. Cifras al cierre de la tanda (2026-09-20).

| Puerta | Comando exacto | Cubre | Resultado al cierre |
| --- | --- | --- | --- |
| Contratos raíz de la tanda | `node --test tests/brand-contract.test.mjs tests/integrations-honesty-contract.test.mjs` | marca «ehotelOS» en este runbook, `CLAUDE.md` y `docs/api-contracts.md` (`brand-contract`: `docs/runbooks/*.md` está en `VISIBLE_ROOTS`); modo ↔ comportamiento y «un modo `none` nunca simula un resultado real» (`integrations-honesty-contract`, L8-08) | 31/31 (13:40): `brand-contract` 10 + `integrations-honesty-contract` 21 (fuente, sin BD: una función `*Status` por clave en el servicio y en el orden de `INTEGRATION_KEYS`, una fila por clave en §1 de este runbook y una entrada por clave en `docs/api-contracts.md`, exactamente 14 claves en `/health`, `finalizeIntegrationStatus` con sus reglas, `server.ts` sin secretos ni «http» en el bloque, PSP sandbox solo por `setPspRegistry`, webhook `refused` en producción, proveedores `simulated: true` fuera de producción, tope de canales nacido en `sandbox`, IMAP no configurado, hub `simulated`, Pagos sin `gatewayReady` del hub) |
| Unitarios API de la tanda | `cd apps/api && node --import tsx --test src/modules/integrations/__tests__/integrations-status.test.mts src/modules/integrations/__tests__/legacy-hub.test.mts src/modules/integrations/__tests__/integrations-status-routes.test.mts` | 44 casos del servicio (`assertInvariants`: `readyForReal` ≡ `real` ∧ sin pendientes; `none` sin actividad; `sandbox` con «simul \| prueba \| ficticia \| local» y nunca «enviado»; sin URLs ni variables secretas; 14 claves de `/health`) + 9 del hub heredado (`simulated`, `PATCH` persistido); corrector L8: 50 del servicio (+6: interruptor del establecimiento apagado / activo por uso, `complianceGates` puro, colector con flags, sin fila de propiedad no gatea, nota TBAI de `/health`), 11 del hub (+2: fixture sin `lastSyncAt`, `legacyFixturesApplyTo`) y 3 de `integrations-status-routes.test.mts` (nuevo; `compliance-health.test.mts` 6/6 aparte) | 53/53 (tanda) · 64/64 (corrector) |
| Unitarios admin-web de la tanda | `cd apps/admin-web && node --import ../api/node_modules/tsx/dist/loader.mjs --test src/screens/integrations/__tests__/integrations-status-helpers.test.mts src/screens/__tests__/integrations-copy.test.mts src/screens/notifications/__tests__/delivery-outcome.test.mts` | helpers del panel (15), copy de Pagos / gestoría / manual (8 + 7 del corrector: campañas, SES «(simulador)», Pagos, Integraciones, `CocoaStatusBar`, manifiesto, manuales 10/20), `simulated` en Comunicaciones (8) | 31/31 (tanda) · 38/38 (corrector; `fiscal-shared.test.mts` +3 aparte) |
| Suites completas | `corepack pnpm --filter @hotelos/api test` · `corepack pnpm --filter @hotelos/admin-web test` · `corepack pnpm test` (contratos raíz) | regresión | puerta completa final (`scratchpad/L8/gates-full.json`): api 3.622 (3.621 pass · 1 skip) · admin-web 2.045 (2.044 · 1 skip) · contratos raíz 786 (784 · 2 skip). Corrector L8 (`scratchpad/L8-fix/gates-quick.json`): api 3.636 (3.635 · 1 skip) · admin-web 2.053 (2.052 · 1 skip) · contratos raíz 787 (785 · 2 skip) |
| Integración (L8-08) | `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/integraciones-estado.test.mts` (todas: `corepack pnpm run test:integration`) | organización aislada (`helpers/l2-tenant.mts`), auth real y `RBAC_STRICT`: `401` sin token, `403` recepción y owner, `200` dirección general y sistemas (18 entradas en orden, reglas del DTO, `degraded` vacío); `withEnv` (`AI_PROVIDER=none`, `CHANNEL_MAX_MODE=stub`, sin PSP, `REDIS_URL` ficticia) → `ai`/`psp`/`redis` `none`, canales «simulador sin credenciales», ninguna `real` por red; `/health.integrations` con las 14 claves sin «http» ni «://»; prueba del hub `simulated` + `IntegrationTestSimulated` con `lastSyncAt` intacto; invariantes de Faranda idénticas antes y después | presente (10 casos); lo ejecuta la puerta de la ola 3 (L8-09 verificó los mismos códigos a mano por HTTP, §2.4). Exige Postgres con conexiones libres («too many clients» por encima de 95/100) |
| e2e (L8-08) | `E2E_API_URL=http://127.0.0.1:<api> E2E_BASE_URL=http://127.0.0.1:<vite> corepack pnpm --filter @hotelos/admin-web e2e -- e2e/integrations-status.spec.ts` con API y Vite propios del carril (`loginAsUxDay`) | `/configuracion/modulos/integraciones`: panel montado sobre el catálogo, KPI y badges leídos del API | presente (`apps/admin-web/e2e/integrations-status.spec.ts`); lo ejecuta la puerta de la ola 3 con API y Vite propios |
| Puertas del carril | `NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv bash scripts/gates.sh --quick --json <f>` tras cada ola; `bash scripts/gates.sh --json <f>` completo al final (12 puertas: typecheck:all, api unit, admin-web unit, ai-core, worker, contratos raíz, discoverability, nav-tree --check, route-access, cocoa waves, rbac:sync --dry-run, migrate status + drift) | todo | puerta completa final del orquestador (`scratchpad/L8/gates-full.json`): **13/14** — typecheck 15 PASS · 0 FAIL · 1 SKIP; api 3.622; admin-web 2.045; ai-core 119; worker 34; contratos raíz 786 (784 · 0 fail · 2 skip, tras añadir `integrations-status.spec.ts` a `seed-ux-day-contract` l.164/188 y corregir el flaky #1 de `payments-tenancy`: `correlationId` fuera del cuerpo comparado); discoverability 197 URL; route-access 15 × 197; cocoa waves §6 al día; rbac dry-run OK; migrate 24/24 + «No difference detected.»; build OK; integración 993 (985 · 8 skip); **único rojo** `nav-tree --check` por el CSV compartido (filas de otro carril): regenerar `nav-tree.generated.json` en el carril dueño. Corrector L8 (`--quick`, `scratchpad/L8-fix/gates-quick.json`): 11/12 con el mismo único rojo (`nav-tree --check`); `integraciones-estado.test.mts` 10/10 a mano |

Instancia propia para las sondas de §2.4 (desde `apps/api`): `PORT=<api> RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node
--env-file-if-exists=../../.env --import tsx src/server.ts`; Vite (desde `apps/admin-web`): `VITE_API_URL=http://127.0.0.1:<api>
node ./node_modules/.bin/vite --port <vite> --host 127.0.0.1 --strictPort`. Se matan por PID, nunca con `pkill -f`.

Documentos relacionados: `docs/api-contracts.md` («Estado de las integraciones (Tanda L8 · L8-05)», «Integration Marketplace» con
el hub honesto, `/health` en «Plataforma», `template-stats` en «Notifications»), `docs/manual/60-sistemas.md` §3.3 (L8-07),
`docs/audits/TANDA-L8-INTEGRACIONES-2026-09-20.md` (cierre de la tanda), el bloque «Tanda L8 · Integraciones honestas» de
`docs/audits/ESTADO-VERIFICADO.md`, `CLAUDE.md` (deuda 19 y «Docs prioritarios»), la auditoría de textos
`scratchpad/L8/audit-textos.md` (no versionada: A1-A9 y B1 cerradas —A8 KPI de campañas, A9 `CocoaStatusBar` borrado y B1 SES
«(simulador)» por el corrector L8—; quedan B2-B6 y los comentarios `QuickCheckInDrawer.tsx:45` / `e2e/quick-checkin.spec.ts:18`) y
los runbooks citados en la cabecera.
