# Componentes Cocoa Edition

## Estructura
```
components/
├── cocoa/              ← 12 componentes base (Button, Input, Card, Table, ...)
├── cocoa-extras/       ← 5 componentes secundarios (Alert, ColorWell, ContextMenu, ...)
├── cocoa-global/       ← 8 componentes globales (CommandPalette, Preferences, ...)
├── cocoa-icons/        ← 36 iconos SF Symbols style
├── cocoa-illustrations/← 5 illustrations SVG
└── cocoa-empty-state/  ← Wrapper EmptyState con illustration
```

## Convenciones
1. Cada componente exporta tipo NombreProps + componente Nombre
2. Estilos inline con var(--cocoa-*) tokens
3. No usa otros design systems (Material, Tailwind, etc.) — pure Cocoa
4. dark mode automatico via data-theme='dark'

## Ejemplos
Ver screens/developer/CocoaShowcaseScreen.tsx

## Tests
Ver __tests__/cocoa.test.tsx (cuando existan)
