export type ScreenScaffoldAction = string | { label: string; screen?: string; href?: string };

// Canonical semantic tones. Legacy screens may still pass a free-form string,
// which is rendered verbatim (no invented translation).
export type ScreenScaffoldStatus = "ok" | "warn" | "error" | "info";

export type ScreenScaffoldProps = {
  title: string;
  eyebrow: string;
  summary: string;
  /**
   * Honest "under construction" notice. When set, the scaffold renders a
   * visible banner so nobody mistakes static copy for property data. Pass
   * `true` for the default wording (`PENDING_SCREEN_NOTE`) or a custom string.
   */
  pendingNote?: string | boolean;
  cards: Array<{
    title: string;
    metric?: string;
    // Status is rendered as a Spanish tag; only the 4 canonical tones get a
    // label mapping, anything else is shown as-is (legacy free-form labels).
    status?: ScreenScaffoldStatus | string;
    body: string;
    actions?: ScreenScaffoldAction[];
  }>;
};

/** Default copy for `pendingNote: true`. */
export const PENDING_SCREEN_NOTE = "Pantalla en construcción: los datos mostrados no proceden de tu propiedad.";

const STATUS_LABELS: Record<ScreenScaffoldStatus, string> = {
  ok: "Correcto",
  warn: "Atención",
  error: "Error",
  info: "Info"
};

function isCanonicalStatus(status: string): status is ScreenScaffoldStatus {
  return status in STATUS_LABELS;
}

function statusLabel(status: string): string {
  return isCanonicalStatus(status) ? STATUS_LABELS[status] : status;
}

function actionToLabel(action: ScreenScaffoldAction): string {
  return typeof action === "string" ? action : action.label;
}

function actionToScreen(action: ScreenScaffoldAction): string | undefined {
  return typeof action === "string" ? undefined : action.screen;
}

function actionToHref(action: ScreenScaffoldAction): string | undefined {
  return typeof action === "string" ? undefined : action.href;
}

function handleAction(action: ScreenScaffoldAction) {
  const screen = actionToScreen(action);
  if (screen) {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
    return;
  }
  const href = actionToHref(action);
  if (href) window.open(href, "_blank", "noopener,noreferrer");
}

export function ScreenScaffold(props: ScreenScaffoldProps) {
  const pendingNote = props.pendingNote === true ? PENDING_SCREEN_NOTE : props.pendingNote || null;
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">{props.eyebrow}</p>
          <h2>{props.title}</h2>
        </div>
      </div>
      {pendingNote ? (
        <p
          role="note"
          className="bo-muted"
          style={{
            margin: "0 0 var(--space-4)",
            padding: "var(--space-3) var(--space-4)",
            borderLeft: "3px solid var(--warn-ink)",
            background: "var(--warn-bg)",
            color: "var(--warn-ink)",
            borderRadius: "var(--radius-md)",
            textTransform: "none",
            fontSize: 13
          }}
        >
          {pendingNote}
        </p>
      ) : null}
      <p>{props.summary}</p>
      <div className="bo-grid two">
        {props.cards.map((card) => (
          <article className="bo-card" key={card.title}>
            <div className="bo-card-head">
              <h3>{card.title}</h3>
              {card.status ? <span className={`bo-status ${card.status}`}>{statusLabel(card.status)}</span> : null}
            </div>
            {card.metric ? <div className="bo-metric">{card.metric}</div> : null}
            <p>{card.body}</p>
            {card.actions?.length ? (
              <div className="bo-actions">
                {card.actions.map((action) => {
                  const label = actionToLabel(action);
                  const navigable = Boolean(actionToScreen(action) || actionToHref(action));
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={navigable ? () => handleAction(action) : undefined}
                      disabled={!navigable}
                      title={navigable ? undefined : "Pendiente de implementación"}
                      style={!navigable ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
