// LifecycleDialog — cancelar / marcar no-show con penalización (Tanda UX-1 ·
// lote U6 · docs/design/UX-RECEPCION-FEEL.md §4.2 «Cancelar / no-show», §5.1
// (9), F9). El mismo diálogo nominal para la cola de Mi día y la ficha: motivo
// obligatorio con el foco inicial, previsualización de la penalización (GET
// /reservations/:id/cancellation-charge?mode=) y botones que dicen lo que hacen
// («Marcar no-show (penalización 89,00 €)» / «Mantener la reserva»), nunca
// «¿Seguro?». Envía `{ reason, applyPolicy }` a POST /reservations/:id/no-show
// · /cancel. Intro confirma desde el campo del motivo (CocoaDialog
// `submitOnEnter` + `initialFocus`, F6).
//
// Lote U7 (§5.5 (8)): la ficha lo adopta y trae consigo la renuncia a la
// penalización (`allowWaiver`): el interruptor «Aplicar la penalización
// prevista» envía `applyPolicy: false`; por encima del tramo operativo el API
// responde 409 APPROVAL_REQUIRED (motor de descuentos de T8a) y el diálogo
// ofrece el PIN de supervisor (pms.reservation.override sobre esta reserva),
// que se reenvía como `supervisorAuthorizationId` en el mismo intento (DS-02).
// Sin estilos en línea: copy de content/actions.ts, layout con las utilidades Cocoa.

import { useEffect, useId, useState } from "react";
import type { SupervisorAuthorizationDto } from "@hotelos/shared";
import { useToast } from "../Toast";
import { cancelReservation, noShowReservation, type AdminReservation, type ReservationLifecycleOptions } from "../../services/pmsCommerceApi";
import { previewCancellationCharge, type ChargeBreakdown, type ChargeMode } from "../../services/cancellationApi";
import { financeErrorCode, financeErrorMessage } from "../../services/finance-contracts";
import { lifecycleOutcomeSummary, penaltyPreviewSummary, type LifecycleOutcomeLike } from "../billing/charge-types";
import { SupervisorPinDialog } from "../SupervisorPinDialog";
import { dateTime, money } from "../../lib/format";
import { FRONT_DESK_ACTIONS } from "../../content/actions";
import { CocoaButton, CocoaCallout, CocoaDialog, CocoaField, CocoaInput, CocoaState, CocoaSwitch } from "../cocoa";

export type LifecycleMode = ChargeMode;

/** POST /cancel · /no-show responde la reserva más `cancellation` (L3-B). */
export type LifecycleResult = AdminReservation & { cancellation?: LifecycleOutcomeLike };

export interface LifecycleDialogProps {
  open: boolean;
  mode: LifecycleMode;
  reservation: { id: string; code: string; currency?: string | null; propertyId?: string | null } | null;
  onClose: () => void;
  /** Tras la escritura (la fila ya puede pasar a no-show / cancelada). */
  onDone?: (result: LifecycleResult) => void;
  /** Ficha (U7): permite renunciar a la penalización con la clave de descuento y, por encima del tramo, el PIN de supervisor. */
  allowWaiver?: boolean;
}

type PenaltyPreview = { loading: boolean; data: ChargeBreakdown | null; error: string | null };
const IDLE_PREVIEW: PenaltyPreview = { loading: false, data: null, error: null };

/** Etiqueta nominal del botón de confirmación (pura): importe de la penalización prevista o «sin penalización». */
export function lifecycleConfirmLabel(mode: LifecycleMode, preview: ChargeBreakdown | null, formatAmount: (amount: number) => string, options: { applyPolicy?: boolean; authorized?: boolean } = {}): string {
  const chargeable = Boolean(preview && preview.amount > 0 && !preview.withinFreeWindow) && options.applyPolicy !== false;
  const amount = chargeable && preview ? formatAmount(preview.amount) : null;
  const base = mode === "no_show" ? FRONT_DESK_ACTIONS.markNoShowWithPenalty(amount) : FRONT_DESK_ACTIONS.cancelWithPenalty(amount);
  return options.authorized ? `${base} · con autorización` : base;
}

export function lifecycleTitle(mode: LifecycleMode, code: string): string {
  return mode === "no_show" ? `¿Marcar ${code} como no-show?` : `¿Cancelar la reserva ${code}?`;
}

/** Mensaje del guard del motivo (el botón ya va deshabilitado sin motivo; el toast lo dice si algo lo salta). */
export function missingReasonMessage(mode: LifecycleMode): string {
  return mode === "no_show" ? "Indica el motivo del no-show." : "Indica el motivo de la cancelación.";
}

const DESCRIPTION: Record<LifecycleMode, string> = {
  no_show: "El huésped no se ha presentado: la reserva se cierra, la penalización de no-show prevista por su política se carga al folio y, si el saldo queda a cero, el folio se cierra.",
  cancellation: "La reserva dejará de contar en la ocupación. La penalización prevista por su política se carga al folio como línea no sujeta a IVA y, si el saldo queda a cero, el folio se cierra."
};

const REASON_PLACEHOLDER: Record<LifecycleMode, string> = {
  no_show: "No se ha presentado ni ha avisado",
  cancellation: "El huésped anula el viaje"
};

export function LifecycleDialog({ open, mode, reservation, onClose, onDone, allowWaiver = false }: LifecycleDialogProps) {
  const { showToast } = useToast();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PenaltyPreview>(IDLE_PREVIEW);
  // Renuncia a la penalización (ficha): interruptor, aviso del 409 y autorización de un solo uso.
  const [applyPolicy, setApplyPolicy] = useState(true);
  const [waiverApproval, setWaiverApproval] = useState<{ tier: string | null; message: string } | null>(null);
  const [waiverPinOpen, setWaiverPinOpen] = useState(false);
  const [waiverAuthorization, setWaiverAuthorization] = useState<SupervisorAuthorizationDto | null>(null);

  // Previsualización de la penalización al abrir; un diálogo cerrado la olvida.
  useEffect(() => {
    if (!open || !reservation) {
      setPreview(IDLE_PREVIEW);
      return;
    }
    setReason("");
    setApplyPolicy(true);
    setWaiverApproval(null);
    setWaiverAuthorization(null);
    setWaiverPinOpen(false);
    setPreview({ loading: true, data: null, error: null });
    let stale = false;
    previewCancellationCharge(reservation.id, mode)
      .then((data) => {
        if (!stale) setPreview({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (!stale) setPreview({ loading: false, data: null, error: financeErrorMessage(error, "No se pudo calcular la penalización.") });
      });
    return () => {
      stale = true;
    };
    // Importa el id, no el objeto (cambia en cada recarga).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, reservation?.id]);

  if (!reservation) return null;

  const formatAmount = (amount: number) => money(amount, reservation.currency ?? undefined);
  const penalty = preview.data;
  const chargeable = Boolean(penalty && penalty.amount > 0 && !penalty.withinFreeWindow);
  const waiving = allowWaiver && chargeable && !applyPolicy;

  async function confirm() {
    if (!reservation) return;
    const text = reason.trim();
    if (!text) {
      showToast(missingReasonMessage(mode), { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const options: ReservationLifecycleOptions = { applyPolicy: !waiving, ...(waiving && waiverAuthorization ? { supervisorAuthorizationId: waiverAuthorization.id } : {}) };
      const write = mode === "no_show" ? noShowReservation(reservation.id, text, options) : cancelReservation(reservation.id, text, options);
      const result = (await write) as LifecycleResult;
      showToast(lifecycleOutcomeSummary(mode, result.cancellation ?? null, formatAmount), { variant: "success" });
      onDone?.(result);
      onClose();
    } catch (error) {
      if (waiving && financeErrorCode(error) === "APPROVAL_REQUIRED") {
        const details = (error as { details?: { tier?: unknown } }).details;
        setWaiverApproval({ tier: typeof details?.tier === "string" ? details.tier : null, message: financeErrorMessage(error, "La renuncia a la penalización necesita autorización.") });
        setWaiverAuthorization(null);
        showToast("La renuncia a la penalización supera tu tramo: pide la autorización de un supervisor.", { variant: "warning" });
      } else {
        showToast(financeErrorMessage(error, mode === "no_show" ? "No se pudo registrar el no-show." : "No se pudo cancelar la reserva."), { variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <CocoaDialog
        open={open}
        onClose={onClose}
        submitOnEnter
        tone="destructive"
        title={lifecycleTitle(mode, reservation.code)}
        description={DESCRIPTION[mode]}
        size="md"
        confirmLabel={busy ? "Registrando…" : lifecycleConfirmLabel(mode, penalty, formatAmount, { applyPolicy: !waiving, authorized: Boolean(waiving && waiverAuthorization) })}
        cancelLabel={FRONT_DESK_ACTIONS.keepReservation}
        busy={busy}
        confirmDisabled={!reason.trim() || preview.loading}
        initialFocus={() => document.getElementById(reasonId)}
        onConfirm={() => void confirm()}
      >
        <div className="cocoa-stack" data-gap="3">
          {preview.loading ? (
            <CocoaState kind="loading" inline title="Calculando la penalización prevista…" />
          ) : (
            <CocoaCallout tone={preview.error ? "warning" : chargeable && !waiving ? "warning" : "info"} title={penalty ? (penalty.policyName ? `Política «${penalty.policyName}»` : "Sin política de cancelación") : "Penalización no calculada"} role="status">
              {preview.error ?? penaltyPreviewSummary(mode, penalty, formatAmount)}
              {penalty?.label ? ` ${penalty.label}` : ""}
              {penalty?.cutoffAt ? ` Plazo gratuito hasta ${dateTime(penalty.cutoffAt, { style: "medium" })}.` : ""}
            </CocoaCallout>
          )}
          <CocoaField label="Motivo" required help="Queda en la auditoría de la reserva. Intro confirma." htmlFor={reasonId}>
            <CocoaInput id={reasonId} value={reason} onChange={setReason} placeholder={REASON_PLACEHOLDER[mode]} maxLength={1000} disabled={busy} autoComplete="off" />
          </CocoaField>
          {allowWaiver && chargeable ? (
            <CocoaField
              label="Aplicar la penalización prevista"
              inline
              help={
                applyPolicy
                  ? `Se cargarán ${formatAmount(penalty!.amount)} al folio como línea no sujeta a IVA.`
                  : "Renunciar es un descuento: hasta el tramo operativo basta la clave de descuento y el motivo; por encima hace falta la autorización de un supervisor (PIN) o una solicitud aprobada. Queda auditado."
              }
            >
              <CocoaSwitch
                checked={applyPolicy}
                onChange={(next) => {
                  setApplyPolicy(next);
                  setWaiverApproval(null);
                  setWaiverAuthorization(null);
                }}
                size="small"
                disabled={busy}
              />
            </CocoaField>
          ) : null}
          {waiving && waiverApproval && !waiverAuthorization ? (
            <CocoaCallout
              tone="warning"
              title="Esta renuncia supera tu tramo"
              role="alert"
              actions={
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setWaiverPinOpen(true)} disabled={busy}>
                  Autorizar con PIN de supervisor
                </CocoaButton>
              }
            >
              {waiverApproval.message}
              {waiverApproval.tier ? ` Tramo: ${waiverApproval.tier}.` : ""} Un supervisor presente puede autorizar solo esta renuncia con su PIN hasta su tramo; por encima del tramo de supervisión solo vale una solicitud de descuento aprobada.
            </CocoaCallout>
          ) : null}
          {waiving && waiverAuthorization ? (
            <CocoaCallout tone="success" title="Autorización de supervisor concedida" role="status">
              Válida hasta {dateTime(waiverAuthorization.expiresAt, { style: "medium" })} y solo para esta reserva. Confirma para renunciar a la penalización.
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>
      {allowWaiver && open && reservation.propertyId ? (
        <SupervisorPinDialog
          open={waiverPinOpen}
          onClose={() => setWaiverPinOpen(false)}
          permissionKey="pms.reservation.override"
          entityType="reservation"
          entityId={reservation.id}
          propertyId={reservation.propertyId}
          amount={penalty && penalty.amount > 0 ? penalty.amount.toFixed(2) : undefined}
          actionLabel={`Renunciar a la penalización de ${penalty ? formatAmount(penalty.amount) : "la reserva"} ${reservation.code}`}
          onAuthorized={(granted) => {
            setWaiverAuthorization(granted);
            setWaiverPinOpen(false);
            setWaiverApproval(null);
            showToast("Autorización de supervisor concedida: confirma la renuncia", { variant: "success" });
          }}
        />
      ) : null}
    </>
  );
}

export default LifecycleDialog;
