// Reusable UI state primitives for the Back Office design system.
//
// These wrap the `.bo-*` utility classes in styles.css so screens get
// consistent loading / empty / error / skeleton presentation without
// re-implementing markup. They are theme-aware (light/dark) automatically
// because they only use design tokens.
//
// Usage:
//   if (loading) return <LoadingBlock label="Cargando reservas…" />;
//   if (error)   return <ErrorState message={error} onRetry={refetch} />;
//   if (!rows.length) return <EmptyState title="Sin reservas" .../>;

import type { CSSProperties, ReactNode } from "react";

export function Spinner(props: { size?: "sm" | "md" | "lg"; className?: string }) {
  const size = props.size ?? "md";
  const sizeClass = size === "md" ? "" : ` ${size}`;
  return <span className={`bo-spinner${sizeClass}${props.className ? ` ${props.className}` : ""}`} role="status" aria-label="Cargando" />;
}

/** Centered spinner + label. Use as a whole-panel loading state. */
export function LoadingBlock(props: { label?: string }) {
  return (
    <div className="bo-loading">
      <Spinner />
      <span>{props.label ?? "Cargando…"}</span>
    </div>
  );
}

/** A single shimmer bar. Compose several for a skeleton list. */
export function Skeleton(props: {
  variant?: "text" | "title" | "card" | "avatar";
  width?: "short" | "medium" | "full";
  style?: CSSProperties;
}) {
  const variant = props.variant ?? "text";
  const variantClass =
    variant === "text" ? "bo-skeleton-text" :
    variant === "title" ? "bo-skeleton-title" :
    variant === "card" ? "bo-skeleton-card" :
    "bo-skeleton-avatar";
  const widthClass = props.width && props.width !== "full" ? ` ${props.width}` : "";
  return <span className={`bo-skeleton ${variantClass}${widthClass}`} style={props.style} aria-hidden />;
}

/** A few skeleton text lines — a common "content loading" placeholder. */
export function SkeletonLines(props: { lines?: number }) {
  const lines = props.lines ?? 3;
  return (
    <div aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} variant="text" width={i === lines - 1 ? "short" : i === 0 ? "full" : "medium"} />
      ))}
    </div>
  );
}

export function EmptyState(props: {
  title: string;
  message?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="bo-empty">
      {props.icon ? <div className="bo-empty-icon">{props.icon}</div> : null}
      <div className="bo-empty-title">{props.title}</div>
      {props.message ? <div className="bo-empty-text">{props.message}</div> : null}
      {props.actions ? <div className="bo-empty-actions">{props.actions}</div> : null}
    </div>
  );
}

export function ErrorState(props: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="bo-error" role="alert">
      <div className="bo-error-icon" aria-hidden>!</div>
      <div className="bo-error-title">{props.title ?? "Algo salió mal"}</div>
      {props.message ? <div className="bo-error-text">{props.message}</div> : null}
      {props.onRetry ? (
        <div className="bo-error-actions">
          <button type="button" className="primary" onClick={props.onRetry}>
            {props.retryLabel ?? "Reintentar"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
