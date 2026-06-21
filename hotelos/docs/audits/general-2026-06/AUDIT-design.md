# Auditoría de Diseño Visual — Cocoa Edition

**Fecha:** 2026-06-21
**Alcance:** `apps/admin-web/src` — `styles/cocoa-*.css` + `components/cocoa*` (58 componentes reales exportados, 10 directorios)
**Auditor:** revisión estática de tokens + componentes representativos (Button, Input, Card, Table, Select, Switch, SegmentedControl, PageHeader, Tooltip, DirectorKpiTile, StatusBadge v2)

---

## Resumen ejecutivo

El núcleo del sistema (`components/cocoa/` + `cocoa-tokens.css`) es **bueno y maduro**: tokens bien estructurados, namespace `--cocoa-*` limpio, ~92% de adopción de tokens (1631 referencias `var(--cocoa-*)` vs 147 literales), escala tipográfica fiel a la macOS HIG, soporte dark explícito + `prefers-color-scheme`, `prefers-reduced-motion`, fallback de `backdrop-filter`, y atención real a a11y (roles ARIA, `aria-sort`, focus de teclado, `aria-describedby` en Tooltip). En aislamiento, los 16 componentes base se sienten nativos de macOS Sequoia y compiten dignamente con un SaaS B2B moderno.

El problema **no es el núcleo, es la coherencia del conjunto.** Conviven **dos sistemas de diseño con paletas irreconciliables**: el Cocoa "frío" (gris + azul Apple `#0064E1`) y un sistema "cálido" tipo *cocoa-brown* (`#e8e5dd`, `#fdf2dc`, `#f0eee8`, `#6a6a6a`) que vive en `components/v2/` y se ha **filtrado** a componentes con namespace Cocoa (`DirectorVipList`, `Toast`). Ese segundo sistema usa además un namespace de tokens totalmente distinto (`--ok-bg`, `--fs-xs`, `--radius-full`) que **no existe** en `cocoa-tokens.css`, por lo que sus fallbacks marrones son lo que realmente se renderiza. El resultado: la identidad "premium macOS nativo" se cumple pantalla a pantalla pero **se rompe al cruzar módulos**.

A esto se suman tres ejes de *drift* internos: tres definiciones distintas del focus ring, dos azules de acento (`#0064E1` token vs `#007AFF` hardcodeado en tints), y una capa de motion (`cocoa-motion.css` + `lib/cocoa-motion.ts`) huérfana y con curvas que no coinciden con los tokens.

**El veredicto:** arquitectura de tokens de nivel A-, ejecución del sistema completo de nivel C+. Es recuperable con trabajo de consolidación, no de rediseño.

---

## 10 hallazgos priorizados

### P0 — Críticos (rompen la coherencia visual)

**1. Dos design systems con paletas en conflicto (frío vs cálido).**
`components/v2/` (8 componentes: `StatusBadge`, `DataTable`, `PageHeader`, `SearchInput`, `SegmentedControl`, `StatTile`, `Tooltip`, `Avatar`) usa una paleta cálida marrón (`#e8e5dd`, `#fdf2dc`, `#f0eee8`, `#d8d4ca`, `#6a6a6a`, `#1a1a1a`) que **no aparece en `cocoa-tokens.css`** (gris frío + azul). Peor: esa paleta contamina componentes con marca Cocoa — `DirectorVipList.tsx` (42 literales hardcodeados) y `Toast.tsx`. Un usuario que pase de una pantalla Cocoa a una con badge v2 ve dos productos distintos. *Acción:* migrar v2 → tokens Cocoa o eliminarlo; purgar la paleta cálida de `cocoa-director` y `Toast`.

**2. `StatusBadge`/`v2` referencian un namespace de tokens inexistente.**
`v2/StatusBadge.tsx` usa `var(--ok-bg, #e3f4eb)`, `var(--fs-xs, 11px)`, `var(--radius-full, 999px)`. Esas variables `--ok-*`, `--fs-*`, `--radius-*` **no están definidas** en ningún token Cocoa, así que SIEMPRE cae al fallback hardcodeado. Es un sistema de tokens fantasma. *Acción:* reescribir contra `--cocoa-*` reales.

**3. No existen surfaces de estado (success/warning/danger) suaves en tokens.**
Hay 0 tokens tipo `--cocoa-success-bg` / `-border`. Cada badge, alert y pill **inventa su propio par bg/fg/border** (de ahí los `#e3f4eb`/`#0a6b46`, `#fdf2dc`/`#8a4a09` repartidos por el código). Es la causa raíz de #1 y #2. *Acción:* añadir 4 estados × {bg, fg, border} × {light, dark} = 24 tokens; es la pieza que falta más rentable del sistema.

### P1 — Altos (inconsistencia perceptible + a11y)

**4. Tres definiciones distintas del focus ring.**
- Token: `--cocoa-focus-ring: rgb(0 100 225 / 0.50)` (light)
- `cocoa-base.css .cocoa-focus-ring`: `rgba(0,122,255,0.4)` — **otro azul (#007AFF) y otra alfa**
- `CocoaInput.tsx`: `0 0 0 3px rgb(0 100 225 / 0.40)` hardcodeado — tercera alfa
La clase utilitaria global (la que más se usa vía `cocoa-focus-ring`) ni siquiera consume el token. Los anillos no coinciden entre Button, Input y Select. *Acción:* unificar `box-shadow: 0 0 0 3px var(--cocoa-focus-ring)` en un solo sitio.

**5. Dos azules de acento conviviendo.**
`--cocoa-accent = #0064E1`, pero los `tintedBg` de `CocoaButton` usan `rgba(0,122,255,0.15)` (#007AFF) y `--cocoa-info` también es `#007AFF`. Un botón *tinted* y un botón *filled* del mismo `tone="accent"` no comparten matiz. *Acción:* derivar tints con `color-mix(in srgb, var(--cocoa-accent) 15%, transparent)`.

**6. Estados hover/zebra hardcodeados en negro → rotos en dark mode.**
`CocoaTable` usa zebra `rgba(0,0,0,0.02)` y hover `rgba(0,100,225,0.05)`; `CocoaButton` tint neutral `rgba(0,0,0,0.06)`. En dark, "negro sobre negro" es invisible y el hover azul no se adapta. Son los únicos componentes core que rompen la promesa de paridad light/dark. *Acción:* tokenizar (`--cocoa-fill-hover`, `--cocoa-row-stripe`) con valores por tema.

**7. Touch targets por debajo del mínimo accesible.**
Button `small=22 / regular=28 / large=32px`; Select `22/28/34px`; Switch small track `20px`. Fiel a la HIG de escritorio, pero por debajo de los 44px (WCAG 2.5.5 / pointer) e incluso de 24px (WCAG 2.2 AA 2.5.8). En un PMS usado en tablets de recepción esto duele. *Acción:* o subir a `regular=28` como mínimo clicable con hit-area invisible de 44px, o documentar explícitamente que es "desktop-only, mouse-first".

### P2 — Medios (deuda, drift, claims)

**8. Capa de motion huérfana y con curvas duplicadas.**
`styles/cocoa-motion.css` (keyframes `cocoa-fade-in`, `cocoa-scale-in`, `cocoa-slide-*`) **no se importa en ningún sitio** (`styles.css` solo trae tokens + base). Además `lib/cocoa-motion.ts` define un **cuarto set** de easings (`cubic-bezier(0.32,0.72,0,1)`, etc.) que no coincide con `--cocoa-ease-*` de los tokens, y `cocoa-base.css` ya duplica el bloque `prefers-reduced-motion`. Tres fuentes de verdad para el movimiento. *Acción:* importar el CSS o borrarlo; alinear `cocoa-motion.ts` con los tokens.

**9. La cuenta de "64 componentes" está inflada y mezcla capas.**
El recuento real de componentes exportados (`Cocoa*`/`Director*`, sin `index.ts` ni tipos) es **58**, y eso incluye 11 widgets de dashboard muy específicos de Director y depende de contar los 36 SF-icons. Sumar `v2/` (legacy, según CLAUDE.md) para llegar a 64 mezcla el DS oficial con lo que está en transición. No es factorización limpia: hay `CocoaSegmentedControl` + `v2/SegmentedControl`, `CocoaSearchInput` + `v2/SearchInput`, `CocoaPageHeader` + `v2/PageHeader`, `CocoaTable` + `v2/DataTable`, `CocoaTooltip` + `v2/Tooltip` — **5 pares redundantes**. *Acción:* declarar v2 deprecated con fecha y un único API público.

**10. Escala tipográfica y de spacing con colisiones/huecos no documentados.**
Tipografía: 10 tamaños nombrados → solo **7 valores distintos** (`headline=body=13px`, `subheadline=footnote=11px`). Útil para fidelidad HIG, pero crea ambigüedad ("¿uso headline o body?") sin guía. Spacing: la escala (4·8·12·16·24·32·48·64) **no es 4/8/16 puro** — salta 16→24 (sin 20) y 32→48 (sin 40), lo que ya obliga a literales `gap: 6`, `padding: 9` en componentes (ej. `DirectorKpiTile`). Menor, pero genera magic numbers. *Acción:* documentar la intención de cada tamaño y añadir step-5 (20) si se necesita densidad media.

---

## Evaluación por dimensión

| Dimensión | Nota | Notas |
|---|---|---|
| **Tokens — color** | B− | Buen sistema base Apple; pero 2 azules de acento, sin surfaces de estado, focus ring divergente. |
| **Tokens — spacing** | B+ | Escala 4pt sólida; huecos 20/40 generan algún magic number. |
| **Tokens — radius** | A | 4/8/12/16/full, coherente y bien usado. |
| **Tokens — shadows** | A | Modelo "ambient + edge ring", multiplicador dark ~3-4×: excelente, muy macOS. |
| **Tokens — tipografía** | A− | Fiel a HIG (SF Pro Text/Display/Mono/Rounded, tnum, tracking). Colisiones de tamaño sin doc. |
| **Light/Dark** | B | Dark explícito + OS-pref bien hechos; rotos por hardcodes negros en Table/Button y stub vacío en base.css. |
| **Coherencia de librería** | C | Núcleo coherente; v2 + paleta cálida + 5 pares redundantes lo hunden. |
| **Jerarquía visual** | A− | `PageHeader` (eyebrow/title/subtitle/tabs), KPI tiles con tabular-nums, densidad NSTableView: muy buena. |
| **Identidad (premium/macOS)** | B | Convincente por pantalla; se quiebra al cruzar módulos por la paleta cálida intrusa. |
| **Accesibilidad visual** | B− | ARIA y focus de teclado serios; falla touch targets y contraste dark en estados hardcodeados. |
| **vs Linear/Stripe/Notion** | B− | Tokens y tipografía a la altura; la fragmentación en 2 sistemas sería impensable en esos productos. |

---

## Comparación con el estándar SaaS B2B moderno

- **Stripe / Linear / Notion** tienen **una** fuente de verdad de color y **surfaces de estado tokenizadas** (`--bg-success-subtle`, etc.). Cocoa tiene la arquitectura para ello pero le falta esa capa (#3) y ha permitido un segundo sistema (#1).
- En **densidad, tipografía con tabular-nums y materiales (vibrancy/blur)**, Cocoa iguala o supera a Notion y se acerca al refinamiento de Linear.
- El **focus ring fragmentado (#4)** y los **hardcodes dark-unsafe (#6)** no pasarían un design review en ninguno de los tres.
- Veredicto comparativo: **el núcleo Cocoa juega en la liga**; el *sistema completo* todavía no, por falta de gobierno de tokens.

---

## Recomendación de remediación (orden de impacto)

1. Añadir tokens de **surfaces de estado** (24 vars) — desbloquea #1/#2/#3.
2. Unificar **focus ring** en un único token/clase — #4.
3. Migrar `v2/` y purgar paleta cálida de `cocoa-director`/`Toast` — #1.
4. Tokenizar **hover/zebra/tint** por tema — #6.
5. Derivar tints del acento con `color-mix` — #5.
6. Decidir motion: importar o borrar `cocoa-motion.css`; alinear easings — #8.
7. Doc de escala (tipografía/spacing) + deprecación formal de v2 — #9/#10.

---

## Score de calidad visual

# **72 / 100**

**Desglose:** Tokens/fundamentos 82 · Componentes núcleo 85 · Coherencia del sistema completo 55 · Identidad macOS 78 · Accesibilidad visual 70.

> Un núcleo de design system de calidad alta (≈85) penalizado ~13 puntos por **fragmentación en dos sistemas de color** y *drift* (focus ring, acento, motion). No es un problema de gusto ni de rediseño: es **gobierno de tokens y limpieza de legacy**. Cerrando los 6 P0/P1 el sistema subiría con realismo a 86-90.
