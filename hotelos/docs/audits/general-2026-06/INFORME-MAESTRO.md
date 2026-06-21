# Auditoria General HotelOS · Informe Maestro

> Consolidado CTO+CPO sobre 14 informes (5 AUDIT, 5 REVIEW adversariales, 4 MARKET + meta-review).
> Fecha: 2026-06-21 · Solo sobreviven aqui los hallazgos confirmados en la revision adversarial.

---

## Scorecard ejecutivo

| Dimension | Score primario | Veredicto del revisor | Score ajustado |
|---|---:|---|---:|
| code-backend | 58 | Auditoria correcta (82/100 de calidad) **pero se le escapo un IDOR de escritura cross-tenant tan grave como el RBAC fail-open**. El producto es peor de lo que su 58 sugiere. | **52** |
| code-frontend | 70 | Honesto y verificable. Una afirmacion falsa (chunk showcase ya aislado), `any` inflado 7x (a favor del codigo). Punto ciego real: a11y de formularios (414 inputs / 11 `htmlFor`). | **72** |
| architecture | 69 | **Generoso.** Audito el "plumbing" (CI, OTAs, Docker) y omitio los tres riesgos que deciden produccion: tenant-isolation manual sin RLS, imposibilidad de >1 replica (SPOF), `demoStore` de 3.894 LOC en el path de auth. | **58** |
| ui | 62 | Demasiado generoso. Audito los flujos de escaparate y **no toco el Room Rack ni el Night Audit** — las pantallas mas usadas y con peor manejo de estados. | **54** |
| design | 72 | Tesis **invertida**: trato Cocoa como "el sistema" cuando Aurora calido cubre 156/202 pantallas y es el host real. Un P0 (#2 tokens fantasma) es falso. | **68** |

**Score global ponderado del producto: ~58/100.** Artesania y dominio de nivel senior; production-readiness real bloqueada por seguridad multi-tenant, ausencia de HA y la cadena CI->deploy.

---

## Estado real del producto (5 bullets honestos)

1. **El dominio es excepcional; la seguridad multi-tenant no se sostiene.** Compliance ES (VeriFactu RD 1007/2023, XAdES, TBAI multi-foral, mTLS AEAT real), cifrado PII por envelope y crypto de auth son nivel senior. Pero conviven **dos agujeros de aislamiento**: RBAC fail-open en todo GET sin manifiesto, y un **IDOR de escritura** — un usuario del org A crea reservas en la propiedad del org B cambiando el path param. El "multi-tenant" que los informes acreditan solo es cierto en lecturas.

2. **La red de seguridad de tests es ~0 real.** Los 39 ficheros `.test.mjs` leen el codigo fuente con `readFileSync`+regex; **ninguno** ejercita la API (`app.inject`/`fetch`). `pms-lifecycle.test.mjs` reimplementa la logica dentro del propio test. Y el "production gate" de CI **nunca ha corrido verde**: usa `npm ci` sobre un repo que solo tiene `pnpm-lock.yaml`.

3. **No escala mas alla de una instancia.** Cinco `setInterval` (SES, pace, allotment, cutoff, mailbox) viven dentro de `server.ts`; con 2 replicas cada una dispara cada scheduler -> envios SES/VeriFactu duplicados al gobierno. El compose no define `replicas`. Es un SPOF de manual clavado a single-node.

4. **El frontend es la mejor noticia: deuda alta pero convergente.** El camino correcto ya existe (Cocoa, `States`, `useApiData`, `toArray`). El problema es de gobierno, no estructural: **dos design systems completos** (Aurora calido 156/202 vs Cocoa frio 27/202) sin decidir cual gana, 3.985 estilos inline, y el corazon operativo (Room Rack, Night Audit) **sin ningun estado de carga/error**.

5. **La distancia a un pilot serio es de semanas en plumbing, pero de meses en lo que importa.** Arreglar CI/OTAs/Docker es rapido. Retrofittear tenant-authz sobre ~954 queries + rediseñar schedulers para HA es trabajo de diseño, no de parche. Las OTAs — lo mas critico para un PMS (recibir reservas) — son **100% mock** pese a que CLAUDE.md afirma adapters reales.

---

## Top 15 acciones priorizadas

Solo hallazgos que **sobrevivieron** la revision adversarial. Ordenadas por ratio impacto/esfuerzo (esfuerzo S=dias, M=1-2 sem, L=mes+).

| # | Accion | Dimension | Severidad | Esfuerzo | Impacto |
|---|---|---|---|---|---|
| 1 | Corregir CI: `pnpm install --frozen-lockfile` (hoy `npm ci` aborta; el gate jamas corrio verde) | architecture | CRITICO | S | Muy alto |
| 2 | Cerrar IDOR escritura: validar `property/roomType/ratePlan.organizationId === ctx.org` en `createReservation` y rutas `/(properties\|reservations)/:id/*` | code-backend | CRITICO | S | Muy alto |
| 3 | RBAC fail-closed: si no hay entrada de manifiesto -> 403 (tambien GET); endurecer el contract test que hoy **fija el bug como contrato** | code-backend | CRITICO | M | Muy alto |
| 4 | Validar disponibilidad dentro de `$transaction` de reserva (lock pesimista / constraint) — el "OVERSELL FIX" solo arreglo la lectura | code-backend | CRITICO | M | Muy alto |
| 5 | Vaciar datos demo hardcodeados de `ReservationCreateScreen` (`"Ana Martinez"`, 272€) — riesgo de reserva con huesped equivocado | ui | CRITICO | S | Alto |
| 6 | Default deny en permisos: cambiar `?? demoStore.userContext.permissions` por `?? []`; gate de demo via flag positivo, no `NODE_ENV` | code-backend / architecture | ALTO | S | Alto |
| 7 | `prisma migrate deploy` con migraciones versionadas; quitar `db push` del deploy (riesgo de drop silencioso con 250 modelos) | architecture | ALTO | M | Alto |
| 8 | Suite de integracion con `app.inject()`: login, crear reserva (+oversell), cargo en folio, GET protegido sin permiso = 403 | code-backend | ALTO | M | Alto |
| 9 | Rate limiting global (def. 120/min) + `trustProxy` saneado; hoy solo 5/772 rutas limitadas, `x-forwarded-for` spoofeable | code-backend | ALTO | S | Alto |
| 10 | Estados de carga/error en Room Rack y Night Audit (hoy 0 LoadingBlock/ErrorState; pantalla en blanco si la API tarda) | ui | ALTO | M | Alto |
| 11 | Implementar 1 adapter OTA real (Booking XML/Channex) + corregir CLAUDE.md que afirma adapters inexistentes | architecture | ALTO | L | Alto |
| 12 | DECISION de direccion: declarar Aurora **o** Cocoa canonico + lint-gate que congele el legacy; sin esto la deuda de DS no para de crecer | design / ui | ALTO | M | Alto |
| 13 | Resolver schedulers para HA: leader election (pg-boss/advisory lock) en vez de 5 env-vars opt-out por replica | architecture | ALTO | L | Alto |
| 14 | A11y formularios: binding `<label htmlFor>` (414 inputs / 11 hoy) + `aria-invalid` + scroll-to-first-error en reserva | code-frontend / ui | MEDIO | M | Medio |
| 15 | Añadir 24 tokens de surfaces de estado + unificar focus ring (3 definiciones) + tints con `color-mix`; desbloquea coherencia visual | design | MEDIO | S | Medio |

---

## Posicionamiento vs mercado

**Donde esta HotelOS hoy.** El meta-revisor demuele la premisa de los 4 informes de mercado: fueron escritos como si HotelOS fuera greenfield que "debe aprender a construir" API, marketplace, webhooks, pagos y channel manager — **cuando todo eso ya existe** (`marketplace`, `oauth.service`, `webhooks.service`, `redsys.adapter`, channel manager con adapters, allotments, ERP con payroll/commissions/owner/ESRS). ~70% de las "lecciones" son redundantes. La API abierta, el marketplace y los pagos no son ventaja: son **paridad de mesa**.

**Que copiar (de verdad, los gaps reales):**
- **Mews**: tratar la API como producto versionado con sandbox publico y SLA de deprecacion — auditar **paridad UI<->API real vs parcial**, no asumir cero. Pagos: **Bizum nativo** es el unico gap de pago confirmado (Redsys/SEPA ya existen).
- **Cloudbeds**: el insight mas valioso de los cuatro — **"el onboarding es producto, no servicio"**. El churn por "no consigo configurarlo" en bajo ARPU es el riesgo real. El wizard que precarga lo fiscal-legal ("legal en España en 72h") es la mejor leccion accionable.
- **OPERA**: el motor de grupos es su lock-in. HotelOS tiene allotments — pero hay que **demostrar** que el bloque modela rooming list importable, cut-off, pickup tracking y **facturacion consolidada a un solo deudor (AR)**, no que es "ligero".
- **Apaleo/Stayntouch**: marketplace ya existe; el gap es **poblarlo** — certificar 10-15 integraciones ES (A3/Sage/Holded es el hueco real en accounting) y el check-in movil que empuja el DNI al parte SES.

**Que ignorar:**
- **NO** competir con OPERA en cadenas globales enterprise (Marriott/Accor): años de distancia, capital-intensivo. Replicar su audit-trail inmutable / segregacion de funciones es **over-engineering** para un comprador que HotelOS no ganara pronto.
- **NO** imitar el take-rate de Mews sobre GMV: el hotelero español con margenes ajustados lo percibe caro y opaco. Atacarlo, no copiarlo.
- **NO** la apertura "composable pura" de Apaleo: el cliente español tipico no tiene equipo de IT para ser integrador.

**Donde ganar — tesis del meta-revisor (literal en su esencia):**

> HotelOS es el primer PMS+ERP que trata el compliance fiscal español **no como un modulo sino como su sistema operativo**, y lo cierra en un unico bucle nativo donde cada folio, pago y comision de canal se convierte en factura VeriFactu/TBAI-foral y asiento contable conciliado, con IA encima del dato operativo-financiero-fiscal unificado.

No se compite en quien tiene la API mas abierta — eso es paridad. Se compite en lo que ningun global reescribira su core para igualar: ser el **responsable unico y garante del cumplimiento** de un grupo hotelero español (VeriFactu, TBAI en las 4 haciendas forales, IGIC, SES.Hospedajes, impuestos turisticos autonomicos, ESRS) sobre un ERP de verdad. El foso **no es una feature**: es que la regulacion española cambia cada año y HotelOS ya vive dentro de ella — es categoria de producto, casi monopolio de facto en su nicho.

**ICP recomendado (que los 4 informes no nombraron):** grupo/cadena mediana española (3-30 propiedades), ARPU sano, dolor fiscal agudo, **hoy en OPERA-via-partner o stack Frankenstein**. Es el target de migracion mas caliente y el que maximiza el foso. El negocio se gana **migrando hoteles que sufren**, no en greenfield — y nadie trazo el playbook de migracion asistida (<72h).

**Arma infravalorada por todos:** la IA no como copiloto gratis sino como **modulo de pago** sobre dato unificado — conciliacion fiscal automatica, deteccion de anomalias en libros de IVA, cierre contable asistido, prevision de tesoreria. Unico terreno donde HotelOS cobra premium *y* nadie le sigue sin el dato unificado.

---

## Quick wins (1 semana)

- **CI verde de verdad** (#1): migrar a `pnpm/action-setup` + `--frozen-lockfile`. Desbloquea que `npm run test` siquiera se ejecute.
- **Cerrar el IDOR de escritura** (#2): assert de `organizationId` en `createReservation` + barrido de rutas con id por path. Cambio acotado, severidad maxima.
- **Vaciar datos demo de la reserva** (#5): `defaultForm` a strings vacios; mover el seed tras flag. Elimina riesgo de huesped equivocado.
- **Default deny en permisos** (#6): `?? []` en vez del super-usuario demo; flag `HOTELOS_ALLOW_DEMO_AUTH` explicito.
- **Rate limiting global** (#9): `global: true` con limite por defecto y `trustProxy` correcto.
- **Tokens de estado + focus ring unico** (#15): 24 vars `--cocoa-*-bg/-border` + un solo `box-shadow` de focus. Desbloquea coherencia visual sin rediseño.
- **Corregir CLAUDE.md**: borrar el subdir `/hotelos/` inexistente, desmentir los OTA adapters, fechar metricas. Cada afirmacion falsa se propaga a decisiones futuras.

## Apuestas estructurales (1 trimestre)

- **Tenant-authz sistematico** (#2/#3 ampliados): middleware/`$extends` de Prisma que fuerce scoping por `organizationId`, o evaluar RLS. Hoy el aislamiento depende de ~954 `where` escritos a mano; un olvido = fuga cross-tenant. Es el retrofit de meses, no de parche.
- **HA real** (#13): leader election para schedulers + `apps/worker` como hogar de jobs + compose con redundancia. Sin esto no hay >1 replica ni failover.
- **Migraciones versionadas** (#7): `prisma migrate deploy` antes del primer cliente con datos reales.
- **Decision de design system** (#12): Aurora o Cocoa canonico, lint-gate, migracion por oleadas. Empezar por `<button>`->`CocoaButton` y tablas->`CocoaTable`.
- **1 OTA real** (#11): Booking via XML/Channex. Es la diferencia entre PMS y demo.
- **Demostrar el moat en la demo**: el bucle folio->pago->factura VeriFactu/TBAI->asiento->conciliacion visible en una pantalla; profundidad real de allotments (rooming list, cut-off, pickup, AR consolidado); wizard de onboarding fiscal "legal en 72h".

## Riesgos que bloquean un pilot serio

1. **Fuga cross-tenant (IDOR escritura + RBAC fail-open).** Dos clientes en la misma instancia pueden verse/escribirse datos. **Bloqueante absoluto** para cualquier multi-tenant. (#2, #3)
2. **OTAs 100% mock.** Un PMS que no recibe reservas reales de Booking/Expedia no es un PMS en produccion. `pullReservations` devuelve "Maria Lopez Garcia" hardcodeada. (#11)
3. **`db push` en deploy.** Un deploy puede dropear columnas/datos silenciosamente con 250 modelos. Sin rollback. (#7)
4. **Cero red de seguridad de tests + CI roto.** Ningun cambio esta verificado de extremo a extremo; el gate verde es decorativo. (#1, #8)
5. **SPOF / sin HA.** Single-node obligatorio; un fallo de la instancia tumba el PMS entero. Con >1 replica, envios duplicados al gobierno (sancionable). (#13)
6. **Oversell en escritura.** Dos reservas concurrentes sobre inventario lleno se confirman igual. Riesgo operativo y reputacional directo en el front desk. (#4)
7. **`demoStore` (3.894 LOC) en el path de auth de produccion** sin gate de entorno: si `userContext` llega null por cualquier ruta, se evaluan permisos contra el super-usuario demo. (#6)

**Conclusion CTO+CPO:** el producto tiene un foso de dominio real y defendible (compliance ES + ERP + IA) y una artesania de fondo que la mayoria de competidores no tiene. Pero **no es apto para un pilot multi-tenant serio hoy** por seguridad de aislamiento, ausencia de HA, integraciones OTA falsas y un gate de calidad que nunca corrio. Invertir el proximo trimestre en cerrar los 7 riesgos de arriba — empezando por los 6 quick wins de la semana 1 — convierte una base "casi" en una plataforma vendible. La inversion va a **seguridad multi-tenant + HA + 1 OTA real + demostrar el moat fiscal**, no a mas features.
