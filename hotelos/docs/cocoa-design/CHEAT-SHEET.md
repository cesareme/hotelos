# Cocoa Edition Cheat Sheet

Resumen ultra conciso para developers. Imprimible en 1 pagina.

---

## Imports

```jsx
// Componentes core
import { CocoaButton, CocoaCard, CocoaTable } from '../../components/cocoa';

// Componentes extras (forms, alerts, etc)
import { CocoaAlert, CocoaFormFieldset } from '../../components/cocoa-extras';

// Globales (palette, theme)
import { CocoaCommandPalette, CocoaThemeToggle } from '../../components/cocoa-global';

// Iconos SF Symbols-style
import { HouseIcon, CheckCircleIcon } from '../../components/cocoa-icons';
```

---

## Tokens basicos

| Token | Light | Dark | Uso |
|---|---|---|---|
| `--cocoa-label` | `#000` | `#fff` | Texto primario |
| `--cocoa-label-secondary` | `rgba(60,60,67,.6)` | `rgba(235,235,245,.6)` | Texto secundario |
| `--cocoa-background-content` | `#fff` | `#2c2c2e` | Fondo de cards |
| `--cocoa-background-grouped` | `#f2f2f7` | `#000` | Fondo de pagina |
| `--cocoa-separator` | `rgba(60,60,67,.29)` | `rgba(84,84,88,.6)` | Lineas divisorias |
| `--cocoa-accent` | `#007aff` | `#0a84ff` | Acento (azul iOS) |
| `--cocoa-destructive` | `#ff3b30` | `#ff453a` | Destructivo (rojo) |
| `--cocoa-success` | `#34c759` | `#30d158` | Success (verde) |
| `--cocoa-warning` | `#ff9500` | `#ff9f0a` | Warning (naranja) |

### Spacing (4px grid)

| Token | Valor |
|---|---|
| `--cocoa-space-1` | `4px` |
| `--cocoa-space-2` | `8px` |
| `--cocoa-space-3` | `12px` |
| `--cocoa-space-4` | `16px` |
| `--cocoa-space-6` | `24px` |
| `--cocoa-space-8` | `32px` |

### Radius

| Token | Valor |
|---|---|
| `--cocoa-radius-sm` | `4px` |
| `--cocoa-radius-md` | `8px` |
| `--cocoa-radius-lg` | `12px` |
| `--cocoa-radius-xl` | `16px` |

### Typography (SF Pro)

| Token | Tamano | Uso |
|---|---|---|
| `--cocoa-text-caption2` | `11px` | Etiquetas finas |
| `--cocoa-text-caption1` | `12px` | Captions |
| `--cocoa-text-footnote` | `13px` | Footnotes |
| `--cocoa-text-subhead` | `15px` | Subheads |
| `--cocoa-text-body` | `17px` | Body (default) |
| `--cocoa-text-title3` | `20px` | Titulo seccion |
| `--cocoa-text-title2` | `22px` | Titulo card |
| `--cocoa-text-title1` | `28px` | Titulo pagina |
| `--cocoa-text-large-title` | `34px` | Hero title |

---

## Patron tipico de pantalla

```jsx
export default function FrontDeskPage() {
  return (
    <CocoaPageContainer>
      <CocoaPageHeader
        eyebrow='Operations'
        title='Front Desk'
        subtitle='12 check-ins pendientes'
        actions={
          <>
            <CocoaButton variant='bordered'>Exportar</CocoaButton>
            <CocoaButton variant='filled' tone='accent'>+ Nuevo</CocoaButton>
          </>
        }
      />

      <CocoaCard variant='elevated' padding='md'>
        <CocoaTable columns={cols} rows={rows} />
      </CocoaCard>
    </CocoaPageContainer>
  );
}
```

---

## Botones (decision rapida)

| Caso | Variante | Tone |
|---|---|---|
| Accion primaria | `variant='filled'` | `tone='accent'` |
| Accion secundaria | `variant='bordered'` | `tone='neutral'` |
| Accion terciaria / link | `variant='plain'` | `tone='accent'` |
| Destructiva (borrar, cancelar) | `variant='filled'` | `tone='destructive'` |
| Success (confirmar) | `variant='filled'` | `tone='success'` |
| Toolbar icon | `variant='ghost'` | `tone='neutral'` |

```jsx
<CocoaButton variant='filled' tone='accent' size='md' icon={<PlusIcon />}>
  Nuevo
</CocoaButton>
```

---

## Cards

| Variante | Cuando usar |
|---|---|
| `variant='plain'` | Contenedor simple sin sombra |
| `variant='elevated'` | Card principal con sombra sutil |
| `variant='grouped'` | Lista de items tipo Settings.app |
| `variant='inset'` | Card dentro de seccion grouped |

```jsx
<CocoaCard variant='elevated' padding='md' radius='lg'>
  <CocoaCardHeader title='Reservas' subtitle='Hoy' />
  <CocoaCardBody>{...}</CocoaCardBody>
  <CocoaCardFooter>{...}</CocoaCardFooter>
</CocoaCard>
```

---

## Forms

```jsx
<CocoaFormFieldset legend='Datos del huesped'>
  <CocoaFormField label='Nombre' required>
    <CocoaTextField value={name} onChange={setName} />
  </CocoaFormField>

  <CocoaFormField label='Email' help='No se compartira'>
    <CocoaTextField type='email' value={email} onChange={setEmail} />
  </CocoaFormField>

  <CocoaFormField label='Pais'>
    <CocoaSelect options={countries} value={country} onChange={setCountry} />
  </CocoaFormField>
</CocoaFormFieldset>
```

---

## Alerts y feedback

| Componente | Uso |
|---|---|
| `<CocoaAlert tone='info'>` | Info contextual |
| `<CocoaAlert tone='success'>` | Confirmacion |
| `<CocoaAlert tone='warning'>` | Advertencia |
| `<CocoaAlert tone='destructive'>` | Error |
| `<CocoaToast>` | Notificacion temporal (3s) |
| `<CocoaDialog>` | Confirmacion bloqueante |
| `<CocoaSheet>` | Modal con form largo |
| `<CocoaPopover>` | Tooltip rico anclado |

---

## Atajos de teclado

| Combo | Accion |
|---|---|
| `Cmd+K` | Command Palette |
| `Cmd+/` | Ayuda y atajos |
| `Cmd+,` | Preferencias |
| `Cmd+N` | Nuevo (contextual) |
| `Cmd+F` | Buscar en pagina |
| `Cmd+Shift+P` | Cambiar tema |
| `Cmd+1..9` | Cambiar tab |
| `Cmd+\` | Toggle sidebar |
| `Esc` | Cerrar modal / cancelar |
| `Enter` | Confirmar accion primaria |
| `Tab` / `Shift+Tab` | Navegar campos |
| `Space` | Toggle checkbox / boton |
| `Arrow keys` | Navegar listas / tablas |

---

## Reglas de design (top 10)

1. **Primary action** siempre `CocoaButton variant='filled' tone='accent'`. Solo una por pantalla.
2. **Secondary action** usa `variant='bordered'`. Multiples permitidas.
3. **Destructive** usa `tone='destructive'`. Confirmar con `CocoaDialog`.
4. **Spacing entre cards** usa `var(--cocoa-space-4)` (16px). Nunca margenes inline.
5. **Page title** siempre via `CocoaPageHeader`. No usar `<h1>` directo.
6. **Tablas** dentro de `CocoaCard variant='elevated'`. Headers sticky por defecto.
7. **Forms** agrupados en `CocoaFormFieldset`. Una columna en mobile.
8. **Colores** SOLO via tokens. Nunca hex hardcoded en JSX o CSS.
9. **Iconos** SF Symbols-style 17px inline, 20px standalone, 24px en toolbar.
10. **Motion** usa tokens `--cocoa-motion-*`. Default 250ms ease-out. Respeta `prefers-reduced-motion`.

---

## Anti-patrones (no hacer)

- No usar `box-shadow` custom. Solo tokens `--cocoa-shadow-*`.
- No mezclar Cocoa con componentes legacy en la misma pantalla.
- No poner mas de 1 boton `filled accent` por seccion visible.
- No usar emojis como iconos. Usar `cocoa-icons`.
- No setear font-family inline. Heredar de root (`-apple-system`).
- No usar `position: fixed` para modales. Usar `CocoaSheet` / `CocoaDialog`.
- No hardcodear colores en dark mode. Usar tokens que conmutan automaticamente.
- No deshabilitar focus rings (`outline: none`). Solo customizar via `--cocoa-focus-ring`.

---

## Responsive breakpoints

| Token | Valor | Layout |
|---|---|---|
| `--cocoa-bp-sm` | `640px` | Mobile -> Tablet portrait |
| `--cocoa-bp-md` | `768px` | Tablet -> iPad |
| `--cocoa-bp-lg` | `1024px` | iPad -> Desktop |
| `--cocoa-bp-xl` | `1280px` | Desktop wide |

**Regla:** mobile-first. Sidebar colapsa a `< lg`. Tablas se convierten en cards stacked a `< md`.

---

## Dark mode

Automatico via `prefers-color-scheme` + override manual con `<CocoaThemeToggle>`. Los tokens conmutan solos. Si necesitas estilos condicionales:

```css
[data-theme='dark'] .mi-componente {
  /* override especifico dark */
}
```

---

## Accesibilidad (checklist rapido)

- Todo control interactivo tiene focus ring visible
- Contraste minimo WCAG AA (4.5:1 texto, 3:1 UI)
- `aria-label` en botones icon-only
- `role` y `aria-*` correctos en menus, dialogs, tabs
- Soporta navegacion 100% por teclado
- Anuncia cambios dinamicos con `aria-live` (alerts, toasts)
- Respeta `prefers-reduced-motion`
- Touch targets minimo 44x44px en mobile

---

## Debugging tips

- `data-cocoa-component='nombre'` en cada componente para inspeccion
- `window.__cocoa.tokens` lista todos los tokens activos en runtime
- `window.__cocoa.theme` para leer / setear tema
- Storybook en `/storybook/cocoa` con todos los componentes
- DevTools: filtrar por `[data-cocoa-*]` para encontrar componentes en el DOM

---

## Referencias

- **MASTER-PLAN.md** vision general
- **SPEC-components.md** API completa
- **SPEC-tokens.md** tabla completa de tokens
- **SPEC-keyboard-shortcuts.md** atajos detallados
- **SPEC-darkmode-a11y.md** dark mode + accesibilidad
- **02-controls-catalog.md** catalogo visual
- **08-icons.md** libreria de iconos
