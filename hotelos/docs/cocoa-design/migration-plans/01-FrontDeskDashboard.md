# FrontDeskDashboard migration plan

Pantalla: `apps/admin-web/src/screens/operations/FrontDeskDashboard.tsx`
Origen: Aurora v2 (bo-*, rev-*, cm-*) + estilos inline.
Destino: Cocoa Design System (CocoaCard, CocoaButton, CocoaTable, StatTile, CocoaPageHeader, cocoa-icons, tokens `--cocoa-*`).

Este plan cubre las primeras 200 lineas analizadas. Las lineas posteriores (tabs de arrivals/departures/inHouse/unassigned y tablas) tienen patrones equivalentes y se migran con las mismas reglas.

## Mapeo de componentes

| Linea actual | Patron Aurora detectado | Componente Cocoa equivalente |
|--|--|--|
| 124 | `<span className="bo-status {kind}">` (pill helper) | `<CocoaBadge tone={kind} />` o `<CocoaPill tone={kind} />` |
| 130-136 | `statusPill` / `balancePill` (helpers que devuelven `bo-status`) | Helpers que devuelven `<CocoaBadge tone="success|warning|danger|info" />` |
| 166 | `<article className="bo-card">` | `<CocoaCard variant="highlight">` |
| 167-171 | inline style `background: var(--surface)` + `borderLeft: 4px solid var(--accent)` + `padding: 32px` | Eliminar inline; usar prop `accent="primary"` en `CocoaCard` + token de padding `--cocoa-spacing-xl` |
| 173 | `<div className="bo-page-eyebrow">` | `eyebrow` prop de `CocoaPageHeader` o `<CocoaEyebrow>` |
| 174 | `<h2 className="bo-page-title">` + inline `marginTop: 8` | `<CocoaHeading level={2}>` (margen por token) |
| 177 | `<p className="bo-page-subtitle">` + inline `marginBottom: 20` | `<CocoaText variant="subtitle">` (margen por token) |
| 181 | `<div style={{display:'flex', flexWrap:'wrap', gap:10}}>` | `<CocoaStack direction="row" wrap gap="sm">` o `<CocoaChipGroup>` |
| 183-200 | `<button className="bo-chip">` con inline border/background/padding/font | `<CocoaChip onClick=... icon=...>` (los pasos numerados pasan a `index` prop) |
| (no leido) ~210+ esperado `bo-page-head` + `bo-page-title` + acciones | `<CocoaPageHeader eyebrow="Operations" title="Front Desk" actions={...} />` |
| (no leido) ~230+ esperado `rev-kpi-grid` con 6 KPIs (`Kpis` type lineas 12-19) | `<CocoaGrid columns={{base:1, md:3, lg:6}}>` con 6 `<CocoaCard><StatTile/></CocoaCard>` |
| (no leido) ~300+ esperado `cm-table` para arrivals/departures/inHouse/unassigned | `<CocoaTable columns={...} rows={...} />` con `<CocoaTableHeader>` |
| (no leido) emoji icons en chips/acciones | Reemplazar por `<CocoaIcon name="..." />` desde `@hotelos/cocoa-icons` |

## Cambios necesarios

1. **Imports**: anadir `import { CocoaCard, CocoaPageHeader, CocoaBadge, CocoaChip, CocoaChipGroup, CocoaStack, CocoaHeading, CocoaText, CocoaGrid, StatTile, CocoaTable, CocoaButton } from '@hotelos/cocoa-ui';` y `import { CocoaIcon } from '@hotelos/cocoa-icons';`. Eliminar dependencias visuales a clases globales `bo-*`.

2. **Helper `pill` (linea 123-125)**: reemplazar por:
   ```tsx
   function pill(kind: StatusKind, label: string) {
     const tone = kind === 'ok' ? 'success' : kind === 'warn' ? 'warning' : kind === 'error' ? 'danger' : 'info';
     return <CocoaBadge tone={tone}>{label}</CocoaBadge>;
   }
   ```
   Mantener firma para no romper `statusPill`/`balancePill`.

3. **`FirstRunWelcomeCard` (lineas 163-201)**: reescribir como:
   ```tsx
   <CocoaCard variant="accent" accent="primary" padding="xl">
     <CocoaEyebrow>Bienvenido a HotelOS</CocoaEyebrow>
     <CocoaHeading level={2}>Configura tu hotel en 4 pasos</CocoaHeading>
     <CocoaText variant="subtitle">Empieza por dar de alta tu inventario...</CocoaText>
     <CocoaChipGroup>
       {FIRST_RUN_STEPS.map(step => (
         <CocoaChip key={step.screen} onClick={() => navigateTo(step.screen)} title={`Ir a ${step.label}`}>
           {step.label}
         </CocoaChip>
       ))}
     </CocoaChipGroup>
   </CocoaCard>
   ```
   Eliminar todos los `style={{...}}` inline. El `borderLeft` accent se logra con prop `accent="primary"` en CocoaCard.

4. **Cabecera de pagina** (zona no leida, ~linea 210+): sustituir bloque `bo-page-head` + `bo-page-title` + `bo-page-subtitle` por:
   ```tsx
   <CocoaPageHeader
     eyebrow="Operations"
     title="Front Desk"
     subtitle={`${greeting()} · ${todayLabel()}`}
     actions={
       <CocoaStack direction="row" gap="sm">
         <CocoaButton variant="secondary" icon={<CocoaIcon name="search" />} onClick={openSearch}>Buscar</CocoaButton>
         <CocoaButton variant="primary" icon={<CocoaIcon name="user-plus" />} onClick={() => setCheckInOpen(true)}>Check-in</CocoaButton>
         <CocoaButton variant="secondary" icon={<CocoaIcon name="user-minus" />} onClick={() => setCheckOutOpen(true)}>Check-out</CocoaButton>
       </CocoaStack>
     }
   />
   ```

5. **KPI grid (`rev-kpi-grid` esperado)**: sustituir por:
   ```tsx
   <CocoaGrid columns={{ base: 1, sm: 2, md: 3, lg: 6 }} gap="md">
     <CocoaCard><StatTile label="Llegadas hoy" value={fmtNumber(kpis.arrivalsToday)} icon="arrow-down-right" /></CocoaCard>
     <CocoaCard><StatTile label="Salidas hoy" value={fmtNumber(kpis.departuresToday)} icon="arrow-up-right" /></CocoaCard>
     <CocoaCard><StatTile label="In-house" value={fmtNumber(kpis.inHouseNow)} icon="bed" /></CocoaCard>
     <CocoaCard><StatTile label="Sin asignar" value={fmtNumber(kpis.unassignedRooms)} tone={kpis.unassignedRooms > 0 ? 'warning' : 'default'} icon="alert-triangle" /></CocoaCard>
     <CocoaCard><StatTile label="Late check-out" value={fmtNumber(kpis.overdueDepartures)} tone={kpis.overdueDepartures > 0 ? 'danger' : 'default'} icon="clock" /></CocoaCard>
     <CocoaCard><StatTile label="Saldo pendiente" value={fmtEur(kpis.pendingBalanceEur)} icon="euro" /></CocoaCard>
   </CocoaGrid>
   ```

6. **Tablas (`cm-table` esperado en tabs)**: cada `<table className="cm-table">` pasa a `<CocoaTable columns={[...]} rows={...} emptyState={<EmptyState .../>} />`. Las celdas que ahora son `statusPill`/`balancePill` siguen funcionando porque devuelven `CocoaBadge`.

7. **Botones de accion en filas** (esperados: "Check-in", "Asignar", "Cobrar"): `<button className="bo-button">` → `<CocoaButton size="sm" variant="ghost">`.

8. **Iconos emoji**: cualquier emoji literal en strings o JSX (e.g. `🏨`, `🛏️`, `💶`) pasa a `<CocoaIcon name="..." />`. Mapeos: 🏨→`hotel`, 🛏️→`bed`, 💶→`euro`, ✅→`check`, ⚠️→`alert-triangle`, ⏰→`clock`, 👤→`user`.

## Tokens a reemplazar

| Token Aurora | Token Cocoa |
|--|--|
| `var(--surface)` | `var(--cocoa-background-content)` |
| `var(--surface-alt)` | `var(--cocoa-background-base)` |
| `var(--ink)` | `var(--cocoa-label)` |
| `var(--ink-muted)` / `var(--muted)` | `var(--cocoa-label-secondary)` |
| `var(--border)` | `var(--cocoa-separator)` |
| `var(--accent)` | `var(--cocoa-tint-primary)` |
| `var(--accent-soft)` | `var(--cocoa-tint-primary-subtle)` |
| `var(--success)` | `var(--cocoa-system-green)` |
| `var(--warn)` / `var(--warning)` | `var(--cocoa-system-orange)` |
| `var(--danger)` / `var(--error)` | `var(--cocoa-system-red)` |
| `var(--info)` | `var(--cocoa-system-blue)` |
| literales `padding: "32px"` | `padding="xl"` prop o `var(--cocoa-spacing-xl)` |
| literales `gap: 10`, `marginTop: 8`, `marginBottom: 20` | tokens `--cocoa-spacing-{xs,sm,md,lg}` via props de `CocoaStack`/`CocoaCard` |
| literales `fontSize: 14`, `fontWeight: 500` | tipografia Cocoa via `CocoaText`/`CocoaChip` (no inline) |
| `borderLeft: "4px solid var(--accent)"` | prop `accent="primary"` en `CocoaCard` |

Regla: tras la migracion, **cero `style={{...}}` inline** en el archivo salvo casos justificados (grid templates dinamicos). Todo color/spacing/typography pasa por props o tokens `--cocoa-*`.

## Riesgo

**Medium**. Razones:
- La pantalla es operativa critica (recepcion) y combina KPIs, 4 tabs con tablas, drawers (`QuickCheckInDrawer`, `QuickCheckOutDrawer`), `FrontDeskActionQueue` y exportacion CSV. Hay que preservar comportamiento (navegacion via `hotelos-nav` event, `openSearch`, `exportToCsv`).
- Los helpers `pill`/`statusPill`/`balancePill` se usan dentro de columnas de tabla; el cambio a `CocoaBadge` debe ser API-compatible (return `ReactNode`).
- Dependencia de subcomponentes (`FrontDeskActionQueue`, drawers) que pueden seguir en Aurora v2 hasta su propia migracion; coexistencia visual a vigilar.
- Sin tests visuales conocidos en este archivo → riesgo de regresion en espaciados/colores.

Mitigacion: migrar por bloques (header, KPIs, welcome card, cada tab) con commit por bloque; snapshot manual antes/despues; verificar `getActiveProperty()` sigue resolviendo.

## Estimacion

- **Agents**: 2 agentes en paralelo.
  - Agent A: header + welcome card + KPI grid + helpers (`pill`) + imports/tokens. ~150 lineas tocadas.
  - Agent B: 4 tabs con `CocoaTable` (arrivals, departures, inHouse, unassigned) + botones de accion + iconos. ~400 lineas tocadas.
- **Tiempo estimado**: 45-60 min Agent A, 75-90 min Agent B, 20 min revision conjunta + ajuste de tokens residuales. Total **~2,5-3 h** wall-clock con paralelizacion.
- **Bloqueantes potenciales**: que `CocoaPageHeader`, `StatTile`, `CocoaChipGroup`, `CocoaTable` ya existan en `@hotelos/cocoa-ui`. Si falta `CocoaChipGroup`, Agent A debe crearlo antes (suma ~30 min).

Orden recomendado: Agent A primero (deja imports y helpers listos), luego Agent B sobre la base ya importada.
