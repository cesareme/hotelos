// Borrador de respuesta a una reseña (Tanda T8 · lote T8-G · Cocoa 22).
//
// CocoaDialog en dos fases: (1) elegir el tono y pedir el borrador a
// POST /reputation/reviews/:id/draft; (2) leer el resultado con su origen
// («IA» si lo redactó el proveedor configurado, «Plantilla» si salió del
// respaldo por reglas) y el aviso honesto «Se ha enviado a revisión humana;
// aprobar no publica»: el borrador entra en la cola HITL review_response y
// la publicación sigue siendo una acción de la persona en ReviewDetailDrawer.
// Sin estilos en línea, sin colores literales, sin textarea crudo (CocoaInput multiline).

import { useEffect, useState } from "react";
import { CocoaBadge, CocoaCallout, CocoaDialog, CocoaField, CocoaInput, CocoaSelect } from "../../../components/cocoa";
import { draftReviewResponse, reputationErrorMessage, type ReviewDraftResult } from "../../../services/reputationApi";
import { DRAFT_REVIEW_NOTICE, draftSourceBadge } from "./reputation-helpers";

export type ReviewDraftDialogProps = {
  open: boolean;
  reviewId: string | null;
  onClose: () => void;
  /** La persona acepta el borrador como texto de partida de su respuesta (no publica). */
  onUseDraft: (result: ReviewDraftResult) => void;
};

type DraftTone = "cordial" | "formal" | "breve";

const TONE_OPTIONS: Array<{ value: DraftTone; label: string }> = [
  { value: "cordial", label: "Cordial" },
  { value: "formal", label: "Formal" },
  { value: "breve", label: "Breve" }
];

export function ReviewDraftDialog({ open, reviewId, onClose, onUseDraft }: ReviewDraftDialogProps) {
  const [tone, setTone] = useState<DraftTone>("cordial");
  const [result, setResult] = useState<ReviewDraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
    }
  }, [open, reviewId]);

  const generate = async () => {
    if (!reviewId) return;
    setError(null);
    try {
      const draft = await draftReviewResponse(reviewId, { tone });
      setResult(draft);
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo generar el borrador."));
    }
  };

  const accept = () => {
    if (!result) return;
    onUseDraft(result);
    onClose();
  };

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title="Borrador de respuesta"
      description={result ? "Revisa el texto antes de usarlo: la respuesta no se publica hasta que la envíes tú." : "El borrador se redacta con el proveedor de IA configurado o, si no lo hay, con una plantilla por reglas."}
      size="md"
      confirmLabel={result ? "Usar borrador" : "Generar borrador"}
      cancelLabel={result ? "Descartar" : "Cancelar"}
      onConfirm={result ? accept : generate}
      confirmDisabled={!reviewId}
    >
      <div className="cocoa-stack" data-gap="3">
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        {result ? (
          <>
            <div className="cocoa-cluster">
              <CocoaBadge tone={result.source === "ai" ? "info" : "neutral"} variant="tinted">
                {draftSourceBadge(result.source)}
              </CocoaBadge>
              {result.model ? <span className="cocoa-note">modelo {result.model}</span> : null}
              {result.language ? <span className="cocoa-note">idioma {result.language}</span> : null}
            </div>
            <CocoaCallout tone="info" role="status" title="Revisión humana">
              {DRAFT_REVIEW_NOTICE}
            </CocoaCallout>
            <CocoaField label="Texto propuesto">
              <CocoaInput multiline rows={7} value={result.draft} onChange={() => undefined} readOnly aria-label="Texto propuesto del borrador" />
            </CocoaField>
          </>
        ) : (
          <CocoaField label="Tono de la respuesta" help="Cordial y formal siguen la voz del hotel; breve limita la respuesta a unas pocas frases.">
            <CocoaSelect value={tone} onChange={(value) => setTone(value as DraftTone)} options={TONE_OPTIONS} aria-label="Tono de la respuesta" />
          </CocoaField>
        )}
      </div>
    </CocoaDialog>
  );
}

export default ReviewDraftDialog;
