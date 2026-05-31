# Mobile responsive Cocoa

## Breakpoints (matching iPadOS/iOS standards)
- xxl: 1280px+ (Desktop full layout)
- xl: 1024-1279 (Desktop compact)
- lg: 768-1023 (Tablet landscape)
- md: 600-767 (Tablet portrait)
- sm: <600 (iPhone)

## Adaptaciones por breakpoint

### xxl (Desktop full)
- CocoaSplitView: 240px sidebar | 1fr | 320px inspector
- CocoaToolbar: muestra todos los items

### xl (Desktop compact)
- Inspector se colapsa a icon-only o toggleable

### lg (Tablet landscape)
- Sidebar reducido a 64px icons-only
- Click expande overlay sidebar

### md (Tablet portrait)
- Sidebar como bottom tab bar (5 tabs primarios)
- Toolbar simplificado

### sm (iPhone)
- Bottom tab bar siempre
- Modals -> full-screen sheets
- CocoaTable -> cards verticales
- CocoaSegmentedControl -> 2-row si muchos options

## Touch targets
Minimo 44x44px (Apple HIG) en mobile. En desktop puede ser 28-32px.

## Gestos
- Swipe izquierda en row -> reveal acciones
- Swipe abajo en sheet -> cerrar
- Pinch en zonas zoomables

## Tipografia
Escalado: 100% desktop, 110% tablet, 115% mobile para mejor legibilidad.
