# Componentes Cocoa 22

Especificación: `docs/design/COCOA-22.md` (§8 = API generada desde los tipos exportados;
`node docs/design/cocoa-22-api.mjs --check` falla cuando el código cambia sin regenerarla).
Contrato automático: `tests/cocoa-22-contract.test.mjs` (§9). Referencia viva:
`/desarrollo/guia-estilo` (`screens/dev/StyleGuideScreen.tsx`, primera consumidora de cada primitiva).

## Estructura (cierre de la migración · ola 11 · 2026-09-16)
```
components/
├── cocoa/               ← primitivas del sistema (barrel index.ts; 40 ficheros): CocoaPage, CocoaPageHeader,
│                          HostedHead, CocoaButton, CocoaField/Input/Select/Switch/DatePicker, CocoaTable,
│                          CocoaKpi/KpiStrip/Stat/Delta, CocoaCard/Section/Grid, CocoaDrawer/Dialog/Sheet/Popover,
│                          CocoaState/Skeleton, CocoaChart, CocoaBadge/Callout, tonos (cocoa-tones.ts)…
├── cocoa-extras/        ← secundarios fuera del barrel: DegradedValue (re-exportado), CocoaDataPreview,
│                          CocoaContextMenu, CocoaToolbarSearchField; CocoaAlert y CocoaFormFieldset son legado
│                          sin uso en pantallas (→ CocoaCallout, CocoaFormSection)
├── cocoa-global/        ← globales del shell: paleta ⌘K, preferencias, notificaciones, atajos, acerca de…
├── cocoa-guidance/      ← guía intrínseca (CocoaHelpButton, CocoaEmptyStateGuide, instrucciones por pantalla)
├── cocoa-director/      ← gráficas y tarjetas del cuadro de mando de dirección
├── cocoa-rate-grid/     ← parrilla de tarifas (README.md propio)
├── cocoa-icons/         ← ActionIcons · NavigationIcons · StatusIcons (prop `size`)
├── cocoa-illustrations/ ← 5 ilustraciones SVG de los estados vacíos
├── guide/               ← tour guiado, centro de ayuda y bienvenida (styles/cocoa-22-guide.css)
├── billing/ · finance/  ← diálogos de cobro/devolución y selector de ámbito financiero
├── CommandPalette.tsx   ← ⌘K
└── Toast.tsx            ← useToast() (render CocoaToast)
```

Retirados en la ola 11 (0 importadores; copia en el commit de retirada): `cocoa-empty-state/`
(→ `CocoaState kind="empty"`), `cocoa-extras/CocoaColorWell.tsx`, `States.tsx`, `SidePanel.tsx`,
`SubmissionDetailPanel.tsx`, `ConfirmDialog.tsx`, `NarrowViewportBanner.tsx`, `TopBar.tsx`,
`forms/FormComponents.tsx`, `v2/**`, el alias `DirectorKpiTile` (→ `CocoaKpi`) y el helper
`cocoa-rate-grid/helpers.ts toastOffsetForBar` (el offset del toast lo publica `CocoaActionBar`).

## Convenciones (§8 de la spec)
1. Raíz `data-cocoa="<nombre>"` + clase `c22-<nombre>` (partes `c22-<nombre>__<parte>`, variantes en `data-*`,
   tonos por `data-tone`); estilos en `styles/cocoa-22*.css` solo con `var(--cocoa-*)`.
2. Cada componente exporta `NombreProps` + `Nombre`; `className`/`style` de escape solo para layout (regla 6).
3. Ningún otro design system (Material, Tailwind…) y ningún color literal fuera de `cocoa-tokens.css`.
4. Modo oscuro por `data-theme='dark'` (tokens); un solo acento Esmeralda (nadie escribe `--cocoa-accent` en línea).

## Ejemplos
`/desarrollo/guia-estilo` (`?dev=1`, administrador de plataforma): cada bloque lleva su JSX con botón «Copiar».
Plantillas por arquetipo en `COCOA-22.md` §4.3 (`node docs/design/cocoa-22-api.mjs --typecheck-examples`).

## Tests
`components/cocoa/__tests__/*.test.mts` (tokens, API, comportamiento) y el contrato `tests/cocoa-22-contract.test.mjs`.
