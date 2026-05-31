# Placeholder Cleanup Plan — `apps/admin-web/src/App.tsx`

**Fecha:** 2026-05-30
**Objetivo:** Reducir el número de `makeModulePlaceholder` activos en `App.tsx` desde el inventario actual hasta el target Q3 (≤ 50 globales).
**Alcance:** Sólo los 48 placeholders declarados en `App.tsx` (líneas 257–304). Otros dead-ends fuera de este archivo se tratan en `APP-DISCOVERABILITY-AUDIT.md`.

## Nota sobre el conteo

El brief habla de **64 placeholders globales**. En `App.tsx` hay únicamente **48 llamadas a `makeModulePlaceholder`** (líneas 257-304) más 1 `import` (línea 19). Los 16 restantes corresponden a placeholders fuera de `App.tsx` (rutas dentro de sub-screens y módulos compañeros) y quedan fuera del ámbito de este plan. Reducir 14 aquí dejaría el global en **64 − 14 = 50**, exactamente el target Q3.

## Cómo se ha clasificado cada placeholder

Todos los `dashboardScreen` y `setupScreen` referenciados son **strings** que se resuelven en el registry interno de `App.tsx` (`SCREEN_REGISTRY`, líneas 420-510). Por tanto, "target real" no significa que exista un archivo con ese nombre exacto, sino que el registry mapea ese string a un componente real ya lazy-importado. Comprobaciones realizadas:

- `CrmDashboard`, `LoyaltyDashboard`, `SalesPipelineDashboard`, `GroupsEventsDashboard`, `WorkforceDashboard`, `ProcurementDashboard`, `InventoryDashboard`, `GuestJourneyWorkspace`, `UpsellsDashboard`, `ReputationDashboard`, `SurveysDashboard`, `QualityDashboard`, `EnergyDashboard`, `SustainabilityDashboard`, `SafetyDashboard`, `AnalyticsCenterDashboard`, `AuditLogViewer`, `AISettings` — existen archivos físicos en `/screens/`.
- `RevenueDataQuality` → mapeado a `RevenueDataQualityScreen` (App.tsx:496).
- `ReportingCenter` → mapeado a `ReportingCenterScreen` (App.tsx:448).
- `PropertyProfileSetupForm`, `DepartmentSetupForm` → exportados desde `screens/propertySetup/PropertySetupForms.tsx` (App.tsx:213/220).
- `AISetupCenter` → mapeado a `AISetupCenterScreen` (App.tsx:503).

**Conclusión:** los 48 placeholders apuntan, sin excepción, a un componente real que el usuario puede abrir. La pregunta del cleanup no es "¿existe el target?" sino "¿el placeholder aporta valor sobre un redirect directo al dashboard?".

## Criterios de acción

- **Replace (R):** el placeholder no aporta UI propia más allá de un CTA "Abrir tablero X". Cualquier ruta del módulo puede redirigir directamente al `dashboardScreen`. Se sustituye por un re-export lazy del dashboard o por una redirección en el router.
- **Keep-Intentional (K):** módulo en construcción real con compromiso de release antes de Q4 2026 (eyebrow por defecto "Próximamente · Q4 2026"). Mantener pero documentar fecha objetivo en `relatedScreens` o `summary`.
- **Remove (X):** el módulo no aparece en la navegación, está duplicado, o es un sub-ítem que sólo el dashboard padre necesita.

## Tabla de placeholders

| #  | Module                              | DashboardScreen           | Status               | Action                                              |
|----|-------------------------------------|---------------------------|----------------------|-----------------------------------------------------|
| 1  | CRM                                 | CrmDashboard              | real screen exists   | Replace placeholder with redirect to `CrmDashboard` |
| 2  | Segmentos de huéspedes              | CrmDashboard              | real screen exists   | Remove (subnodo redundante de CRM)                  |
| 3  | Campañas                            | CrmDashboard              | real screen exists   | Replace with lazy `CampaignManagerScreen` cuando exista; mantener hasta Q4 |
| 4  | Fidelización                        | LoyaltyDashboard          | real screen exists   | Replace placeholder with redirect to `LoyaltyDashboard` |
| 5  | Revisión de duplicados              | CrmDashboard              | real screen exists   | Remove (sub-flujo, se accede desde CRM)             |
| 6  | Pipeline de ventas                  | SalesPipelineDashboard    | real screen exists   | Replace with redirect                               |
| 7  | Cuentas corporativas                | SalesPipelineDashboard    | real screen exists   | Remove (subnodo del pipeline)                       |
| 8  | Grupos                              | GroupsEventsDashboard     | real screen exists   | Replace with redirect                               |
| 9  | Espacios para eventos               | GroupsEventsDashboard     | real screen exists   | Remove (subnodo del workspace de eventos)           |
| 10 | Ajustes de ventas                   | SalesPipelineDashboard    | intentional Q4 2026  | Keep — apunta a settings nuevos                     |
| 11 | Personal                            | WorkforceDashboard        | real screen exists   | Replace with redirect                               |
| 12 | Reglas de turnos                    | WorkforceDashboard        | intentional Q4 2026  | Keep — feature pendiente                            |
| 13 | Exportación de nóminas              | WorkforceDashboard        | intentional Q4 2026  | Keep — pendiente integración payroll                |
| 14 | Proveedores                         | ProcurementDashboard      | real screen exists   | Replace with redirect                               |
| 15 | Inventario                          | InventoryDashboard        | real screen exists   | Replace with redirect                               |
| 16 | Compras                             | ProcurementDashboard      | real screen exists   | Replace with redirect                               |
| 17 | Reglas de compras                   | ProcurementDashboard      | intentional Q4 2026  | Keep                                                |
| 18 | Portal del huésped                  | GuestJourneyWorkspace     | real screen exists   | Replace with redirect                               |
| 19 | Kiosco                              | GuestJourneyWorkspace     | real screen exists   | Replace with redirect                               |
| 20 | Ventas adicionales (upsell)         | UpsellsDashboard          | real screen exists   | Replace with redirect                               |
| 21 | Llave digital                       | GuestJourneyWorkspace     | intentional Q4 2026  | Keep — feature en desarrollo                        |
| 22 | Reputación                          | ReputationDashboard       | real screen exists   | Replace with redirect                               |
| 23 | Encuestas                           | SurveysDashboard          | real screen exists   | Replace with redirect                               |
| 24 | Flujo de calidad                    | QualityDashboard          | intentional Q4 2026  | Keep — workflow editor pendiente                    |
| 25 | Energía                             | EnergyDashboard           | real screen exists   | Replace with redirect                               |
| 26 | Contadores                          | EnergyDashboard           | intentional Q4 2026  | Keep — UI específica de meters pendiente            |
| 27 | Sostenibilidad                      | SustainabilityDashboard   | real screen exists   | Replace with redirect                               |
| 28 | Seguridad                           | SafetyDashboard           | real screen exists   | Replace with redirect                               |
| 29 | Incidentes                          | SafetyDashboard           | real screen exists   | Remove (subnodo del Safety dashboard)               |
| 30 | Flujo de incidentes                 | SafetyDashboard           | intentional Q4 2026  | Keep — workflow pendiente                           |
| 31 | Contactos de emergencia             | SafetyDashboard           | intentional Q4 2026  | Keep — UI dedicada en roadmap                       |
| 32 | Analítica                           | AnalyticsCenterDashboard  | real screen exists   | Replace with redirect                               |
| 33 | Definiciones de métricas            | AnalyticsCenterDashboard  | intentional Q4 2026  | Keep — semantic layer pendiente                     |
| 34 | Informes programados                | AnalyticsCenterDashboard  | intentional Q4 2026  | Keep — scheduler pendiente                          |
| 35 | Calidad de datos                    | RevenueDataQuality        | real screen exists   | Replace with redirect                               |
| 36 | Plataforma de desarrollador         | AuditLogViewer            | intentional Q4 2026  | Keep — marcado `status: warn / vista previa`        |
| 37 | Apps de API                         | AuditLogViewer            | intentional Q4 2026  | Keep — `vista previa`                               |
| 38 | Webhooks                            | AuditLogViewer            | intentional Q4 2026  | Keep — `vista previa`                               |
| 39 | Suscripciones de webhooks           | AuditLogViewer            | intentional Q4 2026  | Keep — `vista previa`                               |
| 40 | Registros de uso de API             | AuditLogViewer            | real screen exists   | Replace with redirect                               |
| 41 | Certificación de partners           | AuditLogViewer            | intentional Q4 2026  | Keep — `vista previa`                               |
| 42 | Gobernanza de IA                    | AISettings                | real screen exists   | Replace with redirect to `AISettings`               |
| 43 | Catálogo de herramientas de IA      | (sólo setupScreen)        | intentional Q4 2026  | Keep — sin dashboard real, sólo wizard              |
| 44 | Versiones de prompts de IA          | (sólo setupScreen)        | intentional Q4 2026  | Keep                                                |
| 45 | Evaluaciones de IA                  | (sólo setupScreen)        | intentional Q4 2026  | Keep                                                |
| 46 | Registro de incidentes de IA        | AuditLogViewer            | intentional Q4 2026  | Keep                                                |
| 47 | Cola de revisión humana             | (sólo setupScreen)        | intentional Q4 2026  | Keep                                                |
| 48 | Costes de IA                        | AnalyticsCenterDashboard  | real screen exists   | Replace with redirect                               |

## Resumen

| Categoría                             | Cantidad |
|---------------------------------------|---------:|
| **Replace** (redirect directo al dashboard real)         | 20       |
| **Remove** (subnodos redundantes o duplicados)           | 5        |
| **Keep** (intencional Q4 2026 o feature en construcción) | 23       |
| **Total auditado**                                       | **48**   |

### Reducción esperada
- Eliminaciones puras: **5** (#2, #5, #7, #9, #29).
- Sustituciones por redirect (siguen contando como navegables, pero ya no como `makeModulePlaceholder`): **20**.
- Permanecen como placeholder explícito hasta Q4 2026: **23**.

**Resultado neto:** 48 − (20 + 5) = **23 placeholders activos** en `App.tsx`. Combinado con los ~16 placeholders externos no auditados aquí, el inventario global queda en **23 + 16 = 39**, **por debajo del target Q3 de 50**.

Si se prefiere una intervención más conservadora, basta con eliminar/sustituir los 14 placeholders de mayor impacto (los 9 primeros `Replace` con `real screen exists` puro + las 5 eliminaciones) para alcanzar exactamente **64 − 14 = 50**.

## Recomendaciones de implementación

1. **Crear helper `redirectToDashboard(screen, label)`** en `ModuleSettingsPlaceholder.tsx` que dispare `hotelos-nav` al montar, evitando que el usuario vea la pantalla intermedia. Aplicar a los 20 `Replace`.
2. **Auditar la navegación lateral** (`src/components/Navigation*.tsx`) y retirar entradas para los 5 `Remove` antes de borrar el `const`.
3. **Documentar fecha objetivo** en los 23 `Keep`: añadir `eyebrow: "Próximamente · Q4 2026"` explícitamente (hoy se hereda por defecto) y `summary` describiendo la feature concreta. Esto evita que la auditoría siguiente los marque como "stale".
4. **Añadir test de regresión** que verifique `grep -c 'makeModulePlaceholder' App.tsx <= 25` para impedir crecimiento.
