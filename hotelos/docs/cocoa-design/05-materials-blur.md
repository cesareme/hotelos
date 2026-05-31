# Materiales, vibrancy y blur (macOS)

Investigación sobre `NSVisualEffectView`, vibrancy y su aproximación en web.

---

## 1. Material types (NSVisualEffectView.Material)

Apple recomienda elegir el material por su **rol semántico**, no por su color aparente. Los materiales basados en color (`light`, `dark`, `mediumLight`) están deprecados.

| Material | Uso | Tono típico |
|---|---|---|
| `titlebar` | Barra de título de la ventana | Claro, sutil |
| `sidebar` | Paneles laterales (Finder, Mail) | Claro, blur medio |
| `hudWindow` | Heads-Up Displays (overlays flotantes, p. ej. control de volumen) | Oscuro, alto contraste |
| `fullScreenUI` | Controles sobre contenido en pantalla completa | Adaptativo, oscuro |
| `toolTip` | Fondo de tooltips | Sutil, opacidad alta |
| `menu` | Menús contextuales y de barra | Translúcido, blur fuerte |
| `popover` | Fondo de popovers | Translúcido, blur medio |
| `contentBackground` | Área principal de contenido | Casi opaco |
| `windowBackground` | Fondo general de ventana | Opaco, sin vibrancy fuerte |
| `headerView` | Cabeceras de sección/tabla | Claro |
| `sheet` | Diálogos de tipo sheet | Adaptativo |
| `underWindowBackground` | Detrás de la ventana | — |
| `underPageBackground` | Detrás del contenido paginado | — |

Cada material **se adapta automáticamente** a modo claro/oscuro y al `appearance` del sistema. Usar el material correcto garantiza consistencia visual con el resto del SO.

---

## 2. Vibrancy: qué es, cuándo, cómo

**Vibrancy** es el efecto que aplica macOS al contenido **encima** de un material (texto, iconos SF Symbols, separadores, fills) para mejorar contraste y dar sensación de profundidad. No es solo translucidez: el sistema "tira" color del fondo a través del primer plano usando un blend mode especial.

**Cuándo usarla:**
- Texto/iconos sobre `sidebar`, `menu`, `popover`, `hudWindow`.
- Separadores y fills secundarios sobre cualquier material.
- Cualquier control sistema (botón, label) heredan vibrancy automáticamente si están dentro de un `NSVisualEffectView`.

**Cómo se calcula** (a alto nivel):
1. El material captura el contenido detrás de la ventana.
2. Aplica blur gaussiano + saturación + tint.
3. El contenido vibrante usa un blend mode `plusLighter` (modo claro) o `plusDarker` (modo oscuro) sobre el material.
4. El resultado: colores que "se iluminan" desde dentro, manteniendo legibilidad.

**Reglas:**
- Activar `allowsVibrancy = true` **solo en vistas hoja** (sin subvistas). Activarlo en contenedores degrada la calidad y rendimiento.
- Tres condiciones para que funcione: appearance compatible + vista lo permite + dentro de un `NSVisualEffectView`.
- Usar **siempre colores semánticos del sistema** (`NSColor.labelColor`, `secondaryLabelColor`) — están calibrados para vibrancy.

---

## 3. Blur radius aproximado por material

Apple no publica los valores exactos (son privados y cambian entre versiones), pero a partir de inspección y aproximaciones de la comunidad:

| Material | Blur radius aprox. | Saturación | Opacidad fondo |
|---|---|---|---|
| `titlebar` | 20px | ~150% | ~0.72 |
| `sidebar` | 30px | ~180% | ~0.65 |
| `menu` | 40px | ~180% | ~0.78 |
| `popover` | 30px | ~180% | ~0.70 |
| `hudWindow` | 50px | ~150% | ~0.55 (oscuro) |
| `fullScreenUI` | 40px | ~180% | ~0.60 |
| `toolTip` | 15px | ~150% | ~0.85 |
| `contentBackground` | 0–10px | ~100% | ~0.95 |

Big Sur introdujo **Progressive blur**: un gradiente de intensidad en lugar de un blur uniforme, especialmente en sidebars y barras superiores.

---

## 4. Sombras

| Tipo | Offset | Blur | Color/opacidad | Nota |
|---|---|---|---|---|
| Window shadow | `0 25px 45px` | 45px | `rgba(0,0,0,0.40)` | Sombra difusa principal |
| Window edge | `0 0 2px` | 2px | `rgba(0,0,0,0.50)` | Sombra tight que define el borde |
| Popover shadow | `0 10px 30px` | 30px | `rgba(0,0,0,0.30)` | Más ligera, sigue al anchor |
| HUD / panel shadow | `0 20px 40px` | 40px | `rgba(0,0,0,0.45)` | Pronunciada por estar flotante |
| Menu shadow | `0 8px 20px` | 20px | `rgba(0,0,0,0.25)` | Sutil |

Las ventanas en macOS suelen combinar **dos sombras** (difusa + edge) para flotar correctamente sobre cualquier fondo.

---

## 5. Aproximación en web

```css
/* Sidebar / popover (claro) */
.material-sidebar {
  background: rgba(246, 246, 248, 0.72);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
}

/* HUD (oscuro) */
.material-hud {
  background: rgba(40, 40, 42, 0.55);
  -webkit-backdrop-filter: blur(50px) saturate(150%);
  backdrop-filter: blur(50px) saturate(150%);
  color: rgba(255, 255, 255, 0.92);
}

/* Window shadow */
.window {
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.08),       /* borde fino */
    0 25px 45px rgba(0, 0, 0, 0.40),     /* difusa */
    0 0 2px rgba(0, 0, 0, 0.50);         /* edge */
}

/* Vibrancy "aproximada" para texto sobre material */
.vibrant-text { mix-blend-mode: plus-lighter; color: rgba(255,255,255,0.92); }
```

**Notas críticas:**
- Siempre poner `-webkit-backdrop-filter` **antes** que `backdrop-filter` (Safari ≤17 solo lee el prefijo).
- El fondo **debe** ser semitransparente. Con `opacity: 1` no se ve el blur.
- `saturate(180%)` compensa la pérdida de saturación que produce el blur gaussiano — es el "secreto" del look Apple.

---

## 6. Performance

`backdrop-filter` es **caro**: cada frame el navegador re-rasteriza la región detrás del elemento, aplica blur (kernel grande = O(n²) por píxel) y la compone.

**Reglas de oro:**
- **Máx. 2–3** elementos con `backdrop-filter` visibles a la vez.
- **Radio ≤ 30px** salvo HUD/menú a pantalla pequeña. Por encima de 20px en mobile el GPU sufre.
- **No animar** `backdrop-filter` ni el tamaño del contenedor que lo aplica (forzar repaint cada frame).
- **No anidar** materiales (popover dentro de sidebar dentro de window) → multiplica el coste.
- Usar `will-change: backdrop-filter` solo si se va a animar realmente; si no, perjudica.
- En listas con scroll, **no** poner blur en cada item: pon un overlay fijo con blur en el contenedor.
- Fallback para navegadores sin soporte: detectar con `@supports (backdrop-filter: blur(1px))` y servir un `rgba` opaco como degradación.

```css
@supports not (backdrop-filter: blur(1px)) {
  .material-sidebar { background: rgba(246, 246, 248, 0.96); }
}
```

**Heurística práctica para hotelOS:** material solo en sidebar, header de ventana y popovers/menús. El contenido principal (tablas, formularios, dashboards) debe ir sobre fondo opaco — además es más legible.

---

## Fuentes

- [NSVisualEffectView.Material — Apple Developer](https://developer.apple.com/documentation/appkit/nsvisualeffectview/material)
- [NSVisualEffectView — Apple Developer](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- [Materials — HIG](https://developer.apple.com/design/human-interface-guidelines/foundations/materials/)
- [Dark Side of the Mac: Appearance & Materials — mackuba.eu](https://mackuba.eu/2018/07/04/dark-side-mac-1/)
- [Using Apple's Materials, Blur & Vibrancy — createwithplay.com](https://createwithplay.com/blog/best-practices-for-using-materials-properties)
- [backdrop-filter — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)
- [macOS Window Drop Shadow — CodePen joeyhoer](https://codepen.io/joeyhoer/pen/beXJzj)
- [Costly CSS Properties — dev.to](https://dev.to/leduc1901/costly-css-properties-and-how-to-optimize-them-3bmd)
