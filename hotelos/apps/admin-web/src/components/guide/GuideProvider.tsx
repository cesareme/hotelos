import { useEffect, useState } from "react";
import { GuidedTour } from "./GuidedTour";
import { HelpCenter } from "./HelpCenter";
import { WELCOME_TOUR_ID, getTourById, tourStepsFor } from "./guideContent";
import { GUIDE_EVENTS, getGuideState, setGuideState } from "./guideStore";
import { useNavAudience } from "../../navigation/useEnabledModules";
import { CocoaButton } from "../cocoa/CocoaButton";

type WelcomeOffer = { tourId: string; title: string; body: string };

/**
 * Non-blocking corner card that offers a tour. Deferential by design.
 * Skin: styles/cocoa-22-guide.css (`c22-guide-welcome*`).
 */
function WelcomeCard(props: { offer: WelcomeOffer; onStart: () => void; onDismiss: () => void }) {
  return (
    <div className="c22-guide-welcome" role="dialog" aria-label="Recorrido guiado">
      <div className="c22-guide-welcome-icon" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M11 2.5l2.4 4.86 5.36.78-3.88 3.78.92 5.34L11 14.96 6.2 17.24l.92-5.34L3.24 8.12l5.36-.78L11 2.5Z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="c22-guide-welcome-text">
        <strong>{props.offer.title}</strong>
        <p>{props.offer.body}</p>
      </div>
      <div className="c22-guide-welcome-actions">
        <CocoaButton variant="plain" tone="neutral" onClick={props.onDismiss}>Ahora no</CocoaButton>
        <CocoaButton onClick={props.onStart}>Empezar recorrido</CocoaButton>
      </div>
    </div>
  );
}

/**
 * Mounts the help center («?») and the guided tours once in the shell. Tours
 * are filtered by the same audience as the menu (`useNavAudience` of
 * navigation/useEnabledModules.ts): the role tokens of the session and, once
 * known, the enabled modules of the active property — so a step never
 * navigates to an item the user cannot open or to a disabled module. The
 * audience re-renders when GET /users/me answers and when ModuleManager
 * enables or disables a module (ENABLED_MODULES_CHANGED_EVENT).
 */
export function GuideProvider() {
  const [tourId, setTourId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeOffer | null>(null);
  const [tourRunId, setTourRunId] = useState(0);
  const { roleTokens, enabledModules } = useNavAudience();

  const startTourRun = (id: string = WELCOME_TOUR_ID) => {
    setHelpOpen(false);
    setWelcome(null);
    setTourId(id);
    setTourRunId((n) => n + 1);
  };

  // First-run welcome: universal "Primeros pasos" if never seen.
  useEffect(() => {
    const s = getGuideState();
    if (!s.tourCompleted && !s.welcomeDismissed) {
      const t = setTimeout(
        () =>
          setWelcome({
            tourId: WELCOME_TOUR_ID,
            title: "Te damos la bienvenida a Anfitorio",
            body: "¿Hacemos un recorrido rápido de un minuto para empezar?"
          }),
        900
      );
      return () => clearTimeout(t);
    }
    return undefined;
  }, []);

  useEffect(() => {
    function openHelp() {
      setHelpOpen(true);
    }
    function startTour(e: Event) {
      startTourRun((e as CustomEvent<string | undefined>).detail ?? WELCOME_TOUR_ID);
    }
    window.addEventListener(GUIDE_EVENTS.openHelp, openHelp);
    window.addEventListener(GUIDE_EVENTS.startTour, startTour);
    return () => {
      window.removeEventListener(GUIDE_EVENTS.openHelp, openHelp);
      window.removeEventListener(GUIDE_EVENTS.startTour, startTour);
    };
  }, []);

  function dismissWelcome() {
    setGuideState({ welcomeDismissed: true });
    setWelcome(null);
  }
  function startWelcome() {
    setGuideState({ welcomeDismissed: true });
    startTourRun(welcome?.tourId ?? WELCOME_TOUR_ID);
  }

  const activeTour = tourId ? getTourById(tourId) : null;
  const activeSteps = activeTour ? tourStepsFor(activeTour, { roleTokens, enabledModules }) : [];

  return (
    <>
      {welcome ? <WelcomeCard offer={welcome} onStart={startWelcome} onDismiss={dismissWelcome} /> : null}

      {activeTour && activeSteps.length > 0 ? (
        <GuidedTour
          key={tourRunId}
          steps={activeSteps}
          tourTitle={activeTour.title}
          onClose={() => {
            setTourId(null);
            setGuideState({ tourCompleted: true, welcomeDismissed: true });
          }}
          onComplete={() => {
            setTourId(null);
            setGuideState({ tourCompleted: true, welcomeDismissed: true });
          }}
        />
      ) : null}

      {helpOpen ? <HelpCenter onClose={() => setHelpOpen(false)} onStartTour={(id) => startTourRun(id)} /> : null}
    </>
  );
}
