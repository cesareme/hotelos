# HotelOS — Auditoría de Arquitectura y Calidad Global

**Fecha:** 2026-06-21
**Alcance:** monorepo pnpm (17 paquetes), compliance ES, integraciones OTA, sistema de calidad, CI/CD, deploy, riesgos de producción.
**Método:** lectura directa (Grep/Read) de código y configuración, ejecución de guardrails.

---

## Resumen ejecutivo

HotelOS es un monorepo PMS+ERP maduro y sorprendentemente bien construido para su etapa. La separación `apps/` (6 servicios) vs `packages/` (11 librerías) es limpia, el grafo de dependencias es acíclico con `@hotelos/shared` como base común (8 dependientes), y la capa de compliance española es **real y de alta calidad técnica**, no un mock decorativo. El deploy (Docker + Caddy) y los scripts de backup en shell son de nivel producción.

El proyecto cojea en tres puntos concretos y arreglables: (1) **el pipeline de CI está roto** porque usa `npm ci` sobre un repo que solo tiene `pnpm-lock.yaml`; (2) **las integraciones OTA son enteramente mock** pese a que la documentación interna afirma adapters reales de Booking/Expedia/Airbnb; (3) hay **deriva entre el deploy real y lo que CI valida** (dos juegos de Dockerfiles, validación de env que solo lee el fichero de ejemplo). Ninguno es un fallo de diseño profundo; son inconsistencias de integración que dan una falsa sensación de cobertura verde.

La documentación de contexto (`CLAUDE.md`) está **desactualizada**: describe un subdirectorio `/hotelos/` que ya no existe (la estructura se aplanó) y atribuye al channel-manager adapters reales que no están implementados. Esto es un riesgo de gobernanza: las decisiones se toman sobre un mapa que no coincide con el territorio.

**Veredicto:** base sólida con honestidad técnica notable (los stubs están etiquetados como "NUNCA aceptado por AEAT"). No está production-ready hoy por la cadena CI→deploy y la ausencia de OTAs reales, pero la distancia es de semanas, no de meses.

---

## Hallazgos priorizados

### 1. [CRÍTICO] CI usa `npm ci` sin `package-lock.json` — pipeline roto
`package.json` declara `packageManager: pnpm@9.15.0` y el único lockfile es `pnpm-lock.yaml`. Sin embargo `.github/workflows/ci.yml` ejecuta `npm ci` con `cache: 'npm'` en los 6 jobs. `npm ci` **aborta** si no existe `package-lock.json`. Todo el "production gate" (build, typecheck, contract-tests, smoke, docker) falla en el primer paso o nunca ha corrido verde de verdad.
**Acción:** migrar CI a `pnpm/action-setup` + `pnpm install --frozen-lockfile`, o comprometerse a npm y generar `package-lock.json`. Decidir un gestor y ser coherente.

### 2. [CRÍTICO] Integraciones OTA 100% mock pese a documentación que afirma lo contrario
`packages/integrations/src/channel-manager.ts` solo contiene `createMockChannelAdapter`. Los providers registrados son `booking_com_mock`, `expedia_mock`, `google_hotels_mock` — el sufijo `_mock` es explícito. `pullReservations` devuelve siempre "Maria Lopez Garcia" hardcodeada. `BaseIntegrationAdapter.testConnection` devuelve `ok` siempre. `CLAUDE.md` afirma "adapters/ — Booking, Expedia, Airbnb, Hotelbeds, Vrbo": **falso**. No existe ese directorio.
Contraste: los adapters de **pagos** (Redsys con HMAC-SHA256 real, Stripe vía REST), **cerraduras** (Salto/Dormakaba/Assa) y **mensajería** (WhatsApp con verificación X-Hub-Signature-256) sí son reales con fallback a stub. La asimetría es el problema: lo más crítico para un PMS (recibir reservas) es lo único 100% falso.
**Acción:** implementar al menos un adapter OTA real (Booking XML/Channex) antes de cualquier piloto que dependa de reservas externas. Corregir `CLAUDE.md` inmediatamente.

### 3. [ALTO] `prisma db push` en producción sin historial de migraciones
`deploy/scripts/deploy.sh` paso 4 ejecuta `prisma db push --skip-generate` contra la DB viva. El propio comentario admite "no migration history committed yet". `db push` puede **dropear columnas/datos silenciosamente** ante drift de schema, sin revisión ni rollback. Con 250 modelos Prisma, el riesgo de pérdida de datos en un deploy es real.
**Acción:** adoptar `prisma migrate deploy` con migraciones versionadas en git antes del primer cliente con datos reales. Es la diferencia entre un PMS y un juguete.

### 4. [ALTO] Deriva entre lo que CI construye y lo que se despliega
Existen DOS juegos de Dockerfiles: `infra/docker/Dockerfile.*` (single-stage, bookworm, naive) y `deploy/Dockerfile.*` (multi-stage, alpine, usuario no-root, tini, prune — calidad producción). **CI construye los de `infra/`; el deploy real usa los de `deploy/`.** CI valida un artefacto que nunca se despliega. Además `deploy/Dockerfile.api` copia `package-lock.json*` (glob que no matchea nada) y hace `npm install` no determinista.
**Acción:** eliminar `infra/docker/` o convertirlo en symlink al de `deploy/`. CI debe construir exactamente el Dockerfile de producción.

### 5. [ALTO] `validate:env` solo comprueba nombres en `.env.example`, no el entorno real
El npm script `validate:env` corre sin argumentos → `validate-env.mjs` cae al default `.env.example` (fichero **commiteado**). El job de CI exporta valores dummy que el validador **ignora** porque lee el fichero, no `process.env`. Resultado: la "validación de contrato de env" nunca verifica el entorno de despliegue, solo que el fichero de ejemplo liste 18 nombres. Tampoco valida longitud/fortaleza de `JWT_SECRET`/`ENCRYPTION_KEY` ni detecta placeholders tipo `change-me`.
**Acción:** validar `process.env` en arranque del API (fail-fast) y añadir checks de longitud mínima (32 chars) y rechazo de valores placeholder conocidos.

### 6. [MEDIO] `backup:check` es un stub aunque el backup real existe
`scripts/backup-restore-check.mjs` (cableado en `npm run backup:check`) solo imprime un checklist y termina con "Status: checklist generated. Wire this to the chosen cloud backup provider before production." No ejecuta nada. **Sin embargo** `scripts/backup-postgres.sh` SÍ es real y de calidad: pg_dump custom-format, cifrado AES-256-CBC con pbkdf2, subida a S3 (Backblaze EU GDPR-ok), rotación 7/4/12, notificación webhook. El riesgo no es ausencia de backup, es la **falsa señal de verificación**: nadie ha ensayado un restore automatizado, y el sidecar `postgres-backup` del compose es independiente del script S3.
**Acción:** convertir `backup-restore-check.mjs` en un test real de restore (o eliminarlo), y unificar la estrategia: sidecar local vs script S3 son dos sistemas distintos.

### 7. [MEDIO] `/health` reporta Redis y Sentry como "ok" sin comprobarlos
`apps/api/src/server.ts` (~L889): el health-check mide latencia real de DB (bien), pero Redis se reporta `ok: true` solo por presencia de `REDIS_URL` en env — nunca hace PING. Sentry idem. El endpoint puede dar verde con Redis caído, y el deploy.sh `grep '"ok":true'` lo dará por bueno. La observabilidad de dependencias es cosmética.
**Acción:** hacer PING real a Redis en `/health` y degradar el status si falla.

### 8. [MEDIO] `CLAUDE.md` desactualizado induce a error en decisiones
Además del subdir `/hotelos/` inexistente (ya aplanado) y los OTA adapters ficticios (#2), las métricas son del 2026-05-31. Como este fichero se autocarga en cada sesión de Claude Code y se cita como "manual del proyecto", cada afirmación falsa se propaga a futuras decisiones de producto y arquitectura.
**Acción:** revisar `CLAUDE.md` contra el repo real. Borrar la nota del subdir, corregir la sección de integraciones, fechar las métricas como snapshot.

### 9. [BAJO] Protocolos de workspace mezclados (`workspace:*` vs `"0.1.0"`)
La mayoría de cross-deps usan `@hotelos/shared: "workspace:*"`, pero 2 paquetes pinean `"0.1.0"`. Con pnpm `workspace:*` resuelve al paquete local; un pin a versión puede intentar resolver del registry (no publicado) o enmascarar el enlace local. Inconsistencia menor pero fuente de bugs de install no determinista.
**Acción:** normalizar todo a `workspace:*`.

### 10. [BAJO] Ruido documental y guardrail de placeholders calibrado al alza
Coexisten `AUDITORIA.md`, `AUDITORIA-IA.md` (raíz) y 7 informes en `docs/audits/` con solapamiento. El `check-placeholder-budget.mjs` tiene BUDGET=80 con 75 usados (verificado en vivo): el guardrail funciona, pero el budget se "recalibró al alza" tras re-etiquetar pantallas. Es deuda gestionada (~24% de pantallas parciales según CLAUDE.md), no un fallo, pero el margen de 5 invita a seguir subiendo el techo en vez de bajar el contador.
**Acción:** consolidar informes obsoletos; mantener la hoja de ruta de placeholders (Q3→55, Q4→35) como gate descendente, no ascendente.

---

## Lo que está bien (no tocar)

- **Compliance ES real:** VeriFactu hash conforme a RD 1007/2023 + Orden HFP/1177/2024 (canonical key=value, cadena de huellas, offset Europe/Madrid con DST). Submitter con mTLS real (undici PKCS#12) y endpoints AEAT correctos (prewww1/www1). XAdES-EPES/-T con firma RSA-SHA256 real y TSA RFC 3161. TBAI foral (Bizkaia/Gipuzkoa/Araba) e IGIC siguen el mismo patrón. SES Hospedajes con endpoints MIR reales. Los stubs están **honestamente etiquetados** ("NEVER accepted by AEAT").
- **Aislamiento de compliance:** paquete autocontenido, sin DB, solo `node:crypto`. `dist/` correctamente NO trackeado en git.
- **Deploy de calidad:** Postgres 16 con `--data-checksums`, tuning de memoria, healthchecks; Redis AOF; Caddy con HTTPS automático, HSTS, headers de seguridad, bloqueo de paths de escaneo; Dockerfile multi-stage no-root con tini.
- **Secrets:** `.env` gitignored y NO trackeado; `.env.*` excluido con excepción `!.env.example`. Sentry real (lazy-init, degradación elegante sin DSN) en API y admin-web.
- **Sistema de calidad:** pre-commit hook con discoverability (orphan screens, broken links, budget) + typecheck; 37 ficheros de contract-test; whitelist explícita.

---

## Score de Production-Readiness

| Dimensión | Peso | Nota /10 | Comentario |
|---|---|---|---|
| Arquitectura monorepo | 15 | 8.5 | Separación limpia, grafo acíclico, protocolos mezclados (-) |
| Compliance ES | 15 | 9.0 | Real, conforme a normativa, honesto en límites |
| Integraciones | 12 | 4.5 | Pagos/cerraduras/mensajería reales; OTAs 100% mock |
| Sistema de calidad / guardrails | 12 | 8.0 | Pre-commit sólido; E2E ausente; budget al alza |
| CI/CD | 14 | 3.5 | Roto (npm ci sin lockfile); valida artefacto equivocado |
| Deploy (Docker/Caddy) | 12 | 8.0 | Producción-grade; `db push` peligroso (-) |
| Seguridad / secrets | 10 | 7.5 | Higiene buena; validación de env débil |
| Observabilidad / backups | 10 | 6.0 | Sentry real, backup shell real; health cosmético, restore no ensayado |

**Cálculo ponderado:** (8.5·15 + 9.0·15 + 4.5·12 + 8.0·12 + 3.5·14 + 8.0·12 + 7.5·10 + 6.0·10) / 100 = **69.5/100**

# PRODUCTION-READINESS: 69 / 100

**Interpretación:** arquitectura y dominio de nivel senior; la nota la hunden la cadena CI→deploy rota y la ausencia de OTAs reales. Arreglar los hallazgos 1–4 (CI, OTAs, migraciones, deriva Docker) subiría el score por encima de 85 sin tocar el diseño. La base es de fiar; lo que falla es el "plumbing" de integración y la coherencia entre documentación, CI y producción.
