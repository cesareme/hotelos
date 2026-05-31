// Cocoa Illustrations
// 5 ilustraciones SVG inline en estilo plano macOS Big Sur: gradientes suaves,
// sin bordes harsh, esquinas redondeadas. Tamaño por defecto 240×180.
//
// Cada export acepta:
//   - size?:      número (alto/ancho proporcional)
//   - tone?:      'accent' | 'success' | 'warning' | 'error'
//   - className?: string
//
// Los tonos se mapean a tokens CSS Cocoa:
//   accent  -> var(--cocoa-accent)
//   success -> var(--cocoa-success)
//   warning -> var(--cocoa-warning)
//   error   -> var(--cocoa-danger)
//
// Las ilustraciones usan `currentColor` para el color primario, gradientes
// generados con IDs únicos para evitar colisiones cuando varias instancias
// coexisten en el DOM.

import { useId, type CSSProperties } from "react";

export type IllustrationTone = "accent" | "success" | "warning" | "error";

export interface CocoaIllustrationProps {
  /** Ancho en píxeles. La altura mantiene la proporción 4:3 (size × 0.75). */
  size?: number;
  /** Tono semántico que se aplica al color principal de la ilustración. */
  tone?: IllustrationTone;
  /** Clases CSS adicionales para el SVG raíz. */
  className?: string;
}

// Mapeo de tono a variable CSS (--cocoa-*).
function toneColor(tone: IllustrationTone | undefined): string {
  switch (tone) {
    case "success":
      return "var(--cocoa-success)";
    case "warning":
      return "var(--cocoa-warning)";
    case "error":
      return "var(--cocoa-danger)";
    case "accent":
    default:
      return "var(--cocoa-accent)";
  }
}

// Base SVG width/height ratio 4:3 (240×180 por defecto).
const DEFAULT_SIZE = 240;
const ASPECT = 180 / 240;

const baseStyle: CSSProperties = {
  display: "inline-block",
  verticalAlign: "middle",
  flexShrink: 0
};

interface IllustrationFrameProps extends CocoaIllustrationProps {
  /** Etiqueta accesible. */
  ariaLabel: string;
  /** Contenido interno del SVG. Recibe el color resuelto y un ID único. */
  children: (color: string, gradientId: string) => React.ReactNode;
}

function IllustrationFrame(props: IllustrationFrameProps) {
  const { size = DEFAULT_SIZE, tone = "accent", className, ariaLabel, children } = props;
  const color = toneColor(tone);
  const gid = useId().replace(/[:]/g, "");
  return (
    <svg
      width={size}
      height={Math.round(size * ASPECT)}
      viewBox="0 0 240 180"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={baseStyle}
      fill="none"
    >
      {children(color, gid)}
    </svg>
  );
}

// 1. EmptyStateBox — caja abierta con flecha hacia arriba, "No items found".
export function EmptyStateBox(props: CocoaIllustrationProps) {
  return (
    <IllustrationFrame {...props} ariaLabel="No hay elementos">
      {(color, gid) => (
        <>
          <defs>
            <linearGradient id={`box-body-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0.32" />
            </linearGradient>
            <linearGradient id={`box-lid-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.10" />
              <stop offset="100%" stopColor={color} stopOpacity="0.22" />
            </linearGradient>
            <linearGradient id={`box-shadow-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sombra suave bajo la caja */}
          <ellipse cx="120" cy="158" rx="62" ry="6" fill={`url(#box-shadow-${gid})`} />

          {/* Cuerpo de la caja */}
          <path
            d="M62 78 L178 78 L170 152 Q169 158 163 158 L77 158 Q71 158 70 152 Z"
            fill={`url(#box-body-${gid})`}
            stroke={color}
            strokeOpacity="0.55"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />

          {/* Tapas laterales abiertas */}
          <path
            d="M62 78 L96 60 L150 60 L178 78 Z"
            fill={`url(#box-lid-${gid})`}
            stroke={color}
            strokeOpacity="0.45"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <line
            x1="120"
            y1="78"
            x2="120"
            y2="158"
            stroke={color}
            strokeOpacity="0.18"
            strokeWidth="1.25"
          />

          {/* Flecha hacia arriba saliendo de la caja */}
          <path
            d="M120 70 L120 22"
            stroke={color}
            strokeOpacity="0.9"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <path
            d="M104 38 L120 22 L136 38"
            stroke={color}
            strokeOpacity="0.9"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </IllustrationFrame>
  );
}

// 2. EmptyStateSearch — lupa magnificadora, sin resultados.
export function EmptyStateSearch(props: CocoaIllustrationProps) {
  return (
    <IllustrationFrame {...props} ariaLabel="Sin resultados">
      {(color, gid) => (
        <>
          <defs>
            <radialGradient id={`lens-${gid}`} cx="0.35" cy="0.3" r="0.85">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="55%" stopColor={color} stopOpacity="0.10" />
              <stop offset="100%" stopColor={color} stopOpacity="0.22" />
            </radialGradient>
            <linearGradient id={`lens-shadow-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sombra suave */}
          <ellipse cx="120" cy="160" rx="68" ry="6" fill={`url(#lens-shadow-${gid})`} />

          {/* Mango de la lupa */}
          <rect
            x="148"
            y="118"
            width="14"
            height="44"
            rx="7"
            transform="rotate(-45 155 140)"
            fill={color}
            fillOpacity="0.55"
          />
          <rect
            x="148"
            y="118"
            width="14"
            height="44"
            rx="7"
            transform="rotate(-45 155 140)"
            fill="none"
            stroke={color}
            strokeOpacity="0.7"
            strokeWidth="1.25"
          />

          {/* Aro de la lupa */}
          <circle
            cx="104"
            cy="84"
            r="44"
            fill={`url(#lens-${gid})`}
            stroke={color}
            strokeOpacity="0.7"
            strokeWidth="3"
          />

          {/* Brillo decorativo */}
          <path
            d="M76 64 Q82 56 92 54"
            stroke="#ffffff"
            strokeOpacity="0.75"
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />

          {/* Indicador "sin resultados" (línea diagonal cruzada suave) */}
          <line
            x1="86"
            y1="84"
            x2="122"
            y2="84"
            stroke={color}
            strokeOpacity="0.55"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </>
      )}
    </IllustrationFrame>
  );
}

// 3. EmptyStateError — triángulo de advertencia amigable.
export function EmptyStateError(props: CocoaIllustrationProps) {
  return (
    <IllustrationFrame {...props} ariaLabel="Algo salió mal">
      {(color, gid) => (
        <>
          <defs>
            <linearGradient id={`tri-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0.35" />
            </linearGradient>
            <linearGradient id={`tri-shadow-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sombra */}
          <ellipse cx="120" cy="160" rx="64" ry="6" fill={`url(#tri-shadow-${gid})`} />

          {/* Triángulo redondeado */}
          <path
            d="M120 30
               Q128 30 132 37
               L190 138
               Q194 145 188 150
               Q184 152 180 152
               L60 152
               Q56 152 52 150
               Q46 145 50 138
               L108 37
               Q112 30 120 30 Z"
            fill={`url(#tri-${gid})`}
            stroke={color}
            strokeOpacity="0.7"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />

          {/* Signo de exclamación */}
          <rect
            x="115"
            y="64"
            width="10"
            height="44"
            rx="5"
            fill={color}
            fillOpacity="0.85"
          />
          <circle cx="120" cy="128" r="6" fill={color} fillOpacity="0.85" />
        </>
      )}
    </IllustrationFrame>
  );
}

// 4. EmptyStateConnection — wifi con línea cruzada (sin conexión).
export function EmptyStateConnection(props: CocoaIllustrationProps) {
  return (
    <IllustrationFrame {...props} ariaLabel="Sin conexión">
      {(color, gid) => (
        <>
          <defs>
            <radialGradient id={`wifi-glow-${gid}`} cx="0.5" cy="0.7" r="0.7">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </radialGradient>
            <linearGradient id={`wifi-shadow-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sombra */}
          <ellipse cx="120" cy="158" rx="62" ry="5" fill={`url(#wifi-shadow-${gid})`} />

          {/* Halo sutil detrás */}
          <circle cx="120" cy="120" r="78" fill={`url(#wifi-glow-${gid})`} />

          {/* Arcos wifi (3 capas, exterior a interior) */}
          <path
            d="M58 90 Q120 36 182 90"
            stroke={color}
            strokeOpacity="0.45"
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M76 108 Q120 64 164 108"
            stroke={color}
            strokeOpacity="0.65"
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M94 126 Q120 100 146 126"
            stroke={color}
            strokeOpacity="0.85"
            strokeWidth="6"
            strokeLinecap="round"
            fill="none"
          />

          {/* Punto central */}
          <circle cx="120" cy="142" r="6.5" fill={color} fillOpacity="0.9" />

          {/* Línea cruzada diagonal indicando "sin conexión" */}
          <line
            x1="56"
            y1="44"
            x2="190"
            y2="158"
            stroke="#ffffff"
            strokeOpacity="0.9"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <line
            x1="56"
            y1="44"
            x2="190"
            y2="158"
            stroke={color}
            strokeOpacity="0.9"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        </>
      )}
    </IllustrationFrame>
  );
}

// 5. SuccessIllustration — checkmark grande dentro de círculo + confetti.
export function SuccessIllustration(props: CocoaIllustrationProps) {
  // Por defecto este ilustración usa tono "success" si no se especifica otro.
  const tone = props.tone ?? "success";
  return (
    <IllustrationFrame {...props} tone={tone} ariaLabel="Operación exitosa">
      {(color, gid) => (
        <>
          <defs>
            <radialGradient id={`succ-${gid}`} cx="0.35" cy="0.3" r="0.85">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.45" />
              <stop offset="55%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color} stopOpacity="0.85" />
            </radialGradient>
            <linearGradient id={`succ-shadow-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Sombra suave */}
          <ellipse cx="120" cy="160" rx="56" ry="6" fill={`url(#succ-shadow-${gid})`} />

          {/* Confetti dots */}
          <circle cx="40" cy="44" r="4" fill="var(--cocoa-accent)" fillOpacity="0.75" />
          <circle cx="200" cy="40" r="3.5" fill="var(--cocoa-warning)" fillOpacity="0.85" />
          <circle cx="208" cy="100" r="3" fill={color} fillOpacity="0.7" />
          <circle cx="32" cy="110" r="3.5" fill="var(--cocoa-warning)" fillOpacity="0.8" />
          <circle cx="56" cy="76" r="2.5" fill={color} fillOpacity="0.8" />
          <circle cx="186" cy="68" r="2.5" fill="var(--cocoa-accent)" fillOpacity="0.85" />
          <rect
            x="22"
            y="78"
            width="6"
            height="6"
            rx="1.5"
            transform="rotate(20 25 81)"
            fill="var(--cocoa-accent)"
            fillOpacity="0.7"
          />
          <rect
            x="212"
            y="124"
            width="6"
            height="6"
            rx="1.5"
            transform="rotate(-15 215 127)"
            fill="var(--cocoa-warning)"
            fillOpacity="0.75"
          />
          <rect
            x="68"
            y="36"
            width="5"
            height="5"
            rx="1.25"
            transform="rotate(35 70.5 38.5)"
            fill={color}
            fillOpacity="0.7"
          />
          <rect
            x="170"
            y="132"
            width="5"
            height="5"
            rx="1.25"
            transform="rotate(-25 172.5 134.5)"
            fill="var(--cocoa-accent)"
            fillOpacity="0.7"
          />

          {/* Círculo principal con gradiente */}
          <circle
            cx="120"
            cy="90"
            r="48"
            fill={`url(#succ-${gid})`}
            stroke={color}
            strokeOpacity="0.55"
            strokeWidth="2"
          />

          {/* Checkmark */}
          <path
            d="M98 92 L114 108 L144 76"
            stroke="#ffffff"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </IllustrationFrame>
  );
}
