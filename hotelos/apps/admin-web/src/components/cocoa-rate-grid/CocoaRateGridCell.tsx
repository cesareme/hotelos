// CocoaRateGridCell — Celda individual del grid de tarifas (Rate Manager).
//
// Subcomponente puro: render + interactions a nivel celda. La gestion del
// estado (que celda esta seleccionada, activa, en edicion, batches de cambios,
// etc) vive en el contenedor padre (`CocoaRateGrid`).
//
// Estados visuales:
//   - default     : 80x40, fondo de control, valor formateado tabular.
//   - selected    : tint accent (background + border) + aria-selected="true".
//   - active      : focus ring accent (ultima celda navegada con teclado).
//   - editing     : sustituye el span por un <input type="number" inline> que
//                   recibe focus automatico y emite onCommit en blur/Enter.
//   - readOnly    : opacidad reducida + cursor not-allowed; nunca entra a
//                   editing y expone aria-readonly="true".
//
// Badges: restricciones (CTA/CTD/CLOSED/MIN/MAX) se renderizan como puntos
// muy pequenos en la esquina inferior, para no competir con el valor.
//
// Accessibility: role="gridcell" + aria-selected + aria-readonly + tabIndex
// controlado por el padre (active = 0, resto = -1) siguiendo el roving
// tabindex pattern de WAI-ARIA grid.

import { useEffect, useRef } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent
} from "react";
import type { RateGridCell, RateRestrictions } from "@hotelos/shared";

export interface CocoaRateGridCellProps {
  cell: RateGridCell;
  selected: boolean;
  editing: boolean;
  active: boolean;
  readOnly?: boolean;
  onSelect: (cell: RateGridCell, event: ReactMouseEvent<HTMLDivElement>) => void;
  onEdit: (cell: RateGridCell) => void;
  onCommit: (cell: RateGridCell, value: number | null) => void;
}

const CELL_WIDTH = 80;
const CELL_HEIGHT = 40;

function formatPrice(value: number): string {
  // Sin separador de miles para mantener el ancho de 80px; 0 decimales es lo
  // habitual para BAR en hospitalidad (los centimos se pierden en los OTAs).
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toString();
}

type RestrictionFlag = {
  key: keyof RateRestrictions;
  label: string;
  short: string;
  tone: "warning" | "danger" | "info";
};

const RESTRICTION_FLAGS: ReadonlyArray<RestrictionFlag> = [
  { key: "closed", label: "Cerrado", short: "X", tone: "danger" },
  { key: "stopSell", label: "Stop sell", short: "S", tone: "danger" },
  { key: "cta", label: "CTA (cerrado a llegada)", short: "A", tone: "warning" },
  { key: "ctd", label: "CTD (cerrado a salida)", short: "D", tone: "warning" }
];

function collectBadges(r: RateRestrictions): RestrictionFlag[] {
  const out: RestrictionFlag[] = [];
  for (const flag of RESTRICTION_FLAGS) {
    if (r[flag.key]) out.push(flag);
  }
  return out;
}

function describeRestrictions(r: RateRestrictions): string | null {
  const parts: string[] = [];
  for (const flag of RESTRICTION_FLAGS) {
    if (r[flag.key]) parts.push(flag.label);
  }
  if (typeof r.minLos === "number") parts.push(`MIN LOS ${r.minLos}`);
  if (typeof r.maxLos === "number") parts.push(`MAX LOS ${r.maxLos}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function toneColor(tone: RestrictionFlag["tone"]): string {
  switch (tone) {
    case "danger":
      return "var(--cocoa-danger, #FF3B30)";
    case "warning":
      return "var(--cocoa-warning, #FF9F0A)";
    case "info":
    default:
      return "var(--cocoa-accent)";
  }
}

export function CocoaRateGridCell(props: CocoaRateGridCellProps) {
  const {
    cell,
    selected,
    editing,
    active,
    readOnly = false,
    onSelect,
    onEdit,
    onCommit
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus + select cuando entramos a edicion. Usamos requestAnimationFrame
  // para garantizar que el input ya esta en el DOM cuando llamamos a focus().
  useEffect(() => {
    if (!editing || readOnly) return;
    const el = inputRef.current;
    if (!el) return;
    const handle = window.requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [editing, readOnly]);

  const restrictions = cell.restrictions ?? {};
  const badges = collectBadges(restrictions);
  const restrictionsLabel = describeRestrictions(restrictions);
  const isClosed = Boolean(restrictions.closed || restrictions.stopSell);

  // Border + background: selected > active > default.
  // Mantenemos un border de 1px siempre para que el layout no salte al cambiar
  // de estado (evita reflows en escenarios de seleccion rapida con shift+arrow).
  const borderColor = selected
    ? "var(--cocoa-accent)"
    : active
      ? "var(--cocoa-accent)"
      : "var(--cocoa-separator)";

  const background = selected
    ? "color-mix(in srgb, var(--cocoa-accent) 12%, var(--cocoa-background-control))"
    : "var(--cocoa-background-control)";

  const focusRing = active && !editing
    ? "0 0 0 2px rgb(0 100 225 / 0.40)"
    : "none";

  const containerStyle: CSSProperties = {
    position: "relative",
    boxSizing: "border-box",
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    minWidth: CELL_WIDTH,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "0 8px",
    border: `1px solid ${borderColor}`,
    background,
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    fontVariantNumeric: "tabular-nums",
    boxShadow: focusRing,
    cursor: readOnly ? "not-allowed" : editing ? "text" : "cell",
    userSelect: "none",
    opacity: readOnly ? 0.55 : 1,
    transition:
      "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), background var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    outline: "none"
  };

  const valueStyle: CSSProperties = {
    display: "inline-block",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: isClosed ? "var(--cocoa-label-secondary)" : "var(--cocoa-label)",
    textDecoration: isClosed ? "line-through" : "none"
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    margin: 0,
    padding: 0,
    border: 0,
    background: "transparent",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    textAlign: "right",
    outline: "none",
    appearance: "textfield",
    WebkitAppearance: "none",
    MozAppearance: "textfield"
  };

  const badgeRowStyle: CSSProperties = {
    position: "absolute",
    left: 4,
    bottom: 3,
    display: "flex",
    alignItems: "center",
    gap: 2,
    pointerEvents: "none"
  };

  const sourceDotStyle: CSSProperties | null =
    cell.source === "rms" || cell.source === "derived"
      ? {
          position: "absolute",
          top: 4,
          left: 4,
          width: 5,
          height: 5,
          borderRadius: "50%",
          background:
            cell.source === "rms"
              ? "var(--cocoa-accent)"
              : "var(--cocoa-label-tertiary)",
          pointerEvents: "none"
        }
      : null;

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (readOnly) {
      onSelect(cell, event);
      return;
    }
    onSelect(cell, event);
  };

  const handleDoubleClick = () => {
    if (readOnly) return;
    onEdit(cell);
  };

  const handleContainerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (readOnly) return;
    // Enter / F2 abren edicion; las flechas las maneja el padre (grid container).
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      onEdit(cell);
    }
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitFromInput(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCommit(cell, null);
    }
  };

  const commitFromInput = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      onCommit(cell, null);
      return;
    }
    // Aceptamos coma o punto como decimal (locale es-ES vs en-US).
    const normalized = trimmed.replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0) {
      onCommit(cell, null);
      return;
    }
    onCommit(cell, parsed);
  };

  const handleInputBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    commitFromInput(event.currentTarget.value);
  };

  const ariaLabel = (() => {
    const priceLabel = `${formatPrice(cell.effectivePrice)}`;
    const restrictionPart = restrictionsLabel ? `, ${restrictionsLabel}` : "";
    const sourcePart = cell.source === "rms" ? ", origen RMS" : cell.source === "derived" ? ", origen derivado" : "";
    return `Tarifa ${priceLabel} para ${cell.date}${restrictionPart}${sourcePart}`;
  })();

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-readonly={readOnly || undefined}
      aria-label={ariaLabel}
      data-date={cell.date}
      data-room-type-id={cell.roomTypeId}
      data-source={cell.source}
      data-state={editing ? "editing" : selected ? "selected" : active ? "active" : "default"}
      tabIndex={active ? 0 : -1}
      style={containerStyle}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleContainerKeyDown}
    >
      {sourceDotStyle ? (
        <span
          aria-hidden="true"
          title={cell.source === "rms" ? "Sugerido por RMS" : "Derivado"}
          style={sourceDotStyle}
        />
      ) : null}

      {editing && !readOnly ? (
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          step="1"
          min={0}
          defaultValue={formatPrice(cell.effectivePrice)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          aria-label={`Editar tarifa para ${cell.date}`}
          style={inputStyle}
        />
      ) : (
        <span style={valueStyle}>{formatPrice(cell.effectivePrice)}</span>
      )}

      {badges.length > 0 && !editing ? (
        <span style={badgeRowStyle} aria-hidden="true">
          {badges.map((b) => (
            <span
              key={b.key}
              title={b.label}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: toneColor(b.tone),
                color: "var(--cocoa-accent-contrast, #fff)",
                fontSize: 8,
                lineHeight: 1,
                fontWeight: 700,
                letterSpacing: 0
              }}
            >
              {b.short}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

export default CocoaRateGridCell;
