# Revisión adversarial · AUDIT-code-frontend.md (Ronda 2)

**Fecha:** 2026-06-21 · **Rol:** Senior frontend, escéptico · **Método:** re-verificación independiente (Grep/Read sobre `apps/admin-web`) de cada claim cuantitativo, cada fix y cada hallazgo del audit.
**Veredicto corto:** El audit es **sólido y honesto**. Los 4 fixes de frontend están realmente en el código. La inmensa mayoría de cifras se reproducen. Encontré **3 imprecisiones de evidencia** (no de conclusión) y **2 cosas que el audit no cubre**. El score 72/100 es defendible; lo dejaría igual.

---

## 1. Fixes: ¿reales? — SÍ, los 4 confirmados de forma independiente

| Fix | Claim del audit | Mi verificación | Veredicto |
|---|---|---|---|
| 10 tokens estado/focus/dark | `cocoa-tokens.css:53-66`, `cocoa-base.css:31` | 10 surfaces con `color-mix` presentes (`:53-62`); focus ring def única en `cocoa-base.css:31` + token en `:66`/`:271`/`:337` | **Real** |
| 11 loading/error RoomRack+NightAudit | `:228`/`:158` | `RoomRackScreen.tsx:229` `<ErrorState onRetry={refresh}/>`+`:231` `<LoadingBlock/>`; `NightAuditScreen.tsx:159/161` idem | **Real** |
| 12 demo data vaciada | `:96-102,443` | `firstName/surname1` arrancan `""` (`:98-100`); comentario "Defaults are now intentionally blank" en `:443` | **Real** |
| 13 scroll-to-first-error | `:262-269,450,457` | `focusInvalidField` en `:262`, `scrollIntoView({block:"center"})` `:266`, `focus({preventScroll:true})` `:268`, invocado en `:450/457` | **Real** |
| 15 brief DS + drift script | doc + `check-design-system-drift.mjs` | Ambos existen; el script es report-only por defecto (`exit 0`) y bloqueante con flag (`process.exit(enforce?1:0)` `:53`) | **Real** |

No hay fix inflado ni inventado. Esto es lo que más me importaba comprobar y el audit pasa limpio.

---

## 2. Métricas: reproducibles, con drift menor de snapshot

Cifras que reproduje contra el árbol actual:

| Métrica | Audit | Mi medición | Nota |
|---|---|---|---|
| `style={{` (ocurrencias) | 3.957 | **3.985** | +28; drift de commit, no error material |
| `React.memo` / `memo(` | 0 | **0** | exacto |
| pantallas `useApiData` | 82 | **82** | exacto |
| pantallas `toArray` | 13 | **13** | exacto |
| `components/v2` LOC / comps / consumidores | 1.342 / 8 / 4 | **1.342 / 8 / 4** | exacto |
| `cocoa-sidebar-v2` LOC | 2.207 | **2.207** | exacto |
| `key={index}` | 28 | **28** | exacto |
| `as any` / `@ts-ignore` / `dangerouslySetInnerHTML` | 0/0/0 | **0/0/0** | exacto |
| `console.*` | 4 | **5** | +1; trivial |
| pantallas `.bo-*` (Aurora) | 156 | **157** | +1; trivial |

El único número que merece una nota es **3.985 vs 3.957 inline styles**: el audit dice "sin cambio" vs ronda 1, pero el conteo subió ~28. Coherente con su propio hallazgo de que el fix 13 *reintrodujo* inline styles (`FieldRow`). No invalida nada; si acaso refuerza el hallazgo #2. La frase "idéntico" debería ser "prácticamente idéntico (+28 neto)".

---

## 3. Imprecisiones de evidencia (la conclusión aguanta, la cita no)

**3a. Hallazgo #4 — dos ejemplos mal atribuidos al chunk.**
El audit dice que `screens-operations-rest` "incluye `GroupDetailDialog.tsx` (1.436 LOC)... y `RoomBlockGridDialog`". **Falso para esos dos.** `vite.config.ts:93` enruta explícitamente `GroupDetailDialog` *y* `RoomBlockGridDialog` a `screens-operations-groups`. Los pesos que **sí** quedan en `operations-rest` son `OperationsDirectorScreen` (1.240) y `GeneralManagerScreen` (1.129) — que el audit también nombra y esos sí caen ahí (no hay regla previa que los capture; `:105` los recoge). **La dirección del hallazgo es correcta** (hay archivos >1k LOC en un chunk monolítico), pero 2 de sus 3 ejemplos están en el chunk equivocado. Corregir la evidencia; el fix propuesto (`React.lazy` para diálogos >1k) sigue válido apuntado a Director/GeneralManager.

**3b. Hallazgo #1 — tokens de `StatTile` citados sin sus fallbacks.**
El audit cita `StatTile.tsx:25 var(--fs-xl)` y `:37 var(--ink)` como prueba de "tokens Aurora propios". El código real es `var(--fs-xl, 20px)` (`:25`) y `var(--ink, #1a1a1a)` (`:36`, no `:37`) — **con valor de respaldo literal**. Importa porque el riesgo implícito ("vars que no resuelven fuera de Aurora") está **mitigado por los fallbacks**: el componente degrada a 20px/#1a1a1a aunque el token no exista. El claim de fondo (v2 vive en un namespace de tokens distinto a `--cocoa-*`, es una 3ª capa) es **correcto y bien traído** — `v2/DataTable.tsx` sí reimplementa `sortable/loading/emptyState` (`:8,22-27`) que ya da `CocoaTable`, y el decision-doc no menciona v2 (lo confirmé: grep vacío). Solo matizaría que estos tokens no son tan frágiles como la cita sugiere.

**3c. `console.*` = 5, no 4.** Cosmético; no afecta score.

---

## 4. ¿Regresiones introducidas por los fixes? — Una real, bien capturada; ninguna oculta

- **Sí hay una micro-regresión y el audit la pilla:** el fix 13 (`FieldRow`) reintroduce 6 inline styles/fila (`ReservationCreateScreen.tsx:275-292`), confirmado. Es honesto que el audit lo señale en su propio hallazgo #2 en vez de barrerlo. Mismo fichero sí hoistea bien en otros sitios (`gridThreeStyle:299`, `actionsRowStyle:305`), así que es inconsistencia, no incompetencia.
- **Fix 10 introduce deuda nueva → hallazgo #7 (color-mix sin fallback): CONFIRMADO y bien razonado.** Los 10 surfaces usan solo `color-mix(in srgb,...)` (`:53-62`); el único `@supports` del fichero (`:384`) cubre `backdrop-filter`, no `color-mix`. En Safari <16.2 los banners de estado quedan sin fondo. Hallazgo legítimo y P2 correcto.
- **No detecté regresiones que el audit haya omitido.** Revisé que `LoadingBlock`/`ErrorState` se importan correctamente y que las defaults blancas no rompen el submit (hay guard en `:453`).

---

## 5. a11y / performance: ¿se omitió algo? — Cobertura justa, con un matiz

- **Perf:** el audit cubre lo esencial (0 memo, hover-en-estado de `CocoaTable`, chunks, inline styles). Verifiqué `CocoaTable.tsx`: `useState(hoverKey)` `:104` + `onMouseEnter` `:243` → repaint de N filas en hover. **Claim correcto.** El fix propuesto (hover por CSS `:hover`) es el correcto y barato.
- **a11y:** el audit acierta en lo grande (fix 13 scroll-to-error, los 12 dashboards sin loading — verifiqué FiscalDashboard 5×useApiData/0 loading, ComplianceInbox 6/0, y 5 dashboards más todos con useApiData y 0 LoadingBlock). **Lo que el audit NO mira y yo sí miraría:** no hay una sola medición de **roles/ARIA ni contraste de los 800 `<button>` crudos** ni del nuevo focus-ring (¿cumple el ring 3px AA contra los fondos de estado nuevos?). El audit valida que el focus-ring es *fuente única* pero no que sea *suficiente en contraste*. Es un hueco de método (lectura estática no mide contraste), no un error — pero debería declararse como "no evaluado" en vez de implicar a11y OK.

---

## 6. Score

El reparto por ejes es razonable y las subidas (+2 consistencia, +1 a11y) están justificadas por fixes reales. **Mantengo 72/100.** No subiría pese a las imprecisiones 3a/3b porque ninguna cambia la conclusión sistémica (la deuda P1 persiste: inline styles, 0 memo, 3ª capa v2, chunk operaciones). No bajaría porque los fixes son genuinos y verificados.

**Acciones para el próximo audit:**
1. Corregir #4: `GroupDetailDialog`/`RoomBlockGridDialog` están en `operations-groups`, no en `rest`. Reapuntar el ejemplo a `OperationsDirectorScreen`/`GeneralManagerScreen`.
2. Matizar #1: los tokens de `StatTile` llevan fallback literal (`var(--x, valor)`); el problema es el namespace duplicado, no que no resuelvan.
3. Declarar explícitamente "contraste/ARIA: no evaluado (lectura estática)" para no implicar cobertura a11y completa.
4. Cambiar "3.957 sin cambio" → "+28 neto" (coherente con el propio hallazgo del FieldRow).
