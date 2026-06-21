# Revisión adversarial de AUDIT-ui.md (ronda 2)

Revisor: product designer escéptico · Fecha: 2026-06-21
Método: re-verificación independiente de cada claim load-bearing contra el código real en `apps/admin-web/src/`. No me fío de la prosa; cuento.

## Veredicto

El audit es **mayormente sólido y honesto**, mejor que la media: casi todos los claims son verificables y verdaderos. Pero tiene **un error de magnitud en su hallazgo estrella (P0 #1)** y **un punto ciego grave: no auditó la ruta del dinero** (folio/factura/checkout). Por eso el "68/100" y la narrativa "deuda intacta" son defendibles, pero el documento sobrevende su cobertura de flujos críticos.

## Lo que confirmo (los fixes son reales)

**¿Room Rack y Night Audit tienen estados de verdad? Sí, confirmado de primera mano.**
- `RoomRackScreen.tsx:216` — guard `if (!data)` real que renderiza `ErrorState` (con `onRetry`) o `LoadingBlock`, en lugar del "hotel vacío" engañoso. Verificado.
- `NightAuditScreen.tsx:157` — guard `!preflight` que sustituye el banner rojo "no puedes cerrar" por loading/error con retry mientras la API carga. Verificado.
- Claim crítico de calidad: **los hooks corren antes del early-return**. Lo comprobé con grep — **cero** hooks después de los guards en ambas pantallas. No hay violación de Rules-of-Hooks. Este detalle, que muchos auditores afirman sin mirar, aquí es cierto.

**Datos demo (#12), scroll-to-error (#13):** confirmados. `defaultForm` tiene `totalAmount:""`, `bookerName:""`, `firstName:""` (líneas 75/86/98); no queda "Ana Martínez" ni "272€". `focusInvalidField` (262) hace `scrollIntoView({block:"center"})`+`focus`, invocado en `handleCreate`. Real.

**`aria-invalid` = 0/202:** lo conté yo mismo. **Cero coincidencias** en todo el árbol. El argumento de que el #13 quedó a medias en accesibilidad (foco sí, marca visual/SR no) es legítimo y bien fundado.

**Claims estructurales (todos verdaderos):** `bo-card` 149/202 (exacto), `CocoaPageHeader` 14/202 (exacto), `ScreenScaffold.tsx:71` mantiene el botón muerto con `title="Pendiente de implementación"` y `cursor:not-allowed` (exacto), `ModuleSettingsPlaceholder.tsx` existe como alternativa con CTA real, los **dos** wizards de onboarding coexisten, y `roles.ts` define 5 roles (`reception/operations/asset/owner/all`) frente a las 9 PERSONAS de la landing. El `<select>` "Vista" sigue en `Sidebar.tsx:858`. Nada inventado aquí.

## Donde el audit falla o exagera

**1. El número estrella está inflado 2×. (Grave para la credibilidad del P0.)**
El hallazgo #1 — el titular del documento — afirma "mega-formulario de **153 campos**" y "153 `FieldRow`". El conteo real es **76 `FieldRow`**. El diagnóstico cualitativo es correcto (es un formulario largo monopágina; `setStep`/`activeStep` están **vacíos** — confirmado, no hay estado de wizard, el `CocoaStepper` solo cuenta ocupación). Pero un product designer no puede presentar como dato duro una cifra que dobla la realidad en el hallazgo P0 más visible. "76 campos en una página sin wizard" ya es un problema de fricción suficiente; inflarlo a 153 daña la confianza en el resto de números.

**2. Punto ciego: la ruta del dinero no se auditó como flujo. (El gap más serio.)**
El audit dice haber hecho "relectura de flujos clave (front-desk, reserva, navegación, formularios, estados)". Pero en un PMS el flujo más crítico —donde se cobra al huésped— es **folio → factura → checkout**, y existen pantallas sustanciales para ello: `billing/FolioDetailScreen.tsx`, `billing/InvoiceDetailScreen.tsx`, `billing/SplitFolioDialog.tsx`, `invoicing/InvoiceRectificationsScreen.tsx`, `operations/QuickCheckOutDrawer.tsx`, `admin/FolioRoutingScreen.tsx`. El documento **no menciona ninguna** salvo de pasada (`BillingSettings` como stub, "Pagos" como un paso hipotético del wizard). No se evaluó su manejo de estados, su i18n, ni su validación. Para un producto hotelero esto es como auditar un banco y saltarse la pantalla de transferencias. Si "flujos críticos" incluye la facturación —y debe—, la cobertura es incompleta y el audit no lo declara.

**3. El "~41 pantallas sin estados" es una estimación, no una medición — y el audit lo semi-admite.**
Conté **83** pantallas que usan `fetch`/`useApiData`. La cifra de 41 "sin estados" es un net aproximado que el propio texto marca como "conteo aproximado". Honesto, pero significa que el #12 es una hipótesis de alcance, no un hallazgo verificado pantalla por pantalla. Verifiqué muestras: `FolioDetailScreen` y `InvoiceDetailScreen` hacen fetch y **no** importan `LoadingBlock`/`ErrorState` —exactamente el riesgo de "vacío engañoso" que el audit dice haber arreglado en rack/night-audit—, lo que **refuerza** el #12 pero también prueba que las pantallas money-path caen en ese saco sin que el audit las nombre.

**4. Ruido menor de numeración y conteo.**
- Los comentarios en el código dicen **"#10"** (`RoomRackScreen.tsx:213`, `NightAuditScreen.tsx:154`) mientras el audit los llama **"#11"**. La trazabilidad fix↔código se rompe; alguien que busque "#11" en el repo no lo encontrará.
- Skeletons: el audit dice "3/202" y nombra `States.tsx`, pero `States.tsx` es un componente, **no** una pantalla; en `screens/` solo aparece en **2** archivos. La afirmación "solo adopción de skeletons falta" en `States.tsx` es correcta, pero el "3/202" mezcla componentes con pantallas.
- Stubs: dice "30", el real es **29** consumidores de `ScreenScaffold`. Trivial, pero es otro número redondeado al alza.

## Conclusión

¿Se auditaron los flujos críticos? **Parcialmente.** Front-desk, reserva, rack y night-audit sí, y bien. La **facturación/checkout —el flujo donde se mueve el dinero— quedó fuera**, sin declararlo. ¿Room Rack/Night Audit tienen estados de verdad ahora? **Sí, sin asterisco**: guards reales, retry, hooks en orden correcto. Eso lo firmo.

El documento es creíble en lo cualitativo y en casi todos sus claims binarios (existe/no existe), pero **no es fiable en sus magnitudes**: el 153 es un 76, el 41 es un net no medido, el 30 es 29, el "3/202" mezcla capas. Para una ronda 3, exigiría: (a) corregir el conteo de campos del #1 antes de usarlo para justificar el wizard; (b) **añadir una auditoría explícita del flujo folio/factura/checkout** —probablemente genere uno o dos P0 nuevos de manejo de estado en money-path—; (c) alinear la numeración de fixes con los comentarios del código.

**Mi ajuste al score:** la calidad técnica de los fixes verificados sostiene la subida, pero la cobertura incompleta de la ruta crítica del dinero me impide validar el "68/100" como global. Lo leería como **"~66 sobre lo auditado, con un flujo crítico sin cubrir"** — no como una foto completa del producto.
