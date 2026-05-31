# Sidebar Placeholder Audit

Fecha: 2026-05-30
Fuente: `apps/admin-web/src/navigation/Sidebar.tsx` (15 items con `placeholder: true`)
Referencia: `apps/admin-web/src/App.tsx` (registro `SCREEN_COMPONENTS` y `makeModulePlaceholder`)

## Resumen

De los 15 items marcados como `placeholder: true`, todos apuntan hoy a un
`makeModulePlaceholder(...)` (`ModuleSettingsPlaceholder` con CTA al dashboard
operativo). Tres items tienen pantalla real disponible y deberían dejar de ser
placeholders (cambio de `screen` key + remoción de la bandera). Los doce
restantes no tienen pantalla real construida y deben mantener el placeholder
pero recibir un horizonte (Q3'26 / Q4'26 / Q1'27) en el TODO.

## Tabla de auditoría

| # | Item (Sidebar.tsx) | `screen` actual | Target en App.tsx | ¿Hay screen real? | Acción recomendada | Horizonte |
|---|---|---|---|---|---|---|
| 1 | Ajustes de personal (L481) | `WorkforceSettings` | `WorkforceSettingsModule` (placeholder, CTA→`WorkforceDashboard` + `DepartmentSetupForm`) | NO. Sólo `WorkforceDashboard` (operativo) y `DepartmentSetupForm` (alta de departamentos). No hay screen real de políticas RR. HH. | Mantener placeholder | Q4'26 |
| 2 | Ajustes de seguridad (L483) | `SafetySettings` | `SafetySettingsModule` (placeholder, CTA→`SafetyDashboard`) | NO. `SafetyDashboard` es operativo (incidentes en vivo). No hay screen real de políticas de seguridad. | Mantener placeholder | Q4'26 |
| 3 | Ajustes de grupos (L503) | `GroupSettings` | `GroupSettingsModule` (placeholder, CTA→`GroupsEventsDashboard`) | NO. `GroupsEventsDashboard` es operativo (calendario y bloques). No existe screen de reglas de grupos. | Mantener placeholder | Q1'27 |
| 4 | Ajustes de eventos (L505) | `EventSpacesSettings` | `EventSpacesSettingsModule` (placeholder, CTA→`GroupsEventsDashboard`) | NO. Sin screen real de catálogo de espacios/recursos. | Mantener placeholder | Q1'27 |
| 5 | Ajustes de ventas (L507) | `SalesSettings` | `SalesSettingsModule` (placeholder, CTA→`SalesPipelineDashboard`) | NO. `SalesPipelineDashboard` es operativo. Sin screen real para configurar etapas / equipos comerciales. | Mantener placeholder | Q4'26 |
| 6 | Ajustes del portal del huésped (L509) | `GuestPortalSettings` | `GuestPortalSettingsModule` (placeholder) | **SÍ.** `screens/guest-portal/GuestPortalSettingsScreen.tsx` ya está registrada como `GuestPortalSettingsReal` en `SCREEN_COMPONENTS` (App.tsx L396). | **Eliminar `placeholder: true`** y cambiar `screen` a `GuestPortalSettingsReal` | inmediato |
| 7 | Ajustes de upsells (L511) | `UpsellSettings` (singular) | `UpsellSettingsModule` (placeholder) | **SÍ.** `screens/upsells/UpsellsSettingsScreen.tsx` está registrada como `UpsellsSettings` (plural, App.tsx L387). | **Eliminar `placeholder: true`** y cambiar `screen` a `UpsellsSettings` | inmediato |
| 8 | Ajustes de reputación (L513) | `ReputationSettings` | `ReputationSettingsModule` (placeholder, CTA→`ReputationDashboard`) | NO. `ReputationDashboard` es panel de KPIs (reviews agregadas). No hay screen de configuración de conectores/respuestas. | Mantener placeholder | Q3'26 |
| 9 | Ajustes de encuestas (L515) | `SurveySettings` | `SurveySettingsModule` (placeholder, CTA→`SurveysDashboard`) | Parcial. `SurveysNpsScreen` es un mix de configuración de plantillas y panel; no es estrictamente un settings screen. | Mantener placeholder; evaluar `SurveysNps` como redirección provisional | Q3'26 |
| 10 | Ajustes del flujo de calidad (L517) | `QualityWorkflowSettings` | `QualityWorkflowSettingsModule` (placeholder, CTA→`QualityDashboard`) | NO. `QualityCasesScreen` (`QualityCasesReal`) y `QualityDashboard` son operativos (casos vivos). | Mantener placeholder | Q4'26 |
| 11 | Ajustes de CRM (L519) | `CRMSettings` | `CRMSettingsModule` (placeholder) | NO. `GuestSegmentsScreen` (`GuestSegmentsReal`) y `CampaignManagerScreen` (`CampaignManagerReal`) cubren operación, no configuración estructural. | Mantener placeholder | Q4'26 |
| 12 | Ajustes de fidelización (L521) | `LoyaltySettings` | `LoyaltySettingsModule` (placeholder, CTA→`LoyaltyDashboard`) | Parcial. `LoyaltyProgramScreen` (`LoyaltyProgram`) configura tiers y ratio de puntos: es de facto una settings screen real. | **Eliminar `placeholder: true`** y cambiar `screen` a `LoyaltyProgram` | inmediato |
| 13 | Ajustes de compras (L536) | `ProcurementSettings` | `ProcurementSettingsModule` (placeholder, CTA→`ProcurementDashboard`) | NO. `ProcurementDashboard` es operativo. Sin screen real de reglas de aprobación / catálogo de proveedores. | Mantener placeholder | Q3'26 |
| 14 | Ajustes de inventario (L538) | `InventorySettings` | `InventorySettingsModule` (placeholder, CTA→`InventoryDashboard`) | Parcial. `FnbInventoryScreen` (`FnbInventory`) cubre F&B; no es global de inventario. `InventoryDashboard` es operativo. | Mantener placeholder | Q3'26 |
| 15 | Plataforma de desarrollador (L597) | `DeveloperPortal` | `DeveloperPortalModule` (placeholder, status `warn`) | Parcial. `DeveloperAppsScreen` (`DeveloperApps`), `WebhooksAdminScreen` (`WebhooksAdmin`), `ApiReferenceScreen` cubren áreas individuales pero no existe el hub. | Mantener placeholder; el hub debe agregar atajos a las 3 anteriores | Q3'26 |

## Resultados consolidados

### Items con pantalla real (3) — quitar `placeholder: true`

1. **Ajustes del portal del huésped** (Sidebar.tsx L509)
   - Cambio: `screen: "GuestPortalSettings"` → `screen: "GuestPortalSettingsReal"`, borrar `placeholder: true` y comentario TODO.
   - Riesgo: ninguno; la screen ya está cargada lazy en App.tsx.

2. **Ajustes de upsells** (Sidebar.tsx L511)
   - Cambio: `screen: "UpsellSettings"` → `screen: "UpsellsSettings"` (plural), borrar `placeholder: true` y comentario TODO.
   - Nota: el módulo placeholder `UpsellSettingsModule` queda huérfano una vez retirado el último consumidor; revisar si puede borrarse de App.tsx L276 / L542.

3. **Ajustes de fidelización** (Sidebar.tsx L521)
   - Cambio: `screen: "LoyaltySettings"` → `screen: "LoyaltyProgram"`, borrar `placeholder: true` y comentario TODO.
   - Confirmar con producto que `LoyaltyProgramScreen` cubre el alcance esperado (tiers + ratio + beneficios). Si más adelante se requiere un settings separado, restablecer.

### Items sin pantalla real (12) — mantener placeholder + añadir horizonte

Estos items deben conservar `placeholder: true` pero el comentario TODO en
Sidebar.tsx se enriquece con horizonte. Patrón sugerido:

```
// TODO(Q3'26): implementar screen ReputationSettings — placeholder visible solo para admin
```

Asignación propuesta:

- **Q3'26 (corto plazo, alta visibilidad)**: `ReputationSettings`, `SurveySettings`, `ProcurementSettings`, `InventorySettings`, `DeveloperPortal`.
- **Q4'26 (mediano plazo, dependiente de motor backend)**: `WorkforceSettings`, `SafetySettings`, `SalesSettings`, `QualityWorkflowSettings`, `CRMSettings`.
- **Q1'27 (largo plazo, depende de motor de grupos/eventos)**: `GroupSettings`, `EventSpacesSettings`.

## Diff sugerido (Sidebar.tsx)

```tsx
// L509 — antes
// TODO: implementar screen GuestPortalSettings — actualmente placeholder visible solo para admin
{ label: "Ajustes del portal del huésped", screen: "GuestPortalSettings", placeholder: true },
// L509 — después
{ label: "Ajustes del portal del huésped", screen: "GuestPortalSettingsReal" },

// L511 — antes
// TODO: implementar screen UpsellSettings — actualmente placeholder visible solo para admin
{ label: "Ajustes de upsells", screen: "UpsellSettings", placeholder: true },
// L511 — después
{ label: "Ajustes de upsells", screen: "UpsellsSettings" },

// L521 — antes
// TODO: implementar screen LoyaltySettings — actualmente placeholder visible solo para admin
{ label: "Ajustes de fidelización", screen: "LoyaltySettings", placeholder: true }
// L521 — después
{ label: "Ajustes de fidelización", screen: "LoyaltyProgram" }
```

Para los 12 restantes, sustituir el comentario `// TODO: implementar...` por
`// TODO(Q3'26|Q4'26|Q1'27): implementar...` con el horizonte de la sección
anterior. No se modifica `screen` ni se quita `placeholder: true`.

## Limpieza opcional en App.tsx

Tras aplicar los cambios, los módulos placeholder ya no referenciados pueden
borrarse:

- `UpsellSettingsModule` (App.tsx L276) y entrada `UpsellSettings: UpsellSettingsModule` (L542) — si nada más lo importa.
- `GuestPortalSettingsModule` (L274) y entrada `GuestPortalSettings` (L540) — verificar antes de borrar (puede ser referenciado por la zona móvil).
- `LoyaltySettingsModule` (L260) y entrada `LoyaltySettings` (L526) — idem.

Recomendado dejar la limpieza en App.tsx para un PR de seguimiento separado,
una vez verificado que ningún otro origen (deep links, settings hub, móvil)
sigue navegando a esas keys.

## Conclusiones

- 3 quick wins (`GuestPortalSettings`, `UpsellSettings`, `LoyaltySettings`) producen pantallas reales con cambio mínimo y sin riesgo.
- 12 placeholders permanecen, pero el TODO debe pasar de genérico a un horizonte planificado para evitar deuda silenciosa.
- La discrepancia `UpsellSettings` (singular) vs `UpsellsSettings` (plural) ya generó un fix por desalineación de nombres; vale la pena estandarizar a plural en todo el código.
