# ehotelOS · workspace `hotelos/`

Monorepo pnpm de ehotelOS, PMS + ERP para grupos hoteleros españoles. `hotelos/` y el prefijo `@hotelos/` son los nombres técnicos del workspace y de los paquetes; la marca del producto es ehotelOS. La descripción del producto, las funcionalidades por dominio, la arquitectura, el estado y las limitaciones están en el [README de la raíz del repositorio](../README.md). La instalación en servidor está en [`deploy/README-INSTALL.md`](deploy/README-INSTALL.md).

## Qué hay aquí

| Carpeta | Contenido |
|---|---|
| `apps/api` | API Fastify + Prisma (58 módulos, 935 rutas con manifiesto de permisos, 20 CLI). Runtime `node --import tsx`. |
| `apps/admin-web` | Back office React + Vite (226 pantallas Cocoa 22, 9 categorías de menú). |
| `apps/worker` | Worker pg-boss sobre PostgreSQL: 4 colas (webhooks y notificaciones) con ejecuciones durables. |
| `apps/guest-web` · `apps/mobile` | Portal del huésped (React + Vite) y app Expo / React Native. Demo interna en este commit; ver el apartado 5 del README de la raíz. |
| `packages/` | `ai-core` (cliente de IA, tool runner con confirmación humana, enmascarado de datos personales), `shared` (permisos RBAC), `database` (esquema Prisma, 14 migraciones en `99dc3c3`, 15 en `main` con la Tanda L3, seeds), `compliance` (VeriFactu, TicketBAI, SES, retención), `product` (33 módulos, navegación móvil), `revenue` (agregador del cuadro histórico y previsión), `ai-tools`, `integrations`, `ui`, `config`, `onboarding`. |
| `deploy/` | Guía de instalación, scripts idempotentes, unidades systemd, Caddy y la vía Docker secundaria. |
| `docs/` | `design/` (diseños y Cocoa 22), `runbooks/`, `audits/` (informes de cierre por tanda), `compliance/`, `api-contracts.md`. |
| `docs/manual/` | Manual de uso por perfil, plan de formación, fichas y FAQ para el personal del hotel (índice en `docs/manual/README.md`; contrato `tests/manual-contract.test.mjs`). |
| `scripts/` · `tests/` | Puertas de calidad (typecheck de todos los workspaces, discoverability, árbol de navegación, migraciones ↔ esquema, contrato de entorno) y contratos raíz (`node --test tests/*.test.mjs`); `tests/integration/` necesita PostgreSQL. |
| `CLAUDE.md` | Guía de trabajo: comandos, seeds, convenciones, estado verificado por tanda y deuda técnica. |

## Arrancar en 10 pasos

Requisitos: Node 22.x (≥ 22.9, la versión de la CI, las imágenes y la guía de instalación), pnpm 9.15.0 vía corepack, PostgreSQL 16. Redis es opcional (ningún código lo exige hoy).

1. `corepack enable && corepack prepare pnpm@9.15.0 --activate`
2. `pnpm install` (nunca `npm install` ni `pnpm install --prod`: el runtime es tsx y hace falta como dependencia).
3. `cp .env.example .env`, rellena `DATABASE_URL` y `JWT_SECRET` (`openssl rand -base64 48`) y descomenta `ENCRYPTION_KEY` (base64 de 32 bytes: `openssl rand -base64 32`; opcional en desarrollo, obligatoria en producción); comprueba con `pnpm validate:env .env`.
4. `pnpm db:generate`
5. `pnpm db:migrate:deploy && pnpm db:drift:check` (el esquema solo cambia por migraciones; nunca `db push` sobre una base compartida).
6. Seed base de demo: `cd packages/database && node --env-file=../../.env --import tsx prisma/seed.ts && cd ../..`
7. Seeds comerciales y usuarios de departamento ficticios: `pnpm db:seed:commercial && pnpm db:seed:rbac-demo`, después `pnpm --filter @hotelos/api rbac:sync`.
8. `pnpm dev:api` (API en `http://localhost:3000`).
9. `pnpm dev:web` (back office en `http://localhost:5173`; `VITE_API_URL` apunta por defecto al API local).
10. Opcional: `pnpm --filter @hotelos/worker dev` (webhooks y notificaciones). El núcleo de IA (`packages/ai-core`) va dentro del API; sin `AI_PROVIDER` responde por reglas.

Los seeds solo aceptan los identificadores de demo; cualquier otro objetivo exige confirmación explícita. La credencial del usuario de demo está documentada en `deploy/README-INSTALL.md` y no debe usarse en una instalación real, que se inicializa con `POST /onboarding/bootstrap`.

## Puertas antes de un commit

```sh
pnpm typecheck:all          # 16 workspaces
pnpm test                   # contratos raíz
pnpm test:unit              # unitarios del API
pnpm discoverability:check  # menú ↔ pantallas ↔ rutas, presupuesto de placeholders
pnpm db:migrations:check    # migraciones ↔ schema.prisma sin base de datos
pnpm test:integration       # con PostgreSQL migrado
pnpm db:install:check       # instalación desde cero en una base temporal
```

El hook de pre-commit (`git config core.hooksPath .husky`) ejecuta discoverability y typecheck de todos los workspaces; no se salta con `--no-verify`. Convenciones: código y comentarios en inglés, interfaz y commits en español, conventional commits.
