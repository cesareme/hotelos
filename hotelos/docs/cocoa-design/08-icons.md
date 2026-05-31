# 08 · Iconografia para HotelOS

## 1. SF Symbols: panorama general

SF Symbols 7 (2026) es la libreria oficial de Apple, con mas de **6.900 simbolos** disenados para integrarse con la tipografia San Francisco. Cada simbolo se alinea automaticamente con el texto, se escala y se colorea como una glyph mas. Es el estandar de facto en apps nativas Mail, Calendar, Notes, Reminders, Finder.

**Limitacion critica para HotelOS web**: la licencia de SF Symbols solo permite su uso en apps que corren sobre plataformas Apple. **No se pueden embeber en una web** (incluido el web font `SF-Pro.woff2`). Si HotelOS tendra cliente web/PWA, debemos usar otra libreria.

---

## 2. SF Symbols mas usados en apps profesionales

Subset relevante para HotelOS (hotel management):

| Categoria | Simbolos clave |
|---|---|
| **Personas / Guests** | `person`, `person.fill`, `person.2`, `person.crop.circle`, `person.badge.key`, `figure.walk` |
| **Comunicacion** | `envelope`, `envelope.fill`, `envelope.badge`, `bubble.left`, `phone`, `phone.badge.waveform` |
| **Calendario / Reservas** | `calendar`, `calendar.badge.plus`, `calendar.badge.clock`, `clock`, `clock.arrow.circlepath` |
| **Edificio / Hotel** | `building`, `building.2`, `building.columns`, `bed.double`, `bed.double.fill`, `house` |
| **Documentos** | `doc`, `doc.text`, `doc.fill`, `doc.badge.plus`, `folder`, `tray`, `tray.full` |
| **Finanzas** | `creditcard`, `dollarsign.circle`, `eurosign.circle`, `chart.line.uptrend.xyaxis`, `chart.bar` |
| **Configuracion** | `gearshape`, `gearshape.2`, `slider.horizontal.3`, `key`, `lock`, `lock.shield` |
| **Navegacion** | `chevron.left`, `chevron.right`, `magnifyingglass`, `plus.circle`, `xmark.circle` |
| **Estados** | `checkmark.circle.fill`, `exclamationmark.triangle.fill`, `info.circle`, `bell` |
| **Limpieza / Operaciones** | `sparkles`, `wrench.and.screwdriver`, `washer`, `fork.knife`, `cart` |

Hay un patron consistente: `name`, `name.fill`, `name.circle`, `name.badge.X`, `name.slash`.

---

## 3. Variantes: weight y scale

**9 weights**: `ultraLight`, `thin`, `light`, `regular`, `medium`, `semibold`, `bold`, `heavy`, `black`. Estos coinciden con los pesos de San Francisco, asi que un simbolo dentro de un titulo en `bold` se renderiza automaticamente en weight `bold`.

**3 scales**: `small`, `medium`, `default`. Ajustan el grosor optico segun tamano.

**Variants**: `.fill` (relleno), `.circle` (envuelto en circulo), `.slash` (con linea diagonal = "off"), `.badge.X` (con badge superpuesto, ej. `envelope.badge`).

Recomendacion HotelOS para mockups nativos: weight `regular` en cuerpo, `semibold` en tab bars/toolbars, `medium` en sidebars.

---

## 4. Rendering modes (SF Symbols 3+)

| Modo | Comportamiento | Uso tipico |
|---|---|---|
| **Monochrome** | Un solo color aplicado a todas las capas. | Default. Toolbars, body text. |
| **Hierarchical** | Un color, diferentes opacidades por capa. Profundidad. | Sidebars, status cards. |
| **Palette** | 2-3 colores explicitos por capa. | Iconos compuestos: `person.crop.circle.badge.checkmark`. |
| **Multicolor** | Colores intrinsecos del simbolo (verde para hoja, rojo para trash.slash). | Errores, semaforos, finance. |

En SwiftUI: `Image(systemName: "envelope.badge").symbolRenderingMode(.hierarchical)`.

---

## 5. Como usarlos en web

Tres caminos, ninguno ideal:

1. **Export SVG desde la app SF Symbols**: File > Export Symbol. Genera SVG editable. **Licencia bloquea** uso en web publica/non-Apple.
2. **Web font de Apple** (`SF-Pro.woff2`, `SFSymbols.woff2`): mismo problema de licencia, ademas glyphs aparecen como cuadros vacios en navegadores non-Safari sin fallback.
3. **Emojis Apple**: `📧 📅 🏨` solo se renderizan asi en macOS/iOS. En Windows/Android cambian de estilo. **No es profesional**.

**Conclusion**: para la app macOS nativa de HotelOS, usar SF Symbols. Para el cliente web (admin panel, booking widget, PWA), usar otra libreria.

---

## 6. Recomendacion para HotelOS web: lucide-react

Comparativa de las 3 opciones serias en 2026:

| Libreria | Iconos | Stroke | Bundle/icono | Cobertura |
|---|---|---|---|---|
| **lucide-react** | 1.500+ | 2px, 24px grid | ~1KB tree-shaken | Amplia, fork mantenido de Feather |
| **heroicons** | 292 | 1.5px outline + 24px solid | ~1KB | Pequena, optimizada Tailwind |
| **tabler-icons** | 5.000+ | 2px, 24px grid | ~1KB | Maxima cobertura |

**Recomendacion: lucide-react.**

Razones:
- Estetica clean, line-based, que combina bien con el aire "Mail.app moderno" que buscamos en HotelOS.
- Cobertura suficiente: tiene `mail`, `calendar`, `users`, `building-2`, `bed`, `key-round`, `credit-card`, `gauge`, `wrench`, etc.
- Tree-shakeable, MIT, mantenido activamente, usado por shadcn/ui (alineado con nuestra stack web).
- Menos "generico" que heroicons (que se ve en cada starter Tailwind) y mas curado que tabler (que tiene ruido).

**Fallback alternativo**: si necesitamos un icono muy especifico de hospitality (servicio de toallas, room service tray), complementar con **tabler-icons** importando solo ese icono concreto.

**Lo que NO recomendamos**: 
- Emojis (no profesional, inconsistente cross-platform).
- font-awesome (estetica obsoleta, restricciones pro tier).
- Material Icons (estetica Google, choca con lenguaje Cocoa que persigue HotelOS).

---

## 7. Decision final HotelOS

- **App macOS nativa**: SF Symbols 7, rendering mode `hierarchical` para sidebars, `monochrome` para body, `multicolor` solo en estados/finance.
- **Web (admin + booking widget)**: **lucide-react** como libreria base, con paleta de stroke 2px, 24px size, color heredado de tokens (`--color-text`, `--color-accent`).
- Mantener un **archivo de mapeo** `icons.ts` que exponga semanticamente: `IconGuest`, `IconReservation`, `IconRoom`, etc., aislando la libreria concreta y permitiendo swap futuro.

Sources:
- [SF Symbols - Apple Developer](https://developer.apple.com/sf-symbols/)
- [SF Symbols HIG](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)
- [Complete Guide to SF Symbols - Hacking with Swift](https://www.hackingwithswift.com/articles/237/complete-guide-to-sf-symbols)
- [SF Symbols Rendering Modes](https://sparrowcode.io/en/tutorials/sf-symbols-and-render-mode)
- [Use SF Symbols on the Web - codestudy.net](https://www.codestudy.net/blog/is-there-a-way-to-use-the-apple-sf-symbols-on-the-web/)
- [sf-symbols-svg - GitHub](https://github.com/MoOx/sf-symbols-svg)
- [Lucide vs Heroicons comparison](https://allsvgicons.com/compare/lucide-vs-heroicons/)
- [Best React Icon Libraries 2026 - Mighil](https://mighil.com/best-react-icon-libraries)
- [tabler-icons-react vs lucide-react - devpick](https://devpick.co/lucide-react-vs-tabler-icons-react)
