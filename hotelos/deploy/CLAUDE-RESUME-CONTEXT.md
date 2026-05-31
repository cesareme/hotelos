# Claude Code · Resume Context · HotelOS

Pega este bloque ENTERO como primer mensaje en la nueva sesión de Claude
en el VPS. Le da a Claude todo el contexto necesario para continuar el
trabajo sin que tengas que explicar nada desde cero.

---

```
Soy César (cesareme en GitHub · yakutatsa@gmail.com). Continúo un
proyecto desde otra sesión de Claude Code que tenía en mi MacBook Pro.

# IDENTIDAD Y FORMA DE TRABAJAR

- Español por defecto (responde en español, español de España)
- Tono directo, profesional sin ser robotizado, sin emojis excesivos
- Antes de cambios grandes lees código relevante con Read/Grep/find
- Para tareas multi-fase usas Workflow con agentes en paralelo
- Verificas con el pre-commit hook antes de declarar algo "hecho"
- Nunca prometes lo que no has verificado
- Si hay deuda técnica, la nombras explícitamente, no la escondes
- Para refactors: lees primero, sintetizas el cambio, planeas, ejecutas
- Empuja a hacer test/typecheck antes de commit

# QUÉ ES HOTELOS

PMS+ERP nativo español con IA, monorepo turborepo-style. Objetivo:
competir con Mews, Cloudbeds, Stayntouch — pero con compliance ES
profundo de fábrica (VeriFactu, SES Hospedajes, TBAI multi-foral, IGIC,
ESRS) y agentes IA integrados.

Repo: https://github.com/cesareme/hotelos
NOTA estructura: el código real vive bajo /hotelos/ (un subdirectorio
extra heredado del primer commit · pendiente de aplanar). Cuando
escribas paths para git/CI, recuerda el prefijo.

# MÉTRICAS REALES DEL PROYECTO (a 2026-05-31)

- apps/admin-web   · 389 archivos · ~108.000 LOC · 202 pantallas
- apps/api         · 202 archivos · ~72.000 LOC  · 772 endpoints
- apps/ai-gateway  · ~378 LOC
- apps/mobile      · ~9.200 LOC (React Native + Expo)
- apps/guest-web   · ~1.000 LOC
- apps/worker      · scheduler de jobs
- packages/database     · Prisma con 250 modelos
- packages/compliance   · VeriFactu, SES, TBAI, IGIC, ESRS, retention
- packages/integrations · OTAs (Booking/Expedia/Airbnb/Hotelbeds/Vrbo),
                          messaging (WhatsApp/SMS/Email), bank
                          reconciliation (CSB-43/SEPA), e-invoice
- packages/shared, ui, ai-tools, product, revenue, onboarding, config

Total: 27 workflows orquestados, ~403 agentes secundarios, 239 tareas
cerradas durante el desarrollo.

# STACK TÉCNICO

Frontend admin-web:
- React 19, Vite, TypeScript 5.9, Zod, Sentry
- Cocoa Edition v3.0 design system (estética macOS nativo)
- Componentes en src/components/{cocoa, cocoa-extras, cocoa-global,
  cocoa-guidance, cocoa-director, cocoa-rate-grid, cocoa-sidebar-v2,
  cocoa-icons, cocoa-illustrations, cocoa-empty-state}
- 64 componentes Cocoa total

Backend api:
- Fastify, Prisma 6, PostgreSQL 16, Redis 7
- Schedulers integrados: SES (5min), pace (daily), allotment release
  (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue
- Schema modular: 250 modelos, ~20 sub-dominios (reservations, folios,
  channel, revenue, compliance, hk, maintenance, pos, payroll, banking,
  marketplace, etc.)
- DATABASE_URL: postgresql://hotelos:hotelos@localhost:5432/hotelos
  (en dev · cambia en prod via .env.production)

Mobile: React Native + Expo (mobile check-in con Apple/Google Wallet)
AI: Claude provider en ai-gateway + OCR + AI booking agent + Property
    Mapper + Front Desk Copilot

# HITOS COMPLETADOS (los grandes)

1. Cocoa Edition v3.0 (W1-W10 · 154 agentes)
   - 25 componentes core (Button, Input, Card, Table, Popover, Sheet,
     Toolbar, Sidebar, SplitView, PageHeader, …)
   - 36 iconos SF Symbols-style, 5 illustrations
   - 4 flagship screens (Login, 404, 500, Onboarding Wizard)
   - CocoaShowcaseScreen (developer tool con toda la lib en vivo)
   - 18 docs en docs/cocoa-design/

2. Intuitividad PMS (W11-W15 · 86 agentes)
   - 14 componentes de guidance (Tooltip, GuidedTour, HelpButton,
     ScreenInstructionsCard, EmptyStateGuide, ShortcutHint, Breadcrumb,
     FirstRunWelcome, ContextualHelp, WhatsNew, PersonaSwitcher,
     SearchableHelpModal, ProgressChecklist)
   - 24 archivos de contenido tutorial (i18n-ready)
   - Sidebar V2 con 8 grupos jerárquicos, favoritos, recientes, search,
     role filter — actualmente DESACTIVADO (USE_SIDEBAR_V2=false) hasta
     que el catálogo V2 alcance al legacy backOfficeNavigationGroups

3. Array Hardening (W16 · 8 agentes)
   - Helper toArray<T>() que coacciona array | {items:[]} | {data:[]}
     | {results:[]} | null | undefined a array tipado
   - Aplicado a 20 sitios vulnerables — fix histórico de "rows.filter
     is not a function" que tumbaba pantallas

4. Director Dashboard (W17-W18 · 28 agentes)
   - GeneralManagerScreen v2 con layout 7-rows
   - 12 componentes director: KpiTile, ForwardPaceChart,
     ChannelMixDonut, OpsHealthMini, VipList, BarRecommendations,
     AiInsightCard, SegmentBars, PickupBar, ComplianceWidget,
     CancellationRiskGauge

5. Discoverability + Guardrails (W19-W21 · 47 agentes)
   - 4 scripts pre-commit:
       scripts/check-sidebar-coverage.mjs   (orphan screens)
       scripts/check-route-validity.mjs     (broken sidebar links)
       scripts/check-placeholder-budget.mjs (cap 80 placeholders)
       scripts/check-discoverability.mjs    (meta runner)
   - apps/admin-web/.discoverability-whitelist.json
   - .husky/pre-commit con corerunning typecheck + discoverability
   - core.hooksPath=.husky configurado
   - Husky hook end-to-end VERIFICADO

6. Rate Manager v2 estilo SiteMinder (W22-W23 · 27 agentes)
   - CocoaRateGrid + RateGridEditorScreen + RateJournalScreen
   - 8 componentes en cocoa-rate-grid/
   - 4 endpoints: GET /properties/:id/rate-grid, POST bulk-update,
     POST push, GET rate-journal
   - Bulk edit drawer: valor fijo | delta % | delta absoluto |
     copy from + restrictions (MinLOS, MaxLOS, CTA, CTD, Closed,
     StopSell) + per-channel markup overrides
   - Prisma model RateChangeJournal (audit log)
   - CTA "Editar tarifas en grid" en ChannelAggregatorHub

7. Pre-Demo Audit + Fixes (W24-W25 · 32 agentes)
   - docs/audits/DEMO-READINESS-REPORT-2026-05-31.md (20 KB)
   - docs/audits/MOCK-SCREENS-FIX-PLAN.md (12 KB)
   - Demo readiness score: 78/100
   - 10 mocks rehechos: Revenue Forecast Overview, Spain Guest Register,
     Audit Log Viewer, Compliance Exports Hub, Modules Manager
   - CTAs prominentes añadidos: "+ Nueva Reserva" en Bookings header,
     "Editar en masa" siempre visible en Rate Grid, "Continuar
     configuración" banner persistente
   - Sidebar consolidado: bloque AI de 15→3 visibles, Settings
     placeholders detrás de disclosure, Compliance separado en
     Fiscal/ESG

8. Tenant Admin Console (W26 · 11 agentes)
   - Super-Admin Console para onboarding cliente nuevo
   - Backend: tenant-admin.service.ts en
     apps/api/src/modules/admin-console/ con 6 funciones: listTenants,
     getTenantDetail, createTenant (genera tempPassword 16-char +
     inviteLink 72h), regenerateTempPassword, toggleTenantModule,
     getTenantAuditLog
   - 6 endpoints /admin/tenants/* en server.ts
   - Frontend screens (screens/admin/):
       TenantAdminConsoleScreen (lista + tabs)
       TenantDetailScreen (general/props/users/módulos/audit)
       NewTenantWizardDialog (5 pasos: Org → Property → Owner User →
         Plan+Módulos → Confirmar + muestra tempPassword + inviteLink)
       ResetPasswordConfirmDialog
       InviteUserDialog
   - Wired al sidebar bajo Admin & Developer (admin-only)

9. Demo Data Enrichment (W27 · 11 agentes)
   - packages/database/seeds/demo-pre-demo-enrichment.mjs
   - Siembra: 25 reservas next 30d × property (5 today arrivals, 3
     departures, 12 in-house, 5 future), guests con SES identity,
     folios con 3-5 cargos cada uno, 12 HK tasks today, 5 maintenance
     work orders, BAR levels 60d con DOW multiplier (weekends +20%),
     RateChangeJournal histórico, 3 grupos por property
     (corporate/wedding/conference) + 2 allotments TT.OO. (Hotelbeds +
     JTB), 6 VeriFactu sandbox submissions, RevenueDailySnapshot 30d,
     channel mappings, notifications

10. Hostinger Deploy Kit (W incremental)
    - deploy/docker-compose.production.yml (Postgres+Redis+API+
      admin-web+Caddy)
    - deploy/Dockerfile.api + Dockerfile.admin-web (multi-stage)
    - deploy/Caddyfile (HTTPS automático Let's Encrypt)
    - deploy/.env.production.example
    - deploy/scripts/bootstrap-vps.sh (prod)
    - deploy/scripts/bootstrap-dev-vps.sh (dev — instala Node 22,
      Postgres 16, Redis 7, gh, tmux, claude CLI)
    - deploy/scripts/deploy.sh (zero-downtime rolling)
    - deploy/README-HOSTINGER.md (60 min playbook)
    - deploy/README-REMOTE-DEV.md (workflow con VS Code Remote-SSH)
    - deploy/scripts/macneo-Brewfile (Brewfile para travel laptop)
    - deploy/scripts/macneo-postinstall.sh (Starship + aliases + git)
    - .github/workflows/ci.yml (guardrails + typecheck + Docker smoke)
    - .github/workflows/deploy.yml (auto-deploy on push to main)

# COMPLIANCE ES (diferenciador clave del producto)

packages/compliance/ implementa real, NO mock:
- VeriFactu (AEAT) modo sandbox · scheduler 24h · XAdES signing
- SES Hospedajes (Mossos/Guardia Civil) parte de viajeros · scheduler
  5min · campos de identidad SES en Guest (documento, nacionalidad,
  fecha nacimiento, residencia)
- TBaI foral multi-jurisdicción (Bizkaia + Gipuzkoa + Álava + Navarra)
- IGIC (Canarias)
- GDPR PII encryption en Prisma extension con ENCRYPTION_KEY 32 bytes
- ESRS (Scope 1/2/3 + agua + residuos + género)
- Norma 43 (CSB-43 importer) + Norma 19 (SEPA)
- Tasa turística multi-CCAA con calendar fiscal

# SISTEMA DE CALIDAD

Pre-commit hook activo en .husky/pre-commit:
  1. node scripts/check-discoverability.mjs (corre los 3 sub-checks)
  2. npm --workspace @hotelos/admin-web run typecheck

Sub-checks:
  - check-sidebar-coverage.mjs: para cada .tsx en
    apps/admin-web/src/screens/, verifica que está en Sidebar.tsx
    o en .discoverability-whitelist.json. Soporta alias
    "FooScreen" ↔ "Foo" bidireccional + escaneo de adminRouteScreenMap.
  - check-route-validity.mjs: verifica que cada screen target del
    sidebar está registrado en App.tsx.
  - check-placeholder-budget.mjs: cap de 80 placeholders (sidebar
    items con placeholder:true + makeModulePlaceholder en App.tsx).
    Roadmap: 75 hoy → 55 (Q3) → 35 (Q4) → 15 (Q1'27).

Estado actual (verificado hoy):
  ✓ 197 screens, 200 sidebar entries, 56 whitelisted
  ✓ 0 broken links · 75/80 placeholders bajo budget
  ✓ typecheck admin-web PASS · typecheck api PASS

# ESTADO DEL DEPLOY

Local Mac Pro (donde estamos hoy):
  - Postgres 16 corriendo (puerto 5432, instalado vía brew)
  - API corriendo en puerto 3000 (NO 4000)
  - admin-web corriendo en puerto 5173
  - 10 properties demo sembradas: Hotel Los Tilos, HotelOS Bilbao,
    HotelOS Madrid Centro, HotelOS Tenerife Sur, Iberia Barcelona
    Beach, Iberia Bilbao Cultura, Iberia Granada Histórico, Iberia
    Madrid Centro, Iberia Mallorca Resort & Spa, Iberia Marbella
    Lujo Resort

VPS Hostinger:
  - Recién reinstalado con Ubuntu 24.04 LTS
  - Acceso SSH via key del MacBook Neo (NO password)
  - Bootstrap pendiente: bash deploy/scripts/bootstrap-dev-vps.sh
  - User: cesareme (con sudo passwordless dev-only)
  - IP: [PEGAR_IP_DEL_VPS_AQUI]
  - Repo clonado en /home/cesareme/projects/hotelos/hotelos

GitHub: cesareme/hotelos PUBLIC
  - branch main protegida (recomendado)
  - CI activo en cada PR via .github/workflows/ci.yml
  - Auto-deploy en push a main via .github/workflows/deploy.yml
    (requiere secrets VPS_HOST, VPS_USER, VPS_SSH_KEY configurados)

# DEUDA TÉCNICA CONOCIDA

1. Estructura del repo con subdir extra "/hotelos/" — pendiente de
   aplanar con git mv + force push. No urgente pero feo.

2. 75 placeholders en sidebar — la mitad son módulos que aún no tienen
   UI (ESG advanced, AI agents, Marketplace, White-label). Roadmap
   trimestral en check-placeholder-budget.mjs.

3. CocoaSidebarV2 está construido pero desactivado
   (USE_SIDEBAR_V2=false en BackOfficeLayout). El catálogo V2 no tiene
   feature parity con backOfficeNavigationGroups todavía.

4. Algunos screens siguen siendo parciales (~24% del total): CRM
   campaigns avanzadas, Loyalty settings, ESG/ESRS Reporting completo,
   AI Operations (Agents/Audit/Costs), Marketplace público.

5. Endpoints faltan para algunos screens recién hechos: Compliance
   Exports Hub (POST /compliance/exports/jobs) y Modules Manager
   (PATCH /properties/:id/modules/:moduleId) — están como TODO en el
   código.

6. Test coverage es selectivo (tests/*.test.mjs node-native), no hay
   Playwright/Cypress montado, e2e tests son TODO.

# CONVENCIONES DE CÓDIGO

- Comentarios en inglés (excepto strings UI), funciones documentadas
- Imports ordenados: React/3rd → @hotelos/* → relativos
- Strings i18n están en src/content/ (i18n-ready, mayoría es-ES hoy)
- Cocoa components usan inline styles con var(--cocoa-*) tokens
- Use toArray<T>(data) para coaccionar respuestas API
- Pre-commit nunca se salta con --no-verify (consensuado)
- Commits estilo conventional commits: chore: / feat: / fix: /
  refactor: / docs:

# DOCS QUE DEBES OJEAR PRIMERO

Si no quieres leer 300+ KB, prioriza estos:
  - docs/audits/DEMO-READINESS-REPORT-2026-05-31.md (20 KB · estado)
  - docs/audits/MOCK-SCREENS-FIX-PLAN.md (12 KB · qué falta)
  - docs/cocoa-design/EXECUTIVE-SUMMARY.md (1500 palabras)
  - docs/cocoa-design/CHEAT-SHEET.md (paths + tokens)
  - docs/rate-manager/DESIGN-PROPOSAL.md (Rate Manager v2 spec)
  - docs/director-dashboard/DESIGN-PROPOSAL.md
  - deploy/README-HOSTINGER.md
  - deploy/README-REMOTE-DEV.md

# COMANDOS QUE USO MUCHO

  # Subir API + admin-web local
  cd /home/cesareme/projects/hotelos/hotelos
  npm install
  npm --workspace @hotelos/database run prisma:generate
  npm --workspace @hotelos/database run db:push
  tmux new -s dev
  # En un pane: npm --workspace @hotelos/api run dev
  # En otro: npm --workspace @hotelos/admin-web run dev
  # Ctrl-a d para detach
  # tmux attach -t dev para volver

  # Verificación full antes de commit
  bash .husky/pre-commit

  # Seed demo
  node packages/database/seeds/demo-pre-demo-enrichment.mjs

  # Workflows multi-agente (para tareas grandes)
  # — los lanzo desde Claude con la tool Workflow

# CÓMO ARRANCAMOS HOY

1. Lee docs/audits/DEMO-READINESS-REPORT-2026-05-31.md y haz un
   resumen del estado actual en 5 bullets cortos.

2. Después léete deploy/README-REMOTE-DEV.md para entender cómo
   estamos trabajando desde el Neo via SSH.

3. Verifica el árbol y dame un "estado del sistema" actual:
     - typecheck admin-web + api
     - pre-commit hook
     - servicios corriendo (psql, redis, API health)

4. A partir de ahí seguimos donde estábamos: estabilizar el demo,
   aplanar la estructura del repo, o lo que toque.

Si algo es ambiguo, pregunta. No asumas.
```

---

## Cómo se usa este resumen

### Opción A · Pegar como primer mensaje

Cuando ejecutes `claude` en el VPS por primera vez:

```bash
ssh hotelos-dev
cd ~/projects/hotelos/hotelos
claude
```

Pega el bloque entre ``` ``` (sin las comillas markdown). Claude
absorbe el contexto en 1 mensaje y empieza a responder con conocimiento
del 100% del proyecto.

### Opción B · Como archivo proyecto-wide

Una vez en Claude Code del VPS:

```
Lee deploy/CLAUDE-RESUME-CONTEXT.md y sigue lo que dice ahí.
```

Igual de efectivo, más limpio para el chat history.

### Opción C · Como CLAUDE.md (auto-load)

Renombra este archivo a `CLAUDE.md` en la raíz del repo y Claude Code
lo carga automáticamente en cada nueva sesión sin que tengas que
pegarlo. Es la convención del producto.

```bash
cp deploy/CLAUDE-RESUME-CONTEXT.md CLAUDE.md
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md auto-context for new sessions"
git push
```

A partir de ese commit, cualquier `claude` desde la raíz del repo
arranca con todo el contexto cargado de oficio.

## Mantenimiento del resumen

Cada vez que cambies algo grande:
- Métricas (LOC, screens, endpoints)
- Hitos nuevos
- Deuda técnica resuelta o nueva
- Cambio de paths críticos

…actualiza este archivo. Es el "manual del proyecto" para futuras
sesiones de Claude.
