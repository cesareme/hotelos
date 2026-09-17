import { useEffect, useMemo, useState } from "react";
import { HELP_ARTICLES, KEYBOARD_SHORTCUTS, PERSONA_GUIDE_CATEGORY, normalizeSearchText, searchHelpArticles, type HelpArticle } from "../../content/help-articles";
import { personaGuidesFor } from "../../content/persona-guides";
import { ROLE_TOKEN_LABELS, primaryRoleToken } from "../../navigation/role-tokens";
import { useNavAudience } from "../../navigation/useEnabledModules";
import { CocoaButton } from "../cocoa/CocoaButton";
import { CocoaKbd } from "../cocoa/CocoaKbd";
import { CocoaSearchInput } from "../cocoa/CocoaSearchInput";
import { HelpMarkdown } from "./HelpMarkdown";
import { ROLE_STARTER_TOUR, WELCOME_TOUR_ID, taskGuides, tours, toursForAudience, type TaskGuide, type Tour } from "./guideContent";

// Skin: styles/cocoa-22-guide.css (`c22-guide-help-*`, `c22-guide-tour-*`,
// `c22-guide-steps`). Open/closed rows travel as data-open; the search field,
// the action buttons and the keys are Cocoa primitives.

function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

function GuideRow(props: { guide: TaskGuide; open: boolean; onToggle: () => void; onClose: () => void }) {
  const { guide, open } = props;
  return (
    <div className="c22-guide-help-item" data-open={open ? "true" : "false"}>
      <button type="button" className="c22-guide-help-item-head" aria-expanded={open} onClick={props.onToggle}>
        <span className="c22-guide-help-item-text">
          <strong>{guide.title}</strong>
          <small>{guide.summary}</small>
        </span>
        <span className="c22-guide-help-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="c22-guide-help-item-body">
          <ol className="c22-guide-steps">
            {guide.steps.map((s, i) => (
              <li key={i}>
                <span className="c22-guide-step-num">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {guide.screen ? (
            <CocoaButton
              fullWidth
              onClick={() => {
                navigateTo(guide.screen as string);
                props.onClose();
              }}
            >
              Ir ahora →
            </CocoaButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ArticleRow(props: { article: HelpArticle; open: boolean; onToggle: () => void }) {
  const { article, open } = props;
  return (
    <div className="c22-guide-help-item" data-open={open ? "true" : "false"}>
      <button type="button" className="c22-guide-help-item-head" aria-expanded={open} onClick={props.onToggle}>
        <span className="c22-guide-help-item-text">
          <strong>{article.title}</strong>
          <small>{article.category}</small>
        </span>
        <span className="c22-guide-help-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="c22-guide-help-item-body">
          <HelpMarkdown markdown={article.bodyMd} hideTitle />
        </div>
      ) : null}
    </div>
  );
}

function TourRow(props: { tour: Tour; recommended: boolean; onStart: () => void }) {
  const { tour, recommended } = props;
  return (
    <button type="button" className="c22-guide-tour-row" onClick={props.onStart}>
      <span className="c22-guide-tour-row-text">
        <strong>
          {tour.title}
          {recommended ? <span className="c22-guide-tour-badge">Recomendado</span> : tour.badge ? <span className="c22-guide-tour-badge">{tour.badge}</span> : null}
        </strong>
        <small>{tour.summary}</small>
      </span>
      <span className="c22-guide-tour-row-meta">
        <span className="c22-guide-tour-steps">{tour.steps.length} pasos</span>
        <span className="c22-guide-help-chevron" aria-hidden>▸</span>
      </span>
    </button>
  );
}

function matchesQuery(query: string, ...fields: string[]): boolean {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalizeSearchText(fields.join(" "));
  return terms.every((term) => haystack.includes(term));
}

export type HelpCenterProps = {
  onClose: () => void;
  onStartTour: (tourId: string) => void;
};

/**
 * The «?» panel: search across tours, task guides, persona guides and help
 * articles; recommended tour for the user's role; real keyboard shortcuts.
 * Tours are filtered by the audience of the menu (`useNavAudience`: role
 * tokens of the session plus the enabled modules once known).
 */
export function HelpCenter(props: HelpCenterProps) {
  const [query, setQuery] = useState("");
  const [openGuideId, setOpenGuideId] = useState<string | null>(null);
  const [openArticleId, setOpenArticleId] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const { roleTokens, enabledModules } = useNavAudience();
  const audience = useMemo(() => ({ roleTokens, enabledModules }), [roleTokens, enabledModules]);
  const primary = primaryRoleToken(roleTokens);
  const roleLabel = primary ? ROLE_TOKEN_LABELS[primary] : "";
  const welcomeTour = tours.find((t) => t.id === WELCOME_TOUR_ID) ?? tours[0];
  const recommendedId = primary ? ROLE_STARTER_TOUR[primary] : undefined;
  const areaTours = useMemo(() => {
    const list = toursForAudience(audience);
    return list.sort((a, b) => (a.id === recommendedId ? -1 : b.id === recommendedId ? 1 : 0));
  }, [audience, recommendedId]);
  const personaGuides = useMemo(() => personaGuidesFor(roleTokens), [roleTokens]);
  const personaArticleIds = useMemo(() => new Set(personaGuides.map((guide) => `guia-${guide.id}`)), [personaGuides]);
  const myGuides = useMemo(() => HELP_ARTICLES.filter((article) => personaArticleIds.has(article.id)), [personaArticleIds]);
  const otherArticles = useMemo(() => HELP_ARTICLES.filter((article) => article.category !== PERSONA_GUIDE_CATEGORY), []);
  const articleCategories = useMemo(() => Array.from(new Set(otherArticles.map((article) => article.category))), [otherArticles]);

  const searching = query.trim().length > 0;
  const tourHits = useMemo(() => (searching ? areaTours.filter((tour) => matchesQuery(query, tour.title, tour.summary, ...tour.steps.map((step) => step.title))) : []), [searching, query, areaTours]);
  const guideHits = useMemo(() => (searching ? taskGuides.filter((guide) => matchesQuery(query, guide.title, guide.summary, ...guide.steps)) : []), [searching, query]);
  const articleHits = useMemo(() => (searching ? searchHelpArticles(query) : []), [searching, query]);
  const shortcutHits = useMemo(
    () => (searching ? KEYBOARD_SHORTCUTS.flatMap((category) => category.shortcuts.filter((s) => matchesQuery(query, s.keys, s.action, category.category))) : []),
    [searching, query]
  );
  const nothingFound = searching && tourHits.length + guideHits.length + articleHits.length + shortcutHits.length === 0;

  return (
    <div className="c22-guide-help-root" role="dialog" aria-modal="true" aria-label="Centro de ayuda">
      <div className="c22-guide-help-scrim" onClick={props.onClose} aria-hidden />
      <aside className="c22-guide-help-panel">
        <header className="c22-guide-help-head">
          <div>
            <p className="c22-guide-help-eyebrow">Ayuda</p>
            <h2>Centro de ayuda</h2>
          </div>
          <button type="button" className="c22-guide-help-close" aria-label="Cerrar ayuda" onClick={props.onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="c22-guide-help-body">
          <CocoaSearchInput
            value={query}
            onChange={(value) => {
              setQuery(value);
              setOpenArticleId(null);
            }}
            placeholder="Buscar en la ayuda: check-in, factura, VeriFactu…"
            aria-label="Buscar en la ayuda"
            autoFocus
          />

          {searching ? (
            <>
              {nothingFound ? (
                <p className="cocoa-note c22-guide-help-empty">
                  Sin resultados para «{query}». Prueba con otra palabra o abre un recorrido.
                </p>
              ) : null}
              {tourHits.length > 0 ? (
                <>
                  <p className="c22-guide-help-section-title">Recorridos</p>
                  <div className="c22-guide-help-list">
                    {tourHits.map((tour) => (
                      <TourRow key={tour.id} tour={tour} recommended={tour.id === recommendedId} onStart={() => props.onStartTour(tour.id)} />
                    ))}
                  </div>
                </>
              ) : null}
              {guideHits.length > 0 ? (
                <>
                  <p className="c22-guide-help-section-title">Cómo hacer cada tarea</p>
                  <div className="c22-guide-help-list">
                    {guideHits.map((guide) => (
                      <GuideRow key={guide.id} guide={guide} open={openGuideId === guide.id} onToggle={() => setOpenGuideId((id) => (id === guide.id ? null : guide.id))} onClose={props.onClose} />
                    ))}
                  </div>
                </>
              ) : null}
              {articleHits.length > 0 ? (
                <>
                  <p className="c22-guide-help-section-title">Artículos</p>
                  <div className="c22-guide-help-list">
                    {articleHits.map(({ article }) => (
                      <ArticleRow key={article.id} article={article} open={openArticleId === article.id} onToggle={() => setOpenArticleId((id) => (id === article.id ? null : article.id))} />
                    ))}
                  </div>
                </>
              ) : null}
              {shortcutHits.length > 0 ? (
                <>
                  <p className="c22-guide-help-section-title">Atajos</p>
                  <ul className="c22-guide-help-shortcuts">
                    {shortcutHits.map((shortcut) => (
                      <li key={`${shortcut.keys}-${shortcut.action}`}>
                        <CocoaKbd announce>{shortcut.keys}</CocoaKbd>
                        <span>{shortcut.action}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="c22-guide-help-tour-cta" onClick={() => props.onStartTour(welcomeTour.id)}>
                <span className="c22-guide-help-tour-icon" aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M10 9.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <circle cx="10" cy="6.6" r="0.95" fill="currentColor" />
                  </svg>
                </span>
                <span className="c22-guide-help-tour-text">
                  <strong>{welcomeTour.title}</strong>
                  <small>{welcomeTour.summary}</small>
                </span>
                <span className="c22-guide-help-chevron" aria-hidden>▸</span>
              </button>

              <p className="c22-guide-help-section-title">{roleLabel ? `Recorridos para ${roleLabel}` : "Recorridos por área"}</p>
              <div className="c22-guide-help-list">
                {areaTours.map((tour) => (
                  <TourRow key={tour.id} tour={tour} recommended={tour.id === recommendedId} onStart={() => props.onStartTour(tour.id)} />
                ))}
              </div>

              <p className="c22-guide-help-section-title">Cómo hacer cada tarea</p>
              <div className="c22-guide-help-list">
                {taskGuides.map((guide) => (
                  <GuideRow key={guide.id} guide={guide} open={openGuideId === guide.id} onToggle={() => setOpenGuideId((id) => (id === guide.id ? null : guide.id))} onClose={props.onClose} />
                ))}
              </div>

              {myGuides.length > 0 ? (
                <>
                  <p className="c22-guide-help-section-title">{roleLabel ? "Guía de tu puesto" : "Guías por puesto"}</p>
                  <div className="c22-guide-help-list">
                    {myGuides.map((article) => (
                      <ArticleRow key={article.id} article={article} open={openArticleId === article.id} onToggle={() => setOpenArticleId((id) => (id === article.id ? null : article.id))} />
                    ))}
                  </div>
                </>
              ) : null}

              {articleCategories.map((category) => (
                <div key={category}>
                  <p className="c22-guide-help-section-title">{category}</p>
                  <div className="c22-guide-help-list">
                    {otherArticles
                      .filter((article) => article.category === category)
                      .map((article) => (
                        <ArticleRow key={article.id} article={article} open={openArticleId === article.id} onToggle={() => setOpenArticleId((id) => (id === article.id ? null : article.id))} />
                      ))}
                  </div>
                </div>
              ))}

              <p className="c22-guide-help-section-title">Atajos de teclado</p>
              <ul className="c22-guide-help-shortcuts">
                {KEYBOARD_SHORTCUTS[0].shortcuts.map((shortcut) => (
                  <li key={shortcut.keys}>
                    <CocoaKbd announce>{shortcut.keys}</CocoaKbd>
                    <span>{shortcut.action}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
