# Cocoa migration master index

## Pantallas con plan detallado
- 01-FrontDeskDashboard.md
- 02-GroupsEventsDashboard.md
- 03-AllotmentsScreen.md
- 04-Reservations.md
- 05-Billing.md
- 06-ComplianceCenter.md
- 07-Management.md

## Orden recomendado de migracion
1. FrontDesk (highest visibility - landing page)
2. ComplianceCenter (diferenciador comercial)
3. GroupsEventsDashboard (demo wow factor)
4. AllotmentsScreen (revenue management)
5. Reservations (uso diario)
6. Billing/Folio (financiero)
7. Management (Gerencia)

## Patrones comunes a aplicar
- bo-page-head → CocoaPageHeader (todas)
- rev-kpi-grid → grid de CocoaCard con StatTile
- bo-card → CocoaCard
- cm-table → CocoaTable
- bo-button primary → CocoaButton variant='filled' tone='accent'
- bo-button ghost → CocoaButton variant='plain'
- inline emoji icons → cocoa-icons componentes
- bo-page-eyebrow → CocoaPageHeader eyebrow prop

## Tokens a reemplazar globalmente
- var(--ink) → var(--cocoa-label)
- var(--surface) → var(--cocoa-background-content)
- var(--accent) → var(--cocoa-accent)
- var(--space-N) → var(--cocoa-space-N)
- var(--radius-N) → var(--cocoa-radius-N)

## Estrategia
Paso 1: migrar shell macro (Toolbar + Sidebar + Layout) — afecta a todo
Paso 2: migrar 7 pantallas en orden de prioridad
Paso 3: cleanup de Aurora v2 classes obsoletas (despues de verificar todo OK)
