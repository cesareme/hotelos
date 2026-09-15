// CocoaSearchInput — pill search field (COCOA-22.md §3.1 «búsqueda»,
// §4 list toolbar): control bg, separator border, radius full, leading
// magnifier, clear button when there is text, optional debounce, focus ring
// via :focus state on the container.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";

export type CocoaSearchInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
  onClear?: () => void;
  /** Enter with the current (undebounced) text. */
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  /** Accessible name (default «Buscar»). */
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
};

const containerStyle: CSSProperties = { position: "relative", display: "inline-flex", alignItems: "center", width: "100%", minWidth: 0 };

const inputStyleBase: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  padding: "6px 32px 6px 32px",
  font: "inherit",
  color: "inherit",
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const iconStyle: CSSProperties = { position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--cocoa-label-secondary)" };

const clearBtnStyle: CSSProperties = {
  position: "absolute",
  right: 6,
  top: "50%",
  transform: "translateY(-50%)",
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  borderRadius: "var(--cocoa-radius-full)",
  cursor: "pointer",
  color: "var(--cocoa-label-secondary)",
  padding: 0
};

export function CocoaSearchInput(props: CocoaSearchInputProps) {
  const { value, onChange, placeholder, debounceMs, onClear, onSubmit, autoFocus, id, name, "aria-label": ariaLabel = "Buscar", className, style } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focused, setFocused] = useState(false);
  const inputStyle: CSSProperties = {
    ...inputStyleBase,
    borderColor: focused ? "var(--cocoa-accent)" : "var(--cocoa-separator)",
    boxShadow: focused ? "0 0 0 3px var(--cocoa-focus-ring)" : undefined
  };
  // Local mirror so typing feels instant while the parent gets the debounced value.
  const [local, setLocal] = useState<string>(value);
  const lastEmittedRef = useRef<string>(value);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      setLocal(value);
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const emit = (next: string) => {
    lastEmittedRef.current = next;
    onChange(next);
  };

  const handleChange = (next: string) => {
    setLocal(next);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (debounceMs && debounceMs > 0) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        emit(next);
      }, debounceMs);
    } else {
      emit(next);
    }
  };

  const handleClear = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLocal("");
    emit("");
    onClear?.();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && onSubmit) {
      event.preventDefault();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        emit(local);
      }
      onSubmit(local);
    } else if (event.key === "Escape" && local !== "") {
      event.preventDefault();
      handleClear();
    }
  };

  return (
    <div className={["cocoa-search", className].filter(Boolean).join(" ")} style={{ ...containerStyle, ...style }} data-cocoa="search">
      <span style={iconStyle} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        value={local}
        placeholder={placeholder}
        style={inputStyle}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={autoFocus}
      />
      {local !== "" ? (
        <button type="button" onClick={handleClear} aria-label="Limpiar búsqueda" className="cocoa-focus-ring" style={clearBtnStyle}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export default CocoaSearchInput;
