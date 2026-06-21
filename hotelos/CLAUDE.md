# CLAUDE.md · Auto-context for Claude Code

Este archivo se carga automáticamente cuando arrancas `claude` desde la
raíz del repo. Sirve como "manual del proyecto" para que cualquier nueva
sesión de Claude tenga contexto completo sin que el usuario lo explique.

---

## Identidad del usuario

César (cesareme en GitHub · yakutatsa@gmail.com). Empresa: HotelOS.
Trabaja en español. Prefiere tono directo, profesional sin emojis
excesivos. Mac Pro como ÚNICA máquina (casa y viaje — el MacBook Neo se
retiró). VPS Hostinger como entorno dev remoto: el código, la BD y los
secretos viven en el VPS, así que viajar con el Pro no añade riesgo de
perder trabajo.

## Producto

HotelOS · monorepo PMS+ERP nativo español con IA. Compite con Mews,
Cloudbeds, Stayntouch — pero con compliance ES profundo de fábrica
(VeriFactu, SES Hospedajes, TBAI multi-foral, IGIC, ESRS) y agentes IA
integrados.

NOTA estructura: el código real vive bajo `/hotelos/` (subdirectorio
extra heredado del primer commit · pendiente de aplanar). Si escribes
paths para CI o referencias, recuerda el prefijo.

## Métricas (a 2026-05-31)

- 389 archivos / ~108k LOC / 202 pantallas en admin-web (React 19 + Vite)
- 202 archivos / ~72k LOC / 772 endpoints en api (Fastify + Prisma)
- 250 modelos Prisma
- 64 componentes Cocoa Edition v3.0 (estética macOS nativo)
- 27 workflows multi-agente orquestados durante el desarrollo
- 239 tareas cerradas

## Áreas funcionales

### Front-end (apps/admin-web)

- `src/screens/` — 202 pantallas organizadas por dominio (operations,
  reservations, billing, compliance, revenue, channelManager, ai,
  admin, …)
- `src/components/cocoa/` + cocoa-extras + cocoa-global + cocoa-guidance
  + cocoa-director + cocoa-rate-grid + cocoa-sidebar-v2 + cocoa-icons +
  cocoa-illustrations + cocoa-empty-state — 64 componentes del design
  system
- `src/components/v2/` — componentes legacy en transición
- `src/content/` — copy i18n-ready (mayoría es-ES hoy)
- `src/utils/toArray.ts` — helper defensive para coaccionar respuestas
  API a array tipado. Usa SIEMPRE este helper para `data` de
  `useApiData`.
- `src/navigation/Sidebar.tsx` — fuente de verdad del menú lateral

### Back-end (apps/api)

- `src/server.ts` — único entrypoint, 772 endpoints (en migración
  progresiva a módulos en `src/modules/`)
- `src/modules/` — bounded contexts ya extraídos (admin-console,
  rate-manager, audit, …)
- `src/security/route-permissions.ts` — matriz de permisos RBAC
- Schedulers integrados: SES (5min), pace (daily), allotment release
  (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue

### Compliance ES (packages/compliance/src)

- `spain/` — SES Hospedajes, parte de viajeros, VeriFactu
- `id-scan-policy.ts`, `guest-register.ts`, `invoice-policy.ts`,
  `retention-policy.ts`, `risk-matrix.ts`
- TBAI foral (Bizkaia/Gipuzkoa/Álava/Navarra) + IGIC + ESRS

### OTAs e integraciones (packages/integrations/src)

- `channel-manager.ts` — agregador unificado con interfaz común. OJO: los 5
  adapters (`booking_com_mock`, `expedia_mock`, `google_hotels_mock`,
  `direct_booking_engine`, `manual_channel`) son **MOCK** — datos sintéticos,
  sin credenciales ni mapeo de payload OTA. NO hay conexión OTA real todavía;
  `pullReservations` devuelve un huésped hardcodeado. (audit 2026-06 · #11)
- `messaging.ts` — WhatsApp Business + Email + SMS
- `bank-reconciliation.ts` — CSB-43 + SEPA Norma 19
- `einvoice.ts` + `ses-hospedajes.ts`

## Sistema de calidad (NO toques sin razón)

Pre-commit hook activo en `.husky/pre-commit`:

1. `node scripts/check-discoverability.mjs` (corre 3 sub-checks):
   - `check-sidebar-coverage.mjs` — orphan screens
   - `check-route-validity.mjs` — broken sidebar links
   - `check-placeholder-budget.mjs` — cap 80 placeholders
2. typecheck de admin-web (usa `pnpm --filter @hotelos/admin-web
   typecheck` si pnpm existe, si no cae a npm — hook agnóstico)

Estado verificado:
- 197 screens, 200 sidebar entries, 56 whitelisted
- 0 broken links · 75/80 placeholders bajo budget
- typecheck admin-web + api PASS

Whitelist: `apps/admin-web/.discoverability-whitelist.json` — screens
que intencionalmente NO están en sidebar (dialogs, drawers, drill-down
detail, sub-forms de wizards, auth, dev tools).

## Servicios en local Mac Pro

- Postgres 16 brew · puerto 5432 · DB hotelos / user hotelos / pass
  hotelos
- Redis 7 · puerto 6379
- API · puerto 3000 (NO 4000)
- admin-web Vite dev server · puerto 5173

## Servicios en VPS Hostinger (dev box)

- Ubuntu 24.04 LTS fresh
- Acceso SSH key-only (sin password) como user `cesareme`
- Bootstrap: `deploy/scripts/bootstrap-dev-vps.sh`
- Repo clonado en `/home/cesareme/projects/hotelos/hotelos`

## Comandos frecuentes

```bash
# IMPORTANTE: el proyecto usa pnpm (pnpm-lock.yaml v9 + workspace:*).
# NUNCA npm install (rompe con EUNSUPPORTEDPROTOCOL 'workspace:').

# Levantar dev
cd /home/cesareme/projects/hotelos/hotelos
pnpm install
pnpm db:generate            # prisma generate (atajo root)
pnpm db:push                # prisma db push --skip-generate (crea tablas)
tmux new -s dev
# pane 1: pnpm dev:api       (API en :3000)
# pane 2: pnpm dev:web       (admin-web en :5173)

# Seed demo data (ORDEN: base primero, luego avanzados)
cd packages/database && node --env-file=../../.env --import tsx prisma/seed.ts && cd ../..
pnpm db:seed:commercial     # añade room types, rooms, tarifas sobre prop_123

# Verificación completa antes de commit
bash .husky/pre-commit

# Discoverability check standalone
node scripts/check-discoverability.mjs
```

## Convenciones

- **Comentarios y código**: inglés. **Strings UI y commits**: español
  está bien también.
- **Commits**: conventional commits — `chore:`, `feat:`, `fix:`,
  `refactor:`, `docs:`, `chore(deploy):`, etc.
- **Pre-commit NUNCA se salta** con `--no-verify`.
- **Pre-commit hook**: si typecheck o discoverability fallan, **se
  arregla el problema, no se desactiva el check**.
- **Workflows multi-agente** para tareas grandes (>5 archivos, >2
  módulos). Para ediciones puntuales, edits inline directos.
- **Antes de cambios grandes**: lee con Read/Grep/find, sintetiza el
  plan, luego ejecuta.
- **Antes de declarar algo "hecho"**: verifica con typecheck +
  pre-commit hook + comprobación manual.

## Deuda técnica conocida

1. Estructura del repo con subdir extra `/hotelos/` — aplanar con
   `git mv` + force push. Bajo riesgo (solo cesareme tiene acceso).
2. 75 placeholders en sidebar — roadmap trimestral en
   `check-placeholder-budget.mjs`.
3. `CocoaSidebarV2` construido pero desactivado
   (`USE_SIDEBAR_V2=false` en `BackOfficeLayout.tsx`). Catálogo V2 no
   tiene feature parity con `backOfficeNavigationGroups` aún.
4. ~24% de screens son parciales (CRM campaigns, Loyalty avanzado,
   ESG/ESRS reporting completo, AI Operations Agents/Audit/Costs,
   Marketplace público).
5. Endpoints TODO: Compliance Exports Hub, Modules Manager.
6. E2E tests son TODO (Playwright no montado). Sí hay tests de integración
   reales con `app.inject` (`pnpm test:integration`, audit #8) además de los
   contract tests readFileSync.
7. **OTAs son MOCK** (audit #11): el channel manager no recibe reservas reales
   de Booking/Expedia. Para un PMS de producción hay que implementar 1 adapter
   real (Booking XML/push-pull o Channex) con credenciales + sandbox round-trip.
8. **Seguridad multi-tenant (audit 2026-06):** IDOR de escritura y rate limit
   ya cerrados; el RBAC fail-open de GET sigue por defecto — actívalo con
   `RBAC_STRICT=true` una vez mapeadas todas las rutas GET al manifiesto.
   Schedulers: en multi-réplica usar `RUN_SCHEDULERS=false` salvo en una
   instancia (evita envíos duplicados a AEAT).

## Docs prioritarios

Antes de tomar decisiones de producto, lee:

- `docs/audits/DEMO-READINESS-REPORT-2026-05-31.md` — estado del demo
- `docs/audits/MOCK-SCREENS-FIX-PLAN.md` — mocks pendientes
- `docs/cocoa-design/EXECUTIVE-SUMMARY.md` — visión Cocoa
- `docs/cocoa-design/CHEAT-SHEET.md` — paths + tokens del DS
- `docs/rate-manager/DESIGN-PROPOSAL.md` — Rate Manager v2 spec
- `docs/director-dashboard/DESIGN-PROPOSAL.md`
- `deploy/README-HOSTINGER.md` — playbook deploy producción
- `deploy/README-REMOTE-DEV.md` — workflow remoto desde el Mac Pro (cliente único)
- `deploy/CLAUDE-RESUME-CONTEXT.md` — versión larga de este archivo

## Primera tarea en cada sesión nueva

Si el usuario llega con una sesión "fresca":

1. Léete `docs/audits/DEMO-READINESS-REPORT-2026-05-31.md`.
2. Comprueba estado de servicios y guardrails.
3. Resume estado en 5 bullets.
4. Pregunta qué quiere hacer hoy.

Si el usuario llega con una tarea concreta, ve directo a ella sin
preguntar — ya tienes contexto suficiente.
