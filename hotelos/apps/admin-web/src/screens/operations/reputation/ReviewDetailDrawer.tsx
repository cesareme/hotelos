// Detalle de una reseña (Tanda T8 · lote T8-G · Cocoa 22): el cajón desde el
// que una persona trabaja la bandeja. GET /reputation/reviews/:id al abrir y
// después:
//   · texto de la reseña (o «Contenido purgado por retención»), nota sobre 10
//     y nota original del portal, categorías con el badge del origen del
//     análisis (IA · Diccionario · Subpuntuaciones del portal);
//   · estado, plazo (SLA: «Nuevo plazo» + «Aplicar plazo») y asignación →
//     PATCH /reputation/reviews/:id (ReviewPatchSchema: status / assignedUserId /
//     slaTargetAt; nunca responseBody);
//   · «Crear caso» → QualityCaseDrawer prellenado (POST …/quality-case);
//   · «Borrador» → ReviewDraftDialog (POST …/draft): badge «IA»/«Plantilla» y
//     aviso «Se ha enviado a revisión humana; aprobar no publica»; si el ítem
//     HITL del borrador está `rejected` (detail.draftReviewStatus) el texto no
//     se precarga y publicarlo tal cual queda bloqueado con aviso (HP-01);
//   · «Responder»: con `replyCapability` la API publica en el portal a través
//     de POST /reputation/reviews/:id/respond {responseBody}; sin ella la
//     persona copia el texto, abre el portal («Copiar y abrir portal») y
//     confirma «Ya la he publicado en el portal» → POST …/respond + UN PATCH
//     {status:'responded', responseSource} (publicationPatches; la API ya lee
//     una fila con respondedAt como `responded` y reconcilia la meta).
// Área de texto = CocoaInput multiline rows 6 (nunca un textarea crudo);
// sin estilos en línea ni colores literales.

import { useCallback, useEffect, useState } from "react";
import { useToast } from "../../../components/Toast";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaStat
} from "../../../components/cocoa";
import { dateTime } from "../../../lib/format";
import { navigateTo } from "../../../lib/navigate";
import { REPUTATION_ERROR_MESSAGES_ES, categoryLabel, formatScore10, providerLabel, scoreTone, sentimentLabel, sentimentTone, statusLabel } from "../../../services/reputation-contracts";
import { getReviewDetail, patchReview, reputationErrorMessage, respondReview, type ReviewDetail, type ReviewDraftResult } from "../../../services/reputationApi";
import { QualityCaseDrawer, type QualityCaseDrawerMode } from "./QualityCaseDrawer";
import { ReviewDraftDialog } from "./ReviewDraftDialog";
import {
  DRAFT_REVIEW_NOTICE,
  MANUAL_PUBLICATION_CONFIRM_LABEL,
  PURGED_BODY_COPY,
  analysisBadge,
  analysisTitle,
  buildPortalActionLabel,
  draftSourceBadge,
  publicationPatches,
  responseTextError,
  reviewStatusTone,
  reviewTransitions,
  scoreCaption,
  slaCopy,
  slaTone
} from "./reputation-helpers";

export type ReviewDetailDrawerProps = {
  open: boolean;
  reviewId: string | null;
  onClose: () => void;
  /** Tras cualquier escritura (la bandeja y el panel se refrescan). */
  onChanged: () => void;
  /** `reputation.respond` en la propiedad activa. */
  canRespond: boolean;
  /** `quality_cases.manage` en la propiedad activa. */
  canManageCases: boolean;
  /** Id de la persona de la sesión («Asignar a mí»). */
  currentUserId: string | null;
};

function toneOf(value: ReturnType<typeof sentimentTone>): "success" | "warning" | "danger" | "neutral" {
  return value;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* sin portapapeles: la persona copia a mano */
  }
  return false;
}

export function ReviewDetailDrawer({ open, reviewId, onClose, onChanged, canRespond, canManageCases, currentUserId }: ReviewDetailDrawerProps) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [draftInfo, setDraftInfo] = useState<{ source: "ai" | "rules"; model?: string } | null>(null);
  const [nextStatus, setNextStatus] = useState("");
  const [slaInput, setSlaInput] = useState("");
  const [busy, setBusy] = useState<"patch" | "respond" | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [caseMode, setCaseMode] = useState<QualityCaseDrawerMode | null>(null);
  const [confirmManual, setConfirmManual] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!reviewId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getReviewDetail(reviewId);
      setDetail(next);
      // Un borrador rechazado en revisión humana no se precarga: la persona escribe otro texto.
      setResponseText((current) => current || (next.draftReviewStatus === "rejected" ? "" : next.draft?.body || ""));
      setDraftInfo(next.draft ? { source: next.draft.source, ...(next.draft.model ? { model: next.draft.model } : {}) } : null);
      setNextStatus("");
      setSlaInput("");
    } catch (err) {
      setLoadError(reputationErrorMessage(err, "No se pudo cargar la reseña."));
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setError(null);
    setResponseText("");
    setDraftInfo(null);
    setCopied(false);
    setConfirmManual(false);
    void load();
  }, [open, load]);

  const refreshAll = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const applyPatch = async (body: Parameters<typeof patchReview>[1], success: string) => {
    if (!detail) return;
    setError(null);
    setBusy("patch");
    try {
      const next = await patchReview(detail.id, body);
      setDetail(next);
      setNextStatus("");
      showToast(success, { variant: "success" });
      onChanged();
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo actualizar la reseña."));
    } finally {
      setBusy(null);
    }
  };

  const publish = async (source: "api" | "manual") => {
    if (!detail) return;
    const textError = responseTextError(responseText);
    if (textError) {
      setError(textError);
      return;
    }
    setError(null);
    setBusy("respond");
    try {
      await respondReview(detail.id, responseText.trim());
      for (const patch of publicationPatches(detail.status, source, currentUserId)) {
        await patchReview(detail.id, patch);
      }
      showToast(source === "api" ? "Respuesta enviada al portal." : "Respuesta registrada como publicada manualmente.", { variant: "success" });
      setConfirmManual(false);
      await refreshAll();
    } catch (err) {
      setError(reputationErrorMessage(err, "No se pudo registrar la respuesta."));
    } finally {
      setBusy(null);
    }
  };

  const copyAndOpen = async () => {
    if (!detail) return;
    const textError = responseTextError(responseText);
    if (textError) {
      setError(textError);
      return;
    }
    setError(null);
    const ok = await copyToClipboard(responseText.trim());
    setCopied(ok);
    showToast(ok ? "Respuesta copiada al portapapeles." : "No se pudo copiar: selecciona el texto y cópialo a mano.", { variant: ok ? "success" : "warning" });
    if (detail.portalUrl && typeof window !== "undefined") window.open(detail.portalUrl, "_blank", "noopener,noreferrer");
  };

  const useDraft = (result: ReviewDraftResult) => {
    setResponseText(result.draft);
    setDraftInfo({ source: result.source, ...(result.model ? { model: result.model } : {}) });
    onChanged();
    void load();
  };

  const responded = Boolean(detail?.respondedAt || detail?.responseBody);
  const closed = detail ? detail.status === "closed" || detail.status === "ignored" : false;
  // El texto actual es el borrador cuyo ítem HITL fue rechazado: no se publica tal cual (la API también lo rechaza con 409).
  const draftRejected = Boolean(detail && detail.draftReviewStatus === "rejected" && detail.draft?.body && responseText.trim().toLowerCase() === detail.draft.body.trim().toLowerCase());
  const slaIso = slaInput && Number.isFinite(Date.parse(slaInput)) ? new Date(slaInput).toISOString() : null;
  const transitions = detail ? reviewTransitions(detail.status) : [];
  const assignedToMe = Boolean(detail && currentUserId && detail.assignedUserId === currentUserId);
  const primaryLabel = detail ? buildPortalActionLabel(detail) : "Responder";

  return (
    <>
      <CocoaDrawer
        open={open}
        onClose={onClose}
        title={detail?.title?.trim() || "Reseña"}
        subtitle={detail ? `${providerLabel(detail.provider)} · ${detail.receivedAt ? dateTime(detail.receivedAt) : dateTime(detail.createdAt)}${detail.isDemo ? " · datos ficticios" : ""}` : undefined}
        size="lg"
        focusKey={detail?.id ?? "none"}
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy !== null}>
              Cerrar
            </CocoaButton>
          </div>
        }
      >
        {loading && !detail ? (
          <CocoaState kind="loading" inline title="Cargando la reseña…" />
        ) : loadError && !detail ? (
          <CocoaState kind="error" inline title="No se pudo cargar la reseña" message={loadError} onRetry={load} />
        ) : detail ? (
          <div className="cocoa-stack" data-gap="4">
            {error ? (
              <CocoaCallout tone="danger" role="alert">
                {error}
              </CocoaCallout>
            ) : null}

            <CocoaSection title="Reseña" meta={scoreCaption(detail)}>
              <div className="cocoa-stack" data-gap="3">
                <div className="cocoa-cluster">
                  <CocoaBadge tone={detail.score10 === null ? "neutral" : scoreTone(detail.score10)} uppercase={false}>
                    {formatScore10(detail.score10)} / 10
                  </CocoaBadge>
                  <CocoaBadge tone={toneOf(sentimentTone(detail.sentiment))} variant="tinted" size="small">
                    {sentimentLabel(detail.sentiment)}
                  </CocoaBadge>
                  {detail.language ? (
                    <CocoaBadge tone="neutral" variant="outline" size="small" uppercase={false}>
                      {detail.language}
                    </CocoaBadge>
                  ) : null}
                  {detail.authorDisplayName ? <span className="cocoa-note">{detail.authorDisplayName}{detail.authorCountry ? ` · ${detail.authorCountry}` : ""}</span> : null}
                </div>
                {detail.bodyPurged || (!detail.body && !detail.title) ? (
                  <CocoaCallout tone="neutral" role="note">
                    {detail.bodyPurged ? PURGED_BODY_COPY : "La reseña no trae texto: el portal solo publicó la nota."}
                  </CocoaCallout>
                ) : (
                  <p className="cocoa-note">{detail.body}</p>
                )}
                {!detail.bodyComplete && !detail.bodyPurged ? <span className="cocoa-note">El portal solo entrega un extracto; el texto completo está en el portal.</span> : null}
                {detail.portalUrl ? (
                  <span className="cocoa-cluster">
                    <CocoaButton variant="plain" tone="accent" size="small" onClick={() => window.open(detail.portalUrl ?? "", "_blank", "noopener,noreferrer")}>
                      Ver en el portal
                    </CocoaButton>
                  </span>
                ) : null}
              </div>
            </CocoaSection>

            <CocoaSection
              title="Análisis"
              meta={
                <CocoaBadge tone={detail.analysisSource === "llm" ? "info" : "neutral"} variant="tinted" size="small" uppercase={false} title={analysisTitle(detail.analysisSource)}>
                  {analysisBadge(detail.analysisSource)}
                </CocoaBadge>
              }
            >
              {detail.categories.length === 0 ? (
                <CocoaState kind="empty" inline title={detail.analysisStatus === "pending" ? "Análisis pendiente." : "Sin categorías detectadas."} />
              ) : (
                <div className="cocoa-stack" data-gap="2">
                  <div className="cocoa-cluster">
                    {detail.categories.map((mention) => (
                      <CocoaBadge key={mention.category} tone={mention.sentiment > 0 ? "success" : mention.sentiment < 0 ? "danger" : "neutral"} variant="dot" size="small" uppercase={false} title={mention.snippet ?? undefined}>
                        {categoryLabel(mention.category)}
                      </CocoaBadge>
                    ))}
                  </div>
                  {detail.summary ? <span className="cocoa-note">{detail.summary}</span> : null}
                </div>
              )}
            </CocoaSection>

            <CocoaSection title="Estado y plazo">
              <div className="cocoa-stack" data-gap="3">
                <div className="cocoa-row" data-gap="4" data-wrap="true">
                  <CocoaStat label="Estado" value={<CocoaBadge tone={reviewStatusTone(detail.status) === "info" ? "info" : reviewStatusTone(detail.status)} variant="dot">{statusLabel(detail.status)}</CocoaBadge>} tabular={false} />
                  <CocoaStat label="Plazo" value={<CocoaBadge tone={slaTone(detail)} variant="tinted" uppercase={false}>{slaCopy(detail)}</CocoaBadge>} tabular={false} hint={detail.slaTargetAt ? `Límite ${dateTime(detail.slaTargetAt)}` : undefined} />
                  <CocoaStat label="Responsable" value={detail.assignedUserId ? (assignedToMe ? "Tú" : detail.assignedUserId) : "Sin asignar"} tabular={false} />
                  {detail.qualityCaseId ? <CocoaStat label="Caso de calidad" value={<CocoaBadge tone="warning" variant="tinted" uppercase={false}>Abierto</CocoaBadge>} tabular={false} /> : null}
                </div>
                {canRespond && !closed ? (
                  <div className="cocoa-row" data-gap="2" data-wrap="true" data-align="end">
                    {transitions.length > 0 ? (
                      <CocoaField label="Cambiar estado">
                        <CocoaSelect
                          value={nextStatus}
                          onChange={setNextStatus}
                          options={[{ value: "", label: "Elige un estado" }, ...transitions.filter((status) => status !== "responded").map((status) => ({ value: status, label: statusLabel(status) }))]}
                          size="small"
                          inline
                          aria-label="Cambiar estado"
                        />
                      </CocoaField>
                    ) : null}
                    {nextStatus ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => applyPatch({ status: nextStatus as ReviewDetail["status"] }, `Reseña ${statusLabel(nextStatus).toLowerCase()}.`)} loading={busy === "patch"} disabled={busy !== null}>
                        Aplicar
                      </CocoaButton>
                    ) : null}
                    {!responded ? (
                      <CocoaField label="Nuevo plazo">
                        <CocoaInput type="datetime-local" value={slaInput} onChange={setSlaInput} size="small" />
                      </CocoaField>
                    ) : null}
                    {slaIso ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => applyPatch({ slaTargetAt: slaIso }, "Plazo de respuesta actualizado.")} loading={busy === "patch"} disabled={busy !== null}>
                        Aplicar plazo
                      </CocoaButton>
                    ) : null}
                    {currentUserId && !assignedToMe && !responded ? (
                      <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => applyPatch({ assignedUserId: currentUserId }, "Reseña asignada a ti.")} loading={busy === "patch"} disabled={busy !== null}>
                        Asignar a mí
                      </CocoaButton>
                    ) : null}
                    {detail.assignedUserId && !responded ? (
                      <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => applyPatch({ assignedUserId: null }, "Asignación retirada.")} disabled={busy !== null}>
                        Quitar asignación
                      </CocoaButton>
                    ) : null}
                    {canManageCases && !detail.qualityCaseId ? (
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setCaseMode({ kind: "from_review", reviewId: detail.id, title: `Reseña negativa · ${providerLabel(detail.provider)}`, score10: detail.score10, provider: providerLabel(detail.provider) })} disabled={busy !== null}>
                        Crear caso
                      </CocoaButton>
                    ) : null}
                    {detail.qualityCaseId ? (
                      <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("QualityDashboard")}>
                        Ver en Calidad
                      </CocoaButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CocoaSection>

            <CocoaSection
              title="Respuesta"
              meta={
                responded ? (
                  <CocoaBadge tone="success" variant="dot" size="small" uppercase={false}>
                    {detail.response?.source === "api" ? "Publicada por API" : "Publicada en el portal"}
                  </CocoaBadge>
                ) : draftInfo ? (
                  <CocoaBadge tone={draftInfo.source === "ai" ? "info" : "neutral"} variant="tinted" size="small">
                    {draftSourceBadge(draftInfo.source)}
                  </CocoaBadge>
                ) : undefined
              }
            >
              {responded ? (
                <div className="cocoa-stack" data-gap="2">
                  <p className="cocoa-note">{detail.responseBody ?? "Respuesta publicada sin copia del texto."}</p>
                  {detail.respondedAt ? <span className="cocoa-note">Respondida el {dateTime(detail.respondedAt)}{detail.response?.externalState ? ` · estado en el portal: ${detail.response.externalState}` : ""}</span> : null}
                </div>
              ) : closed ? (
                <CocoaState kind="empty" inline title={`Reseña ${statusLabel(detail.status).toLowerCase()}: no se responde.`} />
              ) : !canRespond ? (
                <CocoaState kind="empty" inline title="Sin permiso para responder" message="Necesitas el permiso «Responder reseñas» en esta propiedad." />
              ) : (
                <div className="cocoa-stack" data-gap="3">
                  {draftRejected ? (
                    <CocoaCallout tone="warning" role="alert" title="Borrador rechazado en revisión humana">
                      {REPUTATION_ERROR_MESSAGES_ES.REVIEW_DRAFT_REJECTED}
                    </CocoaCallout>
                  ) : draftInfo ? (
                    <CocoaCallout tone="info" role="status" title={`Borrador · ${draftSourceBadge(draftInfo.source)}`}>
                      {detail.draftReviewStatus === "approved" ? "Aprobado en revisión humana; publicar sigue siendo una decisión de la persona." : DRAFT_REVIEW_NOTICE}
                    </CocoaCallout>
                  ) : null}
                  {!detail.replyCapability ? (
                    <CocoaCallout tone="warning" role="note" title="Publicación manual">
                      Esta fuente no admite responder desde aquí: copia el texto, publícalo en el portal y confírmalo abajo.
                    </CocoaCallout>
                  ) : null}
                  <CocoaField label="Texto de la respuesta" help={`${responseText.trim().length} / 4000 caracteres.`}>
                    <CocoaInput multiline rows={6} value={responseText} onChange={setResponseText} maxLength={4000} placeholder="Gracias por su opinión…" />
                  </CocoaField>
                  <div className="cocoa-row" data-gap="2" data-wrap="true" data-justify="between">
                    <span className="cocoa-cluster">
                      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setDraftOpen(true)} disabled={busy !== null}>
                        Borrador
                      </CocoaButton>
                    </span>
                    <span className="cocoa-cluster">
                      {detail.replyCapability ? (
                        <CocoaButton variant="filled" tone="accent" size="small" onClick={() => publish("api")} loading={busy === "respond"} disabled={busy !== null || draftRejected}>
                          {primaryLabel}
                        </CocoaButton>
                      ) : (
                        <>
                          <CocoaButton variant="tinted" tone="accent" size="small" onClick={copyAndOpen} disabled={busy !== null}>
                            {primaryLabel}
                          </CocoaButton>
                          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setConfirmManual(true)} disabled={busy !== null || !responseText.trim() || draftRejected}>
                            {MANUAL_PUBLICATION_CONFIRM_LABEL}
                          </CocoaButton>
                        </>
                      )}
                    </span>
                  </div>
                  {copied ? <span className="cocoa-note">Texto copiado: pégalo en el portal y confirma cuando esté publicado.</span> : null}
                </div>
              )}
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>

      <ReviewDraftDialog open={draftOpen} reviewId={detail?.id ?? null} onClose={() => setDraftOpen(false)} onUseDraft={useDraft} />

      <QualityCaseDrawer open={caseMode !== null} mode={caseMode} onClose={() => setCaseMode(null)} onSaved={() => void refreshAll()} currentUserId={currentUserId} />

      <CocoaDialog
        open={confirmManual}
        onClose={() => setConfirmManual(false)}
        title="Confirmar publicación manual"
        description="Se guardará el texto como respuesta publicada por ti en el portal. Una reseña se responde una sola vez."
        confirmLabel={MANUAL_PUBLICATION_CONFIRM_LABEL}
        onConfirm={() => publish("manual")}
        busy={busy === "respond"}
      />
    </>
  );
}

export default ReviewDetailDrawer;
