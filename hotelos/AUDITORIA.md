# HotelOS — Auditoría Exhaustiva + Resumen de Developer

**Fecha:** 2026-05-21 · **Revisión:** estado actual tras las rondas de remediación P0 + P1 + P2 + módulo IA. Sustituye a la auditoría inicial. (El módulo de IA tiene además su informe propio en `AUDITORIA-IA.md`.)
**Método:** revisión de código por 6 agentes especializados (solo lectura) sobre el código ACTUAL, verificando además que las remediaciones siguen intactas (sin regresiones) + verificación en API/navegador.

---

## PARTE A — Veredicto y scorecard

**Estado global:** de ~50% real (auditoría inicial) a **~65% real**. El núcleo contable/cumplimiento, el channel manager (agregador), las operaciones (HK/mantenimiento), el front-desk y la mensajería ya **persisten en Prisma y funcionan de punta a punta**. El módulo de IA pasó de "marketing" a **IA real conectable**. Quedan **dos deudas arquitectónicas grandes** (RBAC por handler + demo-store) y varios módulos aún en demo.

**Las remediaciones de esta ronda están TODAS verificadas como intactas (6/6 dominios OK).**

| Dominio | Antes | Ahora | Nota |
|---|---|---|---|
| Seguridad/Auth | 🔴 20% | 🟡 ~55% | Cifrado PII real, error handler, MFA real, gating prod — pero RBAC por handler pendiente |
| Cumplimiento ES | 🟠 60% | 🟠 ~62% | VeriFactu núcleo real; XAdES/scheduler/SII pendientes (no go-live) |
| Contabilidad/ERP | 🟡 65% | 🟢 ~75% | AP + asientos manuales + cierre + branding factura reales |
| PMS/Front-desk | 🟠 55%/20% | 🟢 ~70% | Acciones de recepción reales en UI; pricing real; oversell fix |
| Distribución/Channel | 🟠 45% | 🟡 ~55% | Agregador + rate-grid reales; OTAs/RMS aún stub |
| Operaciones | 🔴 35% | 🟢 ~70% | HK/mantenimiento persisten + visibles en dashboards |
| Guest experience | 🔴 40% | 🟡 ~55% | Entrega real (email/SMS/WhatsApp); portal pago/online check-in stub |
| IA | 🔴 35% | 🟢 conectable | LLM/visión real, copiloto, OCR, evals, telemetría; ver AUDITORIA-IA.md |
| Frontend admin-web | 🟡 60% | 🟡 ~69% | ~89/129 reales, ~40 placeholders (settings) |
| Tests | 🔴 | 🔴 | CI solo corre grep-tests; los reales (.mts) no en CI |

---

## PARTE B — Resumen de developer

### Arquitectura
- **Monorepo pnpm**: `apps/{api,admin-web,worker,mobile,guest-web,ai-gateway}` + `packages/{database,compliance,shared,product,ui,ai-tools,onboarding,integrations,revenue,config}`.
- **API** (`apps/api`): Fastify + Prisma + Postgres 16. Entrada `src/server.ts` (~5k líneas, registra ~600 rutas). Lógica en `src/modules/<dominio>`. Capas transversales: `lib/auth-context.ts` (hook JWT), `security/route-permissions.ts` (manifiesto de permisos — toda ruta debe tener entrada), `lib/http-error.ts` (errores tipados), `lib/llm.ts` (proveedor IA texto+visión).
- **admin-web** (`apps/admin-web`): React 19 + Vite. Pantallas en `src/screens`, servicios en `src/services` (todo vía `api-client.ts`; **0 referencias a demo-store**). Navegación 3 zonas (`navigation/Sidebar.tsx`) con gating por permisos. Propiedad activa vía `services/activeProperty.ts`.
- **worker** (`apps/worker`): pg-boss (colas Postgres) para reintentos VeriFactu/TBAI/IGIC, modelo 303 y notificaciones. **No arranca con la API** (hay que lanzarlo aparte).
- **guest-web**: React (sign-in, stay overview, pre-check-in, service request) sobre endpoints reales del portal.
- **ai-gateway**: ejecuta el motor determinista de onboarding (las funciones LLM viven en el API).

### Cómo arrancar (dev)
```
# Postgres 16 en localhost:5432 (db hotelos)
cd packages/database && npx prisma db push && npx prisma db seed
cd apps/api && pnpm dev            # API :3000  (tsx src/server.ts)
cd apps/admin-web && pnpm dev      # web :5173  (vite)
cd apps/worker && pnpm dev         # opcional: colas/cron
```
Build web de producción: `cd apps/admin-web && pnpm build` (script añadido en esta ronda).

### Variables de entorno (encender funciones reales)
Todo degrada con elegancia sin clave (modo dev/simulado). Para activar:
- **Cifrado PII**: `ENCRYPTION_KEY`/`HOTELOS_FIELD_KEY` (base64 32 bytes). *(Ya configurado en dev.)*
- **IA (texto+visión)**: `AI_PROVIDER=anthropic|openai`, `AI_PROVIDER_API_KEY`, opc. `AI_MODEL`. Para OCR, modelo con visión.
- **Email**: `EMAIL_PROVIDER=postmark|sendgrid`, `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`.
- **SMS**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
- **WhatsApp**: `WHATSAPP_PHONE_ID`, `WHATSAPP_PROVIDER_TOKEN`.
- **Cumplimiento**: `VERIFACTU_MODE`/`SES_HOSPEDAJES_MODE` (sandbox por defecto) + certificado PKCS#12 (pendiente, ver Parte E).
- **Producción**: `NODE_ENV=production` activa los cierres de seguridad (sin fallback demo, sin MFA legacy, sin escalada de permisos). **No etiquetar mal el entorno.**

### Patrón "dual-mode" (clave para entender el código)
Muchos servicios escriben en Prisma (fuente de verdad) **y** espejan a `demo-store.ts` (estado en memoria legacy) para lectores que aún no migraron. El objetivo final es retirar demo-store. Identidad/scope del usuario hoy salen de `demoStore.userContext` en la mayoría de handlers (ver deuda #1).

---

## PARTE C — Auditoría pormenorizada por dominio

### C1. PMS core / recepción / folio / pricing
**REAL:** crear/modificar/cancelar/no-show reserva, check-in/out, asignación, folio + pagos, factura desde folio, **night audit** (date-roll, auto-cargo, reconciliación). **Acciones de recepción reales en la UI** (`ReservationDetailWorkspaceScreen`). **Oversell fix** (cuenta todas las reservas solapadas). **Pricing real**: `quoteAvailability` lee `RateDay` (mín. por noche) con fallback 136.
**Cabos sueltos:** `createReservation` persiste el `totalAmount` del cliente sin recalcular tarifa ni comprobar disponibilidad (`pms.service.ts:316`); firma de check-in es placeholder; doble fórmula de saldo (folio.service vs folio-balance.service — equivalentes hoy, deuda).
**Gaps prod:** rack/tape chart, room move, deposit ledger, splits/routing, inventario de grupos.

### C2. Finanzas / contabilidad / ERP
**REAL (verificado 6/6):** asiento AP de proveedor (DR 6xx/472, CR 400/4751), **asientos manuales en Prisma**, cierre/reapertura de ejercicio sin duplicar (regulariza 129), `/organizations/:id/accounts` lee las 80 cuentas PGC, **branding de factura** (`issuer`: logo/NIF/dirección/pie legal), estados financieros excluyen borradores (`status:posted`). Comisiones OTA (6230/4109), nómina (640/642), Modelo 303 desde `journalLine` real, banca con conciliación.
**Cabos sueltos (arreglados esta ronda):** cuenta 438 reetiquetada a "Anticipos de clientes" (pasivo) + añadida 407.
**Gaps prod:** sin export SIE/diario contable (solo nómina A3/Sage), sin SEPA (pain.001), sin AR aging, sin deposit ledger 438 posteado (`PaymentCaptured` asume cargo previo), sin periodificaciones.

### C3. Cumplimiento ES + Seguridad
**REAL:** cifrado PII (`$allModels`/`$allOperations`, AES-256-GCM, hashes de búsqueda) — **verificado: 22/22 guests cifrados**; auth endurecida (rechazo password null, MFA con codeHash real, escalada/fallback solo fuera de producción); error handler global (400/404, Prisma mapping); gating de zona IA; VeriFactu huella+cadena + submitters mTLS PKCS#12 reales (modo sandbox por defecto); GDPR DSAR/erasure.
**Cabos sueltos / no go-live:** **XAdES no conforme** (canonicalización por regex, PEM no PKCS#12 nativo → AEAT rechazaría); **sin scheduler 24h SES**; parte de viajeros aún en demo-store; **SII inexistente**; protecciones condicionadas a `NODE_ENV==="production"`.

### C4. Distribución (channel manager) + Revenue
**REAL:** agregador (push/ingest sobre `RateDay/InventoryDay/RestrictionDay`), mapeos idempotentes, sync-jobs, parity, readiness; **rate-grid real (P1.7)** — verificado PATCH→GET→quote 380€.
**Cabos sueltos:** 4 de 5 adaptadores OTA en stub por defecto; ingest real solo Booking (regex); rate-shopper sintético; **forecasts/recommendations/pickup/pace/scenarios/automation-rules siguen en demo-store**; credenciales OTA en claro (`credentialsSecretRef` sin uso); parity sin dedupe; **doble superficie de rutas channel-manager** (demo en `server.ts:1053-1148` vs real en `:4431-4566`).
**Gaps prod:** RMS real, webhooks OTA firmados, retry/DLQ, secret-store.

### C5. Operaciones + Guest experience + Mensajería
**REAL:** HK + mantenimiento persisten en Prisma y se reflejan en dashboards; offline async; **entrega real email/SMS/WhatsApp** (Postmark/SendGrid, Twilio, Meta) con honestidad (`simulated:true` dev / fail prod, nota "SIMULADO" en deliveries); magic-link honesto; guest-portal pre-check-in/service-request en Prisma; **copiloto de recepción** con indicador IA/reglas; concierge/reputation dashboards leen Prisma.
**Cabos sueltos:** online check-in/out/**pago** del portal son stubs (`server.ts:1233-1240`, no verifican token, escriben a demo-store, `/folio` devuelve 0); **sin PSP** (no mueve dinero); reputación/encuestas/loyalty solo lectura (sin ingesta); **POS no postea a folio**; pipeline de sentiment inexistente; `messaging.createServiceRequest` en demo-store (doble fuente con guest-portal Prisma); `transitionAdvancedRecord` muta memoria (ops fantasma).

### C6. IA + Frontend + Plataforma
**IA (ver AUDITORIA-IA.md):** capa LLM real (texto+visión), 5 funciones conectadas (reply, OCR, mapping-suggest, evals, copiloto), telemetría real, todo en español + gating. Catálogo de ~108 tools = metadatos (solo ~5 ejecutables).
**Frontend:** 129 pantallas, ~89 reales (63 con API), ~40 placeholders `ScreenScaffold` (sobre todo Settings/Manager). admin-web no toca demo-store.
**Plataforma:** **demo-store = 3.840 líneas, 44 imports** (deuda #1 de arquitectura). **Tests:** CI solo corre `tests/*.test.mjs` (37 de 39 son grep de texto, no ejecutan lógica); los **8 `.test.mts` reales no corren en CI**. mobile ~122 ficheros (depende de los mismos endpoints).

---

## PARTE D — Remediaciones aplicadas en estas rondas

- **P0 seguridad/datos:** cifrado PII arreglado (extensión + env), auth endurecida (password null, MFA real, gating prod), error handler global + validaciones 400, asiento AP + asientos manuales Prisma + cierre idempotente, fix oversell.
- **P1 flujos reales:** HK/mantenimiento → Prisma; **acciones de front-desk en UI**; **entrega real de mensajería**; **rate-grid → Prisma + pricing real**.
- **P2 IA:** capa LLM (texto+visión), borrador de respuesta, copiloto de recepción, OCR de documentos, telemetría real, evaluaciones reales, asistente de mapping en onboarding.
- **Módulo IA UX:** traducción al español (5 pantallas + nav + datos), vista de propietario, gating por rol, limpieza de fugas/placeholders.
- **Branding de factura:** logo + avisos legales por propiedad.
- **Cabos sueltos (esta ronda):** comentario "STUB runner" corregido; script `build` en admin-web; cuenta 438→pasivo + 407; closeFolio tolerante a redondeo; env de proveedores documentado.

---

## PARTE E — Backlog priorizado (cabos sueltos restantes)

### 🔴 P0 (bloqueantes de producción / multi-tenant)
1. **RBAC real por handler — BACKEND HECHO.** 310 handlers migrados de `demoStore.userContext` → `request.userContext` (idéntico en dev, **usuario autenticado real en producción**); 40 handlers recibieron `request`. *Falta (complementario):* admin-web debe enviar el token en **todas** las llamadas (hoy lo hacen `api-client`/`onboardingApi`; `pmsCommerceApi`/`backofficeApi` usan fetch sin token — en producción darían 401), y crear usuarios con roles limitados para probar 403.
2. **VeriFactu go-live — PENDIENTE (requiere librería cripto + certificado).** XAdES real (c14n11/exc-c14n + PKCS#12 nativo vía p. ej. node-forge), validación contra XSD oficiales, salir de modo sandbox, probar contra el entorno AEAT. **SII** sigue sin implementar (módulo nuevo).
3. **SES Hospedajes — SCHEDULER HECHO.** Añadido `runDueSesSubmissions` + intervalo in-process en la API (poll de `nextRetryAt` de los "retrying" + reporte de "overdue" >24h; `SES_SCHEDULER_INTERVAL_MS`/`SES_SCHEDULER_DISABLED`). El **parte de viajeros ya persiste en Prisma** (`prisma.guestRegisterRecord`). *Falta:* auto-encolar altas completas en plazo (hoy se encola en pre-check-in) y mover el scheduler al worker pg-boss para multi-instancia.

### 🟠 P1 (flujos a completar)
4. **Retirar/contraer demo-store** (3.840 líneas) — EN CURSO: **rate-grid** (RateDay/RestrictionDay/InventoryDay) y **revenue forecasts** (`RevenueForecast`, generador determinista que lee el rate grid real) ya migrados a Prisma. *Falta:* recommendations/pickup/pace/scenarios/automation-rules de revenue, channels stub, service-requests de messaging, y finalmente la identidad/scope (ligado al P0.1).
5. **Portal: online check-in/out + pago reales** + integración **PSP** (Stripe/Redsys/Adyen) — hoy fachada.
6. **POS → folio** (postear consumos a la cuenta); ingesta real de **reseñas/encuestas** + motor de **loyalty**.
7. **OTAs reales:** parsers de ingest para los 4 restantes, webhooks firmados, retry/DLQ, **cifrar credenciales** (usar `credentialsSecretRef`), dedupe de parity; unificar la doble superficie de rutas.
8. **Worker en marcha** por defecto (deliveries `scheduledFor` futuras se quedan en "queued").

### 🟡 P2 (calidad / paridad)
9. **Tests reales en CI:** ejecutar los `.test.mts` (no solo los grep de texto); cobertura de folio/fiscal/revenue.
10. **PMS pro:** recálculo de tarifa + chequeo de oversell en `createReservation`; rack/tape chart, room move, deposit ledger, splits/routing, grupos.
11. **ERP:** export SIE/A3 contabilidad, SEPA, AR aging, deposit ledger 438 posteado, periodificaciones.
12. **RMS real** + rate-shopper real (hoy sintético); más suites de evaluación IA; cablear más tools del catálogo.
13. **Frontend:** completar/retirar los ~40 placeholders de Settings; unificar design system; completar mobile.
14. **Hardening:** rate-limit + helmet; no condicionar toda la seguridad a `NODE_ENV`; secret manager.

---

## PARTE F — Checklist go-live (resumen)
1. `NODE_ENV=production` + revisar que NO queda dependencia de demo-store para identidad → **completar P0.1 (RBAC)**.
2. Claves: `ENCRYPTION_KEY`, proveedores (IA/email/SMS/WhatsApp/PSP), certificado AEAT PKCS#12.
3. VeriFactu/SES: XAdES real + scheduler + salir de sandbox.
4. Arrancar `apps/worker` (colas/cron).
5. CI: ejecutar los tests reales (`.test.mts`).
6. Rate-limit/helmet + secret manager + CORS por entorno.

**Conclusión:** la base es sólida y mucho mayor que en la auditoría inicial — núcleo contable/cumplimiento, operaciones, front-desk, channel aggregator, mensajería e IA ya son reales y verificados. El camino a producción está dominado por **dos deudas concretas y conocidas** (RBAC por handler + retirada de demo-store) y el **go-live fiscal** (XAdES/scheduler), todo claramente acotado en la Parte E.
