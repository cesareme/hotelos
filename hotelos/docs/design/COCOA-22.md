# Cocoa 22 · especificación visual y de migración

> Encargo de César (2026-09): «Ya he revisado y es el Dashboard del director. Por favor revisa los colores, font, sombreados. Eso es lo que quiero para toda la app. La UI tiene que ser así. Cambia toda la app. Desarrollemos la UI más intuitiva, responsive, moderna, funcional, básicamente COCOA 22nd century».

Canon: `apps/admin-web/src/screens/operations/GeneralManagerScreen.tsx` («Dashboard del director», pestaña Dirección de Mi día, `/hoy/direccion`). Todo lo que sigue está **medido** en ese canon el 2026-09-15 con `getComputedStyle` en Chrome a 1440×900 y 390×844, en claro y oscuro (tema del sistema; `data-theme` sin forzar), o leído del código que lo pinta (`cocoa-tokens.css`, `cocoa-motion.css`, `mobile.css`, `styles.css`, `components/cocoa/*`, `cocoa-director/*`, `CocoaPageHeader`, `TabHost`, `BackOfficeLayout`, `Sidebar`, `Toast`, `ConfirmDialog`) y del playbook premium de junio (`docs/strategy/anfitorio-premium-lookfeel-2026-06/PLAYBOOK.md`).

Inventario de pantallas: `docs/design/cocoa-22-inventory.json` (generado por `scripts/cocoa-22-inventory.mjs`).

**Cómo se usa para migrar una pantalla**: §4.1 (piloto real de su arquetipo) → §4.2 (reglas que rompen la compilación, el contrato o el layout) → §4.3 (plantilla completa con imports, alojada y standalone) → §8 (API generada desde los tipos exportados) → §9 (contrato automático) → §10 (definición de «hecho»). El documento se verifica solo: `node docs/design/cocoa-22-api.mjs --check` (§8.2 coincide con `components/cocoa/*`) y `node docs/design/cocoa-22-api.mjs --typecheck-examples` (las plantillas de §4.3 compilan con el `tsc` de admin-web).

---

## §1 · Principios

| # | Principio | Qué significa en la práctica |
|---|---|---|
| 1 | **El Dashboard del director es el canon** | Tipografía, color, profundidad, rejilla, tarjetas, KPI, gráficos, estados y motion de esa pantalla son la única gramática visual. Ninguna pantalla inventa un tono, una sombra o un radio propios. |
| 2 | **Premium = restricción** (playbook 2026-06) | Un acento (Esmeralda), una familia (Inter), dos radios (8/12), una sombra de tarjeta, un ritmo (4 pt). Nada de blur en cabeceras de tabla, halos de acento, shimmer teñido ni pulsos infinitos. |
| 3 | **Intuitiva** | Cada página se lee igual: cabecera (eyebrow · título · subtítulo · acciones) → pestañas → contenido en tarjetas con cabecera. Las acciones primarias siempre arriba a la derecha (o en barra inferior en móvil). ⌘K en todas partes. |
| 4 | **Responsive de verdad** | 12 columnas en escritorio, 2 en tablet, 1 en teléfono; tablas → tarjetas apiladas; objetivos táctiles de 44 px; safe-area; sin scroll horizontal salvo calendarios/parrillas envueltos. |
| 5 | **Moderna, no decorativa** | Profundidad por anillo + ambiente suave, cifras tabulares grandes, deltas con polaridad semántica, gráficos SVG propios sin librerías, motion compositor-only de 100–220 ms. |
| 6 | **Funcional y honesta** | Estados vacío / error / carga / **degradado** explícitos (`DegradedValue` «—» con tooltip, nunca un 0 verde falso). Nada se pinta con datos que no existen. |
| 7 | **Una sola gramática para las 9 categorías** | Hoy, Recepción, Operaciones, Comercial, Revenue, Finanzas, Cumplimiento, Informes y Configuración comparten shell, cabecera, rejilla, primitivas y contrato automático. Las diferencias son de contenido, nunca de estilo. |
| 8 | **Tokens, nunca literales** | Todo color, sombra, radio, espacio y duración sale de `--cocoa-*` (o de `--accent*` de Aurora, que Cocoa consume). Cero `#hex`/`rgba()` en pantallas. |
| 9 | **Textos en español, código en inglés** | Microcopys, etiquetas y estados en español; nombres de componentes, props y comentarios en inglés (convención del repo). |

---

## §2 · Tokens

### 2.1 Color — valores medidos (`getComputedStyle(:root)`)

| Rol | Token | Claro | Oscuro | Notas |
|---|---|---|---|---|
| Lienzo (body) | `--canvas` (Aurora) | `#f6f5f1` | `#14130e` | **Medido**: el `body` pinta `--canvas`, no `--cocoa-background-window` (#ECECEC / #323232). `styles.css` gana a `cocoa-base.css`. Cocoa 22 fija `--cocoa-background-window: var(--canvas)` y deja de existir el doble token. |
| Superficie tarjeta / control | `--cocoa-background-content` | `#FFFFFF` | `#1E1E1E` | Tarjetas, KPI, popovers, tabla. |
| Control (segmented, inputs, botón neutro) | `--cocoa-background-control` | `#FFFFFF` | `#3A3A3C` | Fondo del tab strip y de los iconos de la barra. |
| Sidebar | `--surface` (Aurora) | `#ffffff` | `#1d1b15` | Medido en `#bo-sidebar`; borde derecho `--line` `#e8e5dd` / `#332f24`. Cocoa 22 alinea `--cocoa-background-sidebar` a `--surface`. |
| Barra superior | `--cocoa-background-toolbar` | `rgb(246 246 246 / .72)` + `saturate(1.8) blur(20px)` | `rgb(40 40 40 / .72)` | Único material con blur permitido (toolbar). |
| Separador | `--cocoa-separator` | `rgb(0 0 0 / .10)` | `rgb(255 255 255 / .10)` | Bordes de tarjeta, cabecera, filas, rejillas de gráfico. |
| Separador opaco | `--cocoa-separator-opaque` | `#C6C6C8` | `#38383A` | Solo cuando el fondo es translúcido. |
| Texto primario | `--cocoa-label` | `rgb(0 0 0 / .85)` → 15,1:1 | `rgb(255 255 255 / .85)` → 12,3:1 | Títulos, cifras, cuerpo. |
| Texto secundario | `--cocoa-label-secondary` | `rgb(0 0 0 / .50)` → **3,98:1** | `rgb(255 255 255 / .55)` → 5,9:1 | Subtítulos, etiquetas KPI, captions. **No supera AA para texto ≤ 13 px en claro**; ver §5.2. |
| Texto terciario | `--cocoa-label-tertiary` | `rgb(0 0 0 / .26)` → **1,88:1** | `rgb(255 255 255 / .25)` → 2,3:1 | Solo decorativo (ejes de gráfico, placeholders). **Prohibido para texto informativo** (hoy lo usa el eyebrow). |
| Acento único | `--accent` = `--cocoa-accent` | `#0d8a5f` (4,36:1 sobre blanco) | `#2bb37f` (6,24:1) | Esmeralda. Para texto pequeño en claro usar `--accent-strong` `#086b48` (6,55:1). |
| Acento fuerte / hover | `--accent-strong` | `#086b48` | `#4dca96` | Nav activo, enlaces, hover de filled. |
| Acento suave | `--accent-soft` | `#e6f4ef` | `#122e25` | Fondo del ítem de menú activo. |
| Tinta sobre acento | `--accent-ink` | `#ffffff` (5,35:1 sobre `--cocoa-accent-fill`; solo 4,36:1 sobre `--accent`) | `#07140e` (7,0:1) | Texto de botones filled, siempre sobre `--cocoa-accent-fill`. |
| Acento de relleno | `--cocoa-accent-fill` | `#0b7a54` (5,35:1 bajo `--accent-ink`; 5,02:1 con el hover `brightness(1.04)`) | `= --accent` `#2bb37f` | Fondo del `CocoaButton` filled accent: el acento puro no llega a AA bajo blanco a 11–15 px (qa#7). Barras, iconos, foco y selección siguen en `--accent`. |
| Success | `--cocoa-success` | `#28A745` | `#30D158` | Barras, deltas, iconos. Como **texto** en claro solo 3,1:1 → usar `--ok-ink` `#0a6b46` (6,55:1). |
| Warning | `--cocoa-warning` | `#FF9500` | `#FF9F0A` | Texto en claro 2,2:1 → `--warn-ink` `#8a4a09` (6,85:1). |
| Danger | `--cocoa-danger` | `#FF3B30` | `#FF453A` | Texto en claro 3,55:1 → `--danger-ink` `#8d1b1b` (9,1:1). |
| Info | `--cocoa-info` | `#007AFF` | `#0A84FF` | Reservado a «informativo»; **nunca** como acento. Texto → `--info-ink` `#1a3d8a`. |
| Superficies de estado | `--cocoa-{success,warning,danger,info,accent}-bg / -border` | `color-mix(tono 12–14 %, transparent)` / `32–34 %` | idem (se derivan) | Badges tintados, banners, callouts. |
| Foco | `--cocoa-focus-ring` | `color-mix(#0d8a5f 50 %, transparent)` | `color-mix(#2bb37f 60 %, transparent)` | `box-shadow: 0 0 0 3px` vía `.cocoa-focus-ring:focus-visible`. |

**Hallazgo bloqueante (medido)**: `<html style="--cocoa-accent: #007aff">`. `providers/CocoaGlobalProvider.tsx:68` (`DEFAULT_PREFERENCES.accentColor = "#007aff"`) y `:188` (`applyAccentColor`) escriben el azul Apple en línea al montar, pisando `var(--accent)`. Resultado medido: botón «Nueva reserva», avatar, `CocoaButton` accent, «Ver detalle», línea OTB del pace y `--cocoa-accent-bg/-border` en **azul**, mientras foco y menú activo van en Esmeralda. En oscuro el botón azul lleva texto `#07140e`. Cocoa 22 elimina la preferencia de acento (o la limita a «Esmeralda») y `applyAccentColor` deja de tocar `--cocoa-accent`.

Reglas de color: (a) un solo acento cromático por pantalla; (b) tonos semánticos solo en barras de 3 px, deltas, badges y puntos de estado, nunca en fondos grandes; (c) para texto ≤ 13 px en claro se usan los `*-ink` de Aurora, para cifras ≥ 24 px valen los tonos Cocoa; (d) `--ai` (#6d4ed1) queda reservado a badges «IA» con `bo-status.ai` → `CocoaBadge tone="ai"`.

### 2.2 Tipografía (Inter Variable cargada: `document.fonts.check` = true)

Familia medida en todo el canon: `"Inter Variable", Inter, system-ui, -apple-system, "SF Pro Text", …` (`--cocoa-font`); display = `--cocoa-font-display` (misma Inter, tracking apretado). `body`: 13 px / 19,5 px, peso 400, tracking −0,13 px (−0,01 em), `font-feature-settings: "calt","kern","liga","ss01"`.

| Estilo | Token | Tamaño / interlínea | Peso | Tracking | Medido en |
|---|---|---|---|---|---|
| Large title (H1 de página, cifra de tarjeta) | `--cocoa-fs-large-title` | 26 / 29,9 (1,15) | 700 | −0,011 em (−0,286 px) | `h1` «Mi día» |
| Cifra KPI regular | literal 32 px en `DirectorKpiTile` | 32 / 33,6 (1,05) | 600 | −0,011 em | valor «1,7 %» — **Cocoa 22 lo promueve a token `--cocoa-fs-kpi: 32px`** (compacto 24 px) |
| Title 1 | `--cocoa-fs-title-1` | 22 / 26 | 600 | −0,011 em | cifra del gauge |
| Title 2 | `--cocoa-fs-title-2` | 17 / 22 | 600 | −0,011 em | título de estado vacío |
| Title 3 (cabecera de tarjeta) | `--cocoa-fs-title-3` | 15 / 17,25 | 600 | −0,011 em (−0,165 px) | `h3` «Pace próximos 30 días» |
| Headline / Body | `--cocoa-fs-body` | 13 / 16 (17,55 en subtítulo, 1,35) | 400 (600 en tab activa) | −0,011 em | subtítulo, tabs, tabla |
| Callout | `--cocoa-fs-callout` | 12 / 15 | 400–600 | 0 | notas degradadas, anomalías |
| Subheadline / Footnote (delta, botón small) | `--cocoa-fs-footnote` | 11 / 13,2 | 500 | −0,01 em | «▲ 100 % vs LY», botón «Actualizar» |
| Caption (eyebrow, etiqueta KPI, badge, th, muted) | `--cocoa-fs-caption` | 10 / 10–13 | 500–600 | **+0,012 em** (0,12 px) uppercase | «OCUPACIÓN», «HOY», «HIGH» |
| Ejes de gráfico | literal 10 px | 10 | 400 | 0 | `<text>` del pace |

Cifras: `font-variant-numeric: tabular-nums` + `font-feature-settings: "tnum"` en KPI, deltas, columnas numéricas (`"tnum" 1, "lnum" 1` en `CocoaTable`). Formato es-ES (`1.234,50 €`, `1,7 %`) vía `lib/format`.

### 2.3 Espaciado, radios, sombras, motion, z-index, densidad

| Grupo | Token | Valor | Uso medido |
|---|---|---|---|
| Espacio | `--cocoa-space-1…8` | 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 | gap de rejilla 12 (`space-3`), stack de secciones 16 (`space-4`), padding de contenido 24 (`space-5`), cabecera padding-bottom 24 |
| Padding de tarjeta | `CocoaCard padding` | sm 12 · md 16 · lg 24 | KPI = sm, tarjeta con cabecera = md, vacío = lg |
| Radio | `--cocoa-radius-sm/md/lg/xl/full` | 4 · 8 · 12 · 16 · 9999 | badge 4 (small button 4), botón/segmented/input 8, tarjeta 12, avatar full. **Prohibidos** los radios Aurora 16/20/28 (`--radius-xl/2xl`) en contenido. |
| Sombra control | `--cocoa-shadow-control` | `0 1px 0 rgb(0 0 0/.05), 0 1px 2px rgb(0 0 0/.08)` · oscuro `0 1px 0 rgb(0 0 0/.40), 0 1px 2px rgb(0 0 0/.50)` | tarjeta `bordered` en reposo, tab activa (inset), tooltip del pace |
| Sombra tarjeta | `--cocoa-shadow-card` | `0 0 0 1px rgb(0 0 0/.06), 0 1px 2px rgb(0 0 0/.04), 0 4px 12px rgb(0 0 0/.06)` · oscuro anillo **blanco** `.05` + `0 1px 2px /.30` + `0 4px 12px /.40` | `elevated`; **es la sombra de tarjeta canónica de Cocoa 22** (anillo + ambiente + proyección suave) |
| Sombra hover | `--cocoa-shadow-window` | `0 0 0 1px /.10, 0 24px 48px /.18, 0 2px 6px /.10` | `CocoaCard` interactiva al hover (+ `translateY(-2px)`) |
| Popover / menú | `--cocoa-shadow-popover` | `0 0 0 1px /.08, 0 8px 16px /.12, 0 2px 4px /.08` | menús, tooltips flotantes |
| Modal / sheet | `--cocoa-shadow-modal` | `0 0 0 1px /.12, 0 48px 96px /.28, 0 8px 16px /.14` | `CocoaSheet`, switcher de propiedad (hoy), diálogos |
| Flotante (FAB) | `--cocoa-shadow-floating` | anillo neutro `.08` + `0 8px 24px /.14` | ayuda flotante; **sin halo de acento** |
| Duraciones | `--cocoa-duration-fast/base/slow` | 100 · 200 · 400 ms | hover de botón 100, sombra de tarjeta 200, sheet 400 |
| Curvas | `--cocoa-ease-out` `cubic-bezier(.2,0,0,1)` · `-in-out` `(.4,0,.2,1)` · `-spring` `(.5,1.5,.5,1)` | | spring solo en el thumb del switch |
| Entrada | `.cocoa-enter` 200 ms · `.cocoa-stagger > *` 220 ms `cocoa-slide-in-up` (8 px, `both`) con retardo 40 ms × n | medido: hijos 1–8 (0 → 280 ms), **hijo 9+ sin retardo** (nth-child limitado a 8; Cocoa 22 amplía a 12 o usa `--i`) |
| Reduced motion | `prefers-reduced-motion` y `data-cocoa-reduced-motion` | duraciones 0, `animation: none` en enter/stagger, `CocoaButton` no escala | |
| Z-index (tokens) | `--cocoa-z-*` | base 0 · sticky 100 · toolbar 200 · sidebar 300 · dropdown 400 · popover 500 · sheet 600 · modal 700 · toast 800 · tooltip 900 | **Medido hoy**: toolbar 10, scrim 40, drawer 50, menús 100, tour 905, toast 1000, `ConfirmDialog` 9999 → Cocoa 22 obliga a consumir los tokens |
| Densidad | `--cocoa-density` (nuevo) | `comfortable` (padding md, filas 36 px) · `compact` (padding sm, filas 28 px) | recepción/parrillas en compact; dashboards en comfortable |

---

## §3 · Gramática de página

### 3.1 Shell (medido)

| Zona | Escritorio ≥ 900 | Teléfono < 900 |
|---|---|---|
| Barra superior | `CocoaToolbar` sticky 48 px, padding 0 16, material toolbar (blur 20), borde inferior separator. Izq.: semáforo + switcher de propiedad (borde separator, radio 8). Centro: «Anfitorio» 13 px 600. Der.: «Nueva reserva» (filled 32 px), búsqueda expandible, `⌘K` kbd, tema, campana, ayuda, avatar (24 px full). | `CompactToolbar` 48 px, padding 0 12; 6 controles de **32 × 44** (menú, propiedad truncada, nueva reserva icono, búsqueda, avisos, avatar); tema y ayuda dentro del menú de usuario. |
| Banners de shell | Bajo la barra: «puesta en marcha pendiente» (57 px, fondo `rgba(10,132,255,.12)` por `--cocoa-accent-soft` **no definido** → Cocoa 22: `--cocoa-accent-bg`), propiedad inválida (warning). | Texto con ellipsis, botones en fila sin wrap. |
| Sidebar | Columna de `CocoaSplitView` 240 px (239 + borde), redimensionable 180–420, plegable. Fondo `--surface`, padding 24 12. Marca «A» + «Anfitorio / Back Office». Buscador de menú. 9 grupos: cabecera 11 px 700 uppercase 0,06 em `--ink-muted`, padding 8 12; ítem 13 px 500 `--ink-soft`, padding 9 12, radio 8, min-height 38; activo `--accent-strong` sobre `--accent-soft` 600 con barra izquierda. | Drawer fijo 260 px (`min(86vw, 260px)`), `translateX(-100%) → 0` 180 ms, `z 50`, sombra `--shadow-lg`; scrim `rgba(20,19,14,.45)` + blur 2 px `z 40`; body scroll bloqueado; botón cerrar 32 × 44. |
| Contenido | `main.cocoa-content` padding 24, **es el scroller** (overflow-y auto; el documento no crece). Ancho útil 1120 a 1440. | Medido: `main` a x = 16 + padding 24 → **310 px útiles de 390** (gutter 40). Cocoa 22: padding 16 y sin margen extra del split view → 358 útiles. |

### 3.2 Cabecera de página — `CocoaPageHeader` (medido)

```
<header>                         padding-bottom 24 · border-bottom 1px separator · gap 12
  <p eyebrow>  HOY               10 px 600 uppercase +0,012 em · hoy label-tertiary (1,9:1) → Cocoa 22: label-secondary
  <h1>         Mi día            26 px 700 −0,011 em lh 1,15 · label · nowrap + ellipsis
  <p subtitle> Lo que pasa hoy…  13 px 400 lh 1,35 · label-secondary
  <div actions>                  inline-flex gap 8, alineado arriba a la derecha
  <tabs>                         CocoaSegmentedControl (opcional) margin-top 8
```

Reglas: un solo `h1` por página; en pantallas alojadas (`useTabHost() !== null`) la pantalla **no** pinta eyebrow/título — pinta `HostedHead` (subtítulo + vistas internas + acciones, `HOSTED_TOOLBAR`) o solo `HOSTED_ACTIONS_ROW` (flex-end, gap 8, wrap). El eyebrow siempre es «Categoría · Propiedad» o la categoría del árbol (`treeHeaderFor`).

### 3.3 Pestañas (medido)

`CocoaRouteTabs`/`CocoaSegmentedControl`: contenedor `background-control`, padding 2, radio 8, alto 44; pestaña `6px 16px`, 13 px; activa 600 `label` sobre `background-content` con radio 6 y sombra `inset 0 1px 0 rgb(0 0 0/.05), 0 1px 2px rgb(0 0 0/.08)`; inactiva 500 `label-secondary`. La pestaña activa **es la URL**. En teléfono la tira hace scroll horizontal (medido: 4.ª pestaña a x = 344 – 444 px) → Cocoa 22 añade fade de borde (`mask-image`) y `scroll-snap`. Una sola pestaña visible → tira oculta.

### 3.4 Rejilla de 12 columnas (medido)

| Ancho contenido | Columnas | Ancho columna | Gap | Fuente |
|---|---|---|---|---|
| 1120 (1440 de viewport) | 12 | 82,3 px | 12 | `gridRowStyle` |
| 900–1199 | 12; por debajo de 912 px de rejilla un `min` que no cabe promociona a 6 y luego a 12 | — | 12 | `CocoaGrid` (`effectiveSpan`) + `.c22-min-*` |
| 600–899 | 2 (spans < 6 → 6, ≥ 6 → 12) | — | 12 | `cocoa-22-layout.css` |
| < 600 | 1 (`.c22-grid` a `minmax(0,1fr)` + hijos `1 / -1`; `.gm-grid` alias legacy) | 358 (gutter 16) | 12 | `cocoa-22-layout.css` |

Spans canónicos del GM: `8/2/2` (pace · pickup · gauge), `4/4/2/2` (segmentos · comp-set · donut · BAR), `3/3/3/3` (experiencia; cumplimiento), `5/4/3` (insights). `spanStyle(cols, minPx)`: 480 para 8 col, 320 para 4–5, 240 para 3, 200 para 2. Tiras de KPI: `repeat(auto-fit, minmax(min(180px, 100%), 1fr))` → 5 tiles de 214 px a 1120 (11 tiles = 5/5/1); ops: `minmax(200px, 1fr)`.

Promoción de spans en `CocoaGrid`/`CocoaSpan` (implementada, lote primitives): **por clase** (`c22-span-N` + `c22-min-{200,240,320,480}` + `c22-rowspan-N` de `spanClassNames()`, nunca `grid-column` inline), medida por contenedor con `ResizeObserver` (`useElementWidth`): < 600 → 12; < 900 → ≥ 6; rejilla < 912 px (= 1200 − sidebar 240 − gutters 48, `GRID_DESKTOP_WIDTH`) → un `min` que no cabe promociona a 6 y luego a 12; ≥ 912 spans reales (el canon 8/2/2 a 1120 px se conserva con tiles de 176 px y `min` 200, igual que la hoja). `min` se redondea al bucket superior (`minBucket`: 300 → 320; > 480 → 480). `.gm-grid` de `mobile.css`/`cocoa-22-layout.css` queda como alias legacy hasta que el lote css lo retire (el canon ya usa `CocoaGrid`).

### 3.5 Anatomía de tarjeta (medido)

| Variante | Fondo | Borde | Sombra | Radio | Uso |
|---|---|---|---|---|---|
| `bordered` (tarjeta con cabecera) | content `#fff / #1e1e1e` | 1 px separator | control | 12 | contenido por defecto |
| `elevated` | content | — | **card** | 12 | destacadas / interactivas (hover → window + `translateY(-2px)`, 100/200 ms) |
| `plain` | content | — | — | **0 (medido en el GM)** | **Hallazgo**: los KPI y las mini-cards de ops se pintan como rectángulos blancos sin radio ni borde sobre el lienzo; `CocoaKpi` los normaliza a radio 12 + sombra card. |

Cabecera de tarjeta: flex space-between center, gap 12, margin-bottom 12; título `h3` title-3 600; texto secundario caption `label-secondary` o acción `CocoaButton plain accent small`. Listas internas: `li` padding 8 0, borde inferior separator, gap 8, valor a la derecha en `strong` tabular con color de tono.

### 3.6 KPI tile (medido en `DirectorKpiTile`)

```
┌─ barra 3 px tono (padding-left 9) ──────────────────┐  card padding 12 · gap 8 · min-height 44
│ OCUPACIÓN                caption 500 uppercase +0,012em label-secondary
│ 1,7 %                    32 px 600 −0,011em lh 1,05 tabular label   (unidad callout 500 secondary)
│ ▲ 100 % vs LY   ~~~~~    footnote 500 tabular · color por polaridad (success/danger/secondary) · sparkline 60×20, 1,5 px
└─────────────────────────────────────────────────────┘
```

Polaridad: `positive-good` (▲ verde / ▼ rojo), `negative-good` (invertida), `neutral` (secondary, «•»). Estado → color de barra y de sparkline: ok success · warning warning · critical danger; sin estado → sin barra, sparkline `label-tertiary`. `aria-label` = «etiqueta, valor, +delta unidad vs LY».

### 3.7 Tabla — `CocoaTable` (leído)

`thead` sticky sobre `background-sidebar` con sombra `0 1px 0 separator, 0 2px 6px rgb(0 0 0/.04)` (**sin blur**); `th` caption 600 uppercase +0,012 em secondary, padding 8 12, `aria-sort`; `td` body, padding 8 12, borde inferior separator; columnas `align="right"` con `tnum lnum`; zebra `color-mix(label 3 %)`; hover `accent 8 %`; selección `accent 15 %` + barra inset 3 px accent (WCAG 1.4.1); vacío centrado padding 32 secondary; < 600 px → tarjetas apiladas etiqueta/valor (radio 12, borde separator, sombra control). Cocoa 22 añade: `density`, `stickyFirstColumn`, `rowActions`, `footer` (totales sobre `--inverse-surface`), `virtualize` (> 200 filas), `fit` (columna ajustada a su contenido en una sola línea: fecha, número, importe, estado; el ancho libre va a la columna de texto) y `showFrom` (columna secundaria visible solo desde un tier: `"desktop"` ≥ 1200); las columnas `align="right"` no parten nunca la cifra.

### 3.8 Formulario (leído: `CocoaInput`/`Select`/`Switch`/`DatePicker`, `FormComponents`, `.fp-*`)

| Elemento | Especificación |
|---|---|
| Sección | `CocoaFormSection`: título title-3 600 + descripción caption, tarjeta `bordered` padding 24, secciones separadas 16 |
| Fila | `CocoaFormRow`: grid `repeat(auto-fit, minmax(240px, 1fr))` gap 12; 1 columna < 600 |
| Campo | `CocoaField`: label 11 px 600 secondary (uppercase opcional) + `*` danger si requerido; control 28 px (small 22, large 34) fondo control, borde separator, radio 8, foco `0 0 0 3px focus-ring`, error borde danger + halo `danger 45 %`; ayuda callout secondary; error callout `--danger-ink` 600 + `aria-describedby`. `inline` (interruptores): rejilla `minmax(0, 1fr) auto` — etiqueta a la izquierda, control a la derecha, ayuda y error DEBAJO de la etiqueta (en fila flex la ayuda larga encogía la etiqueta hasta partir palabras a 390, qa#2 L6) |
| Controles | `CocoaInput` (icono, rightSlot, inputMode), `CocoaSelect` nativo con chevron, `CocoaSwitch` 52×32 / 32×20 (thumb spring), `CocoaDatePicker`, `CocoaSegmentedControl` para ≤ 4 opciones, textarea = `CocoaInput multiline` (nuevo) |
| Acciones | Barra inferior sticky (`fp-sticky-actions` → `CocoaActionBar`): cancelar bordered neutral + guardar filled accent; en móvil ocupa todo el ancho sobre safe-area |
| Touch | inputs 16 px en `pointer: coarse` (evita zoom iOS), 44 px de alto |

### 3.9 Drawer / sheet, diálogo, toast (leído)

| Superficie | Hoy | Cocoa 22 |
|---|---|---|
| `CocoaSheet` | Portal, sheet superior centrado `max-width 480/640/880`, `translateY(-100%) → 0` 400 ms ease-out, sombra modal, radio 12, cabecera 16 20 (title-2), cuerpo 20, pie 12 20; focus trap, Esc, scroll lock | Base de `CocoaDrawer side="right"` (360/480/640, `translateX`) y `side="bottom"` en teléfono (safe-area, asa de 36×4) |
| `ConfirmDialog` | Tokens Aurora, overlay `rgba(15,23,42,.55)` + blur 2, **literal `#dc2626`**, `<button>` crudos, `z 9999`, foco inicial en Cancelar si `danger` | `CocoaDialog`: `--cocoa-z-modal`, overlay `color-mix(label 45 %)`, botones `CocoaButton` (destructive filled), sombra modal, radio 12, max 440, `role=dialog` + `aria-labelledby/-describedby`, Esc, click en overlay cancela |
| `Toast` | Aurora, esquina inferior derecha (24 px, offset 120 px sobre barras sticky), borde izq. 4 px por variante, `guide-rise` 180 ms, máx. 3, 4 s, `role=status/alert` | Mismo comportamiento con tokens Cocoa (content, shadow-popover, radio 12, barra 3 px tono, `--cocoa-z-toast`), en móvil arriba bajo la toolbar y a ancho completo menos 16 |

### 3.10 Estados (leído: `DashboardSkeleton`, `States.tsx`, `CocoaEmptyState`, `DegradedValue`)

| Estado | Especificación |
|---|---|
| Carga | Skeleton con shimmer neutro `linear-gradient(90deg, control 0 %, separator 50 %, control 100 %)`, `background-size 200 %`, 1,1–1,4 s ease-in-out infinito (única animación infinita permitida), radio 8, alturas 110 (tile) / 240 (tarjeta), `aria-busy` + `aria-label="Cargando…"`; réplica de la rejilla real (mismos spans). Spinner solo dentro de botones (`loading`). |
| Vacío | `CocoaEmptyState`: ilustración 200×150 `label-tertiary` (5 de `cocoa-illustrations`), título title-2 600, descripción subheadline secondary, acciones (filled + bordered), min-height 320, `role=status`. Dentro de tarjeta: texto caption secondary («Sin anomalías detectadas.») o caja punteada `1px dashed separator` radio 8 con CTA («Conectar STR / CoStar»). |
| Error | `ErrorState` → `CocoaState kind="error"`: icono danger, título `--danger-ink`, mensaje, «Reintentar»; `role=alert`. Nunca un `alert()` ni texto rojo suelto. |
| Degradado | `DegradedValue` «—» `label-tertiary` con `title`/`aria-label` «No disponible: el cálculo falló; revisa el log del servidor»; `DegradedNote` línea callout; `DegradedCard` conserva el hueco de rejilla con título y «—»; `DegradedBanner` chip warning uppercase «N indicadores no disponibles» en la fila de acciones. |

### 3.11 Badges y tonos (medido `badgeStyle`)

Badge outline: caption 600 uppercase +0,012 em, padding 2 8, lh 1,4, radio 4, fondo transparente, borde 1 px y texto del tono. Badge tintado (banner degradado): texto tono, fondo `tono-bg`, borde `tono-border`. Tonos: `success · warning · danger · info · neutral · accent · ai`. Pill de estado con punto (`.bo-status` con `::before` 6 px) → `CocoaBadge dot`.

### 3.12 Gráficos SVG propios (medido)

| Gráfico | Geometría | Trazos | Texto |
|---|---|---|---|
| Sparkline (`DirectorKpiTile`) | 60×20, padding 1 | 1,5 px, tono/ tertiary, `round` | — |
| Línea / pace (`DirectorForwardPaceChart`) | viewBox 640×200, padding 16/16/32/44, 4 ticks Y, `preserveAspectRatio="none"` (**se estira en móvil: 276×200 medido → Cocoa 22 fija `xMidYMid meet` + alto por `aspect-ratio`**) | OTB accent 2 px · forecast warning 2 px `dash 6 4` · LY tertiary 1 px · guía hover tertiary `dash 3 3` · rejilla separator 1 px (`vector-effect: non-scaling-stroke`) | ejes 10 px `label-tertiary`; leyenda caption con swatches SVG 20×8; tooltip tarjeta control radio 8 sombra control caption tabular |
| Barras (`DirectorPickupBar`) | alto ≥ 60, barras div con radio 2, color success/danger/tertiary | — | etiquetas caption; tooltip HUD (`material-hud-bg`, radio 4, sombra popover) |
| Gauge (`DirectorCancellationRiskGauge`) | viewBox 220×130, arco 180°, `stroke-width 16`, pista separator, aguja + hub 6 px | tono por umbral | cifra title-1 600, etiqueta caption |
| Donut (`DirectorChannelMixDonut`) | viewBox 160×160, `stroke-width 1,5` entre segmentos | acento + escala de grises (`label` 85/50/26 %) | centro title-2 + caption |

Regla: colores solo `var(--cocoa-*)` dentro del SVG (heredan el tema), sin librerías, `role="img"` + `aria-label` descriptivo o `aria-hidden` si es decorativo, tabla oculta `sr-only` para series largas.

---

## §4 · Arquetipos de pantalla y receta de migración

El inventario asigna un arquetipo por heurística (nombre + contenido); es orientativo y se revisa al migrar.

| Arquetipo | Pantallas (inventario) | Ejemplos | Receta |
|---|---|---|---|
| **Dashboard** | 78 | GeneralManager, OperationsDirector, FrontDesk, Revenue*, Fiscal* | `CocoaPage` → `CocoaKpiStrip` → `CocoaGrid` de `CocoaSection` con `CocoaChart`/listas; skeleton espejo; polling con «datos a HH:MM». |
| **Lista / tabla** | 13 (+ tablas dentro de otros) | AuditLogViewer, ReservationsList, InvoicesList | `CocoaPage` con `CocoaToolbar` (búsqueda, filtros `CocoaSelect`, segmented) → `CocoaTable` (sticky, sort, selección → `CocoaDrawer`) → paginación; < 600 tarjetas. |
| **Detalle** | 4 (+ dialogs) | FolioDetail, InvoiceDetail, CategoryDetail | Cabecera con `CocoaBadge` de estado + acciones (destructiva → `CocoaDialog` con `busy`); vistas internas con `tabs`/`activeTab` de `CocoaPage` (alojada las pinta `HostedHead`); `CocoaGrid align="start"` 8/4: cuerpo (secciones) + aside (`CocoaStat` + timeline); el `:id` llega por `useRouteParam` (pestaña `:id` del contenedor) o por la ruta propia. |
| **Formulario / ajustes** | 16 | *Settings, RatePlans, RevenueRules | `CocoaPage` → `CocoaFormSection` × n → `CocoaActionBar` sticky; guardado optimista + toast; dirty guard. |
| **Asistente / wizard** | 7 | GoLiveChecklist, CocoaOnboardingWizard, ReservationCreate | Indicador de pasos con `CocoaChart.Progress` + `ol.c22-section__list` de pasos con `CocoaBadge variant="dot"` (hecho success · actual accent · pendiente neutral) — **no existe un stepper de pasos**: `CocoaStepper` es el contador numérico ± (handoff `CocoaSteps`); una `CocoaSection` por paso; `CocoaActionBar` `secondary={{ label: ACTIONS.previous }}` / `primary={{ label: ACTIONS.next \| ACTIONS.finish }}`; resumen final y `state="empty"` con `illustration="success"` al terminar. |
| **Workspace split** | 10 | ComplianceInbox, GuestJourneyWorkspace, ConciergeInbox | `CocoaGrid align="start"` con `CocoaSpan cols={4} min={320}` (lista en `CocoaSection scroll="y" maxHeight padding="none"`) + `CocoaSpan cols={8} min={480}` (detalle); con `useViewportTier()` en `phone`/`tablet` la lista es la página y el detalle un `CocoaDrawer` (hoja inferior automática en teléfono). `CocoaSplitView` es el shell (BackOfficeLayout), no una primitiva de página. |
| **Calendario / parrilla ancha** | 6 | RateGridEditor, LiveTimeline, RoomRack, GroupsCalendar | `CocoaPage` a ancho completo (`fullBleed`), cabecera sticky de fechas **sin blur**, primera columna sticky, scroll horizontal envuelto con sombra de borde, `CocoaActionBar` de guardado. |
| **Chat / asistente IA** | 1 | AssistantChat | `CocoaGrid align="start"` 4/8: conversaciones + hilo (`CocoaSection scroll="y"`); burbujas `CocoaCard bordered padding="sm"` (propias sobre `--cocoa-accent-bg`); compositor `cocoa-row` con `CocoaInput multiline` (Enter envía, Mayús+Enter salta de línea) + `CocoaButton`; `CocoaBadge tone="ai"`. |
| **Diálogo / drawer** | 14 | GroupDetailDialog, QuickCheckInDrawer | `CocoaDialog` (≤ 440) o `CocoaDrawer` (≥ 480) con secciones de formulario; nunca `<div position:fixed>` propio. |
| **Contenedor de pestañas** | 39 | `screens/tabs/**` | Ya en Cocoa (`NavItemTabs`); solo consumen `CocoaPageHeader`. |

### 4.1 Pilotos (lote «pilot», 2026-09-15)

Cada arquetipo tiene una pantalla piloto migrada que sirve de plantilla real (contrato `tests/cocoa-22-contract.test.mjs`, allowlist `NOT_MIGRATED`). Antes de migrar una pantalla, copia la receta del piloto de su arquetipo.

| Arquetipo | Pantalla piloto | URL | Qué usa | Lecciones |
|---|---|---|---|---|
| **Dashboard** (canon) | `screens/operations/GeneralManagerScreen.tsx` | `/hoy/direccion` (alojada en Mi día) | `CocoaPage` (state/skeleton/empty/commands) → `CocoaKpiStrip stagger` + `CocoaKpi` × 11 → `CocoaGrid`/`CocoaSpan` 8/2/2 · 4/4/2/2 · 3×4 · 5/4/3 → `CocoaSection` + `CocoaChart.Line/Bars/Gauge/Donut` → `CocoaBadge`, `CocoaState inline/dashed`, listas `c22-section__list`; `CocoaSkeleton.Strip/Grid` espejo | 12 `style={` (presupuesto 25). Paridad medida a 1440/390 claro/oscuro: columnas 12 × 85 px, gap 12, tira 6 × 182, tarjeta bordered 16 px, h3 15/17,25/600, botón small 22 px, tile 32 px 600 tabular. Cambios deliberados de la spec: KPI con `--cocoa-shadow-card` (§3.5), badges y texto ≤ 13 px en tinta AA (`toneInk`), cabecera h3 en pickup/gauge/donut, leyenda del pace bajo el título (+27 px de fila). Alojada NO pasa `subtitle` (paridad con la fila de acciones del canon y bug de `HostedHead`, ver handoffs). Los `Director*` de listas (segmentos, BAR, ops, VIP, cumplimiento, insight) se conservan hasta la ola 2. |
| **Lista / tabla** | `screens/guests/GuestsListScreen.tsx` | `/recepcion/huespedes` (alojada en Huéspedes) | `CocoaPage` → `CocoaToolbar variant="content"` + `CocoaSearchInput` → `CocoaSection padding="none"` (+ `overflow: clip` para recortar al radio 12 sin crear un scroll container: `hidden` capturaría el `thead` sticky, que se ancla al scroller de página) → `CocoaTable` (`rowKey`, `onSelect` abre la ficha, Enter/Espacio) → `footer` con recuento y «Cargar más» (`loading`) → `CocoaState empty` con acción primaria; `< 600` tarjetas apiladas | 3 `style={`. La barra de búsqueda sigue visible en los estados vacío/error/carga (no se delega el estado a `CocoaPage`); la acción «Nuevo huésped» solo se pinta standalone (el contenedor ya la lleva); `CocoaSearchInput` sin `debounceMs` (la pantalla conserva su debounce de 250 ms). |
| **Formulario / ajustes** | `screens/propertySetup/PropertySetupForms.tsx` (14 formularios, un renderizador) | `/configuracion/propiedad` (alojada en Propiedad) y hermanos | `CocoaPage` → `CocoaGrid` 6/6 de `CocoaSection` («Sobre este formulario», «Estado actual» con `CocoaCallout` del guardado) → `CocoaFormSection columns={2}` con `CocoaField` + `CocoaInput/Select/Switch/DatePicker`, `multiline` para textarea, `fullWidth` en textarea y chips → `ValidationSummary` (lista + `CocoaBadge warning`) → `CocoaActionBar` (solo Cancelar + Guardar, `publishToastOffset`, ⌘/Ctrl+Enter; el estado del guardado vive en el `CocoaCallout` de «Estado actual»); «Guardar y añadir otro» e «Historial de auditoría» viven en el pie `actions` de la `CocoaFormSection` | 4 `style={`. `multi_select` pasa de un input separado por comas a un grupo de chips `CocoaButton` con `aria-pressed`. Alojada, la descripción del formulario va como primer párrafo del panel «Sobre este formulario» (no como `subtitle`). Medido a 390: con cuatro botones la barra fija desbordaba (primaria a 44 px de ancho); con dos botones estirados cabe — máximo dos acciones en la barra, el resto en la sección. `DataPreview` (componente legacy) sigue pintando «Valores actuales» hasta que el lote de componentes lo lleve a `CocoaTable`. |
| **Dashboard operativo (Hoy)** | `screens/operations/ShiftManagerScreen.tsx` | `/hoy/turno` (standalone) | `CocoaPage` con `state`/`skeleton`/`error`/`commands` → `CocoaSection` «Productividad» y «Caja» con `CocoaKpiStrip min={200}` de `CocoaKpi` (unidad «de N», `deltaLabel` con el ratio) → flags como `CocoaCallout` en una tira `min={240}` con iconos de estado → cronología en `ol.c22-section__list` con `CocoaBadge variant="dot"` por importancia (sin emoji) | 4 `style={`. Los KPI dentro de una `CocoaSection` anidan sombra de tarjeta sobre tarjeta bordered (como el canon `.rev-kpi` dentro de `.bo-card`); el color de la hora sigue la importancia con `toneInk`. |
| **Detalle** | `screens/billing/FolioDetailScreen.tsx` (Cocoa 22 · lote 6-A) | `/finanzas/facturacion/folios/:id` (alojada en Facturación y cobros; `useRouteParam` del `:id`) | `CocoaPage` con badge de estado y acciones (Cobrar · Devolver · Dividir · Cerrar) en la cabecera y vistas internas `tabs` (Cargos · Cobros · Enrutamiento) → `CocoaGrid align="start"` 8/4: cuerpo con `CocoaSection padding="none"` + `CocoaTable` (`rowActions` «Mover» / «Devolver», `rowTone` para las devoluciones) y aside con `CocoaStat` (saldo `size="large"` con tono, cargos, cobrado neto) y lista `c22-section__list` de los otros folios → `CocoaDialog` con `busy` para cerrar (destructivo), dividir y mover (`initialFocus` en el campo) → `components/billing/PaymentDialog` y `RefundDialog` (Tanda 6: método enum, `clientRequestId`, 202 → pasarela, 409 honesto) | 3 `style={` (presupuesto 15). Sin `:id` la página ofrece un `CocoaFormRow` de búsqueda por identificador en vez de un `CocoaState empty` (el operador llega desde Facturación y cobros o la reserva). Los `<div draggable>` con estilos de color del legacy se sustituyen por la acción «Mover» por fila (accesible por teclado; mismo `POST /folios/:id/move-charges`). La pestaña «Notas» (sessionStorage sin API) se retira. |

Contrato de salida de un piloto: 0 `.bo-*`, 0 `<button>`/`<table>`/`<input>` crudos, 0 colores literales, `style={` ≤ presupuesto y solo de layout en literales, cabecera Cocoa, sin emoji, `docs/design/cocoa-22-inventory.json` regenerado (`node scripts/cocoa-22-inventory.mjs`) y la pantalla fuera de `NOT_MIGRATED` (el techo `ALLOWLIST_CEILING` baja con ella).

### 4.2 Reglas que rompen (compilación, contrato o layout)

Lo que §8 no dice por sí solo y que ha roto (o casi) los pilotos. Cada regla cita el código que la impone; migrar sin leerlas obliga a leer el código.

**A · Compilación (`corepack pnpm --filter @hotelos/admin-web typecheck`)**

1. **Imports.** Todo lo Cocoa sale del barrel `../../components/cocoa` (`index.ts`, §8.2), incluidos `openTabPath`, `useIsNarrow`, `useViewportTier`, `toneInk`, `toneFromStatus`, `thresholdTone`, `DegradedValue/*` y `CocoaEmptyState`. Fuera del barrel: `useTabHost` de `../tabs/TabHost`; `useRouteParam`/`treeHeaderFor` de `../tabs/tab-helpers`; `useToast` de `../../components/Toast`; formato de `../../lib/format`; copy de `../../content/actions`; `navigateTo(screenKey)` de `../../lib/navigate` (claves = `SCREEN_COMPONENTS` de `App.tsx`); `urlForScreen(screenKey, params)` de `../../navigation/nav-tree`; iconos de `../../components/cocoa-icons/{ActionIcons,NavigationIcons,StatusIcons}`; datos con `useApiData<T>(path | null, { pollIntervalMs })` de `../../hooks/useApiData` y `toArray<T>()` de `../../utils/toArray` para cualquier array del payload.
2. **`CocoaPage.title` es obligatorio también alojada** (`Pick<CocoaPageHeaderProps, "title">`, `title: string`): alojada no se pinta, pero nombra `data-hosted-head` y el `aria-label` del control segmentado de vistas internas.
3. **Controles controlados de valor primitivo.** `CocoaInput`, `CocoaSelect`, `CocoaDatePicker`, `CocoaSearchInput` y `CocoaSegmentedControl` → `value: string` + `onChange(v: string)`; `CocoaSwitch` → `checked: boolean` + `onChange(v: boolean)`; `CocoaStepper` → `value: number` + `onChange(v: number)`; `CocoaFileInput` → `onPick(file: File)` (+ `onReject(message)`), el único `<input type="file">` vive en la primitiva. No hay `event.target`: los números viajan como cadena y se parsean al guardar (`toNumber` de `lib/format`). `CocoaInput type="number"` sigue entregando `string`.
4. **`CocoaField` exige UN hijo `ReactElement`** (`Children.only`): un fragmento, dos controles o texto suelto lanzan en tiempo de ejecución. El hijo recibe `id`, `aria-describedby`, `aria-invalid` y, si es un control Cocoa, `error`/`required`; no pongas otro `<label>` dentro.
5. **`CocoaTable<Row>`**: `columns: CocoaTableColumn<Row>[]` declaradas fuera del componente; `rowKey` (clave o función) para selección estable; **la tabla no ordena**: `sortBy` + `onSort` son controlados (`nextSort` ya calcula el siguiente estado); `rows: Row[]` mutable (nada de `as const`).
6. **`CocoaSkeleton.Grid rows`** es `ReadonlyArray<ReadonlyArray<CocoaSpanCols>>` (literales 1…12): escríbelo inline en JSX (`rows={[[8, 2, 2], [4, 4, 2, 2]]}`); una constante `const rows = [[8, 2, 2]]` se ensancha a `number[][]` y no compila (`as const` lo arregla).
7. **`CocoaKpi`**: `value: string | number` ya formateado (`percent()`, `money()`); `delta` es un número sin formatear (la primitiva pinta «▲ 3,1 % vs LY» con `formatDelta`); `deltaUnit` solo `"%" | "pp" | "€" | "pts"`; `sparkline: readonly number[]`; `status` solo `"ok" | "warning" | "critical"`.
8. **`CocoaActionBar.primary/secondary`** son `CocoaActionBarAction` (= props de `CocoaButton` + `label`), no nodos: `primary={{ label, onClick, loading, disabled }}`. Ctrl/⌘+Enter ejecuta `primary.onClick`.
9. **Obligatorios de las capas.** `CocoaDialog`: `open`, `onClose`, `title`, `onConfirm: () => void | Promise<void>` (`busy` lo gestiona el llamador; `hideCancel` para avisos de un botón). `CocoaDrawer`: `open`, `onClose`, `title`, `children`. `CocoaState`: `kind`. `CocoaPage.empty/error` son `Partial<Omit<CocoaStateProps, "kind">>`: basta `error={{ message, onRetry }}`.
10. **`CocoaButton`** no acepta `role`, `aria-selected` ni `data-*` distintos de `data-cocoa` (los `data-tour` van en un `<span>` envolvente); un botón solo icono exige `aria-label`; `size="large"` es 15 px. **`CocoaChart.Line`**: `series[].tone` es `CocoaSeriesTone` (`CocoaTone | "tertiary"`), `width` solo `1 | 2`, `points[].x` ya formateado (`date(d, "dayMonth")`).
11. **`CocoaSection.title` es opcional**, pero sin título hay que pasar `aria-label`; `headingLevel` 2 | 3 (3 por defecto: h3 bajo el h1 de la página). `meta` y `action` van a la derecha (`action` = `CocoaButton variant="plain" size="small"`).
12. **`CocoaStat.value` es `ReactNode`** (texto ya formateado); `suffix` pinta decimales/símbolo en secundario; `tabular={false}` para valores de texto.

**B · Contrato (`tests/cocoa-22-contract.test.mjs`, §9)**

13. **Allowlist.** Una pantalla migrada = su línea borrada de `NOT_MIGRATED` y `ALLOWLIST_CEILING` una unidad menor (hoy 197); desde ese momento le aplican las 15 reglas. `docs/design/cocoa-22-migrated.json` no existe: la lista vive en el test.
14. **Regla 6 (`style=`).** ≤ presupuesto por pantalla: 25 dashboard · 15 lista/detalle/formulario · 40 calendario/workspace — el mapa `STYLE_BUDGET` del test necesita una entrada por cada pantalla que no sea dashboard (sin entrada = 25). Dentro de un literal `style={{…}}` solo claves de layout: `display grid* flex* gap rowGap columnGap align* justify* min* max* width height margin* padding* overflow* position inset* top right bottom left order place* boxSizing visibility pointerEvents`. `color`, `background`, `fontSize`, `border` en un literal rompen; en una constante `const x: CSSProperties = { color: toneInk("danger") }` no se inspeccionan, pero el color literal sigue prohibido (regla 5) y cada uso cuenta como un `style=`. (Hoy el regex del test no inspecciona el PRIMER prop del literal —`{{ color: … }}` escapa—; no confíes en ello: handoff al lote contract.)
15. **Reglas 2–4, 8–11.** `<button>` → `CocoaButton`; `<table>` solo dentro de `<CocoaScrollArea>` y con `data-cocoa-grid-table` (parrillas); `<input>` solo `type="file"` o `"hidden"`; ningún `<h1>` (lo pone `CocoaPage`); sin `position: "fixed"` ni `zIndex` numérico (las capas las ponen `CocoaDrawer/Dialog/Toast/ActionBar`); sin emoji en JSX (iconos de `cocoa-icons` con `aria-hidden` + texto); sin `transition: "all"` ni `animation … infinite`.
16. **Regla 12 (tokens).** Cada `var(--cocoa-*)` de una pantalla o de `components/cocoa*` debe existir en `styles/*.css`; `var(--cocoa-x, fallback)` se tolera pero es deuda (§7). Texto de tono ≤ 13 px → `toneInk(tone)`; cifras ≥ 24 px, barras y trazos → `toneColor(tone)`; fondos → `toneBg/toneBorder`.
17. **Reglas 13 y 15 (inventario).** Tras tocar cualquier pantalla: `node scripts/cocoa-22-inventory.mjs` y commit de `docs/design/cocoa-22-inventory.json`; la 15 falla si otro lote cambió pantallas sin regenerar, y la 13 si sube cualquier total. (El inventario reconoce `<CocoaPage` y `<NavItemTabs` como cabecera desde la integración del 2026-09-15, igual que el contrato.)

**C · Copy y formato (`tests/admin-web-spanish-copy-contract.test.mjs`)**

18. **Toda cifra visible sale de `lib/format`**: `money(v, currency?, { decimals?: n | "auto", compact?, signDisplay? })` («1.234,56 €»), `number(v, { maximumFractionDigits })`, `percent(v, { signDisplay: "always", maximumFractionDigits: 1 })` (entrada en unidades de porcentaje: 12,5 → «12,5 %»; `ratio: true` para 0,125), `date(v, "short" | "medium" | "long" | "weekday" | "weekdayShort" | "weekdayOnly" | "dayMonth" | "monthYear" | "relative")`, `time(v)`, `dateTime(v)`, `dateRange(a, b)`, `plural(n, "reserva", "reservas")` («3 reservas»), `relativeTime(v)`. Prohibidos en pantallas: `Intl.NumberFormat/DateTimeFormat`, `toLocale*String(`, `toFixed(n)` seguido de «€»/«%», `} EUR` en JSX, `"EUR"` literal (la divisa viene del registro o de `DEFAULT_CURRENCY`). El canon cayó en esto (`pctVsLY.toFixed(1)}%`).
19. **Ni un literal inglés del diccionario** (`Save`, `Cancel`, `Loading`, `Status`, `Name`, `Email`, `Phone`, `Type`, `Date`, `Amount`, `Open`, `Close`, `Details`, `Refresh`, `Retry`, …) en texto JSX, `label=`, `label:` ni ternarios: usa `ACTIONS.*`, `STATUS_LABELS.*`, `FIELD_LABELS.*`, `A11Y_LABELS.*`, `newLabel("f", "reserva")`, `emptyStateFor()`, `errorStateFor()`, `confirmDelete()`, `confirmDiscard()`. Sin jerga en pantalla («Próximamente», «TODO», «mock», «stub», «sandbox», «Q1…Q4»).

**D · Layout y comportamiento (medido en los pilotos)**

20. **Alojada** (`useTabHost() !== null`): el contenedor pinta eyebrow + H1; la página aporta acciones y vistas internas (`tabs`). **No pases `subtitle` alojada** (los pilotos usan `subtitle={hosted ? undefined : …}`): `screens/tabs/tab-helpers.tsx:42` ya lleva `flex: "0 0 auto"` en `subtitleStyle` (`leadStyle` conserva `1 1 320px` en el contenedor), pero la regla sigue vigente hasta que la QA visual de la Tanda 6 mida un `HostedHead` con subtítulo; la acción «Nuevo…» que ya pinta el contenedor tampoco se repite (`actions={hosted ? undefined : …}`). Una página alojada sin subtítulo, acciones ni `tabs` no pinta cabecera alguna.
21. **`CocoaSection` es flex column** (raíz `display:flex; flex-direction:column; height:100%`, cuerpo `.c22-section__body` flex column con gap 8): los hijos se apilan y se estiran a lo ancho; dos controles en fila necesitan `<div className="cocoa-row" data-gap="2">`; `<p>` y `<ul className="c22-section__list">` no llevan márgenes propios. Una celda `CocoaSpan` estira su sección a `height: 100%` (filas alineadas); si el contenido debe quedar arriba, `CocoaGrid align="start"`.
22. **`CocoaGrid/CocoaSpan`**: 12 columnas, gap 12; `min` se redondea al bucket 200/240/320/480 (`minBucket`); < 600 px → 1 columna; 600–899 → spans < 6 pasan a 6; rejilla < 912 px → un `min` que no cabe promociona a 6 y luego a 12; ≥ 912 spans reales (el canon 8/2/2 a 1120 px se conserva). Todo por clase (`c22-span-N`, `c22-min-B`), nunca `grid-column` inline.
23. **`CocoaKpiStrip`**: `min` 180 (canon), 200 (ops) y 240 (callouts) los resuelve la hoja; otros valores viajan como `--c22-kpi-min` inline; < 600 una columna. Los KPI dentro de una `CocoaSection` anidan sombra de tarjeta sobre tarjeta (aceptado, como el canon).
24. **`CocoaPage fullBleed`** cancela el gutter (`--cocoa-content-padding` 24 / 16) solo en el cuerpo; `density="compact"` conmuta `--cocoa-density-*` (padding de tarjeta, filas 28 px, controles) en todo el subárbol; `gap` 3 | 4 | 5 = 12 / 16 / 24 px entre secciones.
25. **Capas.** `CocoaDrawer` en teléfono siempre es hoja inferior (`drawerGeometry`); `CocoaDialog` `sm` 440 · `md` 560; ambos bloquean scroll, atrapan foco, cierran con Esc y clic en el scrim (`dismissible`). `CocoaActionBar` fija en < 600 con safe-area: **máximo dos acciones** (medido a 390: con cuatro la primaria queda en 44 px); el resto va al pie `actions` de la `CocoaFormSection`; `publishToastOffset` aparta los toasts.
26. **Tablas en tarjeta.** `CocoaSection padding="none"` + `style={{ overflow: "clip" }}` (recorta al radio 12 **sin** crear un scroll container: `overflow: hidden` en cualquier ancestro captura el `thead` sticky de `CocoaTable`, que se ancla al scroller de página `main.cocoa-content`); cabecera y pie conservan su inset de 16. `CocoaTable` apila tarjetas por sí sola en < 600 (`hideOnNarrow` oculta columnas secundarias en teléfono); con 7 o más columnas, las cortas —fecha, número, importe, estado— llevan `fit` (ajustadas a su contenido, una línea) y las secundarias `showFrom: "desktop"`, para que en un portátil de 1024 el ancho libre vaya a la columna de texto (medido sin ello: «Concepto» cae a 117 px y parte en 6 líneas); `minWidth` en la de texto es el suelo bajo el cual la tabla pasa a scroll horizontal; `loading` pinta filas skeleton; `onSelect` hace la fila foco + Enter/Espacio; `rowActions` debe parar la propagación (`event.stopPropagation()`) para no abrir la fila.
27. **Estados.** `CocoaState inline` dentro de tarjeta = una línea caption («Sin anomalías detectadas.»); `dashed` = caja punteada con CTA (comp-set); `kind="degraded"` para «—» con explicación; `CocoaPage state="empty" | "error"` sustituye TODO el cuerpo (la barra de búsqueda desaparece: las listas pintan su vacío/error dentro de la sección, como GuestsList, y solo delegan `loading`).
28. **⌘K.** `commands` se registran mientras la página está montada: ids únicos por pantalla (`<pantalla>-<acción>`), `run` puede cambiar de clausura (la primitiva lee la última); `shortcut` es solo indicativo (nadie lo enlaza).
29. **Accesibilidad.** `CocoaKpi` calcula su `aria-label` («Ocupación, 71 %, +3 % vs LY»); los gráficos llevan `aria-label` descriptivo o son decorativos (`CocoaSparkline` sin etiqueta); `CocoaLiveRegion` una por página; los iconos solo decorativos van `aria-hidden` y con texto al lado.

### 4.3 Plantillas por arquetipo (alojada y standalone, imports completos)

Cada plantilla es un fichero completo que **compila contra las primitivas del working tree**: `node docs/design/cocoa-22-api.mjs --typecheck-examples` las extrae de este documento (bloques ```tsx cuya primera línea es `// file: screens/ejemplos/<Nombre>.tsx`), espeja `apps/admin-web/src` con enlaces simbólicos en un directorio temporal y ejecuta el `tsc` de admin-web sobre ellas (verificado 2026-09-15: 11 plantillas, 0 errores en las plantillas ni en admin-web). Todas son la MISMA función alojada y standalone: `useTabHost()` decide qué pinta la cabecera; lo demás no cambia.

| Arquetipo | Plantilla | Modo mostrado | Piloto real |
|---|---|---|---|
| Cualquiera | `PlantillaBase` | alojada y standalone (esqueleto mínimo) | — |
| Dashboard | `DashboardAlojado` | alojada (contenedor Mi día) | `operations/GeneralManagerScreen.tsx` |
| Dashboard | `DashboardStandalone` | standalone (ruta propia) | `operations/ShiftManagerScreen.tsx` |
| Lista / tabla | `ListaTabla` | alojada y standalone (búsqueda, orden controlado, drawer) | `guests/GuestsListScreen.tsx` |
| Detalle | `Detalle` | standalone `/…/:id` y alojada como pestaña `:id` (`useRouteParam`) | `screens/billing/FolioDetailScreen.tsx` (lote 6-A) |
| Formulario / ajustes | `Formulario` | alojada y standalone | `propertySetup/PropertySetupForms.tsx` |
| Asistente / wizard | `Asistente` | standalone | `screens/reservations/ReservationCreateScreen.tsx` (lote 3-A) |
| Workspace split | `Workspace` | standalone (rejilla 4/8; < 900 lista + drawer) | `screens/reservations/ReservationWorkspaceScreen.tsx` · `screens/guestJourney/GuestJourneyWorkspace.tsx` (ola 3) |
| Calendario / parrilla | `Calendario` | standalone `fullBleed` + `density="compact"` | `screens/revenue/RateGridEditorScreen.tsx` (parrilla, lote 5-A) · `screens/timeline/LiveTimelineWorkspace.tsx` (cronograma, lote 3-A) |
| Chat / asistente IA | `Chat` | standalone | — (AssistantChat) |
| Diálogo / drawer | `DialogoDrawer` | componentes, no páginas (`*Dialog.tsx`, `*Drawer.tsx`) | `screens/operations/QuickCheckInDrawer.tsx` (ola 2) · `screens/operations/NewGroupDialog.tsx` (lote 3-B) |
| Contenedor de pestañas | — | ya Cocoa (`NavItemTabs`, `CocoaRouteTabs`); solo consumen `CocoaPageHeader` | `screens/tabs/**` |

Las llamadas a la API de las plantillas (`/ejemplo…`) son ilustrativas: sustitúyelas por el endpoint real y su tipo. Los `await new Promise(setTimeout)` marcan dónde va `apiRequest`.

#### `PlantillaBase` — Esqueleto mínimo: cabecera alojada/standalone, estado, skeleton, ⌘K.

```tsx
// file: screens/ejemplos/PlantillaBase.tsx
// Esqueleto mínimo de una pantalla Cocoa 22. La MISMA función sirve alojada
// (dentro de un contenedor de screens/tabs/**, p. ej. /hoy/direccion) y
// standalone (ruta propia): `useTabHost()` decide qué pinta la cabecera.
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { CocoaButton, CocoaPage, CocoaSection, CocoaSkeleton } from "../../components/cocoa";

type Data = { total: number; items: Array<{ id: string; label: string }> };

export function PlantillaBaseScreen() {
  // Alojada: el contenedor ya pintó eyebrow + H1 (+ subtítulo); la página solo
  // añade su fila de acciones. `title` sigue siendo obligatorio (nombre de la
  // cabecera alojada y del control segmentado).
  const hosted = useTabHost() !== null;
  const { data, loading, error, refresh } = useApiData<Data>(`/ejemplo?propertyId=${getActivePropertyId()}`, { pollIntervalMs: 60000 });
  const state = loading && !data ? "loading" : error && !data ? "error" : data && data.total === 0 ? "empty" : "ready";

  return (
    <CocoaPage
      eyebrow="Operaciones · Ejemplo"
      title="Ejemplo"
      // Alojada NO se pasa subtítulo (D20): el contenedor pinta la cabecera; pendiente de medir en la QA visual.
      subtitle={hosted ? undefined : "Qué muestra esta pantalla, en una frase."}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      state={state}
      skeleton={<CocoaSkeleton variant="card" height={240} />}
      empty={{ title: "Aún no hay datos", message: "Los datos aparecen aquí cuando la propiedad registre actividad." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "ejemplo-refresh", label: "Actualizar ejemplo", run: refresh }]}
    >
      <CocoaSection title="Contenido" meta={data ? `${data.total} elementos` : undefined}>
        <ul className="c22-section__list">
          {data?.items.map((item) => (
            <li key={item.id}>
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      </CocoaSection>
    </CocoaPage>
  );
}
```

#### `DashboardAlojado` — Dashboard alojado (Mi día): tira de KPI, rejilla 8/2/2 con `CocoaChart.Line/Bars/Gauge`, listas, estados `inline`/`dashed`, skeleton espejo.

```tsx
// file: screens/ejemplos/DashboardAlojado.tsx
// Dashboard ALOJADO (como GeneralManagerScreen en /hoy/direccion): tira de KPI,
// rejilla 8/2/2 con gráficos, listas y estados honestos. Standalone la misma
// función pinta además eyebrow + H1 + subtítulo (ver DashboardStandalone).
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { date, money, percent, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaChart,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  DegradedBanner,
  DegradedValue,
  type CocoaBarsDatum,
  type CocoaLineSeries
} from "../../components/cocoa";

type PaceRow = { date: string; otb: number; forecast: number; lastYear: number };
type Data = {
  asOf: string;
  occupancyPct: number;
  occupancyVsLyPct?: number;
  adrEur: number;
  adrVsLyPct?: number;
  cancellationRiskScore: number;
  pace: PaceRow[];
  anomalies: Array<{ id: string; title: string; severity: "warning" | "danger" }>;
  degraded?: string[];
};

// Skeleton espejo: mismos spans que el contenido → sin salto de layout.
function DashboardSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[8, 2, 2], [6, 6]]} />
    </div>
  );
}

export function DashboardAlojadoScreen() {
  const hosted = useTabHost() !== null;
  const propertyId = getActivePropertyId();
  const { data, loading, error, refresh } = useApiData<Data>(`/dashboards/ejemplo?propertyId=${propertyId}`, { pollIntervalMs: 60000 });
  const k = data;
  const degraded = toArray<string>(data?.degraded);
  const pace = toArray<PaceRow>(data?.pace);

  // Series del gráfico de líneas: `x` ya formateado, tonos del canon (accent · warning dashed · tertiary).
  const paceSeries: CocoaLineSeries[] = [
    { id: "otb", label: "OTB", points: pace.map((r) => ({ x: date(r.date, "dayMonth"), y: r.otb })), tone: "accent", width: 2 },
    { id: "forecast", label: "Previsión", points: pace.map((r) => ({ x: date(r.date, "dayMonth"), y: r.forecast })), tone: "warning", dashed: true, width: 2 },
    { id: "ly", label: "Año anterior", points: pace.map((r) => ({ x: date(r.date, "dayMonth"), y: r.lastYear })), tone: "tertiary", width: 1 }
  ];
  const pickup: CocoaBarsDatum[] = pace.slice(0, 7).map((r) => ({
    label: date(r.date, "weekdayOnly"),
    value: r.otb - r.lastYear,
    hint: r.lastYear > 0 ? `vs LY: ${percent(((r.otb - r.lastYear) / r.lastYear) * 100, { signDisplay: "always", maximumFractionDigits: 1 })}` : undefined
  }));

  return (
    <CocoaPage
      eyebrow={`Gerencia · ${getActiveProperty().propertyName}`}
      title="Dashboard de ejemplo"
      subtitle={hosted ? undefined : k ? `Vista del día · datos a ${date(k.asOf, "short")}` : "Vista del día"}
      actions={
        <>
          <DegradedBanner degraded={degraded} />
          {error ? <CocoaBadge tone="danger">{error}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !k ? "loading" : error && !k ? "error" : !k ? "empty" : "ready"}
      skeleton={<DashboardSkeleton />}
      empty={{ title: "Sin datos hoy", message: "El cuadro se rellena con la actividad de la propiedad a lo largo del día." }}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "ejemplo-dashboard-refresh", label: "Actualizar dashboard de ejemplo", run: refresh }]}
    >
      {k ? (
        <>
          <CocoaKpiStrip stagger aria-label="Indicadores de hoy">
            <CocoaKpi label="Ocupación" value={percent(k.occupancyPct)} delta={k.occupancyVsLyPct} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" sparkline={pace.slice(0, 7).map((r) => r.otb)} status="ok" />
            <CocoaKpi label="ADR" value={money(k.adrEur)} delta={k.adrVsLyPct} deltaUnit="%" deltaLabel="vs LY" polarity="positive-good" status={k.adrVsLyPct !== undefined && k.adrVsLyPct < 0 ? "warning" : "ok"} />
            <CocoaKpi label="Riesgo de cancelación" value={k.cancellationRiskScore} unit="/ 100" polarity="negative-good" status={k.cancellationRiskScore > 60 ? "critical" : "ok"} />
            <CocoaKpi label="Anomalías" value={k.anomalies.length} deltaLabel="hoy" polarity="neutral" degraded={degraded.includes("aiAnomalies")} />
          </CocoaKpiStrip>

          <CocoaGrid aria-label="Pace, pickup y riesgo">
            <CocoaSpan cols={8} min={480}>
              <CocoaSection title="Pace próximos 30 días" meta="OTB · Previsión · Año anterior">
                {pace.length > 0 ? (
                  <CocoaChart.Line series={paceSeries} yLabel="Habitaciones" aria-label="Pace de los próximos 30 días" />
                ) : (
                  <CocoaState kind="empty" inline title="Sin datos de pace." />
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={2} min={200}>
              <CocoaSection title="Pickup 7 días">
                <CocoaChart.Bars data={pickup} height={120} aria-label="Pickup de los próximos siete días" />
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={2} min={200}>
              <CocoaSection title="Riesgo de cancelación">
                <CocoaChart.Gauge value={k.cancellationRiskScore} thresholds={[30, 60]} label="Índice" caption={plural(Math.round(k.cancellationRiskScore / 5), "reserva en riesgo", "reservas en riesgo")} />
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaGrid>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Anomalías" meta={plural(k.anomalies.length, "detectada", "detectadas")}>
                {k.anomalies.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin anomalías detectadas." />
                ) : (
                  <ul className="c22-section__list">
                    {k.anomalies.map((a) => (
                      <li key={a.id}>
                        <span>{a.title}</span>
                        <CocoaBadge tone={a.severity}>{a.severity === "danger" ? "alta" : "media"}</CocoaBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={6} min={320}>
              <CocoaSection title="Comp-set">
                <CocoaState kind="empty" dashed title="Conectar STR / CoStar" message="Sin feed externo. Activa la integración para ver el comp-set." primaryAction={{ label: "Configurar", onClick: refresh }} />
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          <p className="cocoa-sr-only">
            Ocupación <DegradedValue label="occupancy" degraded={degraded}>{percent(k.occupancyPct)}</DegradedValue>
          </p>
        </>
      ) : null}
    </CocoaPage>
  );
}
```

#### `DashboardStandalone` — Dashboard standalone (Turno): secciones con tiras de KPI, `CocoaCallout` con iconos, cronología en `ol.c22-section__list`.

```tsx
// file: screens/ejemplos/DashboardStandalone.tsx
// Dashboard STANDALONE (como ShiftManagerScreen en /hoy/turno): sin contenedor,
// la página pinta eyebrow + H1 + subtítulo + acciones siempre. Secciones con
// tiras de KPI, avisos CocoaCallout y una cronología en lista.
import type { CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { money, plural, time } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CheckCircleIcon, ExclamationCircleIcon } from "../../components/cocoa-icons/StatusIcons";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaKpi, CocoaKpiStrip, CocoaPage, CocoaSection, CocoaSkeleton, CocoaState, toneInk, type CocoaTone } from "../../components/cocoa";

type Flag = { id: string; title: string; detail: string; status: "ok" | "warning" };
type Event = { id: string; title: string; amountEur?: number; at: string; importance: "low" | "high" };
type Data = { kpis: { checkIns: number; pendingArrivals: number; cashEur: number }; flags: Flag[]; events: Event[] };

const FLAG_TONE: Record<Flag["status"], CocoaTone> = { ok: "success", warning: "warning" };

// Importes: los reembolsos (negativos) en la tinta AA de danger; fuera de un literal `style={{…}}` (regla 6).
function amountStyle(amount: number): CSSProperties {
  return { color: amount < 0 ? toneInk("danger") : "var(--cocoa-label)" };
}

function ShiftSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} min={200} />
      <CocoaSkeleton variant="card" height={220} />
    </div>
  );
}

export function DashboardStandaloneScreen() {
  const { data, loading, error, refresh } = useApiData<Data>(`/dashboards/ejemplo-turno?propertyId=${getActivePropertyId()}`, { pollIntervalMs: 30000 });
  const k = data?.kpis;
  const flags = toArray<Flag>(data?.flags);
  const events = toArray<Event>(data?.events);

  return (
    <CocoaPage
      eyebrow={`Hoy · ${getActiveProperty().propertyName}`}
      title="Turno de ejemplo"
      subtitle="Productividad del equipo, caja del día y bloqueos críticos."
      actions={
        <>
          {loading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<ShiftSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: refresh }}
      commands={[{ id: "ejemplo-turno-refresh", label: "Actualizar el turno de ejemplo", run: refresh }]}
    >
      {k ? (
        <CocoaSection
          title="Productividad del turno"
          meta={plural(k.pendingArrivals, "llegada pendiente", "llegadas pendientes")}
          action={
            <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("FinancePositionDashboard")}>
              {ACTIONS.viewDetail}
            </CocoaButton>
          }
        >
          <CocoaKpiStrip min={200} aria-label="Productividad del turno">
            <CocoaKpi label="Check-ins hechos" value={k.checkIns} unit={`de ${k.checkIns + k.pendingArrivals}`} polarity="neutral" status="ok" />
            <CocoaKpi label="Caja del día" value={money(k.cashEur)} status={k.cashEur < 0 ? "warning" : "ok"} />
          </CocoaKpiStrip>
        </CocoaSection>
      ) : null}

      {flags.length > 0 ? (
        <CocoaSection title="Estado operativo" meta={plural(flags.length, "comprobación", "comprobaciones")}>
          <CocoaKpiStrip min={240} aria-label="Estado operativo">
            {flags.map((f) => (
              <CocoaCallout key={f.id} tone={FLAG_TONE[f.status]} title={f.title} icon={f.status === "ok" ? <CheckCircleIcon size={16} /> : <ExclamationCircleIcon size={16} />}>
                {f.detail}
              </CocoaCallout>
            ))}
          </CocoaKpiStrip>
        </CocoaSection>
      ) : null}

      <CocoaSection title="Eventos del turno" meta={`${events.length} eventos`}>
        {events.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin actividad registrada hoy." />
        ) : (
          <ol className="c22-section__list" aria-label="Eventos del turno">
            {events.map((ev) => (
              <li key={ev.id}>
                <CocoaBadge tone={ev.importance === "high" ? "warning" : "neutral"} variant="dot" size="small">
                  {ev.importance === "high" ? "importante" : "info"}
                </CocoaBadge>
                <span style={{ flex: "1 1 auto" }}>{ev.title}</span>
                {ev.amountEur !== undefined ? <strong style={amountStyle(ev.amountEur)}>{money(ev.amountEur)}</strong> : null}
                <time dateTime={ev.at}>{time(ev.at)}</time>
              </li>
            ))}
          </ol>
        )}
      </CocoaSection>
    </CocoaPage>
  );
}
```

#### `ListaTabla` — Lista / tabla: barra de contenido, orden controlado, selección → `CocoaDrawer`, pie con recuento, vacío/error dentro de la sección.

```tsx
// file: screens/ejemplos/ListaTabla.tsx
// Lista / tabla (como GuestsListScreen en /recepcion/huespedes): barra de
// contenido con búsqueda y filtro, tabla ordenable con selección que abre un
// drawer, pie con recuento. Alojada, el contenedor ya pinta título y la
// acción «Nuevo…»; standalone la página los pinta.
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { date, money } from "../../lib/format";
import { ACTIONS, newLabel } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaDrawer,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaStat,
  CocoaTable,
  CocoaToolbar,
  toneFromStatus,
  type CocoaTableColumn,
  type CocoaTableSort
} from "../../components/cocoa";

type Row = { id: string; code: string; guest: string; arrival: string; nights: number; totalEur: number; status: "confirmed" | "pending" | "cancelled" };

const STATUS_ES: Record<Row["status"], string> = { confirmed: "Confirmada", pending: "Pendiente", cancelled: "Cancelada" };

// Columnas fuera del componente (tipadas con la fila); `render` devuelve ReactNode.
const COLUMNS: CocoaTableColumn<Row>[] = [
  { key: "code", label: "Código", sortable: true, width: "12ch" },
  { key: "guest", label: "Huésped", sortable: true },
  { key: "arrival", label: "Llegada", sortable: true, render: (r) => date(r.arrival, "medium"), hideOnNarrow: true },
  { key: "nights", label: "Noches", align: "right", render: (r) => r.nights },
  { key: "totalEur", label: "Total", align: "right", sortable: true, render: (r) => money(r.totalEur) },
  { key: "status", label: "Estado", render: (r) => <CocoaBadge tone={toneFromStatus(r.status)}>{STATUS_ES[r.status]}</CocoaBadge> }
];

export function ListaTablaScreen() {
  const hosted = useTabHost() !== null;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState<CocoaTableSort>({ key: "arrival", direction: "asc" });
  const [selected, setSelected] = useState<Row | null>(null);
  const { data, loading, error, refresh } = useApiData<Row[]>(`/reservas-ejemplo?propertyId=${getActivePropertyId()}&q=${encodeURIComponent(search)}&status=${status}`);
  const rows = toArray<Row>(data);

  // La tabla NO ordena por sí sola: `sortBy` + `onSort` son controlados.
  const sorted = useMemo(() => {
    const dir = sortBy.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortBy.key as keyof Row];
      const bv = b[sortBy.key as keyof Row];
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [rows, sortBy]);

  const newLabelText = newLabel("f", "reserva");
  const ready = !loading && !error && rows.length > 0;

  return (
    <CocoaPage
      eyebrow="Recepción · Reservas"
      title="Reservas de ejemplo"
      subtitle={hosted ? undefined : "Todas las reservas de la propiedad. Busca por código o huésped."}
      actions={hosted ? undefined : <CocoaButton variant="filled" tone="accent" onClick={() => setSelected(null)}>{newLabelText}</CocoaButton>}
      commands={[{ id: "ejemplo-reservas-new", label: newLabelText, run: () => setSelected(null) }]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Filtros de reservas"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Código o huésped…" aria-label="Buscar reservas" />}
        rightSlot={
          <CocoaSelect
            value={status}
            onChange={setStatus}
            placeholder="Todos los estados"
            aria-label="Filtrar por estado"
            options={[
              { value: "confirmed", label: STATUS_ES.confirmed },
              { value: "pending", label: STATUS_ES.pending },
              { value: "cancelled", label: STATUS_ES.cancelled }
            ]}
          />
        }
      />

      {/* padding="none" + overflow hidden: el thead sticky se recorta al radio 12. */}
      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Listado de reservas" footer={ready ? <span>{rows.length} reservas</span> : undefined}>
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las reservas" message={error} onRetry={refresh} />
        ) : !loading && rows.length === 0 ? (
          <CocoaState kind="empty" illustration={search ? "search" : "box"} title={search ? "Sin resultados" : "Aún no hay reservas"} primaryAction={{ label: newLabelText, onClick: () => setSelected(null) }} />
        ) : (
          <CocoaTable
            columns={COLUMNS}
            rows={sorted}
            rowKey="id"
            loading={loading && rows.length === 0}
            sortBy={sortBy}
            onSort={setSortBy}
            selectedKey={selected?.id}
            onSelect={setSelected}
            rowActions={(r) => (
              <CocoaButton variant="plain" size="small" onClick={(event) => { event.stopPropagation(); setSelected(r); }}>
                {ACTIONS.view}
              </CocoaButton>
            )}
            caption="Reservas de ejemplo"
            aria-label="Reservas de ejemplo"
          />
        )}
      </CocoaSection>

      {/* Detalle en drawer (derecha en escritorio; en teléfono siempre abajo). */}
      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Reserva ${selected.code}` : "Reserva"}
        subtitle={selected ? `${selected.guest} · ${STATUS_ES[selected.status]}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaStat label="Total" value={money(selected.totalEur)} size="large" />
            <CocoaStat label="Llegada" value={date(selected.arrival, "long")} tabular={false} />
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}
```

#### `Detalle` — Detalle: vistas internas con `tabs`, rejilla 8/4 con aside de `CocoaStat`, `CocoaDialog` destructivo con `busy`, `useRouteParam` para `:id`.

```tsx
// file: screens/ejemplos/Detalle.tsx
// Detalle (FolioDetail, InvoiceDetail…): cabecera con badge de estado y
// acciones, vistas internas con `tabs` (segmented en la cabecera; alojada las
// pinta HostedHead), rejilla 8/4 (cuerpo + aside con CocoaStat) y un diálogo
// destructivo con `busy`. Standalone en /finanzas/folios/:id; alojada como
// pestaña `:id` de un contenedor (useRouteParam de tab-helpers).
import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { date, money, plural } from "../../lib/format";
import { ACTIONS, confirmDelete } from "../../content/actions";
import { useToast } from "../../components/Toast";
import { useTabHost, type TabHostInfo } from "../tabs/TabHost";
import { useRouteParam } from "../tabs/tab-helpers";
import { CocoaBadge, CocoaButton, CocoaDialog, CocoaGrid, CocoaPage, CocoaSection, CocoaSkeleton, CocoaSpan, CocoaStat, CocoaState, toneFromStatus } from "../../components/cocoa";

type Line = { id: string; concept: string; amountEur: number; at: string };
type Folio = { id: string; code: string; guest: string; status: "open" | "closed"; balanceEur: number; lines: Line[] };

const VIEWS = [
  { value: "resumen", label: "Resumen" },
  { value: "cargos", label: "Cargos" },
  { value: "historial", label: "Historial" }
];

export function DetalleScreen() {
  const host: TabHostInfo | null = useTabHost();
  const hosted = host !== null;
  // Sub-URL `:id` del contenedor (p. ej. /finanzas/folios/:id); standalone la ruta propia aporta el mismo parámetro.
  const id = useRouteParam(`${host?.basePath ?? "/finanzas/folios"}/:id`, "id");
  const [view, setView] = useState("resumen");
  const [askClose, setAskClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();
  const { data: folio, loading, error, refresh } = useApiData<Folio>(id ? `/folios-ejemplo/${id}` : null);
  const lines = toArray<Line>(folio?.lines);

  async function closeFolio() {
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // llamada real: apiRequest(...)
      showToast("Folio cerrado", { variant: "success" });
      setAskClose(false);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const copy = confirmDelete(`el folio ${folio?.code ?? ""}`, { confirmLabel: "Cerrar folio" });

  return (
    <CocoaPage
      eyebrow="Finanzas · Folios"
      title={folio ? `Folio ${folio.code}` : "Folio"}
      subtitle={hosted ? undefined : folio ? `${folio.guest} · ${plural(lines.length, "cargo", "cargos")}` : undefined}
      tabs={VIEWS}
      activeTab={view}
      onTabChange={setView}
      actions={
        <>
          {folio ? <CocoaBadge tone={toneFromStatus(folio.status)}>{folio.status === "open" ? "Abierto" : "Cerrado"}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="destructive" size="small" disabled={!folio || folio.status !== "open"} onClick={() => setAskClose(true)}>
            Cerrar folio
          </CocoaButton>
        </>
      }
      state={loading && !folio ? "loading" : error ? "error" : !id || !folio ? "empty" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} />}
      empty={{ title: "Folio no encontrado", message: "El enlace no apunta a un folio de esta propiedad." }}
      error={{ message: error ?? undefined, onRetry: refresh }}
    >
      {folio ? (
        <CocoaGrid align="start">
          <CocoaSpan cols={8} min={480}>
            {view === "cargos" ? (
              <CocoaSection title="Cargos" meta={plural(lines.length, "línea", "líneas")}>
                {lines.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin cargos todavía." />
                ) : (
                  <ul className="c22-section__list">
                    {lines.map((l) => (
                      <li key={l.id}>
                        <span>{l.concept}</span>
                        <strong>{money(l.amountEur)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </CocoaSection>
            ) : (
              <CocoaSection title={view === "historial" ? "Historial" : "Resumen"}>
                <p>{view === "historial" ? `Última operación el ${date(lines[0]?.at, "medium")}.` : `Huésped ${folio.guest}.`}</p>
              </CocoaSection>
            )}
          </CocoaSpan>
          <CocoaSpan cols={4} min={240}>
            <CocoaSection title="Saldo" meta={folio.status === "open" ? "pendiente" : "liquidado"}>
              <div className="cocoa-stack" data-gap="3">
                <CocoaStat label="Saldo" value={money(folio.balanceEur, { decimals: 0 })} suffix={money(folio.balanceEur).slice(-5)} tone={folio.balanceEur > 0 ? "warning" : "success"} size="large" />
                <CocoaStat label="Cargos" value={lines.length} hint="líneas en el folio" />
              </div>
            </CocoaSection>
          </CocoaSpan>
        </CocoaGrid>
      ) : null}

      <CocoaDialog open={askClose} onClose={() => setAskClose(false)} tone="destructive" title={copy.title} description={copy.message} confirmLabel={copy.confirmLabel} cancelLabel={ACTIONS.cancel} onConfirm={closeFolio} busy={busy} />
    </CocoaPage>
  );
}
```

#### `Formulario` — Formulario / ajustes: campos controlados por cadena, validación en `CocoaField.error`, `CocoaActionBar` (⌘/Ctrl+Enter), toast, diálogo de descarte.

```tsx
// file: screens/ejemplos/Formulario.tsx
// Formulario / ajustes (como PropertySetupForms en /configuracion/propiedad):
// secciones de formulario con campos controlados por STRING, validación con
// `error` en el campo, barra de acciones (⌘/Ctrl+Enter guarda), toast y
// diálogo de descarte. Alojada NO pasa subtítulo (bug tab-helpers.tsx:41).
import { useState } from "react";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaActionBar,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSelect,
  CocoaStepper,
  CocoaSwitch
} from "../../components/cocoa";

type Values = { name: string; code: string; region: string; maxGuests: number; openingDate: string; active: boolean; notes: string };

const INITIAL: Values = { name: "", code: "", region: "", maxGuests: 2, openingDate: "", active: true, notes: "" };
const CODE = /^[A-Z0-9-]{2,12}$/;

export function FormularioScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [values, setValues] = useState<Values>(INITIAL);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(INITIAL);

  const errors = {
    name: values.name.trim() === "" ? "El nombre es obligatorio." : undefined,
    code: values.code !== "" && !CODE.test(values.code) ? "Entre 2 y 12 caracteres: mayúsculas, dígitos o guion." : undefined
  };
  const valid = !errors.name && !errors.code;

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // llamada real: apiRequest("/…", { method: "PUT", body })
      setSavedAt(new Date().toISOString());
      showToast("Cambios guardados", { variant: "success" });
    } catch {
      showToast("No se pudieron guardar los cambios", { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  const discard = confirmDiscard();

  return (
    <CocoaPage
      eyebrow="Configuración · Propiedad"
      title="Ficha de ejemplo"
      subtitle={hosted ? undefined : "Identidad y capacidad del establecimiento."}
      commands={[{ id: "ejemplo-form-save", label: `${ACTIONS.save}: ficha de ejemplo`, run: () => { void save(); }, shortcut: "⌘ Enter" }]}
    >
      <CocoaFormSection title="Identidad" description="Nombre comercial y código interno.">
        <CocoaFormRow columns={2}>
          {/* CocoaField: UN solo hijo; inyecta id / aria-describedby / aria-invalid / error / required. */}
          <CocoaField label="Nombre" required error={errors.name} help="Como aparece en facturas y comunicaciones.">
            <CocoaInput value={values.name} onChange={(v) => set("name", v)} placeholder="Hotel Rías Altas" autoComplete="organization" />
          </CocoaField>
          <CocoaField label="Código" error={errors.code} hint="opcional">
            <CocoaInput value={values.code} onChange={(v) => set("code", v.toUpperCase())} placeholder="RA-01" maxLength={12} />
          </CocoaField>
          <CocoaField label="Región fiscal" required>
            <CocoaSelect
              value={values.region}
              onChange={(v) => set("region", v)}
              placeholder="Seleccionar…"
              options={[
                { value: "peninsula", label: "Península y Baleares (IVA)" },
                { value: "canarias", label: "Canarias (IGIC)" }
              ]}
            />
          </CocoaField>
          <CocoaField label="Apertura">
            <CocoaDatePicker value={values.openingDate} onChange={(v) => set("openingDate", v)} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Capacidad" columns={2}>
        <CocoaField label="Huéspedes por habitación" help="Máximo permitido al crear reservas.">
          <CocoaStepper value={values.maxGuests} onChange={(v) => set("maxGuests", v)} min={1} max={8} />
        </CocoaField>
        <CocoaField label="Propiedad activa" inline>
          <CocoaSwitch checked={values.active} onChange={(v) => set("active", v)} size="small" />
        </CocoaField>
        <CocoaField label="Notas internas" fullWidth>
          <CocoaInput value={values.notes} onChange={(v) => set("notes", v)} multiline rows={3} placeholder="Solo visible para el equipo." />
        </CocoaField>
      </CocoaFormSection>

      {savedAt ? (
        <CocoaCallout tone="success" title={STATUS_LABELS.saved} role="status">
          Última copia guardada correctamente.
        </CocoaCallout>
      ) : null}

      {/* Máximo dos acciones en la barra (en teléfono se estiran a ancho completo). */}
      <CocoaActionBar
        aria-label="Acciones de la ficha"
        status={dirty ? "Cambios sin guardar" : undefined}
        secondary={{ label: ACTIONS.cancel, onClick: () => (dirty ? setAskDiscard(true) : setValues(INITIAL)) }}
        primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.save, loading: saving, disabled: !valid || saving, onClick: () => { void save(); } }}
        publishToastOffset
      />

      <CocoaDialog
        open={askDiscard}
        onClose={() => setAskDiscard(false)}
        tone="destructive"
        title={discard.title}
        description={discard.message}
        confirmLabel={discard.confirmLabel}
        cancelLabel={discard.cancelLabel}
        onConfirm={() => {
          setValues(INITIAL);
          setAskDiscard(false);
        }}
      />
    </CocoaPage>
  );
}
```

#### `Asistente` — Asistente / wizard: `CocoaChart.Progress` + lista de pasos con `CocoaBadge` (no hay stepper de pasos), una sección por paso, Atrás / Continuar.

```tsx
// file: screens/ejemplos/Asistente.tsx
// Asistente / wizard (GoLiveChecklist, ReservationCreate): indicador de pasos
// con CocoaProgress + lista de pasos con CocoaBadge (NO existe un «stepper»
// de pasos: CocoaStepper es el contador numérico ±), una CocoaSection por
// paso y CocoaActionBar Atrás / Continuar. Standalone (/recepcion/nueva-reserva).
import { useState } from "react";
import { ACTIONS } from "../../content/actions";
import { useToast } from "../../components/Toast";
import { CocoaActionBar, CocoaBadge, CocoaChart, CocoaField, CocoaInput, CocoaPage, CocoaSection, CocoaStepper, CocoaState, type CocoaTone } from "../../components/cocoa";

const STEPS = ["Huésped", "Estancia", "Resumen"] as const;

export function AsistenteScreen() {
  const { showToast } = useToast();
  const [step, setStep] = useState(0);
  const [guest, setGuest] = useState("");
  const [nights, setNights] = useState(1);
  const [done, setDone] = useState(false);
  const last = step === STEPS.length - 1;
  const canContinue = step === 0 ? guest.trim() !== "" : true;

  function stepTone(index: number): CocoaTone {
    return index < step ? "success" : index === step ? "accent" : "neutral";
  }

  function finish() {
    setDone(true);
    showToast("Reserva creada", { variant: "success" });
  }

  return (
    <CocoaPage eyebrow="Recepción · Nueva reserva" title="Asistente de ejemplo" subtitle={`Paso ${step + 1} de ${STEPS.length}: ${STEPS[step]}`} state={done ? "empty" : "ready"} empty={{ title: "Reserva creada", message: "Puedes abrirla desde Reservas.", illustration: "success" }}>
      <CocoaSection title="Progreso" meta={`${step + 1} / ${STEPS.length}`}>
        <CocoaChart.Progress value={((step + 1) / STEPS.length) * 100} label={STEPS[step]} showValue={false} />
        <ol className="c22-section__list" aria-label="Pasos">
          {STEPS.map((label, index) => (
            <li key={label} aria-current={index === step ? "step" : undefined}>
              <CocoaBadge tone={stepTone(index)} variant="dot" size="small">
                {index < step ? "hecho" : index === step ? "actual" : "pendiente"}
              </CocoaBadge>
              <span style={{ flex: "1 1 auto" }}>{label}</span>
            </li>
          ))}
        </ol>
      </CocoaSection>

      {step === 0 ? (
        <CocoaSection title="Huésped">
          <CocoaField label="Nombre del huésped" required error={guest.trim() === "" ? "Indica el nombre para continuar." : undefined}>
            <CocoaInput value={guest} onChange={setGuest} placeholder="Marta Otero" autoFocus />
          </CocoaField>
        </CocoaSection>
      ) : step === 1 ? (
        <CocoaSection title="Estancia">
          <CocoaField label="Noches" help="Entre 1 y 30.">
            <CocoaStepper value={nights} onChange={setNights} min={1} max={30} />
          </CocoaField>
        </CocoaSection>
      ) : (
        <CocoaSection title="Resumen">
          <ul className="c22-section__list">
            <li>
              <span>Huésped</span>
              <strong>{guest}</strong>
            </li>
            <li>
              <span>Noches</span>
              <strong>{nights}</strong>
            </li>
          </ul>
          {nights > 14 ? <CocoaState kind="degraded" inline title="Estancia larga: revisa el precio semanal antes de confirmar." /> : null}
        </CocoaSection>
      )}

      <CocoaActionBar
        aria-label="Navegación del asistente"
        status={`Paso ${step + 1} de ${STEPS.length}`}
        secondary={step > 0 ? { label: ACTIONS.previous, onClick: () => setStep((s) => s - 1) } : undefined}
        primary={last ? { label: ACTIONS.finish, onClick: finish } : { label: ACTIONS.next, disabled: !canContinue, onClick: () => setStep((s) => s + 1) }}
      />
    </CocoaPage>
  );
}
```

#### `Workspace` — Workspace split: rejilla 4/8 con lista `scroll="y"`; por debajo de 900 px la lista es la página y el detalle un `CocoaDrawer`.

```tsx
// file: screens/ejemplos/Workspace.tsx
// Workspace split (ComplianceInbox, ConciergeInbox): lista a la izquierda
// (CocoaSection scroll="y") y detalle a la derecha en una rejilla 4/8; por
// debajo de 900 px la lista es la página y el detalle se abre en un
// CocoaDrawer (en teléfono, hoja inferior automática). Standalone.
import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { date } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CocoaBadge, CocoaButton, CocoaDrawer, CocoaGrid, CocoaPage, CocoaSection, CocoaSpan, CocoaState, useViewportTier } from "../../components/cocoa";

type Item = { id: string; subject: string; from: string; receivedAt: string; unread: boolean; body: string };

export function WorkspaceScreen() {
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, loading, error, refresh } = useApiData<Item[]>(`/bandeja-ejemplo?propertyId=${getActivePropertyId()}`, { pollIntervalMs: 60000 });
  const items = toArray<Item>(data);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  const list = (
    <CocoaSection title="Bandeja" meta={`${items.filter((i) => i.unread).length} sin leer`} scroll="y" maxHeight={compact ? undefined : 560} padding="none">
      {items.length === 0 ? (
        <CocoaState kind="empty" inline title="Sin mensajes." />
      ) : (
        <ul className="c22-section__list" style={{ padding: "0 var(--cocoa-space-4)" }}>
          {items.map((i) => (
            <li key={i.id}>
              <CocoaButton variant="plain" tone={i.id === selectedId ? "accent" : "neutral"} size="small" onClick={() => setSelectedId(i.id)} aria-current={i.id === selectedId ? true : undefined} style={{ flex: "1 1 auto", justifyContent: "flex-start" }}>
                {i.subject}
              </CocoaButton>
              {i.unread ? <CocoaBadge tone="accent" variant="dot" size="small">nuevo</CocoaBadge> : null}
            </li>
          ))}
        </ul>
      )}
    </CocoaSection>
  );

  const detail = selected ? (
    <CocoaSection title={selected.subject} meta={`${selected.from} · ${date(selected.receivedAt, "weekdayShort")}`} action={<CocoaButton variant="plain" tone="accent" size="small">Responder</CocoaButton>}>
      <p>{selected.body}</p>
    </CocoaSection>
  ) : (
    <CocoaSection aria-label="Sin selección">
      <CocoaState kind="empty" title="Elige un mensaje" message="El detalle aparece aquí." illustration="box" />
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow="Operaciones · Bandeja"
      title="Bandeja de ejemplo"
      subtitle="Mensajes pendientes de atender."
      actions={<CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh}>{ACTIONS.refresh}</CocoaButton>}
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      error={{ message: error ?? undefined, onRetry: refresh }}
    >
      {compact ? (
        <>
          {list}
          <CocoaDrawer open={selected !== null} onClose={() => setSelectedId(null)} title={selected?.subject ?? "Mensaje"} subtitle={selected?.from} side="right" size="md">
            {selected ? <p>{selected.body}</p> : null}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start">
          <CocoaSpan cols={4} min={320}>{list}</CocoaSpan>
          <CocoaSpan cols={8} min={480}>{detail}</CocoaSpan>
        </CocoaGrid>
      )}
    </CocoaPage>
  );
}
```

#### `Calendario` — Calendario / parrilla: `fullBleed` + `density="compact"`, `CocoaScrollArea` con `<table data-cocoa-grid-table>`, barra de publicación.

```tsx
// file: screens/ejemplos/Calendario.tsx
// Calendario / parrilla ancha (RateGridEditor, RoomRack, LiveTimeline):
// página a ancho completo (`fullBleed`), barra de contenido con rango y vista,
// parrilla en CocoaScrollArea (cabecera y primera columna fijas, SIN blur) y
// barra de acciones que publica el offset del toast. La <table> cruda solo se
// permite aquí: `data-cocoa-grid-table` dentro de CocoaScrollArea (regla 3).
import { useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyId } from "../../services/activeProperty";
import { toArray } from "../../utils/toArray";
import { date, money } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CocoaActionBar, CocoaDatePicker, CocoaPage, CocoaScrollArea, CocoaSegmentedControl, CocoaSkeleton, CocoaToolbar } from "../../components/cocoa";

type Cell = { date: string; priceEur: number };
type RowType = { code: string; name: string; cells: Cell[] };

export function CalendarioScreen() {
  const [from, setFrom] = useState("2026-09-15");
  const [view, setView] = useState("precios");
  const [pending, setPending] = useState(0);
  const { data, loading, error, refresh } = useApiData<RowType[]>(`/parrilla-ejemplo?propertyId=${getActivePropertyId()}&from=${from}&view=${view}`);
  const rows = toArray<RowType>(data);
  const days = rows[0]?.cells.map((c) => c.date) ?? [];

  return (
    <CocoaPage
      eyebrow="Revenue · Parrilla"
      title="Parrilla de ejemplo"
      subtitle="Precios por tipo y día. Edita una celda y publica los cambios."
      fullBleed
      density="compact"
      state={loading && !data ? "loading" : error && !data ? "error" : "ready"}
      skeleton={<CocoaSkeleton variant="chart" height={320} />}
      error={{ message: error ?? undefined, onRetry: refresh }}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Rango y vista de la parrilla"
        leftSlot={<CocoaDatePicker value={from} onChange={setFrom} aria-label="Desde" />}
        rightSlot={
          <CocoaSegmentedControl
            value={view}
            onChange={setView}
            size="small"
            aria-label="Vista"
            options={[
              { value: "precios", label: "Precios" },
              { value: "restricciones", label: "Restricciones" }
            ]}
          />
        }
      />

      <CocoaScrollArea axis="x" stickyFirstColumn aria-label="Parrilla de precios">
        <table data-cocoa-grid-table className="cocoa-tabular">
          <thead>
            <tr>
              <th scope="col">Tipo</th>
              {days.map((d) => (
                <th key={d} scope="col">
                  {date(d, "weekdayShort")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <th scope="row">{r.name}</th>
                {r.cells.map((c) => (
                  <td key={c.date} onClick={() => setPending((n) => n + 1)}>
                    {money(c.priceEur, { decimals: "auto" })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CocoaScrollArea>

      <CocoaActionBar
        aria-label="Publicación de la parrilla"
        status={pending > 0 ? `${pending} celdas sin guardar` : "Sin cambios"}
        secondary={{ label: ACTIONS.discard, disabled: pending === 0, onClick: () => setPending(0) }}
        primary={{ label: ACTIONS.publish, disabled: pending === 0, onClick: () => setPending(0) }}
        publishToastOffset
      />
    </CocoaPage>
  );
}
```

#### `Chat` — Chat / asistente IA: conversaciones + hilo con burbujas `CocoaCard`, compositor `CocoaInput multiline`, badge `ai`.

```tsx
// file: screens/ejemplos/Chat.tsx
// Chat / asistente IA (AssistantChat): conversaciones a la izquierda, hilo a
// la derecha con burbujas en tarjetas bordered (las propias con fondo
// accent-bg vía token), compositor con CocoaInput multiline (Enter envía,
// Mayús+Enter salta de línea) y badge «IA». Standalone.
import { useState, type CSSProperties } from "react";
import { time } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CocoaBadge, CocoaButton, CocoaCard, CocoaGrid, CocoaInput, CocoaPage, CocoaSection, CocoaSpan } from "../../components/cocoa";

type Message = { id: string; from: "me" | "ai"; text: string; at: string };

// Burbujas: las propias sobre `--cocoa-accent-bg` (token, nunca un literal), fuera de un
// literal `style={{…}}` para cumplir la regla 6 (solo claves de layout en literales).
const bubbleStyle: CSSProperties = { alignSelf: "flex-start", maxWidth: "80%" };
const ownBubbleStyle: CSSProperties = { ...bubbleStyle, alignSelf: "flex-end", background: "var(--cocoa-accent-bg)" };

export function ChatScreen() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [...m, { id: String(m.length + 1), from: "me", text, at: new Date().toISOString() }]);
    setDraft("");
  }

  return (
    <CocoaPage eyebrow="Operaciones · Asistente" title="Asistente de ejemplo" subtitle="Pregunta por ocupación, tarifas o tareas del día." gap={3}>
      <CocoaGrid align="start">
        <CocoaSpan cols={4} min={240}>
          <CocoaSection title="Conversaciones" padding="none">
            <ul className="c22-section__list" style={{ padding: "0 var(--cocoa-space-4)" }}>
              <li>
                <span>Hoy</span>
                <CocoaBadge tone="ai" size="small">IA</CocoaBadge>
              </li>
            </ul>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={8} min={480}>
          <CocoaSection title="Hilo" meta={<CocoaBadge tone="ai" size="small">IA</CocoaBadge>} scroll="y" maxHeight={480}>
            <div className="cocoa-stack" data-gap="2" role="log" aria-live="polite">
              {messages.map((m) => (
                <CocoaCard key={m.id} variant="bordered" padding="sm" style={m.from === "me" ? ownBubbleStyle : bubbleStyle}>
                  <p style={{ margin: 0 }}>{m.text}</p>
                  <time dateTime={m.at} className="cocoa-tabular">
                    {time(m.at)}
                  </time>
                </CocoaCard>
              ))}
            </div>
          </CocoaSection>
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaInput
              value={draft}
              onChange={setDraft}
              multiline
              rows={2}
              placeholder="Escribe un mensaje…"
              aria-label="Mensaje"
              style={{ flex: "1 1 auto" }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <CocoaButton variant="filled" tone="accent" onClick={send} disabled={draft.trim() === ""}>
              {ACTIONS.send}
            </CocoaButton>
          </div>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}
```

#### `DialogoDrawer` — Diálogo y drawer como componentes (no páginas): `onConfirm` asíncrono con `busy`, drawer con formulario y pie de dos botones.

```tsx
// file: screens/ejemplos/DialogoDrawer.tsx
// Diálogo y drawer (GroupDetailDialog, QuickCheckInDrawer): componentes que
// NO son páginas (sin CocoaPage; los ficheros `*Dialog.tsx` / `*Drawer.tsx`
// quedan exentos de la regla 7). El diálogo espera la promesa de `onConfirm`
// y el `busy` externo; el drawer lleva formulario y pie con dos botones.
import { useState } from "react";
import { ACTIONS, confirmDelete } from "../../content/actions";
import { useToast } from "../../components/Toast";
import { CocoaButton, CocoaDialog, CocoaDrawer, CocoaField, CocoaInput, CocoaSelect } from "../../components/cocoa";

export function EliminarPlanTarifarioDialog({ open, planName, onClose, onDeleted }: { open: boolean; planName: string; onClose: () => void; onDeleted: () => void }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const copy = confirmDelete(`el plan tarifario ${planName}`);

  async function confirm() {
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // llamada real: apiRequest(…, { method: "DELETE" })
      showToast("Plan tarifario eliminado", { variant: "success" });
      onDeleted();
    } catch {
      showToast("No se pudo eliminar el plan tarifario", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return <CocoaDialog open={open} onClose={onClose} tone="destructive" title={copy.title} description={copy.message} confirmLabel={copy.confirmLabel} cancelLabel={copy.cancelLabel} onConfirm={confirm} busy={busy} />;
}

export function CheckInRapidoDrawer({ open, reservationCode, onClose }: { open: boolean; reservationCode: string; onClose: () => void }) {
  const [room, setRoom] = useState("");
  const [document, setDocument] = useState("");
  const canSubmit = room !== "" && document.trim() !== "";

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={`Check-in ${reservationCode}`}
      subtitle="Asigna habitación y verifica el documento."
      side="right"
      size="md"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" disabled={!canSubmit} onClick={onClose}>
            Hacer check-in
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaField label="Habitación" required>
          <CocoaSelect
            value={room}
            onChange={setRoom}
            placeholder="Seleccionar…"
            options={[
              { value: "108", label: "108 · Doble" },
              { value: "432", label: "432 · Suite" }
            ]}
          />
        </CocoaField>
        <CocoaField label="Documento" required help="DNI, NIE o pasaporte.">
          <CocoaInput value={document} onChange={setDocument} placeholder="12345678A" autoComplete="off" />
        </CocoaField>
      </div>
    </CocoaDrawer>
  );
}
```

---

## §5 · Responsive y accesibilidad

### 5.1 Breakpoints y comportamiento (medido / propuesto)

| Rango | Nombre | Shell | Contenido | Tablas | Acciones |
|---|---|---|---|---|---|
| < 600 | phone | toolbar compacta 48, drawer 260, scrim | padding **16** (hoy 40 efectivos), 1 columna, KPI 1 col, cabecera apilada (título 22 px si no cabe), tabs con scroll + fade | tarjetas apiladas | `CocoaActionBar` inferior fija (56 px + safe-area), botones a ancho completo |
| 600–899 | tablet portrait | toolbar compacta + drawer | 2 columnas (`CocoaGrid` colapsa spans < 6 a 6), KPI auto-fit 180 | tabla real con scroll envuelto | acciones en cabecera (wrap) |
| 900–1199 | tablet landscape / portátil pequeño | split view con sidebar plegable | 12 col; spans con `min` mayor que su ancho se promocionan | tabla | cabecera |
| ≥ 1200 | desktop | sidebar 240 fija | 12 col completas (canon 1120 útiles a 1440) | tabla | cabecera |

Otros umbrales existentes que se conservan: 700 (`MOBILE_BREAKPOINT_PX`, landing por rol de pisos/mantenimiento) y 1100 (`bo-hero`) desaparece al migrar. Touch (`pointer: coarse`): botones y filas ≥ 44 px (medido: alto 44 pero **ancho 32** en los iconos de la toolbar → 44×44), inputs 16 px, switch con área ampliada ±12. Safe-area: `viewport-fit=cover` ya activo; toolbar `padding-top: env(safe-area-inset-top)`, action bar y drawer `padding-bottom: env(safe-area-inset-bottom)`, `100dvh`.

### 5.2 Accesibilidad (AA medido)

| Regla | Estado hoy (medido) | Cocoa 22 |
|---|---|---|
| Contraste texto ≥ 4,5:1 | `label` 15,1 ✓ · `label-secondary` claro **3,98 ✗** (oscuro 5,9 ✓) · `label-tertiary` **1,9 ✗** (eyebrow, ejes) · `--accent` como texto 4,36 ✗ · blanco sobre `--accent` (filled) **4,36 ✗** · tonos Cocoa como texto ✗ (success 3,1 · warning 2,2 · danger 3,6 · info 4,0) | `--cocoa-label-secondary` claro → `rgb(0 0 0 / .62)` (≈ 5,3:1; verificar con números en las 3 superficies); eyebrow → secondary; tertiary solo decorativo; texto de tono → `*-ink` de Aurora; acento como texto → `--accent-strong`; filled accent sobre `--cocoa-accent-fill` `#0b7a54` (5,35:1, qa#7) |
| Foco visible | `.cocoa-focus-ring:focus-visible` halo 3 px Esmeralda 50/60 % ✓; `<button>` crudos usan `--focus` Aurora (distinto) | Todo control Cocoa; un solo anillo |
| Roles | KPI `role=group` con `aria-label`; tarjeta interactiva `role=button` + `tabIndex` + Enter/Espacio; tabs WAI-ARIA con roving tabindex; toast `status/alert`; sheet `dialog aria-modal` + focus trap | `CocoaState` `role=status/alert`; tablas `aria-sort`; drawers `aria-labelledby`; live region única (`CocoaLiveRegion`) para «guardado», «N nuevos» |
| Teclado | ⌘K/Ctrl-K global; Esc cierra drawer/menús; tabs ←→ Home End | `CocoaActionBar` Ctrl-Enter = primaria; filas de tabla Enter = abrir; `?` = atajos |
| Reduced motion | tokens a 0, `animation:none` en enter/stagger, botón no escala ✓ | skeleton se vuelve estático (opacidad 0,6) |
| Nombres | `aria-label` en iconos de toolbar ✓ | Sin emoji como único indicador (52 ficheros); iconos `cocoa-icons` con `aria-hidden` + texto |

---

## §6 · «22nd century»: qué se eleva sin romper la restricción

| Elevación | Cómo | Límite |
|---|---|---|
| Profundidad coherente | 3 niveles: lienzo → tarjeta (`shadow-card`) → flotante (`popover/modal`); hover solo en tarjetas interactivas (`window` + −2 px) | Nunca sombra fija de 3 capas en toolbar; anillo dark siempre blanco translúcido |
| Motion de estado | Entrada `cocoa-stagger` en tiras de KPI y rejillas (hasta 12 hijos); cambio de cifra con `transition: color 200ms` + «▲/▼» que solo aparece al cambiar; drawer/sheet 400 ms; skeleton → contenido con `cocoa-fade-in` | Ningún `infinite` salvo shimmer y spinner; nada > 400 ms |
| ⌘K omnipresente | Campo de búsqueda de la toolbar lanza la paleta; `CocoaPage` registra sus acciones (`actions`) en la paleta como comandos («Actualizar», «Nueva reserva…»); resultados con eyebrow de categoría | Una paleta, un índice |
| Densidad | `--cocoa-density` en `CocoaPage` (`compact` para recepción, parrillas, listas > 50 filas) | Sin escalar tipografías; solo paddings y alturas de fila |
| Live regions | «Datos a 08:12» + `role=status` al refrescar; contador de degradados; guardado optimista con toast | Una live region por página |
| Esqueletos espejo | Cada arquetipo tiene su skeleton con los mismos spans que el contenido (sin CLS) | Neutro, sin tinte |
| Microcopys | Español, frase corta, verbo primero en acciones («Ver qué falta», «Aplicar»), unidad en el valor («1,7 %», «272,00 €»), fecha corta («30 may, 10:12»), negativos honestos («Sin feed externo. Activa la integración…») | Sin exclamaciones ni emoji |
| Cifras | `CocoaStat` (entero grande + `suffix` con decimales/símbolo en secondary, tabular; title-2 17 px, `large` title-1) y `CocoaDelta` («▲ 3,1 % vs LY» por polaridad). `CocoaMoney`/`DeltaChip` no existen: las cifras se formatean con `lib/format` antes de entrar | — |

**Prohibiciones explícitas** (revisores 2026-06 + esta auditoría): blur en `thead`/cabeceras de parrilla · halo de acento en FAB o foco · shimmer teñido · pulsos/glows infinitos · subir `--cocoa-fs-large-title` global · sombra de 3 capas en topbar · triple `box-shadow` en filled · `transition: all` · colores literales · `alert()/confirm()` nativos · `position: fixed` ad hoc · `<table>`/`<button>`/`<input>` crudos · radios Aurora 16/20/28 en contenido · emoji como icono · gradientes salvo login · segundo acento (el azul `--cocoa-info` no es acento) · preferencia de acento de usuario.

---

## §7 · Mapa legacy → Cocoa 22

| Legacy (inventario) | Cocoa 22 | Notas |
|---|---|---|
| `.bo-card` (941), `.bo-section`, `.rev-home-card` | `CocoaCard variant="bordered"` / `CocoaSection` | radio 12 (no 16), padding md |
| `.bo-page-head` / `.bo-page-title` (46) / `.bo-page-eyebrow`, `<h1>` crudo, `v2/PageHeader`, `FormPage` | `CocoaPageHeader` vía `CocoaPage` (o `HostedHead` alojado) | eyebrow secondary, no `--accent-strong` |
| `<button>` crudos (647), `.bo-button*`, `button.primary/ghost/danger` | `CocoaButton` filled/tinted/bordered/plain × accent/neutral/destructive × small/regular/large | `min-height 40` global de `styles.css` desaparece |
| `<input>/<select>/<textarea>` (553), `.fp-field`, `.bo-form-field`, `FormField/FormSelect/FormSwitch/FormDateInput/FormTextarea` | `CocoaField` + `CocoaInput/Select/Switch/DatePicker`, `CocoaInput multiline` | `FormComponents.tsx` se reimplementa sobre las primitivas |
| `<table>` crudas (159), `v2/DataTable`, `.cm-table`, `.rev-report-table`, `DataPreview` | `CocoaTable` (+ `footer`, `density`, `stickyFirstColumn`) | parrillas: `CocoaScrollArea` |
| `display:grid` inline, `.bo-grid.two/three`, `.rev-kpi-grid`, `.cm-stat-grid`, `gridRowStyle/spanStyle` | `CocoaGrid` + `CocoaSpan` · `CocoaKpiStrip` | `gm-grid` de `mobile.css` pasa a la primitiva |
| KPIs ad hoc: `.bo-metric`, `.rev-kpi`, `.cm-stat`, `v2/StatTile`, `DirectorKpiTile` | `CocoaKpi` (canon) / `CocoaStat` (cifra secundaria) | `DirectorKpiTile` se convierte en alias deprecado |
| `.bo-status/.bo-chip/.bo-pill`, `.cm-pill`, `v2/StatusBadge`, `badgeStyle` local | `CocoaBadge tone variant="outline|tinted|dot"` | `managementBadges.ts` alimenta `tone` |
| `LoadingBlock/Skeleton/EmptyState/ErrorState` (`.bo-*`), `CocoaEmptyState`, `DashboardSkeleton` local | `CocoaState kind="loading|empty|error|degraded"` + `CocoaSkeleton` | `DegradedValue/Note/Card/Banner` se conservan tal cual |
| `style={}` de layout (4.607) | utilidades `cocoa-stack`, `cocoa-row`, `cocoa-cluster`, `cocoa-grid-*` o props (`gap`, `align`) de las primitivas | ≤ N por pantalla (§9) |
| `ConfirmDialog`, `window.confirm`, overlays `position:fixed` locales | `CocoaDialog` | — |
| `SidePanel`, `CocoaSheet` como panel lateral, drawers `*Drawer.tsx` | `CocoaDrawer` | `CocoaSheet` queda para hojas de importación/preview |
| `Toast` Aurora | `Toast` con tokens Cocoa (misma API `useToast`) | — |
| `.fp-sticky-actions`, `RateGridStatusBar`, barras locales | `CocoaActionBar` | publica `--hotelos-toast-offset` en `<html>` mientras está montada (único estilo en línea admitido en la raíz; plan §4.3 V4) |
| Gráficos inline SVG por pantalla, `.rev-channel-bar`, `.bo-progress-bar` | `CocoaChart.{Sparkline,Bars,Line,Gauge,Donut,Progress}` | extraídos de `cocoa-director` |
| Emoji (`✨ ⚠️ ✅`) | `cocoa-icons` (`SparkleIcon`, `StatusIcons`) | — |
| Colores literales (539: 267 duros + 272 fallbacks `var(--x, #hex)`) | tokens; fallbacks eliminados (todos los tokens existen) | — |

---

## §8 · API de las primitivas (generada desde los tipos exportados)

Ubicación: `apps/admin-web/src/components/cocoa/` (39 ficheros + barrel `index.ts`). Convenciones comunes a todas: raíz `data-cocoa="<nombre>"` + clase `c22-<nombre>` (partes `c22-<nombre>__<parte>`, variantes en `data-*`, tonos por `data-tone` → `--c22-tone*`) para el contrato y las hojas `styles/cocoa-22*.css`; estilos solo con `var(--cocoa-*)`; `className`/`style` de escape solo para layout (§9 regla 6); tipos exportados `NombreProps`; controles controlados de valor primitivo (§4.2 A3). Lo que no se ve aquí no existe: §8.2 lo escribe `node docs/design/cocoa-22-api.mjs --write` a partir de los tipos exportados y `--check` falla cuando el código cambia sin regenerarlo (propuesta de regla 16, §9).

### 8.1 Índice — qué usar para qué

| Necesidad | Primitiva | Fichero | Obligatorio |
|---|---|---|---|
| Página completa (cabecera, estado, densidad, ⌘K) | `CocoaPage` | `CocoaPage.tsx` | `title`, `children` |
| Cabecera suelta (contenedores de pestañas) | `CocoaPageHeader` | `CocoaPageHeader.tsx` | `title` |
| Rejilla 12 col + celda | `CocoaGrid` / `CocoaSpan` | `CocoaGrid.tsx` | — / `cols` |
| Tira y tile de KPI, chip de delta | `CocoaKpiStrip` / `CocoaKpi` / `CocoaDelta` | `CocoaKpi.tsx` | — / `label`, `value` / — |
| Tarjeta con cabecera (título · meta · acción · pie) | `CocoaSection` | `CocoaSection.tsx` | `children` (+ `aria-label` sin `title`) |
| Tarjeta sin cabecera (burbujas, tiles propios) | `CocoaCard` | `CocoaCard.tsx` | `children` |
| Etiqueta de estado / tono | `CocoaBadge` | `CocoaBadge.tsx` | `children` |
| Aviso en línea o banner con acciones | `CocoaCallout` | `CocoaCallout.tsx` | — |
| Vacío / error / carga / degradado; skeleton y espejos | `CocoaState` / `CocoaSkeleton` (+ `.Strip`, `.Grid`) | `CocoaState.tsx` | `kind` / — |
| Cifra secundaria (aside, listas) | `CocoaStat` | `CocoaStat.tsx` | `label`, `value` |
| Campo, fila y sección de formulario | `CocoaField` / `CocoaFormRow` / `CocoaFormSection` | `CocoaField.tsx` | `label` + 1 hijo / — / `title` |
| Texto, número, textarea | `CocoaInput` (`multiline`) | `CocoaInput.tsx` | `value`, `onChange` |
| Selección nativa | `CocoaSelect` | `CocoaSelect.tsx` | `value`, `onChange`, `options`; `inline` para un selector en una fila de acciones o toolbar (ancho de la opción más larga, no de la fila) |
| Interruptor | `CocoaSwitch` | `CocoaSwitch.tsx` | `checked`, `onChange` |
| Fecha | `CocoaDatePicker` | `CocoaDatePicker.tsx` | `value`, `onChange` |
| Contador numérico ± (no es un indicador de pasos) | `CocoaStepper` | `CocoaStepper.tsx` | `value`, `onChange` |
| Fichero (extracto, adjunto): botón + `<input type="file">` oculto, nombre cargado, rechazo por tipo o peso | `CocoaFileInput` | `CocoaFileInput.tsx` | `onPick` |
| Búsqueda con debounce y limpiar | `CocoaSearchInput` | `CocoaSearchInput.tsx` | `value`, `onChange` |
| Vistas ≤ 4 opciones | `CocoaSegmentedControl` | `CocoaSegmentedControl.tsx` | `value`, `onChange`, `options` |
| Tabla (orden controlado, selección, pie, apilado < 600) | `CocoaTable<Row>` | `CocoaTable.tsx` | `columns`, `rows` |
| Parrilla ancha con cabecera y primera columna fijas | `CocoaScrollArea` | `CocoaScrollArea.tsx` | `children` |
| Barra de filtros dentro de la página | `CocoaToolbar variant="content"` | `CocoaToolbar.tsx` | — |
| Menú / popover anclado | `CocoaPopover` | `CocoaPopover.tsx` | `open`, `anchorEl`, `onClose`, `children` |
| Hoja superior (importación, vista previa) | `CocoaSheet` | `CocoaSheet.tsx` | `open`, `onClose`, `children` |
| Panel lateral / hoja inferior en teléfono | `CocoaDrawer` | `CocoaDrawer.tsx` | `open`, `onClose`, `title`, `children` |
| Confirmación (destructiva con `busy`) | `CocoaDialog` | `CocoaDialog.tsx` | `open`, `onClose`, `title`, `onConfirm` |
| Toast (las pantallas usan `useToast()` de `components/Toast.tsx`) | `CocoaToast` / `CocoaToastViewport` | `CocoaToast.tsx` | `id`, `message`, `onDismiss` |
| Barra de acciones inferior (Ctrl/⌘+Enter) | `CocoaActionBar` | `CocoaActionBar.tsx` | — |
| Gráficos SVG | `CocoaChart.{Sparkline,Bars,Line,Gauge,Donut,Progress}` | `CocoaChart.tsx` | `values` / `data` / `series` / `value` / `slices` / `value` |
| Botón (4 variantes × 3 tonos × 3 tamaños) | `CocoaButton` | `CocoaButton.tsx` | `children` o `aria-label` |
| Tecla, live region | `CocoaKbd` / `CocoaLiveRegion` | `CocoaKbd.tsx` / `CocoaLiveRegion.tsx` | `children` / `message` |
| Pestañas por URL (contenedores) | `CocoaRouteTabs` / `useRouteTabs` / `openTabPath` | `CocoaRouteTabs.tsx` | `basePath`, `tabs`, `defaultTab` |
| Shell (no primitivas de página) | `CocoaSplitView` / `CocoaSidebar` | `CocoaSplitView.tsx` / `CocoaSidebar.tsx` | `sidebar`, `content` / `sections`, `onSelect` |
| Tonos: color, tinta AA, fondo, borde; estado API → tono | `toneColor` / `toneInk` / `toneBg` / `toneBorder` / `toneFromStatus` / `isCocoaTone` | `cocoa-tones.ts` | — |
| Viewport: tier, estrecho, ancho medido | `useViewportTier` / `useIsNarrow` / `useElementWidth` | `cocoa-viewport.ts` | — |
| Capas: foco atrapado, Esc, scroll lock, scrim | `useFocusTrap` / `useEscapeKey` / `useScrollLock` / `COCOA_SCRIM` | `cocoa-overlay.ts` | — |
| ⌘K: registro de comandos de página | `registerPageCommands` / `resolvePageState` | `cocoa-page-commands.ts` | — |
| Geometría de gráficos (umbral → tono, gauge, donut, línea) | `thresholdTone` / `gaugeGeometry` / `donutSegments` / `lineGeometry` | `cocoa-chart-math.ts` | — |
| Degradados («—» honesto) | `DegradedValue` / `DegradedNote` / `DegradedCard` / `DegradedBanner` / `isDegraded` | re-export de `cocoa-extras/DegradedValue.tsx` | `label`, `degraded` |
| Vacío legacy | `CocoaEmptyState` (usa `CocoaState kind="empty"`) | re-export de `cocoa-empty-state/` | `title` |

### 8.2 Declaraciones exportadas (generado)

<!-- cocoa-22-api:start -->

Generado por `docs/design/cocoa-22-api.mjs --write` a partir de `apps/admin-web/src/components/cocoa/*` (orden del barrel `index.ts`). No editar a mano: `--check` falla si difiere del código.

#### Barrel `components/cocoa/index.ts`

```ts
export * from "./cocoa-tones";
export * from "./cocoa-viewport";
export * from "./cocoa-overlay";
export * from "./cocoa-page-commands";
export * from "./cocoa-chart-math";
export * from "./CocoaButton";
export * from "./CocoaCard";
export * from "./CocoaPageHeader";
export * from "./CocoaPage";
export * from "./CocoaGrid";
export * from "./CocoaKpi";
export * from "./CocoaSection";
export * from "./CocoaBadge";
export * from "./CocoaCallout";
export * from "./CocoaKbd";
export * from "./CocoaLiveRegion";
export * from "./CocoaState";
export * from "./CocoaStat";
export * from "./CocoaField";
export * from "./CocoaInput";
export * from "./CocoaSelect";
export * from "./CocoaSwitch";
export * from "./CocoaDatePicker";
export * from "./CocoaStepper";
export * from "./CocoaFileInput";
export * from "./CocoaSearchInput";
export * from "./CocoaSegmentedControl";
export * from "./CocoaTable";
export * from "./CocoaScrollArea";
export * from "./CocoaToolbar";
export * from "./CocoaPopover";
export * from "./CocoaSheet";
export * from "./CocoaDrawer";
export * from "./CocoaDialog";
export * from "./CocoaToast";
export * from "./CocoaActionBar";
export * from "./CocoaChart";
export * from "./CocoaSplitView";
export * from "./CocoaSidebar";
export * from "./CocoaRouteTabs";
export { CocoaEmptyState, type CocoaEmptyStateProps, type CocoaEmptyStateAction } from "../cocoa-empty-state/CocoaEmptyState";
export { DegradedValue, DegradedNote, DegradedCard, DegradedBanner, isDegraded, DEGRADED_HINT, type DegradedLabel, type DegradedList } from "../cocoa-extras/DegradedValue";
```

#### `cocoa-tones.ts`

```ts
/** Semantic tone shared by badges, KPIs, stats, charts and states. */
export type CocoaTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "accent"
  | "ai";

export const COCOA_TONES: readonly CocoaTone[] = [
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "accent",
  "ai"
]

/** Chromatic hue of a tone (bars, strokes, dots, large figures). */
export function toneColor(tone: CocoaTone): string

/** AA-safe text colour of a tone for small text (≤ 13 px). */
export function toneInk(tone: CocoaTone): string

/** Soft wash of a tone (tinted badges, banners, callouts). */
export function toneBg(tone: CocoaTone): string

/** Outline that pairs with `toneBg`. */
export function toneBorder(tone: CocoaTone): string

/** Type guard used when a tone arrives from data (API status → tone). */
export function isCocoaTone(value: unknown): value is CocoaTone

/** Legacy status names → tone (`error` → `danger`, `ok` → `success`, …). */
export function toneFromStatus(status: string | null | undefined): CocoaTone

/** Delta sentiment (the css lot's `data-sentiment`): good · bad · neutral. */
export type CocoaSentiment = "good" | "bad" | "neutral";

/** Sentiment → tone (good = success, bad = danger). */
export function sentimentTone(sentiment: CocoaSentiment): CocoaTone
```

#### `cocoa-viewport.ts`

```ts
export const COCOA_BREAKPOINTS = {
  /** Below this the layout is a single column (phone). */
  phone: 600,
  /** Below this spans < half collapse to half (tablet portrait). */
  tablet: 900,
  /** Below this the sidebar is collapsible (laptop). */
  desktop: 1200
} as const

export type CocoaViewportTier = "phone" | "tablet" | "laptop" | "desktop";

/** Tier of a width in CSS px (pure). */
export function viewportTier(width: number): CocoaViewportTier

/** Reactive `matchMedia` (false during SSR and in environments without it). */
export function useMediaQuery(query: string): boolean

/** True below `breakpoint` px (default: the phone breakpoint, 600). */
export function useIsNarrow(breakpoint: number = COCOA_BREAKPOINTS.phone): boolean

/** Current viewport tier, reactive to resizes. */
export function useViewportTier(): CocoaViewportTier

/** Content-box width of an element, measured with ResizeObserver; `null` until the first measurement (callers fall back to their desktop layout). */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number | null
```

#### `cocoa-overlay.ts`

```ts
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",")

/** Focusable, visible descendants of `root` in DOM order. */
export function getFocusableElements(root: HTMLElement | null): HTMLElement[]

/** Where a Tab press inside a trap must land (pure). Returns the index of the element to focus, `"root"` when there is nothing focusable, or `null` when the browser's default order is fine. */
export function trapTabTarget(input: { count: number; activeIndex: number; shiftKey: boolean; }): number | "root" | null

/** Traps Tab/Shift+Tab inside `ref` and moves the initial focus in (to `initialFocus()` when given, else the first focusable, else the root). Restores focus to the previously focused element on unmount. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean, initialFocus?: () => HTMLElement | null | undefined): (event: ReactKeyboardEvent<HTMLElement>) => void

/** Calls `onEscape` on Escape while `active` (stops propagation so shells don't double-handle). */
export function useEscapeKey(active: boolean, onEscape: (() => void) | undefined): void

/** Locks body scroll while `active`, restoring the previous value after. */
export function useScrollLock(active: boolean): void

/** `mounted` stays true for `exitMs` after `open` flips to false so the exit transition can play; `visible` flips a frame after mount so the entry transition starts from the off-screen styles. */
export function useMountedTransition(open: boolean, exitMs: number): { mounted: boolean; visible: boolean }

/** Scrim shared by drawers, sheets and dialogs: the `--cocoa-scrim` token (rgb(20 19 14 / .45), themes with the palette). */
export const COCOA_SCRIM = "var(--cocoa-scrim)"
```

#### `cocoa-page-commands.ts`

```ts
export type CocoaPageState = "ready" | "loading" | "empty" | "error";

export interface CocoaPageCommand {
  id: string;
  label: string;
  run: () => void;
  /** Display hint («⌘R»); the palette does not bind it. */
  shortcut?: string;
}

/** Window event dispatched whenever the registered set changes. */
export const PAGE_COMMANDS_EVENT = "cocoa-page-commands"

/** Registers a page's commands; returns the unregister function. */
export function registerPageCommands(commands: readonly CocoaPageCommand[]): () => void

/** Commands currently offered by mounted pages (most specific page first). */
export function getPageCommands(): CocoaPageCommand[]

/** Subscribes to registry changes; returns the unsubscribe function. */
export function subscribePageCommands(listener: Listener): () => void

/** Test/reset helper: clears every registration without notifying. */
export function resetPageCommands(): void

/** Stable key of a command set (id · label · shortcut), so re-renders don't re-register. */
export function commandsKey(commands: readonly CocoaPageCommand[] | undefined): string

/** Explicit `state` wins; otherwise derive it from the classic `loading / error / empty` trio so screens can pass either shape. */
export function resolvePageState(input: { state?: CocoaPageState; loading?: boolean; error?: unknown; empty?: boolean; }): CocoaPageState
```

#### `cocoa-chart-math.ts`

```ts
export interface XY {
  x: number;
  y: number;
}

/** Path `d` of a sparkline: values fitted to `width×height` with `pad`. */
export function sparklinePath(values: readonly number[], width = 60, height = 20, pad = 1): string

/** Rounds up to the nearest 1 / 2 / 5 × 10ⁿ ("nice" axis ceiling). */
export function niceCeil(value: number): number

/** Tick step so an X axis shows at most ~8 labels. */
export function pickXStep(count: number): number

/** Polyline `d` from points. */
export function buildPathD(points: readonly XY[]): string

/** Y-axis tick label (es-ES via lib/format): one decimal when the range is small (≤ 10), integers otherwise. */
export function formatYTick(value: number, max: number): string

/** Compact value for tooltips (es-ES via lib/format): 0 decimals ≥ 100, 1 decimal ≥ 10, 2 below; «—» for NaN. */
export function formatChartValue(value: number): string
export const LINE_PADDING = { top: 16, right: 16, bottom: 32, left: 44 } as const
export const LINE_DEFAULT_WIDTH = 640

export interface LineSeriesInput {
  id: string;
  points: ReadonlyArray<{ x: string; y: number }>;
}

export interface LineGeometry {
  innerWidth: number;
  innerHeight: number;
  yMax: number;
  /** Points per series (same order as the input). */
  series: XY[][];
  xTicks: Array<{ i: number; x: number; label: string }>;
  yTicks: Array<{ value: number; y: number }>;
  xOf: (index: number) => number;
  /** Index of the point nearest to a viewBox X (hover). */
  indexAt: (viewBoxX: number) => number;
}

/** Scales every series to a `width×height` viewBox. The X axis takes the labels of the longest series; shorter series are drawn on their first N positions. `yMax` is the nice ceiling of the largest value (min 0). */
export function lineGeometry(input: readonly LineSeriesInput[], width: number = LINE_DEFAULT_WIDTH, height = 200, ticks = 4): LineGeometry | null
export const GAUGE = { width: 220, height: 130, cx: 110, cy: 110, radius: 90, stroke: 16 } as const

/** Angle in degrees on a semicircle: left (180°) = min, right (0°) = max. */
export function gaugeAngle(value: number, min = 0, max = 100): number

/** Gauge polar → cartesian (Y grows downwards, angle counter-clockwise from +X), rounded to 3 decimals so paths are stable. */
export function gaugePoint(radius: number, angleDeg: number, cx: number = GAUGE.cx, cy: number = GAUGE.cy): XY

/** Rounds to 3 decimals and drops the negative zero (pure). */
export function round3(value: number): number

export interface GaugeGeometry {
  angle: number;
  trackPath: string;
  progressPath: string;
  needlePath: string;
}

/** Track, progress arc and needle for a value in `[min, max]`. */
export function gaugeGeometry(value: number, min = 0, max = 100): GaugeGeometry

/** Tone by thresholds `[warnAt, dangerAt]`: below the first → success, below the second → warning, else danger. `invert` flips it (higher is better). */
export function thresholdTone(value: number, thresholds: readonly [number, number] = [30, 60], invert = false): "success" | "warning" | "danger"

/** Donut polar → cartesian (0° at 12 o'clock, clockwise). */
export function donutPoint(cx: number, cy: number, radius: number, angle: number): XY

/** Ring segment path between two angles (degrees, clockwise from 12 o'clock). */
export function describeArcPath(cx: number, cy: number, outerRadius: number, innerRadius: number, startAngle: number, endAngle: number): string

export interface DonutSegment<T> {
  slice: T;
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
}

/** Segments of a donut of `size` px (inner radius 62 %); zero/negative values get an empty slice. */
export function donutSegments<T extends { value: number }>(slices: readonly T[], size = 160): { segments: DonutSegment<T>[]; total: number }
export type ChartPolarity = "positive-good" | "negative-good";

/** Tone of a bar by sign and polarity; zero/NaN → neutral. */
export function barTone(value: number, polarity: ChartPolarity = "positive-good"): "success" | "danger" | "neutral"

/** Bar height in px for a value inside a plot of `plotHeight` (min 2 px). */
export function barHeight(value: number, maxAbs: number, plotHeight: number, minPx = 2): number

/** Clamp to [0, 100] for progress bars; NaN → 0. */
export function clampPercent(value: number): number
```

#### `CocoaButton.tsx`

```ts
export type CocoaButtonVariant = "filled" | "tinted" | "bordered" | "plain";
export type CocoaButtonSize = "small" | "regular" | "large";
export type CocoaButtonTone = "accent" | "neutral" | "destructive";
export type CocoaButtonAlign = "start" | "center" | "between";

export interface CocoaButtonProps {
  variant?: CocoaButtonVariant;
  size?: CocoaButtonSize;
  tone?: CocoaButtonTone;
  icon?: ReactNode;
  iconPosition?: "left" | "right";
  loading?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onFocus?: FocusEventHandler<HTMLButtonElement>;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  type?: "button" | "submit";
  className?: string;
  /** Layout escape hatch (width, flex); colours come from `variant`/`tone`. */
  style?: CSSProperties;
  id?: string;
  name?: string;
  form?: string;
  tabIndex?: number;
  autoFocus?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Accessible name; REQUIRED for icon-only buttons. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
  "aria-controls"?: string;
  "aria-haspopup"?: boolean | "menu" | "dialog" | "listbox";
  "aria-current"?: boolean | "page" | "step";
  /** Native tooltip (callers used to wrap the button in <span title>). */
  title?: string;
  "data-cocoa"?: string;
  /** Passthroughs for the shell (guided tour anchors, test hooks) and for menu/listbox rows. */
  "data-tour"?: string;
  "data-testid"?: string;
  role?: "menuitem" | "option" | "tab" | "switch" | "link";
  "aria-selected"?: boolean;
  /** Multi-line label (selectable list rows, long titles in a 320 px column): the text wraps, the height follows it, left-aligned. Default: one line, fixed height. */
  wrap?: boolean;
  /** Stretch to the container's width (rows of a listbox / menu, phone footers) — the geometry is inline, so a className cannot set it. */
  fullWidth?: boolean;
  /** Horizontal alignment of icon + label inside the button: `center` (default) · `start` (list rows) · `between` (label + trailing chevron). */
  align?: CocoaButtonAlign;
}

/** Text colour of a variant/tone pair (exported for the action bar's status text and tests): filled → ink on the hue; ghosts → AA tone ink. */
export function buttonForeground(variant: CocoaButtonVariant, tone: CocoaButtonTone): string
export function CocoaButton({ variant = "filled", size = "regular", tone = "accent", icon, iconPosition = "left", loading = false, disabled = false, onClick, onFocus, onBlur, onKeyDown, children, type = "button", className, style, id, name, form, tabIndex, autoFocus, ref, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, "aria-expanded": ariaExpanded, "aria-pressed": ariaPressed, "aria-controls": ariaControls, "aria-haspopup": ariaHasPopup, "aria-current": ariaCurrent, title, "data-cocoa": dataCocoa = "button", "data-tour": dataTour, "data-testid": dataTestId, role, "aria-selected": ariaSelected, wrap = false, fullWidth = false, align = "center" }: CocoaButtonProps)
```

#### `CocoaCard.tsx`

```ts
export type CocoaCardVariant = "plain" | "elevated" | "bordered";
export type CocoaCardPadding = "sm" | "md" | "lg" | "none";

export interface CocoaCardProps {
  variant?: CocoaCardVariant;
  padding?: CocoaCardPadding;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
  /** Layout escape hatch (min-height, grid placement, overflow); never colours. */
  style?: CSSProperties;
  /** ARIA role for non-interactive cards (`group`, `region`); interactive cards are always `button`. */
  role?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Toggle state of a selectable interactive card (room tile, filter card): the drawer being open is not a state a screen reader hears. */
  "aria-pressed"?: boolean;
  /** Contract marker; primitives built on the card override it (`kpi`, `section`). */
  "data-cocoa"?: string;
}

/** Resting shadow of a variant (what hover escalates from and mouse-leave restores). */
export function cardRestingShadow(variant: CocoaCardVariant): string
export function CocoaCard({ variant = "plain", padding = "md", children, onClick, className, style, role, id, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, "aria-pressed": ariaPressed, "data-cocoa": dataCocoa = "card" }: CocoaCardProps)
```

#### `CocoaPageHeader.tsx`

```ts
export interface CocoaPageHeaderTab {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface CocoaPageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  tabs?: Array<CocoaPageHeaderTab>;
  activeTab?: string;
  onTabChange?: (value: string) => void;
  /** Let the title wrap on desktop too (narrow containers such as the 440 px auth card); default: one line with ellipsis. */
  wrap?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Title metrics by tier (pure): 26 px nowrap on desktop, 22 px wrapping on phones; `wrap` keeps the 26 px and lets it wrap. */
export function headerTitleStyle(isNarrow: boolean, wrap = false): CSSProperties
export function CocoaPageHeader({ eyebrow, title, subtitle, icon, actions, tabs, activeTab, onTabChange, wrap = false, className, style }: CocoaPageHeaderProps)
```

#### `CocoaPage.tsx`

```ts
export { commandsKey };
export type CocoaPageDensity = "comfortable" | "compact";
export type CocoaPageGap = 3 | 4 | 5;

export interface CocoaPageProps extends Pick<CocoaPageHeaderProps, "eyebrow" | "title" | "subtitle" | "icon" | "tabs" | "activeTab" | "onTabChange" | "wrap"> {
  /** Actions row (standalone → header; hosted → HOSTED_ACTIONS_ROW). */
  actions?: ReactNode;
  state?: CocoaPageState;
  /** Mirror skeleton painted while loading (default: CocoaState loading). */
  skeleton?: ReactNode;
  empty?: Partial<Omit<CocoaStateProps, "kind">>;
  error?: Partial<Omit<CocoaStateProps, "kind">>;
  density?: CocoaPageDensity;
  fullBleed?: boolean;
  /** Stack gap between sections: 3 = 12 · 4 = 16 (default) · 5 = 24. */
  gap?: CocoaPageGap;
  commands?: readonly CocoaPageCommand[];
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only (min-height, overflow). */
  style?: CSSProperties;
  "aria-label"?: string;
}

export function CocoaPage({ eyebrow, title, subtitle, icon, tabs, activeTab, onTabChange, wrap, actions, state, skeleton, empty, error, density, fullBleed = false, gap = 4, commands, children, id, className, style, "aria-label": ariaLabel }: CocoaPageProps)
```

#### `CocoaGrid.tsx`

```ts
export type CocoaGridColumns = 12 | 6 | 4;
export type CocoaGridGap = 2 | 3 | 4;
export type CocoaSpanCols = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface CocoaGridProps {
  columns?: CocoaGridColumns;
  /** Space token: 2 = 8 px · 3 = 12 px (canon) · 4 = 16 px. */
  gap?: CocoaGridGap;
  /** Cascade the children in (`cocoa-stagger`, 220 ms, 40 ms apart, up to 12). */
  stagger?: boolean;
  /** Align cells to the top instead of stretching them. */
  align?: "start" | "stretch";
  children: ReactNode;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
}

export interface CocoaSpanProps {
  cols: CocoaSpanCols;
  /** Minimum content width in px; promotes the span when the columns are narrower. Canon: 480 (8), 320 (4–5), 240 (3), 200 (2). */
  min?: number;
  rowSpan?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Minimum-width buckets the stylesheet knows (`.c22-min-N`). */
export const SPAN_MIN_BUCKETS = [200, 240, 320, 480] as const
export type CocoaSpanMinBucket = (typeof SPAN_MIN_BUCKETS)[number];

/** Smallest stylesheet bucket that honours `min` (pure); null when there is no minimum. */
export function minBucket(min: number | undefined): CocoaSpanMinBucket | null

/** Width in px of `span` columns inside a grid of `width` px (pure). */
export function spanWidth(span: number, columns: number, width: number, gap: number): number

/** Grid width that corresponds to the desktop viewport tier (1200 − sidebar 240 − gutters 48). Above it the real spans always apply, exactly like the stylesheet: the canon paints its 2-column tiles at 176 px (min 200) on a 1120 px grid and must keep doing so. */
export const GRID_DESKTOP_WIDTH = 912

/** Columns a cell actually occupies (pure). - unknown width → `cols` (desktop first paint; CSS covers the phone case) - width < 600 → full - width < 900 → at least half - width < 912 → `min` px that does not fit promotes to half, then full - otherwise `cols` (desktop: the canon spans, never promoted). */
export function effectiveSpan(input: { cols: number; columns: number; min?: number; width: number | null; gap: number }): number

/** Tablet-tier span (≥ half) for the CSS fallback variable. */
export function tabletSpan(cols: number, columns: number): number

/** Class list of a span cell (pure): `c22-span-N` + `c22-min-B` + `c22-rowspan-R`. */
export function spanClassNames(input: { span: number; min?: number; rowSpan?: number }): string[]
export function CocoaGrid({ columns = 12, gap = 3, stagger = false, align, children, className, style, role, "aria-label": ariaLabel }: CocoaGridProps)
export function CocoaSpan({ cols, min, rowSpan, children, className, style }: CocoaSpanProps)
```

#### `CocoaKpi.tsx`

```ts
/** Unit of the delta chip: the four usual ones keep autocomplete; any other short unit («hab», «noches») is accepted (`(string & {})`). */
export type CocoaKpiDeltaUnit = "%" | "pp" | "€" | "pts" | (string & {});
export type CocoaKpiPolarity = "positive-good" | "negative-good" | "neutral";
export type CocoaKpiStatus = "ok" | "warning" | "critical";
export type CocoaKpiSize = "regular" | "compact";

export interface CocoaKpiProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Secondary line under the figure («272,00 €», «4 facturas»): context of the value, not its unit (Tanda 6). */
  caption?: string;
  delta?: number;
  deltaUnit?: CocoaKpiDeltaUnit;
  /** «vs LY», «vs ayer». */
  deltaLabel?: string;
  polarity?: CocoaKpiPolarity;
  sparkline?: readonly number[];
  status?: CocoaKpiStatus;
  /** Forces the colour of the figure (the status bar keeps its own tone). */
  tone?: CocoaTone;
  size?: CocoaKpiSize;
  icon?: ReactNode;
  onClick?: () => void;
  /** The counter's query failed: paint «—» with the hint instead of a fake value. */
  degraded?: boolean;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

export interface CocoaKpiStripProps {
  /** Minimum tile width in px for the auto-fit grid. Default 180 (canon); ops mini-cards use 200. */
  min?: number;
  stagger?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export interface CocoaDeltaProps {
  delta?: number;
  unit?: string;
  /** «vs LY». */
  label?: string;
  polarity?: CocoaKpiPolarity;
  className?: string;
  style?: CSSProperties;
}

/** Tone of a delta by polarity (pure): success / danger / neutral. */
export function deltaTone(delta: number | undefined, polarity: CocoaKpiPolarity = "positive-good"): "success" | "danger" | "neutral"

/** Sentiment of a delta (pure; the css lot's `data-sentiment`). */
export function deltaSentiment(delta: number | undefined, polarity: CocoaKpiPolarity = "positive-good"): CocoaSentiment

/** «▲» / «▼» / «•» (pure). */
export function deltaArrow(delta: number): string

/** Absolute delta with sensible precision: integers whole, otherwise one decimal (es-ES via lib/format). */
export function formatDelta(delta: number): string

/** Colours of a delta chip (pure): AA ink for the 11 px text, the tone hue only for the arrow glyph. */
export function deltaColors(tone: "success" | "danger" | "neutral"): { text: string; arrow: string }

/** Accessible name «etiqueta, valor unidad, +delta unidad vs LY» (pure). */
export function kpiAriaLabel(input: { label: string; value: string | number; unit?: string; caption?: string; delta?: number; deltaUnit?: string; deltaLabel?: string; degraded?: boolean; }): string

/** Delta chip: «▲ 100 % vs LY» in the polarity colour; decorative (the KPI's aria-label carries the value). */
export function CocoaDelta({ delta, unit, label, polarity = "positive-good", className, style }: CocoaDeltaProps)
export function CocoaKpi({ label, value, unit, caption, delta, deltaUnit, deltaLabel, polarity = "positive-good", sparkline, status, tone, size = "regular", icon, onClick, degraded = false, id, className, style }: CocoaKpiProps)

/** `data-min` values the stylesheet resolves by itself; other minimums travel as an inline variable. */
export const KPI_STRIP_CSS_MINS: readonly number[] = [180, 200, 240]
export function CocoaKpiStrip({ min = 180, stagger = false, children, className, style, "aria-label": ariaLabel }: CocoaKpiStripProps)
```

#### `CocoaSection.tsx`

```ts
export interface CocoaSectionProps extends Pick<CocoaCardProps, "variant" | "padding" | "onClick"> {
  title?: string;
  /** Caption at the right of the title («OTB · Forecast · LY», «datos a 08:12»). */
  meta?: ReactNode;
  /** Action at the right («Ver detalle»); a CocoaButton plain/small. */
  action?: ReactNode;
  headingLevel?: 2 | 3;
  footer?: ReactNode;
  /** Scroll axis of the body (tables → "x"). */
  scroll?: "x" | "y";
  /** Upper bound (px) of the body when `scroll="y"`: the body grows with its content up to it, then scrolls (an empty thread stays short). */
  maxHeight?: number;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
}

export function CocoaSection({ variant = "bordered", padding = "md", onClick, title, meta, action, headingLevel = 3, footer, scroll, maxHeight, children, id, className, style, "aria-label": ariaLabel }: CocoaSectionProps)
```

#### `CocoaBadge.tsx`

```ts
export type CocoaBadgeVariant = "outline" | "tinted" | "dot";
export type CocoaBadgeSize = "small" | "regular";

export interface CocoaBadgeProps {
  tone?: CocoaTone;
  variant?: CocoaBadgeVariant;
  size?: CocoaBadgeSize;
  /** Default: true for outline/tinted, false for dot. */
  uppercase?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
}

export interface BadgeTokens {
  color: string;
  background: string;
  border: string;
  /** Colour of the leading dot (`dot` variant only). */
  dot?: string;
}

/** Token set for a tone/variant pair (pure, unit-tested). */
export function badgeTokens(tone: CocoaTone, variant: CocoaBadgeVariant): BadgeTokens
export function CocoaBadge({ tone = "neutral", variant = "outline", size = "regular", uppercase, icon, children, title, className, style, role, "aria-label": ariaLabel }: CocoaBadgeProps)
```

#### `CocoaCallout.tsx`

```ts
export type CocoaCalloutVariant = "inline" | "banner";

export interface CocoaCalloutProps {
  tone?: CocoaTone;
  variant?: CocoaCalloutVariant;
  title?: string;
  icon?: ReactNode;
  /** Buttons at the right (CocoaButton small). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Default `note` (static). `status`/`alert` only for messages that change while mounted. */
  role?: "status" | "alert" | "note";
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

/** ARIA role of a callout (pure): `note` unless the caller asks for a live role; the tone never makes it live. */
export function calloutRole(_tone: CocoaTone, role?: CocoaCalloutProps["role"]): "status" | "alert" | "note"
export function CocoaCallout({ tone = "neutral", variant = "inline", title, icon, actions, children, role, id, className, style }: CocoaCalloutProps)
```

#### `CocoaKbd.tsx`

```ts
export interface CocoaKbdProps {
  children: ReactNode;
  /** Announce the key to AT (default: hidden, decorative). */
  announce?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CocoaKbd({ children, announce = false, className, style }: CocoaKbdProps)
```

#### `CocoaLiveRegion.tsx`

```ts
export interface CocoaLiveRegionProps {
  message: ReactNode;
  politeness?: "polite" | "assertive";
  /** Change it to re-announce an identical message. */
  announceKey?: string | number;
  id?: string;
}

export function CocoaLiveRegion({ message, politeness = "polite", announceKey, id }: CocoaLiveRegionProps)
```

#### `CocoaState.tsx`

```ts
export const CocoaIllustrations = {
  box: EmptyStateBox,
  search: EmptyStateSearch,
  error: EmptyStateError,
  connection: EmptyStateConnection,
  success: SuccessIllustration
} as const

export type CocoaIllustrationKey = keyof typeof CocoaIllustrations;
export type CocoaStateKind = "empty" | "error" | "loading" | "degraded";

export interface CocoaStateAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
}

export interface CocoaStateProps {
  kind: CocoaStateKind;
  title?: string;
  message?: string;
  illustration?: CocoaIllustrationKey;
  primaryAction?: CocoaStateAction;
  secondaryAction?: CocoaStateAction;
  /** Shorthand for an error state's «Reintentar» (bordered, neutral). */
  onRetry?: () => void;
  /** Inside a card: a caption row without illustration. */
  inline?: boolean;
  /** Dashed CTA box inside a card (no illustration, compact). */
  dashed?: boolean;
  role?: "status" | "alert";
  className?: string;
  style?: CSSProperties;
}

/** Resolved copy/role of a state (pure, unit-tested). */
export function resolveStateDefaults(kind: CocoaStateKind, overrides: Pick<CocoaStateProps, "title" | "message" | "illustration" | "role">)
export function CocoaState({ kind, title, message, illustration, primaryAction, secondaryAction, onRetry, inline = false, dashed = false, role, className, style }: CocoaStateProps)
export type CocoaSkeletonVariant = "text" | "title" | "kpi" | "card" | "chart" | "row" | "avatar" | "button";

export interface CocoaSkeletonProps {
  variant?: CocoaSkeletonVariant;
  width?: string | number;
  height?: number;
  /** Repeats `text` lines with 100 / 85 / 60 % widths. */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

export const SKELETON_HEIGHT: Record<CocoaSkeletonVariant, number> = {
  text: 12,
  title: 18,
  row: 36,
  kpi: 110,
  chart: 200,
  card: 240,
  avatar: 32,
  button: 28
}

/** Width of the n-th text line (pure): full, then 85 %, then 60 % for the last. */
export function skeletonLineWidth(index: number, total: number): string

/** `data-width` hint of a text line for the stylesheet (pure). */
export function skeletonLineWidthHint(index: number, total: number): "short" | "medium" | undefined
export function CocoaSkeleton({ variant = "text", width, height, lines, className, style }: CocoaSkeletonProps)

export interface CocoaSkeletonGridProps {
  /** Rows of spans, mirroring the real grid: `[[8,2,2],[4,4,2,2]]`. */
  rows: ReadonlyArray<ReadonlyArray<CocoaSpanCols>>;
  /** Height of each placeholder card. Default 240. */
  height?: number;
  label?: string;
}

export interface CocoaSkeletonStripProps {
  count?: number;
  min?: number;
  label?: string;
}
```

#### `CocoaStat.tsx`

```ts
export interface CocoaStatProps {
  label: string;
  value: ReactNode;
  /** Decimals / unit painted smaller in secondary («,50 €»). */
  suffix?: ReactNode;
  tone?: CocoaTone;
  hint?: string;
  align?: "left" | "right";
  size?: "regular" | "large";
  /** Tabular figures (default true; disable for text values). */
  tabular?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CocoaStat({ label, value, suffix, tone, hint, align = "left", size = "regular", tabular = true, className, style }: CocoaStatProps)
```

#### `CocoaField.tsx`

```ts
export interface CocoaFieldProps {
  label: string;
  /** Id of the control; generated (and injected into the child) when omitted. */
  htmlFor?: string;
  required?: boolean;
  help?: string;
  error?: string;
  /** Right of the label («opcional», a link). */
  hint?: ReactNode;
  /** Switch layout: label left, control right. */
  inline?: boolean;
  /** Uppercase caption label (dense forms). Default false. */
  uppercase?: boolean;
  /** Spans every column of its CocoaFormRow. */
  fullWidth?: boolean;
  children: ReactElement;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

/** Space-separated `aria-describedby` from the ids that exist (pure). */
export function describedBy(ids: { help?: string | null; error?: string | null; external?: string | null }): string | undefined

/** Id the <label> points at (pure): explicit `htmlFor`, else the child's own `id`, else the generated one (which is then injected into the child). */
export function resolveControlId(htmlFor: string | undefined, childId: unknown, generated: string): string
export function CocoaField({ label, htmlFor, required = false, help, error, hint, inline = false, uppercase = false, fullWidth = false, children, className, style }: CocoaFieldProps)
export type CocoaFormRowColumns = 1 | 2 | 3 | 4;

export interface CocoaFormRowProps {
  columns?: CocoaFormRowColumns;
  /** Minimum column width in px (default 240); a narrower container drops columns. */
  min?: number;
  children: ReactNode;
  /** Name the row as a group (`role="group"` + `aria-label`): inline forms in a section footer («Añadir competidor»). */
  role?: "group";
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

/** Column gap of a form row in px (`--cocoa-space-3`, mirrored from the stylesheet's `.c22-form-row`). */
export const FORM_ROW_GAP_PX = 12

/** Columns a form row paints (pure): as many of the requested `columns` as fit `min` px each (plus the gap) in the measured container width; at least 1. Unknown width (first paint, no ResizeObserver) → the request; the stylesheet's phone media query still forces 1 column below 600 px. */
export function formRowColumns(columns: CocoaFormRowColumns, input: { width: number | null; min?: number; gap?: number }): number

/** The template itself lives in the stylesheet (`.c22-form-row[data-columns]` → `repeat(N, minmax(0, 1fr))`, 1 column under 600 px): this component only measures its own width and emits the effective column count, so a row inside a drawer or a narrow CocoaSpan never overflows its container. */
export function CocoaFormRow({ columns = 2, min = 240, children, role, "aria-label": ariaLabel, className, style }: CocoaFormRowProps)

export interface CocoaFormSectionProps {
  title: string;
  description?: string;
  /** Wrap the children in a CocoaFormRow of N columns. */
  columns?: 1 | 2;
  children: ReactNode;
  /** Right-aligned footer (per-section save, «Restablecer»). */
  actions?: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

export function CocoaFormSection({ title, description, columns, children, actions, id, className, style }: CocoaFormSectionProps)
```

#### `CocoaInput.tsx`

```ts
export type CocoaInputSize = "small" | "regular" | "large";

export type CocoaInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  size?: CocoaInputSize;
  icon?: ReactNode;
  rightSlot?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  error?: boolean;
  inputMode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search";
  required?: boolean;
  /** Render a <textarea> (vertical resize). */
  multiline?: boolean;
  rows?: number;
  /** Native <datalist> suggestions (single-line only): offered while typing, free text stays allowed (a category field with the usual values). */
  suggestions?: readonly string[];
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  pattern?: string;
  onBlur?: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Accessible name when there is no visible <label>. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Explicit id so an external <label htmlFor> can point at the input; defaults to a generated one. */
  id?: string;
  className?: string;
  /** Layout escape hatch for the wrapper (width). */
  style?: CSSProperties;
};

/** Outer height of every text-like control by size (§3.8): shared with CocoaSelect / CocoaDatePicker. */
export const CONTROL_HEIGHT_BY_SIZE: Record<CocoaInputSize, number> = { small: 22, regular: 28, large: 34 }

/** Border of every control (1 px each side). */
export const CONTROL_BORDER_PX = 1

/** Vertical padding that makes the control exactly `CONTROL_HEIGHT_BY_SIZE[size]` tall (pure): (height − 2 × border − line-height) / 2. */
export function inputPaddingY(size: CocoaInputSize): number

/** Border and halo of a control by state (pure; shared with select/date picker). */
export function controlChrome(input: { focused: boolean; error: boolean }): { borderColor: string; boxShadow: string }
export function CocoaInput(props: CocoaInputProps)
```

#### `CocoaSelect.tsx`

```ts
export interface CocoaSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CocoaSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSelectOption>;
  /** Disabled, hidden first option shown while `value` is "" («Selecciona un canal»); a REAL «none» choice («Sin asignar») must be an explicit `{ value: "", label }` option instead. */
  placeholder?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
  error?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  /** Layout escape hatch for the wrapper (width). */
  style?: CSSProperties;
  /** Shrink to the widest option instead of filling the row (pickers in an actions row or a toolbar). */
  inline?: boolean;
}

/** Outer height of a select by size (pure; equals CocoaInput's). */
export function selectControlHeight(size: NonNullable<CocoaSelectProps["size"]>): number
export function CocoaSelect({ value, onChange, options, placeholder, size = "regular", disabled = false, error = false, required = false, id, name, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, className, style, inline = false }: CocoaSelectProps)
```

#### `CocoaSwitch.tsx`

```ts
export interface CocoaSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: "small" | "regular";
  label?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  style?: CSSProperties;
}

/** Thumb translation for a state (pure). */
export function switchThumbOffset(checked: boolean, dims: Dimensions): number
export function CocoaSwitch({ checked, onChange, size = "regular", label, disabled = false, id, name, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, className, style }: CocoaSwitchProps)
```

#### `CocoaDatePicker.tsx`

```ts
export interface CocoaDatePickerProps {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
  error?: boolean;
  required?: boolean;
  /** Date AND time (`datetime-local`; `value`/`min`/`max` as «YYYY-MM-DDTHH:mm»); default a date only. */
  withTime?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CocoaDatePicker({ value, onChange, min, max, size = "regular", disabled = false, error = false, required = false, withTime = false, id, name, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, className, style }: CocoaDatePickerProps)
```

#### `CocoaStepper.tsx`

```ts
export interface CocoaStepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "small" | "regular";
  disabled?: boolean;
  error?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Clamp to [min, max] (pure). */
export function clampStep(value: number, min: number, max: number): number

/** Fine pointer: ± stacked (NSStepper); coarse: side by side «− +» (UIStepper). */
export type CocoaStepperDirection = "column" | "row";

export interface CocoaStepperGeometry {
  direction: CocoaStepperDirection;
  /** Outer height of the control: 22 / 28, 44 on touch (equals CocoaInput / CocoaSelect). */
  height: number;
  /** Outer width of each ± button, borders included: 16 / 18, 44 on touch. */
  buttonWidth: number;
  chevronSize: number;
}

/** Geometry of the control by size and pointer (pure). */
export function stepperGeometry(size: NonNullable<CocoaStepperProps["size"]>, coarse: boolean): CocoaStepperGeometry

export interface CocoaStepperPartStyles {
  input: CSSProperties;
  increment: CSSProperties;
  decrement: CSSProperties;
}

/** Borders and corner radii of the three parts (pure): the outer edge paints `borderColor` (the control chrome: separator, accent on focus, danger on error), the dividers between parts paint the separator, and only the outer corners are rounded so the assembled control reads as one 8 px shell. */
export function stepperPartStyles(direction: CocoaStepperDirection, borderColor: string): CocoaStepperPartStyles
export function CocoaStepper({ value, onChange, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, step = 1, size = "regular", disabled = false, error = false, id, name, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, className, style }: CocoaStepperProps)
```

#### `CocoaFileInput.tsx`

```ts
export interface CocoaFileInputProps {
  /** Native `accept` list: extensions and/or MIME types, comma-separated (`.n43,.txt,text/plain`). */
  accept?: string;
  /** Upper bound in bytes; a heavier file is refused before `onPick`. */
  maxBytes?: number;
  /** The chosen file (already within `accept` and `maxBytes`). */
  onPick: (file: File) => void;
  /** Spanish reason a file was refused (type or size); without it the refusal is silent. */
  onReject?: (message: string) => void;
  /** Button label; default «Elegir fichero». */
  label?: string;
  /** Name of the file currently loaded, painted next to the button (the caller owns it). */
  fileName?: string | null;
  disabled?: boolean;
  /** Button size; default `small` (the picker sits in a row of small actions). */
  size?: CocoaButtonSize;
  /** Button icon; default `UploadIcon`. */
  icon?: ReactNode;
  id?: string;
  "aria-describedby"?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

/** «812 B» · «512 KB» · «2,5 MB» (pure, es-ES, base 1024). */
export function formatFileSize(bytes: number): string

/** Whether a file satisfies a native `accept` list (pure): `.ext` by name, `type/*` or `type/sub` by MIME; an empty list accepts everything. */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string | undefined): boolean

/** Spanish rejection for a file outside `accept` or over `maxBytes`; null when it passes (pure). */
export function fileInputRejection(file: { name: string; size: number; type: string }, limits: { accept?: string; maxBytes?: number }): string | null
export function CocoaFileInput({ accept, maxBytes, onPick, onReject, label = "Elegir fichero", fileName, disabled = false, size = "small", icon, id, "aria-describedby": ariaDescribedBy, className, style }: CocoaFileInputProps)
```

#### `CocoaSearchInput.tsx`

```ts
export type CocoaSearchInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
  onClear?: () => void;
  /** Enter with the current (undebounced) text. */
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  /** Accessible name (default «Buscar»). */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
};

export function CocoaSearchInput(props: CocoaSearchInputProps)
```

#### `CocoaSegmentedControl.tsx`

```ts
export type CocoaSegmentedControlSize = "small" | "regular";

export interface CocoaSegmentedControlOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface CocoaSegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSegmentedControlOption>;
  size?: CocoaSegmentedControlSize;
  /** Stretch every segment to share the width (phones). */
  fullWidth?: boolean;
  /**
   * id of the element the active tab controls (`aria-controls`, as CocoaRouteTabs
   * does): give that container `role="tabpanel"` and an `aria-label` — the
   * segmented control has no ids of its own to point `aria-labelledby` at.
   */
  panelId?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

/** Next enabled value for a navigation key (pure): wraps; null for other keys. */
export function nextSegmentValue(current: string, values: readonly string[], key: string): string | null

/** True when the strip's content is wider than its box (pure; 1 px tolerance for subpixel rounding). */
export function segmentedOverflows(scrollWidth: number, clientWidth: number): boolean

/** Radius of a tab inside the 2 px-padded strip (radius 8 − 2). */
export const TAB_ITEM_RADIUS = "calc(var(--cocoa-radius-md) - 2px)"

/** Active surface of a tab (pure): content background + inset control shadow on an absolutely positioned, decorative child; fades with `opacity` so the switch keeps the 200 ms transition. Sits at z-index −1 inside the button's own stacking context (`isolation: isolate`), i.e. under the label and above the strip. */
export function tabSurfaceStyle(isActive: boolean): CSSProperties

/** Button style of a segment (pure): NO `boxShadow` and a transparent background — both live on the surface child. */
export function segmentItemStyle(input: { isActive: boolean; disabled?: boolean; size: CocoaSegmentedControlSize; fullWidth: boolean }): CSSProperties
export function CocoaSegmentedControl({ value, onChange, options, size = "regular", fullWidth = false, panelId, className, style, "aria-label": ariaLabel }: CocoaSegmentedControlProps)
```

#### `CocoaTable.tsx`

```ts
export type CocoaTableSortDirection = "asc" | "desc";
export type CocoaTableDensity = "comfortable" | "compact";

export interface CocoaTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  minWidth?: number;
  /**
   * Shrink the column to its content on one line (dates, numbers, identifiers,
   * badges, short enums): the free width goes to the text columns instead of
   * being shared out. Implies `nowrap`; an explicit `width` still wins.
   */
  fit?: boolean;
  /** Keep the cells on one line. Default: `true` for `fit` and for `align: "right"` (a number never splits). */
  nowrap?: boolean;
  render?: (row: Row) => ReactNode;
  /** Cell of the totals row (`footer` prop must be true or an object). */
  footer?: ReactNode;
  /** Hide on phones (secondary columns). Same as `showFrom: "tablet"`. */
  hideOnNarrow?: boolean;
  /**
   * First viewport tier that shows the column (`"tablet"` ≥ 600 · `"laptop"`
   * ≥ 900 · `"desktop"` ≥ 1200): secondary columns of wide tables (7+ columns)
   * that would crush the text column on a 1024 laptop.
   */
  showFrom?: CocoaViewportTier;
}

export interface CocoaTableSort {
  key: string;
  direction: CocoaTableSortDirection;
}

export interface CocoaTableProps<Row> {
  columns: CocoaTableColumn<Row>[];
  rows: Row[];
  sortBy?: CocoaTableSort;
  onSort?: (sort: CocoaTableSort) => void;
  rowKey?: string | ((row: Row) => string);
  selectedKey?: string;
  onSelect?: (row: Row) => void;
  emptyState?: ReactNode;
  loading?: boolean;
  density?: CocoaTableDensity;
  stickyFirstColumn?: boolean;
  /** Trailing actions cell per row (CocoaButton plain/small). */
  rowActions?: (row: Row) => ReactNode;
  /**
   * When the row actions show on a fine pointer: `hover` (default: hover, focus
   * and selection; always on touch and in the phone cards) or `always` — for
   * tables whose actions ARE the interaction (channels: probar · mapeos ·
   * desactivar · archivar) and must be discoverable without a mouse move.
   */
  rowActionsVisible?: "hover" | "always";
  /** Tone wash of a row (`data-tone` on the <tr>, tone-bg on the phone card; hover and selection still win): low stock, overdue… */
  rowTone?: (row: Row) => CocoaTone | undefined;
  /** Native tooltip of a row («Abrir el detalle de la propiedad»). */
  rowTitle?: (row: Row) => string | undefined;
  /** Totals row: `true` uses each column's `footer`; an object maps column key → cell. */
  footer?: boolean | Record<string, ReactNode>;
  /** Progressive rendering for long lists (chunks of 100 once past 200 rows). */
  virtualize?: boolean;
  /** Visually hidden <caption> (accessible name of the table). */
  caption?: string;
  "aria-label"?: string;
  /** Own vertical scroller (the sticky head needs it). */
  maxHeight?: number;
  className?: string;
  style?: CSSProperties;
}

export const VIRTUALIZE_THRESHOLD = 200
export const VIRTUALIZE_CHUNK = 100

/** Next sort for a header click (pure): asc → desc on the same key, asc on a new key. */
export function nextSort(current: CocoaTableSort | undefined, key: string): CocoaTableSort

/** Rows rendered so far under progressive rendering (pure). */
export function visibleRowCount(total: number, pages: number, threshold = VIRTUALIZE_THRESHOLD, chunk = VIRTUALIZE_CHUNK): number

/** Overflow of the wrapper (pure). The head can only stick to a scroller it lives in: without `maxHeight` the wrapper must NOT be a scroll container (`clip` clips without scrolling, unlike `hidden`), so the page scroller keeps the head; `overflowing` (table wider than the wrapper) trades the sticky head for a horizontal scroller; `maxHeight` makes the wrapper the scroller and the head sticks inside it. */
export function wrapOverflowStyle(input: { maxHeight?: number; overflowing: boolean }): CSSProperties

/** True when the table needs more width than its wrapper offers (pure; 0.5 px tolerance for subpixel layouts). */
export function isTableOverflowing(tableWidth: number, wrapWidth: number): boolean

/** Whether a column is shown at a viewport tier (pure): `hideOnNarrow` hides it on phones, `showFrom` below that tier. */
export function isColumnVisible(column: Pick<CocoaTableColumn<unknown>, "hideOnNarrow" | "showFrom">, tier: CocoaViewportTier): boolean

/** Sizing of a column's cells (pure). `fit` shrinks the column to its content on one line — a 1 px `width` in `table-layout: auto` resolves to the min-content width, the trick the actions cell already uses — unless an explicit `width` is given; `nowrap` defaults to true for `fit` and for right-aligned (numeric) columns. Only the keys that apply are returned so the caller can spread it under its own `whiteSpace`. */
export function columnSizingStyle(column: Pick<CocoaTableColumn<unknown>, "width" | "minWidth" | "fit" | "nowrap" | "align">): CSSProperties

/** Cell padding for a density (pure); undefined → inherited page density or comfortable. */
export function densityRowPadding(density: CocoaTableDensity | undefined): string
export function resolveRowKey<Row>(row: Row, rowKey: string | ((row: Row) => string) | undefined, idx: number): string
export function defaultRender<Row>(row: Row, key: string): ReactNode
export function CocoaTable<Row>({ columns, rows, sortBy, onSort, rowKey, selectedKey, onSelect, emptyState, loading = false, density, stickyFirstColumn = false, rowActions, rowActionsVisible = "hover", rowTone, rowTitle, footer, virtualize = false, caption, "aria-label": ariaLabel, maxHeight, className, style }: CocoaTableProps<Row>)
```

#### `CocoaScrollArea.tsx`

```ts
export type CocoaScrollAxis = "x" | "y" | "both";

export interface CocoaScrollAreaProps {
  axis?: CocoaScrollAxis;
  /** First `th`/`td` of each row stays visible while scrolling horizontally. */
  stickyFirstColumn?: boolean;
  /** Fade the right edge (default: true when the axis includes x). */
  fade?: boolean;
  /** Fixed height (the box becomes the vertical scroller too). */
  maxHeight?: number | string;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
  role?: string;
}

export function CocoaScrollArea({ axis = "x", stickyFirstColumn = false, fade, maxHeight, children, id, className, style, "aria-label": ariaLabel, role }: CocoaScrollAreaProps)
```

#### `CocoaToolbar.tsx`

```ts
export type CocoaToolbarVariant = "window" | "content";

export interface CocoaToolbarProps {
  variant?: CocoaToolbarVariant;
  title?: string;
  subtitle?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  showTrafficLights?: boolean;
  /** Sticky at the top of its scroller (default: true for window, false for content). */
  sticky?: boolean;
  /** Let the zones wrap (default: true for content, false for window). */
  wrap?: boolean;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
}

export function CocoaToolbar({ variant = "window", title, subtitle, leftSlot, rightSlot, showTrafficLights = false, sticky, wrap, "aria-label": ariaLabel, className, style }: CocoaToolbarProps)
```

#### `CocoaPopover.tsx`

```ts
export type CocoaPopoverPlacement = "top" | "bottom" | "left" | "right";

export interface CocoaPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  placement?: CocoaPopoverPlacement;
  onClose: () => void;
  children: ReactNode;
  /** `dialog` (default) or `menu`/`listbox` when the content is a list. */
  role?: "dialog" | "menu" | "listbox" | "tooltip";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

/** Popover origin for a placement (pure). */
export function computePosition(anchorRect: { top: number; left: number; right: number; bottom: number; width: number; height: number }, popoverRect: { width: number; height: number }, placement: CocoaPopoverPlacement): Position
export function CocoaPopover({ open, anchorEl, placement = "bottom", onClose, children, role = "dialog", "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, className }: CocoaPopoverProps)
```

#### `CocoaSheet.tsx`

```ts
export type CocoaSheetSize = "sm" | "md" | "lg";

export interface CocoaSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: CocoaSheetSize;
  footer?: ReactNode;
  /** Esc and the scrim close the sheet (default true). */
  dismissible?: boolean;
  /** Accessible name when there is no title. */
  "aria-label"?: string;
  initialFocus?: () => HTMLElement | null | undefined;
}

export const SHEET_MAX_WIDTH: Record<CocoaSheetSize, number> = { sm: 480, md: 640, lg: 880 }
export function CocoaSheet({ open, onClose, title, children, size = "md", footer, dismissible = true, "aria-label": ariaLabel, initialFocus }: CocoaSheetProps)
```

#### `CocoaDrawer.tsx`

```ts
export type CocoaDrawerSide = "right" | "bottom" | "left";
export type CocoaDrawerSize = "sm" | "md" | "lg";

export interface CocoaDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  side?: CocoaDrawerSide;
  size?: CocoaDrawerSize;
  footer?: ReactNode;
  /** Esc and the scrim close the drawer (default true; false for mandatory flows). */
  dismissible?: boolean;
  /** Element to focus on open (default: first focusable, then the panel). */
  initialFocus?: () => HTMLElement | null | undefined;
  /** When it changes while the drawer is open, `initialFocus` is evaluated again (a form that arrives after a fetch: pass the loaded state). */
  focusKey?: string | number | boolean;
  children: ReactNode;
  className?: string;
  /** Layout escape hatch for the panel. */
  style?: CSSProperties;
}

export const DRAWER_WIDTH: Record<CocoaDrawerSize, number> = { sm: 360, md: 480, lg: 640 }

export interface DrawerGeometry {
  side: CocoaDrawerSide;
  width: string;
  maxHeight: string;
  hiddenTransform: string;
  radius: CSSProperties;
  anchor: CSSProperties;
}

/** Effective side and box of the panel (pure): phones always get a bottom sheet. */
export function drawerGeometry(input: { side: CocoaDrawerSide; size: CocoaDrawerSize; isNarrow: boolean }): DrawerGeometry
export function CocoaDrawer({ open, onClose, title, subtitle, side = "right", size = "md", footer, dismissible = true, initialFocus, focusKey, children, className, style }: CocoaDrawerProps)
```

#### `CocoaDialog.tsx`

```ts
export type CocoaDialogTone = "primary" | "destructive";
export type CocoaDialogSize = "sm" | "md";

export interface CocoaDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  tone?: CocoaDialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** External busy flag (the caller awaits its own request). */
  busy?: boolean;
  /** Keeps Confirm disabled (a prompt whose field is still invalid); Cancel, Esc and the overlay keep working. */
  confirmDisabled?: boolean;
  /** Extra content between the description and the buttons (lists, notes). */
  children?: ReactNode;
  size?: CocoaDialogSize;
  /** Single-button dialogs (acknowledgements). */
  hideCancel?: boolean;
  /** Element to focus on open (a field inside `children`, e.g. a one-line prompt); default: the safe button — Cancel for destructive dialogs, Confirm otherwise. */
  initialFocus?: () => HTMLElement | null | undefined;
}

export const DIALOG_WIDTH: Record<CocoaDialogSize, number> = { sm: 440, md: 560 }

/** Which button takes the initial focus (pure): the safe one for destructive dialogs. */
export function dialogInitialFocus(tone: CocoaDialogTone, hideCancel = false): "confirm" | "cancel"
export function CocoaDialog({ open, onClose, title, description, tone = "primary", confirmLabel = "Confirmar", cancelLabel = "Cancelar", onConfirm, busy = false, confirmDisabled = false, children, size = "sm", hideCancel = false, initialFocus }: CocoaDialogProps)
```

#### `CocoaToast.tsx`

```ts
export type CocoaToastVariant = "success" | "error" | "info" | "warning";

/** Tone of a toast variant (pure): `error` → danger. */
export function toastTone(variant: CocoaToastVariant): CocoaTone

/** Fixed stack style by tier (pure). */
export function toastViewportStyle(isNarrow: boolean): CSSProperties

export interface CocoaToastProps {
  id: number | string;
  message: ReactNode;
  variant?: CocoaToastVariant;
  /** Auto-dismiss after ms; ≤ 0 keeps it until dismissed. */
  duration?: number;
  onDismiss: (id: number | string) => void;
}

export function CocoaToast({ id, message, variant = "info", duration = 4000, onDismiss }: CocoaToastProps)

export interface CocoaToastViewportProps {
  children: ReactNode;
  "aria-label"?: string;
}

export function CocoaToastViewport({ children, "aria-label": ariaLabel = "Notificaciones" }: CocoaToastViewportProps)

/** Alias with the css lot's name. */
export const CocoaToastStack = CocoaToastViewport
```

#### `CocoaActionBar.tsx`

```ts
export type CocoaActionBarAction = Omit<CocoaButtonProps, "children" | "ref"> & { label: string };

export interface CocoaActionBarProps {
  primary?: CocoaActionBarAction;
  secondary?: CocoaActionBarAction;
  /** Extra controls between the status and the buttons. */
  extra?: ReactNode;
  /** Status text at the left («Guardado a las 10:12», «3 celdas sin guardar»). */
  status?: ReactNode;
  /** Sticky on desktop (default true); false renders it in flow. */
  sticky?: boolean;
  /** Render only below 600 px (the desktop keeps its header actions). */
  mobileOnly?: boolean;
  /** Let the status wrap onto several lines (composed status: badge + text + chip); default one line with ellipsis. */
  wrap?: boolean;
  publishToastOffset?: boolean;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
}

/** Ctrl/⌘ + Enter (pure). */
export function isPrimaryShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean }): boolean

/** True when the shortcut's target sits inside an open overlay (dialog, drawer, sheet: `role="dialog"` / `"alertdialog"`), which owns Enter there (pure; takes anything with a `closest()` so tests need no DOM). */
export function shortcutInsideOverlay(target: unknown): boolean

/** Placement of the bar by tier (pure; informational `data-placement`, the stylesheet decides). */
export function actionBarPlacement(input: { isNarrow: boolean; sticky: boolean }): "fixed" | "sticky" | "static"
export function CocoaActionBar({ primary, secondary, extra, status, sticky = true, mobileOnly = false, wrap = false, publishToastOffset = false, className, style, "aria-label": ariaLabel }: CocoaActionBarProps)
```

#### `CocoaChart.tsx`

```ts
export type CocoaSeriesTone = CocoaTone | "tertiary";

/** Canon series order when no tone is given: accent → warning → tertiary → info → success → neutral. */
export const SERIES_TONE_ORDER: readonly CocoaSeriesTone[] = ["accent", "warning", "tertiary", "info", "success", "neutral"]

/** Tone name of a series (pure): explicit tone, else by index in the canon order. */
export function seriesToneName(tone: CocoaSeriesTone | undefined, index: number): CocoaSeriesTone

/** Stroke of a series (pure): the tone hue, `label-tertiary` for `tertiary`. */
export function seriesStroke(tone: CocoaSeriesTone | undefined, index: number): string

/** Canon donut palette: accent, then the label greys (85 / 62 / 26 %), then the quaternary fill. */
export const DONUT_PALETTE: readonly string[] = [
  "var(--cocoa-chart-primary)",
  "var(--cocoa-chart-series-2)",
  "var(--cocoa-chart-series-3)",
  "var(--cocoa-chart-series-4)",
  "var(--cocoa-fill-quaternary)"
]

/** Fill of a donut slice (pure): explicit tone, else the palette by index. */
export function donutSliceColor(tone: CocoaTone | undefined, index: number): string

export interface CocoaSparklineProps {
  values: readonly number[];
  tone?: CocoaTone;
  width?: number;
  height?: number;
  /** When given the sparkline is announced; otherwise it is decorative. */
  "aria-label"?: string;
  className?: string;
}

export function CocoaSparkline({ values, tone, width = 60, height = 20, "aria-label": ariaLabel, className }: CocoaSparklineProps)

export interface CocoaBarsDatum {
  label: string;
  value: number;
  tone?: CocoaTone;
  /** Extra text for the tooltip («vs LY: +3,1 %»). */
  hint?: string;
}

export interface CocoaBarsProps {
  data: readonly CocoaBarsDatum[];
  /** Total height in px (min 60). Default 120. */
  height?: number;
  valueFormat?: (value: number) => string;
  polarity?: ChartPolarity;
  "aria-label"?: string;
}

export function CocoaBars({ data, height = 120, valueFormat = formatSigned, polarity = "positive-good", "aria-label": ariaLabel }: CocoaBarsProps)

export interface CocoaLinePoint {
  /** X label (already formatted: «05-10»). */
  x: string;
  y: number;
}

export interface CocoaLineSeries {
  id: string;
  label: string;
  points: readonly CocoaLinePoint[];
  tone?: CocoaSeriesTone;
  dashed?: boolean;
  width?: 1 | 2;
}

export interface CocoaLineProps {
  series: readonly CocoaLineSeries[];
  /** Plot height in px. Default 200. */
  height?: number;
  yLabel?: string;
  ticks?: number;
  tooltip?: boolean;
  legend?: boolean;
  valueFormat?: (value: number) => string;
  /** Title of the tooltip for a point (default: its `x` label). */
  tooltipTitle?: (x: string) => string;
  "aria-label"?: string;
}

export const MIN_LINE_WIDTH = 240

/** ViewBox width of a line chart (pure): the measured container, never below 240; the canon 640 until measured. */
export function lineViewBoxWidth(measured: number | null): number
export function CocoaLine({ series, height = 200, yLabel, ticks = 4, tooltip = true, legend = true, valueFormat = formatChartValue, tooltipTitle, "aria-label": ariaLabel }: CocoaLineProps)

export interface CocoaGaugeProps {
  value: number;
  min?: number;
  max?: number;
  /** `[warnAt, dangerAt]`; below the first success, below the second warning, else danger. */
  thresholds?: [number, number];
  /** Higher is better (flips the threshold tones). */
  invert?: boolean;
  /** Text under the figure («Riesgo cancelación»). */
  label?: string;
  /** Text under the label («12 reservas en riesgo»). */
  caption?: string;
  format?: (value: number) => string;
  "aria-label"?: string;
}

/** Spanish qualifier of a gauge tone (pure). */
export function gaugeToneLabel(tone: "success" | "warning" | "danger"): string
export function CocoaGauge({ value, min = 0, max = 100, thresholds = [30, 60], invert = false, label, caption, format, "aria-label": ariaLabel }: CocoaGaugeProps)

export interface CocoaDonutSlice {
  label: string;
  value: number;
  tone?: CocoaTone;
}

export interface CocoaDonutProps {
  slices: readonly CocoaDonutSlice[];
  centerLabel?: string;
  centerValue?: string;
  /** Diameter in px. Default 160. */
  size?: number;
  legend?: boolean;
  valueFormat?: (value: number) => string;
  "aria-label"?: string;
}

/** Share of a donut slice as es-ES percent with at most one decimal (pure): 0.125 → «12,5 %», 0.5 → «50 %». */
export function donutShareLabel(share: number): string
export function CocoaDonut({ slices, centerLabel, centerValue, size = 160, legend = true, valueFormat, "aria-label": ariaLabel }: CocoaDonutProps)

export interface CocoaProgressProps {
  /** 0–`max` (0–100 by default). */
  value: number;
  /** Upper bound of `value` (default 100): the bar fills value / max — a share scaled to the largest channel, 12 of 48 rooms. */
  max?: number;
  tone?: CocoaTone;
  label?: string;
  /** Show the value at the right of the label (the percentage of `max`, or `valueLabel`). Default true. */
  showValue?: boolean;
  /** Text at the right of the label instead of the computed percentage («12 de 48», the real share when the bar is scaled). */
  valueLabel?: string;
  "aria-label"?: string;
}

export function CocoaProgress({ value, max = 100, tone = "accent", label, showValue = true, valueLabel, "aria-label": ariaLabel }: CocoaProgressProps)

/** `CocoaChart.Line` etc. — one import for screens (COCOA-22.md §8). */
export const CocoaChart = {
  Sparkline: CocoaSparkline,
  Bars: CocoaBars,
  Line: CocoaLine,
  Gauge: CocoaGauge,
  Donut: CocoaDonut,
  Progress: CocoaProgress
} as const

export type CocoaChartNamespace = typeof CocoaChart;
export type { ReactNode as CocoaChartNode };
```

#### `CocoaSplitView.tsx`

```ts
export interface CocoaSplitViewProps {
  sidebar: ReactNode;
  content: ReactNode;
  inspector?: ReactNode;
  sidebarWidth?: number;
  inspectorWidth?: number;
  collapsibleSidebar?: boolean;
}

export function CocoaSplitView({ sidebar, content, inspector, sidebarWidth: sidebarWidthProp = DEFAULT_SIDEBAR_WIDTH, inspectorWidth: inspectorWidthProp = DEFAULT_INSPECTOR_WIDTH, collapsibleSidebar = true }: CocoaSplitViewProps)
```

#### `CocoaSidebar.tsx`

```ts
export interface CocoaSidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
  selected?: boolean;
}

export interface CocoaSidebarSection {
  title?: string;
  items: CocoaSidebarItem[];
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export interface CocoaSidebarProps {
  sections: CocoaSidebarSection[];
  onSelect: (itemId: string) => void;
  width?: number;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function CocoaSidebar({ sections, onSelect, width = DEFAULT_WIDTH, header, footer, className, "aria-label": ariaLabel = "Barra lateral" }: CocoaSidebarProps)
```

#### `CocoaRouteTabs.tsx`

```ts
/** Cancelable event dispatched BEFORE a tab switch; guards veto with preventDefault. */
export const TAB_NAV_EVENT = "hotelos-tab-nav"

/** Informational event dispatched AFTER the URL changed; strips re-sync on it. */
export const TAB_CHANGED_EVENT = "hotelos-tab-changed"

export type TabNavDetail = {
  basePath: string;
  from: string | null;
  to: string;
  /** Path plus preserved query string. */
  href: string;
};

export type LazyTabLoader = () => Promise<{ default: ComponentType<Record<string, never>> }>;

export type CocoaRouteTab = {
  /** Last URL segment of the tab (`lista`, `cronograma`); kebab-case, unique in the container. */
  key: string;
  label: string;
  /** Absolute path override; defaults to `${basePath}/${key}`. Use `basePath` itself for the base tab. May carry `:param`s. */
  path?: string;
  /** Role tokens allowed (evaluated by the caller's `isVisible`, e.g. with `canSee`). */
  roles?: readonly string[];
  /** Module codes, any of which must be enabled (idem). */
  modulesAny?: readonly string[];
  /** Lazy screen: `() => import("../screens/x/Y")` (module scope, so the loader identity is stable). */
  lazy?: LazyTabLoader;
  /** Inline content when the tab is cheap (takes precedence over `lazy`). */
  element?: ReactNode;
  icon?: ReactNode;
  /** Reachable by URL but not painted unless active (detail sub-URLs like `:id`). */
  hidden?: boolean;
};

export type CocoaRouteTabsProps = {
  /** Item URL of the tree (`/recepcion/reservas`). */
  basePath: string;
  tabs: readonly CocoaRouteTab[];
  /** Tab to land on when the URL is the bare `basePath`. */
  defaultTab: string;
  /** Landing tab below `mobileBreakpoint` (e.g. `mi-turno` for housekeeping). */
  mobileDefaultTab?: string;
  /** Default MOBILE_BREAKPOINT_PX (700). */
  mobileBreakpoint?: number;
  /** Keep `?filters` when switching tabs. Default true. */
  preserveQuery?: boolean;
  /** Role/module gate injected by the caller: `(tab) => canSee(tab, tokens, modules)`. */
  isVisible?: (tab: CocoaRouteTab) => boolean;
  onTabChange?: (key: string) => void;
  /** Accessible name of the tab list. Default «Secciones». */
  ariaLabel?: string;
  size?: "small" | "regular";
  /** Suspense fallback; default CocoaTabSkeleton. */
  fallback?: ReactNode;
  /** Shown when no tab is visible for the user. */
  emptyMessage?: string;
  className?: string;
  style?: CSSProperties;
  panelStyle?: CSSProperties;
};

/** Absolute path of a tab: explicit `path`, or `${basePath}/${key}` (`key === ""` → basePath). */
export function tabPath(basePath: string, tab: Pick<CocoaRouteTab, "key" | "path">): string
export function isBaseTab(basePath: string, tab: Pick<CocoaRouteTab, "key" | "path">): boolean

/** Key of the tab whose path matches the pathname; static paths win over `:param` ones; null when none. */
export function resolveTabKey(pathname: string, basePath: string, tabs: readonly Pick<CocoaRouteTab, "key" | "path">[]): string | null

export type LandingInput = {
  resolvedKey: string | null;
  visibleKeys: readonly string[];
  defaultTab: string;
  mobileDefaultTab?: string;
  isMobile: boolean;
};

/** Which tab to show: the one in the URL when visible; else the mobile default (only below the breakpoint); else the default; else the first visible; null when nothing is visible for the user. */
export function pickLandingTab(input: LandingInput): string | null

/** Path plus the current query string when `preserveQuery` (hash is always dropped). */
export function hrefForTab(path: string, search: string, preserveQuery: boolean): string

/** Roving focus target for a keyboard key; null for keys the strip ignores. */
export function nextTabKey(currentKey: string | null, keys: readonly string[], key: string): string | null

/** Writes the URL (push, or replace for landings) and tells every strip to re-sync. */
export function commitTabNavigation(detail: TabNavDetail, options: { replace?: boolean } = {}): void

/** Asks to switch tab: cancelable `hotelos-tab-nav`, decided once every listener ran (microtask, like App.tsx). A vetoing guard keeps `detail` and calls `commitTabNavigation(detail)` after the user confirms. */
export function requestTabNavigation(detail: TabNavDetail): void

/** Deep link to a tab URL from outside its container (⌘K, first-use chips, cross-screen links): writes the URL and fires `popstate` so App.tsx re-resolves the screen from the path. Requires the URL to be registered in the routes table (L1b); inside a container prefer `useRouteTabs().select`. A bare path keeps `?dev=1` of the current URL (navigation/dev-mode.ts). */
export function openTabPath(path: string, options: { replace?: boolean } = {}): void

/** True below `breakpoint` px (default 700); reactive to resizes. */
export function useIsMobileViewport(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean

export type UseRouteTabsInput = Pick<
  CocoaRouteTabsProps,
  "basePath" | "tabs" | "defaultTab" | "mobileDefaultTab" | "mobileBreakpoint" | "preserveQuery" | "isVisible" | "onTabChange"
>;

export type UseRouteTabsResult = {
  activeKey: string | null;
  activeTab: CocoaRouteTab | null;
  /** Tabs allowed for the user (hidden detail tabs included). */
  visibleTabs: CocoaRouteTab[];
  /** Tabs to paint: visible and not hidden, plus the active one. */
  paintedTabs: CocoaRouteTab[];
  isMobile: boolean;
  select: (key: string) => void;
  hrefFor: (key: string) => string | null;
};

/** Headless version for screens that render their own strip (e.g. inside CocoaPageHeader's `tabs`): same URL sync, guards, landing and lazy rules. */
export function useRouteTabs(input: UseRouteTabsInput): UseRouteTabsResult

/** Cocoa-spaced shimmer lines announced as «Cargando sección…»; the default Suspense fallback (CocoaSkeleton, no `.bo-*`). */
export function CocoaTabSkeleton(props: { lines?: number; label?: string })

/** Strip geometry (COCOA-22.md §3.3). On phones the strip scrolls; the lateral fade, the scroll-snap and the hidden scrollbar are owned by the css lot (`.c22-tablist`, styles/cocoa-22-layout.css), which also pads the end of the strip so the last tab clears the fade — hence no inline `padding-inline-end` below 900 px. */
export function tablistStyle(isMobile: boolean): CSSProperties

/** Tab button style (pure). NO `boxShadow` inline: the active surface (content bg + inset control shadow) is the decorative `tabSurfaceStyle` child, so the stylesheet's `.cocoa-focus-ring:focus-visible` ring can paint on the active tab — the only tab stop of the strip under roving tabindex. */
export function routeTabStyle(isActive: boolean, size: "small" | "regular"): CSSProperties
export function CocoaRouteTabs(props: CocoaRouteTabsProps)
```

<!-- cocoa-22-api:end -->

### 8.3 Fuera del barrel

- **Toast**: `useToast()` de `components/Toast.tsx` → `showToast(message: string, { variant?: "success" | "error" | "info" | "warning", duration?: number })`; el render es `CocoaToast` (§3.9). No hay `CocoaMoney` ni `DeltaChip`: son `CocoaStat` (`suffix`) y `CocoaDelta`.
- **Alojamiento**: `useTabHost(): TabHostInfo | null` (`{ screenKey, basePath, title }`) y `HOSTED_ACTIONS_ROW` de `screens/tabs/TabHost.tsx`; `HostedHead`, `pageHead(embedded?)`, `useRouteParam(pattern, name)`, `treeHeaderFor(screenKey, fallback)` de `screens/tabs/tab-helpers.tsx`.
- **Iconos**: `components/cocoa-icons/{ActionIcons,NavigationIcons,StatusIcons}.tsx` (`PlusIcon`, `SearchIcon`, `TrashIcon`, `CheckCircleIcon`, `ExclamationCircleIcon`, `XCircleIcon`, `SparkleIcon`, …; prop `size`).
- **Copy y formato**: `content/actions.ts` (`ACTIONS`, `STATUS_LABELS`, `FIELD_LABELS`, `A11Y_LABELS`, `newLabel`, `emptyStateFor`, `errorStateFor`, `confirmDelete`, `confirmDiscard`) y `lib/format.ts` (`money`, `number`, `percent`, `date`, `time`, `dateTime`, `dateRange`, `plural`, `relativeTime`, `toNumber`, `EMPTY`).
- **Utilidades CSS** (`styles/cocoa-base.css`): `.cocoa-stack[data-gap="1…6"]` (columna, 4…32 px, por defecto 12), `.cocoa-row[data-gap="1|2|4"][data-align="start|end|baseline"][data-justify="between|end"][data-wrap="nowrap"]` (fila centrada que envuelve), `.cocoa-cluster` (chips, 8 px), `.cocoa-sr-only`, `.cocoa-scroll-x`, `.cocoa-truncate`, `.cocoa-clamp-2`, `.cocoa-tabular`, `.cocoa-caption` (etiqueta CORTA de un grupo: caption 10 px 600 mayúsculas) y `.cocoa-note` (nota en prosa de una sección o un diálogo: callout 12 px secundario sin mayúsculas; nunca un pie de 200 caracteres en `.cocoa-caption`, qa#5 L6); listas `ul/ol.c22-section__list` (hairlines entre `li`, `strong` tabular a la derecha) de `cocoa-22-layout.css`.
- **Legacy fuera del barrel**: `CocoaAlert` y `CocoaFormFieldset` (`components/cocoa-extras`) siguen existiendo pero no se usan en pantallas migradas (→ `CocoaCallout`, `CocoaFormSection`); `CocoaColorWell` queda solo en el showcase (la preferencia de acento está prohibida, §6).
- **Tokens** (`cocoa-tokens.css`, lote css): `--cocoa-background-window: var(--canvas)`, `--cocoa-background-sidebar: var(--surface)`, `--cocoa-label-secondary` claro `.62`, `--cocoa-fs-kpi: 32px` / `-compact: 24px`, `--cocoa-tone-{success,warning,danger,info,neutral,accent,ai}[-text|-bg|-border]`, `--cocoa-density-*` (por `[data-cocoa-density]`), `--cocoa-content-padding` (24 → 16 en < 600; el gutter real: no existe `--cocoa-content-inset`), `--cocoa-scrim`, `--cocoa-z-*`, alias `--cocoa-accent-soft: var(--cocoa-accent-bg)`.

---

## §9 · Contrato automático — `tests/cocoa-22-contract.test.mjs`

Estilo: como `tests/admin-web-no-raw-fetch.test.mjs` (node:test, lectura de ficheros, sin build). Alcance: `apps/admin-web/src/screens/**/*.tsx` (sin `__tests__`) y `components/**` en las reglas de tokens. La lista de pantallas **no migradas** vive en el propio test (`NOT_MIGRATED`, rutas relativas a `screens/`, con techo `ALLOWLIST_CEILING` = 197 el 2026-09-15): migrar una pantalla = borrar su línea y bajar el techo (no existe `cocoa-22-migrated.json`); toda pantalla fuera de la lista debe cumplir las reglas 1–12, y el resto solo se comprueba contra el presupuesto global del inventario (reglas 13 y 15, no puede crecer). Presupuestos de `style=` por pantalla en `STYLE_BUDGET` (sin entrada = 25).

| # | Regla (pantallas migradas) | Detección | Excepciones justificadas |
|---|---|---|---|
| 1 | 0 clases `.bo-*` | `/(?<!-)\bbo-[a-z0-9-]+/` | `bo-sidebar*`/`bo-nav-*` solo en `navigation/` y `layouts/` hasta la ola de shell |
| 2 | 0 `<button>` crudos | `/<button\b/` | ninguna (iconos → `CocoaButton variant="plain" aria-label`) |
| 3 | 0 `<table>` crudas | `/<table\b/` | parrillas envueltas en `CocoaScrollArea` con `data-cocoa-grid-table` (RateGridEditor, RoomRack, LiveTimeline) |
| 4 | 0 `<input>/<select>/<textarea>` crudos | `/<(input|select|textarea)\b[^>]*>/` | `type="file"` y `type="hidden"` (en cualquier sitio) |
| 5 | 0 colores literales | `#hex` (solo en contexto de color en su línea), `rgb()/hsl()`, y `var(--x, #…)` | carpetas `auth/` (gradientes del login, tokenizados en ola 10), `preview/`, `developer/`; pendiente `dev/` (guía de estilo, handoff) |
| 6 | ≤ N `style={` por pantalla, solo layout | N por `STYLE_BUDGET`: 25 (dashboard, y por defecto) · 15 (lista/detalle/form) · 40 (calendario/workspace); dentro de literales `style={{…}}` solo `LAYOUT_PROP` = `display grid* flex* gap rowGap columnGap align* justify* min* max* width height margin* padding* overflow* position inset* top right bottom left order place* boxSizing visibility pointerEvents` | constantes `CSSProperties` (no se inspeccionan; el color literal sigue prohibido por la 5) |
| 7 | Cabecera obligatoria | `<CocoaPage` \| `<CocoaPageHeader` \| `pageHead(` \| `<HostedHead` \| `useTabHost(` | `tabs/**` (contenedores), `*Dialog.tsx`, `*Drawer.tsx`, `ScreenScaffold.tsx`, `ModuleSettingsPlaceholder.tsx` (`HEADER_EXEMPT`) |
| 8 | 0 `<h1>` crudos | `/<h1\b/` | ninguna |
| 9 | 0 `position: "fixed"` / `zIndex` numérico | `/position:\s*["']fixed["']\|zIndex:\s*\d/` en pantallas | componentes `CocoaDrawer`, `CocoaDialog`, `CocoaSheet`, `CocoaToast`, `CocoaPopover`, `CocoaSplitView` (drawer móvil), `CocoaActionBar` (fuera del alcance de la regla) |
| 10 | 0 emoji en JSX | rango `\p{Extended_Pictographic}` | `content/*.ts` de microcopys si los hubiera (hoy ninguno) |
| 11 | 0 `transition: "all"` y 0 `animation … infinite` | regex en pantallas | `CocoaSkeleton` (`cocoa-shimmer`), spinner de `CocoaButton` (componentes, fuera del alcance) |
| 12 | Tokens: `--cocoa-*` referenciados existen | definiciones de `styles/*.css` + `styles.css` vs. usos en pantallas migradas, `components/cocoa` y `components/cocoa-extras` | `var(--cocoa-x, fallback)` se tolera (deuda §7) |
| 13 | Presupuesto global (todas las pantallas) no crece | recalcular con `scripts/cocoa-22-inventory.mjs` y comparar `totals` con el JSON commiteado: `boCard ≤ 941`, `rawButtons ≤ 647`, `rawTables ≤ 159`, `rawInputs ≤ 553`, `colourLiterals ≤ 539`, `inlineStyles ≤ 4607` | se rebajan en cada ola |
| 14 | `CocoaGlobalProvider` no escribe `--cocoa-accent` | grep en `providers/` | — |
| 15 | `docs/design/cocoa-22-inventory.json` está al día | ejecutar el script en memoria (`--stdout`) y comparar `totals` | — (falla si cualquier lote toca pantallas sin regenerar) |
| 16 (propuesta) | §8.2 y §4.3 de este documento al día | `node docs/design/cocoa-22-api.mjs --check` (bloque generado = tipos exportados) y `--typecheck-examples` (plantillas compilan) | — (handoff lote contract: mover el script a `scripts/` y añadir la regla) |

---

## §10 · Plan de migración por olas

> Lista exacta de ficheros por ola y lote, reglas de propiedad exclusiva, criterios de aceptación por pantalla y procedimiento de verificación visual: **`docs/design/COCOA-22-MIGRACION.md`** (integración 2026-09-15; los recuentos de esta tabla son los del inventario original y las cifras vigentes están allí).

Datos del inventario (`scripts/cocoa-22-inventory.mjs --summary`, 2026-09-15): 201 ficheros · 75.420 líneas · **6.009 puntos de deuda** · tamaños S 62 · M 109 · L 27 · XL 3 · con cabecera Cocoa 53 · `useTabHost` 61. Puntos = `bo-card·1 + otras bo-*·0,5 + <button>·1 + <table>·3 + inputs·1 + colores·1 (fallbacks·0,25) + style·0,25 + 5 sin cabecera + emoji·0,5`. Tamaño: S < 20 pts y < 300 líneas · M < 60 / < 800 · L < 150 / < 1500 · XL resto. Referencia de esfuerzo: S ≈ ½ día, M ≈ 1 día, L ≈ 2–3 días, XL ≈ 4–5 días (una persona, con primitivas ya disponibles).

| Ola | Alcance | Pantallas | Líneas | Puntos | Tamaños | Prioridad / razón |
|---|---|---|---|---|---|---|
| 0 | **Cimientos**: tokens (§8), primitivas nuevas, `CocoaTable/Toolbar` ampliados, `Toast/ConfirmDialog` → Cocoa, contrato §9, fix del acento en `CocoaGlobalProvider` | — | — | — | — | Bloquea todo lo demás |
| 1 | **Shell y login** (`layouts/BackOfficeLayout`, `navigation/Sidebar`, `TopBar`, `CommandPalette`, `NarrowViewportBanner`) + `publico` (8 pantallas, 1.719 l, 96 pts: S 7 · M 1) | 8 | 1.719 | 96 | S 7 · M 1 | Se ve en todas las páginas: gutter móvil 16, botones 44×44, z-index tokens, banner `--cocoa-accent-bg` |
| 2 | **Hoy** (canon + hermanos: OperationsDirector L/47, FrontDesk, Owner, NightAudit M/42, AiHumanReviewQueue M/40, ShiftManager M/36) | 10 | 5.360 | 283 | S 1 · M 6 · L 3 | Primera categoría completa = plantilla de dashboard, con el GM sobre `CocoaKpi/Grid/Chart` |
| 3 | **Recepción** (Allotments L/107, LiveTimelineWorkspace L/80, RoomRack L/70, QuickActionsDialogs M/58, ReservationWorkspace, ReservationCreate, Guests…) | 19 | 10.835 | 721 | S 5 · M 8 · L 6 | Mayor uso diario; incluye los 3 arquetipos difíciles (calendario, workspace, wizard) |
| 4 | **Operaciones** (GroupDetailDialog L/92, NewGroupDialog L/79, PosDashboard L/66, RoomingListImportDialog M/57, HK/Maintenance/Purchasing…) | 26 | 10.135 | 987 | S 5 · M 17 · L 4 | Segunda deuda absoluta; muchos diálogos → `CocoaDialog/Drawer` |
| 5 | **Revenue** (RevenueHistoryForecast M/49, RatePlans M/47, CancellationPolicies M/46, RateShopperSettings M/35, RateGridEditor XL/18) | 15 | 6.365 | 390 | S 3 · M 11 · XL 1 | RateGridEditor es limpio (18 pts) pero enorme: solo `CocoaPage fullBleed` + `CocoaActionBar` |
| 6 | **Finanzas** (BillingCenter XL/71, FolioRouting L/60, BankingSpain M/59, Payroll M/55, Folio/Invoice detail) | 21 | 8.584 | 648 | S 4 · M 13 · L 3 · XL 1 | Cifras: `CocoaStat/Money`, tablas con `footer` |
| 7 | **Comercial** (ChannelAggregatorHub XL/137, LoyaltyProgram M/59, ChannelMappings M/53, Surveys M/39…) | 18 | 5.997 | 606 | S 4 · M 13 · XL 1 | ChannelAggregatorHub es la 2.ª pantalla con más deuda |
| 8 | **Cumplimiento** (ComplianceCenter L/148 —máxima deuda—, FiscalDashboard L/68, GuestRegisterSettings L/66, TouristTax L/62, modelos AEAT) | 25 | 6.975 | 812 | S 9 · M 11 · L 5 | Formularios y listas fiscales; 15 pantallas aún con prop `embedded` (TabHost.tsx) |
| 9 | **Informes** (PropertyDetail M/36, RevenueExportCenter M/35, ChannelPerformance M/30, RoomProfitability M/28) | 9 | 2.548 | 218 | S 2 · M 7 | Rápida: dashboards + tablas |
| 10 | **Configuración** (AiGovernance L/121, AiPipelineStatus L/61, OnboardingInteractive L/60, Notifications M/56, ModuleManager, Setup, wizards) | 42 | 14.370 | 1.179 | S 17 · M 20 · L 5 | Mayor volumen; mayoritariamente formularios → rendimiento alto de `CocoaField/FormSection` |
| 11 | **Compartido / desarrollo** (`ScreenScaffold`, `ModuleSettingsPlaceholder`, `NavItemTabs`/helpers, showcase y galería) + limpieza: borrar las 276 reglas `.bo-*` de `styles.css`, `components/v2/*`, `FormComponents` legacy, `mobile.css .gm-grid` | 8 | 2.532 | 69 | S 5 · M 2 · L 1 | Cierre: `styles.css` queda con Aurora tokens + shell; presupuesto §9 a 0 |

Orden de trabajo dentro de cada ola: (1) pantalla con más puntos primero (arrastra la mayor parte de patrones), (2) diálogos/drawers de la categoría, (3) borrar la pantalla de `NOT_MIGRATED` (y bajar `ALLOWLIST_CEILING`; entrada en `STYLE_BUDGET` si no es dashboard) en `tests/cocoa-22-contract.test.mjs`, (4) `corepack pnpm --filter @hotelos/admin-web typecheck` + `corepack pnpm test` + `node scripts/cocoa-22-inventory.mjs` (commit del JSON) + `node scripts/check-discoverability.mjs`, (5) revisión visual a 1440/1024/390 en claro y oscuro con el checklist de §3–§5.

Definición de «hecho» por pantalla: cumple §9 · misma URL y pestaña · mismos datos/acciones · estados carga/vacío/error/degradado presentes · AA medido en textos secundarios · sin scroll horizontal en 390 salvo `CocoaScrollArea` · skeleton espejo · foco y teclado verificados.

---

## §11 · Guía de estilo (`/desarrollo/guia-estilo`)

Pantalla viva de referencia, **solo en modo desarrollo** (`?dev=1` o `localStorage["anfitorio.dev"]="1"`, administrador de plataforma; guard único `isDevRouteAllowed`): `apps/admin-web/src/screens/dev/StyleGuideScreen.tsx`, clave `StyleGuideScreen`, fila dev-only «Guía de estilo Cocoa 22» de `pilots/tanda5-nav-tree.csv` (padre `AuditLogViewer`, no es placeholder: no consume presupuesto de `makeModulePlaceholder`). URL local: http://localhost:5173/desarrollo/guia-estilo?dev=1 · en el menú aparece en el grupo «Desarrollo».

| Bloque | Qué muestra |
|---|---|
| Página | La propia pantalla es el primer `CocoaPage` (eyebrow · h1 · subtítulo · acciones · densidad · comandos en ⌘K); selector de tema (Sistema / Claro / Oscuro) y de densidad (Cómoda / Compacta) en la fila de acciones. |
| Tokens · Color | Tabla por grupos (superficies, texto, separadores, acento, 7 tonos × base/-text/-bg/-border, gráficos) con muestra y valor **declarado en claro y en oscuro** (leídos en tiempo de ejecución del CSSOM de `cocoa-tokens.css`) y el valor pintado ahora; sin un solo literal de color en el fichero. |
| Tokens · Tipografía, espacio, radios, shell, sombras, motion, capas | Escala completa renderizada con sus tokens (`--cocoa-fs-*`, `--cocoa-lh-*`, pesos, tracking), barras de `--cocoa-space-1…8`, radios 4/8/12/full, métricas del shell, las 7 sombras, tokens de duración/curvas con «Reproducir entrada» (stagger) y la escala `--cocoa-z-*`. |
| Botones | 4 variantes × 3 tonos × 3 tamaños; icono, carga, deshabilitado, solo icono con `aria-label`, `CocoaKbd`. |
| Campos y formulario | `CocoaField` con ayuda / error / hint / inline / fullWidth; `CocoaInput` (tamaños, icono, rightSlot, readOnly, disabled, multiline), `CocoaSelect`, `CocoaSwitch`, `CocoaDatePicker`, `CocoaStepper`, `CocoaSearchInput`, `CocoaSegmentedControl`; arquetipo formulario con `CocoaFormSection` + `CocoaFormRow` + validación + `CocoaActionBar` (Ctrl/⌘ + Enter). |
| Badges y avisos | 7 tonos × outline / tinted / dot × 2 tamaños; `CocoaCallout` inline por tono y variante banner con acciones. |
| KPI | `CocoaKpiStrip` (regular y compacta), `CocoaKpi` ok / warning / critical / sin estado / degradado / con icono y clic, `CocoaDelta` por polaridad, `CocoaStat` (sufijo, tono, alineación, texto), `DegradedValue` / `DegradedNote` / `DegradedBanner`. |
| Tarjetas, secciones, rejilla | `CocoaCard` bordered / elevated interactiva / plain; `CocoaSection` con meta, acción, pie y scroll vertical; `CocoaGrid` con las filas canónicas 8/2/2 · 4/4/2/2 · 3×4 · 5/4/3 (indica el escalón de viewport activo) y `CocoaSkeleton.Grid` espejo. |
| Tablas | `CocoaTable` con ordenación, numéricos tabulares, totales, acciones por fila, selección que abre un `CocoaDrawer`, carga, tabla vacía con `CocoaState inline`, y parrilla ancha en `CocoaScrollArea axis="x" stickyFirstColumn`; en < 600 px se apila en tarjetas. |
| Pestañas y barra | `CocoaSegmentedControl` (regular, small, fullWidth) y `CocoaToolbar variant="content"` con búsqueda, select, segmented y exportar; `CocoaRouteTabs` documentado en el código de ejemplo (no se monta: cambiaría la URL). |
| Capas | `CocoaDrawer` (lado y tamaño elegibles; en teléfono siempre abajo), `CocoaDialog` (confirmación, destructivo, solo aceptar, con `busy`), `CocoaSheet`, `CocoaPopover`. |
| Toast y live region | `useToast` (éxito / informativo / aviso / error) y `CocoaLiveRegion`. |
| Estados | `CocoaState` vacío (box / search / connection), error con reintento, degradado, carga, inline y caja punteada; `CocoaSkeleton` en sus 8 variantes + `Strip`. |
| Gráficos | `CocoaChart.Line` (OTB / previsión / año anterior con tooltip y leyenda), `Bars`, `Gauge` (3 umbrales), `Donut`, `Sparkline` por tono y `Progress`. |
| Checklist de migración | Las 15 reglas del contrato (§9) y los 9 puntos de la definición de «hecho» (§10) como tabla con interruptores y barra de progreso (estado local, no persiste), más las puertas de cada ola. |

Cada bloque lleva su JSX de ejemplo con botón «Copiar». Todo es estado local (sin peticiones); los textos visibles van en español y cumplen `tests/admin-web-spanish-copy-contract.test.mjs`. Cuando una primitiva cambie de API, esta pantalla debe romper el typecheck antes que cualquier pantalla migrada: es la primera consumidora de cada prop.
