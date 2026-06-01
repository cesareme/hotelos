# Session Log · Mayo–Junio 2026

Bitácora narrativa de la sesión de Claude Code en el MacBook Pro. Sirve
para que cualquier sesión futura (en el VPS o donde sea) entienda CÓMO
llegamos al estado actual, no solo CUÁL es el estado.

Para el estado técnico actual, ver `CLAUDE.md` y
`deploy/CLAUDE-RESUME-CONTEXT.md`. Este documento es la historia.

---

## Contexto de arranque

César (cesareme) continuó una sesión muy larga que venía de antes (la
construcción del PMS HotelOS ya estaba muy avanzada: módulo de grupos
nivel Mews, Cocoa Edition v3.0, etc.). El objetivo macro de esta tanda
de trabajo fue: pulir el producto para un demo serio con cliente, y
luego montar la infraestructura para alojarlo y desarrollarlo en remoto.

Se trabajó con orquestación multi-agente (la tool Workflow) lanzando
decenas de subagentes en paralelo para tareas grandes. En total a lo
largo del proyecto: ~27 workflows, ~403 agentes, 239 tareas cerradas.

---

## Lo que se construyó en esta sesión (orden cronológico)

### 1. Cierre de Cocoa Edition v3.0 (rediseño macOS-nativo)

Se completaron oleadas de workflows que dejaron:
- 25 componentes core + 5 extras + 8 globales + 14 guidance = 64
  componentes Cocoa
- 36 iconos SF Symbols-style, 5 illustrations SVG, EmptyState wrapper
- Flagship screens: Login, 404, 500, Onboarding Wizard, Showcase
- CocoaGlobalProvider (Command Palette ⌘K, Preferences ⌘,,
  Notifications, Shortcuts ⌘/, About)
- ~18 docs en docs/cocoa-design/

### 2. Intuitividad PMS

- Sidebar V2 con 8 grupos jerárquicos + favoritos + recientes + search
  + role filter (construido pero DESACTIVADO con USE_SIDEBAR_V2=false
  porque no tenía feature parity con el legacy)
- 14 componentes de guidance + 24 archivos de contenido tutorial
- Aplicado ScreenInstructionsCard a 10 pantallas

### 3. Bug de producción: "rows.filter is not a function"

El usuario reportó una pantalla rota (FiscalSubmissionsCenter). Causa:
el endpoint devolvía `{items:[]}` (envelope) y el código asumía array
crudo. Se creó el helper `src/utils/toArray.ts` y se aplicó
defensivamente a 20 sitios vulnerables. Fix histórico que blinda toda
la app contra envelope-vs-array drift del backend.

### 4. Crisis del sidebar (y rescate)

Al cablear CocoaSidebarV2 al shell, el usuario perdió acceso a menús
enteros (Operaciones, Admin, persona switcher). Dos bugs combinados:
(a) el catálogo V2 estaba incompleto vs el legacy, (b) el role filter
escondía TODO si el rol no matcheaba. Se resolvió:
- Fall-through defensivo en useSidebarRoleFilter
- Converter buildLegacySidebarV2Groups que alimenta el sidebar con el
  árbol legacy completo
- Finalmente ROLLBACK al Sidebar legacy original (con persona switcher
  integrado), que era lo que el usuario quería

### 5. Restaurar visibilidad del módulo Grupos

El usuario no veía toda la suite de grupos que habíamos construido.
Estaba enterrada en el subgrupo "Comercial". Se creó un subgrupo
dedicado "Grupos y eventos" en Operaciones con 8 entries + hash-link
deep-linking (#nuevo-grupo, #nuevo-evento, #importar-rooming) que
auto-abre los dialogs + CTAs prominentes en el header del dashboard.

### 6. Director Dashboard v2.0

Research de la industria (Mews, Cloudbeds, Opera, STR, HotStats) +
auditoría del estado actual + rediseño. Se construyó GeneralManager
Dashboard con layout 7-rows y 12 componentes director (KpiTile,
ForwardPaceChart, ChannelMixDonut, OpsHealthMini, VipList,
BarRecommendations, AiInsightCard, SegmentBars, PickupBar,
ComplianceWidget, CancellationRiskGauge).

### 7. Auditoría de discoverability + guardrails preventivos

El usuario pidió auditar toda la app para que el problema de "features
fantasma" (pantallas construidas pero no accesibles) no se repitiera.
Hallazgos: de 195 screens, solo 34% accesibles, 47 orphans, 12 broken
links, 23 placeholders dead-end, 8 suites enterradas. Se construyó:
- 4 scripts en scripts/: check-sidebar-coverage.mjs,
  check-route-validity.mjs, check-placeholder-budget.mjs,
  check-discoverability.mjs (meta-runner)
- apps/admin-web/.discoverability-whitelist.json
- Husky pre-commit hook (.husky/pre-commit) que corre los 3 checks +
  typecheck. Activado con core.hooksPath=.husky + script prepare.
- Docs en docs/audits/

El usuario tuvo iteraciones donde el script daba falsos orphans (por el
alias FooScreen↔Foo y por el adminRouteScreenMap dinámico). Se ajustó
la lógica del checker hasta dejar 0 orphans reales.

### 8. Rate Manager v2 estilo SiteMinder

El usuario, viendo el Channel Manager, pidió un editor de tarifas como
SiteMinder. Research (SiteMinder, Mews, Cloudbeds, IDeaS, Duetto) +
diseño + implementación:
- CocoaRateGrid (grid matricial editable: multi-select, drag, copy/paste,
  keyboard nav, F2 edit) + RateGridBulkEditDrawer (valor fijo / delta % /
  delta absoluto / copy from + restricciones MinLOS/MaxLOS/CTA/CTD/
  Closed/StopSell + channel markup overrides) + RateGridStatusBar
- RateGridEditorScreen + RateJournalScreen
- Backend: 4 endpoints (GET rate-grid, POST bulk-update, POST push,
  GET rate-journal) + modelo Prisma RateChangeJournal
- Hubo que arreglar varios errores de typecheck en el server.ts
  (colisión getRateGrid v1/v2 → alias getRateGridV2, mapeo del DTO con
  restrictions nested → campos flat, resolver default BAR rate plan)

### 9. Pre-demo readiness

Auditoría completa módulo por módulo (11 categorías). Demo readiness
score: 62 → 78/100 tras los fixes. Se generó DEMO-READINESS-REPORT y
MOCK-SCREENS-FIX-PLAN. Se rehicieron 5 mocks, se consolidó el sidebar
(AI 15→3, Settings tras disclosure, Compliance separado Fiscal/ESG), se
añadieron CTAs prominentes. Demo script de 15 min verificado.

### 10. Tenant Admin Console (onboarding cliente)

El usuario preguntó cómo crear usuario/contraseña para un cliente nuevo.
Se construyó la Super-Admin Console:
- Backend: tenant-admin.service.ts (listTenants, getTenantDetail,
  createTenant con tempPassword 16-char + inviteLink 72h,
  regenerateTempPassword, toggleTenantModule, getTenantAuditLog) +
  6 endpoints /admin/tenants/*
- Frontend: TenantAdminConsoleScreen, TenantDetailScreen,
  NewTenantWizardDialog (5 pasos), ResetPasswordConfirmDialog,
  InviteUserDialog
- Wired al sidebar bajo Admin & Developer

### 11. Demo data enrichment

Seed realista: 25 reservas/property next 30d, guests con SES identity,
folios con cargos, HK tasks, maintenance work orders, BAR levels 60d
con DOW multiplier, 3 grupos/property, 2 allotments, VeriFactu
submissions, RevenueDailySnapshot, channel mappings, notifications.
Script en packages/database/seeds/demo-pre-demo-enrichment.mjs.

### 12. Restaurar dark mode toggle

El usuario no veía el toggle de tema. Estaba renderizado pero invisible
(botón 28x28 transparente). Se rediseñó como pill con borde + label
visible (Claro/Oscuro/Auto) en BackOfficeLayout.

---

## Infraestructura · GitHub + Hostinger + Remote Dev

### GitHub

- Repo creado: cesareme/hotelos (PÚBLICO)
- Primer commit hecho. Problemas de auth: el 403 con HTTPS PAT se
  resolvió pasando a SSH key.
- IMPORTANTE: el .git quedó en la carpeta padre ("New project"), así que
  el código vive bajo un subdirectorio /hotelos/ dentro del repo. Las
  URLs raw y los paths llevan el prefijo hotelos/. Pendiente de aplanar.

### Deploy kit para Hostinger

Se creó deploy/ completo:
- docker-compose.production.yml (Postgres + Redis + API + admin-web +
  Caddy con HTTPS automático Let's Encrypt)
- Dockerfile.api + Dockerfile.admin-web (multi-stage)
- Caddyfile, .env.production.example
- scripts/bootstrap-vps.sh (producción)
- scripts/bootstrap-dev-vps.sh (dev: Node 22, Postgres 16, Redis 7, gh,
  tmux, claude CLI)
- scripts/deploy.sh (zero-downtime)
- scripts/setup-vps.sh (orquestador maestro: key + config + bootstrap +
  verify, ejecutable desde el laptop)
- README-HOSTINGER.md + README-REMOTE-DEV.md
- .github/workflows/ci.yml + deploy.yml

### MacBook Neo (portátil viajero)

Filosofía: el Mac Pro se queda en casa; el Neo es un terminal
desechable. Código en VPS + GitHub, nunca en local del Neo.
- scripts/macneo-Brewfile (Ghostty, Cursor, OrbStack, Tailscale, Raycast,
  fzf/ripgrep/eza/zoxide, lazygit, mise, Starship, 1Password, etc.)
- scripts/macneo-postinstall.sh (Starship + aliases + git config)

### Contexto para Claude en cualquier máquina

- CLAUDE.md en la raíz (auto-cargado por Claude Code)
- deploy/CLAUDE-RESUME-CONTEXT.md (resumen exhaustivo)
- docs/CLAUDE-CODE-GUIA.md (guía de comandos/modos/atajos)

---

## El via crucis del VPS (1 junio 2026)

VPS Hostinger IP 72.61.194.216 (hostname srv1720761). El usuario lo
reinstaló con Ubuntu 24.04. Problemas encadenados que resolvimos:

1. SSH key no autorizada → ssh-copy-id desde el Neo con root password.
2. tmux: "missing or unsuitable terminal: xterm-ghostty" → Ghostty manda
   un TERM que Ubuntu no conoce. Fix: export TERM=xterm-256color (o
   instalar el terminfo de Ghostty con infocmp | ssh ... tic).
3. claude: command not found → el bootstrap no llegó a instalarlo.
4. El bootstrap requería root → correr como root, no como cesareme.
5. EL GRAN PROBLEMA: el VPS "que ya tenía" traía Node/npm viejos
   mezclados con Ubuntu. npm estaba corrupto:
   "Cannot find module 'promise-retry'". Intentos de apt purge +
   reinstall NodeSource no lo arreglaban (quedaban restos en
   /usr/lib/node_modules/npm). NO usar `npm install promise-retry` dentro
   de /usr/lib/node_modules/npm — eso lo empeora (da E404 @npmcli/docs).
   SOLUCIÓN QUE FUNCIONÓ: `corepack enable && corepack prepare
   npm@10.9.0 --activate` → corepack viene dentro de node 22, descarga
   un npm fresco sin pasar por el roto. npm pasó a 10.9.7 limpio.
6. EEXIST en /usr/bin/pnpm y /usr/bin/pnpx (restos del Node viejo) →
   `rm -f` de los 4 paths + reinstalar con --force. Finalmente se
   instaló claude solo (pnpm es opcional, el proyecto usa npm).

Lección para el futuro: si un VPS trae Node preinstalado, lo más limpio
es corepack para npm, o el tarball oficial de nodejs.org (binario puro
que nunca viene corrupto). Evitar mezclar apt + NodeSource sobre un Node
existente.

---

## Estado al cierre de esta sesión

- ✅ Repo en GitHub (cesareme/hotelos, público, subdir /hotelos/)
- ✅ VPS Hostinger con Ubuntu 24.04, SSH key-only, node 22 + npm 10.9.7
  reparado, claude CLI instalado
- ⏳ Pendiente en el VPS: clonar el repo, correr el resto del bootstrap
  (Postgres, Redis si no quedaron), arrancar la app
- ✅ Mac Pro: app corriendo (Postgres 5432, API 3000, admin-web 5173,
  10 properties demo)

---

## Qué hacer al continuar en el VPS

1. Como cesareme: `cd ~/projects && git clone
   https://github.com/cesareme/hotelos.git`
2. `export TERM=xterm-256color && tmux new -s claude`
3. `cd ~/projects/hotelos/hotelos && claude`
4. Primer mensaje: "Lee CLAUDE.md y docs/SESSION-LOG-2026-05.md, dame el
   estado y sigamos."
5. Tareas candidatas: aplanar el repo (quitar subdir /hotelos),
   completar el bootstrap (verificar Postgres/Redis), levantar la app
   con npm install + prisma db push + seed, configurar VS Code
   Remote-SSH desde el Neo.

---

## Reglas de oro aprendidas

- npm corrupto en VPS → corepack, no apt reinstall.
- Ghostty + SSH → export TERM=xterm-256color.
- El pre-commit hook es sagrado: no se salta con --no-verify.
- Cada máquina su propia SSH key (revocable independiente).
- El código vive en VPS + GitHub, nunca solo en un laptop.
- tmux SIEMPRE en el VPS (SSH drops no matan el trabajo).
