# Decisión de Design System · Aurora vs Cocoa

> Audit 2026-06 · #12. Este documento NO decide por ti: presenta el problema, los
> datos verificados y una recomendación para que tomes la dirección. El gate de
> drift (`scripts/check-design-system-drift.mjs`) es report-only hasta que elijas.

## El problema (verificado en la revisión adversarial de diseño)

No hay "un núcleo Cocoa con fugas de legacy". Hay **dos design systems completos
de primera clase conviviendo sin gobierno**, y la auditoría original solo miró uno:

| | **Aurora** (cálido) | **Cocoa** (frío macOS) |
|---|---|---|
| Fuente | `styles.css` ("HotelOS Aurora — DS v2 (2026)") | `components/cocoa/` + `styles/cocoa-*.css` |
| Host | Importado globalmente en `App.tsx`; **importa a Cocoa** | Importado POR Aurora |
| Cobertura | **156/202 pantallas** (`.bo-*`) | **27/202 pantallas** |
| Paleta | Emerald cálido | Apple-blue frío |
| Tokens | `--fs-*`, `--space-*`, `--ok/warn/danger-bg`, `--focus` | `--cocoa-*` (HIG, dark explícito, a11y) |
| Calidad del núcleo | SaaS cálido competente | **Más alta** (Button/Table/Input/tokens nivel HIG) |

**Coste del statu quo:** dos escalas tipográficas, dos de spacing, dos de radius,
dos focus rings de sistema, dos paletas de acento. Un dev nuevo no sabe cuál usar
→ cada pantalla nueva multiplica la superficie de error (ej. `DirectorVipList`, que
ya mezcla token frío + fallback cálido en el mismo componente).

## Las tres opciones

### A · Aurora canónico (recomendada para ship rápido)
Declarar Aurora el sistema. Es el host de facto y cubre 6× más superficie.
- **Migración:** alinear ~27 pantallas Cocoa a la identidad Aurora — pero sin
  reescribirlas: **re-apuntar los tokens `--cocoa-*` a la paleta cálida de Aurora**
  (un cambio de tokens, no de 27 pantallas). Los componentes Cocoa (Button/Table/
  Input) se quedan; solo cambian de color.
- **Ganas:** la disciplina de tokens de Cocoa (la mejor ingeniería) + la identidad
  cálida que ya es el 77% del producto. Esfuerzo bajo.
- **Pierdes:** el "premium macOS-nativo frío" como north star visual.

### B · Cocoa canónico (premium macOS)
Declarar Cocoa el sistema y migrar las 156 pantallas Aurora.
- **Migración:** alta (156 pantallas `.bo-*` → componentes Cocoa). Meses.
- **Ganas:** identidad Apple-premium coherente, el núcleo de mayor calidad.
- **Pierdes:** tiempo de demo; riesgo de regresiones en mucha superficie.

### C · Statu quo (no recomendada)
Seguir con los dos. La deuda crece con cada pantalla. El techo de coherencia es ~48/100.

## Recomendación

**Opción A (Aurora canónico) + adoptar la disciplina de tokens de Cocoa.**

Razonamiento: para un primer pilot/demo, la coherencia importa más que el ideal
estético, y A es el único camino de **esfuerzo bajo** (cambio de tokens, no de
pantallas). Aurora ya ES la identidad del 77% del producto; pelear contra eso es
caro. Te quedas con lo mejor de Cocoa (tokens HIG, dark, a11y) re-skineado a cálido.

Si más adelante el posicionamiento exige "Apple-premium", la opción B sigue abierta
sobre una base ya unificada en tokens.

## Una vez decidas

1. Marca la dirección en este doc.
2. Activa el gate: `node scripts/check-design-system-drift.mjs --enforce` y cabléalo
   al pre-commit para **congelar el sistema perdedor** (cero imports nuevos).
3. Migra por oleadas (empieza por `<button>`→`CocoaButton` o `.bo-*`→tokens, según
   la dirección), no de golpe.

> Hasta entonces, el gate corre en modo report-only: cuenta el uso de cada sistema
> y marca las pantallas que mezclan ambos (las incoherentes a priorizar).
