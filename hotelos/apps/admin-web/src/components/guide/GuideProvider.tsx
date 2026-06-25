import { useEffect, useState } from "react";
import { GuidedTour } from "./GuidedTour";
import { HelpCenter } from "./HelpCenter";
import { ROLE_STARTER_TOUR, WELCOME_TOUR_ID, getTourById } from "./guideContent";
import { GUIDE_EVENTS, getGuideState, hasSeenRole, markRoleSeen, setGuideState } from "./guideStore";
import { ROLES, type Role } from "../../navigation/roles";

type WelcomeOffer = { tourId: string; title: string; body: string; role?: Role };

/**
 * Non-blocking corner card that offers a tour. Deferential by design.
 */
function WelcomeCard(props: { offer: WelcomeOffer; onStart: () => void; onDismiss: () => void }) {
  return (
    <div className="guide-welcome" role="dialog" aria-label="Recorrido guiado">
      <div className="guide-welcome-icon" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M11 2.5l2.4 4.86 5.36.78-3.88 3.78.92 5.34L11 14.96 6.2 17.24l.92-5.34L3.24 8.12l5.36-.78L11 2.5Z"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="guide-welcome-text">
        <strong>{props.offer.title}</strong>
        <p>{props.offer.body}</p>
      </div>
      <div className="guide-welcome-actions">
        <button type="button" className="ghost" onClick={props.onDismiss}>Ahora no</button>
        <button type="button" className="primary" onClick={props.onStart}>Empezar recorrido</button>
      </div>
    </div>
  );
}

export function GuideProvider() {
  const [tourId, setTourId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [welcome, setWelcome] = useState<WelcomeOffer | null>(null);
  const [tourRunId, setTourRunId] = useState(0);

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
    // When the user picks a persona for the first time, offer that persona's tour.
    function onRoleChanged(e: Event) {
      const role = (e as CustomEvent<Role>).detail;
      if (!role || role === "all" || hasSeenRole(role)) return;
      const starter = ROLE_STARTER_TOUR[role];
      if (!starter) return;
      const meta = ROLES.find((r) => r.id === role);
      setWelcome({
        role,
        tourId: starter,
        title: `Vista de ${meta?.label ?? role}`,
        body: `Te enseñamos en un minuto lo que verás como ${meta?.label ?? role}.`
      });
    }
    window.addEventListener(GUIDE_EVENTS.openHelp, openHelp);
    window.addEventListener(GUIDE_EVENTS.startTour, startTour);
    window.addEventListener(GUIDE_EVENTS.roleChanged, onRoleChanged);
    return () => {
      window.removeEventListener(GUIDE_EVENTS.openHelp, openHelp);
      window.removeEventListener(GUIDE_EVENTS.startTour, startTour);
      window.removeEventListener(GUIDE_EVENTS.roleChanged, onRoleChanged);
    };
  }, []);

  function dismissWelcome() {
    if (welcome?.role) markRoleSeen(welcome.role);
    else setGuideState({ welcomeDismissed: true });
    setWelcome(null);
  }
  function startWelcome() {
    if (welcome?.role) markRoleSeen(welcome.role);
    else setGuideState({ welcomeDismissed: true });
    startTourRun(welcome?.tourId ?? WELCOME_TOUR_ID);
  }

  const activeTour = tourId ? getTourById(tourId) : null;

  return (
    <>
      {welcome ? <WelcomeCard offer={welcome} onStart={startWelcome} onDismiss={dismissWelcome} /> : null}

      {activeTour ? (
        <GuidedTour
          key={tourRunId}
          steps={activeTour.steps}
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

      {helpOpen ? (
        <HelpCenter onClose={() => setHelpOpen(false)} onStartTour={(id) => startTourRun(id)} />
      ) : null}
    </>
  );
}
