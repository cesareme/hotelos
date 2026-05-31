import { useEffect, useRef, useState, type CSSProperties } from "react";

export type CocoaToolbarSearchFieldProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  expandOnFocus?: boolean;
};

const DEFAULT_WIDTH = 240;
const EXPANDED_WIDTH = 360;

const containerStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center"
};

const baseInputStyle: CSSProperties = {
  boxSizing: "border-box",
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-background-toolbar)",
  backdropFilter: "var(--cocoa-material-toolbar-blur)",
  WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
  border: "1px solid var(--cocoa-separator)",
  padding: "6px 32px 6px 32px",
  font: "inherit",
  color: "inherit",
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  transitionProperty: "width",
  transitionDuration: "var(--cocoa-duration-base)",
  transitionTimingFunction: "var(--cocoa-ease-out)"
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

export function CocoaToolbarSearchField(props: CocoaToolbarSearchFieldProps) {
  const { value, onChange, placeholder, expandOnFocus } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [local, setLocal] = useState<string>(value);
  const [focused, setFocused] = useState<boolean>(false);
  const lastEmittedRef = useRef<string>(value);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      setLocal(value);
    }
  }, [value]);

  const emit = (next: string) => {
    lastEmittedRef.current = next;
    onChange(next);
  };

  const handleChange = (next: string) => {
    setLocal(next);
    emit(next);
  };

  const width = expandOnFocus && focused ? EXPANDED_WIDTH : DEFAULT_WIDTH;

  const inputStyle: CSSProperties = {
    ...baseInputStyle,
    width
  };

  const wrapperStyle: CSSProperties = {
    ...containerStyle,
    width
  };

  return (
    <div style={wrapperStyle}>
      <span style={iconStyle} aria-hidden="true">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M11 11L14 14"
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
        value={local}
        placeholder={placeholder}
        style={inputStyle}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  );
}

export default CocoaToolbarSearchField;
