// CocoaState + CocoaSkeleton — the honest states of Cocoa 22 (COCOA-22.md
// §3.10; replaces `LoadingBlock/Skeleton/EmptyState/ErrorState` of
// `.bo-*`, the local `DashboardSkeleton`s and the former empty-state kit,
// consolidated into `kind="empty"` in ola 11).
//
//   empty     illustration 200×150 tertiary · title-2 600 · subheadline secondary · actions · min-height 320 · role=status
//   error     danger icon · title in --cocoa-danger-ink · message · «Reintentar» · role=alert
//   loading   skeleton lines · aria-busy · «Cargando…» for AT
//   degraded  warning icon · «Indicador no disponible» · DEGRADED_HINT · role=status
//   inline    the same four as one caption row inside a card (no illustration)
//   dashed    dashed box inside a card with a CTA («Conectar STR / CoStar»)
//
// CocoaSkeleton: the neutral shimmer of `--cocoa-skeleton-shimmer` (control →
// separator → control, 200 % size, `--cocoa-skeleton-duration` 1.2 s — the only
// infinite animation allowed besides the button spinner; keyframes
// `cocoa-shimmer` in styles/cocoa-motion.css; the stylesheet freezes it at
// 60 % opacity under reduced motion), radius 8, heights text 12 · title 18 ·
// row 36 · kpi 110 · chart 200 · card 240 · avatar 32. `CocoaSkeleton.Grid`
// mirrors a CocoaGrid spans array and `CocoaSkeleton.Strip` a KPI strip so
// loading has the same layout as ready (no CLS).
//
// Hooks for the css lot: `c22-state` + data-kind/inline/dashed, parts
// `c22-state__illustration/__title/__message/__actions`; skeletons carry
// `data-cocoa="skeleton"` + data-variant/data-width.
//
// Tanda UX-1 · U4 (docs/design/UX-RECEPCION-FEEL.md §4 «Esqueleto con retardo
// + fundido», §6.1, F28): `useSkeletonDelay` paints a skeleton only after
// `SKELETON_DELAY_MS` (300, NN/g «under 1 s nothing»; 0 = immediate),
// `useFadeInAfterLoading` hands the body `.cocoa-fade-in` (cocoa-motion.css)
// when a loading phase resolves, and `CocoaPageSkeleton` is the generic
// page skeleton (title + rows) of the App's Suspense.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ExclamationCircleIcon, XCircleIcon } from "../cocoa-icons/StatusIcons";
import { EmptyStateBox, EmptyStateConnection, EmptyStateError, EmptyStateSearch, SuccessIllustration } from "../cocoa-illustrations";
import { DEGRADED_HINT } from "../cocoa-extras/DegradedValue";
import { CocoaButton } from "./CocoaButton";
import { CocoaGrid, CocoaSpan, type CocoaSpanCols } from "./CocoaGrid";
import { CocoaKpiStrip } from "./CocoaKpi";

export const CocoaIllustrations = {
  box: EmptyStateBox,
  search: EmptyStateSearch,
  error: EmptyStateError,
  connection: EmptyStateConnection,
  success: SuccessIllustration
} as const;

export type CocoaIllustrationKey = keyof typeof CocoaIllustrations;
export type CocoaStateKind = "empty" | "error" | "loading" | "degraded";

export interface CocoaStateAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
}

export interface CocoaStateProps {
  kind: CocoaStateKind;
  title?: string;
  message?: string;
  illustration?: CocoaIllustrationKey;
  primaryAction?: CocoaStateAction;
  secondaryAction?: CocoaStateAction;
  /** Shorthand for an error state's «Reintentar» (bordered, neutral). */
  onRetry?: () => void;
  /** Inside a card: a caption row without illustration. */
  inline?: boolean;
  /** Dashed CTA box inside a card (no illustration, compact). */
  dashed?: boolean;
  /**
   * ARIA role: `status` (empty/degraded/loading) or `alert` (error) by default;
   * `none` renders NO live region (UX-2 · corrector UX2-REV-07: an inline
   * empty inside a card of a dashboard that already announces through the shell
   * must not add a `role="status"` per card — one live region per page).
   */
  role?: "status" | "alert" | "none";
  className?: string;
  style?: CSSProperties;
}

const DEFAULTS: Record<CocoaStateKind, { title: string; message?: string; illustration: CocoaIllustrationKey; role: "status" | "alert" }> = {
  empty: { title: "Sin datos", illustration: "box", role: "status" },
  error: { title: "Algo salió mal", message: "No se pudo cargar la información.", illustration: "error", role: "alert" },
  loading: { title: "Cargando…", illustration: "box", role: "status" },
  degraded: { title: "Indicador no disponible", message: DEGRADED_HINT, illustration: "connection", role: "status" }
};

/** Resolved copy/role of a state (pure, unit-tested). */
export function resolveStateDefaults(kind: CocoaStateKind, overrides: Pick<CocoaStateProps, "title" | "message" | "illustration" | "role">) {
  const base = DEFAULTS[kind];
  return {
    title: overrides.title ?? base.title,
    message: overrides.message ?? base.message,
    illustration: overrides.illustration ?? base.illustration,
    role: overrides.role ?? base.role
  };
}

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0
};

function StateIcon({ kind }: { kind: CocoaStateKind }) {
  if (kind === "error") return <XCircleIcon size={16} style={{ color: "var(--cocoa-danger)" }} />;
  if (kind === "degraded") return <ExclamationCircleIcon size={16} style={{ color: "var(--cocoa-warning)" }} />;
  return null;
}

export function CocoaState({ kind, title, message, illustration, primaryAction, secondaryAction, onRetry, inline = false, dashed = false, role, className, style }: CocoaStateProps) {
  const resolved = resolveStateDefaults(kind, { title, message, illustration, role });
  const titleColor = kind === "error" ? "var(--cocoa-danger-ink)" : "var(--cocoa-label)";
  const Illustration = CocoaIllustrations[resolved.illustration];
  const illustrationTone = kind === "error" ? "error" : kind === "degraded" ? "warning" : "accent";
  const rootClass = ["c22-state", "cocoa-state", className].filter(Boolean).join(" ");

  if (kind === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        className={rootClass}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          justifyContent: "flex-start",
          textAlign: "left",
          gap: "var(--cocoa-space-3)",
          minHeight: 0,
          padding: inline ? "var(--cocoa-space-2) 0" : "var(--cocoa-space-4) 0",
          ...style
        }}
        data-cocoa="state"
        data-kind="loading"
        data-inline={inline ? "true" : undefined}
      >
        {inline ? <CocoaSkeleton variant="text" lines={2} /> : <CocoaSkeleton variant="title" />}
        {inline ? null : <CocoaSkeleton variant="text" lines={3} />}
        <span style={srOnly}>{resolved.title}</span>
      </div>
    );
  }

  if (inline) {
    return (
      <div
        role={resolved.role === "none" ? undefined : resolved.role}
        className={rootClass}
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          textAlign: "left",
          gap: "var(--cocoa-space-2)",
          minHeight: 0,
          padding: "var(--cocoa-space-2) 0",
          fontFamily: "var(--cocoa-font)",
          ...style
        }}
        data-cocoa="state"
        data-kind={kind}
        data-inline="true"
        title={kind === "degraded" ? DEGRADED_HINT : undefined}
      >
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0, marginTop: 1 }}>
          <StateIcon kind={kind} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
          <span className="c22-state__title" style={{ fontSize: "var(--cocoa-fs-callout)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], color: titleColor }}>
            {resolved.title}
          </span>
          {resolved.message ? (
            <span className="c22-state__message" style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>
              {resolved.message}
            </span>
          ) : null}
        </div>
        {onRetry || primaryAction ? (
          <div className="c22-state__actions" style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", marginLeft: "auto", flexShrink: 0 }}>
            {onRetry ? (
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={onRetry}>
                Reintentar
              </CocoaButton>
            ) : primaryAction ? (
              <CocoaButton variant="plain" tone="accent" size="small" onClick={primaryAction.onClick} loading={primaryAction.loading}>
                {primaryAction.label}
              </CocoaButton>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const hasActions = Boolean(primaryAction || secondaryAction || onRetry);

  return (
    <div
      role={resolved.role === "none" ? undefined : resolved.role}
      className={rootClass}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        width: "100%",
        minHeight: dashed ? 0 : 320,
        paddingInline: dashed ? "var(--cocoa-space-5)" : "clamp(16px, 4vw, 32px)",
        paddingBlock: dashed ? "var(--cocoa-space-5)" : "clamp(24px, 5vw, 40px)",
        boxSizing: "border-box",
        fontFamily: "var(--cocoa-font)",
        border: dashed ? "1px dashed var(--cocoa-separator)" : undefined,
        borderRadius: dashed ? "var(--cocoa-radius-md)" : undefined,
        ...style
      }}
      data-cocoa="state"
      data-kind={kind}
      data-dashed={dashed ? "true" : undefined}
    >
      {dashed ? null : (
        <div className="c22-state__illustration" aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 200, height: 150, maxWidth: "100%", marginBottom: "var(--cocoa-space-4)", color: "var(--cocoa-label-tertiary)" }}>
          <Illustration size={200} tone={illustrationTone} />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--cocoa-space-2)", maxWidth: 480 }}>
        <h2 className="c22-state__title" style={{ margin: 0, color: titleColor, fontSize: dashed ? "var(--cocoa-fs-title-3)" : "var(--cocoa-fs-title-2)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], letterSpacing: "var(--cocoa-tracking-tight)", lineHeight: 1.2 }}>
          {resolved.title}
        </h2>
        {resolved.message ? (
          <p className="c22-state__message" style={{ margin: 0, color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)", lineHeight: 1.4, letterSpacing: "var(--cocoa-tracking-tight)" }}>
            {resolved.message}
          </p>
        ) : null}
      </div>
      {hasActions ? (
        <div className="c22-state__actions" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-4)" }}>
          {primaryAction ? (
            <CocoaButton variant="filled" tone="accent" onClick={primaryAction.onClick} loading={primaryAction.loading}>
              {primaryAction.label}
            </CocoaButton>
          ) : null}
          {onRetry ? (
            <CocoaButton variant={primaryAction ? "bordered" : "filled"} tone={primaryAction ? "neutral" : "accent"} onClick={onRetry}>
              Reintentar
            </CocoaButton>
          ) : null}
          {secondaryAction ? (
            <CocoaButton variant="bordered" tone="neutral" onClick={secondaryAction.onClick} loading={secondaryAction.loading}>
              {secondaryAction.label}
            </CocoaButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- skeleton

export type CocoaSkeletonVariant = "text" | "title" | "kpi" | "card" | "chart" | "row" | "avatar" | "button";

export interface CocoaSkeletonProps {
  variant?: CocoaSkeletonVariant;
  width?: string | number;
  height?: number;
  /** Repeats `text` lines with 100 / 85 / 60 % widths. */
  lines?: number;
  className?: string;
  style?: CSSProperties;
}

export const SKELETON_HEIGHT: Record<CocoaSkeletonVariant, number> = {
  text: 12,
  title: 18,
  row: 36,
  kpi: 110,
  chart: 200,
  card: 240,
  avatar: 32,
  button: 28
};

/** Width of the n-th text line (pure): full, then 85 %, then 60 % for the last. */
export function skeletonLineWidth(index: number, total: number): string {
  if (total > 1 && index === total - 1) return "60%";
  return index % 2 === 1 ? "85%" : "100%";
}

/** `data-width` hint of a text line for the stylesheet (pure). */
export function skeletonLineWidthHint(index: number, total: number): "short" | "medium" | undefined {
  const width = skeletonLineWidth(index, total);
  if (width === "60%") return "short";
  if (width === "85%") return "medium";
  return undefined;
}

const shimmerStyle: CSSProperties = {
  display: "block",
  background: "var(--cocoa-skeleton-shimmer)",
  backgroundSize: "200% 100%",
  animation: "cocoa-shimmer var(--cocoa-skeleton-duration, 1.2s) ease-in-out infinite",
  borderRadius: "var(--cocoa-radius-md)"
};

export function CocoaSkeleton({ variant = "text", width, height, lines, className, style }: CocoaSkeletonProps) {
  const h = height ?? SKELETON_HEIGHT[variant];
  const composed = ["cocoa-skeleton", className].filter(Boolean).join(" ");

  if (variant === "text" && lines && lines > 1) {
    return (
      <div aria-hidden="true" className="c22-skeleton-stack" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", ...style }} data-cocoa="skeleton-stack">
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className={composed}
            style={{ ...shimmerStyle, height: h, width: skeletonLineWidth(index, lines) }}
            data-cocoa="skeleton"
            data-variant="text"
            data-width={skeletonLineWidthHint(index, lines)}
          />
        ))}
      </div>
    );
  }

  const single: CSSProperties = {
    ...shimmerStyle,
    height: h,
    width: width ?? (variant === "title" ? "40%" : variant === "avatar" ? h : variant === "button" ? 96 : "100%"),
    borderRadius:
      variant === "avatar" ? "var(--cocoa-radius-full)" : variant === "card" || variant === "kpi" || variant === "chart" ? "var(--cocoa-radius-lg)" : variant === "row" ? "var(--cocoa-radius-sm)" : "var(--cocoa-radius-md)",
    ...style
  };
  return <span aria-hidden="true" className={composed} style={single} data-cocoa="skeleton" data-variant={variant} />;
}

export interface CocoaSkeletonGridProps {
  /** Rows of spans, mirroring the real grid: `[[8,2,2],[4,4,2,2]]`. */
  rows: ReadonlyArray<ReadonlyArray<CocoaSpanCols>>;
  /** Height of each placeholder card. Default 240. */
  height?: number;
  label?: string;
}

/** Mirror skeleton of a CocoaGrid (same spans → no layout shift when data lands). */
function CocoaSkeletonGrid({ rows, height = SKELETON_HEIGHT.card, label = "Cargando…" }: CocoaSkeletonGridProps) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }} data-cocoa="skeleton-grid">
      {rows.map((row, rowIndex) => (
        <CocoaGrid key={rowIndex}>
          {row.map((cols, index) => (
            <CocoaSpan key={`${rowIndex}-${index}`} cols={cols}>
              <CocoaSkeleton variant="card" height={height} />
            </CocoaSpan>
          ))}
        </CocoaGrid>
      ))}
    </div>
  );
}

export interface CocoaSkeletonStripProps {
  count?: number;
  min?: number;
  label?: string;
}

/** Mirror skeleton of a CocoaKpiStrip. */
function CocoaSkeletonStrip({ count = 5, min = 180, label = "Cargando indicadores…" }: CocoaSkeletonStripProps) {
  return (
    <CocoaKpiStrip min={min} aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <CocoaSkeleton key={index} variant="kpi" />
      ))}
    </CocoaKpiStrip>
  );
}

CocoaSkeleton.Grid = CocoaSkeletonGrid;
CocoaSkeleton.Strip = CocoaSkeletonStrip;

// ----------------------------------------------------------------- skeleton delay + fade (U4)

/** Default delay before a skeleton paints (ms): NN/g — nothing under 300 ms feels instant. */
export const SKELETON_DELAY_MS = 300;

/** Whether the skeleton paints (pure): never before `delayMs` of loading; immediately with 0. */
export function shouldShowSkeleton(input: { loading: boolean; delayMs: number; elapsedMs: number }): boolean {
  if (!input.loading) return false;
  if (input.delayMs <= 0) return true;
  return input.elapsedMs >= input.delayMs;
}

/** True once `loading` has lasted `delayMs` (0 = at once); false as soon as it stops. */
export function useSkeletonDelay(loading: boolean, delayMs: number = SKELETON_DELAY_MS): boolean {
  const [show, setShow] = useState(() => shouldShowSkeleton({ loading, delayMs, elapsedMs: 0 }));
  useEffect(() => {
    if (!loading) {
      setShow(false);
      return undefined;
    }
    if (delayMs <= 0) {
      setShow(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setShow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [loading, delayMs]);
  return show;
}

/** True after a loading phase resolves (false again while loading), so the body can carry `.cocoa-fade-in`. */
export function useFadeInAfterLoading(loading: boolean): boolean {
  const wasLoading = useRef(false);
  const [fade, setFade] = useState(false);
  useEffect(() => {
    if (loading) {
      wasLoading.current = true;
      setFade(false);
    } else if (wasLoading.current) {
      wasLoading.current = false;
      setFade(true);
    }
  }, [loading]);
  return fade;
}

/** Class of the skeleton → content swap (pure): `.cocoa-fade-in` of cocoa-motion.css, nothing otherwise. */
export function fadeInClass(fade: boolean): string | undefined {
  return fade ? "cocoa-fade-in" : undefined;
}

export interface CocoaPageSkeletonProps {
  /** Placeholder rows under the title (default 6). */
  rows?: number;
  /** Delay before it paints (default SKELETON_DELAY_MS; 0 = at once). */
  delayMs?: number;
  label?: string;
}

/** Generic page skeleton (title + text + rows) for the App's Suspense: mirrors a CocoaPage instead of «Cargando pantalla…». */
export function CocoaPageSkeleton({ rows = 6, delayMs = SKELETON_DELAY_MS, label = "Cargando pantalla…" }: CocoaPageSkeletonProps) {
  const show = useSkeletonDelay(true, delayMs);
  return (
    <div role="status" aria-busy="true" className="c22-page-skeleton" data-cocoa="page-skeleton" data-pending={show ? undefined : "true"}>
      {show ? (
        <>
          <CocoaSkeleton variant="title" />
          <CocoaSkeleton variant="text" lines={2} />
          <div className="c22-page-skeleton__rows" data-cocoa="page-skeleton-rows">
            {Array.from({ length: rows }, (_, index) => (
              <CocoaSkeleton key={index} variant="row" />
            ))}
          </div>
        </>
      ) : null}
      <span className="cocoa-sr-only">{label}</span>
    </div>
  );
}

export default CocoaState;
