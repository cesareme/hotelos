import { useEffect, useRef, useState, type CSSProperties } from "react";

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  onClear?: () => void;
  ariaLabel?: string;
  autoFocus?: boolean;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Buscar...",
  debounceMs = 250,
  onClear,
  ariaLabel = "Buscar",
  autoFocus = false
}: SearchInputProps) {
  const [internalValue, setInternalValue] = useState(value);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastEmittedRef = useRef(value);

  // Keep internal in sync if parent overwrites externally.
  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setInternalValue(value);
      lastEmittedRef.current = value;
    }
  }, [value]);

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (internalValue === lastEmittedRef.current) return;
    if (debounceMs <= 0) {
      lastEmittedRef.current = internalValue;
      onChange(internalValue);
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      lastEmittedRef.current = internalValue;
      onChange(internalValue);
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [internalValue, debounceMs, onChange]);

  const handleClear = () => {
    setInternalValue("");
    lastEmittedRef.current = "";
    onChange("");
    onClear?.();
    inputRef.current?.focus();
  };

  const wrapperStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    width: "100%",
    minWidth: 200
  };

  const iconStyle: CSSProperties = {
    position: "absolute",
    left: 12,
    pointerEvents: "none",
    color: "var(--ink-muted, #6a6a6a)",
    fontSize: 14,
    display: "inline-flex",
    alignItems: "center"
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "8px 36px 8px 34px",
    fontSize: "var(--fs-sm, 12px)",
    color: "var(--ink, #1a1a1a)",
    background: "var(--surface, #ffffff)",
    border: "1px solid var(--line, #e8e5dd)",
    borderRadius: "var(--radius-md, 12px)",
    outline: "none",
    fontFamily: "inherit",
    transition: "border-color var(--duration, 180ms) var(--ease), box-shadow var(--duration, 180ms) var(--ease)"
  };

  const clearBtnStyle: CSSProperties = {
    position: "absolute",
    right: 8,
    width: 22,
    height: 22,
    padding: 0,
    border: "none",
    background: "var(--surface-sunken, #f1efe9)",
    color: "var(--ink-soft, #4a4a4a)",
    borderRadius: "var(--radius-full, 999px)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    lineHeight: 1
  };

  return (
    <div style={wrapperStyle}>
      <span style={iconStyle} aria-hidden="true">
        {/* Magnifier icon */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M11 11l3 3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={internalValue}
        autoFocus={autoFocus}
        onChange={(e) => setInternalValue(e.target.value)}
        style={inputStyle}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent, #0d8a5f)";
          e.currentTarget.style.boxShadow = "var(--focus, 0 0 0 3px rgba(13,138,95,0.18))";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--line, #e8e5dd)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {internalValue.length > 0 ? (
        <button
          type="button"
          aria-label="Limpiar busqueda"
          onClick={handleClear}
          style={clearBtnStyle}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default SearchInput;
