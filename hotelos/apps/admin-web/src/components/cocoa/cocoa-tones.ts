// Cocoa 22 · semantic tones (COCOA-22.md §2.1 rules a–d, §3.11).
//
// One place that maps a semantic tone to the tokens every primitive consumes.
// The tokens are the `--cocoa-tone-*` quadruple of cocoa-tokens.css (the css
// lot resolves the same quadruple from `data-tone="<tone>"` into
// `--c22-tone*`, so inline and stylesheet always agree):
//   - `toneColor`  → the chromatic hue (bars of 3 px, deltas, dots, strokes,
//                    figures ≥ 24 px). NEVER for text ≤ 13 px in light mode.
//   - `toneInk`    → the AA-safe text colour for small text (`*-text`).
//   - `toneBg`     → the 12–14 % wash for tinted badges, banners, callouts.
//   - `toneBorder` → the 32–34 % outline that goes with `toneBg`.
//
// Only `var(--…)` references live here; no literal colours anywhere.

/** Semantic tone shared by badges, KPIs, stats, charts and states. */
export type CocoaTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "accent"
  | "ai";

export const COCOA_TONES: readonly CocoaTone[] = [
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "accent",
  "ai"
];

/** Chromatic hue of a tone (bars, strokes, dots, large figures). */
export function toneColor(tone: CocoaTone): string {
  return `var(--cocoa-tone-${tone})`;
}

/** AA-safe text colour of a tone for small text (≤ 13 px). */
export function toneInk(tone: CocoaTone): string {
  return `var(--cocoa-tone-${tone}-text)`;
}

/** Soft wash of a tone (tinted badges, banners, callouts). */
export function toneBg(tone: CocoaTone): string {
  return `var(--cocoa-tone-${tone}-bg)`;
}

/** Outline that pairs with `toneBg`. */
export function toneBorder(tone: CocoaTone): string {
  return `var(--cocoa-tone-${tone}-border)`;
}

/** Type guard used when a tone arrives from data (API status → tone). */
export function isCocoaTone(value: unknown): value is CocoaTone {
  return typeof value === "string" && (COCOA_TONES as readonly string[]).includes(value);
}

/** Legacy status names → tone (`error` → `danger`, `ok` → `success`, …). */
export function toneFromStatus(status: string | null | undefined): CocoaTone {
  switch ((status ?? "").toLowerCase()) {
    case "ok":
    case "success":
    case "healthy":
    case "done":
      return "success";
    case "warn":
    case "warning":
    case "degraded":
    case "pending":
      return "warning";
    case "error":
    case "danger":
    case "critical":
    case "failed":
      return "danger";
    case "info":
      return "info";
    case "accent":
    case "primary":
      return "accent";
    case "ai":
      return "ai";
    default:
      return "neutral";
  }
}

/** Delta sentiment (the css lot's `data-sentiment`): good · bad · neutral. */
export type CocoaSentiment = "good" | "bad" | "neutral";

/** Sentiment → tone (good = success, bad = danger). */
export function sentimentTone(sentiment: CocoaSentiment): CocoaTone {
  if (sentiment === "good") return "success";
  if (sentiment === "bad") return "danger";
  return "neutral";
}
