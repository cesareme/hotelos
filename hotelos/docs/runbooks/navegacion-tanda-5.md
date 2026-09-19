# Navegación de la Tanda 5 — runbook (L1: L1a · L1b · L1c)

Plan: `docs/audits/TANDA-5-PLAN-2026-09-15.md` (§2 principios, §4 criterios de cierre).
Árbol: `~/anfitorio-demo/pilots/tanda5-nav-tree.csv` (fuente única, fuera del repo) y su explicación
`pilots/tanda5-nav-tree.md` (§1 árbol, §3 roles, §5 redirecciones, §6 gating, §11 tareas frecuentes, §12 plan).
Este runbook explica cómo se compone el menú a partir de ese árbol, cómo se añade una pantalla o una
pestaña, cómo se migran los formateadores, cómo se gatea por módulo y por rol, cuál es el contrato del
router y del menú que cierra L1 y qué hizo cada lote (L1a → L1b → L1c). Tests de contrato:
`tests/nav-tree-contract.test.mjs` (árbol y generador), `tests/sidebar-nav-contract.test.mjs` (menú, gate y
guía), `tests/product-route-maps-contract.test.mjs` (mapa de producto) y las suites de `pnpm test` que leen
`App.tsx` y `routes/backoffice.routes.tsx`.

## Cómo se compone el menú

```
pilots/tanda5-nav-tree.csv  ──(node scripts/build-nav-tree.mjs)──▶  apps/admin-web/src/navigation/nav-tree.generated.json
pilots/tanda5-nav-tree.md §1 (solo el ORDEN de ítems y pestañas)            │
git 78edb35:routes/backoffice.routes.tsx (205 rutas antiguas → legacyRoutes) │
                                                                             ▼
                 apps/admin-web/src/navigation/nav-tree.ts    (carga tipada + helpers puros + modelo del menú)
                 apps/admin-web/src/navigation/role-tokens.ts (tokens de rol, resolveRoleTokens, canSee, navVisibility)
                 apps/admin-web/src/navigation/useEnabledModules.ts (useRoleTokens · useEnabledModules · useNavGate · useNavAudience)
                                    ▲ sesión: services/usersApi.ts (GET /users/me → snapshot en auth-storage) · services/modulesApi.ts (módulos activos)
                                                                             ▼
                 Sidebar.tsx · CommandPalette.tsx (⌘K) · App.tsx · routes/backoffice.routes.tsx · screens/tabs/** · components/guide/**
                 (leen el JSON y los hooks; ninguno copia el árbol)
```

1. **El CSV es la única fuente**: 262 filas (`screenKey;estadoActual;decision;destino;etiquetaES;url;tab;roles;modulo;justificacion`).
   `keep` = ítem de menú con URL propia · `merge-into` = pestaña o sub-URL de un `keep` (`destino` = pantalla padre) ·
   `dev-only` = placeholder honesto bajo `/desarrollo/*`, solo `?dev=1` + administrador de plataforma ·
   `retire` = desaparece (`destino` = qué la cubre) · `duplicate-of` = alias de clave de `SCREEN_COMPONENTS` que
   el router conserva una tanda (`LEGACY_SCREEN_KEYS` = `aliases`, 24).
2. **El generador** `node scripts/build-nav-tree.mjs` escribe `nav-tree.generated.json` (SÍ va al repo; el CSV no).
   Valida el CSV (URLs únicas, kebab-case, sin `/backoffice`, roles conocidos, pestañas con roles ⊆ ítem, dev-only
   bajo `/desarrollo/*`, etiquetas ≤ 28 caracteres) y falla en voz alta si algo no cuadra. `--check` no escribe:
   sale con 1 si el JSON está desactualizado (el test de contrato lo ejecuta cuando el CSV existe en local).
   El orden de ítems y pestañas se lee de las tablas §1 del `.md` (el CSV no tiene columna de orden); si el `.md`
   no está, se usa el orden del CSV. Cifras actuales: 9 categorías · 66 ítems · 94 pestañas · 20 dev-only ·
   2 públicas · 205 redirecciones · 24 alias · 72 retiradas.
3. **Forma del JSON**:
   ```
   { meta: { source, generator, orderSource, legacyRoutesSource, counts },
     categories: [{ key, label, items: [{ screenKey, label, url, baseTab, roles, modulesAny,
                                          tabs: [{ screenKey, label, url, roles, modulesAny, detail? }] }] }],
     legacyRoutes: [{ from, to }],          // 205 rutas /backoffice/* → URL nueva
     devOnly:      [{ screenKey, label, url, roles, modulesAny, parent }],
     retired:      [{ screenKey, coveredBy, url }],
     aliases:      [{ screenKey, canonical, url }],
     publicScreens:[{ screenKey, label, url }] }
   ```
   `baseTab` es la etiqueta de la pantalla base cuando ella misma es la primera pestaña («Recepción» en Mi día,
   «Modelo 303» en Modelos AEAT); `detail: true` marca sub-URLs con parámetro (`:id`, `:codigo`, `:propiedad`)
   que el router registra pero ninguna tira de pestañas pinta.
4. **Carga tipada** (`navigation/nav-tree.ts`, funciones puras, sin `window`):
   `NAV_TREE` / `NAV_CATEGORIES` · `findByUrl(pathname)` (estática gana a `:param`) · `findByScreen(key)` (sigue alias y
   retiradas) · `urlForScreen(key, params?)` · `allUrls()` (lo que el router registra) · `resolveLegacyPath(pathname)`
   (§5; parámetros por posición; si la URL nueva necesita un parámetro que la antigua no tenía, se corta antes de él y
   aterriza en el ancestro estático) · `visibleCategories(tokens, modulosActivos)` / `countVisible` ·
   `paintableTabs(item, …)` · `landingTabFor(item, …)` · `menuEntriesUnlockedBy(codigoModulo)` (§6.2) ·
   `gatingModuleCodes()` · `isDevOnlyPath` / `isDevModeEnabled({ search, storageValue })` (`?dev=1` o
   `localStorage["anfitorio.dev"] = "1"`).
5. **Modelo del menú** (mismo fichero, L1b): `menuCategories(tokens, modulosActivos, { canEnableModules, devMode })`
   devuelve las categorías con cada ítem `visible` o `locked` (módulo apagado y el usuario tiene `modules.enable`:
   atenuado con «Activar módulo» y `lockedBy`); sin token solo entran las entradas que todo rol abre (Mi día,
   Asistente) y la barra muestra `UI_STATES.noRole`; con `devMode` y el token `admin` se añade «Desarrollo» con las
   20 dev-only. Nunca una categoría vacía. `flatMenuEntries(categorías, { includeTabs })` es el catálogo plano que
   consume ⌘K (`components/CommandPalette.tsx`: ítems y pestañas visibles para el rol, con `url` y `tab`);
   `landingFor(tokens, { mobile, templateKey })` es el aterrizaje de la sesión (§3) como `{ url, screenKey }`;
   `activeMenuItemFor(screenKey)` marca el ítem activo; `enableModuleTarget(item)` apunta a
   `/configuracion/modulos#modulo=<código>`; `countMenu`, `menuItemMatches` y `normalizeMenuText` sirven al buscador
   de la barra.
6. **Tokens de rol** (`navigation/role-tokens.ts`): `direccion recepcion pisos mantenimiento revenue finanzas comercial
   fnb admin publico`, derivados del `templateKey` de los roles del usuario en la propiedad ACTIVA (`GET /users/me`,
   `properties[].templateKeys`) más `admin` cuando `isPlatformAdmin`: owner y manager → direccion · receptionist →
   recepcion · housekeeper → pisos · maintenance → mantenimiento · accountant y compliance → finanzas · revenue →
   revenue · sales → comercial · fnb → fnb. `resolveRoleTokens({ templateKeys, isPlatformAdmin, grantedPermissions,
   templatePermissions })` devuelve `{ tokens, templateKey }` (unión de plantillas, la más amplia primero, `templateKey`
   = la más privilegiada para decidir la pestaña de aterrizaje); un rol personalizado sin plantilla cae al único
   heurístico que queda, `templatesCoveredByPermissions` (plantillas cuyas claves están TODAS en los grants reales,
   nunca en la unión demo de :3000), y si ninguna encaja no aporta token. `roleHome` / `roleHomeForTokens` dan la URL
   de §3 (`/hoy/propietario` para la plantilla owner, `/hoy/direccion` para manager, revenue, finanzas, comercial y
   admin, `/hoy` para recepción, `/hoy/operaciones` para pisos, mantenimiento y F&B; con viewport < 700 px pisos
   aterriza en `/operaciones/pisos/mi-turno` y mantenimiento en `/operaciones/mantenimiento/mis-averias`).
   `roles.ts` (vistas por persona en `localStorage hotelos.role.v1`) se retiró en L1b: no existe y nada lo importa.
7. **Sesión y hooks** (`navigation/useEnabledModules.ts`, un solo gate para Sidebar, ⌘K, contenedores y guía):
   - `services/usersApi.ts`: `fetchCurrentUserProfile()` memoiza `GET /users/me` por sesión; al cargar copia el
     snapshot de rol (`isPlatformAdmin`, `templateKeys`, `templateKeysByProperty`, `grantedPermissions`, campos
     opcionales de `AuthUser` en `services/auth-storage.ts`) junto a la sesión con `setSession` (dispara
     `hotelos-auth-changed` una sola vez y solo si cambió), así que tras un F5 los tokens se conocen de forma síncrona
     (`getSessionRoleSnapshot`) y solo se espera la lista de módulos. `POST /auth/login` ya envía `isPlatformAdmin`.
   - `services/modulesApi.ts`: `fetchEnabledModules(propertyId)` con caché de sesión por propiedad;
     `setPropertyModuleState` (PATCH `/backoffice/properties/:id/modules/:code`) invalida la caché y emite
     `ENABLED_MODULES_CHANGED_EVENT` (`hotelos-enabled-modules-changed`): todo consumidor montado vuelve a leer.
   - `useRoleTokens(propertyId)` → `{ tokens, templateKey, isPlatformAdmin, grantedPermissions, canEnableModules,
     known, loading }` · `useEnabledModules(propertyId)` → `{ modules, loading, error, refresh }` (`[]` mientras carga
     o tras un 403 sin `modules.read`) · `useNavGate()` = ambos + `isVisible(gate)` (sin token solo aplica el gate de
     módulo) · `useNavAudience()` → `{ roleTokens, enabledModules | undefined, loading }` para la guía (`tourStepsFor`
     no aplica gates de módulo mientras la lista es desconocida).
   - «Ver como…» (`Sidebar.tsx`): solo con `isPlatformAdmin`, un `useState` en memoria que sustituye los tokens del
     menú por el token elegido (cerrar la pestaña termina la simulación; no toca permisos del API ni `localStorage`).
   - Grupo «Desarrollo»: `isDevModeEnabled` + token `admin`; el router aplica el mismo guard (ver contrato).

## Cómo añadir una pantalla o una pestaña

1. **Añade la fila al CSV** (no inventes etiquetas ni URLs fuera de él): `decision` keep para un ítem, merge-into para
   una pestaña (con `destino` = `screenKey` del ítem), `url` kebab-case en español bajo la categoría, `roles` con
   `|` (las de una pestaña ⊆ las del ítem), `modulo` = código que devuelve 403 cuando está desactivado, o `core`.
   Máximo 12 ítems por categoría (§4): si la categoría está llena, entra como pestaña.
2. `node scripts/build-nav-tree.mjs` y revisa el diff del JSON. `corepack pnpm test` (contratos) y los unitarios de
   navegación deben seguir verdes:
   `cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/navigation/__tests__/*.test.mts`.
3. **Pantalla nueva** (`keep`): créala en `apps/admin-web/src/screens/**` con `CocoaPageHeader` arriba y el diccionario
   de `content/actions.ts`; regístrala en `SCREEN_COMPONENTS` (App.tsx, `lazyNamed(() => import(…), "Export")`). La
   ruta sale sola: `BACKOFFICE_ROUTES` deriva de `allUrls()` y `check-route-validity` exige que toda clave del árbol
   esté en `SCREEN_COMPONENTS` y viceversa. Si sustituye a una antigua, la fila `retire` del CSV y la redirección
   `/backoffice/*` → URL nueva quedan en `legacyRoutes`.
4. **Pestaña nueva** (`merge-into`): el ítem padre es un contenedor `NavItemTabs` (`screens/tabs/<categoría>/<Item>Tabs.tsx`,
   38 hoy). El contenedor solo aporta el loader perezoso de cada clave; etiquetas, URLs, roles, `modulesAny`,
   `detail` y el aterrizaje por rol salen del JSON (`screens/tabs/nav-item-tabs.ts`: `buildItemTabs`,
   `landingKeysFor`, `detailParamsFor`):

   ```tsx
   // apps/admin-web/src/screens/tabs/recepcion/ReservasTabs.tsx (ejemplo)
   import { NavItemTabs } from "../NavItemTabs";
   import type { TabLoaders } from "../nav-item-tabs";

   const LOADERS: TabLoaders = {                        // a nivel de módulo: el loader debe ser estable
     ReservationsListScreen: () => import("../../reservations/ReservationsListScreen").then((m) => ({ default: m.ReservationsListScreen })),
     RoomRackScreen: () => import("../../operations/RoomRackScreen").then((m) => ({ default: m.RoomRackScreen })),
     ReservationDetailWorkspace: () =>
       import("../../reservations/ReservationWorkspaceScreen").then((m) => ({ default: m.ReservationDetailWorkspaceScreen }))
     // … una clave por pestaña del ítem (ReservationImportScreen, GuestJourneyWorkspace); la antigua pestaña Cronograma es hoy Hoy › Live Timeline (fusión TL)
   };
   export default function ReservasTabs() {
     return <NavItemTabs screenKey="ReservationWorkspace" loaders={LOADERS} subtitle="…" />;
   }
   ```

   - `NavItemTabs` pinta UNA `CocoaPageHeader` (eyebrow = categoría —o «Categoría · <sociedad o centro>» cuando la
     pantalla alojada registra un eyebrow que prolonga esa misma categoría: `useHostedEyebrow` desde `CocoaPage` /
     `HostedHead`, `containerEyebrow` de `nav-item-tabs.ts`; cualquier otro eyebrow se ignora (Tanda 6b · L7, diseño
     §5.3 «FINANZAS · <sociedad>»)—, título = etiqueta del ítem), el error de la
     lista de módulos si no se pudo leer, un `CocoaTabSkeleton` mientras el gate carga y `CocoaRouteTabs` con
     `isVisible = gate.isVisible` y `defaultTab`/`mobileDefaultTab` de `landingKeysFor`. Una tira con una sola pestaña
     pintada se oculta por CSS (una pestaña no es una elección). `baseRoles` estrecha los roles de la pestaña base
     («Recepción» de Mi día no es para pisos/fnb); `tabFilter` descarta pestañas en una URL concreta.
   - **Contenedor sin pestañas visibles** (qa#12): `emptyTabsReason` (`nav-item-tabs.ts`) distingue la causa y el
     contenedor pinta un `CocoaState kind="empty"` en lugar de la tira (atributo `data-nav-empty="module|modules_unknown|role"`
     en `.anf-nav-tabs` para las sondas): módulo desactivado para un perfil al que el ítem sí va → «Módulo no activado»
     con «Activar módulo» si el usuario tiene `modules.enable` (mismo destino que el Sidebar, `ModuleManager#modulo=<código>`)
     o «Pide a dirección que lo active…» si no; lista de módulos ilegible (403 o fallo de carga) → «Secciones no disponibles»
     sin afirmar que el módulo esté apagado (con fallo de carga solo se pinta el `ErrorState` con «Reintentar»); ningún
     rol del perfil en el ítem → `UI_STATES.forbidden` («Sin acceso»). El texto genérico de `CocoaRouteTabs` («No hay
     secciones disponibles para tu perfil») ya no se alcanza desde un contenedor.
   - **Pantalla alojada: UNA convención** (`screens/tabs/TabHost.tsx`). Dentro del contenedor la pantalla lee
     `useTabHost()` (null si va sola; `{ screenKey, basePath, title }` dentro) y, si hay host, no pinta ni eyebrow ni H1
     —el contenedor ya los lleva— y conserva subtítulo, vistas internas y su fila de acciones (`HOSTED_ACTIONS_ROW`
     / `HOSTED_TOOLBAR`, o `HostedHead` de `screens/tabs/tab-helpers.tsx`). El contenedor no le pasa nada: el
     contexto es la fuente. `pageHead(embedded?)` (`tab-helpers.tsx`) devuelve un componente con las mismas props
     que `CocoaPageHeader` que ya decide por el contexto (`embedded: true` solo lo fuerza), así que una pantalla escrita
     como `const Head = pageHead(embedded)` ya está en la convención y su prop sobra. Puente pendiente: 15 pantallas
     ramifican a mano sobre una prop `embedded` (`{embedded ? null : <h1>…}`) y su loader las envuelve con
     `embed(m.Pantalla)` (lista en `TabHost.tsx`); migrar una = leer `useTabHost()`, quitar la prop y volver el loader a
     `{ default: m.Pantalla }`. `useRouteParam(patrón, nombre)` lee `:codigo`/`:id` de una sub-URL de detalle;
     `shellNavigate(screen)` es el `hotelos-nav` sin tipar para pantallas con `onNavigate?`.
   - La pestaña activa **es la URL** (`/x/y/:tab`): F5 y enlaces compartidos la conservan; la query (`?desde=…`) se
     mantiene al cambiar de pestaña (`preserveQuery`, por defecto true); el hash se descarta.
   - Aterrizaje en la URL base: `defaultTab` (o `mobileDefaultTab` por debajo de `mobileBreakpoint`, 700 px) y se
     escribe con `replaceState` (sin entrada extra en el historial). `landingTabFor(item, tokens, modules, { mobile,
     templateKey })` de `nav-tree.ts` da el valor por rol.
   - Guardas: antes de cambiar se emite `hotelos-tab-nav` (cancelable, `detail: { basePath, from, to, href }`); una
     pantalla con borrador hace `event.preventDefault()` en un listener de captura, guarda `detail` y, al confirmar,
     llama a `commitTabNavigation(detail)`. `hotelos-nav` (App.tsx) no se toca: el contenedor solo lo escucha para
     re-sincronizarse cuando la barra lateral navega al ítem.
   - Enlace profundo a una pestaña desde fuera (⌘K, chips, «Cancelar» de un formulario):
     `openTabPath(urlForScreen("SetupCenterScreen"))` (pushState + `popstate`; la URL debe existir en el árbol).
     Dentro del contenedor, `useRouteTabs().select(key)`. Nunca `<a href>` a una ruta interna: recarga la aplicación.
   - Accesibilidad: `role=tablist/tab/tabpanel`, activación manual (flechas, Inicio y Fin mueven el foco; Intro o
     espacio activan: cada panel es una ruta perezosa y no debe cargarse al pasar con las flechas).
   - Carga perezosa: `React.lazy` por pestaña (una instancia por `key` durante la vida del contenedor) con
     `CocoaTabSkeleton` como fallback; define los loaders a nivel de módulo.
   - Exporta el contenedor desde `apps/admin-web/src/screens/tabs/index.ts` (una línea) y regístralo en
     `SCREEN_COMPONENTS` con `lazyTab("NombreTabs")` para la clave del ítem Y para cada clave de pestaña (todas
     apuntan al mismo contenedor; el router resuelve la clave de pestaña a su URL). `check-sidebar-coverage` reconoce
     la pantalla alojada por el `m.Export` del loader; `nav-tree-contract` exige que cada export del índice resuelva a
     un fichero con `export default`.
   - `CocoaPageHeader` no cambia: el contenedor va debajo de la cabecera. Si una pantalla quiere pintar las pestañas en
     la propia cabecera (`tabs`/`activeTab`/`onTabChange`), usa `useRouteTabs()` para la lógica de URL, con la
     salvedad de que el control segmentado de la cabecera no tiene navegación por teclado entre pestañas.
5. **Placeholder honesto**: solo como `dev-only` bajo `/desarrollo/<slug>` con `roles = admin`; nunca «Próximamente»
   en el menú (presupuesto 20 = los 20 dev-only del CSV, `scripts/check-placeholder-budget.mjs`).
6. **Detalle con parámetro** (`/recepcion/huespedes/:id`): fila `merge-into` con `:id` en la URL; el JSON la marca
   `detail: true`; la tira no la pinta pero el router la registra y `findByUrl` la resuelve con `params`. Desde una
   pantalla se abre con `urlForScreenWithParams("GuestDetail", { id })` (router) u `openTabPath(urlForScreen(key, { id }))`.

## Cómo migrar formateadores

Un solo módulo: `apps/admin-web/src/lib/format.ts` (es-ES, `Europe/Madrid`, `EMPTY = "—"` para nulos,
`DEFAULT_CURRENCY = "EUR"`, instancias de `Intl` cacheadas). **Hecho en L1c (lote formato-copy)**: 0 `Intl.NumberFormat` /
`Intl.DateTimeFormat`, 0 `toLocale*String()`, 0 `toFixed(n)` pegado a «€»/«%» y 0 «… EUR» en JSX en `screens/**` (los
formateadores locales que quedan son envoltorios de una línea sobre `format.ts`, p. ej. `function fmtEur(v) { return money(v); }`);
lo vigila `tests/admin-web-spanish-copy-contract.test.mjs`. Reemplazos:

| Hoy en la pantalla | Sustituir por |
|---|---|
| `new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(v)` | `money(v)` |
| `formatMoney(v)` local que quita decimales a los enteros | `money(v, "EUR", { decimals: "auto" })` |
| `` `${v.toFixed(2)} €` `` / `` `${v} EUR` `` | `money(v, record.currency)` (la moneda viene del dato; `null`/`undefined`/`""` → `DEFAULT_CURRENCY`; sin dato: `money(v)` o `money(v, { decimals: 0 })`, nunca `"EUR"` literal) |
| `v.toLocaleString()` | `number(v)` · KPI compacto: `number(v, { compact: true })` |
| `` `${v.toFixed(1)} %` `` / `pctFormat.format(v)` | `percent(v)` (unidades de porcentaje) · `percent(r, { ratio: true })` para 0,125 · `signDisplay: "always"` para variaciones |
| `new Date(iso).toLocaleDateString("es-ES")` | `date(iso)` («15/09/2026») · `"medium"` («15 sept 2026») · `"long"` · `"weekday"` («martes, 15 de septiembre») · `"weekdayShort"` («mar, 15 sept») · `"weekdayOnly"` («mar») · `"dayMonth"` («15 sept») · `"monthYear"` («sept 2026») |
| `toLocaleTimeString`, `getHours()`/`getMinutes()` a mano | `time(iso)` («14:05», hora del hotel, no del navegador) · `time(iso, { seconds: true })` · `dateTime(iso)` («15/09/2026, 14:05») · `dateTime(iso, { style: "medium" })` («15 sept 2026, 14:05») · `{ style: "dayMonth" }` («15 sept, 14:05») |
| rangos «12–18 mar» a mano | `dateRange(desde, hasta)` (`formatRange` de Intl: no repite mes ni año) |
| «hace 3 min» a mano | `date(iso, "relative")` / `relativeTime(iso, now)` («ayer», «hace 5 horas», «dentro de 3 días») |
| `` `${n} reserva${n === 1 ? "" : "s"}` `` | `plural(n, "reserva", "reservas")` («1.250 reservas») |
| `"YYYY-MM-DD"` a mano para el API | `isoDate(fecha)` (día natural en Madrid) |

Cómo se hizo el codemod (repetible): un guion de sustituciones exactas por fichero (cada `old` debe aparecer una sola vez o el
fichero no se toca) que (a) reescribe el cuerpo de cada formateador local como envoltorio de `format.ts` conservando su nombre
y sus llamadas, (b) sustituye las llamadas en línea (`new Date(x).toLocaleDateString("es-ES")` → `date(x)`, `x.toLocaleString("es-ES")`
→ `number(x)`, `{x} EUR` → `money(x, row.currency)`, `${p.toFixed(1)} %` → `percent(p, { minimumFractionDigits: 1, maximumFractionDigits: 1 })`)
y (c) añade o funde el `import { … } from "…/lib/format"`. Colisiones: si el fichero ya tiene un identificador `date`/`money`/`number`
(p. ej. `const date = addDays(...)` o el `money` de `services/revenueApi.ts`), renombra la variable local o importa con alias
(`date as formatDate`); `services/revenueApi.ts` conserva su `money()` solo para `apps/mobile` (traspaso: retirarlo).
Equivalencias de estilo: `{ day: "2-digit", month: "short" }` → `"dayMonth"`; `+ year` → `"medium"`; `{ weekday: "short" }` →
`"weekdayOnly"`; `{ month: "short", year: "2-digit" }` → `"monthYear"`; `dateStyle: "medium", timeStyle: "short"` →
`dateTime(x, { style: "medium" })`; `{ notation: "compact" } + " €"` → `money(x, { compact: true })`; `Math.round(p * 100) + "%"` →
`percent(p, { ratio: true, maximumFractionDigits: 0 })`; `"+" + x + " %"` → `percent(x, { signDisplay: "always" })`.

Reglas al migrar: (1) nunca renderizar `0`, `NaN` o `Invalid Date` donde falta el dato — los helpers devuelven `—`
(o el `empty` que se les pase: `money(null, "EUR", { empty: "sin tarifa" })`); (2) las fechas `YYYY-MM-DD` son días
naturales y se formatean como tal aunque la máquina esté en otra zona; los instantes ISO se muestran en hora de
Madrid; (3) el `currency` sale del folio, la tarifa o la propiedad, no de un literal; (4) los helpers de
`cocoa-rate-grid/helpers.ts` (`formatMoney` con `sin tarifa`, signo «−» tipográfico) son de la parrilla y no se tocan
en L1: son un buen candidato a envolver `format.ts` cuando ese lote lo decida; (5) tests: comparar tras normalizar
` `/` ` a espacio (ICU cambia el separador entre versiones), como hace `lib/__tests__/format.test.mts`; (6) un código de
moneda mal formado tecleado por el usuario («euros») no lanza: `money()` pinta el número y el código tal cual; (7) los valores de
formulario y las `<option value="EUR">` son datos, no copy: pueden seguir usando `DEFAULT_CURRENCY` (nunca `"EUR"` en un
formateador ni en JSX).

Diccionario de acciones y estados (`apps/admin-web/src/content/actions.ts`): `ACTIONS` (Guardar, Cancelar, Publicar,
Revertir, Archivar, Activar módulo, Reintentar, Exportar, Editar, Ver, Buscar, Filtrar, Limpiar filtros…),
`newLabel("f", "reserva")` («Nueva reserva»), `STATUS_LABELS` (Cargando…, Sin resultados, Error al cargar, Activo,
Pendiente…), `TIME_LABELS` (Hoy, Ayer, Últimos 7 días…), `FIELD_LABELS`, `A11Y_LABELS`, `PAGINATION`, `UI_STATES`
(loading, empty, noResults, error, saveError, forbidden, notFound, moduleDisabled, noRole, offline) con
`emptyStateFor("reservas")`, `errorStateFor("las reservas")`, `loadingLabel("reservas")` y las confirmaciones
`confirmDelete("la reserva RS-1024")`, `confirmDiscard()`, `confirmAction(...)` para `ConfirmDialog`.

## Cómo gatear por módulo y por rol

Un ítem o pestaña se muestra si (a) el usuario tiene alguno de sus `roles` y (b) alguno de sus `modulesAny` está
activo en la propiedad. El árbol NO lleva permiso por ítem: `grantedPermissions` (reales, nunca la unión demo) solo
decide «Activar módulo» (`modules.enable`) y el fallback de roles personalizados sin plantilla (§10: deltas de
plantilla en `permissions.ts`, L1b api-side: cada GET que abre una pantalla del árbol exige su clave de lectura).
Si algún día se quiere el filtro estricto por permiso, va como columna `permiso` del CSV y se consume en
`menuCategories` con `permissionsAny`.

- **Por rol**: `canSee(item, roleTokens, enabledModules)` de `role-tokens.ts`; `roles` vacío o `publico` → todos.
  El administrador de plataforma ve todo lo que no esté gateado por módulo y dispone de «Ver como…» (simula el filtro
  del menú, no cambia permisos del API).
- **Tokens de la Tanda 8a (RBAC por departamento y nivel, `docs/design/RBAC-DEPARTAMENTOS.md` §4.2 / §5.1)**: a los
  nueve tokens de la Tanda 5 se suman `administracion`, `rrhh`, `propiedad`, `activos`, `auditoria` y `sistemas`
  (16 con `publico`; `ROLE_TOKENS` de `role-tokens.ts`, `ROLE_TOKENS` de `scripts/build-nav-tree.mjs` y
  `tests/nav-tree-contract.test.mjs` van a la par). El token `admin` es SOLO el administrador de plataforma
  (`isPlatformAdmin`): ninguna plantilla lo produce. Mapa plantilla → token (`ROLE_TEMPLATE_TO_TOKEN`, 24 plantillas):
  receptionist · night_auditor · front_office_manager → `recepcion`; housekeeper · housekeeping_manager → `pisos`;
  maintenance · maintenance_manager → `mantenimiento`; fnb · fnb_manager → `fnb`; sales → `comercial`; admin_clerk →
  `administracion`; manager · operations_director · general_manager (· break_glass, la sesión de emergencia) →
  `direccion`; revenue → `revenue`; accountant · controller · compliance → `finanzas`; payroll_hr → `rrhh`;
  asset_manager → `activos`; owner → `propiedad` (ya no `direccion`); auditor → `auditoria`; admin (plantilla de
  organización) → `sistemas`. Prioridad multi-rol (`ROLE_TOKEN_PRIORITY`): admin, sistemas, direccion, propiedad,
  auditoria, finanzas, rrhh, activos, revenue, comercial, administracion, recepcion, fnb, mantenimiento, pisos.
  Aterrizajes nuevos (`roleHome`): `administracion` → `/finanzas/facturacion`, `rrhh` → `/finanzas/nominas`,
  `propiedad` → `/hoy/propietario`, `activos` → `/cumplimiento/centro` (hasta que exista Finanzas › Activo
  inmobiliario), `auditoria` → `/configuracion/sistema`, `sistemas` → `/configuracion/usuarios`; `rrhh`, `activos` y
  `sistemas` no ven Mi día. Sin token (rol personalizado sin plantilla) el menú queda vacío y el shell muestra
  `UI_STATES.noRole`: ninguna fila del árbol lista ya los quince tokens autenticados. El mapa token → plantillas
  con los recuentos por token está en `pilots/tanda5-nav-tree.md` §3.1.
- **Una decisión para menú, router y contenedores (Tanda 8a · L4)**: `accessDecision(entry, scope)` de
  `navigation/access-decision.ts` → `visible | locked | hidden-role | hidden-module | dev-locked` (tokens del árbol
  × módulos × modo dev; nunca permisos). La consumen `menuCategories` (menú y ⌘K), `resolveLocation` de
  `routes/backoffice.routes.tsx` cuando el guard lleva `tokens` (`RouteGuardInput`; `DevGuardInput` es su alias) y
  devuelve `{ kind: "forbidden", reason: "role" | "module" }`, y `RouteAccessGate` de `App.tsx`, que envuelve
  `<ActiveScreen />` con el gate de `useNavGate()` (tokens ya simulados por «Ver como…»): mientras `gate.loading`
  pinta el estado de carga (nunca decide con tokens vacíos), con `hidden-role` / `hidden-module` (lista de módulos
  conocida) pinta `UI_STATES.forbidden` / `moduleDisabled` con «Ir a Mi día», y cubre la URL, `popstate`,
  `hotelos-nav` y ⌘K; al cambiar de propiedad se re-resuelve. Una pestaña solo abre si abre su ítem
  (`tabAccessDecision`). Pruebas: `navigation/__tests__/access-decision.test.mts` (tabla de casos y equivalencia con
  `canSee` / `navVisibility` para todas las entradas × tokens), `routes/__tests__/route-access.test.mts` (∀ URL ×
  ∀ token: `resolveLocation(...).kind === "screen"` ⇔ `canSee`) y `node scripts/check-route-access.mjs` (misma tabla
  sobre el JSON committed, sin CSV; imprime los ítems y pestañas por token).
- **«Ver como…» por ámbito (Tanda 8a)**: lo ofrece `gate.canViewAs` (administrador de plataforma, o `users.assign` /
  `roles.manage` en las concesiones reales de la propiedad activa, evaluado en `useEnabledModules.ts`, nunca en
  `role-tokens.ts`), limitado a los tokens con alguna plantilla de rango ≤ el propio (`maxViewAsRank` =
  `ROLE_LEVEL_RANK` de `ROLE_TEMPLATE_LEVEL`; `viewAsTokensFor` en `view-as.ts`); simula tokens y módulos, nunca
  permisos, y lo aplica también el router. Banner «Viendo como Recepción · solo menú».
- **Por módulo**: la columna `modulo` está calcada del API (§9): solo `guest_data_crm_loyalty`, `reputation_quality`,
  `procurement_inventory`, `workforce_labor`, `safety_incident_management`, `hotel_intelligence_platform`,
  `guest_self_service` (devuelven 403 desactivados) y los tres gates de producto `outlet_pos`, `distribution_hub`,
  `revenue_profit_engine`. Todo lo demás es `core` (gatear una pantalla que responde 200 escondería funcionalidad sin
  motivo). `enabledModules` viene de `GET /backoffice/properties/:id/modules` (`useEnabledModules(propertyId)`) y
  mientras carga se pasa `[]`: lo gateado se oculta hasta saber, así nunca abre un 403. Un módulo sin fila en
  `property_modules` cuenta como su `enabledByDefault` del manifiesto (§14.1, reversible en
  `DEFAULT_ENABLED_MODULE_CODES`); una fila explícita siempre gana.
- **Descubrimiento sin 403** (§6.3): `navVisibility(item, tokens, modules, { canEnableModules })` devuelve `visible`,
  `locked` (atenuado con «Activar módulo», solo para quien tiene `modules.enable`) o `hidden`; `menuCategories` lo
  aplica y `enableModuleTarget(item)` lleva a `/configuracion/modulos#modulo=<código>`. `menuEntriesUnlockedBy(code)`
  alimenta en «Módulos e integraciones» la lista «qué entradas del menú desbloquea».
- **Gate a nivel de acción** (§6.4): cuando el API gatea solo escrituras (crear reservas de un grupo,
  `groups_events_sales`), el ítem sigue `core` y el botón se deshabilita con `UI_STATES.moduleDisabled`.
- **Dev-only**: un solo guard, `isDevRouteAllowed({ search, storageValue, isPlatformAdmin })` de
  `routes/backoffice.routes.tsx` = `isDevModeEnabled` **y** administrador de plataforma; fuera de eso el shell pinta
  `DevOnlyLockedScreen` («Pantalla en desarrollo») y la barra no muestra el grupo.
- **En una tira de pestañas**: `isVisible={(tab) => gate.isVisible(tab)}` (`NavItemTabs` lo hace); una pestaña oculta
  por rol o módulo no se pinta y, si la URL la nombra, el contenedor aterriza en `defaultTab` con `replaceState`.
- **Guía y recorridos**: `components/guide/GuideProvider.tsx` y `HelpCenter.tsx` leen `useNavAudience()` y pasan
  `{ roleTokens, enabledModules }` a `tourStepsFor` / `toursForAudience`: un recorrido nunca navega a un ítem que el rol
  no ve ni a un módulo apagado (mientras la lista de módulos es desconocida solo filtra por rol).

## Contrato del router y del menú (cierre de L1)

**Router** (`apps/admin-web/src/routes/backoffice.routes.tsx`, módulo puro; `App.tsx` lo consume):

- `BACKOFFICE_ROUTES` = `allUrls()` del árbol (183 rutas `{ path, screen, kind: item|tab|dev-only|public, devOnly,
  public }`; la URL base de cada contenedor va ANTES que las de sus pestañas). `LEGACY_ROUTES` = `NAV_TREE.legacyRoutes`
  (205), `LEGACY_SCREEN_KEYS` = `aliases` (24), `RETIRED_SCREEN_KEYS` (72, `retiredScreenUrl()` da la cobertura),
  `DEV_ONLY_ROUTES` (20), `PUBLIC_ROUTES` (2). No hay tabla escrita a mano.
- Resolución: `routeForPathname` / `screenFromPathname` (estática gana a `:param`), `pathForScreen(key)` (URL sin
  parámetros; pestaña → URL de la pestaña; alias/retirada → su cobertura; detalle → undefined),
  `urlPatternForScreen`, `urlForScreenWithParams(key, params)`, `itemUrlForScreen(key)`, `canonicalScreenKey`,
  `isDevOnlyScreen`, `pathnameBelongsToScreen`.
- **308 en cliente**: `resolveLegacyLocation({ pathname, search, hash })` = `resolveLegacyPath` + el id leído de
  `?query`/`#hash` (`id`, `reservationId`, `guestId`, `propertyId`, `propiedad`, `folio`, `org`, `codigo`,
  `categoryCode`…) para las rutas antiguas de detalle (`/backoffice/reservations/:id`, `guest-journey?reservationId=`,
  `property-detail`…); sin id aterriza en el ancestro estático. `resolveLocation(location, guard)` devuelve
  `home | screen (+ redirect) | dev-locked | not-found`; App.tsx escribe el `redirect` con `replaceState` (la ruta
  antigua nunca queda en el historial), pinta `DevOnlyLockedScreen` para `dev-locked` y `CocoaNotFoundScreen` (404
  Cocoa) para `not-found`.
- **Aterrizaje**: `landingFor(resolveRoleTokens(snapshot).tokens, { mobile: innerWidth < MOBILE_BREAKPOINT_PX,
  templateKey })` con el snapshot de sesión; la raíz `/` se reescribe a la URL de aterrizaje con `replaceState`.
- **Pestaña → URL** (`syncLocation` en App.tsx): navegar por clave (`hotelos-nav`, Sidebar, ⌘K) escribe la URL de la
  pestaña cuando la clave es una pestaña, y la URL concreta cuando el emisor trae el id (`ReservationDetailWorkspace`
  con `reservationId`, `TenantDetailScreen#org=…`, `ModuleManager#modulo=<código>`); los resultados de entidad de ⌘K
  (`layouts/BackOfficeLayout.tsx`, `buildHitPath`) derivan la URL de `hit.screen` con `urlForScreenWithParams` /
  `itemUrlForScreen`.
- **Registro**: `SCREEN_COMPONENTS` (App.tsx, 207 claves) = pantallas (`lazyNamed`) + contenedores (`lazyTab`, una
  entrada por clave de ítem y de pestaña) + alias; sin las 72 retiradas.
- **Guardas de commit** (`node scripts/check-discoverability.mjs`, en `.husky/pre-commit`):
  `check-sidebar-coverage.mjs` (cobertura por URL del árbol: toda URL resuelve a un componente vía App.tsx o loader de
  contenedor; huérfanas solo si están en `apps/admin-web/.discoverability-whitelist.json`, 29 entradas: diálogos,
  drawers, helpers como `HostedHead`), `check-route-validity.mjs` (toda clave del árbol y todo alias en
  `SCREEN_COMPONENTS`, ninguna retirada, ninguna clave sin URL, la tabla derivada de `allUrls`) y
  `check-placeholder-budget.mjs` (presupuesto 20 = dev-only del CSV).

**Menú** (`Sidebar.tsx`, `CommandPalette.tsx`, guía): `useNavGate()` → `menuCategories(tokens, modules, {
canEnableModules, devMode })` → 9 categorías; `flatMenuEntries(…, { includeTabs: true })` para ⌘K; `landingFor` para
el aterrizaje; tokens de `resolveRoleTokens` sobre el snapshot de `services/usersApi.ts` (campos opcionales de
`AuthUser`); módulos de `services/modulesApi.ts` con `ENABLED_MODULES_CHANGED_EVENT`; «Ver como…» en memoria y solo
admin; grupo «Desarrollo» con `?dev=1` + admin; la guía con `useNavAudience()`. Sin heurística de permisos: la única
que queda es `templatesCoveredByPermissions` para roles personalizados.

**Mapa de producto** (`packages/product/src/navigation/*`, contrato `tests/product-route-maps-contract.test.mjs` +
`packages/product/src/__tests__/route-maps.test.mts`): cada entrada de `module-route-map.ts` (superficie admin),
`manual-setup-route-map.ts` (Puesta en marcha) y `reservation-commerce-route-map.ts` lleva `url` (URL del árbol),
`screen` (clave canónica) y `tab`/`parent` cuando es pestaña; las rutas antiguas `path`/`adminPath` se retiraron en
L1c (el router las reconduce por `legacyRoutes`; el API `GET /backoffice/properties/:id/manual-setup/options` ya no las
envía). `RETIRED_MANUAL_SETUP_OPTIONS` documenta las opciones retiradas y qué las cubre; `module-manifest.ts` expone
`menuEntries` (derivadas del árbol, `MODULE_MENU_ENTRIES`) y `enabledByDefault` (`DEFAULT_ENABLED_MODULE_CODES`,
§14.1 reversible), que `GET /modules/catalog` y `GET /backoffice/properties/:id/modules` sirven como `unlocks` /
`menuEntries` / `defaultEnabled`.

## Orden de los lotes: L1a → L1b → L1c

| Lote | Tocó | Entregó |
|---|---|---|
| **L1a** | `scripts/build-nav-tree.mjs`, `navigation/{nav-tree.ts, nav-tree.generated.json, role-tokens.ts}`, `components/cocoa/CocoaRouteTabs.tsx`, `lib/format.ts`, `content/actions.ts`, `screens/tabs/**` (35 contenedores `NavItemTabs`), RBAC (`permissions.ts` deltas §10, plantillas `sales`/`fnb`), manifiesto de producto, chrome (⌘K, campana, ayuda, tour, banner) | Infraestructura aditiva: árbol generado, contenedores, formato y diccionario, sin tocar `Sidebar.tsx`/`App.tsx`/rutas |
| **L1b** | `Sidebar.tsx` (9 categorías desde `menuCategories`, «Ver como…», «Activar módulo», grupo Desarrollo), `App.tsx` (`SCREEN_COMPONENTS` sin retiradas, `lazyTab`, aterrizaje por `landingFor`, 308 en cliente, `syncLocation`, `DevOnlyLockedScreen`, 404 Cocoa), `routes/backoffice.routes.tsx` (contrato de arriba), `useEnabledModules.ts`/`usersApi.ts`/`modulesApi.ts` (gate único), `CommandPalette.tsx` (⌘K desde `flatMenuEntries`), `BackOfficeLayout.tsx` (`buildHitPath` por clave), scripts `check-*` por URL con presupuesto 20, API: claves de lectura (`folio.read`, `pos.read`, `tourist_tax.read`), `enabledByDefault` honrado por listado y gate, 10 plantillas por organización, retirada de `roles.ts`, `cocoa-sidebar-v2` y 29 pantallas retiradas | Menú final, redirecciones, «toda ruta antigua resuelve» y «toda URL del JSON está registrada» en verde |
| **L1c** (este) | Limpieza de navegación: la guía lee `useNavAudience()` (`GuideProvider`, `HelpCenter`; `guideRoles.ts` retirado), `AuthUser` con el snapshot de rol (un solo tipo para App.tsx, `usersApi.ts` y la guía), `screens/tabs/useNavGate.ts` retirado (⌘K y contenedores importan `navigation/useEnabledModules`), heurística de permisos de `nav-item-tabs.ts` borrada, UNA convención de pantalla alojada (`useTabHost()`; `tab-helpers.tsx` genérico en `screens/tabs/`, `pageHead` por contexto, `embed()` solo como puente), `PropertySetupForms` alojado sin segundo título y con «Cancelar» por `openTabPath`, `path`/`adminPath` retirados del mapa de producto, `.d.ts` obsoletos de `packages/shared/src` retirados, docs (este runbook, `api-contracts.md`, `README-INSTALL.md`) | Cierre de la navegación; quedan para los lotes de pantallas: cabeceras/copy EN de las pantallas fusionadas, `ConfirmDialog` en destructivos, codemod de formateadores → `format.ts`, retirada de jerga, y el puente `embed()` de 15 pantallas + las 24 ramas `hosted ? … : …` de tabs-a |

Gates en cada lote (desde `hotelos/`): `node scripts/typecheck-all.mjs --parallel 3` (o `corepack pnpm --filter
@hotelos/admin-web typecheck` y product, shared, api, mobile) · `corepack pnpm test` (incluye
`tests/nav-tree-contract.test.mjs` y `tests/sidebar-nav-contract.test.mjs`) · unitarios del front
(`cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts')`)
· `node scripts/check-discoverability.mjs` · `node scripts/build-nav-tree.mjs --check`. Nunca `--no-verify`, nunca
`pnpm-lock.yaml`, nunca reiniciar :3000/:3400/:5173.

## Chrome del shell (lote chrome, L1a; ganchos conservados por L1b/L1c)

Todo vive fuera de `Sidebar.tsx`/`App.tsx`/`routes`; L1b solo tuvo que conservar los ganchos.

- **Buscador de la barra → ⌘K con la consulta**: `layouts/BackOfficeLayout.tsx` (`openPaletteWith(query)`) abre
  `components/CommandPalette.tsx` con `initialQuery`; el primer carácter tecleado (o Intro) hace la entrega y el campo
  se vacía (remount por `key`). Cualquier pantalla puede abrirlo con
  `window.dispatchEvent(new CustomEvent("hotelos-open-search", { detail: "García" }))`. La paleta añade «Recientes»
  (`hooks/useSidebarRecent`) y «Acciones» (centro de ayuda, avisos, cambiar de propiedad) y lista los ítems y pestañas
  visibles para el rol (`flatMenuEntries(menuCategories(gate.tokens, gate.modules, { devMode }))`). ⌘K es único:
  `CocoaGlobalProvider` recibe `commandPaletteHotkey={false}` desde `App.tsx`.
- **Campana**: `providers/CocoaGlobalProvider.tsx` carga `GET /notifications` (`services/notificationsApi.ts`) cuando
  hay sesión, lo sondea cada 60 s con la pestaña visible, marca leídas con `POST /notifications/:id/read` y expone
  `useCocoaNotifications()` → `{ items, unreadCount, status, push, markAllRead, markRead, refresh, openCenter }`.
  La campana del shell muestra el contador y abre `CocoaNotificationCenter`; el evento `hotelos-open-notifications`
  (`OPEN_NOTIFICATIONS_EVENT`) también lo abre.
- **Ayuda «?»**: `openHelpCenter()` (`components/guide/guideStore.ts`) → `components/guide/HelpCenter.tsx`: búsqueda
  (`content/help-articles` → `searchHelpArticles`), recorridos por categoría, «Cómo hacer cada tarea», guía del puesto
  (`content/persona-guides`) y atajos reales (`content/help-articles/keyboard-shortcuts.ts`, única fuente;
  `GET /developer/keyboard-shortcuts` ya no existe).
- **Tour**: `components/guide/guideContent.ts` genera los recorridos desde `NAV_TREE` (bienvenida anclada a
  `data-tour="property|search|sidebar|notifications|help"` del shell Cocoa + uno por categoría con los ítems `keep`);
  `tourStepsFor(tour, { roleTokens, enabledModules? })` filtra por rol y, si se conocen, por módulo. Desde L1c
  `GuideProvider` y `HelpCenter` toman ambos de `useNavAudience()` (`navigation/useEnabledModules.ts`): el mismo gate
  que el menú, re-renderizado al llegar el perfil y al cambiar un módulo; sin heurísticas de permisos.
- **Banner de puesta en marcha**: `SetupPendingBanner` (BackOfficeLayout) llama a
  `GET /backoffice/properties/:id/readiness` (solo con `backoffice.access`), se muestra con `status === "blocked"`,
  se re-comprueba al cambiar de pantalla (30 s) y «Ver qué falta» navega a `GoLiveChecklist`; «Ahora no» lo oculta
  durante la sesión (sessionStorage por propiedad). Ya no existe el flag `onboarding-complete` de localStorage.
