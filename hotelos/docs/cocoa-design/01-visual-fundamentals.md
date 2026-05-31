# 01 · Cocoa Visual Fundamentals & Evolución macOS

> Fuente base para HotelOS · síntesis de Apple HIG, AppKit docs y análisis de la evolución del diseño macOS desde Mac OS X (2001) hasta Tahoe (2025).

---

## 1. Evolución visual macOS (Aqua → Tahoe)

### 1.1 Aqua / Mac OS X (2001–2013)
- **Aqua** definió el lenguaje fundacional: botones rojo/amarillo/verde con apariencia de gel, scrollbars rayadas tipo caramelo, barras de título degradadas, scroll arrows, "brushed metal" en apps pro (iTunes, Safari, QuickTime).
- Filosofía: **skeuomorfismo + profundidad** vía sombras, reflejos, gradientes.
- Permaneció ~12 años; estableció traffic lights en la esquina superior izquierda como marca de identidad ([Aqua – Wikipedia](https://en.wikipedia.org/wiki/Brushed_Metal_(interface))).

### 1.2 Yosemite → Mojave (2014–2019)
- Yosemite (10.10) aplanó Aqua, traduciendo el lenguaje de iOS 7 a Mac: tipografía Helvetica Neue / luego SF, blur translúcido en sidebars, traffic lights más planos.
- Mojave introdujo **Dark Mode** y **accent color** del sistema ([WWDC 2018 218 – Advanced Dark Mode](https://asciiwwdc.com/2018/sessions/218)).

### 1.3 Big Sur (2020) — el gran reset
La actualización visual más grande desde 2001 ([Design Ups & Downs of macOS – rausr](https://rausr.com/blog/design-ups-and-downs-of-apple-macos/)):
- **Iconos squircle** unificados con iOS.
- **Dock despegado** del borde, esquinas redondeadas.
- **Title bar plano**, sin gradiente; título en bold integrado con toolbar; **toolbar items sin bisel**, sólo aparecen en hover.
- **Sidebars de altura completa** (full-height) extendidas hasta el title bar usando `NSWindow.StyleMask.fullSizeContentView`.
- Nuevos `NSWindow.toolbarStyle`: `.unified`, `.unifiedCompact`, `.preference`, `.expanded`, `.automatic` ([mackuba – Adopt the new look of macOS](https://mackuba.eu/notes/wwdc20/adopt-new-look-of-macos/)).
- Selección de tabla pasó a **inset style** con padding extra y filas más altas.
- SF Symbols disponibles en Mac.

### 1.4 Monterey → Sonoma → Sequoia (2021–2024)
- Refinamientos incrementales, no rediseño. Sequoia (2024) trajo iPhone Mirroring y window tiling, y rediseñó Calculator con botones redondeados estilo iOS, pero **no** un cambio visual sistémico ([macOS Sequoia – Wikipedia](https://en.wikipedia.org/wiki/MacOS_Sequoia)).

### 1.5 Tahoe / macOS 26 (2025) — Liquid Glass
El segundo gran rediseño en 25 años ([Apple Newsroom – Delightful new software design](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)):
- **Liquid Glass**: material translúcido que refracta y refleja su entorno, transformándose dinámicamente.
- **Menu bar 100% transparente**.
- **Controles concéntricos** con esquinas redondeadas que cuadran con el bezel del hardware.
- Sidebars que **refractan** el contenido detrás y **reflejan** el wallpaper.
- Iconos compuestos por **múltiples capas de Liquid Glass** con specular highlights; modos light/dark, tinted, clear.
- Toolbar items "morfan dinámicamente" al cambiar contexto.

> Nota: Apple introdujo controles para **reducir** Liquid Glass (Settings → Accessibility → Display → Reduce transparency / Tinted mode) tras feedback de legibilidad ([osxdaily](https://osxdaily.com/2025/10/07/how-reduce-liquid-glass-macos-tahoe/), [eclecticlight 26.1](https://eclecticlight.co/2025/11/05/appearance-revisited-get-tahoe-26-1-looking-in-better-shape/)).

---

## 2. Anatomía de una ventana Cocoa

De arriba a abajo, los elementos canónicos de una `NSWindow` ([NSWindow docs](https://developer.apple.com/documentation/appkit/nswindow)):

1. **Title bar**
   - **Traffic lights** (close rojo, minimize amarillo, zoom verde) en `top-left`, ~12pt diámetro, 8pt de separación. Apple los llama oficialmente "window control buttons" ([macos-traffic-light-buttons-as-SVG](https://github.com/lwouis/macos-traffic-light-buttons-as-SVG)).
   - **Título** centrado o inline (Big Sur+).
   - Soporta **accessory views** vía `titlebarAccessoryViewControllers`.
   - Puede hacerse transparente con `titlebarAppearsTransparent = true`.
2. **Toolbar** (`NSToolbar`) — opcional pero esperada en apps de productividad. Estilos: unified, unifiedCompact, preference, expanded, automatic. Items sin bisel desde Big Sur ([NSToolbar docs](https://developer.apple.com/documentation/appkit/nstoolbar)).
3. **Sidebar / Source list** — full-height desde Big Sur, material `.sidebar` con vibrancy automática. Iconos toman el accent color del usuario; configurable con `NSTintConfiguration`.
4. **Content area** — el corazón de la app. Puede combinarse con `NSSplitViewController` (sidebar + content + inspector).
5. **Status bar / footer** — opcional, suele alojar contadores, filtros, o controles secundarios.
6. **Inspector pane** (opcional, derecha) — patrón común en apps pro (Finder, Notes, Mail).

```
┌──────────────────────────────────────────────┐
│ ●●●  Title           [Toolbar items]    [⊕] │  ← title bar + toolbar (unified)
├────────┬─────────────────────────────────────┤
│        │                                     │
│ Side   │           Content                   │
│ bar    │                                     │
│        │                                     │
├────────┴─────────────────────────────────────┤
│ 23 items · Filter: All                       │  ← status bar
└──────────────────────────────────────────────┘
```

---

## 3. Principios HIG vigentes (2025)

Apple sostiene tres principios desde iOS 7 / Yosemite, ahora reinterpretados con Liquid Glass ([HIG](https://developer.apple.com/design/human-interface-guidelines), [WWDC25 356 – Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)):

| Principio | Significado | Implementación 2025 |
|---|---|---|
| **Clarity** | Texto legible en cualquier tamaño, iconos precisos, jerarquía visual evidente | SF Pro, controles concéntricos, contraste WCAG AA |
| **Deference** | El chrome cede protagonismo al contenido | Liquid Glass translúcido, toolbar sin bisel, menu bar transparente |
| **Depth** | Capas y movimiento realista que comunican jerarquía | Refracción/reflejo de Liquid Glass, sombras suaves, transiciones spring |

Específico macOS ([Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)):
- Aprovecha **pantallas grandes**: menos modalidad, menos navegación anidada, density confortable.
- **Menu bar siempre** con todos los comandos accesibles.
- Ventanas **resizables, moveables, escondibles**; soporta full-screen.
- **Multi-window** y **multi-document** son ciudadanos de primera, no excepciones.

---

## 4. Qué NO hacer en una app Mac

1. **No portar diseño Windows/Linux 1:1.** Una app Electron flat con menubar en la ventana, traffic lights mal colocados y sidebar oscura grita "no-Mac" ([HIG – Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)).
2. **No usar iconos planos monocromos sin alma.** Apps Mac-only (Xcode, Preview, TextEdit) mantienen profundidad skeuomórfica; iconos completamente flat se sienten "uncanny valley" en el Dock ([erik-engheim – Big Sur flat design](https://erik-engheim.medium.com/big-sur-sucks-817cba889376), [PrusaSlicer #4828](https://github.com/prusa3d/PrusaSlicer/issues/4828)).
3. **No reinventar window controls.** Mantén traffic lights en `top-left`, no los muevas ni los reemplaces con iconos custom salvo razón muy fuerte.
4. **No ignores el menu bar.** En Mac el menu bar es contractual: File, Edit, View, Window, Help son esperados; toolbar en ventana no es sustituto.
5. **No abuses de modales/sheets.** Mac prefiere palettes, inspectors y multi-window sobre modales bloqueantes.
6. **No hardcodees colores.** Usa `NSColor.controlAccentColor`, `labelColor`, `windowBackgroundColor` — son **dynamic** y resuelven al draw time según Light/Dark + accent del usuario ([NSColor.controlAccentColor](https://developer.apple.com/documentation/appkit/nscolor/3000782-controlaccentcolor)).
7. **No omitas vibrancy en sidebars y popovers.** Una sidebar opaca rompe la sensación Mac.
8. **No uses fuentes ajenas a SF** sin razón editorial. SF Pro / SF Mono / New York son las del sistema.
9. **No olvides Reduce Transparency / Increase Contrast** — apps que ignoran accessibility prefs son inmediatamente "off-brand".

---

## 5. Tendencias 2025 a explotar

- **Vibrancy + Materials**: `NSVisualEffectView` con `.sidebar`, `.titlebar`, `.menu`, `.popover`, `.hudWindow`, `.sheet`, `.windowBackground`. `blendingMode = .behindWindow` para chrome, `.withinWindow` para overlays. State `.followsWindowActiveState` por defecto ([NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview), [Material.sidebar](https://developer.apple.com/documentation/AppKit/NSVisualEffectView/Material-swift.enum/sidebar)).
- **Esquinas redondeadas concéntricas**: controles, ventanas y hardware del Mac comparten radio para sensación de unidad ([Apple Newsroom Tahoe](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)).
- **Transparencia con sentido**: menu bar transparente, toolbars unified que se funden con el contenido al scroll, sidebars que refractan el wallpaper.
- **Accent dinámico**: leer `NSColor.controlAccentColor` y observar `AppleColorPreferencesChangedNotification` para reaccionar a cambios sin reiniciar ([alexwlchan](https://alexwlchan.net/2022/changing-the-macos-accent-colour/)).
- **SF Symbols 6/7** con variantes hierarchical, palette, multicolor — escalables, accent-aware.
- **Toolbar morphing**: controles que cambian forma según contexto (Tahoe). En SwiftUI: `.toolbar` con `ToolbarItem` agrupados y placement `.principal` / `.navigation`.
- **Light, Dark, Tinted, Clear**: cuatro apariencias de iconos. Diseñar templates SVG/PDF con capas separables.
- **Concentricity** como principio de layout: padding interno de un container = radius del container exterior menos radius del child, para que las esquinas anidadas concentren visualmente.

---

## 6. Checklist de "Mac-nativeness" para HotelOS

- [ ] Traffic lights nativos en top-left, no custom.
- [ ] Toolbar `NSToolbar` con `.unified` o `.unifiedCompact`, items sin bisel.
- [ ] Sidebar `NSSplitViewController` con material `.sidebar`, full-height.
- [ ] Menu bar completo: File / Edit / View / Window / Help + menús de dominio.
- [ ] SF Pro como tipografía principal; SF Mono para datos/IDs.
- [ ] Colores semánticos (`labelColor`, `controlAccentColor`, etc.), no hex hardcoded.
- [ ] Soporte Light / Dark / accessibility (Reduce Transparency, Increase Contrast, Reduce Motion).
- [ ] SF Symbols para iconografía UI; iconos de marca con profundidad multi-layer para el Dock.
- [ ] Vibrancy en sidebars, popovers, sheets, HUDs.
- [ ] Esquinas redondeadas concéntricas (ventana → sidebar → tarjetas).
- [ ] Animaciones spring suaves, respetar `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`.

---

## Fuentes

- [Apple HIG – Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)
- [Apple HIG home](https://developer.apple.com/design/human-interface-guidelines)
- [WWDC25 356 – Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)
- [Apple Newsroom – Liquid Glass announcement](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)
- [NSWindow documentation](https://developer.apple.com/documentation/appkit/nswindow)
- [NSToolbar documentation](https://developer.apple.com/documentation/appkit/nstoolbar)
- [NSVisualEffectView documentation](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- [NSVisualEffectView.Material.sidebar](https://developer.apple.com/documentation/AppKit/NSVisualEffectView/Material-swift.enum/sidebar)
- [NSColor.controlAccentColor](https://developer.apple.com/documentation/appkit/nscolor/3000782-controlaccentcolor)
- [mackuba – Adopt the new look of macOS (WWDC20)](https://mackuba.eu/notes/wwdc20/adopt-new-look-of-macos/)
- [mackuba – Dark Side of the Mac: Appearance & Materials](https://mackuba.eu/2018/07/04/dark-side-mac-1/)
- [Michael Tsai – macOS Big Sur Changes for Developers](https://mjtsai.com/blog/2020/10/02/macos-big-sur-changes-for-developers/)
- [Michael Tsai – Liquid Glass Disbelief](https://mjtsai.com/blog/2025/12/29/liquid-glass-disbelief/)
- [macOS Sequoia – Wikipedia](https://en.wikipedia.org/wiki/MacOS_Sequoia)
- [Aqua / Brushed Metal – Wikipedia](https://en.wikipedia.org/wiki/Brushed_Metal_(interface))
- [Apple Aqua – UX Planet (Nick Babich)](https://uxplanet.org/apple-aqua-exploring-the-legacy-of-macos-x-user-interface-3a11eb9b7dba)
- [Design Ups & Downs of macOS – rausr](https://rausr.com/blog/design-ups-and-downs-of-apple-macos/)
- [erik-engheim – Big Sur is Flat Design Gone Crazy](https://erik-engheim.medium.com/big-sur-sucks-817cba889376)
- [GitHub – NSWindowStyles showcase (lukakerr)](https://github.com/lukakerr/NSWindowStyles)
- [GitHub – TitlebarAndToolbar (robin)](https://github.com/robin/TitlebarAndToolbar)
- [GitHub – macos-traffic-light-buttons-as-SVG (lwouis)](https://github.com/lwouis/macos-traffic-light-buttons-as-SVG)
- [alexwlchan – Changing the macOS accent colour](https://alexwlchan.net/2022/changing-the-macos-accent-colour/)
- [osxdaily – Reduce Liquid Glass on macOS Tahoe](https://osxdaily.com/2025/10/07/how-reduce-liquid-glass-macos-tahoe/)
- [eclecticlight – Tahoe 26.1 appearance revisited](https://eclecticlight.co/2025/11/05/appearance-revisited-get-tahoe-26-1-looking-in-better-shape/)
- [Tom's Guide – macOS Tahoe review](https://www.tomsguide.com/computing/macos/apple-macos-tahoe-review)
- [WWDC 2018 218 – Advanced Dark Mode](https://asciiwwdc.com/2018/sessions/218)
