export type ScreenScaffoldAction = string | { label: string; screen?: string; href?: string };

export type ScreenScaffoldProps = {
  title: string;
  eyebrow: string;
  summary: string;
  cards: Array<{
    title: string;
    metric?: string;
    // Status is rendered as a tag. The first 4 values are the canonical
    // semantic tones; the rest are free-form labels used by legacy screens.
    status?: "ok" | "warn" | "error" | "info" | string;
    body: string;
    actions?: ScreenScaffoldAction[];
  }>;
};

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
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          <p className="bo-muted">{props.eyebrow}</p>
          <h2>{props.title}</h2>
        </div>
        <span className="bo-chip">Back Office</span>
      </div>
      <p>{props.summary}</p>
      <div className="bo-grid two">
        {props.cards.map((card) => (
          <article className="bo-card" key={card.title}>
            <div className="bo-card-head">
              <h3>{card.title}</h3>
              {card.status ? <span className={`bo-status ${card.status}`}>{card.status}</span> : null}
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
