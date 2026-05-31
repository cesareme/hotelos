import { useEffect, useState } from "react";
import { ROLE_STARTER_TOUR, taskGuides, tours, toursForRole, WELCOME_TOUR_ID, type TaskGuide } from "./guideContent";
import { ROLES, getActiveRole } from "../../navigation/roles";

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

function GuideRow(props: { guide: TaskGuide; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { guide, open } = props;
  return (
    <div className={`guide-help-item${open ? " open" : ""}`}>
      <button type="button" className="guide-help-item-head" aria-expanded={open} onClick={props.onToggle}>
        <span className="guide-help-item-text">
          <strong>{guide.title}</strong>
          <small>{guide.summary}</small>
        </span>
        <span className="guide-help-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="guide-help-item-body">
          <ol className="guide-steps">
            {guide.steps.map((s, i) => (
              <li key={i}>
                <span className="guide-step-num">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {guide.screen ? (
            <button
              type="button"
              className="primary guide-help-cta"
              onClick={() => {
                navigateTo(guide.screen as string);
                props.onClose();
              }}
            >
              Ir ahora →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The "?" panel: re-launchable tours (one per area) + task guides + shortcuts. */
export function HelpCenter(props: { onClose: () => void; onStartTour: (tourId: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(taskGuides[0]?.id ?? null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const role = getActiveRole();
  const roleLabel = ROLES.find((r) => r.id === role)?.label ?? "";
  const welcomeTour = tours.find((t) => t.id === WELCOME_TOUR_ID) ?? tours[0];
  const recommendedId = role !== "all" ? ROLE_STARTER_TOUR[role] : undefined;
  // Tours relevant to the active role, recommended one first.
  const areaTours = toursForRole(role).sort((a, b) => {
    if (a.id === recommendedId) return -1;
    if (b.id === recommendedId) return 1;
    return 0;
  });

  return (
    <div className="guide-help-root" role="dialog" aria-modal="true" aria-label="Centro de ayuda">
      <div className="guide-help-scrim" onClick={props.onClose} aria-hidden />
      <aside className="guide-help-panel">
        <header className="guide-help-head">
          <div>
            <p className="guide-help-eyebrow">Ayuda</p>
            <h2>Guía de la app</h2>
          </div>
          <button type="button" className="guide-help-close" aria-label="Cerrar ayuda" onClick={props.onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="guide-help-body">
          <button type="button" className="guide-help-tour-cta" onClick={() => props.onStartTour(welcomeTour.id)}>
            <span className="guide-help-tour-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10 9.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="10" cy="6.6" r="0.95" fill="currentColor" />
              </svg>
            </span>
            <span className="guide-help-tour-text">
              <strong>{welcomeTour.title}</strong>
              <small>{welcomeTour.summary}</small>
            </span>
            <span className="guide-help-chevron" aria-hidden>▸</span>
          </button>

          <p className="guide-help-section-title">
            {role === "all" ? "Recorridos por área" : `Recorridos para ${roleLabel}`}
          </p>
          <div className="guide-help-list">
            {areaTours.map((tour) => (
              <button
                key={tour.id}
                type="button"
                className="guide-tour-row"
                onClick={() => props.onStartTour(tour.id)}
              >
                <span className="guide-tour-row-text">
                  <strong>
                    {tour.title}
                    {tour.id === recommendedId ? <span className="guide-tour-badge">Recomendado</span> : tour.badge ? <span className="guide-tour-badge">{tour.badge}</span> : null}
                  </strong>
                  <small>{tour.summary}</small>
                </span>
                <span className="guide-tour-row-meta">
                  <span className="guide-tour-steps">{tour.steps.length} pasos</span>
                  <span className="guide-help-chevron" aria-hidden>▸</span>
                </span>
              </button>
            ))}
          </div>

          <p className="guide-help-section-title">Cómo hacer cada tarea</p>
          <div className="guide-help-list">
            {taskGuides.map((guide) => (
              <GuideRow
                key={guide.id}
                guide={guide}
                open={openId === guide.id}
                onToggle={() => setOpenId((id) => (id === guide.id ? null : guide.id))}
                onClose={props.onClose}
              />
            ))}
          </div>

          <p className="guide-help-section-title">Atajos útiles</p>
          <ul className="guide-help-shortcuts">
            <li><kbd>⌘K</kbd><span>Buscar reservas, huéspedes y ajustes</span></li>
            <li><kbd>Esc</kbd><span>Cerrar ventanas y menús</span></li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
