import { useEffect, useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Layout, useLang } from "../components/Layout";
import { getSurvey, isApiError, submitSurvey } from "../api/client";
import type { SurveyView } from "../api/client";
import { useGuestSession } from "../auth/GuestSessionContext";
import { isApiConfigured } from "../config/guest-config";
import { t } from "../checkin/wizard";
import type { CopyKey, Lang } from "../checkin/wizard";
import {
  NPS_SCORES,
  SCALE_VALUES,
  SURVEY_STATUS_KEY,
  SURVEY_TEXT_MAX,
  buildSurveySubmission,
  extraQuestions,
  formatDay,
  scoreQuestion,
  surveyErrorKey,
  surveyHasErrors,
  surveyStatus,
  validateSurvey
} from "../stay/stay";
import type { SurveyDraft, SurveyErrors, SurveyQuestion } from "../stay/stay";

// Tanda L7 · L7-08 · encuesta post-estancia (recon §19.7/§19.9, T8 decisión 14,
// contrato L7-04): llega por `?survey=1&token=…` (App.tsx wantsSurvey) o desde
// «Responder la encuesta» de la estancia. Móvil primero: NPS 0-10 como
// radiogroup de botones ≥ 44 px (gp-chip + gp-link: pastilla con anchura y
// altura mínimas de 44 px, flechas y Inicio/Fin para moverse), comentario libre
// (≤ 2000) y las preguntas extra del cuestionario del hotel (texto o escala
// 1-5). Envío a POST /guest-portal/survey → «Gracias» con vuelta a la
// estancia. Estados honestos: ya respondida (con fecha), todavía no (antes de
// la salida), reserva cancelada o sin estancia real, enlace caducado → volver a
// entrar con el código. Corrector L7-REV-01: con la sesión `survey` del enlace
// (`scoped`) el API solo abre esta página; «Entrar en el portal con mi código»
// cierra la sesión y lleva al acceso. Sin API: cuestionario de demostración y
// aviso (demoNoApi).

type ScoreGroupProps = {
  lang: Lang;
  label: string;
  legend: string;
  values: readonly number[];
  value: number | null;
  onChange: (value: number) => void;
  error: string | null;
  required: boolean;
};

/** Radiogroup de puntuación (0-10 o 1-5) con tabulación itinerante y flechas. */
function ScoreGroup({ lang, label, legend, values, value, onChange, error, required }: ScoreGroupProps) {
  const labelId = useId();
  const legendId = useId();
  const errorId = useId();
  const focusedIndex = value !== null && values.includes(value) ? values.indexOf(value) : 0;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % values.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + values.length) % values.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = values.length - 1;
    if (next === null) return;
    event.preventDefault();
    onChange(values[next]);
    const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[next]?.focus();
  }

  return (
    <div className="gp-field">
      <span id={labelId}>{label}</span>
      <small id={legendId}>{legend}</small>
      <div
        className="gp-chips"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={error ? `${legendId} ${errorId}` : legendId}
        aria-required={required}
        aria-invalid={error ? true : undefined}
      >
        {values.map((score, index) => (
          <button
            key={score}
            type="button"
            role="radio"
            aria-checked={value === score}
            aria-label={t(lang, "surveyScoreOption", { score })}
            tabIndex={index === focusedIndex ? 0 : -1}
            className={`gp-chip gp-link${value === score ? " is-active" : ""}`}
            onClick={() => onChange(score)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {score}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {error ? (
          <p id={errorId} className="gp-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const EMPTY_DRAFT: SurveyDraft = { score: null, answers: {} };
const NO_ERRORS: SurveyErrors = { score: null, answers: {} };

type PageState = "loading" | "ready" | "expired" | "error";

export function SurveyPage({ onBack, scoped = false }: { onBack: () => void; /** true con la sesión `survey` del enlace (corrector L7-REV-01): sin «Volver a mi estancia», «Entrar en el portal con mi código» cierra la sesión. */ scoped?: boolean }) {
  const { session, signOut } = useGuestSession();
  const lang = useLang();
  const backLabel = t(lang, scoped ? "surveyToPortal" : "backToStay");
  const [state, setState] = useState<PageState>("loading");
  const [view, setView] = useState<SurveyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SurveyDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<SurveyErrors>(NO_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sentScore, setSentScore] = useState<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const apiConfigured = isApiConfigured();

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState("loading");
    setLoadError(null);
    getSurvey()
      .then((data) => {
        if (cancelled) return;
        setView(data);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setView(null);
        if (isApiError(err, "GUEST_SESSION_INVALID") || (isApiError(err) && err.status === 401)) {
          setState("expired");
          return;
        }
        setLoadError(t(lang, "surveyLoadError"));
        setState("error");
      });
    return () => {
      cancelled = true;
    };
    // `lang` solo afecta al texto del error; no hace falta recargar al cambiar de idioma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, reloadTick]);

  const questions: SurveyQuestion[] = view?.survey.questions ?? [];
  const main = scoreQuestion(questions);
  const extras = extraQuestions(questions);
  const status = view ? surveyStatus(view) : null;

  function setScore(score: number) {
    setDraft((current) => ({ ...current, score }));
    setErrors((current) => ({ ...current, score: null }));
  }

  function setAnswer(key: string, value: string) {
    setDraft((current) => ({ ...current, answers: { ...current.answers, [key]: value } }));
    setErrors((current) => {
      if (!current.answers[key]) return current;
      const { [key]: _omit, ...rest } = current.answers;
      return { ...current, answers: rest };
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || submitting) return;
    const validation = validateSurvey(questions, draft);
    setErrors(validation);
    if (surveyHasErrors(validation)) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await submitSurvey(buildSurveySubmission(questions, draft));
      setSentScore(result.score);
      setView({ ...view, answered: true, answeredAt: result.answeredAt, available: false });
    } catch (err) {
      if (isApiError(err, "GUEST_SESSION_INVALID") || (isApiError(err) && err.status === 401)) {
        setState("expired");
        return;
      }
      if (isApiError(err, "SURVEY_ALREADY_ANSWERED")) {
        // Ya respondida (otra pestaña, o el enlace abierto dos veces): se pinta el estado, no el formulario.
        const answeredAt = typeof err.details?.answeredAt === "string" ? err.details.answeredAt : view.answeredAt;
        setView({ ...view, answered: true, answeredAt, available: false });
        return;
      }
      if (isApiError(err, "SURVEY_NOT_AVAILABLE")) {
        setView({ ...view, available: false });
        return;
      }
      const key: CopyKey = surveyErrorKey(isApiError(err) ? err.code : null);
      setSubmitError(t(lang, key));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Layout
      eyebrow={t(lang, "surveyEyebrow")}
      title={t(lang, "surveyPageTitle")}
      subtitle={t(lang, "surveyPageSubtitle")}
      reservationCode={session?.reservationCode}
      back={{ label: backLabel, onClick: onBack }}
    >
      <div aria-live="polite" aria-busy={state === "loading"}>
        {state === "loading" ? (
          <div className="gp-card gp-skeleton" role="status">
            {t(lang, "surveyLoading")}
          </div>
        ) : null}
      </div>

      {state === "error" ? (
        <div className="gp-card gp-error" role="alert">
          <p className="gp-error-text">{loadError}</p>
          <button type="button" className="gp-button gp-button-ghost" onClick={() => setReloadTick((tick) => tick + 1)}>
            {t(lang, "retry")}
          </button>
        </div>
      ) : null}

      {/* Enlace caducado o sesión revocada (401 GUEST_SESSION_INVALID): se vuelve a la pantalla de acceso; la página de encuesta se reabre tras entrar. */}
      {state === "expired" ? (
        <div className="gp-card gp-error" role="alert">
          <p className="gp-error-text">{t(lang, "surveySessionExpired")}</p>
          <button type="button" className="gp-button gp-button-primary" onClick={signOut}>
            {t(lang, "surveySignIn")}
          </button>
        </div>
      ) : null}

      {!apiConfigured && view ? <p className="gp-hint">{t(lang, "demoNoApi")}</p> : null}

      {/* Enviada en esta visita: gracias + vuelta a la estancia. */}
      {view && sentScore !== null ? (
        <section className="gp-card gp-success" role="status" aria-live="polite">
          <h2>{t(lang, "surveyThanksTitle")}</h2>
          <p>{t(lang, "surveyThanksBody")}</p>
          <p className="gp-meta">{t(lang, "surveyScoreChosen", { score: sentScore })}</p>
          <button type="button" className="gp-button gp-button-primary" onClick={onBack}>
            {backLabel}
          </button>
        </section>
      ) : null}

      {/* Ya respondida antes / todavía no disponible / reserva cancelada: estado honesto, sin formulario. */}
      {view && status && status !== "form" && sentScore === null ? (
        <section className="gp-card gp-survey" aria-label={t(lang, "surveyTitle")}>
          <p className="gp-label">{t(lang, "surveyTitle")}</p>
          <p className="gp-value">{t(lang, SURVEY_STATUS_KEY[status])}</p>
          {status === "answered" && view.answeredAt ? <p className="gp-meta">{t(lang, "surveyAnsweredOn", { date: formatDay(view.answeredAt, lang) })}</p> : null}
          <button type="button" className="gp-button gp-button-ghost" onClick={onBack}>
            {backLabel}
          </button>
        </section>
      ) : null}

      {view && status === "form" && sentScore === null ? (
        <form className="gp-card gp-form" onSubmit={onSubmit} noValidate aria-busy={submitting} aria-label={view.survey.name}>
          <ScoreGroup
            lang={lang}
            label={main?.label ?? t(lang, "surveyPageTitle")}
            legend={t(lang, "surveyNpsLegend")}
            values={NPS_SCORES}
            value={draft.score}
            onChange={setScore}
            error={errors.score ? t(lang, errors.score) : null}
            required
          />
          {extras.map((question) =>
            question.type === "text" ? (
              <label key={question.key} className="gp-field">
                <span>
                  {question.label} {!question.required ? <small>{t(lang, "optional")}</small> : null}
                </span>
                <textarea
                  name={question.key}
                  value={draft.answers[question.key] ?? ""}
                  onChange={(event) => setAnswer(question.key, event.target.value)}
                  maxLength={SURVEY_TEXT_MAX}
                  rows={4}
                  placeholder={question.key === "comment" ? t(lang, "surveyCommentPlaceholder") : undefined}
                  aria-required={question.required}
                  aria-invalid={errors.answers[question.key] ? true : undefined}
                />
                <div aria-live="polite">
                  {errors.answers[question.key] ? (
                    <p className="gp-error" role="alert">
                      {t(lang, errors.answers[question.key], { max: SURVEY_TEXT_MAX })}
                    </p>
                  ) : null}
                </div>
              </label>
            ) : (
              <ScoreGroup
                key={question.key}
                lang={lang}
                label={question.label}
                legend={t(lang, question.type === "nps" ? "surveyNpsLegend" : "surveyScaleLegend")}
                values={question.type === "nps" ? NPS_SCORES : SCALE_VALUES}
                value={draft.answers[question.key] ? Number(draft.answers[question.key]) : null}
                onChange={(value) => setAnswer(question.key, String(value))}
                error={errors.answers[question.key] ? t(lang, errors.answers[question.key]) : null}
                required={question.required}
              />
            )
          )}
          <div aria-live="polite">
            {submitError ? (
              <p className="gp-error" role="alert">
                {submitError}
              </p>
            ) : null}
          </div>
          <button type="submit" className="gp-button gp-button-primary" disabled={submitting}>
            {submitting ? t(lang, "surveySubmitting") : t(lang, "surveySubmit")}
          </button>
        </form>
      ) : null}
    </Layout>
  );
}
