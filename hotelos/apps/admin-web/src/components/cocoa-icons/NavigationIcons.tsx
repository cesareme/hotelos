import type { CSSProperties, SVGProps } from "react";

export type IconWeight = "regular" | "medium" | "semibold";

export interface CocoaIconProps {
  size?: number;
  color?: string;
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
}

const STROKE_BY_WEIGHT: Record<IconWeight, number> = {
  regular: 1.5,
  medium: 2,
  semibold: 2.5
};

const DEFAULT_SIZE = 24;

function getStrokeWidth(weight: IconWeight | undefined): number {
  return STROKE_BY_WEIGHT[weight ?? "regular"];
}

interface BaseSvgProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  size: number;
  color: string;
}

function baseSvgProps({ size, color, ...rest }: BaseSvgProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    xmlns: "http://www.w3.org/2000/svg",
    ...rest
  };
}

/* ------------------------------------------------------------------ */
/*  HouseIcon — Inicio                                                 */
/* ------------------------------------------------------------------ */
export function HouseIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M3.5 11 12 4l8.5 7" />
      <path d="M5.5 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h4V20h3.5a1 1 0 0 0 1-1V9.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  DoorOpenIcon — FrontDesk                                           */
/* ------------------------------------------------------------------ */
export function DoorOpenIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M3 20h18" />
      <path d="M6 20V5.5a1 1 0 0 1 .8-.98l8-1.5A1 1 0 0 1 16 4v16" />
      <path d="M16 20V6.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20" />
      <path d="M13 12.5v1.5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  BedIcon — Habitaciones                                             */
/* ------------------------------------------------------------------ */
export function BedIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M3 18V6" />
      <path d="M3 13h18v5" />
      <path d="M21 18v-4a3 3 0 0 0-3-3h-7v2" />
      <circle cx="7" cy="11" r="2" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  CalendarIcon — Reservas                                            */
/* ------------------------------------------------------------------ */
export function CalendarIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17" />
      <path d="M8 3.5v3" />
      <path d="M16 3.5v3" />
      <circle cx="8" cy="14.5" r="0.6" fill={color} stroke="none" />
      <circle cx="12" cy="14.5" r="0.6" fill={color} stroke="none" />
      <circle cx="16" cy="14.5" r="0.6" fill={color} stroke="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  PersonIcon — Huespedes                                             */
/* ------------------------------------------------------------------ */
export function PersonIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20.5c.7-3.7 3.8-6.25 7.5-6.25s6.8 2.55 7.5 6.25" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  PeopleIcon — Grupos                                                */
/* ------------------------------------------------------------------ */
export function PeopleIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <circle cx="9" cy="9" r="3.25" />
      <circle cx="17.25" cy="10" r="2.5" />
      <path d="M2.75 19.5c.7-3.2 3.2-5.25 6.25-5.25s5.55 2.05 6.25 5.25" />
      <path d="M16 14.5c2.6 0 4.65 1.6 5.25 4" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  BuildingIcon — Property                                            */
/* ------------------------------------------------------------------ */
export function BuildingIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
      <path d="M9 20.5V16h6v4.5" />
      <path d="M8 7.5h2" />
      <path d="M14 7.5h2" />
      <path d="M8 11.5h2" />
      <path d="M14 11.5h2" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  CreditCardIcon — Facturacion                                       */
/* ------------------------------------------------------------------ */
export function CreditCardIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
      <path d="M2.5 10h19" />
      <path d="M6 15h4" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  ChartIcon — Revenue                                                */
/* ------------------------------------------------------------------ */
export function ChartIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M3.5 3.5v17h17" />
      <path d="M7.5 16.5v-3" />
      <path d="M11.5 16.5v-6" />
      <path d="M15.5 16.5v-4.5" />
      <path d="M19.5 16.5V8" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  WrenchIcon — Mantenimiento                                         */
/* ------------------------------------------------------------------ */
export function WrenchIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M15.5 3.5a4.5 4.5 0 0 0-4.4 5.55l-7.4 7.4a2 2 0 0 0 0 2.85l.55.55a2 2 0 0 0 2.85 0l7.4-7.4A4.5 4.5 0 1 0 15.5 3.5z" />
      <path d="M14.5 9.5l1.25 1.25" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  SparkleIcon — AI                                                   */
/* ------------------------------------------------------------------ */
export function SparkleIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M12 3.5c.4 3.4 2.1 5.1 5.5 5.5-3.4.4-5.1 2.1-5.5 5.5-.4-3.4-2.1-5.1-5.5-5.5 3.4-.4 5.1-2.1 5.5-5.5z" />
      <path d="M18.5 14.5c.2 1.7 1.05 2.55 2.75 2.75-1.7.2-2.55 1.05-2.75 2.75-.2-1.7-1.05-2.55-2.75-2.75 1.7-.2 2.55-1.05 2.75-2.75z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  GearIcon — Ajustes                                                 */
/* ------------------------------------------------------------------ */
export function GearIcon({
  size = DEFAULT_SIZE,
  color = "currentColor",
  weight,
  className,
  style,
  ...rest
}: CocoaIconProps) {
  const sw = getStrokeWidth(weight);
  return (
    <svg
      {...baseSvgProps({ size, color, className, style })}
      strokeWidth={sw}
      {...rest}
    >
      <path d="M19.5 12a7.5 7.5 0 0 0-.1-1.25l2-1.55-2-3.4-2.35.9a7.5 7.5 0 0 0-2.15-1.25L14.5 3h-5l-.4 2.45a7.5 7.5 0 0 0-2.15 1.25l-2.35-.9-2 3.4 2 1.55a7.5 7.5 0 0 0 0 2.5l-2 1.55 2 3.4 2.35-.9a7.5 7.5 0 0 0 2.15 1.25L9.5 21h5l.4-2.45a7.5 7.5 0 0 0 2.15-1.25l2.35.9 2-3.4-2-1.55c.07-.4.1-.82.1-1.25z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Named icon catalog                                                 */
/* ------------------------------------------------------------------ */
export const NavigationIcons = {
  HouseIcon,
  DoorOpenIcon,
  BedIcon,
  CalendarIcon,
  PersonIcon,
  PeopleIcon,
  BuildingIcon,
  CreditCardIcon,
  ChartIcon,
  WrenchIcon,
  SparkleIcon,
  GearIcon
} as const;

export type NavigationIconName = keyof typeof NavigationIcons;
