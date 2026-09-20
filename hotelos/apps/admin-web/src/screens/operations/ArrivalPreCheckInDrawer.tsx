// Arrival pre-check-in drawer — Tanda CHK · W4-B (docs/design/CHECKIN-AUTOMATIZADO-IA.md
// §8, fila «Recepción · /hoy»: `ArrivalPreCheckInDrawer`, solo lectura del
// `CheckInSessionDto`).
//
// Lo abren Mi día («Ver pre-check-in» del menú «⋯» de una llegada) y la cola
// de acciones (`open_precheckin`). Pinta, en un `CocoaDrawer`, lo que el
// huésped ha hecho antes de llegar: viajeros con estado, documento (tipo,
// origen, controles MRZ; nunca el número completo: el API solo expone los 3
// últimos caracteres), firma (fecha y método), consentimientos, hora de
// llegada declarada, preferencias, pago y la sugerencia de habitación
// pendiente. Dos acciones: «Invitar de nuevo» (reenvío por el canal de la
// sesión, o invitación por correo si no hay sesión) y «Abrir check-in» (el
// contenedor abre el cajón de 90 s). Sin estilos en línea (pantalla nueva,
// contrato Cocoa 22); cifras y fechas de lib/format; estados de frontdesk-labels.ts.
//
// Fuentes (staff, permisos pms.reservation.read):
//   · GET /reservations/:id/check-in (W3-A): sesión + viajeros + capturas y
//     firmas sin PII; 404 «Sesión de check-in no encontrada.» = sin invitar.
//   · GET /reservations/:id/assignment-suggestions (W3-B): { current, history }.
//   · GET /reservations/:id y /reservations/:id/folio: código, fechas y saldo.
//   · POST /properties/:id/check-in/sessions[/:sid/resend] (pms.reservation.modify).

import { useState } from "react";
import type { AssignmentSuggestionDto, CheckInGuestDto } from "@hotelos/shared";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { inviteSession, type ReservationCheckInGuest, type ReservationCheckInView } from "../../services/checkinApi";
import { useToast } from "../../components/Toast";
import { date, dateTime, money, percent, plural } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import {
  checkInChannelLabel,
  checkInGuestStatus,
  checkInPaymentStatus,
  documentSourceLabel,
  handoffKindLabel,
  identityMethodLabel,
  mrzChecksSummary,
  preCheckInStatus,
  preferenceLabel,
  signatureMethodLabel
} from "./frontdesk-labels";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDrawer, CocoaSection, CocoaSkeleton, CocoaState, CocoaStatusBadge, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";

const DRAWER_STALE_MS = 15_000;

// ---------------------------------------------------------------- tipos (proyección de staff de checkin.routes.ts, sin PII; services/checkinApi.ts de W4-A)

/** Viajero de la vista de recepción; las puras de abajo solo leen lo que necesitan. */
export type StaffCheckInGuest = ReservationCheckInGuest;

export type StaffCheckInView = ReservationCheckInView;

type StaffCapture = Pick<StaffCheckInGuest["captures"][number], "source" | "mrzFormat" | "checksJson" | "needsReviewJson" | "createdAt">;
type StaffSignature = Pick<StaffCheckInGuest["signatures"][number], "method" | "signedAt">;

type SuggestionsView = { current: AssignmentSuggestionDto | null; history: AssignmentSuggestionDto[] };

type ReservationLite = { id: string; code: string; arrivalDate: string; departureDate: string; eta?: string | null; currency?: string };

type FolioLite = { folio: { id: string; status: string; currency: string }; chargesTotal: number; paymentsTotal: number; balanceDue: number };

// ---------------------------------------------------------------- puras (testables sin DOM)

/** «Nombre Apellido1 Apellido2» o «Viajero N» cuando el hueco sigue vacío. */
export function guestDisplayName(guest: Pick<CheckInGuestDto, "firstName" | "surname1" | "surname2" | "ordinal">): string {
  const parts = [guest.firstName, guest.surname1, guest.surname2].map((part) => (part ?? "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : `Viajero ${guest.ordinal}`;
}

export type DocumentSummary = {
  /** Tipo del documento (P, I, DNI…) o null sin captura ni dato. */
  type: string | null;
  /** «···321»: solo los 3 últimos caracteres que expone el API. */
  masked: string | null;
  /** Origen de la última captura («lector MRZ», «visión IA», «manual») o null sin captura. */
  source: string | null;
  format: string | null;
  /** «4/4 controles» de la MRZ o null cuando no aplica. */
  checks: string | null;
  /** Campos que recepción debe revisar (baja confianza o control fallido). */
  needsReview: string[];
};

/** Resumen del documento a partir del viajero y de su última captura; nunca el número completo. */
export function documentSummary(guest: Pick<CheckInGuestDto, "documentType" | "documentNumberLast3"> & { captures?: readonly StaffCapture[] }): DocumentSummary {
  const latest = [...(guest.captures ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const needsReview = latest && Array.isArray(latest.needsReviewJson) ? latest.needsReviewJson.filter((field): field is string => typeof field === "string") : [];
  const last3 = (guest.documentNumberLast3 ?? "").trim();
  return {
    type: guest.documentType ? guest.documentType.trim() || null : null,
    masked: last3 ? `···${last3}` : null,
    source: latest ? documentSourceLabel(latest.source) : null,
    format: latest?.mrzFormat ?? null,
    checks: latest ? (mrzChecksSummary(latest.checksJson)?.label ?? null) : null,
    needsReview
  };
}

export type SignatureSummary = { signedAt: string; method: string } | null;

/** La última firma del viajero (fecha ISO y método legible) o null. */
export function signatureSummary(guest: { signatures?: readonly StaffSignature[] }): SignatureSummary {
  const latest = [...(guest.signatures ?? [])].sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
  return latest ? { signedAt: latest.signedAt, method: signatureMethodLabel(latest.method) } : null;
}

/** El 404 de la vista de staff significa «sin invitar»; cualquier otro error se muestra tal cual. */
export function isNoSessionError(error: string | null | undefined): boolean {
  return Boolean(error && /no encontrada/i.test(error));
}

// ---------------------------------------------------------------- componente

export type ArrivalPreCheckInDrawerProps = {
  reservationId: string;
  propertyId: string;
  /** `false` cuando la fila ya sabe que no hay sesión (no se consulta el API); ausente → se consulta y el 404 vale «sin invitar». */
  hasSession?: boolean;
  onClose: () => void;
  /** «Abrir check-in»: el contenedor abre el cajón de 90 s con la reserva. */
  onOpenCheckIn?: (reservationId: string) => void;
  /** Tras invitar o reenviar: el contenedor revalida Mi día y la cola. */
  onChanged?: () => void;
};

function DrawerSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="3" aria-hidden="true">
      <CocoaSkeleton variant="row" lines={3} />
      <CocoaSkeleton variant="card" height={160} />
      <CocoaSkeleton variant="row" lines={4} />
    </div>
  );
}

function fmtWhen(iso: string | null | undefined): string {
  return iso ? dateTime(iso) : "—";
}

export function ArrivalPreCheckInDrawer({ reservationId, propertyId, hasSession, onClose, onOpenCheckIn, onChanged }: ArrivalPreCheckInDrawerProps) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const sessionState = useApiData<StaffCheckInView>(hasSession === false ? null : `/reservations/${encodeURIComponent(reservationId)}/check-in`, { staleTime: DRAWER_STALE_MS });
  const reservationState = useApiData<ReservationLite>(`/reservations/${encodeURIComponent(reservationId)}`, { staleTime: DRAWER_STALE_MS });
  const folioState = useApiData<FolioLite>(`/reservations/${encodeURIComponent(reservationId)}/folio`, { staleTime: DRAWER_STALE_MS });
  const suggestionsState = useApiData<SuggestionsView>(`/reservations/${encodeURIComponent(reservationId)}/assignment-suggestions`, { staleTime: DRAWER_STALE_MS });

  const view = sessionState.data;
  const reservation = reservationState.data;
  const folio = folioState.data;
  const noSession = hasSession === false || (!view && isNoSessionError(sessionState.error));
  const loading = hasSession !== false && sessionState.loading && !view;

  async function invite() {
    setBusy(true);
    const channel = view && (view.channel === "email" || view.channel === "whatsapp" || view.channel === "sms") ? view.channel : "email";
    try {
      if (view) {
        await apiRequest(`/properties/${encodeURIComponent(propertyId)}/check-in/sessions/${encodeURIComponent(view.id)}/resend`, { method: "POST", body: {} });
      } else {
        await inviteSession(propertyId, reservationId, "email");
      }
      showToast(`Invitación al pre-check-in enviada por ${checkInChannelLabel(channel)}`, { variant: "success" });
      sessionState.refresh();
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo enviar la invitación.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const guestColumns: CocoaTableColumn<StaffCheckInGuest>[] = [
    {
      key: "name",
      label: "Viajero",
      render: (guest) => (
        <div className="cocoa-stack" data-gap="1">
          <strong>{guestDisplayName(guest)}</strong>
          <span className="cocoa-row" data-gap="1">
            {guest.isPrimary ? (
              <CocoaBadge tone="accent" variant="tinted" size="small" uppercase={false}>
                Titular
              </CocoaBadge>
            ) : null}
            {guest.isMinor ? (
              <CocoaBadge tone="warning" variant="tinted" size="small" uppercase={false}>
                {guest.ageAtArrival !== null ? `Menor · ${plural(guest.ageAtArrival, "año", "años")}` : "Menor"}
              </CocoaBadge>
            ) : null}
            {guest.kinship ? <span className="cocoa-note">{guest.kinship}</span> : null}
          </span>
        </div>
      )
    },
    { key: "status", label: "Estado", render: (guest) => <CocoaStatusBadge entry={checkInGuestStatus(guest.status)} dense /> },
    {
      key: "document",
      label: "Documento",
      render: (guest) => {
        const summary = documentSummary(guest);
        if (!summary.type && !summary.masked && !summary.source) return <span className="cocoa-note">Sin documento</span>;
        return (
          <div className="cocoa-stack" data-gap="1">
            <span>{[summary.type, summary.masked].filter(Boolean).join(" ") || "Documento"}</span>
            <span className="cocoa-note">{[summary.source, summary.format, summary.checks].filter(Boolean).join(" · ") || "Sin captura"}</span>
            {summary.needsReview.length > 0 ? (
              <CocoaBadge tone="warning" variant="tinted" size="small" uppercase={false}>
                Revisar: {summary.needsReview.join(", ")}
              </CocoaBadge>
            ) : null}
          </div>
        );
      }
    },
    {
      key: "signature",
      label: "Firma",
      render: (guest) => {
        const signature = signatureSummary(guest);
        return signature ? (
          <div className="cocoa-stack" data-gap="1">
            <span>{date(signature.signedAt, "short")}</span>
            <span className="cocoa-note">{signature.method}</span>
          </div>
        ) : (
          <span className="cocoa-note">Sin firmar</span>
        );
      },
      hideOnNarrow: true
    },
    {
      key: "identity",
      label: "Identidad",
      render: (guest) =>
        guest.identityVerifiedAt ? (
          <div className="cocoa-stack" data-gap="1">
            <span>{identityMethodLabel(guest.identityVerificationMethod)}</span>
            <span className="cocoa-note">{date(guest.identityVerifiedAt, "short")}</span>
          </div>
        ) : (
          <span className="cocoa-note">{guest.identityVerificationMethod ? `${identityMethodLabel(guest.identityVerificationMethod)} · pendiente de verificar` : "Sin verificar"}</span>
        ),
      hideOnNarrow: true
    }
  ];

  const current = suggestionsState.data?.current ?? null;
  const title = `Pre-check-in · ${reservation?.code ?? reservationId}`;
  const subtitle = reservation ? `${date(reservation.arrivalDate, "dayMonth")} → ${date(reservation.departureDate, "dayMonth")}${reservation.eta ? ` · ETA ${reservation.eta}` : ""}` : undefined;

  return (
    <CocoaDrawer
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      side="right"
      size="md"
      loading={loading}
      skeleton={<DrawerSkeleton />}
      focusKey={loading ? "loading" : "ready"}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="regular" disabled={busy} loading={busy} onClick={() => void invite()}>
            {noSession ? "Invitar por correo" : "Invitar de nuevo"}
          </CocoaButton>
          {onOpenCheckIn ? (
            <CocoaButton variant="filled" tone="accent" size="regular" onClick={() => onOpenCheckIn(reservationId)}>
              Abrir check-in
            </CocoaButton>
          ) : null}
        </>
      }
    >
      {noSession ? (
        <CocoaState kind="empty" inline title="Sin pre-check-in" message="El huésped no ha recibido la invitación. Envíasela para que complete viajeros, documento y firma antes de llegar." />
      ) : sessionState.error && !view ? (
        <CocoaState kind="error" title={STATUS_LABELS.loadError} message={sessionState.error} onRetry={sessionState.refresh} />
      ) : view ? (
        <div className="cocoa-stack" data-gap="3">
          <CocoaSection title="Estado" meta={<CocoaStatusBadge entry={preCheckInStatus(view.status)} />}>
            <ul className="c22-section__list" aria-label="Estado del pre-check-in">
              <li>
                <span>Canal</span>
                <strong>{checkInChannelLabel(view.channel)}</strong>
              </li>
              <li>
                <span>Invitado</span>
                <strong>{fmtWhen(view.invitedAt)}</strong>
              </li>
              {view.reminderAt ? (
                <li>
                  <span>Recordatorio</span>
                  <strong>{fmtWhen(view.reminderAt)}</strong>
                </li>
              ) : null}
              <li>
                <span>Completado</span>
                <strong>{fmtWhen(view.completedAt)}</strong>
              </li>
              <li>
                <span>Llegada declarada</span>
                <strong>{view.etaDeclared ?? reservation?.eta ?? "—"}</strong>
              </li>
              {view.arrivedAt ? (
                <li>
                  <span>Llegó</span>
                  <strong>{fmtWhen(view.arrivedAt)}</strong>
                </li>
              ) : null}
              {view.checkedInAt ? (
                <li>
                  <span>Check-in</span>
                  <strong>{fmtWhen(view.checkedInAt)}</strong>
                </li>
              ) : null}
              {view.kioskDeviceId ? (
                <li>
                  <span>Kiosco</span>
                  <strong>{view.kioskDeviceId}</strong>
                </li>
              ) : null}
            </ul>
            {view.status === "handed_off" ? (
              <CocoaCallout tone="warning" role="status" title={handoffKindLabel(view.handoffKind)}>
                {view.handoffReason ?? "El huésped necesita ayuda en el mostrador para terminar."}
              </CocoaCallout>
            ) : null}
          </CocoaSection>

          <CocoaSection title={`Viajeros (${view.guests.length})`}>
            {view.guests.length === 0 ? <span className="cocoa-note">Sin viajeros todavía.</span> : <CocoaTable columns={guestColumns} rows={view.guests} rowKey="id" caption="Viajeros del pre-check-in" density="compact" />}
          </CocoaSection>

          <CocoaSection title="Consentimientos">
            <ul className="c22-section__list" aria-label="Consentimientos del huésped">
              <li>
                <span>Protección de datos</span>
                <strong>{fmtWhen(view.consent.gdprAt)}</strong>
              </li>
              <li>
                <span>Aviso de IA</span>
                <strong>{fmtWhen(view.consent.aiDisclosureAt)}</strong>
              </li>
              <li>
                <span>Comunicaciones comerciales</span>
                <strong>{view.consent.marketing ? STATUS_LABELS.yes : STATUS_LABELS.no}</strong>
              </li>
              <li>
                <span>WhatsApp</span>
                <strong>{fmtWhen(view.consent.whatsappOptInAt)}</strong>
              </li>
            </ul>
          </CocoaSection>

          <CocoaSection title="Preferencias">
            {view.preferences.length === 0 ? (
              <span className="cocoa-note">Sin preferencias declaradas.</span>
            ) : (
              <div className="cocoa-cluster" role="list" aria-label="Preferencias del huésped">
                {view.preferences.map((code) => (
                  <CocoaBadge key={code} tone="info" variant="tinted" size="small" uppercase={false} role="listitem">
                    {preferenceLabel(code)}
                  </CocoaBadge>
                ))}
              </div>
            )}
          </CocoaSection>

          <CocoaSection title="Pago" meta={<CocoaStatusBadge entry={checkInPaymentStatus(view.paymentStatus)} dense />}>
            {folio ? (
              <ul className="c22-section__list" aria-label="Folio abreviado">
                <li>
                  <span>Cargos · pagos</span>
                  <strong>
                    {money(folio.chargesTotal, folio.folio.currency)} · {money(folio.paymentsTotal, folio.folio.currency)}
                  </strong>
                </li>
                <li>
                  <span>Saldo</span>
                  <strong>{money(folio.balanceDue, folio.folio.currency)}</strong>
                </li>
              </ul>
            ) : (
              <span className="cocoa-note">{folioState.error ? "Folio no disponible." : folioState.loading ? STATUS_LABELS.loading : "Sin folio abierto."}</span>
            )}
          </CocoaSection>

          <CocoaSection title="Sugerencia de habitación" meta={current ? <span className="cocoa-note">Confianza {percent(Math.round(current.confidence * 100))}</span> : undefined}>
            {suggestionsState.error ? (
              <span className="cocoa-note">Sugerencias no disponibles.</span>
            ) : !current ? (
              <span className="cocoa-note">Sin sugerencia pendiente: la genera el lote de la tarde anterior o «Asignar habitación».</span>
            ) : (
              <ul className="c22-section__list" aria-label="Candidatas del motor">
                {current.candidates.slice(0, 3).map((candidate, index) => (
                  <li key={candidate.roomId}>
                    <span>
                      {index === 0 ? "Propuesta" : "Alternativa"} · Hab. {candidate.number}
                    </span>
                    <strong>{candidate.reasons.length > 0 ? candidate.reasons.map((reason) => reason.detail).join(" · ") : "Sin motivos"}</strong>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>
        </div>
      ) : null}
    </CocoaDrawer>
  );
}
