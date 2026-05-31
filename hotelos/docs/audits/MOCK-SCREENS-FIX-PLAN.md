# Mock Screens Fix Plan · 2026-05-31

## Resumen ejecutivo

Plan tactico para rehacer los **top 10 mock screens** identificados en el audit de discoverability. Estas pantallas presentan UI completa pero consumen datos hardcoded, stubs estaticos o fixtures de desarrollo, ofreciendo una ilusion de funcionalidad que falla en cuanto el usuario intenta filtrar, paginar o persistir. El objetivo es conectarlas a sus endpoints reales en una unica oleada paralela (W25) con 30 agentes especializados.

**Impacto estimado al cierre:** ~24% de la superficie funcional pasa de "demo-grade" a "production-grade". Reduce el gap entre lo demostrado en sales y lo entregado en pilots.

**Riesgo principal:** colision de schemas en endpoints que aun no estan estabilizados (Revenue Forecast v2, Compliance Spain Register v1.3). Mitigacion via contract tests previos al merge.

## Criterios de seleccion (top 10)

Las 10 screens priorizadas cumplen las tres condiciones:

1. **Visible en sidebar o linkeada desde dashboard principal** — alto trafico de usuarios.
2. **Backend endpoint ya existe** (al menos en staging) — no requiere disenar contrato desde cero.
3. **Mock indicators detectables** — uno o mas de: array literal hardcoded, import desde `__fixtures__/`, `Math.random()` para valores, fechas estaticas tipo `2025-01-15`, comentarios `// TODO: connect to API`, ausencia de loading/error states.

Se excluyen explicitamente las screens en `intentional Q4 2026` (ver `PLACEHOLDER-CLEANUP-PLAN.md`) y las que tienen endpoint pero solo en spec sin implementacion.

## Tabla maestra · Top 10 mock screens

| # | Screen | Mock indicators | Backend endpoint a conectar | Datos a sembrar | LOC esfuerzo | Workflow |
|---|--------|-----------------|------------------------------|------------------|--------------|----------|
| 1 | Revenue Forecast Overview (`/revenue/forecast/overview`) | Array `MOCK_FORECAST_30D` en `ForecastOverview.tsx:42`; sin `useQuery`; chart usa fixture `forecast.fixture.json` | `GET /api/v1/revenue/forecast?range=30d&propertyId=:id` | Seed 90d de occupancy + ADR + RevPAR por property pilot (3 tenants) | ~180 LOC (hook + skeleton + error boundary) | A |
| 2 | Scenario Planner (`/revenue/forecast/scenarios`) | Funcion `generateMockScenarios()` con `Math.random()`; comparacion side-by-side sin state | `POST /api/v1/revenue/scenarios/simulate` + `GET /api/v1/revenue/scenarios` | Seed 4 scenarios baseline (optimistic/realistic/pessimistic/custom) por tenant | ~240 LOC (form + mutation + persist) | A |
| 3 | Seasonality Heatmap (`/revenue/forecast/seasonality`) | Heatmap con `Array.from({length: 365})` mapeado a colores random; tooltip muestra placeholder | `GET /api/v1/revenue/seasonality?year=:year&granularity=day` | Backfill 24 meses historicos por property (DTW + Madrid + Barcelona) | ~140 LOC (data adapter + memoization) | A |
| 4 | Spain Guest Register (`/compliance/spain-register`) | Form pre-rellenado con `MOCK_REGISTRATION`; submit es `console.log`; sin validacion | `POST /api/v1/compliance/spain/register` + `GET /api/v1/compliance/spain/submissions` | Seed catalogo nacionalidades + tipos documento Hospederias 2024 | ~320 LOC (form + Zod schema + retry + dual-mode submit) | B |
| 5 | Audit Log Viewer (`/compliance/audit-log`) | Array `MOCK_AUDIT_EVENTS` con 50 eventos estaticos; filtros no aplicados realmente; export descarga JSON local | `GET /api/v1/audit/events?from=&to=&actor=&action=` + `POST /api/v1/audit/export` | Importar 6 meses de eventos reales del tenant pilot (sanitizados) | ~280 LOC (query params + virtualization + export job) | B |
| 6 | Compliance Exports Hub (`/compliance/exports`) | Lista hardcoded de 8 export types; boton "Generate" hace setTimeout 2s | `GET /api/v1/compliance/exports/types` + `POST /api/v1/compliance/exports/jobs` + `GET /api/v1/compliance/exports/jobs/:id` | Seed 12 plantillas de export (SII, Modelo 179, Spain Register, GDPR, etc.) | ~360 LOC (catalog + async job polling + download manager) | B |
| 7 | Modules Manager (`/admin/modules`) | Toggles wired a useState local; persist via localStorage; sin RBAC | `GET /api/v1/tenants/:id/modules` + `PATCH /api/v1/tenants/:id/modules/:moduleId` | Seed catalogo 32 modulos con feature flags + dependencias declaradas | ~220 LOC (optimistic toggle + dependency resolver + rollback) | C |
| 8 | Audit Trail Settings (`/admin/audit-trail`) | Config UI con `defaultConfig` constante; "Save" muestra toast sin POST | `GET /api/v1/tenants/:id/audit-config` + `PUT /api/v1/tenants/:id/audit-config` | Seed config por defecto: retencion 365d, eventos sensibles flagged, anonymize-PII on | ~160 LOC (form + diff detection + audit-the-audit log) | C |
| 9 | API Apps Registry (`/admin/api-apps`) | Lista de 6 apps mock con keys ficticias `sk_test_*`; "Rotate" hace nothing | `GET /api/v1/tenants/:id/api-apps` + `POST /api/v1/api-apps/:id/rotate-key` + `DELETE /api/v1/api-apps/:id` | Seed 2 apps default por tenant (admin-web + mobile-companion) con scopes minimos | ~290 LOC (CRUD + secure key reveal + confirmation modal) | C |
| 10 | Webhook Subscriptions (`/admin/webhooks`) | Tabla con 12 webhooks estaticos; "Test fire" simula 200 OK siempre | `GET /api/v1/tenants/:id/webhooks` + `POST /api/v1/webhooks` + `POST /api/v1/webhooks/:id/test` | Seed catalogo 24 eventos disponibles (booking.created, payment.captured, etc.) | ~340 LOC (form + signing secret + delivery logs + retry policy) | C |

**Totales:** ~2,530 LOC esfuerzo estimado · 3 workflows · 10 endpoints distintos a estabilizar · seeds para 3 tenants pilot.

## Agrupacion por workflow

Los workflows agrupan screens que comparten **conceptos de dominio, schemas de respuesta y patrones de UI**. Esto permite que un mismo lote de 10 agentes (3 por workflow + 1 coordinador) reutilice hooks, types y test fixtures sin duplicar trabajo.

### Workflow A · Revenue & Forecast (3 screens)

**Screens incluidas:** #1 Forecast Overview · #2 Scenario Planner · #3 Seasonality Heatmap

**Por que agruparlas:**
- Comparten el mismo modelo de dominio (`ForecastDataPoint`, `OccupancyMetric`, `RateBucket`).
- Todas consumen del mismo servicio backend (`revenue-forecast-service`) con endpoints contiguos en el OpenAPI spec.
- Patron de UI comun: charts con Recharts/Visx + filtros temporales + comparacion entre escenarios.
- Una sola dependencia critica: estabilizar el contrato `ForecastResponse v2` antes de empezar.

**Riesgos:**
- El servicio `revenue-forecast-service` esta en migracion a v2 (issue REV-1184). Bloquear hasta que merge antes del W25-D1.
- Seasonality requiere backfill de 24 meses; si la BD del tenant pilot no tiene esa profundidad, derivar de imputacion.

**Asignacion:** 10 agentes (3 por screen + 1 lead que estabiliza tipos compartidos).

### Workflow B · Compliance Forms (3 screens)

**Screens incluidas:** #4 Spain Register · #5 Audit Log Viewer · #6 Compliance Exports

**Por que agruparlas:**
- Las tres son **forms o consumidores de jobs asincronos** con polling/retry.
- Comparten el patron "submit → poll → download/notify" que requiere un mismo conjunto de hooks (`useAsyncJob`, `useExportPoller`).
- Misma audiencia: compliance officers de tenants ES, con requisitos de auditoria y trazabilidad que aplican a las tres.
- Backend reside en `compliance-service` con prefijo comun `/api/v1/compliance/*`.

**Riesgos:**
- Spain Register tiene cambio normativo pendiente (`RD 933/2021` actualizacion Q2 2026); validar con legal antes de codear el schema final.
- Audit Log Viewer puede tener volumen alto (100k+ eventos por tenant/mes); requiere virtualizacion estricta y pagination server-side.

**Asignacion:** 10 agentes (3 por screen + 1 lead que estabiliza el patron `useAsyncJob`).

### Workflow C · Admin & Platform Settings (4 screens)

**Screens incluidas:** #7 Modules Manager · #8 Audit Trail Settings · #9 API Apps Registry · #10 Webhook Subscriptions

**Por que agruparlas:**
- Las cuatro son **tenant-scoped admin screens** con patron CRUD + optimistic updates.
- Comparten guards RBAC (`requiresRole('tenant-admin')`) y patrones de confirmacion para acciones destructivas.
- Backend reside en `tenant-admin-service` y `webhooks-service` (sibling).
- Misma audiencia: admins de tenant que configuran integraciones.

**Riesgos:**
- API Apps y Webhooks tocan **secrets en cleartext** (signing keys, API keys). Pasar review de seguridad antes de merge; nunca loguear en clear; usar `SecretReveal` component con timeout.
- Modules Manager tiene grafo de dependencias entre features; un resolver naive puede dejar la tenant en estado inconsistente. Implementar dry-run obligatorio.

**Asignacion:** 10 agentes (2 por screen + 2 leads: uno security/secrets, uno RBAC/dependencies).

## Propuesta de ejecucion · W25

**Formato:** una oleada (W25) con **30 agentes** trabajando en paralelo, divididos en 3 workflows independientes. Cada workflow opera en su propio branch (`w25/workflow-a-revenue`, `w25/workflow-b-compliance`, `w25/workflow-c-admin`) y mergea a `main` via PR independiente al cierre.

**Lineas maestras:**

1. **Dia 1 (kick-off):** lead de cada workflow estabiliza tipos compartidos y publica un paquete `@hotelos/forecast-types`, `@hotelos/compliance-types`, `@hotelos/admin-types`. Resto de agentes bloqueados hasta D1 EOD.
2. **Dias 2-4 (build):** agentes implementan hooks, components y wiring. Tests unitarios obligatorios por hook (cobertura >= 80%).
3. **Dia 5 (integration):** contract tests contra staging backend; seeds aplicados via `hotelos-seed` CLI en los 3 tenants pilot.
4. **Dia 6 (verification):** smoke tests E2E (Playwright) + walkthrough manual por QA lead + sign-off por product owner del dominio.
5. **Dia 7 (merge):** PRs mergean en orden Workflow A → B → C para minimizar conflictos en `App.tsx` (routes) y `Sidebar.tsx` (entries).

**Pre-requisitos no negociables:**

- `revenue-forecast-service v2` ya en staging (owner: REV team, deadline W24-D5).
- `compliance-service` con endpoint `/exports/jobs` desplegado (owner: COMP team).
- `tenant-admin-service` con RBAC scopes `module.write`, `audit.config`, `apps.manage`, `webhooks.manage` provisionados.
- Migrations de DB para seeds aplicadas en los 3 tenants pilot.
- Feature flag global `mock-screens-w25-rollout` creado, default `off`, para rollback rapido si algun workflow rompe.

**Criterios de done por screen:**

1. Cero arrays mock en el codigo de la screen (eliminacion fisica, no comentado).
2. `useQuery`/`useMutation` con `react-query` para todo data fetching.
3. Loading skeleton + error boundary + empty state implementados.
4. Tests: unit del hook + integration de la screen + E2E happy path.
5. Storybook entry con 4 estados: loading, success, error, empty.
6. Sin warnings en consola al renderizar.
7. Validado en los 3 tenants pilot con datos reales sembrados.

**Metricas de exito post-W25:**

- 10/10 screens muestran datos reales en staging.
- 0 reportes de "esto se ve raro" en pilot client durante la primera semana post-merge.
- Coverage agregado de las 10 screens >= 75%.
- Latencia P95 < 800ms para cualquier query inicial (con seeds aplicados).

## Plan de rollback

Si una screen rompe en produccion: flip del feature flag por screen (`mock-screens-w25-rollout-revenue-forecast`, etc.) revierte a la version mock previa, que se preserva durante 2 sprints en `legacy/mock-fallback/` y se elimina en W27 una vez estabilizado.

## Dependencias cruzadas con otros planes

- **`PLACEHOLDER-CLEANUP-PLAN.md`:** algunas screens objetivo de redirect (Replace) pueden interferir si se hacen simultaneamente. Coordinar para que W25 cierre antes de la limpieza de placeholders.
- **`APP-DISCOVERABILITY-AUDIT.md` issues #1, #2, #3:** las screens #1-#6 de este plan son exactamente las que el audit marca como orphan/buried. Resolver el mock implica tambien anadir entries en Sidebar (parte del scope W25).
- **`AUTO-FIX-PROPOSAL.md`:** el linter propuesto debe activarse **despues** del merge de W25; si no, bloqueara cualquier intento de empezar.

## Conclusion

Las 10 screens listadas concentran la mayor parte del "demo-vs-real" gap percibido por pilot clients. Una oleada concentrada de 30 agentes en 7 dias entrega un salto cualitativo de percepcion que no se conseguiria con sprints incrementales de 2-3 screens. La inversion estimada (~2,530 LOC + ~40h coordinacion) es asumible dentro del Q2 2026 si W24 cierra los pre-requisitos de backend a tiempo.
