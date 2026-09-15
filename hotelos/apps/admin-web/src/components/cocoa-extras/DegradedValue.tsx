// DegradedValue — front-end counterpart of `apps/api/src/lib/degraded.ts`
// (QC-06, audit 2026-09-14).
//
// Dashboard endpoints ship `degraded: string[]`: the labels of every counter
// whose query failed and fell back to 0 / [] / null. Rendering that fallback
// as a confident green "0" hides a dead query behind a quiet day, so screens
// route every counter that has a `safe()` label through one of these helpers:
//
//   - isDegraded(label, degraded)   predicate; `label` may be a list (any hit)
//   - <DegradedValue>               inline: "—" with tooltip, or children
//   - <DegradedNote>                block: muted hint line, or children
//                                   (tables, charts, lists)
//   - <DegradedCard>                card-level: keeps the grid slot and title
//                                   when the counter lives inside a component
//                                   that only accepts numbers
//   - <DegradedBanner>              header chip "N indicadores no disponibles"
//
// Visuals use Cocoa tokens only (label-tertiary for the attenuated value; the
// banner is a `CocoaBadge tone="warning" variant="tinted"`, i.e. the AA-safe
// warning INK on the warning wash — the hue itself was 1.96:1 at 10 px) so
// light/dark themes pick up automatically.

import type { CSSProperties, ReactNode } from "react";
import { CocoaBadge } from "../cocoa/CocoaBadge";
import { CocoaCard } from "../cocoa/CocoaCard";

/** Tooltip / accessible text for a degraded counter. */
export const DEGRADED_HINT = "No disponible: el cálculo falló; revisa el log del servidor";

export type DegradedLabel = string | readonly string[];
export type DegradedList = readonly string[] | null | undefined;

/** True when any of `label` appears in the payload's `degraded[]`. */
export function isDegraded(label: DegradedLabel, degraded: DegradedList): boolean {
  if (!degraded || degraded.length === 0) return false;
  const labels = typeof label === "string" ? [label] : label;
  return labels.some((l) => degraded.includes(l));
}

const dashStyle: CSSProperties = {
  color: "var(--cocoa-label-tertiary)",
  fontVariantNumeric: "tabular-nums",
  cursor: "help"
};

function Dash({ style }: { style?: CSSProperties }) {
  return (
    <span title={DEGRADED_HINT} aria-label={DEGRADED_HINT} style={{ ...dashStyle, ...style }}>
      —
    </span>
  );
}

export interface DegradedValueProps {
  /** `safe()` label(s) this value depends on. */
  label: DegradedLabel;
  /** `degraded[]` from the API payload (coerced with toArray by the caller). */
  degraded: DegradedList;
  children: ReactNode;
}

/** Inline value slot: renders children unless the label is degraded. */
export function DegradedValue({ label, degraded, children }: DegradedValueProps) {
  if (isDegraded(label, degraded)) return <Dash />;
  return <>{children}</>;
}

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-tertiary)",
  cursor: "help"
};

/** Block slot for lists/tables/charts: renders children unless degraded. */
export function DegradedNote({ label, degraded, children }: DegradedValueProps) {
  if (!isDegraded(label, degraded)) return <>{children}</>;
  return (
    <p title={DEGRADED_HINT} style={noteStyle}>
      — {DEGRADED_HINT}
    </p>
  );
}

const cardStackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  minHeight: 44,
  fontFamily: "var(--cocoa-font)"
};

const cardTitleStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const cardValueStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-large-title)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.05
};

export interface DegradedCardProps extends DegradedValueProps {
  /** Card title shown in the fallback so the grid slot stays recognisable. */
  title: string;
}

/**
 * Card slot: renders children (a tile/widget whose props only accept numbers)
 * unless degraded, in which case a bordered card with the title and "—" keeps
 * the layout intact.
 */
export function DegradedCard({ label, degraded, title, children }: DegradedCardProps) {
  if (!isDegraded(label, degraded)) return <>{children}</>;
  return (
    <CocoaCard variant="bordered" padding="md">
      <div style={cardStackStyle}>
        <span style={cardTitleStyle}>{title}</span>
        <Dash style={cardValueStyle} />
      </div>
    </CocoaCard>
  );
}

/** Copy of the header chip (pure): «1 indicador no disponible» · «N indicadores no disponibles». */
export function degradedBannerLabel(count: number): string {
  return `${count} ${count === 1 ? "indicador no disponible" : "indicadores no disponibles"}`;
}

/** Discreet header chip; renders nothing when `degraded` is empty. Announced once (role=status) when it appears. */
export function DegradedBanner({ degraded }: { degraded: DegradedList }) {
  const labels = degraded ?? [];
  const count = labels.length;
  if (count === 0) return null;
  const title = `${DEGRADED_HINT}\n${labels.join("\n")}`;
  return (
    <CocoaBadge tone="warning" variant="tinted" role="status" title={title} style={{ cursor: "help" }}>
      {degradedBannerLabel(count)}
    </CocoaBadge>
  );
}

export default DegradedValue;
