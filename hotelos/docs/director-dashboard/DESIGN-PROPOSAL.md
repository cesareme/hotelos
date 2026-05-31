# Director Dashboard v2.0 · Diseño

Versión: 2.0 · Estado: Propuesta · Owner: Producto + Cocoa Design System

---

## Resumen del research

El research sobre dashboards de dirección hotelera (Oracle OPERA Cloud, Cloudbeds, Mews, IDeaS G3 RMS, Duetto, SiteMinder, STR/CoStar y benchmarks Hotel Tech Report 2024-2025) destaca patrones convergentes:

- **Density layered**: los GMs quieren ver el "today snapshot" en menos de 3 segundos (above the fold) sin scroll, y profundizar bajo demanda. El patrón dominante es *strip de KPIs* en row 1 con 8-12 tiles compactos, seguido de visualizaciones forward-looking.
- **Forward pace > historical**: el peso visual se ha movido de "ayer/MTD" a *next 7/14/30/90 días* — pickup, OTB (on-the-books) vs LY (Last Year) vs forecast, y eventos del compset. Los productos líderes muestran *pace curves* como objeto principal del row 2.
- **Comp-set + STR Index** como contexto obligatorio para RevPAR (RGI, ARI, MPI). Sin benchmark externo, el RevPAR aislado es inaccionable.
- **AI insights como first-class citizen**: 2024-2025 ve la generalización de *anomaly detection* (ADR drops, demand spikes, channel-mix anomalies) y *recommended actions* con CTA en línea (BAR override, restricción CTA/MLOS, ajuste segmento). Mews Atlas, Duetto Ai, IDeaS G3 lideran este patrón.
- **Operations health en mini-cards**: HK, mantenimiento, F&B, seguridad — pequeñas tarjetas con semáforo + count + drill. La presión de la industria es la *single pane of glass* donde el GM ve operaciones + revenue + compliance sin saltar de sistema.
- **Compliance europeo** (VeriFactu, TBAI, SES Hospedajes para España; DSGVO; PCI DSS) emerge como widget propio en mercados regulados — no escondido en submenús.
- **Guest experience score** (NPS + reviews agregadas Booking/TripAdvisor/Google + service requests abiertos + VIPs in-house) ocupa una row dedicada, ya no enterrado bajo "marketing".
- **Profit por encima de revenue**: GOPPAR, TRevPAR y *net contribution* (descontando channel cost real) son los KPIs estrella de 2025. ADR/RevPAR solos son insuficientes.
- **Density + tipografía sobria**: los líderes usan tipografía monoespaciada o tabular para cifras, contraste alto, colores semánticos (verde/ámbar/rojo) sólo en deltas y semáforos. La estética "fintech terminal" (Stripe Sigma, Linear, Vercel Observability) ha permeado al sector hotelero.

## Estado actual

Auditoría del dashboard director vigente (`GeneralManagerDashboard.tsx` y endpoint `GET /general-manager/dashboard`):

- **Layout**: vertical, sin grid 12-col, con secciones apiladas (Occupancy box, ADR box, RevPAR box, Tasks, Alerts). Density baja: 4-5 KPIs above the fold sobre fondo blanco, mucha pérdida de espacio.
- **KPIs cubiertos**: Occupancy %, ADR, RevPAR, in-house, arrivals, departures, MTD revenue. **Faltan**: GOPPAR, total labor cost today, net contribution proxy, pace 30d, pickup 7d, channel cost %, BAR recommendations, NPS, reviews agregadas, compliance status, anomalies.
- **Forward-looking**: ausencia total de gráfico pace OTB vs LY vs forecast. Sólo histórico.
- **Comp-set**: no integrado (sin placeholder STR ni feed externo).
- **AI insights**: no existen. No hay anomaly detection, ni recomendaciones de acción, ni demand spike alerts.
- **Operations health**: HK, mantenimiento y workforce viven en módulos separados sin agregación visual en el director dashboard. Cross-navigation pobre.
- **Compliance widget**: VeriFactu, TBAI y SES Hospedajes se gestionan en módulo `compliance/` pero no afloran al director. El GM no ve estado de partes pendientes ni última submission VeriFactu.
- **Guest experience**: NPS y reviews están dispersos. Service requests visibles en `housekeeping/` pero no agregados.
- **Componentes Cocoa**: existen `KpiCard`, `MetricTile`, `Sparkline`, `LineChart`, `DonutChart` en `cocoa-design/` pero no se han aplicado homogéneamente al director dashboard, que usa estilos legacy en gran parte.
- **Endpoints**: `GET /general-manager/dashboard?date=` único endpoint. No expone forecast accuracy, channel cost breakdown, anomalies, ni compliance summary.

Conclusión: el dashboard actual cumple ~30% del estado del arte. Falta visión forward, AI, comp-set, ops health agregado, compliance, profit-centric KPIs y un sistema visual coherente.

## Propuesta layout Cocoa

Layout **12 columnas grid responsive** (breakpoints: `sm 640`, `md 1024`, `lg 1280`, `xl 1536`, `2xl 1920`). Spacing base 8 px. Cards con `radius-md`, border `border-subtle`, fondo `surface-1`. Tipografía tabular `tabular-nums` para cifras.

### Row 1 — Today snapshot strip (alta densidad)

11 tiles horizontales en 12 col (cada uno ~1 col, ajustable a 2 col en `md`):

- **Occupancy %** — valor + delta vs ayer + delta vs LY + sparkline 7d
- **ADR** — valor + delta vs LY
- **RevPAR** — valor + delta vs LY
- **GOPPAR** — proxy si no hay P&L completo (RevPAR − channel cost − labor cost / available rooms)
- **In-house** — count + total guests
- **Arrivals today** — count + ETA range
- **Departures today** — count + early checkout flag
- **OOO rooms** — count + impacto en disponible
- **Total revenue today** — rooms + F&B + other, breakdown en hover
- **Total labor cost today** — actual vs presupuesto, % varianza
- **Net contribution proxy** — revenue − channel cost − labor cost

Cada tile usa componente `DirectorKpiTile`. Touch target ≥ 44 px.

### Row 2 — Forward pace + Forecast

- **Chart pace next 30 días** (8 cols) — multi-line: OTB (sólido) vs Forecast (dashed) vs LY (gris). Eje X días. Tooltip muestra ADR esperado y ocupación %. Componente `DirectorForwardPaceChart`.
- **Pickup tendencia 7d** (2 cols) — bar chart vertical con pickup neto día a día, semáforo color (verde si > LY, rojo si <).
- **Cancellation risk score** (2 cols) — gauge IA + count de reservas en riesgo alto + CTA "Revisar".

### Row 3 — Performance ladders

- **ADR por segmento** (4 cols) — bar horizontal: Corporate, Leisure, Group, Wholesale, OTA mix. Cada barra con ADR + Δ LY + % mix.
- **RevPAR vs comp-set** (4 cols) — chart: RGI (Revenue Generation Index), ARI (Average Rate Index), MPI (Market Penetration Index). Placeholder con label "Conectar STR" si no hay feed.
- **Channel mix donut + channel cost %** (2 cols) — donut por canal (Direct, Booking, Expedia, GDS, Wholesalers) con cost effective % superpuesto.
- **BAR recommendations IA** (2 cols) — lista 3 fechas próximas con BAR sugerido vs actual y delta esperado en revenue + CTA "Aplicar".

### Row 4 — Operations health (mini-cards)

5 mini-cards de 2 cols + 1 col vacío opcional para futuro:

- **HK progress** — barra: clean / dirty / inspected / OOO con %.
- **Maintenance** — open / in-progress / critical con semáforo rojo si críticos > 0.
- **Workforce** — shifts staffed vs needed por turno actual, % cobertura.
- **Safety** — incidentes abiertos + severity badge.
- **POS revenue today** — total + breakdown bar/restaurant/spa + Δ ayer.

Componente: `DirectorOpsHealthMini`.

### Row 5 — Guest experience

- **NPS sparkline 30d** (3 cols) — valor actual grande + sparkline + segmentación detractor/passive/promoter.
- **Reviews score agregado** (3 cols) — Booking + TripAdvisor + Google ponderado + Δ vs 30d previos + count reviews.
- **Service requests abiertos** (3 cols) — count por categoría (housekeeping, F&B, concierge, maintenance) + SLA breach badge.
- **VIPs in-house** (3 cols) — lista mini (max 5) con nombre, tipo VIP, room, status preferencias. Componente `DirectorVipList`.

### Row 6 — Compliance + Risk

- **VeriFactu** (3 cols) — semáforo (verde/ámbar/rojo) + pending submissions count + last submission timestamp + CTA "Detalle".
- **SES Hospedajes** (3 cols) — partes pending + delay alert + CTA.
- **TBAI** (3 cols) — estado + last submission + errors count.
- **Alerts compliance críticos** (3 cols) — lista de alertas activas (GDPR consent expired, PCI DSS scan due, etc.) con severity + CTA.

Componente: `DirectorComplianceWidget`.

### Row 7 — AI insights & recommendations

- **Anomalies detectadas hoy** (5 cols) — lista (max 5) con tipo (booking drop, cost spike, ADR drop por segmento), magnitud, ventana temporal, badge severity.
- **Top 3 acciones recomendadas** (4 cols) — cards con título acción, impacto esperado (€/p.p. RevPAR), confianza IA, CTA "Aplicar" / "Descartar". Componente `DirectorAiInsightCard`.
- **Forecasted demand spike alerts** (3 cols) — próximos 14d con eventos detectados (festivales, partidos, ferias) + recomendación de rate strategy.

## KPIs críticos (20 priorizados H/M/L)

| # | KPI | Target | Fuente | Prioridad |
|---|---|---|---|---|
| 1 | Occupancy % | > 75% temp alta | PMS reservations | H |
| 2 | ADR | ≥ presupuesto + 3% | PMS bookings | H |
| 3 | RevPAR | ≥ LY + 5% | PMS calc | H |
| 4 | GOPPAR (proxy) | ≥ LY + 3% | PMS + labor + channel cost | H |
| 5 | Total revenue today | ≥ presupuesto día | PMS + POS | H |
| 6 | Labor cost % revenue | < 30% | Payroll + PMS | H |
| 7 | Pickup 7d | ≥ LY pace | Booking history | H |
| 8 | OTB pace next 30d | ≥ LY +3 p.p. ocupación | Reservations | H |
| 9 | Channel cost % revenue | < 18% | Booking source + commission | H |
| 10 | Cancellation risk score | < 8% reservas | IA model | H |
| 11 | RGI (RevPAR vs comp) | ≥ 100 | STR / CoStar | M |
| 12 | NPS | ≥ 50 | Post-stay survey | M |
| 13 | Reviews score agregado | ≥ 8.7/10 | Booking + TA + Google | M |
| 14 | Service request SLA breach | 0 | Ops module | M |
| 15 | HK rooms ready by 3pm | 100% | HK module | M |
| 16 | Maintenance critical open | 0 | Maint module | M |
| 17 | VeriFactu pending | 0 | Compliance module | M |
| 18 | SES Hospedajes pending | 0 | Compliance module | M |
| 19 | POS revenue Δ ayer | ≥ 0% | POS | L |
| 20 | VIPs in-house satisfaction | 100% sin issues | CRM + service requests | L |

## Endpoints backend requeridos

- `GET /general-manager/dashboard?date=&windowDays=` — extiende el actual añadiendo GOPPAR proxy, labor cost, net contribution, pace OTB.
- `GET /general-manager/forecast-accuracy?windowDays=` — devuelve MAPE forecast vs actual últimos N días + curva confianza.
- `GET /general-manager/channel-cost-breakdown?date=` — por canal: bookings, gross revenue, commission/cost, net contribution, mix %.
- `GET /general-manager/anomalies?date=` — anomalías IA detectadas (ADR drop, booking spike/drop, cost spike, segment shift) con magnitud, severidad, CTA recomendado.
- `GET /general-manager/compliance-summary` — VeriFactu, TBAI, SES Hospedajes, GDPR, PCI DSS con estado, pendings, last submission, errors.
- `GET /general-manager/guest-experience-summary?windowDays=` — NPS, reviews agregadas multi-fuente, service requests abiertos, VIPs in-house.

Todos los endpoints siguen contrato OpenAPI definido en `docs/api-contracts.md` y devuelven `{ data, meta, alerts }` consistente.

## Componentes Cocoa a crear

- **DirectorKpiTile** — icon, label, valor (tabular), delta vs ayer, delta vs LY, sparkline mini opcional. Variants: `compact`, `expanded`.
- **DirectorChartCard** — wrapper para line/bar/area con header (title, period selector, legend) + footer (insights texto).
- **DirectorOpsHealthMini** — mini-card con icon de módulo, count principal, semáforo color, breakdown opcional, CTA navegación.
- **DirectorComplianceWidget** — semáforo grande, métrica clave, last action timestamp, CTA detalle. Variants por marco regulatorio.
- **DirectorAiInsightCard** — badge severity, título, descripción IA, impacto esperado, confianza, doble CTA (aplicar / descartar).
- **DirectorVipList** — lista compacta de huéspedes VIP con avatar opcional, tipo VIP, room, status preferencias, badge service request abierto.
- **DirectorForwardPaceChart** — line chart multi-serie OTB/Forecast/LY, tooltip rico, period selector 7/14/30/60/90, anotaciones eventos.
- **DirectorChannelMixDonut** — donut con tooltip por canal mostrando bookings, revenue, cost %, net contribution.

Todos los componentes en `src/cocoa-design/components/director/` con stories Storybook y tests unitarios.

## Implementación fases

- **Fase 1 (sin datos nuevos)** — Refactor visual completo del dashboard usando KPIs ya disponibles (Occupancy, ADR, RevPAR, in-house, arrivals, departures, MTD revenue). Aplicar grid 12-col, `DirectorKpiTile`, `DirectorForwardPaceChart` (con datos OTB existentes y LY del histórico). Activar rows 1, 2 parcial y 4 con datos existentes. Placeholders en rows 3, 5, 6, 7 con estado "Próximamente".
- **Fase 2 (con backend nuevo)** — Añadir endpoints `forecast-accuracy`, `channel-cost-breakdown`, `anomalies`, `compliance-summary`, `guest-experience-summary`. Activar rows 3, 5, 6, 7. Conectar `DirectorAiInsightCard` y `DirectorComplianceWidget`. Forecast accuracy en gráfico pace.
- **Fase 3 (con datos externos)** — STR Index (CoStar feed), Booking.com Connect / TripAdvisor Content API / Google Business Profile API para reviews agregadas. Activar comp-set real en row 3 y reviews agregadas reales en row 5. Demand spike alerts con feed eventos (PredictHQ o equivalente).

## Roadmap

- **Workflow W18 implementación Fase 1** (~15 agentes) — refactor visual completo, componentes Cocoa nuevos, grid 12-col, integración endpoint actual, placeholders fases 2-3. Estimación 2-3 semanas. Entregable: dashboard Fase 1 en staging con stories Storybook y tests E2E.
- **W19 Fase 2** — backend endpoints nuevos + activación rows pendientes. Estimación 3-4 semanas.
- **W20 Fase 3** — integraciones externas STR + reviews + eventos. Estimación 4-6 semanas según feeds disponibles.

Owner producto valida priorización H/M/L y mapeo KPI ↔ endpoint antes de kickoff W18.
