# Pega esto al iniciar una nueva sesión de Claude Code

Cuando arranques `claude` en el VPS desde el Neo, pega este texto como
**primer mensaje** para que Claude tenga el contexto de qué hemos hecho:

---

```
Soy César (cesareme en GitHub). Estoy continuando un proyecto desde otra
sesión de Claude Code en mi MacBook Pro.

CONTEXTO DEL PROYECTO
=====================
HotelOS · monorepo PMS+ERP nativo español con IA. Estructura:
- apps/admin-web (React 19 + Vite + Cocoa Edition v3.0 design system)
- apps/api (Fastify + Prisma + Postgres + Redis · ~7000 LOC)
- apps/ai-gateway, apps/mobile, apps/guest-web
- packages/database (Prisma · 80+ models)
- packages/compliance (VeriFactu, SES Hospedajes, TBAI, IGIC, ESRS · ES sandbox)
- packages/integrations (OTA: Booking, Expedia, Airbnb, Hotelbeds, Vrbo)
- packages/shared, ui, ai-tools, product

Repo: https://github.com/cesareme/hotelos
Estructura: el código real vive bajo /hotelos/ (subdirectorio extra · pendiente de aplanar)

LO QUE YA ESTÁ HECHO (239 tareas, ~403 agentes orquestados)
===========================================================
1. Cocoa Edition v3.0 · 64 componentes estilo macOS nativo
2. Rate Manager v2 estilo SiteMinder (bulk edit + restrictions + push OTA)
3. Director Dashboard 7-rows con KPIs + AI insights
4. Super-Admin Tenant Console · wizard onboarding cliente en 5 pasos
5. Groups module Mews-level (NewGroupDialog 31 campos, RoomBlockGrid, RoomingList CSV)
6. Sistema de calidad pre-commit:
   - .husky/pre-commit con discoverability:check + typecheck
   - 4 scripts guardrails: sidebar-coverage, route-validity, placeholder-budget
   - .discoverability-whitelist.json con screens intencionalmente fuera del sidebar
7. Hostinger deploy kit completo (Docker Compose + Caddy HTTPS auto + CI/CD)
8. Bootstrap del VPS dev (Node 22, Postgres 16, Redis 7, gh, tmux, claude CLI)
9. 27 workflows orquestados, ~300 KB de docs en docs/

ESTADO DEL DEPLOY
=================
- VPS: Hostinger KVM X · Ubuntu 24.04 LTS · IP: [PEGAR_IP_AQUÍ]
- Acceso SSH: como user 'cesareme', key-only (no password)
- Servicios: Postgres + Redis corriendo local en VPS
- Demo data: 10 properties, ~250 reservas, BAR levels, grupos, etc.
- Admin-web :5173 + API :3000 (via tmux session "dev" si está arrancado)

LO QUE QUEDA PENDIENTE
======================
- Push a GitHub con SSH (tenía 403 con HTTPS PAT, resuelto pasando a SSH)
- Aplanar la estructura del repo (quitar el subdirectorio /hotelos/)
- Configurar VS Code Remote-SSH desde el Neo
- Cuando llegue cliente real: contratar 2º VPS KVM 4 para producción

CÓMO TRABAJAMOS
===============
- Eres directo, conciso, profesional sin ser robot
- Español por defecto
- Antes de cambios grandes, lees código relevante con Read/Grep
- Para tareas multi-fase usas Workflow con agentes en paralelo
- Verificas con pre-commit hook antes de declarar "hecho"

PRIMER PASO
===========
Léete docs/audits/DEMO-READINESS-REPORT-2026-05-31.md y dime el estado
actual del proyecto en 5 bullets. Después seguimos.
```

---

## Pasos para usar este resumen

1. Después de hacer `ssh hotelos-dev` desde el Neo:
   ```bash
   cd ~/projects/hotelos/hotelos    # ojo, doble hotelos por el subdir
   claude
   ```

2. Cuando Claude te pida que escribas el primer mensaje, pega el bloque
   de arriba (entre ``` ```).

3. Sustituye `[PEGAR_IP_AQUÍ]` por la IP real del VPS.

4. Claude leerá el contexto, mirará los docs, y continuará el trabajo
   con el mismo nivel de conocimiento que la sesión del Mac Pro.

## Bonus · si quieres más profundidad

Antes de pegar el resumen, también puedes decirle a Claude:
```
Lee primero docs/cocoa-design/CHANGELOG.md y docs/audits/MOCK-SCREENS-FIX-PLAN.md
para entender el estado de la app, después hablamos.
```

Eso le da contexto adicional sin que tenga que adivinarlo.
