# Revisión adversarial · AUDIT-code-frontend.md

**Fecha:** 2026-06-21 · **Revisor:** senior frontend escéptico · **Método:** re-verificación con Grep/Read sobre `apps/admin-web/src` + `vite.config.ts` + `dist/` (build del 30-may, declarado por el propio audit).

**TL;DR:** auditoría sólida y honesta. La mayoría de cifras se reproducen casi exactas. Hay **una afirmación factualmente falsa** (chunking del showcase), **dos cifras infladas** (`any`, button-sin-type) que en realidad juegan a favor del código, y **un hueco de accesibilidad serio** (labels de formulario) que el 8/10 de a11y oculta. El score 70/100 es defendible; yo lo subiría a **72**.

---

## Confirmados (reproducidos al detalle)

- **F1 Dos design systems.** 3.326 refs `var(--cocoa-*)`, ~3.957 `.bo-*`, 2.481 `.rev-*`. 27 pantallas con `CocoaButton`, **694** `<button>` crudos en `screens/`, `CocoaSplitView` con **0** consumidores. Real y bien dimensionado.
- **F2 Inline styles.** **3.985** `style={{` (audit dijo 3.957; diferencia trivial). `ExchangeRatesScreen` pinta celdas a mano (`textAlign`, `fontFamily: var(--font-mono)`) confirmado en `finance/ExchangeRatesScreen.tsx:254-260`.
- **F3 Chunk 419 KB.** `dist/assets/screens-operations-rest-*.js` = **419103 bytes** exactos vs `index` 235783. Regla `vite.config.ts:105`. Confirmado al byte.
- **F4 Sidebar v2 muerto.** `BackOfficeLayout.tsx:51` `USE_SIDEBAR_V2 = false`; `:601` ejecuta `buildLegacySidebarV2Groups()` en carga de módulo igualmente. `cocoa-sidebar-v2/` = 2.207 LOC. `BackOfficeSidebar.tsx` es alias de 1 línea. Todo verificado.
- **F5 toArray infra-aplicado.** 82 ficheros usan `useApiData`, **13** usan `toArray`. El footgun de `ExchangeRatesScreen` es real: guard `!data || data.length === 0` (`:230`) seguido de `data.map` (`:254`) — si el endpoint devuelve `{items:[]}`, `.length` es `undefined`, el guard NO atrapa y revienta en `.map`. Hallazgo legítimo.
- **F6 useApiData deps.** `useApiData.ts:46` deps `[path, nonce, JSON.stringify(options.query ?? {})]`; el fetch en `:33` usa `options.method`/`options.body` **fuera** de deps. Exacto.
- **F7 `any` en tenant-admin.** Las 6 ocurrencias de `: any` están **todas** en `TenantAdminConsoleScreen.tsx:348,627` y `tenantAdminApi.ts:25,26,93,97`. Localización perfecta (ver cifra inflada abajo).
- **F8 12 dashboards sin loader.** Verifiqué los 12 uno a uno: **los 12** sin referencia a `loading`/`Skeleton`/`LoadingBlock`. Hallazgo impecable.
- **F9 0 React.memo.** Confirmado **0** en todo `src/`. `CocoaTable.tsx:104` tiene `useState(hoverKey)` y `:241` `onMouseEnter={setHoverKey}` sin `memo` en la fila → repinta toda la tabla en hover. Real.
- **F10 (parcial) Ficheros monstruo.** 9 ficheros >1.000 LOC confirmados (lista exacta). **49** `makeModulePlaceholder` confirmado.

---

## Refutados / exagerados

- **F10 — FALSO: showcase NO está en operations-rest.** El audit afirma que `CocoaShowcaseScreen` "entra por defecto en `screens-operations-rest` (no aislado a un chunk dev/marketplace)". Falso: el fichero vive en `src/screens/developer/` y `vite.config.ts:107-112` enruta explícitamente `/screens/developer/` → chunk `screens-marketplace`. La regla `operations-rest` (`:105`) sólo matchea `/screens/operations/`. **El showcase YA está aislado.** Esta es la única afirmación verificable falsa del informe.
- **"0 `<button>` sin `type=`" — exagerado (a favor del código).** El conteo real de botones sin `type` en ventana multilínea es **5**, no 0 (p.ej. `main.tsx:87`). Trivial, pero "0" es incorrecto.
- **"~43 usos de `any`" — inflado 7×.** El conteo real de `any` en posición de tipo es **6** (los 6 de F7). El "43" probablemente contó substrings (`company`, `many`…). Type safety es **mejor** de lo que el informe vende; refuerza el 13/15.
- **"709 aria-*" / "6 div onClick" — menores.** Reproduzco 725 aria y **8** div/span con onClick (no 6). Diferencias de redondeo, no cambian la tesis.

---

## Nuevos / omitidos (lo que se le escapó)

1. **[P2] A11y: labels de formulario ausentes.** **414** `<input>` vs sólo **11** `htmlFor`. Casi ningún input tiene `<label htmlFor>` asociado. El audit midió `aria-*` en bruto (725) y concluyó "a11y por encima de la media / 8-10", pero **no comprobó binding label↔input**, que es WCAG 1.3.1 / 3.3.2 básico. Esto debería bajar el eje de accesibilidad. **El 8/10 está sobrevalorado.**

2. **[P2] Filas clicables sin teclado.** `SafetyDashboard.tsx:161`, `MaintenanceDashboard.tsx:189`, `WorkforceDashboard.tsx:165,189` usan `<div>/<span>` con `cursor:pointer` + `onClick` y **sin** `role`, `tabIndex` ni `onKeyDown`. Inaccesibles por teclado. El audit los contó como "6 div onClick" pero no señaló la implicación a11y.

3. **[P3] Modales sin focus trap real.** **74** `role="dialog"`/`aria-modal` pero sólo **7** `.focus()` y 14 `autoFocus`. Hay manejo de `Escape` en los diálogos Cocoa, pero no veo trampa de foco (Tab no queda confinado). `CommandPalette.tsx:167` y `SubmissionDetailPanel.tsx:96` son overlays `role="dialog"` sin gestión de foco visible. Omitido.

4. **[P3] Single error boundary global.** Sólo **1** `ErrorBoundary` (Sentry, en `main.tsx:57`) envolviendo TODA la app. No hay boundaries por ruta/pantalla: una pantalla que lance en render tumba la app entera a la pantalla de error de Sentry en vez de degradar localmente. (Hay una clase boundary suelta en `CocoaGalleryScreen.tsx` pero es dev/preview.) El audit no menciona error boundaries pese a que el prompt de arquitectura lo justifica.

5. **[P3] `useApiData` polling recrea el intervalo en cada cambio de data.** `useApiData.ts:49-57`: el efecto de polling depende de `[path, data, options.pollIntervalMs]`. Como `data` cambia en cada fetch, el `setInterval` se destruye y recrea continuamente; además `options.pollWhile` (función nueva por render) se captura por stale-closure salvo por el `data` en deps. Matiz no trivial que F6 rozó pero no desarrolló. (Mérito: cleanup de intervals/timeouts es **correcto** en el resto — 5 setInterval / 4 clearInterval, el 5º es un comentario; 73 addEventListener / 75 removeEventListener. Sin fugas evidentes.)

**No encontré** prop drilling significativo (`activeProperty` pasa por contexto, no por props; **0** `activeProperty=` en screens), ni `dangerouslySetInnerHTML` (0 → sin XSS por innerHTML).

---

## Veredicto

El informe es **honesto, verificable y bien calibrado en P1-P2**. Comete un error factual (chunk del showcase) e infla dos métricas de type-safety/buttons que paradójicamente subvaloran el código. Su punto ciego real es **accesibilidad de formularios y foco**, que el 8/10 esconde: medir `aria-*` en bruto no equivale a auditar a11y. Falta también el ángulo de **error boundaries granulares**. Nada de esto invalida la tesis central ("deuda convergente, no estructural"), que comparto.

Ajuste de ejes que propondría: Accesibilidad 8→**6** (labels), Type safety 13→**14** (any real = 6). Neto ≈ +2.

### **Score revisado: 72 / 100** (audit decía 70 — dentro de tolerancia, ligeramente generoso en a11y, ligeramente duro en types).
