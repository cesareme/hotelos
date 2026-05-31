# SIDEBAR V2 — Mapa de Iconografía

> Mapeo 1:1 de los items del sidebar V2 al catalogo `cocoa-icons` (`apps/admin-web/src/components/cocoa-icons/`). Cada fila indica el icono a renderizar, su **tone** (resuelto a token `--color-accent` / `--color-success` / `--color-warning` / `--color-text-secondary`) y, cuando proceda, la directiva `CREATE icon:`.
>
> Tones se aplican mediante prop `color` o clase `.icon--{tone}`. El estado activo del item siempre fuerza `accent`, sobreescribiendo el tone base.

---

## 1. Convenciones

- **Tamano**: 20px en items de grupo principal, 18px en subgrupos.
- **Weight**: `regular` (1.5) en idle, `medium` (2) en hover/active.
- **Tone base** (idle): casi siempre `neutral` (`--color-text-secondary`).
- **Tone con badge** (notificacion, urgencia, KPI): se eleva a `accent`, `success` o `warning`.
- **Catalogo activo**: `NavigationIcons.tsx` (12), `ActionIcons.tsx` (12), `StatusIcons.tsx` (12) = 36 iconos.

---

## 2. Grupo `Operaciones` (raiz)

| Item (label) | Cocoa icon | Tone | Notas |
|---|---|---|---|
| Inicio / Mi dia (recepcion) | `HouseIcon` | neutral | Home del rol |
| Mi dia (operaciones) | `HouseIcon` | neutral | Mismo glyph, contexto rol |
| Resumen del propietario | `BuildingIcon` | neutral | Vista cartera |
| Copiloto de recepcion | `SparkleIcon` | accent | IA siempre accent |
| Asistente IA (Ask HotelOS) | `SparkleIcon` | accent | IA |
| Copiloto operativo (IA) | `SparkleIcon` | accent | IA |
| Night audit | `ClockIcon` | warning | Proceso temporal critico |
| Supervision del turno | `EyeIcon` | neutral | Monitorizacion |
| Dashboard del director (GM) | `ChartIcon` | neutral | KPIs |
| Director de operaciones | `ChartIcon` | neutral | KPIs |
| Selector de personas | `PeopleIcon` | neutral | Picker de roles |
| Guia de uso por persona | CREATE icon: `BookOpenIcon` | neutral | No existe libro/manual |
| Tablero de habitaciones | `BedIcon` | neutral | Rack |
| Live Timeline | CREATE icon: `TimelineIcon` | accent | Linea con nodos, no hay equivalente |
| Bandeja de cumplimiento | `BellIcon` | warning | Inbox tareas |
| Centro de cumplimiento | `CheckCircleIcon` | success | Compliance OK |
| Cartera (todas las propiedades) | `BuildingIcon` | neutral | Multi-property |

### 2.1 Subgrupo `Reservas y huespedes`

| Item | Icon | Tone |
|---|---|---|
| Espacio de reservas / Lista / Crear | `CalendarIcon` | neutral |
| Agente de reservas (IA) | `SparkleIcon` | accent |
| Huespedes | `PersonIcon` | neutral |
| Timeline del huesped | CREATE icon: `TimelineIcon` | neutral |
| Recorrido del huesped | CREATE icon: `RouteIcon` | neutral |
| Check-in / Check-out (PMS) | `DoorOpenIcon` | success / warning |

### 2.2 Subgrupo `Tableros operativos`

| Item | Icon | Tone |
|---|---|---|
| Mi turno (HK movil) / Tablero de pisos | CREATE icon: `BroomIcon` | neutral |
| Mis averias / Tablero de mantenimiento | `WrenchIcon` | warning |
| Personal y turnos | `PeopleIcon` | neutral |
| Seguridad e incidentes | `LockIcon` | warning |
| Punto de venta (TPV) | CREATE icon: `ReceiptIcon` | neutral |

### 2.3 Subgrupo `Comercial`

| Item | Icon | Tone |
|---|---|---|
| Channel Manager / Rendimiento de canales | CREATE icon: `BroadcastIcon` | neutral |
| Inicio de revenue / Comparacion / Historico | `ChartIcon` | accent |
| Panel de reunion de revenue | `PeopleIcon` | accent |
| Rate shopper (comp-set) | `SearchIcon` (Action) | neutral |
| Pipeline de ventas | CREATE icon: `FunnelIcon` | accent |
| Grupos y eventos / Calendario de grupos | `PeopleIcon` | neutral |
| Cupos de TT.OO. (allotments) | `CalendarIcon` | neutral |
| Planes tarifarios (BAR) | CREATE icon: `TagIcon` | neutral |
| Politicas de cancelacion | CREATE icon: `DocumentIcon` | neutral |
| Cartas de Restauracion / Inventario F&B | CREATE icon: `ForkKnifeIcon` | neutral |
| Tasa turistica por CCAA | `CreditCardIcon` | neutral |

### 2.4 Subgrupo `Experiencia del huesped`

| Item | Icon | Tone |
|---|---|---|
| Bandeja de concierge | `ChatBubbleIcon` | accent |
| Reputacion | `StarIcon` | success |
| Upsells | CREATE icon: `TrendingUpIcon` | success |
| Encuestas / NPS | CREATE icon: `ClipboardCheckIcon` | neutral |
| Casos de calidad | `ExclamationCircleIcon` | warning |
| CRM | `PeopleIcon` | neutral |
| Fidelizacion | `HeartIcon` | accent |

### 2.5 Subgrupo `Finanzas y fiscal`

| Item | Icon | Tone |
|---|---|---|
| Centro fiscal / Modelos AEAT / TicketBAI | CREATE icon: `DocumentIcon` | neutral |
| Cobros / Pagos / Tesoreria | `CreditCardIcon` | accent |
| Conciliacion bancaria / Banca Espana | CREATE icon: `BankIcon` | neutral |
| Balance / Trial / Cash flow | `ChartIcon` | neutral |
| Comisiones (OTA) / Folios | `CreditCardIcon` | neutral |
| Nominas | `PeopleIcon` | neutral |
| Webhooks / Marketplace / API | CREATE icon: `CodeBracketIcon` | neutral |
| Mensajeria omnichannel | `EnvelopeIcon` | neutral |
| Informe CSRD / Sostenibilidad | CREATE icon: `LeafIcon` | success |
| Campanas marketing | CREATE icon: `MegaphoneIcon` | accent |
| Kiosco self check-in | CREATE icon: `KioskIcon` | neutral |

### 2.6 Subgrupo `Metricas de plataforma`

| Item | Icon | Tone |
|---|---|---|
| Centro de analitica / Reports | `ChartIcon` | accent |
| Registro de activos | `BuildingIcon` | neutral |
| Rentabilidad por habitacion | `ChartIcon` | success |
| Consumo energetico | CREATE icon: `BoltIcon` | warning |

---

## 3. Grupo `Back Office`

| Item | Icon | Tone |
|---|---|---|
| Inicio del Back Office | `GearIcon` | neutral |
| Centro de configuracion inicial / Setup Wizard | CREATE icon: `WandIcon` | accent |
| Mapeador de propiedad | `BuildingIcon` | neutral |
| Perfil / Edificios / Plantas / Zonas | `BuildingIcon` | neutral |
| Tipos de habitacion / Inventario habitaciones | `BedIcon` | neutral |
| Departamentos / Categorias | CREATE icon: `FolderIcon` | neutral |
| Campos personalizados | CREATE icon: `SlidersIcon` | neutral |
| Ajustes de housekeeping / mantenimiento | `WrenchIcon` | neutral |
| SOPs | CREATE icon: `DocumentIcon` | neutral |
| Configuracion revenue / Reglas / Forecast | `GearIcon` | accent |
| Ajustes de channel manager / Mapeos | CREATE icon: `BroadcastIcon` | neutral |
| Comp-set competidores | `SearchIcon` | neutral |

---

## 4. Footer del sidebar

| Item | Icon | Tone |
|---|---|---|
| Notificaciones (badge) | `BellIcon` | accent (con badge), neutral idle |
| Buscador global | `SearchIcon` | neutral |
| Perfil usuario | `PersonIcon` | neutral |
| Cerrar sesion | `LockOpenIcon` | neutral |

---

## 5. Resumen de iconos a crear

Iconos referenciados que **NO** existen en el catalogo actual y deben crearse para soportar V2:

1. `BookOpenIcon` — manuales / guias
2. `TimelineIcon` — linea temporal con nodos
3. `RouteIcon` — recorrido / journey
4. `BroomIcon` — housekeeping
5. `ReceiptIcon` — TPV / tickets
6. `BroadcastIcon` — canales / OTA
7. `FunnelIcon` — pipeline / embudo
8. `TagIcon` — tarifas / etiquetas
9. `DocumentIcon` — documento generico (politicas, SOPs, fiscal)
10. `ForkKnifeIcon` — F&B
11. `TrendingUpIcon` — upsells / crecimiento
12. `ClipboardCheckIcon` — encuestas / NPS
13. `BankIcon` — banca / conciliacion
14. `CodeBracketIcon` — developer / API
15. `LeafIcon` — sostenibilidad
16. `MegaphoneIcon` — marketing / campanas
17. `KioskIcon` — kiosco self check-in
18. `BoltIcon` — energia
19. `WandIcon` — setup wizard
20. `FolderIcon` — agrupacion / categorias
21. `SlidersIcon` — campos / ajustes finos

**Total a crear**: 21 iconos. Recomendacion: agruparlos en un nuevo `OperationsIcons.tsx` (1-7, 10-12, 17), `FinanceIcons.tsx` (8, 9, 13, 14), `BackOfficeIcons.tsx` (15-16, 18-21) para mantener el patron actual de archivos por dominio.
