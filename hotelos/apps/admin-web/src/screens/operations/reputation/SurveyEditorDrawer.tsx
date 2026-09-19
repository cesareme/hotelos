// Encuestas (Tanda T8 · lote T8-G · Cocoa 22): «Nueva encuesta» y «Registrar
// respuesta» en un CocoaDrawer.
//
//   · create   → POST /surveys/properties/:propertyId con SurveyCreateSchema
//                (advanced-record-schemas.ts:272-277): nombre, tipo, preguntas
//                (una por línea → { id, text }) y activa;
//   · response → POST /surveys/:id/responses con SurveyResponseCreateSchema
//                (:279-285): puntuación 0-10, reserva/huésped opcionales y un
//                comentario dentro de `answers`; `surveyId` lo inyecta el
//                handler desde el path, así que no viaja en el cuerpo.
// Las encuestas de la propiedad se leen al abrir (GET /surveys/properties/:id?envelope=1).
// Sin estilos en línea, sin colores literales, sin textarea crudo.

import { useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import { CocoaButton, CocoaCallout, CocoaDrawer, CocoaField, CocoaFormRow, CocoaInput, CocoaSelect, CocoaState, CocoaSwitch } from "../../../components/cocoa";
import { createSurvey, createSurveyResponse, listSurveys, reputationErrorMessage, type SurveyItem } from "../../../services/reputationApi";
import { parseSurveyScore, questionsFromLines, surveyTypeLabel, surveyTypeOptions, type SurveyType } from "./reputation-helpers";

export type SurveyEditorMode = "create" | "response";

export type SurveyEditorDrawerProps = {
  open: boolean;
  mode: SurveyEditorMode;
  onClose: () => void;
  /** Se llama tras guardar (la pantalla refresca su panel). */
  onSaved: () => void;
};

const TYPE_OPTIONS = surveyTypeOptions();

function isSurveyType(value: string): value is SurveyType {
  return value === "post_stay" || value === "in_stay" || value === "pre_arrival" || value === "event" || value === "other";
}

export function SurveyEditorDrawer({ open, mode, onClose, onSaved }: SurveyEditorDrawerProps) {
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [surveyType, setSurveyType] = useState<SurveyType>("post_stay");
  const [active, setActive] = useState(true);
  const [questionsText, setQuestionsText] = useState("");
  const [surveys, setSurveys] = useState<SurveyItem[] | null>(null);
  const [surveysError, setSurveysError] = useState<string | null>(null);
  const [surveyId, setSurveyId] = useState("");
  const [scoreText, setScoreText] = useState("");
  const [reservationId, setReservationId] = useState("");
  const [guestId, setGuestId] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    if (mode === "create") {
      setName("");
      setSurveyType("post_stay");
      setActive(true);
      setQuestionsText("");
      return;
    }
    setScoreText("");
    setReservationId("");
    setGuestId("");
    setComment("");
    setSurveys(null);
    setSurveysError(null);
    let cancelled = false;
    listSurveys()
      .then((page) => {
        if (cancelled) return;
        const items = page.items.filter((item) => item.payload.active !== false);
        setSurveys(items);
        setSurveyId(items[0]?.id ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setSurveys([]);
        setSurveysError(reputationErrorMessage(err, "No se pudieron cargar las encuestas."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  const questions = questionsFromLines(questionsText);
  const score = parseSurveyScore(scoreText);
  const scoreError = scoreText.trim() && score === null ? "La puntuación debe estar entre 0 y 10." : null;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "create") {
        if (!name.trim()) {
          setError("El nombre de la encuesta es obligatorio.");
          return;
        }
        await createSurvey({ name: name.trim(), surveyType, questions, active });
        showToast("Encuesta creada.", { variant: "success" });
      } else {
        if (!surveyId) {
          setError("Elige la encuesta a la que pertenece la respuesta.");
          return;
        }
        if (scoreError) {
          setError(scoreError);
          return;
        }
        await createSurveyResponse(surveyId, {
          ...(score !== null ? { score } : {}),
          ...(reservationId.trim() ? { reservationId: reservationId.trim() } : {}),
          ...(guestId.trim() ? { guestId: guestId.trim() } : {}),
          ...(comment.trim() ? { answers: { comment: comment.trim() } } : {})
        });
        showToast("Respuesta registrada.", { variant: "success" });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(reputationErrorMessage(err, mode === "create" ? "No se pudo crear la encuesta." : "No se pudo registrar la respuesta."));
    } finally {
      setBusy(false);
    }
  };

  const surveyOptions = (surveys ?? []).map((item) => ({ value: item.id, label: `${item.payload.name ?? item.id} · ${surveyTypeLabel(item.payload.surveyType)}` }));

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={mode === "create" ? "Nueva encuesta" : "Registrar respuesta"}
      subtitle={mode === "create" ? "Define el cuestionario que responderán los huéspedes." : "Anota una respuesta recibida por otro canal (papel, llamada, correo)."}
      size="md"
      footer={
        <div className="cocoa-row" data-gap="2" data-justify="end">
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={submit} loading={busy} disabled={busy || (mode === "response" && surveys !== null && surveys.length === 0)}>
            {mode === "create" ? "Crear encuesta" : "Registrar respuesta"}
          </CocoaButton>
        </div>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}

        {mode === "create" ? (
          <>
            <CocoaField label="Nombre" required>
              <CocoaInput value={name} onChange={setName} maxLength={200} placeholder="Encuesta tras la estancia" />
            </CocoaField>
            <CocoaFormRow columns={2}>
              <CocoaField label="Tipo">
                <CocoaSelect value={surveyType} onChange={(value) => setSurveyType(isSurveyType(value) ? value : "other")} options={TYPE_OPTIONS} aria-label="Tipo de encuesta" />
              </CocoaField>
              <CocoaField label="Activa" inline help="Una encuesta inactiva no admite respuestas nuevas.">
                <CocoaSwitch checked={active} onChange={setActive} size="small" aria-label="Encuesta activa" />
              </CocoaField>
            </CocoaFormRow>
            <CocoaField label="Preguntas" help={`Una por línea (hasta 100). ${questions.length} ${questions.length === 1 ? "pregunta" : "preguntas"}.`}>
              <CocoaInput multiline rows={6} value={questionsText} onChange={setQuestionsText} placeholder={"¿Cómo valoras la limpieza de la habitación?\n¿Recomendarías el hotel?"} />
            </CocoaField>
          </>
        ) : surveys === null ? (
          <CocoaState kind="loading" inline title="Cargando encuestas…" />
        ) : surveys.length === 0 ? (
          <CocoaState kind="empty" inline title="No hay encuestas activas" message={surveysError ?? "Crea una encuesta antes de registrar respuestas."} />
        ) : (
          <>
            <CocoaField label="Encuesta" required>
              <CocoaSelect value={surveyId} onChange={setSurveyId} options={surveyOptions} aria-label="Encuesta" />
            </CocoaField>
            <CocoaFormRow columns={2}>
              <CocoaField label="Puntuación (0-10)" error={scoreError ?? undefined} help="Promotores 9-10 · pasivos 7-8 · detractores 0-6.">
                <CocoaInput value={scoreText} onChange={setScoreText} inputMode="decimal" placeholder="9" maxLength={4} />
              </CocoaField>
              <CocoaField label="Reserva" help="Opcional.">
                <CocoaInput value={reservationId} onChange={setReservationId} maxLength={100} placeholder="res_…" />
              </CocoaField>
            </CocoaFormRow>
            <CocoaField label="Huésped" help="Opcional; nunca el nombre, solo el identificador.">
              <CocoaInput value={guestId} onChange={setGuestId} maxLength={100} placeholder="gst_…" />
            </CocoaField>
            <CocoaField label="Comentario">
              <CocoaInput multiline rows={4} value={comment} onChange={setComment} maxLength={4000} placeholder="Lo que nos ha contado el huésped" />
            </CocoaField>
          </>
        )}
      </div>
    </CocoaDrawer>
  );
}

export default SurveyEditorDrawer;
