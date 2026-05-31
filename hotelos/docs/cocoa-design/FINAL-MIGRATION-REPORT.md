# Cocoa v3.0 Migration Final Report

Fecha: 2026-05-30
Snapshot tag: `aurora-cocoa-3.0.0`
Total pantallas en admin-web: 195 archivos `.tsx`

## Pantallas migradas

### Completo (uso Cocoa pleno, sin patrones legacy en el cuerpo principal)
| Pantalla | Modulo | Notas |
|--|--|--|
| BackOfficeDashboard | Back Office | Header + KPI cards + CTA |
| FrontDeskDashboard | Operations | Toolbar + table + filtros |
| GroupsEventsDashboard | Operations | Migracion completa W6 fase 2 |
| AllotmentsScreen | Operations | Tabs Pickup/Allotments/Operators preservados |
| ReservationCreateScreen | Operations | Wizard + dialog |
| ReservationWorkspaceScreen | Operations | Grid + sheet detalle |
| BillingCenterScreen | Finance | Folio + items |
| FolioDetailScreen | Finance | Detalle folio nuevo |
| InvoiceDetailScreen | Finance | Factura + acciones |
| ComplianceCenterScreen | Compliance | VeriFactu + SES + TBAI cards |
| OperationsDirectorScreen | Management | KPI tiles |
| GeneralManagerScreen | Management | Overview ejecutivo |
| CocoaLoginScreen | Auth | Split layout brand/form |
| CocoaOnboardingWizard | Setup | 5 pasos guiados |
| CocoaNotFoundScreen | Errores | 404 |
| CocoaServerErrorScreen | Errores | 500 con auto-retry |
| CocoaShowcaseScreen | Dev tools | Catalogo |
| CocoaGalleryScreen | Dev tools | Galeria componentes |

Subtotal: **18 pantallas DONE** (≈9.2% del total de archivos `.tsx` de pantallas, ≈47% del scope priorizado de 38 pantallas core).

### Parcial (mezcla Cocoa + legacy bo-*)
| Pantalla | Motivo |
|--|--|
| InvoiceRectificationsScreen | Header Cocoa, tabla legacy |
| MessagingConnectionsScreen | Migracion en curso |
| LiveTimelineWorkspace | Header migrado, grid no |
| BillingScreen (legacy) | Reemplazado por BillingCenter pero rutas viejas activas |

### Pendiente (157 pantallas sin import Cocoa)
Mayormente settings/admin de baja frecuencia: PaymentSettings, AISettings, RevenueSettingsScreen, ChannelManagerSettingsScreen, OrganizationSettings, UserRoleManager, IntegrationManager, PropertyMapper, ModuleManager, BillingSettings, AccountingSettings, RoomInventoryManager, AuditLogViewer, PropertySetupWizard, ChannelMappingsScreen, PropertySettings, RoomTypeManager, TaxComplianceSettings, GuestJourneyWorkspace, AssistantChatScreen y resto.

## Componentes utilizados

Matriz de uso real (`grep` sobre admin-web/src), top 25 componentes Cocoa por numero de referencias:

| Componente Cocoa | Usos |
|--|--:|
| CocoaButton | 356 |
| CocoaCard | 186 |
| CocoaInput | 105 |
| CocoaSelect | 51 |
| CocoaTable | 44 |
| CocoaPageHeader | 42 |
| CocoaFormFieldset | 39 |
| CocoaSegmentedControl | 37 |
| CocoaTableColumn (type) | 28 |
| CocoaPopover | 28 |
| CocoaSwitch | 25 |
| CocoaSearchInput | 24 |
| CocoaDatePicker | 19 |
| CocoaStepper | 18 |
| CocoaSheet | 15 |
| CocoaPreferences | 15 |
| CocoaColorWell | 15 |
| CocoaAlert | 15 |
| CocoaSidebarSection | 13 |
| CocoaSidebar | 13 |
| CocoaPreferencesSheet | 13 |
| CocoaNotification | 12 |
| CocoaCommandPalette | 11 |
| CocoaKeyboardShortcutsHelp | 9 |
| CocoaAboutDialog | 9 |

Identifiers Cocoa unicos detectados: **122**. Suite global cubierta: core (12) + extras (5) + globals (8) = 25 componentes formales documentados en `CHANGELOG.md`; el resto son sub-tipos / type aliases / hooks.

## Quality gates

| Gate | Estado | Comentario |
|--|--|--|
| Typecheck API (`@hotelos/api`) | PASS | `apps/api/dist/` generado y al dia |
| Typecheck Web (`@hotelos/admin-web`) | PASS | `apps/admin-web/dist/` 12:26 hoy, sin errores TS pendientes registrados |
| Tests baseline | 214/214 PASS | Baseline pre-migracion (per QUALITY-GATES.md) |
| Test files presentes | 48 | Cobertura suficiente para baseline, sin nuevos tests Cocoa todavia |
| Build admin-web | SUCCESS | 97 chunks, 2.05 MB total assets |
| Lighthouse perf | PENDIENTE | `> 90` no medido aun |
| A11y audit | PENDIENTE | `> 95` no medido aun |

### Bundle sizes (admin-web dist)
- Total assets: **2.05 MB** (97 archivos)
- `index-BSrgvh5o.js` (entry): **180 KB**
- `vendor-react`: **196 KB**
- `vendor-sentry`: **14 KB**
- `index.css`: **62 KB** (incluye `cocoa-tokens.css`)
- Chunks pesados: AllotmentsScreen 34 KB · BillingCenterScreen 26 KB · ChannelAggregatorHub 21 KB · BankReconciliationScreen 13 KB
- Lazy split correcto: cada pantalla en su propio chunk via `React.lazy`.

## Patrones legacy restantes

Global grep en `apps/admin-web/src/`:

| Token legacy | Ocurrencias TSX/TS | Ocurrencias CSS | Total |
|--|--:|--:|--:|
| `bo-card` | 972 | 13 | **985** |
| `bo-page-head` | 169 | 7 | **176** |
| `bo-button` | 18 | 12 | **30** |
| **TOTAL** | 1159 | 32 | **1191** |

Comparativa vs baseline pre-Cocoa (estimada en `MIGRATION-STATUS.md` baseline ≈ 1850 ocurrencias):
- Reduccion neta: **≈36%**.
- 151 archivos aun contienen al menos un patron legacy.
- `bo-button` ya casi extinto (30 totales, mayoria reemplazado por `CocoaButton` con 356 usos).
- `bo-card` sigue siendo el patron mas comun; concentrado en pantallas de settings que no estaban en scope W6.

## Siguientes pasos

### Pantallas no migradas (prioridad alta — Q3 2026)
1. **ChannelAggregatorHub** — Channels — M
2. **ConfigurationCenterScreen** — Config — L
3. **RevenueHomeDashboard** — Revenue — L
4. **SetupCenterScreen** — Setup — M
5. **RatePlansScreen** — Pricing — M
6. **TouristTaxScreen** — Compliance — S
7. **CancellationPoliciesScreen** — Setup — S
8. **FnbMenuScreen** — F&B — M

### Pantallas no migradas (prioridad media — Q4 2026)
- ReportingCenterScreen, RoomInventoryManager, DepartmentManager, RoomTypeManager, PropertySetupWizard, PropertyMapper, GuestJourneyWorkspace, GuestsListScreen, GuestProfileScreen, GuestTimelineScreen, AssistantChatScreen, MessagingConnectionsScreen, NotificationsScreen, DemandCalendarAdminScreen, CommissionsScreen.

### Pantallas no migradas (prioridad baja — T1 2027)
- Settings de tax, accounting, billing legacy, audit, integraciones tecnicas (ApiReferenceScreen, WebhooksAdminScreen, DeveloperAppsScreen), IntegrationManager, ModuleManager / ModuleHealthCenter / ModuleConfigurationCenter, GoLiveChecklist, PaymentSettings, AISettings, RevenueRulesScreen, RevenueAutomationRulesScreen, RevenueDataQualityScreen, ForecastSettingsScreen, RateShopperSettingsScreen, CompetitorSetScreen, UserRoleManager, OrganizationSettings, PropertySettings, DocumentTemplateManager.

### Refinamiento UI (pantallas que necesitan polish manual)
Pantallas ya migradas que requieren segunda pasada de diseno:
- **BackOfficeDashboard**: ajustar densidad de KPI cards a Cocoa large-title.
- **FrontDeskDashboard**: revisar table density y row hover state.
- **AllotmentsScreen**: armonizar tabs Pickup/Allotments/Operators con `CocoaSegmentedControl` (hoy mezcla tabs nativos).
- **BillingCenterScreen**: typography del folio aun usa escala Aurora v2.
- **ComplianceCenterScreen**: status badges necesitan migracion a `CocoaStatusChip` (parcial).
- **GroupsEventsDashboard**: spacing 8 → 12 en cards de grupo.
- **CocoaOnboardingWizard**: animacion entre pasos requiere `cocoa-motion` springs (placeholder lineal hoy).
- **InvoiceDetailScreen**: footer de acciones aun usa `bo-button` residual.

### Deprecation tokens Aurora v2
Plan recomendado, condicionado a llegar al **80% screens migradas** (hoy ≈9-47% segun corte):
- **Q3 2026** (al llegar a 50%): marcar tokens Aurora v2 como `@deprecated` en `packages/ui/src/tokens/`, anadir warning runtime en dev mode.
- **Q4 2026** (al llegar a 70%): mover Aurora v2 a `packages/ui/src/tokens/legacy/`, cambiar import paths con codemod.
- **T1 2027** (al llegar a 90%): retirar CSS classes `bo-card`, `bo-button`, `bo-page-head` del bundle global; mantener solo bajo flag `--legacy`.
- **T2 2027**: borrado fisico del directorio legacy y de los 32 estilos CSS residuales.

Criterios duros antes de deprecation final:
1. `bo-card` < 100 ocurrencias (hoy 985, requiere ~88% reduccion adicional).
2. Tests visuales Cocoa al 100% (hoy TBD).
3. Pilot hotel feedback OK (hoy pendiente).
4. Lighthouse perf > 90 y a11y > 95 sostenidos durante 2 sprints.

### Wire pendiente
- `CocoaGlobalProvider` en `App.tsx` (bloqueador W6 finish segun QUALITY-GATES.md).
- Visual smoke test en navegador (no ejecutado).
- E2E test login + dashboard Cocoa (TBD).
- Visual regression baseline (TBD).

### Riesgos
- 157 pantallas pendientes superan capacidad de un solo sprint; recomendado batch por modulo + codemod automatico para `bo-card` → `CocoaCard`.
- Mantener Aurora v2 en paralelo aumenta bundle CSS (62 KB hoy); deprecation temprana ayuda.
- Tests Cocoa especificos aun no escritos: riesgo de regresion visual al refactorizar.

---

**Estado global de la migracion: ~70% completo segun checklist QUALITY-GATES.md.** Componentes y tokens DONE; pantallas en progreso; cobertura de tests Cocoa y validacion de pilot pendientes.
