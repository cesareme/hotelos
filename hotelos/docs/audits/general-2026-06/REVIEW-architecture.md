# REVIEW adversarial — AUDIT-architecture.md

**Revisor:** principal engineer / arquitecto (escéptico)
**Fecha:** 2026-06-21
**Método:** lectura directa del repo (Grep/Read) contra cada afirmación del informe.

---

## Veredicto de una línea

El informe es **honesto, bien verificado en lo que mira, y técnicamente competente**, pero **subestima el riesgo de producción** porque audita "plumbing" (CI, OTAs, Docker) y omite los tres riesgos arquitectónicos que de verdad deciden si esto aguanta un cliente real: **aislamiento multi-tenant manual sin RLS, imposibilidad de correr >1 réplica de API (SPOF + schedulers in-process), y un `demoStore` de 3.894 LOC cableado en la ruta de auth/permisos de producción.** La nota 69/100 es generosa.

---

## Hallazgos CONFIRMADOS (verificación en vivo)

- **#1 CI roto (`npm ci` sin lockfile):** confirmado al 100%. Solo existe `pnpm-lock.yaml`; `package.json` declara `pnpm@9.15.0`; los 6 jobs de `.github/workflows/ci.yml` usan `npm ci` + `cache:'npm'`. Aborta en el primer paso. Corolario que el informe no remata: `npm run test` (= `node --test tests/*.test.mjs`) **nunca corre** porque va detrás de `npm ci`. Todo el "production gate" es decorativo.
- **#2 OTAs 100% mock:** confirmado. `channel-manager.ts` solo expone `createMockChannelAdapter`; providers `booking_com_mock/expedia_mock/google_hotels_mock`; `guestName: "Maria Lopez Garcia"` hardcodeado (L170). La asimetría es real: pagos (Redsys 264 LOC con HMAC, Stripe 293), cerraduras (5 adapters), mensajería (WhatsApp con X-Hub-Signature) **sí** existen.
  **Matiz / imprecisión:** el informe afirma "No existe ese directorio [adapters/]". Falso. `packages/integrations/src/adapters/` existe con 10 subcarpetas, e incluso hay `adapters/ota/` — **vacía** (0 ficheros). Lo correcto: el directorio existe; el de OTA está vacío. Detalle menor pero el informe pierde precisión justo donde acusa a CLAUDE.md de imprecisión.
- **#3 `prisma db push` en prod:** confirmado. `deploy/scripts/deploy.sh` L42 con comentario "no migration history committed yet". Riesgo de pérdida de datos real con 250 modelos.
- **#4 Deriva Docker:** confirmado. `infra/docker/Dockerfile.*` (lo que CI construye) vs `deploy/Dockerfile.*` (lo que se despliega). Dos compose distintos.
- **#5 `validate:env` lee el fichero, no el entorno:** confirmado literal. `scripts/validate-env.mjs` L24: `process.argv[2] ?? ".env.example"` → `readFileSync`. Ignora `process.env`. Los dummies de CI no se validan jamás.
- **#7 `/health` cosmético:** confirmado. `server.ts` L911-916: Redis se reporta `ok:true` solo por presencia de `REDIS_URL`; nunca hace PING. DB sí mide latencia real (L900). **Agravante omitido:** no hay **ningún** cliente Redis en `apps/api/src` ni `apps/worker/src` (cero `createClient`/`ioredis`/`new Redis`). Redis se provisiona en compose pero no está cableado a nada — el health reporta "ok" de una dependencia que el código ni usa.
- **#8 CLAUDE.md stale:** confirmado. El subdir `/hotelos/` no existe (`ls hotelos/` → No such file). Métricas fechadas 2026-05-31.
- **#9 Mezcla `workspace:*` vs `"0.1.0"`:** confirmado. `packages/onboarding` y `packages/revenue` pinean `"0.1.0"`.
- **#6 / #10 / "lo que está bien":** spot-checked y correctos — `backup-postgres.sh` es real (pg_dump custom, AES-256-CBC, S3, rotación), `backup-restore-check.mjs` es stub, `BUDGET=80`. Compliance ES no re-auditado a fondo pero los markers (mTLS undici, XAdES, TBAI foral) están presentes.

---

## Hallazgos OMITIDOS (los serios — esto es lo que baja la nota)

1. **[CRÍTICO arquitectónico] Aislamiento multi-tenant manual, sin RLS, sin middleware.** Modelo shared-DB/shared-schema (`Organization`→`Property`, FKs `organizationId`/`propertyId`). **Cero RLS** en `schema.prisma`, **cero** `$use`/`$extends` de Prisma para scoping. El aislamiento depende de que cada una de las **954** llamadas `findMany/findFirst/findUnique` de `modules/` incluya a mano su `where:{ propertyId }`. Un solo `where` olvidado = fuga cross-tenant. Peor: muchas rutas GET toman `:propertyId` de la URL (p.ej. `/revenue/properties/:propertyId/...`) y la matriz RBAC (`route-permissions.ts`) valida **permisos** (`revenue.read`) pero **no la propiedad del tenant** — no se ve comprobación de que ese `propertyId` pertenezca a la organización del usuario. Es un IDOR / escalada horizontal de manual. Para un PMS multi-propiedad esto es **el** riesgo número uno, y el informe le da 8.5 a arquitectura y 7.5 a seguridad sin mencionarlo.

2. **[CRÍTICO arquitectónico] No escala a >1 réplica: SPOF + schedulers in-process.** Cinco `setInterval` viven dentro de `server.ts` (SES L6784, pace L6806, allotment L6845, group-cutoff L6871, mailbox L6881). Con 2 réplicas de API, **cada réplica dispara cada scheduler** → submissions SES duplicadas al gobierno (RD 933/2021), snapshots de pace duplicados. Mitigación existente: flags `*_SCHEDULER_DISABLED` por scheduler — pero es opt-out vía 5 env vars distintas en N-1 réplicas, **no** leader election. Existe `apps/worker` y se menciona pg-boss ("when team adopts… move to worker"), pero hoy conviven. Resultado: la app está **clavada a una sola instancia de API**. El compose de producción no tiene `replicas`/`deploy:` y corre Postgres+Redis+API en un contenedor cada uno: **cero redundancia, SPOF de libro**. El informe llama al deploy "producción-grade" (8.0) sin notar que no admite HA.

3. **[ALTO] `demoStore` (3.894 LOC) en la ruta de auth/permisos de producción.** Segundo fichero más grande del repo, `export const demoStore` (L1709) **sin gate de entorno**, importado en `auth.service.ts` y usado como fallback de permisos y propiedad: `Set([...prismaPerms, ...demoStore.userContext.permissions])` (L57), `assignment?.propertyId ?? demoStore.userContext.propertyId` (L67, L184). Un store en memoria mezclando permisos en el path de autorización es un riesgo de seguridad y de corrección. El informe no lo menciona ni una vez.

4. **[MEDIO] `server.ts` 6.889 LOC como riesgo, no solo "en migración".** El informe lo cita de pasada. Un único entrypoint de ~7k LOC con 772 endpoints es un blast-radius enorme: cualquier cambio recompila/recarga todo, el arranque registra in-line ~50 módulos, y los schedulers viven aquí. La extracción a `modules/` está a medias (50+ módulos extraídos, pero el router sigue monolítico). Merece su propia fila en el score.

5. **[MENOR] Sin rate limiting / backpressure visibles** en el server para endpoints públicos (`/auth/login`, `/onboarding/bootstrap`), y schedulers sin jitter. No es bloqueante pero es deuda operativa que el informe no toca.

---

## REFUTADO / matizado

- **"adapters/ no existe":** refutado — existe; lo vacío es `adapters/ota/`.
- **Tono "distancia de semanas, no meses":** discutible. Arreglar CI/OTAs/Docker es de semanas; **RLS/tenant-authz retrofit sobre 954 queries y rediseño de schedulers para HA es de meses** y toca diseño, no plumbing. El informe afirma que arreglar #1-#4 sube a >85 "sin tocar el diseño" — eso es exactamente el punto ciego: sube la nota *de lo que el informe mide*, dejando intactos los riesgos que no midió.

---

## Score recalibrado

El 69 del informe es defendible **para su alcance**. Penalizando los tres omitidos:

- Arquitectura monorepo 8.5 → **6.0** (grafo limpio, pero tenant-isolation manual y monolito server.ts).
- Seguridad 7.5 → **5.5** (RBAC sin tenant-authz = IDOR potencial; demoStore en auth).
- Deploy 8.0 → **6.5** (calidad de imagen real, pero SPOF y sin HA por diseño).

**VEREDICTO: 58 / 100.** Dominio (compliance ES) y artesanía de nivel senior; **no production-ready** para multi-tenant real hasta cerrar aislamiento de tenant, modelo de HA/schedulers y la cadena CI→deploy. El informe original es un buen *code-quality audit*; le falta el sombrero de *arquitecto de producción*.
