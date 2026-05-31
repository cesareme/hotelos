// CocoaShortcutHint — inline keyboard shortcut hint rendered as a
// sequence of `<kbd>` chips joined by tiny "+" separators.
//
// Accepts a shortcut spec like "Cmd+Shift+K" or "Ctrl+Alt+Enter" and
// renders each key with its conventional Cocoa symbol where applicable:
//
//   Cmd     → ⌘    Shift   → ⇧    Alt    → ⌥    Ctrl   → ⌃
//   Enter   → ↵    Tab     → ⇥    Esc    → ⎋
//   ArrowUp → ↑    ArrowDown → ↓  ArrowLeft → ←  ArrowRight → →
//
// Aliases supported (case-insensitive): "Command", "Meta", "Option",
// "Return", "Escape", "Up", "Down", "Left", "Right".
//
// Visuals follow the rest of the cocoa-* component set:
//   border, padding 1px 5px, border-radius 4px, monospace font,
//   font-size 11px. Two optional knobs:
//
//   - size: "sm" (10px) | "md" (11px, default) | "lg" (12px)
//   - tone: "neutral" (default) | "muted" | "accent"
//
// The wrapper is an inline-flex span so the hint sits cleanly next to
// surrounding copy. Each kbd carries an aria-label with the original
// (un-symbolized) key name so screen readers still hear "Command".

import { Fragment, useMemo, type CSSProperties } from "react";

export type CocoaShortcutHintSize = "sm" | "md" | "lg";
export type CocoaShortcutHintTone = "neutral" | "muted" | "accent";

export interface CocoaShortcutHintProps {
  /** Shortcut string, e.g. "Cmd+Shift+K" or "Ctrl+Enter". */
  keys: string;
  /** Visual size of the kbd chips. Defaults to "md" (11px). */
  size?: CocoaShortcutHintSize;
  /** Color tone for the chip text/border. Defaults to "neutral". */
  tone?: CocoaShortcutHintTone;
}

interface ParsedKey {
  /** Display glyph or label rendered inside the kbd. */
  label: string;
  /** Human-readable name for aria-label (original token). */
  ariaLabel: string;
}

const KEY_MAP: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  opt: "⌥",
  ctrl: "⌃",
  control: "⌃",
  enter: "↵",
  return: "↵",
  tab: "⇥",
  esc: "⎋",
  escape: "⎋",
  up: "↑",
  arrowup: "↑",
  down: "↓",
  arrowdown: "↓",
  left: "←",
  arrowleft: "←",
  right: "→",
  arrowright: "→"
};

function parseKey(token: string): ParsedKey {
  const trimmed = token.trim();
  const key = trimmed.toLowerCase().replace(/\s+/g, "");
  const glyph = KEY_MAP[key];
  if (glyph) {
    return { label: glyph, ariaLabel: trimmed };
  }
  // Single letter keys: uppercase for visual consistency with Cocoa.
  if (trimmed.length === 1) {
    return { label: trimmed.toUpperCase(), ariaLabel: trimmed.toUpperCase() };
  }
  return { label: trimmed, ariaLabel: trimmed };
}

function parseShortcut(spec: string): ParsedKey[] {
  if (!spec) return [];
  return spec
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map(parseKey);
}

const SIZE_FS: Record<CocoaShortcutHintSize, number> = {
  sm: 10,
  md: 11,
  lg: 12
};

interface ToneStyle {
  color: string;
  border: string;
  background: string;
}

const TONE_STYLE: Record<CocoaShortcutHintTone, ToneStyle> = {
  neutral: {
    color: "var(--cocoa-label)",
    border: "1px solid var(--cocoa-separator)",
    background: "var(--cocoa-background-control)"
  },
  muted: {
    color: "var(--cocoa-label-secondary)",
    border: "1px solid var(--cocoa-separator)",
    background: "transparent"
  },
  accent: {
    color: "var(--cocoa-accent)",
    border: "1px solid var(--cocoa-accent)",
    background: "transparent"
  }
};

export function CocoaShortcutHint({
  keys,
  size = "md",
  tone = "neutral"
}: CocoaShortcutHintProps) {
  const parsed = useMemo(() => parseShortcut(keys), [keys]);
  const fontSize = SIZE_FS[size];
  const toneStyle = TONE_STYLE[tone];

  const wrapperStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 2,
      lineHeight: 1,
      verticalAlign: "baseline",
      fontFamily:
        "var(--cocoa-font-mono, var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))"
    }),
    []
  );

  const kbdStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: fontSize + 6,
      padding: "1px 5px",
      borderRadius: 4,
      border: toneStyle.border,
      background: toneStyle.background,
      color: toneStyle.color,
      fontFamily:
        "var(--cocoa-font-mono, var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))",
      fontSize,
      fontWeight: 600,
      lineHeight: 1.2,
      whiteSpace: "nowrap"
    }),
    [fontSize, toneStyle]
  );

  const separatorStyle = useMemo<CSSProperties>(
    () => ({
      color: "var(--cocoa-label-tertiary, var(--cocoa-label-secondary))",
      fontSize: Math.max(fontSize - 2, 8),
      fontFamily:
        "var(--cocoa-font-mono, var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace))",
      userSelect: "none"
    }),
    [fontSize]
  );

  if (parsed.length === 0) return null;

  return (
    <span style={wrapperStyle} aria-label={keys}>
      {parsed.map((key, index) => (
        <Fragment key={`${key.ariaLabel}-${index}`}>
          {index > 0 ? (
            <span aria-hidden="true" style={separatorStyle}>
              +
            </span>
          ) : null}
          <kbd style={kbdStyle} aria-label={key.ariaLabel}>
            {key.label}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

export default CocoaShortcutHint;
