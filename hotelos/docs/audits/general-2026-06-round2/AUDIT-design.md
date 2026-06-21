# Auditoría de Diseño Visual · Ronda 2 (2026-06-21)

Ámbito: `apps/admin-web/src` (design system, tokens, focus ring, coherencia Aurora vs
Cocoa, dark mode, a11y visual). Verifica el estado real tras la ronda de remediación
de `docs/audits/general-2026-06/`. Foco solicitado: fixes **#10** (tokens de estado +
focus ring único + tints dark-safe) y **#15** (brief de decisión DS + script ds-drift).

## Resumen

La ronda de remediación de tokens es **real y de buena calidad** donde se aplicó. El
fichero `styles/cocoa-tokens.css` ahora define superficies de estado themeable
(`--cocoa-success-bg`, `--cocoa-warning-bg`, `--cocoa-danger-bg`, `--cocoa-info-bg`,
`--cocoa-accent-bg`) vía `color-mix`, con bloques dark explícitos (`data-theme`),
dark por preferencia de OS, `prefers-reduced-motion` y fallback sin `backdrop-filter`.
`CocoaButton`, `CocoaTable` e `CocoaInput` se reescribieron para derivar sus tints de
tokens en vez de `rgba()` literales invisibles sobre `#1E1E1E`; los comentarios
`audit 2026-06` documentan cada cambio. El brief de decisión existe
(`docs/design-system/DESIGN-SYSTEM-DECISION.md`) y el script `scripts/check-design-system-drift.mjs`
corre y produce métricas reales.

Dicho esto, **el fix #10 se cumple solo dentro del universo Cocoa, no a nivel de
producto**, y el fix #15 está documentado pero **inacabado en su ejecución**:

- El focus ring **NO es único**: coexisten dos anillos con colores distintos —
  Cocoa azul (`--cocoa-focus-ring`) y Aurora esmeralda (`--focus`). "Único" es cierto
  *intra-Cocoa*; falso a nivel de app. Además hay 2 componentes Cocoa que suprimen el
  outline **sin** anillo de reemplazo (regresión a11y real).
- Los **tokens de estado están infrautilizados**: solo 1 componente
  (`CocoaButton`) consume los `--cocoa-*-bg` nombrados; el resto re-deriva su propio
  `color-mix` inline, así que el "single source of truth" todavía no centraliza.
- La **decisión Aurora/Cocoa está documentada pero sin aplicar ni siquiera marcada**:
  el doc sigue en "Decision pending", el gate `--enforce` no está cableado a
  pre-commit ni CI, y el drift sigue creciendo (16 pantallas mezclan ambos sistemas).

Confirmación de los fixes pedidos: **#10 → PARCIAL** (tokens y tints sí; focus ring
único no). **#15 → PARCIAL** (brief y script sí; decisión no tomada, gate report-only).

Score: **62 / 100** (subida real respecto al techo ~48 del statu quo, pero lejos de
coherente).

## Hallazgos

### H1 · Focus ring NO es único a nivel de producto (severidad: alta)
Conviven dos anillos con color y forma distintos:
- Cocoa: `--cocoa-focus-ring: rgb(0 100 225 / 0.50)` (light) / `rgb(10 132 255 / 0.60)` (dark), consumido vía `.cocoa-focus-ring:focus-visible` con `box-shadow: 0 0 0 3px …`.
- Aurora: `--focus: 0 0 0 3px rgba(13,138,95,0.18)` (light) / `rgba(43,179,127,0.32)` (dark) en `styles.css:1089,1301,1355`.
- Stray adicional: `styles.css:627` usa `outline: 2px solid var(--accent-strong)` (tercera variante, ni box-shadow ni token de focus).

El fix #10 dice "focus ring único". Es exacto solo dentro de Cocoa. En las 141
pantallas Aurora y las 16 mixtas el usuario ve un anillo esmeralda; en las 14 Cocoa,
azul. No es un único sistema de focus.

### H2 · Outline suprimido sin anillo de reemplazo en CocoaSwitch y CocoaSearchInput (severidad: alta, a11y)
Ambos hacen `outline: none/0` sin ninguna `:focus-visible` ni clase `cocoa-focus-ring`:
- `components/cocoa/CocoaSwitch.tsx:86` — es un `<button role="switch">` focusable pero **sin indicador de foco visible**.
- `components/cocoa/CocoaSearchInput.tsx:28` — input sin anillo de foco.

Esto es una regresión WCAG 2.4.7 (Focus Visible) introducida por el patrón
"outline:none + box-shadow" cuando se olvida el box-shadow. Los demás
(`CocoaInput`, `CocoaSelect`, `CocoaStepper`, `CocoaDatePicker`) sí pares
outline-none con anillo.

### H3 · Filas/headers de CocoaTable interactivos no son accesibles por teclado (severidad: alta, a11y)
`components/cocoa/CocoaTable.tsx`: las celdas de cabecera ordenables
(`onClick` en :172) y las filas seleccionables (`onClick` en :247) **no tienen**
`tabIndex`, `onKeyDown`, `role="button"` ni `cocoa-focus-ring`. Son `onClick` sobre
`<th>/<tr>` puros: invisibles para teclado y lectores de pantalla. El tint de
hover/selección es dark-safe (bien), pero la interacción no es operable sin ratón.

### H4 · Tokens de estado infrautilizados — single-source-of-truth incompleto (severidad: media)
Los `--cocoa-*-bg` se definen en `cocoa-tokens.css` pero solo se **consumen** en
`CocoaButton.tsx` (`--cocoa-accent-bg`, `--cocoa-danger-bg`). `CocoaTable` y
`CocoaInput` re-derivan su propio `color-mix(in srgb, var(--cocoa-…) X%, transparent)`
inline en vez de usar los tokens nombrados. Resultado: la promesa "usa estos en vez
de rgba() literal" se cumple a medias; cambiar el % de tint de un estado aún requiere
editar varios sitios. Los tokens `--cocoa-success-bg`/`--cocoa-warning-bg`/`--cocoa-info-bg`
no tienen **ningún** consumidor todavía.

### H5 · Decisión Aurora/Cocoa documentada pero NO tomada ni aplicada (severidad: alta, deuda)
`docs/design-system/DESIGN-SYSTEM-DECISION.md` presenta opciones A/B/C y recomienda A
(Aurora canónico + disciplina de tokens Cocoa), pero **no marca una dirección**: el
doc y el script siguen diciendo "Decision pending". No se ha re-apuntado ningún token
`--cocoa-*` a la paleta cálida; las dos paletas siguen intactas. Por diseño la ronda
solo entregó el brief, pero la pregunta del audit ("¿documentada pero sin aplicar?")
se responde: **sí, documentada y completamente sin aplicar**.

### H6 · Gate de drift report-only y no cableado (severidad: media)
`scripts/check-design-system-drift.mjs` soporta `--enforce` pero solo está expuesto
como `ds:drift` en `package.json:27` (modo report). No aparece en ningún pre-commit
(`.husky`) ni en `.github/workflows/`. Nada impide que entren nuevas pantallas mixtas;
el gate no protege todavía.

### H7 · El drift sigue alto: 16 pantallas mezclan ambos sistemas (severidad: media)
Ejecución real del script: 202 pantallas → **141 Aurora**, **14 Cocoa**, **16 mixtas**,
31 neutras. Las mixtas (a migrar primero) incluyen `ReservationCreateScreen.tsx`,
`ReservationWorkspaceScreen.tsx`, `BillingCenterScreen.tsx`, `FolioDetailScreen.tsx`,
`RevenueHomeDashboard.tsx`, `GeneralManagerScreen.tsx`, varias `operations/*Mobile*`.
Nota: estas cifras difieren de las del brief (156/27); el brief está desactualizado.

### H8 · Dos escalas de design tokens en paralelo, sin puente (severidad: media)
Persisten dos sistemas completos de tokens: Aurora (`--fs-*`, `--space-*`, `--ok/warn/danger-bg`,
`--accent`, `--focus`) y Cocoa (`--cocoa-*`, grid 4pt, tipografía HIG 13px). No hay capa
de alias que mapee uno al otro, así que un componente nuevo todavía debe elegir
universo. Es exactamente el coste que el brief describe — y que sigue vigente porque
H5 no se resolvió.

### H9 · Sin soporte de forced-colors / prefers-contrast (severidad: baja, a11y)
No hay ninguna media query `forced-colors` ni `prefers-contrast` en `styles/` ni en
`styles.css`. En modo de alto contraste de Windows / contraste aumentado, los anillos
de foco basados en `box-shadow` (no `outline`) tienden a desaparecer, agravando H1/H2.
Cocoa sí cubre bien `prefers-reduced-motion` (3 ficheros) y `@supports not backdrop-filter`.

### H10 · ReservationCreateScreen es mixta y aplica parches sobre base incoherente (severidad: baja)
Fixes #12 (datos demo vaciados — confirmado, `:443` "Defaults are now intentionally
blank") y #13 (scroll-to-first-error — confirmado, `focusInvalidField` en `:255-270`
con `scrollIntoView` + `focus({preventScroll:true})`) están **bien implementados**. Pero
la pantalla aparece en la lista de mixtas (H7): usa `CocoaInput` dentro de un layout
con clases `.bo-*`, heredando dos focus rings y dos escalas. Los parches son correctos;
la base no es coherente.

## Score: 62 / 100

| Eje | Peso | Nota | Comentario |
|---|---|---|---|
| Tokens (definición/calidad) | 20 | 18 | cocoa-tokens.css es excelente (dark explícito, color-mix, fallbacks) |
| Tokens de estado en uso | 15 | 8 | definidos sí; consumidos solo en 1 componente (H4) |
| Focus ring único | 15 | 6 | único intra-Cocoa, no en producto; 2 componentes sin anillo (H1,H2) |
| A11y visual | 20 | 9 | tabla no operable por teclado, sin forced-colors (H2,H3,H9) |
| Coherencia Aurora/Cocoa | 20 | 9 | decisión sin tomar, 16 mixtas, gate report-only (H5,H6,H7,H8) |
| Dark mode | 10 | 9 | tints dark-safe reales y verificados; bien (#10) |

## Remediación (priorizada)

1. **Cerrar el focus ring (H1, H2).** Resolver inmediatamente H2: añadir
   `className="cocoa-focus-ring"` a `CocoaSwitch` (`<button role="switch">`) y a
   `CocoaSearchInput` (o un `:focus-visible` con `box-shadow: 0 0 0 3px var(--cocoa-focus-ring)`).
   Para H1, decidir DS (paso 4) y unificar `--focus` ← `--cocoa-focus-ring` (o
   viceversa) en un único token; eliminar el `outline` suelto de `styles.css:627`.
2. **Teclado en CocoaTable (H3).** En filas/headers con `onClick`, añadir
   `tabIndex={0}`, `role="button"` (o `aria-sort` en headers), `onKeyDown`
   Enter/Espacio y `className="cocoa-focus-ring"`. Quick win de alto impacto a11y.
3. **Centralizar tints de estado (H4).** Hacer que `CocoaTable` y `CocoaInput`
   consuman `--cocoa-danger-bg`/`--cocoa-accent-bg` etc. en vez de `color-mix` inline;
   dar un primer consumidor real a `--cocoa-success-bg`/`-warning-bg`/`-info-bg`
   (p. ej. un componente `CocoaBadge`/`CocoaCallout`). Cumple la promesa de single source.
4. **Tomar la decisión DS y cablear el gate (H5, H6).** Marcar dirección en
   `DESIGN-SYSTEM-DECISION.md` (la recomendación es Aurora canónico). Implementar el
   re-apuntado de tokens `--cocoa-*` a la paleta cálida (un cambio de tokens, no de
   pantallas). Añadir `node scripts/check-design-system-drift.mjs --enforce` a
   pre-commit y a un job de CI para congelar el sistema perdedor.
5. **Migrar las 16 mixtas por oleadas (H7, H10).** Empezar por las de reservas y
   billing (alta visibilidad). Actualizar las cifras 156/27 del brief a 141/14/16.
6. **A11y de alto contraste (H9).** Añadir un bloque `@media (forced-colors: active)`
   que fuerce el focus ring a `outline: 2px solid CanvasText` (los box-shadow no
   sobreviven en forced-colors).

### Estado de los fixes verificados en esta ronda
Confirmados reales: #10 (tints dark-safe ✔, focus único PARCIAL), #11 (RoomRack y
NightAudit usan `LoadingBlock`/`ErrorState` ✔), #12 (datos demo vaciados ✔), #13
(scroll-to-error ✔), #15 (brief ✔ + script ds:drift ✔; decisión y enforce NO).
Pendientes nuevos: H1–H10 arriba.
