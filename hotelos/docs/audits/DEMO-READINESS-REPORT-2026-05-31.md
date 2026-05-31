# Pre-Demo Readiness Audit · 2026-05-31

Fuentes: `APP-DISCOVERABILITY-AUDIT.md`, `SIDEBAR-PLACEHOLDER-AUDIT.md`, `PLACEHOLDER-CLEANUP-PLAN.md`, `AUTO-FIX-PROPOSAL.md`, `LINT-RULE-PROPOSAL.md`. Owner: Tech Lead Frontend + PM. Horizonte: 3 dias a la demo.

## TL;DR

- **187 screens totales** · **94 reales** (50%) · **48 mocks/placeholders** (26%) · **45 parciales** (24%)
- **64 screens expuestas en sidebar** (34% del codigo). **47 orphan** sin entry point. **12 broken links**. **23 placeholders dead-end**. **8 suites enterradas** (Revenue Forecast, Compliance Reporting, AI Onboarding, etc.).
- **Demo readiness score: 62 / 100**. El nucleo operativo (Bookings, Front Desk, Housekeeping, Rate Grid, Compliance ES) esta listo. Los anillos exteriores (CRM avanzado, Loyalty, ESG, AI ops) son irregulares.
- **Top 5 critical blockers**: dialog crear-reserva sin CTA visible, sidebar IA sobrecargado (15 placeholders confundibles), Compliance Spain Register orphan (mostrar mata el demo si no se accede), broken link Settings>Audit, AI Wizard sin "resume" persistente tras login fresh.
- **Top 10 mocks a rehacer**: Marketing > Campaigns, Analytics > Custom Dashboards, AI > Recommendations, Integrations > Marketplace, Settings > White-Label, Reports > Templates, Onboarding > Sample Data, GroupSettings, EventSpacesSettings, ProcurementSettings. Detalle abajo.
- **Modulos demo-ready (8)**: Bookings & Reservations, Front Desk (check-in/QR), Housekeeping, Rate Grid Editor, Channel Manager push (Booking/Expedia), Compliance Spain Register (sandbox), Night Audit, Director Dashboard KPIs.
- **Modulos no demo-ready (6)**: CRM > Campaigns reales, Loyalty Settings (parcial), ESG/ESRS Reporting, AI Operations (agents/audit/costs), Marketplace, White-Label.

---

## Sidebar IA analysis

El sidebar actual mezcla en un mismo nivel pantallas operativas reales con accesos a "Ajustes de X" que en realidad son placeholders. Esto produce dos sintomas medibles: (a) usuarios pilot pierden 30-90 s buscando funciones que existen pero estan dos clicks abajo, (b) los demos enseñan "Coming soon" como contenido nominal porque el AE entra a buscar settings.

Distribucion por grupo segun `Sidebar.tsx` (15 entries marcadas `placeholder: true` + 48 `makeModulePlaceholder` en `App.tsx`):

| Grupo top-level | Subgrupos | Items totales | Reales | Placeholder/redirect | % real |
|---|---|---:|---:|---:|---:|
| Dashboard / Mi dia | 0 | 6 | 6 | 0 | 100% |
| Bookings & Reservations | Calendar, Walk-in, Groups | 14 | 12 | 2 | 86% |
| Front Desk | Check-in, QR, Wallet | 9 | 9 | 0 | 100% |
| Housekeeping | Board, Incidents | 7 | 6 | 1 | 86% |
| Revenue | Rate Grid, Forecast, Upsells | 18 | 9 | 9 (orphan suite Forecast) | 50% |
| Distribution / Channels | Booking, Expedia, OTAs | 11 | 9 | 2 | 82% |
| Guest Ops | CRM, Loyalty, Surveys, Messaging | 22 | 11 | 11 | 50% |
| Finance | Invoicing, Payroll, Treasury, Commissions | 19 | 9 | 10 | 47% |
| Compliance | VeriFactu, Spain Register, ESRS, Audit | 14 | 6 | 8 | 43% |
| Operations | Quality, Sustainability, Safety | 16 | 8 | 8 | 50% |
| AI | Settings, Agents, Audit, Costs, Governance | 15 | 2 | 13 | 13% |
| Integrations & Developer | Marketplace, Webhooks, API keys, Audit log | 12 | 5 | 7 | 42% |
| Settings | 15 sub-areas de configuracion | 24 | 9 | 15 | 38% |

**Lo que refleja el sidebar hoy**: ambicion de producto completo (gran cobertura horizontal), no la realidad operativa lista para enseñar. La IA esta optimizada para "demostrar amplitud" mas que para "guiar a un manager hotelero recien onboarded a su tarea de hoy".

**Sobrecargas detectadas**:

1. Bloque AI con 15 items pero solo `AISettings` y `AIGovernance` son reales. Los otros 13 son placeholders Q4 2026.
2. Bloque Settings con 24 items, 15 placeholders. Cada visita a Settings genera una percepcion de producto inacabado.
3. Bloque Compliance mezcla 3 verticales muy distintos (fiscal ES, ESG, audit) sin separacion. ESRS deberia ser un subgrupo propio (ver `AUTO-FIX-PROPOSAL.md` §4).
4. Bloque Guest Ops mezcla CRM, Loyalty, Surveys y Messaging sin jerarquia clara.

**Que consolidar antes del demo**:

- Colapsar AI a 3 items visibles (Settings, Governance, "AI Operations · Próximamente Q4 2026"). Esconder el resto detras de un disclosure.
- Mover los 15 placeholders de Settings a un patron unificado "Configuracion avanzada · Próximamente" con disclosure unico.
- Crear subgrupo Compliance > Fiscal (VeriFactu + AEAT + Tax calendar) y Compliance > ESG (ESRS dashboard + Evidence) — separa los dos relatos.
- Quitar del sidebar los 10 items dead-end identificados en `AUTO-FIX-PROPOSAL.md` §2 (Reports "Coming soon", Marketing "Campaigns (beta)", Finance > Reports duplicado, Settings > General/Preferences, Guests > Segments (legacy), Operations > Cleaning v1, Property > Photos, AI > Insights duplicado, Compliance > GDPR (old)).

---

## Per-category status

### Bookings & Reservations · **READY**
Lista, detalle y dialog `NewReservationDialog` operativos. Falta unicamente CTA visible en header (hoy solo shortcut `N`). Walk-in funcional con asignacion de room. Calendar drag-drop estable.

### Front Desk · **READY**
Check-in con generacion de QR y Apple/Google Wallet pass. Front Desk Copilot responde a queries naturales ("cuantas llegadas hoy"). Pre-arrival message dialog funciona.

### Housekeeping · **READY**
Board operativo con drag de habitaciones. Assign rooms dialog completo. Incident report dialog cruzado a Quality funciona end-to-end.

### Rate Grid & Pricing · **READY**
Rate Grid Editor con bulk edit (+5% week, +N% range, copy-from-day). Persiste cambios. Falta CTA "Bulk Edit" visible (hoy via shortcut), pero el dialog responde.

### Channel Manager · **READY**
Push manual a Booking.com y Expedia funcional contra sandbox. Sync errors visibles. Connect channel dialog completo. Channel mapping persistido.

### Compliance Spain Register · **READY (con caveat)**
VeriFactu sandbox sign opera contra mock de AEAT. Spain Guest Register UI completa pero **orphan**: hoy no se accede desde sidebar (issue #2 en discoverability). Para demo es critico añadir entry visible.

### Night Audit · **READY**
Run audit boton ejecuta el cierre del dia, muestra checklist y genera reportes. Estable en pilot client.

### Director Dashboard · **READY**
KPIs cargan desde datos reales (revpar, adr, occupancy, MTD vs LY). Falta widget "Pilot Clients" tab pero no es blocker para una demo de manager.

### Groups & Events · **PARTIAL**
Group create con 50 rooms operativo. Rooming list import (CSV) funciona. `GroupSettings` y `EventSpacesSettings` son placeholders Q1'27 (no mostrar).

### Quality & Incidents · **PARTIAL**
Quality dashboard y `IncidentDetailScreen` reales pero orphan (no en sidebar segun `AUTO-FIX-PROPOSAL.md` §1). Workflow editor pendiente. Cases reales operativos.

### Energy & Sustainability · **PARTIAL**
`EnergyOverviewScreen` real y dashboard de Sustainability con KPIs. Subgrupo Sustainability inexistente en sidebar; meter connection dialog pendiente.

### Loyalty · **PARTIAL**
`LoyaltyProgramScreen` real (tiers + ratio + benefits). `LoyaltyDashboardScreen` real pero accesible solo via deep link desde guest profile. Settings placeholder a remplazar (quick win identificado).

### Payroll & HR · **PARTIAL**
`PayrollRunScreen` y `PayrollHistoryScreen` reales pero orphan. Integracion payroll backend mock.

### CRM Campaigns · **NOT READY**
Solo wireframe. Backend listo, UI muestra "Stay tuned!". No mostrar.

### Marketplace · **NOT READY**
Placeholder con lista hardcoded de 3 items. No es marketplace real. No mostrar.

### ESG / ESRS · **NOT READY**
`EsrsDashboardScreen` y `EsrsEvidenceScreen` existen pero orphan, sin subgrupo Compliance > ESG y sin upload evidence dialog completo. Mandatorio EU 2026 pero no listo para demo 2026-06.

### AI Operations · **NOT READY**
`AiAgentsScreen`, `AiAuditScreen`, `AiCostsScreen` son placeholders. Sub-grupo `AI > Operations` no existe aun. Mostrar solo `AISettings` + `AIGovernance`.

### White-Label · **NOT READY**
Placeholder "Contact Sales" con form roto (HTTP 500). No mostrar bajo ninguna circunstancia.

### Custom Dashboards · **NOT READY**
Wireframe estatico. No mostrar.

### AI Recommendations · **NOT READY**
Muestra mock data. Pilot reports "no funciona". No mostrar.

---

## Critical pre-demo blockers (priorizados)

| # | Issue | Modulo | Severidad | Fix time |
|---|-------|--------|-----------|----------|
| 1 | Dialog crear-reserva sin CTA visible en Bookings header (solo shortcut `N`) | Bookings | H | 2h |
| 2 | Spain Guest Register / VeriFactu screens orphan, sin entry en sidebar Compliance | Compliance | H | 1h (anadir items + verificar route) |
| 3 | Sidebar AI bloque con 13 placeholders visibles — colapsar a 3 reales + 1 disclosure | Sidebar IA | H | 3h |
| 4 | Broken link Settings > Audit Trail apunta a `/backoffice/audit` (404) — real es `/admin/audit-log` | Backoffice | H | 30 min |
| 5 | AI Onboarding Wizard orphan tras refresh: no hay "Resume Onboarding" persistente en Dashboard header | Onboarding | H | 4h |
| 6 | 15 entries `placeholder: true` en Sidebar.tsx llenan Settings de "Ajustes de X · próximamente" | Settings | H | 6h (consolidar en disclosure unico) |
| 7 | Dialog crear-tarifa enterrado en menu contextual fila — mover a header Rate Plans | Pricing | H | 2h |
| 8 | 10 items dead-end en sidebar (Reports "Coming soon", Marketing "Campaigns beta", Cleaning v1, etc.) | Sidebar IA | H | 1h (remover) |
| 9 | Revenue Forecast suite (8 screens) sin entry — Forecasting subgrupo a crear | Revenue | M | 3h |
| 10 | Dashboard "View Forecast" widget apunta a `/revenue/forecast` placeholder index — redirigir a `/revenue/forecast/overview` | Dashboard | M | 30 min |
| 11 | Bookings detail > "Manage Rate" abre dialog vacio por falta de `propertyId` en handler | Bookings | M | 1h |
| 12 | Help menu > Documentation apunta a dominio no registrado | Global | M | 15 min (apuntar a `/docs` o esconder) |
| 13 | Footer > Status Page apunta a `status.hotelos.io` (404) — redirigir a `/admin/system-status` | Footer | M | 15 min |
| 14 | Encryption Settings inaccesible para tenant admins por permission gate mal configurado | Security | M | 2h |
| 15 | Mobile App banner "Download iOS App" apunta a placeholder App Store | Marketing | L | esconder en demo |

**Total tiempo fix critical (H)**: ~20 h. Asignable a 2 devs en 24h.

---

## Top 10 mock screens a rehacer

Lista priorizada por **valor de demo** × **esfuerzo bajo**. LOC aproximados de `App.tsx` cleanup plan + endpoints requeridos.

| # | Screen | LOC actual | Endpoint a conectar | Esfuerzo | Demo value |
|---|--------|-----:|---|---:|---|
| 1 | Marketing > Campaigns | 120 LOC mock | `POST /v1/campaigns` + `GET /v1/campaigns` | 6h | alto (lo piden todos los pilot) |
| 2 | Analytics > Custom Dashboards | 90 LOC wireframe | `GET /v1/analytics/widgets` + `POST /v1/dashboards` | 8h | alto |
| 3 | AI > Recommendations | 150 LOC mock data | `GET /v1/ai/recommendations` (ya existe) | 3h | medio-alto |
| 4 | Integrations > Marketplace | 200 LOC hardcoded | `GET /v1/marketplace/apps` | 5h | medio |
| 5 | Reports > Templates | 80 LOC "0 templates" | `GET /v1/reports/templates` (12 existen en backend) | 1h | alto (quick win) |
| 6 | Property Config > Category Manager | 180 LOC "Coming Soon" | `GET /v1/categories` + `POST /v1/categories` (backend listo) | 6h | medio |
| 7 | Settings > White-Label | 60 LOC "Contact Sales" | fix form HTTP 500 → `POST /v1/leads` | 2h | bajo (esconder vs fix) |
| 8 | Onboarding > Sample Data | 40 LOC handler vacio | `POST /v1/onboarding/seed-sample` | 3h | alto (mejora onboarding) |
| 9 | GroupSettings | 200 LOC placeholder | `GET/PUT /v1/groups/settings` | 12h | bajo (no demo) |
| 10 | ProcurementSettings | 180 LOC placeholder | `GET/PUT /v1/procurement/rules` | 10h | bajo (no demo) |

**Recomendacion para 72h pre-demo**: priorizar #1, #3, #5 (suman ~10h, valor alto). #7 esconderlo. El resto, dejar para post-demo.

---

## Demo script recomendado

Flujo demo de **15 minutos** cubriendo solo modulos demo-ready. Orden optimizado para mostrar journey real de un manager hotelero, no para lucirse con features.

1. **Login → Persona Receptionist → 'Mi dia' (action queue)** [1 min]
   Mostrar dashboard personalizado con KPIs y cola de acciones del dia (llegadas, salidas, cuentas pendientes). Demuestra personalizacion por rol.

2. **Crear reserva walk-in → asignar room** [2 min]
   Click "+ Nueva Reserva" desde header (asumiendo fix de blocker #1). Llenar formulario, seleccionar fechas, asignar room. Mostrar drag-drop a calendar. Demuestra el flujo critico de front desk.

3. **Check-in con QR / Wallet pass** [1.5 min]
   Abrir reserva creada, lanzar check-in, generar QR. Mostrar Wallet pass en simulador iPhone (Apple Wallet preview). Diferenciador UX claro.

4. **Ver Rate Grid Editor → bulk edit +5% week** [2 min]
   Navegar a Pricing, abrir Rate Grid Editor. Seleccionar rango (Lun-Dom), bulk edit +5%, aplicar. Mostrar persistencia y "diff" antes/despues. Mensaje: control granular sin spreadsheets.

5. **Push a Booking.com / Expedia** [1.5 min]
   Channel Manager → Sync now → mostrar log de updates exitosos. Si hay error de mapping, mostrar como se resuelve inline. Demuestra que el sistema es operacional, no demo.

6. **Front Desk Copilot 'cuantas llegadas hoy'** [1 min]
   Abrir Copilot, pregunta natural. Mostrar respuesta con numero + breakdown por tipo de huesped. Cierre del bloque "AI utilil hoy".

7. **Group create con 50 rooms + rooming import** [2 min]
   Nuevo grupo, fechas, 50 rooms. Importar CSV de rooming. Mostrar como asigna automaticamente. Demuestra capacidad B2B.

8. **Compliance Center → VeriFactu sandbox sign** [1.5 min]
   Compliance > Spain > VeriFactu (asumiendo fix de blocker #2). Firma sandbox de una factura. Mostrar registro. Critico para audiencia ES.

9. **Night audit run** [1 min]
   Operations > Night Audit → Run. Mostrar checklist progresando y output final. Demuestra automatizacion de cierre del dia.

10. **Director Dashboard → ver KPIs** [1.5 min]
    Cambiar persona a Director. Ver dashboard agregado: RevPAR, ADR, occupancy, MTD vs LY. Cierre con vision ejecutiva.

**Total: ~15 minutos** + 5 min de Q&A. **Margen de seguridad: 3 min** para recuperar si algo falla.

---

## Demo NO ready (NO mostrar)

Pantallas y flujos que el demo debe evitar — abrirlos enseña mocks que destruyen la credibilidad construida en los 15 min anteriores.

- **CRM > Campaigns** (`Stay tuned!` placeholder)
- **Analytics > Custom Dashboards** (wireframe estatico)
- **Integrations > Marketplace** (hardcoded 3 items)
- **Settings > White-Label** (form HTTP 500)
- **AI > Recommendations** (mock data)
- **AI > Agents / Audit / Costs** (placeholders Q4'26)
- **ESG / ESRS Reporting** (orphan, sin subgrupo aun)
- **Onboarding > Sample Data** (handler vacio)
- **Reports > Templates** (muestra "0 templates" pese a existir 12)
- **Mobile App banner Download iOS** (link placeholder App Store)
- **Settings > Reports duplicado / Settings > Preferences vacio** (esconder antes de demo)
- **Settings > Ajustes de [Workforce / Safety / Groups / Events / Sales / Reputation / Surveys / Quality / CRM / Procurement / Inventory]** — los 12 placeholders Q3-Q1'27 (consolidar bajo disclosure)
- **Marketing > Campaigns (beta)** (404)
- **Footer > Status Page** (link roto)
- **Help > Video Tutorials** (thumbnails sin enlace)
- **Help > Documentation** (dominio no registrado)
- **Backoffice Admin Suite** (12 screens super-admin, no para demo de manager)

**Regla de oro**: si el AE/PM duda durante la demo "¿esto esta listo?", la respuesta por defecto es **no abrir**. El cliente pilot ha reportado que ver "Coming Soon" destruye 3 minutos previos de confianza.

---

## Roadmap urgente (3 dias a la demo)

### Fase 1 (24h) · Top 5 mock fixes + blockers H

Owner: 2 devs full-time.

1. **CTA "+ Nueva Reserva"** en `ReservationsListScreen` header (blocker #1). 2h.
2. **Anadir entries Spain Register + VeriFactu** en sidebar Compliance (blocker #2). 1h.
3. **Reducir bloque AI** en sidebar a 3 items + disclosure (blocker #3). 3h.
4. **Fix broken link Settings > Audit Trail** a `/admin/audit-log` (blocker #4). 30 min.
5. **CTA "+ Crear Tarifa"** en header Rate Plans (blocker #7). 2h.
6. **Consolidar 15 placeholders Settings** en disclosure unico "Configuracion avanzada · Próximamente" (blocker #6). 6h.
7. **Remover 10 items dead-end** del sidebar (blocker #8). 1h.
8. **Resume Onboarding CTA persistente** en Dashboard header (blocker #5). 4h.
9. **Mock fixes #1 (Marketing Campaigns), #3 (AI Recommendations), #5 (Reports Templates)** — endpoints ya existen, solo wire-up. 10h.
10. **Anadir 3 quick wins de sidebar** (`GuestPortalSettings`, `UpsellSettings`, `LoyaltyProgram`) — eliminar `placeholder: true` y apuntar a screens reales (`SIDEBAR-PLACEHOLDER-AUDIT.md`). 30 min.

Total: ~30h, 2 devs en paralelo = 1 dia.

### Fase 2 (48h) · Seed data demo-quality

Owner: 1 dev backend + PM para validar.

- Crear seed dataset con 200 reservas spread en proximos 90 dias, mix de OTA / direct / walk-in / grupos.
- Crear 1 grupo grande (50 rooms, evento corporativo) ya creado para demo step 7.
- 50 guests con perfil real (lealtad, idiomas, preferencias) para que Copilot tenga datos.
- Rate plans con stagiones y restricciones realistas (min stay, closed to arrival).
- 12 reports templates ya visibles en Reports > Templates.
- Pilot incidentes resueltos en Quality dashboard (no en blanco).
- KPIs Director con 12 meses de historia (no comenzar en cero).
- Sandbox AEAT con 5 facturas firmadas pre-demo + 1 nueva en vivo.
- Channel Manager con 2 OTAs ya conectadas y syncs exitosos visibles.

### Fase 3 (72h) · Smoke test + rehearsal

Owner: PM + AE + 1 dev en standby.

- **Smoke test E2E** del demo script de 15 min. Cronometrar cada paso. Identificar transiciones lentas.
- **Pre-flight checklist**: verificar que cada uno de los 10 pasos del script abre sin error. Pasar 3 veces seguidas.
- **Plan B documentado** para cada paso: si falla step N, que enseñar en su lugar (siempre algo demo-ready).
- **Rehearsal con stakeholders internos** (1h, miercoles AM). Recoger feedback de timing y narrativa.
- **Freeze de deploys** desde 24h antes de demo en main / demo branches.
- **Backup demo grabado** (Loom) por si conectividad falla.

---

## Indicadores post-demo (medir el lunes siguiente)

- `placeholders activos en App.tsx` actual: 48. Target post-fase 1: 25. Target Q3: ≤ 20.
- `screens orphan` actual: 47. Target post-fase 1: 30. Target Q3: ≤ 15.
- `broken links sidebar/routes` actual: 12. Target post-fase 1: 2. Target Q3: 0.
- `discoverability score` (screens en sidebar / total) actual: 34%. Target post-fase 1: 45%. Target Q3: ≥ 60%.

Implementar pre-commit hooks de `LINT-RULE-PROPOSAL.md` (`sidebar-coverage`, `route-validity`, `placeholder-budget`) en modo warning durante fase 1 y bloqueante en CI desde fase 3 para evitar regresion.

---

## Anexo · Decisiones tomadas durante la sintesis

1. **No incluir AI Operations en demo** aunque pilot lo pidio: 3 screens placeholder + sin agentes funcionales reales. Promesa "Q4 2026" mas honesta que demo falso.
2. **Spain Register fixable en 1h** (solo anadir entry sidebar a screen real existente) — debe ir en demo por audiencia ES.
3. **Marketplace y White-Label** quedan fuera incluso si toma 5h fixar: el ROI demo de un marketplace mock es negativo.
4. **Consolidar 15 placeholders Settings** vale 6h pero ahorra ~90s por demo de despues (cliente abre Settings, ve ruido, perdemos hilo). ROI inmediato.
5. **Demo script 15 min** prefiere profundidad en 10 pasos sobre amplitud en 18 pasos. Cubrir menos, mejor.

Owner final del documento: Tech Lead Frontend. Revisores: PM + AE. Proxima auditoria: 1 semana post-demo con metricas de feedback.
