# 06 · Motion & Animations (Cocoa → Web)

Motion en macOS se siente "vivo" porque combina **physics-based springs** para gestos interactivos y **timing curves** (cubic Bezier) para transiciones deterministas. La regla de oro de Apple: el movimiento debe **reforzar la relación entre acción y resultado**, mantener continuidad espacial, y respetar la preferencia *Reduce Motion*.

---

## 1. Spring physics — qué usa Apple

SwiftUI expone dos modelos de spring:

### Modelo moderno (`response` + `dampingFraction`)
| Parámetro | Rango | Default | Significado |
|-----------|-------|---------|-------------|
| `response` | 0.1 – 1.0 s | **0.55** | Tiempo perceptual del rebote (≈ período natural). Menor = más rápido/snappy. |
| `dampingFraction` | 0 – 1 | **0.825** | 1 = crítico (sin oscilar), <1 = rebota, 0 = oscila eterno. |
| `blendDuration` | 0 – ∞ s | 0 | Transición suave entre springs. |

**Presets oficiales** (SwiftUI/AppKit):
- `.smooth` → `response: 0.5, damping: 1.0` (sin rebote, transiciones de layout)
- `.snappy` → `response: 0.5, damping: 0.85` (default de iOS 17/macOS 14, leve rebote)
- `.bouncy` → `response: 0.5, damping: 0.7` (rebote claro, modales que aparecen)
- `.interactiveSpring` → `response: 0.15, damping: 0.86` (drag/follow gesture)

### Modelo físico (`interpolatingSpring`)
`mass: 1.0, stiffness: 100, damping: 10` ≈ default. Damping ratio se calcula como `damping / (2 * sqrt(mass * stiffness))`.

### AppKit equivalente
`CASpringAnimation` con `mass`, `stiffness`, `damping`, `initialVelocity`. Usa `settlingDuration` para sincronizar duraciones con otras capas.

---

## 2. Timing curves (cubic Bezier)

`CAMediaTimingFunction` mapea progreso normalizado [0,1] mediante Bezier. Las nombradas:

| Nombre | Control points (c1x,c1y,c2x,c2y) | Uso |
|--------|----------------------------------|-----|
| `linear` | (0,0,1,1) | Progress bars, loops |
| `easeIn` | (0.42, 0, 1, 1) | Salidas (objeto se va) |
| `easeOut` | (0, 0, 0.58, 1) | Entradas (objeto llega) |
| `easeInEaseOut` | (0.42, 0, 0.58, 1) | Transiciones simétricas |
| `default` | (0.25, 0.1, 0.25, 1) | Curva "Apple natural" |

**Curva "Apple ease-out" frecuente en sistema**: `(0.2, 0.0, 0.0, 1.0)` — arranque firme, frenado suave.
**"Apple ease-in-out estándar"**: `(0.4, 0.0, 0.2, 1.0)` — Material-like, neutral y predecible.

---

## 3. Durations recomendadas

NSAnimationContext default = **0.25 s**. Apple HIG sugiere escala perceptual:

| Interacción | Duración | Curva |
|-------------|----------|-------|
| Hover (color/elevación) | **0.10 s** | `easeOut` |
| Focus ring, micro-feedback | **0.15 s** | `easeOut` |
| Standard transition (tab, swap) | **0.20–0.25 s** | `easeInEaseOut` |
| Modal/sheet/popover entrada | **0.30 s** | `spring(.snappy)` o ease-out |
| Page/scene change, window resize | **0.40 s** | `easeInEaseOut` |
| NSWindow open/close (sistema) | ~0.20–0.30 s | spring suave |

Regla: entradas más cortas que salidas no. Inverso: **entradas un poco más largas** para "anunciar" el elemento; salidas rápidas para no estorbar.

---

## 4. Reduce Motion — respeto obligatorio

**Cocoa**:
```swift
NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
// Observa cambios:
NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, ...)
```

**SwiftUI**: `@Environment(\.accessibilityReduceMotion)`.

Cuando es `true`:
- Sustituir slides/scales por **cross-fade** (opacity 0→1) o cambio instantáneo.
- Eliminar parallax, bounce, autoplay.
- **Mantener duración** (no hace falta acortar) — solo cambiar el *tipo* de movimiento.

**Web equivalente**:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 5. Aproximación Web — CSS variables

```css
:root {
  /* Easings Apple-like */
  --ease-out-apple:     cubic-bezier(0.2, 0.0, 0.0, 1.0);
  --ease-in-out-apple:  cubic-bezier(0.4, 0.0, 0.2, 1.0);
  --ease-in-apple:      cubic-bezier(0.4, 0.0, 1.0, 1.0);
  --ease-default-apple: cubic-bezier(0.25, 0.1, 0.25, 1.0);

  /* Durations */
  --dur-hover:      100ms;
  --dur-focus:      150ms;
  --dur-transition: 200ms;
  --dur-modal:      300ms;
  --dur-page:       400ms;
}

.button         { transition: background var(--dur-hover) var(--ease-out-apple); }
.input:focus    { transition: box-shadow var(--dur-focus) var(--ease-out-apple); }
.tab-content    { transition: opacity var(--dur-transition) var(--ease-in-out-apple); }
.modal          { transition: transform var(--dur-modal) var(--ease-out-apple),
                              opacity   var(--dur-modal) var(--ease-out-apple); }
```

---

## 6. Spring en CSS — dos caminos

### A) Bezier que imita un spring (sin rebote real, basta para la mayoría)
```css
:root {
  --spring-snappy: cubic-bezier(0.34, 1.56, 0.64, 1.0);  /* leve overshoot */
  --spring-bouncy: cubic-bezier(0.68, -0.55, 0.27, 1.55); /* rebote claro */
  --spring-smooth: cubic-bezier(0.32, 0.72, 0, 1.0);     /* crítico */
}
.popover-enter { animation: pop 280ms var(--spring-snappy) both; }
```

### B) Spring físico real → WAAPI + JS o `linear()` con muchos stops
CSS moderno acepta `transition-timing-function: linear(0, 0.2 10%, 0.5 25%, ...)`. Generar la curva con un solver de spring (response/damping) y emitir 20–40 stops.

```js
function springStops(response = 0.5, damping = 0.825, steps = 30) {
  const omega = (2 * Math.PI) / response;
  const zeta  = damping;
  // x(t) = 1 - e^(-zeta*omega*t) * (cos(wd*t) + (zeta*omega/wd) sin(wd*t))
  ...
}
element.style.transitionTimingFunction = `linear(${stops.join(',')})`;
```

Para gestos interactivos (drag con follow) usar **WAAPI** o librería (Framer Motion / Motion One) que resuelve la integración numérica frame a frame; CSS por sí solo no permite *interrumpir* un spring en curso preservando velocidad.

---

## Checklist HotelOS

- [ ] Hover/focus = 100–150 ms, ease-out
- [ ] Transitions estándar = 200 ms, ease-in-out Apple
- [ ] Modales/sheets = 300 ms con spring snappy (overshoot ≤ 5 %)
- [ ] `prefers-reduced-motion` → fade instantáneo, sin scale/translate
- [ ] Todas las durations vía CSS custom properties
- [ ] No animar `width`/`height` (usa `transform: scale` + layout shift contenido)

---

## Sources
- [Apple HIG · Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [NSAnimationContext](https://developer.apple.com/documentation/appkit/nsanimationcontext)
- [NSWindow animationBehavior](https://developer.apple.com/documentation/appkit/nswindow/1419763-animationbehavior)
- [CAMediaTimingFunction · Predefined](https://developer.apple.com/documentation/quartzcore/camediatimingfunction/predefined_timing_functions)
- [SwiftUI interpolatingSpring](https://developer.apple.com/documentation/swiftui/animation/interpolatingspring(mass:stiffness:damping:initialvelocity:))
- [CASpringAnimation damping](https://developer.apple.com/documentation/quartzcore/caspringanimation/1412532-damping)
- [NSWorkspace.accessibilityDisplayShouldReduceMotion](https://developer.apple.com/documentation/appkit/nsworkspace/accessibilitydisplayshouldreducemotion)
- [Reduce motion settings · Apple Support](https://support.apple.com/guide/mac-help/change-motion-settings-for-accessibility-mchla3c4f1da/mac)
- [Mike Rundle · Your spring animations are bad](https://medium.com/@flyosity/your-spring-animations-are-bad-and-it-s-probably-apple-s-fault-784932e51733)
- [CocoaSprings (MacPaw)](https://github.com/MacPaw/CocoaSprings)
- [Jonathan Willing · OS X animations](https://jwilling.com/blog/osx-animations/)
- [CSS prefers-reduced-motion · CSS-Tricks](https://css-tricks.com/almanac/rules/m/media/prefers-reduced-motion/)
