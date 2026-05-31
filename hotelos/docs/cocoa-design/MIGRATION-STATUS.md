# Cocoa Migration Status

Ultima actualizacion: 2026-05-30

## Resumen
Total pantallas en la app: ~38
Migradas a Cocoa: 8
Porcentaje completo: 21%

## Pantallas migradas (W6 + manual)
| Screen | Modulo | Status | Notas |
|--|--|--|--|
| BackOfficeDashboard | Back Office | DONE | header + cards + cta |
| FrontDeskScreen | Operations | DONE (W6 phase 2) | toolbar + table |
| GroupsScreen | Operations | DONE (W6 phase 2) | full Cocoa |
| AllotmentsScreen | Operations | DONE (W6 phase 2) | preserva tabs Pickup/Allotments/Operators |
| ReservationsScreen | Operations | DONE (W6 phase 2) | grid + dialog |
| BillingScreen | Finance | DONE (W6 phase 2) | folio + items |
| ComplianceCenterScreen | Compliance | DONE (W6 phase 2) | VeriFactu+SES+TBAI cards |
| ManagementScreen | Management | DONE (W6 phase 2) | KPI tiles |

## Pantallas pendientes (priorizadas)
### Alta (Q3 2026)
| Screen | Modulo | Esfuerzo |
|--|--|--|
| ChannelAggregatorHub | Channels | M |
| ConfigurationCenterScreen | Config | L |
| RevenueHomeDashboard | Revenue | L |
| SetupCenterScreen | Setup | M |
| RatePlansScreen | Pricing | M |
| TouristTaxScreen | Compliance | S |
| CancellationPoliciesScreen | Setup | S |
| FnbMenuScreen | F&B | M |

### Media (Q4 2026)
(... resto pantallas operativas)

### Baja (T1 2027)
(... pantallas de administracion poco frecuente)

## Roadmap fase 2
- Wire CocoaGlobalProvider en App.tsx
- Migrar pantallas alta prioridad
- Storybook publico para componentes
- iPad Catalyst-like build

## Bloqueadores conocidos
Ninguno actualmente.
