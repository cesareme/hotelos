# Auditoría de Código · Frontend (apps/admin-web) — Ronda 2

**Fecha:** 2026-06-21 · **Alcance:** `apps/admin-web` (React 19 + Vite) · ~108.5k LOC · 299 `.tsx` · 64+ componentes Cocoa
**Método:** lectura estática (Grep/Read), sin ejecución. Verificación de los 15 fixes de la ronda de remediación + búsqueda de hallazgos nuevos y regresiones.
**Base:** `docs/audits/general-2026-06/AUDIT-code-frontend.md` (score previo 70/100).

---

## Resumen ejecutivo

La remediación es **real y de buena calidad en lo que tocó**. Confirmo los cuatro fixes de frontend del lote (10–13) leyendo el código actual, no solo el changelog:

- **Fix 10 (tokens de estado + focus ring único + tints dark-safe) — CONFIRMADO.** `cocoa-tokens.css` añade 10 surfaces de estado (`--cocoa-success-bg/-border`, `danger`, `warning`, `info`, `accent`) derivadas con `color-mix` desde los hues themeables, más bloque dark explícito y `@media (prefers-color-scheme)`. El focus ring es fuente única: una sola def `.cocoa-focus-ring:focus-visible` en `cocoa-base.css:31`, y `CocoaButton`/`CocoaInput` consumen `var(--cocoa-focus-ring)` (nunca literal).
- **Fix 11 (estados carga/error en Room Rack + Night Audit) — CONFIRMADO.** `RoomRackScreen.tsx:228-231` y `NightAuditScreen.tsx:158-161` renderizan `<ErrorState ... onRetry={refresh}/>` y `<LoadingBlock/>` antes del contenido, en vez del banner rojo engañoso anterior.
- **Fix 12 (datos demo vaciados del alta de reserva) — CONFIRMADO.** `ReservationCreateScreen.tsx:96-102`: `firstName`, `surname1`, `email`, etc. arrancan en `""`. Comentario explícito en `:443` ("Defaults are now intentionally blank").
- **Fix 13 (a11y scroll-to-first-error) — CONFIRMADO.** `focusInvalidField()` (`:262-269`) hace `scrollIntoView({block:"center"})` + `.focus({preventScroll:true})` sobre el primer campo inválido; invocado en `handleCreate` (`:450,457`).

**Lo que NO mejoró:** los fixes 10–13 son quirúrgicos y no atacan los hallazgos sistémicos previos. Las métricas estructurales están **casi idénticas** a la ronda 1: 3.957 `style={{}}` inline (sin cambio), **0** `React.memo` (sin cambio), 82 pantallas con `useApiData` y solo 13 con `toArray` (sin cambio), 799 `<button>` crudos. La deuda de consistencia y performance sigue intacta.

**Lo positivo nuevo:** el fix 15 reencuadra honestamente el hallazgo #1 — `docs/design-system/DESIGN-SYSTEM-DECISION.md` documenta que no es "Cocoa con fugas legacy" sino **dos DS de primera clase (Aurora cálido `.bo-*` 156 pantallas + Cocoa frío 27)** y deja un gate report-only (`scripts/check-design-system-drift.mjs`). Excelente diagnóstico. Y `CocoaShowcaseScreen` (dev-only, 1.075 LOC) ya está aislado al chunk `screens-marketplace` vía `id.includes("/screens/developer/")` (`vite.config.ts:108`), cerrando media parte del hallazgo #10 previo.

**Lo negativo nuevo:** aparece un **tercer** sistema de componentes a medias — `components/v2/` (8 componentes, 1.342 LOC, su propio `DataTable` que duplica `CocoaTable`) — usado por solo 4 pantallas y con tokens Aurora. El decision-doc Aurora-vs-Cocoa **no lo menciona**, así que el "gobierno de DS" ya nace incompleto.

**Veredicto:** remediación frontend real y verificada (10–13 ✓), pero acotada a lo táctico. Los hallazgos sistémicos P1/P2 persisten. Score sube modestamente por las correcciones puntuales y el reencuadre honesto del DS: **72/100**.

---

## Estado de los fixes del lote (frontend)

| Fix | Estado | Evidencia |
|---|---|---|
| 10 tokens estado / focus ring / dark | ✅ Real | `cocoa-tokens.css:53-66`, `cocoa-base.css:31` |
| 11 loading/error Room Rack + Night Audit | ✅ Real | `RoomRackScreen.tsx:228`, `NightAuditScreen.tsx:158` |
| 12 demo data vaciada | ✅ Real | `ReservationCreateScreen.tsx:96-102,443` |
| 13 scroll-to-first-error | ✅ Real | `ReservationCreateScreen.tsx:262-269,450,457` |
| 14 OTAs mock honestas (backend `channel-manager.ts`) | n/a frontend | fuera de `admin-web` |
| 15 brief Aurora vs Cocoa + ds-drift | ✅ Real | `docs/design-system/DESIGN-SYSTEM-DECISION.md`, `scripts/check-design-system-drift.mjs` |

---

## 10 hallazgos priorizados

### 1. [P1·persiste] Tres capas de UI conviviendo; `components/v2/` es un DS huérfano
**Evidencia:** además de Aurora (`.bo-*`, 156 pantallas) y Cocoa (27 pantallas), existe `components/v2/` — 8 componentes (1.342 LOC): `DataTable`, `StatTile`, `PageHeader`, `SegmentedControl`, etc., con tokens Aurora propios (`StatTile.tsx:25` `var(--fs-xl)`, `:37` `var(--ink)`). `v2/DataTable.tsx` reimplementa sort/loading/empty que ya da `CocoaTable`. Usado por solo 4 pantallas (`ReservationsListScreen`, `BillingCenterScreen`, `InvoiceDetailScreen`, `invoiceStatus.ts`). El `DESIGN-SYSTEM-DECISION.md` no lo cita.
**Impacto:** migración abandonada a medias; un cuarto patrón de tabla; el gobierno de DS ya nace con un hueco.
**Fix:** incluir `components/v2/` explícitamente en `DESIGN-SYSTEM-DECISION.md` y darle destino: o promover a la opción ganadora (probablemente fundirse en Cocoa) o borrarlo y reapuntar las 4 pantallas a `CocoaTable`. Cambio acotado a 4 ficheros consumidores.

### 2. [P1·persiste] 3.957 estilos inline `style={{}}` (sin cambio vs ronda 1)
**Evidencia:** `grep "style={{"` = 3.957 (idéntico). Incluso el código nuevo del fix 13 los reintroduce: `FieldRow` en `ReservationCreateScreen.tsx:275-289` pinta 6 `style={{}}` inline por fila.
**Impacto:** objeto nuevo por render (rompe igualdad referencial, presiona GC), valores fuera del token-system.
**Fix:** extraer a `CSSProperties` a nivel módulo (el propio fichero ya lo hace bien en `:299 gridThreeStyle`, `:305 actionsRowStyle`) o a clases utilitarias. Priorizar tablas pintadas a mano.

### 3. [P1·persiste] 0 `React.memo` en 108k LOC; hover de fila repinta toda la tabla
**Evidencia:** `grep "React.memo\|memo("` = **0**. `CocoaTable.tsx:104` `useState(hoverKey)` + `:243 onMouseEnter={()=>setHoverKey(key)}` → cada hover re-renderiza las N filas. Listas grandes (`LiveTimelineWorkspace` 1.081 LOC, `RoomRackScreen`) no aíslan items.
**Impacto:** jank en tablas/timelines con N>100.
**Fix:** memoizar el row-component de `CocoaTable` + mover el hover a CSS (`:hover`) en vez de estado React. No global — solo las 5-6 vistas pesadas.

### 4. [P1·persiste] Chunk `screens-operations-rest` aún agrupa los diálogos pesados
**Evidencia:** `vite.config.ts:105` sigue colapsando `/screens/operations/` (salvo groups/front/reservations ya separados) en un chunk, incluyendo `GroupDetailDialog.tsx` (1.436 LOC), `OperationsDirectorScreen.tsx` (1.240), `GeneralManagerScreen.tsx` (1.129). El showcase dev SÍ se aisló (`:108` → `screens-marketplace`), cerrando media parte del hallazgo previo.
**Impacto:** abrir una pantalla de operaciones descarga el grupo entero.
**Fix:** `React.lazy` para los diálogos >1k LOC (`GroupDetailDialog`, `RoomBlockGridDialog`) en vez de import estático, o subdividir `operations-rest`.

### 5. [P2·persiste] `toArray` mandado por CLAUDE.md, usado en 13/82 pantallas
**Evidencia:** 82 pantallas con `useApiData`, solo 13 con `toArray`. El doc del helper exige envolver toda `data` iterada. Riesgo latente si un endpoint pasa de `[...]` a `{items:[...]}`.
**Impacto:** la red de seguridad existe pero no se aplica; fragilidad ante cambios de forma del API.
**Fix:** envolver `data` con `toArray<T>()` en las pantallas que iteran; lint que detecte `.map(` sobre `data` de `useApiData` sin `toArray`.

### 6. [P2·persiste] `useApiData` deps incompletas → footgun para mutaciones
**Evidencia:** `useApiData.ts:46` deps `[path, nonce, JSON.stringify(options.query ?? {})]` con `eslint-disable exhaustive-deps`, pero `:33` el fetch usa `options.method` y `options.body`. Cambiar `method`/`body` sin cambiar `path` no refetchea. Hoy 0 pantallas pasan method/body, pero es trampa para la 1ª mutación. Además `JSON.stringify` corre en cada render.
**Fix:** serializar `method`/`body` en las deps, o documentar `useApiData` como solo-GET y mover mutaciones a `apiRequest` directo.

### 7. [P2·nuevo] `color-mix` sin fallback para navegadores viejos (introducido por fix 10)
**Evidencia:** `cocoa-tokens.css:53-62` define los 10 surfaces de estado solo con `color-mix(in srgb, ...)`. Único `@supports` del fichero (`:384`) cubre `backdrop-filter`, **no** `color-mix`. En Safari <16.2 / Firefox <113 esas vars resuelven a inválido → badges/banners sin fondo.
**Impacto:** estado visual degradado (banners de error/aviso transparentes) en navegadores antiguos; bajo riesgo si el target es Chrome/Safari recientes, pero no declarado.
**Fix:** añadir `@supports not (color-mix(in srgb, red, blue)) { ... }` con rgba() literales de respaldo, o un fallback en la misma declaración. ~12 líneas.

### 8. [P2·persiste] 12 dashboards sin estado de carga (sin cambio)
**Evidencia:** verificado fichero a fichero: `FiscalDashboard` (5×`useApiData`, 0 `loading`), `ComplianceInbox` (6×, 0), `CrmDashboard`, `EnergyDashboard`, `UpsellsDashboard`, `QualityDashboard`, `AssetsDashboard`… ninguno renderiza `LoadingBlock`/`Skeleton`. El fix 11 arregló Room Rack y Night Audit pero no extendió el patrón.
**Impacto:** parpadeo a "vacío" antes de datos; percepción de pantalla rota.
**Fix:** aplicar el patrón ya usado en el propio fix 11 (`<LoadingBlock/>` mientras `loading`) a estos 12. Primitivos ya existen.

### 9. [P2·persiste] Navegación duplicada + sidebar-v2 muerto (sin cambio)
**Evidencia:** `cocoa-sidebar-v2/` sigue con 2.207 LOC. `BackOfficeLayout.tsx:51 USE_SIDEBAR_V2 = false` → `CocoaSidebarV2` nunca se renderiza, pero `:601 LEGACY_V2_GROUPS = buildLegacySidebarV2Groups()` se ejecuta en carga de módulo y `:651` se usa como `sourceGroups` igualmente (la estructura v2 viva, el render v2 muerto).
**Impacto:** ~2.200 LOC muertas + confusión de "fuente de verdad" del menú.
**Fix:** decidir v2 sí/no; si no entra, borrar `cocoa-sidebar-v2/` y `SIDEBAR_V2_CONFIG`/`CocoaSidebarV2` de `BackOfficeLayout.tsx`, manteniendo solo `buildLegacySidebarV2Groups` (renombrar a algo sin "v2").

### 10. [P3·persiste] `any` en tenant-admin + 28 `key={index}` en listas
**Evidencia:** `tenantAdminApi.ts:25-26` `properties: any[]; users: any[]`, `:93 Promise<any[]>`, `:97 toArray<any>`; `TenantAdminConsoleScreen.tsx:348 useState<any[]>`, `:627 <CocoaTable<any>>`. Aparte, 28 `key={index}` en pantallas con listas reordenables (`RoomingListImportDialog`, `FrontDeskActionQueue`, `GuestSegmentsScreen`…) → riesgo de estado pegado a índice tras filtrar/ordenar.
**Impacto:** se pierde tipado en consola multi-tenant sensible; bugs sutiles de reconciliación en listas.
**Fix:** tipar `TenantProperty/User/AuditRow` y propagar a `CocoaTable<T>` (2 ficheros). Sustituir `key={index}` por id estable donde la lista muta.

---

## Notas

- **Buen patrón nuevo:** el fix 13 (`focusInvalidField` + ids `rc-field-*`) es el modelo de a11y de error a replicar en otros formularios largos (`AllotmentsScreen`, `BillingCenterScreen`).
- **Sin regresiones de seguridad/type:** se mantienen **0** `@ts-ignore`, **0** `as any`, **0** `dangerouslySetInnerHTML`. Solo 4 `console.*` residuales.
- **Falso positivo descartado:** `LoadingBlock`/`ErrorState` (States.tsx) vs equivalentes Cocoa no son duplicado accidental; son los dos lados del split Aurora/Cocoa ya documentado en el fix 15.

---

## Score

| Eje | Peso | Nota | vs R1 | Comentario |
|---|---|---|---|---|
| Arquitectura de componentes | 20 | 13/20 | = | Showcase aislado (+), pero aparece `components/v2/` huérfano (−); navegación v2 muerta sigue |
| Estado (useApiData/toArray/states) | 20 | 15/20 | = | `toArray` 13/82 y deps incompletas sin tocar; loading dashboards pendiente |
| Performance | 20 | 14/20 | = | 0 memo, 3.957 inline, chunk operaciones sin subdividir |
| Type safety | 15 | 13/15 | = | 0 ts-ignore/as-any; `any` acotado a tenant-admin |
| Consistencia / design system | 15 | 9/15 | +2 | Fix 10 (tokens estado/focus único) real + reencuadre honesto Aurora/Cocoa (fix 15); −1 por 3ª capa v2 sin gobierno |
| Accesibilidad / pulido | 10 | 9/10 | +1 | Fix 11 (loaders Room Rack/Night Audit) + fix 13 (scroll-to-error) reales; faltan 12 dashboards |

### **Score global: 72 / 100** (R1: 70)

La remediación frontend es **verificada y real** (fixes 10–13 confirmados en código), pero táctica: sube 2 puntos por las correcciones puntuales de DS-tokens, a11y y estados de carga, más el diagnóstico honesto del split Aurora/Cocoa. Los hallazgos sistémicos P1 (inline styles, 0 memo, chunk operaciones, 3ª capa de UI) siguen intactos.

---

## Sección de remediación (priorizada por ROI)

1. **[P1] Cerrar el gobierno de DS:** decidir Aurora vs Cocoa en `DESIGN-SYSTEM-DECISION.md` **e incluir `components/v2/`** en la decisión (promover o borrar + reapuntar 4 pantallas). Activar el `check-design-system-drift.mjs` de report-only a bloqueante para pantallas nuevas.
2. **[P1] Performance de tablas:** memoizar row-component de `CocoaTable` + mover hover a CSS `:hover`; `React.lazy` para los diálogos >1k LOC de operaciones. Subdividir `screens-operations-rest`.
3. **[P2] Cerrar el bucle del fix 11:** extender `LoadingBlock`/`ErrorState` a los 12 dashboards sin estado de carga (patrón ya escrito).
4. **[P2] `color-mix` fallback:** añadir `@supports not (color-mix...)` con rgba() de respaldo en `cocoa-tokens.css` para no degradar los surfaces nuevos del fix 10.
5. **[P2] Higiene de estado:** aplicar `toArray<T>` en las 69 pantallas que iteran sin él (+ lint); arreglar deps de `useApiData` o declararlo solo-GET.
6. **[P3] Limpieza:** borrar `cocoa-sidebar-v2/` muerto; tipar `tenantAdminApi`; sustituir `key={index}` en listas mutables; eliminar `style={{}}` inline en `FieldRow` y tablas pintadas a mano.
