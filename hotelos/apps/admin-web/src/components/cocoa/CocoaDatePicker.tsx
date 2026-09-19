// CocoaDatePicker — native date input with the CocoaInput skin (COCOA-22.md
// §3.8): control bg, separator border (accent on focus, danger on error),
// radius 8, focus halo, tabular figures, 44 px on a coarse pointer.
//
// Tanda UX-1 · lote U7 (docs/design/UX-RECEPCION-FEEL.md §4 «Campo de fecha con
// aritmética», F8, patrón OPERA): with `arithmetic`, the native input also
// accepts «+7», «−1», «hoy» and «mañana» typed on the keyboard. The keystrokes
// a `<input type="date">` would ignore (+, −, letters) open a small buffer
// painted next to the field with the date it resolves to; Enter or leaving
// the field applies it through `onChange`, Esc discards it. Digits typed
// without a buffer keep driving the native segments, so the picker itself is
// untouched (`parseDateArithmetic` is pure and tested in CocoaControls.test.mts).

import { useId, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";
import { controlChrome } from "./CocoaInput";

export interface CocoaDatePickerProps {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
  error?: boolean;
  required?: boolean;
  /** Date AND time (`datetime-local`; `value`/`min`/`max` as «YYYY-MM-DDTHH:mm»); default a date only. */
  withTime?: boolean;
  /** Keyboard arithmetic («+7», «−1», «hoy», «mañana») applied on Enter / blur (U7, F8). Date-only pickers. */
  arithmetic?: boolean;
  /** Reference day of «hoy» / «mañana» and of a relative offset on an empty field (ISO; default: the local date). */
  today?: string;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  style?: CSSProperties;
}

const SIZE_METRICS: Record<NonNullable<CocoaDatePickerProps["size"]>, { height: number; padX: number; fontSize: string; lineHeight: string }> = {
  small: { height: 22, padX: 8, fontSize: "var(--cocoa-fs-subheadline)", lineHeight: "var(--cocoa-lh-subheadline)" },
  regular: { height: 28, padX: 10, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)" },
  large: { height: 34, padX: 12, fontSize: "var(--cocoa-fs-title-3)", lineHeight: "var(--cocoa-lh-title-3)" }
};

// ---------------------------------------------------------------- arithmetic (pure)

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar day as ISO («2026-09-19»). */
export function localIsoDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** `iso` shifted `days` calendar days (UTC arithmetic on a date-only value: no DST drift). */
export function shiftIsoDay(iso: string, days: number): string | null {
  const match = ISO_DATE.exec(iso);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Words the buffer understands, normalised (no accents, lower case). */
const TODAY_WORDS = new Set(["hoy", "h", "today", "t"]);
const TOMORROW_WORDS = new Set(["manana", "man", "m", "mañana", "tomorrow"]);
const YESTERDAY_WORDS = new Set(["ayer", "a", "yesterday"]);

function normalizeWord(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Resolves what the operator typed into an ISO date, or null when it is not
 * arithmetic: «+7» / «-1» / «−1» (days from `base`, or from `today` when the
 * field is empty), «+2s» (weeks), «hoy», «mañana», «ayer», a plain «25»
 * (day of the base month), «25/09» or «25/09/2026», and an ISO date as is.
 */
export function parseDateArithmetic(text: string, base: string, today: string = base): string | null {
  const raw = text.trim().replace(/\s+/g, "");
  if (!raw) return null;
  const reference = ISO_DATE.test(base) ? base : ISO_DATE.test(today) ? today : null;
  const day = ISO_DATE.test(today) ? today : reference;
  if (ISO_DATE.test(raw)) return shiftIsoDay(raw, 0);
  const word = normalizeWord(raw);
  if (TODAY_WORDS.has(word)) return day;
  if (TOMORROW_WORDS.has(word)) return day ? shiftIsoDay(day, 1) : null;
  if (YESTERDAY_WORDS.has(word)) return day ? shiftIsoDay(day, -1) : null;
  const relative = /^([+\-−–])(\d{1,3})([ds]?)$/i.exec(raw);
  if (relative) {
    if (!reference) return null;
    const sign = relative[1] === "+" ? 1 : -1;
    const amount = Number(relative[2]) * (relative[3].toLowerCase() === "s" ? 7 : 1);
    return shiftIsoDay(reference, sign * amount);
  }
  const dayMonth = /^(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2}|\d{4}))?)?$/.exec(raw);
  if (dayMonth) {
    if (!reference) return null;
    const [, dd, mm, yy] = dayMonth;
    const refMatch = ISO_DATE.exec(reference)!;
    const year = yy ? (yy.length === 2 ? 2000 + Number(yy) : Number(yy)) : Number(refMatch[1]);
    const month = mm ? Number(mm) : Number(refMatch[2]);
    const dayOfMonth = Number(dd);
    if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
    const candidate = new Date(Date.UTC(year, month - 1, dayOfMonth));
    if (candidate.getUTCMonth() !== month - 1) return null;
    return candidate.toISOString().slice(0, 10);
  }
  return null;
}

/** Keys that open or extend the arithmetic buffer on a native date input (pure). */
export function isArithmeticKey(key: string, bufferOpen: boolean): boolean {
  if (key.length !== 1) return false;
  if (/^[+\-−–]$/.test(key)) return true;
  if (/^[a-zA-ZñÑ]$/.test(key)) return true;
  if (/^[0-9/]$/.test(key)) return bufferOpen;
  return false;
}

/** «26/09» preview of the resolved day, in Spanish; «?» when the buffer resolves to nothing. */
export function arithmeticPreview(buffer: string, base: string, today: string): string {
  const iso = parseDateArithmetic(buffer, base, today);
  if (!iso) return "?";
  const match = ISO_DATE.exec(iso)!;
  return `${match[3]}/${match[2]}`;
}

export function CocoaDatePicker({
  value,
  onChange,
  min,
  max,
  size = "regular",
  disabled = false,
  error = false,
  required = false,
  withTime = false,
  arithmetic = false,
  today,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  style
}: CocoaDatePickerProps) {
  const [focused, setFocused] = useState(false);
  const [buffer, setBuffer] = useState("");
  const coarse = useCoarsePointer();
  const generatedId = useId();
  const metrics = SIZE_METRICS[size];
  const chrome = controlChrome({ focused, error });
  const arithmeticOn = arithmetic && !withTime;
  const referenceDay = today ?? localIsoDate();
  const bufferOpen = arithmeticOn && buffer.length > 0;
  const previewId = `${id ?? generatedId}-arith`;

  const inputStyle: CSSProperties = {
    height: coarse ? TAP_TARGET_PX : metrics.height,
    padding: `0 ${metrics.padX}px`,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontFamily: "var(--cocoa-font)",
    fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-control)",
    border: `1px solid ${chrome.borderColor}`,
    borderRadius: "var(--cocoa-radius-md)",
    outline: "none",
    boxShadow: chrome.boxShadow,
    transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    appearance: "none",
    WebkitAppearance: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
    ...style
  };

  function applyBuffer(): boolean {
    if (!bufferOpen) return false;
    const next = parseDateArithmetic(buffer, value, referenceDay);
    setBuffer("");
    if (next && next !== value) onChange(next);
    return next !== null;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!arithmeticOn || disabled) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (bufferOpen && event.key === "Enter") {
      event.preventDefault();
      // The buffer resolves and the change is applied; a wrapping form does
      // not submit on the same keystroke (the operator sees the date first).
      applyBuffer();
      return;
    }
    if (bufferOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setBuffer("");
      return;
    }
    if (bufferOpen && event.key === "Backspace") {
      event.preventDefault();
      setBuffer((current) => current.slice(0, -1));
      return;
    }
    if (isArithmeticKey(event.key, bufferOpen)) {
      event.preventDefault();
      setBuffer((current) => (current + event.key).slice(0, 12));
    }
  }

  const input = (
    <input
      type={withTime ? "datetime-local" : "date"}
      id={id ?? generatedId}
      name={name}
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      aria-describedby={[ariaDescribedBy, bufferOpen ? previewId : undefined].filter(Boolean).join(" ") || undefined}
      aria-invalid={ariaInvalid ?? (error || undefined)}
      aria-required={required || undefined}
      className={["cocoa-date-picker", className].filter(Boolean).join(" ")}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        applyBuffer();
      }}
      onKeyDown={arithmeticOn ? onKeyDown : undefined}
      style={inputStyle}
      data-cocoa="date-picker"
      data-size={size}
      data-with-time={withTime ? "true" : undefined}
      data-arithmetic={arithmeticOn ? "true" : undefined}
    />
  );

  if (!arithmeticOn) return input;
  return (
    <span className="cocoa-row" data-gap="1" data-cocoa="date-picker-arithmetic">
      {input}
      {bufferOpen ? (
        <span id={previewId} className="cocoa-note" role="status" data-cocoa="date-picker-buffer">
          <kbd className="c22-kbd cocoa-kbd">{buffer}</kbd> → {arithmeticPreview(buffer, value, referenceDay)}
        </span>
      ) : null}
    </span>
  );
}

export default CocoaDatePicker;
