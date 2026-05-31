import { useEffect, useRef, useState, type CSSProperties } from "react";

export type CocoaSearchInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  debounceMs?: number;
  onClear?: () => void;
  autoFocus?: boolean;
};

const containerStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  width: "100%"
};

const inputStyle: CSSProperties = {
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
  WebkitAppearance: "none"
};

const iconStyle: CSSProperties = {
  position: "absolute",
  left: 10,
  top: "50%",
  transform: "translateY(-50%)",
  pointerEvents: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "currentColor",
  opacity: 0.55
};

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
  color: "currentColor",
  opacity: 0.55,
  padding: 0
};

export function CocoaSearchInput(props: CocoaSearchInputProps) {
  const { value, onChange, placeholder, debounceMs, onClear, autoFocus } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Local mirror of the input text so typing feels instant while we debounce the
  // call up to the parent. Sync from `value` only when it changes externally.
  const [local, setLocal] = useState<string>(value);
  const lastEmittedRef = useRef<string>(value);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
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

  return (
    <div style={containerStyle}>
      <span style={iconStyle} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={local}
        placeholder={placeholder}
        style={inputStyle}
        onChange={(e) => handleChange(e.target.value)}
        autoFocus={autoFocus}
      />
      {local !== "" ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Limpiar búsqueda"
          style={clearBtnStyle}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export default CocoaSearchInput;
