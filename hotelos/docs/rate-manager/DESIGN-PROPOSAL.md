# Rate Manager v2.0 · Diseño

## Resumen del research

Análisis comparativo de cuatro líderes del mercado (SiteMinder, Mews, Cloudbeds, RMS) revela un patrón consolidado para la gestión moderna de tarifas hoteleras:

**Editor matricial como núcleo**. Todos los players ofrecen una grilla bidimensional room-type × date que permite ver y editar tarifas in-line. SiteMinder lo llama "Rate Manager", Mews "Rates Manager", Cloudbeds "Calendar View". La interacción tipo spreadsheet (selección múltiple, copy/paste, fill-down) es el estándar de facto — los revenue managers vienen de Excel y exigen esa ergonomía.

**Restricciones por celda, no por tarifa**. CTA (closed-to-arrival), CTD (closed-to-departure), MinLOS, MaxLOS, Closed y StopSell se aplican a la intersección room-type × fecha, no a la tarifa global. SiteMinder y Mews permiten badges visuales en cada celda. Cloudbeds usa color-coding (amarillo cerrado, rojo stop-sell).

**Bulk edit con drawer lateral**. RMS Cloud popularizó el patrón de seleccionar N celdas y abrir un panel derecho con opciones: valor fijo, delta %, delta absoluto, "copy from another date range". Mews lo evolucionó a un workflow de tres clicks: select → choose operation → preview diff → apply.

**Channel-level overrides via markup**. Mews y SiteMinder almacenan una tarifa base (BAR) y aplican markup % por canal (Booking +0%, Expedia +12%, Airbnb +18%). Cloudbeds permite override absoluto por canal. Ambos modelos coexisten en el mercado; el % es más mantenible.

**Push selectivo + journal de cambios**. Tras editar, el usuario decide qué pushear (todos los canales / selección). Cada push genera un audit log con timestamp, usuario, diff, motivo opcional. Es un requisito de compliance para hoteles grandes.

**Scheduled rate changes**. SiteMinder permite cambios programados (ej: "subir 10% el viernes a las 18:00"). Útil para eventos previstos, lanzamientos de campañas, y respuesta automatizada a forecast.

**Mobile-first quick adjustments**. Mews y Cloudbeds tienen vistas compactas móviles con acciones rápidas: "stop-sell hoy", "+5% esta semana", "duplica precio del fin de semana pasado". Para revenue managers que reaccionan a demand spikes sin acceso a PC.

**Comp-set shopping integrado**. Los RMS modernos (RMS Cloud, IDeaS) muestran rates de competencia en sidebar. Highlight visual cuando HotelOS está fuera de banda (>15% por encima/debajo del promedio del comp-set).

## Estado actual de HotelOS

La auditoría del repo identifica los siguientes activos y huecos:

**Lo que existe**:
- Modelos Prisma `RoomType`, `BARLevel`, `ChannelMapping` con relación many-to-many propiedad↔canal
- Push manual a OTAs vía `ChannelService.push()` — funciona pero requiere edición previa en Excel u otra herramienta externa
- Pantallas `RatesListScreen` (vista tabular read-only) y `BARLevelEditScreen` (formulario individual)
- Servicio `getEffectiveRate(roomTypeId, date, channelId)` que ya calcula tarifa con markup, pero solo se usa en checkout
- Tabla `AuditLog` genérica (no especializada por dominio tarifa)

**Lo que falta en UI**:
- Editor matricial pre-push
- Bulk edit
- Restricciones por celda (CTA/CTD/MinLOS/MaxLOS/Closed/StopSell)
- Channel overrides desde UI (el dato existe en `ChannelMapping.markup` pero no es editable inline)
- Diff preview antes de push
- Journal de cambios filtrable
- Scheduled rate changes
- Vista mobile
- Comp-set integration (requiere proveedor externo, fuera de scope v2.0)

**Gap analysis**: HotelOS cubre solo Push. Sin editor matricial pre-push, sin bulk edit, sin restricciones por celda, sin channel overrides editables, sin journal especializado. Los revenue managers actualmente exportan a Excel, editan, re-importan via CSV, y pushean — workflow de 4-5 minutos por cambio. Rate Manager v2.0 colapsa ese flujo a 30 segundos.

## Propuesta

### Pantalla nueva: RateGridEditorScreen

Layout completo Cocoa estructurado en cuatro zonas:

**Top toolbar** (fila superior, 56pt height):
- Date range picker (default: próximos 30 días, máx 90)
- Room type filter (multi-select chips)
- Channel selector (dropdown: "All channels" o canal específico para ver overrides)
- BAR level selector (BAR1 / BAR2 / BAR3 / Last-minute)
- Botón "Refresh" + "Comp-set" toggle (sidebar widget)

**Center** (zona principal, expansiva): `CocoaRateGrid` component
- Matriz editable rows = room types, cols = dates
- Header sticky con día de semana + fecha (lun 1 / mar 2 / mié 3…)
- Weekend coloring (sáb/dom fondo gris claro)
- Celdas con valor + badges de restricciones inline
- Click celda → input numérico + dropdown de restricciones
- Drag-select rectángulos (mouse down + drag)
- Ctrl+click para añadir celdas no contiguas
- Shift+click para extender selección
- Copy/paste entre celdas (Ctrl+C / Ctrl+V) — paste replica el valor o el patrón
- Visual indicators: amarillo=Closed, rojo=StopSell, verde=Open con restricciones, blanco=Open sin restricciones
- Fill-down con arrastre del corner-handle (estilo Excel)

**Right panel** (drawer condicional, 320pt width, slide-in cuando hay selección):
- Header: "Aplicar a 12 celdas seleccionadas" (contador dinámico)
- Sección "Valor": radio buttons → Valor fijo (input €) / Delta % (input %) / Delta absoluto (input ±€) / Copy from (date picker)
- Sección "Restricciones": checkboxes con valor → MinLOS (num), MaxLOS (num), CTA (toggle), CTD (toggle), Closed (toggle), StopSell (toggle)
- Sección "Canal" (opcional): toggle "Override per channel" que muestra lista de canales con markup % editable
- Preview: tabla mini con before/after de las primeras 5 celdas afectadas
- Botones: "Aplicar a selección" (primary) / "Cancelar"

**Bottom status bar** (40pt height):
- "Cambios sin guardar: N celdas"
- Botones: "Descartar" / "Push selected channels…" / "Push to all channels" (primary)
- Spinner + estado del último push ("Pushed 2 min ago to Booking, Expedia")

### Componente nuevo: CocoaRateGrid

Componente reutilizable. Props:
- `cells: RateGridCell[]` (datos)
- `roomTypes: RoomType[]` (rows)
- `dates: Date[]` (cols)
- `selectedChannelId?: string` (filtro de override)
- `onCellChange: (cellId, patch) => void`
- `onSelectionChange: (cellIds[]) => void`
- `readOnly?: boolean`

Comportamiento detallado:
- **Edición**: click selecciona, doble-click o F2 entra en modo edit, Enter confirma, Esc cancela
- **Multi-select**: drag rectangular, Ctrl+click (toggle individual), Shift+click (range), Ctrl+A (todas)
- **Copy/paste**: Ctrl+C copia selección a clipboard interno; Ctrl+V pega en celda activa replicando patrón (si copias 1 celda y pegas en 10, replica; si copias 5 y pegas en 5, mapea 1:1)
- **Keyboard nav**: flechas mueven foco, Tab horizontal, Shift+Tab inverso, Home/End extremos de fila, Ctrl+Home/End extremos de grilla
- **Right-click context menu**: Cut / Copy / Paste / Clear / "Aplicar restricciones…" / "Stop-sell" / "Reopen"
- **Inline restrictions badges**: pequeños iconos en esquina inferior de celda (candado=Closed, ⛔=StopSell, ↑=CTA, ↓=CTD, número=MinLOS)
- **Virtualización**: si dates × roomTypes > 300 celdas (ej: 30d × 10rt), usa `NSCollectionView` con prefetching; renderiza solo viewport + 20% buffer
- **Dirty tracking**: celdas modificadas tienen border azul; status bar cuenta dirties

### Nuevos modelos Prisma

```prisma
model RateGridCell {
  id               String   @id @default(cuid())
  propertyId       String
  roomTypeId       String
  channelId        String?  // null = base BAR, set = override
  date             DateTime @db.Date
  basePrice        Decimal? @db.Decimal(10,2)
  restrictionsJson Json     // { minLOS, maxLOS, cta, ctd, closed, stopSell }
  source           String   // 'manual' | 'scheduled' | 'rms-import' | 'channel-sync'
  lastModifiedBy   String
  etag             String   // optimistic concurrency
  updatedAt        DateTime @updatedAt
  @@unique([propertyId, roomTypeId, channelId, date])
  @@index([propertyId, date])
}

model RateChangeJournal {
  id            String   @id @default(cuid())
  propertyId    String
  ratesUpdated  Json     // [{ cellId, before, after }]
  userId        String
  reason        String?
  timestamp     DateTime @default(now())
  @@index([propertyId, timestamp])
}

model ScheduledRateChange {
  id          String   @id @default(cuid())
  propertyId  String
  applyAt     DateTime
  changes     Json     // [{ rt, date, ch?, price?, restrictions? }]
  status      String   // 'pending' | 'applied' | 'failed' | 'cancelled'
  createdBy   String
  createdAt   DateTime @default(now())
  @@index([applyAt, status])
}
```

### Endpoints backend

- `GET /rate-grid?propertyId=&from=&to=&roomTypeIds=&channelId=` → array de `RateGridCell` para hidratar la grilla. Devuelve también `effectiveBARLevel` por fecha para que la UI muestre qué nivel está activo.
- `POST /rate-grid/bulk-update` body: `{ cells: [{ rt, date, ch?, price?, restrictions? }], reason? }` → aplica cambios en transacción, valida ranges (price > 0, MinLOS ≤ MaxLOS), incrementa etag, registra en `RateChangeJournal`. Devuelve cells actualizadas para reconciliación.
- `POST /rate-grid/push` body: `{ from, to, channelIds[] }` → invoca `ChannelService.push` por cada canal seleccionado, devuelve status por canal.
- `GET /rate-grid/journal?propertyId=&limit=&from=&to=&userId=` → audit log paginado.
- `POST /rate-grid/schedule` body: `{ applyAt, changes }` → encola cambio futuro en `ScheduledRateChange`.

### Channel-level overrides

- Base BAR vive en `BARLevel` (modelo existente).
- Markup % por canal en `ChannelMapping.markup` (campo existente).
- Función `getEffectiveRate(rt, date, channel)` ya existe — extender para considerar `RateGridCell` override si presente.
- UI: cuando el usuario activa el toggle "Override per channel" en el drawer, aparece lista de canales con markup % editable inline. Si se establece un `basePrice` con `channelId` específico, sobreescribe el cálculo base+markup para esa celda.

### Restricciones (CTA, CTD, MinLOS, MaxLOS, Closed, StopSell)

- Stored como JSON inline en `RateGridCell.restrictionsJson` para flexibilidad y queries simples.
- Forma: `{ minLOS: 2, maxLOS: 14, cta: false, ctd: true, closed: false, stopSell: false }`
- UI: badge en celda con icono (candado=Closed, ⛔=StopSell, ↑=CTA arrival, ↓=CTD departure, num pequeño en esquina=MinLOS).
- Bulk edit aplica restrictions junto a price; si solo se modifica restriction sin tocar price, el `basePrice` permanece null y hereda del `BARLevel`.

### Scheduled changes

- Tabla `ScheduledRateChange` con queue de cambios pendientes.
- Cron job (existente en `JobScheduler`) ejecuta cada 5 min, busca `status='pending' AND applyAt <= now()`, aplica via mismo endpoint `bulk-update`, marca `applied` o `failed`.
- UI: tab "Programados" lista con countdown ("se aplica en 2h 14min"), botón "Cancelar", botón "Aplicar ahora".

### Audit log

- Cada cambio registra entry en `RateChangeJournal` con `ratesUpdated` (diff before/after), `userId`, `reason`, `timestamp`.
- UI: tab "Historial" tabla scrollable con filtros (rango fecha, usuario, room type). Click en row expande detalle del diff.

### Mobile-friendly rate update

Pantalla compact (`RateQuickAdjustScreen`) con acciones rápidas:
- "Stop-sell hoy" (un tap → confirma → push)
- "+5% esta semana" / "+10% / +15%"
- "Paste from yesterday" (replica tarifas del día anterior a hoy o a rango)
- "Reopen all" (reabre celdas cerradas en ventana 7d)

Pensado para situaciones de demand spike sin acceso a PC. Comparte endpoints con la pantalla desktop.

### Comp-set rate shopping integration

Sidebar widget (toggle desde top toolbar) muestra rates de competencia para próximos 7 días vía proveedor externo (OTA Insight o RateGain).
- Highlight si HotelOS rate > comp-set avg + 15% (over-priced, fondo rojo claro)
- Highlight si HotelOS rate < comp-set avg − 15% (under-priced, fondo azul claro)
- Tooltip muestra promedio + min/max del comp-set
- Refresh cada 6h

## Roadmap implementación (3 fases)

**Fase 1 — W23 (~20 agentes)**: Núcleo editable
- `CocoaRateGrid` component (multi-select, copy/paste, inline edit, virtualización)
- `RateGridEditorScreen` (toolbar + grid + bulk-edit drawer + status bar)
- Endpoints `GET /rate-grid` y `POST /rate-grid/bulk-update`
- Modelo `RateGridCell` + migración
- Integración con push existente (`POST /rate-grid/push`)
- Tests E2E del flujo edit → push

**Fase 2 — W24 (~15 agentes)**: Restricciones + overrides + journal
- Restricciones inline en celdas (badges + bulk edit support)
- Channel-level overrides editables desde drawer
- Modelo `RateChangeJournal` + endpoint `GET /rate-grid/journal`
- Pantalla `RateJournalScreen` con filtros
- Diff preview antes de push (modal con before/after por canal)

**Fase 3 — W25 (~12 agentes)**: Scheduled + mobile + comp-set
- Modelo `ScheduledRateChange` + endpoint `POST /rate-grid/schedule`
- Cron job de aplicación
- Tab "Programados" en `RateGridEditorScreen`
- `RateQuickAdjustScreen` mobile
- Integración comp-set (proveedor externo, sidebar widget, alertas)

## KPIs esperados

- **Tiempo medio para cambiar tarifas**: −70% (de 4 min Excel+manual push a 30s edit+push directo)
- **Stop-sell on demand**: < 10s (1 click en mobile)
- **Cambios masivos (toda temporada)**: 1 click via fill-down + bulk apply
- **Errores tarifa**: −90% (validation server-side + diff preview previo a push)
- **NPS revenue manager**: +25 pts vs herramienta actual
- **Adopción esperada**: 80% de usuarios revenue manager activos en W26 (2 semanas tras release Fase 3)
