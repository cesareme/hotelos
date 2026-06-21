# Revisión adversarial · AUDIT-design.md (Ronda 2)

**Rol:** Design director escéptico. **Método:** verificación por `grep`/lectura/ejecución
del script contra tokens y componentes reales, no contra el texto del audit.
**Veredicto global:** el audit es **sólido y mayormente exacto**. Las dos afirmaciones
centrales del encargo —"¿el focus ring único es real?" y "¿los dos design systems
siguen sin gobierno?"— se confirman *en contra* del fix. Hay **una imprecisión** en H3
que conviene corregir antes de pasar a remediación.

---

## 1. ¿El focus ring "único" es real? — NO. Confirmado por grep.

El fix #10 prometía "focus ring único". **Es falso a nivel de producto.** Coexisten
**tres** mecanismos de foco con colores/formas distintos:

| Sistema | Token / regla | Color | Evidencia |
|---|---|---|---|
| Cocoa | `--cocoa-focus-ring` | **azul** `rgb(0 100 225 / .50)` light, `rgb(10 132 255 / .60)` dark | `styles/cocoa-tokens.css:66,271,337` |
| Aurora | `--focus` | **esmeralda** `rgba(13,138,95,.18)` light, `rgba(43,179,127,.32)` dark | `styles.css:111,191,250` (consumido en `1089,1301,1355`) |
| Stray | `outline: 2px solid var(--accent-strong)` | tercera variante, ni box-shadow ni token de focus | `styles.css:627` (`.bo-role-select-wrap select:focus-visible`) |

`grep` directo confirma dos paletas de focus distintas y físicamente separadas. La
palabra "único" solo es cierta *intra-Cocoa*. El usuario ve azul en pantallas Cocoa y
esmeralda en pantallas Aurora; **H1 es correcto y la severidad alta está justificada.**

### H2 — outline suprimido sin reemplazo: CONFIRMADO, y es lo más grave
Verificado en el fichero, no en el texto del audit:

- `components/cocoa/CocoaSwitch.tsx:86` → `outline: "none"` en un `<button role="switch">`
  (línea 125) **focusable**. No hay `:focus-visible`, ni `cocoa-focus-ring`, ni box-shadow
  de foco. El único `boxShadow` del componente es `--cocoa-shadow-control` en el *thumb*
  (línea 104): decorativo, no indica foco. **Regresión WCAG 2.4.7 real.**
- `components/cocoa/CocoaSearchInput.tsx:28` → `outline: "none"`, sin anillo de reemplazo.

Contraste verificado: `CocoaInput.tsx:114`, `CocoaSelect.tsx:91`, `CocoaStepper.tsx:203`,
`CocoaDatePicker.tsx:58` **sí** emparejan `outline:0/none` con
`box-shadow: 0 0 0 3px var(--cocoa-focus-ring)`. El patrón es correcto en 9 componentes
(grep de `cocoa-focus-ring` en `components/cocoa/`) y se rompe en exactamente 2. Es un
olvido puntual, no un fallo sistémico — pero ambos son controles operables sin indicador
de foco. **Prioridad 1, y es un quick win** (añadir `className="cocoa-focus-ring"`).

**Conclusión sección 1:** el "focus ring único" es marketing. La realidad son 3 colores
de foco y 2 controles ciegos a teclado. El audit acierta.

---

## 2. ¿Los dos design systems siguen sin gobierno? — SÍ. Confirmado al ejecutar.

Ejecuté `node scripts/check-design-system-drift.mjs`. Salida real, sin tocar:

```
Screens scanned:   202
Aurora only (.bo): 141
Cocoa only:        14
Mixed (both):      16
Neither:           31
Decision pending — see docs/design-system/DESIGN-SYSTEM-DECISION.md. (report-only)
```

- **Decisión NO tomada (H5): confirmado.** `DESIGN-SYSTEM-DECISION.md` recomienda
  explícitamente Opción A (Aurora canónico + disciplina de tokens Cocoa), pero el propio
  script imprime **"Decision pending"** y la última sección del doc es *"Una vez decidas"*:
  nadie ha marcado dirección. Verifiqué además que **ningún** token `--cocoa-*` se ha
  re-apuntado a la paleta cálida: siguen en azul Apple (`cocoa-tokens.css`). Documentado,
  cero aplicado. Exacto.
- **Gate report-only (H6): confirmado.** El script soporta `--enforce`
  (`scripts/check-design-system-drift.mjs:25,53,86-88`: `process.exit(1)` si hay mixtas),
  pero `package.json:27` solo expone `ds:drift` **sin** la flag. `grep` en `.husky/pre-commit`
  y `.github/workflows/{ci,deploy}.yml` → **0 referencias** a drift/design-system. Nada
  bloquea pantallas mixtas nuevas. El gobierno está construido pero **desconectado**.
- **Drift (H7): cifras exactas.** 141/14/16/31 coinciden bit a bit con mi ejecución. El
  audit acierta también al señalar que el brief (156/27) está desactualizado: la fuente de
  verdad es el script, no el doc. Bien cazado.
- **Dos escalas de tokens sin puente (H8): confirmado.** No existe capa de alias; un
  componente nuevo sigue obligado a elegir universo.

**Conclusión sección 2:** sí, dos design systems completos conviviendo sin gobierno. La
ronda entregó el **diagnóstico** (brief + script), no el **gobierno** (decisión + enforce).
El encargado del fix #15 confundió "documentar el problema" con "resolverlo".

---

## 3. Donde el audit se PASA de frenada — corregir antes de remediar

**H3 es parcialmente inexacto.** El audit afirma que las cabeceras ordenables de
`CocoaTable` no tienen "`tabIndex`, `onKeyDown`, `role="button"` **ni `aria-sort`**".
Falso en lo último: `CocoaTable.tsx:173` **sí emite `aria-sort`** (`ascending`/`descending`/
`none`). Es decir, las cabeceras **sí comunican el estado de orden a lectores de pantalla**;
lo que falta es la **operabilidad por teclado** (`tabIndex`/`onKeyDown`/foco). El núcleo
del hallazgo (no operable sin ratón en `:172` headers y `:247` filas) es **correcto y de
severidad alta**, pero la frase "ni aria-sort" debe eliminarse: resta credibilidad y
sobreestima el daño. Recomiendo reescribir H3 como "operabilidad de teclado ausente
(aria-sort sí presente en headers)".

---

## 4. Resto de hallazgos: verificados

- **H4 (tokens infrautilizados): confirmado y más grave de lo que suena.** `grep` de
  consumidores: `--cocoa-danger-bg` y `--cocoa-accent-bg` solo se usan en
  `CocoaButton.tsx`; `--cocoa-success-bg`, `--cocoa-warning-bg`, `--cocoa-info-bg` tienen
  **cero consumidores**. `CocoaTable.tsx:221,224` y `CocoaInput.tsx:111` re-derivan su
  propio `color-mix` inline. El "single source of truth" es por ahora un *single source of
  un solo botón*. Token-debt definido pero no centralizado.
- **H9 (sin forced-colors): confirmado.** `grep -r "forced-colors\|prefers-contrast"` en
  todo `apps/admin-web/src/` → **0 resultados**. Con anillos basados en `box-shadow` (que
  no sobreviven en alto contraste de Windows), H1/H2 empeoran. Severidad baja correcta.
  Justo: Cocoa sí cubre `prefers-reduced-motion` (4 ficheros) y `@supports not backdrop-filter`.
- **H10 (#12/#13 bien, base incoherente): plausible y consistente** con que
  `ReservationCreateScreen.tsx` aparezca en la lista de mixtas del script. No re-verifiqué
  línea a línea los fixes #12/#13 por estar fuera del foco del encargo.

---

## Veredicto sobre el audit

| Eje | Mi lectura |
|---|---|
| Exactitud de H1/H2 (focus ring) | **Alta** — verificado por grep, 3 colores reales |
| Exactitud de H5/H6/H7 (gobierno) | **Alta** — cifras exactas al ejecutar, gate desconectado confirmado |
| Exactitud de H3 | **Media** — núcleo correcto, sub-afirmación "ni aria-sort" **errónea** |
| Score 62/100 | **Razonable.** Si acaso, generoso en "Focus ring único=6": con 2 controles
  ciegos a teclado (WCAG fail) y 3 colores de foco, un 5 sería más justo. No lo movería. |

**Confirmación del encargo:**
1. *¿Focus ring único real?* **No.** Tres mecanismos de foco distintos por grep; dos
   componentes Cocoa sin indicador de foco alguno. El fix #10 es PARCIAL, como dice el audit.
2. *¿Dos design systems sin gobierno?* **Sí.** Decisión "pending", tokens sin re-apuntar,
   gate `--enforce` sin cablear a husky/CI, 16 pantallas mixtas y subiendo. El fix #15
   entregó diagnóstico, no gobierno.

**Acción requerida en el audit:** corregir la frase "ni aria-sort" de H3. Todo lo demás
queda **aprobado para remediación** con las prioridades 1–2 (cerrar focus ring + teclado
en tabla) y 4 (decidir DS + cablear `--enforce`) como bloqueantes.
