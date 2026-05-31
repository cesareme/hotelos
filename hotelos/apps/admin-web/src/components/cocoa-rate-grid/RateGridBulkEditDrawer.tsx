// RateGridBulkEditDrawer — drawer right slide-in (320px) para edicion en
// bloque del rate grid.
//
// Permite aplicar una operacion (valor + restricciones + override por canal)
// a un conjunto de celdas seleccionadas (`RateGridCell[]`). Renderiza un
// preview con las primeras 5 celdas mostrando before/after.
//
// El consumidor pasa `selectedCells`, `onApply(op)` y `onCancel()`. El drawer
// devuelve un `BulkEditOperation` que el parent puede traducir al payload de
// `RateGridBulkUpdateRequest` antes de enviarlo al backend.
//
// Visual: Cocoa tokens (--cocoa-*) para light/dark, slide-in desde la derecha
// con `transform: translateX`. Usa `createPortal` para escapar overflow del
// host. Bloquea scroll del body y trampa de foco (igual que CocoaSheet).

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { RateGridCell, RateRestrictions } from "@hotelos/shared";
import { CocoaButton } from "../cocoa/CocoaButton";
import { CocoaInput } from "../cocoa/CocoaInput";
import { CocoaSwitch } from "../cocoa/CocoaSwitch";

const DRAWER_WIDTH = 320;

export type BulkEditValueMode = "fixed" | "deltaPercent" | "deltaAbsolute" | "copyFrom";

export type BulkEditValueOp =
  | { mode: "fixed"; value: number }
  | { mode: "deltaPercent"; value: number }
  | { mode: "deltaAbsolute"; value: number }
  | { mode: "copyFrom"; sourceDate: string };

export type BulkEditChannelOverride = {
  channelId: string;
  markupPercent: number;
};

export type BulkEditOperation = {
  value?: BulkEditValueOp;
  restrictions?: RateRestrictions;
  channelOverrides?: BulkEditChannelOverride[];
};

export type RateGridChannelOption = {
  id: string;
  name: string;
  defaultMarkupPercent?: number;
};

export interface RateGridBulkEditDrawerProps {
  selectedCells: RateGridCell[];
  onApply: (op: BulkEditOperation) => void;
  onCancel: () => void;
  channels?: RateGridChannelOption[];
}

// ---------- helpers ----------

function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function clampNumber(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n;
}

function parseFloatOr(input: string, fallback: number): number {
  if (input.trim() === "") return fallback;
  const n = Number.parseFloat(input);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntOr(input: string, fallback: number | undefined): number | undefined {
  if (input.trim() === "") return fallback;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) ? n : fallback;
}

function applyValueOp(cell: RateGridCell, op: BulkEditValueOp | undefined, source: RateGridCell[]): number {
  if (!op) return cell.basePrice;
  switch (op.mode) {
    case "fixed":
      return clampNumber(op.value);
    case "deltaPercent":
      return clampNumber(cell.basePrice * (1 + op.value / 100));
    case "deltaAbsolute":
      return clampNumber(cell.basePrice + op.value);
    case "copyFrom": {
      const src = source.find(
        (c) => c.date === op.sourceDate && c.roomTypeId === cell.roomTypeId
      );
      return src ? src.basePrice : cell.basePrice;
    }
    default:
      return cell.basePrice;
  }
}

// ---------- focus trap ----------

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

// ---------- subcomponents ----------

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3
      style={{
        margin: "0 0 8px",
        fontFamily: "var(--cocoa-font)",
        fontSize: "var(--cocoa-fs-subheadline)",
        fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
        textTransform: "uppercase",
        letterSpacing: "var(--cocoa-tracking-wide)",
        color: "var(--cocoa-label-secondary)"
      }}
    >
      {children}
    </h3>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", marginBottom: 16 }}>
      <SectionHeader>{title}</SectionHeader>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </section>
  );
}

interface RadioOptionProps {
  name: string;
  value: BulkEditValueMode;
  checked: boolean;
  onSelect: (v: BulkEditValueMode) => void;
  label: string;
  children?: ReactNode;
}

function RadioOption({ name, value, checked, onSelect, label, children }: RadioOptionProps) {
  const id = useId();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        borderRadius: "var(--cocoa-radius-md)",
        border: `1px solid ${checked ? "var(--cocoa-accent)" : "var(--cocoa-separator)"}`,
        background: checked
          ? "color-mix(in srgb, var(--cocoa-accent) 6%, transparent)"
          : "var(--cocoa-background-control)",
        transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
      }}
    >
      <label
        htmlFor={id}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontFamily: "var(--cocoa-font)",
          fontSize: "var(--cocoa-fs-body)",
          color: "var(--cocoa-label)"
        }}
      >
        <input
          id={id}
          type="radio"
          name={name}
          checked={checked}
          onChange={() => onSelect(value)}
          style={{ accentColor: "var(--cocoa-accent)", margin: 0 }}
        />
        {label}
      </label>
      {checked && children ? <div style={{ paddingLeft: 24 }}>{children}</div> : null}
    </div>
  );
}

interface CheckboxRowProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  children?: ReactNode;
}

function CheckboxRow({ checked, onChange, label, children }: CheckboxRowProps) {
  const id = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        htmlFor={id}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontFamily: "var(--cocoa-font)",
          fontSize: "var(--cocoa-fs-body)",
          color: "var(--cocoa-label)"
        }}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ accentColor: "var(--cocoa-accent)", margin: 0 }}
        />
        {label}
      </label>
      {checked && children ? <div style={{ paddingLeft: 24 }}>{children}</div> : null}
    </div>
  );
}

interface ToggleRowProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}

function ToggleRow({ checked, onChange, label }: ToggleRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        fontFamily: "var(--cocoa-font)",
        fontSize: "var(--cocoa-fs-body)",
        color: "var(--cocoa-label)"
      }}
    >
      <span>{label}</span>
      <CocoaSwitch checked={checked} onChange={onChange} size="small" />
    </div>
  );
}

// ---------- main ----------

export function RateGridBulkEditDrawer({
  selectedCells,
  onApply,
  onCancel,
  channels = []
}: RateGridBulkEditDrawerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const [isVisible, setIsVisible] = useState<boolean>(false);

  // --- Valor section state
  const [valueMode, setValueMode] = useState<BulkEditValueMode>("fixed");
  const [fixedValue, setFixedValue] = useState<string>("");
  const [deltaPercent, setDeltaPercent] = useState<string>("");
  const [deltaAbsolute, setDeltaAbsolute] = useState<string>("");
  const [copyFromDate, setCopyFromDate] = useState<string>("");
  const [valueEnabled, setValueEnabled] = useState<boolean>(false);

  // --- Restricciones section state
  const [minLosEnabled, setMinLosEnabled] = useState<boolean>(false);
  const [minLos, setMinLos] = useState<string>("");
  const [maxLosEnabled, setMaxLosEnabled] = useState<boolean>(false);
  const [maxLos, setMaxLos] = useState<string>("");
  const [ctaEnabled, setCtaEnabled] = useState<boolean>(false);
  const [cta, setCta] = useState<boolean>(false);
  const [ctdEnabled, setCtdEnabled] = useState<boolean>(false);
  const [ctd, setCtd] = useState<boolean>(false);
  const [closedEnabled, setClosedEnabled] = useState<boolean>(false);
  const [closed, setClosed] = useState<boolean>(false);
  const [stopSellEnabled, setStopSellEnabled] = useState<boolean>(false);
  const [stopSell, setStopSell] = useState<boolean>(false);

  // --- Canal section state
  const [overridePerChannel, setOverridePerChannel] = useState<boolean>(false);
  const [channelMarkups, setChannelMarkups] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const ch of channels) {
      init[ch.id] = ch.defaultMarkupPercent != null ? String(ch.defaultMarkupPercent) : "0";
    }
    return init;
  });

  // animate in on mount
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setIsVisible(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // focus trap + restore focus on unmount
  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const root = containerRef.current;
    if (root) {
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      window.requestAnimationFrame(() => first.focus({ preventScroll: true }));
    }
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  // body scroll lock + Esc
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onCancel]);

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = getFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
    []
  );

  const handleBackdropMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onCancel();
    },
    [onCancel]
  );

  // --- Build the BulkEditOperation
  const operation = useMemo<BulkEditOperation>(() => {
    const op: BulkEditOperation = {};

    if (valueEnabled) {
      switch (valueMode) {
        case "fixed":
          op.value = { mode: "fixed", value: parseFloatOr(fixedValue, 0) };
          break;
        case "deltaPercent":
          op.value = { mode: "deltaPercent", value: parseFloatOr(deltaPercent, 0) };
          break;
        case "deltaAbsolute":
          op.value = { mode: "deltaAbsolute", value: parseFloatOr(deltaAbsolute, 0) };
          break;
        case "copyFrom":
          op.value = { mode: "copyFrom", sourceDate: copyFromDate };
          break;
      }
    }

    const restrictions: RateRestrictions = {};
    let hasAny = false;
    if (minLosEnabled) {
      const n = parseIntOr(minLos, undefined);
      if (n !== undefined) {
        restrictions.minLos = n;
        hasAny = true;
      }
    }
    if (maxLosEnabled) {
      const n = parseIntOr(maxLos, undefined);
      if (n !== undefined) {
        restrictions.maxLos = n;
        hasAny = true;
      }
    }
    if (ctaEnabled) {
      restrictions.cta = cta;
      hasAny = true;
    }
    if (ctdEnabled) {
      restrictions.ctd = ctd;
      hasAny = true;
    }
    if (closedEnabled) {
      restrictions.closed = closed;
      hasAny = true;
    }
    if (stopSellEnabled) {
      restrictions.stopSell = stopSell;
      hasAny = true;
    }
    if (hasAny) op.restrictions = restrictions;

    if (overridePerChannel && channels.length > 0) {
      op.channelOverrides = channels.map((ch) => ({
        channelId: ch.id,
        markupPercent: parseFloatOr(channelMarkups[ch.id] ?? "0", 0)
      }));
    }

    return op;
  }, [
    valueEnabled,
    valueMode,
    fixedValue,
    deltaPercent,
    deltaAbsolute,
    copyFromDate,
    minLosEnabled,
    minLos,
    maxLosEnabled,
    maxLos,
    ctaEnabled,
    cta,
    ctdEnabled,
    ctd,
    closedEnabled,
    closed,
    stopSellEnabled,
    stopSell,
    overridePerChannel,
    channels,
    channelMarkups
  ]);

  // Preview: first 5 cells with before/after price
  const previewRows = useMemo(() => {
    return selectedCells.slice(0, 5).map((cell) => {
      const after = applyValueOp(cell, operation.value, selectedCells);
      return {
        key: `${cell.roomTypeId}-${cell.date}-${cell.channelId ?? "base"}`,
        date: cell.date,
        roomTypeId: cell.roomTypeId,
        before: cell.basePrice,
        after
      };
    });
  }, [selectedCells, operation.value]);

  // ---------- styles ----------

  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    justifyContent: "flex-end",
    background: "rgba(0,0,0,0.32)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    opacity: isVisible ? 1 : 0,
    transition: "opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    pointerEvents: isVisible ? "auto" : "none"
  };

  const containerStyle: CSSProperties = {
    position: "relative",
    width: DRAWER_WIDTH,
    height: "100vh",
    background: "var(--cocoa-background-content)",
    boxShadow: "var(--cocoa-shadow-modal)",
    display: "flex",
    flexDirection: "column",
    transform: isVisible ? "translateX(0)" : `translateX(${DRAWER_WIDTH}px)`,
    transition: "transform var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    outline: "none"
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "14px 16px",
    borderBottom: "1px solid var(--cocoa-separator)",
    flexShrink: 0
  };

  const headerTitleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-headline)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-label)",
    lineHeight: 1.3
  };

  const bodyStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "16px"
  };

  const footerStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: "1px solid var(--cocoa-separator)",
    flexShrink: 0
  };

  const previewTableStyle: CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "var(--cocoa-fs-caption)",
    fontFamily: "var(--cocoa-font)"
  };

  const previewCellStyle: CSSProperties = {
    padding: "4px 6px",
    borderBottom: "1px solid var(--cocoa-separator)",
    textAlign: "left",
    color: "var(--cocoa-label)"
  };

  const previewHeadStyle: CSSProperties = {
    ...previewCellStyle,
    color: "var(--cocoa-label-secondary)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    textTransform: "uppercase",
    letterSpacing: "var(--cocoa-tracking-wide)",
    fontSize: "var(--cocoa-fs-caption)"
  };

  const closeButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: "var(--cocoa-radius-sm)",
    background: "transparent",
    border: "1px solid transparent",
    color: "var(--cocoa-label-secondary)",
    cursor: "pointer",
    padding: 0
  };

  if (typeof document === "undefined") return null;

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropMouseDown}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header style={headerStyle}>
          <h2 id={headingId} style={headerTitleStyle}>
            Aplicar a {selectedCells.length} celdas seleccionadas
          </h2>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onCancel}
            className="cocoa-focus-ring"
            style={closeButtonStyle}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M1 1L13 13M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div style={bodyStyle}>
          {/* Valor */}
          <Section title="Valor">
            <div style={{ marginBottom: 4 }}>
              <ToggleRow
                checked={valueEnabled}
                onChange={setValueEnabled}
                label="Modificar precio"
              />
            </div>
            {valueEnabled ? (
              <>
                <RadioOption
                  name="bulk-value-mode"
                  value="fixed"
                  checked={valueMode === "fixed"}
                  onSelect={setValueMode}
                  label="Valor fijo"
                >
                  <CocoaInput
                    value={fixedValue}
                    onChange={setFixedValue}
                    placeholder="120.00"
                    inputMode="decimal"
                    size="small"
                  />
                </RadioOption>
                <RadioOption
                  name="bulk-value-mode"
                  value="deltaPercent"
                  checked={valueMode === "deltaPercent"}
                  onSelect={setValueMode}
                  label="Delta %"
                >
                  <CocoaInput
                    value={deltaPercent}
                    onChange={setDeltaPercent}
                    placeholder="+10"
                    inputMode="decimal"
                    size="small"
                  />
                </RadioOption>
                <RadioOption
                  name="bulk-value-mode"
                  value="deltaAbsolute"
                  checked={valueMode === "deltaAbsolute"}
                  onSelect={setValueMode}
                  label="Delta absoluto"
                >
                  <CocoaInput
                    value={deltaAbsolute}
                    onChange={setDeltaAbsolute}
                    placeholder="+15.00"
                    inputMode="decimal"
                    size="small"
                  />
                </RadioOption>
                <RadioOption
                  name="bulk-value-mode"
                  value="copyFrom"
                  checked={valueMode === "copyFrom"}
                  onSelect={setValueMode}
                  label="Copy from"
                >
                  <CocoaInput
                    value={copyFromDate}
                    onChange={setCopyFromDate}
                    placeholder="YYYY-MM-DD"
                    size="small"
                  />
                </RadioOption>
              </>
            ) : null}
          </Section>

          {/* Restricciones */}
          <Section title="Restricciones">
            <CheckboxRow
              checked={minLosEnabled}
              onChange={setMinLosEnabled}
              label="MinLOS"
            >
              <CocoaInput
                value={minLos}
                onChange={setMinLos}
                placeholder="1"
                inputMode="numeric"
                size="small"
              />
            </CheckboxRow>
            <CheckboxRow
              checked={maxLosEnabled}
              onChange={setMaxLosEnabled}
              label="MaxLOS"
            >
              <CocoaInput
                value={maxLos}
                onChange={setMaxLos}
                placeholder="14"
                inputMode="numeric"
                size="small"
              />
            </CheckboxRow>
            <CheckboxRow
              checked={ctaEnabled}
              onChange={setCtaEnabled}
              label="CTA"
            >
              <ToggleRow checked={cta} onChange={setCta} label="Cerrado a llegada" />
            </CheckboxRow>
            <CheckboxRow
              checked={ctdEnabled}
              onChange={setCtdEnabled}
              label="CTD"
            >
              <ToggleRow checked={ctd} onChange={setCtd} label="Cerrado a salida" />
            </CheckboxRow>
            <CheckboxRow
              checked={closedEnabled}
              onChange={setClosedEnabled}
              label="Closed"
            >
              <ToggleRow checked={closed} onChange={setClosed} label="Dia cerrado" />
            </CheckboxRow>
            <CheckboxRow
              checked={stopSellEnabled}
              onChange={setStopSellEnabled}
              label="StopSell"
            >
              <ToggleRow checked={stopSell} onChange={setStopSell} label="Detener venta" />
            </CheckboxRow>
          </Section>

          {/* Canal (opcional) */}
          {channels.length > 0 ? (
            <Section title="Canal">
              <ToggleRow
                checked={overridePerChannel}
                onChange={setOverridePerChannel}
                label="Override per channel"
              />
              {overridePerChannel ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {channels.map((ch) => (
                    <div
                      key={ch.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8
                      }}
                    >
                      <span
                        style={{
                          fontSize: "var(--cocoa-fs-callout)",
                          color: "var(--cocoa-label)",
                          minWidth: 0,
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}
                      >
                        {ch.name}
                      </span>
                      <div style={{ width: 96, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <CocoaInput
                          value={channelMarkups[ch.id] ?? "0"}
                          onChange={(v) =>
                            setChannelMarkups((prev) => ({ ...prev, [ch.id]: v }))
                          }
                          inputMode="decimal"
                          size="small"
                        />
                        <span
                          style={{
                            color: "var(--cocoa-label-secondary)",
                            fontSize: "var(--cocoa-fs-callout)"
                          }}
                        >
                          %
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </Section>
          ) : null}

          {/* Preview */}
          <Section title="Vista previa">
            {previewRows.length === 0 ? (
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--cocoa-fs-callout)",
                  color: "var(--cocoa-label-secondary)"
                }}
              >
                Sin celdas seleccionadas.
              </p>
            ) : (
              <table style={previewTableStyle}>
                <thead>
                  <tr>
                    <th style={previewHeadStyle}>Fecha</th>
                    <th style={previewHeadStyle}>Antes</th>
                    <th style={previewHeadStyle}>Despues</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => (
                    <tr key={row.key}>
                      <td style={previewCellStyle}>{row.date}</td>
                      <td style={previewCellStyle}>{formatMoney(row.before)}</td>
                      <td
                        style={{
                          ...previewCellStyle,
                          color:
                            row.after !== row.before
                              ? "var(--cocoa-accent)"
                              : "var(--cocoa-label)",
                          fontWeight:
                            row.after !== row.before
                              ? ("var(--cocoa-fw-medium)" as unknown as number)
                              : ("var(--cocoa-fw-regular)" as unknown as number)
                        }}
                      >
                        {formatMoney(row.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {selectedCells.length > previewRows.length ? (
              <p
                style={{
                  margin: "4px 0 0",
                  fontSize: "var(--cocoa-fs-caption)",
                  color: "var(--cocoa-label-tertiary)"
                }}
              >
                +{selectedCells.length - previewRows.length} mas
              </p>
            ) : null}
          </Section>
        </div>

        <footer style={footerStyle}>
          <CocoaButton variant="bordered" tone="neutral" onClick={onCancel}>
            Cancel
          </CocoaButton>
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => onApply(operation)}
            disabled={selectedCells.length === 0}
          >
            Aplicar a seleccion
          </CocoaButton>
        </footer>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default RateGridBulkEditDrawer;
