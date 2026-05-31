# SIDEBAR V2 — TAXONOMÍA (Source List Style)

> Sidebar de navegación primaria para HotelOS. Inspirado en macOS Finder / Mail / Notes Source List.
> Estructura jerárquica colapsable, role-aware, con búsqueda, favoritos y mode switcher.

---

## 1. Anatomía global

```
┌─────────────────────────────────┐
│  [Logo HotelOS]   [⌘K Search]   │  ← Header fijo
├─────────────────────────────────┤
│  ★ FAVORITOS                    │  ← Pinned, user-managed
│    ▸ Mi día                     │
│    ▸ Room Rack                  │
│                                 │
│  🕒 RECIENTES                   │  ← Auto, últimos 5
│    ▸ Reserva #20461             │
│    ▸ Folio F-2026-0331          │
├─────────────────────────────────┤
│  ▼ INICIO                       │  ← Grupo 1 (default open)
│  ▼ FRONT DESK                   │  ← Grupo 2 (default open)
│  ▸ RESERVAS Y GRUPOS            │  ← Grupo 3 (collapsed)
│  ▸ OPERACIONES                  │
│  ▸ REVENUE & DISTRIBUTION       │
│  ▸ FINANCE                      │
│  ▸ COMPLIANCE & SETUP           │
│  ▸ ADMIN & DEVELOPER            │
├─────────────────────────────────┤
│  [PMS ▾]  Mode switcher         │  ← Footer fijo
│  PMS · ERP · Compliance         │
└─────────────────────────────────┘
```

**Reglas globales:**
- Ancho: 260 px (resizable 220–340).
- Grupos colapsables con disclosure triangle (▸ / ▼).
- **Default open:** Inicio + Front Desk. Resto colapsado.
- Estado de colapso persistido por usuario (localStorage + perfil).
- Búsqueda global en header (⌘K) — filtra ítems en vivo y abre Cmd palette.
- **Recientes** y **Favoritos** flotan encima de los grupos jerárquicos.
- **Role filter:** ítems y grupos sin permiso se ocultan (no greyed-out).
- Footer: Mode switcher PMS / ERP / Compliance — cambia el conjunto de grupos visibles.

**Anatomía de ítem:**
`[icon 16px] [label] [⌥shortcut?] [badge?]`
- Icon: SF Symbols / Lucide, 16 × 16, color por modo.
- Label: sentence case, max 22 chars.
- Shortcut opcional: tecla mostrada a la derecha (ej. `⌘1`).
- Badge opcional: numérico (rojo crítico, azul info, naranja warning).

---

## 2. Grupos y ítems

### 1. INICIO — *default open*
Dashboard rol-aware. Único grupo con ítem singular.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 🏠 | Inicio | ⌘1 | — | Dashboard adapta a rol: recepción, gobernanta, RM, director, admin. |

---

### 2. FRONT DESK — *default open*
Operativa diaria del front-of-house. El grupo más usado por recepción.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| ☀️ | Mi día | ⌘2 | Llegadas pendientes | Vista priorizada del turno: llegadas, salidas, mensajes. |
| 📅 | Reservas | ⌘R | — | Lista + búsqueda + filtros. |
| ✓ | Check-in / Check-out | ⌘K | Llegadas hoy | Flujo guiado, biométrico, firma. |
| 🛏️ | Room Rack | ⌘G | — | Vista tipo grid habitación × fecha. |
| 🚶 | Walk-in | ⌥W | — | Reserva express sin canal. |

---

### 3. RESERVAS Y GRUPOS
Gestión avanzada de reservas, contratos y operadores.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 🗓️ | Calendario | ⌘L | — | Timeline drag&drop, multi-resort. |
| 👥 | Grupos | — | Pdte. confirmar | Master reservation + bloqueos. |
| 📦 | Allotments | — | — | Cupos por TT.OO. y temporada. |
| ✈️ | TT.OO. | — | — | Tour operadores, contratos, comisiones. |
| 📋 | Rooming list | — | — | Asignación nominativa por grupo. |

---

### 4. OPERACIONES
Servicios internos del hotel (housekeeping, mantenimiento, F&B, seguridad).

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 🧹 | Housekeeping móvil | — | Hab. pendientes | Vista responsive prioritaria. |
| 🔧 | Maintenance móvil | — | Incidencias | Work orders, fotos, SLA. |
| 👷 | Workforce | — | — | Turnos, fichaje, planificación. |
| 🛡️ | Safety & Security | — | Alertas | Rondas, llaves maestras, PCI, evac. |
| 🍽️ | F&B POS | — | — | Punto de venta restaurante/bar/room service. |

---

### 5. REVENUE & DISTRIBUTION
Pricing, channel management, forecast y benchmarking.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 📈 | Revenue Management | — | — | RevPAR, ADR, ocupación, KPI board. |
| 💲 | Pricing | — | — | BAR, rate plans, derived, yield. |
| 🌐 | Channels (CM) | — | Errores sync | Booking, Expedia, Hotelbeds, GDS, propio. |
| 🔮 | Forecast | — | — | Pickup, on-the-books, pace. |
| 🔍 | Rate Shopper | — | — | Comp set, benchmarking de tarifas. |

---

### 6. FINANCE
Folios, cobros, contabilidad, banca y reporting financiero.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 📄 | Folios | ⌘F | Abiertos | Cuentas huésped, transferencias, splits. |
| 💳 | Pagos | — | Devoluciones | TPV, tokens, MOTO, conciliación. |
| 🏦 | Banking | — | Errores CSB | Norma 43, SEPA, conciliación bancaria. |
| 📊 | Budget | — | — | Presupuesto vs real, flash forecast. |
| 📑 | Reports | — | — | Reportes financieros + export. |

---

### 7. COMPLIANCE & SETUP
Centro normativo, configuración del hotel, fiscalidad, políticas.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| ⚖️ | Compliance Center | — | Crítico | SES.Hospedajes, AEAT VeriFactu, Mossos, IT BC, PCI DSS, GDPR, NIS2, DAC7. |
| ⚙️ | Configuración hotel | — | — | Inventario, tipologías, segmentos, calendarios. |
| 💼 | Tasas turísticas | — | — | Configuración por jurisdicción (CAT, BAL, etc.). |
| 🚫 | Cancellation policies | — | — | Políticas, no-show, garantías. |

---

### 8. ADMIN & DEVELOPER
Administración global, marketplace de extensiones, herramientas para devs.

| Icon | Label | Shortcut | Badge | Notas |
|------|-------|----------|-------|-------|
| 👤 | Usuarios y roles | — | — | RBAC, MFA, SCIM, audit. |
| 🛍️ | Marketplace | — | Updates | Plugins, integraciones, skills. |
| 🔌 | API & Webhooks | — | — | Keys, logs, rate limits, sandbox. |
| 🎨 | Design Showcase | — | — | Patterns, tokens, componentes (dev only). |
| ⚙️ | Settings | ⌘, | — | Preferencias usuario, tema, idioma. |

---

## 3. Reglas de comportamiento

### 3.1 Colapso / expansión
- Click en disclosure: toggle grupo.
- ⌥ + click: expande/colapsa todos.
- Estado guardado por usuario en backend (`sidebar.collapsedGroups`).
- En primer login, sólo Inicio + Front Desk abiertos.

### 3.2 Búsqueda (header)
- ⌘K abre Command Palette.
- Texto en la caja del header: filtra ítems visibles en vivo. Grupos sin matches se ocultan.
- Tabulator entra al primer match. Esc limpia.

### 3.3 Favoritos
- Right-click sobre ítem → "Añadir a favoritos".
- Drag&drop dentro de Favoritos para reordenar.
- Max 8 favoritos. Más → tooltip "límite alcanzado".

### 3.4 Recientes
- Auto-populated, últimos 5 ítems o entidades abiertas.
- Persistente por sesión. Click derecho → "Quitar".
- Iconos pequeños y label truncada con ellipsis.

### 3.5 Role filter
- El sidebar consulta `user.permissions[]`.
- Cada ítem declara `requiredPermission: string[]`.
- Grupo entero se oculta si todos sus ítems quedan sin permiso.
- Ejemplos:
  - Rol *Recepción*: ve Inicio, Front Desk, Reservas, parcialmente Finance (sólo Folios).
  - Rol *Gobernanta*: ve Inicio, Operaciones (HK), nada más.
  - Rol *Revenue Manager*: ve Inicio, Reservas (read), Revenue, Finance (read).
  - Rol *Director*: ve todo excepto Admin/Developer y Design Showcase.
  - Rol *Admin*: ve absolutamente todo.

### 3.6 Mode switcher (footer)
Cambia el conjunto de grupos visibles para reducir ruido cognitivo:

| Modo | Grupos visibles | Color de acento |
|------|-----------------|-----------------|
| **PMS** *(default)* | 1, 2, 3, 4, 5, 6 (Folios/Pagos), 7 (parcial), 8 | Azul |
| **ERP** | 1, 6, 4 (Workforce), 7 (Config) | Verde |
| **Compliance** | 1, 7, 8 (Users, API logs) | Rojo |

- Picker tipo segmented control en el footer.
- Cambio instantáneo, animación lateral 200 ms.
- Modo persistido por usuario.

### 3.7 Badges
- **Crítico** (rojo): incidencias, alertas Safety, errores CSB-43, Compliance bloqueante.
- **Warning** (naranja): pendientes con SLA cercano.
- **Info** (azul): counters informativos (llegadas hoy, hab. pendientes HK).
- **Updates** (gris): notificaciones suaves de Marketplace.
- Badges con número (`12`) o punto (`•`). Max 99+; "99+" si más.
- Click derecho sobre ítem con badge: "Marcar como leído" o "Ir al pendiente".

### 3.8 Shortcuts
- Bindings registrados globalmente, no sólo cuando sidebar tiene foco.
- ⌘ + número (1–9): grupos top-level (cuando el grupo tiene ítem singular como Inicio).
- ⌘ + letra: ítems frecuentes (R=Reservas, F=Folios, L=Calendario, G=Rack, K=Check-in).
- ⌥ + letra: ítems secundarios (W=Walk-in).
- ⌘, abre Settings.
- ⌘K abre Command Palette.

---

## 4. Estados y skins

### Visual states
- **Default:** label gris-700, icon gris-500.
- **Hover:** fondo gris-100, icon en color modo.
- **Active (ítem seleccionado):** fondo accent-50, label accent-700 bold, icon accent-600. Barra lateral 3 px accent.
- **Disabled (sin permiso pero visible en debug):** opacidad 40%, sin click.

### Dark mode
- Fondo sidebar `#1C1C1E`, ítems `#A8A8AD`, active `#2C2C2E` con accent.

### Densidad
- Comfortable: 32 px alto por ítem (default).
- Compact: 26 px (configurable en Settings).

---

## 5. Tokens (design system)

```scss
--sidebar-width: 260px;
--sidebar-bg: var(--surface-1);
--sidebar-item-height: 32px;
--sidebar-group-header-color: var(--text-tertiary);
--sidebar-item-color: var(--text-secondary);
--sidebar-item-active-bg: var(--accent-50);
--sidebar-item-active-color: var(--accent-700);
--sidebar-icon-size: 16px;
--sidebar-shortcut-color: var(--text-quaternary);
--sidebar-badge-critical: var(--red-500);
--sidebar-badge-warning: var(--orange-500);
--sidebar-badge-info: var(--blue-500);
--sidebar-padding-x: 12px;
--sidebar-group-gap: 4px;
```

---

## 6. Accesibilidad
- Roles ARIA: `<nav role="navigation">`, grupos `role="tree"`, ítems `role="treeitem"`.
- Navegación teclado: ↑↓ entre ítems, ←→ colapsar/expandir, Enter abre.
- Focus visible accesible (anillo 2 px accent).
- Mín contraste 4.5:1 en labels, 3:1 en iconos.
- Anuncios SR para badges: "Folios, 4 pendientes".

---

## 7. Notas de implementación
- Componente: `<Sidebar />` con slots `header`, `pinned`, `groups`, `footer`.
- Estado global en `useSidebarStore` (Zustand): `mode`, `collapsedGroups`, `favorites`, `recent`.
- Datos del menú: JSON declarativo `sidebar.config.ts` con permisos y modo.
- Animación colapso: `framer-motion` height auto, 180 ms ease-out.
- Lazy load del Command Palette (⌘K) — no en bundle inicial.

---

## 8. Resumen ejecutivo

8 grupos jerárquicos colapsables, defaults inteligentes (Inicio + Front Desk abiertos), búsqueda y favoritos arriba, mode switcher abajo. Filtrado por rol oculta lo irrelevante. Iconos + labels + shortcuts + badges para escaneo rápido. Persistencia por usuario. Soporta PMS, ERP y Compliance como modos. Diseñado para reducir clicks en recepción (top 5 acciones en 1 nivel) sin sacrificar profundidad para admin/dev.
