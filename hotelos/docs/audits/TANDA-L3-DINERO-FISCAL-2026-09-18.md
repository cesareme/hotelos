# Tanda L3 · Dinero y fiscal — informe de cierre (2026-09-18)

**Encargo:** fila L3 del plan `docs/audits/TANDA-5-PLAN-2026-09-15.md` (§3) — precio de reserva desde tarifa al crear e importar, políticas de cancelación (seed, preview y cierre de folio al cancelar / no-show), `taxCategory` inferida, asientos de factura y rectificativa cotejados con el Modelo 303, `GET /invoices/:id/pdf`, «Cobrar» y «Añadir cargo» reales en el Centro de facturación con buscador, `?status` en TPV y cierre de caja persistido — con los criterios §4 (crear reserva con precio, cobrar en ≤ 3 clics, factura con PDF, 303 = Σ facturas + libros de Sage sin doble cómputo, cancelación con penalización según política). Reconocimiento de partida: `scratchpad/tandaL3-recon.md` (18 puntos de decisión §6). Base: HEAD `99dc3c3` (Tanda L2 commiteada). Working tree SIN commit al cierre: **68 ficheros modificados + 16 sin seguimiento** (incluidos `CLAUDE.md`, los dos runbooks, el inventario Cocoa regenerado y este informe); una parte de ese árbol NO es de L3 sino de la carga real de Sage 200 que corre en paralelo sobre esta BD (`apps/api/src/modules/accounting/import/**`, `apps/api/src/scripts/import-sage200.ts` y su test, `docs/design/FINANZAS-IMPORTACION-SAGE200.md`, `docs/runbooks/finanzas-importacion-sage200.md`, `pnpm-lock.yaml` +52 líneas): el commit de la tanda debe atribuirlos a su dueño y no arrastrar el lockfile sin revisar (deuda L2 §10.7).

El API `:3000` **no se ha reiniciado**: no había ningún proceso escuchando ni antes (22:49) ni al cerrar (23:1x); lo arranca el orquestador con este código. El flujo real por HTTP se hizo en una instancia propia `:3903` (dos procesos, A y B, ambos cerrados; `lsof -iTCP:3903` → 0 al terminar). La carga de Sage no escribió durante la tanda (`ledger_imports` 34, último lote 2026-09-17 15:10:54; `sage200_*` 4.421 asientos / 2.918 filas de libro, idénticos al principio y al final).

## 1. Lotes

| Lote | Alcance ejecutado | Dónde (líneas del árbol al cierre) |
|---|---|---|
| L3-S · esquema | Migración `20260918150000_dinero_fiscal` (aditiva: `cancellation_policies.is_default` BOOLEAN NOT NULL DEFAULT false + índice `(property_id, is_default)`; `reservations.price_source` TEXT nullable: `rate_plan \| partial \| none \| manual \| file \| quoted`, NULL = fila heredada); sin backfill de `folio_lines.tax_category` (decisión §6.8). Unión `FolioLineRecord.type` ampliada con `cancellation_fee` / `no_show_fee`. | `packages/database/prisma/migrations/20260918150000_dinero_fiscal/migration.sql`, `schema.prisma` (+17), `lib/demo-store.ts`, `schemas/reservations.schemas.ts` (+16) |
| L3-A · precio al crear | `createReservation` cotiza con `quoteReservationTotal` (plan pedido → BAR → precio publicado más bajo) cuando no llega `totalAmount`; persiste `priceSource` y devuelve `pricing { source, nights, nightsWithoutRate, ratePlanId, warning }`; `quoteAvailability` alineado con el mismo cotizador (`quotedRatePlanId`, `ratePlanSwitched`; el relleno 136 € solo cubre noches sin precio en ningún plan); `PATCH` con `totalAmount` escribe `manual`; importador T7 pasa `quoted` / `none`; reservas por correo cotizan. Formulario «Nueva reserva» con planes reales (`GET /rate-plans`), quote con tipo/plan, política por defecto (`isDefault`) y avisos honestos. | `modules/pms/pms.service.ts` (2.805 l.), `pms/room-charge.service.ts` (332), `integrations/email/email-reservation.service.ts`, `pms/reservation-import.service.ts`, `screens/reservations/ReservationCreateScreen.tsx` (1.290), `services/pmsCommerceApi.ts`; tests `pms/__tests__/reservation-price.test.mts`, `tests/integration/l3-precio-reserva.test.mts` (274) |
| L3-B · cancelación, penalización y folio | Orquestador nuevo `reservation-lifecycle.service.ts` (384 l.): guarda de estado (solo `draft` / `confirmed` transicionan; 409 `RESERVATION_NOT_ACTIVE`), transición condicional sobre el estado vivo (`TRANSITION_SOURCE_STATUSES` + `updateMany`), penalización idempotente por (reserva, modo) como línea `cancellation_fee` / `no_show_fee` `not_subject` en el folio abierto de la reserva, cierre de folio solo con cargos facturados (`pendingInvoice`), renuncia por tramos del descuento de reserva (`APPROVAL_REQUIRED` antes de escribir, PIN vía `supervisorAuthorizationId`), no-show automático del cierre del día por la misma vía, ventana a las 14:00 hora del hotel, política por defecto por centro (`isDefault`, una sola en transacción), rutas heredadas `/apply-*-fee` como reparación (409 `RESERVATION_STATUS_MISMATCH`), preflight que separa los folios de canceladas / no-show. Seed ejecutado en Faranda: **24 políticas** (FLEX* 24 h primera noche · SEMI 72 h primera noche · NREF 0 h toda la estancia × 8 centros; * = default). | `modules/cancellation-policy/{reservation-lifecycle,cancellation-policy}.service.ts` (384 / 471), `server.ts` (+30 / −10: handlers de `/cancel` y `/no-show`), `schemas/reservations.schemas.ts`, `night-audit/{night-audit,night-audit-preflight}.service.ts`, `packages/database/prisma/seed-cancellation-policies.ts`, `services/cancellationApi.ts`, `screens/admin/CancellationPoliciesScreen.tsx`; tests `cancellation-policy/__tests__/{cancellation-charge,reservation-lifecycle-guards}.test.mts`, `schemas/__tests__/reservation-lifecycle-schemas.test.mts`, `tests/integration/l3-cancelacion.test.mts` (517); runbook `accesos-por-departamento.md` §4.1 |
| L3-T · `taxCategory` inferida | `postFolioLine` persiste `categoryForLineType(type)` cuando no hay override y valida la compatibilidad (`compatibleTaxCategories`: room → accommodation; minibar / restaurant → food_beverage \| general_services; city_tax → tourist_tax; penalizaciones → not_subject \| accommodation; genéricos → cualquier sujeta) con 400 «incompatible con el tipo de cargo»; tasa turística y seeds con categoría explícita. Las 30 líneas NULL de Faranda no se rellenan (§6.8). | `modules/folio/folio.service.ts` (1.457), `tourist-tax/tourist-tax.service.ts`, `seeds/chain-reservations.ts`, `components/billing/charge-types.ts` (espejo en el front); tests `folio/__tests__/{folio-tax-inference,folios-schemas-strict}.test.mts`, `tests/integration/payments-tenancy.test.mts` |
| L3-C/D · 303 desde libros | Convención única de `sourceId` (`#anulacion` / `#sustituida`; la `:anulacion` heredada se purga en el rebuild), `deriveVatBookRows` genera las contrafilas `#sustituida`, el 303 deriva en memoria las que faltan (aviso con la cuota, DS-06), cotejo con el diario que excluye y nombra `pms_shadow_revenue` y los asientos de liquidación de Sage (patrón 4750/4700 junto a 477/472), topes explícitos; `invoice.service.ts` escribe las filas de emisión / anulación / sustitución con `invoiceSourceType` (FC-7). Test factura ↔ 303 en tenant aislado por servicio (emitir, anular, rectificar «S», rebuild idéntico fila a fila, purga de `:anulacion`). | `modules/accounting/{vat-books,modelo-303}.service.ts` (1.447 / 703), `invoicing/vat-book.ts`, `invoicing/invoice.service.ts` (3.367); tests `accounting/__tests__/{modelo-303,vat-books}.test.mts`, `tests/integration/{l3-factura-303 (260),fiscal-models}.test.mts`; runbook `finanzas-contabilidad.md` §11.1 |
| L3-E · PDF y documentación | Facturas heredadas sin `tax_breakdown_json` (14/25 de Faranda) imprimen el desglose reconstruido desde sus líneas (`breakdownSource: snapshot \| stored \| lines`), «IVA 0 %» sin «(exento)» para S1; permiso de `send-email` documentado (§6.11 abierta); `openapi.yaml` con `/invoices/{id}/pdf`, `/fiscal/*`, `/pos/*`, cancel / no-show, `/folios/{id}/close` (409 `FOLIO_UNINVOICED_LINES`), `/availability/quote` (23 operaciones a mano; YAML válido, 607 paths); `api-contracts.md` §TPV / Invoicing / cancel y convención de listas §6.12. | `invoicing/{invoice-pdf,invoice-email}.service.ts` (511 / —), `apps/api/docs/openapi.yaml` (23.859 l.), `docs/api-contracts.md` (512); test `invoicing/__tests__/invoice-pdf.test.mts` |
| L3-F1 · centro de facturación y ficha | Buscador de reserva `q` + cursor (`billingSearch.ts`), «Añadir cargo» con categoría fiscal compatible en dos filas, `supervisorAuthorizationId` al anular y al renunciar (PIN sobre el 409), «Cobrar» desde la ficha, diálogos de cancelar / no-show con preview y motivo obligatorio (también en el cronograma), badge de categoría en el folio. | `screens/billing/{BillingCenterScreen (1.625),FolioDetailScreen}.tsx`, `screens/billing/billingSearch.ts` (116, nuevo), `screens/reservations/ReservationWorkspaceScreen.tsx` (1.015), `screens/timeline/LiveTimelineWorkspace.tsx`, `content/screen-instructions/billing.ts`; tests `screens/billing/__tests__/{billing-search,billing-wiring}.test.mts`, `components/billing/__tests__/charge-types.test.mts` |
| L3-F2 · quick check-out | «Cobrar X y cerrar» ya no envía `status` a `POST /folios/:id/payments` (era 400 `.strict()`); cuerpo tipado en `quickCheckoutPayment.ts`; aviso «folio saldado y abierto: emite la factura». | `screens/operations/QuickCheckOutDrawer.tsx` (601), `screens/operations/quickCheckoutPayment.ts` (nuevo) + `__tests__/quick-checkout-payment.test.mts` |
| L3-P1 · TPV honesto | `PosCashSummary` completo (`unsettled`, `openTickets`, `unplaceable`, `degraded`, `timeZoneSource`), panel con ámbito reactivo y serie real. | `services/posApi.ts`, `screens/operations/PosDashboard.tsx` (754), `screens/operations/posSummaryView.ts` (nuevo) + `__tests__/pos-dashboard-summary.test.mts` |
| Corrector · ronda 1 | 21 hallazgos (§4) más dos arreglos de la puerta 9 (`ledger-import-routes` cuenta solo `sage200%`; `financial-statements/source.ts` lee sobre un snapshot `REPEATABLE READ`). | ver §4 |
| Integrador (este informe) | Copia previa, flujo real por HTTP en `:3903` como usuarios de T8a, limpieza, puertas completas, invariantes, `CLAUDE.md`, runbooks §11.1 / §4.1, inventario Cocoa regenerado. | §2, §3, §5, §6, §7 |

Navegación: ningún lote dejó pantallas ni pestañas nuevas (los ficheros nuevos del front son helpers y tests), así que `~/anfitorio-demo/pilots/tanda5-nav-tree.csv`, `App.tsx`, `routes` y `Sidebar.tsx` no se tocan; `build-nav-tree --check` al día (68 ítems · 101 pestañas · 205 rutas legacy). RBAC: ninguna ruta nueva (todas existían); `security/route-permissions.ts` sin cambios; el catálogo sigue en 250 claves / 24 plantillas.

## 2. Copias de seguridad y proceso

- Copia previa del integrador **`~/anfitorio-demo/backups/hotelos-pre-l3-20260918-224133.dump`** (`pg_dump -Fc`, 17,9 MB, 285 `TABLE DATA`, 22:41:33) antes de la primera escritura por API. La migración de la tanda se había aplicado antes, a las 20:13:35 (`_prisma_migrations` checksum `03fc53dfdd…`), con copia anterior `hotelos-pre-sage-real-20260918-193223.dump` (19:32, previa a la migración y a la carga real de Sage).
- Migraciones **15/15** (`db:migrate:status` «Database schema is up to date!», última `20260918150000_dinero_fiscal`) y `db:drift:check` «No difference detected», medidos a las 22:4x y repetidos a las 23:1x tras la limpieza.
- Instancia propia `PORT=3903 RUN_SCHEDULERS=false RBAC_STRICT=true node --import tsx src/server.ts` con el `.env` local (Postgres ok, Redis ok, VeriFactu `mode=sandbox`): proceso **A** (pid 57621, 22:49) recibe las escrituras → se mata → proceso **B** (pid 61334, 22:57, arriba en 2 s) sirve las relecturas, el cierre y la aprobación del arqueo y el 303 tras la limpieza → se mata (23:1x). Sesiones reales `POST /auth/login` de Carmen (`direccion@farandariasaltas.es`, owner + general_manager), `recepcion.rias` (receptionist · RA), `direccion.rias` (manager · RA) y `contabilidad` (accountant · sociedad), todas `@faranda.test` con la contraseña única de demo de T8a. Guiones: `scratchpad/l3.sh` (curl con token + `x-property-id`), `l3-login.sh`, `l3-cleanup.sql`; respuestas en `scratchpad/l3-*.json` y PDF en `scratchpad/l3-*.pdf`.

## 3. Puertas (integrador, 2026-09-18 23:0x-23:1x, tras la limpieza de §6)

| Puerta | Resultado | Puerta esperada (brief, HEAD 99dc3c3) |
|---|---|---|
| `corepack pnpm run typecheck:all` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** (apps/guest-web, explícito) · 20,9 s | 15/15 + 1 skip |
| `corepack pnpm --filter @hotelos/api test` | **2.302 tests · 2.301 pass · 0 fail · 1 skipped** · 697 suites · 11,8 s | 2.243/2.244 (+58 tests nuevos: precio, lifecycle, guards, esquemas, folio-tax, 303, vat-books, pdf, fiscal-series) |
| `corepack pnpm --filter @hotelos/worker test` | **20/20** · 3 suites | 20/20 |
| Front (`cd apps/admin-web && node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/**/__tests__/*.test.mts"`) | **1.276/1.276** · 370 suites · 2,3 s | 1.219 (+57: billing-search, billing-wiring, charge-types, quick-checkout, pos-dashboard-summary…) |
| `node --test tests/*.test.mjs` (contratos raíz) | **532/532** · 112 suites · 2,0 s | 532/532 |
| Integración completa (`cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/*.test.mts"`, **49 ficheros**) | **661 tests · 654 pass · 0 fail · 0 cancelados · 7 skipped** · 156 suites · 35,2 s (máquina cargada; 15,0 s en la puerta del corrector) · 0 «too many clients» · 0 organizaciones residuales | 626/633 (+28: l3-precio-reserva 6, l3-cancelacion, l3-factura-303, ajustes) |
| Skips conocidos (7) | H2 folio `taxCategory` sin folio abierto · check-out 403 `pms.checkin.execute` · 4 × `INTEGRATION_RECEPTION_EMAIL` · 1 × `INTEGRATION_FNB_EMAIL` | los mismos 7 |
| `node scripts/check-discoverability.mjs` | OK · 226 pantallas · 192/192 URLs · 24 alias · 0 enlaces rotos · placeholders 16/20 | 192/192 |
| `node scripts/build-nav-tree.mjs --check` | al día (68 ítems · 101 pestañas · 205 rutas legacy) | al día |
| `node scripts/check-route-access.mjs` | OK: 15 tokens × 192 URLs (admin 68 ítems / 101 pestañas) | OK |
| Cocoa 22: `cocoa-22-inventory.mjs` + `cocoa-22-waves.mjs --write` + `tests/cocoa-22-contract.test.mjs` | 226 pantallas · 94.191 líneas · 193 puntos · **inlineStyles 679 = techo (no lo supera)** · colourLiterals 0 · boClasses 0 · rawButtons 0 · waves 0 pendientes · contrato **18/18** (regla 15 «inventario al día» incluida; `COCOA-22-MIGRACION.md` §6 solo cambia la cifra de líneas 93.251 → 94.191) | 18/18, techo 679 |
| `corepack pnpm --filter @hotelos/admin-web build` | OK · 2,60 s · `BillingCenterScreen` 44,68 kB · chunk mayor `screens-operations-rest` 625,66 kB (gzip 159,77) · 2 avisos «Circular chunk» preexistentes (config de chunks sin tocar) | OK |
| `db:migrate:status` / `db:drift:check` | 15/15 al día · «No difference detected» | 14 → 15, drift 0 |
| `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run` | 250 claves (249 org + 1 plataforma) · +0 · 0 descripciones · 0 stale · 46 roles de plantilla · 0 topped up · plantilla v2 · 0 behind · 24 plantillas · 163 ms — ejecutado SIN solapar con la integración (el primer intento del corrector, solapado con la puerta 9, cayó con «Rol no encontrado» porque 26 suites borran organizaciones; no es un defecto del árbol) | +0 |
| Invariantes de Faranda (§7) | idénticas a la línea base antes de escribir, tras la limpieza y tras la integración | 25 · 33 · 110 · 250/24/31 |

## 4. Hallazgos y correcciones

### 4.1 Ronda de corrección 1 (corrector, sobre los nueve lotes; todo por `app.inject`, Faranda intacta)

| Id | Sev. | Hallazgo | Corrección (fichero) | Pina |
|---|---|---|---|---|
| DS-01 / FC-1 | alta | Dos cancelaciones (o cancel + no-show) concurrentes apilaban dos penalizaciones | Guarda de estado en `reservation-lifecycle.service.ts` (409 `RESERVATION_NOT_ACTIVE` si status ∉ {draft, confirmed}) y transición condicional en `pms.service.ts` (`TRANSITION_SOURCE_STATUSES` + `updateMany` sobre el estado vivo: dos llamadas solo cambian una fila); `chargeToFolio` idempotente por (reserva, modo) vía `findPostedPenaltyLine` | `l3-cancelacion` «cancelar dos veces y luego no-show» → 409, UNA línea de 150 € |
| DS-02 | alta | La renuncia a la penalización se autorizaba con la sola clave de recepción | Renuncia = descuento del 100 % del importe renunciado por tramos del descuento de reserva (`penaltyWaiverBand`, `assertPenaltyWaiverAuthorized`): ≤ T1 (≤ 50 € y ≤ 10 %) con `pms.reservation.discount` + motivo; ≤ 25 % motor `assertApprovedOrAuthorized` kind `discount` (solicitud, override propio, PIN vía `supervisorAuthorizationId` nuevo en `CancelReservationSchema` / `NoShowReservationSchema`); por encima solo solicitud aprobada; 409 `APPROVAL_REQUIRED` antes de escribir; respuesta y auditoría con `waiver { band, pct, tier, authorization }`; front con `SupervisorPinDialog` sobre el 409 | recepción 150/150 → 409 (T2, 0 solicitudes); dirección general → 200 `above` / `implicit` + `APPROVAL_DECIDED`; 20 € de 300 → T1 |
| DS-03 | media | Rutas heredadas `/apply-*-fee` cargaban sobre cualquier estado y podían abrir folio secundario | `applyPenaltyFee` exige `cancelled` / `no_show` (409 `RESERVATION_STATUS_MISMATCH { status, expected }`), idempotente (`alreadyApplied`), nunca abre folio secundario | confirmada → 409 ×2; no_show → `alreadyApplied` con la misma línea |
| FC-2 | media | El folio se cerraba con cargos sin facturar | `folioUninvoicedCharges` + `closeFolio({ requireInvoiced })` (409 `FOLIO_UNINVOICED_LINES { lines, total }`) en la ruta y en el motor; `settleFolios` deja el folio saldado abierto con `pendingInvoice: true`; check-out y sincronización OPERA conservan el cierre heredado (decisión para César); toast en el front | cobro → close 409 → F2 + issue → asiento D 4300 / H 705.3 sin 477 → close 200 |
| FC-4 / DS-08 | media / baja | Cualquier categoría fiscal se aceptaba para cualquier tipo de cargo | `compatibleTaxCategories` + `validateFolioLineTaxCategory` (400 «incompatible con el tipo de cargo») y espejo `compatibleTaxCategoriesForType` en `charge-types.ts` usado por los dos «Añadir cargo» | `folio-tax-inference` 14/14, `fiscal-series`, `charge-types` |
| FUX-01 | media | El formulario elegía como política por defecto la primera activa y casteaba `isDefault` | `defaultPolicyCode` solo `isDefault`, `policyHelp` con los tres textos, tipo ya trae `isDefault` | `billing-wiring` |
| FUX-02 | media | Dos cotizadores divergentes (A con relleno 136 €) | `quoteAvailability` cotiza noche a noche con `quoteReservationTotal` y responde `quotedRatePlanId` / `ratePlanSwitched`; el relleno solo cubre noches sin precio en ningún plan; tarjeta y callout dicen «el plan elegido no publica precio: se usa la tarifa BAR» | integrador §5.1 |
| FUX-03 | media | `openapi.yaml` sin cancel / no-show, `mode`, rutas heredadas, close 409, quote | Documentado; YAML validado con js-yaml (607 paths); `brand-contract` OK | contratos raíz |
| DS-05 / FC-6 | baja | El importador persistía `file` para filas cotizadas | `buildCreateReservationInput` pasa `quoted` / `none` | `l3-precio-reserva` (6) |
| DS-06 | baja | El 303 vivo de Faranda arrastraba +4,55 (FAC-2026-000018 sustituida sin `#sustituida`) | `supersededRowsInMemory` deriva en memoria las contrafilas que faltan y avisa «derivadas en memoria… ejecuta rebuild»; el 303 Q3 pasa de 239.499,58 a 239.495,03 sin tocar la BD | integrador §5.6; sondas `structure-e2e:1031`, `structure-l5:808` |
| DS-07 | baja | Cargo y cierre fuera de transacción | Transición atómica + penalización idempotente; ruta heredada como reparación explícita (documentado) | — |
| FC-5 | baja | El PDF imprimía «IVA 0 % (exento)» para S1 al 0 % | `rateLabel` sin «(exento)»; aserción negativa en `invoice-pdf.test.mts` | unitario |
| FC-7 | baja | `invoice.service.ts` escribía `sourceType` distinto del rebuild | `invoiceSourceType` (rectification / simplified / invoice) en emisión (:2206), anulación (:2500) y `#sustituida` (:3072) | `l3-factura-303`, `fiscal-models`, `accounting-ledger` 41/41 |
| FUX-04 … FUX-07 | baja | Callout de anulación remitía a una solicitud inexistente; motivo no obligatorio en el cronograma; «Añadir cargo» en una fila; sin test de cableado | Corregidos (`BillingCenterScreen.tsx:1595`, `LiveTimelineWorkspace.tsx`, dos filas 3 + 2 sin `style={}`); nuevo `billing-wiring.test.mts` (14 pines) | front 1.276 |
| Puerta 9 | — | `ledger-import-routes` oscilaba (63 vs 57) y `structure-l5` fallaba `reconciliation.ok` con un asiento concurrente | Invariante `org123Entries` solo `sage200%`; `buildPrismaFinancialStatementsSource` + `withFinancialStatementsSnapshot` (REPEATABLE READ) en `financial-statements/source.ts` y `pnl-by-property.service.ts` | 661/654 en el glob completo |

### 4.2 Hallazgos del integrador (flujo real por HTTP; ninguno bloquea)

| Id | Sev. | Hallazgo | Estado |
|---|---|---|---|
| INT-L3-01 | media | **VeriFactu envía aunque el centro tenga `verifactu_enabled = false`**: Rías Altas lo tiene a `false` y aun así las tres simplificadas de prueba crearon 3 `verifactu_submissions` `accepted / sandbox / alta` (33 → 36 hasta la limpieza). `verifactu-submission.service.ts` no lee `PropertyComplianceSetting.verifactuEnabled` (0 coincidencias) y envía «en todos los modos, sandbox incluido» (:80-81); el modo es global (`VERIFACTU_MODE`). Comportamiento previo a L3 (los 33 envíos de Faranda nacieron igual). | Decisión §9.6; fuera de L3 |
| INT-L3-02 | baja | `POST /pos/tickets/:id/close` con `settlement: cash` **emite por sí mismo una factura simplificada** (`FS-RA-2026-000001`, 3,00 €, IVA 0,27) y su asiento (D 570 / H 705.2 + 477.10). Es el diseño del TPV (ticket = simplificada), pero consume numeración de la serie REAL `SIM` del centro (activa, `FS-RA-2026-`, `next_number` 1): cualquier prueba de TPV sobre un hotel real gasta números fiscales. | Documentado; la secuencia se restauró a 1 en la limpieza (§6) |
| INT-L3-03 | baja | `POST /pos/tickets` exige el id de tablero del punto de venta (`out_bar`) y responde 404 `POS_OUTLET_NOT_FOUND` con el id de fila (`cmtzogz8y…`), mientras `POST …/pos/cash-closures` acepta el de fila y devuelve ambos (`outletId: out_bar`, `outletRowId`). Inconsistencia menor de contrato (P1 documentó `out_<tipo> \| id de fila` en openapi para `cash-summary`). | Pendiente §8 |
| INT-L3-04 | baja | `POST /availability/quote` sigue devolviendo la cadena fija en inglés `cancellationPolicy: "Flexible until 18:00 the day before arrival"` aunque la política real sea FLEX 24 h (`pms.service.ts`, resto del cotizador A). | Pendiente §8 |
| INT-L3-05 | baja | **8 `journal_lines` huérfanas** (sin `journal_entries`, ids `cmu6l…`, Σ 300,00 / 300,00) ya presentes en la copia previa `hotelos-pre-l3-…dump`: deuda anterior (probable `cleanupTenant` de una suite que borró asientos sin sus líneas). No son de esta tanda (las 12 líneas de mis 5 asientos se borraron con ellos). | Deuda §8 |
| INT-L3-06 | baja | Una reserva creada por API deja `booking_source` NULL (`channel: direct`); el importador sí escribe `import:<lote>`. Preexistente (35 reservas RA sin `booking_source`). | Deuda §8 |
| INT-L3-07 | info | Preflight del cierre del día de RA (lectura como dirección): `businessDate 2026-09-13` (el cierre no se ejecuta desde el 13/09), `canClose: false` por 3 no-shows sin resolver y 4 folios con 379,75 € sin cobrar; la frase nueva del lote B separa los «9 folios de reservas canceladas o no presentadas [que] conservan 385,00 € sin cobrar: no bloquean el cierre». Al ejecutar el cierre real, las llegadas pasadas confirmadas pasarán a `no_show` con línea `no_show_fee` de la primera noche (FLEX por defecto): hacerlo con copia previa (lote B ya lo avisó). | Decisión §9.8 |
| INT-L3-08 | info | La cadena de auditoría (`audit_events.previous_hash / current_hash`) conserva los **34 eventos** de la prueba (4 `AUTH_LOGIN`, 3 `ACCESS_DENIED` de las sondas 403, `RESERVATION_CREATED` ×4, `RESERVATION_CANCELLED` ×2, `RESERVATION_CANCELLATION_POLICY` ×2, `FOLIO_CHARGE_POSTED`, `PAYMENT_CAPTURED` ×2, `INVOICE_DRAFT_CREATED` / `INVOICE_ISSUED` ×2, `VERIFACTU_SUBMISSION` ×3, `POS_TICKET_CLOSED`, `CASH_CLOSURE_OPENED / CLOSED / APPROVED`, `FOLIO_CLOSED`) y 1 fila de `sessions`: no se borran a propósito (cadena hash, solo-añadir). Referencian entidades ya borradas. | Residuo documentado |
| INT-L3-09 | info | `cutoffAt` de la vista previa es el instante de referencia (14:00 hora del hotel del día de llegada), no «llegada − horas gratuitas»: p. ej. RES-00161 (llegada 12/10) → `2026-10-12T12:00:00Z`. Está documentado en el servicio (:186) y en `api-contracts.md`; el front debe etiquetarlo como hora de referencia y no como límite. | Sin cambio |

## 5. Flujos verificados por HTTP en `:3903` (2026-09-18 22:49-23:0x)

### 5.1 Crear reserva con precio desde tarifa (`recepcion.rias`, `POST /properties/RA/reservations` sin `totalAmount`)

| Reserva | Cuerpo | Respuesta | BD |
|---|---|---|---|
| RES-00161 | 12→14/10, 2 adultos, DBL, plan BAR explícito | 200 · `totalAmount 196` (2 × 98,00) · `priceSource rate_plan` · `pricing { nights 2, nightsWithoutRate 0, ratePlanId BAR, warning null }` · `cancellationPolicyCode FLEX` | `price_source rate_plan`, `cancellation_policy_id` FLEX, 1 folio abierto |
| RES-00162 | 12→15/10, DSV, sin plan ni importe | 200 · `390` (3 × 130,00, precio publicado más bajo = BAR) · `rate_plan` | idem |
| RES-00163 | 20→21/10, DBL, plan **BAR-NR** (derivado, 0 celdas) | 200 · `98` · `pricing.ratePlanId` = BAR ≠ plan pedido · `warning` «El plan tarifario elegido no publica precio para estas noches: se ha cotizado con otro plan de la propiedad. Revisa la tarifa.» | `rate_plan_id` BAR-NR conservado |
| RES-00164 | 19→21/09 (llegada al día siguiente), DBL, BAR | 200 · `253` (2 noches) · `rate_plan` | base de la cancelación tardía (§5.3) |

`POST /properties/RA/availability/quote` (DBL, BAR-NR, 12→14/10) → 200 `[{ availableRooms 58, totalAmount 196, priceSource rate_plan, quotedRatePlanId BAR, ratePlanSwitched true, nights 2, nightsWithoutRate 0, fallbackNightly null }]` (INT-L3-04 para la cadena de política). Auditoría `RESERVATION_CREATED` con `pricing`, `priceSource`, `discount.skipped no_total` y `cancellationPolicy`.

### 5.2 Reimportar el CSV de demo de T7 en dry-run (`POST /properties/RA/reservations/imports/preview`, `pms.reservation.create`)

- Fichero original `pilots/faranda-celuisma/reservas-demo-rias-altas.csv` (30 filas): `canImport false` con blocker `RESERVATION_IMPORT_DUPLICATE` («este fichero ya se importó, lote `cmu4t43gh0000fyu01qbc20ri` 2026-09-17»), 29 filas `skipped` por `ROW_DUPLICATE_REFERENCE` (RES-00121…) y **1 fila a crear** (IMP-RA-2026-113, referencia reutilizada de la cancelada RES-00133) **cotizada 306,00** (`RESERVATION_IMPORT_ROW_TOTAL_QUOTED`, 2 noches × 1, `totalSource quoted`); `totals { fromFile 0,00, quoted 306,00 }`. Las filas 106 y 125 (sin importe) quedan `none` porque no se crean (duplicadas): la cotización solo se aplica a lo que se va a crear.
- Mismo fichero con las referencias renombradas `IMP-RA-L3DRY-*` (solo en memoria): 25 a crear + 5 `error` (`ROW_ROOM_UNAVAILABLE`: habitación ya asignada a la importación del 17/09) → `totals { fromFile 8.810,00, quoted 734,00 }` y **las 3 filas sin importe cotizadas**: 106 → 196,00 (llegada leída de serial Excel, `DATE_FROM_SERIAL`), 113 → 306,00, 125 → 232,00 (`RATE_PLAN_DEFAULTED` BAR). `bySource { file 27, quoted 3 }`. Nada se escribió (vista previa).

### 5.3 Cancelar con penalización según política y folio cerrado (`recepcion.rias`)

| Paso | Ruta | Resultado |
|---|---|---|
| Preview fuera de ventana | `GET /reservations/RES-00161/cancellation-charge` | `amount 0, basis none, withinFreeWindow true, policyCode FLEX, cutoffAt 2026-10-12T12:00Z` |
| Cancelar fuera de ventana | `POST /reservations/RES-00161/cancel { reason, reasonCode guest_request }` | 200 · `status cancelled` · `cancellation { applied true, charge.amount 0, line null, folio { status closed, balanceDue 0, pendingInvoice false } }` · BD: folio `closed`, 0 líneas |
| Preview dentro de ventana | `GET /reservations/RES-00164/cancellation-charge` y `?mode=no_show` | `amount 126,5, basis first_night` (253 / 2), etiquetas «Cancelación tardía — Flexible: primera noche» / «No-show — Flexible: primera noche», `cutoffAt 2026-09-19T12:00Z` (`null` en no-show) |
| Renuncia sin autorización | `POST …/cancel { applyPolicy false }` | **409 `APPROVAL_REQUIRED { kind discount, tier T2 }`**, 0 escrituras (reserva sigue `confirmed`, 0 `approval_requests`) |
| Cancelar con penalización | `POST /reservations/RES-00164/cancel` | 200 · `cancellation.line { type cancellation_fee, unitPrice 126,5, taxCategory not_subject }` · `folio { status open, balanceDue 126,5, pendingInvoice false }` · auditoría `RESERVATION_CANCELLED` + `RESERVATION_CANCELLATION_POLICY { mode, folio, charge, lineId, reason, status, waiver, applied, policyWaived, waivedAmount }` |
| Segunda cancelación | `POST …/cancel` | **409 `RESERVATION_NOT_ACTIVE`** («la penalización ya se aplicó… una segunda llamada no vuelve a cargarla») |
| Rutas heredadas sobre RES-00163 (confirmada) | `POST …/apply-cancellation-fee` · `…/apply-no-show-fee` | **409 `RESERVATION_STATUS_MISMATCH { status confirmed, expected … }`** ×2 |
| Cobrar la penalización | `POST /folios/:id/payments { amount 126.5, method card }` | 201 `captured` · asiento D 5721 126,50 / H 4300 126,50 |
| Cerrar sin facturar | `POST /folios/:id/close` | **409 `FOLIO_UNINVOICED_LINES { lines 1, total 126.5 }`** |
| Facturar y cerrar | `POST /folios/:id/invoice { F2, guest }` → `POST /invoices/:id/issue` → `POST /folios/:id/close` | borrador 126,50 / IVA 0 → **`FS-RA-2026-000003`** `issued` (línea `not_subject`, tipo 0 %) · asiento D 4300 126,50 / H 705.3 126,50 **sin 477** → folio `closed` |

### 5.4 Cobrar desde la reserva (`recepcion.rias`, RES-00162; rutas mínimas de cobro: **2**)

`GET /reservations/:id/folio` (folio abierto, 0 líneas) → `POST /folios/:id/lines { type room, unitPrice 390 }` → 200 con **`taxCategory accommodation` inferida** (un segundo cargo `room` con `taxCategory food_beverage` → **400** «Categoría fiscal «food_beverage» incompatible con el tipo de cargo «room». Admitidas para este tipo: accommodation.») → `POST /folios/:id/payments { 390, cash }` → **201** `captured` con `journalEntryId` (D 570 390 / H 4300 390) → `GET /folios/:id/balance` → `POST /folios/:id/close` → 409 `FOLIO_UNINVOICED_LINES { 1, 390 }` → `POST /folios/:id/invoice { F2 }` (borrador 390,00, IVA 35,45) → `POST /invoices/:id/issue` → **`FS-RA-2026-000002`** `issued` (`verifactuHash 447D5E…`, `previousInvoiceHash 0AE8F4…`, `qrPayload prewww2…`) · asiento D 4300 390 / H 705.1 354,55 / H 477.10 35,45 → `POST /folios/:id/close` → 200 `closed`. En pantalla (ficha › Folio › «Cobrar» › confirmar) el criterio ≤ 3 clics se cumple por diseño de F1; no se ha verificado en navegador (sesión del panel `:5173` = Carmen contra `:3000` parado).

### 5.5 PDF de factura (`GET /invoices/:id/pdf`, `invoice.read`)

| Factura | Usuario | HTTP | Bytes | Comprobación |
|---|---|---|---|---|
| FS-RA-2026-000002 | contabilidad | 200 `application/pdf` | 35.208 | empieza por `%PDF-`, 1 página, QR AEAT (`ValidarQR?nif=A33615980&numserie=FS-RA-2026-000002&fecha=18-09-2026&importe=390.00`), «Desglose de IVA · IVA 10 % · Cuota IVA», «Establecimiento: Hotel Faranda R…» |
| FAC-2026-000016 (heredada) | Carmen | 200 `application/pdf` | 36.586 | `%PDF-`, 1 página, QR (misma cifra que el recon §2.4) |
| FS-RA-2026-000003 (penalización) | contabilidad | 200 | 34.908 | `%PDF-`, 1 página, QR |
| FS-RA-2026-000001 (TPV) | recepción | 200 | 34.943 | `%PDF-`, 1 página, QR |

### 5.6 Modelo 303 del trimestre = Σ nativas + libros importados sin doble cómputo (`contabilidad`, `GET /fiscal/models/303?period=2026-Q3`)

| Estado de la BD | Casilla 27 | 45 | 71 | Registros | Emitidas (filas) | Cotejo con el diario |
|---|---|---|---|---|---|---|
| Con las 3 simplificadas de prueba vivas | **239.530,75** | 76.220,42 | 163.310,33 | 200 | 102 (35 al 21 % · 48 al 10 % · 19 al 0 %) | `cuadra true` · 499 apuntes · `diferencias []` |
| Tras la limpieza (§6) | **239.495,03** | 76.220,42 | 163.274,61 | 197 | 99 | `cuadra true` · 497 apuntes · `diferencias []` |

Cruce por SQL sobre `vat_book_entries` (org Faranda, `date` en 2026-07-01…09-30, con las pruebas vivas): emitidas **nativas 40 filas / cuota 110,66** + **`sage200` 61 filas / 239.424,64** = 101 filas / 239.535,30; el 303 resta la contrafila `#sustituida` derivada en memoria (−4,55: FAC-2026-000018 sustituida por REC-2026-000003, DS-06) → **239.530,75** = casilla 27 y 101 + 1 + 98 = **200 registros**; recibidas **`sage200` 98 filas / 76.220,42** = casilla 45; **0 números de factura nativos entre las filas `sage200`** (`number = invoice_number` o `source_id = id`) → sin doble cómputo. Las tres simplificadas aportaron exactamente 0,27 + 35,45 + 0,00 = 35,72 (239.495,03 + 35,72 = 239.530,75). `avisos` (33): la contrafila derivada («ejecuta `POST /fiscal/vat-books/rebuild` del periodo 2026-Q3 para persistirlas», decisión §9.5), 3 asientos `pms_shadow_revenue` excluidos del cotejo, y los avisos rutinarios de las facturas heredadas (sin NIF del destinatario para el 347; líneas al 0 % sin tipo). `presentacion.modo manual` (sin fichero oficial). El rebuild de Faranda Q3 **no se ha ejecutado** (§6.9 del recon sigue siendo decisión de César).

### 5.7 TPV `?status` (`recepcion.rias`, `pos.read` / `pos.order.create` / `pos.order.pay`)

`GET /properties/RA/pos/tickets?status=open|closed|all` → 200 `[]` (RA sin comandas); `?status=foo` → **400** «Validation failed (query): status: Invalid enum value. Expected 'open' | 'closed' | 'all'». `POST /pos/tickets { outletId out_bar }` → 200 `pos_1adfc74e` (con el id de fila → 404 `POS_OUTLET_NOT_FOUND`, INT-L3-03) → `POST …/lines { Café integrador L3, 2 × 1,50 }` → total 3,00 → `POST …/close { settlement cash }` → `closed`, `taxTotal 0,27`, **`invoiceNumber FS-RA-2026-000001`** e `journalEntryId` (INT-L3-02) → `?status=closed` lo lista, `?status=open` vacío → `GET …/pos/cash-summary?date=2026-09-18` → `timeZone Europe/Madrid (property)`, Bar 1 ticket 3,00 `cash`, `unsettled 0`, `openTickets 0`, `unplaceable 0`, `degraded []`, `source pos_orders`.

### 5.8 Cierre de caja que sobrevive a matar y arrancar la instancia

1. Instancia **A**: `POST /properties/RA/pos/cash-closures { outletId (fila), businessDate 2026-09-18, openingFloat 100 }` (recepción, `pos.order.pay`) → **201** `cmu7fr0rf000dfyglkxplnguw` `open`, `outletId out_bar`, `expectedCash 100,00`, `linkedTickets 0`; `GET /properties/RA/pos/cash-closures/:id` (Carmen) → 200.
2. `kill 57621` → 0 procesos en `:3903` → instancia **B** (pid 61334) arriba en 2 s (`/health` `postgres ok`).
3. Instancia **B**: `GET …/cash-closures/:id` (Carmen) → 200 `open` con los mismos campos; `GET …/pos/tickets?status=closed` → el ticket `pos_1adfc74e`; `GET …/cash-closures?status=open` → el arqueo.
4. `POST …/cash-closures/:id/close { countedByMethod { cash 103 }, counts [50 × 2, 1 × 3] }` (recepción) → 200 `closed`, `expectedCash 103,00` (100 + 3 del ticket en efectivo), `countedCash 103,00`, `difference 0,00`, `journalEntryId null` (sin diferencia no hay asiento).
5. `POST …/approve` (contabilidad, `accounting.journal.post`) → 200 `approved` (`closedBy` recepción ≠ `approvedBy` contabilidad); el mismo `approve` como recepción → **403** `accounting.journal.post`. BD: `cash_closures` 1 fila `approved` (borrada después, §6).

### 5.9 Matriz RBAC observada (`RBAC_STRICT=true`)

| Ruta | recepcion.rias | direccion.rias | contabilidad | Carmen |
|---|---|---|---|---|
| `POST /properties/RA/reservations`, `/availability/quote`, `imports/preview` | 200 | — | — | — |
| `POST /reservations/:id/cancel` con penalización · renuncia | 200 · **409 `APPROVAL_REQUIRED` (discount, T2)** | — | — | — |
| `GET /reservations/:id/cancellation-charge` | 200 | 200 | — | — |
| `POST /folios/:id/lines` · `/payments` · `/invoice` · `POST /invoices/:id/issue` · `/folios/:id/close` | 200 · 201 · 200 · 200 · 200 | — | **403 `payment.capture`** (payments) | — |
| `GET /invoices/:id/pdf` | 200 | — | 200 | 200 |
| `GET /fiscal/models/303` · `GET /fiscal/vat-books` | **403 `accounting.reports.read`** | — | 200 · 200 | — |
| `POST /pos/tickets*`, `GET …/pos/tickets?status`, `POST …/cash-closures`, `…/close` | 200 | — | — | — |
| `POST …/cash-closures/:id/approve` | **403 `accounting.journal.post`** | — | 200 | — |
| `GET …/cash-closures/:id` | 200 | — | — | 200 |
| `GET /properties/RA/night-audit/preflight` | — | 200 (INT-L3-07) | — | — |

Los 403 llevan el mensaje en español con la clave que falta y quedaron como `ACCESS_DENIED` en la auditoría.

## 6. Limpieza (23:0x, transacción `scratchpad/l3-cleanup.sql`, ids explícitos)

Borrado en este orden: 12 `journal_lines` + 5 `journal_entries` (`pos_ticket`, `payment` ×2, `invoice` ×2; `entry_number` 2395-2399, la cola de la numeración de Faranda) · 3 `verifactu_submissions` · 3 `invoice_lines` · 3 `vat_book_entries` (`source_id` de las tres simplificadas) · 1 `pos_order_lines` + 1 `pos_orders` · 1 `cash_closures` · 3 `invoices` (`FS-RA-2026-000001…3`, cola de la cadena de hashes del obligado: `findPreviousChainLink` vuelve a apuntar a la última factura previa) · 2 `payments` · 2 `folio_lines` · 4 `folios` · 4 `reservations` (RES-00161…164) · `invoice_sequences` SIM 2026 `next_number` 4 → **1**. `COMMIT` sin errores (`ON_ERROR_STOP`). Nada de `org_123`, nada de Sage, ninguna fila anterior a la tanda. Se conservan a propósito los 34 `audit_events` encadenados y 1 fila de `sessions` (INT-L3-08); los 8 `journal_lines` huérfanos son anteriores (INT-L3-05).

Invariantes de Faranda en tres lecturas — **22:4x** (línea base, antes de escribir) · **23:0x** (con las pruebas vivas) · **23:1x** (tras la limpieza) y de nuevo tras la integración completa:

| Cifra | Base | Con pruebas | Tras limpieza / integración |
|---|---|---|---|
| Facturas Faranda (issued 14 · cancelled 8 · rectified 3) | **25** | 28 | **25** |
| VeriFactu `accepted` | **33** | 36 | **33** |
| Reservas (todas en RA) | **110** | 114 | **110** |
| Asientos org Faranda · núcleo (sin payroll / pms_shadow / sage200 / reversal) | **4.951 · 63** | 4.956 · 68 | **4.951 · 63** |
| Lotes Sage · asientos `sage200_*` · filas de libro `sage200` (NO invariantes: carga en curso) | 34 · 4.421 · 2.918 | igual | igual |
| Permisos · plantillas · asignaciones vivas | **250 · 24 · 31** | igual | igual |
| Folios Faranda (104 open · 7 closed) · líneas (30, 1.126,45 €, 30 NULL) · pagos 25 | 111 · 30 · 25 | 115 · 32 · 27 | 111 · 30 · 25 |
| `cash_closures` · `pos_orders` (1 = prop_123) · `cancellation_policies` | 0 · 1 · 24 | 1 · 2 · 24 | 0 · 1 · 24 |
| Organizaciones · tablas · migraciones | 2 · 275 · 15 | igual | igual |

## 7. SQL de verificación (solo lectura, `psql $DATABASE_URL -Atc`)

```sql
-- O = 'cmrhw9jy30002fyvb6tsdiugt' (Faranda) · RA = 'cmrhw9jy40003fyvbuu2ec2w7'
select count(*) from invoices i join properties p on p.id = i.property_id where p.organization_id = O;               -- 25
select count(*) from verifactu_submissions v join invoices i on i.id = v.invoice_id
  join properties p on p.id = i.property_id where p.organization_id = O;                                      -- 33
select count(*) from reservations r join properties p on p.id = r.property_id where p.organization_id = O;   -- 110
select count(*) from journal_entries where organization_id = O;                                               -- 4951
select count(*) from journal_entries where organization_id = O and source_type not in ('payroll_cost_import','pms_shadow_revenue')
  and source_type not like 'sage200%' and source_type <> 'reversal';                                          -- 63 (structure-e2e)
select count(*) from ledger_imports where organization_id = O;                                                -- 34 (último 2026-09-17 15:10:54)
select (select count(*) from permissions), (select count(distinct template_key) from roles where organization_id = O and template_key is not null),
       (select count(*) from user_role_assignments where organization_id = O and revoked_at is null);         -- 250 · 24 · 31
select finished_at, left(checksum, 10) from _prisma_migrations where migration_name = '20260918150000_dinero_fiscal';  -- 20:13:35 · 03fc53dfdd
select count(*), string_agg(property_id || ':' || code || case when is_default then '*' else '' end, ' ' order by property_id, code)
  from cancellation_policies;                                                                                  -- 24 (FLEX* NREF SEMI × 8 centros)
select price_source, count(*) from reservations where property_id = RA group by 1;                          -- NULL 110 (heredadas)
select next_number from invoice_sequences where property_id = RA and sequence_code = 'SIM' and year = 2026; -- 1
-- Residuos del integrador → 0
select count(*) from reservations where booker_name like 'Integrador L3%';                                   -- 0
select count(*) from invoices where invoice_number like 'FS-RA-2026-%';                                       -- 0
select count(*) from pos_orders where property_id = RA;                                                        -- 0
select count(*) from cash_closures;                                                                            -- 0
select count(*) from organizations where id like 'org_l2_%' or id like 'org_lr%' or id like 'org_l3%';      -- 0
-- Modelo 303 2026-Q3 por origen (con la BD limpia: 27 = 239.495,03 tras restar la #sustituida derivada −4,55)
select case when source_type::text like 'sage200%' then 'sage200' else 'nativas' end, count(*), sum(quota)
  from vat_book_entries where organization_id = O and book = 'emitidas' and date between '2026-07-01' and '2026-09-30' group by 1;
                                                                                                             -- nativas 37 / 74,94 · sage200 61 / 239.424,64
select count(*) from vat_book_entries s where s.organization_id = O and s.source_type::text like 'sage200%'
  and exists (select 1 from invoices i join properties p on p.id = i.property_id where p.organization_id = O
              and (s.number = i.invoice_number or s.source_id = i.id));                                       -- 0 (sin doble cómputo)
-- Deuda previa (INT-L3-05)
select count(*) from journal_lines jl where not exists (select 1 from journal_entries je where je.id = jl.journal_entry_id);  -- 8 (cmu6l…, ya en la copia previa)
```

## 8. Pendientes y deuda que deja la tanda (consolidado de los lotes)

1. **Rebuild de los libros de Faranda 2026-Q3** (`POST /fiscal/vat-books/rebuild`): regeneraría las 8 filas `:anulacion` con la convención `#anulacion` y persistiría la contrafila `#sustituida` de FAC-2026-000018 (el 303 ya la deriva en memoria: −4,55). Requiere copia previa y re-verificar `fiscal-models` / `structure-e2e`. Decisión §9.5.
2. `invoice.service.ts:2496 / :3068` deberían importar `cancellationSourceId` / `supersededSourceId` de `invoicing/vat-book.ts` en vez de los literales (hoy coinciden por texto y los pina `l3-factura-303`). Caso límite sin ejercitar: sustitución de una rectificativa (dos reglas de `sourceType` que hoy coinciden para F1/F2).
3. `registerSupplierBillInVatBooks` / `registerExpenseInVatBooks` (`vat-books.service.ts:1259-1289`) sin llamadores: retirar en el lote de proveedores.
4. `packages/shared/src/fiscal-types.ts`: `FiscalLedgerCrossCheck` sin campo estructurado de exclusiones y `VatBooksRebuildResponse.documentos` sin `sustituciones` (dos campos aditivos para que el front no parsee texto).
5. `POST /invoices/:id/rectify` sigue escribiendo `taxCategory: null` en la línea de reflejo `invoice_adjustment` (`invoice.service.ts:3119-3130`): decidir si es marcador «no facturable» o pasa por `resolveFolioLineTaxCategory`.
6. `folios.schemas.ts`: `ApplyPaymentSchema`, `RefundPaymentSchema`, `MarkInvoicePaidSchema`, `SendInvoiceEmailSchema` son `.strict()` sin `STRICT_BODY_MESSAGE` (el 400 sale en inglés).
7. `pmsCommerceApi.ts`: `LegacyFolioPaymentInput` y la sobrecarga deprecada de `postFolioPayment` siguen en uso por «Cobrar» de la ficha; `CancelInvoiceOptions` sin `supervisorAuthorizationId`; `cancelReservation` / `noShowReservation` sin el bloque `cancellation` en el tipo; `folioRoutingApi.ts` `FolioLine` sin `taxCategory` (F1 los estrecha localmente).
8. `financeScope.ts`: `PosDashboard` sin clave en `FINANCE_SCOPE_POLICIES` (pasa la política literal); `pos-types.ts:12,66` sigue diciendo «serie FS» en comentarios.
9. `apps/api/scripts/generate-openapi.mjs` solo parsea `server.ts`: una regeneración descartaría las 23 operaciones de módulos añadidas a mano (`openapi.yaml`) — extender a los `register*Routes` o marcar el YAML como mantenido a mano. `docs/api-contracts.md:16` sigue diciendo «215 keys» (son 250).
10. TicketBAI ausente del PDF (0 referencias; sin generador de QR TBAI en el repo). Facturas heredadas `ES_UNKNOWN_0` al 0 % (FAC-2026-000004…000013) se reconstruyen como «IVA 0 %» sin calificación: solo una rectificativa podría corregirlas.
11. `SEED_PROPERTY_IDS` / `SEED_DEFAULT_CODE` no existen (el seed acepta el csv en `SEED_PROPERTY_ID`); `email-reservation.service.ts` pasa `ratePlanId` que ningún extractor emite (las reservas por correo cotizan BAR o quedan a 0 € con aviso).
12. Auditoría de la política (`policyWaived`, `waivedAmount`, `autoNoShow`, `source`) viaja en `RESERVATION_CANCELLATION_POLICY` y no dentro de `RESERVATION_CANCELLED` (mismo `correlationId`); unificar exigiría un `auditExtra` en `transitionReservation`.
13. Check-out y sincronización OPERA conservan el cierre de folio heredado (sin exigir factura): decidir si `requireInvoiced` también ahí.
14. Cancelación con `applyPolicy = false` en el cronograma y la ficha exige `pms.reservation.discount` (recepción recibe 403 / 409 en el toast); el 409 `RBAC_SOD_CONFLICT issuer_ne_canceller` de anulación de factura no se levanta con PIN (solo otra persona).
15. Verificación visual en navegador de los tres fronts (formulario, centro de facturación con buscador, drawer de check-out, panel TPV) pendiente: el panel `:5173` sirve una sesión de Carmen contra `:3000`, que estaba parado durante toda la tanda.
16. INT-L3-03 (`out_bar` vs id de fila), INT-L3-04 (cadena fija de política en el quote), INT-L3-05 (8 `journal_lines` huérfanas), INT-L3-06 (`booking_source` NULL por API).
17. Datos de prueba que quedan: en `prop_123` (org_123) dos reservas cerradas del lote F2 (RES-18396 / RES-18397, 2 pagos de 90 y 75 €) como fixtures; en Faranda los 34 `audit_events` de esta prueba (cadena hash). `pnpm-lock.yaml` (+52 líneas por la carga de Sage) sin commit.
18. Puerta 11: `rbac:sync --dry-run` no debe solaparse con la integración (26 suites borran organizaciones); documentado en el runbook de puertas por el corrector.

## 9. Decisiones abiertas para César

1. **Políticas de cancelación reales por hotel.** El seed dejó en los 8 centros FLEX (24 h, primera noche; **default**), SEMI (72 h, primera noche) y NREF (0 h, toda la estancia). Faltan: los códigos y ventanas reales de cada hotel (¿Los Tilos igual que Rías Altas?), el enlace plan → política (`RatePlan.cancellationPolicyId` sigue NULL en los 9 planes: BAR-NR debería llevar NREF) y la regla de derivación de BAR-NR / BAR-BB (hoy `derivation_json {}` sin padre: cotizan a BAR con aviso, §6.18 del recon). Sin decidirlo, toda reserva nueva de cualquier centro es FLEX.
2. **Categorías fiscales por tipo de cargo.** Tabla vigente (`compatibleTaxCategories`): room → accommodation (10 %); minibar / restaurant → food_beverage (10 %) o general_services; spa / parking / laundry / telecom → general_services (21 %); city_tax → tourist_tax; **penalizaciones → `not_subject` (indemnización, 705.3 sin cuota)** o accommodation. Confirmar con asesoría el criterio de la penalización (el no-show con retención del precio puede ser contraprestación sujeta al 10 %), si debe ser configurable por política (`penaltyTaxCategory`), y si las 30 líneas históricas NULL de Rías Altas se rellenan por tipo (migración de B) o siguen infiriéndose al facturar (§6.8, vigente).
3. **PSP.** Los cobros son manuales (`cash` / `card` → 570 / 5721 sin conciliación); `payment-intents` y `payments/return/:intentId` existen sin proveedor (`psp-status` responde simulado). Decidir proveedor (Redsys / Adyen / Stripe), tokenización para el «no-show con tarjeta» y quién captura la penalización automáticamente.
4. **Plantilla de PDF.** El PDF es propio (1.4, 1 página, sin dependencias): cabecera «Establecimiento», tabla, «Desglose de IVA», QR VeriFactu y huella; sin logotipo ni identidad Anfitorio / hotel, sin idioma alternativo, sin TicketBAI, y las 14 heredadas imprimen «Desglose reconstruido a partir de las líneas». Decidir plantilla corporativa (logo, pie legal, idiomas), si se imprime el «modo sandbox / NIF de relleno» y si TicketBAI entra (País Vasco: hoy ningún centro).
5. **Rebuild de Faranda 2026-Q3** (§8.1): ejecutar `POST /fiscal/vat-books/rebuild` con copia previa para que el 303 no dependa de la derivación en memoria (−4,55 y 8 filas `:anulacion`).
6. **VeriFactu con `verifactu_enabled = false`** (INT-L3-01): en sandbox se envía todo (los 33 envíos de Faranda, y los 3 de esta prueba). Decidir si el flag del centro debe cortocircuitar el envío (y entonces qué muestran las facturas sin QR) o si el flag solo gobierna producción.
7. **Numeración real del TPV** (INT-L3-02): la serie `SIM` de Rías Altas está activa (`FS-RA-2026-`), así que cada comanda cerrada de una demo gasta un número fiscal; o se demuestra en `prop_123`, o se abre una serie sandbox para el TPV, o se acepta.
8. **Cierre del día en Rías Altas** (INT-L3-07): `businessDate` sigue en 2026-09-13; el próximo cierre real marcará como `no_show` las confirmadas con llegada pasada (3 según el preflight de hoy; 5 según el lote B) con `no_show_fee` de la primera noche bajo FLEX, y cargará 3 noches sin cargo. Ejecutarlo con copia previa o decidir primero las políticas (1).
9. **`send-email`** (§6.11): mantener `invoice.issue` (caja descarga pero no envía) o rebajar a `invoice.read` / `payment.capture` (manifiesto B + plantillas + `rbac:sync`).
10. **Sin tarifa publicada** (§6.2): hoy la reserva se crea a 0 € con `priceSource none|partial` y aviso (coherente con T7); la alternativa 409 `NO_PUBLISHED_RATE` es un cambio local en `pms.service.ts:928-936`. Seis de ocho centros no tienen parrilla.
11. **Renuncia de la penalización como `discount`** (DS-02, vigente): tramos T1 / 25 % / solicitud; si se prefiere un kind propio con umbral, afecta a `rbac-sod-contract` y al runbook §4.1.
12. **Cierre heredado en check-out y OPERA** (§8.13) y **cierre automático de las 12 canceladas históricas de RA** con folio abierto (§6.6 del recon: hoy no se barren; ya no bloquean el preflight).
13. **Commit de la tanda**: atribuir a la carga de Sage los ficheros de `accounting/import/**`, `import-sage200.ts`, sus docs y `pnpm-lock.yaml`; el resto es L3 (lotes + corrector + este informe).

## 10. Ficheros tocados por el integrador

- `docs/audits/TANDA-L3-DINERO-FISCAL-2026-09-18.md` (este informe, nuevo).
- `CLAUDE.md` (bloque «Estado verificado (Tanda L3 …)» tras el de L2).
- `docs/runbooks/finanzas-contabilidad.md` §11.1 (párrafo del integrador con las cifras del 303 verificadas por HTTP) y `docs/runbooks/accesos-por-departamento.md` §4.1 (matriz observada).
- `docs/design/cocoa-22-inventory.json` y `docs/design/COCOA-22-MIGRACION.md` §6 (regenerados por los scripts; solo cambia la cifra de líneas).
- Fuera del repo: `~/anfitorio-demo/backups/hotelos-pre-l3-20260918-224133.dump`; `scratchpad/{l3.sh,l3-login.sh,l3-cleanup.sql,l3-*.json,l3-*.pdf,l3-api-3903-{A,B}.log,l3-integrador-integration.log}`.
- Sin tocar, por regla: `apps/api/src/modules/accounting/import/**`, `apps/api/src/scripts/import-sage200.ts`, ficheros de IA (L6a), `pnpm-lock.yaml`, `:3000`.
