# Auditoría de Código · Frontend (apps/admin-web)

**Fecha:** 2026-06-21 · **Alcance:** `apps/admin-web` (React 19 + Vite) · ~108k LOC · 202 pantallas · 64 componentes Cocoa
**Método:** lectura estática con Grep/Read. Sin ejecución. Cifras verificadas sobre `src/`.

---

## Resumen ejecutivo

El frontend está **más maduro de lo que sugiere su tamaño**. Los cimientos son sólidos: code-splitting agresivo y correcto (200 de 210 pantallas en `lazy()`), un `api-client` centralizado con manejo de 401/refresh/PII-safe, primitivos de estado reutilizables (`LoadingBlock`/`ErrorState`/`EmptyState`/`Skeleton`), un `CocoaGlobalProvider` que separa en 5 contextos y memoiza cada `value`, type-safety alta (solo ~43 usos reales de `any`, **0** `@ts-ignore`, **0** `as any`), y accesibilidad por encima de la media (709 atributos `aria-*`, 0 `<button>` sin `type=`, solo 6 `<div onClick>`).

El problema dominante **no es la calidad por pantalla sino la coherencia del sistema**. Conviven **dos design systems en paralelo**: el nuevo *Cocoa* (2.890 refs a tokens `--cocoa-*`, 64 componentes) y un sistema legacy de clases CSS `.bo-*`/`.rev-*`/`.cm-*` (5.359 usos de `className`, `styles.css` de 2.790 líneas). Las 202 pantallas se renderizan **mayoritariamente con el legacy**: solo 26 importan algún primitivo Cocoa, hay 693 `<button>` crudos frente a 27 pantallas que usan `CocoaButton`, y 3.957 `style={{}}` inline. El design system Cocoa está construido pero **infra-adoptado**. A esto se suma navegación duplicada (3 implementaciones de sidebar + una v2 muerta tras `USE_SIDEBAR_V2 = false`) y un chunk de 419 KB.

La deuda es **convergente, no estructural**: el camino correcto ya existe (Cocoa, `States`, `useApiData`, `toArray`); falta migrar pantallas hacia él y retirar lo legacy/muerto.

**Veredicto:** base de ingeniería buena con deuda de consistencia de UI alta y concentrada. Abordable de forma incremental.

---

## Lo que está bien (no tocar)

- **Code splitting / lazy loading** — `App.tsx` usa `lazyNamed()` para 200 pantallas; solo 10 eager y todas justificadas (login, dashboards critical-path). `vendor-react`, `vendor-sentry`, `vendor-charts` separados en `vite.config.ts`.
- **`api-client.ts`** — punto único de fetch, maneja 401 (limpia sesión + notifica AuthGate), demo-login solo en dev (`IS_PRODUCTION` guard, `:16`), breadcrumbs PII-safe (solo método+path).
- **`CocoaGlobalProvider`** — 5 contextos separados, cada `value` memoizado con `useMemo` y handlers con `useCallback`. Evita el clásico re-render global por contexto monolítico.
- **`States.tsx` + `CocoaTable`** — primitivos de loading/error/empty/skeleton theme-aware; `CocoaTable` tipado con genéricos, `aria-sort`, empty-state y loading integrados.
- **Type safety** — 0 `@ts-ignore`, 0 `as any`. `toArray<T>` tipado defensivo.

---

## 10 hallazgos priorizados

### 1. [P1] Dos design systems en paralelo; Cocoa infra-adoptado
**Evidencia:** 2.890 refs `var(--cocoa-*)` vs 5.359 usos de clases legacy (`.bo-` 3.342, `.rev-` 1.815, `.cm-` 197). Solo **26/202** pantallas importan primitivos Cocoa; **693** `<button>` crudos vs 27 con `CocoaButton`. `CocoaSplitView` (14 KB) usado por **0** pantallas. `styles.css` = 2.790 líneas de CSS legacy aún vivo.
**Impacto:** doble mantenimiento, inconsistencia visual, los 64 componentes Cocoa no rinden su inversión.
**Fix:** declarar el legacy `.bo-*`/`.rev-*` *frozen* (lint que prohíba nuevas clases legacy en pantallas nuevas — ver propuesta en `docs/audits/general-2026-06/LINT-RULE-PROPOSAL.md`). Migrar por oleadas empezando por `<button>` → `CocoaButton` y tablas → `CocoaTable`. Retirar `CocoaSplitView` si no entra en roadmap.

### 2. [P1] 3.957 estilos inline `style={{}}`
**Evidencia:** 3.957 ocurrencias de `style={{` en `src/**/*.tsx`. Ejemplo representativo en `ExchangeRatesScreen.tsx:226,231,248,259` (colores, padding, `textAlign`, `fontFamily` repetidos a mano por celda).
**Impacto:** objetos nuevos en cada render (presión GC + rompe igualdad referencial), sin reutilización, valores mágicos fuera del token system.
**Fix:** extraer estilos repetidos a clases utilitarias Cocoa o `CSSProperties` constantes a nivel de módulo (patrón ya usado bien en `CocoaTable.tsx` y `cocoa-empty-state`). Priorizar las pantallas con tablas pintadas a mano.

### 3. [P1] Chunk `screens-operations-rest` de 419 KB
**Evidencia:** `dist/assets/screens-operations-rest-*.js` = **419 KB** (el doble del main `index` de 235 KB). `vite.config.ts:105` agrupa 48 pantallas de `operations/` en un solo chunk, incluyendo diálogos enormes: `GroupDetailDialog.tsx` (1.436 LOC), `OperationsDirectorScreen.tsx` (1.240), `FrontDeskDashboard.tsx` (996).
**Impacto:** abrir cualquier pantalla de operaciones descarga ~419 KB aunque uses una sola; los diálogos pesados viajan con el dashboard padre.
**Fix:** subdividir el grupo `operations-rest` (ya se hace con `groups`/`front`/`reservations`) y/o lazy-load de los diálogos grandes (`React.lazy` para `GroupDetailDialog`, `RoomBlockGridDialog`) en vez de import estático en `GroupsEventsDashboard.tsx:5,8`.

### 4. [P2] Navegación duplicada + sidebar v2 muerto
**Evidencia:** 4 implementaciones de sidebar conviven: `navigation/Sidebar.tsx` (962 LOC, activo), `components/BackOfficeSidebar.tsx` (re-export alias de 1 línea), `components/cocoa/CocoaSidebar.tsx`, y `cocoa-sidebar-v2/` (5 ficheros, 2.207 LOC). `BackOfficeLayout.tsx:51` fija `const USE_SIDEBAR_V2 = false` → `CocoaSidebarV2` nunca se renderiza, pero `BackOfficeLayout.tsx:601` ejecuta `buildLegacySidebarV2Groups()` en carga de módulo igualmente (overhead puro).
**Impacto:** ~2.200 LOC muertas mantenidas, confusión sobre la "fuente de verdad" del menú.
**Fix:** decidir v2 sí/no. Si no entra este trimestre, borrar `cocoa-sidebar-v2/` + el código `SIDEBAR_V2_CONFIG`/`LEGACY_V2_GROUPS` de `BackOfficeLayout.tsx`. Eliminar el alias redundante `BackOfficeSidebar.tsx`.

### 5. [P2] `toArray` mandado pero usado en 13/81 pantallas
**Evidencia:** CLAUDE.md exige "usa SIEMPRE `toArray` para `data` de `useApiData`". Realidad: 81 pantallas usan `useApiData`, solo **13** usan `toArray`. Las demás confían en guards ad-hoc `?.` + `.length === 0`. Riesgo latente en `ExchangeRatesScreen.tsx:230` (`!data || data.length === 0`) — correcto hoy, pero si un endpoint devuelve `{items:[...]}` en vez de `[...]`, el guard pasa y revienta en `:254` `data.map`. Mismo patrón sin `toArray` en `CommissionsScreen.tsx:355,414`, `ExchangeRatesScreen.tsx:254`, `YearEndCloseScreen.tsx:231`, `PropertyAiScreen.tsx:473`, `OperationsDirectorScreen.tsx:1083`.
**Impacto:** la red de seguridad existe pero no se aplica; fragilidad ante cambios de forma de respuesta del API.
**Fix:** envolver toda `data` que se itere con `toArray<T>(data)` (el propio doc del helper lo pide). Opcional: lint que detecte `.map(` sobre el `data` de `useApiData` sin pasar por `toArray`.

### 6. [P2] `useApiData`: deps incompletas → footgun para mutaciones
**Evidencia:** `hooks/useApiData.ts:46` declara deps `[path, nonce, JSON.stringify(options.query ?? {})]` con `eslint-disable exhaustive-deps`, pero el fetch usa también `options.method` y `options.body` (`:33`). Si una pantalla cambia `method`/`body` sin cambiar `path`, **no refetchea**. Hoy no muerde (0 pantallas pasan `method`/`body` a `useApiData`), pero es una trampa para la primera llamada mutante.
**Impacto:** bug silencioso futuro; además `JSON.stringify(options.query)` en cada render es trabajo redundante.
**Fix:** incluir `method`/`body` serializados en la firma de deps, o documentar explícitamente que `useApiData` es solo-GET y mover mutaciones a un `useMutation`/`apiRequest` directo.

### 7. [P3] `any` concentrado en el módulo tenant-admin
**Evidencia:** ~43 usos reales de `any` (sano para 108k LOC), pero agrupados: `TenantAdminConsoleScreen.tsx:348` `useState<any[]>([])` y `:627` `<CocoaTable<any>>`; `services/tenantAdminApi.ts:25-26` `properties: any[]; users: any[]`, `:93` `Promise<any[]>`, `:97` `toArray<any>`.
**Impacto:** se pierde el chequeo de tipos justo en una consola de administración (datos sensibles multi-tenant).
**Fix:** tipar `TenantAuditRow`/`TenantProperty`/`TenantUser` en `tenantAdminApi.ts` y propagar a `CocoaTable<TenantAuditRow>`. Cambio acotado a 2 ficheros.

### 8. [P3] 12 dashboards sin estado de carga visible
**Evidencia:** 12 pantallas usan `useApiData` pero no renderizan loading/skeleton/spinner: `FiscalDashboard.tsx`, `ComplianceInbox.tsx`, `CrmDashboard.tsx`, `EnergyDashboard.tsx`, `UpsellsDashboard.tsx`, `QualityDashboard.tsx`, `AssetsDashboard.tsx`, `SustainabilityDashboard.tsx`, `GroupsEventsDashboard.tsx`, `FrontDeskCopilotScreen.tsx`, `SalesPipelineDashboard.tsx`, `AiOwnerSummaryScreen.tsx`. (El manejo de *error* sí es bueno: solo 5/81 omiten render de error.)
**Impacto:** parpadeo a "vacío" antes de que lleguen los datos; percepción de pantalla rota.
**Fix:** añadir `<LoadingBlock/>`/`<SkeletonLines/>` mientras `loading` (los primitivos ya existen en `States.tsx`). Patrón de referencia: `RevenueRulesScreen.tsx:94-117`.

### 9. [P3] Memoización de listas ausente (0 `React.memo`)
**Evidencia:** **0** usos de `React.memo`/`memo()` en 108k LOC; 599 `onClick={() => ...}` inline en pantallas. Componentes de fila/celda (p.ej. `CocoaTable` re-renderiza todas las filas en cada `setHoverKey`, `CocoaTable.tsx:104,241`) y listas grandes (`LiveTimelineWorkspace` 1.081 LOC, `RoomRackScreen`) no aíslan items.
**Impacto:** re-renders innecesarios en tablas/timelines grandes; el hover de una fila repinta toda la tabla.
**Fix:** memoizar el row component de `CocoaTable` y extraer items de listas pesadas con `React.memo` + handlers estables. No global — solo en las 5-6 vistas con N>100 filas.

### 10. [P3] Componentes monstruo (>1.000 LOC) y 49 placeholders en producción
**Evidencia:** 9 ficheros >1.000 LOC: `GroupDetailDialog.tsx` (1.436), `ReservationCreateScreen.tsx` (1.433), `BillingCenterScreen.tsx` (1.251), `OperationsDirectorScreen.tsx` (1.240), etc. Además `App.tsx` registra **49** `makeModulePlaceholder` en el `SCREEN_COMPONENTS`, y `CocoaShowcaseScreen.tsx` (1.075 LOC, dev-only) entra por defecto en `screens-operations-rest` (no aislado a un chunk dev/marketplace).
**Impacto:** ficheros difíciles de testear/revisar; código de showcase mezclado con producción.
**Fix:** trocear los diálogos >1k LOC en sub-componentes por sección. Mover `CocoaShowcaseScreen` a su propio chunk lazy/dev-gated. Mantener el budget de placeholders (`check-placeholder-budget.mjs`, cap 80) como ya hace el pre-commit.

---

## Notas de arquitectura

- **Routing:** `App.tsx` usa un mapa `SCREEN_COMPONENTS` (key → componente) + `hotelos-nav` CustomEvent + `history.pushState`, sin react-router. Funciona y es ligero, pero el "router" casero (`App.tsx:662-693`) carece de params/guards por ruta; aceptable al tamaño actual, vigilar si crece la necesidad de deep-linking con parámetros.
- **Buen patrón a replicar:** `PropertySetupForms.tsx` factoriza 14 formularios como wrappers finos sobre un único `PropertySetupFormScreen` con `formCode` (`:630-643`). Es el modelo de des-duplicación a extender a otras familias de pantallas casi-idénticas.
- **Falso positivo descartado:** `EmptyState` (legacy `.bo-empty`) y `CocoaEmptyState` (tokens) parecen duplicados, pero son los dos lados del split de design systems del Hallazgo 1, no copia accidental.

---

## Score

| Eje | Peso | Nota | Comentario |
|---|---|---|---|
| Arquitectura de componentes | 20 | 13/20 | Buenos primitivos; reuso desigual, navegación duplicada, ficheros monstruo |
| Estado (useApiData/toArray/states) | 20 | 15/20 | Hook sólido y states reutilizables; `toArray` infra-aplicado, deps incompletas |
| Performance | 20 | 14/20 | Lazy/splitting excelente; chunk 419 KB, 0 memo, inline styles |
| Type safety | 15 | 13/15 | 0 ts-ignore/as-any; `any` acotado a tenant-admin |
| Consistencia / design system | 15 | 7/15 | Dos DS en paralelo, Cocoa infra-adoptado, 3.957 inline styles |
| Accesibilidad / pulido | 10 | 8/10 | aria sólido, 0 button sin type; faltan loaders en 12 dashboards |

### **Score global: 70 / 100**

Base de ingeniería buena (camino correcto ya construido); penalizada por deuda de consistencia de UI alta pero **convergente y acotada**. Las tres acciones de mayor ROI: (1) congelar el CSS legacy + migrar a Cocoa por oleadas, (2) subdividir/lazy-load el chunk de operaciones, (3) aplicar `toArray` y loaders de forma uniforme.
