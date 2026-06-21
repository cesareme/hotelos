# Auditoría UI / UX — admin-web

Fecha: 2026-06-21 · Alcance: `apps/admin-web/src/screens/` (202 pantallas) + `navigation/Sidebar.tsx` + design system Cocoa/Aurora.
Método: lectura con Grep/Read de pantallas representativas de cada flujo clave y conteo de adopción de patrones.

## Resumen ejecutivo

El producto tiene **dos sistemas de diseño viviendo en paralelo**: el legacy "Aurora" (clases `bo-*` en `styles.css`, 2790 líneas) y el nuevo **Cocoa Edition v3** (tokens `--cocoa-*`, 64 componentes). La intención estratégica es claramente migrar a Cocoa, pero la adopción en pantallas es minoritaria: solo **14/202 usan `CocoaPageHeader`** y **19/202 `CocoaCard`**, mientras **152/202 siguen usando clases `bo-*`** y **30 son stubs `ScreenScaffold`** (Aurora puro). Peor aún, **11 pantallas mezclan ambos sistemas en el mismo archivo** (p.ej. `ReservationCreateScreen` envuelve componentes Cocoa dentro de `<section className="bo-card">`). El resultado para el usuario es inconsistencia visual de header, card, tipografía y espaciado al navegar entre módulos.

La base técnica de estados es sólida (`components/States.tsx` ofrece `LoadingBlock`, `ErrorState`, `EmptyState`, `Skeleton`) y la adopción de loading/error es razonable (57 pantallas con `LoadingBlock`, 37 con `ErrorState`, 49 con empty state). El punto débil es **skeletons: solo 2 pantallas los usan** — el resto muestra spinners genéricos, lo que se percibe más lento. Y **28 pantallas no manejan ningún estado** de carga/error/vacío.

Los flujos clave están desigualmente pulidos. El **Rate Grid** (`RateGridEditorScreen`) y el **Quick Check-in** (`QuickCheckInDrawer`, flujo 90s monopágina) son ejemplares: Cocoa nativo, estados completos, un solo CTA. En el extremo opuesto, **crear reserva** es un mega-formulario de **153 campos en una sola página**, sin pasos reales, con datos demo hardcodeados ("Ana Martínez", total 272€) y etiquetas mezcladas inglés/español. El **onboarding tiene dos wizards competidores** (`CocoaOnboardingWizard` vs `OnboardingInteractive`).

El **Sidebar** es funcional y bien pensado (persona switcher, RBAC por permisos, búsqueda, filtrado por rol, ocultación de placeholders), pero es un único archivo de 962 líneas con 200+ entradas; la discoverability depende mucho del buscador porque la jerarquía es profunda (grupos → subgrupos → items, subgrupos cerrados por defecto).

**Score UX global: 62/100.** Fundamentos buenos, ejecución a medio camino: la deuda de migración Cocoa y los stubs de configuración son el mayor lastre percibido.

---

## 12 hallazgos priorizados

### P0 — Bloqueantes de coherencia / confianza

**1. Dos design systems mezclados — inconsistencia visual sistémica.**
Pantalla: transversal; ejemplo flagrante `screens/reservations/ReservationCreateScreen.tsx:611` (`<section className="bo-card">` envolviendo `CocoaCard`/`CocoaInput`). 152 pantallas Aurora vs 14 Cocoa header.
Fix: definir Cocoa como único DS. Crear un wrapper `CocoaScreen` (header + contenedor) y migrar por oleadas empezando por los 11 archivos mixtos. Prohibir `bo-card` nuevo con regla de lint.

**2. Datos demo hardcodeados en producción al crear reserva.**
Pantalla: `ReservationCreateScreen.tsx:75-103` — `totalAmount:"272"`, `bookerName:"Ana Martinez"`, `firstName:"Ana"`, `phone:"+34600000000"`.
Fix: vaciar `defaultForm` (strings vacíos) y mover los valores de ejemplo a un modo "seed/demo" detrás de flag. Riesgo real de crear reservas con el huésped equivocado.

**3. Crear reserva: 153 campos en una sola pantalla, sin pasos.**
Pantalla: `ReservationCreateScreen.tsx` (62 KB, 153 `FieldRow`). Importa `CocoaStepper` pero solo para contadores +/- de ocupación, no para navegar el alta.
Fix: convertir en wizard de 4–5 pasos (Estancia → Tarifa/Origen → Huésped+identidad → Pagos → Confirmar) reutilizando el patrón ya probado en `CocoaOnboardingWizard`. Reduce abandono y carga cognitiva drásticamente.

### P1 — Fricción alta

**4. 30 pantallas de configuración son stubs de solo lectura (dead-ends).**
Pantalla: `ScreenScaffold` consumers — `AISettings.tsx`, `BillingSettings.tsx`, `PropertySettings.tsx`, `ChannelManagerSettingsScreen.tsx`, etc. Solo describen funcionalidad; los botones únicamente navegan a otra pantalla y algunos no tienen acción (botón deshabilitado "Pendiente de implementación", `ScreenScaffold.tsx:71`).
Fix: o bien implementar el formulario real, o reemplazar por `ModuleSettingsPlaceholder` (que sí tiene CTA "avísame" y links claros) para no simular profundidad inexistente.

**5. Stubs/ScreenScaffold íntegramente en inglés.**
Pantalla: las 30 de `ScreenScaffold` (eyebrow/title/summary en inglés: "Billing Settings", "Configure invoice sequences…") en una app es-ES.
Fix: traducir copy a español o mover a `content/` i18n. Inconsistencia idiomática visible junto a pantallas Cocoa en español.

**6. Etiquetas mezcladas inglés/español dentro del mismo formulario.**
Pantalla: `ReservationCreateScreen.tsx:632-656` — labels "Arrival date", "Departure date", "Booking source", "Market segment" con hints en español.
Fix: unificar a español (o EN) en todo el formulario. Confunde al recepcionista.

**7. Skeletons casi inexistentes; carga percibida lenta.**
Pantalla: solo 2/202 usan `Skeleton`/`SkeletonLines` pese a existir en `States.tsx`. Dashboards pesados (`RevenueHomeDashboard`, `FrontDeskDashboard`) muestran spinner global.
Fix: sustituir `LoadingBlock` por skeletons con la silueta del contenido en las pantallas data-heavy (tablas, KPI cards, rate grid).

**8. Dos wizards de onboarding compitiendo.**
Pantalla: `screens/onboarding/CocoaOnboardingWizard.tsx` (Cocoa, 5 pasos, setup property) vs `OnboardingInteractive.tsx` (Aurora `bo-card/rev-kpi/cm-table`, pipeline import IA). Solapan el concepto "onboarding tenant" con estética y modelo mentales distintos.
Fix: decidir uno como canónico, fusionar el otro como una etapa dentro del wizard Cocoa, y dar un único punto de entrada en sidebar.

### P2 — Navegación, formularios, pulido

**9. Persona switcher: modelo desalineado entre Sidebar y Persona Landing.**
Pantalla: `navigation/roles.ts` define **5 roles** (reception/operations/asset/owner/all) pero `screens/operations/PersonaLandingScreen.tsx` declara **9 personas** ("8 personas operativas"). El `<select>` "Vista" (`Sidebar.tsx:857`) y la landing no cuentan la misma historia.
Fix: una sola fuente de verdad de personas; que la landing derive de `ROLES`. Si hay sub-personas (GM, night auditor…), modelarlas como homes dentro de un rol, no como roles paralelos.

**10. Persona switcher minimalista, baja discoverability.**
Pantalla: `Sidebar.tsx:857-874` — `<select>` nativo etiquetado "Vista", sin descripción de rol, sin icono/avatar, sin explicar que cambiar de vista reordena todo el menú y te lleva a otro home.
Fix: popover/segmented con label + descripción (ya existe `ROLES[].description`) y confirmación visual del cambio. Es una de las funciones más potentes del producto y está enterrada.

**11. Jerarquía de navegación profunda; subgrupos cerrados por defecto.**
Pantalla: `Sidebar.tsx:925` — `openSubgroups[key] === true` → subgrupos arrancan colapsados; 200+ items en grupos→subgrupos→items. Encontrar una pantalla concreta exige varios clics o depender del buscador.
Fix: abrir por defecto el subgrupo que contiene la pantalla activa; recientes/favoritos; y exponer el command palette (`CocoaCommandPalette` ya existe) como atajo primario de navegación.

**12. Validación de formularios no visible inline; errores solo por toast.**
Pantalla: `ReservationCreateScreen.tsx` marca required con `*` y da `hint`, pero al fallar el submit el error llega por `showToast(...,{variant:"error"})` (línea 564) sin `aria-invalid` ni mensaje junto al campo culpable. El usuario no sabe qué campo de 153 corregir.
Fix: validación inline por campo (borde + mensaje + `aria-invalid`), scroll-to-first-error, y deshabilitar/explicar el CTA hasta que el paso sea válido.

---

## Lo que está bien (no romper)

- **`components/States.tsx`**: primitivas de estado theme-aware y completas. Base correcta; falta adopción de skeletons.
- **Rate Grid** (`RateGridEditorScreen.tsx`): Cocoa nativo, toolbar clara, bulk-edit drawer, status bar, `ErrorState`/`LoadingBlock`. Patrón a replicar.
- **Quick Check-in** (`QuickCheckInDrawer.tsx`): flujo 90s monopágina con un solo CTA y cronómetro. Excelente reducción de fricción.
- **Dark mode**: ambos DS lo soportan (`styles.css:138` `[data-theme="dark"]` + `@media prefers-color-scheme`; `cocoa-tokens.css:220`). Cobertura sólida vía tokens.
- **RBAC + ocultación de placeholders en Sidebar**: items placeholder marcados y filtrados por persona evitan dead-ends para roles operativos (`Sidebar.tsx:20-23`).
- **Responsive**: `NarrowViewportBanner` (<700px) avisa con `aria-live`; grids usan `minmax(...,1fr)`. Estrategia "tablet/desktop-first" honesta, aunque no es mobile-first real.

## Observaciones de responsive / accesibilidad

- Uso intensivo de estilos inline (47 `style={{` solo en ReservationCreate) dificulta media queries y consistencia; preferir clases/tokens.
- A11y: el switcher de rol y los toggles de grupo tienen `aria-*` correctos. Falta `aria-invalid`/`aria-describedby` en formularios largos (ver hallazgo 12).

## Recomendación de secuencia

1. Vaciar datos demo (#2) — riesgo de datos. 2. Wizard de reserva (#3) + validación inline (#12). 3. Resolver stubs de config (#4/#5). 4. Unificar onboarding (#8) y modelo de personas (#9). 5. Migración progresiva Cocoa con lint-gate (#1). 6. Skeletons en data-heavy (#7).

**Score UX: 62/100.**
