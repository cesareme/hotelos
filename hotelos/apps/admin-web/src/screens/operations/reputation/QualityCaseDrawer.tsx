// Caso de calidad (Tanda T8 · lote T8-G · Cocoa 22): alta, alta desde una
// reseña y transición de estado en un CocoaDrawer.
//
//   · create      → POST /quality/properties/:propertyId/cases con los campos
//                   de QualityCaseCreateSchema (advanced-record-schemas.ts:249-260);
//   · from_review → POST /reputation/reviews/:id/quality-case (T8-D): el caso
//                   nace enlazado a la reseña; QualityCaseFromReviewSchema solo
//                   admite prioridad, responsable, plazo y título;
//   · transition  → PATCH /quality/cases/:id con QualityCaseUpdateSchema
//                   (:262-270): estado según OPERATIONAL_CASE (open → in_progress
//                   | resolved | closed …), prioridad, causa raíz y descripción.
// La máquina de estados se espeja en reputation-helpers.ts solo para ofrecer
// opciones: la API sigue validando (409 INVALID_TRANSITION). Sin estilos en línea.

import { useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDatePicker, CocoaDrawer, CocoaField, CocoaFormRow, CocoaInput, CocoaSelect } from "../../../components/cocoa";
import {
  createQualityCase,
  createQualityCaseFromReview,
  reputationErrorMessage,
  updateQualityCase,
  type QualityCaseCreateBody,
  type QualityCaseUpdateBody
} from "../../../services/reputationApi";
import {
  localDateTimeToIso,
  qualityCasePriorityOptions,
  qualityCaseStatusLabel,
  qualityCaseTransitions,
  suggestedCasePriority,
  type QualityCasePriority
} from "./reputation-helpers";

export type QualityCaseDrawerMode =
  | { kind: "create" }
  | { kind: "from_review"; reviewId: string; title: string; score10: number | null; provider: string }
  | { kind: "transition"; caseId: string; status: string; title: string; priority?: string | null; rootCause?: string | null; description?: string | null };

export type QualityCaseDrawerProps = {
  open: boolean;
  mode: QualityCaseDrawerMode | null;
  onClose: () => void;
  /** Se llama tras guardar (la pantalla refresca su panel). */
  onSaved: () => void;
  /** Id de la persona de la sesión («Asignármelo»). */
  currentUserId?: string | null;
};

const CASE_TYPE_SUGGESTIONS = ["service", "cleanliness", "maintenance", "food", "noise", "billing", "review_negative"] as const;
const PRIORITY_OPTIONS = qualityCasePriorityOptions();

function isPriority(value: string): value is QualityCasePriority {
  return value === "low" || value === "normal" || value === "high" || value === "urgent";
}

export function QualityCaseDrawer({ open, mode, onClose, onSaved, currentUserId }: QualityCaseDrawerProps) {
  const { showToast } = useToast();
  const [title, setTitle] = useState("");
  const [caseType, setCaseType] = useState("service");
  const [priority, setPriority] = useState<QualityCasePriority>("normal");
  const [description, setDescription] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [slaLocal, setSlaLocal] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [reservationId, setReservationId] = useState("");
  const [nextStatus, setNextStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prellenado por modo cada vez que se abre.
  useEffect(() => {
    if (!open || !mode) return;
    setError(null);
    setBusy(false);
    setSlaLocal("");
    setReservationId("");
    setOwnerUserId("");
    setNextStatus("");
    if (mode.kind === "create") {
      setTitle("");
      setCaseType("service");
      setPriority("normal");
      setDescription("");
      setRootCause("");
    } else if (mode.kind === "from_review") {
      setTitle(mode.title);
      setCaseType("review_negative");
      setPriority(suggestedCasePriority(mode.score10));
      setDescription("");
      setRootCause("");
    } else {
      setTitle(mode.title);
      setPriority(mode.priority && isPriority(mode.priority) ? mode.priority : "normal");
      setRootCause(mode.rootCause ?? "");
      setDescription(mode.description ?? "");
    }
  }, [open, mode]);

  const transitions = mode?.kind === "transition" ? qualityCaseTransitions(mode.status) : [];
  const titleError = title.trim() ? null : "El título es obligatorio.";
  const slaIso = slaLocal ? localDateTimeToIso(slaLocal) : null;
  const slaError = slaLocal && !slaIso ? "La fecha del plazo no es válida." : null;

  const submit = async () => {
    if (!mode) return;
    setError(null);
    if (mode.kind !== "transition" && titleError) {
      setError(titleError);
      return;
    }
    if (slaError) {
      setError(slaError);
      return;
    }
    setBusy(true);
    try {
      if (mode.kind === "create") {
        const body: QualityCaseCreateBody = {
          title: title.trim(),
          caseType: caseType.trim() || "service",
          priority,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(ownerUserId.trim() ? { ownerUserId: ownerUserId.trim() } : {}),
          ...(slaIso ? { slaTargetAt: slaIso } : {}),
          ...(rootCause.trim() ? { rootCause: rootCause.trim() } : {}),
          ...(reservationId.trim() ? { reservationId: reservationId.trim() } : {})
        };
        await createQualityCase(body);
        showToast("Caso de calidad creado.", { variant: "success" });
      } else if (mode.kind === "from_review") {
        await createQualityCaseFromReview(mode.reviewId, {
          priority,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(ownerUserId.trim() ? { ownerUserId: ownerUserId.trim() } : {}),
          ...(slaIso ? { slaTargetAt: slaIso } : {})
        });
        showToast("Caso de calidad abierto desde la reseña.", { variant: "success" });
      } else {
        const body: QualityCaseUpdateBody = {
          ...(nextStatus && nextStatus !== mode.status ? { status: nextStatus as QualityCaseUpdateBody["status"] } : {}),
          priority,
          ...(title.trim() && title.trim() !== mode.title ? { title: title.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(rootCause.trim() ? { rootCause: rootCause.trim() } : {}),
          ...(ownerUserId.trim() ? { ownerUserId: ownerUserId.trim() } : {})
        };
        await updateQualityCase(mode.caseId, body);
        showToast(nextStatus ? `Caso ${qualityCaseStatusLabel(nextStatus).toLowerCase()}.` : "Caso actualizado.", { variant: "success" });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo guardar el caso de calidad."));
    } finally {
      setBusy(false);
    }
  };

  const heading = mode?.kind === "from_review" ? "Crear caso desde la reseña" : mode?.kind === "transition" ? "Cambiar el caso" : "Nuevo caso de calidad";
  const subtitle =
    mode?.kind === "from_review"
      ? "El caso queda enlazado a la reseña y aparece en Calidad con el tipo «review_negative»."
      : mode?.kind === "transition"
        ? `Estado actual: ${qualityCaseStatusLabel(mode.status)}.`
        : "Un caso registra una incidencia de calidad con responsable y plazo.";

  return (
    <CocoaDrawer
      open={open}
      onClose={onClose}
      title={heading}
      subtitle={subtitle}
      size="md"
      footer={
        <div className="cocoa-row" data-gap="2" data-justify="end">
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" onClick={submit} loading={busy} disabled={busy || !mode}>
            {mode?.kind === "transition" ? "Guardar cambios" : "Crear caso"}
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

        {mode?.kind === "transition" ? (
          <CocoaField label="Nuevo estado" help={transitions.length === 0 ? "Un caso cerrado no admite más cambios de estado." : undefined}>
            <CocoaSelect
              value={nextStatus}
              onChange={setNextStatus}
              options={[{ value: "", label: `Mantener «${qualityCaseStatusLabel(mode.status)}»` }, ...transitions.map((status) => ({ value: status, label: qualityCaseStatusLabel(status) }))]}
              disabled={transitions.length === 0}
              aria-label="Nuevo estado del caso"
            />
          </CocoaField>
        ) : null}

        <CocoaField label="Título" required error={mode?.kind !== "transition" && title.length > 0 ? (titleError ?? undefined) : undefined}>
          <CocoaInput value={title} onChange={setTitle} maxLength={200} placeholder="Ruido en la planta 3 durante la noche" />
        </CocoaField>

        <CocoaFormRow columns={2}>
          {mode?.kind === "create" ? (
            <CocoaField label="Tipo" help="Categoría corta del caso.">
              <CocoaInput value={caseType} onChange={setCaseType} maxLength={60} suggestions={CASE_TYPE_SUGGESTIONS} />
            </CocoaField>
          ) : null}
          <CocoaField label="Prioridad">
            <CocoaSelect value={priority} onChange={(value) => setPriority(isPriority(value) ? value : "normal")} options={PRIORITY_OPTIONS} aria-label="Prioridad" />
          </CocoaField>
        </CocoaFormRow>

        {mode?.kind !== "from_review" ? (
          <CocoaField label="Descripción">
            <CocoaInput multiline rows={4} value={description} onChange={setDescription} maxLength={4000} placeholder="Qué ha pasado, cuándo y a quién afecta" />
          </CocoaField>
        ) : (
          <CocoaCallout tone="neutral" role="note">
            La descripción del caso se rellena con el extracto de la reseña y el marcador de enlace.
          </CocoaCallout>
        )}

        <CocoaFormRow columns={2}>
          <CocoaField
            label="Responsable"
            help="Id de usuario de la organización; en blanco usa el responsable por defecto del módulo."
            hint={
              currentUserId ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setOwnerUserId(currentUserId)}>
                  Asignármelo
                </CocoaButton>
              ) : undefined
            }
          >
            <CocoaInput value={ownerUserId} onChange={setOwnerUserId} maxLength={100} placeholder="usr_…" />
          </CocoaField>
          <CocoaField label="Plazo (SLA)" error={slaError ?? undefined}>
            <CocoaDatePicker value={slaLocal} onChange={setSlaLocal} withTime aria-label="Plazo del caso" />
          </CocoaField>
        </CocoaFormRow>

        {mode?.kind !== "from_review" ? (
          <CocoaFormRow columns={2}>
            <CocoaField label="Causa raíz">
              <CocoaInput value={rootCause} onChange={setRootCause} maxLength={2000} placeholder="Falta de personal en el turno de noche" />
            </CocoaField>
            {mode?.kind === "create" ? (
              <CocoaField label="Reserva relacionada" help="Opcional.">
                <CocoaInput value={reservationId} onChange={setReservationId} maxLength={100} placeholder="res_…" />
              </CocoaField>
            ) : null}
          </CocoaFormRow>
        ) : null}

        {mode?.kind === "from_review" ? (
          <div className="cocoa-cluster">
            <CocoaBadge tone="neutral" variant="tinted" uppercase={false}>
              {mode.provider}
            </CocoaBadge>
            <span className="cocoa-note">{mode.score10 !== null ? `Nota ${mode.score10.toFixed(1).replace(".", ",")} sobre 10` : "Reseña sin nota"}</span>
          </div>
        ) : null}
      </div>
    </CocoaDrawer>
  );
}

export default QualityCaseDrawer;
