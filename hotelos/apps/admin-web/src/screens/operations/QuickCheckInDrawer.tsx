// Quick Check-in Drawer — flujo guiado de ≤ 90 segundos en una sola pantalla.
//
// Directriz Anfitorio (Nov 2026):
//   "Diseñar check-in/check-out de 90 segundos. Buscar reserva, validar
//    identidad, confirmar datos, ver alertas importantes, asignar habitación
//    limpia, cobrar o preautorizar, firmar digitalmente, emitir llave, enviar
//    mensaje de bienvenida. Evitar saltos entre pantallas."
//
// Este drawer concentra todo el flujo en una sola vista deslizante:
//   1. Huésped + identidad + alertas (VIP, recurrente, peticiones)
//   2. Habitación asignada + estado HK (con sugerencia de cambio si no lista)
//   3. Folio + saldo + método de pago (preautorización vs captura)
//   4. Compliance (parte viajeros SES) + firma
// Un único CTA "Hacer check-in" ejecuta:
//   - POST /reservations/:id/assign-room (si hay que reasignar)
//   - POST /reservations/:id/check-in
//   - POST /properties/:id/ses/submissions → { status, queued, submissions[], failed[] }
//     (Tanda 3 · cierre): el resultado se lee de verdad. «Encolado» solo si
//     queued > 0 y failed vacío; un 409 SES_ESTABLISHMENT_INCOMPLETE
//     (details.missing) o entradas en failed[] se muestran con los campos que
//     faltan y un enlace a Ajustes fiscales. Nunca «enviado» en falso.
// Mostramos cronómetro: la directriz exige < 90 s.
//
// Cocoa 22 (ola 2 · lote 2-A): the panel is a `CocoaDrawer` (portal, scrim,
// focus trap, Esc, bottom sheet on phones); each step is a `CocoaSection`
// with a `CocoaBadge` as meta; controls are `CocoaField` + `CocoaSelect` /
// `CocoaSegmentedControl`; notices are `CocoaCallout`; the finished state is a
// `CocoaState` with the success illustration. Same endpoints, same props.

import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useToast } from "../../components/Toast";
import { apiRequest } from "../../services/api-client";
import {
  queueSesSubmissions,
  sesEstablishmentIssueLabel,
  sesFailureMessages,
  sesQueueOutcomeFromError,
  sesQueueOutcomeFromResponse,
  type SesQueueOutcome
} from "../../services/complianceApi";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { navigateTo } from "../../lib/navigate";
import { housekeepingStatusLabel, reservationStatusLabel, roomOptionLabel } from "./frontdesk-labels";
import { DEFAULT_CURRENCY, money, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { ChatBubbleIcon, ClockIcon, InfoCircleIcon, StarIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaState,
  type CocoaTone
} from "../../components/cocoa";

// =============================================================== shapes

type Reservation = {
  id: string;
  propertyId: string;
  code: string;
  channel: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  roomTypeId: string;
  assignedRoomId?: string;
  ratePlanId?: string;
  boardType?: string;
  specialRequests?: string;
  notes?: string;
  cancellationPolicyCode?: string;
  totalAmount: number;
  currency: string;
};

type Guest = {
  id: string;
  firstName: string;
  surname1?: string;
  surname2?: string;
  documentType?: string;
  documentNumber?: string;
  email?: string;
  phone?: string;
  nationality?: string;
  vipCode?: string;
  loyaltyTier?: string;
  loyaltyNumber?: string;
};

type Room = {
  id: string;
  number: string;
  floor?: string;
  status: string;
  housekeepingStatus?: string;
  roomTypeId: string;
};

type RoomType = { id: string; name: string };

// Only what the check-in reads from GET /guests/:id/timeline (guest 360).
type GuestTimelineLite = { metrics?: { totalStays?: number } };

type FolioBalance = {
  folio: { id: string; status: string; currency: string };
  lines: Array<{ id: string; type: string; description: string; total: number }>;
  payments: Array<{ id: string; amount: number; method: string; status: string }>;
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

export type QuickCheckInProps = {
  reservationId: string;
  onClose: () => void;
  onCompleted?: (info: { reservationId: string; elapsedSeconds: number }) => void;
};

type PaymentMode = "none" | "preauth" | "capture";
// Values match the API PaymentRecord.method union.
type PaymentMethod = "card" | "cash" | "bank_transfer";

const PAYMENT_METHOD_OPTIONS = [
  { value: "card", label: "Tarjeta" },
  { value: "cash", label: "Efectivo" },
  { value: "bank_transfer", label: "Transferencia" }
];

// =============================================================== utils

function fmtEur(value: number | undefined | null): string {
  return money(value);
}

function fmtName(g: Guest | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1, g.surname2].filter(Boolean).join(" ").trim() || "Huésped";
}

function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival).getTime();
  const d = new Date(departure).getTime();
  return Math.max(0, Math.round((d - a) / 86400000));
}

function missingLabels(missing: string[]): string {
  return missing.map(sesEstablishmentIssueLabel).join(", ");
}

function elapsedText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Toast copy for a non-queued SES outcome (the queued case has its own success toast). */
function sesOutcomeToast(outcome: SesQueueOutcome): string {
  switch (outcome.kind) {
    case "queued":
      return `Parte de viajeros encolado en SES.HOSPEDAJES (${outcome.queued}).`;
    case "no_records":
      return "La reserva no tiene registros de viajeros: no se ha encolado ningún parte SES. Completa el registro de viajeros.";
    case "partial":
      return `Parte SES: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar${outcome.missing.length > 0 ? ` (faltan: ${missingLabels(outcome.missing)})` : ""}.`;
    case "incomplete":
      return `Parte SES no encolado: faltan datos del establecimiento${outcome.missing.length > 0 ? ` (${missingLabels(outcome.missing)})` : ""}. Complétalos en Ajustes fiscales.`;
    case "error":
      return `Parte SES no encolado${outcome.code ? ` (${outcome.code})` : ""}: ${outcome.message} Revísalo en la bandeja de cumplimiento.`;
  }
}

// Secondary text inside the steps (caption, secondary ink); layout comes from
// the `cocoa-stack` / `cocoa-row` utilities and `c22-section__list`.
const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)"
};

const bulletListStyle: CSSProperties = { margin: 0, paddingLeft: "var(--cocoa-space-5)" };

// =============================================================== component

export function QuickCheckInDrawer({ reservationId, onClose, onCompleted }: QuickCheckInProps) {
  const { showToast } = useToast();
  const roomSelectId = useId();
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [guest, setGuest] = useState<Guest | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [roomType, setRoomType] = useState<RoomType | null>(null);
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  // QC-06: the folio is money-path. A failed load is surfaced (with retry) and
  // the operator must explicitly pick "Sin cobro" to continue without it.
  const [folioError, setFolioError] = useState<string | null>(null);
  const [folioLoading, setFolioLoading] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<Room[]>([]);
  const [priorStays, setPriorStays] = useState<number>(0);

  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("preauth");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ elapsedSeconds: number } | null>(null);
  // Real result of the SES queue call after the check-in (null until then).
  const [sesOutcome, setSesOutcome] = useState<SesQueueOutcome | null>(null);

  // Cronómetro — empieza al abrir, congela al completar.
  const [tick, setTick] = useState(0);
  const startedAt = useMemo(() => Date.now(), []);
  useEffect(() => {
    logBreadcrumb("checkin.opened", "ui", { reservationId });
    // El efecto se ejecuta una sola vez al montar; reservationId es estable
    // durante la vida del drawer (cambiar reserva implica reabrirlo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (completed) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [completed]);
  void tick;
  const elapsedSeconds = completed ? completed.elapsedSeconds : Math.floor((Date.now() - startedAt) / 1000);
  const elapsedLabel = elapsedText(elapsedSeconds);
  const timerTone: CocoaTone = elapsedSeconds < 90 ? "success" : elapsedSeconds < 120 ? "warning" : "danger";

  // ------------------------------------------------------------- data load
  const loadFolio = useCallback(async () => {
    setFolioLoading(true);
    setFolioError(null);
    try {
      setFolio(await apiRequest<FolioBalance>(`/reservations/${reservationId}/folio`));
    } catch (err) {
      setFolio(null);
      setFolioError(err instanceof Error ? err.message : "No se pudo cargar el folio.");
    } finally {
      setFolioLoading(false);
    }
  }, [reservationId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<Reservation>(`/reservations/${reservationId}`);
      setReservation(res);
      setSelectedRoomId(res.assignedRoomId);

      // Guest — el endpoint /reservations/:id ya devuelve `primaryGuest`
      // enriquecido (id + name + dni + vip). Evitamos /guests/:id porque tiene
      // scope por org y la cadena demo usa varias orgs.
      const primaryGuest = (res as unknown as { primaryGuest?: Guest | null }).primaryGuest;
      if (primaryGuest) setGuest(primaryGuest);

      // Parallel fetches — the folio failure is tracked separately (folioError)
      // instead of being swallowed into a fake "0 € pending". Prior stays
      // («Recurrente» badge) come from the guest timeline, the history route
      // the API does expose (`/reservations/:id/guest-history` never existed:
      // 404 on every opening, fix:2-A qa#6); best-effort — a failure degrades
      // to "no badge" (not money-path).
      const [, roomsData, roomTypesData, timeline] = await Promise.all([
        loadFolio(),
        apiRequest<Room[]>(`/properties/${res.propertyId}/rooms`),
        apiRequest<RoomType[]>(`/properties/${res.propertyId}/room-types`),
        primaryGuest?.id ? apiRequest<GuestTimelineLite>(`/guests/${primaryGuest.id}/timeline`).catch(() => null) : Promise.resolve<GuestTimelineLite | null>(null)
      ]);
      setAvailableRooms(roomsData);
      const rt = roomTypesData.find((t) => t.id === res.roomTypeId) ?? null;
      setRoomType(rt);
      const r = res.assignedRoomId ? roomsData.find((x) => x.id === res.assignedRoomId) ?? null : null;
      setRoom(r);
      // `metrics.totalStays` counts the guest's checked-out reservations.
      setPriorStays(Math.max(0, Math.floor(timeline?.metrics?.totalStays ?? 0)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error cargando reserva");
    } finally {
      setLoading(false);
    }
  }, [reservationId, loadFolio]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ------------------------------------------------------------- derived

  const selectedRoom = useMemo(
    () => (selectedRoomId ? availableRooms.find((r) => r.id === selectedRoomId) : undefined),
    [selectedRoomId, availableRooms]
  );
  void room;

  const roomIsClean = useMemo(() => {
    if (!selectedRoom) return false;
    const hk = (selectedRoom.housekeepingStatus ?? "").toLowerCase();
    return hk === "clean" || hk === "inspected" || hk === "ready" || selectedRoom.status === "clean";
  }, [selectedRoom]);

  const candidateRooms = useMemo(() => {
    if (!reservation) return [];
    const occupiedIds = new Set<string>(); // se podría enriquecer con in-house ids
    return availableRooms.filter((r) => {
      if (occupiedIds.has(r.id)) return false;
      if (r.roomTypeId !== reservation.roomTypeId) return false;
      const hk = (r.housekeepingStatus ?? "").toLowerCase();
      const clean = hk === "clean" || hk === "inspected" || hk === "ready" || r.status === "clean";
      return clean;
    });
  }, [availableRooms, reservation]);

  // Options of the room select: "Sin asignar" is a real choice (the legacy
  // select offered it), then the clean rooms of the same type, then the room
  // currently selected when it is not clean (so the control never loses it).
  const roomOptions = useMemo(() => {
    const options = [{ value: "", label: "Sin asignar" }];
    for (const r of candidateRooms) options.push({ value: r.id, label: roomOptionLabel(r, "limpia") });
    if (selectedRoom && !candidateRooms.some((c) => c.id === selectedRoom.id)) {
      options.push({ value: selectedRoom.id, label: roomOptionLabel(selectedRoom, housekeepingStatusLabel(selectedRoom.housekeepingStatus)) });
    }
    return options;
  }, [candidateRooms, selectedRoom]);

  // null = unknown (folio not loaded). The reservation total is NOT a balance:
  // it ignores deposits already captured, so it is never used as a fallback.
  const balanceDue: number | null = folio ? folio.balanceDue : null;
  const preauthAmount = Math.max(0, Math.round((reservation?.totalAmount ?? 0) * 100) / 100);
  const paymentRequiresFolio = paymentMode !== "none";

  // ------------------------------------------------------------- execute
  const canSubmit = Boolean(
    reservation && selectedRoomId && guest && reservation.status === "confirmed" && (folio || !paymentRequiresFolio)
  );
  const blockingReason = !reservation
    ? ""
    : reservation.status !== "confirmed"
    ? `Reserva en estado «${reservationStatusLabel(reservation.status)}»: el check-in solo procede con la reserva confirmada.`
    : !selectedRoomId
    ? "Asigna una habitación primero."
    : !guest
    ? "Sin huésped principal vinculado."
    : !roomIsClean
    ? "La habitación seleccionada no está limpia. Cambia o avisa a housekeeping."
    : !folio && paymentRequiresFolio
    ? "No se pudo cargar el folio: reintenta o elige «Sin cobro» de forma explícita."
    : "";

  async function executeCheckIn() {
    if (!reservation || !selectedRoomId) return;
    setBusy(true);
    setError(null);
    logBreadcrumb("checkin.submitted", "mutation", {
      reservationId: reservation.id,
      paymentMode,
      reassignRoom: selectedRoomId !== reservation.assignedRoomId
    });
    try {
      // 1) Reassign si el room cambió.
      if (selectedRoomId !== reservation.assignedRoomId) {
        await apiRequest(`/reservations/${reservation.id}/assign-room`, {
          method: "POST",
          body: { roomId: selectedRoomId }
        });
      }
      // 2) Cobro previo si capture/preauth con saldo.
      // Auditoría 2026-07: antes `.catch(()=>undefined)` — si el cobro fallaba se
      // tragaba el error y el check-in seguía como si se hubiera cobrado. Ahora
      // un fallo de cobro ABORTA el check-in con error visible; el recepcionista
      // puede reintentar o elegir explícitamente "Sin cobro".
      // QC-06: sin folio cargado no se puede cobrar; la UI exige "Sin cobro"
      // explícito antes de llegar aquí, y este guard lo hace imposible de saltar.
      if (paymentMode !== "none" && !folio) {
        throw new Error("No se pudo cargar el folio: no es posible cobrar. Reintenta o elige «Sin cobro».");
      }
      if (paymentMode !== "none" && folio && balanceDue !== null && balanceDue > 0) {
        try {
          await apiRequest(`/folios/${folio.folio.id}/payments`, {
            method: "POST",
            body: {
              amount: paymentMode === "capture" ? balanceDue : preauthAmount,
              currency: reservation.currency || DEFAULT_CURRENCY,
              method: paymentMethod,
              status: paymentMode === "capture" ? "captured" : "pending"
            }
          });
        } catch (err) {
          throw new Error(
            `No se pudo registrar el cobro (${err instanceof Error ? err.message : "error"}). ` +
              `El check-in NO se ha realizado. Reintenta o selecciona "Sin cobro".`
          );
        }
      }
      // 3) Check-in.
      await apiRequest(`/reservations/${reservation.id}/check-in`, {
        method: "POST",
        body: { roomId: selectedRoomId, signatureObjectKey: "sig_drawer_checkin" }
      });
      // 4) Parte de viajeros SES.HOSPEDAJES. The check-in is already done; the
      // queue response is read honestly (queued > 0 and no failed record) and
      // a 409 SES_ESTABLISHMENT_INCOMPLETE / failed[] is surfaced with the
      // missing establishment fields instead of a fake "enviado".
      let ses: SesQueueOutcome;
      try {
        ses = sesQueueOutcomeFromResponse(await queueSesSubmissions(reservation.propertyId, reservation.id));
      } catch (sesError) {
        ses = sesQueueOutcomeFromError(sesError);
      }
      setSesOutcome(ses);
      logBreadcrumb("checkin.ses", "mutation", { reservationId: reservation.id, outcome: ses.kind });

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setCompleted({ elapsedSeconds: elapsed });
      onCompleted?.({ reservationId: reservation.id, elapsedSeconds: elapsed });
      if (ses.kind === "queued") {
        showToast(`Check-in completado en ${elapsedText(elapsed)} · parte de viajeros encolado en SES (${ses.queued}).`, { variant: "success" });
        window.setTimeout(() => onClose(), 2500);
      } else {
        // The drawer stays open: the operator must see what SES is missing.
        showToast(`Check-in completado en ${elapsedText(elapsed)}.`, { variant: "success" });
        showToast(sesOutcomeToast(ses), { variant: ses.kind === "no_records" ? "info" : "error", duration: 9000 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error ejecutando check-in";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // =============================================================== render
  const nights = reservation ? nightsBetween(reservation.arrivalDate, reservation.departureDate) : 0;

  let body: ReactNode;
  if (loading) {
    body = <CocoaState kind="loading" title="Cargando reserva…" />;
  } else if (error && !reservation) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={() => void loadAll()} />;
  } else if (!reservation) {
    body = <CocoaState kind="error" title="No se encontró la reserva." onRetry={() => void loadAll()} />;
  } else if (completed) {
    body = <CompletedView elapsed={elapsedLabel} guest={fmtName(guest)} roomNumber={selectedRoom?.number} ses={sesOutcome} />;
  } else {
    body = (
      <>
        {error ? <CocoaCallout tone="danger" role="alert">{error}</CocoaCallout> : null}

        {/* STEP 1: huésped + alertas */}
        <Step title="1 · Huésped" badge={guest?.vipCode ? "VIP" : priorStays > 0 ? "Recurrente" : undefined} badgeTone={guest?.vipCode ? "accent" : "info"}>
          <div className="cocoa-stack" data-gap="2">
            <strong style={nameStyle}>{fmtName(guest)}</strong>
            <p style={mutedStyle}>
              {guest?.documentType ?? "Documento"} {guest?.documentNumber ?? "—"} · {guest?.nationality ?? "?"}
              {guest?.email ? ` · ${guest.email}` : ""}
            </p>
            {guest?.vipCode ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaBadge tone="accent" variant="tinted" uppercase={false} icon={<StarIcon size={12} />}>
                  VIP {guest.vipCode}
                  {guest.loyaltyTier ? ` · ${guest.loyaltyTier}` : ""}
                </CocoaBadge>
              </div>
            ) : null}
            {priorStays > 0 ? (
              <div className="cocoa-row" data-gap="2">
                <CocoaBadge tone="info" variant="tinted" uppercase={false}>
                  Cliente recurrente · {plural(priorStays, "estancia previa", "estancias previas")}
                </CocoaBadge>
              </div>
            ) : null}
            {reservation.specialRequests || reservation.notes ? (
              <CocoaCallout tone="neutral" icon={<ChatBubbleIcon size={16} />}>
                {reservation.specialRequests ?? reservation.notes}
              </CocoaCallout>
            ) : null}
          </div>
        </Step>

        {/* STEP 2: habitación */}
        <Step title="2 · Habitación" badge={roomIsClean ? "Limpia" : "No lista"} badgeTone={roomIsClean ? "success" : "warning"}>
          <div className="cocoa-stack" data-gap="2">
            <div className="cocoa-row" data-gap="2" data-align="baseline">
              <strong>{selectedRoom ? `Hab. ${selectedRoom.number}` : "Sin asignar"}</strong>
              {selectedRoom?.floor ? <span style={mutedStyle}>Planta {selectedRoom.floor}</span> : null}
              {roomType ? <span style={mutedStyle}>· {roomType.name}</span> : null}
            </div>
            {!roomIsClean && candidateRooms.length > 0 ? (
              <CocoaCallout
                tone="info"
                title="Sugerencia"
                icon={<InfoCircleIcon size={16} />}
                actions={
                  <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => setSelectedRoomId(candidateRooms[0].id)}>
                    Cambiar a {candidateRooms[0].number}
                  </CocoaButton>
                }
              >
                La {candidateRooms[0].number} está limpia y es del mismo tipo.
              </CocoaCallout>
            ) : null}
            <CocoaField label="Cambiar habitación">
              <CocoaSelect id={roomSelectId} value={selectedRoomId ?? ""} onChange={(value) => setSelectedRoomId(value || undefined)} options={roomOptions} />
            </CocoaField>
          </div>
        </Step>

        {/* STEP 3: pago */}
        <Step
          title="3 · Pago"
          badge={
            folioLoading
              ? "Cargando folio…"
              : balanceDue === null
              ? "Folio no disponible"
              : balanceDue > 0
              ? `${fmtEur(balanceDue)} pendiente`
              : "Saldado"
          }
          badgeTone={folioLoading ? "info" : balanceDue === null ? "danger" : balanceDue > 0 ? "warning" : "success"}
        >
          <div className="cocoa-stack" data-gap="2">
            {!folio && !folioLoading ? (
              <CocoaCallout
                tone="danger"
                title={`No se pudo cargar el folio${folioError ? `: ${folioError}` : "."}`}
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void loadFolio()} disabled={busy}>
                    {ACTIONS.retry}
                  </CocoaButton>
                }
              >
                Sin folio no se puede cobrar ni preautorizar. Reintenta o elige «Sin cobro» de forma explícita.
              </CocoaCallout>
            ) : null}
            <ul className="c22-section__list">
              <li>
                <span>Total estancia ({plural(nights, "noche", "noches")})</span>
                <strong>{fmtEur(reservation.totalAmount)}</strong>
              </li>
              <li>
                <span>Pagos hasta ahora</span>
                <strong>{folio ? fmtEur(folio.paymentsTotal) : "No disponible"}</strong>
              </li>
              <li>
                <span>Saldo pendiente</span>
                <strong>{balanceDue === null ? "No disponible (folio no cargado)" : fmtEur(balanceDue)}</strong>
              </li>
            </ul>
            <CocoaSegmentedControl
              size="small"
              aria-label="Modo de cobro"
              value={paymentMode}
              onChange={(value) => setPaymentMode(value as PaymentMode)}
              options={[
                { value: "preauth", label: "Preautorizar", disabled: !folio },
                { value: "capture", label: "Cobrar ahora", disabled: !folio },
                { value: "none", label: "Sin cobro" }
              ]}
            />
            {!folio ? <p style={mutedStyle}>Preautorizar y cobrar requieren el folio cargado.</p> : null}
            {paymentMode !== "none" ? (
              <CocoaField label="Método">
                <CocoaSelect value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod)} options={PAYMENT_METHOD_OPTIONS} />
              </CocoaField>
            ) : null}
          </div>
        </Step>

        {/* STEP 4: compliance */}
        <Step title="4 · Cumplimiento" badge="Al confirmar" badgeTone="info">
          <ul style={bulletListStyle}>
            <li>Al confirmar se encola el parte de viajeros (SES.HOSPEDAJES); aquí verás el resultado real del encolado.</li>
            <li>Firma digital aplicada con sello "sig_drawer_checkin".</li>
            <li>Política de cancelación: {reservation.cancellationPolicyCode ?? "estándar"}.</li>
          </ul>
        </Step>

        {blockingReason ? (
          <CocoaCallout tone="warning" role="status">
            {blockingReason}
          </CocoaCallout>
        ) : null}
      </>
    );
  }

  return (
    <CocoaDrawer
      open
      onClose={onClose}
      title="Check-in"
      subtitle={reservation ? `${fmtName(guest)} · ${reservation.code}` : undefined}
      side="right"
      size="md"
      initialFocus={() => document.getElementById(roomSelectId)}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={onClose} disabled={busy}>
            {ACTIONS.cancel}
          </CocoaButton>
          {completed ? (
            <CocoaButton variant="filled" tone="accent" onClick={onClose}>
              {ACTIONS.close}
            </CocoaButton>
          ) : (
            <CocoaButton
              variant="filled"
              tone="accent"
              disabled={!canSubmit || busy || !roomIsClean}
              loading={busy}
              onClick={() => void executeCheckIn()}
              title={blockingReason || "Pulsa para completar el check-in"}
            >
              Hacer check-in
            </CocoaButton>
          )}
        </>
      }
    >
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="2">
          <CocoaBadge tone={timerTone} icon={<ClockIcon size={12} />} title="Objetivo: < 90 segundos" aria-label={`Cronómetro ${elapsedLabel}`}>
            {elapsedLabel}
          </CocoaBadge>
          {completed ? (
            <CocoaBadge tone="success" variant="tinted">
              {STATUS_LABELS.completed}
            </CocoaBadge>
          ) : null}
        </div>
        {body}
      </div>
    </CocoaDrawer>
  );
}

// =============================================================== sub-components

function Step({ title, badge, badgeTone = "neutral", children }: { title: string; badge?: string; badgeTone?: CocoaTone; children: ReactNode }) {
  return (
    <CocoaSection
      title={title}
      meta={
        badge ? (
          <CocoaBadge tone={badgeTone} size="small">
            {badge}
          </CocoaBadge>
        ) : undefined
      }
    >
      {children}
    </CocoaSection>
  );
}

/** Real SES queue outcome after the check-in: never claims "enviado" unless every record was queued. */
function SesOutcomeBlock({ outcome }: { outcome: SesQueueOutcome | null }) {
  if (!outcome) {
    return <p style={mutedStyle}>Sin resultado del parte de viajeros todavía.</p>;
  }
  if (outcome.kind === "queued") {
    return (
      <CocoaCallout tone="success" title={`Parte de viajeros encolado en SES.HOSPEDAJES (${outcome.queued})`} role="status">
        Encolado no es aceptado: el envío real al MIR se ve en el Centro de envíos. Esta ventana se cierra automáticamente.
      </CocoaCallout>
    );
  }
  const tone: CocoaTone = outcome.kind === "no_records" ? "warning" : "danger";
  const title =
    outcome.kind === "no_records"
      ? "No se ha encolado ningún parte de viajeros"
      : outcome.kind === "partial"
        ? `Parte SES parcial: ${outcome.queued} encolado${outcome.queued === 1 ? "" : "s"}, ${outcome.failed.length} sin encolar`
        : outcome.kind === "incomplete"
          ? "Parte SES no encolado: faltan datos del establecimiento"
          : "Parte SES no encolado";
  const missing = outcome.kind === "partial" || outcome.kind === "incomplete" ? outcome.missing : [];
  const detail =
    outcome.kind === "no_records"
      ? "La reserva no tiene registros de viajeros (SES_NO_GUEST_REGISTER_RECORDS). Completa el registro de viajeros y vuelve a encolar el parte desde la bandeja de cumplimiento."
      : outcome.kind === "error"
        ? `${outcome.message}${outcome.code ? ` (${outcome.code})` : ""}`
        : outcome.kind === "incomplete" && missing.length === 0
          ? outcome.message
          : null;
  // Per-parte server messages (failed[]), verbatim; the one already used as `detail` is not repeated.
  const failed = outcome.kind === "partial" || outcome.kind === "incomplete" || outcome.kind === "error" ? outcome.failed : [];
  const headlineMessage = outcome.kind === "incomplete" || outcome.kind === "error" ? outcome.message : null;
  const failureMessages = sesFailureMessages(failed).filter((message) => message !== headlineMessage);
  const failedCount = failed.length;
  return (
    <CocoaCallout tone={tone} variant="banner" title={title} role="alert">
      <div className="cocoa-stack" data-gap="2">
        {missing.length > 0 ? (
          <ul style={bulletListStyle}>
            {missing.map((issue) => (
              <li key={issue}>{sesEstablishmentIssueLabel(issue)}</li>
            ))}
          </ul>
        ) : null}
        {detail ? <p style={mutedStyle}>{detail}</p> : null}
        {failureMessages.length > 0 ? (
          <div style={mutedStyle}>
            Motivo{failedCount === 1 ? "" : "s"} del servidor ({plural(failedCount, "parte", "partes")} sin encolar):
            <ul style={bulletListStyle}>
              {failureMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="cocoa-row" data-gap="2">
          {outcome.kind === "incomplete" || outcome.kind === "partial" ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("TaxComplianceSettings")}>
              Ajustes fiscales
            </CocoaButton>
          ) : null}
          {outcome.kind === "no_records" ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
              Registro de huéspedes
            </CocoaButton>
          ) : null}
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("ComplianceInbox")}>
            Bandeja de cumplimiento
          </CocoaButton>
        </div>
        <p style={mutedStyle}>El check-in sí se ha realizado. Esta ventana no se cierra sola para que puedas revisar el parte.</p>
      </div>
    </CocoaCallout>
  );
}

function CompletedView({ elapsed, guest, roomNumber, ses }: { elapsed: string; guest: string; roomNumber?: string; ses: SesQueueOutcome | null }) {
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaState kind="empty" illustration="success" title="Check-in completado" message={`${guest} alojado en ${roomNumber ? `Hab. ${roomNumber}` : "su habitación"}.`} role="status" />
      <div className="cocoa-row" data-gap="2" data-justify="center">
        <CocoaBadge tone="success" icon={<ClockIcon size={12} />}>
          {elapsed} · objetivo &lt; 1:30
        </CocoaBadge>
      </div>
      <SesOutcomeBlock outcome={ses} />
    </div>
  );
}
