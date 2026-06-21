# Revisión adversarial — AUDIT-design.md

**Fecha:** 2026-06-21 · **Revisor:** design director escéptico (segunda pasada)
**Método:** lectura del informe + verificación directa de `styles/cocoa-*.css`, `styles.css`, `cocoa/`, `cocoa-director/`, `v2/`, `lib/cocoa-motion.ts` y conteo de uso en `screens/`.

## Veredicto en una línea

El informe primario es **técnicamente sólido en lo micro pero estructuralmente equivocado en su tesis central**. Acierta en casi todos los hallazgos de drift (focus ring, acento, hardcodes dark), pero su P0 #2 es **falso** y su narrativa "Cocoa es el sistema, lo cálido es legacy intruso" está **invertida respecto a la realidad del producto**.

---

## CONFIRMADOS (el primario tenía razón)

- **#4 Tres focus rings.** Verificado literal: token `rgb(0 100 225 / 0.50)`; `cocoa-base.css:33` `rgba(0,122,255,0.4)`; `CocoaInput.tsx:113` `rgb(0 100 225 / 0.40)`. La clase global `.cocoa-focus-ring` (la que usan Button y KpiTile) **no consume el token**. Real y feo.
- **#5 Dos azules.** `--cocoa-accent #0064E1` vs `CocoaButton.tsx:72` `tintedBg: rgba(0,122,255,0.15)` (#007AFF) y `--cocoa-info #007AFF`. Un *filled* y un *tinted* `accent` no comparten matiz. Confirmado.
- **#6 Hardcodes negros dark-unsafe.** `CocoaTable.tsx:219` zebra `rgba(0,0,0,0.02)`, `:222` hover `rgba(0,100,225,0.05)`, `CocoaButton.tsx:79` `rgba(0,0,0,0.06)`. Sobre `#1E1E1E` el zebra es invisible. El componente que se vende como "theme parity light/dark" rompe esa promesa. Confirmado.
- **#3 No hay surfaces de estado en tokens Cocoa.** Cero `--cocoa-success-bg/-border`. Los 186 tokens `--cocoa-*` no incluyen estados suaves. Causa raíz real.
- **#7 Touch targets.** Button 22/28/32, Select 22/28/34, Switch 20. Por debajo de 24/44px. Confirmado (matiz abajo).
- **#8 Motion huérfano.** `cocoa-motion.css` solo se referencia a sí mismo y desde el comentario de `lib/cocoa-motion.ts`; **no se importa en `styles.css` ni `App.tsx`**. Y `cocoa-motion.ts:19-24` define un cuarto set de easings (`cubic-bezier(0.32,0.72,0,1)`…) que no coincide con `--cocoa-ease-*`. Confirmado.
- **#9 "64" inflado / 5 pares redundantes.** Conteo real exportado = **58** (confirmado), y existen los pares `Cocoa{SegmentedControl,SearchInput,PageHeader,Table,Tooltip}` ↔ `v2/{…}`. La cifra de 64 de CLAUDE.md está inflada. Confirmado.
- **#10 Magic numbers de spacing.** `DirectorKpiTile.tsx` usa `gap:6`, `paddingLeft:9`. Reales, aunque triviales y justificados (compensación de `border-left`).

## REFUTADOS (el primario se equivocó)

- **#2 "v2 referencia un namespace de tokens inexistente / SIEMPRE cae al fallback" — FALSO.** `--ok-bg`, `--warn-bg`, `--danger-bg`, `--info-bg`, `--neutral-bg`, `--ai`, `--ai-soft`, `--fs-xs`, `--fs-sm`, `--radius-full`, `--space-*` **están todos definidos en `styles.css`** (líneas 36-103), cada color con variante light **+ dos bloques dark**. No son fantasma: resuelven y **tematizan en dark**. El primario auditó `cocoa-tokens.css` en aislamiento e ignoró el stylesheet global. Este es el error más grave del informe: invalida medio P0.
- **Tesis "Cocoa es el sistema; lo cálido es legacy filtrado" — INVERTIDA.** `styles.css` se titula *"HotelOS Aurora — Design System v2 (2026)"*, lo importa `App.tsx:23` a nivel global, y **él** importa a Cocoa (`@import cocoa-tokens; @import cocoa-base`), no al revés. Uso real: **156/202 screens** usan clases Aurora `.bo-*`; solo **27/202** importan `components/cocoa/`. La identidad de facto del producto es **Aurora cálida emerald**, no Cocoa frío. La paleta cálida no "se filtró" a Cocoa: es el host. El primario tomó al inquilino por dueño.
- **"92% adopción de tokens" — número no reproducible.** Mi conteo en los dirs `cocoa*`: 1892 refs `var(--cocoa-*)` vs 103 literales hex (~94.8%), no 1631/147. La conclusión (adopción alta) se sostiene; las cifras citadas no.

## OMITIDOS (lo que el primario no vio)

- **Bug real en `DirectorVipList.tsx`: colisión token-vs-intención.** Líneas 38, 49, 257 usan `var(--cocoa-accent, #6d4ed1)` y `var(--ai, #6d4ed1)` esperando **morado**, pero `--cocoa-accent` **existe** y resuelve a `#0064E1` (azul Apple) → el badge VIP y el link "Ver todos" se renderizan azules, no morados. Simultáneamente sus fills usan `var(--cocoa-fill-quaternary, #f0eee8)` / `--cocoa-fill-tertiary` que **NO existen** (confirmado: ningún `--cocoa-fill-*` definido) → caen a cálido `#f0eee8`. El mismo componente mezcla *token frío que gana* + *fallback cálido que gana*: incoherencia **intra-componente**, peor que la inter-módulo que describe el informe. El primario lo contó como "42 literales" sin detectar el mecanismo.
- **El primario elogia y critica a la vez a `DirectorKpiTile` sin notar que es el contraejemplo modélico:** usa `--cocoa-success/warning/danger` reales (cero cálido) y **sí** fuerza `minHeight:44` (línea 176) — o sea, su propio hallazgo #7 no aplica aquí. Demuestra que el patrón correcto ya existe en el repo; el problema es de gobierno, no de capacidad.
- **`--cocoa-info #007AFF` ≠ `--cocoa-accent #0064E1` es un tercer punto del mismo defecto #5**, no señalado como tal: el sistema tiene dos "azules de sistema" oficiales en tokens, antes incluso de los hardcodes.
- **`cocoa-base.css:40-44` tiene un bloque dark vacío con comentario "duplica el bloque dark o usa cascade"** — stub muerto en producción. El informe lo menciona de pasada ("stub vacío") pero no lo lista como hallazgo.

## ¿Alcanza el nivel "premium" que el informe sugiere?

**Por pantalla aislada, sí; como producto, no — y por una razón distinta a la del informe.** El núcleo Cocoa (Button, Table, Input, KpiTile, tokens, sombras, tipografía HIG) es genuinamente de alta calidad: 186 tokens, sombras ambient+ring, `tnum`, dark explícito, a11y seria. Eso es real y el informe no exagera ahí.

Pero el usuario real pasa el 77% del tiempo en pantallas **Aurora**, no Cocoa. El "premium macOS nativo" describe 27 pantallas; las otras 156 son un SaaS cálido competente pero distinto. La pregunta no es "¿se rompe Cocoa al cruzar módulos?" sino "¿por qué hay un design system Apple-frío de 58 componentes encima de un Aurora-cálido que cubre 6× más superficie?". El informe nunca formula esa pregunta porque no miró `styles.css`.

## ¿Escala el design system?

**El de tokens, sí; la gobernanza, no.** Arquitectura `--cocoa-*` con namespace limpio, light/dark/reduced-motion/fallback: escala bien. Pero coexisten **dos escalas tipográficas** (`--cocoa-fs-*` vs `--fs-*`), **dos de spacing** (`--cocoa-space-*` 4·8·12·16·24·32 vs `--space-*` con 20/40/80), **dos de radius**, **dos focus rings de sistema** (`--cocoa-focus-ring` vs `--focus`), **dos paletas de acento** (azul vs emerald). Un dev nuevo no tiene forma de saber cuál usar. Eso no escala: multiplica la superficie de error con cada pantalla nueva (ver `DirectorVipList`, que ya cayó).

## Ajuste de score

El primario da **72/100**. Su desglose es razonable pero parte de un mapa equivocado del territorio (Cocoa=sistema). Reencuadrado a "calidad visual del producto tal como se renderiza":

- Núcleo Cocoa aislado: **85** (de acuerdo).
- Fundamentos de token: **80** (de acuerdo; −puntos por #2 mal diagnosticado pero el defecto real —dos sistemas de tokens paralelos— es peor de lo que el informe creyó).
- Coherencia del producto completo: **48** (más bajo que su 55: no es "Cocoa con intrusiones", son dos DS completos de igual peso sin puente, y el dominante ni se auditó).
- Identidad: **70**.
- A11y: **70** (de acuerdo).

### Veredicto: **68 / 100**

Cuatro puntos por debajo del primario, no por más defectos sino porque el defecto estructural es mayor del diagnosticado: **no es un núcleo premium con leaks de legacy, son dos design systems de primera clase (Aurora cálido / Cocoa frío) conviviendo sin gobierno, y la auditoría original solo miró uno de los dos.** La remediación correcta no es "migrar v2 a Cocoa" (#1/#3 del plan), sino una **decisión de dirección**: declarar Aurora **o** Cocoa como canónico y migrar el otro. Cerrar focus-ring, acento y hardcodes (todos confirmados) sube la nota; pero sin resolver qué sistema gana, el techo realista es ~80, no los 86-90 que promete el informe.

## Calidad del informe primario

Buen trabajo forense de componentes; **fallo de alcance**: auditó `cocoa-tokens.css` sin leer `styles.css`, el stylesheet que `App.tsx` carga globalmente. Eso produjo un falso positivo P0 (#2) y una tesis invertida. Recomendación: re-emitir con Aurora dentro del alcance.
