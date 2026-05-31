/**
 * Sprint 37a — Aurora-inspired RN tokens for the staff mobile MVP.
 *
 * Kept intentionally local (no @hotelos/ui dependency) so the staff app can be
 * built and shipped without coupling to the full design-system. The richer
 * scaffold under src/theme/colors.ts still re-exports tokens from @hotelos/ui
 * for the rest of the app.
 */
export const tokens = {
  color: {
    background: "#f4f5f7",
    surface: "#ffffff",
    surfaceMuted: "#f9fafb",
    border: "#e5e7eb",
    borderStrong: "#d4d4d8",
    textPrimary: "#0f172a",
    textMuted: "#64748b",
    textInverse: "#ffffff",
    accent: "#0d8a5f",
    accentDark: "#076b48",
    danger: "#d04545",
    dangerSoft: "#fde2e2",
    warning: "#b45309",
    warningSoft: "#fef3c7",
    info: "#1d4ed8",
    infoSoft: "#dbeafe",
    success: "#0d8a5f",
    successSoft: "#dcfce7"
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    pill: 999
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32
  },
  font: {
    h1: 24,
    h2: 20,
    h3: 18,
    body: 15,
    small: 13,
    micro: 11
  }
} as const;

export type Tokens = typeof tokens;
