# Anfitorio · Playbook premium de look & feel (2026-06)

Síntesis de la auditoría multi-agente de dirección de arte (19 agentes: 12 lentes
+ 3 referencias Stripe/Mercury·Linear/Vercel·Ramp/Qonto + 3 revisores adversariales
+ 1 director creativo). Principio rector: **premium = restricción**, todo sobre los
tokens existentes (acento Esmeralda único #0d8a5f).

## Diagnóstico (promedio ~4.8/10)

| Lente | Hoy |
|---|---|
| Profundidad / elevación | 4 |
| Datos / dinero / KPIs | 4 |
| Estados carga/vacío/error | 4 |
| Iconografía | 4 |
| Movimiento / microinteracciones | 5 |
| Tipografía / ritmo | 5 |
| Espaciado / densidad | 5 |
| Chrome (sidebar/topbar) | 5 |
| Dark mode | 5 |
| Perf del polish | 5 |
| Componentes core | 6 |
| Color / luz | 6 |

5 raíces: motion muerto (cocoa-motion.css sin importar) · Inter no carga · foco
bifurcado (azul Apple vs Esmeralda) · cards planas (elevated usa sombra de control)
· cifras sin tabular-nums + Billing en formato anglosajón.

## Aplicado (commit a906feb)

**Cohesión de marca + bugs rotos**
- Foco único Esmeralda (`--cocoa-focus-ring` ← `--accent`, ×3 bloques).
- Login a monocromo Esmeralda (4 gradientes).
- `--cocoa-shadow-floating` definido (era referencia muerta), anillo neutro.
- Shimmer invertido corregido (centro más claro) + 1.1s.
- Sombras navy hardcodeadas → `var(--shadow-*)` (property-menu, HK board, user menu).
- Logo "H" → "A".

**Profundidad**
- `--cocoa-shadow-card` + remapeo `CocoaCard` elevated/bordered; hover lift -2px.
- Anillos dark = blanco translúcido (no negro sobre-opaco).
- `CocoaTable` thead sticky con sombra sutil (sin blur); fila seleccionada suave
  (15% + barra inset) en vez de acento 100%.
- Press físico `scale(0.97)` en `CocoaButton` (compositor) con guarda reduced-motion.

**Alma fintech (cifras)**
- `tabular-nums + lining-nums` en KPIs de recepción y columnas numéricas de `CocoaTable`.
- BillingCenter en es-ES (`272,00 €`) vía `fmtMoney`/`fmtEur`.
- Pills de estado a tokens (info: azul → Esmeralda).

**Motion**
- `cocoa-motion.css` importado (keyframes ahora en el bundle).
- `.cocoa-enter` / `.cocoa-stagger` (GPU-only, reduced-motion safe) en rejillas de KPIs.

## Descartado por los revisores (NO implementar)
Blur en thead de tablas de datos · halo de acento en el FAB · shimmer teñido de
verde · subir `--cocoa-fs-large-title` global (CLS) · sombra fija de 3 capas en
topbar · pulse infinito sin restricción férrea · triple box-shadow en botón filled.

## Pendiente (roadmap)

**Fase 3 — deuda estructural** (necesita `pnpm install`)
- Instalar `@fontsource-variable/inter` + import en main.tsx (hoy Inter no carga →
  faux-bold). Bajar los `font-weight:900` a 700/800.
- Alinear escalas duales Aurora↔Cocoa (`--space-5/6`, `--fs-body`).
- Calentar backgrounds Cocoa dark (+7/+10 R-B) para cerrar el "cold seam" con Aurora.
- `--ink-muted` light → #676560 (warmth, AA mejor) — verificar sobre las 3 superficies.

**Fase 4 — sistema de componentes**
- `CocoaMoneyAmount` (entero/decimales/símbolo jerárquicos) + `DeltaChip` con
  polaridad semántica.
- Unificar las 3 APIs de iconos; desemojificar 52 ficheros (✨→SparkleIcon existente).
- Conectar las 5 cocoa-illustrations al EmptyState legacy (sube 75 pantallas).
- Logomark SVG de Anfitorio definitivo.
- `transition: all` → propiedades explícitas (12 sitios, perf).
- `content-visibility:auto` en tablas >50 filas (con @supports + intrinsic-size medido).
- `CocoaButton size="small"` 22px → 24px (WCAG 2.5.8).

## Notas técnicas (de los revisores)
- `color-mix` requiere Safari 16.2+. cocoa-tokens.css ya lo usa; si hay iPads de
  recepción en Safari 15.x, definir tokens derivados resueltos con `@supports`.
- Cualquier cambio que suba un fondo dark BAJA el contraste del texto encima →
  re-verificar `ink-muted`/`label-secondary` con números, no a ojo.
- Antes de migrar el hover de `CocoaTable` a CSS `:hover`: confirmar que ninguna
  lógica de negocio dependa de `hoverKey` (hoy no).
