# Auditoria General R2 (post-remediacion)

> Consolidado CTO+CPO sobre 11 informes de ronda 2 (5 AUDIT, 5 REVIEW adversariales, 1 REMEDIATION-VERIFY) comparados contra el Informe Maestro de ronda 1.
> Fecha: 2026-06-21 · Scores R2 = **post-revision adversarial** (la nota que sobrevive al revisor, no la del auditor primario).

---

## Scorecard: dimension | score R1 | score R2 | delta

| Dimension | Score R1 (ajustado) | Score R2 (post-review) | Delta | Comentario del salto |
|---|---:|---:|---:|---|
| code-backend | 52 | **70** | **+18** | IDOR escritura, oversell transaccional, rate-limit global, default-deny, tests `app.inject` reales en CI. El mayor salto del producto. Lastrado por bypass de cerradura nuevo y RBAC strict OFF. |
| code-frontend | 72 | **72** | **0** | Remediacion real pero quirurgica (4 fixes en 3 pantallas). La deuda sistemica (3.985 inline styles, 0 `memo`, 3ª capa `components/v2/`) sigue intacta. |
| architecture | 58 | **68** | **+10** | CI a pnpm verde, IDOR cerrado, HA *preparada*. Pero abre brecha codigo↔deploy: el `worker` no esta en el compose y `TRUST_PROXY`/`RUN_SCHEDULERS` no se setean. |
| ui | 54 | **66** | **+12** | Front-desk Cocoa nativo, rack/night-audit con estados reales, datos demo eliminados. No sube la coherencia: reserva sigue mega-formulario, i18n mixto, 29 stubs. |
| design | 68 | **62** | **−6** | Unica nota que **baja**. El "focus ring unico" es falso a nivel de producto (3 colores), 2 controles sin foco visible (WCAG fail), decision Aurora/Cocoa documentada pero NO tomada ni cableada. |

**Score global ponderado R1 → R2: ~58 → ~67/100 (+9).**

El producto subio de forma **real y verificable**, pero desigual: el backend y la arquitectura dieron el salto; el frontend se quedo plano; el diseño retrocedio porque la ronda entrego *diagnostico* (brief + script) en vez de *gobierno* (decision + enforce), y el revisor lo penalizo por vender un "focus ring unico" inexistente.

---

## Remediacion: cuantos de los 15 fixes son REAL / PARCIAL / FALSO

Veredicto del verificador independiente (`REMEDIATION-VERIFY.md`), corroborado por los 5 audits de ronda 2:

**REAL: 13 · PARCIAL: 2 · FALSO: 0**

- **Ningun fix es falso.** Todos los cambios reclamados existen fisicamente en el arbol y hacen lo que dicen *en su ambito*. Esto es lo mas importante del veredicto: la remediacion fue de buena fe, no cosmetica, con comentarios trazables (`audit 2026-06 · #N`).
- **Los 2 PARCIAL son los que mas importan:**
  - **#1 IDOR escritura (PARCIAL por seguridad):** el guard de tenant esta bien hecho (404 para no filtrar existencia, validacion dentro de `$transaction`) pero vive **solo en `createReservation`**. `createRoom`, `patchReservation` y `assignRoom` siguen confiando en IDs de la URL sin revalidar `organizationId`. La *clase* de bug sobrevive; se tapo un endpoint, no el patron.
  - **#15 ds-drift (PARCIAL por gobierno):** el brief y el script existen y son sustantivos, pero el script **no esta cableado a husky ni CI** — es una herramienta inerte hasta que alguien la invoque a mano. La decision Aurora/Cocoa sigue en "pending".

**Matiz critico que el verificador no captura del todo, pero los audits de R2 sí:** "REAL en su ambito" no es lo mismo que "resuelto". Tres fixes REAL tienen el candado en el codigo pero **desconectado en produccion**:
- **#5 RBAC fail-closed:** REAL pero `RBAC_STRICT` OFF por defecto y ausente del compose → ~60+ GETs siguen fail-open publicos en el deploy documentado.
- **#3/#6 rate-limit + scheduler-leader:** REALES pero `TRUST_PROXY` y `RUN_SCHEDULERS` no se setean en `docker-compose.production.yml` → el rate-limit colapsa a la IP de Caddy (DoS auto-infligido) y el gate HA depende de que un humano recuerde el env.

---

## Estado real del producto (5 bullets honestos) — ¿mejoro vs R1?

1. **Sí mejoro, y de verdad: el suelo de seguridad subio.** El oversell esta cerrado con advisory lock transaccional (la forma correcta), el rate-limit es default-on y anti-spoof, el default-deny tiene candado real en `auth-context.ts`, y por primera vez existe una suite de integracion que **bootea la app** (`app.inject` + Postgres en CI) en vez de leer el codigo con regex. El CI pasa de decorativo a verde real. El backend salto de "no apto multi-tenant" a "apto para piloto vigilado". Esto es progreso genuino, no maquillaje.

2. **Pero el aislamiento multi-tenant sigue sin cerrar, solo movido un endpoint.** El IDOR se tapo en `createReservation` y reapareció el patron en sus rutas hermanas. El fondo del problema no cambio: **no hay RLS**, el aislamiento descansa en que cada una de ~6.500 clausulas `where` manuales no se olvide nunca, y el RBAC_STRICT esta OFF, lo que elimina la red de captura en lectura. Una sola omision = fuga cross-tenant de huespedes/facturas. Es deuda estructural, no un bug.

3. **Apareció un agujero NUEVO tan grave como los de R1: bypass de cerradura.** `verifyUnlock` (mobile-keys) **descarta la firma** (`void input.signature`) y devuelve `ok:true` para cualquier llave activa conocido solo el `serialNumber` — que viaja en claro en el QR. Cualquiera que lea el QR abre la puerta. Y por diseño solo se guarda `secretHash`, asi que ni siquiera es parcheable sin rediseñar el challenge-response. Esto no estaba en R1 y es CRITICO.

4. **La paradoja de la ronda: el codigo mejoro, el deploy se quedo atras.** El `worker` (unica fuente de `verifactu.retry` y `webhooks.deliver` via pg-boss) **no esta en el compose de produccion**. Consecuencia: en el despliegue documentado, una factura que falla el primer envio a la AEAT se queda en `retrying` para siempre → **incumplimiento fiscal silencioso**. Las defensas existen en el codigo y no estan cableadas en prod. Es barato de cerrar (config, horas) pero hoy bloquea go-live.

5. **El frontend/diseño no avanzaron en lo sistemico, y el diseño hasta retrocedio en honestidad.** Los fixes UI son reales pero tocan 3 pantallas; la reserva sigue siendo un formulario monopagina (76 campos, no 153 como inflo el audit), `aria-invalid` es 0/202, hay i18n mixto ingles/español en la pantalla mas critica, y conviven **dos** design systems sin decision + una tercera capa `components/v2/` huerfana. El "focus ring unico" del fix #10 es falso fuera de Cocoa (3 colores reales) y dejo 2 controles sin foco visible. La OTA sigue 100% mock (ahora honestamente etiquetada, pero sigue siendo bloqueante funcional).

---

## Top 12 acciones que quedan (solo las que sobrevivieron revision adversarial)

Ordenadas por impacto/esfuerzo. Esfuerzo: S=horas/dias, M=1-2 sem, L=mes+. Solo hallazgos que el revisor confirmo contra codigo.

| # | Accion | Origen | Severidad | Esfuerzo | Impacto |
|---|---|---|---|---|---|
| 1 | **Cablear el deploy:** añadir servicio `worker` al `docker-compose.production.yml` + setear `TRUST_PROXY=1` y `RUN_SCHEDULERS` en `api`. Sin esto, los reintentos VeriFactu no corren (incumplimiento fiscal) y el rate-limit colapsa a Caddy. | arch H1/H2 | CRITICO | S | Muy alto |
| 2 | **Arreglar `verifyUnlock`:** challenge-response real (nonce firmado HMAC) o no exponer `ok:true`. Hoy es bypass fisico de cerradura con el serial del QR. | backend H1 | CRITICO | M | Muy alto |
| 3 | **Cerrar el IDOR de verdad:** helper `assertPropertyInOrg(ctx, id)` aplicado a `createRoom`, `patchReservation`, `assignRoom` (+ validar `assignedRoomId`) + test de integracion con **dos orgs reales** (hoy solo prueba el 404 de inexistente). | verify / backend | CRITICO | M | Muy alto |
| 4 | **Fail-open del drift-guard:** abortar el deploy si `prisma migrate diff` no produce salida valida (hoy `|| true` → si el diff falla, asume "safe" y aplica). El guardian se desactiva en silencio. | arch review | ALTO | S | Alto |
| 5 | **Activar `RBAC_STRICT=true` en prod** tras completar el manifiesto de los ~60+ GET sin mapear (PII/finanzas/allotment) + test que rompa el build si un GET registrado no tiene entrada. | backend H2 | ALTO | M | Alto |
| 6 | **Idempotencia + `$transaction` en night-audit:** el re-run de un audit `failed` re-postea cargos de habitacion sin idempotencia → cargos duplicados en folio. Envolver pasos contables en una tx o hacerlos re-ejecutables. | backend review | ALTO | M | Alto |
| 7 | **Desacoplar el fallback demo de `NODE_ENV`:** exigir flag positivo `HOTELOS_ALLOW_DEMO_AUTH=true`; un `NODE_ENV` mal seteado hoy abre la API entera con super-user demo (82 permisos). | backend H3 | ALTO | S | Alto |
| 8 | **Migrar `db push` → `prisma migrate deploy`** reconciliando con la baseline ya existente; mantener el drift-guard como red. Hoy cada deploy es mutacion directa de prod sin rollback. | arch H4 | ALTO | M | Alto |
| 9 | **Cifrar `secretRef` de webhook** (hoy en claro; añadir `WebhookSubscription` a `PII_FIELDS`). Una fuga de BD permite falsificar webhooks salientes validos. | backend review | ALTO | S | Medio |
| 10 | **Tomar la decision DS y cablear el gate:** marcar Aurora canonico en `DESIGN-SYSTEM-DECISION.md`, re-apuntar tokens `--cocoa-*`, incluir `components/v2/` en la decision, y poner `check-design-system-drift.mjs --enforce` en pre-commit/CI. | design H5/H6 | ALTO | M | Alto |
| 11 | **A11y de focus + teclado:** añadir `cocoa-focus-ring` a `CocoaSwitch` y `CocoaSearchInput` (sin foco visible hoy), `tabIndex`/`onKeyDown` en filas/headers de `CocoaTable`, y `aria-invalid` en formularios (0/202). | design H2/H3, ui #2 | MEDIO | M | Medio |
| 12 | **1 adapter OTA real (Booking/Channex):** sigue 100% mock; `pullReservations` devuelve "Maria Lopez Garcia" hardcodeada. Es la diferencia entre PMS y demo para el segmento objetivo. | arch H8 | ALTO | L | Alto |

**Cayeron de la lista de R1** (resueltos y confirmados, no re-listar): CI a pnpm (#1 R1), oversell en escritura (#4 R1), datos demo en reserva (#5 R1), default-deny base (#6 R1), rate-limit global (#9 R1), estados rack/night-audit (#10 R1), scroll-to-error (#14 R1 parcial), tokens de estado/focus base (#15 R1).

---

## Riesgos que aun bloquean un pilot multi-tenant serio

1. **Aislamiento multi-tenant ad-hoc, sin RLS, con RBAC de lectura fail-open.** El IDOR se cerro en un endpoint pero sobrevive en rutas hermanas; no hay guardian central; `RBAC_STRICT` esta OFF. Dos clientes en la misma instancia pueden cruzarse datos por una `where` olvidada o un GET sin manifiesto. **Bloqueante absoluto.** (acciones #3, #5)

2. **Bypass de cerradura (`verifyUnlock`).** Riesgo fisico directo sobre huespedes: el QR abre la puerta sin verificar firma. Inaceptable en cualquier hotel real. (acción #2)

3. **Reintentos fiscales que no corren en produccion.** El `worker` ausente del compose deja `verifactu.retry` y `webhooks.deliver` sin ejecutar → facturas atascadas en `retrying`, incumplimiento de los plazos legales de la AEAT (24h). Combinado con `db push` sin rollback y drift-guard fail-open. (acciones #1, #4, #8)

4. **SPOF total + sin HA real.** Postgres, Redis, api, worker y Caddy en un solo nodo; el dato fiscal vive en un disco sin replica entre backups. El scheduler-leader es un flag manual: escalar a 2 replicas sin tocar env reactiva el envio duplicado al gobierno (sancionable). (acciones #1, futura leader-election automatica)

5. **OTAs 100% mock.** Un PMS que no recibe reservas reales de Booking/Expedia no es un PMS de produccion para el segmento objetivo. Ahora honestamente documentado, pero sigue siendo bloqueante funcional de go-live. (acción #12)

6. **Red de tests aun delgada en lo que importa.** La suite de integracion es real (gran avance) pero minima (3 casos): no cubre oversell concurrente, cargo en folio, 403 de RBAC, ni cross-tenant con dos orgs. No detectaria la regresion en las rutas IDOR no parcheadas.

---

## Veredicto

**Scorecard R1 → R2:** global **~58 → ~67** (+9). Backend +18 (52→70), arquitectura +10 (58→68), ui +12 (54→66), frontend 0 (72→72), design **−6** (68→62, la unica que baja).

**Veredicto de remediacion:** **13 REAL / 2 PARCIAL / 0 FALSO.** Remediacion genuina y de buena fe — ningun fix es humo. Pero "REAL en su ambito" oculta tres trampas: el IDOR se tapo en un solo endpoint, y tres candados de seguridad (RBAC strict, rate-limit anti-spoof, scheduler HA) existen en el codigo pero **estan desconectados en el compose de produccion**.

**Las 3 acciones top que quedan:**
1. **Cablear el deploy** (worker + `TRUST_PROXY` + `RUN_SCHEDULERS`) — sin esto los reintentos VeriFactu no corren: incumplimiento fiscal silencioso. Coste: horas.
2. **Arreglar `verifyUnlock`** — bypass fisico de cerradura nuevo, tan grave como cualquier hallazgo de R1.
3. **Cerrar el IDOR de verdad** con un helper de scoping reutilizable en todo el modulo PMS + test de dos orgs reales — la clase de bug sigue viva fuera de `createReservation`.

**Conclusion CTO+CPO:** la ronda 2 demuestra capacidad real de cierre rapido y subio el suelo del producto de forma medible. Pero **HotelOS sigue sin ser apto para un pilot multi-tenant serio hoy**, por tres clases de riesgo que la remediacion no cerro: aislamiento de tenant que depende de disciplina manual sin RLS, un bypass de cerradura nuevo, y un deploy que no ejecuta los procesos fiscales criticos. La buena noticia es que el grueso del riesgo residual restante es **operacional/de cableado y de alcance de patron** (barato de cerrar), no de diseño de fondo — salvo RLS y HA, que siguen siendo apuestas de trimestre. El foso de dominio (compliance ES + ERP + IA sobre dato unificado) intacto y sin igualar por la competencia.
