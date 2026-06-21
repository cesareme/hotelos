# REVIEW ADVERSARIAL — AUDIT-architecture.md (Ronda 2)

**Fecha:** 2026-06-21 · **Rol:** arquitecto principal, escéptico · **Base revisada:** `docs/audits/general-2026-06-round2/AUDIT-architecture.md` vs código en `/tmp/hotelos-audit/hotelos`.

## Veredicto

El audit es **sólido y honesto**. Verifiqué cada confirmación de fix y cada hallazgo crítico contra el código fuente: no encontré inflación. H1 y H2 son ciertos y bien diagnosticados. Pero el audit **subestima dos riesgos estructurales** que no son de "cableado de deploy" sino de diseño, y el score de 71 me parece **2-3 puntos optimista** por ello. Mi nota: **68/100**.

## Lo que confirmo del audit (sin objeción)

- **Fix 5 / RBAC_STRICT — real pero cosmético en producción.** `route-permissions.ts:1082` solo lanza `ForbiddenError` si `process.env.RBAC_STRICT === "true"`. El flag **no aparece en `deploy/docker-compose.production.yml`** (verificado: `grep`=0). Por tanto en producción **todo GET no mapeado sigue siendo fail-open público**. El mecanismo "mitiga" únicamente en el sentido de que existe la palanca; el riesgo real (fuga de lectura cross-tenant por una ruta GET olvidada en el manifiesto) **sigue activo en el deploy documentado**. El `console.warn` da telemetría, no defensa. Esto es honesto en el audit (H2, tabla) pero merecía severidad mayor que "RBAC strict off" en una línea: es un fail-open de lectura en multi-tenant.

- **Fix 6 / RUN_SCHEDULERS — real, mitiga duplicación, NO resuelve HA.** `scheduler-leader.ts:24` es literalmente `process.env.RUN_SCHEDULERS !== "false"`. Es un *flag manual*, no elección de líder. El propio fichero lo admite (líneas 16-19). Mitiga el riesgo de doble envío SES/VeriFactu **solo si un humano recuerda** poner `false` en las réplicas no-líder. Con default `true` y sin réplicas declaradas hoy es correcto, pero es una mitigación **operacional, no arquitectónica**: escalar a 2 réplicas sin tocar env reactiva exactamente el riesgo sancionable que pretendía cerrar. El audit lo clava (H7).

- **drift-guard — real, pero con un agujero que el audit NO menciona.** Confirmo `deploy.sh:42-54`: computa `prisma migrate diff` y bloquea ante `DROP TABLE/COLUMN`. Pero la captura es `... --script 2>/dev/null || true` (línea 43). **Si `migrate diff` falla por cualquier causa** (credenciales, contenedor, timeout, cambio de flag de Prisma), `DRIFT_SQL` queda **vacío**, el `grep` no encuentra `DROP`, y el script imprime *"Schema changes are additive or none — safe to apply"* y continúa a `db push`. Es decir: **el guardián falla-abierto**. Un drift-guard que se desactiva en silencio cuando su propia herramienta de diagnóstico falla no es una red de seguridad fiable. Esto debería ser un hallazgo propio (lo sitúo entre H4 y crítico).

- **H1 (worker ausente) — confirmado y correctamente calificado de CRÍTICO.** Servicios en el compose: `postgres, redis, api, admin-web, caddy, postgres-backup`. `grep worker`=0. Y `apps/worker/src/scheduler.ts:135-136` es el **único** lugar que programa `verifactu.retry` (`*/2`) y `webhooks.deliver` (`*/1`) vía pg-boss. Los schedulers in-process del `api` (`server.ts:6795+`) cubren SES/pace/allotment/group/mailbox pero **no** estos dos. Conclusión del audit — reintentos fiscales y webhooks **nunca corren en el deploy documentado** — es exacta y es el hallazgo más grave del informe.

- **H2 (TRUST_PROXY/RUN_SCHEDULERS no seteados)** — confirmado, `grep` en `deploy/`+`infra/`=0. El razonamiento del DoS auto-infligido (todo el tráfico colapsa a la IP de Caddy → ventana global 200/min compartida) es correcto: sin `TRUST_PROXY=1`, `server.ts:853` cae a `req.ip` = IP del contenedor Caddy. El anti-spoof no aporta nada y el rate-limit pasa de per-cliente a per-Caddy. Bien visto.

## Lo que el audit subestima — riesgo estructural residual

**1. Aislamiento de tenant sin RLS: el mayor riesgo estructural, ausente del informe.**
El audit habla de "guardas IDOR en escritura" y RBAC, pero **no analiza el modelo de aislamiento de fondo**. Lo verifiqué: **no hay Row-Level Security** — `grep` de `ROW LEVEL SECURITY`/`CREATE POLICY` en `packages/database/prisma/`=0. El cliente Prisma (`packages/database/src/client.ts`) usa `$extends` **solo para cifrado de campos PII** (líneas 17, 101), **no para scoping de tenant**. El aislamiento descansa **íntegramente** en que cada query incluya manualmente `where: { propertyId }` / `organizationId` (5270 + 1267 apariciones repartidas a mano por el código de servicios). Hay 291 `findUnique` en `modules/`. **No existe un guardián central** (`$use` middleware, extension de scoping, ni `SET app.current_property` + política RLS) que garantice que *ninguna* query escape al scope. El modelo es: "aislamiento correcto mientras cada desarrollador no olvide la cláusula `where` en ninguna de las miles de queries". Esto es un riesgo estructural de primer orden en un PMS multi-tenant fiscal: **una sola omisión = fuga cross-tenant de datos de huéspedes/facturas**, y el RBAC_STRICT off (arriba) elimina incluso la red de captura en lectura. El audit debería degradar "Seguridad multi-tenant" de 8.0; yo le pongo 6.5.

**2. SPOF total — el audit lo nombra pero lo suaviza como "single-node está bien".**
La topología es un único nodo con **Postgres, Redis, api, worker(ausente) y Caddy en una sola máquina** (la propia `CLAUDE.md` lo confirma como "Mac Pro máquina única"). No hay réplicas, no hay failover, `postgres-backup` es el único mecanismo de recuperación. Esto no es solo "HA preparada, no resuelta" (H7); es que **cada componente es un SPOF y el dato fiscal vive en un disco sin réplica**. Para un sistema sujeto a RD 933/2021 y VeriFactu, la pérdida del nodo entre backups = pérdida de submissions con deadline legal de 24h. El audit lo trata como dimensión "HA 4.5"; estructuralmente es más grave porque se combina con H1 (la cola que reintenta lo fiscal ni siquiera está desplegada).

**3. `db push` (H4) — coincido, pero el riesgo real es la combinación con el drift-guard fallable.** `db push` no transaccional + drift-guard que falla-abierto = una migración destructiva *puede* pasar si el diff falla silenciosamente. El audit puntúa los dos por separado; el riesgo compuesto es mayor que la suma.

## Sobre el score

El cálculo ponderado (66.3) es defendible; el ajuste al alza a **71** "porque cerrar es barato" es **donde discrepo**. El coste de cerrar no entra en una nota de *estado actual*: hoy, en el deploy documentado, los reintentos fiscales no corren, el RBAC de lectura es fail-open, no hay RLS y todo es SPOF. Eso es **68**, no 71. Bajaría "Seguridad multi-tenant" a 6.5 (falta de RLS + RBAC off) y añadiría el agujero del drift-guard a "Deploy" (5.0 → 4.5).

## Prioridades que añadiría a la remediación del audit

- **P0:** corregir el fail-open del drift-guard — abortar el deploy si `migrate diff` no produce salida válida, en vez de asumir "safe".
- **P1 (estructural, no en el audit):** introducir RLS en Postgres por `propertyId`/`organizationId` con `SET app.current_tenant` por request, como defensa en profundidad bajo el scoping manual. Es la única mitigación real al riesgo de omisión de `where`.
- **P1:** activar `RBAC_STRICT=true` en producción una vez completado el manifiesto de GETs — sin esto, el fix 5 no protege nada en el deploy.

**Cierre:** remediación de ronda 2 genuina; el audit es competente y honesto en lo que cubre. Mi objeción no es a sus hallazgos sino a su *encuadre*: presenta el riesgo residual como "cableado de deploy barato de cerrar", cuando bajo esa capa hay dos decisiones de diseño no resueltas — **aislamiento de tenant sin RLS y SPOF total** — que ninguna variable de entorno arregla.
