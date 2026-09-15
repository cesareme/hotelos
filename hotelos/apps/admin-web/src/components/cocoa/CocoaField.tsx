// CocoaField + CocoaFormRow + CocoaFormSection — the form grammar of Cocoa 22
// (COCOA-22.md §3.8; replaces `.fp-field`, `.bo-form-field`, `FormField/
// FormSelect/FormSwitch/FormDateInput/FormTextarea` and `FormPage`).
//
//   CocoaFormSection  bordered card padding 24 · title-3 600 + caption description · sections 16 apart
//   CocoaFormRow      grid of ≤ N columns (min 240 px each) decided by the CONTAINER
//                     width (ResizeObserver, like CocoaGrid), never by the viewport:
//                     a 2-column row inside a 360 px drawer paints 1 column.
//   CocoaField        label 11 px 600 secondary (+ «*» danger when required) · control ·
//                     help callout secondary · error callout --cocoa-danger-ink 600, wired with
//                     id / aria-describedby / aria-invalid into the child control.
//                     `inline` (switches): label left, control right, same DOM.
//
// `CocoaField` clones its single child: Cocoa controls (`CocoaInput`,
// `CocoaSelect`, `CocoaDatePicker`, `CocoaSwitch`) receive `id`, `error`,
// `required`, `aria-describedby`, `aria-invalid`; a raw DOM child only gets
// the DOM attributes. A child that brings its own `id` keeps it and the
// <label htmlFor> follows it (`resolveControlId`), so the association never
// points at a generated id that is not in the DOM.
//
// The field's own layout (column / inline row, spacing, type) is owned by the
// css lot (`.c22-field`, `.c22-field__label-row/__label/__required/__hint/
// __control/__help/__error`, data-inline/data-invalid/data-uppercase); this
// file only emits the hooks and the ARIA wiring.

import { Children, cloneElement, isValidElement, useId, useRef, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CocoaCard } from "./CocoaCard";
import { useElementWidth } from "./cocoa-viewport";

// ----------------------------------------------------------------- CocoaField

export interface CocoaFieldProps {
  label: string;
  /** Id of the control; generated (and injected into the child) when omitted. */
  htmlFor?: string;
  required?: boolean;
  help?: string;
  error?: string;
  /** Right of the label («opcional», a link). */
  hint?: ReactNode;
  /** Switch layout: label left, control right. */
  inline?: boolean;
  /** Uppercase caption label (dense forms). Default false. */
  uppercase?: boolean;
  /** Spans every column of its CocoaFormRow. */
  fullWidth?: boolean;
  children: ReactElement;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

/** Space-separated `aria-describedby` from the ids that exist (pure). */
export function describedBy(ids: { help?: string | null; error?: string | null; external?: string | null }): string | undefined {
  const list = [ids.external, ids.error, ids.help].filter((id): id is string => Boolean(id));
  return list.length > 0 ? list.join(" ") : undefined;
}

/**
 * Id the <label> points at (pure): explicit `htmlFor`, else the child's own
 * `id`, else the generated one (which is then injected into the child).
 */
export function resolveControlId(htmlFor: string | undefined, childId: unknown, generated: string): string {
  if (htmlFor) return htmlFor;
  if (typeof childId === "string" && childId.length > 0) return childId;
  return generated;
}

export function CocoaField({ label, htmlFor, required = false, help, error, hint, inline = false, uppercase = false, fullWidth = false, children, className, style }: CocoaFieldProps) {
  const generatedId = useId();
  const child = Children.only(children);
  const childProps = isValidElement(child) ? (child as ReactElement<Record<string, unknown>>).props : undefined;
  const controlId = resolveControlId(htmlFor, childProps?.id, `cocoa-field-${generatedId}`);
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;

  let control: ReactNode = child;
  if (isValidElement(child)) {
    const element = child as ReactElement<Record<string, unknown>>;
    const existing = element.props;
    const injected: Record<string, unknown> = {
      id: controlId,
      "aria-describedby": describedBy({ help: helpId, error: errorId, external: typeof existing["aria-describedby"] === "string" ? (existing["aria-describedby"] as string) : undefined }),
      "aria-invalid": error ? true : existing["aria-invalid"]
    };
    if (typeof element.type !== "string") {
      // Cocoa controls understand these; DOM elements would get unknown attributes.
      if (error) injected.error = true;
      if (required) injected.required = true;
    } else if (required) {
      injected.required = true;
    }
    control = cloneElement(element, injected);
  }

  return (
    <div
      className={["c22-field", "cocoa-field", className].filter(Boolean).join(" ")}
      style={style}
      data-cocoa="field"
      data-inline={inline ? "true" : undefined}
      data-invalid={error ? "true" : undefined}
      data-uppercase={uppercase ? "true" : undefined}
      data-span={fullWidth ? "full" : undefined}
    >
      <div className="c22-field__label-row">
        <label htmlFor={controlId} className="c22-field__label">
          <span>{label}</span>
          {required ? (
            <span className="c22-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
        {hint ? <span className="c22-field__hint">{hint}</span> : null}
      </div>
      <div className="c22-field__control">{control}</div>
      {help ? (
        <p id={helpId} className="c22-field__help" style={{ margin: 0 }}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="c22-field__error" aria-live="polite" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- CocoaFormRow

export type CocoaFormRowColumns = 1 | 2 | 3 | 4;

export interface CocoaFormRowProps {
  columns?: CocoaFormRowColumns;
  /** Minimum column width in px (default 240); a narrower container drops columns. */
  min?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Column gap of a form row in px (`--cocoa-space-3`, mirrored from the stylesheet's `.c22-form-row`). */
export const FORM_ROW_GAP_PX = 12;

/**
 * Columns a form row paints (pure): as many of the requested `columns` as fit
 * `min` px each (plus the gap) in the measured container width; at least 1.
 * Unknown width (first paint, no ResizeObserver) → the request; the
 * stylesheet's phone media query still forces 1 column below 600 px.
 */
export function formRowColumns(columns: CocoaFormRowColumns, input: { width: number | null; min?: number; gap?: number }): number {
  const width = input.width;
  if (width === null) return columns;
  const min = Math.max(1, input.min ?? 240);
  const gap = input.gap ?? FORM_ROW_GAP_PX;
  const fit = Math.floor((width + gap) / (min + gap));
  return Math.max(1, Math.min(columns, fit));
}

/**
 * The template itself lives in the stylesheet (`.c22-form-row[data-columns]`
 * → `repeat(N, minmax(0, 1fr))`, 1 column under 600 px): this component only
 * measures its own width and emits the effective column count, so a row
 * inside a drawer or a narrow CocoaSpan never overflows its container.
 */
export function CocoaFormRow({ columns = 2, min = 240, children, className, style }: CocoaFormRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(ref);
  const effective = formRowColumns(columns, { width, min, gap: FORM_ROW_GAP_PX });
  const rowStyle: CSSProperties = {
    minWidth: 0,
    ["--c22-field-min" as string]: `${min}px`,
    ...style
  };
  return (
    <div ref={ref} className={["c22-form-row", "cocoa-form-row", className].filter(Boolean).join(" ")} style={rowStyle} data-cocoa="form-row" data-columns={effective}>
      {children}
    </div>
  );
}

// ----------------------------------------------------------------- CocoaFormSection

export interface CocoaFormSectionProps {
  title: string;
  description?: string;
  /** Wrap the children in a CocoaFormRow of N columns. */
  columns?: 1 | 2;
  children: ReactNode;
  /** Right-aligned footer (per-section save, «Restablecer»). */
  actions?: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

export function CocoaFormSection({ title, description, columns, children, actions, id, className, style }: CocoaFormSectionProps) {
  const headingId = useId();
  return (
    <CocoaCard
      variant="bordered"
      padding="lg"
      id={id}
      className={["c22-form-section", "cocoa-form-section", className].filter(Boolean).join(" ")}
      style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)", ...style }}
      role="group"
      aria-labelledby={headingId}
      data-cocoa="form-section"
    >
      <div className="c22-form-section__head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <h3 id={headingId} className="c22-form-section__title" style={{ margin: 0 }}>
            {title}
          </h3>
          {description ? (
            <p className="c22-form-section__description" style={{ margin: 0 }}>
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {columns ? <CocoaFormRow columns={columns}>{children}</CocoaFormRow> : <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-3)" }}>{children}</div>}
      {actions ? (
        <div className="c22-form-section__actions" style={{ paddingTop: "var(--cocoa-space-3)", borderTop: "1px solid var(--cocoa-separator)" }}>
          {actions}
        </div>
      ) : null}
    </CocoaCard>
  );
}

export default CocoaField;
