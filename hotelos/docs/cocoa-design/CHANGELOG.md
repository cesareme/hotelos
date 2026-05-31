# Changelog · HotelOS Aurora Cocoa Edition

Todos los cambios notables documentados aqui. Sigue Keep a Changelog y Semantic Versioning.

## [3.0.0] · 2026-05-30 · Cocoa Edition

### Added — Componentes (25 total)

#### Cocoa core (12)
- CocoaButton: 4 variants × 3 sizes × 3 tones
- CocoaInput, CocoaSelect, CocoaSearchInput
- CocoaSegmentedControl, CocoaStepper, CocoaSwitch, CocoaDatePicker
- CocoaCard variants elevated/bordered/flat
- CocoaTable NSTableView style
- CocoaPopover, CocoaSheet
- CocoaToolbar (con traffic lights), CocoaSidebar (Source List), CocoaSplitView
- CocoaPageHeader

#### Cocoa extras (5)
- CocoaAlert (info/warning/critical)
- CocoaColorWell
- CocoaContextMenu
- CocoaFormFieldset
- CocoaToolbarSearchField

#### Cocoa globals (8)
- CocoaCommandPalette ⌘K
- CocoaPreferencesSheet ⌘,
- CocoaNotificationCenter
- CocoaKeyboardShortcutsHelp ⌘/
- CocoaStatusBar
- CocoaThemeToggle
- CocoaQuickActionsBar
- CocoaAboutDialog

### Added — Assets
- 36 SF Symbols-style icons (NavigationIcons + ActionIcons + StatusIcons)
- 5 SVG illustrations (EmptyStateBox/Search/Error/Connection + SuccessIllustration)
- CocoaEmptyState wrapper
- cocoa-motion library (springs + duration presets + hooks)
- cocoa-tokens.css con full token system (light+dark)

### Added — Pantallas Cocoa
- CocoaLoginScreen (split layout brand + form)
- CocoaNotFoundScreen (404)
- CocoaServerErrorScreen (500 con auto-retry)
- CocoaOnboardingWizard (5 pasos)
- CocoaShowcaseScreen (developer tool)

### Added — Backend
- GET/PATCH /users/me/preferences (themePreference, accentColor, reducedMotion, highContrast)
- GET /developer/keyboard-shortcuts (catalogo)
- User model: themePreference, accentColor, reducedMotion, highContrast

### Added — Documentacion (15+ documentos)
- EXECUTIVE-SUMMARY.md, CHEAT-SHEET.md, INTEGRATION-GUIDE.md, INDEX.md
- 7 migration plans en migration-plans/
- Cocoa research papers (color, typography, motion, materials)

### Changed — Migracion pantallas
- BackOfficeDashboard migrado a CocoaPageHeader + CocoaCard + CocoaButton + icons
- 7 pantallas adicionales migradas via W6

### Performance
- operations chunk: 488 KB → 338 KB (-31%) via lazy load + manualChunks
- Cocoa core gzipped: ~28 KB
- Cocoa globals gzipped: ~26 KB

### Testing
- 214/214 tests PASS pre-Cocoa baseline preservado

## [2.x] · Aurora Material
- (Versiones anteriores en CHANGELOG legacy)
