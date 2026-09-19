// CocoaStatusBadge — badge de estado con icono (Tanda UX-1 · lote U2;
// UX-RECEPCION-FEEL §4 «Diccionario de estados con icono», F31, D5).
//
// `CocoaBadge` + el icono que nombra la entrada del diccionario
// (content/status-dictionary.ts): icono + color + texto, siempre en
// minúsculas (`uppercase={false}` → 11 px footnote/subheadline en tablas y
// fichas). `dense` es para los tiles del tablero: badge `small` e icono de
// 10 px. Sin estilos inline propios: todo lo pinta CocoaBadge con sus tokens.
//
// Uso: <CocoaStatusBadge entry={reservationStatus(row.status)} />

import type { ComponentType } from "react";
import { CocoaBadge, type CocoaBadgeVariant } from "./CocoaBadge";
import type { StatusEntry, StatusIconName } from "../../content/status-dictionary";
import {
  ArrowInIcon,
  ArrowOutIcon,
  BroomIcon,
  CheckCircleIcon,
  ClockIcon,
  EuroIcon,
  ExclamationCircleIcon,
  EyeIcon,
  InfoCircleIcon,
  KeyIcon,
  LockIcon,
  MoonIcon,
  UserSlashIcon,
  XCircleIcon,
  type CocoaIconProps
} from "../cocoa-icons/StatusIcons";

/** Nombre del diccionario → componente de cocoa-icons (todos decorativos: el texto ya nombra el estado). */
export const STATUS_ICON_COMPONENTS: Record<StatusIconName, ComponentType<CocoaIconProps>> = {
  key: KeyIcon,
  broom: BroomIcon,
  euro: EuroIcon,
  "arrow-in": ArrowInIcon,
  "arrow-out": ArrowOutIcon,
  "user-slash": UserSlashIcon,
  moon: MoonIcon,
  "check-circle": CheckCircleIcon,
  "x-circle": XCircleIcon,
  "exclamation-circle": ExclamationCircleIcon,
  "info-circle": InfoCircleIcon,
  clock: ClockIcon,
  lock: LockIcon,
  eye: EyeIcon
};

/** Lo que el badge necesita de una entrada: etiqueta y tono; icono, forma corta y énfasis opcionales. */
export type CocoaStatusEntry = Pick<StatusEntry, "label" | "tone"> & Partial<Pick<StatusEntry, "short" | "icon" | "emphasis">>;

export interface CocoaStatusBadgeProps {
  entry: CocoaStatusEntry;
  /** Por defecto `outline`, o `tinted` si la entrada lleva `emphasis` (Inspeccionada). */
  variant?: CocoaBadgeVariant;
  /** Tiles del tablero: badge `small` e icono de 10 px. */
  dense?: boolean;
  /** Pinta `entry.short` (el `title` conserva la etiqueta completa). */
  short?: boolean;
  title?: string;
  className?: string;
  "aria-label"?: string;
}

/** Variante efectiva: la pedida, o el énfasis de la entrada, o el contorno canónico. */
export function statusBadgeVariant(entry: CocoaStatusEntry, variant?: CocoaBadgeVariant): CocoaBadgeVariant {
  return variant ?? entry.emphasis ?? "outline";
}

export function CocoaStatusBadge({ entry, variant, dense = false, short = false, title, className, "aria-label": ariaLabel }: CocoaStatusBadgeProps) {
  const Icon = entry.icon ? STATUS_ICON_COMPONENTS[entry.icon] : null;
  const text = short && entry.short ? entry.short : entry.label;
  return (
    <CocoaBadge
      tone={entry.tone}
      variant={statusBadgeVariant(entry, variant)}
      size={dense ? "small" : "regular"}
      uppercase={false}
      icon={Icon ? <Icon size={dense ? 10 : 11} /> : undefined}
      title={title ?? (text !== entry.label ? entry.label : undefined)}
      className={["c22-status-badge", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
    >
      {text}
    </CocoaBadge>
  );
}

export default CocoaStatusBadge;
