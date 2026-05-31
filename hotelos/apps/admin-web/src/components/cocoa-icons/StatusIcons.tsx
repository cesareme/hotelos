// Cocoa Status Icons
// Conjunto de 12 iconos de estado siguiendo el patrón Cocoa (SVG inline,
// stroke="currentColor"). Cada icono acepta `size`, `className`, `title` y
// `aria-label`. Si no se proporciona `title`/`aria-label`, el icono es
// decorativo (aria-hidden).

import type { CSSProperties, SVGProps } from "react";

export type CocoaIconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  /** Tamaño en píxeles (ancho y alto). Por defecto 16. */
  size?: number | string;
  /** Título accesible. Si se omite, el icono se marca como decorativo. */
  title?: string;
};

type IconRenderProps = CocoaIconProps & {
  /** Contenido SVG interno. */
  children: React.ReactNode;
  /** viewBox del SVG. Por defecto "0 0 16 16". */
  viewBox?: string;
};

const baseStyle: CSSProperties = {
  display: "inline-block",
  verticalAlign: "middle",
  flexShrink: 0,
  color: "currentColor"
};

function IconBase(props: IconRenderProps) {
  const {
    size = 16,
    title,
    children,
    viewBox = "0 0 16 16",
    style,
    "aria-label": ariaLabel,
    "aria-hidden": ariaHidden,
    role,
    ...rest
  } = props;

  const hasLabel = Boolean(title) || Boolean(ariaLabel);
  const computedAriaHidden = hasLabel ? undefined : ariaHidden ?? true;
  const computedRole = role ?? (hasLabel ? "img" : undefined);

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={computedRole}
      aria-label={ariaLabel ?? title}
      aria-hidden={computedAriaHidden}
      style={{ ...baseStyle, ...style }}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

// 1. CheckCircleIcon — éxito
export function CheckCircleIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.25 8.25L7.25 10.25L10.75 6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// 2. ExclamationCircleIcon — advertencia
export function ExclamationCircleIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.75V8.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.25" r="0.85" fill="currentColor" />
    </IconBase>
  );
}

// 3. XCircleIcon — peligro/error
export function XCircleIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.75 5.75L10.25 10.25M10.25 5.75L5.75 10.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

// 4. InfoCircleIcon — información
export function InfoCircleIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 7.5V11.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="5.25" r="0.85" fill="currentColor" />
    </IconBase>
  );
}

// 5. ClockIcon — pendiente
export function ClockIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.5V8L10.25 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// 6. LockIcon — cerrado/seguro
export function LockIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <rect
        x="3.25"
        y="7.5"
        width="9.5"
        height="6.75"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.25 7.5V5.25C5.25 3.73 6.48 2.5 8 2.5C9.52 2.5 10.75 3.73 10.75 5.25V7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10.75" r="0.85" fill="currentColor" />
    </IconBase>
  );
}

// 7. LockOpenIcon — abierto
export function LockOpenIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <rect
        x="3.25"
        y="7.5"
        width="9.5"
        height="6.75"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.25 7.5V5.25C5.25 3.73 6.48 2.5 8 2.5C9.27 2.5 10.34 3.36 10.65 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10.75" r="0.85" fill="currentColor" />
    </IconBase>
  );
}

// 8. StarIcon — favorito / VIP
export function StarIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M8 2.25L9.85 6L14 6.6L11 9.5L11.7 13.6L8 11.65L4.3 13.6L5 9.5L2 6.6L6.15 6L8 2.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// 9. HeartIcon — loyalty
export function HeartIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M8 13.5C8 13.5 2.25 10.25 2.25 6.25C2.25 4.45 3.7 3 5.5 3C6.7 3 7.55 3.62 8 4.4C8.45 3.62 9.3 3 10.5 3C12.3 3 13.75 4.45 13.75 6.25C13.75 10.25 8 13.5 8 13.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// 10. BellIcon — notificación
export function BellIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M3.75 11.25H12.25C12.25 11.25 11.25 10.5 11.25 8.75V7C11.25 5.21 9.79 3.75 8 3.75C6.21 3.75 4.75 5.21 4.75 7V8.75C4.75 10.5 3.75 11.25 3.75 11.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M6.75 12.75C6.75 13.44 7.31 14 8 14C8.69 14 9.25 13.44 9.25 12.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8 3.75V2.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

// 11. ChatBubbleIcon — mensaje
export function ChatBubbleIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M2.75 4.25C2.75 3.42 3.42 2.75 4.25 2.75H11.75C12.58 2.75 13.25 3.42 13.25 4.25V9.75C13.25 10.58 12.58 11.25 11.75 11.25H6.5L3.75 13.5V11.25H4.25C3.42 11.25 2.75 10.58 2.75 9.75V4.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// 12. EyeIcon — visible
export function EyeIcon(props: CocoaIconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M1.75 8C1.75 8 4 3.75 8 3.75C12 3.75 14.25 8 14.25 8C14.25 8 12 12.25 8 12.25C4 12.25 1.75 8 1.75 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  );
}
