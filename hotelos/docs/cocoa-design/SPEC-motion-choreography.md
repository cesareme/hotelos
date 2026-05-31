# Motion choreography Cocoa Edition

## Principios

- Toda transicion respeta `prefers-reduced-motion`. Cuando el usuario activa esta preferencia, las duraciones se colapsan a 0ms o se sustituyen por crossfades de 80ms maximo, eliminando desplazamientos espaciales y rebotes.
- Duracion proporcional a distancia visual. Un elemento que recorre 8px no puede compartir duracion con un sheet que recorre 600px. La regla heuristica: `duracion (ms) = 120 + (distancia_px * 0.4)`, redondeado al token mas cercano definido en SPEC-tokens.md (`motion.duration.*`).
- Easings:
  - `ease-out` para entrada (el elemento desacelera al llegar a destino, sensacion de aterrizaje natural).
  - `ease-in` para salida (acelera al irse, sensacion de despedida).
  - `spring` para feedback de control (switches, popovers, toggles) donde se requiere personalidad fisica leve, con overshoot controlado.
- Coherencia jerarquica: animaciones de chrome (sidebar, tabs) ceden el escenario a animaciones de contenido (page transitions, modals). Nunca dos transiciones de magnitud media o alta corren simultaneamente.
- Origen del movimiento: toda transicion tiene una causa visible (click, hover, focus, navegacion). Animaciones automaticas sin trigger del usuario quedan prohibidas excepto en estados de loading.
- Composicion: opacidad y transform son los unicos canales animables en transiciones de entrada/salida. `width`, `height`, `top`, `left` se reservan para layouts que requieren reflow (sidebar collapse).

## Tokens utilizados

Los valores cuantitativos referencian directamente SPEC-tokens.md. Si un valor diverge del token, se anota la razon.

| Token | Valor | Uso |
| --- | --- | --- |
| `motion.duration.instant` | 80ms | Click feedback |
| `motion.duration.fast` | 100ms | Hover |
| `motion.duration.short` | 150ms | Focus ring |
| `motion.duration.medium` | 200ms | Popover, switch, page transition |
| `motion.duration.long` | 250ms | Modal exit, tab change |
| `motion.duration.xlong` | 300ms | Sidebar collapse |
| `motion.duration.xxlong` | 400ms | Modal entry |
| `motion.easing.out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entradas |
| `motion.easing.in` | `cubic-bezier(0.7, 0, 0.84, 0)` | Salidas |
| `motion.easing.spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Feedback de control |

## Casos especificos

### Hover de botones

- Duracion: 100ms (`motion.duration.fast`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: `background-color` aplicando `brightness(0.95)` sobre el token de fondo del boton.
- Notas: hover en touch devices se suprime para evitar estados pegajosos. Sobre fondos translucidos (CocoaMaterial), el oscurecimiento se aplica a la capa de tinte superior, no al backdrop blur.

### Click feedback

- Duracion: 80ms (`motion.duration.instant`).
- Easing: ease-in (`motion.easing.in`).
- Cambio: `transform: scale(0.98)` desde `scale(1)`, recuperando a `scale(1)` con ease-out de 120ms al soltar.
- Notas: aplica a botones primarios, secundarios y chips. No aplica a links de texto. El compositor debe asegurar `transform-origin: center`.

### Focus ring

- Duracion: 150ms (`motion.duration.short`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: `box-shadow` con opacidad 0 a 0.4 sobre el token `color.accent.focus` definido en SPEC-tokens.md. Radio del ring: 3px, offset 2px.
- Notas: el ring desaparece instantaneamente (sin easing) al blur, evitando ambiguedad sobre cual control esta activo durante navegacion por teclado rapida.

### Modal entry (CocoaSheet)

- Duracion: 400ms (`motion.duration.xxlong`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: el sheet traslada de `translateY(-100%)` a `translateY(0)` cuando entra desde el top. Simultaneamente el backdrop pasa de `opacity: 0` a `opacity: 0.5` con la misma curva.
- Notas: el contenido interno del sheet aparece con un retraso de 80ms y duracion 200ms para que no compita visualmente con el desplazamiento del contenedor. Si el sheet entra desde el bottom (variante mobile), la direccion se invierte (`translateY(100%)` a `translateY(0)`).

### Modal exit

- Duracion: 250ms (`motion.duration.long`).
- Easing: ease-in (`motion.easing.in`).
- Cambio: reverso del entry. El backdrop y el sheet salen de forma sincronica.
- Notas: la salida es mas corta que la entrada porque la atencion del usuario ya esta en el siguiente estado. El contenido interno no necesita salida diferida; se va con el contenedor.

### Popover (CocoaPopover)

- Duracion: 200ms (`motion.duration.medium`).
- Easing: spring (`motion.easing.spring`).
- Cambio: `transform: scale(0.95)` y `opacity: 0` a `transform: scale(1)` y `opacity: 1`. El origen del scale se ancla al anchor del popover (boton invocador), no al centro del popover.
- Notas: el spring tiene overshoot maximo de 1.02 para evitar sensacion de gelatina. La salida usa ease-in 150ms sin spring para reducir distraccion.

### Switch (CocoaSwitch)

- Duracion: 200ms (`motion.duration.medium`).
- Easing: spring (`motion.easing.spring`).
- Cambio: `thumb translateX` desde posicion off a posicion on, y `track` color desde `color.surface.neutral` a `color.accent.primary` (tokens en SPEC-tokens.md).
- Notas: el spring se aplica solo al thumb; el track color usa ease-out de 200ms para evitar parpadeos cromaticos. El thumb crece levemente (`scale(1.05)`) durante el primer 40% del recorrido y vuelve a `scale(1)` al final, simulando inercia.

### Tab change (CocoaSegmentedControl)

- Duracion: 250ms (`motion.duration.long`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: el indicador (fondo activo del tab) desliza horizontalmente entre tabs. La etiqueta del tab activo cambia su color de texto a `color.text.onAccent` con un crossfade de 150ms desfasado 50ms del inicio del slide.
- Notas: si el numero de tabs es 2, la duracion se reduce a 200ms. Si hay mas de 5 tabs, se incrementa a 280ms para mantener la sensacion de continuidad sobre distancias mayores.

### Sidebar collapse

- Duracion: 300ms (`motion.duration.xlong`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: `width` de 240px a 0px, y el contenido principal desplaza su `margin-left` correspondientemente. Los labels del sidebar desaparecen con opacity 1 a 0 durante los primeros 100ms.
- Notas: este es uno de los pocos casos donde animamos `width`. Para evitar reflow costoso, el contenido del sidebar se posiciona absoluto durante la transicion y vuelve a su layout natural al finalizar. La expansion usa la misma duracion y curva.

### Page transition (entre screens)

- Duracion: 200ms (`motion.duration.medium`).
- Easing: ease-out (`motion.easing.out`).
- Cambio: la pantalla entrante pasa de `opacity: 0` y `translateY(8px)` a `opacity: 1` y `translateY(0)`. La pantalla saliente se desmonta sin animacion (corte limpio) para evitar superposicion de scrollbars y conflictos de focus.
- Notas: navegaciones laterales dentro del mismo nivel jerarquico (por ejemplo, entre items de un master-detail) pueden suprimir el translateY y conservar solo el fade, para evitar mareo en rafagas de clicks.

## Reglas de composicion

- Nunca encadenar mas de dos transiciones consecutivas en la misma interaccion. Si un flujo requiere mas pasos, fusionarlos o introducir un estado de espera deliberado.
- Cuando un modal o popover esta abierto, las animaciones de chrome (sidebar, tabs) se desactivan hasta el cierre, evitando que el usuario perciba movimientos secundarios mientras decide.
- Las animaciones de loading (spinners, skeletons) usan curvas lineales o ease-in-out cycle y quedan fuera del catalogo de transiciones expuesto en este documento. Ver `06-motion.md` para detalle de patrones de espera.

## Verificacion

Cada componente debe documentar en su pagina de SPEC-components.md el token de duracion y easing que utiliza, citando este archivo. Si una pantalla requiere un valor fuera del catalogo, debe justificarse en el RFC correspondiente y proponerse como nuevo token en SPEC-tokens.md antes de implementarse.
