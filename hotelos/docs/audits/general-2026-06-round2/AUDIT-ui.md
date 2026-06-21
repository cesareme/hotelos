# Auditoría UI / UX — admin-web · Ronda 2

Fecha: 2026-06-21 · Alcance: `apps/admin-web/src/screens/` (202 pantallas) + `navigation/Sidebar.tsx`.
Método: verificación de los 15 fixes de remediación + relectura de flujos clave (front-desk, reserva, navegación, formularios, estados).
Referencia: ronda 1 en `docs/audits/general-2026-06/AUDIT-ui.md` (score previo 62/100).

## Resumen ejecutivo

La remediación es **real pero parcial**. Los tres fixes UI que pedía confirmar están **aplicados y correctos**:

- **#11 (estados carga/error)** — CONFIRMADO. `RoomRackScreen.tsx:216` tiene un guard `if (!data)` que muestra `LoadingBlock`/`ErrorState` en vez del "hotel vacío" engañoso. `NightAuditScreen.tsx:157` hace lo mismo con `!preflight`, evitando el banner rojo "no puedes cerrar" mientras la API aún carga. Ambos con hooks ejecutados antes del early-return (sin romper reglas de hooks) y botón de reintento.
- **#12 (datos demo vaciados)** — CONFIRMADO. `ReservationCreateScreen.tsx:58` — `defaultForm` tiene `totalAmount:""`, `bookerName:""`, `firstName:""`, `phone:""`. Ya no existe "Ana Martínez" ni "272€". Además se añadió un guard de campos requeridos (`handleCreate`, línea 446-459) que bloquea el submit sin tipo de habitación ni nombre/apellido. (Nota: la cadena "Usando datos de demo" en línea 335 solo fija un *status text* ante fallo de API, no rellena el formulario.)
- **#13 (scroll-to-first-error)** — CONFIRMADO. `focusInvalidField()` (línea 262-269) hace `scrollIntoView({block:"center"})` + `focus()` sobre el primer control inválido, invocado en `handleCreate` para roomtype/firstname/surname1.

El front-desk está claramente mejor que en ronda 1: `FrontDeskDashboard.tsx` es **Cocoa nativo** (header, cards, tabla, tabs internos que recortan scroll, bloque "Riesgos" colapsable, clean-slate de primera ejecución con 4 pasos). `QuickCheckIn/Out` siguen siendo ejemplares.

**Pero la deuda estructural de ronda 1 sigue casi intacta.** Los fixes 11-13 atacan 3 pantallas; los problemas de fondo (P0/P1 de ronda 1) no se tocaron: la **reserva sigue siendo un mega-formulario de 153 campos en una sola página** (el `CocoaStepper` se importa pero solo para contadores +/-, no hay estado de paso de wizard); **mezcla inglés/español** persiste ("Arrival date", "Create Reservation", "Booking source" junto a hints en español); **30 stubs `ScreenScaffold` siguen en inglés** con botones deshabilitados ("Pendiente de implementación"); el **role switcher sigue siendo un `<select>` "Vista"** sin descripción; **dos wizards de onboarding** coexisten; y la **validación inline sigue ausente** — `aria-invalid` no aparece en **ninguna** pantalla (0/202), por lo que la mitad accesible del hallazgo #12 de ronda 1 queda pendiente: el scroll-to-error existe, pero el campo culpable no se marca visualmente ni para lectores de pantalla.

Adopción de design system prácticamente igual: **149/202 con `bo-card`**, **14/202 con `CocoaPageHeader`**, **30 stubs**, **skeletons solo en 3 pantallas**. ~41 pantallas con fetch siguen sin manejar estados de carga/error/vacío.

**Score UX global: 68/100** (+6 vs ronda 1). Suben los flujos remediados (front-desk, rack, night audit, riesgo de datos demo eliminado); no sube la coherencia sistémica.

---

## 12 hallazgos (pantalla + fix)

### P0 — Fricción que bloquea o confunde

**1. Reserva: mega-formulario de 153 campos en una sola página (sin wizard).**
`reservations/ReservationCreateScreen.tsx` — 153 `FieldRow`, 0 estado de paso (`grep` de `setStep`/`activeStep` = vacío). El `CocoaStepper` solo incrementa ocupación. El recepcionista ve 6 fieldsets gigantes de scroll continuo.
Fix: convertir a wizard de 4-5 pasos (Estancia → Tarifa/Origen → Huésped+identidad → Pagos → Confirmar) reutilizando el patrón de `CocoaOnboardingWizard`. Era P0 en ronda 1 y sigue abierto.

**2. Validación de formulario no es inline ni accesible.**
`ReservationCreateScreen.tsx` — el error de submit llega por toast + scroll-to-error (#13), pero el campo culpable **no** recibe `aria-invalid`, `aria-describedby` ni borde/mensaje propio. `aria-invalid` no existe en ninguna de las 202 pantallas.
Fix: marcar el campo inválido (borde danger + mensaje bajo el control + `aria-invalid="true"`). El scroll ya lleva el foco; falta el feedback visual y de SR.

**3. Mezcla inglés/español dentro del mismo formulario de reserva.**
`ReservationCreateScreen.tsx:644` "Manual reservation" / "Create Reservation"; líneas 662, 665, 1116, 1123, 1137, 1186 — labels "Arrival date", "Departure date", "Booking source", "Market segment", "Source code", "Booker name" con hints en español. La tarjeta de éxito dice "Created", "Open reservation detail".
Fix: unificar a español. App es-ES; confunde al recepcionista en la pantalla más crítica.

### P1 — Dead-ends y profundidad

**4. 30 pantallas de configuración siguen siendo stubs de solo lectura.**
`ScreenScaffold.tsx:71` mantiene el botón deshabilitado con `title="Pendiente de implementación"` (`opacity:0.55, cursor:not-allowed`). Consumidores: `BillingSettings`, `AISettings`, `PropertySettings`, `ChannelManagerSettingsScreen`, etc.
Fix: implementar el formulario o migrar a `ModuleSettingsPlaceholder` (que sí tiene CTA real "avísame" + links a dashboard/setup, líneas 25/123). El stub actual simula profundidad inexistente.

**5. Los 30 stubs siguen íntegramente en inglés.**
`BillingSettings.tsx:6-8` — eyebrow "Invoices", title "Billing Settings", summary en inglés, junto a pantallas Cocoa en español.
Fix: traducir el copy o moverlo a `content/` i18n.

**6. Dos wizards de onboarding compitiendo.**
`onboarding/CocoaOnboardingWizard.tsx` (Cocoa, 23 KB) vs `onboarding/OnboardingInteractive.tsx` (Aurora, 37 KB). Mismo concepto, estéticas y modelos mentales distintos.
Fix: elegir uno canónico, fusionar el otro como etapa, único punto de entrada en sidebar.

**7. Modelo de personas desalineado: 9 personas vs 5 roles.**
`operations/PersonaLandingScreen.tsx` declara 9 `PERSONAS` ("8 personas operativas" en el comentario, línea 7) pero `navigation/roles.ts` define 5 roles (reception/operations/asset/owner/all). El `<select>` "Vista" y la landing no cuentan la misma historia.
Fix: una sola fuente de verdad; que la landing derive de `ROLES`. Sub-personas (GM, night auditor) como homes dentro de un rol, no como roles paralelos.

**8. Role switcher: `<select>` "Vista" sin descripción ni confirmación.**
`Sidebar.tsx:857-873` — sigue siendo un `<select>` nativo etiquetado "Vista", sin icono, sin `ROLES[].description`, sin avisar que cambiar de vista reordena todo el menú y te lleva a otro home (`changeRole` → `roleHome`). Una de las funciones más potentes del producto, enterrada.
Fix: popover/segmented con label + descripción + confirmación visual del cambio.

### P2 — Coherencia, navegación, pulido

**9. Dos design systems en paralelo (Aurora `bo-*` vs Cocoa) sin avanzar migración.**
149/202 con `bo-card`, 14/202 con `CocoaPageHeader`. `ReservationCreateScreen` aún envuelve Cocoa en `<section className="bo-card">` (línea 641) y reusa `bo-card` en la tarjeta de éxito (1430). Inconsistencia visual de header/card/tipografía al navegar.
Fix: definir Cocoa como DS único, wrapper `CocoaScreen`, migrar por oleadas empezando por los archivos mixtos, lint-gate contra `bo-card` nuevo.

**10. Navegación: command palette existe pero no se expone como atajo primario.**
`Sidebar.tsx` ya abre el subgrupo que contiene la pantalla activa (`subgroupContainsActive`, líneas 747/764) — mejora parcial sobre ronda 1 — pero siguen 200+ items en grupos→subgrupos→items, sin recientes/favoritos. `components/cocoa-global/CocoaCommandPalette.tsx` existe; el front-desk lo enlaza ("Buscar ⌘K") pero el sidebar no lo promociona.
Fix: exponer command palette como entrada de navegación primaria + sección "recientes" en el sidebar.

**11. Skeletons casi inexistentes; carga percibida lenta en data-heavy.**
Solo 3/202 usan `Skeleton` (`GeneralManagerScreen`, `RevenueForecastExplorer`, `States.tsx`). Dashboards pesados muestran spinner global.
Fix: sustituir `LoadingBlock` por skeletons con la silueta del contenido (KPI cards, tablas, rate grid).

**12. ~41 pantallas con fetch sin estados de carga/error/vacío.**
Conteo aproximado: pantallas que usan `useApiData`/`fetch` pero no importan `LoadingBlock`/`ErrorState`/`EmptyState`/`Skeleton` ni son stubs. Riesgo de pantallas en blanco o "vacío engañoso" como el que se corrigió en rack/night-audit (#11).
Fix: aplicar el mismo patrón de guard `if (!data)` ya probado en `RoomRackScreen`/`NightAuditScreen` a las pantallas data-heavy restantes.

---

## Verificación de los 15 fixes (resumen)

Los fixes UI/DS están aplicados:
- **#10 (tokens estado + focus ring + tints dark-safe)**: `cocoa-tokens.css` y componentes Cocoa presentes; front-desk usa tokens semánticos consistentemente.
- **#11 (carga/error rack + night audit)**: CONFIRMADO en ambas pantallas (guards reales con retry).
- **#12 (datos demo vaciados)**: CONFIRMADO (`defaultForm` en blanco + guard de requeridos).
- **#13 (scroll-to-first-error)**: CONFIRMADO (`focusInvalidField`).

Fuera de alcance UI directo pero observados como honestos: **#14** (`CHANNEL_OPTIONS` etiqueta OTAs como "Booking.com Mock"/"Expedia Mock" en la propia reserva) y **#15** (decisión Aurora vs Cocoa documentada). Los fixes 1-9 (backend/CI/seguridad) no se reauditan aquí.

**Conclusión sobre la remediación:** los fixes fueron quirúrgicos y correctos, pero acotados a 3 pantallas. **No deben re-listarse como pendientes** los hallazgos 11, 12 y 13 — están resueltos. La deuda P0/P1 de coherencia (wizard de reserva, i18n, stubs, personas, migración Cocoa, validación inline accesible) sigue siendo el grueso del trabajo.

## Lo que está bien (no romper)

- **Front-desk** (`FrontDeskDashboard.tsx`): Cocoa nativo, tabs que recortan ~60% de scroll, "Riesgos" colapsable con badge de alertas, clean-slate de 4 pasos, tooltips explicando por qué un check-in está deshabilitado. Patrón a replicar.
- **Room Rack / Night Audit**: estados de carga/error correctos tras #11; night audit con checklist accionable (botón "fix" por check que navega a la cola correcta).
- **Quick Check-in/out**: flujos monopágina con cronómetro, intactos.
- **`components/States.tsx`**: primitivas completas; falta solo adopción de skeletons.
- **Sidebar**: RBAC por permisos con null-guard (evita crash en primer render), ocultación de placeholders para personas operativas, apertura del subgrupo activo.

## Recomendación de secuencia (ronda 3)

1. Validación inline accesible (#2) — barato, alto impacto a11y, complementa el #13 ya hecho.
2. i18n del formulario de reserva y stubs (#3/#5) — barato, alta visibilidad.
3. Wizard de reserva (#1) — el mayor reductor de fricción pendiente.
4. Resolver stubs: implementar o migrar a `ModuleSettingsPlaceholder` (#4).
5. Unificar personas (#7) y onboarding (#6).
6. Role switcher enriquecido (#8) + command palette primario (#10).
7. Migración Cocoa con lint-gate (#9) + skeletons (#11) + estados en las ~41 restantes (#12).

**Score UX: 68/100** (ronda 1: 62/100).
