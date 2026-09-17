// Body of the dev-only onboarding screens (onboarding/OnboardingScreens.tsx is
// its only importer): an honest "under construction" callout plus a grid of
// cards with a status badge, a body and navigable actions. The page head
// (eyebrow · h1 · subtitle · next steps) is painted by the CocoaPage that
// hosts it, so this sub-view is exempt from the header rule of the contract.
// Cocoa 22 · ola 11: no legacy `.bo-*` classes, no raw buttons, no inline
// colours.

import { CocoaBadge, CocoaButton, CocoaCallout, CocoaGrid, CocoaSection, CocoaSpan, type CocoaTone } from "../components/cocoa";
import { navigateTo, type ScreenKey } from "../lib/navigate";

export type ScreenScaffoldAction = string | { label: string; screen?: string; href?: string };

// Canonical semantic tones. Legacy screens may still pass a free-form string,
// which is rendered verbatim (no invented translation) on a neutral badge.
export type ScreenScaffoldStatus = "ok" | "warn" | "error" | "info";

export type ScreenScaffoldProps = {
  /**
   * Honest "under construction" notice. When set, the scaffold renders a
   * visible banner so nobody mistakes static copy for property data. Pass
   * `true` for the default wording (`PENDING_SCREEN_NOTE`) or a custom string.
   */
  pendingNote?: string | boolean;
  cards: Array<{
    title: string;
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

const STATUS_TONES: Record<ScreenScaffoldStatus, CocoaTone> = {
  ok: "success",
  warn: "warning",
  error: "danger",
  info: "info"
};

function isCanonicalStatus(status: string): status is ScreenScaffoldStatus {
  return status in STATUS_LABELS;
}

function statusLabel(status: string): string {
  return isCanonicalStatus(status) ? STATUS_LABELS[status] : status;
}

function statusTone(status: string): CocoaTone {
  return isCanonicalStatus(status) ? STATUS_TONES[status] : "neutral";
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
    // Screen keys arrive as plain strings from the card definitions; the registry is the source of truth.
    navigateTo(screen as ScreenKey);
    return;
  }
  const href = actionToHref(action);
  if (href) window.open(href, "_blank", "noopener,noreferrer");
}

export function ScreenScaffold(props: ScreenScaffoldProps) {
  const pendingNote = props.pendingNote === true ? PENDING_SCREEN_NOTE : props.pendingNote || null;
  return (
    <>
      {pendingNote ? (
        <CocoaCallout tone="warning" role="note">
          {pendingNote}
        </CocoaCallout>
      ) : null}
      <CocoaGrid gap={3} align="start">
        {props.cards.map((card) => (
          <CocoaSpan key={card.title} cols={6} min={320}>
            <CocoaSection
              title={card.title}
              action={
                card.status ? (
                  <CocoaBadge tone={statusTone(card.status)} variant="tinted" size="small">
                    {statusLabel(card.status)}
                  </CocoaBadge>
                ) : undefined
              }
            >
              <div className="cocoa-stack" data-gap="3">
                <p className="cocoa-note">{card.body}</p>
                {card.actions?.length ? (
                  <div className="cocoa-row" data-gap="2">
                    {card.actions.map((action) => {
                      const label = actionToLabel(action);
                      const navigable = Boolean(actionToScreen(action) || actionToHref(action));
                      return (
                        <CocoaButton
                          key={label}
                          variant="bordered"
                          tone="neutral"
                          size="small"
                          onClick={navigable ? () => handleAction(action) : undefined}
                          disabled={!navigable}
                          title={navigable ? undefined : "Acción no disponible en esta pantalla"}
                        >
                          {label}
                        </CocoaButton>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </CocoaSection>
          </CocoaSpan>
        ))}
      </CocoaGrid>
    </>
  );
}
